import { describe, expect, it } from "vitest";
import { createDemoGame } from "@colonizt/test-utils";
import {
  assertInvariants,
  classicResourceBankSize,
  emptyResources,
  maxCitiesPerPlayer,
  maxRoadsPerPlayer,
  maxSettlementsPerPlayer,
  resources,
  type DevelopmentCard,
  type GameState,
  type TradeOffer,
} from "../src/index.js";

const expectInvariantError = (state: GameState, message: string, code = "INVARIANT_VIOLATION"): void => {
  expect(assertInvariants(state)).toEqual({ ok: false, error: { code, message } });
};

const independentVertices = (state: GameState, count: number): string[] => {
  const selected: string[] = [];
  for (const vertexId of Object.keys(state.board.vertices)) {
    if (selected.every((candidate) => !state.board.adjacency.vertexToEdges[candidate]?.some((edgeId) => state.board.adjacency.edgeToVertices[edgeId]?.includes(vertexId)))) {
      selected.push(vertexId);
    }
    if (selected.length === count) break;
  }
  return selected;
};

const tradeOffer = (overrides: Partial<TradeOffer> = {}): TradeOffer => ({
  id: "trade-invariant",
  fromPlayerId: "p1",
  offered: { ...emptyResources(), timber: 1 },
  requested: { ...emptyResources(), ore: 1 },
  recipients: ["p2"],
  status: "OPEN",
  createdAtSeq: 1,
  expiresAtSeq: 20,
  ...overrides,
});

const discardingState = (): GameState => {
  const state = createDemoGame("discard-invariants");
  state.phase = { type: "DISCARDING", activePlayerId: "p1", rollerId: "p1", pending: { p2: 1 }, submitted: {} };
  return state;
};

describe("terminal and discard invariants", () => {
  it("accepts a valid pending discard and its exact submitted card count", () => {
    const pending = discardingState();
    expect(assertInvariants(pending)).toEqual({ ok: true, value: true });

    pending.phase = {
      ...pending.phase,
      submitted: { p2: { ...emptyResources(), timber: 1 } },
    };
    expect(assertInvariants(pending)).toEqual({ ok: true, value: true });
  });

  it("rejects unknown, non-positive, and incorrectly submitted discard entries", () => {
    const unknown = discardingState();
    unknown.phase = { ...unknown.phase, pending: { departed: 1 } };
    expect(assertInvariants(unknown)).toEqual({ ok: false, error: { code: "INVARIANT_VIOLATION", message: "invalid discard pending entry" } });

    const nonPositive = discardingState();
    nonPositive.phase = { ...nonPositive.phase, pending: { p2: 0 } };
    expect(assertInvariants(nonPositive)).toEqual({ ok: false, error: { code: "INVARIANT_VIOLATION", message: "invalid discard pending entry" } });

    const wrongSubmission = discardingState();
    wrongSubmission.phase = { ...wrongSubmission.phase, submitted: { p2: { ...emptyResources(), timber: 2 } } };
    expect(assertInvariants(wrongSubmission)).toEqual({ ok: false, error: { code: "INVARIANT_VIOLATION", message: "invalid discard submission" } });
  });

  it("rejects an early victory but permits turn-limit adjudication below the threshold", () => {
    const state = createDemoGame("game-over-invariants");
    state.phase = { type: "GAME_OVER", winnerId: "p1", reason: "VICTORY_POINTS" };
    expect(assertInvariants(state)).toEqual({ ok: false, error: { code: "INVARIANT_VIOLATION", message: "game over before victory threshold" } });

    state.phase = { type: "GAME_OVER", winnerId: "p1", reason: "TURN_LIMIT" };
    expect(assertInvariants(state)).toEqual({ ok: true, value: true });
  });

  it("does not count non-victory cards and rejects an unknown winner", () => {
    const nonVictoryCard = createDemoGame("non-victory-card-invariant");
    nonVictoryCard.players.p1!.score = nonVictoryCard.config.victoryPoints - 1;
    nonVictoryCard.players.p1!.developmentCards = [{ id: "knight-card", type: "KNIGHT", ownerId: "p1", boughtTurn: 0 }];
    nonVictoryCard.phase = { type: "GAME_OVER", winnerId: "p1", reason: "VICTORY_POINTS" };
    expectInvariantError(nonVictoryCard, "game over before victory threshold");

    const unknownWinner = createDemoGame("unknown-winner-invariant");
    unknownWinner.phase = { type: "GAME_OVER", winnerId: "departed", reason: "VICTORY_POINTS" };
    expectInvariantError(unknownWinner, "game over before victory threshold");
  });

  it("reports exact piece-supply diagnostics for roads, settlements, and cities", () => {
    const roads = createDemoGame("road-piece-limit");
    roads.roads = Object.fromEntries(Object.keys(roads.board.edges).slice(0, 16).map((edgeId) => [edgeId, "p1"]));
    expectInvariantError(roads, "p1 has too many roads");

    const settlements = createDemoGame("settlement-piece-limit");
    const settlementVertices = independentVertices(settlements, 6);
    expect(settlementVertices).toHaveLength(6);
    settlements.settlements = Object.fromEntries(settlementVertices.map((vertexId) => [vertexId, "p1"]));
    settlements.buildings = Object.fromEntries(settlementVertices.map((vertexId) => [vertexId, { owner: "p1", type: "settlement" as const }]));
    expectInvariantError(settlements, "p1 has too many settlements");

    const cities = createDemoGame("city-piece-limit");
    const cityVertices = independentVertices(cities, 5);
    expect(cityVertices).toHaveLength(5);
    cities.settlements = Object.fromEntries(cityVertices.map((vertexId) => [vertexId, "p1"]));
    cities.buildings = Object.fromEntries(cityVertices.map((vertexId) => [vertexId, { owner: "p1", type: "city" as const }]));
    expectInvariantError(cities, "p1 has too many cities");
  });
});

describe("board, bank, and player corruption invariants", () => {
  it("returns all board-validation diagnostics without relabeling them", () => {
    const state = createDemoGame("invalid-board-invariant");
    const hexes = Object.values(state.board.hexes);
    hexes[0]!.token = 7;
    hexes[1]!.token = 7;
    expectInvariantError(state, "hex h0 has invalid token; hex h1 desert cannot have token", "INVALID_BOARD");
  });

  it.each([
    {
      name: "a thief on an unknown hex",
      message: "thief is on an unknown hex",
      corrupt: (state: GameState) => { state.thiefHexId = "missing-hex"; },
    },
    {
      name: "a negative bank balance",
      message: "bank has negative resources",
      corrupt: (state: GameState) => { state.resourceBank.timber = -1; },
    },
    {
      name: "a negative player balance",
      message: "p1 has negative resources",
      corrupt: (state: GameState) => { state.players.p1!.resources.brick = -1; },
    },
    {
      name: "a fractional special-card count",
      message: "p1 has invalid special cards",
      corrupt: (state: GameState) => { state.players.p1!.specialCards = 0.5; },
    },
    {
      name: "a negative special-card count",
      message: "p1 has invalid special cards",
      corrupt: (state: GameState) => { state.players.p1!.specialCards = -1; },
    },
    {
      name: "a non-array development-card collection",
      message: "p1 has invalid development cards",
      corrupt: (state: GameState) => {
        (state.players.p1! as unknown as { developmentCards: unknown }).developmentCards = {};
      },
    },
    {
      name: "duplicate development-card ids",
      message: "duplicate development card duplicate-card",
      corrupt: (state: GameState) => {
        const card: DevelopmentCard = { id: "duplicate-card", type: "KNIGHT", ownerId: "p1", boughtTurn: 0 };
        state.players.p1!.developmentCards = [card, { ...card }];
      },
    },
    {
      name: "a development-card owner mismatch",
      message: "development card wrong-owner owner mismatch",
      corrupt: (state: GameState) => {
        state.players.p1!.developmentCards = [{ id: "wrong-owner", type: "KNIGHT", ownerId: "p2", boughtTurn: 0 }];
      },
    },
    {
      name: "an unknown development-card type",
      message: "development card wrong-type has invalid type",
      corrupt: (state: GameState) => {
        state.players.p1!.developmentCards = [{ id: "wrong-type", type: "INVALID" as DevelopmentCard["type"], ownerId: "p1", boughtTurn: 0 }];
      },
    },
    {
      name: "a negative score",
      message: "p1 has negative score",
      corrupt: (state: GameState) => { state.players.p1!.score = -1; },
    },
  ])("rejects $name", ({ corrupt, message }) => {
    const state = createDemoGame(`player-corruption-${message}`);
    corrupt(state);
    expectInvariantError(state, message);
  });

  it("detects resource conservation mismatches by resource", () => {
    const state = createDemoGame("bank-accounting-invariant");
    state.resourceBank.timber -= 1;
    expectInvariantError(state, "timber bank accounting mismatch");
  });

  it("accepts a migrated state without a bank only when players hold the full supply", () => {
    const state = createDemoGame("legacy-bank-invariant");
    for (const resource of resources) state.players.p1!.resources[resource] = classicResourceBankSize;
    delete (state as Partial<GameState>).resourceBank;
    expect(assertInvariants(state)).toEqual({ ok: true, value: true });
  });
});

describe("road and building topology invariants", () => {
  it("rejects roads on unknown edges and roads owned by unknown players", () => {
    const unknownEdge = createDemoGame("unknown-road-edge");
    unknownEdge.roads["missing-edge"] = "p1";
    expectInvariantError(unknownEdge, "road on unknown edge missing-edge");

    const unknownOwner = createDemoGame("unknown-road-owner");
    const edgeId = Object.keys(unknownOwner.board.edges)[0]!;
    unknownOwner.roads[edgeId] = "departed";
    expectInvariantError(unknownOwner, "road owned by unknown player departed");
  });

  it("rejects unknown settlement vertices, owners, and missing or mismatched buildings", () => {
    const unknownVertex = createDemoGame("unknown-settlement-vertex");
    unknownVertex.settlements["missing-vertex"] = "p1";
    expectInvariantError(unknownVertex, "settlement on unknown vertex missing-vertex");

    const unknownOwner = createDemoGame("unknown-settlement-owner");
    const ownerVertex = Object.keys(unknownOwner.board.vertices)[0]!;
    unknownOwner.settlements[ownerVertex] = "departed";
    expectInvariantError(unknownOwner, "settlement owned by unknown player departed");

    const missingBuilding = createDemoGame("missing-settlement-building");
    const missingVertex = Object.keys(missingBuilding.board.vertices)[0]!;
    missingBuilding.settlements[missingVertex] = "p1";
    expectInvariantError(missingBuilding, `building state missing for ${missingVertex}`);

    const mismatchedBuilding = createDemoGame("mismatched-settlement-building");
    const mismatchVertex = Object.keys(mismatchedBuilding.board.vertices)[0]!;
    mismatchedBuilding.settlements[mismatchVertex] = "p1";
    mismatchedBuilding.buildings[mismatchVertex] = { owner: "p2", type: "settlement" };
    expectInvariantError(mismatchedBuilding, `building state missing for ${mismatchVertex}`);
  });

  it("rejects adjacent settlements", () => {
    const state = createDemoGame("settlement-distance-invariant");
    const edgeId = Object.keys(state.board.edges)[0]!;
    const [left, right] = state.board.adjacency.edgeToVertices[edgeId]!;
    state.settlements[left] = "p1";
    state.settlements[right] = "p2";
    state.buildings[left] = { owner: "p1", type: "settlement" };
    state.buildings[right] = { owner: "p2", type: "settlement" };
    expectInvariantError(state, `settlement distance violation at ${left}`);
  });

  it("rejects buildings on unknown vertices, with unknown owners, or without settlement ownership", () => {
    const unknownVertex = createDemoGame("unknown-building-vertex");
    unknownVertex.buildings["missing-vertex"] = { owner: "p1", type: "settlement" };
    expectInvariantError(unknownVertex, "building on unknown vertex missing-vertex");

    const unknownOwner = createDemoGame("unknown-building-owner");
    const ownerVertex = Object.keys(unknownOwner.board.vertices)[0]!;
    unknownOwner.buildings[ownerVertex] = { owner: "departed", type: "settlement" };
    expectInvariantError(unknownOwner, "building owned by unknown player departed");

    const missingSettlement = createDemoGame("building-owner-mismatch");
    const settlementVertex = Object.keys(missingSettlement.board.vertices)[0]!;
    missingSettlement.buildings[settlementVertex] = { owner: "p1", type: "settlement" };
    expectInvariantError(missingSettlement, `settlement owner mismatch at ${settlementVertex}`);
  });
});

describe("trade response invariants", () => {
  it("rejects trades owned by unknown players", () => {
    const state = createDemoGame("unknown-trade-owner");
    state.trades.invalid = tradeOffer({ fromPlayerId: "departed" });
    expectInvariantError(state, "trade owned by unknown player departed");
  });

  it("does not require response records for trades that are not collecting responses", () => {
    const state = createDemoGame("open-trade-invariant");
    state.trades.open = tradeOffer({ status: "OPEN", responses: undefined });
    expect(assertInvariants(state)).toEqual({ ok: true, value: true });
  });

  it.each(["PENDING", "WANTS_ACCEPT", "REJECTED"] as const)("accepts a %s response for every intended recipient", (status) => {
    const state = createDemoGame(`valid-collecting-trade-${status}`);
    state.trades.collecting = tradeOffer({
      status: "COLLECTING_RESPONSES",
      responses: { p2: { playerId: "p2", status } },
    });
    expect(assertInvariants(state)).toEqual({ ok: true, value: true });
  });

  it("rejects missing, mis-keyed, mismatched, and invalid response records", () => {
    const missing = createDemoGame("missing-trade-response");
    missing.trades.missing = tradeOffer({ status: "COLLECTING_RESPONSES", responses: {} });
    expectInvariantError(missing, "trade trade-invariant has invalid response entries");

    const misKeyed = createDemoGame("mis-keyed-trade-response");
    misKeyed.trades.misKeyed = tradeOffer({
      status: "COLLECTING_RESPONSES",
      responses: { p3: { playerId: "p3", status: "PENDING" } },
    });
    expectInvariantError(misKeyed, "trade trade-invariant has invalid response entries");

    const extra = createDemoGame("extra-trade-response");
    extra.trades.extra = tradeOffer({
      status: "COLLECTING_RESPONSES",
      responses: {
        p2: { playerId: "p2", status: "PENDING" },
        p3: { playerId: "p3", status: "PENDING" },
      },
    });
    expectInvariantError(extra, "trade trade-invariant has invalid response entries");

    const partiallyMisKeyed = createDemoGame("partially-mis-keyed-trade-response");
    partiallyMisKeyed.trades.partiallyMisKeyed = tradeOffer({
      status: "COLLECTING_RESPONSES",
      recipients: ["p2", "p3"],
      responses: {
        p2: { playerId: "p2", status: "PENDING" },
        p4: { playerId: "p4", status: "PENDING" },
      },
    });
    expectInvariantError(partiallyMisKeyed, "trade trade-invariant has invalid response entries");

    const mismatched = createDemoGame("mismatched-trade-response");
    mismatched.trades.mismatched = tradeOffer({
      status: "COLLECTING_RESPONSES",
      responses: { p2: { playerId: "p3", status: "PENDING" } },
    });
    expectInvariantError(mismatched, "trade trade-invariant has an invalid responder");

    const invalidStatus = createDemoGame("invalid-trade-response-status");
    invalidStatus.trades.invalidStatus = tradeOffer({
      status: "COLLECTING_RESPONSES",
      responses: { p2: { playerId: "p2", status: "INVALID" as "PENDING" } },
    });
    expectInvariantError(invalidStatus, "trade trade-invariant has invalid response status");
  });
});

describe("piece supply boundaries", () => {
  it("accepts the exact road, settlement, and city supplies", () => {
    const roads = createDemoGame("exact-road-piece-limit");
    roads.roads = Object.fromEntries(Object.keys(roads.board.edges).slice(0, maxRoadsPerPlayer).map((edgeId) => [edgeId, "p1"]));
    expect(assertInvariants(roads)).toEqual({ ok: true, value: true });

    const settlements = createDemoGame("exact-settlement-piece-limit");
    const settlementVertices = independentVertices(settlements, maxSettlementsPerPlayer);
    expect(settlementVertices).toHaveLength(maxSettlementsPerPlayer);
    settlements.settlements = Object.fromEntries(settlementVertices.map((vertexId) => [vertexId, "p1"]));
    settlements.buildings = Object.fromEntries(settlementVertices.map((vertexId) => [vertexId, { owner: "p1", type: "settlement" as const }]));
    expect(assertInvariants(settlements)).toEqual({ ok: true, value: true });

    const cities = createDemoGame("exact-city-piece-limit");
    const cityVertices = independentVertices(cities, maxCitiesPerPlayer);
    expect(cityVertices).toHaveLength(maxCitiesPerPlayer);
    cities.settlements = Object.fromEntries(cityVertices.map((vertexId) => [vertexId, "p1"]));
    cities.buildings = Object.fromEntries(cityVertices.map((vertexId) => [vertexId, { owner: "p1", type: "city" as const }]));
    expect(assertInvariants(cities)).toEqual({ ok: true, value: true });
  });

  it("counts each player's road supply independently", () => {
    const state = createDemoGame("independent-road-piece-limits");
    const edgeIds = Object.keys(state.board.edges);
    state.roads = Object.fromEntries([
      ...edgeIds.slice(0, maxRoadsPerPlayer).map((edgeId) => [edgeId, "p1"]),
      ...edgeIds.slice(maxRoadsPerPlayer, maxRoadsPerPlayer * 2).map((edgeId) => [edgeId, "p2"]),
    ]);
    expect(assertInvariants(state)).toEqual({ ok: true, value: true });
  });
});
