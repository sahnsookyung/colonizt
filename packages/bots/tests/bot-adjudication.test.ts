import { describe, expect, it } from "vitest";
import { playBotGame } from "@colonizt/demo-state";

describe("bot adjudication simulations", () => {
  it("concludes representative all-bot simulations under test-only turn adjudication", () => {
    for (let index = 0; index < 16; index += 1) {
      const played = playBotGame(`adjudicated-${index}`, 700, {
        botDifficulty: "medium",
        rules: { maxTurns: 50, maxTurnAdjudication: "leader", mapRandomized: true },
      });
      expect(played.invalidCommands).toBe(0);
      expect(played.state.phase.type).toBe("GAME_OVER");
    }
  }, 120_000);
});
