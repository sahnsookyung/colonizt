import { createFixedBoard, createSeededBoard, validateBoard } from "./board.js";
import { randomIntAt, rollSeededDice } from "./rng.js";
import {
  addResources,
  emptyResources,
  hasResources,
  isNonNegativeBundle,
  resourceCount,
  resourceBundle,
  cityCost,
  defaultSpecialCardCost,
  randomizedSpecialCardCost,
  roadCost,
  settlementCost,
  specialCardCost,
  subtractResources,
} from "./resources.js";
import {
  resources,
  schemaVersion,
  type EdgeId,
  type GameCommand,
  type GameConfig,
  type GameEvent,
  type GameRules,
  type GameState,
  type LegalAction,
  type PlayerId,
  type Resource,
  type ResourceBundle,
  type Result,
  type TradeClosedReason,
  type TradeOffer,
  type TradeResponse,
  type ValidationError,
  type VertexId,
} from "./types.js";

export const maxRoadsPerPlayer = 15;
export const maxSettlementsPerPlayer = 5;
export const maxCitiesPerPlayer = 4;
export const longestRoadMinimum = 5;
export const longestRoadBonus = 2;
const defaultPlightTurn = 20;

const normalizeRules = (config: GameConfig, mapRandomizedDefault: boolean): GameRules => {
  const baseRules: GameRules = {
    diceDoubles: false,
    plight: false,
    plightTurn: defaultPlightTurn,
    mapRandomized: mapRandomizedDefault,
    specialCardCostRandomized: false,
    ...config.rules,
  };
  return {
    ...baseRules,
    specialCardCost: baseRules.specialCardCost
      ? specialCardCost(baseRules)
      : baseRules.specialCardCostRandomized
        ? randomizedSpecialCardCost(config.seed)
        : defaultSpecialCardCost(),
  };
};

export const createGame = (config: GameConfig, board?: GameState["board"]): GameState => {
  const normalizedRules = normalizeRules(config, !board);
  const selectedBoard = board ?? (normalizedRules.mapRandomized ? createSeededBoard(config.seed, 2) : createFixedBoard());
  const boardErrors = validateBoard(selectedBoard);
  if (boardErrors.length > 0) {
    throw new Error(`Invalid board: ${boardErrors.join("; ")}`);
  }
  const normalizedConfig: GameConfig = {
    ...config,
    botDifficulty: config.botDifficulty ?? "medium",
    rules: normalizedRules,
  };
  const players = Object.fromEntries(
    normalizedConfig.playerOrder.map((playerId) => [
      playerId,
      {
        id: playerId,
        name: normalizedConfig.playerNames[playerId] ?? playerId,
        color: normalizedConfig.playerColors[playerId] ?? "#64748b",
        resources: emptyResources(),
        specialCards: 0,
        score: 0,
        longestRoadLength: 0,
        hasLongestRoad: false,
      },
    ]),
  );
  const firstPlayer = normalizedConfig.playerOrder[0];
  if (!firstPlayer) throw new Error("Game requires at least one player");
  return {
    schemaVersion,
    config: normalizedConfig,
    board: selectedBoard,
    players,
    playerOrder: [...normalizedConfig.playerOrder],
    phase: { type: "SETUP_PLACEMENT", activePlayerId: firstPlayer, setupIndex: 0 },
    turn: 0,
    roads: {},
    settlements: {},
    buildings: {},
    trades: {},
    eventSeq: 0,
    rng: { seed: normalizedConfig.seed, index: 0, policy: "SEEDED_DETERMINISTIC" },
  };
};

const error = (code: ValidationError["code"], message: string): ValidationError => ({ code, message });

const cloneState = (state: GameState): GameState => structuredClone(state) as GameState;

const nextSeq = (state: GameState, offset: number): number => state.eventSeq + offset + 1;

const activePlayer = (state: GameState): PlayerId | undefined =>
  "activePlayerId" in state.phase ? state.phase.activePlayerId : undefined;

const ensureActive = (state: GameState, playerId: PlayerId): ValidationError | null => {
  if (!state.players[playerId]) return error("UNKNOWN_PLAYER", `Unknown player ${playerId}`);
  if (state.phase.type === "GAME_OVER") return error("GAME_ALREADY_OVER", "Game is already over");
  if (activePlayer(state) !== playerId) return error("NOT_ACTIVE_PLAYER", "Only the active player can do that");
  return null;
};

const adjacentVertices = (state: GameState, vertexId: VertexId): VertexId[] => {
  const edges = state.board.adjacency.vertexToEdges[vertexId] ?? [];
  return edges.flatMap((edgeId) => state.board.adjacency.edgeToVertices[edgeId] ?? []).filter((id): id is VertexId => Boolean(id) && id !== vertexId);
};

const edgeTouchesVertex = (state: GameState, edgeId: EdgeId, vertexId: VertexId): boolean =>
  Boolean(state.board.adjacency.edgeToVertices[edgeId]?.includes(vertexId));

const setupOrder = (playerOrder: readonly PlayerId[]): PlayerId[] => [
  ...playerOrder,
  ...[...playerOrder].reverse(),
];

const setupPlacementGrantsResources = (state: GameState): boolean =>
  state.phase.type === "SETUP_PLACEMENT" && state.phase.setupIndex >= state.playerOrder.length;

const buildingAt = (state: GameState, vertexId: VertexId): { owner: PlayerId; type: "settlement" | "city" } | undefined => {
  const building = state.buildings[vertexId];
  if (building) return building;
  const owner = state.settlements[vertexId];
  return owner ? { owner, type: "settlement" } : undefined;
};

const countRoads = (state: GameState, playerId: PlayerId): number =>
  Object.values(state.roads).filter((owner) => owner === playerId).length;

const countBuildings = (state: GameState, playerId: PlayerId, type: "settlement" | "city"): number =>
  Object.values(state.buildings).filter((building) => building.owner === playerId && building.type === type).length;

export const tradeRecipientIds = (state: GameState, trade: TradeOffer): PlayerId[] =>
  trade.recipients === "ANY"
    ? state.playerOrder.filter((playerId) => playerId !== trade.fromPlayerId)
    : state.playerOrder.filter((playerId) => trade.recipients !== "ANY" && trade.recipients.includes(playerId));

export const activeCollectingTradeForPlayer = (state: GameState, playerId: PlayerId): TradeOffer | undefined =>
  Object.values(state.trades).find((trade) => trade.fromPlayerId === playerId && trade.status === "COLLECTING_RESPONSES");

export const canViewerSeeTrade = (state: Pick<GameState, "playerOrder">, trade: TradeOffer, viewerId: PlayerId | "spectator"): boolean => {
  if (viewerId === "spectator") return false;
  if (viewerId === trade.fromPlayerId) return true;
  if (trade.recipients === "ANY") return state.playerOrder.includes(viewerId);
  return trade.recipients.includes(viewerId);
};

const initialTradeResponses = (state: GameState, trade: Pick<TradeOffer, "fromPlayerId" | "recipients">): Record<PlayerId, TradeResponse> =>
  Object.fromEntries(
    tradeRecipientIds(state, {
      ...trade,
      id: "",
      offered: emptyResources(),
      requested: emptyResources(),
      status: "COLLECTING_RESPONSES",
      createdAtSeq: 0,
      expiresAtSeq: 0,
    }).map((playerId) => [playerId, { playerId, status: "PENDING" as const }]),
  );

const isBlockedRoadVertex = (state: GameState, vertexId: VertexId, playerId: PlayerId): boolean => {
  const building = buildingAt(state, vertexId);
  return Boolean(building && building.owner !== playerId);
};

export const longestRoadLengthForPlayer = (state: GameState, playerId: PlayerId): number => {
  const ownedEdges = new Set(Object.entries(state.roads).filter(([, owner]) => owner === playerId).map(([edgeId]) => edgeId as EdgeId));
  if (ownedEdges.size === 0) return 0;

  const walk = (vertexId: VertexId, usedEdges: Set<EdgeId>): number => {
    let best = 0;
    for (const edgeId of state.board.adjacency.vertexToEdges[vertexId] ?? []) {
      const typedEdgeId = edgeId as EdgeId;
      if (!ownedEdges.has(typedEdgeId) || usedEdges.has(typedEdgeId)) continue;
      const [left, right] = state.board.adjacency.edgeToVertices[typedEdgeId]!;
      const other = left === vertexId ? right : left;
      const nextUsed = new Set(usedEdges);
      nextUsed.add(typedEdgeId);
      const continuation = isBlockedRoadVertex(state, other, playerId) ? 0 : walk(other, nextUsed);
      best = Math.max(best, 1 + continuation);
    }
    return best;
  };

  const candidateVertices = new Set<VertexId>([...ownedEdges].flatMap((edgeId) => state.board.adjacency.edgeToVertices[edgeId] ?? []));
  return Math.max(...[...candidateVertices].map((vertexId) => walk(vertexId, new Set<EdgeId>())));
};

const longestRoadSummary = (state: GameState): { owner?: PlayerId; length: number; lengths: Record<PlayerId, number> } => {
  const lengths = Object.fromEntries(state.playerOrder.map((playerId) => [playerId, longestRoadLengthForPlayer(state, playerId)])) as Record<PlayerId, number>;
  const bestLength = Math.max(0, ...Object.values(lengths));
  if (bestLength < longestRoadMinimum) return { length: bestLength, lengths };

  const leaders = state.playerOrder.filter((playerId) => lengths[playerId] === bestLength);
  if (leaders.length === 1) return { owner: leaders[0]!, length: bestLength, lengths };
  if (state.longestRoadOwner && leaders.includes(state.longestRoadOwner) && state.players[state.longestRoadOwner]?.hasLongestRoad) {
    return { owner: state.longestRoadOwner, length: bestLength, lengths };
  }
  return { length: bestLength, lengths };
};

const refreshLongestRoad = (state: GameState): void => {
  for (const player of Object.values(state.players)) {
    if (player.hasLongestRoad) player.score -= longestRoadBonus;
    player.hasLongestRoad = false;
  }

  const summary = longestRoadSummary(state);
  for (const playerId of state.playerOrder) {
    state.players[playerId]!.longestRoadLength = summary.lengths[playerId] ?? 0;
  }

  if (summary.owner) {
    state.longestRoadOwner = summary.owner;
    state.players[summary.owner]!.hasLongestRoad = true;
    state.players[summary.owner]!.score += longestRoadBonus;
  } else {
    delete state.longestRoadOwner;
  }
};

const maybeLongestRoadEvent = (before: GameState, after: GameState, seq: number): GameEvent | undefined => {
  if (before.longestRoadOwner === after.longestRoadOwner) return undefined;
  const length = after.longestRoadOwner
    ? after.players[after.longestRoadOwner]!.longestRoadLength
    : Math.max(0, ...after.playerOrder.map((playerId) => after.players[playerId]!.longestRoadLength));
  return after.longestRoadOwner
    ? { schemaVersion, seq, type: "LONGEST_ROAD_UPDATED", playerId: after.longestRoadOwner, length }
    : { schemaVersion, seq, type: "LONGEST_ROAD_UPDATED", length };
};

export const maritimeTradeRatio = (state: GameState, playerId: PlayerId, offered: Resource): 2 | 3 | 4 => {
  let ratio: 2 | 3 | 4 = 4;
  for (const port of Object.values(state.board.ports ?? {})) {
    if (!port.vertexIds.some((vertexId) => buildingAt(state, vertexId)?.owner === playerId)) continue;
    if (port.resource === offered) return 2;
    if (!port.resource) ratio = 3;
  }
  return ratio;
};

export const canPlaceSettlement = (state: GameState, vertexId: VertexId, requireRoad: PlayerId | false): boolean => {
  if (!state.board.vertices[vertexId] || buildingAt(state, vertexId)) return false;
  if (adjacentVertices(state, vertexId).some((neighbor) => buildingAt(state, neighbor))) return false;
  if (requireRoad === false) return true;
  return (state.board.adjacency.vertexToEdges[vertexId] ?? []).some((edgeId) => state.roads[edgeId] === requireRoad);
};

export const canBuildRoad = (state: GameState, playerId: PlayerId, edgeId: EdgeId, freeSetupVertex?: VertexId): boolean => {
  const edge = state.board.edges[edgeId];
  if (!edge || state.roads[edgeId]) return false;
  if (freeSetupVertex) return edgeTouchesVertex(state, edgeId, freeSetupVertex);
  return edge.vertices.some((vertexId) => {
    const building = buildingAt(state, vertexId);
    if (building?.owner === playerId) return true;
    if (building && building.owner !== playerId) return false;
    return (state.board.adjacency.vertexToEdges[vertexId] ?? []).some((nearbyEdge) => state.roads[nearbyEdge] === playerId);
  });
};

const resourceGainForRoll = (state: GameState, sum: number, multiplier = 1): Record<PlayerId, Partial<ResourceBundle>> => {
  const gains: Record<PlayerId, Partial<ResourceBundle>> = {};
  for (const hex of Object.values(state.board.hexes)) {
    if (hex.resource === "desert" || hex.token !== sum) continue;
    for (const vertexId of state.board.adjacency.hexToVertices[hex.id] ?? []) {
      const owner = state.settlements[vertexId];
      if (!owner) continue;
      const building = buildingAt(state, vertexId);
      const playerGains = gains[owner] ?? {};
      playerGains[hex.resource] = (playerGains[hex.resource] ?? 0) + (building?.type === "city" ? 2 : 1) * multiplier;
      gains[owner] = playerGains;
    }
  }
  return gains;
};

const startingResourcesForVertex = (state: GameState, vertexId: VertexId): Partial<ResourceBundle> => {
  const gains: Partial<ResourceBundle> = {};
  for (const hexId of state.board.vertices[vertexId]?.adjacentHexes ?? []) {
    const hex = state.board.hexes[hexId];
    if (!hex || hex.resource === "desert") continue;
    gains[hex.resource] = (gains[hex.resource] ?? 0) + 1;
  }
  return gains;
};

const hasAnyGain = (gains: Record<PlayerId, Partial<ResourceBundle>>): boolean =>
  Object.values(gains).some((bundle) => resources.some((resource) => (bundle[resource] ?? 0) > 0));

const closeTradeEvents = (
  state: GameState,
  trades: readonly TradeOffer[],
  reason: TradeClosedReason,
  startSeq = state.eventSeq + 1,
  playerId?: PlayerId,
): GameEvent[] =>
  trades.map((trade, index) => ({
    schemaVersion,
    seq: startSeq + index,
    type: "TRADE_CLOSED",
    tradeId: trade.id,
    reason,
    ...(playerId ? { playerId } : {}),
  }));

export const closeExpiredTrades = (state: GameState, startSeq = state.eventSeq + 1): GameEvent[] =>
  closeTradeEvents(
    state,
    Object.values(state.trades).filter((trade) => trade.status === "OPEN" && state.eventSeq >= trade.expiresAtSeq),
    "TTL",
    startSeq,
  );

export const closeOpenTradesForPlayer = (state: GameState, playerId: PlayerId, startSeq = state.eventSeq + 1): GameEvent[] =>
  closeTradeEvents(
    state,
    Object.values(state.trades).filter((trade) => (trade.status === "OPEN" || trade.status === "COLLECTING_RESPONSES") && trade.fromPlayerId === playerId),
    "TURN_ENDED",
    startSeq,
    playerId,
  );

const plightTurn = (state: GameState): number => Math.max(1, Math.floor(state.config.rules?.plightTurn ?? defaultPlightTurn));

const plightEvent = (state: GameState, seq: number): GameEvent | undefined => {
  if (!state.config.rules?.plight || state.plightApplied || state.turn < plightTurn(state)) return undefined;
  const destroyed = state.playerOrder.flatMap((playerId) => {
    const candidates = Object.entries(state.buildings)
      .filter(([, building]) => building.owner === playerId)
      .sort(([left], [right]) => left.localeCompare(right));
    if (candidates.length === 0) return [];
    const index = randomIntAt(`${state.config.seed}:plight:${playerId}`, state.turn, candidates.length);
    const [vertexId, building] = candidates[index]!;
    return [{ playerId, vertexId: vertexId as VertexId, buildingType: building.type }];
  });
  return { schemaVersion, seq, type: "PLIGHT_STRUCK", destroyed };
};

const recipientValidationError = (state: GameState, command: Extract<GameCommand, { type: "OFFER_TRADE" }>): ValidationError | null => {
  if (command.recipients === "ANY") return null;
  if (command.recipients.length === 0) return error("TRADE_NOT_ALLOWED", "Choose at least one trade recipient");
  const seen = new Set<PlayerId>();
  for (const recipient of command.recipients) {
    if (!state.players[recipient]) return error("UNKNOWN_PLAYER", `Unknown trade recipient ${recipient}`);
    if (recipient === command.playerId) return error("TRADE_NOT_ALLOWED", "Trade recipient cannot be the offerer");
    if (seen.has(recipient)) return error("TRADE_NOT_ALLOWED", "Trade recipients must be unique");
    seen.add(recipient);
  }
  return null;
};

export const applyCommand = (
  state: GameState,
  command: GameCommand,
): Result<{ nextState: GameState; events: GameEvent[] }, ValidationError> => {
  const validation = validateCommand(state, command);
  if (validation) return { ok: false, error: validation };

  const events: GameEvent[] = [];
  const seq = (offset: number) => nextSeq(state, offset);

  switch (command.type) {
    case "PLACE_SETUP": {
      events.push({
        schemaVersion,
        seq: seq(0),
        type: "SETUP_PLACED",
        playerId: command.playerId,
        vertexId: command.vertexId,
        edgeId: command.edgeId,
        startingResources: setupPlacementGrantsResources(state) ? startingResourcesForVertex(state, command.vertexId) : {},
      });
      break;
    }
    case "ROLL_DICE": {
      const rolled = rollSeededDice(state.rng.seed, state.rng.index);
      const sum = rolled.dice[0] + rolled.dice[1];
      const doublesMultiplier = state.config.rules?.diceDoubles && rolled.dice[0] === rolled.dice[1] ? 2 : 1;
      events.push({
        schemaVersion,
        seq: seq(0),
        type: "DICE_ROLLED",
        playerId: command.playerId,
        dice: rolled.dice,
        sum,
        rngIndex: state.rng.index,
        rngPolicy: state.rng.policy,
        ...(doublesMultiplier > 1 ? { doublesMultiplier } : {}),
      });
      if (sum === 7) {
        events.push({ schemaVersion, seq: seq(1), type: "SEVEN_ROLLED", playerId: command.playerId });
      } else {
        const gains = resourceGainForRoll(state, sum, doublesMultiplier);
        if (hasAnyGain(gains)) {
          events.push({ schemaVersion, seq: seq(1), type: "RESOURCES_PRODUCED", gains, ...(doublesMultiplier > 1 ? { multiplier: doublesMultiplier } : {}) });
        }
      }
      break;
    }
    case "BUILD_ROAD":
      events.push({ schemaVersion, seq: seq(0), type: "ROAD_BUILT", playerId: command.playerId, edgeId: command.edgeId, cost: roadCost() });
      {
        const preview = applyEvents(state, events);
        const update = maybeLongestRoadEvent(state, preview, seq(events.length));
        if (update) events.push(update);
      }
      break;
    case "BUILD_SETTLEMENT":
      events.push({ schemaVersion, seq: seq(0), type: "SETTLEMENT_BUILT", playerId: command.playerId, vertexId: command.vertexId, cost: settlementCost() });
      {
        const preview = applyEvents(state, events);
        const update = maybeLongestRoadEvent(state, preview, seq(events.length));
        if (update) events.push(update);
      }
      break;
    case "UPGRADE_CITY":
      events.push({ schemaVersion, seq: seq(0), type: "CITY_UPGRADED", playerId: command.playerId, vertexId: command.vertexId, cost: cityCost() });
      break;
    case "BUY_SPECIAL_CARD":
      events.push({
        schemaVersion,
        seq: seq(0),
        type: "SPECIAL_CARD_BOUGHT",
        playerId: command.playerId,
        cost: specialCardCost(state.config.rules),
        cardIndex: (state.players[command.playerId]?.specialCards ?? 0) + 1,
      });
      break;
    case "MARITIME_TRADE":
      events.push({
        schemaVersion,
        seq: seq(0),
        type: "MARITIME_TRADED",
        playerId: command.playerId,
        offered: command.offered,
        requested: command.requested,
        ratio: maritimeTradeRatio(state, command.playerId, command.offered),
      });
      break;
    case "OFFER_TRADE": {
      const trade: TradeOffer = {
        id: command.tradeId,
        fromPlayerId: command.playerId,
        offered: command.offered,
        requested: command.requested,
        recipients: command.recipients,
        status: "COLLECTING_RESPONSES",
        createdAtSeq: state.eventSeq,
        expiresAtSeq: seq(command.ttlEvents ?? 12),
      };
      trade.responses = initialTradeResponses(state, trade);
      events.push({ schemaVersion, seq: seq(0), type: "TRADE_OFFERED", trade });
      break;
    }
    case "CANCEL_TRADE":
      events.push({ schemaVersion, seq: seq(0), type: "TRADE_CANCELLED", tradeId: command.tradeId, playerId: command.playerId });
      break;
    case "RESPOND_TRADE": {
      const trade = state.trades[command.tradeId] as TradeOffer;
      events.push({
        schemaVersion,
        seq: seq(0),
        type: "TRADE_RESPONSE_RECORDED",
        tradeId: command.tradeId,
        fromPlayerId: trade.fromPlayerId,
        recipientIds: tradeRecipientIds(state, trade),
        playerId: command.playerId,
        response: command.response,
      });
      if (command.response === "REJECTED") {
        const responses = { ...(trade.responses ?? initialTradeResponses(state, trade)) };
        responses[command.playerId] = { playerId: command.playerId, status: "REJECTED", respondedAtSeq: seq(0) };
        const recipients = tradeRecipientIds(state, trade);
        if (recipients.length > 0 && recipients.every((recipient) => responses[recipient]?.status === "REJECTED")) {
          events.push({ schemaVersion, seq: seq(1), type: "TRADE_CLOSED", tradeId: command.tradeId, playerId: trade.fromPlayerId, reason: "ALL_REJECTED" });
        }
      }
      break;
    }
    case "FINALIZE_TRADE": {
      const trade = state.trades[command.tradeId] as TradeOffer;
      events.push({
        schemaVersion,
        seq: seq(0),
        type: "TRADE_ACCEPTED",
        tradeId: trade.id,
        fromPlayerId: trade.fromPlayerId,
        toPlayerId: command.toPlayerId,
        offered: trade.offered,
        requested: trade.requested,
      });
      break;
    }
    case "ACCEPT_TRADE": {
      const trade = state.trades[command.tradeId] as TradeOffer;
      events.push({
        schemaVersion,
        seq: seq(0),
        type: "TRADE_ACCEPTED",
        tradeId: trade.id,
        fromPlayerId: trade.fromPlayerId,
        toPlayerId: command.playerId,
        offered: trade.offered,
        requested: trade.requested,
      });
      break;
    }
    case "REJECT_TRADE":
      events.push({ schemaVersion, seq: seq(0), type: "TRADE_REJECTED", tradeId: command.tradeId, playerId: command.playerId });
      break;
    case "EXPIRE_TRADE":
      events.push({ schemaVersion, seq: seq(0), type: "TRADE_CLOSED", tradeId: command.tradeId, playerId: command.playerId, reason: command.reason ?? "TTL" });
      break;
    case "END_TURN": {
      const currentIndex = state.playerOrder.indexOf(command.playerId);
      const nextPlayerId = state.playerOrder[(currentIndex + 1) % state.playerOrder.length] as PlayerId;
      const tradeCloseEvents = closeOpenTradesForPlayer(state, command.playerId, seq(0));
      events.push(...tradeCloseEvents);
      events.push({ schemaVersion, seq: seq(tradeCloseEvents.length), type: "TURN_ENDED", playerId: command.playerId, nextPlayerId });
      break;
    }
  }

  let nextState = applyEvents(state, events);
  const plight = plightEvent(nextState, seq(events.length));
  if (plight) {
    events.push(plight);
    nextState = applyEvent(nextState, plight);
  }
  const expiredEvents = closeExpiredTrades(nextState);
  if (expiredEvents.length > 0) {
    events.push(...expiredEvents);
    nextState = applyEvents(nextState, expiredEvents);
  }
  if (nextState.phase.type !== "GAME_OVER" && (nextState.players[command.playerId]?.score ?? 0) >= nextState.config.victoryPoints) {
    const gameOver: GameEvent = { schemaVersion, seq: seq(events.length), type: "GAME_OVER", winnerId: command.playerId, reason: "VICTORY_POINTS" };
    events.push(gameOver);
    nextState = applyEvent(nextState, gameOver);
  }
  const invariant = assertInvariants(nextState);
  if (!invariant.ok) return { ok: false, error: invariant.error };
  return { ok: true, value: { nextState, events } };
};

export const validateCommand = (state: GameState, command: GameCommand): ValidationError | null => {
  if (!state.players[command.playerId]) return error("UNKNOWN_PLAYER", `Unknown player ${command.playerId}`);
  if (state.phase.type === "GAME_OVER") return error("GAME_ALREADY_OVER", "Game is already over");
  const modalTrade = activeCollectingTradeForPlayer(state, command.playerId);
  if (modalTrade) {
    const allowed =
      (command.type === "FINALIZE_TRADE" && command.tradeId === modalTrade.id)
      || (command.type === "CANCEL_TRADE" && command.tradeId === modalTrade.id)
      || (command.type === "EXPIRE_TRADE" && command.tradeId === modalTrade.id);
    if (!allowed) return error("TRADE_NOT_ALLOWED", "Resolve the staged trade before taking another action");
  }

  switch (command.type) {
    case "PLACE_SETUP": {
      const activeError = ensureActive(state, command.playerId);
      if (activeError) return activeError;
      if (state.phase.type !== "SETUP_PLACEMENT") return error("WRONG_PHASE", "Setup placement is not active");
      if (!state.board.vertices[command.vertexId]) return error("UNKNOWN_VERTEX", "Unknown vertex");
      if (!state.board.edges[command.edgeId]) return error("UNKNOWN_EDGE", "Unknown edge");
      if (!edgeTouchesVertex(state, command.edgeId, command.vertexId)) return error("EDGE_NOT_ADJACENT", "Setup road must touch setup settlement");
      if (countBuildings(state, command.playerId, "settlement") >= maxSettlementsPerPlayer) return error("PIECE_LIMIT", "No settlements left to place");
      if (countRoads(state, command.playerId) >= maxRoadsPerPlayer) return error("PIECE_LIMIT", "No roads left to place");
      if (!canPlaceSettlement(state, command.vertexId, false)) return error("DISTANCE_RULE", "Settlement violates distance rule");
      if (!canBuildRoad(state, command.playerId, command.edgeId, command.vertexId)) return error("ROAD_NOT_CONNECTED", "Setup road is not adjacent to settlement");
      return null;
    }
    case "ROLL_DICE": {
      const activeError = ensureActive(state, command.playerId);
      if (activeError) return activeError;
      return state.phase.type === "WAITING_FOR_ROLL" ? null : error("WRONG_PHASE", "Dice can only be rolled at turn start");
    }
    case "BUILD_ROAD": {
      const activeError = ensureActive(state, command.playerId);
      if (activeError) return activeError;
      if (state.phase.type !== "ACTION_PHASE") return error("WRONG_PHASE", "Roads can be built only during action phase");
      if (!state.board.edges[command.edgeId]) return error("UNKNOWN_EDGE", "Unknown edge");
      if (state.roads[command.edgeId]) return error("POSITION_OCCUPIED", "Road is already occupied");
      if (countRoads(state, command.playerId) >= maxRoadsPerPlayer) return error("PIECE_LIMIT", "No roads left to build");
      if (!canBuildRoad(state, command.playerId, command.edgeId)) return error("ROAD_NOT_CONNECTED", "Road must connect to your network");
      if (!hasResources(state.players[command.playerId]!.resources, roadCost())) return error("INSUFFICIENT_RESOURCES", "Not enough resources to build road");
      return null;
    }
    case "BUILD_SETTLEMENT": {
      const activeError = ensureActive(state, command.playerId);
      if (activeError) return activeError;
      if (state.phase.type !== "ACTION_PHASE") return error("WRONG_PHASE", "Settlements can be built only during action phase");
      if (!state.board.vertices[command.vertexId]) return error("UNKNOWN_VERTEX", "Unknown vertex");
      if (countBuildings(state, command.playerId, "settlement") >= maxSettlementsPerPlayer) return error("PIECE_LIMIT", "No settlements left to build");
      if (!canPlaceSettlement(state, command.vertexId, command.playerId)) return error("DISTANCE_RULE", "Settlement must be empty, distanced, and connected to your road");
      if (!hasResources(state.players[command.playerId]!.resources, settlementCost())) return error("INSUFFICIENT_RESOURCES", "Not enough resources to build settlement");
      return null;
    }
    case "UPGRADE_CITY": {
      const activeError = ensureActive(state, command.playerId);
      if (activeError) return activeError;
      if (state.phase.type !== "ACTION_PHASE") return error("WRONG_PHASE", "Cities can be upgraded only during action phase");
      if (!state.board.vertices[command.vertexId]) return error("UNKNOWN_VERTEX", "Unknown vertex");
      const building = buildingAt(state, command.vertexId);
      if (!building || building.owner !== command.playerId || building.type !== "settlement") return error("TRADE_NOT_ALLOWED", "Choose one of your settlements to upgrade");
      if (countBuildings(state, command.playerId, "city") >= maxCitiesPerPlayer) return error("PIECE_LIMIT", "No cities left to build");
      if (!hasResources(state.players[command.playerId]!.resources, cityCost())) return error("INSUFFICIENT_RESOURCES", "Not enough resources to upgrade city");
      return null;
    }
    case "BUY_SPECIAL_CARD": {
      const activeError = ensureActive(state, command.playerId);
      if (activeError) return activeError;
      if (state.phase.type !== "ACTION_PHASE") return error("WRONG_PHASE", "Special cards can be bought only during action phase");
      if (!hasResources(state.players[command.playerId]!.resources, specialCardCost(state.config.rules))) {
        return error("INSUFFICIENT_RESOURCES", "Not enough resources to buy a special card");
      }
      return null;
    }
    case "OFFER_TRADE": {
      const activeError = ensureActive(state, command.playerId);
      if (activeError) return activeError;
      if (state.phase.type !== "ACTION_PHASE") return error("WRONG_PHASE", "Trades can be offered only during action phase");
      if (state.trades[command.tradeId]) return error("STALE_TRADE", "Trade id already exists");
      if (activeCollectingTradeForPlayer(state, command.playerId)) return error("TRADE_NOT_ALLOWED", "Only one staged offer can be open");
      if (command.recipients === "ANY" && state.playerOrder.filter((playerId) => playerId !== command.playerId).length === 0) {
        return error("TRADE_NOT_ALLOWED", "Choose at least one trade recipient");
      }
      if (!isNonNegativeBundle(command.offered) || !isNonNegativeBundle(command.requested)) return error("TRADE_NOT_ALLOWED", "Trade bundles must be non-negative resource counts");
      if (!hasResources(state.players[command.playerId]!.resources, command.offered)) return error("INSUFFICIENT_RESOURCES", "Not enough resources to offer trade");
      if (resourceCount(command.offered) <= 0 || resourceCount(command.requested) <= 0) return error("TRADE_NOT_ALLOWED", "Trade must offer and request resources");
      if (resources.some((resource) => command.offered[resource] > 0 && command.requested[resource] > 0)) {
        return error("TRADE_NOT_ALLOWED", "Trade cannot offer and request the same resource");
      }
      const recipientError = recipientValidationError(state, command);
      if (recipientError) return recipientError;
      return null;
    }
    case "MARITIME_TRADE": {
      const activeError = ensureActive(state, command.playerId);
      if (activeError) return activeError;
      if (state.phase.type !== "ACTION_PHASE") return error("WRONG_PHASE", "Bank trades can be made only during action phase");
      if (!resources.includes(command.offered) || !resources.includes(command.requested) || command.offered === command.requested) {
        return error("TRADE_NOT_ALLOWED", "Choose two different resources for a maritime trade");
      }
      const ratio = maritimeTradeRatio(state, command.playerId, command.offered);
      if (!hasResources(state.players[command.playerId]!.resources, resourceBundle(command.offered, ratio))) {
        return error("INSUFFICIENT_RESOURCES", `Need ${ratio} ${command.offered} for this bank trade`);
      }
      return null;
    }
    case "CANCEL_TRADE": {
      const trade = state.trades[command.tradeId];
      if (!trade) return error("UNKNOWN_TRADE", "Unknown trade");
      if (trade.status !== "OPEN" && trade.status !== "COLLECTING_RESPONSES") return error("STALE_TRADE", "Trade is not open");
      if (trade.fromPlayerId !== command.playerId) return error("TRADE_NOT_ALLOWED", "Only the creator can cancel this trade");
      return null;
    }
    case "RESPOND_TRADE": {
      const trade = state.trades[command.tradeId];
      if (!trade) return error("UNKNOWN_TRADE", "Unknown trade");
      if (trade.status !== "COLLECTING_RESPONSES") return error("STALE_TRADE", "Trade is not collecting responses");
      if (trade.fromPlayerId === command.playerId) return error("TRADE_NOT_ALLOWED", "Cannot respond to your own trade");
      if (!tradeRecipientIds(state, trade).includes(command.playerId)) return error("TRADE_NOT_ALLOWED", "Player is not a recipient");
      if (command.response === "WANTS_ACCEPT") {
        if (!hasResources(state.players[trade.fromPlayerId]?.resources ?? emptyResources(), trade.offered)) return error("INSUFFICIENT_RESOURCES", "Offerer no longer has resources");
        if (!hasResources(state.players[command.playerId]!.resources, trade.requested)) return error("INSUFFICIENT_RESOURCES", "Responder lacks requested resources");
      }
      return null;
    }
    case "FINALIZE_TRADE": {
      const trade = state.trades[command.tradeId];
      if (!trade) return error("UNKNOWN_TRADE", "Unknown trade");
      if (trade.status !== "COLLECTING_RESPONSES") return error("STALE_TRADE", "Trade is not collecting responses");
      if (trade.fromPlayerId !== command.playerId) return error("TRADE_NOT_ALLOWED", "Only the creator can finalize this trade");
      if (!tradeRecipientIds(state, trade).includes(command.toPlayerId)) return error("TRADE_NOT_ALLOWED", "Player is not a recipient");
      if (trade.responses?.[command.toPlayerId]?.status !== "WANTS_ACCEPT") return error("TRADE_NOT_ALLOWED", "Selected player has not offered to accept");
      if (!hasResources(state.players[trade.fromPlayerId]?.resources ?? emptyResources(), trade.offered)) return error("INSUFFICIENT_RESOURCES", "Offerer no longer has resources");
      if (!hasResources(state.players[command.toPlayerId]?.resources ?? emptyResources(), trade.requested)) return error("INSUFFICIENT_RESOURCES", "Selected player lacks requested resources");
      return null;
    }
    case "ACCEPT_TRADE": {
      const trade = state.trades[command.tradeId];
      if (!trade) return error("UNKNOWN_TRADE", "Unknown trade");
      if (trade.status !== "OPEN" || state.eventSeq >= trade.expiresAtSeq) return error("STALE_TRADE", "Trade is stale");
      if (trade.fromPlayerId === command.playerId) return error("TRADE_NOT_ALLOWED", "Cannot accept your own trade");
      if (trade.recipients !== "ANY" && !trade.recipients.includes(command.playerId)) return error("TRADE_NOT_ALLOWED", "Player is not a recipient");
      if (!hasResources(state.players[trade.fromPlayerId]?.resources ?? emptyResources(), trade.offered)) return error("INSUFFICIENT_RESOURCES", "Offerer no longer has resources");
      if (!hasResources(state.players[command.playerId]!.resources, trade.requested)) return error("INSUFFICIENT_RESOURCES", "Accepter lacks requested resources");
      return null;
    }
    case "REJECT_TRADE": {
      const trade = state.trades[command.tradeId];
      if (!trade) return error("UNKNOWN_TRADE", "Unknown trade");
      if (trade.status !== "OPEN") return error("STALE_TRADE", "Trade is not open");
      if (trade.recipients !== "ANY" && !trade.recipients.includes(command.playerId)) return error("TRADE_NOT_ALLOWED", "Player is not a recipient");
      return null;
    }
    case "EXPIRE_TRADE": {
      const trade = state.trades[command.tradeId];
      if (!trade) return error("UNKNOWN_TRADE", "Unknown trade");
      if (trade.status !== "OPEN" && trade.status !== "COLLECTING_RESPONSES") return error("STALE_TRADE", "Trade is not open");
      if ((command.reason ?? "TTL") === "TTL" && state.eventSeq < trade.expiresAtSeq) return error("STALE_TRADE", "Trade has not expired yet");
      return null;
    }
    case "END_TURN": {
      const activeError = ensureActive(state, command.playerId);
      if (activeError) return activeError;
      return state.phase.type === "ACTION_PHASE" ? null : error("WRONG_PHASE", "Turn can only end during action phase");
    }
  }
};

export const applyEvents = (state: GameState, events: readonly GameEvent[]): GameState =>
  events.reduce((current, event) => applyEvent(current, event), state);

export const applyEvent = (state: GameState, event: GameEvent): GameState => {
  const next = cloneState(state);
  next.eventSeq = Math.max(next.eventSeq, event.seq);
  switch (event.type) {
    case "SETUP_PLACED": {
      next.settlements[event.vertexId] = event.playerId;
      next.buildings[event.vertexId] = { owner: event.playerId, type: "settlement" };
      next.roads[event.edgeId] = event.playerId;
      next.players[event.playerId]!.resources = addResources(next.players[event.playerId]!.resources, event.startingResources);
      next.players[event.playerId]!.score += 1;
      refreshLongestRoad(next);
      const setupIndex = next.phase.type === "SETUP_PLACEMENT" ? next.phase.setupIndex + 1 : 0;
      const nextPlayer = setupOrder(next.playerOrder)[setupIndex];
      next.phase = nextPlayer
        ? { type: "SETUP_PLACEMENT", activePlayerId: nextPlayer, setupIndex }
        : { type: "WAITING_FOR_ROLL", activePlayerId: next.playerOrder[0] as PlayerId };
      break;
    }
    case "DICE_ROLLED":
      next.rng.index = event.rngIndex + 2;
      next.lastRoll = { dice: event.dice, sum: event.sum, ...(event.doublesMultiplier ? { doublesMultiplier: event.doublesMultiplier } : {}) };
      next.phase = { type: "ACTION_PHASE", activePlayerId: event.playerId };
      break;
    case "SEVEN_ROLLED":
      next.phase = { type: "ACTION_PHASE", activePlayerId: event.playerId };
      break;
    case "RESOURCES_PRODUCED":
      for (const [playerId, gains] of Object.entries(event.gains)) {
        next.players[playerId]!.resources = addResources(next.players[playerId]!.resources, gains);
      }
      break;
    case "ROAD_BUILT":
      next.roads[event.edgeId] = event.playerId;
      next.players[event.playerId]!.resources = subtractResources(next.players[event.playerId]!.resources, event.cost);
      refreshLongestRoad(next);
      break;
    case "SETTLEMENT_BUILT":
      next.settlements[event.vertexId] = event.playerId;
      next.buildings[event.vertexId] = { owner: event.playerId, type: "settlement" };
      next.players[event.playerId]!.resources = subtractResources(next.players[event.playerId]!.resources, event.cost);
      next.players[event.playerId]!.score += 1;
      refreshLongestRoad(next);
      break;
    case "CITY_UPGRADED":
      next.buildings[event.vertexId] = { owner: event.playerId, type: "city" };
      next.settlements[event.vertexId] = event.playerId;
      next.players[event.playerId]!.resources = subtractResources(next.players[event.playerId]!.resources, event.cost);
      next.players[event.playerId]!.score += 1;
      break;
    case "SPECIAL_CARD_BOUGHT":
      next.players[event.playerId]!.resources = subtractResources(next.players[event.playerId]!.resources, event.cost);
      next.players[event.playerId]!.specialCards += 1;
      break;
    case "LONGEST_ROAD_UPDATED":
      break;
    case "MARITIME_TRADED":
      next.players[event.playerId]!.resources = subtractResources(next.players[event.playerId]!.resources, resourceBundle(event.offered, event.ratio));
      next.players[event.playerId]!.resources = addResources(next.players[event.playerId]!.resources, resourceBundle(event.requested, 1));
      break;
    case "TRADE_OFFERED":
      next.trades[event.trade.id] = event.trade;
      break;
    case "TRADE_CANCELLED":
      next.trades[event.tradeId]!.status = "CANCELLED";
      break;
    case "TRADE_RESPONSE_RECORDED": {
      const trade = next.trades[event.tradeId];
      if (!trade || !event.playerId || !event.response) break;
      trade.responses = trade.responses ?? initialTradeResponses(next, trade);
      trade.responses[event.playerId] = { playerId: event.playerId, status: event.response, respondedAtSeq: event.seq };
      break;
    }
    case "TRADE_REJECTED":
      next.trades[event.tradeId]!.status = "REJECTED";
      break;
    case "TRADE_ACCEPTED":
      next.players[event.fromPlayerId]!.resources = subtractResources(next.players[event.fromPlayerId]!.resources, event.offered);
      next.players[event.toPlayerId]!.resources = addResources(next.players[event.toPlayerId]!.resources, event.offered);
      next.players[event.toPlayerId]!.resources = subtractResources(next.players[event.toPlayerId]!.resources, event.requested);
      next.players[event.fromPlayerId]!.resources = addResources(next.players[event.fromPlayerId]!.resources, event.requested);
      next.trades[event.tradeId]!.status = "ACCEPTED";
      break;
    case "TRADE_EXPIRED":
      next.trades[event.tradeId]!.status = "EXPIRED";
      break;
    case "TRADE_CLOSED":
      next.trades[event.tradeId]!.status = "CLOSED";
      next.trades[event.tradeId]!.closedReason = event.reason;
      break;
    case "PLIGHT_STRUCK":
      next.plightApplied = true;
      for (const destroyed of event.destroyed) {
        delete next.settlements[destroyed.vertexId];
        delete next.buildings[destroyed.vertexId];
        next.players[destroyed.playerId]!.score = Math.max(0, next.players[destroyed.playerId]!.score - (destroyed.buildingType === "city" ? 2 : 1));
      }
      refreshLongestRoad(next);
      break;
    case "TURN_ENDED":
      next.turn += 1;
      next.phase = { type: "WAITING_FOR_ROLL", activePlayerId: event.nextPlayerId };
      break;
    case "GAME_OVER":
      next.phase = { type: "GAME_OVER", winnerId: event.winnerId };
      break;
  }
  return next;
};

export const assertInvariants = (state: GameState): Result<true, ValidationError> => {
  const boardErrors = validateBoard(state.board);
  if (boardErrors.length > 0) return { ok: false, error: error("INVALID_BOARD", boardErrors.join("; ")) };
  for (const player of Object.values(state.players)) {
    if (!isNonNegativeBundle(player.resources)) return { ok: false, error: error("INVARIANT_VIOLATION", `${player.id} has negative resources`) };
    if (!Number.isInteger(player.specialCards) || player.specialCards < 0) return { ok: false, error: error("INVARIANT_VIOLATION", `${player.id} has invalid special cards`) };
    if (player.score < 0) return { ok: false, error: error("INVARIANT_VIOLATION", `${player.id} has negative score`) };
  }
  for (const [edgeId, playerId] of Object.entries(state.roads)) {
    if (!state.board.edges[edgeId]) return { ok: false, error: error("INVARIANT_VIOLATION", `road on unknown edge ${edgeId}`) };
    if (!state.players[playerId]) return { ok: false, error: error("INVARIANT_VIOLATION", `road owned by unknown player ${playerId}`) };
  }
  for (const [vertexId, playerId] of Object.entries(state.settlements)) {
    if (!state.board.vertices[vertexId]) return { ok: false, error: error("INVARIANT_VIOLATION", `settlement on unknown vertex ${vertexId}`) };
    if (!state.players[playerId]) return { ok: false, error: error("INVARIANT_VIOLATION", `settlement owned by unknown player ${playerId}`) };
    const building = state.buildings[vertexId];
    if (!building || building.owner !== playerId) return { ok: false, error: error("INVARIANT_VIOLATION", `building state missing for ${vertexId}`) };
    for (const neighbor of adjacentVertices(state, vertexId as VertexId)) {
      if (state.settlements[neighbor]) return { ok: false, error: error("INVARIANT_VIOLATION", `settlement distance violation at ${vertexId}`) };
    }
  }
  for (const [vertexId, building] of Object.entries(state.buildings)) {
    if (!state.board.vertices[vertexId]) return { ok: false, error: error("INVARIANT_VIOLATION", `building on unknown vertex ${vertexId}`) };
    if (!state.players[building.owner]) return { ok: false, error: error("INVARIANT_VIOLATION", `building owned by unknown player ${building.owner}`) };
    if (state.settlements[vertexId] !== building.owner) return { ok: false, error: error("INVARIANT_VIOLATION", `settlement owner mismatch at ${vertexId}`) };
  }
  for (const trade of Object.values(state.trades)) {
    if (!state.players[trade.fromPlayerId]) return { ok: false, error: error("INVARIANT_VIOLATION", `trade owned by unknown player ${trade.fromPlayerId}`) };
    if (trade.status !== "COLLECTING_RESPONSES") continue;
    const recipients = tradeRecipientIds(state, trade);
    const responseIds = Object.keys(trade.responses ?? {});
    if (responseIds.length !== recipients.length || recipients.some((playerId) => !trade.responses?.[playerId])) {
      return { ok: false, error: error("INVARIANT_VIOLATION", `trade ${trade.id} has invalid response entries`) };
    }
    for (const response of Object.values(trade.responses ?? {})) {
      if (!recipients.includes(response.playerId)) return { ok: false, error: error("INVARIANT_VIOLATION", `trade ${trade.id} has an invalid responder`) };
      if (response.status !== "PENDING" && response.status !== "WANTS_ACCEPT" && response.status !== "REJECTED") {
        return { ok: false, error: error("INVARIANT_VIOLATION", `trade ${trade.id} has invalid response status`) };
      }
    }
  }
  for (const playerId of state.playerOrder) {
    if (countRoads(state, playerId) > maxRoadsPerPlayer) return { ok: false, error: error("INVARIANT_VIOLATION", `${playerId} has too many roads`) };
    if (countBuildings(state, playerId, "settlement") > maxSettlementsPerPlayer) return { ok: false, error: error("INVARIANT_VIOLATION", `${playerId} has too many settlements`) };
    if (countBuildings(state, playerId, "city") > maxCitiesPerPlayer) return { ok: false, error: error("INVARIANT_VIOLATION", `${playerId} has too many cities`) };
  }
  if (state.phase.type === "GAME_OVER" && state.players[state.phase.winnerId]!.score < state.config.victoryPoints) {
    return { ok: false, error: error("INVARIANT_VIOLATION", "game over before victory threshold") };
  }
  return { ok: true, value: true };
};

export const getLegalActions = (state: GameState, playerId: PlayerId): LegalAction[] => {
  if (!state.players[playerId] || state.phase.type === "GAME_OVER" || activePlayer(state) !== playerId) return [];
  if (activeCollectingTradeForPlayer(state, playerId)) return [];
  if (state.phase.type === "SETUP_PLACEMENT") {
    return [{ type: "PLACE_SETUP", vertices: Object.keys(state.board.vertices).filter((vertexId) => canPlaceSettlement(state, vertexId as VertexId, false)) as VertexId[] }];
  }
  if (state.phase.type === "WAITING_FOR_ROLL") return [{ type: "ROLL_DICE" }];
  const actions: LegalAction[] = [{ type: "END_TURN" }, { type: "OFFER_TRADE" }];
  const maritimeTrades = resources.flatMap((offered) => {
    const ratio = maritimeTradeRatio(state, playerId, offered);
    if (state.players[playerId]!.resources[offered] < ratio) return [];
    return resources
      .filter((requested) => requested !== offered)
      .map((requested) => ({ offered, requested, ratio }));
  });
  if (maritimeTrades.length > 0) actions.push({ type: "MARITIME_TRADE", trades: maritimeTrades });
  const roadEdges = countRoads(state, playerId) < maxRoadsPerPlayer
    ? Object.keys(state.board.edges).filter((edgeId) => canBuildRoad(state, playerId, edgeId as EdgeId) && hasResources(state.players[playerId]!.resources, roadCost())) as EdgeId[]
    : [];
  if (roadEdges.length > 0) actions.push({ type: "BUILD_ROAD", edges: roadEdges });
  const settlementVertices = countBuildings(state, playerId, "settlement") < maxSettlementsPerPlayer
    ? Object.keys(state.board.vertices).filter((vertexId) => canPlaceSettlement(state, vertexId as VertexId, playerId) && hasResources(state.players[playerId]!.resources, settlementCost())) as VertexId[]
    : [];
  if (settlementVertices.length > 0) actions.push({ type: "BUILD_SETTLEMENT", vertices: settlementVertices });
  const cityVertices = Object.entries(state.buildings)
    .filter(([, building]) => building.owner === playerId && building.type === "settlement")
    .map(([vertexId]) => vertexId as VertexId)
    .filter(() => countBuildings(state, playerId, "city") < maxCitiesPerPlayer && hasResources(state.players[playerId]!.resources, cityCost()));
  if (cityVertices.length > 0) actions.push({ type: "UPGRADE_CITY", vertices: cityVertices });
  if (hasResources(state.players[playerId]!.resources, specialCardCost(state.config.rules))) {
    actions.push({ type: "BUY_SPECIAL_CARD", cost: specialCardCost(state.config.rules) });
  }
  return actions;
};
