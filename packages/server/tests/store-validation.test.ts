import { describe, expect, it } from "vitest";
import { validateStoredCommandResult, validateStoredRoomRecord } from "../src/store-validation.js";
import type { StoredCommandResult, StoredRoomRecord } from "../src/event-store.js";

const validStoredRoom = (): StoredRoomRecord => ({
  id: "room_valid",
  code: "VALID1",
  status: "LOBBY",
  hostUserId: "u_host",
  settings: {
    mode: "CLASSIC",
    botFill: false,
    ranked: false,
    minPlayers: 2,
    maxPlayers: 4,
    botDifficulty: "medium",
    rules: { mapPreset: "standard" },
  },
  createdAt: "2026-06-26T00:00:00.000Z",
  lastActivityAt: "2026-06-26T00:00:00.000Z",
  seats: [
    { seatIndex: 0, userId: "u_host", ready: false, connected: false },
    { seatIndex: 1, ready: false, connected: false },
  ],
});

describe("stored runtime validation", () => {
  it("accepts valid persisted room metadata", () => {
    expect(validateStoredRoomRecord(validStoredRoom())).toMatchObject({
      id: "room_valid",
      settings: { minPlayers: 2, maxPlayers: 4 },
    });
  });

  it("rejects malformed persisted room timers before hydration", () => {
    const malformed = {
      ...validStoredRoom(),
      timer: { activePlayerId: "u_host", expiresAt: "soon" },
    } as unknown as StoredRoomRecord;

    expect(() => validateStoredRoomRecord(malformed)).toThrow(/timer\.expiresAt/);
  });

  it("rejects invalid persisted lobby settings before hydration", () => {
    const malformed = {
      ...validStoredRoom(),
      settings: {
        mode: "CLASSIC",
        botFill: false,
        ranked: false,
        minPlayers: 4,
        maxPlayers: 2,
      },
    } as unknown as StoredRoomRecord;

    expect(() => validateStoredRoomRecord(malformed)).toThrow(/minPlayers/);
  });

  it("rejects command result event ranges with mismatched sequence metadata", () => {
    const result: StoredCommandResult = {
      roomId: "room_valid",
      matchId: "match_valid",
      userId: "u_host",
      clientSeq: 1,
      commandHash: "hash",
      ok: true,
      seqStart: 1,
      seqEnd: 3,
      events: [
        { schemaVersion: 3, seq: 1, type: "TURN_ENDED", playerId: "u_host", nextPlayerId: "u_guest" },
        { schemaVersion: 3, seq: 3, type: "TURN_ENDED", playerId: "u_guest", nextPlayerId: "u_host" },
      ],
    };

    expect(() => validateStoredCommandResult(result)).toThrow(/expected contiguous event seq 2/);
  });

  it("rejects unknown event types in stored command results", () => {
    const result = {
      roomId: "room_valid",
      matchId: "match_valid",
      userId: "u_host",
      clientSeq: 1,
      commandHash: "hash",
      ok: true,
      events: [{ schemaVersion: 3, seq: 1, type: "UNKNOWN_EVENT" }],
    } as unknown as StoredCommandResult;

    expect(() => validateStoredCommandResult(result)).toThrow(/event payload is invalid/);
  });

  it("rejects malformed events in stored room replay logs", () => {
    const state = {
      ...validStoredRoom(),
      status: "IN_GAME",
      match: {
        id: "match_valid",
        config: {},
        board: {},
        events: [{ schemaVersion: 3, seq: 1, type: "TURN_ENDED", playerId: "u_host" }],
      },
    } as unknown as StoredRoomRecord;

    expect(() => validateStoredRoomRecord(state)).toThrow(/event payload is invalid/);
  });
});
