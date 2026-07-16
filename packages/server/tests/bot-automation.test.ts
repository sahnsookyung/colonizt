import { describe, expect, it } from "vitest";
import { emptyResources } from "@colonizt/game-core";
import { completeSetup, createDemoGame } from "@colonizt/test-utils";
import type { Room } from "../src/room-manager.js";
import {
  botControllerFor,
  botOfferResolutionCommand,
  botSeatIds,
  botTradeResponseCommand,
  chooseBotTurnCommand,
  dueTradeResponseCommand,
  readyBotOfferResolutionCommand,
  tradeShapeKey,
} from "../src/bot-automation.js";

const lobbyRoom = (): Room => ({
  id: "room_bot_helpers",
  code: "BOT234",
  hostUserId: "p1",
  status: "LOBBY",
  settings: { mode: "CLASSIC", botFill: true, ranked: false },
  seats: [
    { seatIndex: 0, userId: "p1", displayName: "Human", ready: true, connected: true },
    { seatIndex: 1, botId: "bot_1", displayName: "Bot One", ready: true, connected: true },
    { seatIndex: 2, ready: false, connected: false },
    { seatIndex: 3, botId: "bot_12", displayName: "Bot Twelve", ready: true, connected: true },
  ],
  spectators: new Set(),
  createdAt: "2026-01-01T00:00:00.000Z",
  lastActivityAt: "2026-01-01T00:00:00.000Z",
  events: [],
  chat: [],
  reports: [],
  processedClientCommands: new Map(),
  tradeResponseDeadlines: new Map(),
});

describe("bot automation helpers", () => {
  it("assigns stable controller profiles from multi-digit bot seat suffixes", () => {
    expect(botControllerFor("bot_1").profile).toBe("random");
    expect(botControllerFor("bot_2").profile).toBe("greedy");
    expect(botControllerFor("bot_3").profile).toBe("planner");
    expect(botControllerFor("bot_12").profile).toBe("planner");
    expect(botControllerFor("bot_without_suffix").profile).toBe("planner");
  });

  it("returns only occupied bot seats in seat order", () => {
    expect(botSeatIds(lobbyRoom())).toEqual(["bot_1", "bot_12"]);
  });

  it("does not synthesize commands before a game exists", () => {
    const room = lobbyRoom();
    expect(botTradeResponseCommand(room)).toBeUndefined();
    expect(botOfferResolutionCommand(room, "trade_missing")).toBeUndefined();
    expect(readyBotOfferResolutionCommand(room)).toBeUndefined();
    expect(chooseBotTurnCommand(room, "bot_1")).toBeUndefined();
  });

  it("removes expired unresolved trade deadlines while retaining future work", () => {
    const room = lobbyRoom();
    room.tradeResponseDeadlines.set("future", 2_000);
    room.tradeResponseDeadlines.set("expired_b", 1_000);
    room.tradeResponseDeadlines.set("expired_a", 1_000);

    expect(dueTradeResponseCommand(room, 1_000)).toBeUndefined();
    expect([...room.tradeResponseDeadlines.entries()]).toEqual([["future", 2_000]]);
  });

  it("uses all resource fields when identifying equivalent trade shapes", () => {
    const base = { ...emptyResources(), timber: 1 };
    const differentRequest = { ...emptyResources(), grain: 1 };
    expect(tradeShapeKey({ offered: base, requested: differentRequest, recipients: "ANY" }))
      .not.toBe(tradeShapeKey({ offered: base, requested: emptyResources(), recipients: "ANY" }));
  });

  it("responds only for explicitly addressed bot seats", () => {
    const room = lobbyRoom();
    room.seats[1] = { seatIndex: 1, botId: "p2", displayName: "Bot Two", ready: true, connected: true };
    room.seats[3] = { seatIndex: 3, botId: "p3", displayName: "Bot Three", ready: true, connected: true };
    room.game = completeSetup(createDemoGame("explicit-bot-recipient")).state;
    room.game.players.p1!.resources = { ...emptyResources(), timber: 2 };
    room.game.players.p2!.resources = { ...emptyResources(), grain: 2 };
    room.game.trades.explicit = {
      id: "explicit",
      fromPlayerId: "p1",
      offered: { ...emptyResources(), timber: 1 },
      requested: { ...emptyResources(), grain: 1 },
      recipients: ["p2"],
      status: "COLLECTING_RESPONSES",
      responses: { p2: { playerId: "p2", status: "PENDING" } },
      createdAtSeq: 10,
      expiresAtSeq: 20,
    };

    expect(botTradeResponseCommand(room)).toMatchObject({ type: "RESPOND_TRADE", playerId: "p2", tradeId: "explicit" });
  });

  it("resolves the oldest fully answered bot offer deterministically", () => {
    const room = lobbyRoom();
    room.seats[1] = { seatIndex: 1, botId: "p2", displayName: "Bot Two", ready: true, connected: true };
    room.game = completeSetup(createDemoGame("ordered-bot-offers")).state;
    room.game.players.p2!.resources = { ...emptyResources(), timber: 2 };
    room.game.players.p1!.resources = { ...emptyResources(), grain: 2 };
    const makeTrade = (id: string, createdAtSeq: number) => ({
      id,
      fromPlayerId: "p2",
      offered: { ...emptyResources(), timber: 1 },
      requested: { ...emptyResources(), grain: 1 },
      recipients: ["p1"] as string[],
      status: "COLLECTING_RESPONSES" as const,
      responses: { p1: { playerId: "p1", status: "WANTS_ACCEPT" as const, respondedAtSeq: createdAtSeq + 1 } },
      createdAtSeq,
      expiresAtSeq: createdAtSeq + 10,
    });
    room.game.trades.later = makeTrade("later", 20);
    room.game.trades.earlier = makeTrade("earlier", 10);

    expect(readyBotOfferResolutionCommand(room)).toMatchObject({ type: "FINALIZE_TRADE", tradeId: "earlier", toPlayerId: "p1" });
  });
});
