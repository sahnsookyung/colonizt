import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { schemaVersion, serializeEventsForViewer, serializeForViewer, type GameCommand } from "@colonizt/game-core";
import { analyticsEventSchema, createRoomSchema, defaultWebSocketTicketTtlMs, protocolVersion, websocketAuthMode, wsClientMessageSchema } from "@colonizt/protocol";
import { createPool, runMigrations } from "@colonizt/db";
import { PostgresEventStore } from "./event-store.js";
import { createStructuredLogger, MetricsRegistry, resolveInstanceMode, type StructuredLogger } from "./observability.js";
import { createPresenceStore, type PresenceStore } from "./presence.js";
import { defaultRoomCleanupPolicy, RoomCapacityError, RoomManager, type Room, type RoomCleanupPolicy, type Session } from "./room-manager.js";
import { RoomAutomationScheduler } from "./scheduler.js";

export { RoomManager } from "./room-manager.js";
export { MemoryEventStore, PostgresEventStore } from "./event-store.js";
export { MemoryPresenceStore, RedisPresenceStore } from "./presence.js";
export { MetricsRegistry, createStructuredLogger, resolveInstanceMode } from "./observability.js";
export { RoomAutomationScheduler } from "./scheduler.js";

export interface BuildServerOptions {
  manager?: RoomManager;
  allowedOrigins?: string[];
  allowLegacySessionToken?: boolean;
  publicApiBaseUrl?: string;
  publicWsBaseUrl?: string;
  publicWebUrl?: string;
  wsTicketTtlMs?: number;
  roomCleanupPolicy?: Partial<RoomCleanupPolicy>;
  roomCleanupIntervalMs?: number;
  logger?: StructuredLogger;
  metrics?: MetricsRegistry;
  nodeId?: string;
  instanceMode?: "single";
}

type SocketClient = { socket: WebSocketLike; session: Session; roomId?: string; asSpectator?: boolean };
type WsTicket = { token: string; sessionToken: string; expiresAt: number; consumed: boolean };

interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message" | "close", listener: (...args: any[]) => void): void;
}

const tokenFromHeader = (authorization: unknown, xSessionToken: unknown): string | undefined => {
  if (typeof xSessionToken === "string") return xSessionToken;
  if (typeof authorization === "string" && authorization.startsWith("Bearer ")) return authorization.slice("Bearer ".length);
  return undefined;
};

const requireSession = async (manager: RoomManager, request: { headers: Record<string, unknown> }): Promise<Session> => {
  const token = tokenFromHeader(request.headers.authorization, request.headers["x-session-token"]);
  const session = await manager.resolveSession(token);
  if (!session) {
    throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
  }
  return session;
};

const positiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const sqlStatePattern = /^[0-9A-Z]{5}$/u;

const isDatabaseError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; routine?: unknown; severity?: unknown };
  return typeof candidate.code === "string"
    && sqlStatePattern.test(candidate.code)
    && (typeof candidate.routine === "string" || typeof candidate.severity === "string");
};

export const buildServer = async (options: BuildServerOptions = {}): Promise<FastifyInstance> => {
  const instanceMode = options.instanceMode ?? resolveInstanceMode();
  const nodeId = options.nodeId ?? process.env.NODE_ID ?? "local";
  const logger = options.logger ?? createStructuredLogger(nodeId, instanceMode);
  const metrics = options.metrics ?? new MetricsRegistry(nodeId, instanceMode);
  const cleanupPolicy: RoomCleanupPolicy = {
    ...defaultRoomCleanupPolicy,
    maxActiveRooms: positiveInt(process.env.MAX_ACTIVE_ROOMS, defaultRoomCleanupPolicy.maxActiveRooms),
    emptyLobbyTtlMs: positiveInt(process.env.EMPTY_LOBBY_TTL_MS, defaultRoomCleanupPolicy.emptyLobbyTtlMs),
    emptyGameTtlMs: positiveInt(process.env.EMPTY_GAME_TTL_MS, defaultRoomCleanupPolicy.emptyGameTtlMs),
    finishedRoomUnloadMs: positiveInt(process.env.FINISHED_ROOM_UNLOAD_MS, defaultRoomCleanupPolicy.finishedRoomUnloadMs),
    ...options.roomCleanupPolicy,
  };
  let manager = options.manager;
  let pool: ReturnType<typeof createPool> | undefined;
  if (!manager && process.env.DATABASE_URL) {
    pool = createPool({ connectionString: process.env.DATABASE_URL });
    try {
      await runMigrations(pool);
    } catch (error) {
      metrics.recordDbFailure("migrations");
      logger.error("db.migrations_failed", { message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    manager = new RoomManager(new PostgresEventStore(pool), cleanupPolicy);
    await manager.hydrateFromStore();
  }
  manager ??= new RoomManager(undefined, cleanupPolicy);
  const presence: PresenceStore = await createPresenceStore(process.env.REDIS_URL);
  const allowedOrigins = options.allowedOrigins ?? [process.env.WEB_ORIGIN ?? "http://127.0.0.1:5173"];
  const allowLegacySessionToken = options.allowLegacySessionToken ?? false;
  const wsTicketTtlMs = options.wsTicketTtlMs ?? defaultWebSocketTicketTtlMs;
  const app = Fastify({ logger: false, bodyLimit: 32_000 });
  const clients = new Set<SocketClient>();
  const wsTickets = new Map<string, WsTicket>();
  const requestStartedAt = new WeakMap<object, number>();

  const externalBaseUrl = (request: { headers: Record<string, unknown>; protocol?: string; hostname?: string }, configured?: string): string => {
    if (configured) return configured.replace(/\/$/, "");
    const protoHeader = request.headers["x-forwarded-proto"];
    const hostHeader = request.headers["x-forwarded-host"] ?? request.headers.host;
    const proto = typeof protoHeader === "string" ? protoHeader.split(",")[0]!.trim() : request.protocol ?? "http";
    const host = typeof hostHeader === "string" ? hostHeader.split(",")[0]!.trim() : request.hostname ?? "127.0.0.1";
    return `${proto}://${host}`.replace(/\/$/, "");
  };

  const issueWsTicket = (session: Session): WsTicket => {
    const ticket: WsTicket = {
      token: `wst_${nanoid(24)}`,
      sessionToken: session.token,
      expiresAt: Date.now() + wsTicketTtlMs,
      consumed: false,
    };
    wsTickets.set(ticket.token, ticket);
    return ticket;
  };

  const consumeWsTicket = async (ticketToken: string | null): Promise<Session | undefined> => {
    if (!ticketToken) return undefined;
    const ticket = wsTickets.get(ticketToken);
    if (!ticket || ticket.consumed || ticket.expiresAt < Date.now()) {
      if (ticket) wsTickets.delete(ticketToken);
      return undefined;
    }
    ticket.consumed = true;
    wsTickets.delete(ticketToken);
    return manager.resolveSession(ticket.sessionToken);
  };

  const withinLimit = (timestamps: number[], limit: number, windowMs: number): boolean => {
    const now = Date.now();
    while (timestamps[0] && timestamps[0] < now - windowMs) timestamps.shift();
    if (timestamps.length >= limit) return false;
    timestamps.push(now);
    return true;
  };

  const send = (client: SocketClient, payload: unknown): void => {
    client.socket.send(JSON.stringify(payload));
  };

  const viewerIdFor = (client: SocketClient): Session["userId"] | "spectator" =>
    client.asSpectator ? "spectator" : client.session.userId;

  const snapshotFor = (roomId: string, state: Parameters<typeof serializeForViewer>[0], client: SocketClient) => {
    const room = manager.rooms.get(roomId);
    return room ? manager.viewerState(room, state, viewerIdFor(client)) : serializeForViewer(state, viewerIdFor(client));
  };

  const broadcastRoom = (roomId: string, payloadFor: (client: SocketClient) => unknown): void => {
    for (const client of clients) {
      if (client.roomId === roomId) send(client, payloadFor(client));
    }
  };

  const roomInviteUrl = (request: { headers: Record<string, unknown>; protocol?: string; hostname?: string } | undefined, room: Room): string => {
    const webUrl = (options.publicWebUrl ?? process.env.PUBLIC_WEB_URL ?? process.env.WEB_ORIGIN ?? (request ? externalBaseUrl(request) : allowedOrigins[0] ?? "http://127.0.0.1:5173")).replace(/\/$/, "");
    return `${webUrl}/?room=${encodeURIComponent(room.code)}`;
  };

  const publicRoomWithInvite = (
    request: { headers: Record<string, unknown>; protocol?: string; hostname?: string } | undefined,
    room: Room,
    viewerId: Session["userId"] | "spectator" = "spectator",
  ) => ({
    ...manager.publicRoom(room, viewerId),
    inviteUrl: roomInviteUrl(request, room),
  });

  const broadcastRoomState = (room: Room): void => {
    broadcastRoom(room.id, (target) => ({ type: "ROOM_STATE", room: publicRoomWithInvite(undefined, room, viewerIdFor(target)) }));
  };

  const closeRoomClients = (roomId: string, code: string, message: string): void => {
    for (const client of [...clients]) {
      if (client.roomId !== roomId) continue;
      send(client, { type: "ERROR", code, message });
      client.socket.close(1000, message);
    }
  };

  const cleanupIntervalMs = options.roomCleanupIntervalMs ?? positiveInt(process.env.ROOM_CLEANUP_INTERVAL_MS, 30_000);
  const scheduler = new RoomAutomationScheduler({
    manager,
    cleanupPolicy,
    cleanupIntervalMs,
    logger,
    metrics,
    onEvents: (roomId, result) => {
      broadcastRoom(roomId, (target) => ({
        type: "EVENTS",
        roomId,
        events: serializeEventsForViewer(result.events, viewerIdFor(target), result.state.playerOrder),
        snapshot: snapshotFor(roomId, result.state, target),
      }));
    },
    onRoomClosed: (closed) => {
      const code = closed.status === "EXPIRED" ? "ROOM_EXPIRED" : closed.status === "ABANDONED" ? "ROOM_ABANDONED" : "ROOM_CLOSED";
      closeRoomClients(closed.roomId, code, closed.cleanupReason ?? "Room closed");
    },
  });
  scheduler.start();

  app.addHook("onRequest", (request, _reply, done) => {
    requestStartedAt.set(request, Date.now());
    done();
  });

  app.addHook("onResponse", (request, reply, done) => {
    const started = requestStartedAt.get(request) ?? Date.now();
    const route = request.routeOptions.url ?? request.url;
    metrics.recordHttpRequest(request.method, route, reply.statusCode, Date.now() - started);
    logger.info("http.request", { method: request.method, route, statusCode: reply.statusCode, durationMs: Date.now() - started });
    done();
  });

  app.addHook("onError", (request, _reply, error, done) => {
    if (isDatabaseError(error)) metrics.recordDbFailure("request");
    logger.error("http.error", { method: request.method, url: request.url, message: error.message });
    done();
  });

  app.addHook("onClose", async () => {
    scheduler.stop();
    await presence.close();
    await pool?.end();
  });

  await app.register(cors, {
    credentials: true,
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) callback(null, true);
      else callback(null, false);
    },
  });
  await app.register(websocket, { options: { maxPayload: 32_000 } });

  app.get("/health", async () => ({ ok: true, service: "colonizt-server", presence: presence.kind, nodeId, instanceMode }));

  app.get("/metrics", async (_request, reply) =>
    reply.header("content-type", "text/plain; version=0.0.4; charset=utf-8").send(metrics.render(manager, clients.size, presence.kind)),
  );

  app.get("/config", async (request) => {
    const apiBaseUrl = externalBaseUrl(request, options.publicApiBaseUrl ?? process.env.PUBLIC_API_URL);
    const wsBaseUrl = (options.publicWsBaseUrl ?? process.env.PUBLIC_WS_URL ?? apiBaseUrl.replace(/^http/i, "ws")).replace(/\/$/, "");
    return {
      schemaVersion,
      protocolVersion,
      apiBaseUrl,
      wsBaseUrl,
      webOrigin: options.publicWebUrl ?? process.env.PUBLIC_WEB_URL ?? process.env.WEB_ORIGIN ?? allowedOrigins[0],
      auth: { webSocket: websocketAuthMode, ticketTtlMs: wsTicketTtlMs },
      nodeId,
      instanceMode,
    };
  });

  app.post<{ Body: { displayName?: string } }>("/sessions", async (request) => {
    return manager.createSession(request.body.displayName ?? "Guest");
  });

  app.post("/ws-tickets", async (request, reply) => {
    const session = await requireSession(manager, request);
    const ticket = issueWsTicket(session);
    return reply.status(201).send({ ticket: ticket.token, expiresAt: new Date(ticket.expiresAt).toISOString(), ttlMs: wsTicketTtlMs });
  });

  app.post("/analytics", async (request, reply) => {
    const parsed = analyticsEventSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ code: "BAD_REQUEST", issues: parsed.error.issues });
    const token = tokenFromHeader(request.headers.authorization, request.headers["x-session-token"]);
    const session = token ? await manager.resolveSession(token) : undefined;
    const event = {
      eventName: parsed.data.eventName,
      payload: parsed.data.payload,
      ...(session ? { userId: session.userId } : {}),
      ...(parsed.data.matchId ? { matchId: parsed.data.matchId } : {}),
    };
    await manager.recordAnalytics(event);
    return reply.status(202).send({ ok: true });
  });

  app.get("/rooms", async () => manager.listRooms());

  app.get<{ Params: { roomRef: string } }>("/rooms/:roomRef", async (request, reply) => {
    const room = manager.roomForRef(request.params.roomRef);
    if (room) return publicRoomWithInvite(request, room);
    const stored = await manager.loadRoomStatusByRef(request.params.roomRef);
    if (!stored) return reply.status(404).send({ code: "ROOM_NOT_FOUND" });
    const code = stored.status === "EXPIRED" ? "ROOM_EXPIRED" : stored.status === "ABANDONED" ? "ROOM_ABANDONED" : "ROOM_CLOSED";
    return reply.status(410).send({ code, status: stored.status, cleanupReason: stored.cleanupReason });
  });

  app.get<{ Querystring: { limit?: string } }>("/matches", async (request) => {
    const limit = Number(request.query.limit ?? 20);
    return manager.listMatchHistory(Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 100) : 20);
  });

  app.get<{ Params: { matchId: string } }>("/matches/:matchId", async (request, reply) => {
    const matches = await manager.listMatchHistory(100);
    const match = matches.find((candidate) => candidate.id === request.params.matchId || candidate.roomId === request.params.matchId);
    return match ?? reply.status(404).send({ code: "MATCH_NOT_FOUND" });
  });

  app.post("/rooms", async (request, reply) => {
    const session = await requireSession(manager, request);
    const parsed = createRoomSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ code: "BAD_REQUEST", issues: parsed.error.issues });
    const settings = parsed.data.minPlayers === undefined
      ? (({ minPlayers: _minPlayers, ...rest }) => rest)(parsed.data)
      : parsed.data;
    try {
      return publicRoomWithInvite(request, await manager.createRoom(session, settings), session.userId);
    } catch (error) {
      if (error instanceof RoomCapacityError) return reply.status(503).send({ code: error.code, message: error.message });
      throw error;
    }
  });

  app.get<{ Params: { replayId: string } }>("/matches/:replayId/replay", async (request, reply) => {
    const session = await requireSession(manager, request);
    const storedReplay = await manager.getReplayById(request.params.replayId);
    if (!storedReplay) {
      metrics.recordReplay("not_found");
      return reply.status(404).send({ code: "REPLAY_NOT_FOUND" });
    }
    if (!storedReplay.config.playerOrder.includes(session.userId)) {
      metrics.recordReplay("forbidden");
      return reply.status(403).send({ code: "REPLAY_FORBIDDEN" });
    }
    metrics.recordReplay("loaded");
    logger.info("replay.loaded", { replayId: request.params.replayId, userId: session.userId, eventCount: storedReplay.events.length });
    return storedReplay;
  });

  app.get("/leaderboard", async () => ({
    mode: "CLASSIC",
    seasonId: "local-admin",
    rankedPublicQueue: "deferred",
    rows: [...manager.rooms.values()].flatMap((room) =>
      Object.values(room.game?.players ?? {}).map((player) => ({ userId: player.id, score: player.score, rating: 1000 + player.score * 25 })),
    ),
  }));

  app.post<{ Params: { roomId: string }; Body: { reportedUserId?: string; reason?: string } }>("/rooms/:roomId/reports", async (request, reply) => {
    const session = await requireSession(manager, request);
    if (!request.body.reportedUserId || !request.body.reason) return reply.status(400).send({ code: "BAD_REQUEST" });
    const report = await manager.createReport(request.params.roomId, session, request.body.reportedUserId, request.body.reason);
    if (!report) return reply.status(404).send({ code: "REPORT_REJECTED" });
    return report;
  });

  app.get("/ws", { websocket: true }, async (socket, request) => {
    const url = new URL(request.url, "http://localhost");
    const origin = request.headers.origin;
    if (typeof origin === "string" && !allowedOrigins.includes(origin)) {
      metrics.recordWebSocket("rejected", "origin");
      logger.warn("websocket.rejected", { reason: "origin", origin });
      socket.close(1008, "Origin not allowed");
      return;
    }
    const session = await consumeWsTicket(url.searchParams.get("ticket"))
      ?? (allowLegacySessionToken ? await manager.resolveSession(url.searchParams.get("sessionToken") ?? undefined) : undefined);
    if (!session) {
      metrics.recordWebSocket("rejected", "unauthorized");
      logger.warn("websocket.rejected", { reason: "unauthorized" });
      socket.close(1008, "Unauthorized");
      return;
    }
    const client: SocketClient = { socket, session };
    const socketId = `sock_${nanoid(10)}`;
    const commandTimes: number[] = [];
    const chatTimes: number[] = [];
    clients.add(client);
    metrics.recordWebSocket("connected");
    logger.info("websocket.connected", { socketId, userId: session.userId });
    void presence.connect(session, socketId).catch(() => undefined);
    socket.on("close", () => {
      clients.delete(client);
      const roomId = client.roomId;
      metrics.recordWebSocket("closed");
      logger.info("websocket.closed", { socketId, userId: session.userId, roomId });
      void (async () => {
        await presence.disconnect(session, socketId, roomId);
        if (!roomId) return;
        const room = await manager.syncConnections(roomId, await presence.roomUserIds(roomId));
        if (room) broadcastRoomState(room);
      })().catch(() => undefined);
    });

    socket.on("message", (raw) => {
      const rawText = raw.toString();
      if (Buffer.byteLength(rawText) > 32_000) {
        socket.close(1009, "Message too large");
        return;
      }
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(rawText);
      } catch {
        socket.send(JSON.stringify({ type: "ERROR", code: "BAD_JSON" }));
        return;
      }
      const parsed = wsClientMessageSchema.safeParse(parsedJson);
      if (!parsed.success) {
        socket.send(JSON.stringify({ type: "ERROR", code: "BAD_MESSAGE", issues: parsed.error.issues }));
        return;
      }

      const message = parsed.data;
      if (message.type === "PING") {
        socket.send(JSON.stringify({ type: "PONG", nonce: message.nonce }));
        return;
      }
      if (message.type === "JOIN_ROOM") {
        void manager.joinRoom(message.roomId, session, message.asSpectator ?? false).then((joined) => {
          if (!joined.ok) {
            send(client, { type: "ERROR", code: joined.code, message: joined.message });
            return;
          }
          client.roomId = joined.room.id;
          client.asSpectator = joined.room.spectators.has(session.userId) && !manager.isMember(joined.room, session.userId);
          void presence.joinRoom(session, socketId, joined.room.id).then(async () => {
            const synced = await manager.syncConnections(joined.room.id, await presence.roomUserIds(joined.room.id));
            if (synced) broadcastRoomState(synced);
            else broadcastRoomState(joined.room);
          }).catch(() => undefined);
        }).catch((error) => send(client, { type: "ERROR", code: "JOIN_FAILED", message: error instanceof Error ? error.message : "Join failed" }));
        return;
      }
      if (message.type === "READY") {
        void manager.setReady(message.roomId, session, message.ready).then((ready) => {
          if (!ready.ok) {
            send(client, { type: "ERROR", code: ready.code, message: ready.message });
            return;
          }
          broadcastRoomState(ready.room);
        }).catch((error) => send(client, { type: "ERROR", code: "READY_FAILED", message: error instanceof Error ? error.message : "Ready failed" }));
        return;
      }
      if (message.type === "COMMAND") {
        const commandStartedAt = Date.now();
        if (!withinLimit(commandTimes, 30, 10_000)) {
          metrics.recordCommand("rejected", message.command.type, Date.now() - commandStartedAt);
          logger.warn("command.rejected", { code: "RATE_LIMITED", userId: session.userId, command: message.command.type });
          send(client, { type: "COMMAND_REJECTED", code: "RATE_LIMITED", message: "Too many commands", clientSeq: message.clientSeq });
          return;
        }
        const canonicalRoomId = manager.roomForRef(message.roomId)?.id ?? message.roomId;
        void manager.submitCommand(message.roomId, session, message.clientSeq, message.command as GameCommand).then((result) => {
          if (!result.ok) {
            metrics.recordCommand("rejected", message.command.type, Date.now() - commandStartedAt);
            logger.warn("command.rejected", { code: result.code, userId: session.userId, roomId: canonicalRoomId, command: message.command.type });
            send(client, { type: "COMMAND_REJECTED", code: result.code, message: result.message, clientSeq: message.clientSeq });
            return;
          }
          if (result.replayed) {
            metrics.recordCommand("replayed", message.command.type, Date.now() - commandStartedAt);
            logger.info("command.replayed", { userId: session.userId, roomId: canonicalRoomId, command: message.command.type, clientSeq: message.clientSeq });
            send(client, {
              type: "COMMAND_ACK",
              roomId: canonicalRoomId,
              clientSeq: message.clientSeq,
              seqStart: result.seqStart,
              seqEnd: result.seqEnd,
            });
            return;
          }
          metrics.recordCommand("accepted", message.command.type, Date.now() - commandStartedAt);
          logger.info("command.accepted", { userId: session.userId, roomId: canonicalRoomId, command: message.command.type, events: result.events.length });
          broadcastRoom(canonicalRoomId, (target) => ({
            type: "EVENTS",
            roomId: canonicalRoomId,
            events: serializeEventsForViewer(result.events, viewerIdFor(target), result.state.playerOrder),
            snapshot: snapshotFor(canonicalRoomId, result.state, target),
          }));
        }).catch((error) => {
          metrics.recordCommand("rejected", message.command.type, Date.now() - commandStartedAt);
          metrics.recordDbFailure("command");
          logger.error("command.failed", { userId: session.userId, roomId: canonicalRoomId, command: message.command.type, message: error instanceof Error ? error.message : String(error) });
          send(client, { type: "COMMAND_REJECTED", code: "COMMAND_FAILED", message: error instanceof Error ? error.message : "Command failed", clientSeq: message.clientSeq });
        });
        return;
      }
      if (message.type === "CHAT") {
        if (!withinLimit(chatTimes, 6, 10_000)) {
          send(client, { type: "ERROR", code: "RATE_LIMITED", message: "Too many chat messages" });
          return;
        }
        const canonicalRoomId = manager.roomForRef(message.roomId)?.id ?? message.roomId;
        void manager.addChat(message.roomId, session, message.message).then((chat) => {
          if (!chat) send(client, { type: "ERROR", code: "CHAT_REJECTED" });
          else broadcastRoom(canonicalRoomId, () => ({ type: "CHAT", roomId: canonicalRoomId, chat }));
        }).catch((error) => send(client, { type: "ERROR", code: "CHAT_FAILED", message: error instanceof Error ? error.message : "Chat failed" }));
        return;
      }
      if (message.type === "RESYNC") {
        const canonicalRoomId = manager.roomForRef(message.roomId)?.id ?? message.roomId;
        const resync = manager.resync(message.roomId, session, message.lastSeq);
        send(client, resync ? { type: "RESYNC", roomId: canonicalRoomId, ...resync } : { type: "ERROR", code: "RESYNC_FAILED" });
      }
    });
  });

  return app;
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await buildServer();
  const host = process.env.SERVER_HOST ?? "127.0.0.1";
  const port = Number(process.env.SERVER_PORT ?? 8787);
  await app.listen({ host, port });
  console.log(`Colonizt server listening on http://${host}:${port}`);

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    console.log(`Colonizt server received ${signal}; draining sockets and closing resources`);
    await app.close();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}
