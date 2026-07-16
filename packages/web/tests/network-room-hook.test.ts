// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNetworkRoom } from "../src/hooks/useNetworkRoom.js";

describe("useNetworkRoom", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-14T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("schedules reconnects, fires them, and supports an immediate retry", () => {
    vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation((array) => {
      (array as Uint32Array)[0] = 0;
      return array;
    });
    const connect = vi.fn();
    const { result } = renderHook(() => useNetworkRoom());

    act(() => {
      expect(result.current.scheduleReconnect(connect)).toBe(true);
    });
    expect(result.current.networkStatus).toBe("Reconnecting in 1s");
    expect(result.current.reconnectRetryAt).toBe(Date.now() + 750);

    act(() => vi.advanceTimersByTime(750));
    expect(connect).toHaveBeenCalledTimes(1);
    expect(result.current.networkStatus).toBe("Reconnecting...");
    expect(result.current.reconnectRetryAt).toBeNull();

    act(() => {
      expect(result.current.scheduleReconnect(connect)).toBe(true);
      result.current.retryReconnectNow(connect);
    });
    expect(connect).toHaveBeenCalledTimes(2);
    expect(result.current.reconnectTimerRef.current).toBeNull();
  });

  it("uses unbiased jitter and pauses after the bounded retry budget", () => {
    let sample = 0;
    vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation((array) => {
      (array as Uint32Array)[0] = sample === 0 ? 0xffff_ffff : 7;
      sample += 1;
      return array;
    });
    const { result } = renderHook(() => useNetworkRoom());

    act(() => {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        expect(result.current.scheduleReconnect(vi.fn())).toBe(true);
      }
      expect(result.current.scheduleReconnect(vi.fn())).toBe(false);
    });
    expect(result.current.networkStatus).toBe("Reconnect paused");
    expect(result.current.shouldReconnectRef.current).toBe(false);

    act(() => {
      expect(result.current.scheduleReconnect(vi.fn())).toBe(false);
      result.current.resetReconnectState();
    });
    expect(result.current.reconnectAttemptRef.current).toBe(0);
    expect(result.current.reconnectRetryAt).toBeNull();
  });

  it("tracks pending commands with a defensive cap and clears them", () => {
    const { result } = renderHook(() => useNetworkRoom());

    act(() => {
      for (let count = 0; count < 120; count += 1) result.current.markCommandPending();
    });
    expect(result.current.pendingCommandCount).toBe(99);

    act(() => result.current.clearPendingCommands());
    expect(result.current.pendingCommandCount).toBe(0);
  });
});
