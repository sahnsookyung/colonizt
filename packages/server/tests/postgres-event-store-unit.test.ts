import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { completeSetup, createDemoGame } from "@colonizt/demo-state";
import type { GameEvent, GameState } from "@colonizt/game-core";
import { PostgresEventStore } from "../src/event-store.js";
import type { Room, Session } from "../src/room-manager.js";

type QueryHandler = (sql: string, params?: readonly unknown[]) => QueryResult<QueryResultRow> | Promise<QueryResult<QueryResultRow>>;

const queryResult = (rows: QueryResultRow[] = [], rowCount = rows.length): QueryResult<QueryResultRow> => ({
  command: "", rowCount, oid: 0, fields: [], rows,
});

const fakePool = (handler: QueryHandler) => {
  const query = vi.fn(handler);
  const clientQuery = vi.fn(handler);
  const release = vi.fn();
  const client = { query: clientQuery, release } as unknown as PoolClient;
  const connect = vi.fn(async () => client);
  return { pool: { query, connect } as unknown as Pool, query, clientQuery, connect, release };
};

const roomFixture = (game: GameState | null = completeSetup(createDemoGame("event-store-unit")).state): Room => ({
  id: "room_event_store",
  code: "EVENT1",
  hostUserId: "p1",
  status: game ? "IN_GAME" : "LOBBY",
  settings: { mode: "CLASSIC", botFill: false, ranked: true, minPlayers: 2, maxPlayers: 4, botDifficulty: "hard", rules: { mapPreset: "standard" } },
  seats: [
    { seatIndex: 0, userId: "p1", displayName: "Ada", ready: true, connected: true },
    { seatIndex: 1, botId: "p2", ready: true, connected: true },
    { seatIndex: 2, ready: false, connected: false },
    { seatIndex: 3, botId: "not-in-match", ready: true, connected: true },
  ],
  spectators: new Set(),
  createdAt: "2026-07-14T00:00:00.000Z",
  lastActivityAt: "2026-07-14T00:01:00.000Z",
  emptySince: "2026-07-14T00:02:00.000Z",
  pausedAt: "2026-07-14T00:03:00.000Z",
  pauseReason: "EMPTY_ROOM",
  archivedAt: "2026-07-14T00:04:00.000Z",
  cleanupReason: "FINISHED_UNLOADED",
  ...(game ? { game, board: game.board } : {}),
  events: [],
  chat: [],
  reports: [],
  processedClientCommands: new Map(),
  timer: { activePlayerId: "p1", expiresAt: 2_000 },
  tradeResponseDeadlines: new Map([["trade_1", 1_000]]),
});

describe("PostgresEventStore adapter", () => {
  it("hashes sessions at rest and rehydrates only from a presented token", async () => {
    const expiresAt = "2026-08-01T00:00:00.000Z";
    const db = fakePool((sql) => {
      if (sql.includes("UPDATE sessions")) return queryResult([{ token: "hash", user_id: "u_1", display_name: "Ada", expires_at: expiresAt }]);
      return queryResult();
    });
    const store = new PostgresEventStore(db.pool);
    const session: Session = { token: "s_secret", userId: "u_1", displayName: "Ada", expiresAt };

    await store.persistSession(session);
    const sessionInsert = db.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO sessions"));
    expect(sessionInsert?.[1]?.[0]).not.toBe(session.token);
    expect(sessionInsert?.[1]).toEqual(expect.arrayContaining(["u_1", "Ada", expiresAt]));
    await expect(store.loadSessionByToken(session.token)).resolves.toEqual(session);
    await expect(store.deleteExpiredSessions(new Date(expiresAt))).resolves.toBe(0);
    expect(db.clientQuery).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM sessions"), [expiresAt]);

    const missing = new PostgresEventStore(fakePool(() => queryResult()).pool);
    await expect(missing.loadSessionByToken("s_missing")).resolves.toBeUndefined();
  });

  it("persists full room lifecycle metadata and filters match players to the game order", async () => {
    const db = fakePool(() => queryResult([{ command_hash: "hash" }], 1));
    const store = new PostgresEventStore(db.pool);
    const room = roomFixture();
    if (!room.game) throw new Error("missing game");

    await store.persistRoom(room);
    expect(db.clientQuery).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO rooms"), expect.arrayContaining([
      room.id, "CLASSIC", "IN_GAME", "p1", room.emptySince, room.pausedAt, room.pauseReason,
      JSON.stringify({ trade_1: 1_000 }), JSON.stringify(room.timer), room.archivedAt, room.cleanupReason,
    ]));

    db.connect.mockClear();
    db.clientQuery.mockClear();
    await store.persistRooms([room, { ...roomFixture(null), id: "room_second", code: "SECOND" }]);
    expect(db.connect).toHaveBeenCalledOnce();
    expect(db.clientQuery.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO rooms"))).toHaveLength(2);
    expect(db.clientQuery).toHaveBeenLastCalledWith("COMMIT");

    db.connect.mockClear();
    db.clientQuery.mockClear();
    await store.persistMatchStart(room, room.game);
    expect(db.connect).toHaveBeenCalledOnce();
    expect(db.clientQuery.mock.calls.map(([sql]) => String(sql))).toEqual([
      "BEGIN",
      expect.stringContaining("INSERT INTO rooms"),
      ...Array.from({ length: room.seats.length }, () => expect.stringContaining("INSERT INTO room_seats")),
      expect.stringContaining("DELETE FROM room_seats"),
      expect.stringContaining("INSERT INTO matches"),
      expect.stringContaining("INSERT INTO match_players"),
      expect.stringContaining("INSERT INTO match_players"),
      "COMMIT",
    ]);
    const playerWrites = db.clientQuery.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO match_players"));
    expect(playerWrites.map(([, params]) => params)).toEqual([
      [room.game.config.matchId, "p1", 0],
      [room.game.config.matchId, "p2", 1],
    ]);
  });

  it("persists sparse room and command records without inventing lifecycle metadata", async () => {
    const db = fakePool(() => queryResult([{ command_hash: "minimal-hash" }], 1));
    const store = new PostgresEventStore(db.pool);
    const room = roomFixture();
    delete room.code;
    delete room.emptySince;
    delete room.pausedAt;
    delete room.pauseReason;
    delete room.archivedAt;
    delete room.cleanupReason;
    delete room.timer;
    room.tradeResponseDeadlines.clear();
    if (!room.game) throw new Error("missing game");
    room.game.eventSeq = 1;

    await store.persistRoom(room);
    await store.commitEvents(room, [], {
      roomId: room.id,
      userId: "p1",
      clientSeq: 1,
      commandHash: "minimal-hash",
      ok: false,
    });
    await store.persistCommandResult({
      roomId: room.id,
      userId: "p1",
      clientSeq: 2,
      commandHash: "minimal-hash",
      ok: false,
    });

    const roomWrites = db.clientQuery.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO rooms"));
    expect(roomWrites).not.toHaveLength(0);
    for (const [, params] of roomWrites) {
      expect(params).not.toEqual(expect.arrayContaining(["EMPTY_ROOM", "FINISHED_UNLOADED"]));
    }
    const commandWrites = [...db.clientQuery.mock.calls, ...db.query.mock.calls]
      .filter(([sql]) => String(sql).includes("INSERT INTO command_results"));
    expect(commandWrites).toHaveLength(2);
    expect(commandWrites.every(([, params]) => params?.includes("minimal-hash"))).toBe(true);
  });

  it("rejects event writes before match start and appends typed events afterward", async () => {
    const db = fakePool(() => queryResult());
    const store = new PostgresEventStore(db.pool);
    await expect(store.appendEvents(roomFixture(null), [])).rejects.toThrow(/before game start/);

    const room = roomFixture();
    const event: GameEvent = { schemaVersion: 3, seq: 1, type: "TURN_ENDED", playerId: "p1", nextPlayerId: "p2" };
    await store.appendEvents(room, [event]);
    expect(db.clientQuery).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO match_events"), [room.game!.config.matchId, 1, "TURN_ENDED", event]);
  });

  it("maps atomic command commits, periodic snapshots, and game winners", async () => {
    const db = fakePool(() => queryResult([{ command_hash: "hash" }], 1));
    const store = new PostgresEventStore(db.pool);
    const room = roomFixture();
    if (!room.game) throw new Error("missing game");
    room.game.eventSeq = 25;
    const turnEvent: GameEvent = { schemaVersion: 3, seq: 25, type: "TURN_ENDED", playerId: "p1", nextPlayerId: "p2" };

    await store.commitEvents(room, [turnEvent], {
      roomId: room.id, matchId: room.game.config.matchId, userId: "p1", clientSeq: 3, commandHash: "hash", ok: true,
      seqStart: 25, seqEnd: 25, events: [turnEvent], rejectionCode: "unused", rejectionMessage: "unused",
    });
    expect(db.clientQuery).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO match_snapshots"), [room.game.config.matchId, 25, room.game]);
    expect(db.clientQuery).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO command_results"), expect.arrayContaining([room.id, room.game.config.matchId, "p1", 3, "hash"]));

    room.game.eventSeq = 26;
    room.game.phase = { type: "GAME_OVER", winnerId: "p1", reason: "VICTORY_POINTS" };
    const gameOver: GameEvent = { schemaVersion: 3, seq: 26, type: "GAME_OVER", winnerId: "p1", reason: "VICTORY_POINTS" };
    await store.commitEvents(room, [gameOver]);
    expect(db.clientQuery).toHaveBeenCalledWith(expect.stringContaining("UPDATE matches"), [room.game.config.matchId, "p1"]);

    await expect(store.commitEvents(roomFixture(null), [])).rejects.toThrow(/before game start/);
  });

  it("handles snapshot and finish no-ops for lobbies and persists active games", async () => {
    const snapshotState = createDemoGame("snapshot-store");
    snapshotState.eventSeq = 4;
    const db = fakePool((sql) => sql.includes("FROM match_snapshots")
      ? queryResult([{ match_id: snapshotState.config.matchId, seq: "4", state_json: snapshotState }])
      : queryResult());
    const store = new PostgresEventStore(db.pool);
    const lobby = roomFixture(null);

    await store.saveSnapshot(lobby, snapshotState);
    await store.markFinished(lobby, "p1");
    expect(db.connect).not.toHaveBeenCalled();

    const room = roomFixture(snapshotState);
    await store.saveSnapshot(room, snapshotState);
    await expect(store.loadLatestSnapshot(snapshotState.config.matchId)).resolves.toEqual({ matchId: snapshotState.config.matchId, seq: 4, state: snapshotState });
    await store.markFinished(room, "p1");
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("UPDATE matches"), [snapshotState.config.matchId, "p1"]);

    const missing = new PostgresEventStore(fakePool(() => queryResult()).pool);
    await expect(missing.loadLatestSnapshot("missing")).resolves.toBeUndefined();
  });

  it("persists chat, reports, and analytics with and without match linkage", async () => {
    const db = fakePool(() => queryResult());
    const store = new PostgresEventStore(db.pool);
    const gameRoom = roomFixture();
    const lobby = roomFixture(null);
    const chat = { id: "chat_1", userId: "p1", message: "hello", createdAt: "2026-07-14T00:00:00.000Z" };
    const report = { id: "report_1", reporterUserId: "p1", reportedUserId: "p2", roomId: gameRoom.id, reason: "spam", status: "OPEN" as const };

    await store.persistChat(gameRoom, chat);
    await store.persistChat(lobby, { ...chat, id: "chat_2" });
    await store.persistReport(gameRoom, report);
    await store.persistReport(lobby, { ...report, id: "report_2" });
    await store.persistAnalytics({ id: "analytics_1", userId: "p1", matchId: gameRoom.game?.config.matchId, eventName: "opened", payload: { source: "menu" } });

    expect(db.clientQuery).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO chat_messages"), ["chat_1", gameRoom.id, gameRoom.game?.config.matchId, "p1", "hello", chat.createdAt]);
    expect(db.clientQuery).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO chat_messages"), ["chat_2", lobby.id, null, "p1", "hello", chat.createdAt]);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO reports"), expect.arrayContaining(["report_2", lobby.id, "p1", "p2", null]));
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO analytics_events"), expect.any(Array));
  });

  it("loads replay logs by match and room and preserves missing results", async () => {
    const game = createDemoGame("load-replay-store");
    const event: GameEvent = { schemaVersion: 3, seq: 1, type: "TURN_ENDED", playerId: "p1", nextPlayerId: "p2" };
    const db = fakePool((sql) => {
      if (sql.includes("SELECT id FROM matches")) return queryResult([{ id: game.config.matchId }]);
      if (sql.includes("SELECT config_json")) return queryResult([{ config_json: game.config, board_json: game.board }]);
      if (sql.includes("FROM match_events")) return queryResult([{ seq: 1, event_type: "TURN_ENDED", payload_json: event }]);
      return queryResult();
    });
    const store = new PostgresEventStore(db.pool);

    await expect(store.loadReplay(game.config.matchId)).resolves.toEqual({ config: game.config, board: game.board, events: [event] });
    await expect(store.loadReplayByRoomId("room_1")).resolves.toEqual({ config: game.config, board: game.board, events: [event] });

    const missing = new PostgresEventStore(fakePool(() => queryResult()).pool);
    await expect(missing.loadReplay("missing")).resolves.toBeUndefined();
    await expect(missing.loadReplayByRoomId("missing")).resolves.toBeUndefined();
  });

  it("maps match lists and complete persisted room records", async () => {
    const game = createDemoGame("load-room-store");
    const roomRow = {
      id: "room_loaded", room_code: "LOAD01", mode: "CLASSIC", status: "IN_GAME", host_user_id: "p1",
      settings_json: { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2, maxPlayers: 4 },
      created_at: "2026-07-14T00:00:00.000Z", last_activity_at: "2026-07-14T00:01:00.000Z",
      empty_since: "2026-07-14T00:02:00.000Z", paused_at: "2026-07-14T00:03:00.000Z", pause_reason: "EMPTY_ROOM",
      trade_deadlines_json: { trade_1: 100 }, timer_json: { activePlayerId: "p1", expiresAt: 200 },
      archived_at: "2026-07-14T00:04:00.000Z", cleanup_reason: "FINISHED_UNLOADED",
    };
    const db = fakePool((sql) => {
      if (sql.includes("FROM matches m")) return queryResult([{ id: game.config.matchId, room_id: "room_loaded", mode: "CLASSIC", ranked: false, started_at: "2026-07-14T00:00:00.000Z", ended_at: null, winner_user_id: null, event_count: 0, player_ids: ["p1", "p2"] }]);
      if (sql.includes("FROM rooms")) return queryResult([roomRow]);
      if (sql.includes("FROM room_seats")) return queryResult([
        { seat_index: 0, user_id: "p1", bot_id: null, ready: true, connected: false },
        { seat_index: 1, user_id: null, bot_id: "p2", ready: true, connected: false },
      ]);
      if (sql.includes("FROM matches") && sql.includes("config_json")) return queryResult([{ id: game.config.matchId, config_json: game.config, board_json: game.board, ended_at: "2026-07-14T01:00:00.000Z", winner_user_id: "p1" }]);
      if (sql.includes("FROM match_events")) return queryResult();
      if (sql.includes("FROM match_snapshots")) return queryResult([{ match_id: game.config.matchId, seq: 0, state_json: game }]);
      return queryResult();
    });
    const store = new PostgresEventStore(db.pool);

    await expect(store.listMatches(3)).resolves.toEqual([expect.objectContaining({ id: game.config.matchId, roomId: "room_loaded" })]);
    const rooms = await store.loadRooms(3);
    expect(rooms).toEqual([expect.objectContaining({
      id: "room_loaded", code: "LOAD01", status: "IN_GAME", lastActivityAt: roomRow.last_activity_at,
      emptySince: roomRow.empty_since, pausedAt: roomRow.paused_at, pauseReason: "EMPTY_ROOM",
      tradeResponseDeadlines: { trade_1: 100 }, timer: { activePlayerId: "p1", expiresAt: 200 },
      archivedAt: roomRow.archived_at, cleanupReason: roomRow.cleanup_reason,
      match: expect.objectContaining({ id: game.config.matchId, snapshot: { matchId: game.config.matchId, seq: 0, state: game }, endedAt: "2026-07-14T01:00:00.000Z", winnerUserId: "p1" }),
    })]);
    await expect(store.loadRoomByRef("LOAD01")).resolves.toMatchObject({ id: "room_loaded", code: "LOAD01" });

    const missing = new PostgresEventStore(fakePool(() => queryResult()).pool);
    await expect(missing.loadRoomByRef("missing")).resolves.toBeUndefined();
  });

  it("maps sparse persisted lobbies without manufacturing optional room or match fields", async () => {
    const roomRow = {
      id: "room_sparse", room_code: null, mode: "CLASSIC", status: "LOBBY", host_user_id: "p1",
      settings_json: { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2, maxPlayers: 4 },
      created_at: "2026-07-14T00:00:00.000Z", last_activity_at: null,
      empty_since: null, paused_at: null, pause_reason: null, trade_deadlines_json: null,
      timer_json: null, archived_at: null, cleanup_reason: null,
    };
    const db = fakePool((sql) => {
      if (sql.includes("FROM rooms")) return queryResult([roomRow]);
      if (sql.includes("FROM room_seats")) return queryResult([
        { seat_index: 0, user_id: "p1", bot_id: null, display_name: null, ready: false, connected: false },
        { seat_index: 1, user_id: null, bot_id: null, display_name: null, ready: false, connected: false },
      ]);
      return queryResult();
    });
    const store = new PostgresEventStore(db.pool);

    const expected = expect.objectContaining({
      id: "room_sparse",
      status: "LOBBY",
      hostUserId: "p1",
      createdAt: roomRow.created_at,
    });
    const rooms = await store.loadRooms();
    expect(rooms).toEqual([expected]);
    expect(rooms[0]).not.toHaveProperty("code");
    expect(rooms[0]).not.toHaveProperty("lastActivityAt");
    expect(rooms[0]).not.toHaveProperty("match");
    const byRef = await store.loadRoomByRef("room_sparse");
    expect(byRef).toEqual(expected);
    expect(byRef).not.toHaveProperty("timer");
    expect(byRef).not.toHaveProperty("cleanupReason");
  });

  it("delegates code lookup and safely avoids bulk raw-token hydration", async () => {
    const db = fakePool((sql) => sql.includes("SELECT 1 FROM rooms") ? queryResult([{ exists: 1 }], 1) : queryResult());
    const store = new PostgresEventStore(db.pool);
    await expect(store.roomCodeExists("EVENT1")).resolves.toBe(true);
    await expect(store.loadSessions(100)).resolves.toEqual([]);
  });

  it("persists and validates full command result records", async () => {
    const event: GameEvent = { schemaVersion: 3, seq: 1, type: "TURN_ENDED", playerId: "p1", nextPlayerId: "p2" };
    const db = fakePool((sql) => {
      if (sql.includes("SELECT room_id")) return queryResult([{
        room_id: "room_1", match_id: "match_1", user_id: "p1", client_seq: 4, command_hash: "hash", ok: true,
        seq_start: 1, seq_end: 1, events_json: [event], rejection_code: "unused", rejection_message: "unused",
      }]);
      return queryResult([{ command_hash: "hash" }], 1);
    });
    const store = new PostgresEventStore(db.pool);
    const result = {
      roomId: "room_1", matchId: "match_1", userId: "p1", clientSeq: 4, commandHash: "hash", ok: true,
      seqStart: 1, seqEnd: 1, events: [event], rejectionCode: "unused", rejectionMessage: "unused",
    };
    await store.persistCommandResult(result);
    await expect(store.loadCommandResult("room_1", "p1", 4)).resolves.toEqual(result);

    const missing = new PostgresEventStore(fakePool(() => queryResult()).pool);
    await expect(missing.loadCommandResult("room_1", "p1", 5)).resolves.toBeUndefined();
  });
});
