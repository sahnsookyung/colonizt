import { describe, expect, it } from "vitest";
import { cityCost, createGame, emptyResources, roadCost, settlementCost, type GameState } from "@colonizt/game-core";
import { buildUnavailableReason, selectActionHint, type ActionHintInput } from "../src/game-guidance.js";

const game = (): GameState => createGame({
  matchId: "guidance",
  seed: "guidance",
  playerOrder: ["p1", "p2"],
  playerNames: { p1: "Ada", p2: "Lin" },
  playerColors: { p1: "red", p2: "blue" },
  victoryPoints: 10,
});

describe("build guidance", () => {
  it("explains every phase, ownership, resource, and placement blocker", () => {
    const state = game();
    const reason = (mode: "road" | "settlement" | "city", active = true) => buildUnavailableReason({ state, mode, humanPlayerId: "p1", isHumanActive: active });

    state.phase = { type: "GAME_OVER", winnerId: "p1", reason: "VICTORY_POINTS" };
    expect(reason("road")).toBe("The game is over.");
    state.phase = { type: "WAITING_FOR_ROLL", activePlayerId: "p1" };
    expect(reason("road")).toBe("Available during your action phase.");
    state.phase = { type: "ACTION_PHASE", activePlayerId: "p2" };
    expect(buildUnavailableReason({ state, mode: "road", humanPlayerId: "p1", isHumanActive: false, activeName: "Lin" })).toBe("Lin is taking a turn.");
    expect(buildUnavailableReason({ state, mode: "road", humanPlayerId: "missing", isHumanActive: true })).toBe("Player hand is unavailable.");

    state.phase = { type: "ACTION_PHASE", activePlayerId: "p1" };
    expect(reason("road")).toContain("Need");
    state.players.p1!.resources = { ...emptyResources(), ...roadCost() };
    expect(reason("road")).toContain("No legal road edges");
    state.players.p1!.resources = { ...emptyResources(), ...settlementCost() };
    expect(reason("settlement")).toContain("No legal settlement corners");
    state.players.p1!.resources = emptyResources();
    expect(reason("settlement")).toContain("Need");
    expect(reason("city")).toContain("Need");
    state.players.p1!.resources = { ...emptyResources(), ...cityCost() };
    expect(reason("city")).toBe("No settlements available to upgrade.");
    const vertexId = Object.keys(state.board.vertices)[0]!;
    state.settlements[vertexId] = "p1";
    state.buildings[vertexId] = { owner: "p1", type: "settlement" };
    expect(reason("city")).toBe("No legal city upgrades are currently available.");
  });
});

describe("action guidance", () => {
  const input = (): ActionHintInput => ({
    state: game(),
    humanPlayerId: "p1",
    isHumanActive: true,
    activeKnight: false,
    activeRoadBuilding: false,
    roadsRemaining: 2,
    activeMonopoly: false,
    activeYearOfPlenty: false,
    pendingSetup: false,
    canBuild: false,
  });

  it("selects guidance for every mutually exclusive interaction mode", () => {
    const cases: Array<[string, (value: ActionHintInput) => void, string]> = [
      ["game over", (value) => { value.state.phase = { type: "GAME_OVER", winnerId: "p1", reason: "VICTORY_POINTS" }; }, "Game over"],
      ["discard", (value) => { value.state.phase = { type: "DISCARDING", activePlayerId: "p1", rollerId: "p1", pending: { p1: 2 }, submitted: {} }; value.discardCount = 2; }, "Discard"],
      ["robber", (value) => { value.state.phase = { type: "MOVING_THIEF", activePlayerId: "p1", rollerId: "p1", reason: "ROLL_7" }; }, "Move robber"],
      ["waiting", (value) => { value.isHumanActive = false; value.activeName = "Lin"; }, "Waiting"],
      ["knight", (value) => { value.activeKnight = true; }, "Play Knight"],
      ["one road", (value) => { value.activeRoadBuilding = true; value.roadsRemaining = 1; }, "Road Building"],
      ["two roads", (value) => { value.activeRoadBuilding = true; }, "Road Building"],
      ["monopoly", (value) => { value.activeMonopoly = true; }, "Monopoly"],
      ["plenty", (value) => { value.activeYearOfPlenty = true; }, "Year of Plenty"],
      ["offerer", (value) => { value.stagedTradeRole = "offerer"; }, "Choose trade partner"],
      ["recipient", (value) => { value.stagedTradeRole = "recipient"; }, "Answer trade"],
      ["setup road", (value) => { value.pendingSetup = true; }, "Place setup road"],
      ["setup settlement", () => undefined, "Place setup settlement"],
      ["roll", (value) => { value.state.phase = { type: "WAITING_FOR_ROLL", activePlayerId: "p1" }; }, "Roll dice"],
      ["build", (value) => { value.state.phase = { type: "ACTION_PHASE", activePlayerId: "p1" }; value.canBuild = true; }, "Build or trade"],
      ["end", (value) => { value.state.phase = { type: "ACTION_PHASE", activePlayerId: "p1" }; }, "Trade or end"],
    ];

    for (const [, mutate, expectedTitle] of cases) {
      const value = input();
      mutate(value);
      expect(selectActionHint(value).title).toBe(expectedTitle);
    }
    const unnamedWinner = input();
    unnamedWinner.state.phase = { type: "GAME_OVER", winnerId: "departed", reason: "VICTORY_POINTS" };
    expect(selectActionHint(unnamedWinner).detail).toContain("departed");
  });
});
