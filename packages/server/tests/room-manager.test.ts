import { describe, expect, it } from "vitest";
import { boardHexComponentCount, createSeededBoard, emptyResources, getLegalActions, resourceCount, serializeForViewer, type GameCommand, type GameState, type TradeOffer } from "@colonizt/game-core";
import { maxRoomChatMessages, MemoryEventStore, type EventStore, type StoredCommandResult, type StoredRoomRecord } from "../src/event-store.js";
import { MemoryRoomOwnershipStore } from "../src/ownership.js";
import { RoomCapacityError, RoomManager, type ChatMessage, type Report, type Room, type Session } from "../src/room-manager.js";
import type { GameEvent } from "@colonizt/game-core";
import { createDemoGame, withResources } from "@colonizt/demo-state";

const startedRoom = async (eventStore?: EventStore) => {
  const manager = new RoomManager();
  const actualManager = eventStore ? new RoomManager(eventStore) : manager;
  const session = await actualManager.createSession("Host");
  const room = await actualManager.createRoom(session, { mode: "CLASSIC", botFill: true, ranked: false });
  const ready = await actualManager.setReady(room.id, session, true);
  if (!ready.ok) throw new Error("ready failed");
  return { manager: actualManager, session, room: ready.room };
};

class FailingAppendStore extends MemoryEventStore {
  async appendEvents(_room: Room, _events: GameEvent[]): Promise<void> {
    throw new Error("planned append failure");
  }
}

class FailingCommandResultStore extends MemoryEventStore {
  async persistCommandResult(): Promise<void> {
    throw new Error("planned command result failure");
  }
}

class ConflictingCommandResultStore extends MemoryEventStore {
  private conflictingResult: StoredCommandResult | undefined;

  async persistCommandResult(result: StoredCommandResult): Promise<void> {
    this.conflictingResult = {
      roomId: result.roomId,
      matchId: result.matchId,
      userId: result.userId,
      clientSeq: result.clientSeq,
      commandHash: "preexisting-command",
      ok: false,
      rejectionCode: "PREEXISTING_RESULT",
      rejectionMessage: "Preexisting command result",
    };
    throw Object.assign(new Error("command result conflict"), { code: "COMMAND_RESULT_CONFLICT" });
  }

  async loadCommandResult(roomId: string, userId: string, clientSeq: number): Promise<StoredCommandResult | undefined> {
    return this.conflictingResult
      ?? super.loadCommandResult(roomId, userId, clientSeq);
  }
}

class EmptyConflictingCommandResultStore extends MemoryEventStore {
  async persistCommandResult(): Promise<void> {
    throw Object.assign(new Error("command result conflict"), { code: "COMMAND_RESULT_CONFLICT" });
  }

  async loadCommandResult(): Promise<undefined> {
    return undefined;
  }
}

class PersistBeforeAcquireOwnershipStore extends MemoryRoomOwnershipStore {
  constructor(private readonly eventStore: EventStore) {
    super();
  }

  override async acquire(roomId: string, ownerId: string, ttlMs: number): Promise<boolean> {
    const persisted = await this.eventStore.loadRoomByRef?.(roomId);
    expect(persisted).toBeDefined();
    return super.acquire(roomId, ownerId, ttlMs);
  }
}

class DelayedMatchStartStore extends MemoryEventStore {
  matchStarted = false;
  private resolveStartEntered!: () => void;
  private releaseStart!: () => void;
  readonly startEntered: Promise<void>;
  private readonly startReleased: Promise<void>;

  constructor() {
    super();
    this.startEntered = new Promise((resolve) => {
      this.resolveStartEntered = resolve;
    });
    this.startReleased = new Promise((resolve) => {
      this.releaseStart = resolve;
    });
  }

  releaseMatchStart(): void {
    this.releaseStart();
  }

  async persistMatchStart(room: Room, state: GameState): Promise<void> {
    this.resolveStartEntered();
    await this.startReleased;
    await super.persistMatchStart(room, state);
    this.matchStarted = true;
  }

  async appendEvents(room: Room, events: GameEvent[]): Promise<void> {
    if (!this.matchStarted) throw new Error("append before match start");
    await super.appendEvents(room, events);
  }
}

class DelayedRoomCreationStore extends MemoryEventStore {
  private resolvePersistEntered!: () => void;
  private releasePersist!: () => void;
  readonly persistEntered: Promise<void>;
  private readonly persistReleased: Promise<void>;

  constructor() {
    super();
    this.persistEntered = new Promise((resolve) => {
      this.resolvePersistEntered = resolve;
    });
    this.persistReleased = new Promise((resolve) => {
      this.releasePersist = resolve;
    });
  }

  releaseRoomPersist(): void {
    this.releasePersist();
  }

  override async persistRoom(room: Room): Promise<void> {
    this.resolvePersistEntered();
    await this.persistReleased;
    await super.persistRoom(room);
  }
}

class CountingStartStore extends MemoryEventStore {
  persistRoomCount = 0;
  matchStartCount = 0;

  async persistRoom(room: Room): Promise<void> {
    this.persistRoomCount += 1;
    await super.persistRoom(room);
  }

  async persistMatchStart(room: Room, state: GameState): Promise<void> {
    this.matchStartCount += 1;
    await super.persistMatchStart(room, state);
  }
}

class FirstCodeCollisionStore extends MemoryEventStore {
  roomCodeChecks = 0;

  override async roomCodeExists(code: string): Promise<boolean> {
    this.roomCodeChecks += 1;
    return this.roomCodeChecks === 1 || super.roomCodeExists(code);
  }
}

class PersistedRoomCodeCollisionStore extends MemoryEventStore {
  persistAttempts = 0;

  override async persistRoom(room: Room): Promise<void> {
    this.persistAttempts += 1;
    if (this.persistAttempts === 1) {
      throw Object.assign(new Error("duplicate room_code"), { code: "23505", constraint: "rooms_room_code_key" });
    }
    await super.persistRoom(room);
  }
}

class NonCollisionRoomFailureStore extends MemoryEventStore {
  override async persistRoom(): Promise<void> {
    throw new Error("storage offline");
  }
}

class DenyingRoomOwnershipStore extends MemoryRoomOwnershipStore {
  override async acquire(): Promise<boolean> {
    return false;
  }
}

class FailingHydrationStore extends MemoryEventStore {
  override async loadSessions(): Promise<Session[]> {
    throw new Error("planned hydration read failure");
  }
}

const invalidStoredRoom = (): StoredRoomRecord => {
  const game = createDemoGame("invalid-stored-room");
  return {
    id: "room_invalid",
    code: "BAD001",
    status: "IN_GAME",
    hostUserId: "p1",
    settings: { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2, maxPlayers: 4 },
    createdAt: "2026-07-16T00:00:00.000Z",
    seats: game.playerOrder.map((userId, seatIndex) => ({ seatIndex, userId, ready: true, connected: false })),
    match: {
      id: game.config.matchId,
      config: game.config,
      board: game.board,
      events: [{ schemaVersion: 3, seq: 1, type: "UNKNOWN_EVENT" } as unknown as GameEvent],
    },
  };
};

class InvalidHydrationStore extends MemoryEventStore {
  override async loadRooms(): Promise<StoredRoomRecord[]> {
    return [invalidStoredRoom()];
  }

  override async loadRoomByRef(): Promise<StoredRoomRecord> {
    return invalidStoredRoom();
  }
}

class FailNextRoomPersistStore extends MemoryEventStore {
  failNextPersist = false;
  failNextSessionPersist = false;
  failNextChatPersist = false;
  failNextReportPersist = false;

  override async persistRoom(room: Room): Promise<void> {
    if (this.failNextPersist) {
      this.failNextPersist = false;
      throw new Error("planned join persistence failure");
    }
    await super.persistRoom(room);
  }

  override async persistSession(session: Session): Promise<void> {
    if (this.failNextSessionPersist) {
      this.failNextSessionPersist = false;
      throw new Error("planned session persistence failure");
    }
    await super.persistSession(session);
  }

  override async persistChat(room: Room, chat: ChatMessage): Promise<void> {
    if (this.failNextChatPersist) {
      this.failNextChatPersist = false;
      throw new Error("planned chat persistence failure");
    }
    await super.persistChat(room, chat);
  }

  override async persistReport(room: Room, report: Report): Promise<void> {
    if (this.failNextReportPersist) {
      this.failNextReportPersist = false;
      throw new Error("planned report persistence failure");
    }
    await super.persistReport(room, report);
  }
}

class OrderedRoomPersistStore extends MemoryEventStore {
  private armed = false;
  private readyWriteStarted = false;
  private resolveReadyStarted!: () => void;
  private resolveReadyWrite!: () => void;
  private resolveReadyPersisted!: () => void;
  readonly readyStarted = new Promise<void>((resolve) => { this.resolveReadyStarted = resolve; });
  private readonly readyWrite = new Promise<void>((resolve) => { this.resolveReadyWrite = resolve; });
  private readonly readyPersisted = new Promise<void>((resolve) => { this.resolveReadyPersisted = resolve; });

  arm(): void {
    this.armed = true;
  }

  releaseReadyWrite(): void {
    this.resolveReadyWrite();
  }

  override async persistRoom(room: Room): Promise<void> {
    const hostReady = room.seats[0]?.ready === true;
    if (this.armed && hostReady && !this.readyWriteStarted) {
      this.readyWriteStarted = true;
      this.resolveReadyStarted();
      await this.readyWrite;
      await super.persistRoom(room);
      this.resolveReadyPersisted();
      return;
    }
    if (this.armed && this.readyWriteStarted && !hostReady) await this.readyPersisted;
    await super.persistRoom(room);
  }
}

describe("RoomManager", () => {
  it("creates sessions and rooms", async () => {
    const manager = new RoomManager();
    const session = await manager.createSession("Soo");
    const room = await manager.createRoom(session, { mode: "CLASSIC", botFill: true, ranked: false });
    expect(manager.getSession(session.token)?.userId).toBe(session.userId);
    expect(room.seats[0]?.userId).toBe(session.userId);
    expect(room.code).toMatch(/^[A-Z2-9]{6}$/);
    expect(manager.roomForRef(room.code)?.id).toBe(room.id);
  });

  it("checks persisted room codes before assigning a public lobby code", async () => {
    const store = new FirstCodeCollisionStore();
    const manager = new RoomManager(store);
    const session = await manager.createSession("Host");

    const room = await manager.createRoom(session, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2 });

    expect(room.code).toMatch(/^[A-Z2-9]{6}$/);
    expect(store.roomCodeChecks).toBeGreaterThan(1);
    expect(await store.roomCodeExists(room.code)).toBe(true);
  });

  it("retries database room-code collisions but propagates unrelated persistence failures", async () => {
    const collisionStore = new PersistedRoomCodeCollisionStore();
    const collisionManager = new RoomManager(collisionStore);
    const collisionSession = await collisionManager.createSession("Collision Host");
    const room = await collisionManager.createRoom(collisionSession, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2 });

    expect(room.code).toMatch(/^[A-Z2-9]{6}$/);
    expect(collisionStore.persistAttempts).toBe(2);

    const failingManager = new RoomManager(new NonCollisionRoomFailureStore());
    const failingSession = await failingManager.createSession("Failure Host");
    await expect(failingManager.createRoom(failingSession, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2 }))
      .rejects.toThrow("storage offline");
  });

  it("does not expose a newly persisted room when its ownership lease is denied", async () => {
    const store = new MemoryEventStore();
    const manager = new RoomManager(store, { ownershipStore: new DenyingRoomOwnershipStore() });
    const session = await manager.createSession("Lease denied");

    await expect(manager.createRoom(session, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2 }))
      .rejects.toThrow(/Could not acquire ownership for newly created room/);
    expect(manager.rooms.size).toBe(0);
  });

  it("does not expose an unpersisted room or exceed capacity during concurrent creation", async () => {
    const store = new DelayedRoomCreationStore();
    const manager = new RoomManager(store, { maxActiveRooms: 1 });
    const first = await manager.createSession("First host");
    const second = await manager.createSession("Second host");
    const firstCreation = manager.createRoom(first, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2 });
    await store.persistEntered;

    expect(manager.listRooms()).toEqual([]);
    await expect(manager.createRoom(second, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2 }))
      .rejects.toBeInstanceOf(RoomCapacityError);

    store.releaseRoomPersist();
    await expect(firstCreation).resolves.toMatchObject({ hostUserId: first.userId });
    expect(manager.listRooms()).toHaveLength(1);
  });

  it("propagates store read and record validation failures during eager and lazy hydration", async () => {
    await expect(new RoomManager(new FailingHydrationStore()).hydrateFromStore())
      .rejects.toThrow("planned hydration read failure");

    const eager = new RoomManager(new InvalidHydrationStore());
    await expect(eager.hydrateFromStore()).rejects.toThrow(/Invalid replay log/);
    expect(eager.rooms.size).toBe(0);

    const lazy = new RoomManager(new InvalidHydrationStore());
    await expect(lazy.ensureRoomLoadedByRef("BAD001")).rejects.toThrow(/Invalid replay log/);
    expect(lazy.rooms.size).toBe(0);
  });

  it("rejects non-contiguous event appends and forces a snapshot-only resync across a history gap", async () => {
    const { manager, session, room } = await startedRoom();
    if (!room.game) throw new Error("expected started room");
    const [playerId, nextPlayerId] = room.game.playerOrder;
    if (!playerId || !nextPlayerId) throw new Error("expected players");
    const event = { schemaVersion: 3, seq: 2, type: "TURN_ENDED", playerId, nextPlayerId } as GameEvent;

    expect(() => manager.appendEvents(room, [event])).toThrow("Expected event seq 1, got 2");
    room.events.push(event);
    const resync = await manager.resync(room.id, session, 0);

    expect(resync?.snapshot).toBeDefined();
    expect(resync?.events).toEqual([]);
    await expect(manager.getStoredReplayByMatchId("missing-match")).resolves.toBeUndefined();
  });

  it("repairs stale empty-room lifecycle markers and removes archived rooms from due work", async () => {
    const manager = new RoomManager(undefined, { finishedRoomUnloadMs: 10_000 });
    const session = await manager.createSession("Lifecycle Host");
    const room = await manager.createRoom(session, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2 });
    room.emptySince = new Date(0).toISOString();

    await manager.syncConnections(room.id, new Set([session.userId]), 1_000);
    expect(room.emptySince).toBeUndefined();

    room.emptySince = new Date(0).toISOString();
    const cleanedConnected = await manager.cleanupRooms(2_000, [room.id]);
    expect(cleanedConnected).toEqual([]);
    expect(room.emptySince).toBeUndefined();

    room.status = "FINISHED";
    room.seats.forEach((seat) => { seat.connected = false; });
    const cleanedFinished = await manager.cleanupRooms(3_000, [room.id]);
    expect(cleanedFinished).toEqual([]);
    expect(room.emptySince).toBe(new Date(3_000).toISOString());

    room.status = "EXPIRED";
    manager.refreshRoomDueWork(room.id, 4_000);
    expect(manager.dueCleanupRoomIds(Number.POSITIVE_INFINITY)).not.toContain(room.id);
  });

  it("falls back to a stable user id when a persisted seat has no display name or session", async () => {
    const manager = new RoomManager();
    const session = await manager.createSession("Original Host");
    const room = await manager.createRoom(session, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2 });
    room.seats[0] = { seatIndex: 0, userId: "orphaned-user", ready: false, connected: false };

    expect(manager.publicRoom(room, "spectator").seats[0]?.displayName).toBe("orphaned-user");
  });

  it("persists new rooms before acquiring ownership leases", async () => {
    const store = new MemoryEventStore();
    const manager = new RoomManager(store, { ownershipStore: new PersistBeforeAcquireOwnershipStore(store) });
    const session = await manager.createSession("Host");

    const room = await manager.createRoom(session, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 4 });

    expect(room.id).toMatch(/^room_/);
  });

  it("writes memory snapshots when a committed event batch crosses the snapshot interval", async () => {
    const store = new MemoryEventStore();
    const { room } = await startedRoom(store);
    if (!room.game) throw new Error("Expected started room");
    const [playerId, nextPlayerId] = room.game.playerOrder;
    if (!playerId || !nextPlayerId) throw new Error("Expected at least two players");
    const events = [24, 25, 26].map((seq) => ({
      schemaVersion: room.game!.schemaVersion,
      seq,
      type: "TURN_ENDED",
      playerId,
      nextPlayerId,
    } as GameEvent));
    room.game = { ...room.game, eventSeq: 26 };

    await store.commitEvents(room, events);

    const snapshot = await store.loadLatestSnapshot(room.game.config.matchId);
    expect(snapshot?.seq).toBe(26);
    expect(snapshot?.state.eventSeq).toBe(26);
  });

  it("rolls back a newly created replay log when an atomic command-result write conflicts", async () => {
    const store = new MemoryEventStore();
    const { room } = await startedRoom(store);
    if (!room.game) throw new Error("Expected started room");
    const [playerId, nextPlayerId] = room.game.playerOrder;
    if (!playerId || !nextPlayerId) throw new Error("Expected at least two players");
    const priorResult: StoredCommandResult = {
      roomId: room.id,
      matchId: room.game.config.matchId,
      userId: playerId,
      clientSeq: 7,
      commandHash: "original-command",
      ok: false,
      rejectionCode: "ORIGINAL_REJECTION",
      rejectionMessage: "Original result",
    };
    await store.persistCommandResult(priorResult);
    store.replayLogs.delete(room.game.config.matchId);
    store.rooms.delete(room.id);
    const event = {
      schemaVersion: room.game.schemaVersion,
      seq: 1,
      type: "TURN_ENDED",
      playerId,
      nextPlayerId,
    } as GameEvent;

    await expect(store.commitEvents(room, [event], priorResult)).rejects.toMatchObject({ code: "COMMAND_RESULT_CONFLICT" });

    expect(store.replayLogs.has(room.game.config.matchId)).toBe(false);
    expect(store.rooms.has(room.id)).toBe(false);
    await expect(store.loadCommandResult(room.id, playerId, 7)).resolves.toEqual(priorResult);
  });

  it("rejects new rooms when active room capacity is reached", async () => {
    const manager = new RoomManager(new MemoryEventStore(), { maxActiveRooms: 1 });
    const first = await manager.createSession("First");
    const second = await manager.createSession("Second");
    await manager.createRoom(first, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 4 });
    await expect(manager.createRoom(second, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 4 })).rejects.toBeInstanceOf(RoomCapacityError);
  });

  it("rejects room mutations when another owner holds the lease", async () => {
    const store = new MemoryEventStore();
    const ownershipStore = new MemoryRoomOwnershipStore();
    const ownerA = new RoomManager(store, { ownerId: "owner-a", ownershipStore });
    const host = await ownerA.createSession("Host");
    const guest = await ownerA.createSession("Guest");
    const room = await ownerA.createRoom(host, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 4 });
    const ownerB = new RoomManager(store, { ownerId: "owner-b", ownershipStore });
    const recoveredHost = await ownerB.resolveSession(host.token);
    const recoveredGuest = await ownerB.resolveSession(guest.token);
    if (!recoveredHost || !recoveredGuest) throw new Error("sessions not recovered");

    const joined = await ownerB.joinRoom(room.code, recoveredGuest);

    expect(joined).toMatchObject({ ok: false, code: "ROOM_NOT_OWNED" });
    const mutationResults = await Promise.all([
      ownerB.setReady(room.code, recoveredHost, true),
      ownerB.updateRoomSettings(room.code, recoveredHost, { ranked: true }),
      ownerB.addLobbyBot(room.code, recoveredHost),
      ownerB.removeLobbyBot(room.code, recoveredHost, 1),
      ownerB.startRoomByHost(room.code, recoveredHost),
      ownerB.leaveRoom(room.code, recoveredHost),
    ]);
    expect(mutationResults).toEqual(mutationResults.map(() => expect.objectContaining({ ok: false, code: "ROOM_NOT_OWNED" })));

    const gameRoom = await ownerA.createRoom(host, { mode: "CLASSIC", botFill: true, ranked: false });
    const started = await ownerA.setReady(gameRoom.id, host, true);
    if (!started.ok) throw new Error("game room did not start");
    await expect(ownerB.submitCommand(gameRoom.code, recoveredHost, 1, { type: "ROLL_DICE", playerId: recoveredHost.userId }))
      .resolves.toMatchObject({ ok: false, code: "ROOM_NOT_OWNED" });
    expect(ownerB.roomForRef(room.id)).toBeUndefined();
  });

  it("does not expose an unpersisted join and permits a clean retry", async () => {
    const store = new FailNextRoomPersistStore();
    const manager = new RoomManager(store);
    const host = await manager.createSession("Host");
    const guest = await manager.createSession("Guest");
    const room = await manager.createRoom(host, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2 });
    store.failNextPersist = true;

    await expect(manager.joinRoom(room.id, guest)).rejects.toThrow("planned join persistence failure");
    expect(room.seats.some((seat) => seat.userId === guest.userId)).toBe(false);
    expect(manager.roomForRef(room.id)?.seats.some((seat) => seat.userId === guest.userId)).toBe(false);

    await expect(manager.joinRoom(room.id, guest)).resolves.toMatchObject({ ok: true });
    expect(room.seats.some((seat) => seat.userId === guest.userId)).toBe(true);
  });

  it("does not expose unpersisted lobby, connection, or cleanup mutations", async () => {
    const store = new FailNextRoomPersistStore();
    const manager = new RoomManager(store, { emptyLobbyTtlMs: 1_000 });
    const host = await manager.createSession("Host");
    const room = await manager.createRoom(host, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2 });

    store.failNextPersist = true;
    await expect(manager.setReady(room.id, host, true)).rejects.toThrow("planned join persistence failure");
    expect(room.seats[0]).toMatchObject({ ready: false, connected: false });

    store.failNextPersist = true;
    await expect(manager.updateRoomSettings(room.id, host, { ranked: true })).rejects.toThrow("planned join persistence failure");
    expect(room.settings.ranked).toBe(false);

    store.failNextPersist = true;
    await expect(manager.addLobbyBot(room.id, host)).rejects.toThrow("planned join persistence failure");
    expect(room.seats.some((seat) => seat.botId)).toBe(false);

    const added = await manager.addLobbyBot(room.id, host);
    if (!added.ok) throw new Error("bot was not added");
    const botSeat = room.seats.find((seat) => seat.botId);
    if (!botSeat) throw new Error("bot seat missing");
    store.failNextPersist = true;
    await expect(manager.removeLobbyBot(room.id, host, botSeat.seatIndex)).rejects.toThrow("planned join persistence failure");
    expect(room.seats[botSeat.seatIndex]?.botId).toBe(botSeat.botId);

    store.failNextPersist = true;
    await expect(manager.leaveRoom(room.id, host, 500)).rejects.toThrow("planned join persistence failure");
    expect(room.seats.some((seat) => seat.userId === host.userId)).toBe(true);

    store.failNextPersist = true;
    await expect(manager.syncConnections(room.id, new Set([host.userId]), 750)).rejects.toThrow("planned join persistence failure");
    expect(room.seats.find((seat) => seat.userId === host.userId)?.connected).toBe(false);

    room.emptySince = new Date(0).toISOString();
    manager.refreshRoomDueWork(room.id, 2_000);
    store.failNextPersist = true;
    await expect(manager.cleanupRooms(2_000, [room.id])).rejects.toThrow("planned join persistence failure");
    manager.refreshRoomDueWork(room.id, 2_000);
    expect(room.status).toBe("LOBBY");
    expect(room.archivedAt).toBeUndefined();
    expect(manager.dueCleanupRoomIds(2_000)).toContain(room.id);
  });

  it("serializes connection snapshots behind accepted room mutations", async () => {
    const store = new OrderedRoomPersistStore();
    const manager = new RoomManager(store);
    const host = await manager.createSession("Queued Host");
    const room = await manager.createRoom(host, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2 });
    store.arm();

    const readyPromise = manager.setReady(room.id, host, true);
    await store.readyStarted;
    const connectionsPromise = manager.syncConnections(room.id, new Set([host.userId]));
    store.releaseReadyWrite();
    const [ready] = await Promise.all([readyPromise, connectionsPromise]);

    expect(ready).toMatchObject({ ok: true });
    expect(room.seats[0]).toMatchObject({ ready: true, connected: true });
  });

  it("does not expose unpersisted sessions, names, chat, or reports", async () => {
    const store = new FailNextRoomPersistStore();
    const manager = new RoomManager(store);
    store.failNextSessionPersist = true;
    await expect(manager.createSession("Lost Session")).rejects.toThrow("planned session persistence failure");
    expect(manager.sessions.size).toBe(0);

    const host = await manager.createSession("Host");
    const room = await manager.createRoom(host, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2 });
    store.failNextSessionPersist = true;
    await expect(manager.updateDisplayName(host, "Renamed", room.id)).rejects.toThrow("planned session persistence failure");
    expect(host.displayName).toBe("Host");
    expect(manager.getSession(host.token)?.displayName).toBe("Host");
    expect(room.seats[0]?.displayName).toBe("Host");

    store.failNextChatPersist = true;
    await expect(manager.addChat(room.id, host, "not durable")).rejects.toThrow("planned chat persistence failure");
    expect(room.chat).toEqual([]);

    store.failNextReportPersist = true;
    await expect(manager.createReport(room.id, host, host.userId, "not durable")).rejects.toThrow("planned report persistence failure");
    expect(room.reports).toEqual([]);
  });

  it("unseats lobby players on explicit leave", async () => {
    const manager = new RoomManager();
    const host = await manager.createSession("Host");
    const guest = await manager.createSession("Guest");
    const room = await manager.createRoom(host, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2 });
    const joined = await manager.joinRoom(room.code, guest);
    expect(joined.ok).toBe(true);
    const ready = await manager.setReady(room.id, guest, true);
    expect(ready.ok).toBe(true);

    const left = await manager.leaveRoom(room.code, guest);

    expect(left.ok).toBe(true);
    if (!left.ok) throw new Error("leave failed");
    expect(left.room.status).toBe("LOBBY");
    expect(left.room.seats.some((seat) => seat.userId === guest.userId)).toBe(false);
    expect(left.room.seats[1]).toMatchObject({ ready: false, connected: false });
  });

  it("treats room-code and canonical-id joins as the same room during a switch", async () => {
    const manager = new RoomManager();
    const host = await manager.createSession("Host");
    const room = await manager.createRoom(host, { mode: "CLASSIC", botFill: false, ranked: false });

    const switched = await manager.switchRoom(room.id, room.code, host);

    expect(switched).toMatchObject({ ok: true, room: { id: room.id }, previousRoom: { id: room.id } });
    expect(room.seats.filter((seat) => seat.userId === host.userId)).toHaveLength(1);
  });

  it("orders opposite two-room switches consistently without deadlocking", async () => {
    const manager = new RoomManager();
    const firstHost = await manager.createSession("First Host");
    const secondHost = await manager.createSession("Second Host");
    const firstRoom = await manager.createRoom(firstHost, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2 });
    const secondRoom = await manager.createRoom(secondHost, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2 });

    const [firstSwitch, secondSwitch] = await Promise.all([
      manager.switchRoom(firstRoom.id, secondRoom.id, firstHost),
      manager.switchRoom(secondRoom.id, firstRoom.id, secondHost),
    ]);

    expect(firstSwitch).toMatchObject({ ok: true, room: { id: secondRoom.id }, previousRoom: { id: firstRoom.id } });
    expect(secondSwitch).toMatchObject({ ok: true, room: { id: firstRoom.id }, previousRoom: { id: secondRoom.id } });
    expect(firstRoom.seats.some((seat) => seat.userId === secondHost.userId)).toBe(true);
    expect(firstRoom.seats.some((seat) => seat.userId === firstHost.userId)).toBe(false);
    expect(secondRoom.seats.some((seat) => seat.userId === firstHost.userId)).toBe(true);
    expect(secondRoom.seats.some((seat) => seat.userId === secondHost.userId)).toBe(false);
  });

  it("does not let an explicit socket leave bypass the retained active-game seat guard", async () => {
    const manager = new RoomManager();
    const player = await manager.createSession("Active Player");
    const otherHost = await manager.createSession("Other Host");
    const activeRoom = await manager.createRoom(player, { mode: "CLASSIC", botFill: true, ranked: false });
    const destination = await manager.createRoom(otherHost, { mode: "CLASSIC", botFill: false, ranked: false });
    await manager.setReady(activeRoom.id, player, true);
    await manager.leaveRoom(activeRoom.id, player);

    await expect(manager.joinRoom(destination.id, player)).resolves.toMatchObject({ ok: false, code: "ROOM_SWITCH_ACTIVE_GAME" });
    expect(manager.isMember(activeRoom, player.userId)).toBe(true);
    expect(manager.isMember(destination, player.userId)).toBe(false);
  });

  it("preserves previous membership when a destination is full or owned elsewhere", async () => {
    const ownership = new MemoryRoomOwnershipStore();
    const manager = new RoomManager(undefined, { ownerId: "node_a", ownershipStore: ownership });
    const oldHost = await manager.createSession("Old Host");
    const destinationHost = await manager.createSession("Destination Host");
    const guest = await manager.createSession("Guest");
    const occupant = await manager.createSession("Occupant");
    const oldRoom = await manager.createRoom(oldHost, { mode: "CLASSIC", botFill: false, ranked: false });
    const fullRoom = await manager.createRoom(destinationHost, { mode: "DUEL", botFill: false, ranked: false, maxPlayers: 2 });
    await manager.joinRoom(oldRoom.id, guest);
    await manager.joinRoom(fullRoom.id, occupant);

    await expect(manager.switchRoom(oldRoom.id, fullRoom.id, guest)).resolves.toMatchObject({ ok: false, code: "ROOM_FULL" });
    expect(manager.isMember(oldRoom, guest.userId)).toBe(true);
    expect(manager.isMember(fullRoom, guest.userId)).toBe(false);

    const openRoom = await manager.createRoom(destinationHost, { mode: "CLASSIC", botFill: false, ranked: false });
    await ownership.release(openRoom.id, "node_a");
    await ownership.acquire(openRoom.id, "node_b", 60_000);
    await expect(manager.switchRoom(oldRoom.id, openRoom.id, guest)).resolves.toMatchObject({ ok: false, code: "ROOM_NOT_OWNED" });
    expect(manager.isMember(oldRoom, guest.userId)).toBe(true);
    expect(manager.isMember(openRoom, guest.userId)).toBe(false);

    const closedRoom = await manager.createRoom(destinationHost, { mode: "CLASSIC", botFill: false, ranked: false });
    closedRoom.archivedAt = new Date().toISOString();
    await expect(manager.switchRoom(oldRoom.id, closedRoom.id, guest)).resolves.toMatchObject({ ok: false, code: "ROOM_CLOSED" });
    expect(manager.isMember(oldRoom, guest.userId)).toBe(true);
    expect(manager.isMember(closedRoom, guest.userId)).toBe(false);
  });

  it("transfers a bot-only lobby to the next human who joins", async () => {
    const manager = new RoomManager();
    const host = await manager.createSession("Host");
    const guest = await manager.createSession("Guest");
    const room = await manager.createRoom(host, { mode: "DUEL", botFill: false, ranked: false, minPlayers: 2, maxPlayers: 2 });
    expect((await manager.addLobbyBot(room.id, host)).ok).toBe(true);
    expect((await manager.leaveRoom(room.id, host)).ok).toBe(true);

    const joined = await manager.joinRoom(room.code, guest);
    expect(joined).toMatchObject({ ok: true, room: { hostUserId: guest.userId } });
    expect((await manager.setReady(room.id, guest, true)).ok).toBe(true);
    await expect(manager.startRoomByHost(room.id, guest)).resolves.toMatchObject({ ok: true, room: { status: "IN_GAME" } });
  });

  it("honors explicit two-player room capacity", async () => {
    const manager = new RoomManager();
    const [host, guest, extra] = await Promise.all(["Host", "Guest", "Extra"].map((name) => manager.createSession(name)));
    const room = await manager.createRoom(host!, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2, maxPlayers: 2 });

    expect(room.seats).toHaveLength(2);
    const joined = await manager.joinRoom(room.code, guest!);
    expect(joined.ok).toBe(true);
    const full = await manager.joinRoom(room.code, extra!);
    expect(full).toMatchObject({ ok: false, code: "ROOM_FULL" });

    await manager.syncConnections(room.id, new Set([host!.userId, guest!.userId]));
    await manager.setReady(room.id, host!, true);
    const ready = await manager.setReady(room.id, guest!, true);

    expect(ready.ok).toBe(true);
    if (!ready.ok) throw new Error("ready failed");
    expect(ready.room.status).toBe("LOBBY");

    const started = await manager.startRoomByHost(room.code, host!);
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error("start failed");
    expect(started.room.status).toBe("IN_GAME");
    expect(started.room.game?.playerOrder).toEqual([host!.userId, guest!.userId]);
    expect(started.room.game?.config.maxPlayers).toBe(2);
  });

  it("starts four-seat lobbies with two ready connected players through host Go", async () => {
    const manager = new RoomManager();
    const host = await manager.createSession("Host");
    const guest = await manager.createSession("Guest");
    const room = await manager.createRoom(host, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2, maxPlayers: 4 });

    const joined = await manager.joinRoom(room.code, guest);
    expect(joined.ok).toBe(true);
    await manager.syncConnections(room.id, new Set([host.userId, guest.userId]));
    await manager.setReady(room.code, host, true);
    const ready = await manager.setReady(room.code, guest, true);
    expect(ready).toMatchObject({ ok: true, room: { status: "LOBBY" } });

    const started = await manager.startRoomByHost(room.code, host);

    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error("start failed");
    expect(started.room.status).toBe("IN_GAME");
    expect(started.room.seats).toHaveLength(4);
    expect(started.room.game?.playerOrder).toEqual([host.userId, guest.userId]);
    expect(started.room.game?.config.maxPlayers).toBe(2);
  });

  it("lets the host add and remove lobby bots as ready seats", async () => {
    const manager = new RoomManager();
    const host = await manager.createSession("Host");
    const guest = await manager.createSession("Guest");
    const outsider = await manager.createSession("Outsider");
    const room = await manager.createRoom(host, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2, maxPlayers: 4 });
    expect((await manager.joinRoom(room.code, guest)).ok).toBe(true);

    await expect(manager.addLobbyBot(room.code, outsider)).resolves.toMatchObject({ ok: false, code: "NOT_ROOM_HOST" });
    const firstBot = await manager.addLobbyBot(room.code, host);
    expect(firstBot.ok).toBe(true);
    if (!firstBot.ok) throw new Error("add bot failed");
    expect(firstBot.room.seats[2]).toMatchObject({ botId: "bot_3", ready: true, connected: true });

    const removed = await manager.removeLobbyBot(room.code, host, 2);
    expect(removed.ok).toBe(true);
    if (!removed.ok) throw new Error("remove bot failed");
    expect(removed.room.seats[2]).toMatchObject({ seatIndex: 2, ready: false, connected: false });
    expect(removed.room.seats[2]?.botId).toBeUndefined();

    const addedAgain = await manager.addLobbyBot(room.code, host);
    expect(addedAgain.ok).toBe(true);
    if (!addedAgain.ok) throw new Error("add bot failed");
    const secondBot = await manager.addLobbyBot(room.code, host);
    expect(secondBot.ok).toBe(true);
    if (!secondBot.ok) throw new Error("add bot failed");
    expect(secondBot.room.seats.filter((seat) => seat.botId)).toHaveLength(2);
    await expect(manager.addLobbyBot(room.code, host)).resolves.toMatchObject({ ok: false, code: "ROOM_FULL" });

    await manager.syncConnections(room.id, new Set([host.userId, guest.userId]));
    await manager.setReady(room.code, host, true);
    await manager.setReady(room.code, guest, true);
    const started = await manager.startRoomByHost(room.code, host);

    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error("start failed");
    expect(started.room.game?.playerOrder).toEqual([host.userId, guest.userId, "bot_3", "bot_4"]);
    expect(started.room.game?.config.maxPlayers).toBe(4);
  });

  it("ignores stale disconnected lobby seats when the ready connected minimum can start", async () => {
    const manager = new RoomManager();
    const host = await manager.createSession("Host");
    const guest = await manager.createSession("Guest");
    const stale = await manager.createSession("Stale");
    const room = await manager.createRoom(host, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2, maxPlayers: 4 });
    expect((await manager.joinRoom(room.code, guest)).ok).toBe(true);
    expect((await manager.joinRoom(room.code, stale)).ok).toBe(true);

    await manager.syncConnections(room.id, new Set([host.userId, guest.userId]));
    await manager.setReady(room.code, host, true);
    await manager.setReady(room.code, guest, true);
    const started = await manager.startRoomByHost(room.code, host);

    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error("start failed");
    expect(started.room.game?.playerOrder).toEqual([host.userId, guest.userId]);
    expect(started.room.game?.config.maxPlayers).toBe(2);
    expect(started.room.seats.some((seat) => seat.userId === stale.userId)).toBe(false);
  });

  it("does not start over connected unready lobby players", async () => {
    const manager = new RoomManager();
    const host = await manager.createSession("Host");
    const guest = await manager.createSession("Guest");
    const unready = await manager.createSession("Unready");
    const room = await manager.createRoom(host, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2, maxPlayers: 4 });
    expect((await manager.joinRoom(room.code, guest)).ok).toBe(true);
    expect((await manager.joinRoom(room.code, unready)).ok).toBe(true);
    await manager.syncConnections(room.id, new Set([host.userId, guest.userId, unready.userId]));
    await manager.setReady(room.code, host, true);
    await manager.setReady(room.code, guest, true);

    await expect(manager.startRoomByHost(room.code, host)).resolves.toMatchObject({ ok: false, code: "ROOM_NOT_READY" });
  });

  it("persists host starts through the match-start boundary without a second room write", async () => {
    const store = new CountingStartStore();
    const manager = new RoomManager(store);
    const host = await manager.createSession("Host");
    const guest = await manager.createSession("Guest");
    const room = await manager.createRoom(host, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2, maxPlayers: 4 });
    expect((await manager.joinRoom(room.code, guest)).ok).toBe(true);
    await manager.syncConnections(room.id, new Set([host.userId, guest.userId]));
    await manager.setReady(room.code, host, true);
    await manager.setReady(room.code, guest, true);
    const roomWritesBeforeStart = store.persistRoomCount;

    const started = await manager.startRoomByHost(room.code, host);

    expect(started.ok).toBe(true);
    expect(store.matchStartCount).toBe(1);
    expect(store.persistRoomCount).toBe(roomWritesBeforeStart);
    const persisted = await store.loadRoomByRef(room.code);
    expect(persisted?.status).toBe("IN_GAME");
    expect(persisted?.match).toBeDefined();
  });

  it("lets the host update lobby settings and resets readiness", async () => {
    const manager = new RoomManager();
    const host = await manager.createSession("Host");
    const guest = await manager.createSession("Guest");
    const room = await manager.createRoom(host, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2, maxPlayers: 4 });
    const joined = await manager.joinRoom(room.code, guest);
    expect(joined.ok).toBe(true);
    await manager.setReady(room.id, host, true);
    await manager.setReady(room.id, guest, true);

    const updated = await manager.updateRoomSettings(room.code, host, {
      minPlayers: 2,
      maxPlayers: 3,
      botDifficulty: "hard",
      rules: { mapPreset: "islands" },
    });

    expect(updated.ok).toBe(true);
    if (!updated.ok) throw new Error("settings update failed");
    expect(updated.room.seats).toHaveLength(3);
    expect(updated.room.seats.every((seat) => seat.ready === false)).toBe(true);
    expect(updated.room.settings).toMatchObject({
      minPlayers: 2,
      maxPlayers: 3,
      botDifficulty: "hard",
      rules: { mapPreset: "islands", mapRandomized: true },
    });
  });

  it("validates player-count boundaries and expands lobby seats deterministically", async () => {
    const manager = new RoomManager();
    const host = await manager.createSession("Host");
    const room = await manager.createRoom(host, {
      mode: "CLASSIC",
      botFill: false,
      ranked: false,
      minPlayers: 2,
      maxPlayers: 2,
    });

    await expect(manager.updateRoomSettings(room.code, host, { maxPlayers: 1 as 2 }))
      .resolves.toMatchObject({ ok: false, code: "INVALID_ROOM_SETTINGS" });
    await expect(manager.updateRoomSettings(room.code, host, { minPlayers: 5 as 2 }))
      .resolves.toMatchObject({ ok: false, code: "INVALID_ROOM_SETTINGS" });

    const expanded = await manager.updateRoomSettings(room.code, host, { maxPlayers: 4 });
    expect(expanded.ok).toBe(true);
    if (!expanded.ok) throw new Error("settings update failed");
    expect(expanded.room.seats).toEqual([
      expect.objectContaining({ seatIndex: 0, userId: host.userId }),
      { seatIndex: 1, ready: false, connected: false },
      { seatIndex: 2, ready: false, connected: false },
      { seatIndex: 3, ready: false, connected: false },
    ]);
  });

  it("preserves readiness when lobby settings do not effectively change", async () => {
    const manager = new RoomManager();
    const host = await manager.createSession("Host");
    const guest = await manager.createSession("Guest");
    const room = await manager.createRoom(host, {
      mode: "CLASSIC",
      botFill: false,
      ranked: false,
      minPlayers: 2,
      maxPlayers: 4,
      botDifficulty: "medium",
      rules: { mapPreset: "standard" },
    });
    expect((await manager.joinRoom(room.code, guest)).ok).toBe(true);
    await manager.setReady(room.code, host, true);
    await manager.setReady(room.code, guest, true);

    const updated = await manager.updateRoomSettings(room.code, host, {
      minPlayers: 2,
      maxPlayers: 4,
      botDifficulty: "medium",
      rules: { mapPreset: "standard", mapRandomized: true },
    });

    expect(updated.ok).toBe(true);
    if (!updated.ok) throw new Error("settings update failed");
    expect(updated.room.seats.find((seat) => seat.userId === host.userId)?.ready).toBe(true);
    expect(updated.room.seats.find((seat) => seat.userId === guest.userId)?.ready).toBe(true);
  });

  it("rejects non-host settings updates and shrinking below occupied seats", async () => {
    const manager = new RoomManager();
    const host = await manager.createSession("Host");
    const guest = await manager.createSession("Guest");
    const third = await manager.createSession("Third");
    const room = await manager.createRoom(host, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2, maxPlayers: 4 });
    expect((await manager.joinRoom(room.code, guest)).ok).toBe(true);
    expect((await manager.joinRoom(room.code, third)).ok).toBe(true);

    await expect(manager.updateRoomSettings(room.code, guest, { maxPlayers: 3 })).resolves.toMatchObject({ ok: false, code: "NOT_ROOM_HOST" });
    await expect(manager.updateRoomSettings(room.code, host, { maxPlayers: 2 })).resolves.toMatchObject({ ok: false, code: "ROOM_HAS_TOO_MANY_PLAYERS" });
  });

  it("does not silently drop occupied higher seats when closing seats", async () => {
    const manager = new RoomManager();
    const host = await manager.createSession("Host");
    const room = await manager.createRoom(host, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2, maxPlayers: 4 });
    expect((await manager.addLobbyBot(room.code, host)).ok).toBe(true);
    const added = await manager.addLobbyBot(room.code, host);
    expect(added.ok).toBe(true);
    if (!added.ok) throw new Error("add bot failed");
    expect(added.room.seats[2]?.botId).toBe("bot_3");
    const removedLowerBot = await manager.removeLobbyBot(room.code, host, 1);
    expect(removedLowerBot.ok).toBe(true);
    expect(room.seats.filter((seat) => seat.userId || seat.botId)).toHaveLength(2);

    await expect(manager.updateRoomSettings(room.code, host, { maxPlayers: 2 })).resolves.toMatchObject({
      ok: false,
      code: "ROOM_HAS_OCCUPIED_CLOSED_SEAT",
    });
    expect(room.seats[2]?.botId).toBe("bot_3");
  });

  it("uses updated lobby display names in seats and started games", async () => {
    const manager = new RoomManager();
    const host = await manager.createSession("Host");
    const guest = await manager.createSession("Guest");
    const room = await manager.createRoom(host, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2, maxPlayers: 4 });
    const joined = await manager.joinRoom(room.code, guest);
    expect(joined.ok).toBe(true);
    expect(room.seats.find((seat) => seat.userId === host.userId)?.displayName).toBe("Host");
    expect(room.seats.find((seat) => seat.userId === guest.userId)?.displayName).toBe("Guest");

    await manager.updateDisplayName(host, "Ada");
    await manager.updateDisplayName(guest, "Ben");
    expect(room.seats.find((seat) => seat.userId === host.userId)?.displayName).toBe("Ada");
    expect(room.seats.find((seat) => seat.userId === guest.userId)?.displayName).toBe("Ben");
    expect(manager.publicRoom(room, host.userId).seats).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: host.userId, displayName: "Ada" }),
      expect.objectContaining({ userId: guest.userId, displayName: "Ben" }),
    ]));

    await manager.syncConnections(room.id, new Set([host.userId, guest.userId]));
    await manager.setReady(room.code, host, true);
    await manager.setReady(room.code, guest, true);
    const started = await manager.startRoomByHost(room.code, host);

    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error("start failed");
    expect(started.room.game?.config.playerNames).toMatchObject({ [host.userId]: "Ada", [guest.userId]: "Ben" });
  });

  it("does not start a lobby with disconnected ready players", async () => {
    const manager = new RoomManager();
    const sessions = await Promise.all(["Host", "P2", "P3"].map((name) => manager.createSession(name)));
    const room = await manager.createRoom(sessions[0]!, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 3 });
    for (const session of sessions.slice(1)) {
      const joined = await manager.joinRoom(room.id, session);
      expect(joined.ok).toBe(true);
    }
    await manager.setReady(room.id, sessions[0]!, true);
    await manager.setReady(room.id, sessions[1]!, true);

    await manager.syncConnections(room.id, new Set([sessions[0]!.userId, sessions[2]!.userId]));
    const finalReady = await manager.setReady(room.id, sessions[2]!, true);

    expect(finalReady.ok).toBe(true);
    if (!finalReady.ok) throw new Error("ready failed");
    expect(finalReady.room.status).toBe("LOBBY");
    expect(finalReady.room.game).toBeUndefined();
    const disconnectedSeat = finalReady.room.seats.find((seat) => seat.userId === sessions[1]!.userId);
    expect(disconnectedSeat).toMatchObject({ ready: false, connected: false });
  });

  it("bot-fills and starts after ready", async () => {
    const { room } = await startedRoom();
    expect(room.status).toBe("IN_GAME");
    expect(room.game?.phase.type).toBe("SETUP_PLACEMENT");
    expect(room.seats.every((seat) => seat.userId || seat.botId)).toBe(true);
  });

  it("starts rooms with the selected map preset", async () => {
    const manager = new RoomManager();
    const session = await manager.createSession("Host");
    const room = await manager.createRoom(session, {
      mode: "CLASSIC",
      botFill: true,
      ranked: false,
      rules: { mapPreset: "islands", mapRandomized: true },
    });
    const ready = await manager.setReady(room.id, session, true);
    expect(ready.ok).toBe(true);
    if (!ready.ok || !ready.room.game) throw new Error("room did not start");
    expect(ready.room.game.config.rules?.mapPreset).toBe("islands");
    expect(boardHexComponentCount(ready.room.game.board)).toBe(2);
  });

  it("treats standard as a seeded preset even when legacy mapRandomized is false", async () => {
    const manager = new RoomManager();
    const session = await manager.createSession("Host");
    const room = await manager.createRoom(session, {
      mode: "CLASSIC",
      botFill: true,
      ranked: false,
      rules: { mapPreset: "standard", mapRandomized: false },
    });
    const ready = await manager.setReady(room.id, session, true);
    expect(ready.ok).toBe(true);
    if (!ready.ok || !ready.room.game) throw new Error("room did not start");
    expect(ready.room.game.config.rules).toMatchObject({ mapPreset: "standard", mapRandomized: true });
    expect(ready.room.game.board).toEqual(createSeededBoard(room.id, 2));
  });

  it("does not expose started rooms before durable match start finishes", async () => {
    const store = new DelayedMatchStartStore();
    const manager = new RoomManager(store);
    const sessions = await Promise.all(["Host", "P2", "P3", "P4"].map((name) => manager.createSession(name)));
    const host = sessions[0]!;
    const room = await manager.createRoom(host, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 4 });
    for (const session of sessions.slice(1)) {
      const joined = await manager.joinRoom(room.id, session);
      expect(joined.ok).toBe(true);
    }

    const readyResults = await Promise.all(sessions.map((session) => manager.setReady(room.id, session, true)));
    expect(readyResults.every((result) => result.ok)).toBe(true);
    const startPromise = manager.startRoomByHost(room.id, host);
    await store.startEntered;
    expect(room.status).toBe("LOBBY");
    expect(room.game).toBeUndefined();

    store.releaseMatchStart();
    const started = await startPromise;
    expect(started.ok).toBe(true);
    expect(room.status).toBe("IN_GAME");
    expect(room.game).toBeDefined();

    const activePlayerId = room.game?.phase.type === "SETUP_PLACEMENT" ? room.game.phase.activePlayerId : undefined;
    const activeSession = sessions.find((session) => session.userId === activePlayerId);
    if (!room.game || !activePlayerId || !activeSession) throw new Error("started room missing active human player");
    const vertexId = getLegalActions(room.game, activePlayerId).find((action) => action.type === "PLACE_SETUP")!.vertices[0]!;
    const result = await manager.submitCommand(room.id, activeSession, 1, {
      type: "PLACE_SETUP",
      playerId: activePlayerId,
      vertexId,
      edgeId: room.game.board.adjacency.vertexToEdges[vertexId]![0]!,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects command player mismatch", async () => {
    const { manager, session, room } = await startedRoom();
    const result = await manager.submitCommand(room.id, session, 1, { type: "ROLL_DICE", playerId: "bot_2" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("COMMAND_PLAYER_MISMATCH");
  });

  it("appends accepted events before exposing state", async () => {
    const { manager, session, room } = await startedRoom();
    const command: GameCommand = {
      type: "PLACE_SETUP",
      playerId: session.userId,
      vertexId: getLegalActions(room.game!, session.userId).find((action) => action.type === "PLACE_SETUP")!.vertices[0]!,
      edgeId: room.game!.board.adjacency.vertexToEdges[getLegalActions(room.game!, session.userId).find((action) => action.type === "PLACE_SETUP")!.vertices[0]!]![0]!,
    };
    const result = await manager.submitCommand(room.id, session, 1, command);
    expect(result.ok).toBe(true);
    expect(room.events.length).toBeGreaterThanOrEqual(1);
    expect(room.game?.eventSeq).toBe(room.events.at(-1)?.seq);
  });

  it("does not batch bot moves into a human command response", async () => {
    const { manager, session, room } = await startedRoom();
    const vertexId = getLegalActions(room.game!, session.userId).find((action) => action.type === "PLACE_SETUP")!.vertices[0]!;
    const result = await manager.submitCommand(room.id, session, 1, { type: "PLACE_SETUP", playerId: session.userId, vertexId, edgeId: room.game!.board.adjacency.vertexToEdges[vertexId]![0]! });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.events.filter((event) => event.type === "SETUP_PLACED")).toHaveLength(1);
      expect(result.state.phase).toMatchObject({ type: "SETUP_PLACEMENT", activePlayerId: "bot_2" });
    }
  });

  it("runs at most one bot automation action per tick", async () => {
    const { manager, session, room } = await startedRoom();
    const vertexId = getLegalActions(room.game!, session.userId).find((action) => action.type === "PLACE_SETUP")!.vertices[0]!;
    await manager.submitCommand(room.id, session, 1, { type: "PLACE_SETUP", playerId: session.userId, vertexId, edgeId: room.game!.board.adjacency.vertexToEdges[vertexId]![0]! });
    const result = await manager.runDueBotAutomation(room.id);
    expect(result?.ok).toBe(true);
    if (result?.ok) {
      expect(result.events.filter((event) => event.type === "SETUP_PLACED")).toHaveLength(1);
      expect(result.state.phase).toMatchObject({ type: "SETUP_PLACEMENT", activePlayerId: "bot_3" });
    }
  });

  it("skips bot acceptance when the offerer no longer has the offered cards", async () => {
    const { manager, session, room } = await startedRoom();
    room.game!.players.bot_2!.resources = { ...emptyResources(), ore: 1 };
    const trade: TradeOffer = {
      id: "unfunded",
      fromPlayerId: session.userId,
      offered: { timber: 5, brick: 5, grain: 5, fiber: 5, ore: 5 },
      requested: { ...emptyResources(), ore: 1 },
      recipients: "ANY",
      status: "OPEN",
      createdAtSeq: room.game!.eventSeq,
      expiresAtSeq: room.game!.eventSeq + 10,
    };
    room.game!.trades[trade.id] = trade;

    const result = await manager.runDueBotAutomation(room.id);
    expect(result).toBeUndefined();
    expect(room.game!.trades[trade.id]!.status).toBe("OPEN");
  });

  it("returns duplicate clientSeq idempotently", async () => {
    const { manager, session, room } = await startedRoom();
    const vertexId = getLegalActions(room.game!, session.userId).find((action) => action.type === "PLACE_SETUP")!.vertices[0]!;
    const command: GameCommand = { type: "PLACE_SETUP", playerId: session.userId, vertexId, edgeId: room.game!.board.adjacency.vertexToEdges[vertexId]![0]! };
    const first = await manager.submitCommand(room.id, session, 5, command);
    const second = await manager.submitCommand(room.id, session, 5, command);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.events).toEqual(first.events);
    expect(room.events.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects a reused clientSeq with a different command payload", async () => {
    const { manager, session, room } = await startedRoom();
    const vertexId = getLegalActions(room.game!, session.userId).find((action) => action.type === "PLACE_SETUP")!.vertices[0]!;
    const edgeId = room.game!.board.adjacency.vertexToEdges[vertexId]![0]!;
    const first = await manager.submitCommand(room.id, session, 9, { type: "PLACE_SETUP", playerId: session.userId, vertexId, edgeId });
    const second = await manager.submitCommand(room.id, session, 9, { type: "ROLL_DICE", playerId: session.userId });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("CLIENT_SEQ_CONFLICT");
  });

  it("persists rejected command results for lost-ack reconnects", async () => {
    const store = new MemoryEventStore();
    const { manager, session, room } = await startedRoom(store);
    const first = await manager.submitCommand(room.id, session, 12, { type: "ROLL_DICE", playerId: session.userId });
    const duplicate = await manager.submitCommand(room.id, session, 12, { type: "ROLL_DICE", playerId: session.userId });
    const stored = await store.loadCommandResult(room.id, session.userId, 12);

    expect(first.ok).toBe(false);
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.code).toBe("WRONG_PHASE");
    expect(stored).toMatchObject({ ok: false, rejectionCode: "WRONG_PHASE" });
  });

  it("does not leak private resources in viewer payloads", async () => {
    const { session, room } = await startedRoom();
    room.game!.players[session.userId]!.resources = { ...emptyResources(), timber: 4 };
    const own = serializeForViewer(room.game!, session.userId);
    const spectator = serializeForViewer(room.game!, "spectator");
    expect(own.players.find((player) => player.id === session.userId)?.resources?.timber).toBe(4);
    expect(spectator.players.find((player) => player.id === session.userId)?.resources).toBeUndefined();
  });

  it("redacts public room event history for spectators", async () => {
    const { manager, session, room } = await startedRoom();
    const vertexId = getLegalActions(room.game!, session.userId).find((action) => action.type === "PLACE_SETUP")!.vertices[0]!;
    await manager.submitCommand(room.id, session, 1, { type: "PLACE_SETUP", playerId: session.userId, vertexId, edgeId: room.game!.board.adjacency.vertexToEdges[vertexId]![0]! });

    const ownRoom = manager.publicRoom(room, session.userId);
    const spectatorRoom = manager.publicRoom(room, "spectator");
    const ownSetup = ownRoom.events.find((event) => event.type === "SETUP_PLACED");
    const spectatorSetup = spectatorRoom.events.find((event) => event.type === "SETUP_PLACED");

    expect(ownSetup).toMatchObject({ type: "SETUP_PLACED", startingResources: expect.objectContaining({}) });
    expect(spectatorSetup).toMatchObject({ type: "SETUP_PLACED", startingResources: {} });
  });

  it("resync returns contiguous events after last sequence", async () => {
    const { manager, session, room } = await startedRoom();
    const vertexId = getLegalActions(room.game!, session.userId).find((action) => action.type === "PLACE_SETUP")!.vertices[0]!;
    await manager.submitCommand(room.id, session, 1, { type: "PLACE_SETUP", playerId: session.userId, vertexId, edgeId: room.game!.board.adjacency.vertexToEdges[vertexId]![0]! });
    const resync = await manager.resync(room.id, session, 0);
    expect(resync?.events.length).toBeGreaterThanOrEqual(1);
    expect(resync?.snapshot?.eventSeq).toBe(room.game?.eventSeq);
  });

  it("hydrates active stored rooms by short code during join after restart", async () => {
    const store = new MemoryEventStore();
    const original = new RoomManager(store);
    const host = await original.createSession("Host");
    const guest = await original.createSession("Guest");
    const room = await original.createRoom(host, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 4 });

    const restarted = new RoomManager(store);
    const resolvedGuest = await restarted.resolveSession(guest.token);
    if (!resolvedGuest) throw new Error("guest session was not recovered");
    const joined = await restarted.joinRoom(room.code, resolvedGuest);

    expect(joined.ok).toBe(true);
    expect(restarted.roomForRef(room.id)?.id).toBe(room.id);
    expect(restarted.roomForRef(room.code)?.seats.some((seat) => seat.userId === guest.userId)).toBe(true);
  });

  it("joins and readies human lobbies by short room code", async () => {
    const manager = new RoomManager();
    const sessions = await Promise.all(["Host", "Guest 1", "Guest 2", "Guest 3"].map((name) => manager.createSession(name)));
    const room = await manager.createRoom(sessions[0]!, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 4 });

    for (const session of sessions.slice(1)) {
      const joined = await manager.joinRoom(room.code, session);
      expect(joined.ok).toBe(true);
    }
    for (const session of sessions) {
      const ready = await manager.setReady(room.code, session, true);
      expect(ready.ok).toBe(true);
    }

    expect(room.status).toBe("LOBBY");
    const started = await manager.startRoomByHost(room.code, sessions[0]!);
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error("start failed");
    expect(room.status).toBe("IN_GAME");
    expect(room.game?.playerOrder).toEqual(sessions.map((session) => session.userId));
  });

  it("keeps expired stored rooms closed during lazy room lookup", async () => {
    const store = new MemoryEventStore();
    const manager = new RoomManager(store, { emptyLobbyTtlMs: 1_000 });
    const session = await manager.createSession("Host");
    const room = await manager.createRoom(session, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 4 });
    await manager.syncConnections(room.id, new Set(), 1_000);
    await manager.cleanupRooms(2_100);

    const restarted = new RoomManager(store);
    const loaded = await restarted.ensureRoomLoadedByRef(room.code);
    const joined = await restarted.joinRoom(room.code, session);
    const ready = await restarted.setReady(room.code, session, true);

    expect(loaded?.status).toBe("EXPIRED");
    expect(restarted.roomForRef(room.id)).toBeUndefined();
    expect(joined).toMatchObject({ ok: false, code: "ROOM_EXPIRED" });
    expect(ready).toMatchObject({ ok: false, code: "ROOM_EXPIRED" });
  });

  it("expires sessions by default TTL in cached and recovered lookup paths", async () => {
    const store = new MemoryEventStore();
    const manager = new RoomManager(store);
    const session = await manager.createSession("Short Lived");
    session.expiresAt = new Date(Date.now() - 1).toISOString();

    expect(manager.getSession(session.token)).toBeUndefined();
    expect(await new RoomManager(store).resolveSession(session.token)).toBeUndefined();
  });

  it("sweeps every expired session from manager and store caches without token lookups", async () => {
    const store = new MemoryEventStore();
    const manager = new RoomManager(store, { sessionTtlMs: 1 });
    await Promise.all(Array.from({ length: 25 }, (_, index) => manager.createSession(`Guest ${index}`)));
    const afterExpiry = Math.max(...[...manager.sessions.values()].map((session) => Date.parse(session.expiresAt!))) + 1;

    await expect(manager.sweepExpiredSessions(afterExpiry)).resolves.toEqual({ cached: 25, persisted: 25 });
    expect(manager.sessions.size).toBe(0);
    expect(store.sessions.size).toBe(0);
  });

  it("reconstructs replay from stored events", async () => {
    const { manager, session, room } = await startedRoom();
    const vertexId = getLegalActions(room.game!, session.userId).find((action) => action.type === "PLACE_SETUP")!.vertices[0]!;
    await manager.submitCommand(room.id, session, 1, { type: "PLACE_SETUP", playerId: session.userId, vertexId, edgeId: room.game!.board.adjacency.vertexToEdges[vertexId]![0]! });
    const replayed = manager.reconstructReplay(room.id);
    expect(replayed?.eventSeq).toBe(room.game?.eventSeq);
  });

  it("hydrates persisted rooms and replays after a manager restart", async () => {
    const store = new MemoryEventStore();
    const { manager, session, room } = await startedRoom(store);
    const vertexId = getLegalActions(room.game!, session.userId).find((action) => action.type === "PLACE_SETUP")!.vertices[0]!;
    await manager.submitCommand(room.id, session, 1, { type: "PLACE_SETUP", playerId: session.userId, vertexId, edgeId: room.game!.board.adjacency.vertexToEdges[vertexId]![0]! });

    const restarted = new RoomManager(store);
    await restarted.hydrateFromStore();
    const recoveredRoom = restarted.rooms.get(room.id);
    const recoveredSession = restarted.getSession(session.token);
    const replayLog = await restarted.getReplayById(room.id);
    const history = await restarted.listMatchHistory();

    expect(recoveredRoom?.game?.eventSeq).toBe(room.game?.eventSeq);
    expect(recoveredRoom?.seats.some((seat) => seat.connected)).toBe(false);
    expect(recoveredSession?.userId).toBe(session.userId);
    const rejoined = recoveredSession ? await restarted.joinRoom(room.id, recoveredSession) : undefined;
    expect(rejoined?.ok).toBe(true);
    expect(replayLog?.events.length).toBeGreaterThan(0);
    expect(history[0]).toMatchObject({ id: `match_${room.id}`, roomId: room.id });
  });

  it("hydrates up to the configured active-room capacity by default", async () => {
    const store = new MemoryEventStore();
    const manager = new RoomManager(store, { maxActiveRooms: 60 });
    const session = await manager.createSession("Host");
    for (let index = 0; index < 51; index += 1) {
      await manager.createRoom(session, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2 });
    }

    const restarted = new RoomManager(store, { maxActiveRooms: 60 });

    expect(await restarted.hydrateFromStore()).toBe(51);
    expect(restarted.rooms.size).toBe(51);
  });

  it("rehydrates response deadlines for active staged trades", async () => {
    const store = new MemoryEventStore();
    const { session, room } = await startedRoom(store);
    if (!room.game) throw new Error("game not started");

    const trade: TradeOffer = {
      id: "hydrate-trade",
      fromPlayerId: session.userId,
      offered: { ...emptyResources(), timber: 1 },
      requested: { ...emptyResources(), ore: 1 },
      recipients: "ANY",
      status: "COLLECTING_RESPONSES",
      createdAtSeq: room.game.eventSeq,
      expiresAtSeq: room.game.eventSeq + 10,
      responses: Object.fromEntries(room.game.playerOrder
        .filter((playerId) => playerId !== session.userId)
        .map((playerId) => [playerId, { playerId, status: "PENDING" as const }])),
    };
    const event: GameEvent = {
      schemaVersion: room.game.schemaVersion,
      seq: room.game.eventSeq + 1,
      type: "TRADE_OFFERED",
      trade,
    };
    room.game.trades[trade.id] = trade;
    room.game.eventSeq = event.seq;
    room.events.push(event);
    room.tradeResponseDeadlines.set(trade.id, 12_345_678);
    await store.persistRoom(room);

    const restarted = new RoomManager(store);
    await restarted.hydrateFromStore();
    const recoveredRoom = restarted.rooms.get(room.id);
    if (!recoveredRoom?.game) throw new Error("room not recovered");

    const ownView = restarted.viewerState(recoveredRoom, recoveredRoom.game, session.userId);
    expect(ownView.tradeResponseDeadlines?.[trade.id]).toBe(12_345_678);
  });

  it("preserves persisted active timers when hydrating rooms", async () => {
    const store = new MemoryEventStore();
    const { room } = await startedRoom(store);
    if (!room.timer || !room.game || !("activePlayerId" in room.game.phase)) throw new Error("room did not start with an active timer");
    const persistedExpiresAt = Date.parse("2026-06-23T12:34:56.000Z");
    room.timer = { activePlayerId: room.game.phase.activePlayerId, expiresAt: persistedExpiresAt };
    await store.persistRoom(room);

    const restarted = new RoomManager(store);
    await restarted.hydrateFromStore();

    expect(restarted.rooms.get(room.id)?.timer).toEqual({
      activePlayerId: room.game.phase.activePlayerId,
      expiresAt: persistedExpiresAt,
    });
  });

  it("does not claim human-only pending trades as immediate automation work", async () => {
    const manager = new RoomManager();
    const sessions = await Promise.all(["Host", "P2", "P3", "P4"].map((name) => manager.createSession(name)));
    const room = await manager.createRoom(sessions[0]!, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 4 });
    for (const session of sessions.slice(1)) {
      const joined = await manager.joinRoom(room.id, session);
      expect(joined.ok).toBe(true);
    }
    for (const session of sessions) {
      const ready = await manager.setReady(room.id, session, true);
      expect(ready.ok).toBe(true);
    }
    const started = await manager.startRoomByHost(room.id, sessions[0]!);
    expect(started.ok).toBe(true);
    if (!room.game) throw new Error("game not started");
    room.game = withResources(room.game, sessions[0]!.userId, { timber: 2, brick: 0, grain: 0, fiber: 0, ore: 0 });
    room.game.phase = { type: "ACTION_PHASE", activePlayerId: sessions[0]!.userId };

    const offered = await manager.submitCommand(room.id, sessions[0]!, 1, {
      type: "OFFER_TRADE",
      playerId: sessions[0]!.userId,
      tradeId: "human-only-pending",
      offered: { ...emptyResources(), timber: 1 },
      requested: { ...emptyResources(), ore: 1 },
      recipients: "ANY",
    });

    expect(offered.ok).toBe(true);
    expect(manager.dueAutomationRoomIds(Date.now())).not.toContain(room.id);
  });

  it("resolves bot offers as soon as all recipients answer", async () => {
    const { manager, session, room } = await startedRoom();
    if (!room.game) throw new Error("game not started");
    const botOfferer = room.seats.find((seat) => seat.botId)?.botId;
    if (!botOfferer) throw new Error("missing bot seat");
    room.game = withResources(room.game, botOfferer, { timber: 2, brick: 0, grain: 0, fiber: 0, ore: 0 });
    room.game = withResources(room.game, session.userId, { timber: 0, brick: 0, grain: 0, fiber: 0, ore: 2 });
    room.game.phase = { type: "ACTION_PHASE", activePlayerId: botOfferer };
    const recipients = room.game.playerOrder.filter((playerId) => playerId !== botOfferer);
    const trade: TradeOffer = {
      id: "ready-bot-offer",
      fromPlayerId: botOfferer,
      offered: { ...emptyResources(), timber: 1 },
      requested: { ...emptyResources(), ore: 1 },
      recipients: "ANY",
      status: "COLLECTING_RESPONSES",
      createdAtSeq: room.game.eventSeq + 1,
      expiresAtSeq: room.game.eventSeq + 20,
      responses: Object.fromEntries(recipients.map((playerId) => [
        playerId,
        { playerId, status: playerId === session.userId ? "WANTS_ACCEPT" : "REJECTED", respondedAtSeq: room.game!.eventSeq + 2 },
      ])),
    };
    room.game.trades[trade.id] = trade;
    room.tradeResponseDeadlines.set(trade.id, Date.now() + 15_000);

    const result = await manager.runDueBotAutomation(room.id);

    expect(result?.ok).toBe(true);
    expect(result?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "TRADE_ACCEPTED", tradeId: trade.id, fromPlayerId: botOfferer, toPlayerId: session.userId }),
    ]));
    expect(room.game.trades[trade.id]?.status).toBe("ACCEPTED");
  });

  it("does not mutate room events when durable append fails", async () => {
    const { manager, session, room } = await startedRoom(new FailingAppendStore());
    const vertexId = getLegalActions(room.game!, session.userId).find((action) => action.type === "PLACE_SETUP")!.vertices[0]!;
    const result = await manager.submitCommand(room.id, session, 1, { type: "PLACE_SETUP", playerId: session.userId, vertexId, edgeId: room.game!.board.adjacency.vertexToEdges[vertexId]![0]! });
    expect(result.ok).toBe(false);
    expect(room.events).toHaveLength(0);
    expect(room.game?.eventSeq).toBe(0);
  });

  it("rolls back appended events when command-result persistence fails", async () => {
    const store = new FailingCommandResultStore();
    const { manager, session, room } = await startedRoom(store);
    const vertexId = getLegalActions(room.game!, session.userId).find((action) => action.type === "PLACE_SETUP")!.vertices[0]!;
    const result = await manager.submitCommand(room.id, session, 1, { type: "PLACE_SETUP", playerId: session.userId, vertexId, edgeId: room.game!.board.adjacency.vertexToEdges[vertexId]![0]! });
    const replayLog = await store.loadReplay(`match_${room.id}`);

    expect(result.ok).toBe(false);
    expect(room.events).toHaveLength(0);
    expect(room.game?.eventSeq).toBe(0);
    expect(replayLog?.events).toHaveLength(0);
    await expect(store.loadCommandResult(room.id, session.userId, 1)).resolves.toBeUndefined();
  });

  it("returns client sequence conflicts for accepted command-result conflicts", async () => {
    const store = new ConflictingCommandResultStore();
    const { manager, session, room } = await startedRoom(store);
    const vertexId = getLegalActions(room.game!, session.userId).find((action) => action.type === "PLACE_SETUP")!.vertices[0]!;
    const command: GameCommand = { type: "PLACE_SETUP", playerId: session.userId, vertexId, edgeId: room.game!.board.adjacency.vertexToEdges[vertexId]![0]! };

    const first = await manager.submitCommand(room.id, session, 1, command);
    const second = await manager.submitCommand(room.id, session, 1, command);

    expect(first).toMatchObject({ ok: false, code: "CLIENT_SEQ_CONFLICT" });
    expect(second).toMatchObject({ ok: false, code: "CLIENT_SEQ_CONFLICT" });
    expect(room.events).toHaveLength(0);
  });

  it("does not cache rejected commands when result persistence conflicts", async () => {
    const store = new ConflictingCommandResultStore();
    const { manager, session, room } = await startedRoom(store);
    const command: GameCommand = { type: "END_TURN", playerId: session.userId };

    const first = await manager.submitCommand(room.id, session, 1, command);
    const second = await manager.submitCommand(room.id, session, 1, command);

    expect(first).toMatchObject({ ok: false, code: "CLIENT_SEQ_CONFLICT" });
    expect(second).toMatchObject({ ok: false, code: "CLIENT_SEQ_CONFLICT" });
  });

  it("serializes concurrent commands for a room", async () => {
    const { manager, session, room } = await startedRoom();
    const vertexId = getLegalActions(room.game!, session.userId).find((action) => action.type === "PLACE_SETUP")!.vertices[0]!;
    const command: GameCommand = { type: "PLACE_SETUP", playerId: session.userId, vertexId, edgeId: room.game!.board.adjacency.vertexToEdges[vertexId]![0]! };

    const [first, second] = await Promise.all([
      manager.submitCommand(room.id, session, 1, command),
      manager.submitCommand(room.id, session, 2, command),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(room.events.map((event) => event.seq)).toEqual(room.events.map((_, index) => index + 1));
  });

  it("serializes concurrent commands across room ID and code aliases", async () => {
    const { manager, session, room } = await startedRoom();
    const placement = getLegalActions(room.game!, session.userId).find((action) => action.type === "PLACE_SETUP");
    const [firstVertex, secondVertex] = placement?.vertices ?? [];
    if (!firstVertex || !secondVertex) throw new Error("missing setup placements");

    const results = await Promise.all([
      manager.submitCommand(room.id, session, 1, { type: "PLACE_SETUP", playerId: session.userId, vertexId: firstVertex, edgeId: room.game!.board.adjacency.vertexToEdges[firstVertex]![0]! }),
      manager.submitCommand(room.code, session, 2, { type: "PLACE_SETUP", playerId: session.userId, vertexId: secondVertex, edgeId: room.game!.board.adjacency.vertexToEdges[secondVertex]![0]! }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(room.events.filter((event) => event.type === "SETUP_PLACED")).toHaveLength(1);
    expect(room.events.map((event) => event.seq)).toEqual(room.events.map((_, index) => index + 1));
  });

  it("applies expired timers as sequenced server actions", async () => {
    const { manager, room } = await startedRoom();
    room.timer = { activePlayerId: room.game!.phase.activePlayerId, expiresAt: Date.now() - 1 };

    const result = await manager.expireTurn(room.id);

    expect(result?.ok).toBe(true);
    if (result?.ok) expect(result.events[0]?.type).toBe("SETUP_PLACED");
    expect(room.events.map((event) => event.seq)).toEqual(room.events.map((_, index) => index + 1));
    expect(room.timer?.expiresAt).toBeGreaterThan(Date.now());
  });

  it("auto-discards a forced randomized bundle when a discard timer expires", async () => {
    const { manager, room } = await startedRoom();
    room.game = withResources(room.game!, room.game!.playerOrder[1]!, { timber: 3, brick: 2, grain: 2, fiber: 1, ore: 0 });
    const game = room.game!;
    const discarder = game.playerOrder[1]!;
    game.phase = { type: "DISCARDING", activePlayerId: discarder, rollerId: game.playerOrder[0]!, pending: { [discarder]: 4 }, submitted: {} };
    room.timer = { activePlayerId: discarder, expiresAt: Date.now() - 1 };

    const result = await manager.expireTurn(room.id);

    expect(result?.ok).toBe(true);
    if (!result?.ok) throw new Error("expected timer expiry to succeed");
    const event = result.events.find((candidate) => candidate.type === "RESOURCES_DISCARDED");
    expect(event).toMatchObject({ type: "RESOURCES_DISCARDED", playerId: discarder, forced: true });
    if (event?.type !== "RESOURCES_DISCARDED") throw new Error("expected discard event");
    expect(resourceCount(event.resources)).toBe(4);
    expect(resourceCount(room.game!.players[discarder]!.resources)).toBe(4);
    expect(room.game!.phase).toMatchObject({ type: "MOVING_THIEF", activePlayerId: game.playerOrder[0] });
  });

  it("does not extend the action timer for commands in the same active phase", async () => {
    const { manager, session, room } = await startedRoom();
    room.game = withResources(room.game!, session.userId, { timber: 0, brick: 0, grain: 0, fiber: 2, ore: 0 });
    room.game!.phase = { type: "ACTION_PHASE", activePlayerId: session.userId };
    room.game!.turn = 8;
    const expiresAt = Date.now() + 5_000;
    room.timer = { activePlayerId: session.userId, expiresAt };

    const result = await manager.submitCommand(room.id, session, 30, {
      type: "OFFER_TRADE",
      playerId: session.userId,
      tradeId: "same-phase-timer",
      offered: { ...emptyResources(), fiber: 1 },
      requested: { ...emptyResources(), ore: 1 },
      recipients: "ANY",
    });

    expect(result.ok).toBe(true);
    expect(room.timer?.expiresAt).toBe(expiresAt);
  });

  it("pauses empty in-progress rooms and resumes without shortening timers", async () => {
    const { manager, session, room } = await startedRoom();
    if (!room.timer) throw new Error("missing timer");
    room.timer.expiresAt = 10_000;
    room.tradeResponseDeadlines.set("trade_1", 12_000);

    await manager.syncConnections(room.id, new Set(), 5_000);
    expect(room.pausedAt).toBeDefined();
    expect(await manager.expireTurn(room.id, 20_000)).toBeUndefined();

    await manager.syncConnections(room.id, new Set([session.userId]), 8_000);
    expect(room.pausedAt).toBeUndefined();
    expect(room.emptySince).toBeUndefined();
    expect(room.timer.expiresAt).toBe(13_000);
    expect(room.tradeResponseDeadlines.get("trade_1")).toBe(15_000);
  });

  it("pauses stalled automation and keeps it from auto-resuming", async () => {
    const manager = new RoomManager(new MemoryEventStore(), { automationStallTickLimit: 0 });
    const session = await manager.createSession("Host");
    const room = await manager.createRoom(session, { mode: "CLASSIC", botFill: true, ranked: false });
    const ready = await manager.setReady(room.id, session, true);
    if (!ready.ok || !room.game) throw new Error("room did not start");
    const vertexId = getLegalActions(room.game, session.userId).find((action) => action.type === "PLACE_SETUP")!.vertices[0]!;
    const setup = await manager.submitCommand(room.id, session, 1, {
      type: "PLACE_SETUP",
      playerId: session.userId,
      vertexId,
      edgeId: room.game.board.adjacency.vertexToEdges[vertexId]![0]!,
    });
    expect(setup.ok).toBe(true);

    await manager.runDueBotAutomation(room.id);
    await manager.syncConnections(room.id, new Set([session.userId]), Date.now() + 1_000);

    expect(room.pausedAt).toBeDefined();
    expect(room.pauseReason).toBe("STALLED_AUTOMATION");
    expect(manager.livenessState(room)).toBe("STALLED");
    expect(room.pausedAt).toBeDefined();
  });

  it("pauses automation when per-minute command budget is exhausted", async () => {
    const manager = new RoomManager(new MemoryEventStore(), { maxAutomatedCommandsPerMinute: 0 });
    const session = await manager.createSession("Host");
    const room = await manager.createRoom(session, { mode: "CLASSIC", botFill: true, ranked: false });
    await manager.setReady(room.id, session, true);
    if (!room.game) throw new Error("room did not start");
    const vertexId = getLegalActions(room.game, session.userId).find((action) => action.type === "PLACE_SETUP")!.vertices[0]!;
    const setup = await manager.submitCommand(room.id, session, 1, {
      type: "PLACE_SETUP",
      playerId: session.userId,
      vertexId,
      edgeId: room.game.board.adjacency.vertexToEdges[vertexId]![0]!,
    });
    expect(setup.ok).toBe(true);

    await manager.runDueBotAutomation(room.id);

    expect(room.pauseReason).toBe("STALLED_AUTOMATION");
    expect(room.pausedAt).toBeDefined();
  });

  it("expires empty lobbies and unloads them from active memory", async () => {
    const store = new MemoryEventStore();
    const manager = new RoomManager(store, { emptyLobbyTtlMs: 1_000 });
    const session = await manager.createSession("Host");
    const room = await manager.createRoom(session, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 4 });

    await manager.syncConnections(room.id, new Set(), 1_000);
    const cleaned = await manager.cleanupRooms(2_100);
    const stored = await store.loadRoomByRef(room.code);

    expect(cleaned).toEqual([expect.objectContaining({ roomId: room.id, status: "EXPIRED", cleanupReason: "EMPTY_LOBBY_TTL" })]);
    expect(manager.roomForRef(room.id)).toBeUndefined();
    expect(manager.listRooms()).toHaveLength(0);
    expect(stored).toMatchObject({ id: room.id, status: "EXPIRED", cleanupReason: "EMPTY_LOBBY_TTL" });
  });

  it("abandons empty in-progress rooms but keeps replay history loadable", async () => {
    const store = new MemoryEventStore();
    const { manager, room } = await startedRoom(store);

    await manager.syncConnections(room.id, new Set(), 1_000);
    const cleaned = await manager.cleanupRooms(31 * 60 * 1000);
    const replayLog = await manager.getReplayById(room.id);
    const stored = await store.loadRoomByRef(room.code);

    expect(cleaned).toEqual([expect.objectContaining({ roomId: room.id, status: "ABANDONED", cleanupReason: "EMPTY_GAME_TTL" })]);
    expect(manager.roomForRef(room.id)).toBeUndefined();
    expect(replayLog?.config.matchId).toBe(`match_${room.id}`);
    expect(stored).toMatchObject({ id: room.id, status: "ABANDONED", cleanupReason: "EMPTY_GAME_TTL" });
  });

  it("stores chat and reports outside game events", async () => {
    const { manager, session, room } = await startedRoom();
    const chat = await manager.addChat(room.id, session, "hello table");
    const report = await manager.createReport(room.id, session, "bot_2", "test report");
    expect(chat?.message).toBe("hello table");
    expect(report?.status).toBe("OPEN");
    expect(room.events).toHaveLength(0);
  });

  it("rejects reports for identities that are not seated in the room", async () => {
    const { manager, session, room } = await startedRoom();

    await expect(manager.createReport(room.id, session, "u_not_in_room", "fabricated target")).resolves.toBeUndefined();
    expect(room.reports).toEqual([]);
  });

  it("retains only the newest bounded chat window in room state", async () => {
    const { manager, session, room } = await startedRoom();
    for (let index = 0; index < maxRoomChatMessages + 5; index += 1) {
      await manager.addChat(room.id, session, `message ${index}`);
    }

    expect(room.chat).toHaveLength(maxRoomChatMessages);
    expect(room.chat[0]?.message).toBe("message 5");
    expect(room.chat.at(-1)?.message).toBe(`message ${maxRoomChatMessages + 4}`);
    expect(manager.publicRoom(room, session.userId).chat).toHaveLength(maxRoomChatMessages);

    room.chat.unshift(...Array.from({ length: 5 }, (_, index) => ({
      id: `legacy_${index}`,
      userId: session.userId,
      message: `legacy ${index}`,
      createdAt: new Date(index).toISOString(),
    })));
    expect(manager.publicRoom(room, session.userId).chat?.[0]?.message).toBe("message 5");
  });

  it("keeps reports and event history out of public room summaries", async () => {
    const { manager, session, room } = await startedRoom();
    await manager.addChat(room.id, session, "hello table");
    await manager.createReport(room.id, session, "bot_2", "test report");

    const snapshot = manager.publicRoom(room, session.userId) as ReturnType<RoomManager["publicRoom"]> & { reports?: unknown };
    const summary = manager.listRooms()[0] as ReturnType<RoomManager["listRooms"]>[number] & {
      chat?: unknown;
      events?: unknown;
      game?: unknown;
      reports?: unknown;
    };

    expect(snapshot.chat).toHaveLength(1);
    expect(snapshot.reports).toBeUndefined();
    expect(summary.chat).toBeUndefined();
    expect(summary.events).toBeUndefined();
    expect(summary.game).toBeUndefined();
    expect(summary.reports).toBeUndefined();
  });

  it("validates room capacities and the all-bot test contract", async () => {
    const manager = new RoomManager();
    const session = await manager.createSession("Host");

    await expect(manager.createRoom(session, { mode: "CLASSIC", botFill: false, ranked: false, maxPlayers: 1 })).rejects.toThrow(/between 2 and 4/);
    await expect(manager.createRoom(session, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 4, maxPlayers: 2 })).rejects.toThrow(/cannot exceed/);
    await expect(manager.createAllBotRoomForTest({ mode: "CLASSIC", botFill: true, ranked: false }, ["a", "b"])).rejects.toThrow(/exactly four/);

    const room = await manager.createAllBotRoomForTest(
      { mode: "CLASSIC", botFill: true, ranked: false },
      ["alpha", "beta", "gamma", "delta"],
    );
    expect(room.status).toBe("IN_GAME");
    expect(room.hostUserId).toBe("alpha");
    expect(room.game?.playerOrder).toEqual(["alpha", "beta", "gamma", "delta"]);
  });

  it("returns stable lifecycle errors for every lobby mutation boundary", async () => {
    const manager = new RoomManager();
    const host = await manager.createSession("Host");
    const guest = await manager.createSession("Guest");
    const missing = "room_missing";

    await expect(manager.joinRoom(missing, guest)).resolves.toMatchObject({ ok: false, code: "ROOM_NOT_FOUND" });
    await expect(manager.setReady(missing, guest, true)).resolves.toMatchObject({ ok: false, code: "ROOM_NOT_FOUND" });
    await expect(manager.updateRoomSettings(missing, guest, { ranked: true })).resolves.toMatchObject({ ok: false, code: "ROOM_NOT_FOUND" });
    await expect(manager.addLobbyBot(missing, guest)).resolves.toMatchObject({ ok: false, code: "ROOM_NOT_FOUND" });
    await expect(manager.removeLobbyBot(missing, guest, 0)).resolves.toMatchObject({ ok: false, code: "ROOM_NOT_FOUND" });
    await expect(manager.startRoomByHost(missing, guest)).resolves.toMatchObject({ ok: false, code: "ROOM_NOT_FOUND" });
    await expect(manager.leaveRoom(missing, guest)).resolves.toMatchObject({ ok: false, code: "ROOM_NOT_FOUND" });
    await expect(manager.submitCommand(missing, guest, 1, { type: "ROLL_DICE", playerId: guest.userId })).resolves.toMatchObject({ ok: false, code: "ROOM_NOT_IN_GAME" });
    await expect(manager.syncConnections(missing, new Set())).resolves.toBeUndefined();

    const room = await manager.createRoom(host, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2, maxPlayers: 2 });
    await expect(manager.setReady(room.id, guest, true)).resolves.toMatchObject({ ok: false, code: "NOT_IN_ROOM" });
    await expect(manager.updateRoomSettings(room.id, guest, { ranked: true })).resolves.toMatchObject({ ok: false, code: "NOT_ROOM_HOST" });
    await expect(manager.addLobbyBot(room.id, guest)).resolves.toMatchObject({ ok: false, code: "NOT_ROOM_HOST" });
    await expect(manager.removeLobbyBot(room.id, guest, 1)).resolves.toMatchObject({ ok: false, code: "NOT_ROOM_HOST" });
    await expect(manager.startRoomByHost(room.id, guest)).resolves.toMatchObject({ ok: false, code: "NOT_ROOM_HOST" });
    await expect(manager.startRoomByHost(room.id, host)).resolves.toMatchObject({ ok: false, code: "ROOM_NOT_READY" });
    await expect(manager.removeLobbyBot(room.id, host, 1)).resolves.toMatchObject({ ok: false, code: "BOT_NOT_FOUND" });

    await expect(manager.joinRoom(room.id, guest)).resolves.toMatchObject({ ok: true });
    await expect(manager.addLobbyBot(room.id, host)).resolves.toMatchObject({ ok: false, code: "ROOM_FULL" });
    await expect(manager.setReady(room.id, host, true)).resolves.toMatchObject({ ok: true });
    await expect(manager.setReady(room.id, guest, true)).resolves.toMatchObject({ ok: true });
    await expect(manager.startRoomByHost(room.id, host)).resolves.toMatchObject({ ok: true });
    await expect(manager.setReady(room.id, host, false)).resolves.toMatchObject({ ok: false, code: "ROOM_ALREADY_STARTED" });
    await expect(manager.updateRoomSettings(room.id, host, { ranked: true })).resolves.toMatchObject({ ok: false, code: "ROOM_ALREADY_STARTED" });
    await expect(manager.addLobbyBot(room.id, host)).resolves.toMatchObject({ ok: false, code: "ROOM_ALREADY_STARTED" });
    await expect(manager.removeLobbyBot(room.id, host, 1)).resolves.toMatchObject({ ok: false, code: "ROOM_ALREADY_STARTED" });
    await expect(manager.startRoomByHost(room.id, host)).resolves.toMatchObject({ ok: false, code: "ROOM_ALREADY_STARTED" });
    await expect(manager.submitCommand(room.id, await manager.createSession("Outsider"), 1, { type: "ROLL_DICE", playerId: "outsider" })).resolves.toMatchObject({ ok: false, code: "NOT_IN_ROOM" });
  });

  it("shows trade deadlines only to the offerer and eligible recipients", async () => {
    const { manager, session, room } = await startedRoom();
    if (!room.game) throw new Error("expected game");
    const recipientId = room.game.playerOrder[1]!;
    const outsiderId = room.game.playerOrder[2]!;
    room.game.trades.private = {
      id: "private",
      fromPlayerId: session.userId,
      offered: { ...emptyResources(), timber: 1 },
      requested: { ...emptyResources(), grain: 1 },
      recipients: [recipientId],
      status: "COLLECTING_RESPONSES",
      createdAtSeq: room.game.eventSeq,
      expiresAtSeq: room.game.eventSeq + 10,
      responses: { [recipientId]: { playerId: recipientId, status: "PENDING" } },
    };
    room.tradeResponseDeadlines.set("private", 12_345);

    expect(manager.viewerState(room, room.game, session.userId).tradeResponseDeadlines).toEqual({ private: 12_345 });
    expect(manager.viewerState(room, room.game, recipientId).tradeResponseDeadlines).toEqual({ private: 12_345 });
    expect(manager.viewerState(room, room.game, outsiderId).tradeResponseDeadlines).toBeUndefined();
    expect(manager.viewerState(room, room.game, "spectator").tradeResponseDeadlines).toBeUndefined();
  });

  it("pauses an active game when its last human leaves and rejects archived leaves", async () => {
    const { manager, session, room } = await startedRoom();
    const left = await manager.leaveRoom(room.id, session, 5_000);
    expect(left).toMatchObject({ ok: true, room: { pausedAt: new Date(5_000).toISOString(), pauseReason: "EMPTY_ROOM", emptySince: new Date(5_000).toISOString() } });
    expect(manager.pauseReasonCounts().EMPTY_ROOM).toBe(1);

    room.status = "ABANDONED";
    room.archivedAt = new Date(6_000).toISOString();
    await expect(manager.leaveRoom(room.id, session, 7_000)).resolves.toMatchObject({ ok: false, code: "ROOM_CLOSED" });
  });

  it("clears recovered lobby emptiness and unloads finished rooms only after everyone disconnects", async () => {
    const manager = new RoomManager(undefined, { emptyLobbyTtlMs: 1_000, finishedRoomUnloadMs: 100 });
    const session = await manager.createSession("Host");
    const lobby = await manager.createRoom(session, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2 });

    await manager.syncConnections(lobby.id, new Set(), 1_000);
    expect(lobby.emptySince).toBe(new Date(1_000).toISOString());
    await manager.syncConnections(lobby.id, new Set([session.userId]), 1_100);
    expect(lobby.emptySince).toBeUndefined();

    lobby.status = "FINISHED";
    lobby.emptySince = new Date(1_000).toISOString();
    await manager.cleanupRooms(1_050, [lobby.id]);
    expect(lobby.emptySince).toBeUndefined();
    await manager.syncConnections(lobby.id, new Set(), 2_000);
    expect(lobby.emptySince).toBe(new Date(2_000).toISOString());
    const cleaned = await manager.cleanupRooms(2_101, [lobby.id]);
    expect(cleaned).toEqual([expect.objectContaining({ roomId: lobby.id, status: "FINISHED", cleanupReason: "FINISHED_UNLOADED" })]);
    expect(manager.roomForRef(lobby.id)).toBeUndefined();
  });

  it("supports the non-atomic legacy event-store fallback and reports unresolved sequence conflicts", async () => {
    const fallbackStore = new MemoryEventStore();
    Object.defineProperty(fallbackStore, "commitEvents", { value: undefined });
    const { manager, session, room } = await startedRoom(fallbackStore);
    if (!room.game || room.game.phase.type !== "SETUP_PLACEMENT") throw new Error("expected setup");
    const action = getLegalActions(room.game, session.userId).find((candidate) => candidate.type === "PLACE_SETUP");
    const vertexId = action?.vertices[0];
    const edgeId = vertexId ? room.game.board.adjacency.vertexToEdges[vertexId]?.[0] : undefined;
    if (!vertexId || !edgeId) throw new Error("expected legal placement");
    await expect(manager.submitCommand(room.id, session, 1, { type: "PLACE_SETUP", playerId: session.userId, vertexId, edgeId })).resolves.toMatchObject({ ok: true });

    const conflictStore = new EmptyConflictingCommandResultStore();
    const conflictRoom = await startedRoom(conflictStore);
    await expect(conflictRoom.manager.submitCommand(conflictRoom.room.id, conflictRoom.session, 1, { type: "ROLL_DICE", playerId: conflictRoom.session.userId })).resolves.toMatchObject({ ok: false, code: "CLIENT_SEQ_CONFLICT" });
  });

  it("expires modal trades before ending the turn and chooses a robber target on timeout", async () => {
    const { manager, session, room } = await startedRoom();
    if (!room.game) throw new Error("expected game");
    room.game = withResources(room.game, session.userId, { timber: 1 });
    room.game.phase = { type: "ACTION_PHASE", activePlayerId: session.userId };
    room.game.trades.timeout = {
      id: "timeout",
      fromPlayerId: session.userId,
      offered: { ...emptyResources(), timber: 1 },
      requested: { ...emptyResources(), grain: 1 },
      recipients: "ANY",
      status: "COLLECTING_RESPONSES",
      createdAtSeq: room.game.eventSeq,
      expiresAtSeq: room.game.eventSeq + 10,
    };
    room.timer = { activePlayerId: session.userId, expiresAt: 999 };
    const expired = await manager.expireTurn(room.id, 1_000);
    expect(expired).toMatchObject({ ok: true });
    if (!expired?.ok) throw new Error("expected trade expiry");
    expect(expired.events.map((event) => event.type)).toEqual(expect.arrayContaining(["TRADE_CLOSED", "TURN_ENDED"]));

    const robber = await startedRoom();
    if (!robber.room.game) throw new Error("expected robber game");
    const victimId = robber.room.game.playerOrder[1]!;
    robber.room.game = withResources(robber.room.game, victimId, { ore: 2 });
    robber.room.game.phase = { type: "MOVING_THIEF", activePlayerId: robber.session.userId, rollerId: robber.session.userId, reason: "ROLL_7" };
    robber.room.timer = { activePlayerId: robber.session.userId, expiresAt: 999 };
    const moved = await robber.manager.expireTurn(robber.room.id, 1_000);
    expect(moved).toMatchObject({ ok: true });
    if (!moved?.ok) throw new Error("expected robber move");
    expect(moved.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "THIEF_MOVED", playerId: robber.session.userId })]));
  });

  it("distinguishes missing, unfinished, and finished replay records", async () => {
    const { manager, room } = await startedRoom();
    await expect(manager.getFinishedReplayById("missing")).resolves.toEqual({ status: "missing" });
    await expect(manager.getFinishedReplayById(room.id)).resolves.toEqual({ status: "not_finished" });
    if (!room.game) throw new Error("expected game");
    room.events.push({ schemaVersion: room.game.schemaVersion, seq: room.game.eventSeq + 1, type: "GAME_OVER", winnerId: room.game.playerOrder[0]!, reason: "VICTORY_POINTS" });
    await expect(manager.getFinishedReplayById(room.id)).resolves.toMatchObject({ status: "finished", replay: { events: [expect.objectContaining({ type: "GAME_OVER" })] } });
  });
});
