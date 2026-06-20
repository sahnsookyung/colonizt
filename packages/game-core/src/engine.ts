import { createFixedBoard, createSeededBoard, validateBoard } from "./board.js";
import { randomIntAt, rollSeededDice, seededShuffle } from "./rng.js";
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
  type DevelopmentCard,
  type DevelopmentCardId,
  type DevelopmentCardType,
  type EdgeId,
  type GameCommand,
  type GameConfig,
  type GameEvent,
  type GameRules,
  type GameState,
  type LegalAction,
  type PlayerId,
  type HexId,
  type Resource,
  type ResourceBundle,
  type Result,
  type RoadBuildingPlan,
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
export const largestArmyMinimum = 3;
export const largestArmyBonus = 2;
const defaultPlightTurn = 20;

export const classicDevelopmentDeck: DevelopmentCardType[] = [
  ...Array.from({ length: 14 }, () => "KNIGHT" as const),
  ...Array.from({ length: 5 }, () => "VICTORY_POINT" as const),
  ...Array.from({ length: 2 }, () => "ROAD_BUILDING" as const),
  ...Array.from({ length: 2 }, () => "MONOPOLY" as const),
  ...Array.from({ length: 2 }, () => "YEAR_OF_PLENTY" as const),
];

export const createDevelopmentDeck = (seed: string): DevelopmentCardType[] =>
  seededShuffle(classicDevelopmentDeck, `${seed}:development-deck:v3`);

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

const initialThiefHex = (board: GameState["board"]): HexId | undefined =>
  Object.values(board.hexes).find((hex) => hex.resource === "desert")?.id
  ?? Object.keys(board.hexes).sort()[0];

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
        developmentCards: [],
        score: 0,
        longestRoadLength: 0,
        hasLongestRoad: false,
        playedKnights: 0,
        hasLargestArmy: false,
      },
    ]),
  );
  const firstPlayer = normalizedConfig.playerOrder[0];
  if (!firstPlayer) throw new Error("Game requires at least one player");
  const game: GameState = {
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
    developmentDeck: createDevelopmentDeck(normalizedConfig.seed),
    developmentDeckCursor: 0,
    playedKnightCounts: Object.fromEntries(normalizedConfig.playerOrder.map((playerId) => [playerId, 0])),
    eventSeq: 0,
    rng: { seed: normalizedConfig.seed, index: 0, policy: "SEEDED_DETERMINISTIC" },
  };
  const thiefHexId = initialThiefHex(selectedBoard);
  if (thiefHexId) game.thiefHexId = thiefHexId;
  return game;
};

const error = (code: ValidationError["code"], message: string): ValidationError => ({ code, message });

const cloneState = (state: GameState): GameState => structuredClone(state) as GameState;

const nextSeq = (state: GameState, offset: number): number => state.eventSeq + offset + 1;

const activePlayer = (state: GameState): PlayerId | undefined =>
  "activePlayerId" in state.phase ? state.phase.activePlayerId : undefined;

const normalizedCardCount = (player: GameState["players"][PlayerId]): number =>
  player.developmentCards && player.developmentCards.length > 0
    ? player.developmentCards.filter((card) => !card.playedTurn).length
    : player.specialCards;

const cardVictoryPoints = (player: GameState["players"][PlayerId], includeHidden = true): number =>
  (player.developmentCards ?? []).filter((card) => card.type === "VICTORY_POINT" && (includeHidden || card.revealed)).length;

export const trueVictoryPoints = (state: GameState, playerId: PlayerId): number => {
  const player = state.players[playerId];
  if (!player) return 0;
  return player.score + cardVictoryPoints(player, true);
};

export const publicVictoryPoints = (state: GameState, playerId: PlayerId): number => {
  const player = state.players[playerId];
  if (!player) return 0;
  return player.score + cardVictoryPoints(player, state.phase.type === "GAME_OVER");
};

const winnerByVictoryPoints = (state: GameState): PlayerId | undefined =>
  state.playerOrder.find((playerId) => trueVictoryPoints(state, playerId) >= state.config.victoryPoints);

const tokenPipWeight = (token: number | undefined): number => {
  if (!token || token === 7) return 0;
  return 6 - Math.abs(7 - token);
};

const adjudicationProgressScore = (state: GameState, playerId: PlayerId): number => {
  const player = state.players[playerId];
  if (!player) return Number.NEGATIVE_INFINITY;
  const production = Object.entries(state.buildings).reduce((sum, [vertexId, building]) => {
    if (building.owner !== playerId) return sum;
    const multiplier = building.type === "city" ? 2 : 1;
    const pips = (state.board.vertices[vertexId as VertexId]?.adjacentHexes ?? [])
      .reduce((total, hexId) => total + tokenPipWeight(state.board.hexes[hexId]?.token), 0);
    return sum + pips * multiplier;
  }, 0);
  const buildingProgress = Object.values(state.buildings).reduce((sum, building) => {
    if (building.owner !== playerId) return sum;
    return sum + (building.type === "city" ? 2.4 : 1.2);
  }, 0);
  const usefulHand = Math.min(7, resourceCount(player.resources)) * 0.04;
  const hoardingPenalty = Math.max(0, resourceCount(player.resources) - 7) * 0.08;
  return buildingProgress
    + production * 0.08
    + (player.longestRoadLength ?? 0) * 0.08
    + (player.playedKnights ?? 0) * 0.16
    + usefulHand
    - hoardingPenalty;
};

const adjudicatedLeader = (state: GameState): PlayerId => {
  const ranked = [...state.playerOrder].sort((left, right) => {
    const vpDelta = trueVictoryPoints(state, right) - trueVictoryPoints(state, left);
    if (vpDelta !== 0) return vpDelta;
    const publicDelta = (state.players[right]?.score ?? 0) - (state.players[left]?.score ?? 0);
    if (publicDelta !== 0) return publicDelta;
    const progressDelta = adjudicationProgressScore(state, right) - adjudicationProgressScore(state, left);
    if (progressDelta !== 0) return progressDelta;
    return state.playerOrder.indexOf(left) - state.playerOrder.indexOf(right);
  });
  return ranked[0] as PlayerId;
};

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

const roadBuildingSequenceKey = (edgeIds: readonly EdgeId[]): string => edgeIds.join(">");

export const roadBuildingPlan = (state: GameState, playerId: PlayerId): RoadBuildingPlan => {
  const remainingPieces = Math.max(0, maxRoadsPerPlayer - countRoads(state, playerId));
  const firstEdges = Object.keys(state.board.edges).filter((edgeId) => canBuildRoad(state, playerId, edgeId as EdgeId)) as EdgeId[];
  if (remainingPieces <= 0 || firstEdges.length === 0) return { requiredRoadCount: 0, firstEdges, options: [] };
  if (remainingPieces === 1) return { requiredRoadCount: 1, firstEdges, options: firstEdges.map((edgeId) => [edgeId] as [EdgeId]) };

  const twoRoadOptions = firstEdges.flatMap((edgeId) => {
    const preview = cloneState(state);
    preview.roads[edgeId] = playerId;
    return Object.keys(preview.board.edges)
      .filter((candidate) => candidate !== edgeId && canBuildRoad(preview, playerId, candidate as EdgeId))
      .map((candidate) => [edgeId, candidate as EdgeId] as [EdgeId, EdgeId]);
  });
  if (twoRoadOptions.length > 0) return { requiredRoadCount: 2, firstEdges, options: twoRoadOptions };
  return { requiredRoadCount: 1, firstEdges, options: firstEdges.map((edgeId) => [edgeId] as [EdgeId]) };
};

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

const knightCountForPlayer = (state: GameState, playerId: PlayerId): number =>
  state.playedKnightCounts?.[playerId] ?? state.players[playerId]?.playedKnights ?? 0;

const largestArmySummary = (state: GameState): { owner?: PlayerId; knightCount: number } => {
  const counts = Object.fromEntries(state.playerOrder.map((playerId) => [playerId, knightCountForPlayer(state, playerId)])) as Record<PlayerId, number>;
  const currentOwner = state.largestArmyOwner;
  const currentCount = currentOwner ? counts[currentOwner] ?? 0 : 0;
  if (currentOwner && currentCount >= largestArmyMinimum) {
    const strictChallenger = state.playerOrder.find((playerId) => playerId !== currentOwner && (counts[playerId] ?? 0) > currentCount);
    if (!strictChallenger) return { owner: currentOwner, knightCount: currentCount };
  }
  const bestCount = Math.max(0, ...Object.values(counts));
  if (bestCount < largestArmyMinimum) return { knightCount: bestCount };
  const leaders = state.playerOrder.filter((playerId) => counts[playerId] === bestCount);
  return leaders.length === 1 ? { owner: leaders[0]!, knightCount: bestCount } : { knightCount: bestCount };
};

const refreshLargestArmy = (state: GameState): void => {
  for (const player of Object.values(state.players)) {
    if (player.hasLargestArmy) player.score -= largestArmyBonus;
    player.hasLargestArmy = false;
  }
  const summary = largestArmySummary(state);
  if (summary.owner) {
    state.largestArmyOwner = summary.owner;
    state.players[summary.owner]!.hasLargestArmy = true;
    state.players[summary.owner]!.score += largestArmyBonus;
  } else {
    delete state.largestArmyOwner;
  }
};

const maybeLargestArmyEvent = (before: GameState, after: GameState, seq: number): GameEvent | undefined => {
  const summary = largestArmySummary(after);
  if (before.largestArmyOwner === summary.owner) return undefined;
  return summary.owner
    ? { schemaVersion, seq, type: "LARGEST_ARMY_UPDATED", playerId: summary.owner, knightCount: summary.knightCount }
    : { schemaVersion, seq, type: "LARGEST_ARMY_UPDATED", knightCount: summary.knightCount };
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
    if (state.thiefHexId && hex.id === state.thiefHexId) continue;
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

const discardRequirements = (state: GameState): Record<PlayerId, number> =>
  Object.fromEntries(
    state.playerOrder
      .map((playerId) => [playerId, Math.floor(resourceCount(state.players[playerId]?.resources ?? emptyResources()) / 2)] as const)
      .filter(([playerId, count]) => count > 0 && resourceCount(state.players[playerId]?.resources ?? emptyResources()) > 7),
  );

const nextPendingDiscardPlayer = (pending: Record<PlayerId, number>, submitted: Record<PlayerId, Partial<ResourceBundle>>): PlayerId | undefined =>
  Object.keys(pending).find((playerId) => !submitted[playerId]);

export const deterministicDiscard = (state: GameState, playerId: PlayerId, count?: number): ResourceBundle => {
  const player = state.players[playerId];
  const target = count ?? (state.phase.type === "DISCARDING" ? state.phase.pending[playerId] ?? 0 : Math.floor(resourceCount(player?.resources ?? emptyResources()) / 2));
  const discard = emptyResources();
  if (!player || target <= 0) return discard;
  const priority: Resource[] = ["ore", "grain", "fiber", "timber", "brick"];
  for (let index = 0; index < target; index += 1) {
    const candidates = [...resources]
      .filter((resource) => player.resources[resource] - discard[resource] > 0)
      .sort((left, right) => {
        const countDelta = (player.resources[right] - discard[right]) - (player.resources[left] - discard[left]);
        if (countDelta !== 0) return countDelta;
        return priority.indexOf(right) - priority.indexOf(left);
      });
    const resource = candidates[0];
    if (!resource) break;
    discard[resource] += 1;
  }
  return discard;
};

const validThiefHexes = (state: GameState): HexId[] => {
  const hexes = Object.keys(state.board.hexes).sort() as HexId[];
  return hexes.length <= 1 ? hexes : hexes.filter((hexId) => hexId !== state.thiefHexId);
};

export const eligibleStealTargets = (state: GameState, playerId: PlayerId, hexId: HexId): PlayerId[] => {
  const targets = new Set<PlayerId>();
  for (const vertexId of state.board.adjacency.hexToVertices[hexId] ?? []) {
    const owner = state.settlements[vertexId];
    if (!owner || owner === playerId) continue;
    if (resourceCount(state.players[owner]?.resources ?? emptyResources()) <= 0) continue;
    targets.add(owner);
  }
  return [...targets].sort((left, right) => state.playerOrder.indexOf(left) - state.playerOrder.indexOf(right));
};

const stolenResourceFor = (state: GameState, playerId: PlayerId, fromPlayerId: PlayerId, hexId: HexId, seq: number): Resource | undefined => {
  const resourcesInHand = resources.filter((resource) => (state.players[fromPlayerId]?.resources[resource] ?? 0) > 0);
  if (resourcesInHand.length === 0) return undefined;
  const index = randomIntAt(`${state.config.seed}:thief:${state.config.matchId}:${playerId}:${fromPlayerId}:${hexId}`, seq, resourcesInHand.length);
  return resourcesInHand[index];
};

const developmentCard = (state: GameState, playerId: PlayerId, cardId: DevelopmentCardId, type?: DevelopmentCardType): DevelopmentCard | undefined =>
  (state.players[playerId]?.developmentCards ?? []).find((card) => card.id === cardId && (!type || card.type === type));

const playableDevelopmentCards = <T extends Exclude<DevelopmentCardType, "VICTORY_POINT">>(
  state: GameState,
  playerId: PlayerId,
  type?: T,
): DevelopmentCard[] =>
  (state.players[playerId]?.developmentCards ?? []).filter((card) =>
    card.type !== "VICTORY_POINT"
    && !card.playedTurn
    && card.boughtTurn !== state.turn
    && state.players[playerId]?.playedDevelopmentCardTurn !== state.turn
    && (!type || card.type === type),
  );

const canPlayCardPhase = (state: GameState): boolean =>
  state.phase.type === "WAITING_FOR_ROLL" || state.phase.type === "ACTION_PHASE";

const validateDevelopmentCardPlay = <T extends Exclude<DevelopmentCardType, "VICTORY_POINT">>(
  state: GameState,
  playerId: PlayerId,
  cardId: DevelopmentCardId,
  type: T,
): ValidationError | null => {
  const activeError = ensureActive(state, playerId);
  if (activeError) return activeError;
  if (!canPlayCardPhase(state)) return error("WRONG_PHASE", "Development cards can be played only before or after rolling");
  if (state.players[playerId]?.playedDevelopmentCardTurn === state.turn) return error("CARD_NOT_PLAYABLE", "Only one development card can be played per turn");
  const card = developmentCard(state, playerId, cardId, type);
  if (!card) return error("UNKNOWN_CARD", "Development card not found");
  if (card.playedTurn) return error("CARD_NOT_PLAYABLE", "Development card was already played");
  if (card.boughtTurn === state.turn) return error("CARD_NOT_PLAYABLE", "Development cards cannot be played on the turn they are bought");
  return null;
};

const validateThiefMove = (state: GameState, playerId: PlayerId, hexId: HexId, stealFromPlayerId?: PlayerId): ValidationError | null => {
  if (!state.board.hexes[hexId]) return error("INVALID_THIEF_MOVE", "Unknown thief destination");
  if (!validThiefHexes(state).includes(hexId)) return error("INVALID_THIEF_MOVE", "Thief must move to a different hex");
  const eligible = eligibleStealTargets(state, playerId, hexId);
  if (stealFromPlayerId && !eligible.includes(stealFromPlayerId)) return error("INVALID_THIEF_MOVE", "Choose an eligible player to steal from");
  return null;
};

const normalizeExactBundle = (bundle: Partial<ResourceBundle>): ResourceBundle =>
  ({ ...emptyResources(), ...bundle });

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
        const pending = discardRequirements(state);
        if (Object.keys(pending).length > 0) {
          events.push({ schemaVersion, seq: seq(2), type: "DISCARD_REQUIRED", rollerId: command.playerId, pending });
        }
      } else {
        const gains = resourceGainForRoll(state, sum, doublesMultiplier);
        if (hasAnyGain(gains)) {
          events.push({ schemaVersion, seq: seq(1), type: "RESOURCES_PRODUCED", gains, ...(doublesMultiplier > 1 ? { multiplier: doublesMultiplier } : {}) });
        }
      }
      break;
    }
    case "DISCARD_RESOURCES":
      events.push({ schemaVersion, seq: seq(0), type: "RESOURCES_DISCARDED", playerId: command.playerId, resources: command.resources });
      break;
    case "MOVE_THIEF": {
      const stolenResource = command.stealFromPlayerId ? stolenResourceFor(state, command.playerId, command.stealFromPlayerId, command.hexId, seq(0)) : undefined;
      events.push({
        schemaVersion,
        seq: seq(0),
        type: "THIEF_MOVED",
        playerId: command.playerId,
        ...(state.thiefHexId ? { fromHexId: state.thiefHexId } : {}),
        toHexId: command.hexId,
        reason: "ROLL_7",
        ...(command.stealFromPlayerId ? { stealFromPlayerId: command.stealFromPlayerId } : {}),
        ...(stolenResource ? { stolenResource } : {}),
      });
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
      {
        const deckIndex = state.developmentDeckCursor;
        const cardType = state.developmentDeck[deckIndex];
        const cardId = `${state.config.matchId}:dev:${deckIndex + 1}`;
        if (!cardType) break;
      events.push({
        schemaVersion,
        seq: seq(0),
        type: "SPECIAL_CARD_BOUGHT",
        playerId: command.playerId,
        cost: specialCardCost(state.config.rules),
          cardIndex: normalizedCardCount(state.players[command.playerId]!) + 1,
          cardId,
          cardType,
          deckIndex,
      });
      }
      break;
    case "PLAY_KNIGHT": {
      events.push({ schemaVersion, seq: seq(0), type: "DEVELOPMENT_CARD_PLAYED", playerId: command.playerId, cardId: command.cardId, cardType: "KNIGHT" });
      const stolenResource = command.stealFromPlayerId ? stolenResourceFor(state, command.playerId, command.stealFromPlayerId, command.hexId, seq(1)) : undefined;
      events.push({
        schemaVersion,
        seq: seq(1),
        type: "THIEF_MOVED",
        playerId: command.playerId,
        ...(state.thiefHexId ? { fromHexId: state.thiefHexId } : {}),
        toHexId: command.hexId,
        reason: "KNIGHT",
        cardId: command.cardId,
        ...(command.stealFromPlayerId ? { stealFromPlayerId: command.stealFromPlayerId } : {}),
        ...(stolenResource ? { stolenResource } : {}),
      });
      const preview = applyEvents(state, events);
      const update = maybeLargestArmyEvent(state, preview, seq(events.length));
      if (update) events.push(update);
      break;
    }
    case "PLAY_ROAD_BUILDING": {
      events.push({ schemaVersion, seq: seq(0), type: "DEVELOPMENT_CARD_PLAYED", playerId: command.playerId, cardId: command.cardId, cardType: "ROAD_BUILDING" });
      events.push({ schemaVersion, seq: seq(1), type: "ROAD_BUILDING_PLAYED", playerId: command.playerId, cardId: command.cardId, edgeIds: command.edgeIds });
      command.edgeIds.forEach((edgeId, index) => {
        events.push({ schemaVersion, seq: seq(2 + index), type: "ROAD_BUILT", playerId: command.playerId, edgeId, cost: emptyResources() });
      });
      const preview = applyEvents(state, events);
      const update = maybeLongestRoadEvent(state, preview, seq(events.length));
      if (update) events.push(update);
      break;
    }
    case "PLAY_MONOPOLY": {
      const collected = Object.fromEntries(
        state.playerOrder
          .filter((playerId) => playerId !== command.playerId)
          .map((playerId) => [playerId, state.players[playerId]?.resources[command.resource] ?? 0] as const)
          .filter((entry): entry is readonly [PlayerId, number] => entry[1] > 0),
      ) as Record<PlayerId, number>;
      events.push({ schemaVersion, seq: seq(0), type: "DEVELOPMENT_CARD_PLAYED", playerId: command.playerId, cardId: command.cardId, cardType: "MONOPOLY" });
      events.push({ schemaVersion, seq: seq(1), type: "MONOPOLY_PLAYED", playerId: command.playerId, cardId: command.cardId, resource: command.resource, collected });
      break;
    }
    case "PLAY_YEAR_OF_PLENTY":
      events.push({ schemaVersion, seq: seq(0), type: "DEVELOPMENT_CARD_PLAYED", playerId: command.playerId, cardId: command.cardId, cardType: "YEAR_OF_PLENTY" });
      events.push({ schemaVersion, seq: seq(1), type: "YEAR_OF_PLENTY_PLAYED", playerId: command.playerId, cardId: command.cardId, resources: command.resources });
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
  const victoryWinner = nextState.phase.type !== "GAME_OVER" ? winnerByVictoryPoints(nextState) : undefined;
  if (victoryWinner) {
    const gameOver: GameEvent = { schemaVersion, seq: seq(events.length), type: "GAME_OVER", winnerId: victoryWinner, reason: "VICTORY_POINTS" };
    events.push(gameOver);
    nextState = applyEvent(nextState, gameOver);
  } else if (
    nextState.phase.type !== "GAME_OVER"
    && command.type === "END_TURN"
    && nextState.config.rules?.maxTurnAdjudication === "leader"
    && Number.isInteger(nextState.config.rules.maxTurns)
    && nextState.turn >= (nextState.config.rules.maxTurns ?? Number.POSITIVE_INFINITY)
  ) {
    const gameOver: GameEvent = { schemaVersion, seq: seq(events.length), type: "GAME_OVER", winnerId: adjudicatedLeader(nextState), reason: "TURN_LIMIT" };
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
    case "DISCARD_RESOURCES": {
      if (state.phase.type !== "DISCARDING") return error("WRONG_PHASE", "Discarding is not active");
      const required = state.phase.pending[command.playerId] ?? 0;
      if (required <= 0 || state.phase.submitted[command.playerId]) return error("INVALID_DISCARD", "This player is not pending a discard");
      if (!isNonNegativeBundle(command.resources)) return error("INVALID_DISCARD", "Discard bundle must be non-negative");
      if (resourceCount(command.resources) !== required) return error("INVALID_DISCARD", `Discard exactly ${required} resources`);
      if (!hasResources(state.players[command.playerId]!.resources, command.resources)) return error("INSUFFICIENT_RESOURCES", "Cannot discard resources you do not have");
      return null;
    }
    case "MOVE_THIEF": {
      const activeError = ensureActive(state, command.playerId);
      if (activeError) return activeError;
      if (state.phase.type !== "MOVING_THIEF" || state.phase.reason !== "ROLL_7") return error("WRONG_PHASE", "Thief movement is not active");
      return validateThiefMove(state, command.playerId, command.hexId, command.stealFromPlayerId);
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
      if (state.developmentDeckCursor >= state.developmentDeck.length) return error("DECK_EMPTY", "Development card deck is exhausted");
      if (!hasResources(state.players[command.playerId]!.resources, specialCardCost(state.config.rules))) {
        return error("INSUFFICIENT_RESOURCES", "Not enough resources to buy a special card");
      }
      return null;
    }
    case "PLAY_KNIGHT": {
      const cardError = validateDevelopmentCardPlay(state, command.playerId, command.cardId, "KNIGHT");
      if (cardError) return cardError;
      return validateThiefMove(state, command.playerId, command.hexId, command.stealFromPlayerId);
    }
    case "PLAY_ROAD_BUILDING": {
      const cardError = validateDevelopmentCardPlay(state, command.playerId, command.cardId, "ROAD_BUILDING");
      if (cardError) return cardError;
      if (command.edgeIds.length < 1 || command.edgeIds.length > 2 || new Set(command.edgeIds).size !== command.edgeIds.length) {
        return error("CARD_NOT_PLAYABLE", "Road Building must choose one or two unique roads");
      }
      const plan = roadBuildingPlan(state, command.playerId);
      if (plan.requiredRoadCount <= 0) return error("CARD_NOT_PLAYABLE", "No legal roads are available");
      if (command.edgeIds.length !== plan.requiredRoadCount) {
        return error("CARD_NOT_PLAYABLE", plan.requiredRoadCount === 2 ? "Road Building must build two roads when two are available" : "Road Building can build only one road here");
      }
      if (countRoads(state, command.playerId) + command.edgeIds.length > maxRoadsPerPlayer) return error("PIECE_LIMIT", "No roads left to build");
      const preview = cloneState(state);
      for (const edgeId of command.edgeIds) {
        if (!preview.board.edges[edgeId]) return error("UNKNOWN_EDGE", "Unknown edge");
        if (preview.roads[edgeId]) return error("POSITION_OCCUPIED", "Road is already occupied");
        if (!canBuildRoad(preview, command.playerId, edgeId)) return error("ROAD_NOT_CONNECTED", "Road must connect to your network");
        preview.roads[edgeId] = command.playerId;
      }
      const optionKeys = new Set(plan.options.map((option) => roadBuildingSequenceKey(option)));
      if (!optionKeys.has(roadBuildingSequenceKey(command.edgeIds))) return error("CARD_NOT_PLAYABLE", "Choose a legal Road Building sequence");
      return null;
    }
    case "PLAY_MONOPOLY": {
      const cardError = validateDevelopmentCardPlay(state, command.playerId, command.cardId, "MONOPOLY");
      if (cardError) return cardError;
      return resources.includes(command.resource) ? null : error("TRADE_NOT_ALLOWED", "Choose a valid resource");
    }
    case "PLAY_YEAR_OF_PLENTY": {
      const cardError = validateDevelopmentCardPlay(state, command.playerId, command.cardId, "YEAR_OF_PLENTY");
      if (cardError) return cardError;
      return command.resources.every((resource) => resources.includes(resource)) ? null : error("TRADE_NOT_ALLOWED", "Choose valid resources");
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
  next.developmentDeck ??= createDevelopmentDeck(next.config.seed);
  next.developmentDeckCursor ??= 0;
  next.playedKnightCounts ??= {};
  for (const player of Object.values(next.players)) {
    player.developmentCards ??= [];
    player.playedKnights ??= next.playedKnightCounts[player.id] ?? 0;
    player.hasLargestArmy ??= next.largestArmyOwner === player.id;
    player.specialCards = normalizedCardCount(player);
  }
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
      next.phase = { type: "MOVING_THIEF", activePlayerId: event.playerId, rollerId: event.playerId, reason: "ROLL_7" };
      break;
    case "DISCARD_REQUIRED": {
      const activeDiscarder = nextPendingDiscardPlayer(event.pending, {});
      next.phase = {
        type: "DISCARDING",
        activePlayerId: activeDiscarder ?? event.rollerId,
        rollerId: event.rollerId,
        pending: event.pending,
        submitted: {},
      };
      break;
    }
    case "RESOURCES_DISCARDED": {
      next.players[event.playerId]!.resources = subtractResources(next.players[event.playerId]!.resources, event.resources);
      if (next.phase.type === "DISCARDING") {
        const submitted = { ...next.phase.submitted, [event.playerId]: event.resources };
        const activeDiscarder = nextPendingDiscardPlayer(next.phase.pending, submitted);
        next.phase = activeDiscarder
          ? { ...next.phase, activePlayerId: activeDiscarder, submitted }
          : { type: "MOVING_THIEF", activePlayerId: next.phase.rollerId, rollerId: next.phase.rollerId, reason: "ROLL_7" };
      }
      break;
    }
    case "THIEF_MOVED":
      next.thiefHexId = event.toHexId;
      if (event.stealFromPlayerId && event.stolenResource) {
        next.players[event.stealFromPlayerId]!.resources = subtractResources(next.players[event.stealFromPlayerId]!.resources, resourceBundle(event.stolenResource, 1));
        next.players[event.playerId]!.resources = addResources(next.players[event.playerId]!.resources, resourceBundle(event.stolenResource, 1));
      }
      if (event.reason === "ROLL_7") {
        next.phase = { type: "ACTION_PHASE", activePlayerId: event.playerId };
      }
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
      if (event.cardId && event.cardType) {
        next.players[event.playerId]!.developmentCards = [
          ...(next.players[event.playerId]!.developmentCards ?? []),
          {
            id: event.cardId,
            type: event.cardType,
            ownerId: event.playerId,
            boughtTurn: next.turn,
            ...(event.cardType === "VICTORY_POINT" && next.phase.type === "GAME_OVER" ? { revealed: true } : {}),
          },
        ];
        next.developmentDeckCursor = Math.max(next.developmentDeckCursor, (event.deckIndex ?? next.developmentDeckCursor) + 1);
        next.players[event.playerId]!.specialCards = normalizedCardCount(next.players[event.playerId]!);
      } else {
        next.players[event.playerId]!.specialCards += 1;
      }
      break;
    case "DEVELOPMENT_CARD_PLAYED": {
      const player = next.players[event.playerId]!;
      const card = player.developmentCards.find((candidate) => candidate.id === event.cardId);
      if (card) {
        card.playedTurn = next.turn;
        card.revealed = true;
      }
      player.playedDevelopmentCardTurn = next.turn;
      if (event.cardType === "KNIGHT") {
        player.playedKnights += 1;
        next.playedKnightCounts[event.playerId] = (next.playedKnightCounts[event.playerId] ?? 0) + 1;
      }
      player.specialCards = normalizedCardCount(player);
      break;
    }
    case "ROAD_BUILDING_PLAYED":
      break;
    case "MONOPOLY_PLAYED": {
      const total = Object.entries(event.collected).reduce((sum, [, count]) => sum + count, 0);
      for (const [playerId, count] of Object.entries(event.collected)) {
        next.players[playerId]!.resources = subtractResources(next.players[playerId]!.resources, resourceBundle(event.resource, count));
      }
      next.players[event.playerId]!.resources = addResources(next.players[event.playerId]!.resources, resourceBundle(event.resource, total));
      break;
    }
    case "YEAR_OF_PLENTY_PLAYED":
      next.players[event.playerId]!.resources = addResources(
        next.players[event.playerId]!.resources,
        event.resources.reduce<ResourceBundle>((bundle, resource) => addResources(bundle, resourceBundle(resource, 1)), emptyResources()),
      );
      break;
    case "LARGEST_ARMY_UPDATED":
      refreshLargestArmy(next);
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
      for (const player of Object.values(next.players)) {
        for (const card of player.developmentCards ?? []) {
          if (card.type === "VICTORY_POINT") card.revealed = true;
        }
        player.specialCards = normalizedCardCount(player);
      }
      next.phase = { type: "GAME_OVER", winnerId: event.winnerId, reason: event.reason };
      break;
  }
  return next;
};

export const assertInvariants = (state: GameState): Result<true, ValidationError> => {
  const boardErrors = validateBoard(state.board);
  if (boardErrors.length > 0) return { ok: false, error: error("INVALID_BOARD", boardErrors.join("; ")) };
  if (state.thiefHexId && !state.board.hexes[state.thiefHexId]) return { ok: false, error: error("INVARIANT_VIOLATION", "thief is on an unknown hex") };
  const seenCards = new Set<DevelopmentCardId>();
  for (const player of Object.values(state.players)) {
    if (!isNonNegativeBundle(player.resources)) return { ok: false, error: error("INVARIANT_VIOLATION", `${player.id} has negative resources`) };
    if (!Number.isInteger(player.specialCards) || player.specialCards < 0) return { ok: false, error: error("INVARIANT_VIOLATION", `${player.id} has invalid special cards`) };
    if (!Array.isArray(player.developmentCards)) return { ok: false, error: error("INVARIANT_VIOLATION", `${player.id} has invalid development cards`) };
    for (const card of player.developmentCards) {
      if (seenCards.has(card.id)) return { ok: false, error: error("INVARIANT_VIOLATION", `duplicate development card ${card.id}`) };
      seenCards.add(card.id);
      if (card.ownerId !== player.id) return { ok: false, error: error("INVARIANT_VIOLATION", `development card ${card.id} owner mismatch`) };
      if (!classicDevelopmentDeck.includes(card.type)) return { ok: false, error: error("INVARIANT_VIOLATION", `development card ${card.id} has invalid type`) };
    }
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
  if (state.phase.type === "DISCARDING") {
    for (const [playerId, count] of Object.entries(state.phase.pending)) {
      if (!state.players[playerId] || count <= 0) return { ok: false, error: error("INVARIANT_VIOLATION", "invalid discard pending entry") };
      const submitted = state.phase.submitted[playerId];
      if (submitted && resourceCount(normalizeExactBundle(submitted)) !== count) return { ok: false, error: error("INVARIANT_VIOLATION", "invalid discard submission") };
    }
  }
  if (state.phase.type === "GAME_OVER" && state.phase.reason !== "TURN_LIMIT" && trueVictoryPoints(state, state.phase.winnerId) < state.config.victoryPoints) {
    return { ok: false, error: error("INVARIANT_VIOLATION", "game over before victory threshold") };
  }
  return { ok: true, value: true };
};

export const getLegalActions = (state: GameState, playerId: PlayerId): LegalAction[] => {
  if (!state.players[playerId] || state.phase.type === "GAME_OVER") return [];
  if (state.phase.type === "DISCARDING") {
    const count = state.phase.pending[playerId] ?? 0;
    return count > 0 && !state.phase.submitted[playerId] ? [{ type: "DISCARD_RESOURCES", count }] : [];
  }
  if (activePlayer(state) !== playerId) return [];
  if (activeCollectingTradeForPlayer(state, playerId)) return [];
  if (state.phase.type === "MOVING_THIEF") return [{ type: "MOVE_THIEF", hexes: validThiefHexes(state) }];
  if (state.phase.type === "SETUP_PLACEMENT") {
    return [{ type: "PLACE_SETUP", vertices: Object.keys(state.board.vertices).filter((vertexId) => canPlaceSettlement(state, vertexId as VertexId, false)) as VertexId[] }];
  }
  const appendDevelopmentCardActions = (actions: LegalAction[]): void => {
    if (!canPlayCardPhase(state) || state.players[playerId]?.playedDevelopmentCardTurn === state.turn) return;
    const knightCards = playableDevelopmentCards(state, playerId, "KNIGHT").map((card) => card.id);
    if (knightCards.length > 0) actions.push({ type: "PLAY_KNIGHT", cardIds: knightCards, hexes: validThiefHexes(state) });
    const roadBuildingCards = playableDevelopmentCards(state, playerId, "ROAD_BUILDING").map((card) => card.id);
    if (roadBuildingCards.length > 0 && countRoads(state, playerId) < maxRoadsPerPlayer) {
      const plan = roadBuildingPlan(state, playerId);
      if (plan.requiredRoadCount === 1 || plan.requiredRoadCount === 2) {
        actions.push({ type: "PLAY_ROAD_BUILDING", cardIds: roadBuildingCards, edges: plan.firstEdges, requiredRoadCount: plan.requiredRoadCount, options: plan.options });
      }
    }
    const monopolyCards = playableDevelopmentCards(state, playerId, "MONOPOLY").map((card) => card.id);
    if (monopolyCards.length > 0) actions.push({ type: "PLAY_MONOPOLY", cardIds: monopolyCards, resources: [...resources] });
    const plentyCards = playableDevelopmentCards(state, playerId, "YEAR_OF_PLENTY").map((card) => card.id);
    if (plentyCards.length > 0) actions.push({ type: "PLAY_YEAR_OF_PLENTY", cardIds: plentyCards, resources: [...resources] });
  };
  if (state.phase.type === "WAITING_FOR_ROLL") {
    const actions: LegalAction[] = [{ type: "ROLL_DICE" }];
    appendDevelopmentCardActions(actions);
    return actions;
  }
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
  if (state.developmentDeckCursor < state.developmentDeck.length && hasResources(state.players[playerId]!.resources, specialCardCost(state.config.rules))) {
    actions.push({ type: "BUY_SPECIAL_CARD", cost: specialCardCost(state.config.rules) });
  }
  appendDevelopmentCardActions(actions);
  return actions;
};
