import { describe, expect, it } from "vitest";
import type { GameState, PlayerId } from "@colonizt/game-core";
import { createDemoGame } from "@colonizt/demo-state";
import { isLocalBotPlayer, localBotAutomationKey, nextLocalTradeDeadlines } from "../src/local-automation.js";

describe("local automation helpers", () => {
  it("keys local bot turns only when automation is enabled", () => {
    const state = {
      ...createDemoGame("local-automation"),
      eventSeq: 12,
      phase: { type: "WAITING_FOR_ROLL", activePlayerId: "p2" as PlayerId },
    } as GameState;

    expect(isLocalBotPlayer("p2")).toBe(true);
    expect(localBotAutomationKey({ enabled: true, state, activePlayer: "p2" })).toBe("match-local-automation:12:WAITING_FOR_ROLL:p2");
    expect(localBotAutomationKey({ enabled: false, state, activePlayer: "p2" })).toBeNull();
    expect(localBotAutomationKey({ enabled: true, state, activePlayer: "p1" })).toBeNull();
  });

  it("preserves existing trade deadlines and drops closed trades", () => {
    const collecting = { id: "trade-open", status: "COLLECTING_RESPONSES" } as GameState["trades"][string];
    const closed = { id: "trade-closed", status: "CLOSED" } as GameState["trades"][string];

    expect(nextLocalTradeDeadlines({ "trade-open": 123 }, [collecting, closed], 1000)).toEqual({ "trade-open": 123 });
    expect(nextLocalTradeDeadlines({}, [collecting], 1000, 5000)).toEqual({ "trade-open": 6000 });
  });
});
