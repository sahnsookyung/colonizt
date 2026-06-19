import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getLegalActions } from "@colonizt/game-core";
import { createPool, runMigrations } from "@colonizt/db";
import { PostgresEventStore } from "../src/event-store.js";
import { RoomManager } from "../src/room-manager.js";

const testDatabaseUrl = process.env.COLONIZT_TEST_DATABASE_URL;
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

    expect(resolved?.userId).toBe(session.userId);
    expect(expiredStatus).toMatchObject({ status: "EXPIRED", cleanupReason: "EMPTY_LOBBY_TTL" });
    expect(loadedReplay?.events.map((event) => event.seq)).toEqual([1]);
  });
});
