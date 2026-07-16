import { describe, expect, it } from "vitest";
import { applyCommand, createGame, normalizeImportedState, schemaVersion, validateReplayLog, type GameEvent } from "../src/index.js";

const state = () => createGame({
  matchId: "replay-edges",
  seed: "replay-edges",
  playerOrder: ["p1", "p2"],
  playerNames: { p1: "One", p2: "Two" },
  playerColors: { p1: "red", p2: "blue" },
  victoryPoints: 10,
});

describe("replay edge contracts", () => {
  it("validates every destroyed-building field in a plight event", () => {
    const game = state();
    const valid = {
      schemaVersion,
      seq: 1,
      type: "PLIGHT_STRUCK",
      destroyed: [{ playerId: "p1", vertexId: "v1", buildingType: "city" }],
    } as GameEvent;
    expect(validateReplayLog({ config: game.config, board: game.board, events: [valid] })).toEqual([]);
    expect(validateReplayLog({
      config: game.config,
      board: game.board,
      events: [{ ...valid, destroyed: [{ playerId: "p1", vertexId: "v1", buildingType: "castle" }] } as unknown as GameEvent],
    })).toEqual(expect.arrayContaining([expect.objectContaining({ code: "INVALID_EVENT", seq: 1 })]));
  });

  it("migrates missing per-player knight fields and uses a deterministic thief fallback without desert", () => {
    const legacy = state();
    delete (legacy as Partial<typeof legacy>).playedKnightCounts;
    delete legacy.thiefHexId;
    legacy.largestArmyOwner = "p2";
    for (const hex of Object.values(legacy.board.hexes)) hex.resource = "grain";
    for (const player of Object.values(legacy.players)) {
      delete player.playedKnights;
      delete player.hasLargestArmy;
    }

    const migrated = normalizeImportedState(legacy);
    expect(migrated.thiefHexId).toBe(Object.keys(migrated.board.hexes).sort((left, right) => left.localeCompare(right))[0]);
    expect(migrated.playedKnightCounts).toEqual({ p1: 0, p2: 0 });
    expect(migrated.players.p1).toMatchObject({ playedKnights: 0, hasLargestArmy: false });
    expect(migrated.players.p2).toMatchObject({ playedKnights: 0, hasLargestArmy: true });
  });

  it("reconstructs the resource bank for legacy states before resource-moving commands", () => {
    const legacy = state();
    legacy.phase = { type: "ACTION_PHASE", activePlayerId: "p1" };
    legacy.players.p1!.resources.timber = 4;
    delete (legacy as Partial<typeof legacy>).resourceBank;

    const migrated = normalizeImportedState(legacy);
    expect(migrated.resourceBank).toMatchObject({ timber: 15, grain: 19 });

    const result = applyCommand(migrated, {
      type: "MARITIME_TRADE",
      playerId: "p1",
      offered: "timber",
      requested: "grain",
    });
    expect(result.ok).toBe(true);
  });
});
