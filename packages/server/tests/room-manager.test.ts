import { describe, expect, it } from "vitest";
import { emptyResources, getLegalActions, serializeForViewer, type GameCommand, type GameState, type TradeOffer } from "@colonizt/game-core";
import { MemoryEventStore, type EventStore } from "../src/event-store.js";
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

  it("rejects new rooms when active room capacity is reached", async () => {
    const manager = new RoomManager(new MemoryEventStore(), { maxActiveRooms: 1 });
    const first = await manager.createSession("First");
    const second = await manager.createSession("Second");
    await manager.createRoom(first, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 4 });
    await expect(manager.createRoom(second, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 4 })).rejects.toBeInstanceOf(RoomCapacityError);
  });

  it("bot-fills and starts after ready", async () => {
    const { room } = await startedRoom();
    expect(room.status).toBe("IN_GAME");
    expect(room.game?.phase.type).toBe("SETUP_PLACEMENT");
    expect(room.seats.every((seat) => seat.userId || seat.botId)).toBe(true);
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
    const resync = manager.resync(room.id, session, 0);
    expect(resync?.events.length).toBeGreaterThanOrEqual(1);
    expect(resync?.snapshot?.eventSeq).toBe(room.game?.eventSeq);
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
    await store.persistRoom(room);

    const restarted = new RoomManager(store);
    await restarted.hydrateFromStore();
    const recoveredRoom = restarted.rooms.get(room.id);
    if (!recoveredRoom?.game) throw new Error("room not recovered");

    const ownView = restarted.viewerState(recoveredRoom, recoveredRoom.game, session.userId);
    expect(ownView.tradeResponseDeadlines?.[trade.id]).toBeGreaterThan(Date.now());
  });

  it("does not mutate room events when durable append fails", async () => {
    const { manager, session, room } = await startedRoom(new FailingAppendStore());
    const vertexId = getLegalActions(room.game!, session.userId).find((action) => action.type === "PLACE_SETUP")!.vertices[0]!;
    const result = await manager.submitCommand(room.id, session, 1, { type: "PLACE_SETUP", playerId: session.userId, vertexId, edgeId: room.game!.board.adjacency.vertexToEdges[vertexId]![0]! });
    expect(result.ok).toBe(false);
    expect(room.events).toHaveLength(0);
    expect(room.game?.eventSeq).toBe(0);
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
