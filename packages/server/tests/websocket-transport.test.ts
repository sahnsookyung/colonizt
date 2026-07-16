import { createDemoGame } from "@colonizt/test-utils";
import { describe, expect, it, vi } from "vitest";
import { MetricsRegistry, createStructuredLogger, type StructuredLogRecord } from "../src/observability.js";
import { MemoryPresenceStore } from "../src/presence.js";
import { RoomManager } from "../src/room-manager.js";
import { handleWebSocketMessage, withinSlidingWindow, type SocketClient, type WebSocketMessageContext } from "../src/websocket-transport.js";

const messageContext = (
  manager: RoomManager,
  client: SocketClient,
  logs: StructuredLogRecord[],
  overrides: Partial<WebSocketMessageContext> = {},
): WebSocketMessageContext => ({
  client,
  socketId: "socket-1",
  manager,
  presence: new MemoryPresenceStore(),
  metrics: new MetricsRegistry("test", "single"),
  logger: createStructuredLogger("test", "single", (record) => logs.push(record)),
  commandTimes: [],
  chatTimes: [],
  withinNamedLimit: () => true,
  attachClientToRoom: (roomId) => { client.roomId = roomId; },
  detachClientFromRoom: () => { delete client.roomId; },
  broadcastRoomState: vi.fn(),
  broadcastAcceptedCommand: vi.fn(),
  broadcastChat: vi.fn(),
  ...overrides,
});

const socketClient = (session: SocketClient["session"]) => {
  const send = vi.fn();
  const client: SocketClient = { socket: { send, close: vi.fn(), on: vi.fn() }, session };
  return { client, send };
};

describe("websocket sliding-window limiter", () => {
  it("expires every timestamp older than the active window, including epoch zero", () => {
    const timestamps = [0, 500, 1_000];
    expect(withinSlidingWindow(timestamps, 3, 1_000, 1_501)).toBe(true);
    expect(timestamps).toEqual([1_000, 1_501]);
  });

  it("retains the inclusive boundary and rejects without recording an extra attempt", () => {
    const timestamps = [1_000, 1_500];
    expect(withinSlidingWindow(timestamps, 2, 1_000, 2_000)).toBe(false);
    expect(timestamps).toEqual([1_000, 1_500]);
  });

  it("records an accepted attempt after pruning a full expired window", () => {
    const timestamps = [100, 200];
    expect(withinSlidingWindow(timestamps, 2, 1_000, 1_201)).toBe(true);
    expect(timestamps).toEqual([1_201]);
  });
});

describe("websocket message delivery boundaries", () => {
  it("uses message receipt time when applying a deferred join limit", async () => {
    const manager = new RoomManager();
    const session = await manager.createSession("Limited Player");
    const logs: StructuredLogRecord[] = [];
    const { client, send } = socketClient(session);
    const withinNamedLimit = vi.fn(() => false);

    handleWebSocketMessage(
      { toString: () => JSON.stringify({ type: "JOIN_ROOM", roomId: "ROOM01" }) },
      messageContext(manager, client, logs, { withinNamedLimit }),
      1_234,
    );

    expect(withinNamedLimit).toHaveBeenCalledWith(`session:${session.userId}:join-room`, 30, 60_000, 1_234);
    expect(send).toHaveBeenCalledWith(JSON.stringify({ type: "ERROR", code: "RATE_LIMITED", message: "Too many join attempts" }));
  });

  it("keeps heartbeat replies live while surfacing presence refresh failures", async () => {
    const manager = new RoomManager();
    const session = await manager.createSession("Player");
    const presence = new MemoryPresenceStore();
    vi.spyOn(presence, "refresh").mockRejectedValue(new Error("redis unavailable"));
    const metrics = new MetricsRegistry("test", "single");
    const logs: StructuredLogRecord[] = [];
    const { client, send } = socketClient(session);
    client.roomId = "room-a";

    handleWebSocketMessage(
      { toString: () => JSON.stringify({ type: "PING", nonce: "heartbeat" }) },
      messageContext(manager, client, logs, { presence, metrics }),
    );

    expect(send).toHaveBeenCalledWith(JSON.stringify({ type: "PONG", nonce: "heartbeat" }));
    await vi.waitFor(() => expect(logs).toContainEqual(expect.objectContaining({
      event: "presence.refresh_failed",
      roomId: "room-a",
      message: "redis unavailable",
    })));
    expect(metrics.render(manager, 1, presence.kind)).toContain('operation="presence_refresh"');
  });

  it("completes a durable room leave while surfacing presence disconnect failures", async () => {
    const manager = new RoomManager();
    const host = await manager.createSession("Host");
    const room = await manager.createRoom(host, { mode: "CLASSIC", botFill: false, ranked: false });
    const presence = new MemoryPresenceStore();
    vi.spyOn(presence, "disconnect").mockRejectedValue(new Error("redis unavailable"));
    const metrics = new MetricsRegistry("test", "single");
    const logs: StructuredLogRecord[] = [];
    const { client, send } = socketClient(host);
    client.roomId = room.id;
    const broadcastRoomState = vi.fn();

    handleWebSocketMessage(
      { toString: () => JSON.stringify({ type: "LEAVE_ROOM", roomId: room.id }) },
      messageContext(manager, client, logs, { presence, metrics, broadcastRoomState }),
    );

    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(JSON.stringify({ type: "ROOM_LEFT", roomId: room.id })));
    await vi.waitFor(() => expect(logs).toContainEqual(expect.objectContaining({
      event: "presence.disconnect_failed",
      roomId: room.id,
      message: "redis unavailable",
    })));
    expect(client.roomId).toBeUndefined();
    expect(broadcastRoomState).toHaveBeenCalledWith(expect.objectContaining({ id: room.id }));
    expect(metrics.render(manager, 1, presence.kind)).toContain('operation="presence_disconnect"');
  });

  it("broadcasts the authoritative join even when ephemeral presence fails", async () => {
    const manager = new RoomManager();
    const host = await manager.createSession("Host");
    const guest = await manager.createSession("Guest");
    const room = await manager.createRoom(host, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 2 });
    const presence = new MemoryPresenceStore();
    vi.spyOn(presence, "joinRoom").mockRejectedValue(new Error("redis unavailable"));
    const logs: StructuredLogRecord[] = [];
    const { client } = socketClient(guest);
    const broadcastRoomState = vi.fn();
    const context = messageContext(manager, client, logs, { presence, broadcastRoomState });

    handleWebSocketMessage({ toString: () => JSON.stringify({ type: "JOIN_ROOM", roomId: room.id }) }, context);

    await vi.waitFor(() => expect(broadcastRoomState).toHaveBeenCalledWith(expect.objectContaining({ id: room.id })));
    await vi.waitFor(() => expect(logs).toContainEqual(expect.objectContaining({ event: "presence.join_failed", roomId: room.id })));
    expect(client.roomId).toBe(room.id);
  });

  it("does not report a persisted command as rejected when its broadcast fails", async () => {
    const manager = new RoomManager();
    const session = await manager.createSession("Player");
    vi.spyOn(manager, "submitCommand").mockResolvedValue({ ok: true, events: [], state: createDemoGame("broadcast-failure") });
    const logs: StructuredLogRecord[] = [];
    const { client, send } = socketClient(session);
    const context = messageContext(manager, client, logs, {
      broadcastAcceptedCommand: () => { throw new Error("broadcast failed"); },
    });

    handleWebSocketMessage({
      toString: () => JSON.stringify({
        type: "COMMAND",
        roomId: "room-a",
        clientSeq: 1,
        command: { type: "END_TURN", playerId: session.userId },
      }),
    }, context);

    await vi.waitFor(() => expect(logs).toContainEqual(expect.objectContaining({ event: "command.broadcast_failed", roomId: "room-a" })));
    expect(send).not.toHaveBeenCalledWith(expect.stringContaining("COMMAND_REJECTED"));
    expect(logs).not.toContainEqual(expect.objectContaining({ event: "command.failed" }));
  });
});
