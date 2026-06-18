import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { emptyResources, getLegalActions, type GameEvent, type TradeOffer, type ViewerState } from "@colonizt/game-core";
import { buildServer } from "../src/index.js";
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

const wsBase = (app: { server: { address(): string | AddressInfo | null } }): string => {
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("No server address");
  return `ws://127.0.0.1:${address.port}`;
};

const issueTicket = async (app: { inject: (options: { method: string; url: string; headers?: Record<string, string> }) => Promise<{ statusCode: number; json(): { ticket: string } }> }, token: string): Promise<string> => {
  const response = await app.inject({ method: "POST", url: "/ws-tickets", headers: { "x-session-token": token } });
  expect(response.statusCode).toBe(201);
  return response.json().ticket;
};

const openSocket = async (
  app: { inject: (options: { method: string; url: string; headers?: Record<string, string> }) => Promise<{ statusCode: number; json(): { ticket: string } }>; server: { address(): string | AddressInfo | null } },
  token: string,
  options: { origin?: string } = {},
): Promise<WebSocket> => {
  const ticket = await issueTicket(app, token);
  const socket = new WebSocket(`${wsBase(app)}/ws?ticket=${ticket}`, options.origin ? { headers: { origin: options.origin } } : undefined);
  sockets.push(socket);
  await waitForOpen(socket);
  return socket;
};

describe("WebSocket gateway", () => {
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
    const events = waitForMessage<{ type: "EVENTS"; roomId: string; events: GameEvent[] }>(hostSocket, "EVENTS");
    hostSocket.send(JSON.stringify({
      type: "COMMAND",
      roomId: room.code,
      clientSeq: 1,
      command: { type: "PLACE_SETUP", playerId: host.userId, vertexId, edgeId },
    }));

    const message = await events;
    expect(message.roomId).toBe(room.id);
    expect(message.events[0]).toMatchObject({ type: "SETUP_PLACED" });
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
});
