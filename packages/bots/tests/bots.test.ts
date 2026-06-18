import { describe, expect, it } from "vitest";
import { completeSetup, createDemoGame, withResources } from "@colonizt/demo-state";
import { applyCommand, emptyResources } from "@colonizt/game-core";
import { chooseBotCommand, createBotView, evaluateTrade, greedyBot, hasEquivalentBotTradeOffer } from "../src/index.js";

describe("bot policies", () => {
  it("does not change decisions when opponent hidden hands change", () => {
    let state = completeSetup(createDemoGame("hidden-info")).state;
    const rolled = applyCommand(state, { type: "ROLL_DICE", playerId: "p1" });
    if (rolled.ok) state = rolled.value.nextState;
    state = { ...state, phase: { type: "ACTION_PHASE", activePlayerId: "p2" } };
    const baseline = chooseBotCommand(createBotView(state, "p2", greedyBot.profile), greedyBot.profile, () => "trade-a");
    const changed = withResources(state, "p1", { timber: 99, brick: 99, grain: 99, fiber: 99, ore: 99 });
    const afterHiddenChange = chooseBotCommand(createBotView(changed, "p2", greedyBot.profile), greedyBot.profile, () => "trade-a");
    expect(afterHiddenChange).toEqual(baseline);
  });

  it("keeps trade temperament stable for equivalent offers during the same turn", () => {
    let state = completeSetup(createDemoGame("stable-trade-temperament", { botDifficulty: "hard" })).state;
    state = { ...state, phase: { type: "ACTION_PHASE", activePlayerId: "p1" } };
    state = withResources(state, "p1", { timber: 1 });
    state = withResources(state, "p2", { ore: 1 });
    const offered = { ...emptyResources(), timber: 1 };
    const requested = { ...emptyResources(), ore: 1 };
    const result = applyCommand(state, { type: "OFFER_TRADE", playerId: "p1", tradeId: "stable", offered, requested, recipients: "ANY" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected trade offer to open");

    const view = createBotView(result.value.nextState, "p2", greedyBot.profile, "hard");
    const trade = result.value.nextState.trades.stable!;
    const baseline = evaluateTrade(view, trade, greedyBot.profile, "hard");
    expect(evaluateTrade(view, trade, greedyBot.profile, "hard")).toBe(baseline);
    expect(evaluateTrade(view, { ...trade, id: "stable-copy" }, greedyBot.profile, "hard")).toBe(baseline);
  });

  it("does not repeat an equivalent bot trade after it has been cancelled", () => {
    const candidate = Array.from({ length: 80 }, (_, index) => {
      let state = completeSetup(createDemoGame(`duplicate-bot-offer-${index}`, { botDifficulty: "medium" })).state;
      state = { ...state, phase: { type: "ACTION_PHASE", activePlayerId: "p2" } };
      state = withResources(state, "p2", { timber: 3, brick: 0, grain: 0, fiber: 0, ore: 0 });
      const command = chooseBotCommand(createBotView(state, "p2", greedyBot.profile), greedyBot.profile, () => `trade-${index}`);
      return command?.type === "OFFER_TRADE" ? { state, command } : undefined;
    }).find((item): item is NonNullable<typeof item> => Boolean(item));

    expect(candidate).toBeDefined();
    if (!candidate) return;

    const offered = applyCommand(candidate.state, candidate.command);
    expect(offered.ok).toBe(true);
    if (!offered.ok) return;
    const cancelled = applyCommand(offered.value.nextState, { type: "CANCEL_TRADE", playerId: "p2", tradeId: candidate.command.tradeId });
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) return;

    const nextView = createBotView(cancelled.value.nextState, "p2", greedyBot.profile);
    const next = chooseBotCommand(nextView, greedyBot.profile, () => "duplicate");
    expect(next?.type === "OFFER_TRADE" && hasEquivalentBotTradeOffer(nextView, next)).toBe(false);
  });
});
