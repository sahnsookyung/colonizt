// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { completeSetup, createDemoGame } from "@colonizt/demo-state";
import { turnDeadlineKey, useTurnTimer } from "../src/hooks/useTurnTimer.js";

describe("turn deadline identity", () => {
  it("changes between consecutive setup placements by the same player", () => {
    const state = createDemoGame("web-setup-timer");
    state.phase = { type: "SETUP_PLACEMENT", activePlayerId: "p1", setupIndex: 0 };
    const first = turnDeadlineKey(state, "p1");
    state.phase = { type: "SETUP_PLACEMENT", activePlayerId: "p1", setupIndex: 4 };

    expect(turnDeadlineKey(state, "p1")).not.toBe(first);
  });

  it("waits for an authoritative timer instead of inventing one online", async () => {
    const state = completeSetup(createDemoGame("web-online-no-timer")).state;
    state.phase = { type: "WAITING_FOR_ROLL", activePlayerId: "p1" };
    const { result } = renderHook(() => useTurnTimer({
      state,
      activePlayer: "p1",
      paused: false,
      networkRoomId: "room_timer",
      serverTimer: null,
      rollDeadlineMs: 60_000,
      actionDeadlineMs: 240_000,
      onLocalTimeout: () => undefined,
    }));

    await waitFor(() => expect(result.current.turnDeadline).toBeNull());
  });

  it("uses the exact server deadline online and covers setup locally", async () => {
    const online = completeSetup(createDemoGame("web-online-timer")).state;
    online.phase = { type: "ACTION_PHASE", activePlayerId: "p1" };
    const expiresAt = Date.now() + 123_456;
    const onlineHook = renderHook(() => useTurnTimer({
      state: online,
      activePlayer: "p1",
      paused: false,
      networkRoomId: "room_timer",
      serverTimer: { activePlayerId: "p1", expiresAt },
      rollDeadlineMs: 60_000,
      actionDeadlineMs: 240_000,
      onLocalTimeout: () => undefined,
    }));
    await waitFor(() => expect(onlineHook.result.current.turnDeadline).toMatchObject({ dueAt: expiresAt, mode: "action" }));
    onlineHook.unmount();

    const setup = createDemoGame("web-setup-authoritative-timer");
    setup.phase = { type: "SETUP_PLACEMENT", activePlayerId: "p1", setupIndex: 0 };
    const setupHook = renderHook(() => useTurnTimer({
      state: setup,
      activePlayer: "p1",
      paused: false,
      networkRoomId: null,
      serverTimer: null,
      rollDeadlineMs: 60_000,
      actionDeadlineMs: 240_000,
      onLocalTimeout: () => undefined,
    }));
    await waitFor(() => expect(setupHook.result.current.turnDeadline).toMatchObject({ mode: "setup", durationMs: 240_000 }));
    setupHook.unmount();
  });
});
