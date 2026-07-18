import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getLegalActions } from "@colonizt/game-core";
import { createPool, loadReplayLog, runMigrations } from "@colonizt/db";
import { maxRoomChatMessages, PostgresEventStore } from "../src/event-store.js";
import { RoomManager } from "../src/room-manager.js";

const testDatabaseUrl = process.env.COLONIZT_TEST_DATABASE_URL;
if (process.env.CI && !testDatabaseUrl) {
  throw new Error("COLONIZT_TEST_DATABASE_URL is required in CI; PostgreSQL integration tests must not be skipped");
}
const describePostgres = testDatabaseUrl ? describe : describe.skip;

describePostgres("PostgresEventStore integration", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    if (!testDatabaseUrl) throw new Error("COLONIZT_TEST_DATABASE_URL is required for this suite");
    pool = createPool({ connectionString: testDatabaseUrl });
    await runMigrations(pool);
  });

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE
        analytics_events,
        reports,
        chat_messages,
        command_results,
        match_snapshots,
        match_events,
        match_players,
        matches,
        room_seats,
        rooms,
        sessions,
        ratings,
        users
      RESTART IDENTITY CASCADE
    `);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("persists sessions, rooms, matches, command results, replay, chat, reports, analytics, and cleanup status", async () => {
    const store = new PostgresEventStore(pool);
    const manager = new RoomManager(store, { emptyLobbyTtlMs: 1000 });
    const session = await manager.createSession("Postgres Host");
    const room = await manager.createRoom(session, { mode: "CLASSIC", botFill: true, ranked: false });
    const ready = await manager.setReady(room.id, session, true);
    if (!ready.ok || !ready.room.game) throw new Error("room did not start");

    const setup = getLegalActions(ready.room.game, session.userId).find((action) => action.type === "PLACE_SETUP");
    const vertexId = setup?.vertices[0];
    const edgeId = vertexId ? ready.room.game.board.adjacency.vertexToEdges[vertexId]?.[0] : undefined;
    if (!vertexId || !edgeId) throw new Error("missing legal setup placement");
    const command = { type: "PLACE_SETUP" as const, playerId: session.userId, vertexId, edgeId };
    const accepted = await manager.submitCommand(room.id, session, 1, command);
    const duplicate = await manager.submitCommand(room.id, session, 1, command);
    expect(accepted.ok).toBe(true);
    expect(duplicate.ok).toBe(true);
    if (duplicate.ok) expect(duplicate.replayed).toBe(true);

    const chat = await manager.addChat(room.id, session, "hello from postgres");
    const report = await manager.createReport(room.id, session, "bot_2", "test report");
    await manager.recordAnalytics({ userId: session.userId, matchId: `match_${room.id}`, eventName: "postgres_integration", payload: { ok: true } });
    expect(chat).toMatchObject({ userId: session.userId });
    expect(report).toMatchObject({ reporterUserId: session.userId, reportedUserId: "bot_2" });

    const replay = await manager.getReplayById(room.id);
    const matches = await manager.listMatchHistory(10);
    expect(replay?.events.map((event) => event.seq)).toEqual([1]);
    expect(matches.some((match) => match.id === `match_${room.id}` && match.eventCount >= 1)).toBe(true);

    const emptyRoom = await manager.createRoom(session, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 4 });
    await manager.syncConnections(emptyRoom.id, new Set(), 1000);
    await manager.cleanupRooms(2100);

    const restarted = new RoomManager(store);
    await restarted.hydrateFromStore();
    const resolved = await restarted.resolveSession(session.token);
    const expiredStatus = await restarted.loadRoomStatusByRef(emptyRoom.code);
    const loadedReplay = await restarted.getReplayById(room.id);
    const recoveredRoom = restarted.roomForRef(room.id);

    expect(resolved?.userId).toBe(session.userId);
    expect(expiredStatus).toMatchObject({ status: "EXPIRED", cleanupReason: "EMPTY_LOBBY_TTL" });
    expect(loadedReplay?.events.map((event) => event.seq)).toEqual([1]);
    expect(recoveredRoom?.chat).toEqual([expect.objectContaining({ id: chat?.id, message: "hello from postgres" })]);
    expect(recoveredRoom?.reports).toEqual([expect.objectContaining({ id: report?.id, reason: "test report", roomId: room.id })]);
  });

  it("persists latest match snapshots and rejects row/payload replay mismatches", async () => {
    const store = new PostgresEventStore(pool);
    const manager = new RoomManager(store, { emptyLobbyTtlMs: 1000 });
    const session = await manager.createSession("Snapshot Host");
    const room = await manager.createRoom(session, { mode: "CLASSIC", botFill: true, ranked: false });
    const ready = await manager.setReady(room.id, session, true);
    if (!ready.ok || !ready.room.game) throw new Error("room did not start");

    await store.saveSnapshot(ready.room, ready.room.game);
    const snapshot = await store.loadLatestSnapshot(ready.room.game.config.matchId);
    expect(snapshot).toMatchObject({
      matchId: ready.room.game.config.matchId,
      seq: ready.room.game.eventSeq,
    });
    expect(snapshot?.state.eventSeq).toBe(ready.room.game.eventSeq);

    await pool.query(
      `INSERT INTO matches(id, mode, ranked, seed_hash, config_json, board_json)
       VALUES ($1, 'CLASSIC', false, 'bad-seed', '{}'::jsonb, '{}'::jsonb)`,
      ["bad_replay_rows"],
    );
    await pool.query(
      `INSERT INTO match_events(match_id, seq, event_type, payload_json)
       VALUES ($1, 1, 'TURN_ENDED', $2)`,
      ["bad_replay_rows", { schemaVersion: 3, seq: 2, type: "TURN_ENDED", playerId: "p1", nextPlayerId: "p2" }],
    );

    await expect(loadReplayLog(pool, "bad_replay_rows")).rejects.toThrow(/row seq 1 does not match payload seq 2/);
  });

  it("persists two-player starts from four-seat lobbies without open seats as match players", async () => {
    const store = new PostgresEventStore(pool);
    const manager = new RoomManager(store);
    const host = await manager.createSession("Postgres Host");
    const guest = await manager.createSession("Postgres Guest");
    const room = await manager.createRoom(host, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2, maxPlayers: 4 });
    const joined = await manager.joinRoom(room.code, guest);
    expect(joined.ok).toBe(true);

    await manager.syncConnections(room.id, new Set([host.userId, guest.userId]));
    await manager.setReady(room.code, host, true);
    await manager.setReady(room.code, guest, true);

    const started = await manager.startRoomByHost(room.code, host);

    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error("start failed");
    expect(started.room.game?.playerOrder).toEqual([host.userId, guest.userId]);
    const rows = await pool.query("SELECT user_id, seat_index FROM match_players WHERE match_id = $1 ORDER BY seat_index", [`match_${room.id}`]);
    expect(rows.rows).toEqual([
      { user_id: host.userId, seat_index: 0 },
      { user_id: guest.userId, seat_index: 1 },
    ]);
  });

  it("persists lobby host transfers and removes seats after shrinking", async () => {
    const store = new PostgresEventStore(pool);
    const manager = new RoomManager(store);
    const host = await manager.createSession("Original Host");
    const guest = await manager.createSession("New Host");
    const room = await manager.createRoom(host, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2, maxPlayers: 4 });
    expect((await manager.joinRoom(room.id, guest)).ok).toBe(true);
    expect((await manager.leaveRoom(room.id, host)).ok).toBe(true);
    expect((await manager.updateRoomSettings(room.id, guest, { maxPlayers: 2 })).ok).toBe(true);

    const restarted = new RoomManager(store);
    await restarted.hydrateFromStore();
    const recovered = restarted.roomForRef(room.id);

    expect(recovered?.hostUserId).toBe(guest.userId);
    expect(recovered?.seats).toHaveLength(2);
    expect(recovered?.seats.some((seat) => seat.userId === guest.userId)).toBe(true);
  });

  it("atomically switches rooms, bounds durable chat, and deletes expired sessions", async () => {
    const store = new PostgresEventStore(pool);
    const manager = new RoomManager(store);
    const oldHost = await manager.createSession("Old Host");
    const newHost = await manager.createSession("New Host");
    const guest = await manager.createSession("Switching Guest");
    const idleGuest = await manager.createSession("Idle Guest");
    const oldRoom = await manager.createRoom(oldHost, { mode: "CLASSIC", botFill: false, ranked: false });
    const newRoom = await manager.createRoom(newHost, { mode: "CLASSIC", botFill: false, ranked: false });
    await manager.joinRoom(oldRoom.id, guest);

    await expect(manager.switchRoom(oldRoom.id, newRoom.id, guest)).resolves.toMatchObject({ ok: true, room: { id: newRoom.id } });
    for (let index = 0; index < maxRoomChatMessages + 5; index += 1) {
      await manager.addChat(newRoom.id, guest, `postgres chat ${index}`);
    }
    guest.expiresAt = new Date(Date.now() - 1).toISOString();
    idleGuest.expiresAt = guest.expiresAt;
    await store.persistSession(guest);
    await store.persistSession(idleGuest);
    await expect(manager.sweepExpiredSessions()).resolves.toMatchObject({ cached: 2, persisted: 2 });

    const restarted = new RoomManager(store);
    await restarted.hydrateFromStore();
    const recoveredOldRoom = restarted.roomForRef(oldRoom.id);
    const recoveredNewRoom = restarted.roomForRef(newRoom.id);
    const persistedChatCount = await pool.query("SELECT COUNT(*)::int AS count FROM chat_messages WHERE room_id = $1", [newRoom.id]);
    const retainedUsers = await pool.query("SELECT id FROM users WHERE id = ANY($1::text[]) ORDER BY id", [[guest.userId, idleGuest.userId]]);

    expect(recoveredOldRoom?.seats.some((seat) => seat.userId === guest.userId)).toBe(false);
    expect(recoveredNewRoom?.seats.some((seat) => seat.userId === guest.userId)).toBe(true);
    expect(recoveredNewRoom?.chat).toHaveLength(maxRoomChatMessages);
    expect(recoveredNewRoom?.chat[0]?.message).toBe("postgres chat 5");
    expect(persistedChatCount.rows[0]?.count).toBe(maxRoomChatMessages);
    expect(retainedUsers.rows).toEqual([{ id: guest.userId }]);
    await expect(restarted.resolveSession(guest.token)).resolves.toBeUndefined();
  });
});
