import { describe, expect, it } from "vitest";
import {
  addResources,
  applyCommand,
  applyEvent,
  assertInvariants,
  boardHexComponentCount,
  canPlaceSettlement,
  cityCost,
  closeExpiredTrades,
  createBoardForRules,
  createFixedBoard,
  createGame,
  createSeededBoard,
  emptyResources,
  eligibleStealTargets,
  getLegalActions,
  maritimeTradeRatio,
  maxRoadsPerPlayer,
  normalizeImportedState,
  projectedResourceBank,
  replay,
  resourceCount,
  resources,
  randomizedDiscard,
  serializeEventsForViewer,
  roadCost,
  rollSeededDice,
  serializeForViewer,
  settlementCost,
  specialCardCost,
  subtractResources,
  validateBoard,
  validateReplayLog,
  type EdgeId,
  type GameEvent,
  type GameCommand,
  type GameState,
  type HexId,
  type PlayerId,
  type ResourceBundle,
  type VertexId,
} from "../src/index.js";
import { applyOrThrow, completeSetup, createDemoConfig, createDemoGame, playBotGame, withResources } from "@colonizt/test-utils";

const expectReject = (state: GameState, command: GameCommand, code: string): void => {
  const result = applyCommand(state, command);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe(code);
};

const buildUntilSettlementAvailable = (state: GameState, playerId: PlayerId): GameState => {
  let current = state;
  for (let index = 0; index < 8; index += 1) {
    const settlement = getLegalActions(current, playerId).find((candidate) => candidate.type === "BUILD_SETTLEMENT");
    if (settlement?.type === "BUILD_SETTLEMENT" && settlement.vertices[0]) return current;
    const road = getLegalActions(current, playerId).find((candidate) => candidate.type === "BUILD_ROAD");
    if (road?.type !== "BUILD_ROAD" || !road.edges[0]) return current;
    current = applyOrThrow(current, { type: "BUILD_ROAD", playerId, edgeId: road.edges[0] }).state;
  }
  return current;
};

const soloConfig = (seed = "solo-test") => ({
  matchId: `match-${seed}`,
  seed,
  victoryPoints: 3,
  maxPlayers: 1,
  turnSeconds: 45,
  playerOrder: ["p1"],
  playerNames: { p1: "Aster" },
  playerColors: { p1: "#2563eb" },
});

const setupSoloAtVertex = (vertexId: VertexId, edgeId: EdgeId): GameState => {
  const initial = createGame(soloConfig(), createFixedBoard());
  let setup = applyOrThrow(initial, { type: "PLACE_SETUP", playerId: "p1", vertexId, edgeId }).state;
  const action = getLegalActions(setup, "p1").find((candidate) => candidate.type === "PLACE_SETUP");
  if (action?.type !== "PLACE_SETUP") throw new Error("No second setup placement");
  const secondVertex = action.vertices[0]!;
  const secondEdge = setup.board.adjacency.vertexToEdges[secondVertex]!.find((candidate) => !setup.roads[candidate]) as EdgeId;
  setup = applyOrThrow(setup, { type: "PLACE_SETUP", playerId: "p1", vertexId: secondVertex, edgeId: secondEdge }).state;
  return applyOrThrow(setup, { type: "ROLL_DICE", playerId: "p1" }).state;
};

const setupSoloWithSecondVertex = (vertexId: VertexId): { state: GameState; event: Extract<GameEvent, { type: "SETUP_PLACED" }> } => {
  const initial = createGame(soloConfig(), createFixedBoard());
  const firstAction = getLegalActions(initial, "p1").find((candidate) => candidate.type === "PLACE_SETUP");
  if (firstAction?.type !== "PLACE_SETUP") throw new Error("No first setup placement");
  for (const firstVertex of firstAction.vertices) {
    if (firstVertex === vertexId) continue;
    const firstEdge = initial.board.adjacency.vertexToEdges[firstVertex]![0] as EdgeId;
    const first = applyCommand(initial, { type: "PLACE_SETUP", playerId: "p1", vertexId: firstVertex, edgeId: firstEdge });
    if (!first.ok) continue;
    for (const secondEdge of first.value.nextState.board.adjacency.vertexToEdges[vertexId] ?? []) {
      const second = applyCommand(first.value.nextState, { type: "PLACE_SETUP", playerId: "p1", vertexId, edgeId: secondEdge as EdgeId });
      if (!second.ok) continue;
      const event = second.value.events.find((candidate) => candidate.type === "SETUP_PLACED");
      if (event?.type === "SETUP_PLACED") return { state: second.value.nextState, event };
    }
  }
  throw new Error("No legal second setup placement for target vertex");
};

describe("board generation and validation", () => {
  it("creates a valid fixed board", () => {
    expect(validateBoard(createFixedBoard())).toEqual([]);
  });

  it("rejects invalid boards and empty player orders while applying player fallbacks", () => {
    const invalidBoard = structuredClone(createFixedBoard());
    delete invalidBoard.vertices[Object.keys(invalidBoard.vertices)[0] as VertexId];
    expect(() => createGame(soloConfig("invalid-board"), invalidBoard)).toThrow(/^Invalid board:/);
    expect(() => createGame({ ...soloConfig("empty-order"), playerOrder: [] }, createFixedBoard())).toThrow("Game requires at least one player");

    const fallbackPlayer = createGame({
      ...soloConfig("player-fallbacks"),
      playerNames: {},
      playerColors: {},
    }, createFixedBoard()).players.p1;
    expect(fallbackPlayer).toMatchObject({ name: "p1", color: "#64748b" });
  });

  it("creates seed-reproducible random boards", () => {
    expect(createSeededBoard("same")).toEqual(createSeededBoard("same"));
    expect(createSeededBoard("same")).not.toEqual(createSeededBoard("different"));
  });

  it("creates deterministic valid map preset boards", () => {
    for (const mapPreset of ["standard", "islands", "continent"] as const) {
      const first = createBoardForRules("preset-same", { mapPreset, mapRandomized: true });
      const second = createBoardForRules("preset-same", { mapPreset, mapRandomized: true });
      expect(first).toEqual(second);
      expect(validateBoard(first)).toEqual([]);
    }
  });

  it("preserves legacy mapRandomized board behavior when no preset is present", () => {
    expect(createBoardForRules("legacy-random", { mapRandomized: true })).toEqual(createSeededBoard("legacy-random", 2));
    expect(createBoardForRules("legacy-fixed", { mapRandomized: false })).toEqual(createFixedBoard());
    expect(createBoardForRules("standard-preset", { mapPreset: "standard", mapRandomized: false })).toEqual(createSeededBoard("standard-preset", 2));
    expect(createDemoGame("standard-preset-config", { rules: { mapPreset: "standard", mapRandomized: false } }).config.rules?.mapRandomized).toBe(true);
  });

  it("creates two disconnected seeded islands", () => {
    const board = createBoardForRules("island-shape", { mapPreset: "islands", mapRandomized: true });
    expect(validateBoard(board)).toEqual([]);
    expect(Object.keys(board.hexes)).toHaveLength(38);
    expect(boardHexComponentCount(board)).toBe(2);
  });

  it("creates one connected irregular continent", () => {
    const board = createBoardForRules("continent-shape", { mapPreset: "continent", mapRandomized: true });
    expect(validateBoard(board)).toEqual([]);
    expect(Object.keys(board.hexes)).toHaveLength(31);
    expect(boardHexComponentCount(board)).toBe(1);
    expect(Object.keys(board.hexes)).not.toHaveLength(Object.keys(createSeededBoard("continent-shape", 3).hexes).length);
  });

  it("rejects invalid token values", () => {
    const board = createFixedBoard();
    const hex = Object.values(board.hexes).find((candidate) => candidate.resource !== "desert")!;
    hex.token = 7;
    expect(validateBoard(board).join(" ")).toContain("invalid token");
  });

  it("creates one tokenless desert and deterministic coastal ports", () => {
    const board = createFixedBoard();
    const deserts = Object.values(board.hexes).filter((hex) => hex.resource === "desert");
    expect(deserts).toHaveLength(1);
    expect(deserts[0]!.token).toBeUndefined();
    expect(Object.values(board.ports)).toHaveLength(9);
    expect(Object.values(board.ports).some((port) => port.ratio === 3 && !port.resource)).toBe(true);
    expect(Object.values(board.ports).some((port) => port.ratio === 2 && port.resource === "timber")).toBe(true);
  });

  it("uses classic resource counts and avoids adjacent red tokens on 19-hex boards", () => {
    const board = createSeededBoard("balanced-board", 2);
    const terrainCounts = Object.values(board.hexes).reduce<Record<string, number>>((counts, hex) => {
      counts[hex.resource] = (counts[hex.resource] ?? 0) + 1;
      return counts;
    }, {});
    expect(terrainCounts).toMatchObject({ timber: 4, brick: 3, grain: 4, fiber: 4, ore: 3, desert: 1 });
    const tokenCounts = Object.values(board.hexes).reduce<Record<number, number>>((counts, hex) => {
      if (hex.token) counts[hex.token] = (counts[hex.token] ?? 0) + 1;
      return counts;
    }, {});
    expect(tokenCounts).toMatchObject({ 2: 1, 3: 2, 4: 2, 5: 2, 6: 2, 8: 2, 9: 2, 10: 2, 11: 2, 12: 1 });

    const coordToHex = new Map(Object.values(board.hexes).map((hex) => [`${hex.q},${hex.r}`, hex]));
    for (const hex of Object.values(board.hexes)) {
      if (hex.token !== 6 && hex.token !== 8) continue;
      const neighbors = [
        { q: hex.q + 1, r: hex.r },
        { q: hex.q - 1, r: hex.r },
        { q: hex.q, r: hex.r + 1 },
        { q: hex.q, r: hex.r - 1 },
        { q: hex.q + 1, r: hex.r - 1 },
        { q: hex.q - 1, r: hex.r + 1 },
      ];
      expect(neighbors.every((coord) => {
        const neighbor = coordToHex.get(`${coord.q},${coord.r}`);
        return neighbor?.token !== 6 && neighbor?.token !== 8;
      })).toBe(true);
    }
  });

  it("rejects ports that are not attached to coast edges", () => {
    const board = createFixedBoard();
    const inlandEdge = Object.values(board.edges).find((edge) => edge.adjacentHexes.length === 2)!;
    board.ports.bad = { id: "bad", edgeId: inlandEdge.id, vertexIds: inlandEdge.vertices, ratio: 3 };
    expect(validateBoard(board).join(" ")).toContain("not on a coast edge");
  });

  it("keeps graph edges connected to known vertices", () => {
    const board = createFixedBoard();
    for (const edge of Object.values(board.edges)) {
      expect(board.vertices[edge.vertices[0]]).toBeDefined();
      expect(board.vertices[edge.vertices[1]]).toBeDefined();
    }
  });
});

describe("game setup and phases", () => {
  it("starts in setup placement with the first player active", () => {
    const state = createDemoGame();
    expect(state.phase).toMatchObject({ type: "SETUP_PLACEMENT", activePlayerId: "p1" });
  });

  it("rejects setup from a non-active player", () => {
    const state = createDemoGame();
    const vertexId = Object.keys(state.board.vertices)[0] as VertexId;
    const edgeId = state.board.adjacency.vertexToEdges[vertexId]![0] as EdgeId;
    expectReject(state, { type: "PLACE_SETUP", playerId: "p2", vertexId, edgeId }, "NOT_ACTIVE_PLAYER");
  });

  it("rejects setup with a non-adjacent edge", () => {
    const state = createDemoGame();
    const vertexId = Object.keys(state.board.vertices)[0] as VertexId;
    const edgeId = Object.keys(state.board.edges).find((candidate) => !state.board.edges[candidate]!.vertices.includes(vertexId)) as EdgeId;
    expectReject(state, { type: "PLACE_SETUP", playerId: "p1", vertexId, edgeId }, "EDGE_NOT_ADJACENT");
  });

  it("advances through setup into waiting for roll", () => {
    const { state, events } = completeSetup(createDemoGame());
    expect(events.filter((event) => event.type === "SETUP_PLACED")).toHaveLength(8);
    expect(events.filter((event) => event.type === "SETUP_PLACED").map((event) => event.playerId)).toEqual(["p1", "p2", "p3", "p4", "p4", "p3", "p2", "p1"]);
    expect(state.phase).toMatchObject({ type: "WAITING_FOR_ROLL", activePlayerId: "p1" });
  });

  it("completes setup on every map preset", () => {
    for (const mapPreset of ["standard", "islands", "continent"] as const) {
      const { state, events } = completeSetup(createDemoGame(`setup-${mapPreset}`, { rules: { mapPreset, mapRandomized: true } }));
      expect(events.filter((event) => event.type === "SETUP_PLACED")).toHaveLength(state.playerOrder.length * 2);
      expect(state.phase).toMatchObject({ type: "WAITING_FOR_ROLL", activePlayerId: "p1" });
    }
  });

  it("supports configurable demo player counts", () => {
    const state = createDemoGame("six-player-demo", { playerCount: 6 });
    expect(state.playerOrder).toEqual(["p1", "p2", "p3", "p4", "p5", "p6"]);
    expect(state.config.maxPlayers).toBe(6);
  });

  it("enforces settlement distance during setup", () => {
    const initial = createDemoGame();
    const first = completeSetup(initial).state;
    const occupied = Object.keys(first.settlements)[0] as VertexId;
    expect(canPlaceSettlement(first, occupied, false)).toBe(false);
  });

  it("rejects rolling before setup is done", () => {
    expectReject(createDemoGame(), { type: "ROLL_DICE", playerId: "p1" }, "WRONG_PHASE");
  });

  it("returns stable errors for unknown entities and exhausted pieces", () => {
    const setup = createDemoGame("validation-boundaries");
    const setupVertex = Object.keys(setup.board.vertices)[0] as VertexId;
    const setupEdge = setup.board.adjacency.vertexToEdges[setupVertex]![0] as EdgeId;
    expectReject(setup, { type: "PLACE_SETUP", playerId: "missing", vertexId: setupVertex, edgeId: setupEdge }, "UNKNOWN_PLAYER");
    expectReject(setup, { type: "PLACE_SETUP", playerId: "p1", vertexId: "missing" as VertexId, edgeId: setupEdge }, "UNKNOWN_VERTEX");
    expectReject(setup, { type: "PLACE_SETUP", playerId: "p1", vertexId: setupVertex, edgeId: "missing" as EdgeId }, "UNKNOWN_EDGE");

    const state = completeSetup(setup).state;
    state.phase = { type: "ACTION_PHASE", activePlayerId: "p1" };
    expectReject(state, { type: "BUILD_ROAD", playerId: "p1", edgeId: "missing" as EdgeId }, "UNKNOWN_EDGE");
    expectReject(state, { type: "BUILD_SETTLEMENT", playerId: "p1", vertexId: "missing" as VertexId }, "UNKNOWN_VERTEX");
    expectReject(state, { type: "UPGRADE_CITY", playerId: "p1", vertexId: "missing" as VertexId }, "UNKNOWN_VERTEX");
    expectReject(state, { type: "UPGRADE_CITY", playerId: "p1", vertexId: setupVertex }, "TRADE_NOT_ALLOWED");
    expectReject(state, { type: "BUY_SPECIAL_CARD", playerId: "p1" }, "INSUFFICIENT_RESOURCES");

    const roadLimited = structuredClone(state);
    for (const edgeId of Object.keys(roadLimited.board.edges).slice(0, maxRoadsPerPlayer)) roadLimited.roads[edgeId] = "p1";
    expectReject(roadLimited, { type: "BUILD_ROAD", playerId: "p1", edgeId: Object.keys(roadLimited.board.edges)[maxRoadsPerPlayer] as EdgeId }, "PIECE_LIMIT");

    const settlementLimited = structuredClone(state);
    for (const vertexId of Object.keys(settlementLimited.board.vertices).slice(0, 5)) {
      settlementLimited.settlements[vertexId] = "p1";
      settlementLimited.buildings[vertexId] = { owner: "p1", type: "settlement" };
    }
    expectReject(settlementLimited, { type: "BUILD_SETTLEMENT", playerId: "p1", vertexId: Object.keys(settlementLimited.board.vertices)[8] as VertexId }, "PIECE_LIMIT");

    const cityLimited = structuredClone(state);
    const cityVertices = Object.keys(cityLimited.board.vertices).slice(0, 5) as VertexId[];
    for (const vertexId of cityVertices.slice(0, 4)) cityLimited.buildings[vertexId] = { owner: "p1", type: "city" };
    cityLimited.buildings[cityVertices[4]!] = { owner: "p1", type: "settlement" };
    expectReject(cityLimited, { type: "UPGRADE_CITY", playerId: "p1", vertexId: cityVertices[4]! }, "PIECE_LIMIT");
  });

  it("rolls dice into action phase after setup", () => {
    const { state } = completeSetup(createDemoGame());
    const result = applyCommand(state, { type: "ROLL_DICE", playerId: "p1" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.nextState.phase).toMatchObject({ type: "ACTION_PHASE", activePlayerId: "p1" });
      expect(result.value.events[0]?.type).toBe("DICE_ROLLED");
    }
  });

  it("doubles normal production when the dice doubles rule is enabled", () => {
    const { state } = completeSetup(createDemoGame("doubles-rule", { rules: { diceDoubles: true } }));
    const rngIndex = Array.from({ length: 120 }, (_, index) => index).find((index) => {
      const rolled = rollSeededDice(state.rng.seed, index);
      return rolled.dice[0] === rolled.dice[1];
    });
    expect(rngIndex).toBeDefined();
    const rolled = rollSeededDice(state.rng.seed, rngIndex!);
    const rolledSum = rolled.dice[0] + rolled.dice[1];

    const normal = structuredClone(state) as GameState;
    const doubled = structuredClone(state) as GameState;
    normal.config.rules = { ...normal.config.rules, diceDoubles: false };
    doubled.config.rules = { ...doubled.config.rules, diceDoubles: true };
    normal.rng.index = rngIndex!;
    doubled.rng.index = rngIndex!;
    for (const target of [normal, doubled]) {
      for (const hex of Object.values(target.board.hexes)) {
        if (hex.resource !== "desert") hex.token = rolledSum;
      }
    }

    const normalResult = applyOrThrow(normal, { type: "ROLL_DICE", playerId: "p1" });
    const doubledResult = applyOrThrow(doubled, { type: "ROLL_DICE", playerId: "p1" });
    const normalProduced = normalResult.events.find((event) => event.type === "RESOURCES_PRODUCED");
    const doubledRolled = doubledResult.events.find((event) => event.type === "DICE_ROLLED");
    const doubledProduced = doubledResult.events.find((event) => event.type === "RESOURCES_PRODUCED");

    expect(doubledRolled).toMatchObject({ type: "DICE_ROLLED", doublesMultiplier: 2 });
    expect(doubledProduced).toMatchObject({ type: "RESOURCES_PRODUCED", multiplier: 2 });
    expect(normalProduced?.type).toBe("RESOURCES_PRODUCED");
    expect(doubledProduced?.type).toBe("RESOURCES_PRODUCED");
    if (normalProduced?.type === "RESOURCES_PRODUCED" && doubledProduced?.type === "RESOURCES_PRODUCED") {
      for (const playerId of state.playerOrder) {
        expect(resourceCount({ ...emptyResources(), ...doubledProduced.gains[playerId] })).toBe(
          resourceCount({ ...emptyResources(), ...normalProduced.gains[playerId] }) * 2,
        );
      }
    }
  });

  it("does not produce a resource for anyone when the bank cannot pay every earned card", () => {
    const state = completeSetup(createDemoGame("bank-short-production")).state;
    let shortage: { rngIndex: number; resource: (typeof resources)[number]; beforeBank: number } | undefined;
    for (let candidate = state.rng.index; candidate < state.rng.index + 400 && !shortage; candidate += 2) {
      const rolled = rollSeededDice(state.rng.seed, candidate);
      if (rolled.dice[0] + rolled.dice[1] === 7) continue;
      const trial = structuredClone(state) as GameState;
      trial.rng.index = candidate;
      const result = applyCommand(trial, { type: "ROLL_DICE", playerId: "p1" });
      if (!result.ok) continue;
      const produced = result.value.events.find((event) => event.type === "RESOURCES_PRODUCED");
      if (produced?.type !== "RESOURCES_PRODUCED") continue;
      for (const resource of resources) {
        const total = Object.values(produced.gains).reduce((sum, gains) => sum + (gains[resource] ?? 0), 0);
        if (total > 1) {
          shortage = { rngIndex: candidate, resource, beforeBank: 1 };
          break;
        }
      }
    }
    expect(shortage).toBeDefined();
    if (!shortage) throw new Error("Expected a roll with multi-card resource production");
    state.rng.index = shortage.rngIndex;
    for (const player of Object.values(state.players)) player.resources[shortage.resource] = 0;
    state.players.p2!.resources[shortage.resource] = 18;
    state.resourceBank[shortage.resource] = shortage.beforeBank;

    const result = applyOrThrow(state, { type: "ROLL_DICE", playerId: "p1" });
    const produced = result.events.find((event) => event.type === "RESOURCES_PRODUCED");

    if (produced?.type === "RESOURCES_PRODUCED") {
      for (const gains of Object.values(produced.gains)) expect(gains[shortage.resource] ?? 0).toBe(0);
    }
    expect(result.state.resourceBank[shortage.resource]).toBe(shortage.beforeBank);
    expect(result.state.players.p2!.resources[shortage.resource]).toBe(18);
  });

  it("strikes one random building per player when plight reaches its turn", () => {
    let state = completeSetup(createDemoGame("plight-rule", { rules: { plight: true, plightTurn: 1 } })).state;
    state = applyOrThrow(state, { type: "ROLL_DICE", playerId: "p1" }).state;
    const result = applyOrThrow(state, { type: "END_TURN", playerId: "p1" });
    const plight = result.events.find((event) => event.type === "PLIGHT_STRUCK");

    expect(plight).toMatchObject({ type: "PLIGHT_STRUCK" });
    if (plight?.type !== "PLIGHT_STRUCK") throw new Error("Expected plight event");
    expect(plight.destroyed).toHaveLength(4);
    expect(result.state.plightApplied).toBe(true);
    for (const destroyed of plight.destroyed) {
      expect(result.state.buildings[destroyed.vertexId]).toBeUndefined();
      expect(result.state.settlements[destroyed.vertexId]).toBeUndefined();
      expect(result.state.players[destroyed.playerId]!.score).toBe(1);
    }
  });

  it("does not grant starting resources from adjacent desert tiles", () => {
    const initial = createGame(soloConfig("desert-start"), createFixedBoard());
    const desert = Object.values(initial.board.hexes).find((hex) => hex.resource === "desert")!;
    const vertexId = initial.board.adjacency.hexToVertices[desert.id]![0]!;
    const edgeId = initial.board.adjacency.vertexToEdges[vertexId]![0] as EdgeId;
    const result = applyCommand(initial, { type: "PLACE_SETUP", playerId: "p1", vertexId, edgeId });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const event = result.value.events[0];
      expect(event).toMatchObject({ type: "SETUP_PLACED", startingResources: {} });
    }
    const second = setupSoloWithSecondVertex(vertexId);
    const resourceHexCount = initial.board.vertices[vertexId]!.adjacentHexes
      .map((hexId) => initial.board.hexes[hexId]!)
      .filter((hex) => hex.resource !== "desert").length;
    expect(Object.values(second.event.startingResources).reduce((sum, count) => sum + (count ?? 0), 0)).toBe(resourceHexCount);
  });

  it("does not produce resources from desert-adjacent settlements when only desert could match", () => {
    const initial = createGame(soloConfig("desert-roll"), createFixedBoard());
    const desert = Object.values(initial.board.hexes).find((hex) => hex.resource === "desert")!;
    const vertexId = initial.board.adjacency.hexToVertices[desert.id]![0]!;
    const state = setupSoloWithSecondVertex(vertexId).state;
    const rolled = rollSeededDice(state.rng.seed, state.rng.index);
    const rolledSum = rolled.dice[0] + rolled.dice[1];
    const nonMatchingToken = rolledSum === 2 ? 3 : 2;
    for (const hex of Object.values(state.board.hexes)) {
      if (hex.resource !== "desert") hex.token = nonMatchingToken;
    }
    const before = state.players.p1!.resources;
    const result = applyCommand(state, { type: "ROLL_DICE", playerId: "p1" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.events.some((event) => event.type === "RESOURCES_PRODUCED")).toBe(false);
      expect(result.value.nextState.players.p1!.resources).toEqual(before);
    }
  });

  it("rejects ending before action phase", () => {
    const { state } = completeSetup(createDemoGame());
    expectReject(state, { type: "END_TURN", playerId: "p1" }, "WRONG_PHASE");
  });

  it("ends turn and advances to the next player", () => {
    let state = completeSetup(createDemoGame()).state;
    state = applyOrThrow(state, { type: "ROLL_DICE", playerId: "p1" }).state;
    const ended = applyOrThrow(state, { type: "END_TURN", playerId: "p1" }).state;
    expect(ended.phase).toMatchObject({ type: "WAITING_FOR_ROLL", activePlayerId: "p2" });
  });
});

describe("replay validation", () => {
  it("rejects duplicate, missing, and non-1 replay sequences", () => {
    const { state, events } = completeSetup(createDemoGame("replay-validation"));
    const log = { config: state.config, board: state.board, events: events.slice(0, 3) };

    expect(validateReplayLog(log)).toEqual([]);
    const invalidStart = validateReplayLog({ ...log, events: [log.events[1]!] });
    const duplicate = validateReplayLog({ ...log, events: [log.events[0]!, { ...log.events[1]!, seq: 1 }] });
    const missing = validateReplayLog({ ...log, events: [log.events[0]!, { ...log.events[2]!, seq: 3 }] });
    expect(invalidStart.map((issue) => issue.code)).toEqual(["INVALID_SEQUENCE_START"]);
    expect(duplicate.map((issue) => issue.code)).toEqual(["DUPLICATE_SEQUENCE"]);
    expect(missing.map((issue) => issue.code)).toEqual(["MISSING_SEQUENCE"]);
    expect(() => replay({ ...log, events: [log.events[1]!] })).toThrow(/expected event sequence 1, got 2/i);
    expect(() => replay({ ...log, events: [log.events[0]!, { ...log.events[1]!, seq: 1 }] })).toThrow(/appears more than once/);
    expect(() => replay({ ...log, events: [log.events[0]!, { ...log.events[2]!, seq: 3 }] })).toThrow(/expected event sequence 2, got 3/i);

    expect(() => replay({ ...log, events: [{ ...log.events[1]!, seq: 2 }, { ...log.events[2]!, seq: 2 }] }))
      .toThrow("Invalid replay log: Replay expected event sequence 1, got 2; Replay event sequence 2 appears more than once");

    const twoGaps = validateReplayLog({ ...log, events: [log.events[0]!, { ...log.events[1]!, seq: 3 }, { ...log.events[2]!, seq: 4 }] });
    expect(twoGaps.map((issue) => issue.code)).toEqual(["MISSING_SEQUENCE"]);
  });

  it("rejects unknown and structurally malformed replay events", () => {
    const state = createDemoGame("invalid-replay-events");
    const unknown = { schemaVersion: 3, seq: 1, type: "UNKNOWN_EVENT" } as unknown as GameEvent;
    const malformed = { schemaVersion: 3, seq: 1, type: "TURN_ENDED", playerId: "p1" } as unknown as GameEvent;

    expect(validateReplayLog({ config: state.config, board: state.board, events: [unknown] })).toEqual(expect.arrayContaining([expect.objectContaining({ code: "INVALID_EVENT" })]));
    expect(() => replay({ config: state.config, board: state.board, events: [malformed] })).toThrow(/unknown type or invalid payload/i);
    expect(() => applyEvent(state, unknown)).toThrow(/unsupported game event type UNKNOWN_EVENT/i);
  });

  it("replays a validated snapshot plus tail to the same state as the full event log", () => {
    const { state, events } = completeSetup(createDemoGame("replay-snapshot-tail"));
    const snapshotSeq = 4;
    const snapshot = replay({ config: state.config, board: state.board, events: events.filter((event) => event.seq <= snapshotSeq) });
    const tail = events.filter((event) => event.seq > snapshotSeq);

    expect(validateReplayLog({ config: state.config, board: state.board, snapshot: { seq: snapshotSeq, state: snapshot }, events: tail })).toEqual([]);
    expect(replay({ config: state.config, board: state.board, snapshot: { seq: snapshotSeq, state: snapshot }, events: tail })).toEqual(state);
    expect(replay({ config: state.config, board: state.board, snapshot: { seq: snapshotSeq, state: snapshot }, events: [...tail].reverse() })).toEqual(state);
  });

  it("applies imported events by sequence rather than input order", () => {
    const state = createDemoGame("replay-event-order");
    const events: GameEvent[] = [
      { schemaVersion: 3, seq: 2, type: "TURN_ENDED", playerId: "p2", nextPlayerId: "p1" },
      { schemaVersion: 3, seq: 1, type: "TURN_ENDED", playerId: "p1", nextPlayerId: "p2" },
    ];

    const replayed = replay({ config: state.config, board: state.board, events });

    expect(replayed.turn).toBe(2);
    expect(replayed.phase).toEqual({ type: "WAITING_FOR_ROLL", activePlayerId: "p1" });
  });

  it("reports malformed snapshots and events with precise import diagnostics", () => {
    const state = createDemoGame("malformed-replay-diagnostics");
    const badSnapshot = structuredClone(state) as GameState;
    badSnapshot.schemaVersion = 99;
    badSnapshot.eventSeq = 4;
    const events = [
      null,
      { schemaVersion: 3, seq: 0, type: "TURN_ENDED", playerId: "p1", nextPlayerId: "p2" },
      { schemaVersion: 3, seq: 1 },
      { schemaVersion: 99, seq: 2, type: "TURN_ENDED", playerId: "p1", nextPlayerId: "p2" },
    ] as unknown as GameEvent[];

    const issues = validateReplayLog({
      config: state.config,
      board: state.board,
      snapshot: { seq: -1, state: badSnapshot },
      events,
    });

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "INVALID_SNAPSHOT", message: expect.stringContaining("non-negative integer") }),
      expect.objectContaining({ code: "INVALID_SNAPSHOT", message: expect.stringContaining("does not match") }),
      expect.objectContaining({ code: "UNSUPPORTED_SCHEMA", message: expect.stringContaining("snapshot schema") }),
      expect.objectContaining({ code: "INVALID_EVENT", message: "Replay event must be an object" }),
      expect.objectContaining({ code: "INVALID_EVENT", message: expect.stringContaining("positive integer") }),
      expect.objectContaining({ code: "INVALID_EVENT", message: expect.stringContaining("missing a type") }),
      expect.objectContaining({ code: "UNSUPPORTED_SCHEMA", message: expect.stringContaining("event 2 schema") }),
    ]));
  });
});

describe("board validation", () => {
  it("reports distribution, topology, and playability corruption together", () => {
    const board = structuredClone(createFixedBoard());
    const hexes = Object.values(board.hexes);
    const center = hexes.find((hex) => hex.q === 0 && hex.r === 0)!;
    const neighbor = hexes.find((hex) => hex.q === 1 && hex.r === 0)!;
    const distributionHex = hexes.find((hex) => hex.resource === "fiber")!;
    distributionHex.resource = "ore";
    center.resource = "timber";
    center.token = 6;
    neighbor.resource = "brick";
    neighbor.token = 8;
    const desert = hexes.find((hex) => hex.resource === "desert");
    if (desert) desert.token = 5;
    board.adjacency.hexToVertices[center.id] = [];
    const [edgeId, edge] = Object.entries(board.edges)[0]!;
    edge.vertices[1] = "missing";
    board.adjacency.edgeToVertices[edgeId] = ["mismatch-a", "mismatch-b"];
    for (const vertexId of Object.keys(board.vertices).slice(7)) delete board.vertices[vertexId];

    const errors = validateBoard(board);
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/classic board has .* tiles, expected/),
      expect.stringMatching(/adjacent red tokens/),
      expect.stringMatching(/desert cannot have token/),
      expect.stringMatching(/does not have six vertices/),
      expect.stringMatching(/invalid endpoints/),
      expect.stringMatching(/adjacency mismatch/),
      "board is too small to be playable",
    ]));
  });
});

describe("building and resources", () => {
  const setupAction = (): GameState => applyOrThrow(completeSetup(createDemoGame()).state, { type: "ROLL_DICE", playerId: "p1" }).state;

  it("rejects road build without resources", () => {
    const state = setupAction();
    state.players.p1!.resources = emptyResources();
    const edge = getLegalActions(withResources(state, "p1", roadCost()), "p1").find((action) => action.type === "BUILD_ROAD");
    expect(edge?.type).toBe("BUILD_ROAD");
    expectReject(state, { type: "BUILD_ROAD", playerId: "p1", edgeId: edge!.edges[0]! }, "INSUFFICIENT_RESOURCES");
  });

  it("builds a road with resources", () => {
    const state = withResources(setupAction(), "p1", roadCost());
    const action = getLegalActions(state, "p1").find((candidate) => candidate.type === "BUILD_ROAD");
    expect(action?.type).toBe("BUILD_ROAD");
    const next = applyOrThrow(state, { type: "BUILD_ROAD", playerId: "p1", edgeId: action!.edges[0]! }).state;
    expect(Object.values(next.roads).filter((owner) => owner === "p1").length).toBeGreaterThan(1);
  });

  it("rejects duplicate roads", () => {
    const state = setupAction();
    const occupied = Object.entries(state.roads).find(([, owner]) => owner === "p1")![0] as EdgeId;
    expectReject(withResources(state, "p1", roadCost()), { type: "BUILD_ROAD", playerId: "p1", edgeId: occupied }, "POSITION_OCCUPIED");
  });

  it("does not advertise road builds after the piece limit", () => {
    const state = withResources(setupAction(), "p1", { timber: 20, brick: 20 });
    for (const edgeId of Object.keys(state.board.edges).slice(0, maxRoadsPerPlayer)) {
      state.roads[edgeId as EdgeId] = "p1";
    }
    expect(getLegalActions(state, "p1").some((action) => action.type === "BUILD_ROAD")).toBe(false);
  });

  it("builds a settlement and updates score", () => {
    let state = withResources(setupAction(), "p1", { timber: 5, brick: 5, grain: 5, fiber: 5, ore: 5 });
    state = buildUntilSettlementAvailable(state, "p1");
    const settlementAction = getLegalActions(state, "p1").find((candidate) => candidate.type === "BUILD_SETTLEMENT");
    expect(settlementAction?.type).toBe("BUILD_SETTLEMENT");
    const next = applyOrThrow(state, { type: "BUILD_SETTLEMENT", playerId: "p1", vertexId: settlementAction!.vertices[0]! }).state;
    expect(next.players.p1!.score).toBe(3);
  });

  it("upgrades a settlement to a city and produces two resources", () => {
    let state = withResources(setupAction(), "p1", cityCost());
    const vertexId = Object.entries(state.buildings).find(([, building]) => building.owner === "p1" && building.type === "settlement")![0] as VertexId;
    state = applyOrThrow(state, { type: "UPGRADE_CITY", playerId: "p1", vertexId }).state;
    expect(state.buildings[vertexId]).toEqual({ owner: "p1", type: "city" });
    expect(state.players.p1!.score).toBe(3);

    state.phase = { type: "WAITING_FOR_ROLL", activePlayerId: "p1" };
    const rolled = rollSeededDice(state.rng.seed, state.rng.index);
    const rolledSum = rolled.dice[0] + rolled.dice[1];
    const productiveHex = state.board.vertices[vertexId]!.adjacentHexes
      .map((hexId) => state.board.hexes[hexId]!)
      .find((hex) => hex.resource !== "desert")!;
    for (const hex of Object.values(state.board.hexes)) {
      if (hex.resource !== "desert") hex.token = rolledSum === 2 ? 3 : 2;
    }
    productiveHex.token = rolledSum;
    const before = state.players.p1!.resources[productiveHex.resource as keyof ResourceBundle];
    const rolledState = applyOrThrow(state, { type: "ROLL_DICE", playerId: "p1" }).state;
    expect(rolledState.players.p1!.resources[productiveHex.resource as keyof ResourceBundle]).toBeGreaterThanOrEqual(before + 2);
  });

  it("awards longest road once a player reaches five connected roads", () => {
    let state = withResources(setupAction(), "p1", { timber: 20, brick: 20, grain: 20, fiber: 20, ore: 20 });
    for (let index = 0; index < 12 && !state.players.p1!.hasLongestRoad; index += 1) {
      const road = getLegalActions(state, "p1").find((candidate) => candidate.type === "BUILD_ROAD");
      expect(road?.type).toBe("BUILD_ROAD");
      state = applyOrThrow(state, { type: "BUILD_ROAD", playerId: "p1", edgeId: road!.edges[0]! }).state;
    }
    expect(state.players.p1!.longestRoadLength).toBeGreaterThanOrEqual(5);
    expect(state.players.p1!.hasLongestRoad).toBe(true);
    expect(state.longestRoadOwner).toBe("p1");
    expect(state.players.p1!.score).toBeGreaterThanOrEqual(4);
  });

  it("triggers game over at victory threshold", () => {
    let state = withResources(setupAction(), "p1", { timber: 10, brick: 10, grain: 10, fiber: 10, ore: 10 });
    state.config.victoryPoints = 3;
    state = buildUntilSettlementAvailable(state, "p1");
    const settlement = getLegalActions(state, "p1").find((candidate) => candidate.type === "BUILD_SETTLEMENT");
    if (settlement?.type === "BUILD_SETTLEMENT") state = applyOrThrow(state, { type: "BUILD_SETTLEMENT", playerId: "p1", vertexId: settlement.vertices[0]! }).state;
    expect(state.phase.type).toBe("GAME_OVER");
  });

  it("keeps resources non-negative after costs", () => {
    let state = withResources(setupAction(), "p1", { timber: 2, brick: 2, grain: 1, fiber: 1 });
    const road = getLegalActions(state, "p1").find((candidate) => candidate.type === "BUILD_ROAD");
    if (road?.type === "BUILD_ROAD") state = applyOrThrow(state, { type: "BUILD_ROAD", playerId: "p1", edgeId: road.edges[0]! }).state;
    expect(assertInvariants(state).ok).toBe(true);
  });

  it("buys special cards with the configured three-resource recipe", () => {
    let state = withResources(setupAction(), "p1", specialCardCost());
    const action = getLegalActions(state, "p1").find((candidate) => candidate.type === "BUY_SPECIAL_CARD");
    expect(action).toMatchObject({ type: "BUY_SPECIAL_CARD" });
    const result = applyOrThrow(state, { type: "BUY_SPECIAL_CARD", playerId: "p1" });
    expect(result.events[0]).toMatchObject({ type: "SPECIAL_CARD_BOUGHT", playerId: "p1", cardIndex: 1 });
    expect(result.state.players.p1!.specialCards).toBe(1);
    expect(resourceCount(result.state.players.p1!.resources)).toBeLessThan(resourceCount(state.players.p1!.resources));

    state = createGame({ ...soloConfig("random-special"), rules: { specialCardCostRandomized: true } });
    expect(resourceCount(specialCardCost(state.config.rules))).toBe(3);
    const randomizedRecipes = ["random-special-a", "random-special-b", "random-special-c", "random-special-d"].map((seed) =>
      specialCardCost(createGame({ ...soloConfig(seed), rules: { specialCardCostRandomized: true } }).config.rules),
    );
    expect(randomizedRecipes.some((cost) => !resources.every((resource) => cost[resource] === specialCardCost({})[resource]))).toBe(true);
  });
});

describe("trading", () => {
  const tradeReady = (): GameState =>
    withResources(applyOrThrow(completeSetup(createDemoGame()).state, { type: "ROLL_DICE", playerId: "p1" }).state, "p1", { timber: 2, brick: 2 });

  it("offers a trade as an authoritative event", () => {
    const state = tradeReady();
    const command: GameCommand = { type: "OFFER_TRADE", playerId: "p1", tradeId: "t1", offered: { ...emptyResources(), timber: 1 }, requested: { ...emptyResources(), ore: 1 }, recipients: "ANY" };
    const result = applyCommand(state, command);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.events[0]?.type).toBe("TRADE_OFFERED");
  });

  it("rejects trades without offered resources", () => {
    const state = tradeReady();
    expectReject(state, { type: "OFFER_TRADE", playerId: "p1", tradeId: "bad", offered: emptyResources(), requested: { ...emptyResources(), ore: 1 }, recipients: "ANY" }, "TRADE_NOT_ALLOWED");
  });

  it("rejects malformed and self-canceling player trades", () => {
    const state = tradeReady();
    expectReject(state, { type: "OFFER_TRADE", playerId: "p1", tradeId: "negative", offered: { ...emptyResources(), timber: -1 }, requested: { ...emptyResources(), ore: 1 }, recipients: "ANY" }, "TRADE_NOT_ALLOWED");
    expectReject(state, { type: "OFFER_TRADE", playerId: "p1", tradeId: "same", offered: { ...emptyResources(), timber: 1 }, requested: { ...emptyResources(), timber: 1 }, recipients: "ANY" }, "TRADE_NOT_ALLOWED");
    expectReject(state, { type: "OFFER_TRADE", playerId: "p1", tradeId: "self", offered: { ...emptyResources(), timber: 1 }, requested: { ...emptyResources(), ore: 1 }, recipients: ["p1"] }, "TRADE_NOT_ALLOWED");
    expectReject(state, { type: "OFFER_TRADE", playerId: "p1", tradeId: "empty-recipients", offered: { ...emptyResources(), timber: 1 }, requested: { ...emptyResources(), ore: 1 }, recipients: [] }, "TRADE_NOT_ALLOWED");
    expectReject(state, { type: "OFFER_TRADE", playerId: "p1", tradeId: "dupe", offered: { ...emptyResources(), timber: 1 }, requested: { ...emptyResources(), ore: 1 }, recipients: ["p2", "p2"] }, "TRADE_NOT_ALLOWED");
    expectReject(state, { type: "OFFER_TRADE", playerId: "p1", tradeId: "unknown", offered: { ...emptyResources(), timber: 1 }, requested: { ...emptyResources(), ore: 1 }, recipients: ["missing"] }, "UNKNOWN_PLAYER");
  });

  it("stages responses before finalizing a player trade", () => {
    let state = withResources(tradeReady(), "p2", { ore: 1 });
    state = applyOrThrow(state, { type: "OFFER_TRADE", playerId: "p1", tradeId: "t2", offered: { ...emptyResources(), timber: 1 }, requested: { ...emptyResources(), ore: 1 }, recipients: "ANY" }).state;
    expect(state.trades.t2).toMatchObject({ status: "COLLECTING_RESPONSES" });
    const beforeTimber = state.players.p2!.resources.timber;
    const responded = applyOrThrow(state, { type: "RESPOND_TRADE", playerId: "p2", tradeId: "t2", response: "WANTS_ACCEPT" });
    expect(responded.events[0]).toMatchObject({ type: "TRADE_RESPONSE_RECORDED", tradeId: "t2", playerId: "p2", response: "WANTS_ACCEPT" });
    expect(responded.state.players.p2!.resources.timber).toBe(beforeTimber);
    const accepted = applyOrThrow(responded.state, { type: "FINALIZE_TRADE", playerId: "p1", tradeId: "t2", toPlayerId: "p2" }).state;
    expect(accepted.trades.t2!.status).toBe("ACCEPTED");
    expect(accepted.players.p2!.resources.timber).toBe(beforeTimber + 1);
  });

  it("rejects finalization when offerer no longer has resources", () => {
    let state = withResources(tradeReady(), "p2", { ore: 1 });
    state = applyOrThrow(state, { type: "OFFER_TRADE", playerId: "p1", tradeId: "t3", offered: { ...emptyResources(), timber: 2 }, requested: { ...emptyResources(), ore: 1 }, recipients: "ANY" }).state;
    state = applyOrThrow(state, { type: "RESPOND_TRADE", playerId: "p2", tradeId: "t3", response: "WANTS_ACCEPT" }).state;
    state.players.p1!.resources.timber = 0;
    expectReject(state, { type: "FINALIZE_TRADE", playerId: "p1", tradeId: "t3", toPlayerId: "p2" }, "INSUFFICIENT_RESOURCES");
  });

  it("cancels only by creator", () => {
    let state = tradeReady();
    state = applyOrThrow(state, { type: "OFFER_TRADE", playerId: "p1", tradeId: "t4", offered: { ...emptyResources(), timber: 1 }, requested: { ...emptyResources(), ore: 1 }, recipients: "ANY" }).state;
    expectReject(state, { type: "CANCEL_TRADE", playerId: "p2", tradeId: "t4" }, "TRADE_NOT_ALLOWED");
    expect(applyCommand(state, { type: "CANCEL_TRADE", playerId: "p1", tradeId: "t4" }).ok).toBe(true);
  });

  it("uses exclusive trade TTL boundaries for legacy-open expiry", () => {
    let state = withResources(tradeReady(), "p2", { ore: 1 });
    state = applyOrThrow(state, { type: "OFFER_TRADE", playerId: "p1", tradeId: "ttl", offered: { ...emptyResources(), timber: 1 }, requested: { ...emptyResources(), ore: 1 }, recipients: "ANY", ttlEvents: 1 }).state;
    expectReject(state, { type: "EXPIRE_TRADE", playerId: "p1", tradeId: "ttl" }, "STALE_TRADE");
    const timedOut = applyOrThrow(state, { type: "EXPIRE_TRADE", playerId: "p1", tradeId: "ttl", reason: "RESPONSE_TIMEOUT" }).state;
    expect(timedOut.trades.ttl).toMatchObject({ status: "CLOSED", closedReason: "RESPONSE_TIMEOUT" });

    state = withResources(tradeReady(), "p2", { ore: 1 });
    state = applyOrThrow(state, { type: "OFFER_TRADE", playerId: "p1", tradeId: "ttl2", offered: { ...emptyResources(), timber: 1 }, requested: { ...emptyResources(), ore: 1 }, recipients: "ANY", ttlEvents: 1 }).state;
    state = { ...state, eventSeq: state.trades.ttl2!.expiresAtSeq };
    const expired = applyOrThrow(state, { type: "EXPIRE_TRADE", playerId: "p1", tradeId: "ttl2" }).state;
    expect(expired.trades.ttl2).toMatchObject({ status: "CLOSED", closedReason: "TTL" });
  });

  it("returns stable errors for missing, stale, and unauthorized trade transitions", () => {
    const state = withResources(tradeReady(), "p2", { ore: 1 });
    const missingCommands: GameCommand[] = [
      { type: "CANCEL_TRADE", playerId: "p1", tradeId: "missing" },
      { type: "RESPOND_TRADE", playerId: "p2", tradeId: "missing", response: "PASS" },
      { type: "FINALIZE_TRADE", playerId: "p1", tradeId: "missing", toPlayerId: "p2" },
      { type: "ACCEPT_TRADE", playerId: "p2", tradeId: "missing" },
      { type: "REJECT_TRADE", playerId: "p2", tradeId: "missing" },
      { type: "EXPIRE_TRADE", playerId: "p1", tradeId: "missing" },
    ];
    for (const command of missingCommands) expectReject(state, command, "UNKNOWN_TRADE");

    const offered = { ...emptyResources(), timber: 1 };
    const requested = { ...emptyResources(), ore: 1 };
    const closed = structuredClone(state);
    closed.trades.closed = {
      id: "closed", fromPlayerId: "p1", offered, requested, recipients: ["p2"], status: "CLOSED",
      createdAtSeq: 0, expiresAtSeq: 1, responses: { p2: { playerId: "p2", status: "PENDING" } },
    };
    expectReject(closed, { type: "CANCEL_TRADE", playerId: "p1", tradeId: "closed" }, "STALE_TRADE");
    expectReject(closed, { type: "RESPOND_TRADE", playerId: "p2", tradeId: "closed", response: "PASS" }, "STALE_TRADE");
    expectReject(closed, { type: "FINALIZE_TRADE", playerId: "p1", tradeId: "closed", toPlayerId: "p2" }, "STALE_TRADE");
    expectReject(closed, { type: "ACCEPT_TRADE", playerId: "p2", tradeId: "closed" }, "STALE_TRADE");
    expectReject(closed, { type: "REJECT_TRADE", playerId: "p2", tradeId: "closed" }, "STALE_TRADE");
    expectReject(closed, { type: "EXPIRE_TRADE", playerId: "p1", tradeId: "closed" }, "STALE_TRADE");

    const collecting = structuredClone(state);
    collecting.trades.collecting = {
      id: "collecting", fromPlayerId: "p1", offered, requested, recipients: ["p2"], status: "COLLECTING_RESPONSES",
      createdAtSeq: collecting.eventSeq, expiresAtSeq: collecting.eventSeq + 10,
      responses: { p2: { playerId: "p2", status: "PENDING" } },
    };
    expectReject(collecting, { type: "RESPOND_TRADE", playerId: "p1", tradeId: "collecting", response: "PASS" }, "TRADE_NOT_ALLOWED");
    expectReject(collecting, { type: "RESPOND_TRADE", playerId: "p3", tradeId: "collecting", response: "PASS" }, "TRADE_NOT_ALLOWED");
    expectReject(collecting, { type: "FINALIZE_TRADE", playerId: "p2", tradeId: "collecting", toPlayerId: "p2" }, "TRADE_NOT_ALLOWED");
    expectReject(collecting, { type: "FINALIZE_TRADE", playerId: "p1", tradeId: "collecting", toPlayerId: "p3" }, "TRADE_NOT_ALLOWED");
    expectReject(collecting, { type: "FINALIZE_TRADE", playerId: "p1", tradeId: "collecting", toPlayerId: "p2" }, "TRADE_NOT_ALLOWED");
  });

  it("enforces legacy open-trade balances and recipients before accepting or rejecting", () => {
    const offered = { ...emptyResources(), timber: 1 };
    const requested = { ...emptyResources(), ore: 1 };
    const openTrade = {
      id: "legacy-open",
      fromPlayerId: "p1",
      offered,
      requested,
      recipients: ["p2"] as PlayerId[],
      status: "OPEN" as const,
      createdAtSeq: 0,
      expiresAtSeq: 100,
    };
    const ready = withResources(withResources(tradeReady(), "p1", { timber: 1 }), "p2", { ore: 1 });
    ready.trades[openTrade.id] = openTrade;

    const accepted = applyOrThrow(ready, { type: "ACCEPT_TRADE", playerId: "p2", tradeId: openTrade.id });
    expect(accepted.events[0]).toMatchObject({ type: "TRADE_ACCEPTED", fromPlayerId: "p1", toPlayerId: "p2" });

    const rejectedState = structuredClone(ready);
    const rejected = applyOrThrow(rejectedState, { type: "REJECT_TRADE", playerId: "p2", tradeId: openTrade.id });
    expect(rejected.events[0]).toMatchObject({ type: "TRADE_REJECTED", playerId: "p2" });

    expectReject(ready, { type: "ACCEPT_TRADE", playerId: "p1", tradeId: openTrade.id }, "TRADE_NOT_ALLOWED");
    expectReject(ready, { type: "ACCEPT_TRADE", playerId: "p3", tradeId: openTrade.id }, "TRADE_NOT_ALLOWED");
    expectReject(ready, { type: "REJECT_TRADE", playerId: "p3", tradeId: openTrade.id }, "TRADE_NOT_ALLOWED");

    const offererShort = structuredClone(ready);
    offererShort.players.p1!.resources.timber = 0;
    expectReject(offererShort, { type: "ACCEPT_TRADE", playerId: "p2", tradeId: openTrade.id }, "INSUFFICIENT_RESOURCES");

    const recipientShort = structuredClone(ready);
    recipientShort.players.p2!.resources.ore = 0;
    expectReject(recipientShort, { type: "ACCEPT_TRADE", playerId: "p2", tradeId: openTrade.id }, "INSUFFICIENT_RESOURCES");
  });

  it("expires another player's legacy offer after an unrelated command advances the event sequence", () => {
    const state = withResources(tradeReady(), "p1", { timber: 4 });
    state.trades.expiring = {
      id: "expiring",
      fromPlayerId: "p2",
      offered: { ...emptyResources(), ore: 1 },
      requested: { ...emptyResources(), timber: 1 },
      recipients: "ANY",
      status: "OPEN",
      createdAtSeq: state.eventSeq,
      expiresAtSeq: state.eventSeq + 1,
    };

    const result = applyOrThrow(state, { type: "MARITIME_TRADE", playerId: "p1", offered: "timber", requested: "grain" });
    expect(result.events.map((event) => event.type)).toEqual(["MARITIME_TRADED", "TRADE_CLOSED"]);
    expect(result.state.trades.expiring).toMatchObject({ status: "CLOSED", closedReason: "TTL" });
  });

  it("locks the offerer until a staged trade is resolved", () => {
    let state = tradeReady();
    state = applyOrThrow(state, { type: "OFFER_TRADE", playerId: "p1", tradeId: "modal", offered: { ...emptyResources(), timber: 1 }, requested: { ...emptyResources(), ore: 1 }, recipients: "ANY", ttlEvents: 20 }).state;
    expectReject(state, { type: "END_TURN", playerId: "p1" }, "TRADE_NOT_ALLOWED");
    expectReject(state, { type: "MARITIME_TRADE", playerId: "p1", offered: "timber", requested: "ore" }, "TRADE_NOT_ALLOWED");
    state = applyOrThrow(state, { type: "CANCEL_TRADE", playerId: "p1", tradeId: "modal" }).state;
    expect(applyCommand(state, { type: "END_TURN", playerId: "p1" }).ok).toBe(true);
  });

  it("closes legacy-open active player offers before ending the turn", () => {
    const state = tradeReady();
    state.trades["turn-close"] = {
      id: "turn-close",
      fromPlayerId: "p1",
      offered: { ...emptyResources(), timber: 1 },
      requested: { ...emptyResources(), ore: 1 },
      recipients: "ANY",
      status: "OPEN",
      createdAtSeq: state.eventSeq,
      expiresAtSeq: state.eventSeq + 20,
    };
    const result = applyOrThrow(state, { type: "END_TURN", playerId: "p1" });
    expect(result.events.map((event) => event.type)).toEqual(["TRADE_CLOSED", "TURN_ENDED"]);
    expect(result.state.trades["turn-close"]).toMatchObject({ status: "CLOSED", closedReason: "TURN_ENDED" });
  });

  it("can sweep stale legacy-open trades with contiguous event sequences", () => {
    const state = tradeReady();
    state.trades.sweep = {
      id: "sweep",
      fromPlayerId: "p1",
      offered: { ...emptyResources(), timber: 1 },
      requested: { ...emptyResources(), ore: 1 },
      recipients: "ANY",
      status: "OPEN",
      createdAtSeq: state.eventSeq,
      expiresAtSeq: state.eventSeq + 1,
    };
    expect(closeExpiredTrades(state)).toHaveLength(0);
    const expiredState = { ...state, eventSeq: state.trades.sweep!.expiresAtSeq };
    const events = closeExpiredTrades(expiredState);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "TRADE_CLOSED", tradeId: "sweep", reason: "TTL", seq: expiredState.eventSeq + 1 });
  });

  it("closes a staged trade when every recipient rejects", () => {
    let state = withResources(tradeReady(), "p2", { ore: 1 });
    state = applyOrThrow(state, { type: "OFFER_TRADE", playerId: "p1", tradeId: "all-reject", offered: { ...emptyResources(), timber: 1 }, requested: { ...emptyResources(), ore: 1 }, recipients: ["p2"] }).state;
    const result = applyOrThrow(state, { type: "RESPOND_TRADE", playerId: "p2", tradeId: "all-reject", response: "REJECTED" });
    expect(result.events.map((event) => event.type)).toEqual(["TRADE_RESPONSE_RECORDED", "TRADE_CLOSED"]);
    expect(result.state.trades["all-reject"]).toMatchObject({ status: "CLOSED", closedReason: "ALL_REJECTED" });
  });

  it("allows a default 4:1 bank trade without a port", () => {
    const board = createFixedBoard();
    const portVertices = new Set(Object.values(board.ports).flatMap((port) => port.vertexIds));
    const vertexId = Object.keys(board.vertices).find((candidate) => !portVertices.has(candidate as VertexId)) as VertexId;
    const edgeId = board.adjacency.vertexToEdges[vertexId]![0] as EdgeId;
    let state = setupSoloAtVertex(vertexId, edgeId);
    state = withResources(state, "p1", { grain: 4 });
    expect(maritimeTradeRatio(state, "p1", "grain")).toBe(4);
    const beforeOre = state.players.p1!.resources.ore;
    const next = applyOrThrow(state, { type: "MARITIME_TRADE", playerId: "p1", offered: "grain", requested: "ore" }).state;
    expect(next.players.p1!.resources.grain).toBe(0);
    expect(next.players.p1!.resources.ore).toBe(beforeOre + 1);
  });

  it("uses occupied coastal ports for 3:1 and 2:1 maritime trades", () => {
    const board = createFixedBoard();
    const genericPort = Object.values(board.ports).find((port) => port.ratio === 3 && !port.resource)!;
    let state = setupSoloAtVertex(genericPort.vertexIds[0], genericPort.edgeId);
    state = withResources(state, "p1", { grain: 3 });
    expect(maritimeTradeRatio(state, "p1", "grain")).toBe(3);
    const genericTrade = applyOrThrow(state, { type: "MARITIME_TRADE", playerId: "p1", offered: "grain", requested: "ore" });
    expect(genericTrade.events[0]).toMatchObject({ type: "MARITIME_TRADED", ratio: 3 });

    const timberPort = Object.values(board.ports).find((port) => port.resource === "timber")!;
    state = setupSoloAtVertex(timberPort.vertexIds[0], timberPort.edgeId);
    state = withResources(state, "p1", { timber: 2 });
    expect(maritimeTradeRatio(state, "p1", "timber")).toBe(2);
    const timberTrade = applyOrThrow(state, { type: "MARITIME_TRADE", playerId: "p1", offered: "timber", requested: "ore" });
    expect(timberTrade.events[0]).toMatchObject({ type: "MARITIME_TRADED", ratio: 2 });
    expect(timberTrade.state.players.p1!.resources.timber).toBe(0);
    expect(timberTrade.state.players.p1!.resources.ore).toBeGreaterThan(0);
  });
});

describe("serialization and replay", () => {
  it("shows resources only to the owning viewer", () => {
    const state = withResources(createDemoGame(), "p1", { timber: 3 });
    expect(serializeForViewer(state, "p1").players.find((player) => player.id === "p1")?.resources?.timber).toBe(3);
    expect(serializeForViewer(state, "p2").players.find((player) => player.id === "p1")?.resources).toBeUndefined();
    expect(serializeForViewer(state, "spectator").players.find((player) => player.id === "p1")?.resources).toBeUndefined();
  });

  it("redacts open trade bundles in viewer snapshots for spectators and unknown viewers", () => {
    let state = withResources(applyOrThrow(completeSetup(createDemoGame()).state, { type: "ROLL_DICE", playerId: "p1" }).state, "p1", { timber: 2 });
    state = applyOrThrow(state, {
      type: "OFFER_TRADE",
      playerId: "p1",
      tradeId: "snapshot-trade",
      offered: { ...emptyResources(), timber: 1 },
      requested: { ...emptyResources(), ore: 1 },
      recipients: "ANY",
    }).state;

    expect(serializeForViewer(state, "p2").trades[0]?.offered.timber).toBe(1);
    expect(serializeForViewer(state, "spectator").trades[0]?.offered).toEqual(emptyResources());
    expect(serializeForViewer(state, "unknown-viewer").trades[0]?.offered).toEqual(emptyResources());
  });

  it("redacts submitted discard bundles from other players and spectators", () => {
    const state = withResources(completeSetup(createDemoGame("discard-viewer-redaction")).state, "p2", { timber: 3, ore: 1 });
    state.phase = {
      type: "DISCARDING",
      activePlayerId: "p3",
      rollerId: "p1",
      pending: { p2: 4, p3: 2 },
      submitted: { p2: { timber: 3, ore: 1 } },
    };

    const ownPhase = serializeForViewer(state, "p2").phase;
    const opponentPhase = serializeForViewer(state, "p3").phase;
    const spectatorPhase = serializeForViewer(state, "spectator").phase;

    expect(ownPhase.type === "DISCARDING" ? ownPhase.submitted.p2 : undefined).toEqual({ timber: 3, ore: 1 });
    expect(opponentPhase.type === "DISCARDING" ? opponentPhase.submitted.p2 : undefined).toEqual({});
    expect(spectatorPhase.type === "DISCARDING" ? spectatorPhase.submitted.p2 : undefined).toEqual({});
  });

  it("redacts open ANY trade events for viewers outside the game", () => {
    const tradeEvent = {
      schemaVersion: 1 as const,
      seq: 1,
      type: "TRADE_OFFERED" as const,
      trade: {
        id: "event-trade",
        fromPlayerId: "p1",
        offered: { ...emptyResources(), timber: 1 },
        requested: { ...emptyResources(), ore: 1 },
        recipients: "ANY" as const,
        status: "OPEN" as const,
        createdAtSeq: 1,
        expiresAtSeq: 11,
      },
    };

    expect(serializeEventsForViewer([tradeEvent], "unknown-viewer")[0]).toMatchObject({
      type: "TRADE_OFFERED",
      trade: { offered: emptyResources(), requested: emptyResources() },
    });
    expect(serializeEventsForViewer([tradeEvent], "p2", ["p1", "p2"])[0]).toMatchObject({
      type: "TRADE_OFFERED",
      trade: { offered: expect.objectContaining({ timber: 1 }), requested: expect.objectContaining({ ore: 1 }) },
    });
  });

  it("redacts staged response details from uninvolved viewers", () => {
    let state = withResources(applyOrThrow(completeSetup(createDemoGame()).state, { type: "ROLL_DICE", playerId: "p1" }).state, "p1", { timber: 2 });
    state = withResources(state, "p2", { ore: 1 });
    state = applyOrThrow(state, {
      type: "OFFER_TRADE",
      playerId: "p1",
      tradeId: "private-response",
      offered: { ...emptyResources(), timber: 1 },
      requested: { ...emptyResources(), ore: 1 },
      recipients: ["p2"],
    }).state;
    const responded = applyOrThrow(state, { type: "RESPOND_TRADE", playerId: "p2", tradeId: "private-response", response: "WANTS_ACCEPT" });

    expect(serializeForViewer(responded.state, "p1").trades[0]?.responses?.p2?.status).toBe("WANTS_ACCEPT");
    expect(serializeForViewer(responded.state, "p2").trades[0]?.responses?.p2?.status).toBe("WANTS_ACCEPT");
    expect(serializeForViewer(responded.state, "p3").trades[0]?.responses).toBeUndefined();
    expect(serializeForViewer(responded.state, "spectator").trades[0]?.responses).toBeUndefined();

    const responseEvent = responded.events.find((event) => event.type === "TRADE_RESPONSE_RECORDED")!;
    expect(serializeEventsForViewer([responseEvent], "p1", state.playerOrder)[0]).toMatchObject({ type: "TRADE_RESPONSE_RECORDED", response: "WANTS_ACCEPT" });
    expect(serializeEventsForViewer([responseEvent], "p3", state.playerOrder)[0]).toEqual({
      schemaVersion: responseEvent.schemaVersion,
      seq: responseEvent.seq,
      type: "TRADE_RESPONSE_RECORDED",
      tradeId: "private-response",
    });
  });

  it("redacts every private resource-bearing event for uninvolved viewers", () => {
    const privateEvents = [
      { schemaVersion: 3, seq: 1, type: "SPECIAL_CARD_BOUGHT", playerId: "p1", cost: emptyResources(), cardIndex: 0, cardId: "card-1", cardType: "KNIGHT" },
      { schemaVersion: 3, seq: 2, type: "RESOURCES_DISCARDED", playerId: "p1", resources: { ...emptyResources(), ore: 2 } },
      { schemaVersion: 3, seq: 3, type: "THIEF_MOVED", playerId: "p1", toHexId: "h1", reason: "ROLL_7", stealFromPlayerId: "p2", stolenResource: "grain" },
      { schemaVersion: 3, seq: 4, type: "RESOURCES_PRODUCED", gains: { p1: { timber: 2 }, p2: { brick: 1 } } },
      { schemaVersion: 3, seq: 5, type: "TRADE_ACCEPTED", tradeId: "trade-1", fromPlayerId: "p1", toPlayerId: "p2", offered: { ...emptyResources(), timber: 1 }, requested: { ...emptyResources(), ore: 1 } },
    ] as GameEvent[];

    const redacted = serializeEventsForViewer(privateEvents, "p3", ["p1", "p2", "p3"]);
    expect(redacted[0]).toMatchObject({ type: "SPECIAL_CARD_BOUGHT" });
    expect(redacted[0]).not.toHaveProperty("cardId");
    expect(redacted[0]).not.toHaveProperty("cardType");
    expect(redacted[1]).toMatchObject({ resources: emptyResources() });
    expect(redacted[2]).not.toHaveProperty("stolenResource");
    expect(redacted[3]).toMatchObject({ gains: { p1: {}, p2: {} } });
    expect(redacted[4]).toMatchObject({ offered: emptyResources(), requested: emptyResources() });

    expect(serializeEventsForViewer([privateEvents[0]!, privateEvents[2]!], "spectator", ["p1", "p2"], true)).toEqual([privateEvents[0], privateEvents[2]]);
  });

  it("normalizes imported v1 open trades as migrated closed trades", () => {
    const state = applyOrThrow(completeSetup(createDemoGame()).state, { type: "ROLL_DICE", playerId: "p1" }).state;
    state.schemaVersion = 1;
    state.trades.legacy = {
      id: "legacy",
      fromPlayerId: "p1",
      offered: { ...emptyResources(), timber: 1 },
      requested: { ...emptyResources(), ore: 1 },
      recipients: "ANY",
      status: "OPEN",
      createdAtSeq: state.eventSeq,
      expiresAtSeq: state.eventSeq + 10,
      responses: { p2: { playerId: "p2", status: "PENDING" } },
    };

    const normalized = normalizeImportedState(state);
    expect(normalized.schemaVersion).toBe(3);
    expect(normalized.trades.legacy).toMatchObject({ status: "CLOSED", closedReason: "MIGRATED" });
    expect(normalized.trades.legacy?.responses).toBeUndefined();
  });

  it("restores a missing thief location from the imported board", () => {
    const legacy = createDemoGame("legacy-missing-thief");
    delete legacy.thiefHexId;

    const normalized = normalizeImportedState(legacy);
    expect(normalized.thiefHexId).toBe(Object.values(normalized.board.hexes).find((hex) => hex.resource === "desert")?.id);
  });

  it("replays events to the same state", () => {
    const seed = "replay-test";
    const played = playBotGame(seed, 120);
    const replayed = replay({ config: createDemoConfig(seed), board: played.state.board, events: played.events });
    expect(replayed).toEqual(played.state);
  }, 20_000);

  it("applies individual events deterministically", () => {
    const state = createDemoGame();
    const vertexId = Object.keys(state.board.vertices)[0] as VertexId;
    const edgeId = state.board.adjacency.vertexToEdges[vertexId]![0] as EdgeId;
    const event = { schemaVersion: 1 as const, seq: 1, type: "SETUP_PLACED" as const, playerId: "p1", vertexId, edgeId, startingResources: emptyResources() };
    expect(applyEvent(state, event)).toEqual(applyEvent(state, event));
  });
});

describe("development cards, thief, and adjudication", () => {
  it("keeps bought VP cards hidden but counts them for game over", () => {
    let state = applyOrThrow(completeSetup(createDemoGame("vp-card-win")).state, { type: "ROLL_DICE", playerId: "p1" }).state;
    state.config.victoryPoints = state.players.p1!.score + 1;
    state.developmentDeck = ["VICTORY_POINT"];
    state.developmentDeckCursor = 0;
    state = withResources(state, "p1", specialCardCost(state.config.rules));

    const result = applyCommand(state, { type: "BUY_SPECIAL_CARD", playerId: "p1" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected VP card purchase to succeed");
    expect(result.value.nextState.phase).toMatchObject({ type: "GAME_OVER", winnerId: "p1" });
    expect(result.value.events.at(-1)).toMatchObject({ type: "GAME_OVER", reason: "VICTORY_POINTS" });
    expect(serializeForViewer(result.value.nextState, "p2").players.find((player) => player.id === "p1")?.developmentCards?.[0]?.type).toBe("VICTORY_POINT");
  });

  it("componentizes hidden victory points for the owning viewer only", () => {
    let state = applyOrThrow(completeSetup(createDemoGame("secret-vp-view")).state, { type: "ROLL_DICE", playerId: "p1" }).state;
    state.players.p1!.score = 4;
    state.players.p1!.developmentCards = [{ id: "secret-vp", type: "VICTORY_POINT", ownerId: "p1", boughtTurn: state.turn - 1 }];
    state.players.p1!.specialCards = 1;

    const own = serializeForViewer(state, "p1").players.find((player) => player.id === "p1");
    expect(own).toMatchObject({
      score: 4,
      publicVictoryPoints: 4,
      secretVictoryPoints: 1,
      visibleVictoryPoints: 5,
      victoryPointBreakdown: expect.objectContaining({ publicTotal: 4, secret: 1, total: 5 }),
    });
    expect(own?.developmentCards?.[0]?.type).toBe("VICTORY_POINT");

    const opponent = serializeForViewer(state, "p2").players.find((player) => player.id === "p1");
    expect(opponent).toMatchObject({
      score: 4,
      publicVictoryPoints: 4,
      secretVictoryPoints: 0,
      visibleVictoryPoints: 4,
      victoryPointBreakdown: expect.objectContaining({ publicTotal: 4, secret: 0, total: 4 }),
    });
    expect(opponent?.developmentCards).toBeUndefined();

    state = applyEvent(state, { schemaVersion: state.schemaVersion, seq: state.eventSeq + 1, type: "GAME_OVER", winnerId: "p1", reason: "VICTORY_POINTS" });
    const revealed = serializeForViewer(state, "p2").players.find((player) => player.id === "p1");
    expect(revealed).toMatchObject({
      score: 5,
      publicVictoryPoints: 4,
      secretVictoryPoints: 1,
      visibleVictoryPoints: 5,
      victoryPointBreakdown: expect.objectContaining({ publicTotal: 4, secret: 1, total: 5 }),
    });
    expect(revealed?.developmentCards?.[0]?.type).toBe("VICTORY_POINT");
  });

  it("forces discard after a 7 before moving the thief", () => {
    let state = completeSetup(createDemoGame("discard-seven")).state;
    const sevenIndex = Array.from({ length: 200 }, (_, index) => index).find((index) => {
      const rolled = rollSeededDice(state.rng.seed, index);
      return rolled.dice[0] + rolled.dice[1] === 7;
    });
    expect(sevenIndex).toBeDefined();
    state.rng.index = sevenIndex!;
    state = withResources(state, "p2", { timber: 8 });

    const rolled = applyOrThrow(state, { type: "ROLL_DICE", playerId: "p1" });
    expect(rolled.state.phase).toMatchObject({ type: "DISCARDING" });
    expect(rolled.events.map((event) => event.type)).toContain("DISCARD_REQUIRED");

    const required = rolled.state.phase.type === "DISCARDING" ? rolled.state.phase.pending.p2 ?? 0 : 0;
    const discarded = applyOrThrow(rolled.state, { type: "DISCARD_RESOURCES", playerId: "p2", resources: { ...emptyResources(), timber: required } });
    expect(discarded.state.players.p2!.resources.timber).toBe(state.players.p2!.resources.timber - required);
    expect(discarded.state.phase).toMatchObject({ type: "MOVING_THIEF", activePlayerId: "p1" });

    const hexId = Object.keys(discarded.state.board.hexes).find((candidate) => candidate !== discarded.state.thiefHexId) as string;
    const stealFromPlayerId = eligibleStealTargets(discarded.state, "p1", hexId)[0];
    const moved = applyOrThrow(discarded.state, {
      type: "MOVE_THIEF",
      playerId: "p1",
      hexId,
      ...(stealFromPlayerId ? { stealFromPlayerId } : {}),
    });
    expect(moved.state.thiefHexId).toBe(hexId);
    expect(moved.state.phase).toMatchObject({ type: "ACTION_PHASE", activePlayerId: "p1" });
  });

  it("requires a thief target whenever an eligible player can be robbed", () => {
    let state = completeSetup(createDemoGame("mandatory-thief-target")).state;
    state = withResources(state, "p2", { timber: 1 });
    state.phase = { type: "MOVING_THIEF", activePlayerId: "p1", rollerId: "p1", reason: "ROLL_7" };
    const hexId = Object.keys(state.board.hexes).find((candidate) =>
      candidate !== state.thiefHexId && eligibleStealTargets(state, "p1", candidate).includes("p2"),
    ) as HexId | undefined;
    expect(hexId).toBeDefined();
    if (!hexId) throw new Error("Expected a thief destination adjacent to p2");

    expectReject(state, { type: "MOVE_THIEF", playerId: "p1", hexId }, "INVALID_THIEF_MOVE");
    expect(applyOrThrow(state, { type: "MOVE_THIEF", playerId: "p1", hexId, stealFromPlayerId: "p2" }).events)
      .toContainEqual(expect.objectContaining({ type: "THIEF_MOVED", stealFromPlayerId: "p2", stolenResource: expect.any(String) }));
  });

  it("creates seeded random forced discard bundles", () => {
    const state = withResources(completeSetup(createDemoGame("forced-random-discard")).state, "p2", { timber: 3, brick: 2, grain: 2, fiber: 1 });
    state.phase = { type: "DISCARDING", activePlayerId: "p2", rollerId: "p1", pending: { p2: 4 }, submitted: {} };

    const discard = randomizedDiscard(state, "p2", 4);
    expect(discard).toEqual(randomizedDiscard(state, "p2", 4));
    expect(resourceCount(discard)).toBe(4);
    for (const resource of resources) {
      expect(discard[resource]).toBeLessThanOrEqual(state.players.p2!.resources[resource]);
    }

    const result = applyOrThrow(state, { type: "DISCARD_RESOURCES", playerId: "p2", resources: discard, forced: true });
    expect(result.events[0]).toMatchObject({ type: "RESOURCES_DISCARDED", playerId: "p2", forced: true });
  });

  it("blocks production on the thief hex", () => {
    const state = completeSetup(createDemoGame("thief-block")).state;
    const buildingVertex = Object.keys(state.settlements).find((vertexId) => state.settlements[vertexId] === "p1") as VertexId;
    const producingHex = state.board.vertices[buildingVertex]!.adjacentHexes.map((hexId) => state.board.hexes[hexId]!).find((hex) => hex.resource !== "desert" && hex.token);
    expect(producingHex).toBeDefined();
    state.thiefHexId = producingHex!.id;
    const index = Array.from({ length: 300 }, (_, candidate) => {
      const rolled = rollSeededDice(state.rng.seed, candidate);
      return { candidate, sum: rolled.dice[0] + rolled.dice[1] };
    }).find((entry) => entry.sum === producingHex!.token)?.candidate;
    expect(index).toBeDefined();
    state.rng.index = index!;

    const result = applyOrThrow(state, { type: "ROLL_DICE", playerId: "p1" });
    const produced = result.events.find((event) => event.type === "RESOURCES_PRODUCED");
    expect(produced?.type === "RESOURCES_PRODUCED" ? produced.gains.p1?.[producingHex!.resource as keyof ResourceBundle] ?? 0 : 0).toBe(0);
  });

  it("plays development card effects through legal engine commands", () => {
    let state = applyOrThrow(completeSetup(createDemoGame("card-effects")).state, { type: "ROLL_DICE", playerId: "p1" }).state;
    state.developmentDeck = ["YEAR_OF_PLENTY", "MONOPOLY"];
    state.developmentDeckCursor = 0;
    state = withResources(state, "p1", { grain: 2, fiber: 2, ore: 2 });
    state = applyOrThrow(state, { type: "BUY_SPECIAL_CARD", playerId: "p1" }).state;
    state = applyOrThrow(state, { type: "BUY_SPECIAL_CARD", playerId: "p1" }).state;
    for (const card of state.players.p1!.developmentCards) card.boughtTurn = state.turn - 1;
    state = withResources(state, "p2", { ore: 3 });

    const plenty = state.players.p1!.developmentCards.find((card) => card.type === "YEAR_OF_PLENTY")!;
    const afterPlenty = applyOrThrow(state, { type: "PLAY_YEAR_OF_PLENTY", playerId: "p1", cardId: plenty.id, resources: ["timber", "brick"] }).state;
    expect(afterPlenty.players.p1!.resources.timber).toBeGreaterThanOrEqual(1);
    expect(expectReject(afterPlenty, { type: "PLAY_MONOPOLY", playerId: "p1", cardId: state.players.p1!.developmentCards.find((card) => card.type === "MONOPOLY")!.id, resource: "ore" }, "CARD_NOT_PLAYABLE")).toBeUndefined();
  });

  it("requires Road Building to build two roads when a second road is available", () => {
    const state = applyOrThrow(completeSetup(createDemoGame("road-building-two")).state, { type: "ROLL_DICE", playerId: "p1" }).state;
    state.players.p1!.developmentCards = [{ id: "road-card", type: "ROAD_BUILDING", ownerId: "p1", boughtTurn: state.turn - 1 }];
    state.players.p1!.specialCards = 1;
    const action = getLegalActions(state, "p1").find((candidate) => candidate.type === "PLAY_ROAD_BUILDING");
    expect(action?.type).toBe("PLAY_ROAD_BUILDING");
    if (action?.type !== "PLAY_ROAD_BUILDING") throw new Error("Expected Road Building to be legal");
    expect(action.requiredRoadCount).toBe(2);
    const option = action.options.find((candidate) => candidate.length === 2);
    const first = option?.[0];
    expect(first).toBeDefined();
    const second = option?.[1];
    expect(second).toBeDefined();
    if (!first || !second) throw new Error("Expected a two-road Road Building option");

    expectReject(state, { type: "PLAY_ROAD_BUILDING", playerId: "p1", cardId: "road-card", edgeIds: [first] }, "CARD_NOT_PLAYABLE");
    const built = applyOrThrow(state, { type: "PLAY_ROAD_BUILDING", playerId: "p1", cardId: "road-card", edgeIds: [first, second] });
    expect(built.events.some((event) => event.type === "ROAD_BUILDING_PLAYED")).toBe(true);
    expect(built.state.roads[first]).toBe("p1");
    expect(built.state.roads[second]).toBe("p1");
  });

  it("rejects malformed Road Building selections and supports a genuinely single-road network", () => {
    const state = applyOrThrow(completeSetup(createDemoGame("road-building-boundaries")).state, { type: "ROLL_DICE", playerId: "p1" }).state;
    state.players.p1!.developmentCards = [{ id: "road-card", type: "ROAD_BUILDING", ownerId: "p1", boughtTurn: state.turn - 1 }];
    state.players.p1!.specialCards = 1;
    const plan = getLegalActions(state, "p1").find((candidate) => candidate.type === "PLAY_ROAD_BUILDING");
    if (plan?.type !== "PLAY_ROAD_BUILDING" || !plan.options[0]?.[0]) throw new Error("Expected Road Building options");
    const first = plan.options[0][0];

    expectReject(state, { type: "PLAY_ROAD_BUILDING", playerId: "p1", cardId: "road-card", edgeIds: [] }, "CARD_NOT_PLAYABLE");
    expectReject(state, { type: "PLAY_ROAD_BUILDING", playerId: "p1", cardId: "road-card", edgeIds: [first, first] }, "CARD_NOT_PLAYABLE");

    const constrained = structuredClone(state);
    const blockedEdges = new Set<EdgeId>([
      ...plan.options.map((option) => option[0]).filter((edgeId): edgeId is EdgeId => Boolean(edgeId) && edgeId !== first),
      ...plan.options.filter((option) => option[0] === first && option[1]).map((option) => option[1]!),
    ]);
    for (const edgeId of blockedEdges) constrained.roads[edgeId] = "p2";
    const constrainedPlan = getLegalActions(constrained, "p1").find((candidate) => candidate.type === "PLAY_ROAD_BUILDING");
    expect(constrainedPlan).toMatchObject({ type: "PLAY_ROAD_BUILDING", requiredRoadCount: 1, options: [[first]] });
    const built = applyOrThrow(constrained, { type: "PLAY_ROAD_BUILDING", playerId: "p1", cardId: "road-card", edgeIds: [first] });
    expect(built.state.roads[first]).toBe("p1");
  });

  it("rejects invalid and unaffordable maritime trade pairs", () => {
    const state = applyOrThrow(completeSetup(createDemoGame("maritime-boundaries")).state, { type: "ROLL_DICE", playerId: "p1" }).state;
    expectReject(state, { type: "MARITIME_TRADE", playerId: "p1", offered: "timber", requested: "timber" }, "TRADE_NOT_ALLOWED");
    expectReject(state, { type: "MARITIME_TRADE", playerId: "p1", offered: "timber", requested: "grain" }, "INSUFFICIENT_RESOURCES");

    const solo = setupSoloAtVertex(
      Object.keys(createFixedBoard().vertices)[0] as VertexId,
      createFixedBoard().adjacency.vertexToEdges[Object.keys(createFixedBoard().vertices)[0] as VertexId]![0] as EdgeId,
    );
    const offer = { ...emptyResources(), timber: 1 };
    const request = { ...emptyResources(), ore: 1 };
    expectReject(solo, { type: "OFFER_TRADE", playerId: "p1", tradeId: "no-recipient", offered: offer, requested: request, recipients: "ANY" }, "TRADE_NOT_ALLOWED");
  });

  it("serializes public config without exposing seed but includes deck remaining", () => {
    const state = applyOrThrow(completeSetup(createDemoGame("public-config", { botDifficulty: "hard", rules: { mapRandomized: true, maxTurns: 30, maxTurnAdjudication: "leader" } })).state, { type: "ROLL_DICE", playerId: "p1" }).state;
    const viewer = serializeForViewer(state, "p1");

    expect(viewer.config).toMatchObject({
      victoryPoints: state.config.victoryPoints,
      maxPlayers: state.config.maxPlayers,
      turnSeconds: state.config.turnSeconds,
      botDifficulty: "hard",
    });
    expect("seed" in viewer.config).toBe(false);
    expect("matchId" in viewer.config).toBe(false);
    expect(viewer.developmentDeckRemaining).toBe(state.developmentDeck.length - state.developmentDeckCursor);
    expect(viewer.resourceBank).toEqual(state.resourceBank);
  });

  it("projects resource bank only for legacy states that have no persisted bank", () => {
    const state = applyOrThrow(completeSetup(createDemoGame("legacy-bank-projection")).state, { type: "ROLL_DICE", playerId: "p1" }).state;
    const legacy = structuredClone(state) as Omit<GameState, "resourceBank"> & { resourceBank?: ResourceBundle };
    delete legacy.resourceBank;

    expect(serializeForViewer(legacy as GameState, "p1").resourceBank).toEqual(projectedResourceBank(legacy));
  });

  it("does not clamp impossible projected bank shortages", () => {
    const state = completeSetup(createDemoGame("bank-corruption")).state;
    state.players.p1!.resources.timber = 20;
    state.resourceBank = projectedResourceBank(state);

    const result = assertInvariants(state);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("bank has negative resources");
  });

  it("allows Year of Plenty to take duplicate resources", () => {
    const state = applyOrThrow(completeSetup(createDemoGame("plenty-duplicates")).state, { type: "ROLL_DICE", playerId: "p1" }).state;
    state.players.p1!.developmentCards = [{ id: "plenty-card", type: "YEAR_OF_PLENTY", ownerId: "p1", boughtTurn: state.turn - 1 }];
    state.players.p1!.specialCards = 1;
    const before = state.players.p1!.resources.ore;

    const played = applyOrThrow(state, { type: "PLAY_YEAR_OF_PLENTY", playerId: "p1", cardId: "plenty-card", resources: ["ore", "ore"] });
    expect(played.state.players.p1!.resources.ore).toBe(before + 2);
    expect(played.state.resourceBank.ore).toBe(state.resourceBank.ore - 2);
  });

  it("rejects Year of Plenty and maritime trades when the bank lacks the requested resource", () => {
    let state = applyOrThrow(completeSetup(createDemoGame("bank-special-shortage")).state, { type: "ROLL_DICE", playerId: "p1" }).state;
    state.players.p1!.developmentCards = [{ id: "plenty-card", type: "YEAR_OF_PLENTY", ownerId: "p1", boughtTurn: state.turn - 1 }];
    state.players.p1!.specialCards = 1;
    for (const player of Object.values(state.players)) player.resources.ore = 0;
    state.players.p2!.resources.ore = 18;
    state.resourceBank.ore = 1;
    expectReject(state, { type: "PLAY_YEAR_OF_PLENTY", playerId: "p1", cardId: "plenty-card", resources: ["ore", "ore"] }, "INSUFFICIENT_RESOURCES");

    state = withResources(state, "p1", { timber: 4 });
    for (const player of Object.values(state.players)) player.resources.grain = 0;
    state.players.p2!.resources.grain = 19;
    state.resourceBank.grain = 0;
    const maritime = getLegalActions(state, "p1").find((action) => action.type === "MARITIME_TRADE");
    expect(maritime?.type).toBe("MARITIME_TRADE");
    if (maritime?.type !== "MARITIME_TRADE") throw new Error("Expected maritime trades");
    expect(maritime.trades.some((trade) => trade.requested === "grain")).toBe(false);
    expectReject(state, { type: "MARITIME_TRADE", playerId: "p1", offered: "timber", requested: "grain" }, "INSUFFICIENT_RESOURCES");
  });

  it("rejects exhausted decks and cards bought on the current turn", () => {
    let state = applyOrThrow(completeSetup(createDemoGame("deck-guards")).state, { type: "ROLL_DICE", playerId: "p1" }).state;
    state = withResources(state, "p1", specialCardCost(state.config.rules));
    state.developmentDeck = [];
    state.developmentDeckCursor = 0;
    expectReject(state, { type: "BUY_SPECIAL_CARD", playerId: "p1" }, "DECK_EMPTY");

    state.developmentDeck = ["KNIGHT"];
    state.developmentDeckCursor = 0;
    const bought = applyOrThrow(state, { type: "BUY_SPECIAL_CARD", playerId: "p1" }).state;
    const cardId = bought.players.p1!.developmentCards[0]!.id;
    const hexId = Object.keys(bought.board.hexes).find((candidate) => candidate !== bought.thiefHexId) as HexId;
    expectReject(bought, { type: "PLAY_KNIGHT", playerId: "p1", cardId, hexId }, "CARD_NOT_PLAYABLE");
  });

  it("redacts stolen thief resources from uninvolved viewers", () => {
    let state = applyOrThrow(completeSetup(createDemoGame("steal-redaction")).state, { type: "ROLL_DICE", playerId: "p1" }).state;
    state.players.p1!.developmentCards = [{ id: "knight-card", type: "KNIGHT", ownerId: "p1", boughtTurn: state.turn - 1 }];
    state.players.p1!.specialCards = 1;
    state = withResources(state, "p2", { timber: 1 });
    const action = getLegalActions(state, "p1").find((candidate) => candidate.type === "PLAY_KNIGHT");
    expect(action?.type).toBe("PLAY_KNIGHT");
    if (action?.type !== "PLAY_KNIGHT") throw new Error("Expected Knight to be legal");
    const target = action.hexes
      .map((hexId) => ({ hexId, targets: state.board.adjacency.hexToVertices[hexId]?.map((vertexId) => state.settlements[vertexId]).filter(Boolean) ?? [] }))
      .find((candidate) => candidate.targets.includes("p2"));
    expect(target).toBeDefined();
    if (!target) throw new Error("Expected a thief move target adjacent to p2");

    const played = applyOrThrow(state, { type: "PLAY_KNIGHT", playerId: "p1", cardId: "knight-card", hexId: target.hexId as HexId, stealFromPlayerId: "p2" });
    const thief = played.events.find((event) => event.type === "THIEF_MOVED");
    expect(thief?.type === "THIEF_MOVED" ? thief.stolenResource : undefined).toBe("timber");
    const redacted = serializeEventsForViewer(played.events, "p3").find((event) => event.type === "THIEF_MOVED");
    expect(redacted?.type === "THIEF_MOVED" ? redacted.stolenResource : undefined).toBeUndefined();
  });

  it("uses test-only turn-limit adjudication without requiring public VP threshold", () => {
    const state = applyOrThrow(completeSetup(createDemoGame("turn-limit", { rules: { maxTurns: 1, maxTurnAdjudication: "leader" } })).state, { type: "ROLL_DICE", playerId: "p1" }).state;
    state.players.p1!.score = 4;
    state.players.p2!.score = 1;
    state.players.p3!.score = 2;
    state.players.p4!.score = 2;
    const ended = applyOrThrow(state, { type: "END_TURN", playerId: "p1" });
    expect(ended.state.phase).toMatchObject({ type: "GAME_OVER", winnerId: "p1", reason: "TURN_LIMIT" });
  });
});

describe("resource helpers", () => {
  it.each([
    ["timber", { timber: 1 }],
    ["brick", { brick: 1 }],
    ["grain", { grain: 1 }],
    ["fiber", { fiber: 1 }],
    ["ore", { ore: 1 }],
  ] satisfies Array<[string, Partial<ResourceBundle>]>)("adds %s", (_name, bundle) => {
    const result = addResources(emptyResources(), bundle);
    expect(Object.values(result).reduce((sum, value) => sum + value, 0)).toBe(1);
  });

  it.each([
    ["road timber", roadCost()],
    ["settlement timber", settlementCost()],
    ["empty", emptyResources()],
  ])("subtracts without mutating for %s", (_name, bundle) => {
    const start = { timber: 5, brick: 5, grain: 5, fiber: 5, ore: 5 };
    const result = subtractResources(start, bundle);
    expect(start.timber).toBe(5);
    expect(result.timber).toBeLessThanOrEqual(5);
  });
});
