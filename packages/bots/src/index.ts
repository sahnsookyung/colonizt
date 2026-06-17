import {
  addResources,
  applyEvents,
  canBuildRoad,
  cityCost,
  emptyResources,
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
  type EdgeId,
  type BotDifficulty,
  type GameCommand,
  type GameState,
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

const defaultIdFactory: BotIdFactory = (prefix) => `${prefix}-trade`;

export const createBotTradeId = (state: GameState, playerId: PlayerId, profile: BotProfile): string =>
  `bot-trade-${state.config.matchId}-${state.eventSeq + 1}-${playerId}-${profile}`;

const viewerToBotState = (viewer: ViewerState, seed: string, difficulty: BotDifficulty, rules: GameState["config"]["rules"]): GameState => ({
  schemaVersion: 2,
  config: {
    matchId: `bot-view-${seed}`,
    seed,
    victoryPoints: 10,
    maxPlayers: viewer.playerOrder.length,
    turnSeconds: 45,
    playerOrder: viewer.playerOrder,
    playerNames: Object.fromEntries(viewer.players.map((player) => [player.id, player.name])),
    playerColors: Object.fromEntries(viewer.players.map((player) => [player.id, player.color])),
    botDifficulty: difficulty,
    rules,
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
        longestRoadLength: player.longestRoadLength,
        hasLongestRoad: player.hasLongestRoad,
      },
  ])),
  playerOrder: viewer.playerOrder,
  phase: viewer.phase,
  turn: viewer.turn,
  roads: viewer.roads,
  settlements: viewer.settlements,
  buildings: viewer.buildings,
  trades: Object.fromEntries(viewer.trades.map((trade) => [trade.id, trade])),
  eventSeq: viewer.eventSeq,
  rng: { seed, index: 0, policy: "SEEDED_DETERMINISTIC" },
  ...(viewer.lastRoll ? { lastRoll: viewer.lastRoll } : {}),
  ...(viewer.longestRoadOwner ? { longestRoadOwner: viewer.longestRoadOwner } : {}),
});

export const createBotView = (state: GameState, botId: PlayerId, profile?: BotProfile, difficulty: BotDifficulty = state.config.botDifficulty ?? "medium"): BotView => {
  const viewer = serializeForViewer(state, botId);
  const botState = viewerToBotState(viewer, state.config.seed, difficulty, state.config.rules);
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
  const specialReady = hasResources(hypotheticalHand, specialCost) ? 0.52 : Math.max(0, 0.34 - bundleShortfall(hypotheticalHand, specialCost) * 0.08);
  const diversity = resources.filter((resource) => hypotheticalHand[resource] > 0).length / resources.length;
  const production = productionResources(state, view.botId);
  const unproducedCoverage = resources.filter((resource) => hypotheticalHand[resource] > 0 && !production.has(resource)).length * 0.08;
  const handWasteRisk = Math.max(0, resourceCount(hypotheticalHand) - 7) * 0.05;
  const portAccessValue = Object.values(state.board.ports ?? {}).some((port) =>
    port.vertexIds.some((vertexId) => state.settlements[vertexId] === view.botId),
  ) ? 0.25 : 0;
  const roadPotential = Math.max(0, player.longestRoadLength - 3) * 0.08 + (player.hasLongestRoad ? 2 : 0);
  return player.score + player.specialCards * 0.18 + 0.3 * productionEV + roadReady + settlementReady + cityReady + specialReady + 0.2 * diversity + unproducedCoverage + portAccessValue + roadPotential - handWasteRisk;
};

const marginalValue = (view: BotView, resource: Resource): number =>
  evaluateState(view, addResources(view.ownResources, { [resource]: 1 }));

const commandAfterUtility = (view: BotView, command: GameCommand): number => {
  const result = applyEvents(view.state, []);
  const cloned = structuredClone(result) as GameState;
  const player = cloned.players[view.botId];
  if (!player) return Number.NEGATIVE_INFINITY;
  switch (command.type) {
    case "BUILD_ROAD":
      player.resources = subtractResources(player.resources, roadCost());
      cloned.roads[command.edgeId] = view.botId;
      return evaluateState(createBotView(cloned, view.botId, view.profile), player.resources) + 0.05;
    case "BUILD_SETTLEMENT":
      player.resources = subtractResources(player.resources, settlementCost());
      cloned.settlements[command.vertexId] = view.botId;
      cloned.buildings[command.vertexId] = { owner: view.botId, type: "settlement" };
      player.score += 1;
      return evaluateState(createBotView(cloned, view.botId, view.profile), player.resources);
    case "UPGRADE_CITY":
      player.resources = subtractResources(player.resources, cityCost());
      cloned.buildings[command.vertexId] = { owner: view.botId, type: "city" };
      player.score += 1;
      return evaluateState(createBotView(cloned, view.botId, view.profile), player.resources);
    case "BUY_SPECIAL_CARD":
      player.resources = subtractResources(player.resources, specialCardCost(cloned.config.rules));
      player.specialCards += 1;
      return evaluateState(createBotView(cloned, view.botId, view.profile), player.resources) + 0.06;
    default:
      return evaluateState(view);
  }
};

const tradeDifficulty = (difficulty: BotDifficulty = "medium") => {
  switch (difficulty) {
    case "easy":
      return { thresholdMultiplier: 0.72, temperamentSwing: 0.2, unfavorableSlack: 0.04, offerChance: 0.72 };
    case "hard":
      return { thresholdMultiplier: 1.35, temperamentSwing: 0.08, unfavorableSlack: -0.02, offerChance: 0.52 };
    case "medium":
      return { thresholdMultiplier: 1, temperamentSwing: 0.13, unfavorableSlack: 0, offerChance: 0.62 };
  }
};

const tradeTemperament = (view: BotView, salt: string): number =>
  randomFloatAt(`${view.state.config.seed}:${view.state.config.matchId}:turn-${view.state.turn}:${view.botId}:${salt}`, 0);

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
  const actions = view.legalActions;
  const commands: GameCommand[] = [];
  for (const action of actions) {
    if (action.type === "UPGRADE_CITY") commands.push(...action.vertices.map((vertexId) => ({ type: "UPGRADE_CITY" as const, playerId: view.botId, vertexId })));
    if (action.type === "BUILD_SETTLEMENT") commands.push(...action.vertices.map((vertexId) => ({ type: "BUILD_SETTLEMENT" as const, playerId: view.botId, vertexId })));
    if (action.type === "BUILD_ROAD") commands.push(...action.edges.map((edgeId) => ({ type: "BUILD_ROAD" as const, playerId: view.botId, edgeId })));
    if (action.type === "BUY_SPECIAL_CARD") commands.push({ type: "BUY_SPECIAL_CARD", playerId: view.botId });
  }
  const current = evaluateState(view);
  const best = commands
    .map((command) => ({ command, score: commandAfterUtility(view, command) - current }))
    .sort((left, right) => right.score - left.score)[0];
  if (best && (best.score > 0.02 || profile !== "random")) return best.command;
  if (profile !== "random") {
    const offer = chooseTradeOffer(view, idFactory, profile);
    if (offer) return offer;
  }
  return { type: "END_TURN", playerId: view.botId };
};

export const chooseBotCommand = (view: BotView, profile: BotProfile = view.profile ?? "greedy", idFactory: BotIdFactory = defaultIdFactory): GameCommand | undefined => {
  if (view.state.phase.type === "SETUP_PLACEMENT") {
    const placement = chooseSetupPlacement(view);
    return placement ? { type: "PLACE_SETUP", playerId: view.botId, ...placement } : undefined;
  }
  if (view.state.phase.type === "WAITING_FOR_ROLL") return { type: "ROLL_DICE", playerId: view.botId };
  if (view.state.phase.type !== "ACTION_PHASE") return undefined;
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
