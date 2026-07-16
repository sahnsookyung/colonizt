import type { RoomManager } from "./room-manager.js";
import type { HydrationOutcome, RoomDiagnostics } from "./room-diagnostics.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface StructuredLogRecord {
  level: LogLevel;
  event: string;
  at: string;
  nodeId: string;
  instanceMode: "single";
  [key: string]: unknown;
}

export interface StructuredLogger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export const resolveInstanceMode = (value = process.env.INSTANCE_MODE ?? "single"): "single" => {
  if (value === "single") return "single";
  throw new Error(`Unsupported INSTANCE_MODE "${value}". Colonizt currently supports single-authority room ownership only.`);
};

export const createStructuredLogger = (
  nodeId = process.env.NODE_ID ?? "local",
  instanceMode: "single" = "single",
  sink: (record: StructuredLogRecord) => void = (record) => {
    if (process.env.NODE_ENV === "test") return;
    const target = record.level === "error" ? console.error : record.level === "warn" ? console.warn : console.info;
    target(JSON.stringify(record));
  },
): StructuredLogger => {
  const log = (level: LogLevel, event: string, fields: Record<string, unknown> = {}) => {
    sink({ level, event, at: new Date().toISOString(), nodeId, instanceMode, ...fields });
  };
  return {
    debug: (event, fields) => log("debug", event, fields),
    info: (event, fields) => log("info", event, fields),
    warn: (event, fields) => log("warn", event, fields),
    error: (event, fields) => log("error", event, fields),
  };
};

type CommandOutcome = "accepted" | "rejected" | "replayed";
type ReplayOutcome = "loaded" | "not_found" | "not_ready" | "forbidden";
type WebSocketEvent = "connected" | "closed" | "rejected";

const metricLine = (name: string, labels: Record<string, string>, value: number): string => {
  const labelText = Object.entries(labels)
    .map(([key, labelValue]) => `${key}="${labelValue.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`)
    .join(",");
  return `${name}{${labelText}} ${Number.isFinite(value) ? value : 0}`;
};

export class MetricsRegistry implements RoomDiagnostics {
  private readonly counters = new Map<string, number>();
  private commandLatencyTotalMs = 0;
  private commandLatencyCount = 0;

  constructor(
    private readonly nodeId = process.env.NODE_ID ?? "local",
    private readonly instanceMode: "single" = "single",
  ) {}

  recordHttpRequest(method: string, route: string, statusCode: number, durationMs: number): void {
    this.increment("http_requests_total", { method, route, status: String(statusCode) });
    this.increment("http_request_duration_ms_total", { method, route }, durationMs);
  }

  recordWebSocket(event: WebSocketEvent, reason = "none"): void {
    this.increment("websocket_events_total", { event, reason });
  }

  recordCommand(outcome: CommandOutcome, commandType: string, durationMs: number): void {
    this.increment("commands_total", { outcome, command: commandType });
    if (outcome !== "rejected") {
      this.commandLatencyTotalMs += durationMs;
      this.commandLatencyCount += 1;
    }
  }

  recordReplay(outcome: ReplayOutcome): void {
    this.increment("replay_loads_total", { outcome });
  }

  recordDbFailure(operation: string): void {
    this.increment("db_failures_total", { operation });
  }

  recordRoomCleanup(status: string, reason = "none"): void {
    this.increment("room_cleanup_total", { status, reason });
  }

  recordScheduler(event: string): void {
    this.increment("scheduler_events_total", { event });
  }

  recordHydration(outcome: HydrationOutcome): void {
    this.increment("room_hydration_total", { outcome });
  }

  recordStoreValidationFailure(recordType: "room" | "command_result"): void {
    this.increment("store_validation_failures_total", { record_type: recordType });
  }

  recordCommandConflict(path: "accepted" | "rejected"): void {
    this.increment("command_result_conflicts_total", { path });
  }

  recordAutomationPause(reason: "budget" | "stalled"): void {
    this.increment("automation_pauses_total", { reason });
  }

  render(manager: RoomManager, socketCount: number, presenceKind: string): string {
    const labels = { node_id: this.nodeId, instance_mode: this.instanceMode };
    const lines = [
      "# HELP colonizt_active_rooms Active in-memory rooms.",
      "# TYPE colonizt_active_rooms gauge",
      metricLine("colonizt_active_rooms", labels, manager.activeRoomCount()),
      "# HELP colonizt_websocket_clients Connected WebSocket clients.",
      "# TYPE colonizt_websocket_clients gauge",
      metricLine("colonizt_websocket_clients", labels, socketCount),
      "# HELP colonizt_presence_adapter Presence adapter kind.",
      "# TYPE colonizt_presence_adapter gauge",
      metricLine("colonizt_presence_adapter", { ...labels, kind: presenceKind }, 1),
      "# HELP colonizt_room_liveness Active room liveness states.",
      "# TYPE colonizt_room_liveness gauge",
      ...Object.entries(manager.livenessCounts()).map(([state, count]) => metricLine("colonizt_room_liveness", { ...labels, state }, count)),
      "# HELP colonizt_room_pause_reasons Active room pause reasons.",
      "# TYPE colonizt_room_pause_reasons gauge",
      ...Object.entries(manager.pauseReasonCounts()).map(([reason, count]) => metricLine("colonizt_room_pause_reasons", { ...labels, reason }, count)),
      "# HELP colonizt_command_latency_ms Average accepted/replayed command latency.",
      "# TYPE colonizt_command_latency_ms gauge",
      metricLine("colonizt_command_latency_ms", labels, this.commandLatencyCount > 0 ? this.commandLatencyTotalMs / this.commandLatencyCount : 0),
    ];
    for (const [key, value] of [...this.counters.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const parsed = JSON.parse(key) as { name: string; labels: Record<string, string> };
      lines.push(metricLine(`colonizt_${parsed.name}`, { ...labels, ...parsed.labels }, value));
    }
    return `${lines.join("\n")}\n`;
  }

  private increment(name: string, labels: Record<string, string>, amount = 1): void {
    const key = JSON.stringify({ name, labels });
    this.counters.set(key, (this.counters.get(key) ?? 0) + amount);
  }
}
