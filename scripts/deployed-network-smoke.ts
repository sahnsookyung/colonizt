import WebSocket from "ws";

type Session = { token: string; userId: string };
type RoomMessage = {
  type: "ROOM_STATE";
  room: {
    id: string;
    code?: string;
    status: string;
    seats?: Array<{ userId?: string; botId?: string; ready: boolean; connected: boolean }>;
    game?: {
      eventSeq: number;
      phase: { type: string; activePlayerId?: string };
      board: { adjacency: { vertexToEdges: Record<string, string[]> } };
    };
  };
};
type EventsMessage = { type: "EVENTS"; events: Array<{ seq: number; type: string }>; snapshot?: { eventSeq: number } };
type ResyncMessage = { type: "RESYNC"; events: Array<{ seq: number; type: string }>; snapshot?: { eventSeq: number } };
type CommandRejectedMessage = { type: "COMMAND_REJECTED"; clientSeq: number; code: string; message: string };

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

const closeSocket = (socket: WebSocket): void => {
  socket.removeAllListeners();
  if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
};

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

const waitForCommandRejected = (socket: WebSocket, clientSeq: number): { promise: Promise<never>; cleanup: () => void } => {
  let listener: ((raw: WebSocket.RawData) => void) | undefined;
  const promise = new Promise<never>((_, reject) => {
    listener = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as CommandRejectedMessage | { type: string };
      if (message.type === "COMMAND_REJECTED" && "clientSeq" in message && message.clientSeq === clientSeq) {
        if (listener) socket.off("message", listener);
        reject(new Error(`COMMAND rejected: ${message.code} ${message.message}`));
      }
    };
    socket.on("message", listener);
  });
  return {
    promise,
    cleanup: () => {
      if (listener) socket.off("message", listener);
    },
  };
};

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
let exitCode = 0;

try {
  const players = await Promise.all(["Host", "Player 2"].map((name) => createSession(`Smoke ${name} ${Date.now()}`)));
  const host = players[0];
  if (!host) throw new Error("No host session");
  const room = await requestJson<{ id: string; code?: string }>(`${apiBase}/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-session-token": host.token, origin: webOrigin },
    body: JSON.stringify({ mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2, maxPlayers: 4, rules: { mapRandomized: true } }),
  });
  const roomRef = room.code ?? room.id;

  const playerSockets = await Promise.all(players.map((player) => connect(player.token)));
  sockets.push(...playerSockets);
  const hostSocket = playerSockets[0];
  if (!hostSocket) throw new Error("No host socket");
  const joinedPromises = playerSockets.map((socket) => waitForMessage<RoomMessage>(socket, "ROOM_STATE"));
  for (const socket of playerSockets) socket.send(JSON.stringify({ type: "JOIN_ROOM", roomId: roomRef }));
  await Promise.all(joinedPromises);

  const startedPromises = playerSockets.map((socket) =>
    waitForMessage<RoomMessage>(socket, "ROOM_STATE", (message) => message.room.status === "IN_GAME" && Boolean(message.room.game)),
  );
  const readyPromises = playerSockets.map((socket) =>
    waitForMessage<RoomMessage>(socket, "ROOM_STATE", (message) =>
      message.room.status === "LOBBY"
      && (message.room.seats?.filter((seat) => (seat.userId || seat.botId) && seat.ready && (seat.connected || seat.botId)).length ?? 0) >= players.length,
    ),
  );
  for (const socket of playerSockets) socket.send(JSON.stringify({ type: "READY", roomId: roomRef, ready: true }));
  await Promise.all(readyPromises);
  hostSocket.send(JSON.stringify({ type: "START_ROOM", roomId: roomRef }));
  const [started] = await Promise.all(startedPromises);
  if (!started) throw new Error("No started room state observed");

  const activePlayerId = started.room.game!.phase.activePlayerId;
  if (!activePlayerId) throw new Error("Started game did not expose an active setup player");
  const activePlayerIndex = players.findIndex((player) => player.userId === activePlayerId);
  const activeSocket = playerSockets[activePlayerIndex];
  if (activePlayerIndex < 0 || !activeSocket) throw new Error(`Active player ${activePlayerId} is not connected`);
  const vertexId = Object.keys(started.room.game!.board.adjacency.vertexToEdges)[0];
  const edgeId = vertexId ? started.room.game!.board.adjacency.vertexToEdges[vertexId]?.[0] : undefined;
  if (!vertexId || !edgeId) throw new Error("No legal setup target found in deployed room snapshot");

  const hostEventsPromise = waitForMessage<EventsMessage>(hostSocket, "EVENTS");
  const peerEventsPromises = playerSockets.slice(1).map((socket) => waitForMessage<EventsMessage>(socket, "EVENTS"));
  const commandRejected = waitForCommandRejected(activeSocket, 1);
  activeSocket.send(JSON.stringify({
    type: "COMMAND",
    roomId: roomRef,
    clientSeq: 1,
    command: { type: "PLACE_SETUP", playerId: activePlayerId, vertexId, edgeId },
  }));
  const [hostEvents, ...peerEvents] = await Promise.race([
    Promise.all([hostEventsPromise, ...peerEventsPromises]),
    commandRejected.promise,
  ]).finally(commandRejected.cleanup);
  const canonicalSeq = hostEvents.events.map((event) => event.seq).join(",");
  for (const events of peerEvents) {
    if (canonicalSeq !== events.events.map((event) => event.seq).join(",")) {
      throw new Error("Deployed clients observed different event sequences");
    }
  }

  hostSocket.close();
  const reconnected = await connect(host.token);
  sockets.push(reconnected);
  const reconnectedStatePromise = waitForMessage<RoomMessage>(reconnected, "ROOM_STATE");
  reconnected.send(JSON.stringify({ type: "JOIN_ROOM", roomId: roomRef }));
  await reconnectedStatePromise;
  reconnected.send(JSON.stringify({ type: "RESYNC", roomId: roomRef, lastSeq: 0 }));
  const resync = await waitForMessage<ResyncMessage>(reconnected, "RESYNC");
  if (resync.snapshot?.eventSeq !== hostEvents.snapshot?.eventSeq) throw new Error("Deployed reconnect snapshot mismatch");

  console.log(JSON.stringify({
    ok: true,
    label: "deployed-network-smoke",
    roomId: room.id,
    roomCode: room.code,
    startPlayers: players.length,
    maxPlayers: 4,
    humanPlayers: players.map((player) => player.userId),
    eventSeq: hostEvents.snapshot?.eventSeq,
    events: hostEvents.events.map((event) => event.type),
    apiBase,
    wsBase,
  }, null, 2));
} catch (error) {
  exitCode = 1;
  console.error(error instanceof Error ? error.stack ?? error.message : error);
} finally {
  for (const socket of sockets) closeSocket(socket);
}

process.exit(exitCode);
