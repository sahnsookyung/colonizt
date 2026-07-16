import type { GameCommand } from "@colonizt/game-core";
import { wsClientMessageSchema } from "@colonizt/protocol";
import type { MetricsRegistry, StructuredLogger } from "./observability.js";
import type { PresenceStore } from "./presence.js";
import type { CommandResult, Room, RoomManager, RoomSettings, Session } from "./room-manager.js";

export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message" | "close", listener: (...args: any[]) => void): void;
}

export type SocketClient = { socket: WebSocketLike; session: Session; roomId?: string; asSpectator?: boolean };

export const withinSlidingWindow = (timestamps: number[], limit: number, windowMs: number, now = Date.now()): boolean => {
  while (timestamps.length > 0 && timestamps[0]! < now - windowMs) timestamps.shift();
  if (timestamps.length >= limit) return false;
  timestamps.push(now);
  return true;
};

const withoutUndefined = <T extends Record<string, unknown>>(input: T): Partial<T> =>
  Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Partial<T>;

export interface WebSocketMessageContext {
  client: SocketClient;
  socketId: string;
  manager: RoomManager;
  presence: PresenceStore;
  metrics: MetricsRegistry;
  logger: StructuredLogger;
  commandTimes: number[];
  chatTimes: number[];
  withinNamedLimit(key: string, limit: number, windowMs: number): boolean;
  attachClientToRoom(roomId: string): void;
  detachClientFromRoom(roomId?: string): void;
  broadcastRoomState(room: Room): void;
  broadcastAcceptedCommand(roomId: string, result: Extract<CommandResult, { ok: true }>): void;
  broadcastChat(roomId: string, chat: unknown): void;
}

export const handleWebSocketMessage = (raw: { toString(): string }, context: WebSocketMessageContext): void => {
  const {
    client,
    socketId,
    manager,
    presence,
    metrics,
    logger,
    commandTimes,
    chatTimes,
  } = context;
  const { socket, session } = client;
  const send = (payload: unknown): void => socket.send(JSON.stringify(payload));
  const rawText = raw.toString();
  if (Buffer.byteLength(rawText) > 32_000) {
    socket.close(1009, "Message too large");
    return;
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawText);
  } catch {
    send({ type: "ERROR", code: "BAD_JSON" });
    return;
  }
  const parsed = wsClientMessageSchema.safeParse(parsedJson);
  if (!parsed.success) {
    send({ type: "ERROR", code: "BAD_MESSAGE", issues: parsed.error.issues });
    return;
  }

  const message = parsed.data;
  if (message.type === "PING") {
    void presence.refresh(session, socketId, client.roomId).catch((error) => {
      metrics.recordDbFailure("presence_refresh");
      logger.warn("presence.refresh_failed", {
        socketId,
        userId: session.userId,
        ...(client.roomId ? { roomId: client.roomId } : {}),
        message: error instanceof Error ? error.message : String(error),
      });
    });
    send({ type: "PONG", nonce: message.nonce });
    return;
  }
  if (message.type === "JOIN_ROOM") {
    if (!context.withinNamedLimit(`session:${session.userId}:join-room`, 30, 60_000)) {
      send({ type: "ERROR", code: "RATE_LIMITED", message: "Too many join attempts" });
      return;
    }
    const previousRoomId = client.roomId;
    void manager.joinRoom(message.roomId, session, message.asSpectator ?? false).then((joined) => {
      if (!joined.ok) {
        send({ type: "ERROR", code: joined.code, message: joined.message });
        return;
      }
      context.attachClientToRoom(joined.room.id);
      client.asSpectator = joined.room.spectators.has(session.userId) && !manager.isMember(joined.room, session.userId);
      context.broadcastRoomState(joined.room);
      void presence.joinRoom(session, socketId, joined.room.id).then(async () => {
        if (previousRoomId && previousRoomId !== joined.room.id) {
          const previous = await manager.syncConnections(previousRoomId, await presence.roomUserIds(previousRoomId));
          if (previous) context.broadcastRoomState(previous);
        }
        const synced = await manager.syncConnections(joined.room.id, await presence.roomUserIds(joined.room.id));
        context.broadcastRoomState(synced ?? joined.room);
      }).catch((error) => {
        metrics.recordDbFailure("presence_join");
        logger.warn("presence.join_failed", {
          socketId,
          userId: session.userId,
          roomId: joined.room.id,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }).catch((error) => send({ type: "ERROR", code: "JOIN_FAILED", message: error instanceof Error ? error.message : "Join failed" }));
    return;
  }
  if (message.type === "LEAVE_ROOM") {
    const canonicalRoomId = manager.roomForRef(message.roomId)?.id ?? client.roomId ?? message.roomId;
    void manager.leaveRoom(message.roomId, session).then((left) => {
      if (!left.ok) {
        send({ type: "ERROR", code: left.code, message: left.message });
        return;
      }
      context.detachClientFromRoom(left.room.id);
      client.asSpectator = false;
      void presence.disconnect(session, socketId, left.room.id).catch((error) => {
        metrics.recordDbFailure("presence_disconnect");
        logger.warn("presence.disconnect_failed", {
          socketId,
          userId: session.userId,
          roomId: left.room.id,
          message: error instanceof Error ? error.message : String(error),
        });
      });
      send({ type: "ROOM_LEFT", roomId: left.room.id });
      context.broadcastRoomState(left.room);
    }).catch((error) => send({ type: "ERROR", code: "LEAVE_FAILED", message: error instanceof Error ? error.message : "Leave failed", roomId: canonicalRoomId }));
    return;
  }
  if (message.type === "READY") {
    void manager.setReady(message.roomId, session, message.ready).then((ready) => {
      if (!ready.ok) send({ type: "ERROR", code: ready.code, message: ready.message });
      else context.broadcastRoomState(ready.room);
    }).catch((error) => send({ type: "ERROR", code: "READY_FAILED", message: error instanceof Error ? error.message : "Ready failed" }));
    return;
  }
  if (message.type === "START_ROOM") {
    void manager.startRoomByHost(message.roomId, session).then((started) => {
      if (!started.ok) send({ type: "ERROR", code: started.code, message: started.message });
      else context.broadcastRoomState(started.room);
    }).catch((error) => send({ type: "ERROR", code: "START_FAILED", message: error instanceof Error ? error.message : "Start failed" }));
    return;
  }
  if (message.type === "ADD_BOT") {
    void manager.addLobbyBot(message.roomId, session).then((added) => {
      if (!added.ok) send({ type: "ERROR", code: added.code, message: added.message });
      else context.broadcastRoomState(added.room);
    }).catch((error) => send({ type: "ERROR", code: "ADD_BOT_FAILED", message: error instanceof Error ? error.message : "Add bot failed" }));
    return;
  }
  if (message.type === "REMOVE_BOT") {
    void manager.removeLobbyBot(message.roomId, session, message.seatIndex).then((removed) => {
      if (!removed.ok) send({ type: "ERROR", code: removed.code, message: removed.message });
      else context.broadcastRoomState(removed.room);
    }).catch((error) => send({ type: "ERROR", code: "REMOVE_BOT_FAILED", message: error instanceof Error ? error.message : "Remove bot failed" }));
    return;
  }
  if (message.type === "UPDATE_ROOM_SETTINGS") {
    const settings: Partial<Omit<RoomSettings, "mode">> = {};
    if (message.settings.botFill !== undefined) settings.botFill = message.settings.botFill;
    if (message.settings.ranked !== undefined) settings.ranked = message.settings.ranked;
    if (message.settings.minPlayers !== undefined) settings.minPlayers = message.settings.minPlayers;
    if (message.settings.maxPlayers !== undefined) settings.maxPlayers = message.settings.maxPlayers;
    if (message.settings.botDifficulty !== undefined) settings.botDifficulty = message.settings.botDifficulty;
    if (message.settings.rules) settings.rules = withoutUndefined(message.settings.rules);
    void manager.updateRoomSettings(message.roomId, session, settings).then((updated) => {
      if (!updated.ok) send({ type: "ERROR", code: updated.code, message: updated.message });
      else context.broadcastRoomState(updated.room);
    }).catch((error) => send({ type: "ERROR", code: "SETTINGS_FAILED", message: error instanceof Error ? error.message : "Settings update failed" }));
    return;
  }
  if (message.type === "UPDATE_DISPLAY_NAME") {
    void manager.updateDisplayName(session, message.displayName, client.roomId).then(() => {
      if (!client.roomId) return;
      const room = manager.roomForRef(client.roomId);
      if (room) context.broadcastRoomState(room);
    }).catch((error) => send({ type: "ERROR", code: "NAME_FAILED", message: error instanceof Error ? error.message : "Name update failed" }));
    return;
  }
  if (message.type === "COMMAND") {
    const commandStartedAt = Date.now();
    if (!withinSlidingWindow(commandTimes, 30, 10_000, commandStartedAt)) {
      metrics.recordCommand("rejected", message.command.type, Date.now() - commandStartedAt);
      logger.warn("command.rejected", { code: "RATE_LIMITED", userId: session.userId, command: message.command.type });
      send({ type: "COMMAND_REJECTED", code: "RATE_LIMITED", message: "Too many commands", clientSeq: message.clientSeq });
      return;
    }
    const canonicalRoomId = manager.roomForRef(message.roomId)?.id ?? message.roomId;
    void manager.submitCommand(canonicalRoomId, session, message.clientSeq, message.command as GameCommand).then((result) => {
      if (!result.ok) {
        metrics.recordCommand("rejected", message.command.type, Date.now() - commandStartedAt);
        logger.warn("command.rejected", { code: result.code, userId: session.userId, roomId: canonicalRoomId, command: message.command.type });
        send({ type: "COMMAND_REJECTED", code: result.code, message: result.message, clientSeq: message.clientSeq });
        return;
      }
      if (result.replayed) {
        metrics.recordCommand("replayed", message.command.type, Date.now() - commandStartedAt);
        logger.info("command.replayed", { userId: session.userId, roomId: canonicalRoomId, command: message.command.type, clientSeq: message.clientSeq });
        send({ type: "COMMAND_ACK", roomId: canonicalRoomId, clientSeq: message.clientSeq, seqStart: result.seqStart, seqEnd: result.seqEnd });
        return;
      }
      metrics.recordCommand("accepted", message.command.type, Date.now() - commandStartedAt);
      logger.info("command.accepted", { userId: session.userId, roomId: canonicalRoomId, command: message.command.type, events: result.events.length });
      try {
        context.broadcastAcceptedCommand(canonicalRoomId, result);
      } catch (error) {
        metrics.recordWebSocket("rejected", "broadcast_failed");
        logger.error("command.broadcast_failed", {
          userId: session.userId,
          roomId: canonicalRoomId,
          command: message.command.type,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }).catch((error) => {
      metrics.recordCommand("rejected", message.command.type, Date.now() - commandStartedAt);
      metrics.recordDbFailure("command");
      logger.error("command.failed", { userId: session.userId, roomId: canonicalRoomId, command: message.command.type, message: error instanceof Error ? error.message : String(error) });
      send({ type: "COMMAND_REJECTED", code: "COMMAND_FAILED", message: error instanceof Error ? error.message : "Command failed", clientSeq: message.clientSeq });
    });
    return;
  }
  if (message.type === "CHAT") {
    if (!withinSlidingWindow(chatTimes, 6, 10_000)) {
      send({ type: "ERROR", code: "RATE_LIMITED", message: "Too many chat messages" });
      return;
    }
    const canonicalRoomId = manager.roomForRef(message.roomId)?.id ?? message.roomId;
    void manager.addChat(message.roomId, session, message.message).then((chat) => {
      if (!chat) send({ type: "ERROR", code: "CHAT_REJECTED" });
      else context.broadcastChat(canonicalRoomId, chat);
    }).catch((error) => send({ type: "ERROR", code: "CHAT_FAILED", message: error instanceof Error ? error.message : "Chat failed" }));
    return;
  }
  if (message.type === "RESYNC") {
    const canonicalRoomId = manager.roomForRef(message.roomId)?.id ?? message.roomId;
    void manager.resync(message.roomId, session, message.lastSeq).then((resync) => {
      send(resync ? { type: "RESYNC", roomId: canonicalRoomId, ...resync } : { type: "ERROR", code: "RESYNC_FAILED" });
    }).catch((error) => send({ type: "ERROR", code: "RESYNC_FAILED", message: error instanceof Error ? error.message : "Resync failed" }));
  }
};
