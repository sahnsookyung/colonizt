import { describe, expect, it } from "vitest";
import { createDemoGame, withResources } from "@colonizt/demo-state";
import { emptyResources, serializeForViewer } from "@colonizt/game-core";
import {
  activeRuleLabels,
  displayPlayersForViewer,
  selectMaritimeTradeDraft,
  selectYearOfPlentyDraft,
  visiblePlayerResourceCount,
  visibleStealTargets,
} from "../src/game-view-model.js";

describe("game view model", () => {
  it("recognizes only a complete legal maritime draft", () => {
    const state = withResources(createDemoGame("maritime-view"), "p1", { timber: 8 });
    const offer = { ...emptyResources(), timber: 4 };
    const request = { ...emptyResources(), ore: 1 };
    const legal = [{ offered: "timber" as const, requested: "ore" as const, ratio: 4 }];

    expect(selectMaritimeTradeDraft(state, "p1", offer, request, legal)).toEqual({
      previewMaritimeRatio: 4,
      bankOfferResource: "timber",
      bankRequestResource: "ore",
      selectedMaritimeTrade: legal[0],
    });
    expect(selectMaritimeTradeDraft(state, "p1", { ...offer, brick: 1 }, request, legal).selectedMaritimeTrade).toBeUndefined();
    expect(selectMaritimeTradeDraft(state, "p1", offer, { ...request, ore: 2 }, legal).bankRequestResource).toBeUndefined();
    expect(selectMaritimeTradeDraft(state, "missing", offer, request, legal).previewMaritimeRatio).toBe(4);
  });

  it("normalizes Year of Plenty choices against current bank supply", () => {
    const state = createDemoGame("plenty-view");
    state.resourceBank.timber = 1;
    state.resourceBank.ore = 2;

    expect(selectYearOfPlentyDraft(state, [], ["grain", "fiber"])).toEqual({
      firstOptions: [], secondOptions: [], selected: ["timber", "timber"], canTake: false,
    });
    expect(selectYearOfPlentyDraft(state, ["timber", "ore"], ["grain", "timber"])).toEqual({
      firstOptions: ["timber", "ore"], secondOptions: ["ore"], selected: ["timber", "ore"], canTake: true,
    });
    expect(selectYearOfPlentyDraft(state, ["ore"], ["ore", "ore"])).toEqual({
      firstOptions: ["ore"], secondOptions: ["ore"], selected: ["ore", "ore"], canTake: true,
    });
  });

  it("derives hand-safe opponents and prioritizes eligible robber victims", () => {
    let state = createDemoGame("robber-view", { playerCount: 4 });
    state = withResources(state, "p2", { timber: 2 });
    state = withResources(state, "p3", { ore: 3 });
    state.players.p2!.score = 3;
    state.players.p3!.score = 5;
    const hexId = Object.keys(state.board.hexes)[0]!;
    const [humanVertex, p2Vertex, p3Vertex] = state.board.adjacency.hexToVertices[hexId]!;
    state.settlements[humanVertex!] = "p1";
    state.settlements[p2Vertex!] = "p2";
    state.settlements[p3Vertex!] = "p3";
    const viewer = serializeForViewer(state, "p1");

    expect(visiblePlayerResourceCount(state, viewer, "p2")).toBe(2);
    expect(visiblePlayerResourceCount(state, { ...viewer, players: viewer.players.filter((player) => player.id !== "p2") }, "p2")).toBe(2);
    expect(visibleStealTargets(state, viewer, "p1", hexId)).toEqual(["p3", "p2"]);
    expect(visibleStealTargets(state, viewer, "p1", "missing-hex")).toEqual([]);

    const opponent = viewer.players.find((player) => player.id === "p2")!;
    opponent.publicVictoryPoints = 2;
    opponent.visibleVictoryPoints = 4;
    opponent.secretVictoryPoints = 2;
    opponent.victoryPointBreakdown = { settlements: 2, cities: 0, longestRoad: 0, largestArmy: 0, secret: 2, otherPublic: 0, total: 4 };
    const displayed = displayPlayersForViewer(state, viewer, "p1");
    expect(displayed.find((player) => player.id === "p2")).toMatchObject({ score: 2, visibleVictoryPoints: 2, secretVictoryPoints: 0, victoryPointBreakdown: { secret: 0, total: 2 } });
    state.phase = { type: "GAME_OVER", winnerId: "p3", reason: "VICTORY_POINTS" };
    expect(displayPlayersForViewer(state, viewer, "p1").find((player) => player.id === "p2")).toBe(opponent);
  });

  it("describes only enabled rules with stable defaults", () => {
    const state = createDemoGame("rule-labels");
    state.config.rules = { mapPreset: "islands", diceDoubles: true, plight: true, specialCardCostRandomized: true };
    expect(activeRuleLabels(state)).toEqual(["Map Islands", "Doubles x2", "Plight turn 20", "Random special cost"]);
    state.config.rules = undefined;
    expect(activeRuleLabels(state)).toEqual(["Map Standard"]);
  });
});
