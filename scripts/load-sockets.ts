import { performance } from "node:perf_hooks";
import WebSocket from "ws";
import { buildServer, MemoryEventStore, RoomManager } from "@colonizt/server";

type RoomPayload = { id: string; code: string; status: string; chat?: unknown[] };
type WsMessage =
  | { type: "ROOM_STATE"; room: RoomPayload }
  | { type: "CHAT"; roomId: string }
  | { type: "RESYNC"; roomId: string; snapshot?: { eventSeq: number } }
  | { type: "ERROR"; code: string; message?: string };

const roomCount = Number(process.env.LOAD_ROOMS ?? 2);
const playersPerRoom = Number(process.env.LOAD_PLAYERS_PER_ROOM ?? 4);
const spectatorsPerRoom = Number(process.env.LOAD_SPECTATORS_PER_ROOM ?? 2);
const timeoutMs = Number(process.env.LOAD_TIMEOUT_MS ?? 20_000);

const failAfter = <T>(promise: Promise<T>, label: string): Promise<T> =>
  Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)),
  ]);

const requestJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${url} failed: ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
};

const waitForOpen = (socket: WebSocket): Promise<void> =>
  new Promise((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });

const waitForMessage = <T extends WsMessage>(socket: WebSocket, type: T["type"], predicate: (message: T) => boolean = () => true): Promise<T> =>
  failAfter(new Promise((resolve, reject) => {
    const listener = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as WsMessage;
      if (message.type === "ERROR") {
        socket.off("message", listener);
        reject(new Error(`socket error ${message.code}: ${message.message ?? ""}`));
        return;
      }
      if (message.type === type && predicate(message as T)) {
        socket.off("message", listener);
        resolve(message as T);
      }
    };
    socket.on("message", listener);
  }), type);

const connect = async (httpBase: string, wsBase: string, token: string): Promise<WebSocket> => {
  const { ticket } = await requestJson<{ ticket: string }>(`${httpBase}/ws-tickets`, {
    method: "POST",
    headers: { "x-session-token": token },
  });
  const socket = new WebSocket(`${wsBase}/ws?ticket=${encodeURIComponent(ticket)}`);
  await failAfter(waitForOpen(socket), "websocket open");
  return socket;
};

const manager = new RoomManager(new MemoryEventStore(), {
  emptyLobbyTtlMs: 100,
  emptyGameTtlMs: 150,
  finishedRoomUnloadMs: 150,
});
const app = await buildServer({
  manager,
  allowedOrigins: ["http://127.0.0.1:5173"],
  roomCleanupIntervalMs: 50,
});
await app.listen({ host: "127.0.0.1", port: 0 });
const address = app.server.address();
if (!address || typeof address === "string") throw new Error("Server did not bind to a TCP port");

const httpBase = `http://127.0.0.1:${address.port}`;
const wsBase = `ws://127.0.0.1:${address.port}`;
const sockets: WebSocket[] = [];
const startedAt = performance.now();
let chatMessages = 0;
let reconnects = 0;
let resyncs = 0;
let closedRooms = 0;

try {
  for (let roomIndex = 0; roomIndex < roomCount; roomIndex += 1) {
    const players = await Promise.all(Array.from({ length: playersPerRoom }, (_, index) => manager.createSession(`Load R${roomIndex} P${index}`)));
    const spectators = await Promise.all(Array.from({ length: spectatorsPerRoom }, (_, index) => manager.createSession(`Load R${roomIndex} S${index}`)));
    const host = players[0];
    if (!host) throw new Error("No host session");
    const room = await manager.createRoom(host, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: playersPerRoom });

    const playerSockets = await Promise.all(players.map((session) => connect(httpBase, wsBase, session.token)));
    const spectatorSockets = await Promise.all(spectators.map((session) => connect(httpBase, wsBase, session.token)));
    sockets.push(...playerSockets, ...spectatorSockets);

    await Promise.all(playerSockets.map((socket) => {
      const joined = waitForMessage<{ type: "ROOM_STATE"; room: RoomPayload }>(socket, "ROOM_STATE", (message) => message.room.id === room.id);
      socket.send(JSON.stringify({ type: "JOIN_ROOM", roomId: room.code }));
      return joined;
    }));
    await Promise.all(spectatorSockets.map((socket) => {
      const joined = waitForMessage<{ type: "ROOM_STATE"; room: RoomPayload }>(socket, "ROOM_STATE", (message) => message.room.id === room.id);
      socket.send(JSON.stringify({ type: "JOIN_ROOM", roomId: room.code, asSpectator: true }));
      return joined;
    }));

    const started = playerSockets.map((socket) =>
      waitForMessage<{ type: "ROOM_STATE"; room: RoomPayload }>(socket, "ROOM_STATE", (message) => message.room.id === room.id && message.room.status === "IN_GAME"),
    );
    for (const socket of playerSockets) socket.send(JSON.stringify({ type: "READY", roomId: room.code, ready: true }));
    await Promise.all(started);

    const chatSeen = waitForMessage<{ type: "CHAT"; roomId: string }>(playerSockets[1]!, "CHAT", (message) => message.roomId === room.id);
    playerSockets[0]!.send(JSON.stringify({ type: "CHAT", roomId: room.id, message: `load chat ${roomIndex}` }));
    await chatSeen;
    chatMessages += 1;

    playerSockets[0]!.close();
    const reconnected = await connect(httpBase, wsBase, players[0]!.token);
    sockets.push(reconnected);
    const rejoined = waitForMessage<{ type: "ROOM_STATE"; room: RoomPayload }>(reconnected, "ROOM_STATE", (message) => message.room.id === room.id);
    reconnected.send(JSON.stringify({ type: "JOIN_ROOM", roomId: room.id }));
    await rejoined;
    const resynced = waitForMessage<{ type: "RESYNC"; roomId: string; snapshot?: { eventSeq: number } }>(reconnected, "RESYNC", (message) => message.roomId === room.id);
    reconnected.send(JSON.stringify({ type: "RESYNC", roomId: room.id, lastSeq: 0 }));
    await resynced;
    reconnects += 1;
    resyncs += 1;

    for (const socket of [...playerSockets.slice(1), ...spectatorSockets, reconnected]) socket.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await manager.syncConnections(room.id, new Set(), Date.now());
    closedRooms += (await manager.cleanupRooms(Date.now() + 1_000)).filter((closed) => closed.roomId === room.id).length;
  }

  const elapsedMs = performance.now() - startedAt;
  console.log(JSON.stringify({
    ok: true,
    label: "real-websocket-load",
    rooms: roomCount,
    playersPerRoom,
    spectatorsPerRoom,
    socketsOpened: roomCount * (playersPerRoom + spectatorsPerRoom + 1),
    chatMessages,
    reconnects,
    resyncs,
    closedRooms,
    elapsedMs,
  }, null, 2));
} finally {
  for (const socket of sockets) socket.close();
  await app.close();
}
