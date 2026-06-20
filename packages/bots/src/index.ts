import {
  addResources,
  applyCommand,
  canPlaceSettlement,
  canBuildRoad,
  cityCost,
  classicDevelopmentDeck,
  deterministicDiscard,
  emptyResources,
  eligibleStealTargets,
  getLegalActions,
  hasResources,
  maritimeTradeRatio,
  randomFloatAt,
  resourceCount,
  resources,
  roadCost,
  serializeForViewer,
  settlementCost,
  specialCardCost,
  subtractResources,
  trueVictoryPoints,
  type EdgeId,
  type BotDifficulty,
  type DevelopmentCard,
  type DevelopmentCardType,
  type GameCommand,
  type GameState,
  type HexId,
  type LegalAction,
  type PlayerId,
  type Resource,
  type ResourceBundle,
  type TradeOffer,
  type VertexId,
  type ViewerState,
} from "@colonizt/game-core";

export type BotProfile = "random" | "greedy" | "planner";
export type TradeDecision = "ACCEPT" | "IGNORE";
export type BotIdFactory = (prefix: string) => string;

export interface BotView {
  botId: PlayerId;
  state: GameState;
  viewer: ViewerState;
  ownResources: ResourceBundle;
  legalActions: LegalAction[];
  publicTrades: TradeOffer[];
  profile?: BotProfile;
  difficulty?: BotDifficulty;
}

export interface BotController {
  name: string;
  profile: BotProfile;
  chooseCommand(view: BotView, idFactory?: BotIdFactory): GameCommand | undefined;
}

export interface BotCandidateScore {
  command: GameCommand;
  score: number;
  weight: number;
  probability: number;
}

const defaultIdFactory: BotIdFactory = (prefix) => `${prefix}-trade`;

export const createBotTradeId = (state: GameState, playerId: PlayerId, profile: BotProfile): string =>
  `bot-trade-${state.config.matchId}-${state.eventSeq + 1}-${playerId}-${profile}`;

const developmentCardPriority: DevelopmentCardType[] = ["KNIGHT", "VICTORY_POINT", "ROAD_BUILDING", "MONOPOLY", "YEAR_OF_PLENTY"];

const estimatedDevelopmentDeckForBot = (state: GameState, botId: PlayerId): DevelopmentCardType[] => {
  const counts = classicDevelopmentDeck.reduce<Record<DevelopmentCardType, number>>((next, cardType) => {
    next[cardType] += 1;
    return next;
  }, { KNIGHT: 0, ROAD_BUILDING: 0, MONOPOLY: 0, YEAR_OF_PLENTY: 0, VICTORY_POINT: 0 });

  const subtractKnown = (cardType: DevelopmentCardType, count = 1): void => {
    counts[cardType] = Math.max(0, counts[cardType] - count);
  };

  for (const playerId of state.playerOrder) {
    const player = state.players[playerId];
    if (!player) continue;
    if (playerId === botId) {
      for (const card of player.developmentCards ?? []) subtractKnown(card.type);
    } else {
      subtractKnown("KNIGHT", player.playedKnights ?? 0);
    }
  }

  const remainingCount = Math.max(0, state.developmentDeck.length - state.developmentDeckCursor);
  const estimatedRemaining: DevelopmentCardType[] = [];
  while (estimatedRemaining.length < remainingCount && developmentCardPriority.some((cardType) => counts[cardType] > 0)) {
    for (const cardType of developmentCardPriority) {
      if (counts[cardType] <= 0 || estimatedRemaining.length >= remainingCount) continue;
      estimatedRemaining.push(cardType);
      counts[cardType] -= 1;
    }
  }
  while (estimatedRemaining.length < remainingCount) {
    estimatedRemaining.push(developmentCardPriority[estimatedRemaining.length % developmentCardPriority.length] ?? "KNIGHT");
  }
  return [
    ...Array.from({ length: state.developmentDeckCursor }, () => "KNIGHT" as const),
    ...estimatedRemaining,
  ];
};

const bundleKey = (bundle: ResourceBundle): string =>
  resources.map((resource) => `${resource}:${bundle[resource] ?? 0}`).join(",");

export const botStateFingerprint = (state: GameState, botId: PlayerId): string => {
  const playerKeys = state.playerOrder.map((playerId) => {
    const player = state.players[playerId];
    if (!player) return `${playerId}:missing`;
    return [
      playerId,
      `score:${player.score}`,
      `true:${trueVictoryPoints(state, playerId)}`,
      `resources:${playerId === botId ? bundleKey(player.resources) : resourceCount(player.resources)}`,
      `cards:${player.specialCards}`,
      `knights:${player.playedKnights}`,
      `road:${player.longestRoadLength}`,
      `lr:${player.hasLongestRoad ? 1 : 0}`,
      `la:${player.hasLargestArmy ? 1 : 0}`,
      `ownCards:${playerId === botId ? (player.developmentCards ?? []).map((card) => `${card.type}:${card.boughtTurn}:${card.playedTurn ?? "-"}`).join(",") : ""}`,
    ].join(";");
  }).join("|");
  const roadKey = Object.entries(state.roads).sort(([left], [right]) => left.localeCompare(right)).map(([edgeId, playerId]) => `${edgeId}:${playerId}`).join(",");
  const buildingKey = Object.entries(state.buildings).sort(([left], [right]) => left.localeCompare(right)).map(([vertexId, building]) => `${vertexId}:${building.owner}:${building.type}`).join(",");
  const tradeKey = Object.values(state.trades).sort((left, right) => left.id.localeCompare(right.id)).map((trade) => `${trade.id}:${trade.status}:${trade.fromPlayerId}:${bundleKey(trade.offered)}>${bundleKey(trade.requested)}`).join("|");
  return [
    `turn:${state.turn}`,
    `seq:${state.eventSeq}`,
    `phase:${JSON.stringify(state.phase)}`,
    `bot:${botId}`,
    `players:${playerKeys}`,
    `roads:${roadKey}`,
    `buildings:${buildingKey}`,
    `trades:${tradeKey}`,
    `deck:${state.developmentDeckCursor}/${state.developmentDeck.length}`,
    `thief:${state.thiefHexId ?? "-"}`,
  ].join("||");
};

const viewerToBotState = (viewer: ViewerState, seed: string, difficulty: BotDifficulty, rules: GameState["config"]["rules"]): GameState => ({
  schemaVersion: 3,
  config: {
    matchId: `bot-view-${seed}`,
    seed,
    victoryPoints: viewer.config.victoryPoints,
    maxPlayers: viewer.config.maxPlayers,
    turnSeconds: viewer.config.turnSeconds,
    playerOrder: viewer.config.playerOrder,
    playerNames: viewer.config.playerNames,
    playerColors: viewer.config.playerColors,
    botDifficulty: difficulty ?? viewer.config.botDifficulty,
    rules: {
      ...viewer.config.rules,
      ...rules,
    },
  },
  board: viewer.board,
  players: Object.fromEntries(viewer.players.map((player) => [
    player.id,
      {
        id: player.id,
        name: player.name,
        color: player.color,
        score: player.score,
        resources: player.resources ?? emptyResources(),
        specialCards: player.specialCards,
        developmentCards: player.developmentCards ?? [],
        longestRoadLength: player.longestRoadLength,
        hasLongestRoad: player.hasLongestRoad,
        playedKnights: player.playedKnights,
        hasLargestArmy: player.hasLargestArmy,
        ...(player.playedDevelopmentCardTurn !== undefined ? { playedDevelopmentCardTurn: player.playedDevelopmentCardTurn } : {}),
      },
  ])),
  playerOrder: viewer.playerOrder,
  phase: viewer.phase,
  turn: viewer.turn,
  roads: viewer.roads,
  settlements: viewer.settlements,
  buildings: viewer.buildings,
  developmentDeck: [],
  developmentDeckCursor: 0,
  playedKnightCounts: Object.fromEntries(viewer.players.map((player) => [player.id, player.playedKnights])),
  trades: Object.fromEntries(viewer.trades.map((trade) => [trade.id, trade])),
  eventSeq: viewer.eventSeq,
  rng: { seed, index: 0, policy: "SEEDED_DETERMINISTIC" },
  ...(viewer.lastRoll ? { lastRoll: viewer.lastRoll } : {}),
  ...(viewer.longestRoadOwner ? { longestRoadOwner: viewer.longestRoadOwner } : {}),
  ...(viewer.largestArmyOwner ? { largestArmyOwner: viewer.largestArmyOwner } : {}),
  ...(viewer.thiefHexId ? { thiefHexId: viewer.thiefHexId } : {}),
});

export const createBotView = (state: GameState, botId: PlayerId, profile?: BotProfile, difficulty: BotDifficulty = state.config.botDifficulty ?? "medium"): BotView => {
  const viewer = serializeForViewer(state, botId);
  const botState = viewerToBotState(viewer, state.config.seed, difficulty, state.config.rules);
  botState.developmentDeck = estimatedDevelopmentDeckForBot(state, botId);
  botState.developmentDeckCursor = state.developmentDeckCursor;
  return {
    botId,
    state: botState,
    viewer,
    ownResources: botState.players[botId]?.resources ?? emptyResources(),
    legalActions: getLegalActions(botState, botId),
    publicTrades: viewer.trades,
    ...(profile ? { profile } : {}),
    difficulty,
  };
};

const pipWeight = (token: number | undefined): number => {
  if (!token || token === 7) return 0;
  return 6 - Math.abs(7 - token);
};

const bundleShortfall = (hand: ResourceBundle, cost: ResourceBundle): number =>
  resources.reduce((sum, resource) => sum + Math.max(0, cost[resource] - hand[resource]), 0);

const bundleSurplus = (hand: ResourceBundle, cost: ResourceBundle, resource: Resource): number =>
  Math.max(0, hand[resource] - Math.max(cost[resource], 1));

const vertexProductionValue = (state: GameState, vertexId: VertexId, hand = emptyResources()): number => {
  const weights = resourceNeedWeights(hand);
  return (state.board.vertices[vertexId]?.adjacentHexes ?? []).reduce((sum, hexId) => {
    const hex = state.board.hexes[hexId];
    if (!hex || hex.resource === "desert") return sum;
    return sum + (pipWeight(hex.token) / 36) * weights[hex.resource];
  }, 0);
};

const resourceNeedWeights = (hand: ResourceBundle): Record<Resource, number> => {
  const costs = [roadCost(), settlementCost(), cityCost(), specialCardCost()];
  return Object.fromEntries(resources.map((resource) => {
    const pressure = costs.reduce((sum, cost) => sum + Math.max(0, cost[resource] - hand[resource]), 0);
    return [resource, 1 + pressure * 0.35];
  })) as Record<Resource, number>;
};

const productionResources = (state: GameState, playerId: PlayerId): Set<Resource> => {
  const produced = new Set<Resource>();
  for (const [vertexId, building] of Object.entries(state.buildings)) {
    if (building.owner !== playerId) continue;
    for (const hexId of state.board.vertices[vertexId as VertexId]?.adjacentHexes ?? []) {
      const resource = state.board.hexes[hexId]?.resource;
      if (resource && resource !== "desert") produced.add(resource);
    }
  }
  return produced;
};

const objectiveShortfall = (hand: ResourceBundle): Record<Resource, number> => {
  const costs = [roadCost(), settlementCost(), cityCost(), specialCardCost()];
  return Object.fromEntries(resources.map((resource) => [
    resource,
    Math.max(...costs.map((cost) => Math.max(0, cost[resource] - hand[resource]))),
  ])) as Record<Resource, number>;
};

const chooseSetupPlacement = (view: BotView): { vertexId: VertexId; edgeId: EdgeId } | undefined => {
  const action = view.legalActions.find((candidate) => candidate.type === "PLACE_SETUP");
  if (action?.type !== "PLACE_SETUP") return undefined;
  const scored = action.vertices
    .map((vertexId) => {
      const adjacentResources = new Set(
        (view.state.board.vertices[vertexId]?.adjacentHexes ?? [])
          .map((hexId) => view.state.board.hexes[hexId]?.resource)
          .filter((resource): resource is Resource => Boolean(resource) && resources.includes(resource as Resource)),
      );
      const tokenScore = (view.state.board.vertices[vertexId]?.adjacentHexes ?? [])
        .map((hexId) => view.state.board.hexes[hexId]?.token)
        .reduce<number>((sum, token) => sum + pipWeight(token), 0);
      const hasRoadPair = adjacentResources.has("timber") && adjacentResources.has("brick");
      const hasSettlementPair = adjacentResources.has("grain") && adjacentResources.has("fiber");
      const edgeId = (view.state.board.adjacency.vertexToEdges[vertexId] ?? []).find((candidate) => canBuildRoad(view.state, view.botId, candidate, vertexId));
      return {
        vertexId,
        edgeId,
        score: adjacentResources.size * 10 + tokenScore + (hasRoadPair ? 12 : 0) + (hasSettlementPair ? 8 : 0),
      };
    })
    .filter((candidate): candidate is { vertexId: VertexId; edgeId: EdgeId; score: number } => Boolean(candidate.edgeId))
    .sort((left, right) => right.score - left.score || left.vertexId.localeCompare(right.vertexId));
  return scored[0];
};

export const evaluateState = (view: BotView, hypotheticalHand = view.ownResources): number => {
  const state = view.state;
  const player = state.players[view.botId];
  if (!player) return Number.NEGATIVE_INFINITY;
  const trueVp = trueVictoryPoints(state, view.botId);
  const leaderVp = Math.max(...state.playerOrder.filter((id) => id !== view.botId).map((id) => trueVictoryPoints(state, id)), 0);
  const pointsToWin = Math.max(0, state.config.victoryPoints - trueVp);

  const productionEV = Object.entries(state.buildings).reduce((sum, [vertexId, building]) => {
    if (building.owner !== view.botId) return sum;
    return sum + vertexProductionValue(state, vertexId as VertexId, hypotheticalHand) * (building.type === "city" ? 2 : 1);
  }, 0);

  const roadReady = hasResources(hypotheticalHand, roadCost()) ? 0.35 : Math.max(0, 0.25 - bundleShortfall(hypotheticalHand, roadCost()) * 0.08);
  const settlementAction = getLegalActions({ ...state, players: { ...state.players, [view.botId]: { ...player, resources: hypotheticalHand } } }, view.botId)
    .find((action) => action.type === "BUILD_SETTLEMENT");
  const bestVertexEV = settlementAction?.type === "BUILD_SETTLEMENT"
    ? Math.max(0, ...settlementAction.vertices.map((vertexId) => vertexProductionValue(state, vertexId, hypotheticalHand)))
    : 0;
  const settlementReady = hasResources(hypotheticalHand, settlementCost()) ? 1.1 + bestVertexEV : Math.max(0, 0.7 - bundleShortfall(hypotheticalHand, settlementCost()) * 0.12);
  const cityReady = hasResources(hypotheticalHand, cityCost()) ? 1.35 + productionEV * 0.25 : Math.max(0, 0.9 - bundleShortfall(hypotheticalHand, cityCost()) * 0.1);
  const specialCost = specialCardCost(state.config.rules);
  const hasDeckCards = state.developmentDeckCursor < state.developmentDeck.length;
  const specialReady = !hasDeckCards ? 0 : hasResources(hypotheticalHand, specialCost) ? 0.5 : Math.max(0, 0.28 - bundleShortfall(hypotheticalHand, specialCost) * 0.07);
  const diversity = resources.filter((resource) => hypotheticalHand[resource] > 0).length / resources.length;
  const production = productionResources(state, view.botId);
  const unproducedCoverage = resources.filter((resource) => hypotheticalHand[resource] > 0 && !production.has(resource)).length * 0.08;
  const handWasteRisk = Math.max(0, resourceCount(hypotheticalHand) - 7) * 0.05;
  const portAccessValue = Object.values(state.board.ports ?? {}).some((port) =>
    port.vertexIds.some((vertexId) => state.settlements[vertexId] === view.botId),
  ) ? 0.25 : 0;
  const settlementPathPressure = pointsToWin * 0.08 + (settlementAction?.type === "BUILD_SETTLEMENT" ? 0.35 : 0);
  const ownKnights = player.playedKnights ?? 0;
  const bestOpponentKnights = Math.max(...state.playerOrder.filter((id) => id !== view.botId).map((id) => state.players[id]?.playedKnights ?? 0), 0);
  const armyPotential = player.hasLargestArmy
    ? 0.25
    : ownKnights >= 2 && ownKnights + (player.developmentCards ?? []).filter((card) => card.type === "KNIGHT" && !card.playedTurn).length >= 3 && ownKnights >= bestOpponentKnights
      ? 0.75
      : 0;
  const roadPotential = player.hasLongestRoad
    ? 0.25
    : player.longestRoadLength >= 4 && player.longestRoadLength >= Math.max(...state.playerOrder.filter((id) => id !== view.botId).map((id) => state.players[id]?.longestRoadLength ?? 0), 0)
      ? 0.45
      : Math.max(0, player.longestRoadLength - 3) * 0.04;
  const playableCards = (player.developmentCards ?? []).filter((card) => !card.playedTurn && card.boughtTurn !== state.turn);
  const cardEffectValue = playableCards.reduce((sum, card) => {
    if (card.type === "VICTORY_POINT") return sum;
    if (card.type === "KNIGHT") return sum + 0.32 + armyPotential * 0.15;
    if (card.type === "ROAD_BUILDING") return sum + 0.3;
    if (card.type === "MONOPOLY") return sum + 0.28;
    return sum + 0.24;
  }, 0);
  const leaderThreatPenalty = Math.max(0, leaderVp - trueVp) * 0.18;
  return trueVp * 2.45
    + 0.52 * productionEV
    + roadReady
    + settlementReady
    + settlementPathPressure
    + cityReady
    + specialReady
    + 0.2 * diversity
    + unproducedCoverage
    + portAccessValue
    + roadPotential
    + armyPotential
    + cardEffectValue * 0.18
    - leaderThreatPenalty
    - handWasteRisk;
};

const marginalValue = (view: BotView, resource: Resource): number =>
  evaluateState(view, addResources(view.ownResources, { [resource]: 1 }));

const difficultySearch = (difficulty: BotDifficulty = "medium"): { depth: number; topK: number; temperature: number; branchLimit: number; candidateLimit: number } => {
  switch (difficulty) {
    case "easy":
      return { depth: 1, topK: 7, temperature: 2.4, branchLimit: 8, candidateLimit: 24 };
    case "hard":
      return { depth: 3, topK: 4, temperature: 0.45, branchLimit: 5, candidateLimit: 18 };
    case "medium":
      return { depth: 2, topK: 4, temperature: 0.75, branchLimit: 5, candidateLimit: 12 };
  }
};

export const roadOpensSettlementAccess = (state: GameState, playerId: PlayerId, edgeId: EdgeId): boolean => {
  if (!canBuildRoad(state, playerId, edgeId)) return false;
  const before = new Set(
    Object.keys(state.board.vertices).filter((vertexId) => canPlaceSettlement(state, vertexId as VertexId, playerId)),
  );
  const preview = structuredClone(state) as GameState;
  preview.roads[edgeId] = playerId;
  return Object.keys(preview.board.vertices).some((vertexId) =>
    !before.has(vertexId) && canPlaceSettlement(preview, vertexId as VertexId, playerId),
  );
};

const thiefMoveCommand = (state: GameState, playerId: PlayerId, type: "MOVE_THIEF" | "PLAY_KNIGHT", card?: DevelopmentCard): GameCommand | undefined => {
  const hexes = type === "MOVE_THIEF"
    ? getLegalActions(state, playerId).find((action) => action.type === "MOVE_THIEF")?.hexes ?? []
    : getLegalActions(state, playerId).find((action) => action.type === "PLAY_KNIGHT")?.hexes ?? [];
  const ranked = hexes
    .map((hexId) => {
      const targets = eligibleStealTargets(state, playerId, hexId as HexId);
      const adjacentProduction = (state.board.adjacency.hexToVertices[hexId] ?? []).reduce((sum, vertexId) => {
        const owner = state.settlements[vertexId];
        if (!owner || owner === playerId) return sum;
        return sum + (state.players[owner]?.score ?? 0) * 2 + resourceCount(state.players[owner]?.resources ?? emptyResources());
      }, 0);
      return { hexId: hexId as HexId, targets, score: adjacentProduction };
    })
    .sort((left, right) => right.score - left.score || left.hexId.localeCompare(right.hexId));
  const selected = ranked[0];
  if (!selected) return undefined;
  const stealFromPlayerId = selected.targets
    .sort((left, right) =>
      trueVictoryPoints(state, right) - trueVictoryPoints(state, left)
      || resourceCount(state.players[right]?.resources ?? emptyResources()) - resourceCount(state.players[left]?.resources ?? emptyResources())
      || state.playerOrder.indexOf(left) - state.playerOrder.indexOf(right),
    )[0];
  return type === "MOVE_THIEF"
    ? { type: "MOVE_THIEF", playerId, hexId: selected.hexId, ...(stealFromPlayerId ? { stealFromPlayerId } : {}) }
    : card
      ? { type: "PLAY_KNIGHT", playerId, cardId: card.id, hexId: selected.hexId, ...(stealFromPlayerId ? { stealFromPlayerId } : {}) }
      : undefined;
};

const preferredYearOfPlentyResources = (view: BotView): [Resource, Resource] => {
  const wanted = [...resources].sort((left, right) => marginalValue(view, right) - marginalValue(view, left) || left.localeCompare(right));
  return [wanted[0] ?? "grain", wanted[1] ?? wanted[0] ?? "ore"];
};

const commandPriority = (command: GameCommand): number => {
  switch (command.type) {
    case "UPGRADE_CITY":
      return 100;
    case "BUILD_SETTLEMENT":
      return 95;
    case "PLAY_KNIGHT":
    case "PLAY_MONOPOLY":
    case "PLAY_YEAR_OF_PLENTY":
    case "PLAY_ROAD_BUILDING":
      return 88;
    case "MARITIME_TRADE":
      return 76;
    case "BUY_SPECIAL_CARD":
      return 66;
    case "OFFER_TRADE":
      return 56;
    case "BUILD_ROAD":
      return 42;
    case "ROLL_DICE":
    case "DISCARD_RESOURCES":
    case "MOVE_THIEF":
      return 90;
    case "END_TURN":
      return 0;
    default:
      return 20;
  }
};

const generateActionCandidates = (view: BotView, profile: BotProfile, idFactory: BotIdFactory): GameCommand[] => {
  const commands: GameCommand[] = [];
  const state = view.state;
  const player = state.players[view.botId];
  if (!player) return commands;
  if (state.phase.type === "DISCARDING") {
    const count = state.phase.pending[view.botId] ?? 0;
    if (count > 0 && !state.phase.submitted[view.botId]) commands.push({ type: "DISCARD_RESOURCES", playerId: view.botId, resources: deterministicDiscard(state, view.botId, count) });
    return commands;
  }
  if (state.phase.type === "MOVING_THIEF") {
    const move = thiefMoveCommand(state, view.botId, "MOVE_THIEF");
    if (move) commands.push(move);
    return commands;
  }
  for (const action of view.legalActions) {
    if (action.type === "UPGRADE_CITY") commands.push(...action.vertices.map((vertexId) => ({ type: "UPGRADE_CITY" as const, playerId: view.botId, vertexId })));
    if (action.type === "BUILD_SETTLEMENT") commands.push(...action.vertices.map((vertexId) => ({ type: "BUILD_SETTLEMENT" as const, playerId: view.botId, vertexId })));
    if (action.type === "BUILD_ROAD") commands.push(...action.edges.map((edgeId) => ({ type: "BUILD_ROAD" as const, playerId: view.botId, edgeId })));
    if (action.type === "BUY_SPECIAL_CARD") commands.push({ type: "BUY_SPECIAL_CARD", playerId: view.botId });
    if (action.type === "MARITIME_TRADE") commands.push(...action.trades.map((trade) => ({ type: "MARITIME_TRADE" as const, playerId: view.botId, offered: trade.offered, requested: trade.requested })));
    if (action.type === "PLAY_KNIGHT") {
      const card = (player.developmentCards ?? []).find((candidate) => action.cardIds.includes(candidate.id));
      const move = card ? thiefMoveCommand(state, view.botId, "PLAY_KNIGHT", card) : undefined;
      if (move) commands.push(move);
    }
    if (action.type === "PLAY_ROAD_BUILDING") {
      const cardId = action.cardIds[0];
      if (cardId) commands.push(...action.options.map((edgeIds) => ({ type: "PLAY_ROAD_BUILDING" as const, playerId: view.botId, cardId, edgeIds })));
    }
    if (action.type === "PLAY_MONOPOLY") {
      const cardId = action.cardIds[0];
      if (cardId) commands.push(...resources.map((resource) => ({ type: "PLAY_MONOPOLY" as const, playerId: view.botId, cardId, resource })));
    }
    if (action.type === "PLAY_YEAR_OF_PLENTY") {
      const cardId = action.cardIds[0];
      const plenty = preferredYearOfPlentyResources(view);
      if (cardId) commands.push({ type: "PLAY_YEAR_OF_PLENTY", playerId: view.botId, cardId, resources: plenty });
    }
  }
  const offer = profile !== "random" ? chooseTradeOffer(view, idFactory, profile) : undefined;
  if (offer) commands.push(offer);
  if (view.legalActions.some((action) => action.type === "END_TURN")) commands.push({ type: "END_TURN", playerId: view.botId });
  return commands
    .sort((left, right) => commandPriority(right) - commandPriority(left) || left.type.localeCompare(right.type));
};

const commandNudge = (view: BotView, command: GameCommand): number => {
  if (command.type === "BUILD_SETTLEMENT") return 0.7;
  if (command.type === "UPGRADE_CITY") return 0.72;
  if (command.type === "MARITIME_TRADE") return 0.12;
  if (command.type === "BUY_SPECIAL_CARD") return trueVictoryPoints(view.state, view.botId) >= 8 ? 0.28 : 0.08;
  if (command.type === "PLAY_KNIGHT" || command.type === "PLAY_MONOPOLY" || command.type === "PLAY_YEAR_OF_PLENTY") return 0.18;
  if (command.type === "PLAY_ROAD_BUILDING") return 0.14;
  if (command.type === "BUILD_ROAD") {
    return roadOpensSettlementAccess(view.state, view.botId, command.edgeId) || (view.state.players[view.botId]?.longestRoadLength ?? 0) >= 4 ? 0.08 : -0.25;
  }
  if (command.type === "END_TURN" && resourceCount(view.ownResources) > 10) return -0.35;
  return 0;
};

const commandAfterUtility = (view: BotView, command: GameCommand, depth = 1, cache = new Map<string, number>()): number => {
  const cacheKey = `${botStateFingerprint(view.state, view.botId)}:${JSON.stringify(command)}:${depth}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;
  const preview = applyCommand(structuredClone(view.state) as GameState, command);
  if (!preview.ok) {
    cache.set(cacheKey, Number.NEGATIVE_INFINITY);
    return Number.NEGATIVE_INFINITY;
  }
  const nextView = createBotView(preview.value.nextState, view.botId, view.profile, view.difficulty);
  const immediateScore = evaluateState(nextView);
  let score = immediateScore + commandNudge(view, command);
  if (depth > 1 && preview.value.nextState.phase.type !== "GAME_OVER" && "activePlayerId" in preview.value.nextState.phase && preview.value.nextState.phase.activePlayerId === view.botId) {
    const future = generateActionCandidates(nextView, view.profile ?? "greedy", defaultIdFactory)
      .filter((candidate) => candidate.type !== "END_TURN")
      .slice(0, difficultySearch(view.difficulty).branchLimit)
      .map((candidate) => commandAfterUtility(nextView, candidate, depth - 1, cache));
    if (future.length > 0) score += Math.max(0, Math.max(...future) - immediateScore) * 0.45;
  }
  cache.set(cacheKey, score);
  return score;
};

const rankBotCandidates = (view: BotView, profile: BotProfile, idFactory: BotIdFactory): { candidates: BotCandidateScore[]; selected?: GameCommand } => {
  const search = difficultySearch(view.difficulty ?? view.state.config.botDifficulty ?? "medium");
  const commands = generateActionCandidates(view, profile, idFactory);
  if (commands.length === 0) return { candidates: [] };
  const current = evaluateState(view);
  const cache = new Map<string, number>();
  const candidatePool = search.depth > 1 && commands.length > search.candidateLimit
    ? commands
      .map((command) => ({ command, score: commandAfterUtility(view, command, 1, cache) - current }))
      .filter((candidate) => Number.isFinite(candidate.score))
      .sort((left, right) => right.score - left.score || commandPriority(right.command) - commandPriority(left.command) || left.command.type.localeCompare(right.command.type))
      .slice(0, search.candidateLimit)
      .map((candidate) => candidate.command)
    : commands;
  const scored = candidatePool
    .map((command) => ({ command, score: commandAfterUtility(view, command, search.depth, cache) - current }))
    .filter((candidate) => Number.isFinite(candidate.score))
    .sort((left, right) => right.score - left.score || left.command.type.localeCompare(right.command.type))
    .slice(0, search.topK);
  if (scored.length === 0) return { candidates: [] };
  const maxScore = scored[0]!.score;
  const weights = scored.map((candidate) => Math.exp((candidate.score - maxScore) / Math.max(0.05, search.temperature)));
  const total = weights.reduce((sum, value) => sum + value, 0);
  const candidates = scored.map((candidate, index) => ({
    command: candidate.command,
    score: candidate.score,
    weight: weights[index] ?? 0,
    probability: total > 0 ? (weights[index] ?? 0) / total : 0,
  }));
  const roll = randomFloatAt(`${view.state.config.seed}:bot-decision:${view.state.config.matchId}:${view.state.turn}:${view.state.eventSeq}:${view.botId}`, 0) * total;
  let cursor = 0;
  for (let index = 0; index < candidates.length; index += 1) {
    cursor += weights[index] ?? 0;
    if (roll <= cursor) return { candidates, selected: candidates[index]!.command };
  }
  const selected = candidates[0]?.command;
  return selected ? { candidates, selected } : { candidates };
};

export const scoreBotCandidates = (view: BotView, profile: BotProfile = view.profile ?? "greedy", idFactory: BotIdFactory = defaultIdFactory): BotCandidateScore[] =>
  rankBotCandidates(view, profile, idFactory).candidates;

const tradeDifficulty = (difficulty: BotDifficulty = "medium") => {
  switch (difficulty) {
    case "easy":
      return { thresholdMultiplier: 0.68, temperamentSwing: 0.24, unfavorableSlack: 0.06, offerChance: 0.78 };
    case "hard":
      return { thresholdMultiplier: 1.0, temperamentSwing: 0.07, unfavorableSlack: -0.02, offerChance: 0.72 };
    case "medium":
      return { thresholdMultiplier: 0.92, temperamentSwing: 0.16, unfavorableSlack: 0.01, offerChance: 0.66 };
  }
};

const tradeTemperament = (view: BotView, salt: string): number =>
  randomFloatAt(`${view.state.config.seed}:${view.state.config.matchId}:turn-${view.state.turn}:${view.botId}:${salt}`, 0);

type OfferTradeCommand = Extract<GameCommand, { type: "OFFER_TRADE" }>;

const tradeBundleKey = (bundle: ResourceBundle): string =>
  resources.map((resource) => `${resource}:${bundle[resource] ?? 0}`).join("|");

const tradeRecipientsKey = (recipients: TradeOffer["recipients"] | OfferTradeCommand["recipients"]): string =>
  recipients === "ANY" ? "ANY" : [...recipients].sort().join(",");

export const tradeShapeKey = (trade: Pick<TradeOffer | OfferTradeCommand, "offered" | "requested" | "recipients">): string =>
  `${tradeBundleKey(trade.offered)}>${tradeBundleKey(trade.requested)}@${tradeRecipientsKey(trade.recipients)}`;

export const hasEquivalentBotTradeOffer = (view: BotView, command: OfferTradeCommand): boolean =>
  Object.values(view.state.trades).some((trade) =>
    trade.fromPlayerId === view.botId
    && tradeShapeKey(trade) === tradeShapeKey(command),
  );

export const scoreTradeResponder = (
  state: GameState,
  trade: TradeOffer,
  responderId: PlayerId,
  profile: BotProfile = "greedy",
  difficulty: BotDifficulty = state.config.botDifficulty ?? "medium",
): number => {
  const offererView = createBotView(state, trade.fromPlayerId, profile, difficulty);
  const responderView = createBotView(state, responderId, profile, difficulty);
  const offererBefore = evaluateState(offererView);
  const offererAfterHand = addResources(subtractResources(offererView.ownResources, trade.offered), trade.requested);
  const offererDelta = evaluateState(offererView, offererAfterHand) - offererBefore;
  const responderBefore = evaluateState(responderView);
  const responderAfterHand = addResources(subtractResources(responderView.ownResources, trade.requested), trade.offered);
  const responderDelta = evaluateState(responderView, responderAfterHand) - responderBefore;
  const responderThreat = trueVictoryPoints(state, responderId) * 0.12 + resourceCount(responderView.ownResources) * 0.015;
  return offererDelta * 1.2 - responderDelta * 0.75 - responderThreat;
};

const strategicTradeBonus = (view: BotView, beforeHand: ResourceBundle, afterHand: ResourceBundle, gained: ResourceBundle, paid: ResourceBundle): number => {
  const production = productionResources(view.state, view.botId);
  const beforeShortfall = objectiveShortfall(beforeHand);
  const afterShortfall = objectiveShortfall(afterHand);
  return resources.reduce((score, resource) => {
    const gainedCount = gained[resource] ?? 0;
    const paidCount = paid[resource] ?? 0;
    const missingProductionBonus = gainedCount > 0 && !production.has(resource) ? 0.12 : 0;
    const newResourceBonus = gainedCount > 0 && beforeHand[resource] === 0 ? 0.06 : 0;
    const objectiveBonus = Math.max(0, beforeShortfall[resource] - afterShortfall[resource]) * 0.08;
    const painfulPayment = paidCount > 0 && beforeShortfall[resource] > 0 ? 0.06 * paidCount : 0;
    return score + missingProductionBonus + newResourceBonus + objectiveBonus - painfulPayment;
  }, 0);
};

export const evaluateTrade = (
  view: BotView,
  trade: TradeOffer,
  profile: BotProfile = view.profile ?? "greedy",
  difficulty: BotDifficulty = view.difficulty ?? view.state.config.botDifficulty ?? "medium",
): TradeDecision => {
  if ((trade.status !== "OPEN" && trade.status !== "COLLECTING_RESPONSES") || trade.fromPlayerId === view.botId) return "IGNORE";
  if (trade.recipients !== "ANY" && !trade.recipients.includes(view.botId)) return "IGNORE";
  if (!hasResources(view.ownResources, trade.requested)) return "IGNORE";
  const before = evaluateState(view);
  const afterHand = addResources(subtractResources(view.ownResources, trade.requested), trade.offered);
  const after = evaluateState(view, afterHand);
  const difficultyRules = tradeDifficulty(difficulty);
  const offerer = view.state.players[trade.fromPlayerId];
  const bot = view.state.players[view.botId];
  const leaderPenalty = offerer && bot
    ? (offerer.score - bot.score >= 2 ? 0.25 : 0) + (offerer.score >= 8 ? 0.5 : 0)
    : 0;
  const baseThreshold = profile === "random" ? 0.05 : profile === "planner" ? 0.18 : 0.15;
  const temperament = tradeTemperament(view, `${trade.fromPlayerId}:accept`);
  const willingness = (temperament - 0.5) * difficultyRules.temperamentSwing + difficultyRules.unfavorableSlack;
  const strategic = strategicTradeBonus(view, view.ownResources, afterHand, trade.offered, trade.requested);
  const utility = after - before - leaderPenalty + strategic;
  const threshold = baseThreshold * difficultyRules.thresholdMultiplier - willingness;
  return utility >= threshold ? "ACCEPT" : "IGNORE";
};

const chooseTradeOffer = (view: BotView, idFactory: BotIdFactory, profile: BotProfile): GameCommand | undefined => {
  if (!view.legalActions.some((action) => action.type === "OFFER_TRADE")) return undefined;
  if (Object.values(view.state.trades).some((trade) => trade.fromPlayerId === view.botId && trade.status === "COLLECTING_RESPONSES")) return undefined;
  const difficulty = tradeDifficulty(view.difficulty ?? view.state.config.botDifficulty ?? "medium");
  if (tradeTemperament(view, "offer") > difficulty.offerChance) return undefined;
  const wanted = [...resources].sort((left, right) => marginalValue(view, right) - marginalValue(view, left));
  const offered = [...resources].sort((left, right) => bundleSurplus(view.ownResources, settlementCost(), right) - bundleSurplus(view.ownResources, settlementCost(), left));
  for (const want of wanted) {
    for (const give of offered) {
      if (want === give || view.ownResources[give] <= 1) continue;
      const ratio = maritimeTradeRatio(view.state, view.botId, give);
      const count = view.ownResources[give] >= 3 && ratio > 3 ? 2 : 1;
      if (count >= ratio) continue;
      const command: GameCommand = {
        type: "OFFER_TRADE",
        playerId: view.botId,
        tradeId: idFactory(`${view.botId}-${profile}-${view.state.eventSeq + 1}`),
        offered: { ...emptyResources(), [give]: count },
        requested: { ...emptyResources(), [want]: 1 },
        recipients: "ANY",
        ttlEvents: 10,
      };
      if (hasEquivalentBotTradeOffer(view, command)) continue;
      const before = evaluateState(view);
      const afterHand = addResources(subtractResources(view.ownResources, command.offered), command.requested);
      const after = evaluateState(view, afterHand);
      const strategic = strategicTradeBonus(view, view.ownResources, afterHand, command.requested, command.offered);
      if (after + strategic > before + 0.1 * difficulty.thresholdMultiplier) return command;
    }
  }
  return undefined;
};

const chooseActionCommand = (view: BotView, profile: BotProfile, idFactory: BotIdFactory): GameCommand | undefined => {
  const ranked = rankBotCandidates(view, profile, idFactory);
  if (ranked.candidates.length === 0) return { type: "END_TURN", playerId: view.botId };
  const shouldActThreshold = profile === "random" ? -0.15 : 0.0;
  if (ranked.candidates[0]!.score < shouldActThreshold && view.state.phase.type === "ACTION_PHASE") {
    return { type: "END_TURN", playerId: view.botId };
  }
  return ranked.selected ?? ranked.candidates[0]!.command;
};

export const chooseBotCommand = (view: BotView, profile: BotProfile = view.profile ?? "greedy", idFactory: BotIdFactory = defaultIdFactory): GameCommand | undefined => {
  if (view.state.phase.type === "SETUP_PLACEMENT") {
    const placement = chooseSetupPlacement(view);
    return placement ? { type: "PLACE_SETUP", playerId: view.botId, ...placement } : undefined;
  }
  if (view.state.phase.type === "WAITING_FOR_ROLL") return { type: "ROLL_DICE", playerId: view.botId };
  if (view.state.phase.type !== "ACTION_PHASE" && view.state.phase.type !== "DISCARDING" && view.state.phase.type !== "MOVING_THIEF") return undefined;
  return chooseActionCommand(view, profile, idFactory);
};

const controller = (name: string, profile: BotProfile): BotController => ({
  name,
  profile,
  chooseCommand(view, idFactory) {
    return chooseBotCommand(view, profile, idFactory);
  },
});

export const randomLegalBot = controller("RandomLegalBot", "random");
export const greedyBot = controller("GreedyBot", "greedy");
export const plannerBot = controller("PlannerBot", "planner");
