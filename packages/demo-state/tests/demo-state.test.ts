import { describe, expect, it } from "vitest";
import { emptyResources } from "@colonizt/game-core";
import { applyOrThrow, botControllers, chooseFallbackCommand, completeSetup, createDemoConfig, createDemoGame, playBotGame, withResources } from "../src/index.js";

describe("demo-state scenarios", () => {
  it("builds arbitrary player lineups with stable fallback names and colors", () => {
    const config = createDemoConfig("custom-lineup", { playerCount: 10, botCount: 2 });
    expect(config.playerOrder).toHaveLength(10);
    expect(config.playerNames.p9).toBe("Player 9");
    expect(config.playerColors.p9).toBe("#64748b");

    const explicit = createDemoConfig("explicit-lineup", { playerIds: ["alice", "bob"], botCount: 8 });
    expect(explicit.playerOrder).toEqual(["alice", "bob"]);
  });

  it("rejects invalid helper commands with the engine error context", () => {
    const state = createDemoGame("invalid-helper", { playerCount: 2 });
    expect(() => applyOrThrow(state, { type: "ROLL_DICE", playerId: "p1" })).toThrow(/ROLL_DICE failed:/);
  });

  it("caps resources against cards held by other players and keeps the bank conserved", () => {
    const state = createDemoGame("resource-cap", { playerCount: 2 });
    state.players.p2!.resources.ore = 18;
    state.resourceBank.ore = 1;

    const next = withResources(state, "p1", { ore: 99, timber: -3.2 });
    expect(next.players.p1?.resources.ore).toBe(1);
    expect(next.players.p1?.resources.timber).toBe(0);
    expect(next.resourceBank.ore).toBe(0);
    expect(next.players.p1?.resources).not.toBe(state.players.p1?.resources);
  });

  it("completes deterministic setup with legal settlements and roads", () => {
    const result = completeSetup(createDemoGame("complete-setup", { playerCount: 3 }));
    expect(result.state.phase.type).toBe("WAITING_FOR_ROLL");
    expect(result.events.filter((event) => event.type === "SETUP_PLACED")).toHaveLength(6);
    expect(Object.keys(result.state.settlements)).toHaveLength(6);
    expect(Object.keys(result.state.roads)).toHaveLength(6);
  });

  it("runs bot games with custom profiles and difficulties without invalid commands", () => {
    const result = playBotGame("custom-bot-run", 40, {
      playerCount: 3,
      botDifficulty: "easy",
      botDifficulties: { p2: "hard" },
      botProfiles: { p1: "planner", p2: "greedy", p3: "random" },
    });
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.invalidCommands).toBe(0);
    expect(result.state.eventSeq).toBe(result.events.at(-1)?.seq);
  });

  it("uses recovery commands when a controller proposes an invalid action", () => {
    const original = botControllers.p1;
    if (!original) throw new Error("expected the p1 demo controller");
    botControllers.p1 = {
      ...original,
      chooseCommand(view, idFactory) {
        const normal = original.chooseCommand(view, idFactory);
        if (normal?.type === "PLACE_SETUP") return normal;
        return { type: "PLACE_SETUP", playerId: view.botId, vertexId: "missing", edgeId: "missing" };
      },
    };

    try {
      const recovered = playBotGame("fallback-path", 14, { playerCount: 2 });
      expect(recovered.invalidCommands).toBeGreaterThan(0);
      expect(recovered.events.some((event) => event.type === "DICE_ROLLED")).toBe(true);
      expect(recovered.events.some((event) => event.type === "TURN_ENDED")).toBe(true);
    } finally {
      botControllers.p1 = original;
    }
  });

  it("selects phase-safe fallback commands for stalled bot turns", () => {
    const setup = createDemoGame("fallback-commands", { playerCount: 2 });
    expect(chooseFallbackCommand(setup, "p1")).toBeUndefined();

    const action = completeSetup(setup).state;
    expect(chooseFallbackCommand(action, "p1")).toEqual({ type: "ROLL_DICE", playerId: "p1" });
    action.phase = { type: "ACTION_PHASE", activePlayerId: "p1" };
    expect(chooseFallbackCommand(action, "p1")).toEqual({ type: "END_TURN", playerId: "p1" });

    action.trades.open = {
      id: "open", fromPlayerId: "p1", offered: { ...emptyResources(), timber: 1 }, requested: { ...emptyResources(), grain: 1 },
      recipients: "ANY", status: "COLLECTING_RESPONSES", createdAtSeq: action.eventSeq, expiresAtSeq: action.eventSeq + 10,
    };
    expect(chooseFallbackCommand(action, "p1")).toEqual({ type: "CANCEL_TRADE", playerId: "p1", tradeId: "open" });

    delete action.trades.open;
    action.players.p2!.resources = { ...emptyResources(), ore: 8 };
    action.phase = { type: "DISCARDING", activePlayerId: "p2", rollerId: "p1", pending: { p2: 4 }, submitted: {} };
    expect(chooseFallbackCommand(action, "p2")).toMatchObject({ type: "DISCARD_RESOURCES", playerId: "p2" });
    action.phase.pending.p2 = 0;
    expect(chooseFallbackCommand(action, "p2")).toBeUndefined();

    action.phase = { type: "MOVING_THIEF", activePlayerId: "p1", rollerId: "p1", reason: "ROLL_7" };
    expect(chooseFallbackCommand(action, "p1")).toMatchObject({ type: "MOVE_THIEF", playerId: "p1", hexId: expect.any(String) });
  });
});
