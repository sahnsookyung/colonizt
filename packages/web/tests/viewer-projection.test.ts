import { describe, expect, it } from "vitest";
import { createDemoGame, withResources } from "@colonizt/demo-state";
import { classicDevelopmentDeck, emptyResources, resourceCount, schemaVersion, serializeForViewer, type GameEvent } from "@colonizt/game-core";
import { applyEventsToViewerProjection, projectViewerToGameState } from "../src/viewer-projection.js";

describe("viewer projection", () => {
  it("keeps viewer resources while redacting opponent resources in projected UI state", () => {
    let state = createDemoGame("viewer-projection");
    state = withResources(state, "p1", { timber: 2, brick: 1 });
    state = withResources(state, "p2", { ore: 3 });

    const viewer = serializeForViewer(state, "p1");
    const projected = projectViewerToGameState(viewer, "room-projection");

    expect(projected.players.p1?.resources).toMatchObject({ timber: 2, brick: 1 });
    expect(projected.players.p2?.resources).toEqual(emptyResources());
    expect(viewer.players.find((player) => player.id === "p2")?.resources).toBeUndefined();
  });

  it("updates hidden opponent resource counts from redacted events without exposing cards", () => {
    const state = createDemoGame("viewer-projection-events");
    const viewer = serializeForViewer(state, "p1");
    const event: GameEvent = {
      schemaVersion,
      seq: 1,
      type: "RESOURCES_PRODUCED",
      gains: {
        p2: { ore: 2 },
      },
    };

    const projected = applyEventsToViewerProjection(viewer, [event], "room-projection", "p1");
    const opponent = projected.players.find((player) => player.id === "p2");

    expect(opponent?.resources).toBeUndefined();
    expect(opponent?.resourceCount).toBe(resourceCount({ ...emptyResources(), ore: 2 }));
  });

  it("reconstructs optional public state and clamps malformed deck counts", () => {
    const state = createDemoGame("viewer-optionals");
    state.lastRoll = { die1: 3, die2: 4, total: 7 };
    state.longestRoadOwner = "p2";
    state.largestArmyOwner = "p3";
    state.thiefHexId = Object.keys(state.board.hexes)[0];
    state.players.p1!.playedDevelopmentCardTurn = 2;
    const viewer = serializeForViewer(state, "p1");
    viewer.developmentDeckRemaining = classicDevelopmentDeck.length + 100;

    const projected = projectViewerToGameState(viewer, "viewer-optionals", { botDifficulty: "hard", rules: { diceDoubles: true } });

    expect(projected.lastRoll).toEqual(state.lastRoll);
    expect(projected.longestRoadOwner).toBe("p2");
    expect(projected.largestArmyOwner).toBe("p3");
    expect(projected.thiefHexId).toBe(state.thiefHexId);
    expect(projected.players.p1?.playedDevelopmentCardTurn).toBe(2);
    expect(projected.config.botDifficulty).toBe("hard");
    expect(projected.config.rules.diceDoubles).toBe(true);
    expect(projected.developmentDeckCursor).toBe(0);
  });

  it("tracks every public resource-changing event for redacted opponents", () => {
    const state = withResources(createDemoGame("viewer-resource-events"), "p2", {
      timber: 4, brick: 4, grain: 4, fiber: 4, ore: 3,
    });
    let viewer = serializeForViewer(state, "p1");
    const count = () => viewer.players.find((player) => player.id === "p2")?.resourceCount;
    let seq = state.eventSeq;
    const apply = (event: Omit<GameEvent, "schemaVersion" | "seq">) => {
      seq += 1;
      viewer = applyEventsToViewerProjection(viewer, [{ ...event, schemaVersion, seq } as GameEvent], "room-resource-events", "p1");
    };

    const initial = count() ?? 0;
    apply({ type: "ROAD_BUILT", playerId: "p2", edgeId: Object.keys(state.board.edges)[0]!, cost: { ...emptyResources(), timber: 1, brick: 1 } });
    expect(count()).toBe(initial - 2);
    apply({ type: "SETTLEMENT_BUILT", playerId: "p2", vertexId: Object.keys(state.board.vertices)[0]!, cost: { ...emptyResources(), timber: 1, brick: 1, grain: 1, fiber: 1 } });
    expect(count()).toBe(initial - 6);
    apply({ type: "CITY_UPGRADED", playerId: "p2", vertexId: Object.keys(state.board.vertices)[0]!, cost: { ...emptyResources(), grain: 2, ore: 3 } });
    expect(count()).toBe(initial - 11);
    apply({ type: "SPECIAL_CARD_BOUGHT", playerId: "p2", cost: { ...emptyResources(), grain: 1, fiber: 1, ore: 1 }, cardIndex: 0 });
    expect(count()).toBe(initial - 14);
    apply({ type: "RESOURCES_DISCARDED", playerId: "p2", resources: { ...emptyResources(), timber: 1 } });
    expect(count()).toBe(initial - 15);
    apply({ type: "YEAR_OF_PLENTY_PLAYED", playerId: "p2", cardId: "card-yop", resources: ["timber", "ore"] });
    expect(count()).toBe(initial - 13);
    apply({ type: "MARITIME_TRADED", playerId: "p2", offered: "timber", requested: "grain", ratio: 4 });
    expect(count()).toBe(initial - 16);
  });

  it("accounts for thief, monopoly, and bilateral trade transfers without revealing cards", () => {
    let state = createDemoGame("viewer-transfers");
    state = withResources(state, "p2", { timber: 3, ore: 2 });
    state = withResources(state, "p3", { grain: 4 });
    let viewer = serializeForViewer(state, "p1");
    let seq = state.eventSeq;
    const counts = () => Object.fromEntries(viewer.players.map((player) => [player.id, player.resourceCount]));
    const apply = (event: Omit<GameEvent, "schemaVersion" | "seq">) => {
      seq += 1;
      viewer = applyEventsToViewerProjection(viewer, [{ ...event, schemaVersion, seq } as GameEvent], "room-transfers", "p1");
    };
    const starting = counts();

    apply({ type: "THIEF_MOVED", playerId: "p2", toHexId: Object.keys(state.board.hexes)[0]!, reason: "KNIGHT", stealFromPlayerId: "p3", stolenResource: "grain" });
    expect(counts().p2).toBe((starting.p2 ?? 0) + 1);
    expect(counts().p3).toBe((starting.p3 ?? 0) - 1);
    apply({ type: "MONOPOLY_PLAYED", playerId: "p2", cardId: "card-monopoly", resource: "grain", collected: { p1: 0, p3: 3 } });
    expect(counts().p2).toBe((starting.p2 ?? 0) + 4);
    expect(counts().p3).toBe((starting.p3 ?? 0) - 4);
    apply({
      type: "TRADE_OFFERED",
      trade: {
        id: "trade-projected", fromPlayerId: "p2", offered: { ...emptyResources(), timber: 2 }, requested: { ...emptyResources(), ore: 1 },
        recipients: ["p3"], status: "COLLECTING_RESPONSES", createdAtSeq: seq + 1, expiresAtSeq: seq + 10,
      },
    });
    apply({ type: "TRADE_ACCEPTED", tradeId: "trade-projected", fromPlayerId: "p2", toPlayerId: "p3", offered: { ...emptyResources(), timber: 2 }, requested: { ...emptyResources(), ore: 1 } });
    expect(counts().p2).toBe((starting.p2 ?? 0) + 3);
    expect(counts().p3).toBe((starting.p3 ?? 0) - 3);
    apply({ type: "THIEF_MOVED", playerId: "p4", toHexId: Object.keys(state.board.hexes)[1]!, reason: "KNIGHT" });
    expect(counts().p2).toBe((starting.p2 ?? 0) + 3);
  });
});
