import { describe, expect, it } from "vitest";
import { createDemoReplayLog, replayAtIndex } from "../src/replay-state.js";

describe("replay state helpers", () => {
  it("creates deterministic replay logs and clamps replay indexes", () => {
    const log = createDemoReplayLog("test-replay", 12);
    expect(log.events.length).toBeGreaterThan(0);
    expect(replayAtIndex(log, -1).eventSeq).toBe(0);
    expect(replayAtIndex(log, log.events.length + 20).eventSeq).toBe(log.events.at(-1)?.seq ?? 0);
  });
});
