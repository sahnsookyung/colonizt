// @vitest-environment jsdom
import { act, renderHook, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useNetworkRoom } from "../src/hooks/useNetworkRoom.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe("useNetworkRoom", () => {
  it("keeps connection ownership stable through UI updates", () => {
    const { result } = renderHook(() => useNetworkRoom());
    const controller = result.current.controller;
    act(() => { result.current.setNetworkRoomId("room_1"); result.current.setNetworkStatus("Looking up room…"); });
    expect(result.current.controller).toBe(controller);
    expect(result.current.networkRoomId).toBe("room_1");
    expect(result.current.networkStatus).toBe("Looking up room…");
    expect(result.current.connectionState).toBe("idle");
  });
  it("exposes one controller cursor instead of separate competing sequence counters", () => {
    const { result } = renderHook(() => useNetworkRoom());
    result.current.clientSeqRef.current=8;
    expect(result.current.controller.clientSeqRef.current).toBe(8);
    expect(result.current.lastServerSeqRef).toBe(result.current.controller.lastServerSeqRef);
    expect(result.current.pendingCommandCount).toBe(0);
  });
  it("disposes transport and lifecycle listeners when unmounted", () => {
    const { result, unmount } = renderHook(() => useNetworkRoom());
    const stop=vi.spyOn(result.current.controller,"stop");unmount();
    expect(stop).toHaveBeenCalledWith(false);
  });
});
