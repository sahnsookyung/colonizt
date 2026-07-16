import { describe, expect, it } from "vitest";
import { createDemoGame } from "@colonizt/demo-state";
import { turnDeadlineKey } from "../src/hooks/useTurnTimer.js";

describe("turn deadline identity", () => {
  it("changes between consecutive setup placements by the same player", () => {
    const state = createDemoGame("web-setup-timer");
    state.phase = { type: "SETUP_PLACEMENT", activePlayerId: "p1", setupIndex: 0 };
    const first = turnDeadlineKey(state, "p1");
    state.phase = { type: "SETUP_PLACEMENT", activePlayerId: "p1", setupIndex: 4 };

    expect(turnDeadlineKey(state, "p1")).not.toBe(first);
  });
});
