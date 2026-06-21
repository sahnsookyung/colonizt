import { describe, expect, it, vi } from "vitest";
import type { CommandResult } from "../src/room-manager.js";
import { MemoryEventStore } from "../src/event-store.js";
import { MetricsRegistry, createStructuredLogger } from "../src/observability.js";
import { defaultRoomCleanupPolicy, RoomManager } from "../src/room-manager.js";
import { RoomAutomationScheduler } from "../src/scheduler.js";

const silentLogger = createStructuredLogger("test", "single", () => undefined);

describe("RoomAutomationScheduler", () => {
  it("starts and stops interval ownership idempotently", () => {
    vi.useFakeTimers();
    const scheduler = new RoomAutomationScheduler({
      manager: new RoomManager(),
      cleanupPolicy: defaultRoomCleanupPolicy,
      cleanupIntervalMs: 5000,
      logger: silentLogger,
      metrics: new MetricsRegistry("test", "single"),
      onEvents: () => undefined,
      onRoomClosed: () => undefined,
    });

    scheduler.start();
    scheduler.start();
    scheduler.stop();
    scheduler.stop();

    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("broadcasts due turn expiry events through the callback", async () => {
    const manager = new RoomManager();
    const session = await manager.createSession("Host");
    const room = await manager.createRoom(session, { mode: "CLASSIC", botFill: true, ranked: false });
    await manager.setReady(room.id, session, true);
    if (!room.timer) throw new Error("missing room timer");
    room.timer.expiresAt = Date.now() - 1;
    manager.refreshRoomDueWork(room.id);
    const events: Array<{ roomId: string; result: Extract<CommandResult, { ok: true }> }> = [];
    const scheduler = new RoomAutomationScheduler({
      manager,
      cleanupPolicy: defaultRoomCleanupPolicy,
      logger: silentLogger,
      metrics: new MetricsRegistry("test", "single"),
      onEvents: (roomId, result) => events.push({ roomId, result }),
      onRoomClosed: () => undefined,
    });

    await scheduler.tickAutomation();

    expect(events[0]?.roomId).toBe(room.id);
    expect(events[0]?.result.events.length).toBeGreaterThan(0);
  });

  it("uses due room work instead of scanning every active room", async () => {
    const manager = new RoomManager();
    const session = await manager.createSession("Host");
    const dueRoom = await manager.createRoom(session, { mode: "CLASSIC", botFill: true, ranked: false });
    await manager.setReady(dueRoom.id, session, true);
    await manager.syncConnections(dueRoom.id, new Set([session.userId]));
    if (!dueRoom.timer) throw new Error("missing due timer");
    dueRoom.timer.expiresAt = Date.now() - 1;
    manager.refreshRoomDueWork(dueRoom.id);

    const idleSession = await manager.createSession("Idle");
    const idleRoom = await manager.createRoom(idleSession, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 4 });

    expect(manager.dueAutomationRoomIds()).toContain(dueRoom.id);
    expect(manager.dueAutomationRoomIds()).not.toContain(idleRoom.id);
  });

  it("reports rejected bot automation through the rejection callback", async () => {
    const manager = new RoomManager();
    vi.spyOn(manager, "dueAutomationRoomIds").mockReturnValue(["room_bad"]);
    vi.spyOn(manager, "expireTurn").mockResolvedValue(undefined);
    vi.spyOn(manager, "runDueBotAutomation").mockResolvedValue({ ok: false, code: "BAD_BOT_COMMAND", message: "bad bot command" });
    vi.spyOn(manager, "refreshRoomDueWork").mockImplementation(() => undefined);
    vi.spyOn(manager, "nextAutomationDueAt").mockReturnValue(undefined);
    const rejected: Array<{ roomId: string; result: Extract<CommandResult, { ok: false }> }> = [];
    const scheduler = new RoomAutomationScheduler({
      manager,
      cleanupPolicy: defaultRoomCleanupPolicy,
      logger: silentLogger,
      metrics: new MetricsRegistry("test", "single"),
      onEvents: () => undefined,
      onAutomationRejected: (roomId, result) => rejected.push({ roomId, result }),
      onRoomClosed: () => undefined,
    });

    await scheduler.tickAutomation();

    expect(rejected).toEqual([{ roomId: "room_bad", result: { ok: false, code: "BAD_BOT_COMMAND", message: "bad bot command" } }]);
  });

  it("reports cleaned rooms through the close callback", async () => {
    const manager = new RoomManager(new MemoryEventStore(), { emptyLobbyTtlMs: 1000 });
    const session = await manager.createSession("Host");
    const room = await manager.createRoom(session, { mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 4 });
    await manager.syncConnections(room.id, new Set(), 1000);
    const closed: Array<{ roomId: string; status: string; cleanupReason?: string }> = [];
    const scheduler = new RoomAutomationScheduler({
      manager,
      cleanupPolicy: { ...defaultRoomCleanupPolicy, emptyLobbyTtlMs: 1000 },
      logger: silentLogger,
      metrics: new MetricsRegistry("test", "single"),
      onEvents: () => undefined,
      onRoomClosed: (roomClosed) => closed.push(roomClosed),
    });

    await scheduler.tickCleanup();

    expect(closed).toEqual([{ roomId: room.id, code: room.code, status: "EXPIRED", cleanupReason: "EMPTY_LOBBY_TTL" }]);
  });
});
