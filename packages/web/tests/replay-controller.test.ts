// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createDemoReplayLog } from "../src/replay-state.js";
import { useReplayController } from "../src/hooks/useReplayController.js";

describe("useReplayController", () => {
  it("starts at the live edge, clamps stepping, and clears replay state", () => {
    const log = createDemoReplayLog("replay-controller", 6);
    const { result } = renderHook(() => useReplayController());

    expect(result.current.isReplaying).toBe(false);
    expect(result.current.visibleEvents).toEqual([]);

    act(() => result.current.start(log));
    expect(result.current.index).toBe(log.events.length);
    expect(result.current.state?.eventSeq).toBe(log.events.at(-1)?.seq ?? 0);
    expect(result.current.visibleEvents).toEqual(log.events);

    const shorterLog = { ...log, events: log.events.slice(0, 1) };
    act(() => result.current.replaceIfActive(shorterLog));
    expect(result.current.index).toBe(shorterLog.events.length);

    act(() => result.current.step(-100_000));
    expect(result.current.index).toBe(0);
    expect(result.current.visibleEvents).toEqual([]);

    act(() => result.current.step(100_000));
    expect(result.current.index).toBe(shorterLog.events.length);

    act(() => result.current.exit());
    expect(result.current).toMatchObject({ log: null, index: null, state: null, isReplaying: false });
  });

  it("ignores stepping until a replay has started", () => {
    const { result } = renderHook(() => useReplayController());
    act(() => result.current.step(1));
    act(() => result.current.replaceIfActive(createDemoReplayLog("ignored-replacement", 2)));
    expect(result.current.index).toBeNull();
    expect(result.current.log).toBeNull();
  });
});
