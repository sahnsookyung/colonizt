import { describe, expect, it } from "vitest";
import { emptyResources, getLegalActions, serializeForViewer, type GameCommand, type TradeOffer } from "@colonizt/game-core";
import { MemoryEventStore, type EventStore } from "../src/event-store.js";
import { RoomManager, type Room } from "../src/room-manager.js";
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

describe("RoomManager", () => {
  it("creates sessions and rooms", async () => {
    const manager = new RoomManager();
    const session = await manager.createSession("Soo");
    const room = await manager.createRoom(session, { mode: "CLASSIC", botFill: true, ranked: false });
    expect(manager.getSession(session.token)?.userId).toBe(session.userId);
    expect(room.seats[0]?.userId).toBe(session.userId);
  });

  it("bot-fills and starts after ready", async () => {
    const { room } = await startedRoom();
    expect(room.status).toBe("IN_GAME");
    expect(room.game?.phase.type).toBe("SETUP_PLACEMENT");
    expect(room.seats.every((seat) => seat.userId || seat.botId)).toBe(true);
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

  it("stores chat and reports outside game events", async () => {
    const { manager, session, room } = await startedRoom();
    const chat = await manager.addChat(room.id, session, "hello table");
    const report = await manager.createReport(room.id, session, "bot_2", "test report");
    expect(chat?.message).toBe("hello table");
    expect(report?.status).toBe("OPEN");
    expect(room.events).toHaveLength(0);
  });
});
