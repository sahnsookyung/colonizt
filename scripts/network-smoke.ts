import WebSocket from "ws";
import { buildServer } from "@colonizt/server";

type Session = { token: string; userId: string };
type RoomPayload = {
  id: string;
  status: string;
  game?: {
    eventSeq: number;
    phase: { type: string; activePlayerId?: string };
    board: { adjacency: { vertexToEdges: Record<string, string[]> } };
  };
};
type RoomMessage = { type: "ROOM_STATE"; room: RoomPayload };
type EventsMessage = { type: "EVENTS"; events: Array<{ seq: number; type: string }>; snapshot?: { eventSeq: number } };
type ResyncMessage = { type: "RESYNC"; events: Array<{ seq: number; type: string }>; snapshot?: { eventSeq: number } };

const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 10_000);

const failAfter = <T>(promise: Promise<T>, label: string): Promise<T> =>
  Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)),
  ]);

const requestJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${url} failed: ${response.status}`);
  return response.json() as Promise<T>;
};

const createSession = (httpBase: string, displayName: string): Promise<Session> =>
  requestJson(`${httpBase}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName }),
  });

const issueTicket = (httpBase: string, token: string): Promise<{ ticket: string }> =>
  requestJson(`${httpBase}/ws-tickets`, { method: "POST", headers: { "x-session-token": token } });

const waitForOpen = (socket: WebSocket): Promise<void> =>
  new Promise((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });

const waitForMessage = <T extends { type: string }>(socket: WebSocket, type: string, predicate: (message: T) => boolean = () => true): Promise<T> =>
  failAfter(new Promise((resolve) => {
    const listener = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as T;
      if (message.type === type && predicate(message)) {
        socket.off("message", listener);
        resolve(message);
      }
    };
    socket.on("message", listener);
  }), type);

const connect = async (httpBase: string, wsBase: string, token: string): Promise<WebSocket> => {
  const { ticket } = await issueTicket(httpBase, token);
  const socket = new WebSocket(`${wsBase}/ws?ticket=${encodeURIComponent(ticket)}`);
  await failAfter(waitForOpen(socket), "websocket open");
  return socket;
};

const app = await buildServer({ allowedOrigins: ["http://127.0.0.1:5173"] });
await app.listen({ host: "127.0.0.1", port: 0 });
const address = app.server.address();
if (!address || typeof address === "string") throw new Error("Server did not bind to a TCP port");

const httpBase = `http://127.0.0.1:${address.port}`;
const wsBase = `ws://127.0.0.1:${address.port}`;
const sockets: WebSocket[] = [];

try {
  const players = await Promise.all(["Host", "Player 2", "Player 3", "Player 4"].map((name) => createSession(httpBase, `Smoke ${name}`)));
  const host = players[0];
  if (!host) throw new Error("No host session");
  const room = await requestJson<{ id: string }>(`${httpBase}/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-session-token": host.token },
    body: JSON.stringify({ mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 4, rules: { mapRandomized: true } }),
  });

  const playerSockets = await Promise.all(players.map((player) => connect(httpBase, wsBase, player.token)));
  sockets.push(...playerSockets);
  const hostSocket = playerSockets[0];
  if (!hostSocket) throw new Error("No host socket");

  const joinedPromises = playerSockets.map((socket) => waitForMessage<RoomMessage>(socket, "ROOM_STATE"));
  for (const socket of playerSockets) socket.send(JSON.stringify({ type: "JOIN_ROOM", roomId: room.id }));
  await Promise.all(joinedPromises);

  const startedPromises = playerSockets.map((socket) =>
    waitForMessage<RoomMessage>(socket, "ROOM_STATE", (message) => message.room.status === "IN_GAME" && Boolean(message.room.game)),
  );
  for (const socket of playerSockets) socket.send(JSON.stringify({ type: "READY", roomId: room.id, ready: true }));
  const [started] = await Promise.all(startedPromises);
  if (!started) throw new Error("No started room state observed");

  const activePlayerId = started.room.game!.phase.activePlayerId;
  if (!activePlayerId) throw new Error("Started game did not expose an active setup player");
  const activePlayerIndex = players.findIndex((player) => player.userId === activePlayerId);
  const activeSocket = playerSockets[activePlayerIndex];
  if (activePlayerIndex < 0 || !activeSocket) throw new Error(`Active player ${activePlayerId} is not connected`);

  const vertexId = Object.keys(started.room.game!.board.adjacency.vertexToEdges)[0];
  if (!vertexId) throw new Error("No setup vertex in room state");
  const edgeId = started.room.game!.board.adjacency.vertexToEdges[vertexId]?.[0];
  if (!edgeId) throw new Error("No setup edge in room state");

  const hostEventsPromise = waitForMessage<EventsMessage>(hostSocket, "EVENTS");
  const peerEventsPromises = playerSockets.slice(1).map((socket) => waitForMessage<EventsMessage>(socket, "EVENTS"));
  activeSocket.send(JSON.stringify({
    type: "COMMAND",
    roomId: room.id,
    clientSeq: 1,
    command: { type: "PLACE_SETUP", playerId: activePlayerId, vertexId, edgeId },
  }));
  const [hostEvents, ...peerEvents] = await Promise.all([hostEventsPromise, ...peerEventsPromises]);
  const canonicalSeq = hostEvents.events.map((event) => event.seq).join(",");
  for (const events of peerEvents) {
    if (canonicalSeq !== events.events.map((event) => event.seq).join(",")) throw new Error("Clients observed different event sequences");
  }

  hostSocket.close();
  const reconnected = await connect(httpBase, wsBase, host.token);
  sockets.push(reconnected);
  const reconnectedStatePromise = waitForMessage<RoomMessage>(reconnected, "ROOM_STATE");
  reconnected.send(JSON.stringify({ type: "JOIN_ROOM", roomId: room.id }));
  await reconnectedStatePromise;
  reconnected.send(JSON.stringify({ type: "RESYNC", roomId: room.id, lastSeq: 0 }));
  const resync = await waitForMessage<ResyncMessage>(reconnected, "RESYNC");
  if (resync.snapshot?.eventSeq !== hostEvents.snapshot?.eventSeq) throw new Error("Reconnect snapshot did not match committed sequence");

  console.log(JSON.stringify({
    ok: true,
    label: "local-network-smoke",
    roomId: room.id,
    humanPlayers: players.map((player) => player.userId),
    eventSeq: hostEvents.snapshot?.eventSeq,
    events: hostEvents.events.map((event) => event.type),
    reconnected: true,
  }, null, 2));
} finally {
  for (const socket of sockets) socket.close();
  await app.close();
}
