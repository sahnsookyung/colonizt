import type { BotDifficulty, GameCommand, GameConfig, GameEvent, ViewerState } from "@colonizt/game-core";
import type { CreateRoomResponse, CreateSessionResponse, MatchSummaryPayload, ReplayLogPayload, RuntimeNetworkConfig, WsTicketResponse } from "@colonizt/protocol";

export type MatchSummary = MatchSummaryPayload;

export interface NetworkClient {
  createSession(displayName: string): Promise<CreateSessionResponse>;
  createRoom(token: string, options?: { mode?: "CLASSIC" | "DUEL" | "RUSH"; botFill?: boolean; ranked?: boolean; minPlayers?: number; botDifficulty?: BotDifficulty; rules?: GameConfig["rules"] }): Promise<CreateRoomResponse>;
  listMatches(limit?: number): Promise<MatchSummary[]>;
  loadReplay(replayId: string, token?: string): Promise<ReplayLogPayload>;
  createWebSocketTicket(token: string): Promise<WsTicketResponse>;
  connect(token: string, handlers: {
    onEvents: (events: GameEvent[], snapshot?: ViewerState) => void;
    onRoom: (room: unknown) => void;
    onError: (error: unknown) => void;
    onOpen?: (socket: WebSocket) => void;
    onClose?: () => void;
  }): Promise<WebSocket>;
  sendCommand(socket: WebSocket, roomId: string, clientSeq: number, command: GameCommand): void;
}

type ResolvedRuntimeNetworkConfig = Pick<RuntimeNetworkConfig, "apiBaseUrl" | "wsBaseUrl">;

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
  Boolean(importEnv?.DEV)
  || importEnv?.MODE === "test"
  || (typeof window !== "undefined" && isLocalHostname(window.location.hostname));

const runtimeConfigFromPayload = (payload: Partial<RuntimeNetworkConfig>, fallbackApiBaseUrl: string): ResolvedRuntimeNetworkConfig => {
  const apiBaseUrl = trimTrailingSlash(payload.apiBaseUrl ?? fallbackApiBaseUrl);
  return {
    apiBaseUrl,
    wsBaseUrl: trimTrailingSlash(payload.wsBaseUrl ?? wsFromHttp(apiBaseUrl)),
  };
};

const fetchRuntimeConfig = async (url: string, fallbackApiBaseUrl: string): Promise<ResolvedRuntimeNetworkConfig | undefined> => {
  try {
    const response = await fetch(url);
    if (!response.ok) return undefined;
    return runtimeConfigFromPayload(await response.json() as Partial<RuntimeNetworkConfig>, fallbackApiBaseUrl);
  } catch {
    return undefined;
  }
};

export const resolveRuntimeConfig = async (seedBaseUrl = configuredBaseUrl): Promise<ResolvedRuntimeNetworkConfig> => {
  const normalizedSeed = seedBaseUrl ? trimTrailingSlash(seedBaseUrl) : undefined;
  const cacheKey = normalizedSeed ?? "__default__";
  const cached = configCache.get(cacheKey);
  if (cached) return cached;

  const promise = (async () => {
    if (importEnv?.MODE === "test" && !normalizedSeed) {
      return { apiBaseUrl: localBaseUrl, wsBaseUrl: wsFromHttp(localBaseUrl) };
    }

    const pageOrigin = typeof window !== "undefined" ? window.location.origin : localBaseUrl;
    const fallbackBaseUrl = normalizedSeed ?? (localFallbackAllowed() ? localBaseUrl : pageOrigin);
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
    const response = await fetch(`${config.apiBaseUrl}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName }),
    });
    if (!response.ok) throw new Error("Session creation failed");
    return response.json() as Promise<CreateSessionResponse>;
  },
  async createRoom(token, options = {}) {
    const config = await resolveRuntimeConfig(baseUrl);
    const response = await fetch(`${config.apiBaseUrl}/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-token": token },
      body: JSON.stringify({ mode: "CLASSIC", botFill: true, ranked: false, ...options }),
    });
    if (!response.ok) throw new Error("Room creation failed");
    return response.json() as Promise<CreateRoomResponse>;
  },
  async listMatches(limit = 12) {
    const config = await resolveRuntimeConfig(baseUrl);
    const response = await fetch(`${config.apiBaseUrl}/matches?limit=${limit}`);
    if (!response.ok) throw new Error("Match history failed");
    return response.json() as Promise<MatchSummary[]>;
  },
  async loadReplay(replayId, token) {
    const config = await resolveRuntimeConfig(baseUrl);
    const response = await fetch(`${config.apiBaseUrl}/matches/${encodeURIComponent(replayId)}/replay`, token ? { headers: { "x-session-token": token } } : undefined);
    if (!response.ok) throw new Error("Replay load failed");
    return response.json() as Promise<ReplayLogPayload>;
  },
  async createWebSocketTicket(token) {
    const config = await resolveRuntimeConfig(baseUrl);
    const response = await fetch(`${config.apiBaseUrl}/ws-tickets`, {
      method: "POST",
      headers: { "x-session-token": token },
    });
    if (!response.ok) throw new Error("WebSocket ticket creation failed");
    return response.json() as Promise<WsTicketResponse>;
  },
  async connect(token, handlers) {
    const config = await resolveRuntimeConfig(baseUrl);
    const ticket = await this.createWebSocketTicket(token);
    const socket = new WebSocket(`${config.wsBaseUrl}/ws?ticket=${encodeURIComponent(ticket.ticket)}`);
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    socket.addEventListener("open", () => {
      heartbeat = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "PING", nonce: String(Date.now()) }));
      }, 15_000);
      handlers.onOpen?.(socket);
    });
    socket.addEventListener("close", () => {
      if (heartbeat) clearInterval(heartbeat);
      handlers.onClose?.();
    });
    socket.addEventListener("message", (event) => {
      let message: { type: string; events?: GameEvent[]; snapshot?: ViewerState; room?: unknown };
      try {
        message = JSON.parse(String(event.data)) as { type: string; events?: GameEvent[]; snapshot?: ViewerState; room?: unknown };
      } catch {
        handlers.onError({ type: "ERROR", code: "BAD_JSON" });
        return;
      }
      if (message.type === "EVENTS") handlers.onEvents(message.events ?? [], message.snapshot);
      else if (message.type === "RESYNC") handlers.onEvents(message.events ?? [], message.snapshot);
      else if (message.type === "ROOM_STATE") handlers.onRoom(message.room);
      else if (message.type === "ERROR" || message.type === "COMMAND_REJECTED") handlers.onError(message);
    });
    return socket;
  },
  sendCommand(socket, roomId, clientSeq, command) {
    socket.send(JSON.stringify({ type: "COMMAND", roomId, clientSeq, command }));
  },
});
