import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;

export interface DbConfig {
  connectionString: string;
}

export const createPool = (config: DbConfig): pg.Pool => new Pool({ connectionString: config.connectionString });

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../migrations");

export const migrationFiles = [
  "001_init.sql",
  "002_sessions_and_event_writes.sql",
  "003_command_results_and_room_metadata.sql",
  "004_session_column_backfill.sql",
  "005_room_lifecycle_and_invites.sql",
  "006_liveness_and_room_leases.sql",
  "007_room_timer.sql",
];

export const readMigration = async (name: string): Promise<string> => readFile(join(migrationsDir, name), "utf8");

export const runMigrations = async (pool: pg.Pool): Promise<void> => {
  await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  for (const file of migrationFiles) {
    const applied = await pool.query("SELECT 1 FROM schema_migrations WHERE name = $1", [file]);
    if ((applied.rowCount ?? 0) > 0) continue;
    const sql = await readMigration(file);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations(name) VALUES ($1)", [file]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
};

export const appendMatchEvents = async (
  pool: pg.Pool,
  matchId: string,
  events: Array<{ seq: number; type: string; payload: unknown }>,
): Promise<void> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const event of events) {
      await client.query(
        "INSERT INTO match_events(match_id, seq, event_type, payload_json) VALUES ($1, $2, $3, $4)",
        [matchId, event.seq, event.type, event.payload],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export interface PersistRoomInput {
  id: string;
  mode: string;
  status: string;
  hostUserId: string;
  settings: unknown;
  seats: Array<{ seatIndex: number; userId?: string; botId?: string; ready: boolean; connected: boolean }>;
  code?: string;
  lastActivityAt?: string;
  emptySince?: string;
  pausedAt?: string;
  pauseReason?: string;
  tradeResponseDeadlines?: Record<string, number>;
  timer?: { activePlayerId: string; expiresAt: number };
  archivedAt?: string;
  cleanupReason?: string;
}

export interface PersistMatchInput {
  id: string;
  roomId: string;
  mode: string;
  ranked: boolean;
  seedHash: string;
  config: unknown;
  board: unknown;
  players: Array<{ userId: string; seatIndex: number }>;
}

export interface PersistSessionInput {
  tokenHash: string;
  userId: string;
  displayName: string;
  expiresAt?: string;
}

export const upsertSession = async (pool: pg.Pool, session: PersistSessionInput): Promise<void> => {
  await pool.query(
    `INSERT INTO sessions(token, user_id, display_name, expires_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (token) DO UPDATE
     SET user_id = EXCLUDED.user_id,
         display_name = EXCLUDED.display_name,
         expires_at = EXCLUDED.expires_at,
         last_seen_at = now(),
         revoked_at = NULL`,
    [session.tokenHash, session.userId, session.displayName, session.expiresAt ?? null],
  );
  await pool.query(
    `INSERT INTO users(id, display_name)
     VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE
     SET display_name = EXCLUDED.display_name`,
    [session.userId, session.displayName],
  );
};

export interface PersistedSessionRecord {
  tokenHash: string;
  userId: string;
  displayName: string;
  expiresAt?: string;
}

export const listPersistedSessions = async (pool: pg.Pool, limit = 200): Promise<PersistedSessionRecord[]> => {
  const result = await pool.query(
    `SELECT token, user_id, display_name, expires_at
     FROM sessions
     WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
     ORDER BY last_seen_at DESC
     LIMIT $1`,
    [limit],
  );
  return result.rows.map((row) => ({
    tokenHash: row.token,
    userId: row.user_id,
    displayName: row.display_name,
    expiresAt: row.expires_at ? (row.expires_at instanceof Date ? row.expires_at.toISOString() : String(row.expires_at)) : undefined,
  }));
};

export const findPersistedSessionByTokenHash = async (pool: pg.Pool, tokenHash: string): Promise<PersistedSessionRecord | undefined> => {
  const result = await pool.query(
    `UPDATE sessions
     SET last_seen_at = now()
     WHERE token = $1
       AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > now())
     RETURNING token, user_id, display_name, expires_at`,
    [tokenHash],
  );
  const row = result.rows[0];
  return row ? {
    tokenHash: row.token,
    userId: row.user_id,
    displayName: row.display_name,
    expiresAt: row.expires_at ? (row.expires_at instanceof Date ? row.expires_at.toISOString() : String(row.expires_at)) : undefined,
  } : undefined;
};

const upsertRoomWithClient = async (client: pg.PoolClient, room: PersistRoomInput): Promise<void> => {
  await client.query(
      `INSERT INTO rooms(
         id, mode, status, host_user_id, settings_json, room_code,
         last_activity_at, empty_since, paused_at, pause_reason, trade_deadlines_json, timer_json, archived_at, cleanup_reason
       )
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, now()), $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (id) DO UPDATE
       SET mode = EXCLUDED.mode,
           status = EXCLUDED.status,
           host_user_id = EXCLUDED.host_user_id,
           settings_json = EXCLUDED.settings_json,
           room_code = EXCLUDED.room_code,
           last_activity_at = EXCLUDED.last_activity_at,
           empty_since = EXCLUDED.empty_since,
           paused_at = EXCLUDED.paused_at,
           pause_reason = EXCLUDED.pause_reason,
           trade_deadlines_json = EXCLUDED.trade_deadlines_json,
           timer_json = EXCLUDED.timer_json,
           archived_at = EXCLUDED.archived_at,
           cleanup_reason = EXCLUDED.cleanup_reason,
           updated_at = now()`,
      [
        room.id,
        room.mode,
        room.status,
        room.hostUserId,
        room.settings,
        room.code ?? null,
        room.lastActivityAt ?? null,
        room.emptySince ?? null,
        room.pausedAt ?? null,
        room.pauseReason ?? null,
        room.tradeResponseDeadlines ? JSON.stringify(room.tradeResponseDeadlines) : null,
        room.timer ? JSON.stringify(room.timer) : null,
        room.archivedAt ?? null,
        room.cleanupReason ?? null,
      ],
    );
  for (const seat of room.seats) {
    await client.query(
        `INSERT INTO room_seats(room_id, seat_index, user_id, bot_id, ready, connected)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (room_id, seat_index) DO UPDATE
         SET user_id = EXCLUDED.user_id,
             bot_id = EXCLUDED.bot_id,
             ready = EXCLUDED.ready,
             connected = EXCLUDED.connected`,
        [room.id, seat.seatIndex, seat.userId ?? null, seat.botId ?? null, seat.ready, seat.connected],
      );
  }
  await client.query(
    "DELETE FROM room_seats WHERE room_id = $1 AND seat_index >= $2",
    [room.id, room.seats.length],
  );
};

export const upsertRoom = async (pool: pg.Pool, room: PersistRoomInput): Promise<void> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await upsertRoomWithClient(client, room);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const insertMatch = async (pool: pg.Pool, match: PersistMatchInput): Promise<void> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO matches(id, room_id, mode, ranked, seed_hash, config_json, board_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING`,
      [match.id, match.roomId, match.mode, match.ranked, match.seedHash, match.config, match.board],
    );
    for (const player of match.players) {
      await client.query(
        `INSERT INTO match_players(match_id, user_id, seat_index)
         VALUES ($1, $2, $3)
         ON CONFLICT (match_id, user_id) DO NOTHING`,
        [match.id, player.userId, player.seatIndex],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const markMatchFinished = async (pool: pg.Pool, matchId: string, winnerUserId: string): Promise<void> => {
  await pool.query("UPDATE matches SET ended_at = now(), winner_user_id = $2 WHERE id = $1", [matchId, winnerUserId]);
};

export const insertChatMessage = async (
  pool: pg.Pool,
  message: { id: string; matchId?: string; userId: string; message: string },
): Promise<void> => {
  await pool.query(
    `INSERT INTO chat_messages(id, match_id, user_id, message)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [message.id, message.matchId ?? null, message.userId, message.message],
  );
};

export const insertReport = async (
  pool: pg.Pool,
  report: { id: string; reporterUserId: string; reportedUserId: string; matchId?: string; reason: string; status: string },
): Promise<void> => {
  await pool.query(
    `INSERT INTO reports(id, reporter_user_id, reported_user_id, match_id, reason, status)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO NOTHING`,
    [report.id, report.reporterUserId, report.reportedUserId, report.matchId ?? null, report.reason, report.status],
  );
};

export const insertAnalyticsEvent = async (
  pool: pg.Pool,
  event: { id: string; userId?: string; matchId?: string; eventName: string; payload: unknown },
): Promise<void> => {
  await pool.query(
    `INSERT INTO analytics_events(id, user_id, match_id, event_name, payload_json)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO NOTHING`,
    [event.id, event.userId ?? null, event.matchId ?? null, event.eventName, event.payload],
  );
};

export interface PersistCommandResultInput {
  roomId: string;
  matchId?: string;
  userId: string;
  clientSeq: number;
  commandHash: string;
  ok: boolean;
  seqStart?: number;
  seqEnd?: number;
  events?: unknown[];
  rejectionCode?: string;
  rejectionMessage?: string;
}

const commandResultValues = (result: PersistCommandResultInput): unknown[] => [
  result.roomId,
  result.matchId ?? null,
  result.userId,
  result.clientSeq,
  result.commandHash,
  result.ok,
  result.seqStart ?? null,
  result.seqEnd ?? null,
  result.events ? JSON.stringify(result.events) : null,
  result.rejectionCode ?? null,
  result.rejectionMessage ?? null,
];

const commandResultConflict = (result: PersistCommandResultInput): Error =>
  Object.assign(new Error(`Command result already exists for ${result.roomId}:${result.userId}:${result.clientSeq}`), {
    code: "COMMAND_RESULT_CONFLICT",
  });

export const upsertCommandResult = async (pool: pg.Pool, result: PersistCommandResultInput): Promise<void> => {
  const inserted = await pool.query(
    `INSERT INTO command_results(
       room_id, match_id, user_id, client_seq, command_hash, ok,
       seq_start, seq_end, events_json, rejection_code, rejection_message
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (room_id, user_id, client_seq) DO NOTHING
     RETURNING command_hash`,
    commandResultValues(result),
  );
  if ((inserted.rowCount ?? 0) === 0) throw commandResultConflict(result);
};

const upsertCommandResultWithClient = async (client: pg.PoolClient, result: PersistCommandResultInput): Promise<void> => {
  const inserted = await client.query(
    `INSERT INTO command_results(
       room_id, match_id, user_id, client_seq, command_hash, ok,
       seq_start, seq_end, events_json, rejection_code, rejection_message
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (room_id, user_id, client_seq) DO NOTHING
     RETURNING command_hash`,
    commandResultValues(result),
  );
  if ((inserted.rowCount ?? 0) === 0) throw commandResultConflict(result);
};

export interface CommitMatchEventsInput {
  room: PersistRoomInput;
  matchId: string;
  events: Array<{ seq: number; type: string; payload: unknown }>;
  commandResult?: PersistCommandResultInput;
  snapshot?: PersistMatchSnapshotInput;
  winnerUserId?: string;
}

export const commitMatchEvents = async (pool: pg.Pool, input: CommitMatchEventsInput): Promise<void> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const event of input.events) {
      await client.query(
        "INSERT INTO match_events(match_id, seq, event_type, payload_json) VALUES ($1, $2, $3, $4)",
        [input.matchId, event.seq, event.type, event.payload],
      );
    }
    if (input.commandResult) await upsertCommandResultWithClient(client, input.commandResult);
    if (input.snapshot) await saveMatchSnapshotWithClient(client, input.snapshot);
    if (input.winnerUserId) {
      await client.query("UPDATE matches SET ended_at = now(), winner_user_id = $2 WHERE id = $1", [input.matchId, input.winnerUserId]);
    }
    await upsertRoomWithClient(client, input.room);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export interface PersistedCommandResultRecord {
  roomId: string;
  matchId?: string;
  userId: string;
  clientSeq: number;
  commandHash: string;
  ok: boolean;
  seqStart?: number;
  seqEnd?: number;
  events?: unknown[];
  rejectionCode?: string;
  rejectionMessage?: string;
}

export const findCommandResult = async (
  pool: pg.Pool,
  roomId: string,
  userId: string,
  clientSeq: number,
): Promise<PersistedCommandResultRecord | undefined> => {
  const result = await pool.query(
    `SELECT room_id, match_id, user_id, client_seq, command_hash, ok, seq_start, seq_end, events_json, rejection_code, rejection_message
     FROM command_results
     WHERE room_id = $1 AND user_id = $2 AND client_seq = $3`,
    [roomId, userId, clientSeq],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  const record: PersistedCommandResultRecord = {
    roomId: row.room_id,
    userId: row.user_id,
    clientSeq: Number(row.client_seq),
    commandHash: row.command_hash,
    ok: row.ok,
  };
  if (row.match_id) record.matchId = row.match_id;
  if (row.seq_start != null) record.seqStart = Number(row.seq_start);
  if (row.seq_end != null) record.seqEnd = Number(row.seq_end);
  if (row.events_json) record.events = row.events_json;
  if (row.rejection_code) record.rejectionCode = row.rejection_code;
  if (row.rejection_message) record.rejectionMessage = row.rejection_message;
  return record;
};

export interface PersistMatchSnapshotInput {
  matchId: string;
  seq: number;
  state: unknown;
}

export interface PersistedMatchSnapshotRecord {
  matchId: string;
  seq: number;
  state: unknown;
}

const saveMatchSnapshotWithClient = async (client: pg.PoolClient, snapshot: PersistMatchSnapshotInput): Promise<void> => {
  await client.query(
    `INSERT INTO match_snapshots(match_id, seq, state_json)
     VALUES ($1, $2, $3)
     ON CONFLICT (match_id, seq) DO UPDATE
     SET state_json = EXCLUDED.state_json,
         created_at = now()`,
    [snapshot.matchId, snapshot.seq, snapshot.state],
  );
};

export const saveMatchSnapshot = async (pool: pg.Pool, snapshot: PersistMatchSnapshotInput): Promise<void> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await saveMatchSnapshotWithClient(client, snapshot);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const loadLatestMatchSnapshot = async (pool: pg.Pool, matchId: string): Promise<PersistedMatchSnapshotRecord | undefined> => {
  const result = await pool.query(
    `SELECT match_id, seq, state_json
     FROM match_snapshots
     WHERE match_id = $1
     ORDER BY seq DESC
     LIMIT 1`,
    [matchId],
  );
  const row = result.rows[0];
  return row ? { matchId: row.match_id, seq: Number(row.seq), state: row.state_json } : undefined;
};

const validatePersistedEventRows = (rows: pg.QueryResultRow[]): unknown[] =>
  rows.map((row) => {
    const seq = Number(row.seq);
    const type = String(row.event_type);
    const payload = row.payload_json;
    if (!payload || typeof payload !== "object") {
      throw new Error(`Persisted event row ${seq} has a malformed payload`);
    }
    const event = payload as { seq?: unknown; type?: unknown };
    if (event.seq !== seq) {
      throw new Error(`Persisted event row seq ${seq} does not match payload seq ${String(event.seq)}`);
    }
    if (event.type !== type) {
      throw new Error(`Persisted event row type ${type} does not match payload type ${String(event.type)}`);
    }
    return payload;
  });

const loadMatchEventPayloads = async (pool: pg.Pool, matchId: string, afterSeq = 0): Promise<unknown[]> => {
  const events = await pool.query(
    `SELECT seq, event_type, payload_json
     FROM match_events
     WHERE match_id = $1 AND seq > $2
     ORDER BY seq ASC`,
    [matchId, afterSeq],
  );
  return validatePersistedEventRows(events.rows);
};

export const loadReplayLog = async (pool: pg.Pool, matchId: string): Promise<{ config: unknown; board: unknown; events: unknown[] } | undefined> => {
  const match = await pool.query("SELECT config_json, board_json FROM matches WHERE id = $1", [matchId]);
  if ((match.rowCount ?? 0) === 0) return undefined;
  return {
    config: match.rows[0].config_json,
    board: match.rows[0].board_json,
    events: await loadMatchEventPayloads(pool, matchId),
  };
};

export const loadReplayLogByRoomId = async (
  pool: pg.Pool,
  roomId: string,
): Promise<{ matchId: string; config: unknown; board: unknown; events: unknown[] } | undefined> => {
  const match = await pool.query("SELECT id FROM matches WHERE room_id = $1 ORDER BY started_at DESC LIMIT 1", [roomId]);
  if ((match.rowCount ?? 0) === 0) return undefined;
  const matchId = match.rows[0].id as string;
  const replayLog = await loadReplayLog(pool, matchId);
  return replayLog ? { matchId, ...replayLog } : undefined;
};

export interface MatchSummary {
  id: string;
  roomId: string;
  mode: string;
  ranked: boolean;
  startedAt: string;
  endedAt?: string;
  winnerUserId?: string;
  eventCount: number;
  playerIds: string[];
}

export const listMatchSummaries = async (pool: pg.Pool, limit = 20): Promise<MatchSummary[]> => {
  const result = await pool.query(
    `SELECT
       m.id,
       m.room_id,
       m.mode,
       m.ranked,
       m.started_at,
       m.ended_at,
       m.winner_user_id,
       COALESCE((SELECT MAX(seq) FROM match_events e WHERE e.match_id = m.id), 0)::int AS event_count,
       COALESCE((SELECT json_agg(mp.user_id ORDER BY mp.seat_index) FROM match_players mp WHERE mp.match_id = m.id), '[]'::json) AS player_ids
     FROM matches m
     ORDER BY m.started_at DESC
     LIMIT $1`,
    [limit],
  );
  return result.rows.map((row) => ({
    id: row.id,
    roomId: row.room_id,
    mode: row.mode,
    ranked: row.ranked,
    startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : String(row.started_at),
    endedAt: row.ended_at ? (row.ended_at instanceof Date ? row.ended_at.toISOString() : String(row.ended_at)) : undefined,
    winnerUserId: row.winner_user_id ?? undefined,
    eventCount: Number(row.event_count),
    playerIds: row.player_ids ?? [],
  }));
};

export interface PersistedRoomRecord {
  id: string;
  code?: string;
  mode: string;
  status: string;
  hostUserId: string;
  settings: unknown;
  createdAt: string;
  lastActivityAt?: string;
  emptySince?: string;
  pausedAt?: string;
  pauseReason?: string;
  tradeResponseDeadlines?: Record<string, number>;
  timer?: { activePlayerId: string; expiresAt: number };
  archivedAt?: string;
  cleanupReason?: string;
  seats: Array<{ seatIndex: number; userId?: string; botId?: string; ready: boolean; connected: boolean }>;
  match?: {
    id: string;
    config: unknown;
    board: unknown;
    events: unknown[];
    snapshot?: PersistedMatchSnapshotRecord;
    endedAt?: string;
    winnerUserId?: string;
  };
}

const dateString = (value: unknown): string | undefined => {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : String(value);
};

const hydratePersistedRoomRecords = async (pool: pg.Pool, rows: pg.QueryResultRow[]): Promise<PersistedRoomRecord[]> => {
  const records: PersistedRoomRecord[] = [];
  for (const row of rows) {
    const seats = await pool.query(
      `SELECT seat_index, user_id, bot_id, ready, connected
       FROM room_seats
       WHERE room_id = $1
       ORDER BY seat_index ASC`,
      [row.id],
    );
    const match = await pool.query(
      `SELECT id, config_json, board_json, ended_at, winner_user_id
       FROM matches
       WHERE room_id = $1
       ORDER BY started_at DESC
       LIMIT 1`,
      [row.id],
    );
    const matchRow = match.rows[0];
    const events = matchRow ? await loadMatchEventPayloads(pool, matchRow.id) : undefined;
    const snapshot = matchRow ? await loadLatestMatchSnapshot(pool, matchRow.id) : undefined;
    const record: PersistedRoomRecord = {
      id: row.id,
      mode: row.mode,
      status: row.status,
      hostUserId: row.host_user_id,
      settings: row.settings_json,
      createdAt: dateString(row.created_at) ?? new Date().toISOString(),
      seats: seats.rows.map((seat) => ({
        seatIndex: seat.seat_index,
        userId: seat.user_id ?? undefined,
        botId: seat.bot_id ?? undefined,
        ready: seat.ready,
        connected: false,
      })),
    };
    if (row.room_code) record.code = row.room_code;
    const lastActivityAt = dateString(row.last_activity_at);
    if (lastActivityAt) record.lastActivityAt = lastActivityAt;
    const emptySince = dateString(row.empty_since);
    if (emptySince) record.emptySince = emptySince;
    const pausedAt = dateString(row.paused_at);
    if (pausedAt) record.pausedAt = pausedAt;
    const archivedAt = dateString(row.archived_at);
    if (archivedAt) record.archivedAt = archivedAt;
    if (row.cleanup_reason) record.cleanupReason = row.cleanup_reason;
    if (row.pause_reason) record.pauseReason = row.pause_reason;
    if (row.trade_deadlines_json && typeof row.trade_deadlines_json === "object") {
      record.tradeResponseDeadlines = Object.fromEntries(
        Object.entries(row.trade_deadlines_json as Record<string, unknown>)
          .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])),
      );
    }
    if (row.timer_json && typeof row.timer_json === "object") {
      const timer = row.timer_json as Record<string, unknown>;
      if (typeof timer.activePlayerId === "string" && typeof timer.expiresAt === "number" && Number.isFinite(timer.expiresAt)) {
        record.timer = { activePlayerId: timer.activePlayerId, expiresAt: timer.expiresAt };
      }
    }
    if (matchRow) {
      record.match = {
        id: matchRow.id,
        config: matchRow.config_json,
        board: matchRow.board_json,
        events: events ?? [],
      };
      if (snapshot) record.match.snapshot = snapshot;
      const endedAt = dateString(matchRow.ended_at);
      if (endedAt) record.match.endedAt = endedAt;
      if (matchRow.winner_user_id) record.match.winnerUserId = matchRow.winner_user_id;
    }
    records.push(record);
  }
  return records;
};

export const listPersistedRooms = async (pool: pg.Pool, limit = 50): Promise<PersistedRoomRecord[]> => {
  const rooms = await pool.query(
    `SELECT
       id, room_code, mode, status, host_user_id, settings_json, created_at,
       last_activity_at, empty_since, paused_at, pause_reason, trade_deadlines_json, timer_json, archived_at, cleanup_reason
     FROM rooms
     WHERE archived_at IS NULL
       AND status NOT IN ('EXPIRED', 'ABANDONED')
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit],
  );
  return hydratePersistedRoomRecords(pool, rooms.rows);
};

export const findPersistedRoomByRef = async (pool: pg.Pool, roomRef: string): Promise<PersistedRoomRecord | undefined> => {
  const normalizedCode = roomRef.trim().toUpperCase();
  const rooms = await pool.query(
    `SELECT
       id, room_code, mode, status, host_user_id, settings_json, created_at,
       last_activity_at, empty_since, paused_at, pause_reason, trade_deadlines_json, timer_json, archived_at, cleanup_reason
     FROM rooms
     WHERE id = $1 OR room_code = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [roomRef, normalizedCode],
  );
  const [record] = await hydratePersistedRoomRecords(pool, rooms.rows);
  return record;
};

export const persistedRoomCodeExists = async (pool: pg.Pool, code: string): Promise<boolean> => {
  const result = await pool.query("SELECT 1 FROM rooms WHERE room_code = $1 LIMIT 1", [code.trim().toUpperCase()]);
  return (result.rowCount ?? 0) > 0;
};

export interface RoomLeaseRecord {
  roomId: string;
  ownerId: string;
  expiresAt: string;
}

export const acquireRoomLease = async (pool: pg.Pool, roomId: string, ownerId: string, ttlMs: number): Promise<RoomLeaseRecord | undefined> => {
  const result = await pool.query(
    `INSERT INTO room_leases(room_id, owner_id, expires_at)
     VALUES ($1, $2, now() + ($3::text || ' milliseconds')::interval)
     ON CONFLICT (room_id) DO UPDATE
     SET owner_id = EXCLUDED.owner_id,
         expires_at = EXCLUDED.expires_at,
         updated_at = now()
     WHERE room_leases.owner_id = $2 OR room_leases.expires_at < now()
     RETURNING room_id, owner_id, expires_at`,
    [roomId, ownerId, ttlMs],
  );
  const row = result.rows[0];
  return row ? {
    roomId: row.room_id,
    ownerId: row.owner_id,
    expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : String(row.expires_at),
  } : undefined;
};

export const releaseRoomLease = async (pool: pg.Pool, roomId: string, ownerId: string): Promise<boolean> => {
  const result = await pool.query("DELETE FROM room_leases WHERE room_id = $1 AND owner_id = $2", [roomId, ownerId]);
  return (result.rowCount ?? 0) > 0;
};
