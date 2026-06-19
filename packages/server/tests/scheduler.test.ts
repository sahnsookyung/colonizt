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
