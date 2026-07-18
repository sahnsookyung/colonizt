import type { FastifyInstance } from "fastify";
import { schemaVersion, type PlayerId } from "@colonizt/game-core";
import {
  analyticsEventSchema,
  createRoomSchema,
  protocolVersion,
  websocketAuthMode,
} from "@colonizt/protocol";
import type { MetricsRegistry, StructuredLogger } from "./observability.js";
import { RoomCapacityError, type Room, type RoomManager, type Session } from "./room-manager.js";
import { externalBaseUrl } from "./server-runtime.js";
import type { WebSocketTicketStore } from "./websocket-tickets.js";

type RequestShape = {
  headers: Record<string, unknown>;
  protocol?: string;
  hostname?: string;
};

export interface HttpRouteContext {
  manager: RoomManager;
  metrics: MetricsRegistry;
  logger: StructuredLogger;
  wsTickets: WebSocketTicketStore;
  wsTicketTtlMs: number;
  allowedOrigins: string[];
  nodeId: string;
  instanceMode: "single";
  presenceKind: string;
  socketCount(): number;
  allowTestRules: boolean;
  adminToken: string | null | undefined;
  publicApiBaseUrl?: string;
  publicWsBaseUrl?: string;
  publicWebUrl?: string;
  webOrigin?: string;
  rateLimits: {
    sessionsPerMinutePerIp: number;
    wsTicketsPerMinutePerIp: number;
    roomCreationsPerMinutePerIp: number;
  };
  withinNamedLimit(key: string, limit: number, windowMs: number): boolean;
  publicRoomWithInvite(request: RequestShape | undefined, room: Room, viewerId?: PlayerId | "spectator"): unknown;
}

const tokenFromHeader = (authorization: unknown, namedToken: unknown): string | undefined => {
  if (typeof namedToken === "string") return namedToken;
  if (typeof authorization === "string" && authorization.startsWith("Bearer ")) return authorization.slice("Bearer ".length);
  return undefined;
};

const requireSession = async (manager: RoomManager, request: RequestShape): Promise<Session> => {
  const token = tokenFromHeader(request.headers.authorization, request.headers["x-session-token"]);
  const session = await manager.resolveSession(token);
  if (!session) throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
  return session;
};

export const registerHttpRoutes = (app: FastifyInstance, context: HttpRouteContext): void => {
  const {
    manager,
    metrics,
    logger,
    wsTickets,
    wsTicketTtlMs,
    allowedOrigins,
    nodeId,
    instanceMode,
    presenceKind,
    allowTestRules,
    adminToken,
    rateLimits,
    withinNamedLimit,
    publicRoomWithInvite,
  } = context;

  const clientIp = (request: { ip?: string }): string => request.ip ?? "unknown";
  const requireAdminToken = (request: RequestShape, reply: { status(code: number): { send(payload: unknown): unknown } }): boolean => {
    if (!adminToken) return true;
    const token = tokenFromHeader(request.headers.authorization, request.headers["x-admin-token"]);
    if (token === adminToken) return true;
    reply.status(403).send({ code: "FORBIDDEN", message: "Admin token required" });
    return false;
  };

  app.get("/health", async () => ({ ok: true, service: "colonizt-server", presence: presenceKind, nodeId, instanceMode }));

  app.get("/metrics", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    return reply.header("content-type", "text/plain; version=0.0.4; charset=utf-8").send(metrics.render(manager, context.socketCount(), presenceKind));
  });

  app.get("/admin/rooms/health", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    return { nodeId, instanceMode, generatedAt: new Date().toISOString(), rooms: manager.roomHealthReport() };
  });

  app.get("/config", async (request) => {
    const apiBaseUrl = externalBaseUrl(request, context.publicApiBaseUrl);
    const wsBaseUrl = (context.publicWsBaseUrl ?? apiBaseUrl.replace(/^http/i, "ws")).replace(/\/$/, "");
    return {
      schemaVersion,
      protocolVersion,
      apiBaseUrl,
      wsBaseUrl,
      webOrigin: context.publicWebUrl ?? context.webOrigin ?? allowedOrigins[0],
      auth: { webSocket: websocketAuthMode, ticketTtlMs: wsTicketTtlMs },
      nodeId,
      instanceMode,
    };
  });

  app.post<{ Body: { displayName?: string } }>("/sessions", async (request, reply) => {
    if (!withinNamedLimit(`ip:${clientIp(request)}:sessions`, rateLimits.sessionsPerMinutePerIp, 60_000)) {
      return reply.status(429).send({ code: "RATE_LIMITED", message: "Too many sessions" });
    }
    const displayName = typeof request.body.displayName === "string" ? request.body.displayName.trim().slice(0, 40) : "";
    return manager.createSession(displayName || "Guest");
  });

  app.post("/ws-tickets", async (request, reply) => {
    const session = await requireSession(manager, request);
    if (!withinNamedLimit(`session:${session.userId}:ws-tickets`, 60, 60_000)
      || !withinNamedLimit(`ip:${clientIp(request)}:ws-tickets`, rateLimits.wsTicketsPerMinutePerIp, 60_000)) {
      return reply.status(429).send({ code: "RATE_LIMITED", message: "Too many WebSocket tickets" });
    }
    const ticket = wsTickets.issue(session);
    return reply.status(201).send({ ticket: ticket.token, expiresAt: new Date(ticket.expiresAt).toISOString(), ttlMs: wsTicketTtlMs });
  });

  app.post("/analytics", async (request, reply) => {
    if (!withinNamedLimit(`ip:${clientIp(request)}:analytics`, 120, 60_000)) return reply.status(429).send({ code: "RATE_LIMITED" });
    const parsed = analyticsEventSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ code: "BAD_REQUEST", issues: parsed.error.issues });
    const token = tokenFromHeader(request.headers.authorization, request.headers["x-session-token"]);
    const session = token ? await manager.resolveSession(token) : undefined;
    await manager.recordAnalytics({
      eventName: parsed.data.eventName,
      payload: parsed.data.payload,
      ...(session ? { userId: session.userId } : {}),
      ...(parsed.data.matchId ? { matchId: parsed.data.matchId } : {}),
    });
    return reply.status(202).send({ ok: true });
  });

  app.get("/rooms", async (request, reply) => {
    if (!withinNamedLimit(`ip:${clientIp(request)}:room-list`, 120, 60_000)) return reply.status(429).send({ code: "RATE_LIMITED" });
    return [];
  });

  app.get<{ Params: { roomRef: string } }>("/rooms/:roomRef", async (request, reply) => {
    if (!withinNamedLimit(`ip:${clientIp(request)}:room-lookup`, 90, 60_000)) return reply.status(429).send({ code: "RATE_LIMITED" });
    const room = await manager.ensureRoomLoadedByRef(request.params.roomRef);
    if (room && !room.archivedAt && room.status !== "EXPIRED" && room.status !== "ABANDONED") return publicRoomWithInvite(request, room);
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
    if (!withinNamedLimit(`session:${session.userId}:room-create`, 12, 60_000)
      || !withinNamedLimit(`ip:${clientIp(request)}:room-create`, rateLimits.roomCreationsPerMinutePerIp, 60_000)) {
      return reply.status(429).send({ code: "RATE_LIMITED", message: "Too many room creation attempts" });
    }
    const parsed = createRoomSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ code: "BAD_REQUEST", issues: parsed.error.issues });
    const { minPlayers, maxPlayers, ...baseSettings } = parsed.data;
    const parsedSettings = {
      ...baseSettings,
      ...(minPlayers === undefined ? {} : { minPlayers }),
      ...(maxPlayers === undefined ? {} : { maxPlayers }),
    };
    const settings = parsedSettings.rules?.mapPreset
      ? { ...parsedSettings, rules: { ...parsedSettings.rules, mapRandomized: true } }
      : parsedSettings;
    if (!allowTestRules && (settings.rules?.maxTurns !== undefined || settings.rules?.maxTurnAdjudication !== undefined)) {
      return reply.status(400).send({ code: "TEST_RULES_DISABLED", message: "Turn-limit adjudication is available only for test and smoke rooms" });
    }
    try {
      return publicRoomWithInvite(request, await manager.createRoom(session, settings), session.userId);
    } catch (error) {
      if (error instanceof RoomCapacityError) return reply.status(503).send({ code: error.code, message: error.message });
      throw error;
    }
  });

  app.get<{ Params: { replayId: string } }>("/matches/:replayId/replay", async (request, reply) => {
    const session = await requireSession(manager, request);
    const replayResult = await manager.getFinishedReplayById(request.params.replayId);
    if (replayResult.status === "missing") {
      metrics.recordReplay("not_found");
      return reply.status(404).send({ code: "REPLAY_NOT_FOUND" });
    }
    if (replayResult.status === "not_finished") {
      metrics.recordReplay("not_ready");
      return reply.status(409).send({ code: "REPLAY_NOT_READY", message: "Replay is available after the game is finished" });
    }
    if (replayResult.status !== "finished" || !replayResult.replay) {
      metrics.recordReplay("not_found");
      return reply.status(404).send({ code: "REPLAY_NOT_FOUND" });
    }
    const storedReplay = replayResult.replay;
    if (!storedReplay.config.playerOrder.includes(session.userId)) {
      metrics.recordReplay("forbidden");
      return reply.status(403).send({ code: "REPLAY_FORBIDDEN" });
    }
    metrics.recordReplay("loaded");
    logger.info("replay.loaded", { replayId: request.params.replayId, userId: session.userId, eventCount: storedReplay.events.length });
    return storedReplay;
  });

  app.get("/leaderboard", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    return {
      mode: "CLASSIC",
      seasonId: "local-admin",
      rankedPublicQueue: "deferred",
      rows: [...manager.rooms.values()].flatMap((room) =>
        Object.values(room.game?.players ?? {}).map((player) => ({ userId: player.id, score: player.score, rating: 1000 + player.score * 25 }))),
    };
  });

  app.post<{ Params: { roomId: string }; Body: { reportedUserId?: string; reason?: string } }>("/rooms/:roomId/reports", async (request, reply) => {
    const session = await requireSession(manager, request);
    if (!withinNamedLimit(`session:${session.userId}:reports`, 10, 60_000)
      || !withinNamedLimit(`ip:${clientIp(request)}:reports`, 30, 60_000)) return reply.status(429).send({ code: "RATE_LIMITED" });
    const reportedUserId = typeof request.body.reportedUserId === "string" ? request.body.reportedUserId.trim() : "";
    const reason = typeof request.body.reason === "string" ? request.body.reason.trim() : "";
    if (!reportedUserId || reportedUserId.length > 120 || !reason || reason.length > 500) return reply.status(400).send({ code: "BAD_REQUEST" });
    const report = await manager.createReport(request.params.roomId, session, reportedUserId, reason);
    if (!report) return reply.status(404).send({ code: "REPORT_REJECTED" });
    return report;
  });
};
