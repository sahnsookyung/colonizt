import { describe, expect, it } from "vitest";
import { createDemoGame } from "@colonizt/demo-state";
import { defaultRoomCleanupPolicy, type Room, type RoomStatus } from "../src/room-manager.js";
import { applyRoomCleanupPolicy, cleanupDueAt, resumeRoomIfNeeded } from "../src/room-lifecycle.js";

const now = Date.parse("2026-01-02T00:00:00.000Z");
const room = (status: RoomStatus, connected = false): Room => ({
  id: "room_1",
  code: "ABC234",
  hostUserId: "p1",
  status,
  settings: { mode: "CLASSIC", botFill: false, ranked: false },
  seats: [{ seatIndex: 0, userId: "p1", displayName: "Player", ready: true, connected }],
  spectators: new Set(),
  createdAt: new Date(now - 60_000).toISOString(),
  lastActivityAt: new Date(now - 60_000).toISOString(),
  events: [],
  chat: [],
  reports: [],
  processedClientCommands: new Map(),
  tradeResponseDeadlines: new Map(),
  ...(status === "IN_GAME" || status === "FINISHED" ? { game: createDemoGame("room-lifecycle") } : {}),
});

describe("room lifecycle policy", () => {
  it("marks an empty lobby and expires it only after its TTL", () => {
    const candidate = room("LOBBY");
    expect(applyRoomCleanupPolicy(candidate, defaultRoomCleanupPolicy, now)).toBe(true);
    expect(candidate.emptySince).toBe(new Date(now).toISOString());
    expect(candidate.status).toBe("LOBBY");

    expect(applyRoomCleanupPolicy(candidate, defaultRoomCleanupPolicy, now + defaultRoomCleanupPolicy.emptyLobbyTtlMs - 1)).toBe(false);
    expect(applyRoomCleanupPolicy(candidate, defaultRoomCleanupPolicy, now + defaultRoomCleanupPolicy.emptyLobbyTtlMs)).toBe(true);
    expect(candidate).toMatchObject({ status: "EXPIRED", cleanupReason: "EMPTY_LOBBY_TTL" });
    expect(candidate.archivedAt).toBe(new Date(now + defaultRoomCleanupPolicy.emptyLobbyTtlMs).toISOString());
  });

  it("clears a stale empty marker when a lobby has a connected player", () => {
    const candidate = room("LOBBY", true);
    candidate.emptySince = new Date(now - 1_000).toISOString();
    expect(applyRoomCleanupPolicy(candidate, defaultRoomCleanupPolicy, now)).toBe(true);
    expect(candidate.emptySince).toBeUndefined();
    expect(applyRoomCleanupPolicy(candidate, defaultRoomCleanupPolicy, now)).toBe(false);
  });

  it("pauses an empty game and abandons it after its distinct TTL", () => {
    const candidate = room("IN_GAME");
    expect(applyRoomCleanupPolicy(candidate, defaultRoomCleanupPolicy, now)).toBe(true);
    expect(candidate).toMatchObject({ pauseReason: "EMPTY_ROOM", pausedAt: new Date(now).toISOString(), emptySince: new Date(now).toISOString() });

    const abandonedAt = now + defaultRoomCleanupPolicy.emptyGameTtlMs;
    expect(applyRoomCleanupPolicy(candidate, defaultRoomCleanupPolicy, abandonedAt)).toBe(true);
    expect(candidate).toMatchObject({ status: "ABANDONED", cleanupReason: "EMPTY_GAME_TTL", archivedAt: new Date(abandonedAt).toISOString() });
  });

  it("resumes a reconnected game and shifts all server deadlines by the pause duration", () => {
    const candidate = room("IN_GAME", true);
    candidate.pausedAt = new Date(now - 5_000).toISOString();
    candidate.pauseReason = "EMPTY_ROOM";
    candidate.emptySince = candidate.pausedAt;
    candidate.timer = { activePlayerId: "p1", expiresAt: now + 10_000 };
    candidate.tradeResponseDeadlines.set("trade_1", now + 3_000);

    expect(resumeRoomIfNeeded(candidate, now)).toBe(true);
    expect(candidate.timer.expiresAt).toBe(now + 15_000);
    expect(candidate.tradeResponseDeadlines.get("trade_1")).toBe(now + 8_000);
    expect(candidate.pausedAt).toBeUndefined();
    expect(candidate.pauseReason).toBeUndefined();
    expect(candidate.emptySince).toBeUndefined();
  });

  it("does not resume stalled automation or a room that is still empty", () => {
    const stalled = room("IN_GAME", true);
    stalled.pausedAt = new Date(now - 1_000).toISOString();
    stalled.pauseReason = "STALLED_AUTOMATION";
    expect(resumeRoomIfNeeded(stalled, now)).toBe(false);

    const empty = room("IN_GAME");
    empty.pausedAt = new Date(now - 1_000).toISOString();
    empty.pauseReason = "EMPTY_ROOM";
    expect(resumeRoomIfNeeded(empty, now)).toBe(false);
  });

  it("clears a reconnect marker without a pause and resumes safely without timers", () => {
    const marked = room("IN_GAME", true);
    marked.emptySince = new Date(now - 1_000).toISOString();
    expect(resumeRoomIfNeeded(marked, now)).toBe(true);
    expect(marked.emptySince).toBeUndefined();

    const active = room("IN_GAME", true);
    expect(resumeRoomIfNeeded(active, now)).toBe(false);

    active.pausedAt = new Date(now - 1_000).toISOString();
    active.pauseReason = "EMPTY_ROOM";
    expect(resumeRoomIfNeeded(active, now)).toBe(true);
    expect(active.timer).toBeUndefined();
  });

  it("preserves an empty marker when no seated human has reconnected", () => {
    const empty = room("IN_GAME");
    empty.emptySince = new Date(now - 1_000).toISOString();

    expect(resumeRoomIfNeeded(empty, now)).toBe(false);
    expect(empty.emptySince).toBe(new Date(now - 1_000).toISOString());
  });

  it("unloads finished rooms only when every user is disconnected", () => {
    const candidate = room("FINISHED");
    expect(applyRoomCleanupPolicy(candidate, defaultRoomCleanupPolicy, now)).toBe(true);
    const unloadAt = now + defaultRoomCleanupPolicy.finishedRoomUnloadMs;
    expect(applyRoomCleanupPolicy(candidate, defaultRoomCleanupPolicy, unloadAt)).toBe(true);
    expect(candidate).toMatchObject({ status: "FINISHED", cleanupReason: "FINISHED_UNLOADED", archivedAt: new Date(unloadAt).toISOString() });

    const occupied = room("FINISHED", true);
    occupied.emptySince = new Date(now - 1_000).toISOString();
    expect(applyRoomCleanupPolicy(occupied, defaultRoomCleanupPolicy, now)).toBe(true);
    expect(occupied.emptySince).toBeUndefined();
  });

  it("computes cleanup deadlines for each lifecycle and never schedules active or closed rooms", () => {
    const lobby = room("LOBBY");
    lobby.emptySince = new Date(now - 500).toISOString();
    expect(cleanupDueAt(lobby, defaultRoomCleanupPolicy, now)).toBe(now - 500 + defaultRoomCleanupPolicy.emptyLobbyTtlMs);

    const game = room("IN_GAME");
    expect(cleanupDueAt(game, defaultRoomCleanupPolicy, now)).toBe(now);
    const finished = room("FINISHED");
    finished.emptySince = new Date(now - 500).toISOString();
    expect(cleanupDueAt(finished, defaultRoomCleanupPolicy, now)).toBe(now - 500 + defaultRoomCleanupPolicy.finishedRoomUnloadMs);
    expect(cleanupDueAt(room("LOBBY", true), defaultRoomCleanupPolicy, now)).toBe(Number.POSITIVE_INFINITY);
    expect(cleanupDueAt(room("EXPIRED"), defaultRoomCleanupPolicy, now)).toBe(Number.POSITIVE_INFINITY);
  });
});
