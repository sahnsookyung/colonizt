export interface RoomHealthPayload {
  nodeId: string;
  instanceMode: "single";
  generatedAt: string;
  rooms: Array<{
    roomId: string;
    status: string;
    liveness: string;
    pauseReason?: string;
    cleanupReason?: string;
    eventSeq?: number;
    turn?: number;
    phase?: string;
    connectedHumans: number;
    connectedUsers: number;
    botCount: number;
    spectatorCount: number;
  }>;
}

const diagnosticMetricNames = new Set([
  "colonizt_room_hydration_total",
  "colonizt_store_validation_failures_total",
  "colonizt_command_result_conflicts_total",
  "colonizt_automation_pauses_total",
  "colonizt_db_failures_total",
  "colonizt_room_liveness",
  "colonizt_room_pause_reasons",
]);

export const parseDiagnosticMetrics = (text: string): Record<string, number> => {
  const metrics: Record<string, number> = {};
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const match = /^(?<name>[a-zA-Z_:][a-zA-Z0-9_:]*)(?<labels>\{[^}]*\})?\s+(?<value>-?(?:\d+(?:\.\d+)?|\.\d+))$/u.exec(line.trim());
    if (!match?.groups || !diagnosticMetricNames.has(match.groups.name!)) continue;
    metrics[`${match.groups.name}${match.groups.labels ?? ""}`] = Number(match.groups.value);
  }
  return metrics;
};

export const buildOperatorDiagnostic = (health: RoomHealthPayload, metricsText: string) => {
  const liveness: Record<string, number> = {};
  const pauseReasons: Record<string, number> = {};
  for (const room of health.rooms) {
    liveness[room.liveness] = (liveness[room.liveness] ?? 0) + 1;
    if (room.pauseReason) pauseReasons[room.pauseReason] = (pauseReasons[room.pauseReason] ?? 0) + 1;
  }
  return {
    nodeId: health.nodeId,
    instanceMode: health.instanceMode,
    generatedAt: health.generatedAt,
    roomCount: health.rooms.length,
    liveness,
    pauseReasons,
    metrics: parseDiagnosticMetrics(metricsText),
    rooms: health.rooms,
  };
};
