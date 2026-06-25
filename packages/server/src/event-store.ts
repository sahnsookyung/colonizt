import type pg from "pg";
import type { BoardGraph, GameConfig, GameEvent, GameState } from "@colonizt/game-core";
import {
  appendMatchEvents,
  commitMatchEvents,
  findPersistedRoomByRef,
  findCommandResult,
  findPersistedSessionByTokenHash,
  insertAnalyticsEvent,
  insertChatMessage,
  insertMatch,
  insertReport,
  listMatchSummaries,
  listPersistedRooms,
  loadLatestMatchSnapshot,
  loadReplayLog,
  loadReplayLogByRoomId,
  markMatchFinished,
  persistedRoomCodeExists,
  saveMatchSnapshot,
  upsertCommandResult,
  upsertSession,
  upsertRoom,
  type MatchSummary,
  type PersistedCommandResultRecord,
  type PersistedMatchSnapshotRecord,
  type PersistedRoomRecord,
} from "@colonizt/db";
import type { ChatMessage, Report, Room, Session } from "./room-manager.js";
import { hashSessionToken } from "./security.js";

const snapshotIntervalEvents = 25;
const shouldSnapshot = (state: GameState, events: readonly GameEvent[] = []): boolean =>
  state.eventSeq > 0 && (state.phase.type === "GAME_OVER" || events.some((event) => event.seq % snapshotIntervalEvents === 0));

export interface StoredReplayLog {
  config: GameConfig;
  board: BoardGraph;
  events: GameEvent[];
  snapshot?: StoredMatchSnapshot;
}

export type StoredMatchSummary = MatchSummary;

export interface StoredRoomRecord {
  id: string;
  code?: string;
  status: Room["status"];
  hostUserId: string;
  settings: Room["settings"];
  createdAt: string;
  lastActivityAt?: string;
  emptySince?: string;
  pausedAt?: string;
  pauseReason?: Room["pauseReason"];
  tradeResponseDeadlines?: Record<string, number>;
  timer?: Room["timer"];
  archivedAt?: string;
  cleanupReason?: string;
  seats: Room["seats"];
  match?: {
    id: string;
    config: GameConfig;
    board: BoardGraph;
    events: GameEvent[];
    snapshot?: StoredMatchSnapshot;
    endedAt?: string;
    winnerUserId?: string;
  };
}

export interface EventStore {
  persistSession(session: Session): Promise<void>;
  loadSessionByToken?(token: string): Promise<Session | undefined>;
  persistRoom(room: Room): Promise<void>;
  persistMatchStart(room: Room, state: GameState): Promise<void>;
  appendEvents(room: Room, events: GameEvent[]): Promise<void>;
  commitEvents?(room: Room, events: GameEvent[], result?: StoredCommandResult): Promise<void>;
  saveSnapshot?(room: Room, state: GameState): Promise<void>;
  loadLatestSnapshot?(matchId: string): Promise<StoredMatchSnapshot | undefined>;
  markFinished(room: Room, winnerId: string): Promise<void>;
  persistChat(room: Room, chat: ChatMessage): Promise<void>;
  persistReport(room: Room, report: Report): Promise<void>;
  persistAnalytics(event: { id: string; userId?: string; matchId?: string; eventName: string; payload: unknown }): Promise<void>;
  loadReplay(matchId: string): Promise<StoredReplayLog | undefined>;
  loadReplayByRoomId(roomId: string): Promise<StoredReplayLog | undefined>;
  listMatches(limit?: number): Promise<StoredMatchSummary[]>;
  loadRooms(limit?: number): Promise<StoredRoomRecord[]>;
  loadRoomByRef?(roomRef: string): Promise<StoredRoomRecord | undefined>;
  roomCodeExists?(code: string): Promise<boolean>;
  loadSessions(limit?: number): Promise<Session[]>;
  persistCommandResult?(result: StoredCommandResult): Promise<void>;
  loadCommandResult?(roomId: string, userId: string, clientSeq: number): Promise<StoredCommandResult | undefined>;
}

export interface StoredCommandResult {
  roomId: string;
  matchId?: string;
  userId: string;
  clientSeq: number;
  commandHash: string;
  ok: boolean;
  events?: GameEvent[];
  seqStart?: number;
  seqEnd?: number;
  rejectionCode?: string;
  rejectionMessage?: string;
}

export interface StoredMatchSnapshot {
  matchId: string;
  seq: number;
  state: GameState;
}

export class MemoryEventStore implements EventStore {
  readonly rooms = new Map<string, Room>();
  readonly replayLogs = new Map<string, StoredReplayLog>();
  readonly sessions = new Map<string, Session>();
  readonly commandResults = new Map<string, StoredCommandResult>();
  readonly snapshots = new Map<string, StoredMatchSnapshot[]>();

  async persistSession(session: Session): Promise<void> {
    this.sessions.set(session.token, session);
  }

  async loadSessionByToken(token: string): Promise<Session | undefined> {
    return this.sessions.get(token);
  }

  async persistRoom(room: Room): Promise<void> {
    this.rooms.set(room.id, room);
  }

  async persistMatchStart(room: Room, state: GameState): Promise<void> {
    this.rooms.set(room.id, room);
    this.replayLogs.set(state.config.matchId, { config: state.config, board: state.board, events: [] });
  }

  async appendEvents(room: Room, events: GameEvent[]): Promise<void> {
    if (!room.game) throw new Error("Cannot append events before game start");
    const log = this.replayLogs.get(room.game.config.matchId) ?? { config: room.game.config, board: room.game.board, events: [] };
    log.events.push(...events);
    this.replayLogs.set(room.game.config.matchId, log);
  }

  async markFinished(_room: Room, _winnerId: string): Promise<void> {
    return;
  }

  async saveSnapshot(room: Room, state: GameState): Promise<void> {
    const snapshot = { matchId: state.config.matchId, seq: state.eventSeq, state: structuredClone(state) as GameState };
    const snapshots = this.snapshots.get(state.config.matchId) ?? [];
    const next = snapshots.filter((candidate) => candidate.seq !== snapshot.seq);
    next.push(snapshot);
    next.sort((left, right) => left.seq - right.seq);
    this.snapshots.set(state.config.matchId, next);
    const log = this.replayLogs.get(state.config.matchId);
    if (log) log.snapshot = snapshot;
    this.rooms.set(room.id, room);
  }

  async loadLatestSnapshot(matchId: string): Promise<StoredMatchSnapshot | undefined> {
    return this.snapshots.get(matchId)?.at(-1);
  }

  async persistChat(_room: Room, _chat: ChatMessage): Promise<void> {
    return;
  }

  async persistReport(_room: Room, _report: Report): Promise<void> {
    return;
  }

  async persistAnalytics(_event: { id: string; userId?: string; matchId?: string; eventName: string; payload: unknown }): Promise<void> {
    return;
  }

  async loadReplay(matchId: string): Promise<StoredReplayLog | undefined> {
    return this.replayLogs.get(matchId);
  }

  async loadReplayByRoomId(roomId: string): Promise<StoredReplayLog | undefined> {
    return this.replayLogs.get(`match_${roomId}`);
  }

  async listMatches(limit = 20): Promise<StoredMatchSummary[]> {
    return [...this.replayLogs.entries()].slice(-limit).reverse().map(([id, log]) => ({
      id,
      roomId: id.startsWith("match_") ? id.slice("match_".length) : id,
      mode: "CLASSIC",
      ranked: false,
      startedAt: new Date().toISOString(),
      eventCount: log.events.length > 0 ? log.events.at(-1)!.seq : 0,
      playerIds: log.config.playerOrder,
    }));
  }

  async loadRooms(limit = 50): Promise<StoredRoomRecord[]> {
    return [...this.rooms.values()]
      .filter((room) => !room.archivedAt && room.status !== "EXPIRED" && room.status !== "ABANDONED")
      .slice(-limit)
      .reverse()
      .map((room) => this.storedRecordFromRoom(room));
  }

  async loadRoomByRef(roomRef: string): Promise<StoredRoomRecord | undefined> {
    const normalizedRef = roomRef.trim().toUpperCase();
    const room = [...this.rooms.values()].find((candidate) => candidate.id === roomRef || candidate.code === normalizedRef);
    return room ? this.storedRecordFromRoom(room) : undefined;
  }

  async roomCodeExists(code: string): Promise<boolean> {
    const normalizedCode = code.trim().toUpperCase();
    return [...this.rooms.values()].some((room) => room.code === normalizedCode);
  }

  private storedRecordFromRoom(room: Room): StoredRoomRecord {
    const record: StoredRoomRecord = {
      id: room.id,
      ...(room.code ? { code: room.code } : {}),
      status: room.status,
      hostUserId: room.hostUserId,
      settings: room.settings,
      createdAt: room.createdAt,
      lastActivityAt: room.lastActivityAt,
      seats: room.seats,
    };
    if (room.emptySince) record.emptySince = room.emptySince;
    if (room.pausedAt) record.pausedAt = room.pausedAt;
    if (room.pauseReason) record.pauseReason = room.pauseReason;
    if (room.tradeResponseDeadlines.size > 0) record.tradeResponseDeadlines = Object.fromEntries(room.tradeResponseDeadlines);
    if (room.timer) record.timer = room.timer;
    if (room.archivedAt) record.archivedAt = room.archivedAt;
    if (room.cleanupReason) record.cleanupReason = room.cleanupReason;
    if (room.game) {
      record.match = {
        id: room.game.config.matchId,
        config: room.game.config,
        board: room.game.board,
        events: room.events,
      };
      const snapshot = this.snapshots.get(room.game.config.matchId)?.at(-1);
      if (snapshot) record.match.snapshot = snapshot;
    }
    return record;
  }

  async loadSessions(limit = 200): Promise<Session[]> {
    return [...this.sessions.values()].slice(-limit).reverse();
  }

  async persistCommandResult(result: StoredCommandResult): Promise<void> {
    const key = `${result.roomId}:${result.userId}:${result.clientSeq}`;
    if (this.commandResults.has(key)) {
      throw Object.assign(new Error(`Command result already exists for ${key}`), { code: "COMMAND_RESULT_CONFLICT" });
    }
    this.commandResults.set(key, result);
  }

  async loadCommandResult(roomId: string, userId: string, clientSeq: number): Promise<StoredCommandResult | undefined> {
    return this.commandResults.get(`${roomId}:${userId}:${clientSeq}`);
  }

  async commitEvents(room: Room, events: GameEvent[], result?: StoredCommandResult): Promise<void> {
    const matchId = room.game?.config.matchId;
    const previousLog = matchId ? this.replayLogs.get(matchId) : undefined;
    const previousLogCopy = previousLog ? { ...previousLog, events: [...previousLog.events] } : undefined;
    const commandKey = result ? `${result.roomId}:${result.userId}:${result.clientSeq}` : undefined;
    const previousCommandResult = commandKey ? this.commandResults.get(commandKey) : undefined;
    const previousRoom = this.rooms.get(room.id);
    try {
      await this.appendEvents(room, events);
      if (result) await this.persistCommandResult(result);
      if (room.game && shouldSnapshot(room.game, events)) await this.saveSnapshot(room, room.game);
      if (room.game?.phase.type === "GAME_OVER") await this.markFinished(room, room.game.phase.winnerId);
      await this.persistRoom(room);
    } catch (error) {
      if (matchId) {
        if (previousLogCopy) this.replayLogs.set(matchId, previousLogCopy);
        else this.replayLogs.delete(matchId);
      }
      if (commandKey) {
        if (previousCommandResult) this.commandResults.set(commandKey, previousCommandResult);
        else this.commandResults.delete(commandKey);
      }
      if (previousRoom) this.rooms.set(room.id, previousRoom);
      else this.rooms.delete(room.id);
      throw error;
    }
  }
}

export class PostgresEventStore implements EventStore {
  constructor(private readonly pool: pg.Pool) {}

  async persistSession(session: Session): Promise<void> {
    const persistedSession = {
      tokenHash: hashSessionToken(session.token),
      userId: session.userId,
      displayName: session.displayName,
    };
    await upsertSession(this.pool, session.expiresAt ? { ...persistedSession, expiresAt: session.expiresAt } : persistedSession);
  }

  async loadSessionByToken(token: string): Promise<Session | undefined> {
    const session = await findPersistedSessionByTokenHash(this.pool, hashSessionToken(token));
    if (!session) return undefined;
    const hydrated: Session = {
      token,
      userId: session.userId,
      displayName: session.displayName,
    };
    if (session.expiresAt) hydrated.expiresAt = session.expiresAt;
    return hydrated;
  }

  async persistRoom(room: Room): Promise<void> {
    await upsertRoom(this.pool, {
      id: room.id,
      mode: room.settings.mode,
      status: room.status,
      hostUserId: room.hostUserId,
      settings: room.settings,
      seats: room.seats,
      code: room.code,
      lastActivityAt: room.lastActivityAt,
      ...(room.emptySince ? { emptySince: room.emptySince } : {}),
      ...(room.pausedAt ? { pausedAt: room.pausedAt } : {}),
      ...(room.pauseReason ? { pauseReason: room.pauseReason } : {}),
      ...(room.tradeResponseDeadlines.size > 0 ? { tradeResponseDeadlines: Object.fromEntries(room.tradeResponseDeadlines) } : {}),
      ...(room.timer ? { timer: room.timer } : {}),
      ...(room.archivedAt ? { archivedAt: room.archivedAt } : {}),
      ...(room.cleanupReason ? { cleanupReason: room.cleanupReason } : {}),
    });
  }

  async persistMatchStart(room: Room, state: GameState): Promise<void> {
    const playerIds = new Set(state.config.playerOrder);
    await insertMatch(this.pool, {
      id: state.config.matchId,
      roomId: room.id,
      mode: room.settings.mode,
      ranked: room.settings.ranked,
      seedHash: state.config.seed,
      config: state.config,
      board: state.board,
      players: room.seats.flatMap((seat) => {
        const id = seat.userId ?? seat.botId;
        return id && playerIds.has(id) ? [{ userId: id, seatIndex: seat.seatIndex }] : [];
      }),
    });
    await this.persistRoom(room);
  }

  async appendEvents(room: Room, events: GameEvent[]): Promise<void> {
    if (!room.game) throw new Error("Cannot append events before game start");
    await appendMatchEvents(this.pool, room.game.config.matchId, events.map((event) => ({ seq: event.seq, type: event.type, payload: event })));
  }

  async commitEvents(room: Room, events: GameEvent[], result?: StoredCommandResult): Promise<void> {
    if (!room.game) throw new Error("Cannot commit events before game start");
    const persistedRoom = {
      id: room.id,
      mode: room.settings.mode,
      status: room.status,
      hostUserId: room.hostUserId,
      settings: room.settings,
      seats: room.seats,
      code: room.code,
      lastActivityAt: room.lastActivityAt,
      ...(room.emptySince ? { emptySince: room.emptySince } : {}),
      ...(room.pausedAt ? { pausedAt: room.pausedAt } : {}),
      ...(room.pauseReason ? { pauseReason: room.pauseReason } : {}),
      ...(room.tradeResponseDeadlines.size > 0 ? { tradeResponseDeadlines: Object.fromEntries(room.tradeResponseDeadlines) } : {}),
      ...(room.timer ? { timer: room.timer } : {}),
      ...(room.archivedAt ? { archivedAt: room.archivedAt } : {}),
      ...(room.cleanupReason ? { cleanupReason: room.cleanupReason } : {}),
    };
    const persistedResult = result ? {
      roomId: result.roomId,
      userId: result.userId,
      clientSeq: result.clientSeq,
      commandHash: result.commandHash,
      ok: result.ok,
      ...(result.matchId ? { matchId: result.matchId } : {}),
      ...(result.seqStart !== undefined ? { seqStart: result.seqStart } : {}),
      ...(result.seqEnd !== undefined ? { seqEnd: result.seqEnd } : {}),
      ...(result.events ? { events: result.events } : {}),
      ...(result.rejectionCode ? { rejectionCode: result.rejectionCode } : {}),
      ...(result.rejectionMessage ? { rejectionMessage: result.rejectionMessage } : {}),
    } : undefined;
    await commitMatchEvents(this.pool, {
      room: persistedRoom,
      matchId: room.game.config.matchId,
      events: events.map((event) => ({ seq: event.seq, type: event.type, payload: event })),
      ...(persistedResult ? { commandResult: persistedResult } : {}),
      ...(shouldSnapshot(room.game, events) ? { snapshot: { matchId: room.game.config.matchId, seq: room.game.eventSeq, state: room.game } } : {}),
      ...(room.game.phase.type === "GAME_OVER" ? { winnerUserId: room.game.phase.winnerId } : {}),
    });
  }

  async saveSnapshot(room: Room, state: GameState): Promise<void> {
    if (!room.game) return;
    await saveMatchSnapshot(this.pool, { matchId: state.config.matchId, seq: state.eventSeq, state });
  }

  async loadLatestSnapshot(matchId: string): Promise<StoredMatchSnapshot | undefined> {
    const snapshot: PersistedMatchSnapshotRecord | undefined = await loadLatestMatchSnapshot(this.pool, matchId);
    return snapshot ? { matchId: snapshot.matchId, seq: snapshot.seq, state: snapshot.state as GameState } : undefined;
  }

  async markFinished(room: Room, winnerId: string): Promise<void> {
    if (!room.game) return;
    await markMatchFinished(this.pool, room.game.config.matchId, winnerId);
    await this.persistRoom(room);
  }

  async persistChat(room: Room, chat: ChatMessage): Promise<void> {
    const message = {
      id: chat.id,
      userId: chat.userId,
      message: chat.message,
    };
    await insertChatMessage(this.pool, room.game ? { ...message, matchId: room.game.config.matchId } : message);
  }

  async persistReport(room: Room, report: Report): Promise<void> {
    const persistedReport = {
      id: report.id,
      reporterUserId: report.reporterUserId,
      reportedUserId: report.reportedUserId,
      reason: report.reason,
      status: report.status,
    };
    await insertReport(this.pool, room.game ? { ...persistedReport, matchId: room.game.config.matchId } : persistedReport);
  }

  async persistAnalytics(event: { id: string; userId?: string; matchId?: string; eventName: string; payload: unknown }): Promise<void> {
    await insertAnalyticsEvent(this.pool, event);
  }

  async loadReplay(matchId: string): Promise<StoredReplayLog | undefined> {
    const log = await loadReplayLog(this.pool, matchId);
    if (!log) return undefined;
    return {
      config: log.config as GameConfig,
      board: log.board as BoardGraph,
      events: log.events as GameEvent[],
    };
  }

  async loadReplayByRoomId(roomId: string): Promise<StoredReplayLog | undefined> {
    const log = await loadReplayLogByRoomId(this.pool, roomId);
    if (!log) return undefined;
    return {
      config: log.config as GameConfig,
      board: log.board as BoardGraph,
      events: log.events as GameEvent[],
    };
  }

  async listMatches(limit?: number): Promise<StoredMatchSummary[]> {
    return listMatchSummaries(this.pool, limit);
  }

  async loadRooms(limit?: number): Promise<StoredRoomRecord[]> {
    const records = await listPersistedRooms(this.pool, limit);
    return records.map((record: PersistedRoomRecord) => {
      const stored: StoredRoomRecord = {
        id: record.id,
        ...(record.code ? { code: record.code } : {}),
        status: record.status as Room["status"],
        hostUserId: record.hostUserId,
        settings: record.settings as Room["settings"],
        createdAt: record.createdAt,
        ...(record.lastActivityAt ? { lastActivityAt: record.lastActivityAt } : {}),
        ...(record.emptySince ? { emptySince: record.emptySince } : {}),
        ...(record.pausedAt ? { pausedAt: record.pausedAt } : {}),
        ...(record.pauseReason ? { pauseReason: record.pauseReason as Room["pauseReason"] } : {}),
        ...(record.tradeResponseDeadlines ? { tradeResponseDeadlines: record.tradeResponseDeadlines } : {}),
        ...(record.timer ? { timer: record.timer } : {}),
        ...(record.archivedAt ? { archivedAt: record.archivedAt } : {}),
        ...(record.cleanupReason ? { cleanupReason: record.cleanupReason } : {}),
        seats: record.seats,
      };
      if (record.match) {
        stored.match = {
          id: record.match.id,
          config: record.match.config as GameConfig,
          board: record.match.board as BoardGraph,
          events: record.match.events as GameEvent[],
        };
        if (record.match.snapshot) stored.match.snapshot = {
          matchId: record.match.snapshot.matchId,
          seq: record.match.snapshot.seq,
          state: record.match.snapshot.state as GameState,
        };
        if (record.match.endedAt) stored.match.endedAt = record.match.endedAt;
        if (record.match.winnerUserId) stored.match.winnerUserId = record.match.winnerUserId;
      }
      return stored;
    });
  }

  async loadRoomByRef(roomRef: string): Promise<StoredRoomRecord | undefined> {
    const record = await findPersistedRoomByRef(this.pool, roomRef);
    if (!record) return undefined;
    const stored: StoredRoomRecord = {
      id: record.id,
      ...(record.code ? { code: record.code } : {}),
      status: record.status as Room["status"],
      hostUserId: record.hostUserId,
      settings: record.settings as Room["settings"],
      createdAt: record.createdAt,
      ...(record.lastActivityAt ? { lastActivityAt: record.lastActivityAt } : {}),
      ...(record.emptySince ? { emptySince: record.emptySince } : {}),
      ...(record.pausedAt ? { pausedAt: record.pausedAt } : {}),
      ...(record.pauseReason ? { pauseReason: record.pauseReason as Room["pauseReason"] } : {}),
      ...(record.tradeResponseDeadlines ? { tradeResponseDeadlines: record.tradeResponseDeadlines } : {}),
      ...(record.timer ? { timer: record.timer } : {}),
      ...(record.archivedAt ? { archivedAt: record.archivedAt } : {}),
      ...(record.cleanupReason ? { cleanupReason: record.cleanupReason } : {}),
      seats: record.seats,
    };
    if (record.match) {
      stored.match = {
        id: record.match.id,
        config: record.match.config as GameConfig,
        board: record.match.board as BoardGraph,
        events: record.match.events as GameEvent[],
      };
      if (record.match.snapshot) stored.match.snapshot = {
        matchId: record.match.snapshot.matchId,
        seq: record.match.snapshot.seq,
        state: record.match.snapshot.state as GameState,
      };
      if (record.match.endedAt) stored.match.endedAt = record.match.endedAt;
      if (record.match.winnerUserId) stored.match.winnerUserId = record.match.winnerUserId;
    }
    return stored;
  }

  async roomCodeExists(code: string): Promise<boolean> {
    return persistedRoomCodeExists(this.pool, code);
  }

  async loadSessions(limit?: number): Promise<Session[]> {
    void limit;
    // Raw tokens are intentionally not stored at rest. Sessions are lazily
    // rehydrated from a presented token via loadSessionByToken.
    return [];
  }

  async persistCommandResult(result: StoredCommandResult): Promise<void> {
    const persisted = {
      roomId: result.roomId,
      userId: result.userId,
      clientSeq: result.clientSeq,
      commandHash: result.commandHash,
      ok: result.ok,
    };
    await upsertCommandResult(this.pool, {
      ...persisted,
      ...(result.matchId ? { matchId: result.matchId } : {}),
      ...(result.seqStart !== undefined ? { seqStart: result.seqStart } : {}),
      ...(result.seqEnd !== undefined ? { seqEnd: result.seqEnd } : {}),
      ...(result.events ? { events: result.events } : {}),
      ...(result.rejectionCode ? { rejectionCode: result.rejectionCode } : {}),
      ...(result.rejectionMessage ? { rejectionMessage: result.rejectionMessage } : {}),
    });
  }

  async loadCommandResult(roomId: string, userId: string, clientSeq: number): Promise<StoredCommandResult | undefined> {
    const result: PersistedCommandResultRecord | undefined = await findCommandResult(this.pool, roomId, userId, clientSeq);
    if (!result) return undefined;
    return {
      roomId: result.roomId,
      userId: result.userId,
      clientSeq: result.clientSeq,
      commandHash: result.commandHash,
      ok: result.ok,
      ...(result.matchId ? { matchId: result.matchId } : {}),
      ...(result.seqStart !== undefined ? { seqStart: result.seqStart } : {}),
      ...(result.seqEnd !== undefined ? { seqEnd: result.seqEnd } : {}),
      ...(result.events ? { events: result.events as GameEvent[] } : {}),
      ...(result.rejectionCode ? { rejectionCode: result.rejectionCode } : {}),
      ...(result.rejectionMessage ? { rejectionMessage: result.rejectionMessage } : {}),
    };
  }
}
