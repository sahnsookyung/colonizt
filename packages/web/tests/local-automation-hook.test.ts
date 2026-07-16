// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { completeSetup, createDemoGame, withResources } from "@colonizt/demo-state";
import { emptyResources, schemaVersion, type GameCommand, type GameEvent, type GameState, type TradeOffer } from "@colonizt/game-core";
import { useLocalAutomation, type UseLocalAutomationOptions } from "../src/hooks/useLocalAutomation.js";

const trade = (overrides: Partial<TradeOffer> = {}): TradeOffer => ({
  id: "trade-local",
  fromPlayerId: "p1",
  offered: { ...emptyResources(), timber: 1 },
  requested: { ...emptyResources(), grain: 1 },
  recipients: ["p2"],
  status: "COLLECTING_RESPONSES",
  createdAtSeq: 10,
  expiresAtSeq: 30,
  responses: { p2: { playerId: "p2", status: "PENDING" } },
  ...overrides,
});

const automationOptions = (state: GameState, apply: (command: GameCommand) => { state: GameState; events: GameEvent[]; error?: string }): UseLocalAutomationOptions => ({
  enabled: true,
  state,
  events: [],
  activePlayer: "activePlayerId" in state.phase ? state.phase.activePlayerId : undefined,
  humanPlayerId: "p1",
  localTradeDeadlines: {},
  setLocalTradeDeadlines: vi.fn(),
  stateRef: { current: state },
  eventsRef: { current: [] },
  applyLocalCommandRef: { current: apply },
  postRollAnimationMs: 1_000,
});

describe("useLocalAutomation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-14T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("executes a local bot turn after the phase-specific delay", () => {
    const state = completeSetup(createDemoGame("local-hook-bot", { playerCount: 3 })).state;
    state.phase = { type: "WAITING_FOR_ROLL", activePlayerId: "p2" };
    const apply = vi.fn(() => ({ state, events: [] }));
    const options = automationOptions(state, apply);

    renderHook(() => useLocalAutomation(options));
    act(() => vi.advanceTimersByTime(899));
    expect(apply).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));

    expect(apply).toHaveBeenCalledWith({ type: "ROLL_DICE", playerId: "p2" });
  });

  it("falls back to ending an action phase when a bot command is rejected", () => {
    const state = completeSetup(createDemoGame("local-hook-fallback", { playerCount: 3 })).state;
    state.phase = { type: "ACTION_PHASE", activePlayerId: "p2" };
    state.eventSeq += 1;
    const roll: GameEvent = { schemaVersion, seq: state.eventSeq, type: "DICE_ROLLED", playerId: "p2", dice: [3, 4], sum: 7, rngIndex: 0, rngPolicy: "SEEDED_DETERMINISTIC" };
    const apply = vi.fn()
      .mockReturnValueOnce({ state, events: [], error: "simulated rejection" })
      .mockReturnValue({ state, events: [] });
    const options = automationOptions(state, apply);
    options.events = [roll];
    options.eventsRef.current = [roll];

    renderHook(() => useLocalAutomation(options));
    act(() => vi.advanceTimersByTime(1_120));

    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenLastCalledWith({ type: "END_TURN", playerId: "p2" });
  });

  it("does not execute a stale bot callback or act while its trade is awaiting responses", () => {
    const state = completeSetup(createDemoGame("local-hook-stale", { playerCount: 3 })).state;
    state.phase = { type: "WAITING_FOR_ROLL", activePlayerId: "p2" };
    const apply = vi.fn(() => ({ state, events: [] }));
    const staleOptions = automationOptions(state, apply);
    renderHook(() => useLocalAutomation(staleOptions));
    staleOptions.stateRef.current = { ...state, eventSeq: state.eventSeq + 1 };
    act(() => vi.advanceTimersByTime(900));
    expect(apply).not.toHaveBeenCalled();

    const tradingState = withResources(structuredClone(state), "p2", { timber: 1 });
    tradingState.phase = { type: "ACTION_PHASE", activePlayerId: "p2" };
    tradingState.trades["trade-bot-waiting"] = trade({ id: "trade-bot-waiting", fromPlayerId: "p2", recipients: ["p1"] });
    const tradingApply = vi.fn(() => ({ state: tradingState, events: [] }));
    const tradingOptions = automationOptions(tradingState, tradingApply);
    const hook = renderHook(() => useLocalAutomation(tradingOptions));
    act(() => vi.advanceTimersByTime(3_200));
    expect(tradingApply).not.toHaveBeenCalled();
    hook.unmount();
  });

  it("records a bot response only while the same trade is still eligible", () => {
    let state = withResources(completeSetup(createDemoGame("local-hook-response", { playerCount: 3 })).state, "p1", { timber: 1 });
    state = withResources(state, "p2", { grain: 1 });
    state.phase = { type: "ACTION_PHASE", activePlayerId: "p1" };
    state.trades["trade-response"] = trade({ id: "trade-response" });
    const apply = vi.fn(() => ({ state, events: [] }));
    const options = automationOptions(state, apply);

    renderHook(() => useLocalAutomation(options));
    act(() => vi.advanceTimersByTime(650));
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ type: "RESPOND_TRADE", playerId: "p2", tradeId: "trade-response" }));

    const staleState = structuredClone(state);
    staleState.trades["trade-response"]!.status = "CANCELLED";
    options.stateRef.current = staleState;
    apply.mockClear();
    const stale = renderHook(() => useLocalAutomation({ ...options, state }));
    act(() => vi.advanceTimersByTime(650));
    expect(apply).not.toHaveBeenCalled();
    stale.unmount();
  });

  it("finalizes a fully answered bot offer and expires an unanswered human offer", () => {
    let botState = completeSetup(createDemoGame("local-hook-resolve", { playerCount: 3 })).state;
    botState = withResources(botState, "p2", { timber: 1 });
    botState = withResources(botState, "p1", { grain: 1 });
    botState.phase = { type: "ACTION_PHASE", activePlayerId: "p2" };
    botState.trades["trade-resolve"] = trade({
      id: "trade-resolve",
      fromPlayerId: "p2",
      recipients: ["p1"],
      responses: { p1: { playerId: "p1", status: "WANTS_ACCEPT", respondedAtSeq: 11 } },
    });
    const botApply = vi.fn(() => ({ state: botState, events: [] }));
    const botOptions = automationOptions(botState, botApply);
    renderHook(() => useLocalAutomation(botOptions));
    act(() => vi.advanceTimersByTime(300));
    expect(botApply).toHaveBeenCalledWith({ type: "FINALIZE_TRADE", playerId: "p2", tradeId: "trade-resolve", toPlayerId: "p1" });

    const humanState = structuredClone(botState);
    humanState.phase = { type: "ACTION_PHASE", activePlayerId: "p1" };
    humanState.trades = { "trade-timeout": trade({ id: "trade-timeout" }) };
    const humanApply = vi.fn(() => ({ state: humanState, events: [] }));
    const humanOptions = automationOptions(humanState, humanApply);
    humanOptions.localTradeDeadlines = { "trade-timeout": Date.now() + 1_000 };
    renderHook(() => useLocalAutomation(humanOptions));
    act(() => vi.advanceTimersByTime(1_000));
    expect(humanApply).toHaveBeenCalledWith({ type: "EXPIRE_TRADE", playerId: "p1", tradeId: "trade-timeout", reason: "RESPONSE_TIMEOUT" });
  });

  it("clears every pending automation timer when disabled or explicitly reset", () => {
    const state = completeSetup(createDemoGame("local-hook-clear", { playerCount: 3 })).state;
    state.phase = { type: "WAITING_FOR_ROLL", activePlayerId: "p2" };
    const apply = vi.fn(() => ({ state, events: [] }));
    const options = automationOptions(state, apply);
    const { result, rerender } = renderHook(() => useLocalAutomation(options));

    act(() => result.current.clearAutomationTimers());
    act(() => vi.runAllTimers());
    expect(apply).not.toHaveBeenCalled();

    options.enabled = false;
    rerender();
    act(() => vi.runAllTimers());
    expect(apply).not.toHaveBeenCalled();
  });
});
