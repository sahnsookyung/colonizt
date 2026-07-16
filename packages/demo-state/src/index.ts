import {
  applyCommand,
  activeCollectingTradeForPlayer,
  canBuildRoad,
  classicResourceBankSize,
  createGame,
  createBoardForRules,
  deterministicDiscard,
  emptyResources,
  eligibleStealTargets,
  getLegalActions,
  resourceCount,
  resources,
  type EdgeId,
  type BotDifficulty,
  type GameCommand,
  type GameConfig,
  type GameEvent,
  type GameState,
  type BoardGraph,
  type PlayerId,
  type HexId,
  type ResourceBundle,
  type VertexId,
} from "@colonizt/game-core";
import { createBotTradeId, createBotView, evaluateTrade, greedyBot, plannerBot, randomLegalBot, type BotController, type BotProfile } from "@colonizt/bots";

export const demoPlayerIds = ["p1", "p2", "p3", "p4"] as const;

export interface DemoGameOptions {
  playerCount?: number;
  botCount?: number;
  playerIds?: readonly PlayerId[];
  board?: BoardGraph;
  botDifficulty?: BotDifficulty;
  botDifficulties?: Partial<Record<PlayerId, BotDifficulty>>;
  botProfiles?: Partial<Record<PlayerId, BotProfile>>;
  rules?: GameConfig["rules"];
}

const defaultPlayerNames = ["Aster", "Briar", "Cyra", "Dax", "Ember", "Fenn", "Galen", "Hana"];
const defaultPlayerColors = ["#2563eb", "#dc2626", "#16a34a", "#ca8a04", "#7c3aed", "#0891b2", "#db2777", "#65a30d"];

const playerIdsForOptions = (options: DemoGameOptions): PlayerId[] => {
  if (options.playerIds?.length) return [...options.playerIds];
  const count = Math.max(1, Math.floor(options.playerCount ?? (options.botCount !== undefined ? options.botCount + 1 : demoPlayerIds.length)));
  return Array.from({ length: count }, (_, index) => `p${index + 1}` as PlayerId);
};

export const createDemoConfig = (seed = "demo-seed", options: DemoGameOptions = {}): GameConfig => {
  const playerOrder = playerIdsForOptions(options);
  return {
    matchId: `match-${seed}`,
    seed,
    victoryPoints: 10,
    maxPlayers: playerOrder.length,
    turnSeconds: 45,
    playerOrder,
    playerNames: Object.fromEntries(playerOrder.map((playerId, index) => [playerId, defaultPlayerNames[index] ?? `Player ${index + 1}`])),
    playerColors: Object.fromEntries(playerOrder.map((playerId, index) => [playerId, defaultPlayerColors[index] ?? "#64748b"])),
    botDifficulty: options.botDifficulty ?? "medium",
    rules: {
      diceDoubles: false,
      plight: false,
      plightTurn: 20,
      mapRandomized: false,
      specialCardCostRandomized: false,
      ...options.rules,
    },
  };
};

export const createDemoGame = (seed = "demo-seed", options: DemoGameOptions = {}): GameState => {
  const config = createDemoConfig(seed, options);
  const board = options.board ?? createBoardForRules(seed, config.rules);
  return createGame(config, board);
};

export const applyOrThrow = (state: GameState, command: GameCommand): { state: GameState; events: GameEvent[] } => {
  const result = applyCommand(state, command);
  if (!result.ok) {
    throw new Error(`${command.type} failed: ${result.error.code} ${result.error.message}`);
  }
  return { state: result.value.nextState, events: result.value.events };
};

const chooseSetupPlacement = (state: GameState, playerId: PlayerId): { vertexId: VertexId; edgeId: EdgeId } => {
  const action = getLegalActions(state, playerId).find((candidate) => candidate.type === "PLACE_SETUP");
  if (action?.type !== "PLACE_SETUP") throw new Error("No legal setup vertex");
  const scored = action.vertices
    .map((vertexId) => {
      const adjacentResources = new Set(
        (state.board.vertices[vertexId]?.adjacentHexes ?? [])
          .map((hexId) => state.board.hexes[hexId]?.resource)
          .filter((resource): resource is (typeof resources)[number] => Boolean(resource) && resources.includes(resource as (typeof resources)[number])),
      );
      const adjacentTokens = (state.board.vertices[vertexId]?.adjacentHexes ?? [])
        .map((hexId) => state.board.hexes[hexId]?.token)
        .filter((token): token is number => Number.isInteger(token));
      const tokenScore = adjacentTokens.reduce((sum, token) => sum + (7 - Math.abs(7 - token)), 0);
      const hasRoadPair = adjacentResources.has("timber") && adjacentResources.has("brick");
      const hasSettlementPair = adjacentResources.has("grain") && adjacentResources.has("fiber");
      return {
        vertexId,
        score: adjacentResources.size * 10 + tokenScore + (hasRoadPair ? 12 : 0) + (hasSettlementPair ? 8 : 0),
      };
    })
    .sort((left, right) => right.score - left.score || left.vertexId.localeCompare(right.vertexId));
  const vertexId = scored[0]?.vertexId;
  if (!vertexId) throw new Error("No legal setup vertex");
  const edgeId = (state.board.adjacency.vertexToEdges[vertexId] ?? []).find((candidate) => canBuildRoad(state, playerId, candidate as EdgeId, vertexId));
  if (!edgeId) throw new Error("No legal setup edge");
  return { vertexId, edgeId: edgeId as EdgeId };
};

export const withResources = (state: GameState, playerId: PlayerId, bundle: Partial<ResourceBundle>): GameState => {
  const next = structuredClone(state) as GameState;
  next.resourceBank ??= emptyResources();
  const player = next.players[playerId]!;
  for (const resource of resources) {
    if (bundle[resource] === undefined) continue;
    const heldByOthers = Object.values(next.players).reduce((sum, candidate) => (
      candidate.id === playerId ? sum : sum + candidate.resources[resource]
    ), 0);
    const previous = player.resources[resource];
    const requested = Math.max(0, Math.floor(bundle[resource] ?? 0));
    const capped = Math.min(requested, Math.max(0, classicResourceBankSize - heldByOthers));
    player.resources[resource] = capped;
    next.resourceBank[resource] = classicResourceBankSize - heldByOthers - capped;
    if (previous === capped) continue;
  }
  return next;
};

export const completeSetup = (state: GameState): { state: GameState; events: GameEvent[] } => {
  let current = state;
  const events: GameEvent[] = [];
  while (current.phase.type === "SETUP_PLACEMENT") {
    const playerId = current.phase.activePlayerId;
    const placement = chooseSetupPlacement(current, playerId);
    const applied = applyOrThrow(current, { type: "PLACE_SETUP", playerId, ...placement });
    current = applied.state;
    events.push(...applied.events);
  }
  return { state: current, events };
};

export const botControllers: Record<PlayerId, BotController> = {
  p1: greedyBot,
  p2: randomLegalBot,
  p3: plannerBot,
  p4: randomLegalBot,
};

const profileControllers: Record<BotProfile, BotController> = {
  greedy: greedyBot,
  planner: plannerBot,
  random: randomLegalBot,
};

const controllerFor = (playerId: PlayerId, options: DemoGameOptions): BotController => {
  const profile = options.botProfiles?.[playerId];
  return profile ? profileControllers[profile] : botControllers[playerId] ?? randomLegalBot;
};

const difficultyFor = (state: GameState, playerId: PlayerId, options: DemoGameOptions): BotDifficulty =>
  options.botDifficulties?.[playerId] ?? options.botDifficulty ?? state.config.botDifficulty ?? "medium";

const chooseCommand = (state: GameState, playerId: PlayerId, options: DemoGameOptions): GameCommand | undefined => {
  const bot = controllerFor(playerId, options);
  const view = createBotView(state, playerId, bot.profile, difficultyFor(state, playerId, options));
  return bot.chooseCommand(view, (prefix: string) => createBotTradeId(state, playerId, bot.profile) || prefix);
};

export const chooseFallbackCommand = (state: GameState, playerId: PlayerId): GameCommand | undefined => {
  if (state.phase.type === "DISCARDING") {
    const count = state.phase.pending[playerId] ?? 0;
    return count > 0 ? { type: "DISCARD_RESOURCES", playerId, resources: deterministicDiscard(state, playerId, count) } : undefined;
  }
  if (state.phase.type === "MOVING_THIEF") {
    const action = getLegalActions(state, playerId).find((candidate) => candidate.type === "MOVE_THIEF");
    if (action?.type !== "MOVE_THIEF") return undefined;
    const ranked = action.hexes
      .map((hexId) => {
        const targets = eligibleStealTargets(state, playerId, hexId as HexId);
        return {
          hexId: hexId as HexId,
          targets,
          score: targets.reduce((sum, targetId) => sum + resourceCount(state.players[targetId]?.resources ?? emptyResources()) + (state.players[targetId]?.score ?? 0) * 2, 0),
        };
      })
      .sort((left, right) => right.score - left.score || left.hexId.localeCompare(right.hexId));
    const selected = ranked[0];
    if (!selected) return undefined;
    const stealFromPlayerId = selected.targets[0];
    return { type: "MOVE_THIEF", playerId, hexId: selected.hexId, ...(stealFromPlayerId ? { stealFromPlayerId } : {}) };
  }
  const modalTrade = activeCollectingTradeForPlayer(state, playerId);
  if (modalTrade) return { type: "CANCEL_TRADE", playerId, tradeId: modalTrade.id };
  if (state.phase.type === "WAITING_FOR_ROLL") return { type: "ROLL_DICE", playerId };
  if (state.phase.type === "ACTION_PHASE") return { type: "END_TURN", playerId };
  return undefined;
};

export const playBotGame = (seed = "bot-game", maxCommands = 300, options: DemoGameOptions = {}): { state: GameState; events: GameEvent[]; invalidCommands: number } => {
  let current = createDemoGame(seed, options);
  const events: GameEvent[] = [];
  let invalidCommands = 0;

  for (let step = 0; step < maxCommands && current.phase.type !== "GAME_OVER"; step += 1) {
    if (!("activePlayerId" in current.phase)) break;
    let command = chooseCommand(current, current.phase.activePlayerId, options) ?? chooseFallbackCommand(current, current.phase.activePlayerId);
    if (!command) break;
    if (command.type === "PLACE_SETUP") {
      const setupCommand = command;
      const edgeId = current.board.adjacency.vertexToEdges[setupCommand.vertexId]?.find((candidate) => canBuildRoad(current, setupCommand.playerId, candidate as EdgeId, setupCommand.vertexId));
      if (edgeId) command = { ...setupCommand, edgeId: edgeId as EdgeId };
    }
    const result = applyCommand(current, command);
    if (!result.ok) {
      invalidCommands += 1;
      const active = "activePlayerId" in current.phase ? current.phase.activePlayerId : current.playerOrder[0]!;
      const fallback = chooseFallbackCommand(current, active);
      if (!fallback) break;
      const fallbackResult = applyCommand(current, fallback);
      if (!fallbackResult.ok) break;
      current = fallbackResult.value.nextState;
      events.push(...fallbackResult.value.events);
      continue;
    }
    current = result.value.nextState;
    events.push(...result.value.events);

    if (command.type === "OFFER_TRADE") {
      for (const recipient of current.playerOrder.filter((candidate) => candidate !== command.playerId)) {
        const bot = controllerFor(recipient, options);
        const difficulty = difficultyFor(current, recipient, options);
        const view = createBotView(current, recipient, bot.profile, difficulty);
        const trade = current.trades[command.tradeId];
        if (!trade || evaluateTrade(view, trade, view.profile ?? "greedy", difficulty) !== "ACCEPT") continue;
        const responded = applyCommand(current, { type: "RESPOND_TRADE", playerId: recipient, tradeId: command.tradeId, response: "WANTS_ACCEPT" });
        if (!responded.ok) continue;
        current = responded.value.nextState;
        events.push(...responded.value.events);
      }
      const trade = current.trades[command.tradeId];
      const selected = trade
        ? current.playerOrder.find((playerId) => playerId !== command.playerId && trade.responses?.[playerId]?.status === "WANTS_ACCEPT")
        : undefined;
      const resolution: GameCommand = selected
        ? { type: "FINALIZE_TRADE", playerId: command.playerId, tradeId: command.tradeId, toPlayerId: selected }
        : { type: "CANCEL_TRADE", playerId: command.playerId, tradeId: command.tradeId };
      const finalized = applyCommand(current, resolution);
      if (finalized.ok) {
        current = finalized.value.nextState;
        events.push(...finalized.value.events);
      }
    }
  }
  return { state: current, events, invalidCommands };
};

export { greedyBot, plannerBot, randomLegalBot, type BotController };
