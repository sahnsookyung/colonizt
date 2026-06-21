import { describe, expect, it } from "vitest";
import { boardHexComponentCount, createSeededBoard, emptyResources, getLegalActions, serializeForViewer, type GameCommand, type GameState, type TradeOffer } from "@colonizt/game-core";
import { MemoryEventStore, type EventStore, type StoredCommandResult } from "../src/event-store.js";
import { MemoryRoomOwnershipStore } from "../src/ownership.js";
import { RoomCapacityError, RoomManager, type Room } from "../src/room-manager.js";
import type { GameEvent } from "@colonizt/game-core";

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

  it("persists new rooms before acquiring ownership leases", async () => {
    const store = new MemoryEventStore();
    const manager = new RoomManager(store, { ownershipStore: new PersistBeforeAcquireOwnershipStore(store) });
    const session = await manager.createSession("Host");

    const room = await manager.createRoom(session, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 4 });

    expect(room.id).toMatch(/^room_/);
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
    const recoveredGuest = await ownerB.resolveSession(guest.token);
    if (!recoveredGuest) throw new Error("guest session not recovered");

    const joined = await ownerB.joinRoom(room.code, recoveredGuest);

    expect(joined).toMatchObject({ ok: false, code: "ROOM_NOT_OWNED" });
    expect(ownerB.roomForRef(room.id)).toBeUndefined();
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

    const readyResultsPromise = Promise.all(sessions.map((session) => manager.setReady(room.id, session, true)));
    await store.startEntered;
    expect(room.status).toBe("LOBBY");
    expect(room.game).toBeUndefined();

    store.releaseMatchStart();
    const readyResults = await readyResultsPromise;
    expect(readyResults.some((result) => result.ok && result.room.status === "IN_GAME")).toBe(true);
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
    if (!room.game) throw new Error("game not started");
    room.game.phase = { type: "ACTION_PHASE", activePlayerId: sessions[0]!.userId };
    room.game.players[sessions[0]!.userId]!.resources = { ...emptyResources(), timber: 2 };

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

  it("applies expired timers as sequenced server actions", async () => {
    const { manager, room } = await startedRoom();
    room.timer = { activePlayerId: room.game!.phase.activePlayerId, expiresAt: Date.now() - 1 };

    const result = await manager.expireTurn(room.id);

    expect(result?.ok).toBe(true);
    if (result?.ok) expect(result.events[0]?.type).toBe("SETUP_PLACED");
    expect(room.events.map((event) => event.seq)).toEqual(room.events.map((_, index) => index + 1));
    expect(room.timer?.expiresAt).toBeGreaterThan(Date.now());
  });

  it("does not extend the action timer for commands in the same active phase", async () => {
    const { manager, session, room } = await startedRoom();
    room.game!.phase = { type: "ACTION_PHASE", activePlayerId: session.userId };
    room.game!.turn = 8;
    room.game!.players[session.userId]!.resources = { ...emptyResources(), fiber: 2 };
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
});
