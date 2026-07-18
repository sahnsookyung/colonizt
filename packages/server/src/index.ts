import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { serializeEventsForViewer, serializeForViewer } from "@colonizt/game-core";
import { defaultWebSocketTicketTtlMs } from "@colonizt/protocol";
import { createPool, runMigrations } from "@colonizt/db";
import { PostgresEventStore } from "./event-store.js";
import { createStructuredLogger, MetricsRegistry, resolveInstanceMode, type StructuredLogger } from "./observability.js";
import { MemoryRoomOwnershipStore, PostgresRoomOwnershipStore, type RoomOwnershipStore } from "./ownership.js";
import { createPresenceStore, type PresenceStore } from "./presence.js";
import { defaultRoomCleanupPolicy, RoomManager, type Room, type RoomCleanupPolicy, type Session } from "./room-manager.js";
import { RoomAutomationScheduler } from "./scheduler.js";
import { handleWebSocketMessage, type SocketClient } from "./websocket-transport.js";
import { RateLimitBuckets } from "./rate-limits.js";
import { SocketRegistry } from "./socket-registry.js";
import { WebSocketTicketStore } from "./websocket-tickets.js";
import { configuredSecret, externalBaseUrl, isDatabaseError, nonNegativeInt, positiveInt } from "./server-runtime.js";
import { registerHttpRoutes } from "./http-routes.js";
import { installGracefulShutdown } from "./process-lifecycle.js";

export { RoomManager, defaultRoomCleanupPolicy } from "./room-manager.js";
export { MemoryEventStore, PostgresEventStore } from "./event-store.js";
export { MemoryPresenceStore, RedisPresenceStore } from "./presence.js";
export { MetricsRegistry, createStructuredLogger, resolveInstanceMode } from "./observability.js";
export { RoomAutomationScheduler } from "./scheduler.js";
export { MemoryRoomOwnershipStore, PostgresRoomOwnershipStore, type RoomOwnershipStore } from "./ownership.js";

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
  presenceStaleMs?: number;
  presenceSweepIntervalMs?: number;
  sessionTtlMs?: number;
  roomOwnershipStore?: RoomOwnershipStore;
  roomOwnershipLeaseTtlMs?: number;
  presenceStore?: PresenceStore;
  adminToken?: string | null;
  logger?: StructuredLogger;
  metrics?: MetricsRegistry;
  nodeId?: string;
  instanceMode?: "single";
  allowTestRules?: boolean;
  trustedProxyHops?: number;
  rateLimits?: Partial<{
    sessionsPerMinutePerIp: number;
    wsTicketsPerMinutePerIp: number;
    roomCreationsPerMinutePerIp: number;
  }>;
}

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
    automationStallTickLimit: positiveInt(process.env.AUTOMATION_STALL_TICK_LIMIT, defaultRoomCleanupPolicy.automationStallTickLimit),
    maxAutomatedCommandsPerMinute: positiveInt(process.env.MAX_AUTOMATED_COMMANDS_PER_MINUTE, defaultRoomCleanupPolicy.maxAutomatedCommandsPerMinute),
    botTradeCooldownTurns: positiveInt(process.env.BOT_TRADE_COOLDOWN_TURNS, defaultRoomCleanupPolicy.botTradeCooldownTurns),
    ...options.roomCleanupPolicy,
  };
  const sessionTtlMs = options.sessionTtlMs ?? positiveInt(process.env.SESSION_TTL_MS, 30 * 24 * 60 * 60 * 1000);
  const adminToken = configuredSecret(options.adminToken === undefined ? process.env.ADMIN_TOKEN : options.adminToken);
  const allowTestRules = options.allowTestRules ?? process.env.ALLOW_TEST_RULES === "true";
  const rateLimits = {
    sessionsPerMinutePerIp: options.rateLimits?.sessionsPerMinutePerIp ?? 20,
    wsTicketsPerMinutePerIp: options.rateLimits?.wsTicketsPerMinutePerIp ?? 120,
    roomCreationsPerMinutePerIp: options.rateLimits?.roomCreationsPerMinutePerIp ?? 30,
  };
  let manager = options.manager;
  let ownershipStore = options.roomOwnershipStore;
  let pool: ReturnType<typeof createPool> | undefined;
  if (!manager && process.env.DATABASE_URL) {
    pool = createPool({ connectionString: process.env.DATABASE_URL });
    try {
      await runMigrations(pool);
    } catch (error) {
      metrics.recordDbFailure("migrations");
      logger.error("db.migrations_failed", { message: error instanceof Error ? error.message : String(error) });
      try {
        await pool.end();
      } catch (closeError) {
        metrics.recordDbFailure("pool_close");
        logger.error("db.pool_close_failed", { message: closeError instanceof Error ? closeError.message : String(closeError) });
      }
      throw error;
    }
    ownershipStore ??= new PostgresRoomOwnershipStore(pool);
    manager = new RoomManager(new PostgresEventStore(pool), {
      ...cleanupPolicy,
      sessionTtlMs,
      ownerId: nodeId,
      ownershipStore,
      diagnostics: metrics,
      ...(options.roomOwnershipLeaseTtlMs !== undefined ? { ownershipLeaseTtlMs: options.roomOwnershipLeaseTtlMs } : {}),
    });
    await manager.hydrateFromStore();
  }
  ownershipStore ??= new MemoryRoomOwnershipStore();
  manager ??= new RoomManager(undefined, {
    ...cleanupPolicy,
    sessionTtlMs,
    ownerId: nodeId,
    ownershipStore,
    diagnostics: metrics,
    ...(options.roomOwnershipLeaseTtlMs !== undefined ? { ownershipLeaseTtlMs: options.roomOwnershipLeaseTtlMs } : {}),
  });
  const presence: PresenceStore = options.presenceStore ?? await createPresenceStore(process.env.REDIS_URL, {
    onFallback: (error) => {
      metrics.recordDbFailure("presence_connect");
      logger.warn("presence.redis_unavailable", { message: error instanceof Error ? error.message : String(error), fallback: "memory" });
    },
  });
  const defaultAllowedOrigins = process.env.WEB_ORIGIN
    ? [process.env.WEB_ORIGIN]
    : ["http://127.0.0.1:5173", "http://localhost:5173"];
  const allowedOrigins = options.allowedOrigins ?? defaultAllowedOrigins;
  const allowLegacySessionToken = options.allowLegacySessionToken ?? false;
  const wsTicketTtlMs = options.wsTicketTtlMs ?? defaultWebSocketTicketTtlMs;
  const trustedProxyHops = options.trustedProxyHops ?? nonNegativeInt(process.env.TRUSTED_PROXY_HOPS, 0);
  const app = Fastify({ logger: false, bodyLimit: 32_000, ...(trustedProxyHops > 0 ? { trustProxy: trustedProxyHops } : {}) });
  const socketRegistry = new SocketRegistry();
  const wsTickets = new WebSocketTicketStore(wsTicketTtlMs);
  const requestStartedAt = new WeakMap<object, number>();
  const rateLimitBuckets = new RateLimitBuckets();

  const withinNamedLimit = (key: string, limit: number, windowMs: number, now?: number): boolean => {
    return rateLimitBuckets.allow(key, limit, windowMs, now);
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
    const failures = socketRegistry.broadcast(roomId, payloadFor);
    for (const failure of failures) {
      metrics.recordWebSocket("rejected", "broadcast_failed");
      logger.warn("websocket.broadcast_failed", {
        roomId,
        userId: failure.client.session.userId,
        message: failure.error instanceof Error ? failure.error.message : String(failure.error),
      });
    }
  };

  const detachClientFromRoom = (client: SocketClient, roomId = client.roomId): void => {
    socketRegistry.detach(client, roomId);
  };

  const attachClientToRoom = (client: SocketClient, roomId: string): void => {
    socketRegistry.attach(client, roomId);
  };

  const roomInviteUrl = (request: { headers: Record<string, unknown>; protocol?: string; hostname?: string } | undefined, room: Room): string => {
    const webUrl = (options.publicWebUrl ?? process.env.PUBLIC_WEB_URL ?? process.env.WEB_ORIGIN ?? (request ? externalBaseUrl(request) : allowedOrigins[0] ?? "http://127.0.0.1:5173")).replace(/\/$/, "");
    return `${webUrl}/?room=${encodeURIComponent(room.code)}`;
  };

  const publicRoomWithInvite = (
    request: { headers: Record<string, unknown>; protocol?: string; hostname?: string } | undefined,
    room: Room,
    viewerId: Session["userId"] | "spectator" = "spectator",
    includeChat = viewerId !== "spectator",
  ) => ({
    ...manager.publicRoom(room, viewerId, includeChat),
    inviteUrl: roomInviteUrl(request, room),
  });

  const broadcastRoomState = (room: Room): void => {
    broadcastRoom(room.id, (target) => ({ type: "ROOM_STATE", room: publicRoomWithInvite(undefined, room, viewerIdFor(target), true) }));
  };

  const closeRoomClients = (roomId: string, code: string, message: string): void => {
    for (const client of socketRegistry.roomClients(roomId)) {
      send(client, { type: "ERROR", code, message });
      socketRegistry.detach(client, roomId);
      client.socket.close(1000, message);
    }
  };

  const cleanupIntervalMs = options.roomCleanupIntervalMs ?? positiveInt(process.env.ROOM_CLEANUP_INTERVAL_MS, 30_000);
  const presenceStaleMs = options.presenceStaleMs ?? positiveInt(process.env.PRESENCE_STALE_MS, 300_000);
  const presenceSweepIntervalMs = options.presenceSweepIntervalMs ?? positiveInt(process.env.PRESENCE_SWEEP_INTERVAL_MS, 30_000);
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
        events: serializeEventsForViewer(result.events, viewerIdFor(target), result.state.playerOrder, result.state.phase.type === "GAME_OVER"),
        snapshot: snapshotFor(roomId, result.state, target),
        timer: manager.roomForRef(roomId)?.timer,
      }));
    },
    onAutomationRejected: (roomId, result) => {
      logger.warn("scheduler.automation_rejected", { roomId, code: result.code, message: result.message });
    },
    onRoomClosed: (closed) => {
      const code = closed.status === "EXPIRED" ? "ROOM_EXPIRED" : closed.status === "ABANDONED" ? "ROOM_ABANDONED" : "ROOM_CLOSED";
      closeRoomClients(closed.roomId, code, closed.cleanupReason ?? "Room closed");
    },
  });
  scheduler.start();

  const sweepStalePresence = async (): Promise<void> => {
    const staleSockets = await presence.sweepStale(presenceStaleMs);
    if (staleSockets.length === 0) return;
    const affectedRoomIds = new Set<string>();
    for (const stale of staleSockets) {
      if (stale.roomId) affectedRoomIds.add(stale.roomId);
      const client = socketRegistry.find(stale.socketId);
      if (!client) continue;
      socketRegistry.untrack(stale.socketId, client);
      metrics.recordWebSocket("closed", "presence_stale");
      client.socket.close(4000, "Presence stale");
    }
    for (const roomId of affectedRoomIds) {
      const room = await manager.syncConnections(roomId, await presence.roomUserIds(roomId));
      if (room) broadcastRoomState(room);
    }
  };

  const presenceSweepTimer = setInterval(() => {
    void sweepStalePresence().catch((error) => {
      metrics.recordDbFailure("presence_sweep");
      logger.error("presence.sweep_failed", { message: error instanceof Error ? error.message : String(error) });
    });
  }, presenceSweepIntervalMs);
  presenceSweepTimer.unref?.();

  const sweepTransientState = async (): Promise<void> => {
    wsTickets.sweep();
    rateLimitBuckets.sweep();
    socketRegistry.sweepEmptyRooms();
    await manager.sweepExpiredSessions();
  };

  const transientSweepTimer = setInterval(() => {
    void sweepTransientState().catch((error) => {
      metrics.recordDbFailure("session_sweep");
      logger.error("session.sweep_failed", { message: error instanceof Error ? error.message : String(error) });
    });
  }, Math.max(30_000, Math.min(wsTicketTtlMs, 60_000)));
  transientSweepTimer.unref?.();

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
    clearInterval(presenceSweepTimer);
    clearInterval(transientSweepTimer);
    scheduler.stop();
    const closeResults = await Promise.allSettled([presence.close(), pool?.end()]);
    const closeFailures = closeResults
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (closeFailures.length > 0) {
      throw new AggregateError(closeFailures, `Server cleanup failed: ${closeFailures.map(String).join("; ")}`);
    }
  });

  await app.register(cors, {
    credentials: true,
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) callback(null, true);
      else callback(null, false);
    },
  });
  await app.register(websocket, { options: { maxPayload: 32_000 } });

  const publicApiBaseUrl = options.publicApiBaseUrl ?? process.env.PUBLIC_API_URL;
  const publicWsBaseUrl = options.publicWsBaseUrl ?? process.env.PUBLIC_WS_URL;
  const publicWebUrl = options.publicWebUrl ?? process.env.PUBLIC_WEB_URL;
  const webOrigin = process.env.WEB_ORIGIN;
  registerHttpRoutes(app, {
    manager,
    metrics,
    logger,
    wsTickets,
    wsTicketTtlMs,
    allowedOrigins,
    nodeId,
    instanceMode,
    presenceKind: presence.kind,
    socketCount: () => socketRegistry.size(),
    allowTestRules,
    adminToken,
    rateLimits,
    withinNamedLimit,
    publicRoomWithInvite,
    ...(publicApiBaseUrl ? { publicApiBaseUrl } : {}),
    ...(publicWsBaseUrl ? { publicWsBaseUrl } : {}),
    ...(publicWebUrl ? { publicWebUrl } : {}),
    ...(webOrigin ? { webOrigin } : {}),
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
    const session = await wsTickets.consume(url.searchParams.get("ticket"), (token) => manager.resolveSession(token))
      ?? (allowLegacySessionToken ? await manager.resolveSession(url.searchParams.get("sessionToken") ?? undefined) : undefined);
    if (!session) {
      metrics.recordWebSocket("rejected", "unauthorized");
      logger.warn("websocket.rejected", { reason: "unauthorized" });
      socket.close(1008, "Unauthorized");
      return;
    }
    const client: SocketClient = { socket, session };
    const socketId = `sock_${nanoid(10)}`;
    let transitionTail = Promise.resolve();
    const enqueueConnectionTransition = (operation: () => void | Promise<void>): void => {
      transitionTail = transitionTail.then(operation).catch((error) => {
        metrics.recordWebSocket("rejected", "transition_failed");
        logger.error("websocket.transition_failed", {
          socketId,
          userId: session.userId,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    };
    socketRegistry.track(socketId, client);
    metrics.recordWebSocket("connected");
    logger.info("websocket.connected", { socketId, userId: session.userId });
    enqueueConnectionTransition(async () => {
      try {
        await presence.connect(session, socketId);
      } catch (error) {
        metrics.recordDbFailure("presence_connect");
        logger.warn("presence.connect_failed", {
          socketId,
          userId: session.userId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
    socket.on("close", () => {
      enqueueConnectionTransition(async () => {
        const { tracked, roomId } = socketRegistry.untrack(socketId, client);
        if (tracked) metrics.recordWebSocket("closed");
        logger.info("websocket.closed", { socketId, userId: session.userId, roomId });
        if (!roomId) return;
        let useLocalPresence = false;
        try {
          await presence.disconnect(session, socketId, roomId);
        } catch (error) {
          useLocalPresence = true;
          metrics.recordDbFailure("presence_disconnect");
          logger.warn("presence.disconnect_failed", {
            socketId,
            userId: session.userId,
            roomId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
        let connectedUserIds: Set<string>;
        if (useLocalPresence) {
          connectedUserIds = socketRegistry.roomUserIds(roomId);
        } else {
          try {
            connectedUserIds = await presence.roomUserIds(roomId);
          } catch (error) {
            metrics.recordDbFailure("presence_room_users");
            logger.warn("presence.room_users_failed", {
              socketId,
              userId: session.userId,
              roomId,
              message: error instanceof Error ? error.message : String(error),
            });
            connectedUserIds = socketRegistry.roomUserIds(roomId);
          }
        }
        try {
          const room = await manager.syncConnections(roomId, connectedUserIds);
          if (room) broadcastRoomState(room);
        } catch (error) {
          metrics.recordDbFailure("connection_sync");
          logger.error("presence.connection_sync_failed", {
            socketId,
            userId: session.userId,
            roomId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });
    });

    socket.on("message", (raw) => {
      const receivedAt = Date.now();
      enqueueConnectionTransition(() => handleWebSocketMessage(raw, {
        client,
        socketId,
        manager,
        presence,
        metrics,
        logger,
        withinNamedLimit,
        attachClientToRoom: (roomId) => attachClientToRoom(client, roomId),
        detachClientFromRoom: (roomId) => detachClientFromRoom(client, roomId),
        broadcastRoomState,
        broadcastAcceptedCommand: (roomId, result) => {
          broadcastRoom(roomId, (target) => ({
            type: "EVENTS",
            roomId,
            events: serializeEventsForViewer(result.events, viewerIdFor(target), result.state.playerOrder, result.state.phase.type === "GAME_OVER"),
            snapshot: snapshotFor(roomId, result.state, target),
            timer: manager.roomForRef(roomId)?.timer,
          }));
        },
        broadcastChat: (roomId, chat) => broadcastRoom(roomId, () => ({ type: "CHAT", roomId, chat })),
      }, receivedAt));
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

  installGracefulShutdown(app);
}
