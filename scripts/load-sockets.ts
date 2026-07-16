import { performance } from "node:perf_hooks";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import WebSocket from "ws";
import { buildServer, createStructuredLogger } from "@colonizt/server";

type Session = { token: string; userId: string; displayName: string };
type RoomPayload = {
  id: string;
  code: string;
  status: string;
  seats?: Array<{ userId?: string; botId?: string; ready: boolean; connected: boolean }>;
  chat?: unknown[];
};
type WsMessage =
  | { type: "ROOM_STATE"; room: RoomPayload }
  | { type: "CHAT"; roomId: string }
  | { type: "RESYNC"; roomId: string; snapshot?: { eventSeq: number } }
  | { type: "ERROR"; code: string; message?: string };

const roomCount = Number(process.env.LOAD_ROOMS ?? 3);
const playersPerRoom = Number(process.env.LOAD_PLAYERS_PER_ROOM ?? 4);
const spectatorsPerRoom = Number(process.env.LOAD_SPECTATORS_PER_ROOM ?? 2);
const reconnectsPerRoom = Number(process.env.LOAD_RECONNECTS_PER_ROOM ?? 1);
const timeoutMs = Number(process.env.LOAD_TIMEOUT_MS ?? 20_000);
const maxP95Ms = Number(process.env.LOAD_MAX_P95_MS ?? Number.POSITIVE_INFINITY);
const maxP99Ms = Number(process.env.LOAD_MAX_P99_MS ?? Number.POSITIVE_INFINITY);
const maxHeapGrowthMb = Number(process.env.LOAD_MAX_HEAP_GROWTH_MB ?? Number.POSITIVE_INFINITY);
const reportPath = process.env.LOAD_REPORT_PATH;
if (!Number.isInteger(playersPerRoom) || playersPerRoom < 2 || playersPerRoom > 4) {
  throw new Error("LOAD_PLAYERS_PER_ROOM must be between 2 and 4 for public multiplayer rooms");
}
if (!Number.isInteger(roomCount) || roomCount < 1) throw new Error("LOAD_ROOMS must be a positive integer");
if (!Number.isInteger(spectatorsPerRoom) || spectatorsPerRoom < 0) throw new Error("LOAD_SPECTATORS_PER_ROOM must be a non-negative integer");
if (!Number.isInteger(reconnectsPerRoom) || reconnectsPerRoom < 1) throw new Error("LOAD_RECONNECTS_PER_ROOM must be a positive integer");

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

const createSession = (httpBase: string, displayName: string): Promise<Session> =>
  requestJson(`${httpBase}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName }),
  });

const waitForOpen = (socket: WebSocket): Promise<void> =>
  new Promise((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });

const waitForMessage = <T extends WsMessage>(socket: WebSocket, type: T["type"], predicate: (message: T) => boolean = () => true): Promise<T> =>
  failAfter(new Promise((resolve, reject) => {
    const listener = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as WsMessage;
      if (process.env.LOAD_DEBUG === "true") console.error("load-sockets message", JSON.stringify(message).slice(0, 500));
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

const connect = async (httpBase: string, wsBase: string, token: string, latencies: number[]): Promise<WebSocket> => {
  const startedAt = performance.now();
  const { ticket } = await requestJson<{ ticket: string }>(`${httpBase}/ws-tickets`, {
    method: "POST",
    headers: { "x-session-token": token },
  });
  const socket = new WebSocket(`${wsBase}/ws?ticket=${encodeURIComponent(ticket)}`);
  await failAfter(waitForOpen(socket), "websocket open");
  latencies.push(performance.now() - startedAt);
  return socket;
};

const percentile = (values: number[], quantile: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)]!;
};

const emitReport = async (report: Record<string, unknown>): Promise<void> => {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  console.log(serialized.trimEnd());
  if (!reportPath) return;
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, serialized, "utf8");
};

const app = await buildServer({
  allowedOrigins: ["http://127.0.0.1:5173"],
  logger: createStructuredLogger("load-sockets", "single", () => undefined),
  rateLimits: {
    sessionsPerMinutePerIp: roomCount * (playersPerRoom + spectatorsPerRoom) + 5,
    wsTicketsPerMinutePerIp: roomCount * (playersPerRoom + spectatorsPerRoom + reconnectsPerRoom) + 5,
    roomCreationsPerMinutePerIp: roomCount + 5,
  },
});
await app.listen({ host: "127.0.0.1", port: 0 });
const address = app.server.address();
if (!address || typeof address === "string") throw new Error("Server did not bind to a TCP port");

const httpBase = `http://127.0.0.1:${address.port}`;
const wsBase = `ws://127.0.0.1:${address.port}`;
const sockets: WebSocket[] = [];
const startedAt = performance.now();
const heapStartedBytes = process.memoryUsage().heapUsed;
const operationLatenciesMs: number[] = [];
let chatMessages = 0;
let reconnects = 0;
let resyncs = 0;
let reconnectAttempts = 0;
let peakOpenSockets = 0;

try {
  for (let roomIndex = 0; roomIndex < roomCount; roomIndex += 1) {
    const players = await Promise.all(Array.from({ length: playersPerRoom }, (_, index) => createSession(httpBase, `Load R${roomIndex} P${index}`)));
    const spectators = await Promise.all(Array.from({ length: spectatorsPerRoom }, (_, index) => createSession(httpBase, `Load R${roomIndex} S${index}`)));
    const host = players[0];
    if (!host) throw new Error("No host session");
    const room = await requestJson<RoomPayload>(`${httpBase}/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-token": host.token },
      body: JSON.stringify({
        mode: "CLASSIC",
        botFill: false,
        ranked: false,
        minPlayers: playersPerRoom,
        maxPlayers: 4,
      }),
    });

    const playerSockets = await Promise.all(players.map((session) => connect(httpBase, wsBase, session.token, operationLatenciesMs)));
    const spectatorSockets = await Promise.all(spectators.map((session) => connect(httpBase, wsBase, session.token, operationLatenciesMs)));
    sockets.push(...playerSockets, ...spectatorSockets);
    peakOpenSockets = Math.max(peakOpenSockets, sockets.filter((socket) => socket.readyState === WebSocket.OPEN).length);
    const assertRoomState = (message: { room: RoomPayload }, label: string): void => {
      if (message.room.id !== room.id && message.room.code !== room.code) {
        throw new Error(`${label} joined unexpected room ${message.room.id}/${message.room.code}, expected ${room.id}/${room.code}`);
      }
    };

    const playerJoinedPromises = playerSockets.map((socket) => waitForMessage<{ type: "ROOM_STATE"; room: RoomPayload }>(socket, "ROOM_STATE"));
    for (const socket of playerSockets) socket.send(JSON.stringify({ type: "JOIN_ROOM", roomId: room.code }));
    const joinedAt = performance.now();
    const playerJoined = await Promise.all(playerJoinedPromises);
    operationLatenciesMs.push(performance.now() - joinedAt);
    playerJoined.forEach((message, index) => assertRoomState(message, `player ${index}`));
    const spectatorJoinedPromises = spectatorSockets.map((socket) => waitForMessage<{ type: "ROOM_STATE"; room: RoomPayload }>(socket, "ROOM_STATE"));
    for (const socket of spectatorSockets) socket.send(JSON.stringify({ type: "JOIN_ROOM", roomId: room.code, asSpectator: true }));
    const spectatorJoined = await Promise.all(spectatorJoinedPromises);
    spectatorJoined.forEach((message, index) => assertRoomState(message, `spectator ${index}`));

    const started = playerSockets.map((socket) =>
      waitForMessage<{ type: "ROOM_STATE"; room: RoomPayload }>(socket, "ROOM_STATE", (message) =>
        (message.room.id === room.id || message.room.code === room.code) && message.room.status === "IN_GAME"),
    );
    const readyStates = playerSockets.map((socket) =>
      waitForMessage<{ type: "ROOM_STATE"; room: RoomPayload }>(socket, "ROOM_STATE", (message) =>
        (message.room.id === room.id || message.room.code === room.code)
        && message.room.status === "LOBBY"
        && (message.room.seats?.filter((seat) => (seat.userId || seat.botId) && seat.ready && (seat.connected || seat.botId)).length ?? 0) >= playersPerRoom),
    );
    for (const socket of playerSockets) socket.send(JSON.stringify({ type: "READY", roomId: room.code, ready: true }));
    await Promise.all(readyStates);
    playerSockets[0]!.send(JSON.stringify({ type: "START_ROOM", roomId: room.code }));
    const startAt = performance.now();
    await Promise.all(started);
    operationLatenciesMs.push(performance.now() - startAt);

    const chatSeen = waitForMessage<{ type: "CHAT"; roomId: string }>(playerSockets[1]!, "CHAT", (message) => message.roomId === room.id);
    const chatAt = performance.now();
    playerSockets[0]!.send(JSON.stringify({ type: "CHAT", roomId: room.code, message: `load chat ${roomIndex}` }));
    await chatSeen;
    operationLatenciesMs.push(performance.now() - chatAt);
    chatMessages += 1;

    let activeHostSocket = playerSockets[0]!;
    for (let reconnectIndex = 0; reconnectIndex < reconnectsPerRoom; reconnectIndex += 1) {
      reconnectAttempts += 1;
      const closed = new Promise<void>((resolve) => activeHostSocket.once("close", () => resolve()));
      activeHostSocket.close();
      await failAfter(closed, "websocket close before reconnect");
      const reconnectAt = performance.now();
      const reconnected = await connect(httpBase, wsBase, players[0]!.token, operationLatenciesMs);
      sockets.push(reconnected);
      const rejoined = waitForMessage<{ type: "ROOM_STATE"; room: RoomPayload }>(reconnected, "ROOM_STATE");
      reconnected.send(JSON.stringify({ type: "JOIN_ROOM", roomId: room.code }));
      assertRoomState(await rejoined, "reconnected player");
      const resynced = waitForMessage<{ type: "RESYNC"; roomId: string; snapshot?: { eventSeq: number } }>(reconnected, "RESYNC", (message) => message.roomId === room.id);
      reconnected.send(JSON.stringify({ type: "RESYNC", roomId: room.code, lastSeq: 0 }));
      await resynced;
      operationLatenciesMs.push(performance.now() - reconnectAt);
      reconnects += 1;
      resyncs += 1;
      activeHostSocket = reconnected;
    }
    peakOpenSockets = Math.max(peakOpenSockets, sockets.filter((socket) => socket.readyState === WebSocket.OPEN).length);
  }

  const elapsedMs = performance.now() - startedAt;
  const p95Ms = percentile(operationLatenciesMs, 0.95);
  const p99Ms = percentile(operationLatenciesMs, 0.99);
  const heapGrowthMb = (process.memoryUsage().heapUsed - heapStartedBytes) / (1024 * 1024);
  const reconnectSuccessRate = reconnectAttempts === 0 ? 1 : reconnects / reconnectAttempts;
  const expectedConcurrentSockets = roomCount * (playersPerRoom + spectatorsPerRoom);
  const failures = [
    p95Ms > maxP95Ms ? `p95 latency ${p95Ms.toFixed(1)}ms exceeded ${maxP95Ms}ms` : undefined,
    p99Ms > maxP99Ms ? `p99 latency ${p99Ms.toFixed(1)}ms exceeded ${maxP99Ms}ms` : undefined,
    heapGrowthMb > maxHeapGrowthMb ? `heap growth ${heapGrowthMb.toFixed(1)}MB exceeded ${maxHeapGrowthMb}MB` : undefined,
    reconnectSuccessRate < 1 ? `reconnect success rate ${(reconnectSuccessRate * 100).toFixed(1)}% was below 100%` : undefined,
    peakOpenSockets < expectedConcurrentSockets ? `peak socket concurrency ${peakOpenSockets} was below expected ${expectedConcurrentSockets}` : undefined,
  ].filter((failure): failure is string => Boolean(failure));
  const report = {
    ok: failures.length === 0,
    label: "real-websocket-load",
    generatedAt: new Date().toISOString(),
    rooms: roomCount,
    playersPerRoom,
    spectatorsPerRoom,
    socketsOpened: roomCount * (playersPerRoom + spectatorsPerRoom + reconnectsPerRoom),
    chatMessages,
    reconnects,
    resyncs,
    reconnectAttempts,
    reconnectSuccessRate,
    operationSamples: operationLatenciesMs.length,
    p95Ms,
    p99Ms,
    heapGrowthMb,
    peakOpenSockets,
    elapsedMs,
    thresholds: {
      maxP95Ms: Number.isFinite(maxP95Ms) ? maxP95Ms : null,
      maxP99Ms: Number.isFinite(maxP99Ms) ? maxP99Ms : null,
      maxHeapGrowthMb: Number.isFinite(maxHeapGrowthMb) ? maxHeapGrowthMb : null,
      reconnectSuccessRate: 1,
      minimumPeakOpenSockets: expectedConcurrentSockets,
    },
    failures,
  };
  await emitReport(report);
  if (failures.length > 0) throw new Error(failures.join("; "));
} finally {
  for (const socket of sockets) socket.close();
  await app.close();
}
