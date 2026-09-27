import type { BotDifficulty, GameCommand, GameConfig, GameEvent, ViewerState } from "@colonizt/game-core";
import { protocolVersion, type CommandAck, type CreateSessionResponse, type MatchSummaryPayload, type PublicRoomPayload, type ReplayLogPayload, type RuntimeNetworkConfig, type WsTicketResponse } from "@colonizt/protocol";

export type MatchSummary = MatchSummaryPayload;
export type NetworkTimer = NonNullable<PublicRoomPayload["timer"]>;
export const webSocketOpenTimeoutMs = 10_000;
export type RoomLookupResult =
  | { ok: true; room: PublicRoomPayload }
  | { ok: false; code: string; status?: string; cleanupReason?: string };

export interface NetworkClient {
  createSession(displayName: string): Promise<CreateSessionResponse>;
  createRoom(token: string, options?: { mode?: "CLASSIC" | "DUEL" | "RUSH"; botFill?: boolean; ranked?: boolean; minPlayers?: number; maxPlayers?: number; botDifficulty?: BotDifficulty; rules?: GameConfig["rules"] }): Promise<PublicRoomPayload>;
  getRoom(roomRef: string): Promise<RoomLookupResult>;
  listMatches(limit?: number): Promise<MatchSummary[]>;
  loadReplay(replayId: string, token?: string): Promise<ReplayLogPayload>;
  createWebSocketTicket(token: string, signal?: AbortSignal): Promise<WsTicketResponse>;
  connect(token: string, handlers: {
    onEvents: (events: GameEvent[], snapshot?: ViewerState, timer?: NetworkTimer) => void;
    onRoom: (room: unknown) => void;
    onError: (error: unknown) => void;
    onOpen?: (socket: WebSocket) => void;
    onClose?: () => void;
    onAck?: (ack: CommandAck) => void;
    onClock?: (offsetMs: number) => void;
  }, signal?: AbortSignal): Promise<WebSocket>;
  sendCommand(socket: WebSocket, roomId: string, clientSeq: number, command: GameCommand, expectedEventSeq?: number): void;
}

type ResolvedRuntimeNetworkConfig = Pick<RuntimeNetworkConfig, "apiBaseUrl" | "wsBaseUrl"> & { protocolVersion?: number };

type ClientEnv = {
  VITE_API_BASE_URL?: string;
  DEV?: boolean;
  MODE?: string;
};

const importEnv = (import.meta as ImportMeta & { env?: ClientEnv }).env;
const configuredBaseUrl = importEnv?.VITE_API_BASE_URL?.replace(/\/$/, "");
const localBaseUrl = "http://127.0.0.1:8787";
const configCache = new Map<string, Promise<ResolvedRuntimeNetworkConfig>>();

const trimTrailingSlash = (value: string): string => value.replace(/\/$/, "");
const wsFromHttp = (apiBaseUrl: string): string => trimTrailingSlash(apiBaseUrl).replace(/^http/i, "ws");
const isLocalHostname = (hostname: string): boolean =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";

const localFallbackAllowed = (): boolean =>
  importEnv?.MODE === "test"
  || (typeof window !== "undefined" && isLocalHostname(window.location.hostname));

const runtimeConfigFromPayload = (payload: Partial<RuntimeNetworkConfig>, fallbackApiBaseUrl: string): ResolvedRuntimeNetworkConfig => {
  const apiBaseUrl = trimTrailingSlash(payload.apiBaseUrl ?? fallbackApiBaseUrl);
  return {
    apiBaseUrl,
    wsBaseUrl: trimTrailingSlash(payload.wsBaseUrl ?? wsFromHttp(apiBaseUrl)),
    ...(payload.protocolVersion !== undefined ? { protocolVersion: payload.protocolVersion } : {}),
  };
};

const fetchRuntimeConfig = async (url: string, fallbackApiBaseUrl: string): Promise<ResolvedRuntimeNetworkConfig | undefined> => {
  try {
    const response = await boundedFetch(url);
    if (!response.ok) return undefined;
    return runtimeConfigFromPayload(await response.json() as Partial<RuntimeNetworkConfig>, fallbackApiBaseUrl);
  } catch {
    return undefined;
  }
};

/** A cancelled or stalled request cannot keep a connection attempt alive indefinitely. */
export const boundedFetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};
  try {
    const cancellation = new Promise<never>((_, reject) => {
      abort = () => {
        controller.abort(init.signal?.reason);
        reject(init.signal?.reason ?? new DOMException("Request cancelled", "AbortError"));
      };
      init.signal?.addEventListener("abort", abort, { once: true });
      if (init.signal?.aborted) abort();
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("The request timed out. Please try again."));
      }, 10_000);
    });
    return await Promise.race([
      (async () => {
        controller.signal.throwIfAborted();
        const response = await fetch(input, { ...init, signal: controller.signal });
        // Include the response body in the deadline, not just receipt of headers.
        const body = await response.arrayBuffer();
        return new Response([204, 205, 304].includes(response.status) ? null : body, {
          status: response.status, statusText: response.statusText, headers: response.headers,
        });
      })(),
      cancellation,
    ]);
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", abort);
  }
};

const errorPayload = async (response: Response, fallbackCode: string, fallbackMessage: string): Promise<unknown> => {
  const payload = await response.json().catch(() => undefined) as { code?: unknown; message?: unknown } | undefined;
  return {
    code: typeof payload?.code === "string" ? payload.code : fallbackCode,
    message: typeof payload?.message === "string" ? payload.message : fallbackMessage,
    status: response.status,
  };
};

export const resolveRuntimeConfig = async (seedBaseUrl = configuredBaseUrl): Promise<ResolvedRuntimeNetworkConfig> => {
  const normalizedSeed = seedBaseUrl ? trimTrailingSlash(seedBaseUrl) : undefined;
  const cacheKey = normalizedSeed ?? "__default__";
  const cached = configCache.get(cacheKey);
  if (cached) return cached;

  const promise = (async () => {
    if (importEnv?.MODE === "test" && !normalizedSeed) {
      return { apiBaseUrl: localBaseUrl, wsBaseUrl: wsFromHttp(localBaseUrl), protocolVersion };
    }

    const pageOrigin = typeof window !== "undefined" ? window.location.origin : localBaseUrl;
    const fallbackBaseUrl = normalizedSeed ?? pageOrigin;
    const candidates = [
      "/config",
      ...(normalizedSeed ? [`${normalizedSeed}/config`] : []),
      ...(localFallbackAllowed() && normalizedSeed !== localBaseUrl ? [`${localBaseUrl}/config`] : []),
    ];

    for (const url of candidates) {
      const resolved = await fetchRuntimeConfig(url, fallbackBaseUrl);
      if (resolved) return resolved;
    }

    if (normalizedSeed || localFallbackAllowed()) {
      return { apiBaseUrl: fallbackBaseUrl, wsBaseUrl: wsFromHttp(fallbackBaseUrl) };
    }
    throw new Error("Public runtime config is unavailable");
  })();

  configCache.set(cacheKey, promise);
  promise.catch(() => configCache.delete(cacheKey));
  return promise;
};

export const createNetworkClient = (baseUrl = configuredBaseUrl): NetworkClient => ({
  async createSession(displayName) {
    const config = await resolveRuntimeConfig(baseUrl);
    const response = await boundedFetch(`${config.apiBaseUrl}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName }),
    });
    if (!response.ok) throw new Error("Session creation failed");
    return response.json() as Promise<CreateSessionResponse>;
  },
  async createRoom(token, options = {}) {
    const config = await resolveRuntimeConfig(baseUrl);
    const response = await boundedFetch(`${config.apiBaseUrl}/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-token": token },
      body: JSON.stringify({ mode: "CLASSIC", botFill: true, ranked: false, ...options }),
    });
    if (!response.ok) throw new Error("Room creation failed");
    return response.json() as Promise<PublicRoomPayload>;
  },
  async getRoom(roomRef) {
    const config = await resolveRuntimeConfig(baseUrl);
    const response = await boundedFetch(`${config.apiBaseUrl}/rooms/${encodeURIComponent(roomRef)}`);
    const payload = await response.json().catch(() => ({})) as { code?: string; status?: string; cleanupReason?: string };
    if (!response.ok) {
      return {
        ok: false,
        code: payload.code ?? (response.status === 404 ? "ROOM_NOT_FOUND" : "ROOM_LOOKUP_FAILED"),
        ...(payload.status ? { status: payload.status } : {}),
        ...(payload.cleanupReason ? { cleanupReason: payload.cleanupReason } : {}),
      };
    }
    return { ok: true, room: payload as PublicRoomPayload };
  },
  async listMatches(limit = 12) {
    const config = await resolveRuntimeConfig(baseUrl);
    const response = await boundedFetch(`${config.apiBaseUrl}/matches?limit=${limit}`);
    if (!response.ok) throw new Error("Match history failed");
    return response.json() as Promise<MatchSummary[]>;
  },
  async loadReplay(replayId, token) {
    const config = await resolveRuntimeConfig(baseUrl);
    const response = await boundedFetch(`${config.apiBaseUrl}/matches/${encodeURIComponent(replayId)}/replay`, token ? { headers: { "x-session-token": token } } : undefined);
    if (!response.ok) throw await errorPayload(response, response.status === 404 ? "REPLAY_NOT_FOUND" : "REPLAY_LOAD_FAILED", "Replay load failed");
    return response.json() as Promise<ReplayLogPayload>;
  },
  async createWebSocketTicket(token, signal) {
    signal?.throwIfAborted();
    const config = await resolveRuntimeConfig(baseUrl);
    signal?.throwIfAborted();
    const response = await boundedFetch(`${config.apiBaseUrl}/ws-tickets`, {
      method: "POST",
      headers: { "x-session-token": token },
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      throw await errorPayload(response, response.status === 401 ? "UNAUTHORIZED" : "WS_TICKET_FAILED", "WebSocket ticket creation failed");
    }
    return response.json() as Promise<WsTicketResponse>;
  },
  async connect(token, handlers, signal) {
    signal?.throwIfAborted();
    const config = await resolveRuntimeConfig(baseUrl);
    signal?.throwIfAborted();
    if (config.protocolVersion !== protocolVersion) {
      configCache.delete(baseUrl ? trimTrailingSlash(baseUrl) : "__default__");
      throw { code: "PROTOCOL_MISMATCH", message: "The game server needs an update. Please try again shortly." };
    }
    const ticket = await this.createWebSocketTicket(token, signal);
    signal?.throwIfAborted();
    const socket = new WebSocket(`${config.wsBaseUrl}/ws?ticket=${encodeURIComponent(ticket.ticket)}`);
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let ping: { nonce: string; wall: number; mono: number } | undefined;
    let closed = false;
    const unsubscribe: Array<() => void> = [];
    const listen = <K extends keyof WebSocketEventMap>(type: K, callback: (event: WebSocketEventMap[K]) => void) => {
      socket.addEventListener(type, callback);
      unsubscribe.push(() => socket.removeEventListener(type, callback));
    };
    const cleanup = () => {
      unsubscribe.splice(0).forEach((remove) => remove());
      clearTimeout(openTimeout);
      clearInterval(heartbeat);
      clearTimeout(deadline);
      signal?.removeEventListener("abort", abortConnection);
    };
    const close = (reason: string) => {
      if (closed) return;
      closed = true;
      cleanup();
      socket.close(4000, reason);
      handlers.onClose?.();
    };
    const abortConnection = () => close("Connection cancelled");
    const openTimeout = setTimeout(() => {
      handlers.onError({ type: "ERROR", code: "CONNECTION_TIMEOUT", message: "Online connection timed out" });
      close("Connection timeout");
    }, webSocketOpenTimeoutMs);
    signal?.addEventListener("abort", abortConnection, { once: true });
    const sendPing = () => {
      if (closed || socket.readyState !== WebSocket.OPEN || ping) return;
      ping = { nonce: String(Date.now()), wall: Date.now(), mono: performance.now() };
      socket.send(JSON.stringify({ type: "PING", nonce: ping.nonce }));
      deadline = setTimeout(() => {
        handlers.onError({ code: "HEARTBEAT_TIMEOUT", message: "Connection interrupted. Reconnecting to your table…" });
        close("Heartbeat timeout");
      }, 10_000);
    };
    listen("open", () => {
      if (closed) return;
      clearTimeout(openTimeout);
      heartbeat = setInterval(sendPing, 15_000);
      handlers.onOpen?.(socket);
      sendPing();
    });
    listen("close", () => close("Connection closed"));
    listen("error", () => {
      if (closed) return;
      handlers.onError({ type: "ERROR", code: "CONNECTION_FAILED", message: "Online connection failed" });
      close("Connection failed");
    });
    listen("message", (event) => {
      if (closed) return;
      let message: { type: string; events?: GameEvent[]; snapshot?: ViewerState; room?: unknown; timer?: NetworkTimer; nonce?: string; serverTime?: number };
      try {
        message = JSON.parse(String(event.data)) as typeof message;
        if (!message || typeof message.type !== "string") throw new Error("Invalid message");
      } catch {
        handlers.onError({ type: "ERROR", code: "BAD_JSON" });
        return;
      }
      if (message.type === "EVENTS" || message.type === "RESYNC") handlers.onEvents(message.events ?? [], message.snapshot, message.timer);
      else if (message.type === "ROOM_STATE") handlers.onRoom(message.room);
      else if (message.type === "COMMAND_ACK") handlers.onAck?.(message as CommandAck);
      else if (message.type === "PONG" && ping && message.nonce === ping.nonce) {
        clearTimeout(deadline);
        if (typeof message.serverTime === "number" && Number.isFinite(message.serverTime)) {
          handlers.onClock?.(message.serverTime + (performance.now() - ping.mono) / 2 - Date.now());
        }
        ping = undefined;
      } else if (message.type === "ERROR" || message.type === "COMMAND_REJECTED") handlers.onError(message);
    });
    return socket;
  },
  sendCommand(socket, roomId, clientSeq, command, expectedEventSeq) {
    socket.send(JSON.stringify({ type: "COMMAND", roomId, clientSeq, command, ...(expectedEventSeq !== undefined ? { expectedEventSeq } : {}) }));
  },
});
