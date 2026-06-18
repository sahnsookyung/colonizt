import type pg from "pg";
import type { BoardGraph, GameConfig, GameEvent, GameState } from "@colonizt/game-core";
import {
  appendMatchEvents,
  findPersistedRoomByRef,
  findCommandResult,
  findPersistedSessionByTokenHash,
  insertAnalyticsEvent,
  insertChatMessage,
  insertMatch,
  insertReport,
  listMatchSummaries,
  listPersistedRooms,
  loadReplayLog,
  loadReplayLogByRoomId,
  markMatchFinished,
  upsertCommandResult,
  upsertSession,
  upsertRoom,
  type MatchSummary,
  type PersistedCommandResultRecord,
  type PersistedRoomRecord,
} from "@colonizt/db";
import type { ChatMessage, Report, Room, Session } from "./room-manager.js";
import { hashSessionToken } from "./security.js";

export interface StoredReplayLog {
  config: GameConfig;
  board: BoardGraph;
  events: GameEvent[];
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
  archivedAt?: string;
  cleanupReason?: string;
  seats: Room["seats"];
  match?: {
    id: string;
    config: GameConfig;
    board: BoardGraph;
    events: GameEvent[];
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
  markFinished(room: Room, winnerId: string): Promise<void>;
  persistChat(room: Room, chat: ChatMessage): Promise<void>;
  persistReport(room: Room, report: Report): Promise<void>;
  persistAnalytics(event: { id: string; userId?: string; matchId?: string; eventName: string; payload: unknown }): Promise<void>;
  loadReplay(matchId: string): Promise<StoredReplayLog | undefined>;
  loadReplayByRoomId(roomId: string): Promise<StoredReplayLog | undefined>;
  listMatches(limit?: number): Promise<StoredMatchSummary[]>;
  loadRooms(limit?: number): Promise<StoredRoomRecord[]>;
  loadRoomByRef?(roomRef: string): Promise<StoredRoomRecord | undefined>;
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

export class MemoryEventStore implements EventStore {
  readonly rooms = new Map<string, Room>();
  readonly replayLogs = new Map<string, StoredReplayLog>();
  readonly sessions = new Map<string, Session>();
  readonly commandResults = new Map<string, StoredCommandResult>();

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
    if (room.archivedAt) record.archivedAt = room.archivedAt;
    if (room.cleanupReason) record.cleanupReason = room.cleanupReason;
    if (room.game) {
      record.match = {
        id: room.game.config.matchId,
        config: room.game.config,
        board: room.game.board,
        events: room.events,
      };
    }
    return record;
  }

  async loadSessions(limit = 200): Promise<Session[]> {
    return [...this.sessions.values()].slice(-limit).reverse();
  }

  async persistCommandResult(result: StoredCommandResult): Promise<void> {
    this.commandResults.set(`${result.roomId}:${result.userId}:${result.clientSeq}`, result);
  }

  async loadCommandResult(roomId: string, userId: string, clientSeq: number): Promise<StoredCommandResult | undefined> {
    return this.commandResults.get(`${roomId}:${userId}:${clientSeq}`);
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
      ...(room.archivedAt ? { archivedAt: room.archivedAt } : {}),
      ...(room.cleanupReason ? { cleanupReason: room.cleanupReason } : {}),
    });
  }

  async persistMatchStart(room: Room, state: GameState): Promise<void> {
    await insertMatch(this.pool, {
      id: state.config.matchId,
      roomId: room.id,
      mode: room.settings.mode,
      ranked: room.settings.ranked,
      seedHash: state.config.seed,
      config: state.config,
      board: state.board,
      players: room.seats.map((seat) => ({
        userId: (seat.userId ?? seat.botId) as string,
        seatIndex: seat.seatIndex,
      })),
    });
    await this.persistRoom(room);
  }

  async appendEvents(room: Room, events: GameEvent[]): Promise<void> {
    if (!room.game) throw new Error("Cannot append events before game start");
    await appendMatchEvents(this.pool, room.game.config.matchId, events.map((event) => ({ seq: event.seq, type: event.type, payload: event })));
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
      if (record.match.endedAt) stored.match.endedAt = record.match.endedAt;
      if (record.match.winnerUserId) stored.match.winnerUserId = record.match.winnerUserId;
    }
    return stored;
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
