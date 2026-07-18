import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { emptyResources, getLegalActions, type GameEvent, type TradeOffer, type ViewerState } from "@colonizt/game-core";
import { buildServer } from "../src/index.js";
import { createStructuredLogger, MetricsRegistry, type StructuredLogRecord } from "../src/observability.js";
import { MemoryPresenceStore } from "../src/presence.js";
import { RoomManager } from "../src/room-manager.js";
import type { AddressInfo } from "node:net";

const servers: Array<{ close: () => Promise<void> }> = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
  }
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

const waitForOpen = (socket: WebSocket): Promise<void> =>
  new Promise((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });

const waitForMessage = <T extends { type: string }>(socket: WebSocket, type: string): Promise<T> =>
  new Promise((resolve) => {
    const listener = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as T;
      if (message.type === type) {
        socket.off("message", listener);
        resolve(message);
      }
    };
    socket.on("message", listener);
  });

const waitForMessageWhere = <T extends { type: string }>(socket: WebSocket, type: string, predicate: (message: T) => boolean): Promise<T> =>
  new Promise((resolve) => {
    const listener = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as T;
      if (message.type === type && predicate(message)) {
        socket.off("message", listener);
        resolve(message);
      }
    };
    socket.on("message", listener);
  });

const waitForNoMessage = (socket: WebSocket, type: string, durationMs = 100): Promise<void> =>
  new Promise((resolve, reject) => {
    const listener = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as { type: string };
      if (message.type === type) {
        socket.off("message", listener);
        reject(new Error(`Unexpected ${type} message`));
      }
    };
    socket.on("message", listener);
    setTimeout(() => {
      socket.off("message", listener);
      resolve();
    }, durationMs);
  });

const waitForClose = (socket: WebSocket): Promise<{ code: number; reason: string }> =>
  new Promise((resolve) => {
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });

const waitUntil = async (predicate: () => boolean | Promise<boolean>, timeoutMs = 500): Promise<void> => {
  const startedAt = Date.now();
  while (!await predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

class DelayedJoinPresenceStore extends MemoryPresenceStore {
  activeJoins = 0;
  completedJoins = 0;
  maxConcurrentJoins = 0;

  constructor(private readonly delayMs = 40) {
    super();
  }

  override async joinRoom(...args: Parameters<MemoryPresenceStore["joinRoom"]>): Promise<void> {
    this.activeJoins += 1;
    this.maxConcurrentJoins = Math.max(this.maxConcurrentJoins, this.activeJoins);
    try {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      await super.joinRoom(...args);
      this.completedJoins += 1;
    } finally {
      this.activeJoins -= 1;
    }
  }
}

const wsBase = (app: { server: { address(): string | AddressInfo | null } }): string => {
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("No server address");
  return `ws://127.0.0.1:${address.port}`;
};

const issueTicket = async (
  app: { inject: (options: { method: string; url: string; headers?: Record<string, string> }) => Promise<{ statusCode: number; json(): { ticket: string } }> },
  token: string,
  headers: Record<string, string> = {},
): Promise<string> => {
  const response = await app.inject({ method: "POST", url: "/ws-tickets", headers: { "x-session-token": token, ...headers } });
  expect(response.statusCode).toBe(201);
  return response.json().ticket;
};

const openSocket = async (
  app: { inject: (options: { method: string; url: string; headers?: Record<string, string> }) => Promise<{ statusCode: number; json(): { ticket: string } }>; server: { address(): string | AddressInfo | null } },
  token: string,
  options: { origin?: string; forwardedFor?: string } = {},
): Promise<WebSocket> => {
  const ticketHeaders = options.forwardedFor ? { "x-forwarded-for": options.forwardedFor } : {};
  const ticket = await issueTicket(app, token, ticketHeaders);
  const socketHeaders = {
    ...(options.origin ? { origin: options.origin } : {}),
    ...(options.forwardedFor ? { "x-forwarded-for": options.forwardedFor } : {}),
  };
  const socket = new WebSocket(`${wsBase(app)}/ws?ticket=${ticket}`, Object.keys(socketHeaders).length > 0 ? { headers: socketHeaders } : undefined);
  sockets.push(socket);
  await waitForOpen(socket);
  return socket;
};

describe("WebSocket gateway", () => {
  it("enforces the session command burst budget before invoking room logic", async () => {
    const manager = new RoomManager();
    const host = await manager.createSession("Burst Host");
    const room = await manager.createRoom(host, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2 });
    const submit = vi.spyOn(manager, "submitCommand").mockResolvedValue({ ok: false, code: "ROOM_PAUSED", message: "paused" });
    const app = await buildServer({ manager });
    servers.push({ close: () => app.close() });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const firstSocket = await openSocket(app, host.token);
    const secondSocket = await openSocket(app, host.token);
    firstSocket.send(JSON.stringify({ type: "JOIN_ROOM", roomId: room.id }));
    secondSocket.send(JSON.stringify({ type: "JOIN_ROOM", roomId: room.id }));
    await waitForMessageWhere<{ type: "ROOM_STATE"; room: { id: string } }>(firstSocket, "ROOM_STATE", (message) => message.room.id === room.id);
    await waitForMessageWhere<{ type: "ROOM_STATE"; room: { id: string } }>(secondSocket, "ROOM_STATE", (message) => message.room.id === room.id);
    const rateLimited = waitForMessageWhere<{ type: "COMMAND_REJECTED"; code: string; clientSeq: number }>(
      secondSocket,
      "COMMAND_REJECTED",
      (message) => message.code === "RATE_LIMITED",
    );

    for (let clientSeq = 1; clientSeq <= 30; clientSeq += 1) {
      const socket = clientSeq <= 15 ? firstSocket : secondSocket;
      socket.send(JSON.stringify({
        type: "COMMAND",
        roomId: room.id,
        clientSeq,
        command: { type: "ROLL_DICE", playerId: host.userId },
      }));
    }
    secondSocket.send(JSON.stringify({
      type: "COMMAND",
      roomId: room.id,
      clientSeq: 31,
      command: { type: "ROLL_DICE", playerId: host.userId },
    }));

    await expect(rateLimited).resolves.toMatchObject({ code: "RATE_LIMITED", clientSeq: 31 });
    expect(submit).toHaveBeenCalledTimes(30);
  });

  it("rejects room actions until the socket has joined that exact room", async () => {
    const manager = new RoomManager();
    const host = await manager.createSession("Unjoined Host");
    const firstRoom = await manager.createRoom(host, { mode: "CLASSIC", botFill: true, ranked: false });
    const secondRoom = await manager.createRoom(host, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2 });
    const app = await buildServer({ manager });
    servers.push({ close: () => app.close() });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = await openSocket(app, host.token);

    const unjoined = waitForMessageWhere<{ type: "ERROR"; code: string }>(socket, "ERROR", (message) => message.code === "NOT_JOINED_ROOM");
    socket.send(JSON.stringify({ type: "READY", roomId: firstRoom.id, ready: true }));
    await expect(unjoined).resolves.toMatchObject({ code: "NOT_JOINED_ROOM" });
    expect(firstRoom.status).toBe("LOBBY");
    expect(firstRoom.seats[0]).toMatchObject({ ready: false, connected: false });

    socket.send(JSON.stringify({ type: "JOIN_ROOM", roomId: firstRoom.id }));
    await waitForMessageWhere<{ type: "ROOM_STATE"; room: { id: string } }>(socket, "ROOM_STATE", (message) => message.room.id === firstRoom.id);
    const wrongRoom = waitForMessageWhere<{ type: "ERROR"; code: string; roomId: string }>(socket, "ERROR", (message) => message.code === "NOT_JOINED_ROOM");
    socket.send(JSON.stringify({ type: "READY", roomId: secondRoom.id, ready: true }));
    await expect(wrongRoom).resolves.toMatchObject({ code: "NOT_JOINED_ROOM", roomId: secondRoom.id });
    expect(secondRoom.seats[0]).toMatchObject({ ready: false, connected: false });
  });

  it("translates asynchronous manager failures into stable gateway errors and rejects unsafe frames", async () => {
    const manager = new RoomManager();
    const host = await manager.createSession("Failure Host");
    const room = await manager.createRoom(host, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2 });
    const app = await buildServer({ manager });
    servers.push({ close: () => app.close() });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = await openSocket(app, host.token);
    socket.send(JSON.stringify({ type: "JOIN_ROOM", roomId: room.id }));
    await waitForMessageWhere<{ type: "ROOM_STATE"; room: { id: string } }>(socket, "ROOM_STATE", (message) => message.room.id === room.id);

    const expectError = async (message: unknown, code: string) => {
      const received = waitForMessageWhere<{ type: "ERROR" | "COMMAND_REJECTED"; code: string }>(socket, code === "COMMAND_FAILED" ? "COMMAND_REJECTED" : "ERROR", (candidate) => candidate.code === code);
      socket.send(JSON.stringify(message));
      await expect(received).resolves.toMatchObject({ code });
    };

    vi.spyOn(manager, "joinRoom").mockRejectedValueOnce(new Error("join persistence failed"));
    await expectError({ type: "JOIN_ROOM", roomId: room.id }, "JOIN_FAILED");

    vi.spyOn(manager, "leaveRoom").mockRejectedValueOnce(new Error("leave persistence failed"));
    await expectError({ type: "LEAVE_ROOM", roomId: room.id }, "LEAVE_FAILED");

    vi.spyOn(manager, "setReady").mockRejectedValueOnce(new Error("ready persistence failed"));
    await expectError({ type: "READY", roomId: room.id, ready: true }, "READY_FAILED");

    vi.spyOn(manager, "startRoomByHost").mockRejectedValueOnce(new Error("start persistence failed"));
    await expectError({ type: "START_ROOM", roomId: room.id }, "START_FAILED");

    vi.spyOn(manager, "addLobbyBot").mockRejectedValueOnce(new Error("bot add failed"));
    await expectError({ type: "ADD_BOT", roomId: room.id }, "ADD_BOT_FAILED");

    vi.spyOn(manager, "removeLobbyBot").mockRejectedValueOnce(new Error("bot remove failed"));
    await expectError({ type: "REMOVE_BOT", roomId: room.id, seatIndex: 1 }, "REMOVE_BOT_FAILED");

    vi.spyOn(manager, "updateRoomSettings").mockRejectedValueOnce(new Error("settings persistence failed"));
    await expectError({ type: "UPDATE_ROOM_SETTINGS", roomId: room.id, settings: { maxPlayers: 2, botDifficulty: "hard", rules: { diceDoubles: true } } }, "SETTINGS_FAILED");

    vi.spyOn(manager, "updateDisplayName").mockRejectedValueOnce(new Error("name persistence failed"));
    await expectError({ type: "UPDATE_DISPLAY_NAME", displayName: "Renamed" }, "NAME_FAILED");

    vi.spyOn(manager, "submitCommand").mockRejectedValueOnce(new Error("event commit failed"));
    await expectError({ type: "COMMAND", roomId: room.id, clientSeq: 1, command: { type: "ROLL_DICE", playerId: host.userId } }, "COMMAND_FAILED");

    vi.spyOn(manager, "addChat").mockRejectedValueOnce(new Error("chat persistence failed"));
    await expectError({ type: "CHAT", roomId: room.id, message: "hello" }, "CHAT_FAILED");

    vi.spyOn(manager, "resync").mockRejectedValueOnce(new Error("replay persistence failed"));
    await expectError({ type: "RESYNC", roomId: room.id, lastSeq: 0 }, "RESYNC_FAILED");

    await expectError({ type: "UNKNOWN_MESSAGE" }, "BAD_MESSAGE");

    const closed = waitForClose(socket);
    socket.send("x".repeat(32_001));
    await expect(closed).resolves.toMatchObject({ code: 1009 });
  });

  it("preserves domain rejection codes across every mutating gateway command", async () => {
    const manager = new RoomManager();
    const host = await manager.createSession("Rejected Host");
    const room = await manager.createRoom(host, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2 });
    const app = await buildServer({ manager });
    servers.push({ close: () => app.close() });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = await openSocket(app, host.token);
    socket.send(JSON.stringify({ type: "JOIN_ROOM", roomId: room.id }));
    await waitForMessageWhere<{ type: "ROOM_STATE"; room: { id: string } }>(socket, "ROOM_STATE", (message) => message.room.id === room.id);

    const expectError = async (message: unknown, code: string, type = "ERROR") => {
      const received = waitForMessageWhere<{ type: string; code: string }>(socket, type, (candidate) => candidate.code === code);
      socket.send(JSON.stringify(message));
      await expect(received).resolves.toMatchObject({ type, code });
    };
    const rejected = (code: string) => ({ ok: false as const, code, message: `${code} rejected` });

    vi.spyOn(manager, "joinRoom").mockResolvedValueOnce(rejected("ROOM_FULL"));
    await expectError({ type: "JOIN_ROOM", roomId: room.id }, "ROOM_FULL");
    vi.spyOn(manager, "leaveRoom").mockResolvedValueOnce(rejected("ROOM_CLOSED"));
    await expectError({ type: "LEAVE_ROOM", roomId: room.id }, "ROOM_CLOSED");
    vi.spyOn(manager, "setReady").mockResolvedValueOnce(rejected("NOT_IN_ROOM"));
    await expectError({ type: "READY", roomId: room.id, ready: true }, "NOT_IN_ROOM");
    vi.spyOn(manager, "startRoomByHost").mockResolvedValueOnce(rejected("NOT_ROOM_HOST"));
    await expectError({ type: "START_ROOM", roomId: room.id }, "NOT_ROOM_HOST");
    vi.spyOn(manager, "addLobbyBot").mockResolvedValueOnce(rejected("ROOM_FULL"));
    await expectError({ type: "ADD_BOT", roomId: room.id }, "ROOM_FULL");
    vi.spyOn(manager, "removeLobbyBot").mockResolvedValueOnce(rejected("BOT_NOT_FOUND"));
    await expectError({ type: "REMOVE_BOT", roomId: room.id, seatIndex: 1 }, "BOT_NOT_FOUND");
    vi.spyOn(manager, "updateRoomSettings").mockResolvedValueOnce(rejected("INVALID_ROOM_SETTINGS"));
    await expectError({ type: "UPDATE_ROOM_SETTINGS", roomId: room.id, settings: { maxPlayers: 2 } }, "INVALID_ROOM_SETTINGS");
    vi.spyOn(manager, "submitCommand").mockResolvedValueOnce(rejected("ROOM_PAUSED"));
    await expectError({ type: "COMMAND", roomId: room.id, clientSeq: 2, command: { type: "ROLL_DICE", playerId: host.userId } }, "ROOM_PAUSED", "COMMAND_REJECTED");
    vi.spyOn(manager, "addChat").mockResolvedValueOnce(undefined);
    await expectError({ type: "CHAT", roomId: room.id, message: "rejected" }, "CHAT_REJECTED");
    vi.spyOn(manager, "resync").mockResolvedValueOnce(undefined);
    await expectError({ type: "RESYNC", roomId: room.id, lastSeq: 0 }, "RESYNC_FAILED");
  });

  it("redacts trade history and snapshots in implicit spectator room state", async () => {
    const manager = new RoomManager();
    const host = await manager.createSession("Host");
    const spectator = await manager.createSession("Spectator");
    const room = await manager.createRoom(host, { mode: "CLASSIC", botFill: true, ranked: false });
    const ready = await manager.setReady(room.id, host, true);
    if (!ready.ok) throw new Error("Failed to start room");
    const trade: TradeOffer = {
      id: "trade_any",
      fromPlayerId: host.userId,
      offered: { ...emptyResources(), timber: 2 },
      requested: { ...emptyResources(), ore: 1 },
      recipients: "ANY",
      status: "OPEN",
      createdAtSeq: 0,
      expiresAtSeq: 12,
    };
    room.game!.trades[trade.id] = trade;
    room.events.push({
      schemaVersion: 1,
      seq: 1,
      type: "TRADE_OFFERED",
      trade,
    });

    const app = await buildServer({ manager });
    servers.push({ close: () => app.close() });
    await app.listen({ host: "127.0.0.1", port: 0 });

    const spectatorSocket = await openSocket(app, spectator.token);

    spectatorSocket.send(JSON.stringify({ type: "JOIN_ROOM", roomId: room.id }));
    const message = await waitForMessage<{ type: "ROOM_STATE"; room: { events: GameEvent[]; game?: ViewerState } }>(spectatorSocket, "ROOM_STATE");
    const tradeEvent = message.room.events.find((event) => event.type === "TRADE_OFFERED");
    expect(tradeEvent).toMatchObject({
      type: "TRADE_OFFERED",
      trade: { offered: emptyResources(), requested: emptyResources() },
    });
    expect(message.room.game?.viewerId).toBe("spectator");
    expect(message.room.game?.trades[0]).toMatchObject({ offered: emptyResources(), requested: emptyResources() });
  });

  it("broadcasts accepted command events to every joined room client with viewer-safe snapshots", async () => {
    const manager = new RoomManager();
    const host = await manager.createSession("Host");
    const spectator = await manager.createSession("Spectator");
    const room = await manager.createRoom(host, { mode: "CLASSIC", botFill: true, ranked: false });
    const ready = await manager.setReady(room.id, host, true);
    if (!ready.ok || !ready.room.game) throw new Error("Failed to start room");

    const app = await buildServer({ manager });
    servers.push({ close: () => app.close() });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const hostSocket = await openSocket(app, host.token);
    const spectatorSocket = await openSocket(app, spectator.token);

    hostSocket.send(JSON.stringify({ type: "JOIN_ROOM", roomId: room.id }));
    spectatorSocket.send(JSON.stringify({ type: "JOIN_ROOM", roomId: room.id, asSpectator: true }));
    await Promise.all([waitForMessage(hostSocket, "ROOM_STATE"), waitForMessage(spectatorSocket, "ROOM_STATE")]);

    const vertexId = getLegalActions(ready.room.game, host.userId).find((action) => action.type === "PLACE_SETUP")!.vertices[0]!;
    const edgeId = ready.room.game.board.adjacency.vertexToEdges[vertexId]![0]!;
    const hostEvents = waitForMessage<{ type: "EVENTS"; events: GameEvent[]; snapshot: { players: Array<{ id: string; resources?: unknown }> } }>(hostSocket, "EVENTS");
    const spectatorEvents = waitForMessage<{ type: "EVENTS"; events: GameEvent[]; snapshot: { players: Array<{ id: string; resources?: unknown }> } }>(spectatorSocket, "EVENTS");
    hostSocket.send(JSON.stringify({
      type: "COMMAND",
      roomId: room.id,
      clientSeq: 1,
      command: { type: "PLACE_SETUP", playerId: host.userId, vertexId, edgeId },
    }));

    const [hostMessage, spectatorMessage] = await Promise.all([hostEvents, spectatorEvents]);
    expect(hostMessage.events[0]).toMatchObject({ type: "SETUP_PLACED", startingResources: expect.objectContaining({}) });
    expect(spectatorMessage.events[0]).toMatchObject({ type: "SETUP_PLACED", startingResources: {} });
    expect(hostMessage.snapshot.players.find((player) => player.id === host.userId)?.resources).toBeDefined();
    expect(spectatorMessage.snapshot.players.find((player) => player.id === host.userId)?.resources).toBeUndefined();
  });

  it("allows websocket joins by short room code and broadcasts on the canonical room id", async () => {
    const manager = new RoomManager();
    const host = await manager.createSession("Host");
    const room = await manager.createRoom(host, { mode: "CLASSIC", botFill: true, ranked: false });
    const ready = await manager.setReady(room.id, host, true);
    if (!ready.ok || !ready.room.game) throw new Error("Failed to start room");
    const app = await buildServer({ manager });
    servers.push({ close: () => app.close() });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const hostSocket = await openSocket(app, host.token);

    hostSocket.send(JSON.stringify({ type: "JOIN_ROOM", roomId: room.code }));
    const joined = await waitForMessage<{ type: "ROOM_STATE"; room: { id: string; code: string } }>(hostSocket, "ROOM_STATE");
    expect(joined.room).toMatchObject({ id: room.id, code: room.code });

    const vertexId = getLegalActions(ready.room.game, host.userId).find((action) => action.type === "PLACE_SETUP")!.vertices[0]!;
    const edgeId = ready.room.game.board.adjacency.vertexToEdges[vertexId]![0]!;
    const events = waitForMessage<{ type: "EVENTS"; roomId: string; events: GameEvent[]; timer?: { activePlayerId: string; expiresAt: number } }>(hostSocket, "EVENTS");
    hostSocket.send(JSON.stringify({
      type: "COMMAND",
      roomId: room.code,
      clientSeq: 1,
      command: { type: "PLACE_SETUP", playerId: host.userId, vertexId, edgeId },
    }));

    const message = await events;
    expect(message.roomId).toBe(room.id);
    expect(message.events[0]).toMatchObject({ type: "SETUP_PLACED" });
    expect(message.timer).toMatchObject({ activePlayerId: expect.any(String), expiresAt: expect.any(Number) });
  });

  it("removes a socket's presence from its previous room when switching rooms", async () => {
    const manager = new RoomManager();
    const host = await manager.createSession("Host");
    const firstRoom = await manager.createRoom(host, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2 });
    const secondRoom = await manager.createRoom(host, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2 });
    const app = await buildServer({ manager });
    servers.push({ close: () => app.close() });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = await openSocket(app, host.token);

    socket.send(JSON.stringify({ type: "JOIN_ROOM", roomId: firstRoom.code }));
    await waitForMessageWhere<{ type: "ROOM_STATE"; room: { id: string } }>(socket, "ROOM_STATE", (message) => message.room.id === firstRoom.id);
    socket.send(JSON.stringify({ type: "JOIN_ROOM", roomId: secondRoom.code }));
    await waitForMessageWhere<{ type: "ROOM_STATE"; room: { id: string } }>(socket, "ROOM_STATE", (message) => message.room.id === secondRoom.id);
    await waitUntil(() => !firstRoom.seats.some((seat) => seat.userId === host.userId));

    expect(firstRoom.seats.some((seat) => seat.userId === host.userId)).toBe(false);
    expect(secondRoom.seats.find((seat) => seat.userId === host.userId)).toMatchObject({ connected: true });
  });

  it("serializes delayed presence updates while switching rooms", async () => {
    const manager = new RoomManager();
    const host = await manager.createSession("Serialized Host");
    const firstRoom = await manager.createRoom(host, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2 });
    const secondRoom = await manager.createRoom(host, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2 });
    const presence = new DelayedJoinPresenceStore();
    const app = await buildServer({ manager, presenceStore: presence });
    servers.push({ close: () => app.close() });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = await openSocket(app, host.token);

    socket.send(JSON.stringify({ type: "JOIN_ROOM", roomId: firstRoom.code }));
    await waitForMessageWhere<{ type: "ROOM_STATE"; room: { id: string } }>(socket, "ROOM_STATE", (message) => message.room.id === firstRoom.id);
    socket.send(JSON.stringify({ type: "JOIN_ROOM", roomId: secondRoom.code }));
    await waitForMessageWhere<{ type: "ROOM_STATE"; room: { id: string } }>(socket, "ROOM_STATE", (message) => message.room.id === secondRoom.id);
    await waitUntil(() => presence.completedJoins === 2, 1_000);

    expect(presence.maxConcurrentJoins).toBe(1);
    expect(await presence.roomUserIds(firstRoom.id)).not.toContain(host.userId);
    expect(await presence.roomUserIds(secondRoom.id)).toContain(host.userId);
  });

  it("preserves wire order when a command follows a delayed room join", async () => {
    const manager = new RoomManager();
    const host = await manager.createSession("Ordering Host");
    const guest = await manager.createSession("Ordering Guest");
    const room = await manager.createRoom(host, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2 });
    const joinRoom = manager.joinRoom.bind(manager);
    vi.spyOn(manager, "joinRoom").mockImplementationOnce(async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return joinRoom(...args);
    });
    const app = await buildServer({ manager });
    servers.push({ close: () => app.close() });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = await openSocket(app, guest.token);
    const readyState = waitForMessageWhere<{
      type: "ROOM_STATE";
      room: { seats: Array<{ userId?: string; ready: boolean }> };
    }>(socket, "ROOM_STATE", (message) => message.room.seats.some((seat) => seat.userId === guest.userId && seat.ready));

    socket.send(JSON.stringify({ type: "JOIN_ROOM", roomId: room.code }));
    socket.send(JSON.stringify({ type: "READY", roomId: room.code, ready: true }));

    const update = await readyState;
    expect(update.room.seats).toContainEqual(expect.objectContaining({ userId: guest.userId, ready: true }));
  });

  it("finishes a delayed join before close cleanup so presence cannot be recreated", async () => {
    const manager = new RoomManager();
    const host = await manager.createSession("Closing Host");
    const room = await manager.createRoom(host, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2 });
    const presence = new DelayedJoinPresenceStore();
    const app = await buildServer({ manager, presenceStore: presence });
    servers.push({ close: () => app.close() });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = await openSocket(app, host.token);

    socket.send(JSON.stringify({ type: "JOIN_ROOM", roomId: room.code }));
    await waitForMessageWhere<{ type: "ROOM_STATE"; room: { id: string } }>(socket, "ROOM_STATE", (message) => message.room.id === room.id);
    const closed = waitForClose(socket);
    socket.close();
    await closed;
    await waitUntil(() => presence.completedJoins === 1, 1_000);
    await waitUntil(async () => !(await presence.roomUserIds(room.id)).has(host.userId), 1_000);
    await waitUntil(() => room.seats.find((seat) => seat.userId === host.userId)?.connected === false, 1_000);

    expect(await presence.roomUserIds(room.id)).not.toContain(host.userId);
    expect(room.seats.find((seat) => seat.userId === host.userId)).toMatchObject({ connected: false });
  });

  it("resyncs lobby rooms by short code without surfacing RESYNC_FAILED", async () => {
    const manager = new RoomManager();
    const host = await manager.createSession("Host");
    const room = await manager.createRoom(host, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 4 });
    const app = await buildServer({ manager });
    servers.push({ close: () => app.close() });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = await openSocket(app, host.token, { forwardedFor: "203.0.113.10" });

    socket.send(JSON.stringify({ type: "JOIN_ROOM", roomId: room.code }));
    const joined = await waitForMessage<{ type: "ROOM_STATE"; room: { id: string; status: string; game?: ViewerState } }>(socket, "ROOM_STATE");
    expect(joined.room).toMatchObject({ id: room.id, status: "LOBBY" });
    expect(joined.room.game).toBeUndefined();

    socket.send(JSON.stringify({ type: "RESYNC", roomId: room.code, lastSeq: 0 }));
    const resync = await waitForMessage<{ type: "RESYNC"; roomId: string; events: GameEvent[]; snapshot?: ViewerState }>(socket, "RESYNC");
    expect(resync).toMatchObject({ roomId: room.id, events: [] });
    expect(resync.snapshot).toBeUndefined();
  });

  it("leaves lobby rooms by short code and broadcasts the open seat", async () => {
    const manager = new RoomManager();
    const host = await manager.createSession("Host");
    const guest = await manager.createSession("Guest");
    const room = await manager.createRoom(host, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2 });
    const app = await buildServer({ manager });
    servers.push({ close: () => app.close() });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const hostSocket = await openSocket(app, host.token, { forwardedFor: "203.0.113.21" });
    const guestSocket = await openSocket(app, guest.token, { forwardedFor: "198.51.100.31" });

    hostSocket.send(JSON.stringify({ type: "JOIN_ROOM", roomId: room.code }));
    guestSocket.send(JSON.stringify({ type: "JOIN_ROOM", roomId: room.code }));
    await Promise.all([
      waitForMessageWhere<{ type: "ROOM_STATE"; room: { id: string; seats: Array<{ userId?: string }> } }>(hostSocket, "ROOM_STATE", (message) => message.room.seats.some((seat) => seat.userId === guest.userId)),
      waitForMessageWhere<{ type: "ROOM_STATE"; room: { id: string; seats: Array<{ userId?: string }> } }>(guestSocket, "ROOM_STATE", (message) => message.room.seats.some((seat) => seat.userId === guest.userId)),
    ]);

    const left = waitForMessage<{ type: "ROOM_LEFT"; roomId: string }>(guestSocket, "ROOM_LEFT");
    const hostUpdate = waitForMessageWhere<{ type: "ROOM_STATE"; room: { id: string; seats: Array<{ userId?: string; ready: boolean; connected: boolean }> } }>(
      hostSocket,
      "ROOM_STATE",
      (message) => !message.room.seats.some((seat) => seat.userId === guest.userId),
    );
    guestSocket.send(JSON.stringify({ type: "LEAVE_ROOM", roomId: room.code }));

    await expect(left).resolves.toMatchObject({ roomId: room.id });
    const update = await hostUpdate;
    expect(update.room.seats.some((seat) => seat.userId === guest.userId)).toBe(false);
    expect(manager.roomForRef(room.id)?.seats.some((seat) => seat.userId === guest.userId)).toBe(false);
  });

  it("updates lobby names and settings, then starts by host Go from two ready players", async () => {
    const manager = new RoomManager();
    const host = await manager.createSession("Host");
    const guest = await manager.createSession("Guest");
    const room = await manager.createRoom(host, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2, maxPlayers: 4 });
    const app = await buildServer({ manager });
    servers.push({ close: () => app.close() });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const hostSocket = await openSocket(app, host.token, { forwardedFor: "203.0.113.61" });
    const guestSocket = await openSocket(app, guest.token, { forwardedFor: "198.51.100.71" });

    hostSocket.send(JSON.stringify({ type: "JOIN_ROOM", roomId: room.code }));
    guestSocket.send(JSON.stringify({ type: "JOIN_ROOM", roomId: room.code }));
    await Promise.all([
      waitForMessageWhere<{ type: "ROOM_STATE"; room: { id: string; seats: Array<{ userId?: string }> } }>(
        hostSocket,
        "ROOM_STATE",
        (message) => message.room.id === room.id && message.room.seats.some((seat) => seat.userId === guest.userId),
      ),
      waitForMessageWhere<{ type: "ROOM_STATE"; room: { id: string; seats: Array<{ userId?: string }> } }>(
        guestSocket,
        "ROOM_STATE",
        (message) => message.room.id === room.id && message.room.seats.some((seat) => seat.userId === guest.userId),
      ),
    ]);

    hostSocket.send(JSON.stringify({ type: "UPDATE_DISPLAY_NAME", displayName: "Captain Host" }));
    const named = await waitForMessageWhere<{ type: "ROOM_STATE"; room: { seats: Array<{ userId?: string; displayName?: string }> } }>(
      guestSocket,
      "ROOM_STATE",
      (message) => message.room.seats.some((seat) => seat.userId === host.userId && seat.displayName === "Captain Host"),
    );
    expect(named.room.seats).toEqual(expect.arrayContaining([expect.objectContaining({ userId: host.userId, displayName: "Captain Host" })]));

    hostSocket.send(JSON.stringify({
      type: "UPDATE_ROOM_SETTINGS",
      roomId: room.code,
      settings: { minPlayers: 2, maxPlayers: 3, botDifficulty: "hard", rules: { mapPreset: "continent" } },
    }));
    const settingsUpdate = await waitForMessageWhere<{
      type: "ROOM_STATE";
      room: {
        settings: { minPlayers?: number; maxPlayers?: number; botDifficulty?: string; rules?: { mapPreset?: string; mapRandomized?: boolean } };
        seats: Array<{ ready: boolean }>;
      };
    }>(
      hostSocket,
      "ROOM_STATE",
      (message) => message.room.settings.maxPlayers === 3 && message.room.settings.rules?.mapPreset === "continent",
    );
    expect(settingsUpdate.room.settings).toMatchObject({
      minPlayers: 2,
      maxPlayers: 3,
      botDifficulty: "hard",
      rules: { mapPreset: "continent", mapRandomized: true },
    });
    expect(settingsUpdate.room.seats.every((seat) => seat.ready === false)).toBe(true);

    hostSocket.send(JSON.stringify({ type: "READY", roomId: room.code, ready: true }));
    guestSocket.send(JSON.stringify({ type: "READY", roomId: room.code, ready: true }));
    await waitForMessageWhere<{ type: "ROOM_STATE"; room: { status: string; seats: Array<{ userId?: string; ready: boolean }> } }>(
      hostSocket,
      "ROOM_STATE",
      (message) => message.room.status === "LOBBY"
        && message.room.seats.some((seat) => seat.userId === host.userId && seat.ready)
        && message.room.seats.some((seat) => seat.userId === guest.userId && seat.ready),
    );

    hostSocket.send(JSON.stringify({ type: "START_ROOM", roomId: room.code }));
    const started = await waitForMessageWhere<{ type: "ROOM_STATE"; room: { status: string; game?: ViewerState } }>(
      guestSocket,
      "ROOM_STATE",
      (message) => message.room.status === "IN_GAME" && Boolean(message.room.game),
    );

    expect(started.room.status).toBe("IN_GAME");
    expect(manager.roomForRef(room.id)?.game?.playerOrder).toEqual([host.userId, guest.userId]);
    expect(manager.roomForRef(room.id)?.game?.config.playerNames).toMatchObject({ [host.userId]: "Captain Host" });
  });

  it("adds and removes lobby bots by room code before starting a mixed game", async () => {
    const manager = new RoomManager();
    const host = await manager.createSession("Host");
    const guest = await manager.createSession("Guest");
    const room = await manager.createRoom(host, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2, maxPlayers: 4 });
    const app = await buildServer({ manager });
    servers.push({ close: () => app.close() });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const hostSocket = await openSocket(app, host.token, { forwardedFor: "203.0.113.62" });
    const guestSocket = await openSocket(app, guest.token, { forwardedFor: "198.51.100.72" });

    hostSocket.send(JSON.stringify({ type: "JOIN_ROOM", roomId: room.code }));
    guestSocket.send(JSON.stringify({ type: "JOIN_ROOM", roomId: room.code }));
    await Promise.all([
      waitForMessageWhere<{ type: "ROOM_STATE"; room: { id: string; seats: Array<{ userId?: string }> } }>(
        hostSocket,
        "ROOM_STATE",
        (message) => message.room.id === room.id && message.room.seats.some((seat) => seat.userId === guest.userId),
      ),
      waitForMessageWhere<{ type: "ROOM_STATE"; room: { id: string; seats: Array<{ userId?: string }> } }>(
        guestSocket,
        "ROOM_STATE",
        (message) => message.room.id === room.id && message.room.seats.some((seat) => seat.userId === guest.userId),
      ),
    ]);

    hostSocket.send(JSON.stringify({ type: "ADD_BOT", roomId: room.code }));
    const botAdded = await waitForMessageWhere<{ type: "ROOM_STATE"; room: { seats: Array<{ botId?: string; ready: boolean; connected: boolean }> } }>(
      guestSocket,
      "ROOM_STATE",
      (message) => message.room.seats.some((seat) => seat.botId === "bot_3"),
    );
    expect(botAdded.room.seats).toEqual(expect.arrayContaining([expect.objectContaining({ botId: "bot_3", ready: true, connected: true })]));

    hostSocket.send(JSON.stringify({ type: "REMOVE_BOT", roomId: room.code, seatIndex: 2 }));
    await waitForMessageWhere<{ type: "ROOM_STATE"; room: { seats: Array<{ botId?: string }> } }>(
      guestSocket,
      "ROOM_STATE",
      (message) => !message.room.seats.some((seat) => seat.botId === "bot_3"),
    );

    hostSocket.send(JSON.stringify({ type: "ADD_BOT", roomId: room.code }));
    await waitForMessageWhere<{ type: "ROOM_STATE"; room: { seats: Array<{ botId?: string }> } }>(
      hostSocket,
      "ROOM_STATE",
      (message) => message.room.seats.some((seat) => seat.botId === "bot_3"),
    );
    hostSocket.send(JSON.stringify({ type: "ADD_BOT", roomId: room.code }));
    await waitForMessageWhere<{ type: "ROOM_STATE"; room: { seats: Array<{ botId?: string }> } }>(
      hostSocket,
      "ROOM_STATE",
      (message) => message.room.seats.some((seat) => seat.botId === "bot_4"),
    );

    hostSocket.send(JSON.stringify({ type: "READY", roomId: room.code, ready: true }));
    guestSocket.send(JSON.stringify({ type: "READY", roomId: room.code, ready: true }));
    await waitForMessageWhere<{ type: "ROOM_STATE"; room: { status: string; seats: Array<{ userId?: string; ready: boolean }> } }>(
      hostSocket,
      "ROOM_STATE",
      (message) => message.room.status === "LOBBY"
        && message.room.seats.some((seat) => seat.userId === host.userId && seat.ready)
        && message.room.seats.some((seat) => seat.userId === guest.userId && seat.ready),
    );

    hostSocket.send(JSON.stringify({ type: "START_ROOM", roomId: room.code }));
    await waitForMessageWhere<{ type: "ROOM_STATE"; room: { status: string; game?: ViewerState } }>(
      guestSocket,
      "ROOM_STATE",
      (message) => message.room.status === "IN_GAME" && Boolean(message.room.game),
    );

    expect(manager.roomForRef(room.id)?.game?.playerOrder).toEqual([host.userId, guest.userId, "bot_3", "bot_4"]);
  });

  it("keeps simultaneous room broadcasts isolated across simulated networks", async () => {
    const manager = new RoomManager();
    const hostA = await manager.createSession("Host A");
    const observerA = await manager.createSession("Observer A");
    const hostB = await manager.createSession("Host B");
    const roomA = await manager.createRoom(hostA, { mode: "CLASSIC", botFill: true, ranked: false });
    const roomB = await manager.createRoom(hostB, { mode: "CLASSIC", botFill: true, ranked: false });
    const readyA = await manager.setReady(roomA.id, hostA, true);
    const readyB = await manager.setReady(roomB.id, hostB, true);
    if (!readyA.ok || !readyA.room.game || !readyB.ok || !readyB.room.game) throw new Error("Failed to start test rooms");

    const app = await buildServer({ manager });
    servers.push({ close: () => app.close() });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const hostASocket = await openSocket(app, hostA.token, { forwardedFor: "203.0.113.11" });
    const observerASocket = await openSocket(app, observerA.token, { forwardedFor: "198.51.100.22" });
    const hostBSocket = await openSocket(app, hostB.token, { forwardedFor: "10.20.30.40" });

    hostASocket.send(JSON.stringify({ type: "JOIN_ROOM", roomId: roomA.code }));
    observerASocket.send(JSON.stringify({ type: "JOIN_ROOM", roomId: roomA.code, asSpectator: true }));
    hostBSocket.send(JSON.stringify({ type: "JOIN_ROOM", roomId: roomB.code }));
    await Promise.all([waitForMessage(hostASocket, "ROOM_STATE"), waitForMessage(observerASocket, "ROOM_STATE"), waitForMessage(hostBSocket, "ROOM_STATE")]);

    const vertexId = getLegalActions(readyA.room.game, hostA.userId).find((action) => action.type === "PLACE_SETUP")!.vertices[0]!;
    const edgeId = readyA.room.game.board.adjacency.vertexToEdges[vertexId]![0]!;
    const hostAEvents = waitForMessage<{ type: "EVENTS"; roomId: string; events: GameEvent[] }>(hostASocket, "EVENTS");
    const observerAEvents = waitForMessage<{ type: "EVENTS"; roomId: string; events: GameEvent[] }>(observerASocket, "EVENTS");
    hostASocket.send(JSON.stringify({
      type: "COMMAND",
      roomId: roomA.code,
      clientSeq: 1,
      command: { type: "PLACE_SETUP", playerId: hostA.userId, vertexId, edgeId },
    }));

    const [hostMessage, observerMessage] = await Promise.all([hostAEvents, observerAEvents]);
    expect(hostMessage.roomId).toBe(roomA.id);
    expect(observerMessage.roomId).toBe(roomA.id);
    expect(hostMessage.events.map((event) => event.seq)).toEqual(observerMessage.events.map((event) => event.seq));
    await expect(waitForNoMessage(hostBSocket, "EVENTS")).resolves.toBeUndefined();
    expect(roomB.game?.eventSeq).toBe(0);
  });

  it("keeps five room-code games isolated across simulated networks", async () => {
    const manager = new RoomManager();
    const rooms = [];
    for (let index = 0; index < 5; index += 1) {
      const host = await manager.createSession(`Host ${index + 1}`);
      const player = await manager.createSession(`Player ${index + 1}`);
      const observer = await manager.createSession(`Observer ${index + 1}`);
      const room = await manager.createRoom(host, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2 });
      const joined = await manager.joinRoom(room.code, player);
      if (!joined.ok) throw new Error("Failed to join test room");
      await manager.setReady(room.id, host, true);
      const ready = await manager.setReady(room.id, player, true);
      if (!ready.ok) throw new Error("Failed to ready test room");
      const started = await manager.startRoomByHost(room.code, host);
      if (!started.ok || !started.room.game) throw new Error("Failed to start test room");
      rooms.push({ host, observer, room, game: started.room.game });
    }
    const app = await buildServer({ manager });
    servers.push({ close: () => app.close() });
    await app.listen({ host: "127.0.0.1", port: 0 });

    const joined = [];
    for (const [index, entry] of rooms.entries()) {
      const hostSocket = await openSocket(app, entry.host.token, { forwardedFor: `203.0.113.${40 + index}` });
      const observerSocket = await openSocket(app, entry.observer.token, { forwardedFor: `198.51.100.${50 + index}` });
      hostSocket.send(JSON.stringify({ type: "JOIN_ROOM", roomId: entry.room.code }));
      observerSocket.send(JSON.stringify({ type: "JOIN_ROOM", roomId: entry.room.code, asSpectator: true }));
      await Promise.all([
        waitForMessageWhere<{ type: "ROOM_STATE"; room: { id: string } }>(hostSocket, "ROOM_STATE", (message) => message.room.id === entry.room.id),
        waitForMessageWhere<{ type: "ROOM_STATE"; room: { id: string } }>(observerSocket, "ROOM_STATE", (message) => message.room.id === entry.room.id),
      ]);
      joined.push({ ...entry, hostSocket, observerSocket });
    }

    for (const entry of joined) {
      const current = manager.roomForRef(entry.room.id)?.game;
      if (!current) throw new Error("Room lost game state");
      const vertexId = getLegalActions(current, entry.host.userId).find((action) => action.type === "PLACE_SETUP")!.vertices[0]!;
      const edgeId = current.board.adjacency.vertexToEdges[vertexId]![0]!;
      const hostEvents = waitForMessageWhere<{ type: "EVENTS"; roomId: string; events: GameEvent[] }>(
        entry.hostSocket,
        "EVENTS",
        (message) => message.roomId === entry.room.id,
      );
      const observerEvents = waitForMessageWhere<{ type: "EVENTS"; roomId: string; events: GameEvent[] }>(
        entry.observerSocket,
        "EVENTS",
        (message) => message.roomId === entry.room.id,
      );
      entry.hostSocket.send(JSON.stringify({
        type: "COMMAND",
        roomId: entry.room.code,
        clientSeq: 1,
        command: { type: "PLACE_SETUP", playerId: entry.host.userId, vertexId, edgeId },
      }));
      const [hostMessage, observerMessage] = await Promise.all([hostEvents, observerEvents]);
      expect(hostMessage.events[0]).toMatchObject({ type: "SETUP_PLACED" });
      expect(observerMessage.events[0]).toMatchObject({ type: "SETUP_PLACED" });
      for (const other of joined.filter((candidate) => candidate.room.id !== entry.room.id)) {
        await expect(waitForNoMessage(other.hostSocket, "EVENTS", 40)).resolves.toBeUndefined();
        await expect(waitForNoMessage(other.observerSocket, "EVENTS", 40)).resolves.toBeUndefined();
      }
    }
  });

  it("acknowledges duplicate accepted commands without rebroadcasting old events", async () => {
    const manager = new RoomManager();
    const host = await manager.createSession("Host");
    const spectator = await manager.createSession("Spectator");
    const room = await manager.createRoom(host, { mode: "CLASSIC", botFill: true, ranked: false });
    const ready = await manager.setReady(room.id, host, true);
    if (!ready.ok || !ready.room.game) throw new Error("Failed to start room");

    const app = await buildServer({ manager });
    servers.push({ close: () => app.close() });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const hostSocket = await openSocket(app, host.token);
    const spectatorSocket = await openSocket(app, spectator.token);

    hostSocket.send(JSON.stringify({ type: "JOIN_ROOM", roomId: room.id }));
    spectatorSocket.send(JSON.stringify({ type: "JOIN_ROOM", roomId: room.id, asSpectator: true }));
    await Promise.all([waitForMessage(hostSocket, "ROOM_STATE"), waitForMessage(spectatorSocket, "ROOM_STATE")]);

    const vertexId = getLegalActions(ready.room.game, host.userId).find((action) => action.type === "PLACE_SETUP")!.vertices[0]!;
    const edgeId = ready.room.game.board.adjacency.vertexToEdges[vertexId]![0]!;
    const command = { type: "PLACE_SETUP", playerId: host.userId, vertexId, edgeId };
    const hostEvents = waitForMessage<{ type: "EVENTS"; events: GameEvent[] }>(hostSocket, "EVENTS");
    const spectatorEvents = waitForMessage<{ type: "EVENTS"; events: GameEvent[] }>(spectatorSocket, "EVENTS");
    hostSocket.send(JSON.stringify({ type: "COMMAND", roomId: room.id, clientSeq: 1, command }));
    await Promise.all([hostEvents, spectatorEvents]);

    const ack = waitForMessage<{ type: "COMMAND_ACK"; clientSeq: number; seqStart: number; seqEnd: number }>(hostSocket, "COMMAND_ACK");
    hostSocket.send(JSON.stringify({ type: "COMMAND", roomId: room.id, clientSeq: 1, command }));
    expect(await ack).toMatchObject({ type: "COMMAND_ACK", clientSeq: 1, seqStart: 1 });
    await expect(waitForNoMessage(spectatorSocket, "EVENTS")).resolves.toBeUndefined();
  });

  it("rate-limits chat spam", async () => {
    const manager = new RoomManager();
    const host = await manager.createSession("Host");
    const room = await manager.createRoom(host, { mode: "CLASSIC", botFill: true, ranked: false });
    await manager.setReady(room.id, host, true);
    const app = await buildServer({ manager });
    servers.push({ close: () => app.close() });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = await openSocket(app, host.token);
    socket.send(JSON.stringify({ type: "JOIN_ROOM", roomId: room.id }));
    await waitForMessage(socket, "ROOM_STATE");
    const rateLimited = waitForMessage<{ type: "ERROR"; code: string }>(socket, "ERROR");
    for (let index = 0; index < 8; index += 1) {
      socket.send(JSON.stringify({ type: "CHAT", roomId: room.id, message: `hello ${index}` }));
    }
    expect((await rateLimited).code).toBe("RATE_LIMITED");
  });

  it("rejects legacy query-token websocket auth by default", async () => {
    const manager = new RoomManager();
    const host = await manager.createSession("Host");
    const app = await buildServer({ manager });
    servers.push({ close: () => app.close() });
    await app.listen({ host: "127.0.0.1", port: 0 });

    const socket = new WebSocket(`${wsBase(app)}/ws?sessionToken=${host.token}`);
    sockets.push(socket);
    const closed = await waitForClose(socket);
    expect(closed.code).toBe(1008);
    expect(closed.reason).toBe("Unauthorized");
  });

  it("rejects disallowed websocket origins before exposing room state", async () => {
    const manager = new RoomManager();
    const host = await manager.createSession("Host");
    const app = await buildServer({ manager, allowedOrigins: ["https://good.example"] });
    servers.push({ close: () => app.close() });
    await app.listen({ host: "127.0.0.1", port: 0 });

    const ticket = await issueTicket(app, host.token);
    const socket = new WebSocket(`${wsBase(app)}/ws?ticket=${ticket}`, { headers: { origin: "https://evil.example" } });
    sockets.push(socket);
    const closed = await waitForClose(socket);
    expect(closed.code).toBe(1008);
    expect(closed.reason).toBe("Origin not allowed");
  });

  it("accepts allowed websocket origins and rejects ticket reuse", async () => {
    const manager = new RoomManager();
    const host = await manager.createSession("Host");
    const app = await buildServer({ manager, allowedOrigins: ["https://good.example"] });
    servers.push({ close: () => app.close() });
    await app.listen({ host: "127.0.0.1", port: 0 });

    const ticket = await issueTicket(app, host.token);
    const first = new WebSocket(`${wsBase(app)}/ws?ticket=${ticket}`, { headers: { origin: "https://good.example" } });
    sockets.push(first);
    await waitForOpen(first);

    const reused = new WebSocket(`${wsBase(app)}/ws?ticket=${ticket}`, { headers: { origin: "https://good.example" } });
    sockets.push(reused);
    const closed = await waitForClose(reused);
    expect(closed.code).toBe(1008);
    expect(closed.reason).toBe("Unauthorized");
  });

  it("returns BAD_JSON for malformed websocket messages without closing the socket", async () => {
    const manager = new RoomManager();
    const host = await manager.createSession("Host");
    const room = await manager.createRoom(host, { mode: "CLASSIC", botFill: true, ranked: false });
    await manager.setReady(room.id, host, true);
    const app = await buildServer({ manager });
    servers.push({ close: () => app.close() });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = await openSocket(app, host.token);
    socket.send("{not json");
    expect((await waitForMessage<{ type: "ERROR"; code: string }>(socket, "ERROR")).code).toBe("BAD_JSON");
    socket.send(JSON.stringify({ type: "PING", nonce: "still-open" }));
    expect(await waitForMessage(socket, "PONG")).toMatchObject({ type: "PONG", nonce: "still-open" });
  });

  it("disconnects stale in-game sockets without abandoning the room", async () => {
    const manager = new RoomManager(undefined, { emptyGameTtlMs: 60_000 });
    const host = await manager.createSession("Host");
    const room = await manager.createRoom(host, { mode: "CLASSIC", botFill: true, ranked: false });
    const ready = await manager.setReady(room.id, host, true);
    if (!ready.ok) throw new Error("Failed to start room");
    const app = await buildServer({ manager, presenceStaleMs: 25, presenceSweepIntervalMs: 10 });
    servers.push({ close: () => app.close() });
    await app.listen({ host: "127.0.0.1", port: 0 });

    const socket = await openSocket(app, host.token);
    socket.send(JSON.stringify({ type: "JOIN_ROOM", roomId: room.id }));
    await waitForMessage(socket, "ROOM_STATE");

    const closed = await waitForClose(socket);
    expect(closed).toMatchObject({ code: 4000, reason: "Presence stale" });
    await waitUntil(() => room.seats.find((seat) => seat.userId === host.userId)?.connected === false);
    expect(room.status).toBe("IN_GAME");
    expect(room.archivedAt).toBeUndefined();
    expect(room.seats.find((seat) => seat.userId === host.userId)).toMatchObject({ connected: false });
    expect(room.pausedAt).toBeDefined();
    expect(room.pauseReason).toBe("EMPTY_ROOM");
  });

  it("uses local socket authority to synchronize disconnects when presence storage fails", async () => {
    const manager = new RoomManager(undefined, { emptyGameTtlMs: 60_000 });
    const host = await manager.createSession("Host");
    const room = await manager.createRoom(host, { mode: "CLASSIC", botFill: true, ranked: false });
    const ready = await manager.setReady(room.id, host, true);
    if (!ready.ok) throw new Error("Failed to start room");
    const presence = new MemoryPresenceStore();
    vi.spyOn(presence, "disconnect").mockRejectedValue(new Error("redis unavailable"));
    const metrics = new MetricsRegistry("presence-test", "single");
    const logs: StructuredLogRecord[] = [];
    const logger = createStructuredLogger("presence-test", "single", (record) => logs.push(record));
    const app = await buildServer({ manager, presenceStore: presence, metrics, logger });
    servers.push({ close: () => app.close() });
    await app.listen({ host: "127.0.0.1", port: 0 });

    const socket = await openSocket(app, host.token);
    socket.send(JSON.stringify({ type: "JOIN_ROOM", roomId: room.id }));
    await waitForMessage(socket, "ROOM_STATE");
    socket.close();
    await waitForClose(socket);

    await waitUntil(() => room.seats.find((seat) => seat.userId === host.userId)?.connected === false);
    expect(room.seats.find((seat) => seat.userId === host.userId)).toMatchObject({ connected: false });
    expect(logs).toContainEqual(expect.objectContaining({
      event: "presence.disconnect_failed",
      roomId: room.id,
      message: "redis unavailable",
    }));
    expect(metrics.render(manager, 0, presence.kind)).toContain('operation="presence_disconnect"');
  });

  it("keeps accepted sockets usable while surfacing initial presence connection failures", async () => {
    const manager = new RoomManager();
    const host = await manager.createSession("Host");
    const presence = new MemoryPresenceStore();
    vi.spyOn(presence, "connect").mockRejectedValue(new Error("redis connect failed"));
    const metrics = new MetricsRegistry("presence-connect-test", "single");
    const logs: StructuredLogRecord[] = [];
    const logger = createStructuredLogger("presence-connect-test", "single", (record) => logs.push(record));
    const app = await buildServer({ manager, presenceStore: presence, metrics, logger });
    servers.push({ close: () => app.close() });
    await app.listen({ host: "127.0.0.1", port: 0 });

    const socket = await openSocket(app, host.token);
    socket.send(JSON.stringify({ type: "PING", nonce: "still-usable" }));

    await expect(waitForMessage(socket, "PONG")).resolves.toMatchObject({ nonce: "still-usable" });
    await waitUntil(() => logs.some((record) => record.event === "presence.connect_failed"));
    expect(logs).toContainEqual(expect.objectContaining({ event: "presence.connect_failed", message: "redis connect failed" }));
    expect(metrics.render(manager, 1, presence.kind)).toContain('operation="presence_connect"');
  });

  it("falls back to local room users when presence membership lookup fails on close", async () => {
    const manager = new RoomManager(undefined, { emptyGameTtlMs: 60_000 });
    const host = await manager.createSession("Host");
    const room = await manager.createRoom(host, { mode: "CLASSIC", botFill: true, ranked: false });
    const ready = await manager.setReady(room.id, host, true);
    if (!ready.ok) throw new Error("Failed to start room");
    const presence = new MemoryPresenceStore();
    const metrics = new MetricsRegistry("presence-users-test", "single");
    const logs: StructuredLogRecord[] = [];
    const logger = createStructuredLogger("presence-users-test", "single", (record) => logs.push(record));
    const app = await buildServer({ manager, presenceStore: presence, metrics, logger });
    servers.push({ close: () => app.close() });
    await app.listen({ host: "127.0.0.1", port: 0 });

    const socket = await openSocket(app, host.token);
    socket.send(JSON.stringify({ type: "JOIN_ROOM", roomId: room.id }));
    await waitForMessage(socket, "ROOM_STATE");
    await waitUntil(async () => (await presence.roomUserIds(room.id)).has(host.userId));
    vi.spyOn(presence, "roomUserIds").mockRejectedValue(new Error("redis membership failed"));
    socket.close();
    await waitForClose(socket);

    await waitUntil(() => room.seats.find((seat) => seat.userId === host.userId)?.connected === false);
    expect(logs).toContainEqual(expect.objectContaining({ event: "presence.room_users_failed", message: "redis membership failed" }));
    expect(metrics.render(manager, 0, presence.kind)).toContain('operation="presence_room_users"');
  });

  it("reports stale-presence sweep failures without stopping the server", async () => {
    const manager = new RoomManager();
    const host = await manager.createSession("Host");
    const presence = new MemoryPresenceStore();
    vi.spyOn(presence, "sweepStale").mockRejectedValue(new Error("redis sweep failed"));
    const metrics = new MetricsRegistry("presence-sweep-test", "single");
    const logs: StructuredLogRecord[] = [];
    const logger = createStructuredLogger("presence-sweep-test", "single", (record) => logs.push(record));
    const app = await buildServer({ manager, presenceStore: presence, metrics, logger, presenceSweepIntervalMs: 5 });
    servers.push({ close: () => app.close() });
    await app.listen({ host: "127.0.0.1", port: 0 });

    await waitUntil(() => logs.some((record) => record.event === "presence.sweep_failed"));
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(logs).toContainEqual(expect.objectContaining({ event: "presence.sweep_failed", message: "redis sweep failed" }));
    expect(metrics.render(manager, 0, presence.kind)).toContain('operation="presence_sweep"');
    expect(await manager.resolveSession(host.token)).toEqual(host);
  });

  it("reports durable connection-sync failures after a socket closes", async () => {
    const manager = new RoomManager();
    const host = await manager.createSession("Host");
    const room = await manager.createRoom(host, { mode: "CLASSIC", botFill: false, ranked: false });
    const metrics = new MetricsRegistry("connection-sync-test", "single");
    const logs: StructuredLogRecord[] = [];
    const logger = createStructuredLogger("connection-sync-test", "single", (record) => logs.push(record));
    const app = await buildServer({ manager, metrics, logger });
    servers.push({ close: () => app.close() });
    await app.listen({ host: "127.0.0.1", port: 0 });

    const socket = await openSocket(app, host.token);
    socket.send(JSON.stringify({ type: "JOIN_ROOM", roomId: room.id }));
    await waitForMessage(socket, "ROOM_STATE");
    await new Promise((resolve) => setTimeout(resolve, 10));
    vi.spyOn(manager, "syncConnections").mockRejectedValue(new Error("room persistence failed"));
    socket.close();
    await waitForClose(socket);

    await waitUntil(() => logs.some((record) => record.event === "presence.connection_sync_failed"));
    expect(logs).toContainEqual(expect.objectContaining({ event: "presence.connection_sync_failed", message: "room persistence failed" }));
    expect(metrics.render(manager, 0, "memory")).toContain('operation="connection_sync"');
  });

  it("resyncs missed broadcasts after reconnect with a fresh ticket", async () => {
    const manager = new RoomManager();
    const host = await manager.createSession("Host");
    const room = await manager.createRoom(host, { mode: "CLASSIC", botFill: true, ranked: false });
    const ready = await manager.setReady(room.id, host, true);
    if (!ready.ok || !ready.room.game) throw new Error("Failed to start room");
    const app = await buildServer({ manager });
    servers.push({ close: () => app.close() });
    await app.listen({ host: "127.0.0.1", port: 0 });

    const socket = await openSocket(app, host.token);
    const keeperSocket = await openSocket(app, host.token);
    keeperSocket.send(JSON.stringify({ type: "JOIN_ROOM", roomId: room.id }));
    await waitForMessage(keeperSocket, "ROOM_STATE");
    socket.send(JSON.stringify({ type: "JOIN_ROOM", roomId: room.id }));
    await waitForMessage(socket, "ROOM_STATE");
    socket.close();
    await waitForClose(socket);

    const vertexId = getLegalActions(ready.room.game, host.userId).find((action) => action.type === "PLACE_SETUP")!.vertices[0]!;
    const edgeId = ready.room.game.board.adjacency.vertexToEdges[vertexId]![0]!;
    const result = await manager.submitCommand(room.id, host, 1, { type: "PLACE_SETUP", playerId: host.userId, vertexId, edgeId });
    expect(result.ok).toBe(true);

    const reconnected = await openSocket(app, host.token);
    reconnected.send(JSON.stringify({ type: "JOIN_ROOM", roomId: room.id }));
    await waitForMessage(reconnected, "ROOM_STATE");
    reconnected.send(JSON.stringify({ type: "RESYNC", roomId: room.id, lastSeq: 0 }));
    const resync = await waitForMessage<{ type: "RESYNC"; events: GameEvent[]; snapshot: { eventSeq: number } }>(reconnected, "RESYNC");
    expect(resync.events.map((event) => event.seq)).toEqual([1]);
    expect(resync.snapshot.eventSeq).toBe(1);
  });

  it("closes active WebSockets while draining server resources", async () => {
    const manager = new RoomManager();
    const host = await manager.createSession("Shutdown Host");
    const app = await buildServer({ manager });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = await openSocket(app, host.token);
    const closed = waitForClose(socket);

    await app.close();

    await expect(closed).resolves.toMatchObject({ code: 1005 });
  });
});
