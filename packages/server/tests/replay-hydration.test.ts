import { describe, expect, it } from "vitest";
import { replay } from "@colonizt/game-core";
import { completeSetup, createDemoGame } from "@colonizt/test-utils";
import { hydrateGameFromStoredMatch, hydrateGameFromStoredMatchWithOutcome, replayLogFromStoredMatch } from "../src/replay-hydration.js";
import { validateStoredRoomRecord } from "../src/store-validation.js";

describe("stored replay hydration", () => {
  it("keeps only events after the persisted snapshot boundary", () => {
    const completed = completeSetup(createDemoGame("snapshot-boundary"));
    const snapshotSeq = 3;
    const snapshotState = replay({
      config: completed.state.config,
      board: completed.state.board,
      events: completed.events.filter((event) => event.seq <= snapshotSeq),
    });
    const match = {
      id: completed.state.config.matchId,
      config: completed.state.config,
      board: completed.state.board,
      events: completed.events,
      snapshot: { matchId: completed.state.config.matchId, seq: snapshotSeq, state: snapshotState },
    };

    expect(replayLogFromStoredMatch(match).events.every((event) => event.seq > snapshotSeq)).toBe(true);
    expect(hydrateGameFromStoredMatchWithOutcome(match)).toMatchObject({ outcome: "snapshot", state: completed.state });
  });

  it("falls back to the full event log when a persisted snapshot is malformed", () => {
    const completed = completeSetup(createDemoGame("snapshot-fallback"));
    const snapshotState = structuredClone(completed.state);
    snapshotState.eventSeq = 999;
    const stored = validateStoredRoomRecord({
      id: "room_snapshot_fallback",
      code: "ABC234",
      status: "IN_GAME",
      hostUserId: "p1",
      settings: { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2 },
      createdAt: new Date(0).toISOString(),
      seats: completed.state.playerOrder.map((playerId, seatIndex) => ({
        seatIndex,
        userId: playerId,
        displayName: completed.state.players[playerId]?.name,
        ready: true,
        connected: true,
      })),
      match: {
        id: completed.state.config.matchId,
        config: completed.state.config,
        board: completed.state.board,
        events: completed.events,
        snapshot: { matchId: completed.state.config.matchId, seq: 3, state: snapshotState },
      },
    });
    if (!stored.match) throw new Error("expected stored match");

    expect(hydrateGameFromStoredMatchWithOutcome(stored.match)).toEqual({ outcome: "snapshot_fallback", state: completed.state });
  });

  it("reports full-replay hydration and preserves an unrecoverable replay failure", () => {
    const completed = completeSetup(createDemoGame("full-replay-hydration"));
    expect(hydrateGameFromStoredMatchWithOutcome({
      id: completed.state.config.matchId,
      config: completed.state.config,
      board: completed.state.board,
      events: completed.events,
    })).toEqual({ outcome: "full_replay", state: completed.state });
    expect(hydrateGameFromStoredMatch({
      id: completed.state.config.matchId,
      config: completed.state.config,
      board: completed.state.board,
      events: completed.events,
    })).toEqual(completed.state);
    expect(() => hydrateGameFromStoredMatchWithOutcome({
      id: completed.state.config.matchId,
      config: completed.state.config,
      board: completed.state.board,
      events: [{ ...completed.events[0]!, seq: 2 }],
    })).toThrow(/expected event sequence 1/i);
  });

  it("falls back when a snapshot is ahead of the durable event log", () => {
    const completed = completeSetup(createDemoGame("future-snapshot"));
    const snapshotState = structuredClone(completed.state);
    snapshotState.eventSeq = 999;

    expect(hydrateGameFromStoredMatchWithOutcome({
      id: completed.state.config.matchId,
      config: completed.state.config,
      board: completed.state.board,
      events: completed.events,
      snapshot: { matchId: completed.state.config.matchId, seq: 999, state: snapshotState },
    })).toEqual({ outcome: "snapshot_fallback", state: completed.state });
  });

  it("falls back when a snapshot belongs to another match", () => {
    const completed = completeSetup(createDemoGame("snapshot-owner"));
    const other = completeSetup(createDemoGame("snapshot-intruder"));

    expect(hydrateGameFromStoredMatchWithOutcome({
      id: completed.state.config.matchId,
      config: completed.state.config,
      board: completed.state.board,
      events: completed.events,
      snapshot: { matchId: other.state.config.matchId, seq: other.state.eventSeq, state: other.state },
    })).toEqual({ outcome: "snapshot_fallback", state: completed.state });
  });

  it("falls back when snapshot config or board diverges from durable match metadata", () => {
    const completed = completeSetup(createDemoGame("snapshot-metadata"));
    const snapshotState = replay({
      config: completed.state.config,
      board: completed.state.board,
      events: completed.events.slice(0, 3),
    });
    const mismatchedConfig = structuredClone(snapshotState);
    mismatchedConfig.config.victoryPoints += 1;
    const mismatchedBoard = structuredClone(snapshotState);
    const firstHex = Object.values(mismatchedBoard.board.hexes)[0]!;
    firstHex.resource = firstHex.resource === "ore" ? "grain" : "ore";

    for (const state of [mismatchedConfig, mismatchedBoard]) {
      expect(hydrateGameFromStoredMatchWithOutcome({
        id: completed.state.config.matchId,
        config: completed.state.config,
        board: completed.state.board,
        events: completed.events,
        snapshot: { matchId: completed.state.config.matchId, seq: 3, state },
      })).toEqual({ outcome: "snapshot_fallback", state: completed.state });
    }
  });

  it("rejects a structurally valid replay that violates game invariants", () => {
    const completed = completeSetup(createDemoGame("semantic-corruption"));
    const events = completed.events.map((event, index) =>
      index === 0 && event.type === "SETUP_PLACED" ? { ...event, edgeId: "missing_edge" } : event);

    expect(() => hydrateGameFromStoredMatchWithOutcome({
      id: completed.state.config.matchId,
      config: completed.state.config,
      board: completed.state.board,
      events,
    })).toThrow(/road on unknown edge missing_edge/i);
  });
});
