import { describe, expect, it } from "vitest";
import type { GameState, PlayerId } from "@colonizt/game-core";
import { createDemoGame } from "@colonizt/demo-state";
import { isLocalBotPlayer, localBotAutomationKey, localBotPlayerIdsForState, nextLocalTradeDeadlines } from "../src/local-automation.js";

describe("local automation helpers", () => {
  it("keys local bot turns only when automation is enabled", () => {
    const state = {
      ...createDemoGame("local-automation"),
      eventSeq: 12,
      phase: { type: "WAITING_FOR_ROLL", activePlayerId: "p2" as PlayerId },
    } as GameState;

    expect(localBotPlayerIdsForState(state, "p1")).toEqual(["p2", "p3", "p4"]);
    expect(isLocalBotPlayer(state, "p1", "p2")).toBe(true);
    expect(localBotAutomationKey({ enabled: true, state, activePlayer: "p2", humanPlayerId: "p1" })).toBe("match-local-automation:12:WAITING_FOR_ROLL:p2");
    expect(localBotAutomationKey({ enabled: false, state, activePlayer: "p2", humanPlayerId: "p1" })).toBeNull();
    expect(localBotAutomationKey({ enabled: true, state, activePlayer: "p1", humanPlayerId: "p1" })).toBeNull();
  });

  it("derives local bots from the current player order", () => {
    const state = createDemoGame("many-local-bots", { playerCount: 6 });
    expect(localBotPlayerIdsForState(state, "p1")).toEqual(["p2", "p3", "p4", "p5", "p6"]);
    expect(isLocalBotPlayer(state, "p1", "p6")).toBe(true);
  });

  it("preserves existing trade deadlines and drops closed trades", () => {
    const collecting = { id: "trade-open", status: "COLLECTING_RESPONSES" } as GameState["trades"][string];
    const closed = { id: "trade-closed", status: "CLOSED" } as GameState["trades"][string];

    expect(nextLocalTradeDeadlines({ "trade-open": 123 }, [collecting, closed], 1000)).toEqual({ "trade-open": 123 });
    expect(nextLocalTradeDeadlines({}, [collecting], 1000, 5000)).toEqual({ "trade-open": 6000 });
  });
});
