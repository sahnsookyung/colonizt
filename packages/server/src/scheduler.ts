import type { CommandResult, RoomCleanupPolicy, RoomManager } from "./room-manager.js";
import type { MetricsRegistry, StructuredLogger } from "./observability.js";

export interface RoomAutomationSchedulerOptions {
  manager: RoomManager;
  automationIntervalMs?: number;
  cleanupIntervalMs?: number;
  cleanupPolicy: RoomCleanupPolicy;
  logger: StructuredLogger;
  metrics: MetricsRegistry;
  onEvents(roomId: string, result: Extract<CommandResult, { ok: true }>): void;
  onAutomationRejected?(roomId: string, result: Extract<CommandResult, { ok: false }>): void;
  onRoomClosed(closed: { roomId: string; code: string; status: string; cleanupReason?: string }): void;
}

export class RoomAutomationScheduler {
  private automationTimer: ReturnType<typeof setTimeout> | undefined;
  private cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  private running = false;

  constructor(private readonly options: RoomAutomationSchedulerOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.options.logger.info("scheduler.started", {
      automationIntervalMs: this.options.automationIntervalMs ?? "due-work",
      cleanupIntervalMs: this.options.cleanupIntervalMs,
      cleanupPolicy: this.options.cleanupPolicy,
    });
    this.scheduleAutomation(0);
    this.scheduleCleanup(this.options.cleanupIntervalMs ?? 30_000);
  }

  private scheduleAutomation(delayMs: number): void {
    if (!this.running) return;
    this.automationTimer = setTimeout(() => {
      void this.tickAutomation().catch((error) => this.recordFailure("automation", error));
    }, delayMs);
    this.automationTimer.unref?.();
  }

  private scheduleCleanup(delayMs: number): void {
    if (!this.running) return;
    this.cleanupTimer = setTimeout(() => {
      void this.tickCleanup().catch((error) => this.recordFailure("cleanup", error));
    }, delayMs);
    this.cleanupTimer.unref?.();
  }

  stop(): void {
    this.running = false;
    if (this.automationTimer) clearTimeout(this.automationTimer);
    if (this.cleanupTimer) clearTimeout(this.cleanupTimer);
    this.automationTimer = undefined;
    this.cleanupTimer = undefined;
    this.options.logger.info("scheduler.stopped");
  }

  async tickAutomation(): Promise<void> {
    this.options.metrics.recordScheduler("automation_tick");
    const now = Date.now();
    for (const roomId of this.options.manager.dueAutomationRoomIds(now)) {
      try {
        const expired = await this.options.manager.expireTurn(roomId, now);
        if (expired?.ok && expired.events.length > 0) {
          this.options.metrics.recordScheduler("turn_expired");
          if (expired.events.some((event) => event.type === "TURN_ENDED")) this.options.metrics.recordScheduler("forced_end_turn");
          if (expired.events.some((event) => event.type === "TRADE_CLOSED" && event.reason === "RESPONSE_TIMEOUT")) this.options.metrics.recordScheduler("trade_timeout");
          this.options.onEvents(roomId, expired);
        } else if (expired && !expired.ok) {
          this.options.metrics.recordScheduler("turn_expiry_rejected");
          this.options.onAutomationRejected?.(roomId, expired);
        }
        const bot = await this.options.manager.runDueBotAutomation(roomId, now);
        if (bot?.ok && bot.events.length > 0) {
          this.options.metrics.recordScheduler("bot_automation");
          if (bot.events.some((event) => event.type === "TURN_ENDED")) this.options.metrics.recordScheduler("forced_end_turn");
          if (bot.events.some((event) => event.type === "TRADE_CLOSED" && event.reason === "RESPONSE_TIMEOUT")) this.options.metrics.recordScheduler("trade_timeout");
          this.options.onEvents(roomId, bot);
        } else if (bot && !bot.ok) {
          this.options.metrics.recordScheduler("bot_rejected");
          this.options.onAutomationRejected?.(roomId, bot);
        }
        if (this.options.manager.rooms.get(roomId)?.pauseReason === "STALLED_AUTOMATION") {
          this.options.metrics.recordScheduler("stalled_automation");
        }
      } finally {
        this.options.manager.refreshRoomDueWork(roomId, Date.now());
      }
    }
    const nextDue = this.options.manager.nextAutomationDueAt(Date.now());
    const fallback = this.options.automationIntervalMs ?? 1000;
    this.scheduleAutomation(nextDue ? Math.max(0, Math.min(nextDue - Date.now(), fallback)) : fallback);
  }

  async tickCleanup(): Promise<void> {
    this.options.metrics.recordScheduler("cleanup_tick");
    const now = Date.now();
    const dueRoomIds = this.options.manager.dueCleanupRoomIds(now);
    const closedRooms = await this.options.manager.cleanupRooms(now, dueRoomIds);
    for (const closed of closedRooms) {
      this.options.metrics.recordRoomCleanup(closed.status, closed.cleanupReason ?? "none");
      this.options.logger.info("room.cleaned", closed);
      this.options.onRoomClosed(closed);
    }
    for (const roomId of dueRoomIds) this.options.manager.refreshRoomDueWork(roomId, Date.now());
    const nextDue = this.options.manager.nextCleanupDueAt(Date.now());
    const fallback = this.options.cleanupIntervalMs ?? 30_000;
    this.scheduleCleanup(nextDue ? Math.max(0, Math.min(nextDue - Date.now(), fallback)) : fallback);
  }

  private recordFailure(operation: string, error: unknown): void {
    this.options.metrics.recordDbFailure(`scheduler_${operation}`);
    this.options.logger.error("scheduler.failed", {
      operation,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
