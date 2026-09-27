import { describe, expect, it } from "vitest";
import { playBotGame } from "@colonizt/demo-state";
import type { MapPreset, PlayerId } from "@colonizt/game-core";

describe("bot map and player-count simulations", () => {
  it("supports configurable bot counts across map presets", () => {
    const scenarios: Array<{ playerCount: number; mapPreset: MapPreset }> = [
      { playerCount: 2, mapPreset: "standard" },
      { playerCount: 3, mapPreset: "islands" },
      { playerCount: 4, mapPreset: "continent" },
      { playerCount: 6, mapPreset: "islands" },
      { playerCount: 8, mapPreset: "continent" },
    ];
    for (const { playerCount, mapPreset } of scenarios) {
      const playerIds = Array.from({ length: playerCount }, (_, index) => `p${index + 1}` as PlayerId);
      const played = playBotGame(`preset-count-${mapPreset}-${playerCount}`, 900, {
        playerIds,
        botDifficulty: "medium",
        botProfiles: Object.fromEntries(playerIds.map((playerId) => [playerId, "greedy" as const])),
        rules: { mapPreset, mapRandomized: true, maxTurns: 55, maxTurnAdjudication: "leader" },
      });
      expect(played.invalidCommands).toBe(0);
      expect(played.state.phase.type).toBe("GAME_OVER");
    }
  }, 120_000);
});
