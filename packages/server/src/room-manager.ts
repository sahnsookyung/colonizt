import { customAlphabet, nanoid } from "nanoid";
import {
  applyCommand,
  activeCollectingTradeForPlayer,
  canBuildRoad,
  createFixedBoard,
  createGame,
  createSeededBoard,
  deterministicDiscard,
  emptyResources,
  eligibleStealTargets,
  getLegalActions,
  hasResources,
  normalizeImportedState,
  replay,
  resourceCount,
  serializeEventsForViewer,
  serializeForViewer,
  tradeRecipientIds,
  type BotDifficulty,
  type GameCommand,
  type GameConfig,
  type GameEvent,
  type GameState,
  type PlayerId,
  type HexId,
  type ViewerState,
} from "@colonizt/game-core";
import { createBotTradeId, createBotView, evaluateTrade, greedyBot, hasEquivalentBotTradeOffer, plannerBot, randomLegalBot, scoreTradeResponder, tradeShapeKey, type BotController } from "@colonizt/bots";
import { DueWorkIndex } from "./due-work.js";
import { MemoryEventStore, type EventStore, type StoredCommandResult, type StoredMatchSummary, type StoredRoomRecord } from "./event-store.js";
import type { RoomOwnershipStore } from "./ownership.js";
import { hashCommandPayload } from "./security.js";

const tradeResponseWindowMs = 15_000;
const roomCodeAlphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const generateRoomCode = customAlphabet(roomCodeAlphabet, 6);
const defaultSessionTtlMs = 30 * 24 * 60 * 60 * 1000;

export type RoomStatus = "LOBBY" | "IN_GAME" | "FINISHED" | "EXPIRED" | "ABANDONED";
export type RoomPauseReason = "EMPTY_ROOM" | "STALLED_AUTOMATION";

export interface RoomCleanupPolicy {
  maxActiveRooms: number;
  emptyLobbyTtlMs: number;
  emptyGameTtlMs: number;
  finishedRoomUnloadMs: number;
  automationStallTickLimit: number;
  maxAutomatedCommandsPerMinute: number;
  botTradeCooldownTurns: number;
}

export const defaultRoomCleanupPolicy: RoomCleanupPolicy = {
  maxActiveRooms: 200,
  emptyLobbyTtlMs: 10 * 60 * 1000,
  emptyGameTtlMs: 30 * 60 * 1000,
  finishedRoomUnloadMs: 5 * 60 * 1000,
  automationStallTickLimit: 20,
  maxAutomatedCommandsPerMinute: 90,
  botTradeCooldownTurns: 2,
};

export class RoomCapacityError extends Error {
  readonly code = "ROOM_CAPACITY_REACHED";

  constructor() {
    super("Too many active rooms");
  }
}

export interface Session {
  token: string;
  userId: PlayerId;
  displayName: string;
  expiresAt?: string;
}

export interface Seat {
  seatIndex: number;
  userId?: PlayerId;
  botId?: PlayerId;
  ready: boolean;
  connected: boolean;
}

export interface RoomSettings {
  mode: "CLASSIC" | "DUEL" | "RUSH";
  botFill: boolean;
  ranked: boolean;
  minPlayers?: number;
  botDifficulty?: BotDifficulty;
  rules?: GameConfig["rules"];
}

export interface ChatMessage {
  id: string;
  userId: PlayerId;
  message: string;
  createdAt: string;
}

export interface Report {
  id: string;
  reporterUserId: PlayerId;
  reportedUserId: PlayerId;
  roomId: string;
  reason: string;
  status: "OPEN" | "RESOLVED";
}

export interface Room {
  id: string;
  code: string;
  hostUserId: PlayerId;
  status: RoomStatus;
  settings: RoomSettings;
  seats: Seat[];
  spectators: Set<PlayerId>;
  createdAt: string;
  lastActivityAt: string;
  emptySince?: string;
  pausedAt?: string;
  pauseReason?: RoomPauseReason;
  archivedAt?: string;
  cleanupReason?: string;
  game?: GameState;
  board?: GameState["board"];
  events: GameEvent[];
  chat: ChatMessage[];
  reports: Report[];
  processedClientCommands: Map<string, StoredCommandResult>;
  timer?: {
    activePlayerId: PlayerId;
    expiresAt: number;
  };
  tradeResponseDeadlines: Map<string, number>;
}

export type RoomLivenessState = "ACTIVE" | "IDLE_LOBBY" | "PAUSED_EMPTY" | "STALLED" | "FINISHED_UNLOADED" | "CLOSED";

type AutomationProgress = { key: string; repeats: number; seenAt: number };

type RoomManagerOptions = Partial<RoomCleanupPolicy> & {
  sessionTtlMs?: number;
  ownerId?: string;
  ownershipStore?: RoomOwnershipStore;
  ownershipLeaseTtlMs?: number;
};

export type CommandResult = {
  ok: true;
  events: GameEvent[];
  state: GameState;
  replayed?: boolean;
  seqStart?: number;
  seqEnd?: number;
} | {
  ok: false;
  code: string;
  message: string;
};

export class RoomManager {
  readonly sessions = new Map<string, Session>();
  readonly rooms = new Map<string, Room>();
  private readonly roomQueues = new Map<string, Promise<void>>();
  private readonly cleanupPolicy: RoomCleanupPolicy;
  private readonly sessionTtlMs: number;
  private readonly ownerId: string;
  private readonly ownershipStore: RoomOwnershipStore | undefined;
  private readonly ownershipLeaseTtlMs: number;
  private readonly automationDueWork = new DueWorkIndex();
  private readonly cleanupDueWork = new DueWorkIndex();
  private readonly automationProgress = new Map<string, AutomationProgress>();
  private readonly automationCommandTimes = new Map<string, number[]>();
  private readonly botTradeCooldowns = new Map<string, number>();

  constructor(private readonly eventStore: EventStore = new MemoryEventStore(), options: RoomManagerOptions = {}) {
    const { sessionTtlMs, ownerId, ownershipStore, ownershipLeaseTtlMs, ...cleanupPolicy } = options;
    this.cleanupPolicy = { ...defaultRoomCleanupPolicy, ...cleanupPolicy };
    this.sessionTtlMs = sessionTtlMs ?? defaultSessionTtlMs;
    this.ownerId = ownerId ?? "local";
    this.ownershipStore = ownershipStore;
    this.ownershipLeaseTtlMs = ownershipLeaseTtlMs ?? 30_000;
  }

  async createSession(displayName: string): Promise<Session> {
    const userId = `u_${nanoid(8)}`;
    const session: Session = {
      token: `s_${nanoid(24)}`,
      userId,
      displayName,
      ...(this.sessionTtlMs > 0 ? { expiresAt: new Date(Date.now() + this.sessionTtlMs).toISOString() } : {}),
    };
    this.sessions.set(session.token, session);
    await this.eventStore.persistSession(session);
    return session;
  }

  getSession(token: string | undefined): Session | undefined {
    if (!token) return undefined;
    const session = this.sessions.get(token);
    if (!session) return undefined;
    if (!this.sessionIsActive(session)) {
      this.sessions.delete(token);
      return undefined;
    }
    return session;
  }

  async resolveSession(token: string | undefined): Promise<Session | undefined> {
    const cached = this.getSession(token);
    if (cached || !token) return cached;
    const persisted = await this.eventStore.loadSessionByToken?.(token);
    if (!persisted || !this.sessionIsActive(persisted)) return undefined;
    this.sessions.set(token, persisted);
    return persisted;
  }

  async createRoom(host: Session, settings: RoomSettings): Promise<Room> {
    await this.cleanupRooms();
    if (this.activeRoomCount() >= this.cleanupPolicy.maxActiveRooms) {
      throw new RoomCapacityError();
    }
    const createdAt = new Date().toISOString();
    const room: Room = {
      id: `room_${nanoid(8)}`,
      code: this.createUniqueRoomCode(),
      hostUserId: host.userId,
      status: "LOBBY",
      settings,
      seats: Array.from({ length: 4 }, (_, seatIndex) => ({ seatIndex, ready: false, connected: false })),
      spectators: new Set(),
      createdAt,
      lastActivityAt: createdAt,
      events: [],
      chat: [],
      reports: [],
      processedClientCommands: new Map(),
      tradeResponseDeadlines: new Map(),
    };
    room.seats[0] = { seatIndex: 0, userId: host.userId, ready: false, connected: false };
    this.rooms.set(room.id, room);
    await this.eventStore.persistRoom(room);
    await this.claimRoom(room);
    this.updateRoomDueWork(room);
    return room;
  }

  listRooms() {
    return [...this.rooms.values()].filter((room) => this.isActiveRoom(room)).map((room) => this.publicRoomSummary(room));
  }

  publicRoomSummary(room: Room) {
    return {
      id: room.id,
      code: room.code,
      hostUserId: room.hostUserId,
      status: room.status,
      settings: room.settings,
      seats: room.seats,
      spectatorCount: room.spectators.size,
      createdAt: room.createdAt,
      lastActivityAt: room.lastActivityAt,
      pausedAt: room.pausedAt,
      pauseReason: room.pauseReason,
      liveness: this.livenessState(room),
      timer: room.timer,
    };
  }

  viewerState(room: Room, state: GameState, viewerId: PlayerId | "spectator"): ViewerState {
    const snapshot = serializeForViewer(state, viewerId);
    const deadlines = Object.fromEntries(
      [...room.tradeResponseDeadlines.entries()].filter(([tradeId]) => {
        const trade = state.trades[tradeId];
        if (!trade || viewerId === "spectator") return false;
        if (viewerId === trade.fromPlayerId) return true;
        return tradeRecipientIds(state, trade).includes(viewerId);
      }),
    );
    return Object.keys(deadlines).length > 0 ? { ...snapshot, tradeResponseDeadlines: deadlines } : snapshot;
  }

  async hydrateFromStore(limit = 50): Promise<number> {
    const [sessions, records] = await Promise.all([
      this.eventStore.loadSessions(limit * 4),
      this.eventStore.loadRooms(limit),
    ]);
    for (const session of sessions) {
      if (this.sessionIsActive(session)) this.sessions.set(session.token, session);
    }
    let hydrated = 0;
    for (const record of records) {
      const room = this.roomFromStoredRecord(record);
      if (await this.claimRoom(room)) {
        this.rooms.set(room.id, room);
        this.updateRoomDueWork(room);
        hydrated += 1;
      }
    }
    return hydrated;
  }

  async ensureRoomLoadedByRef(roomRef: string): Promise<Room | undefined> {
    const existing = this.roomForRef(roomRef);
    if (existing) return existing;
    const stored = await this.eventStore.loadRoomByRef?.(roomRef);
    if (!stored) return undefined;
    const room = this.roomFromStoredRecord(stored);
    if (room.archivedAt || room.status === "EXPIRED" || room.status === "ABANDONED") return room;
    if (!await this.claimRoom(room)) return room;
    this.rooms.set(room.id, room);
    this.updateRoomDueWork(room);
    return room;
  }

  roomForRef(roomRef: string): Room | undefined {
    const normalizedRef = roomRef.trim().toUpperCase();
    return this.rooms.get(roomRef) ?? [...this.rooms.values()].find((room) => room.code === normalizedRef);
  }

  async loadRoomStatusByRef(roomRef: string): Promise<{ status: RoomStatus; cleanupReason?: string; pauseReason?: RoomPauseReason } | undefined> {
    const room = this.roomForRef(roomRef);
    if (room) return { status: room.status, ...(room.cleanupReason ? { cleanupReason: room.cleanupReason } : {}), ...(room.pauseReason ? { pauseReason: room.pauseReason } : {}) };
    const stored = await this.eventStore.loadRoomByRef?.(roomRef);
    return stored ? { status: stored.status, ...(stored.cleanupReason ? { cleanupReason: stored.cleanupReason } : {}), ...(stored.pauseReason ? { pauseReason: stored.pauseReason } : {}) } : undefined;
  }

  async listMatchHistory(limit = 20): Promise<StoredMatchSummary[]> {
    return this.eventStore.listMatches(limit);
  }

  publicRoom(room: Room, viewerId: PlayerId | "spectator" = "spectator") {
    const game = room.game ? this.viewerState(room, room.game, viewerId) : undefined;
    return {
      id: room.id,
      code: room.code,
      hostUserId: room.hostUserId,
      status: room.status,
      settings: room.settings,
      seats: room.seats,
      spectatorCount: room.spectators.size,
      createdAt: room.createdAt,
      lastActivityAt: room.lastActivityAt,
      pausedAt: room.pausedAt,
      pauseReason: room.pauseReason,
      liveness: this.livenessState(room),
      cleanupReason: room.cleanupReason,
      events: serializeEventsForViewer(room.events, viewerId, room.game?.playerOrder, room.game?.phase.type === "GAME_OVER"),
      chat: room.chat,
      timer: room.timer,
      game,
    };
  }

  async joinRoom(roomId: string, session: Session, asSpectator = false): Promise<{ ok: true; room: Room } | { ok: false; code: string; message: string }> {
    const room = await this.ensureRoomLoadedByRef(roomId);
    if (!room) return { ok: false, code: "ROOM_NOT_FOUND", message: "Room not found" };
    if (room.status === "EXPIRED") return { ok: false, code: "ROOM_EXPIRED", message: "Room expired because everyone left the lobby" };
    if (room.status === "ABANDONED") return { ok: false, code: "ROOM_ABANDONED", message: "Room was abandoned because all seated players disconnected" };
    if (room.archivedAt) return { ok: false, code: "ROOM_CLOSED", message: "Room is closed" };
    if (!await this.claimRoom(room)) return { ok: false, code: "ROOM_NOT_OWNED", message: "Room is owned by another server" };
    const existing = room.seats.find((seat) => seat.userId === session.userId);
    if (existing) {
      existing.connected = true;
      this.touchRoom(room);
      this.resumeRoomIfNeeded(room);
      await this.eventStore.persistRoom(room);
      this.updateRoomDueWork(room);
      return { ok: true, room };
    }
    if (asSpectator || room.status !== "LOBBY") {
      room.spectators.add(session.userId);
      this.touchRoom(room);
      await this.eventStore.persistRoom(room);
      this.updateRoomDueWork(room);
      return { ok: true, room };
    }
    const seat = room.seats.find((candidate) => !candidate.userId && !candidate.botId);
    if (!seat) return { ok: false, code: "ROOM_FULL", message: "Room is full" };
    seat.userId = session.userId;
    seat.connected = true;
    this.touchRoom(room);
    await this.eventStore.persistRoom(room);
    this.updateRoomDueWork(room);
    return { ok: true, room };
  }

  async setReady(roomId: string, session: Session, ready: boolean): Promise<{ ok: true; room: Room } | { ok: false; code: string; message: string }> {
    const targetRoom = await this.ensureRoomLoadedByRef(roomId);
    if (!targetRoom) return { ok: false, code: "ROOM_NOT_FOUND", message: "Room not found" };
    if (targetRoom.status === "EXPIRED") return { ok: false, code: "ROOM_EXPIRED", message: "Room expired because everyone left the lobby" };
    if (targetRoom.status === "ABANDONED") return { ok: false, code: "ROOM_ABANDONED", message: "Room was abandoned because all seated players disconnected" };
    if (targetRoom.archivedAt) return { ok: false, code: "ROOM_CLOSED", message: "Room is closed" };
    return this.enqueueRoom(targetRoom.id, () => this.setReadyNow(targetRoom.id, session, ready));
  }

  private async setReadyNow(roomId: string, session: Session, ready: boolean): Promise<{ ok: true; room: Room } | { ok: false; code: string; message: string }> {
    const room = this.roomForRef(roomId);
    if (!room) return { ok: false, code: "ROOM_NOT_FOUND", message: "Room not found" };
    if (!await this.claimRoom(room)) return { ok: false, code: "ROOM_NOT_OWNED", message: "Room is owned by another server" };
    if (room.status === "EXPIRED" || room.status === "ABANDONED") return { ok: false, code: "ROOM_CLOSED", message: "Room is closed" };
    if (room.status !== "LOBBY") return { ok: false, code: "ROOM_ALREADY_STARTED", message: "Room has already started" };
    const seat = room.seats.find((candidate) => candidate.userId === session.userId);
    if (!seat) return { ok: false, code: "NOT_IN_ROOM", message: "You are not seated in this room" };
    seat.ready = ready;
    this.touchRoom(room);
    if (room.settings.botFill) this.fillBots(room);
    if (this.canStart(room)) await this.startRoom(room);
    else await this.eventStore.persistRoom(room);
    this.updateRoomDueWork(room);
    return { ok: true, room };
  }

  async syncConnections(roomId: string, connectedUserIds: Set<PlayerId>, now = Date.now()): Promise<Room | undefined> {
    const room = this.roomForRef(roomId);
    if (!room) return undefined;
    if (!await this.claimRoom(room)) return undefined;
    let changed = false;
    for (const seat of room.seats) {
      if (!seat.userId) continue;
      const connected = connectedUserIds.has(seat.userId);
      if (seat.connected !== connected) {
        seat.connected = connected;
        changed = true;
      }
    }
    for (const spectatorId of [...room.spectators]) {
      if (!connectedUserIds.has(spectatorId)) {
        room.spectators.delete(spectatorId);
        changed = true;
      }
    }
    if (this.connectedSeatedHumanCount(room) === 0) {
      if (room.status === "IN_GAME" && !room.pausedAt) {
        room.pausedAt = new Date(now).toISOString();
        room.pauseReason = "EMPTY_ROOM";
        room.emptySince ??= room.pausedAt;
        changed = true;
      } else if ((room.status === "LOBBY" || room.status === "FINISHED") && !room.emptySince) {
        room.emptySince = new Date(now).toISOString();
        changed = true;
      }
    } else if (this.resumeRoomIfNeeded(room, now)) {
      changed = true;
    } else if (room.emptySince && room.status !== "IN_GAME") {
      delete room.emptySince;
      changed = true;
    }
    if (changed) {
      this.touchRoom(room, now);
      await this.eventStore.persistRoom(room);
      this.updateRoomDueWork(room, now);
    }
    return room;
  }

  async cleanupRooms(now = Date.now(), roomIds?: string[]): Promise<Array<{ roomId: string; code: string; status: RoomStatus; cleanupReason?: string }>> {
    const cleaned: Array<{ roomId: string; code: string; status: RoomStatus; cleanupReason?: string }> = [];
    const candidates = roomIds
      ? roomIds.map((roomId) => this.rooms.get(roomId)).filter((room): room is Room => Boolean(room))
      : [...this.rooms.values()];
    for (const room of candidates) {
      if (room.archivedAt) continue;
      if (!await this.claimRoom(room)) continue;
      const nowIso = new Date(now).toISOString();
      const connectedSeatedHumans = this.connectedSeatedHumanCount(room);
      const connectedUsers = this.connectedUserCount(room);
      let changed = false;

      if (room.status === "LOBBY") {
        if (connectedSeatedHumans === 0) {
          if (!room.emptySince) {
            room.emptySince = nowIso;
            changed = true;
          }
          if (now - Date.parse(room.emptySince) >= this.cleanupPolicy.emptyLobbyTtlMs) {
            room.status = "EXPIRED";
            room.cleanupReason = "EMPTY_LOBBY_TTL";
            room.archivedAt = nowIso;
            changed = true;
          }
        } else if (room.emptySince) {
          delete room.emptySince;
          changed = true;
        }
      } else if (room.status === "IN_GAME") {
        if (connectedSeatedHumans === 0) {
          if (!room.emptySince) {
            room.emptySince = nowIso;
            changed = true;
          }
          if (!room.pausedAt) {
            room.pausedAt = nowIso;
            room.pauseReason = "EMPTY_ROOM";
            changed = true;
          }
          if (now - Date.parse(room.emptySince) >= this.cleanupPolicy.emptyGameTtlMs) {
            room.status = "ABANDONED";
            room.cleanupReason = "EMPTY_GAME_TTL";
            room.archivedAt = nowIso;
            changed = true;
          }
        } else if (this.resumeRoomIfNeeded(room, now)) {
          changed = true;
        }
      } else if (room.status === "FINISHED") {
        if (connectedUsers === 0) {
          if (!room.emptySince) {
            room.emptySince = nowIso;
            changed = true;
          }
          if (now - Date.parse(room.emptySince) >= this.cleanupPolicy.finishedRoomUnloadMs) {
            room.cleanupReason = "FINISHED_UNLOADED";
            room.archivedAt = nowIso;
            changed = true;
          }
        } else if (room.emptySince) {
          delete room.emptySince;
          changed = true;
        }
      }

      if (!changed) continue;
      this.touchRoom(room, now);
      await this.eventStore.persistRoom(room);
      if (room.archivedAt || room.status === "EXPIRED" || room.status === "ABANDONED") {
        this.rooms.delete(room.id);
        this.removeRoomDueWork(room.id);
        await this.releaseRoom(room.id);
        cleaned.push({
          roomId: room.id,
          code: room.code,
          status: room.status,
          ...(room.cleanupReason ? { cleanupReason: room.cleanupReason } : {}),
        });
      } else this.updateRoomDueWork(room, now);
    }
    return cleaned;
  }

  activeRoomCount(): number {
    return [...this.rooms.values()].filter((room) => this.isActiveRoom(room)).length;
  }

  livenessState(room: Room): RoomLivenessState {
    if (room.archivedAt && room.cleanupReason === "FINISHED_UNLOADED") return "FINISHED_UNLOADED";
    if (room.archivedAt || room.status === "EXPIRED" || room.status === "ABANDONED") return "CLOSED";
    if (room.pauseReason === "STALLED_AUTOMATION") return "STALLED";
    if (room.pausedAt) return "PAUSED_EMPTY";
    if (room.status === "LOBBY" && this.connectedSeatedHumanCount(room) === 0) return "IDLE_LOBBY";
    return "ACTIVE";
  }

  livenessCounts(): Record<RoomLivenessState, number> {
    const counts: Record<RoomLivenessState, number> = {
      ACTIVE: 0,
      IDLE_LOBBY: 0,
      PAUSED_EMPTY: 0,
      STALLED: 0,
      FINISHED_UNLOADED: 0,
      CLOSED: 0,
    };
    for (const room of this.rooms.values()) counts[this.livenessState(room)] += 1;
    return counts;
  }

  pauseReasonCounts(): Record<RoomPauseReason, number> {
    const counts: Record<RoomPauseReason, number> = { EMPTY_ROOM: 0, STALLED_AUTOMATION: 0 };
    for (const room of this.rooms.values()) {
      if (room.pauseReason) counts[room.pauseReason] += 1;
    }
    return counts;
  }

  dueAutomationRoomIds(now = Date.now()): string[] {
    return this.automationDueWork.claimDue(now);
  }

  nextAutomationDueAt(now = Date.now()): number | undefined {
    void now;
    return this.automationDueWork.nextDueAt();
  }

  dueCleanupRoomIds(now = Date.now()): string[] {
    return this.cleanupDueWork.claimDue(now);
  }

  nextCleanupDueAt(now = Date.now()): number | undefined {
    void now;
    return this.cleanupDueWork.nextDueAt();
  }

  fillBots(room: Room): void {
    for (const seat of room.seats) {
      if (!seat.userId && !seat.botId) {
        seat.botId = `bot_${seat.seatIndex + 1}`;
        seat.ready = true;
        seat.connected = true;
      }
    }
  }

  canStart(room: Room): boolean {
    if (room.status !== "LOBBY") return false;
    const occupiedSeats = room.seats.filter((seat) => seat.userId || seat.botId);
    if (room.settings.botFill) return room.seats.every((seat) => (seat.userId || seat.botId) && seat.ready);
    const minPlayers = room.settings.minPlayers ?? (room.settings.mode === "DUEL" ? 2 : 4);
    return occupiedSeats.length >= minPlayers && occupiedSeats.every((seat) => seat.ready);
  }

  async startRoom(room: Room): Promise<void> {
    const activeSeats = room.seats.filter((seat) => seat.userId || seat.botId);
    const playerOrder = activeSeats.map((seat) => (seat.userId ?? seat.botId) as PlayerId);
    const playerNames = Object.fromEntries(room.seats.map((seat) => {
      const id = (seat.userId ?? seat.botId) as PlayerId;
      return [id, seat.userId ? id : `Bot ${seat.seatIndex + 1}`];
    }).filter(([id]) => Boolean(id)));
    const playerColors = Object.fromEntries(playerOrder.map((id, index) => [id, ["#2563eb", "#dc2626", "#16a34a", "#ca8a04"][index] ?? "#64748b"]));
    const config: GameConfig = {
      matchId: `match_${room.id}`,
      seed: room.id,
      victoryPoints: 10,
      maxPlayers: playerOrder.length,
      turnSeconds: 45,
      playerOrder,
      playerNames,
      playerColors,
      botDifficulty: room.settings.botDifficulty ?? "medium",
      rules: {
        diceDoubles: false,
        plight: false,
        plightTurn: 20,
        mapRandomized: true,
        specialCardCostRandomized: false,
        ...room.settings.rules,
      },
    };
    const board = config.rules?.mapRandomized ? createSeededBoard(room.id, 2) : createFixedBoard();
    const game = createGame(config, board);
    const startedRoom: Room = {
      ...room,
      status: "IN_GAME",
      board,
      game,
      tradeResponseDeadlines: new Map(),
    };
    await this.eventStore.persistMatchStart(startedRoom, game);
    room.board = board;
    room.game = game;
    room.status = "IN_GAME";
    room.tradeResponseDeadlines.clear();
    this.refreshTimer(room);
  }

  async submitCommand(roomId: string, session: Session, clientSeq: number, command: GameCommand): Promise<CommandResult> {
    return this.enqueueRoom(roomId, () => this.submitCommandNow(roomId, session, clientSeq, command));
  }

  async expireTurn(roomId: string, now = Date.now()): Promise<CommandResult | undefined> {
    return this.enqueueRoom(roomId, () => this.expireTurnNow(roomId, now));
  }

  async runDueBotAutomation(roomId: string, _now = Date.now()): Promise<CommandResult | undefined> {
    return this.enqueueRoom(roomId, () => this.runDueBotAutomationNow(roomId, _now));
  }

  private async commitAcceptedEvents(
    room: Room,
    previousState: GameState,
    nextState: GameState,
    events: GameEvent[],
    commandResult?: StoredCommandResult,
    now = Date.now(),
  ): Promise<CommandResult> {
    const nextStatus: RoomStatus = nextState.phase.type === "GAME_OVER" ? "FINISHED" : room.status;
    const nextTradeResponseDeadlines = this.tradeResponseDeadlinesAfter(room, events, now);
    const committedRoom: Room = {
      ...room,
      status: nextStatus,
      game: nextState,
      lastActivityAt: new Date(now).toISOString(),
      processedClientCommands: new Map(room.processedClientCommands),
      tradeResponseDeadlines: nextTradeResponseDeadlines,
    };
    try {
      if (this.eventStore.commitEvents) {
        await this.eventStore.commitEvents(committedRoom, events, commandResult);
      } else {
        await this.eventStore.appendEvents(room, events);
        if (commandResult) await this.eventStore.persistCommandResult?.(commandResult);
        if (nextState.phase.type === "GAME_OVER") await this.eventStore.markFinished(committedRoom, nextState.phase.winnerId);
        else await this.eventStore.persistRoom(committedRoom);
      }
    } catch (error) {
      if ((error as { code?: unknown }).code === "COMMAND_RESULT_CONFLICT" && commandResult) {
        const persisted = await this.eventStore.loadCommandResult?.(room.id, commandResult.userId, commandResult.clientSeq);
        if (persisted) {
          room.processedClientCommands.set(`${room.id}:${commandResult.userId}:${commandResult.clientSeq}`, persisted);
          return this.commandResultReplay(room, persisted, commandResult.commandHash);
        }
        return { ok: false, code: "CLIENT_SEQ_CONFLICT", message: "Client sequence was already used for a different command" };
      }
      return { ok: false, code: "EVENT_COMMIT_FAILED", message: error instanceof Error ? error.message : "Event commit failed" };
    }

    this.appendEvents(room, events, now);
    room.game = nextState;
    room.status = nextStatus;
    this.touchRoom(room, now);
    if (commandResult) room.processedClientCommands.set(`${room.id}:${commandResult.userId}:${commandResult.clientSeq}`, commandResult);
    this.refreshTimer(room, previousState);
    this.updateRoomDueWork(room, now);
    return { ok: true, events, state: room.game };
  }

  private async submitCommandNow(roomId: string, session: Session, clientSeq: number, command: GameCommand): Promise<CommandResult> {
    const room = this.roomForRef(roomId);
    if (!room?.game) return { ok: false, code: "ROOM_NOT_IN_GAME", message: "Room is not in game" };
    if (!await this.claimRoom(room)) return { ok: false, code: "ROOM_NOT_OWNED", message: "Room is owned by another server" };
    if (room.pausedAt) return { ok: false, code: "ROOM_PAUSED", message: "Room is paused until a seated player reconnects" };
    if (!this.isMember(room, session.userId)) return { ok: false, code: "NOT_IN_ROOM", message: "You are not in this room" };
    if (command.playerId !== session.userId) return { ok: false, code: "COMMAND_PLAYER_MISMATCH", message: "Command player does not match session" };

    const commandHash = hashCommandPayload(command);
    const idempotencyKey = `${room.id}:${session.userId}:${clientSeq}`;
    const duplicate = room.processedClientCommands.get(idempotencyKey)
      ?? await this.eventStore.loadCommandResult?.(room.id, session.userId, clientSeq);
    if (duplicate) {
      room.processedClientCommands.set(idempotencyKey, duplicate);
      return this.commandResultReplay(room, duplicate, commandHash);
    }

    const previousState = room.game;
    const result = applyCommand(previousState, command);
    if (!result.ok) {
      const rejected: StoredCommandResult = {
        roomId: room.id,
        matchId: room.game.config.matchId,
        userId: session.userId,
        clientSeq,
        commandHash,
        ok: false,
        rejectionCode: result.error.code,
        rejectionMessage: result.error.message,
      };
      room.processedClientCommands.set(idempotencyKey, rejected);
      try {
        await this.eventStore.persistCommandResult?.(rejected);
      } catch (error) {
        if ((error as { code?: unknown }).code === "COMMAND_RESULT_CONFLICT") {
          const persisted = await this.eventStore.loadCommandResult?.(room.id, session.userId, clientSeq);
          if (persisted) {
            room.processedClientCommands.set(idempotencyKey, persisted);
            return this.commandResultReplay(room, persisted, commandHash);
          }
          room.processedClientCommands.delete(idempotencyKey);
          return { ok: false, code: "CLIENT_SEQ_CONFLICT", message: "Client sequence was already used for a different command" };
        }
        room.processedClientCommands.delete(idempotencyKey);
        throw error;
      }
      return { ok: false, code: result.error.code, message: result.error.message };
    }

    const allEvents = result.value.events;
    const storedResult: StoredCommandResult = {
      roomId: room.id,
      matchId: previousState.config.matchId,
      userId: session.userId,
      clientSeq,
      commandHash,
      ok: true,
      events: allEvents,
    };
    if (allEvents[0]) storedResult.seqStart = allEvents[0].seq;
    if (allEvents.at(-1)) storedResult.seqEnd = allEvents.at(-1)!.seq;
    return this.commitAcceptedEvents(room, previousState, result.value.nextState, allEvents, storedResult);
  }

  private commandResultReplay(room: Room, result: StoredCommandResult, commandHash: string): CommandResult {
    if (result.commandHash !== commandHash) {
      return { ok: false, code: "CLIENT_SEQ_CONFLICT", message: "Client sequence was already used for a different command" };
    }
    if (!result.ok) {
      return { ok: false, code: result.rejectionCode ?? "COMMAND_REJECTED", message: result.rejectionMessage ?? "Command was rejected" };
    }
    if (!room.game) return { ok: false, code: "ROOM_NOT_IN_GAME", message: "Room is not in game" };
    const replayed: CommandResult = {
      ok: true,
      events: result.events ?? [],
      state: room.game,
      replayed: true,
    };
    if (result.seqStart !== undefined) replayed.seqStart = result.seqStart;
    if (result.seqEnd !== undefined) replayed.seqEnd = result.seqEnd;
    return replayed;
  }

  appendEvents(room: Room, events: GameEvent[], now = Date.now()): void {
    const expectedNext = room.events.length > 0 ? Math.max(...room.events.map((event) => event.seq)) + 1 : 1;
    if (events[0] && events[0].seq !== expectedNext) {
      throw new Error(`Expected event seq ${expectedNext}, got ${events[0].seq}`);
    }
    room.events.push(...events);
    this.syncTradeResponseDeadlines(room, events, now);
  }

  private tradeResponseDeadlinesAfter(room: Room, events: readonly GameEvent[], now = Date.now()): Map<string, number> {
    const deadlines = new Map(room.tradeResponseDeadlines);
    for (const event of events) {
      switch (event.type) {
        case "TRADE_OFFERED":
          if (event.trade.status === "COLLECTING_RESPONSES") deadlines.set(event.trade.id, now + tradeResponseWindowMs);
          break;
        case "TRADE_CANCELLED":
        case "TRADE_ACCEPTED":
        case "TRADE_EXPIRED":
        case "TRADE_CLOSED":
          deadlines.delete(event.tradeId);
          break;
        default:
          break;
      }
    }
    return deadlines;
  }

  private syncTradeResponseDeadlines(room: Room, events: readonly GameEvent[], now = Date.now()): void {
    room.tradeResponseDeadlines = this.tradeResponseDeadlinesAfter(room, events, now);
  }

  private rebuildTradeResponseDeadlines(room: Room, now = Date.now()): void {
    room.tradeResponseDeadlines.clear();
    if (!room.game) return;
    for (const trade of Object.values(room.game.trades)) {
      if (trade.status === "COLLECTING_RESPONSES") {
        room.tradeResponseDeadlines.set(trade.id, now + tradeResponseWindowMs);
      }
    }
  }

  private async expireTurnNow(roomId: string, now: number): Promise<CommandResult | undefined> {
    const room = this.roomForRef(roomId);
    if (!room?.game || !room.timer || room.timer.expiresAt > now || !("activePlayerId" in room.game.phase)) return undefined;
    if (!await this.claimRoom(room)) return undefined;
    if (room.pausedAt) return undefined;

    const activePlayerId = room.game.phase.activePlayerId;
    const modalTrade = activeCollectingTradeForPlayer(room.game, activePlayerId);
    if (room.game.phase.type === "ACTION_PHASE" && modalTrade) {
      const previousState = room.game;
      const closed = applyCommand(previousState, { type: "EXPIRE_TRADE", playerId: activePlayerId, tradeId: modalTrade.id, reason: "RESPONSE_TIMEOUT" });
      if (!closed.ok) return { ok: false, code: closed.error.code, message: closed.error.message };
      const ended = applyCommand(closed.value.nextState, { type: "END_TURN", playerId: activePlayerId });
      if (!ended.ok) return { ok: false, code: ended.error.code, message: ended.error.message };
      const allEvents = [...closed.value.events, ...ended.value.events];
      return this.commitAcceptedEvents(room, previousState, ended.value.nextState, allEvents, undefined, now);
    }

    const command = this.timeoutCommand(room.game, activePlayerId);
    if (!command) {
      this.refreshTimer(room);
      this.updateRoomDueWork(room, now);
      return undefined;
    }

    const previousState = room.game;
    const result = applyCommand(previousState, command);
    if (!result.ok) return { ok: false, code: result.error.code, message: result.error.message };

    const allEvents = result.value.events;
    return this.commitAcceptedEvents(room, previousState, result.value.nextState, allEvents, undefined, now);
  }

  async addChat(roomId: string, session: Session, message: string): Promise<ChatMessage | undefined> {
    const room = this.roomForRef(roomId);
    if (!room || !this.isMember(room, session.userId)) return undefined;
    if (!await this.claimRoom(room)) return undefined;
    const chat: ChatMessage = { id: `chat_${nanoid(8)}`, userId: session.userId, message, createdAt: new Date().toISOString() };
    room.chat.push(chat);
    this.touchRoom(room);
    await this.eventStore.persistChat(room, chat);
    return chat;
  }

  async createReport(roomId: string, reporter: Session, reportedUserId: string, reason: string): Promise<Report | undefined> {
    const room = this.roomForRef(roomId);
    if (!room || !this.isMember(room, reporter.userId)) return undefined;
    if (!await this.claimRoom(room)) return undefined;
    const report: Report = { id: `report_${nanoid(8)}`, reporterUserId: reporter.userId, reportedUserId, roomId: room.id, reason, status: "OPEN" };
    room.reports.push(report);
    this.touchRoom(room);
    await this.eventStore.persistReport(room, report);
    return report;
  }

  async recordAnalytics(event: { userId?: string; matchId?: string; eventName: string; payload: unknown }): Promise<void> {
    await this.eventStore.persistAnalytics({ id: `analytics_${nanoid(10)}`, ...event });
  }

  getReplay(roomId: string): { config: GameConfig; board: GameState["board"]; events: GameEvent[] } | undefined {
    const room = this.roomForRef(roomId);
    if (!room?.game || !room.board) return undefined;
    return { config: room.game.config, board: room.board, events: room.events };
  }

  async getStoredReplayByMatchId(matchId: string): Promise<{ config: GameConfig; board: GameState["board"]; events: GameEvent[] } | undefined> {
    return this.eventStore.loadReplay(matchId);
  }

  async getReplayById(id: string): Promise<{ config: GameConfig; board: GameState["board"]; events: GameEvent[] } | undefined> {
    return this.getReplay(id)
      ?? await this.eventStore.loadReplay(id)
      ?? await this.eventStore.loadReplayByRoomId(id)
      ?? await this.eventStore.loadReplay(`match_${id}`);
  }

  reconstructReplay(roomId: string): GameState | undefined {
    const log = this.getReplay(roomId);
    return log ? replay(log) : undefined;
  }

  async resync(roomId: string, session: Session, lastSeq: number): Promise<{ snapshot?: ViewerState; events: GameEvent[] } | undefined> {
    const room = await this.ensureRoomLoadedByRef(roomId);
    if (!room?.game) return undefined;
    const viewerId = this.isMember(room, session.userId) ? session.userId : "spectator";
    const events = room.events.filter((event) => event.seq > lastSeq);
    if (events.length === 0 || events[0]!.seq === lastSeq + 1) {
      return { snapshot: this.viewerState(room, room.game, viewerId), events: serializeEventsForViewer(events, viewerId, room.game.playerOrder, room.game.phase.type === "GAME_OVER") };
    }
    return { snapshot: this.viewerState(room, room.game, viewerId), events: [] };
  }

  isMember(room: Room, userId: PlayerId): boolean {
    return room.seats.some((seat) => seat.userId === userId || seat.botId === userId);
  }

  refreshTimer(room: Room, previousState?: GameState): void {
    if (!room.game || !("activePlayerId" in room.game.phase)) {
      delete room.timer;
      return;
    }
    const nextKey = this.timerKey(room.game);
    const previousKey = this.timerKey(previousState);
    if (room.timer && nextKey && nextKey === previousKey && room.timer.activePlayerId === room.game.phase.activePlayerId) {
      return;
    }
    room.timer = {
      activePlayerId: room.game.phase.activePlayerId,
      expiresAt: Date.now() + room.game.config.turnSeconds * 1000,
    };
  }

  refreshRoomDueWork(roomId: string, now = Date.now()): void {
    const room = this.rooms.get(roomId);
    if (room) this.updateRoomDueWork(room, now);
    else this.removeRoomDueWork(roomId);
  }

  private timerKey(state?: GameState): string | undefined {
    if (!state || !("activePlayerId" in state.phase)) return undefined;
    return `${state.config.matchId}:${state.turn}:${state.phase.type}:${state.phase.activePlayerId}`;
  }

  private createUniqueRoomCode(): string {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const code = generateRoomCode();
      if (![...this.rooms.values()].some((room) => room.code === code)) return code;
    }
    return generateRoomCode();
  }

  private touchRoom(room: Room, now = Date.now()): void {
    room.lastActivityAt = new Date(now).toISOString();
  }

  private sessionIsActive(session: Session, now = Date.now()): boolean {
    return !session.expiresAt || Date.parse(session.expiresAt) > now;
  }

  private async claimRoom(room: Room): Promise<boolean> {
    return this.ownershipStore ? this.ownershipStore.acquire(room.id, this.ownerId, this.ownershipLeaseTtlMs) : true;
  }

  private async releaseRoom(roomId: string): Promise<void> {
    await this.ownershipStore?.release(roomId, this.ownerId);
  }

  private isActiveRoom(room: Room): boolean {
    return !room.archivedAt && room.status !== "EXPIRED" && room.status !== "ABANDONED";
  }

  private updateRoomDueWork(room: Room, now = Date.now()): void {
    if (!this.isActiveRoom(room)) {
      this.removeRoomDueWork(room.id);
      return;
    }
    this.automationDueWork.set(room.id, this.automationDueAt(room, now));
    this.cleanupDueWork.set(room.id, this.cleanupDueAt(room, now));
  }

  private removeRoomDueWork(roomId: string): void {
    this.automationDueWork.delete(roomId);
    this.cleanupDueWork.delete(roomId);
  }

  private automationDueAt(room: Room, now = Date.now()): number {
    if (!room.game || room.status !== "IN_GAME" || room.game.phase.type === "GAME_OVER" || room.pausedAt) return Number.POSITIVE_INFINITY;
    const tradeDue = Math.min(Number.POSITIVE_INFINITY, ...room.tradeResponseDeadlines.values());
    if (tradeDue <= now) return tradeDue;
    if (this.botTradeResponseCommand(room)) return now;
    if (room.timer?.expiresAt && room.timer.expiresAt <= now) return room.timer.expiresAt;
    if ("activePlayerId" in room.game.phase && this.botSeatIds(room).includes(room.game.phase.activePlayerId)) {
      const lastAutomation = this.automationCommandTimes.get(room.id)?.at(-1);
      return lastAutomation ? lastAutomation + 450 : now;
    }
    return room.timer?.expiresAt ?? Number.POSITIVE_INFINITY;
  }

  private cleanupDueAt(room: Room, now = Date.now()): number {
    if (!this.isActiveRoom(room)) return Number.POSITIVE_INFINITY;
    const connectedSeatedHumans = this.connectedSeatedHumanCount(room);
    if (room.status === "LOBBY" && connectedSeatedHumans === 0) {
      return room.emptySince ? Date.parse(room.emptySince) + this.cleanupPolicy.emptyLobbyTtlMs : now;
    }
    if (room.status === "IN_GAME" && connectedSeatedHumans === 0) {
      return room.emptySince ? Date.parse(room.emptySince) + this.cleanupPolicy.emptyGameTtlMs : now;
    }
    if (room.status === "FINISHED" && this.connectedUserCount(room) === 0) {
      return room.emptySince ? Date.parse(room.emptySince) + this.cleanupPolicy.finishedRoomUnloadMs : now;
    }
    return Number.POSITIVE_INFINITY;
  }

  private connectedSeatedHumanCount(room: Room): number {
    return room.seats.filter((seat) => seat.userId && seat.connected).length;
  }

  private connectedUserCount(room: Room): number {
    const connectedIds = new Set<PlayerId>();
    for (const seat of room.seats) {
      if (seat.userId && seat.connected) connectedIds.add(seat.userId);
    }
    for (const spectatorId of room.spectators) connectedIds.add(spectatorId);
    return connectedIds.size;
  }

  private resumeRoomIfNeeded(room: Room, now = Date.now()): boolean {
    if (room.pauseReason === "STALLED_AUTOMATION") return false;
    if (!room.pausedAt) {
      if (room.emptySince && this.connectedSeatedHumanCount(room) > 0) {
        delete room.emptySince;
        return true;
      }
      return false;
    }
    if (this.connectedSeatedHumanCount(room) === 0) return false;
    const pausedDuration = Math.max(0, now - Date.parse(room.pausedAt));
    if (room.timer) room.timer.expiresAt += pausedDuration;
    for (const [tradeId, deadline] of room.tradeResponseDeadlines.entries()) {
      room.tradeResponseDeadlines.set(tradeId, deadline + pausedDuration);
    }
    delete room.pausedAt;
    delete room.pauseReason;
    delete room.emptySince;
    return true;
  }

  private botFor(botId: PlayerId): BotController {
    const seatNumber = Number(botId.split("_")[1] ?? "0");
    if (seatNumber % 3 === 0) return plannerBot;
    if (seatNumber % 2 === 0) return greedyBot;
    return randomLegalBot;
  }

  private async applyInternalCommand(room: Room, command: GameCommand): Promise<CommandResult> {
    if (!room.game) return { ok: false, code: "ROOM_NOT_IN_GAME", message: "Room is not in game" };
    const previousState = room.game;
    const result = applyCommand(previousState, command);
    if (!result.ok) return { ok: false, code: result.error.code, message: result.error.message };
    return this.commitAcceptedEvents(room, previousState, result.value.nextState, result.value.events);
  }

  private async enqueueRoom<T>(roomId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.roomQueues.get(roomId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    this.roomQueues.set(roomId, tail);
    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.roomQueues.get(roomId) === tail) this.roomQueues.delete(roomId);
    }
  }

  private timeoutCommand(state: GameState, playerId: PlayerId): GameCommand | undefined {
    if (state.phase.type === "DISCARDING") {
      const count = state.phase.pending[playerId] ?? 0;
      return count > 0 ? { type: "DISCARD_RESOURCES", playerId, resources: deterministicDiscard(state, playerId, count) } : undefined;
    }
    if (state.phase.type === "MOVING_THIEF") {
      const move = getLegalActions(state, playerId).find((action) => action.type === "MOVE_THIEF");
      if (move?.type !== "MOVE_THIEF") return undefined;
      const ranked = move.hexes
        .map((hexId) => {
          const targets = eligibleStealTargets(state, playerId, hexId as HexId);
          const pressure = targets.reduce((sum, targetId) => sum + resourceCount(state.players[targetId]?.resources ?? emptyResources()) + (state.players[targetId]?.score ?? 0) * 2, 0);
          return { hexId: hexId as HexId, targets, score: pressure };
        })
        .sort((left, right) => right.score - left.score || left.hexId.localeCompare(right.hexId));
      const selected = ranked[0];
      if (!selected) return undefined;
      const stealFromPlayerId = selected.targets
        .sort((left, right) =>
          (state.players[right]?.score ?? 0) - (state.players[left]?.score ?? 0)
          || resourceCount(state.players[right]?.resources ?? emptyResources()) - resourceCount(state.players[left]?.resources ?? emptyResources())
          || state.playerOrder.indexOf(left) - state.playerOrder.indexOf(right),
        )[0];
      return { type: "MOVE_THIEF", playerId, hexId: selected.hexId, ...(stealFromPlayerId ? { stealFromPlayerId } : {}) };
    }
    if (state.phase.type === "SETUP_PLACEMENT") {
      const setup = getLegalActions(state, playerId).find((action) => action.type === "PLACE_SETUP");
      const vertexId = setup?.vertices[0];
      if (!vertexId) return undefined;
      const edgeId = state.board.adjacency.vertexToEdges[vertexId]?.find((candidate) => canBuildRoad(state, playerId, candidate, vertexId));
      return edgeId ? { type: "PLACE_SETUP", playerId, vertexId, edgeId } : undefined;
    }
    if (state.phase.type === "WAITING_FOR_ROLL") return { type: "ROLL_DICE", playerId };
    if (state.phase.type === "ACTION_PHASE") return { type: "END_TURN", playerId };
    return undefined;
  }

  private roomFromStoredRecord(record: StoredRoomRecord): Room {
    const game = record.match ? normalizeImportedState(replay(record.match)) : undefined;
    const status = game?.phase.type === "GAME_OVER" ? "FINISHED" : record.status;
    const room: Room = {
      id: record.id,
      code: record.code ?? this.createUniqueRoomCode(),
      hostUserId: record.hostUserId,
      status,
      settings: record.settings,
      seats: record.seats.map((seat) => ({ ...seat, connected: false })),
      spectators: new Set(),
      createdAt: record.createdAt,
      lastActivityAt: record.lastActivityAt ?? record.createdAt,
      events: record.match?.events ?? [],
      chat: [],
      reports: [],
      processedClientCommands: new Map(),
      tradeResponseDeadlines: new Map(Object.entries(record.tradeResponseDeadlines ?? {})),
    };
    if (record.emptySince) room.emptySince = record.emptySince;
    if (record.pausedAt) room.pausedAt = record.pausedAt;
    if (record.pauseReason) room.pauseReason = record.pauseReason;
    if (record.archivedAt) room.archivedAt = record.archivedAt;
    if (record.cleanupReason) room.cleanupReason = record.cleanupReason;
    if (game) room.game = game;
    if (record.match?.board) room.board = record.match.board;
    if (room.game) {
      if (!record.tradeResponseDeadlines) this.rebuildTradeResponseDeadlines(room);
      else {
        for (const [tradeId] of room.tradeResponseDeadlines) {
          if (room.game.trades[tradeId]?.status !== "COLLECTING_RESPONSES") room.tradeResponseDeadlines.delete(tradeId);
        }
      }
      this.refreshTimer(room);
    }
    return room;
  }

  private botSeatIds(room: Room): PlayerId[] {
    return room.seats.map((seat) => seat.botId).filter((botId): botId is PlayerId => Boolean(botId));
  }

  private botTradeResponseCommand(room: Room): GameCommand | undefined {
    if (!room.game) return undefined;
    const botIds = new Set(this.botSeatIds(room));
    for (const trade of Object.values(room.game.trades)) {
      if (trade.status !== "COLLECTING_RESPONSES") continue;
      if (!hasResources(room.game.players[trade.fromPlayerId]?.resources ?? emptyResources(), trade.offered)) continue;
      const candidates = trade.recipients === "ANY"
        ? [...botIds].filter((botId) => botId !== trade.fromPlayerId)
        : trade.recipients.filter((recipient) => botIds.has(recipient));
      for (const botId of candidates) {
        if (trade.responses?.[botId]?.status !== "PENDING") continue;
        const bot = this.botFor(botId);
        const view = createBotView(room.game, botId, bot.profile, room.game.config.botDifficulty ?? "medium");
        if (evaluateTrade(view, trade, bot.profile, room.game.config.botDifficulty ?? "medium") === "ACCEPT") {
          return { type: "RESPOND_TRADE", playerId: botId, tradeId: trade.id, response: "WANTS_ACCEPT" };
        }
        return { type: "RESPOND_TRADE", playerId: botId, tradeId: trade.id, response: "REJECTED" };
      }
    }
    return undefined;
  }

  private botOfferResolutionCommand(room: Room, tradeId: string): GameCommand | undefined {
    if (!room.game) return undefined;
    const trade = room.game.trades[tradeId];
    if (!trade || trade.status !== "COLLECTING_RESPONSES") return undefined;
    const botIds = new Set(this.botSeatIds(room));
    if (!botIds.has(trade.fromPlayerId)) {
      return { type: "EXPIRE_TRADE", playerId: trade.fromPlayerId, tradeId: trade.id, reason: "RESPONSE_TIMEOUT" };
    }
    const candidates = tradeRecipientIds(room.game, trade)
      .filter((playerId) => trade.responses?.[playerId]?.status === "WANTS_ACCEPT")
      .filter((playerId) =>
        hasResources(room.game!.players[trade.fromPlayerId]?.resources ?? emptyResources(), trade.offered)
        && hasResources(room.game!.players[playerId]?.resources ?? emptyResources(), trade.requested),
      )
      .map((playerId) => ({ playerId, score: scoreTradeResponder(room.game!, trade, playerId, this.botFor(trade.fromPlayerId).profile, room.game!.config.botDifficulty ?? "medium") }))
      .sort((left, right) => right.score - left.score || room.game!.playerOrder.indexOf(left.playerId) - room.game!.playerOrder.indexOf(right.playerId));
    const selected = candidates[0]?.playerId;
    return selected
      ? { type: "FINALIZE_TRADE", playerId: trade.fromPlayerId, tradeId: trade.id, toPlayerId: selected }
      : { type: "CANCEL_TRADE", playerId: trade.fromPlayerId, tradeId: trade.id };
  }

  private dueTradeResponseCommand(room: Room, now: number): GameCommand | undefined {
    for (const [tradeId, deadline] of [...room.tradeResponseDeadlines.entries()].sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]))) {
      if (deadline > now) continue;
      const command = this.botOfferResolutionCommand(room, tradeId);
      if (command) return command;
      room.tradeResponseDeadlines.delete(tradeId);
    }
    return undefined;
  }

  private automationProgressKey(room: Room): string {
    const state = room.game;
    const active = state && "activePlayerId" in state.phase ? state.phase.activePlayerId : "none";
    const stagedTrade = state
      ? Object.values(state.trades).find((trade) => trade.status === "COLLECTING_RESPONSES")?.id ?? "none"
      : "none";
    return [
      room.status,
      room.pauseReason ?? "none",
      state?.eventSeq ?? 0,
      state?.turn ?? 0,
      state?.phase.type ?? "NO_GAME",
      active,
      stagedTrade,
    ].join(":");
  }

  private async guardAutomationProgress(room: Room, now: number): Promise<boolean> {
    const key = this.automationProgressKey(room);
    const previous = this.automationProgress.get(room.id);
    const next: AutomationProgress = previous?.key === key
      ? { key, repeats: previous.repeats + 1, seenAt: now }
      : { key, repeats: 1, seenAt: now };
    this.automationProgress.set(room.id, next);
    if (next.repeats <= this.cleanupPolicy.automationStallTickLimit) return true;
    room.pausedAt = new Date(now).toISOString();
    room.pauseReason = "STALLED_AUTOMATION";
    this.touchRoom(room, now);
    await this.eventStore.persistRoom(room);
    this.updateRoomDueWork(room, now);
    return false;
  }

  private automationCommandAllowed(room: Room, now: number): boolean {
    const timestamps = this.automationCommandTimes.get(room.id) ?? [];
    while (timestamps[0] && timestamps[0] < now - 60_000) timestamps.shift();
    if (timestamps.length >= this.cleanupPolicy.maxAutomatedCommandsPerMinute) return false;
    timestamps.push(now);
    this.automationCommandTimes.set(room.id, timestamps);
    return true;
  }

  private async runDueBotAutomationNow(roomId: string, now: number): Promise<CommandResult | undefined> {
    const room = this.rooms.get(roomId);
    if (!room?.game || room.status !== "IN_GAME" || room.game.phase.type === "GAME_OVER") return undefined;
    if (!await this.claimRoom(room)) return undefined;
    if (room.pausedAt) return undefined;
    if (!await this.guardAutomationProgress(room, now)) return undefined;

    const dueTrade = this.dueTradeResponseCommand(room, now);
    if (dueTrade) return this.automationCommandAllowed(room, now) ? this.applyInternalCommand(room, dueTrade) : this.pauseForAutomationBudget(room, now);

    const tradeResponse = this.botTradeResponseCommand(room);
    if (tradeResponse) return this.automationCommandAllowed(room, now) ? this.applyInternalCommand(room, tradeResponse) : this.pauseForAutomationBudget(room, now);

    if (!("activePlayerId" in room.game.phase) || !this.botSeatIds(room).includes(room.game.phase.activePlayerId)) return undefined;
    const active = room.game.phase.activePlayerId;
    if (activeCollectingTradeForPlayer(room.game, active)) return undefined;
    const bot = this.botFor(active);
    const view = createBotView(room.game, active, bot.profile, room.game.config.botDifficulty ?? "medium");
    let command = bot.chooseCommand(view, (prefix: string) => createBotTradeId(room.game!, active, bot.profile) || prefix);
    if (!command) return undefined;
    if (command.type === "OFFER_TRADE" && hasEquivalentBotTradeOffer(view, command)) {
      command = { type: "END_TURN", playerId: active };
    }
    if (command.type === "OFFER_TRADE") {
      const cooldownKey = `${active}:${tradeShapeKey(command)}`;
      const cooldownUntil = this.botTradeCooldowns.get(cooldownKey) ?? -1;
      if (cooldownUntil >= room.game.turn) {
        command = { type: "END_TURN", playerId: active };
      } else {
        this.botTradeCooldowns.set(cooldownKey, room.game.turn + this.cleanupPolicy.botTradeCooldownTurns);
      }
    }
    if (command.type === "PLACE_SETUP") {
      const setupCommand = command;
      const edgeId = room.game.board.adjacency.vertexToEdges[setupCommand.vertexId]?.find((candidate) => canBuildRoad(room.game!, setupCommand.playerId, candidate, setupCommand.vertexId));
      if (edgeId) command = { ...setupCommand, edgeId };
    }
    return this.automationCommandAllowed(room, now) ? this.applyInternalCommand(room, command) : this.pauseForAutomationBudget(room, now);
  }

  private async pauseForAutomationBudget(room: Room, now: number): Promise<CommandResult | undefined> {
    room.pausedAt = new Date(now).toISOString();
    room.pauseReason = "STALLED_AUTOMATION";
    this.touchRoom(room, now);
    await this.eventStore.persistRoom(room);
    this.updateRoomDueWork(room, now);
    return undefined;
  }
}
