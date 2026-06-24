import type { BotDifficulty, MapPreset } from "@colonizt/game-core";

export interface MatchOptions {
  botDifficulty: BotDifficulty;
  playerCount: 2 | 3 | 4;
  rules: {
    diceDoubles: boolean;
    plight: boolean;
    plightTurn: number;
    mapRandomized: boolean;
    mapPreset: MapPreset;
    specialCardCostRandomized: boolean;
  };
}

export const defaultMatchOptions: MatchOptions = {
  botDifficulty: "medium",
  playerCount: 4,
  rules: {
    diceDoubles: false,
    plight: false,
    plightTurn: 20,
    mapRandomized: true,
    mapPreset: "standard",
    specialCardCostRandomized: false,
  },
};

export const mapPresetLabels: Record<MapPreset, string> = {
  standard: "Standard",
  islands: "Islands",
  continent: "Continent",
};

export const toPlayerCount = (value: unknown, fallback: 2 | 3 | 4 = 4): 2 | 3 | 4 =>
  value === 2 || value === 3 || value === 4 ? value : fallback;

export const clampPlayerCount = (value: number): 2 | 3 | 4 =>
  value <= 2 ? 2 : value >= 4 ? 4 : 3;

export const onlineRoomCapacityText = (playerCount: 2 | 3 | 4): string =>
  playerCount === 2 ? "2 player online room" : `2-${playerCount} player online room`;
