import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import {
  acquireRoomLease,
  appendMatchEvents,
  commitMatchEvents,
  createPool,
  deleteExpiredSessions,
  findCommandResult,
  findPersistedRoomByRef,
  findPersistedSessionByTokenHash,
  insertAnalyticsEvent,
  insertChatMessage,
  insertMatch,
  insertMatchAndRoom,
  insertReport,
  listMatchSummaries,
  listPersistedRooms,
  listPersistedSessions,
  loadLatestMatchSnapshot,
  loadReplayLog,
  loadReplayLogByRoomId,
  markMatchFinished,
  maxRoomChatMessages,
  persistedRoomCodeExists,
  readMigration,
  releaseRoomLease,
  runMigrations,
  saveMatchSnapshot,
  upsertCommandResult,
  upsertRoom,
  upsertRooms,
  upsertSession,
  type PersistRoomInput,
} from "../src/index.js";

type QueryHandler = (sql: string, params?: readonly unknown[]) => QueryResult<QueryResultRow> | Promise<QueryResult<QueryResultRow>>;

const queryResult = (rows: QueryResultRow[] = [], rowCount = rows.length): QueryResult<QueryResultRow> => ({
  command: "",
  rowCount,
  oid: 0,
  fields: [],
  rows,
});

const fakePool = (poolHandler: QueryHandler, clientHandler: QueryHandler = poolHandler) => {
  const query = vi.fn(poolHandler);
  const clientQuery = vi.fn(clientHandler);
  const release = vi.fn();
  const client = { query: clientQuery, release } as unknown as PoolClient;
  const connect = vi.fn(async () => client);
  const pool = { query, connect } as unknown as Pool;
  return { pool, query, clientQuery, connect, release };
};

const roomInput = (overrides: Partial<PersistRoomInput> = {}): PersistRoomInput => ({
  id: "room_1",
  code: "ROOM01",
  mode: "CLASSIC",
  status: "LOBBY",
  hostUserId: "u_host",
  settings: { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2, maxPlayers: 2 },
  seats: [
    { seatIndex: 0, userId: "u_host", ready: true, connected: true },
    { seatIndex: 1, botId: "bot_2", ready: true, connected: true },
  ],
  lastActivityAt: "2026-07-14T00:00:00.000Z",
  ...overrides,
});

describe("database contracts", () => {
  it("creates a lazy PostgreSQL pool and reads packaged migrations", async () => {
    const pool = createPool({ connectionString: "postgres://example.invalid/colonizt" });
    expect(pool.options.connectionString).toBe("postgres://example.invalid/colonizt");
    await pool.end();

    await expect(readMigration("001_init.sql")).resolves.toContain("CREATE TABLE");
    await expect(readMigration("missing.sql")).rejects.toThrow();
  });

  it("applies only missing migrations transactionally", async () => {
    const appliedNames: string[] = [];
    const { pool, clientQuery, release } = fakePool(
      (sql, params) => sql.includes("SELECT 1 FROM schema_migrations")
        ? queryResult([], params?.[0] === "001_init.sql" ? 1 : 0)
        : queryResult(),
      (sql, params) => {
        if (sql.includes("INSERT INTO schema_migrations")) appliedNames.push(String(params?.[0]));
        return queryResult();
      },
    );

    await runMigrations(pool);

    expect(appliedNames).not.toContain("001_init.sql");
    expect(appliedNames).toContain("007_room_timer.sql");
    expect(appliedNames).toContain("008_room_content.sql");
    expect(appliedNames).toContain("009_session_expiry_index.sql");
    expect(appliedNames).toContain("010_chat_retention_sequence.sql");
    expect(clientQuery.mock.calls.filter(([sql]) => sql === "BEGIN")).toHaveLength(9);
    expect(clientQuery.mock.calls.filter(([sql]) => sql === "COMMIT")).toHaveLength(9);
    expect(release).toHaveBeenCalledTimes(9);
  });

  it("rolls back and releases a failed migration", async () => {
    const failure = new Error("migration failed");
    const { pool, clientQuery, release } = fakePool(
      (sql) => sql.includes("SELECT 1 FROM schema_migrations") ? queryResult([], 0) : queryResult(),
      (sql) => {
        if (sql !== "BEGIN" && sql !== "ROLLBACK") throw failure;
        return queryResult();
      },
    );

    await expect(runMigrations(pool)).rejects.toBe(failure);
    expect(clientQuery).toHaveBeenCalledWith("ROLLBACK");
    expect(release).toHaveBeenCalledOnce();
  });

  it("appends event batches atomically and rolls back failed batches", async () => {
    const success = fakePool(() => queryResult());
    await appendMatchEvents(success.pool, "match_1", [
      { seq: 1, type: "TURN_ENDED", payload: { seq: 1, type: "TURN_ENDED" } },
      { seq: 2, type: "GAME_OVER", payload: { seq: 2, type: "GAME_OVER" } },
    ]);
    expect(success.clientQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO match_events"),
      ["match_1", 2, "GAME_OVER", { seq: 2, type: "GAME_OVER" }],
    );
    expect(success.clientQuery).toHaveBeenLastCalledWith("COMMIT");
    expect(success.release).toHaveBeenCalledOnce();

    const failure = new Error("event write failed");
    const failed = fakePool(
      () => queryResult(),
      (sql) => {
        if (sql.includes("INSERT INTO match_events")) throw failure;
        return queryResult();
      },
    );
    await expect(appendMatchEvents(failed.pool, "match_1", [{ seq: 1, type: "BAD", payload: {} }])).rejects.toBe(failure);
    expect(failed.clientQuery).toHaveBeenCalledWith("ROLLBACK");
    expect(failed.release).toHaveBeenCalledOnce();
  });

  it("persists and hydrates sessions including timestamp representations", async () => {
    const expiresAt = new Date("2026-08-01T00:00:00.000Z");
    const { pool, query, clientQuery } = fakePool((sql) => {
      if (sql.includes("FROM sessions") && sql.includes("ORDER BY")) {
        return queryResult([
          { token: "hash_1", user_id: "u_1", display_name: "Ada", expires_at: expiresAt },
          { token: "hash_2", user_id: "u_2", display_name: "Ben", expires_at: "2026-09-01T00:00:00.000Z" },
          { token: "hash_3", user_id: "u_3", display_name: "Cyra", expires_at: null },
        ]);
      }
      if (sql.includes("UPDATE sessions")) {
        return queryResult([{ token: "hash_1", user_id: "u_1", display_name: "Ada", expires_at: expiresAt }]);
      }
      if (sql.startsWith("DELETE FROM sessions")) return queryResult([{ user_id: "u_1" }, { user_id: "u_2" }]);
      return queryResult();
    });

    await upsertSession(pool, { tokenHash: "hash_1", userId: "u_1", displayName: "Ada", expiresAt: expiresAt.toISOString() });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO sessions"), ["hash_1", "u_1", "Ada", expiresAt.toISOString()]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO users"), ["u_1", "Ada"]);
    await expect(listPersistedSessions(pool, 3)).resolves.toEqual([
      { tokenHash: "hash_1", userId: "u_1", displayName: "Ada", expiresAt: expiresAt.toISOString() },
      { tokenHash: "hash_2", userId: "u_2", displayName: "Ben", expiresAt: "2026-09-01T00:00:00.000Z" },
      { tokenHash: "hash_3", userId: "u_3", displayName: "Cyra", expiresAt: undefined },
    ]);
    await expect(findPersistedSessionByTokenHash(pool, "hash_1")).resolves.toEqual({
      tokenHash: "hash_1", userId: "u_1", displayName: "Ada", expiresAt: expiresAt.toISOString(),
    });
    await expect(deleteExpiredSessions(pool, expiresAt)).resolves.toBe(2);
    expect(clientQuery).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM sessions"), [expiresAt.toISOString()]);
    expect(clientQuery).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM users"), [["u_1", "u_2"]]);

    const missing = fakePool(() => queryResult());
    await expect(findPersistedSessionByTokenHash(missing.pool, "missing")).resolves.toBeUndefined();
  });

  it("persists rooms and matches transactionally with exact seats and players", async () => {
    const { pool, clientQuery } = fakePool(() => queryResult());
    const room = roomInput({
      emptySince: "2026-07-14T00:01:00.000Z",
      pausedAt: "2026-07-14T00:02:00.000Z",
      pauseReason: "EMPTY_ROOM",
      tradeResponseDeadlines: { trade_1: 1234 },
      timer: { activePlayerId: "u_host", expiresAt: 5678 },
      archivedAt: "2026-07-14T00:03:00.000Z",
      cleanupReason: "FINISHED_UNLOADED",
    });
    await upsertRoom(pool, room);
    expect(clientQuery).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO rooms"), expect.arrayContaining([
      "room_1", "CLASSIC", "LOBBY", "u_host", JSON.stringify({ trade_1: 1234 }), JSON.stringify({ activePlayerId: "u_host", expiresAt: 5678 }),
    ]));
    expect(clientQuery).toHaveBeenCalledWith("DELETE FROM room_seats WHERE room_id = $1 AND seat_index >= $2", ["room_1", 2]);

    await insertMatch(pool, {
      id: "match_1", roomId: "room_1", mode: "CLASSIC", ranked: true, seedHash: "seed", config: { victoryPoints: 10 }, board: { hexes: {} },
      players: [{ userId: "u_host", seatIndex: 0 }, { userId: "bot_2", seatIndex: 1 }],
    });
    expect(clientQuery).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO match_players"), ["match_1", "bot_2", 1]);
  });

  it("persists multiple room states in one transaction", async () => {
    const { pool, clientQuery, connect, release } = fakePool(() => queryResult());
    await upsertRooms(pool, [roomInput(), roomInput({ id: "room_2", code: "ROOM02", hostUserId: "u_guest" })]);

    expect(connect).toHaveBeenCalledOnce();
    expect(clientQuery.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO rooms"))).toHaveLength(2);
    expect(clientQuery).toHaveBeenLastCalledWith("COMMIT");
    expect(release).toHaveBeenCalledOnce();
    await expect(upsertRooms(pool, [])).resolves.toBeUndefined();
    expect(connect).toHaveBeenCalledOnce();
  });

  it("rolls back room, match, and snapshot transactions on write failures", async () => {
    const failure = new Error("write failed");
    for (const operation of [
      (pool: Pool) => upsertRoom(pool, roomInput()),
      (pool: Pool) => upsertRooms(pool, [roomInput(), roomInput({ id: "room_2" })]),
      (pool: Pool) => insertMatch(pool, { id: "match_1", roomId: "room_1", mode: "CLASSIC", ranked: false, seedHash: "seed", config: {}, board: {}, players: [] }),
      (pool: Pool) => insertMatchAndRoom(
        pool,
        { id: "match_1", roomId: "room_1", mode: "CLASSIC", ranked: false, seedHash: "seed", config: {}, board: {}, players: [] },
        roomInput({ status: "IN_GAME" }),
      ),
      (pool: Pool) => saveMatchSnapshot(pool, { matchId: "match_1", seq: 4, state: { eventSeq: 4 } }),
      (pool: Pool) => insertChatMessage(pool, { id: "chat_1", roomId: "room_1", userId: "u_host", message: "hello" }),
      (pool: Pool) => deleteExpiredSessions(pool),
    ]) {
      const failed = fakePool(
        () => queryResult(),
        (sql) => {
          if (sql !== "BEGIN" && sql !== "ROLLBACK") throw failure;
          return queryResult();
        },
      );
      await expect(operation(failed.pool)).rejects.toBe(failure);
      expect(failed.clientQuery).toHaveBeenCalledWith("ROLLBACK");
      expect(failed.release).toHaveBeenCalledOnce();
    }
  });

  it("writes match completion, room-linked content, and analytics with nullable match links", async () => {
    const { pool, query, clientQuery } = fakePool(() => queryResult());
    await markMatchFinished(pool, "match_1", "u_host");
    await insertChatMessage(pool, { id: "chat_1", roomId: "room_1", userId: "u_host", message: "hello" });
    await insertReport(pool, { id: "report_1", roomId: "room_1", reporterUserId: "u_host", reportedUserId: "u_guest", reason: "spam", status: "OPEN" });
    await insertAnalyticsEvent(pool, { id: "analytics_1", eventName: "opened", payload: { source: "menu" } });

    expect(query).toHaveBeenCalledWith(expect.stringContaining("UPDATE matches"), ["match_1", "u_host"]);
    expect(clientQuery).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO chat_messages"), ["chat_1", "room_1", null, "u_host", "hello", null]);
    expect(clientQuery).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM chat_messages"), ["room_1", maxRoomChatMessages]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO reports"), ["report_1", "room_1", "u_host", "u_guest", null, "spam", "OPEN"]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO analytics_events"), ["analytics_1", null, null, "opened", { source: "menu" }]);
  });

  it("stores command results once and reports idempotency conflicts", async () => {
    const accepted = fakePool(() => queryResult([{ command_hash: "hash" }], 1));
    await expect(upsertCommandResult(accepted.pool, {
      roomId: "room_1", matchId: "match_1", userId: "u_host", clientSeq: 2, commandHash: "hash", ok: true,
      seqStart: 4, seqEnd: 5, events: [{ seq: 4 }], rejectionCode: "unused", rejectionMessage: "unused",
    })).resolves.toBeUndefined();
    expect(accepted.query.mock.calls[0]?.[1]).toEqual([
      "room_1", "match_1", "u_host", 2, "hash", true, 4, 5, JSON.stringify([{ seq: 4 }]), "unused", "unused",
    ]);

    const conflict = fakePool(() => queryResult([], 0));
    await expect(upsertCommandResult(conflict.pool, {
      roomId: "room_1", userId: "u_host", clientSeq: 2, commandHash: "hash", ok: false,
    })).rejects.toMatchObject({ code: "COMMAND_RESULT_CONFLICT" });
  });

  it("commits events, command result, snapshot, winner, and room in one transaction", async () => {
    const { pool, clientQuery } = fakePool(() => queryResult([{ command_hash: "hash" }], 1));
    await commitMatchEvents(pool, {
      room: roomInput({ status: "FINISHED" }),
      matchId: "match_1",
      events: [{ seq: 10, type: "GAME_OVER", payload: { seq: 10, type: "GAME_OVER" } }],
      commandResult: { roomId: "room_1", matchId: "match_1", userId: "u_host", clientSeq: 8, commandHash: "hash", ok: true },
      snapshot: { matchId: "match_1", seq: 10, state: { eventSeq: 10 } },
      winnerUserId: "u_host",
    });

    expect(clientQuery).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO match_events"), ["match_1", 10, "GAME_OVER", { seq: 10, type: "GAME_OVER" }]);
    expect(clientQuery).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO command_results"), expect.any(Array));
    expect(clientQuery).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO match_snapshots"), ["match_1", 10, { eventSeq: 10 }]);
    expect(clientQuery).toHaveBeenCalledWith(expect.stringContaining("UPDATE matches"), ["match_1", "u_host"]);
    expect(clientQuery).toHaveBeenLastCalledWith("COMMIT");
  });

  it("rolls back a commit when its command result conflicts", async () => {
    const conflict = fakePool(() => queryResult([], 0));
    await expect(commitMatchEvents(conflict.pool, {
      room: roomInput(),
      matchId: "match_1",
      events: [],
      commandResult: { roomId: "room_1", userId: "u_host", clientSeq: 1, commandHash: "hash", ok: true },
    })).rejects.toMatchObject({ code: "COMMAND_RESULT_CONFLICT" });
    expect(conflict.clientQuery).toHaveBeenCalledWith("ROLLBACK");
    expect(conflict.release).toHaveBeenCalledOnce();
  });

  it("hydrates complete and missing command results", async () => {
    const { pool } = fakePool(() => queryResult([{
      room_id: "room_1", match_id: "match_1", user_id: "u_host", client_seq: "7", command_hash: "hash", ok: false,
      seq_start: "8", seq_end: "9", events_json: [{ seq: 8 }], rejection_code: "NOPE", rejection_message: "Rejected",
    }]));
    await expect(findCommandResult(pool, "room_1", "u_host", 7)).resolves.toEqual({
      roomId: "room_1", matchId: "match_1", userId: "u_host", clientSeq: 7, commandHash: "hash", ok: false,
      seqStart: 8, seqEnd: 9, events: [{ seq: 8 }], rejectionCode: "NOPE", rejectionMessage: "Rejected",
    });
    await expect(findCommandResult(fakePool(() => queryResult()).pool, "room_1", "u_host", 8)).resolves.toBeUndefined();
  });

  it("saves and loads latest snapshots", async () => {
    const save = fakePool(() => queryResult());
    await saveMatchSnapshot(save.pool, { matchId: "match_1", seq: 25, state: { eventSeq: 25 } });
    expect(save.clientQuery).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO match_snapshots"), ["match_1", 25, { eventSeq: 25 }]);

    const load = fakePool(() => queryResult([{ match_id: "match_1", seq: "25", state_json: { eventSeq: 25 } }]));
    await expect(loadLatestMatchSnapshot(load.pool, "match_1")).resolves.toEqual({ matchId: "match_1", seq: 25, state: { eventSeq: 25 } });
    await expect(loadLatestMatchSnapshot(fakePool(() => queryResult()).pool, "missing")).resolves.toBeUndefined();
  });

  it("loads replay logs by match and room while validating row metadata", async () => {
    const payload = { schemaVersion: 3, seq: 1, type: "TURN_ENDED", playerId: "u_host", nextPlayerId: "u_guest" };
    const byMatch = fakePool((sql) => {
      if (sql.includes("SELECT config_json")) return queryResult([{ config_json: { matchId: "match_1" }, board_json: { hexes: {} } }]);
      if (sql.includes("FROM match_events")) return queryResult([{ seq: 1, event_type: "TURN_ENDED", payload_json: payload }]);
      return queryResult();
    });
    await expect(loadReplayLog(byMatch.pool, "match_1")).resolves.toEqual({
      config: { matchId: "match_1" }, board: { hexes: {} }, events: [payload],
    });
    await expect(loadReplayLog(fakePool(() => queryResult()).pool, "missing")).resolves.toBeUndefined();

    const byRoom = fakePool((sql) => {
      if (sql.includes("SELECT id FROM matches")) return queryResult([{ id: "match_1" }]);
      if (sql.includes("SELECT config_json")) return queryResult([{ config_json: {}, board_json: {} }]);
      if (sql.includes("FROM match_events")) return queryResult([{ seq: 1, event_type: "TURN_ENDED", payload_json: payload }]);
      return queryResult();
    });
    await expect(loadReplayLogByRoomId(byRoom.pool, "room_1")).resolves.toEqual({ matchId: "match_1", config: {}, board: {}, events: [payload] });
    await expect(loadReplayLogByRoomId(fakePool(() => queryResult()).pool, "missing")).resolves.toBeUndefined();
  });

  it("rejects malformed, sequence-mismatched, and type-mismatched event rows", async () => {
    for (const row of [
      { seq: 1, event_type: "TURN_ENDED", payload_json: null },
      { seq: 1, event_type: "TURN_ENDED", payload_json: { seq: 2, type: "TURN_ENDED" } },
      { seq: 1, event_type: "TURN_ENDED", payload_json: { seq: 1, type: "GAME_OVER" } },
    ]) {
      const { pool } = fakePool((sql) => {
        if (sql.includes("SELECT config_json")) return queryResult([{ config_json: {}, board_json: {} }]);
        if (sql.includes("FROM match_events")) return queryResult([row]);
        return queryResult();
      });
      await expect(loadReplayLog(pool, "match_bad")).rejects.toThrow(/Persisted event row/);
    }
  });

  it("maps match summaries across Date, string, and nullable columns", async () => {
    const startedAt = new Date("2026-07-14T00:00:00.000Z");
    const { pool } = fakePool(() => queryResult([
      { id: "match_1", room_id: "room_1", mode: "CLASSIC", ranked: true, started_at: startedAt, ended_at: new Date("2026-07-14T01:00:00.000Z"), winner_user_id: "u_host", event_count: "12", player_ids: ["u_host"] },
      { id: "match_2", room_id: "room_2", mode: "DUEL", ranked: false, started_at: "2026-07-13T00:00:00.000Z", ended_at: null, winner_user_id: null, event_count: 0, player_ids: null },
    ]));

    await expect(listMatchSummaries(pool, 2)).resolves.toEqual([
      { id: "match_1", roomId: "room_1", mode: "CLASSIC", ranked: true, startedAt: startedAt.toISOString(), endedAt: "2026-07-14T01:00:00.000Z", winnerUserId: "u_host", eventCount: 12, playerIds: ["u_host"] },
      { id: "match_2", roomId: "room_2", mode: "DUEL", ranked: false, startedAt: "2026-07-13T00:00:00.000Z", endedAt: undefined, winnerUserId: undefined, eventCount: 0, playerIds: [] },
    ]);
  });

  it("hydrates persisted rooms with lifecycle, timer, match, snapshot, and disconnected seats", async () => {
    const createdAt = new Date("2026-07-14T00:00:00.000Z");
    const event = { schemaVersion: 3, seq: 1, type: "TURN_ENDED", playerId: "u_host", nextPlayerId: "bot_2" };
    const roomRow = {
      id: "room_1", room_code: "ROOM01", mode: "CLASSIC", status: "IN_GAME", host_user_id: "u_host", settings_json: { mode: "CLASSIC" }, created_at: createdAt,
      last_activity_at: "2026-07-14T00:01:00.000Z", empty_since: new Date("2026-07-14T00:02:00.000Z"), paused_at: "2026-07-14T00:03:00.000Z",
      pause_reason: "EMPTY_ROOM", trade_deadlines_json: { valid: 123, invalid: "soon", infinite: Number.POSITIVE_INFINITY },
      timer_json: { activePlayerId: "u_host", expiresAt: 456 }, archived_at: "2026-07-14T00:04:00.000Z", cleanup_reason: "FINISHED_UNLOADED",
    };
    const { pool } = fakePool((sql) => {
      if (sql.includes("FROM rooms")) return queryResult([roomRow]);
      if (sql.includes("FROM room_seats")) return queryResult([{ seat_index: 0, user_id: "u_host", bot_id: null, ready: true, connected: true }]);
      if (sql.includes("FROM matches") && sql.includes("config_json")) return queryResult([{ id: "match_1", config_json: { matchId: "match_1" }, board_json: {}, ended_at: new Date("2026-07-14T01:00:00.000Z"), winner_user_id: "u_host" }]);
      if (sql.includes("FROM match_events")) return queryResult([{ seq: 1, event_type: "TURN_ENDED", payload_json: event }]);
      if (sql.includes("FROM match_snapshots")) return queryResult([{ match_id: "match_1", seq: 1, state_json: { eventSeq: 1 } }]);
      return queryResult();
    });

    const records = await listPersistedRooms(pool, 1);
    expect(records).toEqual([expect.objectContaining({
      id: "room_1", code: "ROOM01", createdAt: createdAt.toISOString(), lastActivityAt: "2026-07-14T00:01:00.000Z",
      emptySince: "2026-07-14T00:02:00.000Z", pausedAt: "2026-07-14T00:03:00.000Z", archivedAt: "2026-07-14T00:04:00.000Z",
      pauseReason: "EMPTY_ROOM", cleanupReason: "FINISHED_UNLOADED", tradeResponseDeadlines: { valid: 123 },
      timer: { activePlayerId: "u_host", expiresAt: 456 },
      seats: [{ seatIndex: 0, userId: "u_host", botId: undefined, ready: true, connected: false }],
      match: expect.objectContaining({ id: "match_1", events: [event], snapshot: { matchId: "match_1", seq: 1, state: { eventSeq: 1 } }, endedAt: "2026-07-14T01:00:00.000Z", winnerUserId: "u_host" }),
    })]);

    await expect(findPersistedRoomByRef(pool, " room01 ")).resolves.toMatchObject({ id: "room_1", code: "ROOM01" });
  });

  it("hydrates multiple rooms with a fixed batch of relation queries", async () => {
    const roomRows = [
      { id: "room_1", room_code: "ROOM01", mode: "CLASSIC", status: "IN_GAME", host_user_id: "u_1", settings_json: {}, created_at: "2026-07-14T00:00:00.000Z" },
      { id: "room_2", room_code: "ROOM02", mode: "DUEL", status: "IN_GAME", host_user_id: "u_2", settings_json: {}, created_at: "2026-07-14T00:01:00.000Z" },
    ];
    const { pool, query } = fakePool((sql) => {
      if (sql.includes("FROM rooms")) return queryResult(roomRows);
      if (sql.includes("FROM room_seats")) return queryResult([
        { room_id: "room_1", seat_index: 0, user_id: "u_1", bot_id: null, ready: true },
        { room_id: "room_2", seat_index: 0, user_id: "u_2", bot_id: null, ready: true },
      ]);
      if (sql.includes("FROM matches") && sql.includes("config_json")) return queryResult([
        { room_id: "room_1", id: "match_1", config_json: { matchId: "match_1" }, board_json: {} },
        { room_id: "room_2", id: "match_2", config_json: { matchId: "match_2" }, board_json: {} },
      ]);
      if (sql.includes("FROM match_events")) return queryResult([
        { match_id: "match_1", seq: 1, event_type: "TURN_ENDED", payload_json: { seq: 1, type: "TURN_ENDED" } },
        { match_id: "match_2", seq: 1, event_type: "GAME_OVER", payload_json: { seq: 1, type: "GAME_OVER" } },
      ]);
      if (sql.includes("FROM chat_messages")) return queryResult([
        { room_id: "room_2", id: "chat_2", user_id: "u_2", message: "latest", created_at: "2026-07-14T00:02:00.000Z" },
      ]);
      return queryResult();
    });

    const records = await listPersistedRooms(pool, 200);

    expect(query).toHaveBeenCalledTimes(7);
    expect(records).toEqual([
      expect.objectContaining({ id: "room_1", seats: [expect.objectContaining({ userId: "u_1" })], match: expect.objectContaining({ id: "match_1", events: [{ seq: 1, type: "TURN_ENDED" }] }) }),
      expect.objectContaining({ id: "room_2", chat: [expect.objectContaining({ message: "latest" })], match: expect.objectContaining({ id: "match_2", events: [{ seq: 1, type: "GAME_OVER" }] }) }),
    ]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("ROW_NUMBER() OVER"), [["room_1", "room_2"], maxRoomChatMessages]);
  });

  it("hydrates minimal rooms without matches and handles missing lookups", async () => {
    const minimalRow = { id: "room_2", room_code: null, mode: "DUEL", status: "LOBBY", host_user_id: "u_2", settings_json: {}, created_at: null };
    const minimal = fakePool((sql) => {
      if (sql.includes("FROM rooms")) return queryResult([minimalRow]);
      return queryResult();
    });
    const records = await listPersistedRooms(minimal.pool, 1);
    expect(records[0]).toMatchObject({ id: "room_2", seats: [] });
    expect(records[0]?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    await expect(findPersistedRoomByRef(fakePool(() => queryResult()).pool, "missing")).resolves.toBeUndefined();
  });

  it("normalizes room codes and maps lease acquisition and release outcomes", async () => {
    const expiresAt = new Date("2026-07-14T00:10:00.000Z");
    const { pool, query } = fakePool((sql) => {
      if (sql.startsWith("SELECT 1 FROM rooms")) return queryResult([{ exists: 1 }], 1);
      if (sql.includes("INSERT INTO room_leases")) return queryResult([{ room_id: "room_1", owner_id: "node_1", expires_at: expiresAt }]);
      if (sql.includes("DELETE FROM room_leases")) return queryResult([], 1);
      return queryResult();
    });
    await expect(persistedRoomCodeExists(pool, " room01 ")).resolves.toBe(true);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("room_code = $1"), ["ROOM01"]);
    await expect(acquireRoomLease(pool, "room_1", "node_1", 30_000)).resolves.toEqual({ roomId: "room_1", ownerId: "node_1", expiresAt: expiresAt.toISOString() });
    await expect(releaseRoomLease(pool, "room_1", "node_1")).resolves.toBe(true);

    const denied = fakePool(() => queryResult());
    await expect(persistedRoomCodeExists(denied.pool, "none")).resolves.toBe(false);
    await expect(acquireRoomLease(denied.pool, "room_1", "node_2", 30_000)).resolves.toBeUndefined();
    await expect(releaseRoomLease(denied.pool, "room_1", "node_2")).resolves.toBe(false);
  });
});
