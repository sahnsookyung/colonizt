import { describe, expect, it } from "vitest";
import { buildOperatorDiagnostic, parseDiagnosticMetrics } from "../src/operator-diagnostics.js";

describe("operator diagnostics", () => {
  const metrics = `
# HELP ignored ignored
colonizt_room_hydration_total{outcome="snapshot"} 3
colonizt_store_validation_failures_total{record_type="room"} 1
colonizt_command_result_conflicts_total{path="accepted"} 2
colonizt_http_requests_total{status="200"} 99
malformed
`;

  it("keeps only incident-relevant finite metric samples", () => {
    expect(parseDiagnosticMetrics(metrics)).toEqual({
      'colonizt_room_hydration_total{outcome="snapshot"}': 3,
      'colonizt_store_validation_failures_total{record_type="room"}': 1,
      'colonizt_command_result_conflicts_total{path="accepted"}': 2,
    });
  });

  it("combines hand-safe room health with diagnostic counters", () => {
    const report = buildOperatorDiagnostic({
      nodeId: "node-a",
      instanceMode: "single",
      generatedAt: "2026-07-15T00:00:00.000Z",
      rooms: [
        { roomId: "room-1", status: "IN_GAME", liveness: "STALLED", pauseReason: "STALLED_AUTOMATION", eventSeq: 4, turn: 2, phase: "ACTION_PHASE", connectedHumans: 1, connectedUsers: 1, botCount: 3, spectatorCount: 0 },
        { roomId: "room-2", status: "LOBBY", liveness: "IDLE_LOBBY", connectedHumans: 0, connectedUsers: 0, botCount: 0, spectatorCount: 0 },
      ],
    }, metrics);
    expect(report).toMatchObject({
      nodeId: "node-a", roomCount: 2,
      liveness: { STALLED: 1, IDLE_LOBBY: 1 },
      pauseReasons: { STALLED_AUTOMATION: 1 },
    });
    expect(JSON.stringify(report)).not.toMatch(/resources|developmentCards|hand/i);
  });
});
