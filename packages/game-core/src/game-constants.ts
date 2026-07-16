import type { DevelopmentCardType } from "./types.js";

export const maxRoadsPerPlayer = 15;
export const maxSettlementsPerPlayer = 5;
export const maxCitiesPerPlayer = 4;

export const classicDevelopmentDeck: DevelopmentCardType[] = [
  ...Array.from({ length: 14 }, () => "KNIGHT" as const),
  ...Array.from({ length: 5 }, () => "VICTORY_POINT" as const),
  ...Array.from({ length: 2 }, () => "ROAD_BUILDING" as const),
  ...Array.from({ length: 2 }, () => "MONOPOLY" as const),
  ...Array.from({ length: 2 }, () => "YEAR_OF_PLENTY" as const),
];
