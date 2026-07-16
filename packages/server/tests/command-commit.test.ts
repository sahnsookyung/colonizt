import { describe, expect, it, vi } from "vitest";
import { createDemoGame } from "@colonizt/demo-state";
import type { GameEvent } from "@colonizt/game-core";
import { persistAcceptedEvents } from "../src/command-commit.js";
import { MemoryEventStore, type StoredCommandResult } from "../src/event-store.js";
import type { Room } from "../src/room-manager.js";

const fixture = () => {
  const game = createDemoGame("command-commit");
  const room: Room = {
    id: "room-commit", code: "COMMIT", hostUserId: "p1", status: "IN_GAME",
    settings: { mode: "CLASSIC", botFill: false, ranked: false },
    seats: [], spectators: new Set(), createdAt: new Date(0).toISOString(), lastActivityAt: new Date(0).toISOString(),
    game, board: game.board, events: [], chat: [], reports: [], processedClientCommands: new Map(), tradeResponseDeadlines: new Map(),
  };
  const event = { schemaVersion: 3, seq: 1, type: "TURN_ENDED", playerId: "p1", nextPlayerId: "p2" } as GameEvent;
  const result: StoredCommandResult = { roomId: room.id, matchId: game.config.matchId, userId: "p1", clientSeq: 1, commandHash: "hash", ok: true, events: [event] };
  return { room, game, event, result };
};

describe("accepted command persistence", () => {
  it("uses the atomic adapter when available", async () => {
    const { room, game, event, result } = fixture();
    const store = new MemoryEventStore();
    store.commitEvents = vi.fn(async () => undefined);
    const append = vi.spyOn(store, "appendEvents");

    await persistAcceptedEvents(store, room, game, [event], result);

    expect(store.commitEvents).toHaveBeenCalledWith(room, [event], result);
    expect(append).not.toHaveBeenCalled();
  });

  it("keeps the legacy adapter ordering for active and finished matches", async () => {
    const { room, game, event, result } = fixture();
    const store = new MemoryEventStore();
    await store.persistMatchStart(room, game);
    const persistCommand = vi.spyOn(store, "persistCommandResult");
    const persistRoom = vi.spyOn(store, "persistRoom");
    const markFinished = vi.spyOn(store, "markFinished");

    await persistAcceptedEvents(store, room, game, [event], result);
    expect(persistCommand).toHaveBeenCalledWith(result);
    expect(persistRoom).toHaveBeenCalledWith(room);
    expect(markFinished).not.toHaveBeenCalled();

    game.phase = { type: "GAME_OVER", winnerId: "p1", reason: "VICTORY_POINTS" };
    await persistAcceptedEvents(store, room, game, [], undefined);
    expect(markFinished).toHaveBeenCalledWith(room, "p1");
  });
});
