import { describe, expect, it } from "vitest";
import { playBotGame } from "@colonizt/demo-state";
import type { BotDifficulty, PlayerId } from "@colonizt/game-core";

const tournamentPlayerIds = ["p1", "p2", "p3", "p4"] as const satisfies readonly PlayerId[];

const rotatedDifficulties = (index: number): Record<PlayerId, BotDifficulty> => {
  const tiers: BotDifficulty[] = ["hard", "medium", "easy", "easy"];
  return Object.fromEntries(tournamentPlayerIds.map((playerId, offset) => [playerId, tiers[(index + offset) % tiers.length]!])) as Record<PlayerId, BotDifficulty>;
};

describe("bot difficulty simulations", () => {
  it("runs mixed-difficulty tournament samples with stronger bots winning more often", () => {
    const wins = new Map<BotDifficulty, number>();
    const entries = new Map<BotDifficulty, number>();
    for (let index = 0; index < 24; index += 1) {
      const botDifficulties = rotatedDifficulties(index);
      for (const difficulty of Object.values(botDifficulties)) entries.set(difficulty, (entries.get(difficulty) ?? 0) + 1);
      const played = playBotGame(`difficulty-tournament-${index}`, 900, {
        botDifficulties,
        botProfiles: { p1: "greedy", p2: "greedy", p3: "greedy", p4: "greedy" },
        rules: { maxTurns: 55, maxTurnAdjudication: "leader", mapRandomized: true },
      });
      expect(played.invalidCommands).toBe(0);
      expect(played.state.phase.type).toBe("GAME_OVER");
      if (played.state.phase.type === "GAME_OVER") {
        const difficulty = botDifficulties[played.state.phase.winnerId];
        wins.set(difficulty, (wins.get(difficulty) ?? 0) + 1);
      }
    }

    const rate = (difficulty: BotDifficulty) => (wins.get(difficulty) ?? 0) / (entries.get(difficulty) ?? 1);
    expect(entries.get("hard")).toBeGreaterThan(0);
    expect(entries.get("medium")).toBeGreaterThan(0);
    expect(entries.get("easy")).toBeGreaterThan(0);
    const strongRate = ((wins.get("hard") ?? 0) + (wins.get("medium") ?? 0)) / ((entries.get("hard") ?? 0) + (entries.get("medium") ?? 0));
    expect(strongRate).toBeGreaterThan(rate("easy"));
  }, 120_000);
});
