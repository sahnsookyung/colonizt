import { describe, expect, it } from "vitest";
import { emptyResources, type GameEvent } from "@colonizt/game-core";
import { summarizeDevelopmentDraws, summarizeResourceDraws } from "../src/game-analysis.js";

describe("finished-game analysis", () => {
  it("counts every gameplay path that puts resource cards into player hands", () => {
    const events = [
      { type: "RESOURCES_PRODUCED", gains: { p1: { timber: 2 }, p2: { grain: 1 } } },
      { type: "SETUP_PLACED", playerId: "p1", vertexId: "v1", edgeId: "e1", startingResources: { ore: 1 } },
      { type: "YEAR_OF_PLENTY_PLAYED", playerId: "p1", cardId: "plenty", resources: ["fiber", "fiber"] },
      { type: "MONOPOLY_PLAYED", playerId: "p1", cardId: "monopoly", resource: "brick", collected: { p2: 2, p3: 1 } },
      { type: "MARITIME_TRADED", playerId: "p1", offered: "timber", requested: "grain", ratio: 4 },
      { type: "TRADE_ACCEPTED", tradeId: "t1", fromPlayerId: "p1", toPlayerId: "p2", offered: { ...emptyResources(), timber: 1 }, requested: { ...emptyResources(), ore: 2 } },
      { type: "THIEF_MOVED", playerId: "p1", toHexId: "h1", reason: "ROLL_7", stealFromPlayerId: "p2", stolenResource: "grain" },
    ] as GameEvent[];

    expect(Object.fromEntries(summarizeResourceDraws(events).map(({ resource, count }) => [resource, count]))).toEqual({
      timber: 3,
      brick: 3,
      grain: 3,
      fiber: 2,
      ore: 3,
    });
  });

  it("ignores non-draw events, absent resource bundles, and hidden development-card identities", () => {
    expect(summarizeResourceDraws([
      { type: "SETUP_PLACED", playerId: "p1", vertexId: "v1", edgeId: "e1" },
      { type: "THIEF_MOVED", playerId: "p1", toHexId: "h1", reason: "ROLL_7" },
      { type: "TURN_ENDED", playerId: "p1", nextPlayerId: "p2" },
    ] as GameEvent[]).every(({ count }) => count === 0)).toBe(true);

    expect(summarizeDevelopmentDraws([
      { type: "SPECIAL_CARD_BOUGHT", playerId: "p1", cost: emptyResources(), cardIndex: 0, cardType: "KNIGHT" },
      { type: "SPECIAL_CARD_BOUGHT", playerId: "p1", cost: emptyResources(), cardIndex: 1, cardType: "KNIGHT" },
      { type: "SPECIAL_CARD_BOUGHT", playerId: "p1", cost: emptyResources(), cardIndex: 2 },
      { type: "DICE_ROLLED", playerId: "p1", dice: [2, 3], sum: 5, rngIndex: 0, rngPolicy: "SEEDED_DETERMINISTIC" },
    ] as GameEvent[])).toEqual([
      { type: "KNIGHT", count: 2 },
      { type: "VICTORY_POINT", count: 0 },
      { type: "MONOPOLY", count: 0 },
      { type: "YEAR_OF_PLENTY", count: 0 },
      { type: "ROAD_BUILDING", count: 0 },
    ]);
  });
});
