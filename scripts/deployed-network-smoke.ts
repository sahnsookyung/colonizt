import WebSocket from "ws";

type Session = { token: string; userId: string };
type RoomMessage = {
  type: "ROOM_STATE";
  room: {
    id: string;
    status: string;
    game?: {
      eventSeq: number;
      board: { adjacency: { vertexToEdges: Record<string, string[]> } };
    };
  };
};
type EventsMessage = { type: "EVENTS"; events: Array<{ seq: number; type: string }>; snapshot?: { eventSeq: number } };
type ResyncMessage = { type: "RESYNC"; events: Array<{ seq: number; type: string }>; snapshot?: { eventSeq: number } };

const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 15_000);
const publicApiUrl = process.env.PUBLIC_API_URL?.replace(/\/$/, "");
const publicWsUrl = process.env.PUBLIC_WS_URL?.replace(/\/$/, "");
const publicWebOrigin = process.env.PUBLIC_WEB_ORIGIN ?? process.env.PUBLIC_WEB_URL;

const privateHostPattern = /(^|\.)localhost$|^127\.|^10\.|^172\.(1[6-9]|2\d|3[01])\.|^192\.168\.|^\[?::1\]?$/i;

const assertPublicUrl = (name: string, raw: string | undefined, expectedProtocol: "https:" | "wss:"): string => {
  if (!raw) throw new Error(`${name} is required`);
  const parsed = new URL(raw);
  if (parsed.protocol !== expectedProtocol) throw new Error(`${name} must use ${expectedProtocol}`);
  if (privateHostPattern.test(parsed.hostname)) throw new Error(`${name} must not point at localhost or a private network`);
  return raw.replace(/\/$/, "");
};

const apiBase = assertPublicUrl("PUBLIC_API_URL", publicApiUrl, "https:");
const wsBase = assertPublicUrl("PUBLIC_WS_URL", publicWsUrl, "wss:");
const webOrigin = assertPublicUrl("PUBLIC_WEB_ORIGIN", publicWebOrigin, "https:");

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

const createSession = (displayName: string): Promise<Session> =>
  requestJson(`${apiBase}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: webOrigin },
    body: JSON.stringify({ displayName }),
  });

const issueTicket = (token: string): Promise<{ ticket: string }> =>
  requestJson(`${apiBase}/ws-tickets`, {
    method: "POST",
    headers: { "x-session-token": token, origin: webOrigin },
  });

const connect = async (token: string): Promise<WebSocket> => {
  const { ticket } = await issueTicket(token);
  const socket = new WebSocket(`${wsBase}/ws?ticket=${encodeURIComponent(ticket)}`, { headers: { origin: webOrigin } });
  await failAfter(waitForOpen(socket), "websocket open");
  return socket;
};

const config = await requestJson<{ apiBaseUrl: string; wsBaseUrl: string; auth: { webSocket: string } }>(`${apiBase}/config`, {
  headers: { origin: webOrigin },
});
for (const [name, value, protocol] of [
  ["config.apiBaseUrl", config.apiBaseUrl, "https:"],
  ["config.wsBaseUrl", config.wsBaseUrl, "wss:"],
] as const) {
  assertPublicUrl(name, value, protocol);
}
if (config.auth.webSocket !== "ticket") throw new Error("Deployed server is not advertising ticket websocket auth");

const sockets: WebSocket[] = [];

try {
  const players = await Promise.all(["Host", "Player 2", "Player 3", "Player 4"].map((name) => createSession(`Smoke ${name} ${Date.now()}`)));
  const host = players[0];
  if (!host) throw new Error("No host session");
  const room = await requestJson<{ id: string }>(`${apiBase}/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-session-token": host.token, origin: webOrigin },
    body: JSON.stringify({ mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 4, rules: { mapRandomized: true } }),
  });

  const playerSockets = await Promise.all(players.map((player) => connect(player.token)));
  sockets.push(...playerSockets);
  const hostSocket = playerSockets[0];
  if (!hostSocket) throw new Error("No host socket");
  for (const socket of playerSockets) socket.send(JSON.stringify({ type: "JOIN_ROOM", roomId: room.id }));
  await Promise.all(playerSockets.map((socket) => waitForMessage<RoomMessage>(socket, "ROOM_STATE")));

  for (const socket of playerSockets) socket.send(JSON.stringify({ type: "READY", roomId: room.id, ready: true }));
  const started = await waitForMessage<RoomMessage>(hostSocket, "ROOM_STATE", (message) => message.room.status === "IN_GAME" && Boolean(message.room.game));
  await Promise.all(playerSockets.slice(1).map((socket) => waitForMessage<RoomMessage>(socket, "ROOM_STATE", (message) => message.room.status === "IN_GAME" && Boolean(message.room.game))));

  const vertexId = Object.keys(started.room.game!.board.adjacency.vertexToEdges)[0];
  const edgeId = vertexId ? started.room.game!.board.adjacency.vertexToEdges[vertexId]?.[0] : undefined;
  if (!vertexId || !edgeId) throw new Error("No legal setup target found in deployed room snapshot");

  const hostEventsPromise = waitForMessage<EventsMessage>(hostSocket, "EVENTS");
  const peerEventsPromises = playerSockets.slice(1).map((socket) => waitForMessage<EventsMessage>(socket, "EVENTS"));
  hostSocket.send(JSON.stringify({
    type: "COMMAND",
    roomId: room.id,
    clientSeq: 1,
    command: { type: "PLACE_SETUP", playerId: host.userId, vertexId, edgeId },
  }));
  const [hostEvents, ...peerEvents] = await Promise.all([hostEventsPromise, ...peerEventsPromises]);
  const canonicalSeq = hostEvents.events.map((event) => event.seq).join(",");
  for (const events of peerEvents) {
    if (canonicalSeq !== events.events.map((event) => event.seq).join(",")) {
      throw new Error("Deployed clients observed different event sequences");
    }
  }

  hostSocket.close();
  const reconnected = await connect(host.token);
  sockets.push(reconnected);
  reconnected.send(JSON.stringify({ type: "JOIN_ROOM", roomId: room.id }));
  await waitForMessage<RoomMessage>(reconnected, "ROOM_STATE");
  reconnected.send(JSON.stringify({ type: "RESYNC", roomId: room.id, lastSeq: 0 }));
  const resync = await waitForMessage<ResyncMessage>(reconnected, "RESYNC");
  if (resync.snapshot?.eventSeq !== hostEvents.snapshot?.eventSeq) throw new Error("Deployed reconnect snapshot mismatch");

  console.log(JSON.stringify({
    ok: true,
    label: "deployed-network-smoke",
    roomId: room.id,
    humanPlayers: players.map((player) => player.userId),
    eventSeq: hostEvents.snapshot?.eventSeq,
    events: hostEvents.events.map((event) => event.type),
    apiBase,
    wsBase,
  }, null, 2));
} finally {
  for (const socket of sockets) socket.close();
}
