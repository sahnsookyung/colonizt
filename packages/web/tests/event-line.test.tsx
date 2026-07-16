// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { emptyResources, schemaVersion, type GameEvent } from "@colonizt/game-core";
import { EventLine } from "../src/components/game-ui.js";

afterEach(cleanup);

const bundle = (values: Partial<ReturnType<typeof emptyResources>> = {}) => ({ ...emptyResources(), ...values });

describe("EventLine", () => {
  it("renders every action-specific public event with meaningful table history", () => {
    const events: GameEvent[] = [
      { schemaVersion, seq: 1, type: "ROAD_BUILT", playerId: "p1", edgeId: "e1", cost: bundle({ timber: 1, brick: 1 }) },
      { schemaVersion, seq: 2, type: "SETTLEMENT_BUILT", playerId: "p1", vertexId: "v1", cost: bundle({ timber: 1, brick: 1, grain: 1, fiber: 1 }) },
      { schemaVersion, seq: 3, type: "CITY_UPGRADED", playerId: "p1", vertexId: "v1", cost: bundle({ grain: 2, ore: 3 }) },
      { schemaVersion, seq: 4, type: "SPECIAL_CARD_BOUGHT", playerId: "p1", cost: bundle({ grain: 1, fiber: 1, ore: 1 }), cardIndex: 0, cardType: "KNIGHT" },
      { schemaVersion, seq: 5, type: "DISCARD_REQUIRED", rollerId: "p1", pending: { p2: 4 } },
      { schemaVersion, seq: 6, type: "RESOURCES_DISCARDED", playerId: "p2", resources: bundle({ ore: 4 }), forced: true },
      { schemaVersion, seq: 7, type: "THIEF_MOVED", playerId: "p1", toHexId: "h1", reason: "ROLL_7", stealFromPlayerId: "p2", stolenResource: "ore" },
      { schemaVersion, seq: 8, type: "DEVELOPMENT_CARD_PLAYED", playerId: "p1", cardId: "knight", cardType: "KNIGHT" },
      { schemaVersion, seq: 9, type: "ROAD_BUILDING_PLAYED", playerId: "p1", cardId: "roads", edgeIds: ["e1", "e2"] },
      { schemaVersion, seq: 10, type: "MONOPOLY_PLAYED", playerId: "p1", cardId: "monopoly", resource: "grain", collected: { p2: 2 } },
      { schemaVersion, seq: 11, type: "YEAR_OF_PLENTY_PLAYED", playerId: "p1", cardId: "plenty", resources: ["grain", "ore"] },
      { schemaVersion, seq: 12, type: "LARGEST_ARMY_UPDATED", playerId: "p1", knightCount: 3 },
      { schemaVersion, seq: 13, type: "LONGEST_ROAD_UPDATED", playerId: "p2", length: 5 },
      { schemaVersion, seq: 14, type: "MARITIME_TRADED", playerId: "p1", offered: "timber", requested: "ore", ratio: 4 },
      { schemaVersion, seq: 15, type: "TRADE_ACCEPTED", tradeId: "trade", fromPlayerId: "p1", toPlayerId: "p2", offered: bundle({ timber: 1 }), requested: bundle({ ore: 1 }) },
      { schemaVersion, seq: 16, type: "TRADE_RESPONSE_RECORDED", tradeId: "trade", playerId: "p2", response: "WANTS_ACCEPT" },
      { schemaVersion, seq: 17, type: "TRADE_CLOSED", tradeId: "trade", playerId: "p1", reason: "RESPONSE_TIMEOUT" },
      { schemaVersion, seq: 18, type: "PLIGHT_STRUCK", destroyed: [{ playerId: "p2", vertexId: "v2", buildingType: "city" }] },
      { schemaVersion, seq: 19, type: "GAME_OVER", winnerId: "p1", reason: "TURN_LIMIT" },
    ];

    render(<ul>{events.map((event) => <EventLine key={event.seq} event={event} />)}</ul>);

    for (const text of [
      "p1 built road", "p1 built settlement (+1 VP)", "p1 upgraded city (+1 VP)", "p1 drew knight",
      "Discard required after 7", "p2 auto-discarded", "p1 moved the robber and stole from p2", "p1 played knight",
      "p1 used Road Building", "p1 monopolized grain", "p1 took Year of Plenty", "p1 claimed Largest Army (3)",
      "p2 claimed Longest Road (5)", "p1 bank 4:1", "p2 accepted trade", "p2 wants to accept trade",
      "Trade closed (response timeout)", "Plight destroyed 1 building", "p1 won by adjudication",
    ]) expect(screen.getByText(text)).toBeInTheDocument();
  });
});
