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

  it("keeps scheduling automation after a transient tick failure", async () => {
    vi.useFakeTimers();
    const manager = new RoomManager();
    const dueWork = vi.spyOn(manager, "dueAutomationRoomIds")
      .mockImplementationOnce(() => { throw new Error("transient automation failure"); })
      .mockReturnValue([]);
    const scheduler = new RoomAutomationScheduler({
      manager,
      cleanupPolicy: defaultRoomCleanupPolicy,
      automationIntervalMs: 10,
      cleanupIntervalMs: 100_000,
      logger: silentLogger,
      metrics: new MetricsRegistry("test", "single"),
      onEvents: () => undefined,
      onRoomClosed: () => undefined,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10);

    expect(dueWork).toHaveBeenCalledTimes(2);
    scheduler.stop();
    vi.useRealTimers();
  });

  it("keeps scheduling cleanup after a transient tick failure", async () => {
    vi.useFakeTimers();
    const manager = new RoomManager();
    vi.spyOn(manager, "dueCleanupRoomIds").mockReturnValue(["room-failure"]);
    const cleanup = vi.spyOn(manager, "cleanupRooms")
      .mockRejectedValueOnce(new Error("transient cleanup failure"))
      .mockResolvedValue([]);
    const scheduler = new RoomAutomationScheduler({
      manager,
      cleanupPolicy: defaultRoomCleanupPolicy,
      automationIntervalMs: 100_000,
      cleanupIntervalMs: 10,
      logger: silentLogger,
      metrics: new MetricsRegistry("test", "single"),
      onEvents: () => undefined,
      onRoomClosed: () => undefined,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(10);

    expect(cleanup).toHaveBeenCalledTimes(2);
    scheduler.stop();
    vi.useRealTimers();
  });

  it("keeps scheduling cleanup when due-work discovery fails", async () => {
    vi.useFakeTimers();
    const manager = new RoomManager();
    const dueWork = vi.spyOn(manager, "dueCleanupRoomIds")
      .mockImplementationOnce(() => { throw new Error("cleanup index unavailable"); })
      .mockReturnValue([]);
    const scheduler = new RoomAutomationScheduler({
      manager,
      cleanupPolicy: defaultRoomCleanupPolicy,
      automationIntervalMs: 100_000,
      cleanupIntervalMs: 10,
      logger: silentLogger,
      metrics: new MetricsRegistry("test", "single"),
      onEvents: () => undefined,
      onRoomClosed: () => undefined,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(10);

    expect(dueWork).toHaveBeenCalledTimes(2);
    scheduler.stop();
    vi.useRealTimers();
  });

  it("continues processing and requeues later automation rooms after one room fails", async () => {
    const manager = new RoomManager();
    vi.spyOn(manager, "dueAutomationRoomIds").mockReturnValue(["room-first", "room-second"]);
    const expireTurn = vi.spyOn(manager, "expireTurn").mockImplementation(async (roomId) => {
      if (roomId === "room-first") throw new Error("first room failed");
      return undefined;
    });
    const runBots = vi.spyOn(manager, "runDueBotAutomation").mockResolvedValue(undefined);
    const refresh = vi.spyOn(manager, "refreshRoomDueWork").mockImplementation(() => undefined);
    vi.spyOn(manager, "nextAutomationDueAt").mockReturnValue(undefined);
    const scheduler = new RoomAutomationScheduler({
      manager,
      cleanupPolicy: defaultRoomCleanupPolicy,
      logger: silentLogger,
      metrics: new MetricsRegistry("test", "single"),
      onEvents: () => undefined,
      onRoomClosed: () => undefined,
    });

    await scheduler.tickAutomation();

    expect(expireTurn).toHaveBeenCalledWith("room-second", expect.any(Number));
    expect(runBots).toHaveBeenCalledWith("room-second", expect.any(Number));
    expect(refresh.mock.calls.map(([roomId]) => roomId)).toEqual(["room-first", "room-second"]);
  });

  it("continues cleanup after one claimed room fails and requeues every claim", async () => {
    const manager = new RoomManager();
    vi.spyOn(manager, "dueCleanupRoomIds").mockReturnValue(["room-first", "room-second"]);
    const cleanup = vi.spyOn(manager, "cleanupRooms").mockImplementation(async (_now, roomIds) => {
      if (roomIds[0] === "room-first") throw new Error("first cleanup failed");
      return [{ roomId: "room-second", code: "SECOND", status: "EXPIRED", cleanupReason: "EMPTY_LOBBY_TTL" }];
    });
    const refresh = vi.spyOn(manager, "refreshRoomDueWork").mockImplementation(() => undefined);
    vi.spyOn(manager, "nextCleanupDueAt").mockReturnValue(undefined);
    const closed: string[] = [];
    const scheduler = new RoomAutomationScheduler({
      manager,
      cleanupPolicy: defaultRoomCleanupPolicy,
      logger: silentLogger,
      metrics: new MetricsRegistry("test", "single"),
      onEvents: () => undefined,
      onRoomClosed: (room) => closed.push(room.roomId),
    });

    await scheduler.tickCleanup();

    expect(cleanup.mock.calls.map(([, roomIds]) => roomIds)).toEqual([["room-first"], ["room-second"]]);
    expect(refresh.mock.calls.map(([roomId]) => roomId)).toEqual(["room-first", "room-second"]);
    expect(closed).toEqual(["room-second"]);
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

  it("reports rejected turn expiry through the rejection callback", async () => {
    const manager = new RoomManager();
    vi.spyOn(manager, "dueAutomationRoomIds").mockReturnValue(["room_bad_timeout"]);
    vi.spyOn(manager, "expireTurn").mockResolvedValue({ ok: false, code: "BAD_TIMEOUT_COMMAND", message: "bad timeout command" });
    vi.spyOn(manager, "runDueBotAutomation").mockResolvedValue(undefined);
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

    expect(rejected).toEqual([{ roomId: "room_bad_timeout", result: { ok: false, code: "BAD_TIMEOUT_COMMAND", message: "bad timeout command" } }]);
  });

  it("backs off instead of immediately spinning on rejected overdue automation", async () => {
    vi.useFakeTimers();
    const manager = new RoomManager();
    vi.spyOn(manager, "dueAutomationRoomIds").mockReturnValue(["room_overdue"]);
    const expireTurn = vi.spyOn(manager, "expireTurn").mockResolvedValue({ ok: false, code: "EVENT_COMMIT_FAILED", message: "database unavailable" });
    vi.spyOn(manager, "runDueBotAutomation").mockResolvedValue(undefined);
    vi.spyOn(manager, "refreshRoomDueWork").mockImplementation(() => undefined);
    vi.spyOn(manager, "nextAutomationDueAt").mockReturnValue(0);
    const scheduler = new RoomAutomationScheduler({
      manager,
      cleanupPolicy: defaultRoomCleanupPolicy,
      automationIntervalMs: 100,
      cleanupIntervalMs: 100_000,
      logger: silentLogger,
      metrics: new MetricsRegistry("test", "single"),
      onEvents: () => undefined,
      onRoomClosed: () => undefined,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(expireTurn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(expireTurn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(expireTurn).toHaveBeenCalledTimes(2);

    scheduler.stop();
    vi.useRealTimers();
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
