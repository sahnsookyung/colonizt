import { customAlphabet, nanoid } from "nanoid";
import {
  applyCommand,
  activeCollectingTradeForPlayer,
  canBuildRoad,
  createGame,
  createBoardForRules,
  emptyResources,
  eligibleStealTargets,
  getLegalActions,
  randomizedDiscard,
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
import { tradeShapeKey } from "@colonizt/bots";
import {
  botSeatIds,
  botTradeResponseCommand,
  chooseBotTurnCommand,
  dueTradeResponseCommand,
  readyBotOfferResolutionCommand,
} from "./bot-automation.js";
import {
  acceptedStoredCommandResult,
  commandIdempotencyKey,
  commandPayloadHash,
  rejectedStoredCommandResult,
  replayStoredCommandResult,
  type CommandResult,
} from "./command-idempotency.js";
import { DueWorkIndex } from "./due-work.js";
import { maxRoomChatMessages, MemoryEventStore, type EventStore, type StoredCommandResult, type StoredMatchSummary, type StoredRoomRecord } from "./event-store.js";
import { applyLobbySettings, canStartLobby, publicSeatsForRoom, startableSeatsForRoom, type LobbySettingsUpdate } from "./lobby.js";
import type { RoomOwnershipStore } from "./ownership.js";
import { hydrateGameFromStoredMatchWithOutcome } from "./replay-hydration.js";
import { persistAcceptedEvents } from "./command-commit.js";
import { createAnalyticsRecord, createChatMessage, createModerationReport } from "./room-content.js";
import { noOpRoomDiagnostics, type RoomDiagnostics } from "./room-diagnostics.js";
import { applyRoomCleanupPolicy, cleanupDueAt, resumeRoomIfNeeded } from "./room-lifecycle.js";
import { actionTurnDurationMs, connectedSeatedHumanCount, connectedUserCount, isActiveRoom, livenessStateForRoom, roomTimerKey, roomTurnDurationMs } from "./room-runtime.js";

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
  displayName?: string;
  ready: boolean;
  connected: boolean;
}

export interface RoomSettings {
  mode: "CLASSIC" | "DUEL" | "RUSH";
  botFill: boolean;
  ranked: boolean;
  minPlayers?: number;
  maxPlayers?: number;
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

export interface RoomHealthEntry {
  roomId: string;
  code: string;
  status: RoomStatus;
  liveness: RoomLivenessState;
  hostUserId: PlayerId;
  createdAt: string;
  lastActivityAt?: string;
  pausedAt?: string;
  pauseReason?: RoomPauseReason;
  cleanupReason?: string;
  connectedHumans: number;
  connectedUsers: number;
  botCount: number;
  spectatorCount: number;
  eventSeq?: number;
  turn?: number;
  phase?: string;
  activePlayerId?: PlayerId;
  timer?: Room["timer"];
  tradeDeadlineCount: number;
  cleanupDueAt?: string;
}

type AutomationProgress = { key: string; repeats: number; seenAt: number };

const replaceRoomState = (target: Room, source: Room): void => {
  const mutableTarget = target as unknown as Record<PropertyKey, unknown>;
  for (const key of Reflect.ownKeys(target)) {
    if (!Reflect.has(source, key)) delete mutableTarget[key];
  }
  Object.assign(target, source);
};

type RoomManagerOptions = Partial<RoomCleanupPolicy> & {
  sessionTtlMs?: number;
  ownerId?: string;
  ownershipStore?: RoomOwnershipStore;
  ownershipLeaseTtlMs?: number;
  diagnostics?: RoomDiagnostics;
};

export type { CommandResult } from "./command-idempotency.js";

export class RoomManager {
  readonly sessions = new Map<string, Session>();
  readonly rooms = new Map<string, Room>();
  private readonly roomQueues = new Map<string, Promise<void>>();
  private readonly cleanupPolicy: RoomCleanupPolicy;
  private readonly sessionTtlMs: number;
  private readonly ownerId: string;
  private readonly ownershipStore: RoomOwnershipStore | undefined;
  private readonly ownershipLeaseTtlMs: number;
  private readonly diagnostics: RoomDiagnostics;
  private readonly automationDueWork = new DueWorkIndex();
  private readonly cleanupDueWork = new DueWorkIndex();
  private readonly automationProgress = new Map<string, AutomationProgress>();
  private readonly automationCommandTimes = new Map<string, number[]>();
  private readonly botTradeCooldowns = new Map<string, number>();
  private pendingRoomCreations = 0;

  constructor(private readonly eventStore: EventStore = new MemoryEventStore(), options: RoomManagerOptions = {}) {
    const { sessionTtlMs, ownerId, ownershipStore, ownershipLeaseTtlMs, diagnostics, ...cleanupPolicy } = options;
    this.cleanupPolicy = { ...defaultRoomCleanupPolicy, ...cleanupPolicy };
    this.sessionTtlMs = sessionTtlMs ?? defaultSessionTtlMs;
    this.ownerId = ownerId ?? "local";
    this.ownershipStore = ownershipStore;
    this.ownershipLeaseTtlMs = ownershipLeaseTtlMs ?? 30_000;
    this.diagnostics = diagnostics ?? noOpRoomDiagnostics;
  }

  async createSession(displayName: string): Promise<Session> {
    const userId = `u_${nanoid(8)}`;
    const session: Session = {
      token: `s_${nanoid(24)}`,
      userId,
      displayName,
      ...(this.sessionTtlMs > 0 ? { expiresAt: new Date(Date.now() + this.sessionTtlMs).toISOString() } : {}),
    };
    await this.eventStore.persistSession(session);
    this.sessions.set(session.token, session);
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

  async sweepExpiredSessions(now = Date.now()): Promise<{ cached: number; persisted: number }> {
    let cached = 0;
    for (const [token, session] of this.sessions) {
      if (!this.sessionIsActive(session, now)) {
        this.sessions.delete(token);
        cached += 1;
      }
    }
    const persisted = await this.eventStore.deleteExpiredSessions(new Date(now));
    return { cached, persisted };
  }

  private seatCountForSettings(settings: RoomSettings): number {
    const seatCount = settings.maxPlayers ?? (settings.mode === "DUEL" ? 2 : 4);
    if (!Number.isInteger(seatCount) || seatCount < 2 || seatCount > 4) {
      throw new Error("Room maxPlayers must be between 2 and 4");
    }
    if (settings.minPlayers !== undefined && settings.minPlayers > seatCount) {
      throw new Error("Room minPlayers cannot exceed maxPlayers");
    }
    return seatCount;
  }

  async createRoom(host: Session, settings: RoomSettings): Promise<Room> {
    await this.cleanupRooms();
    if (this.activeRoomCount() + this.pendingRoomCreations >= this.cleanupPolicy.maxActiveRooms) {
      throw new RoomCapacityError();
    }
    this.pendingRoomCreations += 1;
    try {
      const createdAt = new Date().toISOString();
      const seatCount = this.seatCountForSettings(settings);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const room: Room = {
          id: `room_${nanoid(8)}`,
          code: await this.createUniqueRoomCode(),
          hostUserId: host.userId,
          status: "LOBBY",
          settings,
          seats: Array.from({ length: seatCount }, (_, seatIndex) => ({ seatIndex, ready: false, connected: false })),
          spectators: new Set(),
          createdAt,
          lastActivityAt: createdAt,
          events: [],
          chat: [],
          reports: [],
          processedClientCommands: new Map(),
          tradeResponseDeadlines: new Map(),
        };
        room.seats[0] = { seatIndex: 0, userId: host.userId, displayName: host.displayName, ready: false, connected: false };
        try {
          await this.eventStore.persistRoom(room);
          if (!await this.claimRoom(room)) {
            throw new Error(`Could not acquire ownership for newly created room ${room.id}`);
          }
          this.rooms.set(room.id, room);
          this.updateRoomDueWork(room);
          return room;
        } catch (error) {
          this.rooms.delete(room.id);
          if (this.isRoomCodeCollision(error) && attempt < 4) continue;
          throw error;
        }
      }
      throw new Error("Could not allocate a unique room code");
    } finally {
      this.pendingRoomCreations -= 1;
    }
  }

  async createAllBotRoomForTest(settings: RoomSettings, botIds: readonly PlayerId[] = ["bot_1", "bot_2", "bot_3", "bot_4"]): Promise<Room> {
    if (botIds.length !== 4) throw new Error("createAllBotRoomForTest requires exactly four bot ids");
    const host = await this.createSession("All Bot Test Host");
    const allBotSettings = { ...settings, botFill: true, maxPlayers: botIds.length };
    const room = await this.createRoom(host, allBotSettings);
    const candidate = structuredClone(room) as Room;
    candidate.hostUserId = botIds[0]!;
    candidate.seats = candidate.seats.map((seat, index) => ({
      seatIndex: seat.seatIndex,
      botId: botIds[index]!,
      ready: true,
      connected: true,
    }));
    candidate.settings = allBotSettings;
    this.touchRoom(candidate);
    await this.startRoom(candidate);
    replaceRoomState(room, candidate);
    this.updateRoomDueWork(room);
    return room;
  }

  listRooms() {
    return [...this.rooms.values()].filter((room) => isActiveRoom(room)).map((room) => this.publicRoomSummary(room));
  }

  publicRoomSummary(room: Room) {
    return {
      id: room.id,
      code: room.code,
      hostUserId: room.hostUserId,
      status: room.status,
      settings: room.settings,
      seats: this.publicSeats(room),
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

  async hydrateFromStore(limit = this.cleanupPolicy.maxActiveRooms): Promise<number> {
    let sessions: Session[];
    let records: StoredRoomRecord[];
    try {
      [sessions, records] = await Promise.all([
        this.eventStore.loadSessions(limit * 4),
        this.eventStore.loadRooms(limit),
      ]);
    } catch (error) {
      this.diagnostics.recordStoreValidationFailure("room");
      this.diagnostics.recordHydration("failure");
      throw error;
    }
    for (const session of sessions) {
      if (this.sessionIsActive(session)) this.sessions.set(session.token, session);
    }
    let hydrated = 0;
    for (const record of records) {
      let room: Room;
      try {
        room = this.roomFromStoredRecord(record);
      } catch (error) {
        this.diagnostics.recordStoreValidationFailure("room");
        this.diagnostics.recordHydration("failure");
        throw error;
      }
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
    let room: Room;
    try {
      room = this.roomFromStoredRecord(stored);
    } catch (error) {
      this.diagnostics.recordStoreValidationFailure("room");
      this.diagnostics.recordHydration("failure");
      throw error;
    }
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

  publicRoom(room: Room, viewerId: PlayerId | "spectator" = "spectator", includeChat = viewerId !== "spectator") {
    const game = room.game ? this.viewerState(room, room.game, viewerId) : undefined;
    return {
      id: room.id,
      code: room.code,
      hostUserId: room.hostUserId,
      status: room.status,
      settings: room.settings,
      seats: this.publicSeats(room),
      spectatorCount: room.spectators.size,
      createdAt: room.createdAt,
      lastActivityAt: room.lastActivityAt,
      pausedAt: room.pausedAt,
      pauseReason: room.pauseReason,
      liveness: this.livenessState(room),
      cleanupReason: room.cleanupReason,
      events: serializeEventsForViewer(room.events, viewerId, room.game?.playerOrder, room.game?.phase.type === "GAME_OVER"),
      ...(includeChat ? { chat: room.chat.slice(-maxRoomChatMessages) } : {}),
      timer: room.timer,
      game,
    };
  }

  private displayNameForUser(userId: PlayerId): string {
    return [...this.sessions.values()].find((session) => session.userId === userId)?.displayName ?? userId;
  }

  private displayNameForSeat(seat: Seat): string {
    if (seat.botId) return `Bot ${seat.seatIndex + 1}`;
    return seat.displayName ?? (seat.userId ? this.displayNameForUser(seat.userId) : `Seat ${seat.seatIndex + 1}`);
  }

  private botIdForSeat(seatIndex: number): PlayerId {
    return `bot_${seatIndex + 1}`;
  }

  private publicSeats(room: Room) {
    return publicSeatsForRoom(room, (userId) => this.displayNameForUser(userId));
  }

  private repairLobbyHost(room: Room): void {
    if (room.status !== "LOBBY" || room.seats.some((seat) => seat.userId === room.hostUserId)) return;
    const nextHost = room.seats.find((seat) => seat.userId)?.userId;
    if (nextHost) room.hostUserId = nextHost;
  }

  async updateDisplayName(session: Session, displayName: string, roomRef?: string): Promise<Session> {
    const nextName = displayName.trim().slice(0, 40);
    if (!nextName) return session;
    const candidateSession = { ...session, displayName: nextName };
    await this.eventStore.persistSession(candidateSession);
    Object.assign(session, candidateSession);
    this.sessions.set(session.token, session);
    const candidateRooms = roomRef ? [await this.ensureRoomLoadedByRef(roomRef)] : [...this.rooms.values()];
    await Promise.all(candidateRooms.filter((room): room is Room => Boolean(room)).map((targetRoom) =>
      this.enqueueRoom(targetRoom.id, async () => {
        const room = this.roomForRef(targetRoom.id) ?? targetRoom;
        if (!await this.claimRoom(room)) return;
        const candidate = structuredClone(room) as Room;
        const seat = candidate.seats.find((candidateSeat) => candidateSeat.userId === session.userId);
        if (!seat || seat.displayName === nextName) return;
        seat.displayName = nextName;
        this.touchRoom(candidate);
        await this.eventStore.persistRoom(candidate);
        replaceRoomState(room, candidate);
        this.updateRoomDueWork(room);
      }),
    ));
    return session;
  }

  async joinRoom(roomId: string, session: Session, asSpectator = false): Promise<{ ok: true; room: Room } | { ok: false; code: string; message: string }> {
    const targetRoom = await this.ensureRoomLoadedByRef(roomId);
    if (!targetRoom) return { ok: false, code: "ROOM_NOT_FOUND", message: "Room not found" };
    const retainedActiveRoom = [...this.rooms.values()].find((room) =>
      room.id !== targetRoom.id
      && room.status === "IN_GAME"
      && room.seats.some((seat) => seat.userId === session.userId),
    );
    if (retainedActiveRoom) {
      return { ok: false, code: "ROOM_SWITCH_ACTIVE_GAME", message: "You cannot join another room while seated in an active game" };
    }
    return this.enqueueRoom(targetRoom.id, () => this.joinRoomNow(targetRoom, session, asSpectator));
  }

  private async joinRoomNow(targetRoom: Room, session: Session, asSpectator: boolean): Promise<{ ok: true; room: Room } | { ok: false; code: string; message: string }> {
    const room = this.roomForRef(targetRoom.id) ?? targetRoom;
    if (room.status === "EXPIRED") return { ok: false, code: "ROOM_EXPIRED", message: "Room expired because everyone left the lobby" };
    if (room.status === "ABANDONED") return { ok: false, code: "ROOM_ABANDONED", message: "Room was abandoned because all seated players disconnected" };
    if (room.archivedAt) return { ok: false, code: "ROOM_CLOSED", message: "Room is closed" };
    if (!await this.claimRoom(room)) return { ok: false, code: "ROOM_NOT_OWNED", message: "Room is owned by another server" };

    const joined = this.joinCandidate(room, session, asSpectator);
    if (!joined.ok) return joined;
    const candidate = joined.room;
    await this.eventStore.persistRoom(candidate);
    replaceRoomState(room, candidate);
    this.updateRoomDueWork(room);
    return { ok: true, room };
  }

  private joinCandidate(room: Room, session: Session, asSpectator: boolean): { ok: true; room: Room } | { ok: false; code: string; message: string } {
    const candidate = structuredClone(room) as Room;
    const existing = candidate.seats.find((seat) => seat.userId === session.userId);
    if (existing) {
      existing.connected = true;
      existing.displayName = session.displayName;
      this.repairLobbyHost(candidate);
      this.touchRoom(candidate);
      resumeRoomIfNeeded(candidate);
      return { ok: true, room: candidate };
    }
    if (asSpectator || candidate.status !== "LOBBY") {
      candidate.spectators.add(session.userId);
      this.touchRoom(candidate);
      return { ok: true, room: candidate };
    }
    const seat = candidate.seats.find((candidateSeat) => !candidateSeat.userId && !candidateSeat.botId);
    if (!seat) return { ok: false, code: "ROOM_FULL", message: "Room is full" };
    seat.userId = session.userId;
    seat.displayName = session.displayName;
    seat.connected = true;
    this.repairLobbyHost(candidate);
    this.touchRoom(candidate);
    return { ok: true, room: candidate };
  }

  async switchRoom(previousRoomId: string, destinationRoomId: string, session: Session, asSpectator = false, now = Date.now()): Promise<
    { ok: true; room: Room; previousRoom: Room } | { ok: false; code: string; message: string }
  > {
    if (previousRoomId === destinationRoomId) {
      const joined = await this.joinRoom(destinationRoomId, session, asSpectator);
      return joined.ok ? { ...joined, previousRoom: joined.room } : joined;
    }
    const [previousTarget, destinationTarget] = await Promise.all([
      this.ensureRoomLoadedByRef(previousRoomId),
      this.ensureRoomLoadedByRef(destinationRoomId),
    ]);
    if (!previousTarget) return { ok: false, code: "ROOM_NOT_FOUND", message: "Previous room not found" };
    if (!destinationTarget) return { ok: false, code: "ROOM_NOT_FOUND", message: "Room not found" };
    if (previousTarget.id === destinationTarget.id) {
      const joined = await this.joinRoom(destinationTarget.id, session, asSpectator);
      return joined.ok ? { ...joined, previousRoom: joined.room } : joined;
    }

    return this.enqueueRooms([previousTarget.id, destinationTarget.id], async () => {
      const previousRoom = this.roomForRef(previousTarget.id) ?? previousTarget;
      const destinationRoom = this.roomForRef(destinationTarget.id) ?? destinationTarget;
      if (destinationRoom.status === "EXPIRED") return { ok: false, code: "ROOM_EXPIRED", message: "Room expired because everyone left the lobby" };
      if (destinationRoom.status === "ABANDONED") return { ok: false, code: "ROOM_ABANDONED", message: "Room was abandoned because all seated players disconnected" };
      if (destinationRoom.archivedAt) return { ok: false, code: "ROOM_CLOSED", message: "Room is closed" };
      if (previousRoom.archivedAt || previousRoom.status === "EXPIRED" || previousRoom.status === "ABANDONED") {
        return { ok: false, code: "ROOM_SWITCH_FAILED", message: "Previous room is closed" };
      }
      const retainedSeat = previousRoom.seats.find((seat) => seat.userId === session.userId);
      if (retainedSeat && previousRoom.status !== "LOBBY") {
        return { ok: false, code: "ROOM_SWITCH_ACTIVE_GAME", message: "You cannot join another room while seated in an active game" };
      }
      if (!await this.claimRoom(previousRoom) || !await this.claimRoom(destinationRoom)) {
        return { ok: false, code: "ROOM_NOT_OWNED", message: "A room is owned by another server" };
      }

      const joined = this.joinCandidate(destinationRoom, session, asSpectator);
      if (!joined.ok) return joined;
      const previousCandidate = structuredClone(previousRoom) as Room;
      this.applyDeparture(previousCandidate, session, now);
      await this.eventStore.persistRooms([previousCandidate, joined.room]);
      replaceRoomState(previousRoom, previousCandidate);
      replaceRoomState(destinationRoom, joined.room);
      this.updateRoomDueWork(previousRoom, now);
      this.updateRoomDueWork(destinationRoom, now);
      return { ok: true, room: destinationRoom, previousRoom };
    });
  }

  async setReady(roomId: string, session: Session, ready: boolean): Promise<{ ok: true; room: Room } | { ok: false; code: string; message: string }> {
    const targetRoom = await this.ensureRoomLoadedByRef(roomId);
    if (!targetRoom) return { ok: false, code: "ROOM_NOT_FOUND", message: "Room not found" };
    if (targetRoom.status === "EXPIRED") return { ok: false, code: "ROOM_EXPIRED", message: "Room expired because everyone left the lobby" };
    if (targetRoom.status === "ABANDONED") return { ok: false, code: "ROOM_ABANDONED", message: "Room was abandoned because all seated players disconnected" };
    if (targetRoom.archivedAt) return { ok: false, code: "ROOM_CLOSED", message: "Room is closed" };
    return this.enqueueRoom(targetRoom.id, () => this.setReadyNow(targetRoom, session, ready));
  }

  private async setReadyNow(targetRoom: Room, session: Session, ready: boolean): Promise<{ ok: true; room: Room } | { ok: false; code: string; message: string }> {
    const room = this.roomForRef(targetRoom.id) ?? targetRoom;
    if (!await this.claimRoom(room)) return { ok: false, code: "ROOM_NOT_OWNED", message: "Room is owned by another server" };
    if (room.status === "EXPIRED" || room.status === "ABANDONED") return { ok: false, code: "ROOM_CLOSED", message: "Room is closed" };
    if (room.status !== "LOBBY") return { ok: false, code: "ROOM_ALREADY_STARTED", message: "Room has already started" };
    const candidate = structuredClone(room) as Room;
    const seat = candidate.seats.find((candidateSeat) => candidateSeat.userId === session.userId);
    if (!seat) return { ok: false, code: "NOT_IN_ROOM", message: "You are not seated in this room" };
    seat.ready = ready;
    seat.connected = true;
    this.touchRoom(candidate);
    if (candidate.settings.botFill) this.fillBots(candidate);
    if (candidate.settings.botFill && this.canStart(candidate)) await this.startRoom(candidate);
    else await this.eventStore.persistRoom(candidate);
    replaceRoomState(room, candidate);
    this.updateRoomDueWork(room);
    return { ok: true, room };
  }

  async updateRoomSettings(roomId: string, session: Session, settings: LobbySettingsUpdate): Promise<{ ok: true; room: Room } | { ok: false; code: string; message: string }> {
    const targetRoom = await this.ensureRoomLoadedByRef(roomId);
    if (!targetRoom) return { ok: false, code: "ROOM_NOT_FOUND", message: "Room not found" };
    return this.enqueueRoom(targetRoom.id, () => this.updateRoomSettingsNow(targetRoom, session, settings));
  }

  private async updateRoomSettingsNow(targetRoom: Room, session: Session, settings: LobbySettingsUpdate): Promise<{ ok: true; room: Room } | { ok: false; code: string; message: string }> {
    const room = this.roomForRef(targetRoom.id) ?? targetRoom;
    if (!await this.claimRoom(room)) return { ok: false, code: "ROOM_NOT_OWNED", message: "Room is owned by another server" };
    if (room.status !== "LOBBY") return { ok: false, code: "ROOM_ALREADY_STARTED", message: "Room has already started" };
    if (room.hostUserId !== session.userId) return { ok: false, code: "NOT_ROOM_HOST", message: "Only the host can change room settings" };
    const next = applyLobbySettings(room, settings);
    if (!next.ok) return next;
    const candidate = structuredClone(room) as Room;
    candidate.seats = next.seats;
    candidate.settings = next.settings;
    this.touchRoom(candidate);
    await this.eventStore.persistRoom(candidate);
    replaceRoomState(room, candidate);
    this.updateRoomDueWork(room);
    return { ok: true, room };
  }

  async addLobbyBot(roomId: string, session: Session): Promise<{ ok: true; room: Room } | { ok: false; code: string; message: string }> {
    const targetRoom = await this.ensureRoomLoadedByRef(roomId);
    if (!targetRoom) return { ok: false, code: "ROOM_NOT_FOUND", message: "Room not found" };
    return this.enqueueRoom(targetRoom.id, () => this.addLobbyBotNow(targetRoom, session));
  }

  private async addLobbyBotNow(targetRoom: Room, session: Session): Promise<{ ok: true; room: Room } | { ok: false; code: string; message: string }> {
    const room = this.roomForRef(targetRoom.id) ?? targetRoom;
    if (!await this.claimRoom(room)) return { ok: false, code: "ROOM_NOT_OWNED", message: "Room is owned by another server" };
    if (room.status !== "LOBBY") return { ok: false, code: "ROOM_ALREADY_STARTED", message: "Room has already started" };
    if (room.hostUserId !== session.userId) return { ok: false, code: "NOT_ROOM_HOST", message: "Only the host can add bots" };
    const candidate = structuredClone(room) as Room;
    const seat = candidate.seats.find((candidateSeat) => !candidateSeat.userId && !candidateSeat.botId);
    if (!seat) return { ok: false, code: "ROOM_FULL", message: "No open seats for a bot" };
    seat.botId = this.botIdForSeat(seat.seatIndex);
    seat.ready = true;
    seat.connected = true;
    delete seat.displayName;
    candidate.settings.botFill = false;
    this.touchRoom(candidate);
    await this.eventStore.persistRoom(candidate);
    replaceRoomState(room, candidate);
    this.updateRoomDueWork(room);
    return { ok: true, room };
  }

  async removeLobbyBot(roomId: string, session: Session, seatIndex: number): Promise<{ ok: true; room: Room } | { ok: false; code: string; message: string }> {
    const targetRoom = await this.ensureRoomLoadedByRef(roomId);
    if (!targetRoom) return { ok: false, code: "ROOM_NOT_FOUND", message: "Room not found" };
    return this.enqueueRoom(targetRoom.id, () => this.removeLobbyBotNow(targetRoom, session, seatIndex));
  }

  private async removeLobbyBotNow(targetRoom: Room, session: Session, seatIndex: number): Promise<{ ok: true; room: Room } | { ok: false; code: string; message: string }> {
    const room = this.roomForRef(targetRoom.id) ?? targetRoom;
    if (!await this.claimRoom(room)) return { ok: false, code: "ROOM_NOT_OWNED", message: "Room is owned by another server" };
    if (room.status !== "LOBBY") return { ok: false, code: "ROOM_ALREADY_STARTED", message: "Room has already started" };
    if (room.hostUserId !== session.userId) return { ok: false, code: "NOT_ROOM_HOST", message: "Only the host can remove bots" };
    const candidate = structuredClone(room) as Room;
    const seat = candidate.seats[seatIndex];
    if (!seat?.botId) return { ok: false, code: "BOT_NOT_FOUND", message: "No bot is seated there" };
    delete seat.botId;
    delete seat.displayName;
    seat.ready = false;
    seat.connected = false;
    candidate.settings.botFill = false;
    this.touchRoom(candidate);
    await this.eventStore.persistRoom(candidate);
    replaceRoomState(room, candidate);
    this.updateRoomDueWork(room);
    return { ok: true, room };
  }

  async startRoomByHost(roomId: string, session: Session): Promise<{ ok: true; room: Room } | { ok: false; code: string; message: string }> {
    const targetRoom = await this.ensureRoomLoadedByRef(roomId);
    if (!targetRoom) return { ok: false, code: "ROOM_NOT_FOUND", message: "Room not found" };
    return this.enqueueRoom(targetRoom.id, () => this.startRoomByHostNow(targetRoom, session));
  }

  private async startRoomByHostNow(targetRoom: Room, session: Session): Promise<{ ok: true; room: Room } | { ok: false; code: string; message: string }> {
    const room = this.roomForRef(targetRoom.id) ?? targetRoom;
    if (!await this.claimRoom(room)) return { ok: false, code: "ROOM_NOT_OWNED", message: "Room is owned by another server" };
    if (room.status !== "LOBBY") return { ok: false, code: "ROOM_ALREADY_STARTED", message: "Room has already started" };
    if (room.hostUserId !== session.userId) return { ok: false, code: "NOT_ROOM_HOST", message: "Only the host can start the room" };
    const candidate = structuredClone(room) as Room;
    if (candidate.settings.botFill) this.fillBots(candidate);
    if (!this.canStart(candidate)) return { ok: false, code: "ROOM_NOT_READY", message: "At least two connected ready players are required" };
    this.touchRoom(candidate);
    await this.startRoom(candidate);
    replaceRoomState(room, candidate);
    this.updateRoomDueWork(room);
    return { ok: true, room };
  }

  async leaveRoom(roomId: string, session: Session, now = Date.now()): Promise<{ ok: true; room: Room } | { ok: false; code: string; message: string }> {
    const targetRoom = await this.ensureRoomLoadedByRef(roomId);
    if (!targetRoom) return { ok: false, code: "ROOM_NOT_FOUND", message: "Room not found" };
    if (targetRoom.archivedAt || targetRoom.status === "EXPIRED" || targetRoom.status === "ABANDONED") {
      return { ok: false, code: "ROOM_CLOSED", message: "Room is closed" };
    }
    return this.enqueueRoom(targetRoom.id, () => this.leaveRoomNow(targetRoom, session, now));
  }

  private async leaveRoomNow(targetRoom: Room, session: Session, now: number): Promise<{ ok: true; room: Room } | { ok: false; code: string; message: string }> {
    const room = this.roomForRef(targetRoom.id) ?? targetRoom;
    if (!await this.claimRoom(room)) return { ok: false, code: "ROOM_NOT_OWNED", message: "Room is owned by another server" };

    const candidate = structuredClone(room) as Room;
    const changed = this.applyDeparture(candidate, session, now);
    if (changed) {
      await this.eventStore.persistRoom(candidate);
      replaceRoomState(room, candidate);
      this.updateRoomDueWork(room, now);
    }
    return { ok: true, room };
  }

  private applyDeparture(candidate: Room, session: Session, now: number): boolean {
    let changed = false;
    if (candidate.spectators.delete(session.userId)) changed = true;
    const seat = candidate.seats.find((candidateSeat) => candidateSeat.userId === session.userId);
    if (seat) {
      if (candidate.status === "LOBBY") {
        delete seat.userId;
        delete seat.botId;
        delete seat.displayName;
        seat.ready = false;
        seat.connected = false;
        changed = true;
      } else {
        if (seat.connected || seat.ready) changed = true;
        seat.connected = false;
        seat.ready = false;
      }
    }

    if (candidate.status === "LOBBY" && candidate.hostUserId === session.userId) {
      const nextHost = candidate.seats.find((candidateSeat) => candidateSeat.userId)?.userId;
      if (nextHost) candidate.hostUserId = nextHost;
    }

    if (connectedSeatedHumanCount(candidate) === 0) {
      const nowIso = new Date(now).toISOString();
      if (candidate.status === "IN_GAME" && !candidate.pausedAt) {
        candidate.pausedAt = nowIso;
        candidate.pauseReason = "EMPTY_ROOM";
        candidate.emptySince ??= nowIso;
        changed = true;
      } else if ((candidate.status === "LOBBY" || candidate.status === "FINISHED") && !candidate.emptySince) {
        candidate.emptySince = nowIso;
        changed = true;
      }
    } else if (resumeRoomIfNeeded(candidate, now)) {
      changed = true;
    } else if (candidate.emptySince && candidate.status !== "IN_GAME") {
      delete candidate.emptySince;
      changed = true;
    }

    if (changed) {
      this.touchRoom(candidate, now);
    }
    return changed;
  }

  async syncConnections(roomId: string, connectedUserIds: Set<PlayerId>, now = Date.now()): Promise<Room | undefined> {
    const targetRoom = this.roomForRef(roomId);
    if (!targetRoom) return undefined;
    return this.enqueueRoom(targetRoom.id, () => this.syncConnectionsNow(targetRoom, connectedUserIds, now));
  }

  private async syncConnectionsNow(targetRoom: Room, connectedUserIds: Set<PlayerId>, now: number): Promise<Room | undefined> {
    const room = this.roomForRef(targetRoom.id) ?? targetRoom;
    if (!await this.claimRoom(room)) return undefined;
    const candidate = structuredClone(room) as Room;
    let changed = false;
    for (const seat of candidate.seats) {
      if (!seat.userId) continue;
      const connected = connectedUserIds.has(seat.userId);
      if (seat.connected !== connected) {
        seat.connected = connected;
        changed = true;
      }
      if (candidate.status === "LOBBY" && !connected && seat.ready) {
        seat.ready = false;
        changed = true;
      }
    }
    for (const spectatorId of [...candidate.spectators]) {
      if (!connectedUserIds.has(spectatorId)) {
        candidate.spectators.delete(spectatorId);
        changed = true;
      }
    }
    if (connectedSeatedHumanCount(candidate) === 0) {
      if (candidate.status === "IN_GAME" && !candidate.pausedAt) {
        candidate.pausedAt = new Date(now).toISOString();
        candidate.pauseReason = "EMPTY_ROOM";
        candidate.emptySince ??= candidate.pausedAt;
        changed = true;
      } else if ((candidate.status === "LOBBY" || candidate.status === "FINISHED") && !candidate.emptySince) {
        candidate.emptySince = new Date(now).toISOString();
        changed = true;
      }
    } else if (resumeRoomIfNeeded(candidate, now)) {
      changed = true;
    } else if (candidate.emptySince && candidate.status !== "IN_GAME") {
      delete candidate.emptySince;
      changed = true;
    }
    if (changed) {
      this.touchRoom(candidate, now);
      await this.eventStore.persistRoom(candidate);
      replaceRoomState(room, candidate);
      this.updateRoomDueWork(room, now);
    }
    return room;
  }

  async cleanupRooms(now = Date.now(), roomIds?: string[]): Promise<Array<{ roomId: string; code: string; status: RoomStatus; cleanupReason?: string }>> {
    const cleaned: Array<{ roomId: string; code: string; status: RoomStatus; cleanupReason?: string }> = [];
    const candidates = roomIds
      ? roomIds.map((roomId) => this.rooms.get(roomId)).filter((room): room is Room => Boolean(room))
      : [...this.rooms.values()];
    for (const targetRoom of candidates) {
      const result = await this.enqueueRoom(targetRoom.id, async () => {
        const room = this.rooms.get(targetRoom.id);
        if (!room || room.archivedAt || !await this.claimRoom(room)) return undefined;
        const candidate = structuredClone(room) as Room;
        const changed = applyRoomCleanupPolicy(candidate, this.cleanupPolicy, now);
        if (!changed) return undefined;
        this.touchRoom(candidate, now);
        await this.eventStore.persistRoom(candidate);
        if (candidate.archivedAt || candidate.status === "EXPIRED" || candidate.status === "ABANDONED") {
          this.rooms.delete(room.id);
          this.removeRoomRuntimeState(room.id);
          await this.releaseRoom(room.id);
          return {
            roomId: candidate.id,
            code: candidate.code,
            status: candidate.status,
            ...(candidate.cleanupReason ? { cleanupReason: candidate.cleanupReason } : {}),
          };
        }
        replaceRoomState(room, candidate);
        this.updateRoomDueWork(room, now);
        return undefined;
      });
      if (result) cleaned.push(result);
    }
    return cleaned;
  }

  activeRoomCount(): number {
    return [...this.rooms.values()].filter((room) => isActiveRoom(room)).length;
  }

  livenessState(room: Room): RoomLivenessState {
    return livenessStateForRoom(room);
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

  roomHealthReport(now = Date.now()): RoomHealthEntry[] {
    return [...this.rooms.values()]
      .filter((room) => isActiveRoom(room))
      .map((room) => {
        const roomCleanupDueAt = cleanupDueAt(room, this.cleanupPolicy, now);
        const entry: RoomHealthEntry = {
          roomId: room.id,
          code: room.code,
          status: room.status,
          liveness: this.livenessState(room),
          hostUserId: room.hostUserId,
          createdAt: room.createdAt,
          connectedHumans: connectedSeatedHumanCount(room),
          connectedUsers: connectedUserCount(room),
          botCount: room.seats.filter((seat) => Boolean(seat.botId)).length,
          spectatorCount: room.spectators.size,
          tradeDeadlineCount: room.tradeResponseDeadlines.size,
        };
        if (room.lastActivityAt) entry.lastActivityAt = room.lastActivityAt;
        if (room.pausedAt) entry.pausedAt = room.pausedAt;
        if (room.pauseReason) entry.pauseReason = room.pauseReason;
        if (room.cleanupReason) entry.cleanupReason = room.cleanupReason;
        if (room.timer) entry.timer = room.timer;
        if (Number.isFinite(roomCleanupDueAt)) entry.cleanupDueAt = new Date(roomCleanupDueAt).toISOString();
        if (room.game) {
          entry.eventSeq = room.game.eventSeq;
          entry.turn = room.game.turn;
          entry.phase = room.game.phase.type;
          if ("activePlayerId" in room.game.phase) entry.activePlayerId = room.game.phase.activePlayerId;
        }
        return entry;
      });
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
        seat.botId = this.botIdForSeat(seat.seatIndex);
        seat.ready = true;
        seat.connected = true;
      }
    }
  }

  canStart(room: Room): boolean {
    return canStartLobby(room);
  }

  async startRoom(room: Room): Promise<void> {
    const activeSeats = room.status === "LOBBY"
      ? startableSeatsForRoom(room)
      : room.seats.filter((seat) => seat.userId || seat.botId);
    const activeSeatIndexes = new Set(activeSeats.map((seat) => seat.seatIndex));
    const startedSeats = room.status === "LOBBY"
      ? room.seats.map((seat) => activeSeatIndexes.has(seat.seatIndex) ? seat : { seatIndex: seat.seatIndex, ready: false, connected: false })
      : room.seats;
    const playerOrder = activeSeats.map((seat) => (seat.userId ?? seat.botId) as PlayerId);
    const playerNames = Object.fromEntries(activeSeats.map((seat) => {
      const id = (seat.userId ?? seat.botId) as PlayerId;
      return [id, seat.userId ? this.displayNameForSeat(seat) : `Bot ${seat.seatIndex + 1}`];
    }).filter(([id]) => Boolean(id)));
    const playerColors = Object.fromEntries(playerOrder.map((id, index) => [id, ["#2563eb", "#dc2626", "#16a34a", "#ca8a04"][index] ?? "#64748b"]));
    const config: GameConfig = {
      matchId: `match_${room.id}`,
      seed: room.id,
      victoryPoints: 10,
      maxPlayers: playerOrder.length,
      turnSeconds: actionTurnDurationMs / 1000,
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
    const board = createBoardForRules(room.id, config.rules);
    const game = createGame(config, board);
    const startedRoom: Room = {
      ...room,
      status: "IN_GAME",
      seats: startedSeats,
      board,
      game,
      tradeResponseDeadlines: new Map(),
    };
    this.refreshTimer(startedRoom);
    await this.eventStore.persistMatchStart(startedRoom, game);
    room.board = board;
    room.game = game;
    room.status = "IN_GAME";
    room.seats = startedSeats;
    room.tradeResponseDeadlines.clear();
    if (startedRoom.timer) room.timer = startedRoom.timer;
    else delete room.timer;
  }

  async submitCommand(roomId: string, session: Session, clientSeq: number, command: GameCommand): Promise<CommandResult> {
    const targetRoom = await this.ensureRoomLoadedByRef(roomId);
    const canonicalRoomId = targetRoom?.id ?? roomId;
    return this.enqueueRoom(canonicalRoomId, () => this.submitCommandNow(targetRoom, canonicalRoomId, session, clientSeq, command));
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
    this.refreshTimer(committedRoom, previousState, now);
    try {
      await persistAcceptedEvents(this.eventStore, committedRoom, nextState, events, commandResult);
    } catch (error) {
      if ((error as { code?: unknown }).code === "COMMAND_RESULT_CONFLICT" && commandResult) {
        this.diagnostics.recordCommandConflict("accepted");
        const persisted = await this.eventStore.loadCommandResult?.(room.id, commandResult.userId, commandResult.clientSeq);
        if (persisted) {
          room.processedClientCommands.set(commandIdempotencyKey(room.id, commandResult.userId, commandResult.clientSeq), persisted);
          return replayStoredCommandResult(room.game, persisted, commandResult.commandHash);
        }
        return { ok: false, code: "CLIENT_SEQ_CONFLICT", message: "Client sequence was already used for a different command" };
      }
      return { ok: false, code: "EVENT_COMMIT_FAILED", message: error instanceof Error ? error.message : "Event commit failed" };
    }

    this.appendEvents(room, events, now);
    room.game = nextState;
    room.status = nextStatus;
    this.touchRoom(room, now);
    if (commandResult) room.processedClientCommands.set(commandIdempotencyKey(room.id, commandResult.userId, commandResult.clientSeq), commandResult);
    if (committedRoom.timer) room.timer = committedRoom.timer;
    else delete room.timer;
    this.updateRoomDueWork(room, now);
    return { ok: true, events, state: room.game };
  }

  private async submitCommandNow(targetRoom: Room | undefined, roomId: string, session: Session, clientSeq: number, command: GameCommand): Promise<CommandResult> {
    const room = this.roomForRef(roomId) ?? targetRoom;
    if (!room?.game) return { ok: false, code: "ROOM_NOT_IN_GAME", message: "Room is not in game" };
    if (!await this.claimRoom(room)) return { ok: false, code: "ROOM_NOT_OWNED", message: "Room is owned by another server" };
    if (room.pausedAt) return { ok: false, code: "ROOM_PAUSED", message: "Room is paused until a seated player reconnects" };
    if (!this.isMember(room, session.userId)) return { ok: false, code: "NOT_IN_ROOM", message: "You are not in this room" };
    if (command.playerId !== session.userId) return { ok: false, code: "COMMAND_PLAYER_MISMATCH", message: "Command player does not match session" };

    const commandHash = commandPayloadHash(command);
    const idempotencyKey = commandIdempotencyKey(room.id, session.userId, clientSeq);
    const duplicate = room.processedClientCommands.get(idempotencyKey)
      ?? await this.eventStore.loadCommandResult?.(room.id, session.userId, clientSeq);
    if (duplicate) {
      room.processedClientCommands.set(idempotencyKey, duplicate);
      return replayStoredCommandResult(room.game, duplicate, commandHash);
    }

    const previousState = room.game;
    const result = applyCommand(previousState, command);
    if (!result.ok) {
      const rejected = rejectedStoredCommandResult({
        roomId: room.id,
        matchId: room.game.config.matchId,
        userId: session.userId,
        clientSeq,
        commandHash,
        code: result.error.code,
        message: result.error.message,
      });
      room.processedClientCommands.set(idempotencyKey, rejected);
      try {
        await this.eventStore.persistCommandResult?.(rejected);
      } catch (error) {
        if ((error as { code?: unknown }).code === "COMMAND_RESULT_CONFLICT") {
          this.diagnostics.recordCommandConflict("rejected");
          const persisted = await this.eventStore.loadCommandResult?.(room.id, session.userId, clientSeq);
          if (persisted) {
            room.processedClientCommands.set(idempotencyKey, persisted);
            return replayStoredCommandResult(room.game, persisted, commandHash);
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
    const storedResult = acceptedStoredCommandResult({
      roomId: room.id,
      matchId: previousState.config.matchId,
      userId: session.userId,
      clientSeq,
      commandHash,
      events: allEvents,
    });
    return this.commitAcceptedEvents(room, previousState, result.value.nextState, allEvents, storedResult);
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
      if (!closed.ok) return this.rejectExpiredAutomation(room, now, closed.error);
      const ended = applyCommand(closed.value.nextState, { type: "END_TURN", playerId: activePlayerId });
      if (!ended.ok) return this.rejectExpiredAutomation(room, now, ended.error);
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
    if (!result.ok) return this.rejectExpiredAutomation(room, now, result.error);

    const allEvents = result.value.events;
    return this.commitAcceptedEvents(room, previousState, result.value.nextState, allEvents, undefined, now);
  }

  private rejectExpiredAutomation(room: Room, now: number, error: { code: string; message: string }): Extract<CommandResult, { ok: false }> {
    this.refreshTimer(room);
    this.updateRoomDueWork(room, now);
    return { ok: false, code: error.code, message: error.message };
  }

  async addChat(roomId: string, session: Session, message: string): Promise<ChatMessage | undefined> {
    const targetRoom = this.roomForRef(roomId);
    if (!targetRoom) return undefined;
    return this.enqueueRoom(targetRoom.id, () => this.addChatNow(targetRoom, session, message));
  }

  private async addChatNow(targetRoom: Room, session: Session, message: string): Promise<ChatMessage | undefined> {
    const room = this.roomForRef(targetRoom.id) ?? targetRoom;
    if (!this.isMember(room, session.userId)) return undefined;
    if (!await this.claimRoom(room)) return undefined;
    const chat = createChatMessage(session, message);
    const candidate = structuredClone(room) as Room;
    candidate.chat.push(chat);
    if (candidate.chat.length > maxRoomChatMessages) candidate.chat.splice(0, candidate.chat.length - maxRoomChatMessages);
    this.touchRoom(candidate);
    await this.eventStore.persistChat(candidate, chat);
    replaceRoomState(room, candidate);
    return chat;
  }

  async createReport(roomId: string, reporter: Session, reportedUserId: string, reason: string): Promise<Report | undefined> {
    const targetRoom = this.roomForRef(roomId);
    if (!targetRoom) return undefined;
    return this.enqueueRoom(targetRoom.id, () => this.createReportNow(targetRoom, reporter, reportedUserId, reason));
  }

  private async createReportNow(targetRoom: Room, reporter: Session, reportedUserId: string, reason: string): Promise<Report | undefined> {
    const room = this.roomForRef(targetRoom.id) ?? targetRoom;
    if (!this.isMember(room, reporter.userId)) return undefined;
    if (!room.seats.some((seat) => seat.userId === reportedUserId || seat.botId === reportedUserId)) return undefined;
    if (!await this.claimRoom(room)) return undefined;
    const report = createModerationReport(room, reporter, reportedUserId, reason);
    const candidate = structuredClone(room) as Room;
    candidate.reports.push(report);
    this.touchRoom(candidate);
    await this.eventStore.persistReport(candidate, report);
    replaceRoomState(room, candidate);
    return report;
  }

  async recordAnalytics(event: { userId?: string; matchId?: string; eventName: string; payload: unknown }): Promise<void> {
    await this.eventStore.persistAnalytics(createAnalyticsRecord(event));
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

  private replayIsFinished(log: { events: readonly GameEvent[] }): boolean {
    return log.events.some((event) => event.type === "GAME_OVER");
  }

  async getFinishedReplayById(id: string): Promise<{ status: "missing" | "not_finished"; replay?: undefined } | { status: "finished"; replay: { config: GameConfig; board: GameState["board"]; events: GameEvent[] } }> {
    const replayLog = await this.getReplayById(id);
    if (!replayLog) return { status: "missing" };
    if (!this.replayIsFinished(replayLog)) return { status: "not_finished" };
    return { status: "finished", replay: replayLog };
  }

  reconstructReplay(roomId: string): GameState | undefined {
    const log = this.getReplay(roomId);
    return log ? replay(log) : undefined;
  }

  async resync(roomId: string, session: Session, lastSeq: number): Promise<{ snapshot?: ViewerState; events: GameEvent[] } | undefined> {
    const room = await this.ensureRoomLoadedByRef(roomId);
    if (!room) return undefined;
    if (!room.game) return { events: [] };
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

  refreshTimer(room: Room, previousState?: GameState, now = Date.now()): void {
    if (!room.game || !("activePlayerId" in room.game.phase)) {
      delete room.timer;
      return;
    }
    const nextKey = roomTimerKey(room.game);
    const previousKey = roomTimerKey(previousState);
    if (room.timer && nextKey && nextKey === previousKey && room.timer.activePlayerId === room.game.phase.activePlayerId) {
      return;
    }
    room.timer = {
      activePlayerId: room.game.phase.activePlayerId,
      expiresAt: now + roomTurnDurationMs(room.game),
    };
  }

  refreshRoomDueWork(roomId: string, now = Date.now()): void {
    const room = this.rooms.get(roomId);
    if (room) this.updateRoomDueWork(room, now);
    else this.removeRoomDueWork(roomId);
  }

  private createUniqueRoomCodeSync(): string {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const code = generateRoomCode();
      if (![...this.rooms.values()].some((room) => room.code === code)) return code;
    }
    return generateRoomCode();
  }

  private async createUniqueRoomCode(): Promise<string> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const code = generateRoomCode();
      if ([...this.rooms.values()].some((room) => room.code === code)) continue;
      if (await this.eventStore.roomCodeExists?.(code)) continue;
      return code;
    }
    return this.createUniqueRoomCodeSync();
  }

  private isRoomCodeCollision(error: unknown): boolean {
    const code = (error as { code?: unknown }).code;
    if (code !== "23505") return false;
    const constraint = String((error as { constraint?: unknown }).constraint ?? "");
    const message = error instanceof Error ? error.message : String(error);
    return constraint.includes("room_code") || message.includes("room_code");
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

  private updateRoomDueWork(room: Room, now = Date.now()): void {
    if (!isActiveRoom(room)) {
      this.removeRoomDueWork(room.id);
      return;
    }
    this.automationDueWork.set(room.id, this.automationDueAt(room, now));
    this.cleanupDueWork.set(room.id, cleanupDueAt(room, this.cleanupPolicy, now));
  }

  private removeRoomDueWork(roomId: string): void {
    this.automationDueWork.delete(roomId);
    this.cleanupDueWork.delete(roomId);
  }

  private removeRoomRuntimeState(roomId: string): void {
    this.removeRoomDueWork(roomId);
    this.automationProgress.delete(roomId);
    this.automationCommandTimes.delete(roomId);
    const cooldownPrefix = `${roomId}:`;
    for (const key of this.botTradeCooldowns.keys()) {
      if (key.startsWith(cooldownPrefix)) this.botTradeCooldowns.delete(key);
    }
  }

  private automationDueAt(room: Room, now = Date.now()): number {
    if (!room.game || room.status !== "IN_GAME" || room.game.phase.type === "GAME_OVER" || room.pausedAt) return Number.POSITIVE_INFINITY;
    const tradeDue = Math.min(Number.POSITIVE_INFINITY, ...room.tradeResponseDeadlines.values());
    if (tradeDue <= now) return tradeDue;
    if (botTradeResponseCommand(room)) return now;
    if (readyBotOfferResolutionCommand(room)) return now;
    if (room.timer?.expiresAt && room.timer.expiresAt <= now) return room.timer.expiresAt;
    if ("activePlayerId" in room.game.phase && botSeatIds(room).includes(room.game.phase.activePlayerId)) {
      const lastAutomation = this.automationCommandTimes.get(room.id)?.at(-1);
      return lastAutomation ? lastAutomation + 450 : now;
    }
    return room.timer?.expiresAt ?? Number.POSITIVE_INFINITY;
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

  private async enqueueRooms<T>(roomIds: readonly string[], task: () => Promise<T>): Promise<T> {
    const sortedRoomIds = [...new Set(roomIds)].sort();
    const acquire = (index: number): Promise<T> => index >= sortedRoomIds.length
      ? task()
      : this.enqueueRoom(sortedRoomIds[index]!, () => acquire(index + 1));
    return acquire(0);
  }

  private timeoutCommand(state: GameState, playerId: PlayerId): GameCommand | undefined {
    if (state.phase.type === "DISCARDING") {
      const count = state.phase.pending[playerId] ?? 0;
      return count > 0 ? { type: "DISCARD_RESOURCES", playerId, resources: randomizedDiscard(state, playerId, count), forced: true } : undefined;
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
    const hydration = record.match ? hydrateGameFromStoredMatchWithOutcome(record.match) : undefined;
    const game = hydration?.state;
    this.diagnostics.recordHydration(hydration?.outcome ?? "room_only");
    const status = game?.phase.type === "GAME_OVER" ? "FINISHED" : record.status;
    const room: Room = {
      id: record.id,
      code: record.code ?? this.createUniqueRoomCodeSync(),
      hostUserId: record.hostUserId,
      status,
      settings: record.settings,
      seats: record.seats.map((seat) => ({ ...seat, connected: false })),
      spectators: new Set(),
      createdAt: record.createdAt,
      lastActivityAt: record.lastActivityAt ?? record.createdAt,
      events: record.match?.events ?? [],
      chat: (record.chat ?? []).slice(-maxRoomChatMessages),
      reports: record.reports ?? [],
      processedClientCommands: new Map(),
      tradeResponseDeadlines: new Map(Object.entries(record.tradeResponseDeadlines ?? {})),
    };
    if (record.emptySince) room.emptySince = record.emptySince;
    if (record.pausedAt) room.pausedAt = record.pausedAt;
    if (record.pauseReason) room.pauseReason = record.pauseReason;
    if (record.archivedAt) room.archivedAt = record.archivedAt;
    if (record.cleanupReason) room.cleanupReason = record.cleanupReason;
    if (record.timer) room.timer = record.timer;
    if (game) room.game = game;
    if (record.match?.board) room.board = record.match.board;
    if (room.game) {
      if (!record.tradeResponseDeadlines) this.rebuildTradeResponseDeadlines(room);
      else {
        for (const [tradeId] of room.tradeResponseDeadlines) {
          if (room.game.trades[tradeId]?.status !== "COLLECTING_RESPONSES") room.tradeResponseDeadlines.delete(tradeId);
        }
      }
      if (!("activePlayerId" in room.game.phase) || !room.timer || room.timer.activePlayerId !== room.game.phase.activePlayerId) {
        this.refreshTimer(room);
      }
    }
    return room;
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
    const candidate = structuredClone(room) as Room;
    candidate.pausedAt = new Date(now).toISOString();
    candidate.pauseReason = "STALLED_AUTOMATION";
    this.touchRoom(candidate, now);
    await this.eventStore.persistRoom(candidate);
    replaceRoomState(room, candidate);
    this.diagnostics.recordAutomationPause("stalled");
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

    const dueTrade = dueTradeResponseCommand(room, now);
    if (dueTrade) return this.automationCommandAllowed(room, now) ? this.applyInternalCommand(room, dueTrade) : this.pauseForAutomationBudget(room, now);

    const tradeResponse = botTradeResponseCommand(room);
    if (tradeResponse) return this.automationCommandAllowed(room, now) ? this.applyInternalCommand(room, tradeResponse) : this.pauseForAutomationBudget(room, now);

    const readyBotOffer = readyBotOfferResolutionCommand(room);
    if (readyBotOffer) return this.automationCommandAllowed(room, now) ? this.applyInternalCommand(room, readyBotOffer) : this.pauseForAutomationBudget(room, now);

    if (!("activePlayerId" in room.game.phase) || !botSeatIds(room).includes(room.game.phase.activePlayerId)) return undefined;
    const active = room.game.phase.activePlayerId;
    let command = chooseBotTurnCommand(room, active);
    if (!command) return undefined;
    if (command.type === "OFFER_TRADE") {
      const cooldownKey = `${room.id}:${active}:${tradeShapeKey(command)}`;
      const cooldownUntil = this.botTradeCooldowns.get(cooldownKey) ?? -1;
      if (cooldownUntil >= room.game.turn) {
        command = { type: "END_TURN", playerId: active };
      } else {
        this.botTradeCooldowns.set(cooldownKey, room.game.turn + this.cleanupPolicy.botTradeCooldownTurns);
      }
    }
    return this.automationCommandAllowed(room, now) ? this.applyInternalCommand(room, command) : this.pauseForAutomationBudget(room, now);
  }

  private async pauseForAutomationBudget(room: Room, now: number): Promise<CommandResult | undefined> {
    const candidate = structuredClone(room) as Room;
    candidate.pausedAt = new Date(now).toISOString();
    candidate.pauseReason = "STALLED_AUTOMATION";
    this.touchRoom(candidate, now);
    await this.eventStore.persistRoom(candidate);
    replaceRoomState(room, candidate);
    this.diagnostics.recordAutomationPause("budget");
    this.updateRoomDueWork(room, now);
    return undefined;
  }
}
