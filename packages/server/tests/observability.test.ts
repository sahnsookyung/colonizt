import { describe, expect, it } from "vitest";
import { createStructuredLogger, MetricsRegistry, resolveInstanceMode } from "../src/observability.js";
import { RoomManager } from "../src/room-manager.js";

describe("observability", () => {
  it("renders command, replay, cleanup, websocket, and DB metrics", () => {
    const manager = new RoomManager();
    const metrics = new MetricsRegistry("node-a", "single");
    metrics.recordCommand("accepted", "ROLL_DICE", 12);
    metrics.recordCommand("rejected", "BUILD_ROAD", 2);
    metrics.recordReplay("loaded");
    metrics.recordDbFailure("append_events");
    metrics.recordRoomCleanup("EXPIRED", "EMPTY_LOBBY_TTL");
    metrics.recordWebSocket("connected");

    const rendered = metrics.render(manager, 1, "memory");
    expect(rendered).toContain('colonizt_commands_total{node_id="node-a",instance_mode="single",outcome="accepted",command="ROLL_DICE"} 1');
    expect(rendered).toContain('colonizt_commands_total{node_id="node-a",instance_mode="single",outcome="rejected",command="BUILD_ROAD"} 1');
    expect(rendered).toContain('colonizt_replay_loads_total{node_id="node-a",instance_mode="single",outcome="loaded"} 1');
    expect(rendered).toContain('colonizt_db_failures_total{node_id="node-a",instance_mode="single",operation="append_events"} 1');
    expect(rendered).toContain('colonizt_room_cleanup_total{node_id="node-a",instance_mode="single",status="EXPIRED",reason="EMPTY_LOBBY_TTL"} 1');
    expect(rendered).toContain('colonizt_websocket_events_total{node_id="node-a",instance_mode="single",event="connected",reason="none"} 1');
  });

  it("captures structured log records through an injected sink", () => {
    const records: unknown[] = [];
    const logger = createStructuredLogger("node-b", "single", (record) => records.push(record));
    logger.info("test.event", { value: 1 });
    expect(records).toMatchObject([{ level: "info", event: "test.event", nodeId: "node-b", instanceMode: "single", value: 1 }]);
  });

  it("enforces the documented single-authority instance mode", () => {
    expect(resolveInstanceMode("single")).toBe("single");
    expect(() => resolveInstanceMode("multi")).toThrow(/single-authority/);
  });
});
