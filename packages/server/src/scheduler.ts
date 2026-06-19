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
  onRoomClosed(closed: { roomId: string; code: string; status: string; cleanupReason?: string }): void;
}

export class RoomAutomationScheduler {
  private automationInterval: ReturnType<typeof setInterval> | undefined;
  private cleanupInterval: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: RoomAutomationSchedulerOptions) {}

  start(): void {
    if (this.automationInterval || this.cleanupInterval) return;
    this.options.logger.info("scheduler.started", {
      automationIntervalMs: this.options.automationIntervalMs ?? 1000,
      cleanupIntervalMs: this.options.cleanupIntervalMs,
      cleanupPolicy: this.options.cleanupPolicy,
    });
    this.automationInterval = setInterval(() => {
      void this.tickAutomation().catch((error) => this.recordFailure("automation", error));
    }, this.options.automationIntervalMs ?? 1000);
    this.automationInterval.unref?.();

    this.cleanupInterval = setInterval(() => {
      void this.tickCleanup().catch((error) => this.recordFailure("cleanup", error));
    }, this.options.cleanupIntervalMs ?? 30_000);
    this.cleanupInterval.unref?.();
  }

  stop(): void {
    if (this.automationInterval) clearInterval(this.automationInterval);
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    this.automationInterval = undefined;
    this.cleanupInterval = undefined;
    this.options.logger.info("scheduler.stopped");
  }

  async tickAutomation(): Promise<void> {
    this.options.metrics.recordScheduler("automation_tick");
    for (const room of this.options.manager.rooms.values()) {
      const expired = await this.options.manager.expireTurn(room.id);
      if (expired?.ok && expired.events.length > 0) {
        this.options.metrics.recordScheduler("turn_expired");
        this.options.onEvents(room.id, expired);
      }
      const bot = await this.options.manager.runDueBotAutomation(room.id);
      if (bot?.ok && bot.events.length > 0) {
        this.options.metrics.recordScheduler("bot_automation");
        this.options.onEvents(room.id, bot);
      }
    }
  }

  async tickCleanup(): Promise<void> {
    this.options.metrics.recordScheduler("cleanup_tick");
    const closedRooms = await this.options.manager.cleanupRooms();
    for (const closed of closedRooms) {
      this.options.metrics.recordRoomCleanup(closed.status);
      this.options.logger.info("room.cleaned", closed);
      this.options.onRoomClosed(closed);
    }
  }

  private recordFailure(operation: string, error: unknown): void {
    this.options.metrics.recordDbFailure(`scheduler_${operation}`);
    this.options.logger.error("scheduler.failed", {
      operation,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
