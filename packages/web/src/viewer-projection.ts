import {
  applyEvents,
  classicDevelopmentDeck,
  emptyResources,
  resourceCount,
  schemaVersion,
  serializeForViewer,
  type GameConfig,
  type GameEvent,
  type GameState,
  type PlayerId,
  type ViewerState,
} from "@colonizt/game-core";
import { defaultMatchOptions } from "./match-options.js";

declare const projectedGameStateBrand: unique symbol;

/**
 * UI-only state reconstructed from a viewer-safe payload. Opponent resources and
 * hidden development-card details remain redacted, so this must never become an
 * authoritative game source.
 */
export type ProjectedGameState = GameState & {
  readonly [projectedGameStateBrand]: "viewer-safe-projection";
};

export type ViewerProjectionOverrides = Partial<Pick<GameConfig, "botDifficulty" | "rules">>;

export const projectViewerToGameState = (
  viewer: ViewerState,
  seed: string,
  configOverrides: ViewerProjectionOverrides = {},
): ProjectedGameState => {
  const deckRemaining = Math.max(0, Math.min(classicDevelopmentDeck.length, viewer.developmentDeckRemaining ?? classicDevelopmentDeck.length));
  const state: GameState = {
    schemaVersion,
    config: {
      matchId: `client-${seed}`,
      seed,
      victoryPoints: viewer.config.victoryPoints,
      maxPlayers: viewer.config.maxPlayers,
      turnSeconds: viewer.config.turnSeconds,
      playerOrder: viewer.config.playerOrder,
      playerNames: viewer.config.playerNames,
      playerColors: viewer.config.playerColors,
      botDifficulty: configOverrides.botDifficulty ?? viewer.config.botDifficulty ?? defaultMatchOptions.botDifficulty,
      rules: {
        ...defaultMatchOptions.rules,
        ...viewer.config.rules,
        ...configOverrides.rules,
      },
    },
    board: viewer.board,
    players: Object.fromEntries(viewer.players.map((player) => [
      player.id,
      {
        id: player.id,
        name: player.name,
        color: player.color,
        score: player.publicVictoryPoints ?? player.score,
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
    resourceBank: viewer.resourceBank,
    phase: viewer.phase,
    turn: viewer.turn,
    roads: viewer.roads,
    settlements: viewer.settlements,
    buildings: viewer.buildings,
    developmentDeck: [...classicDevelopmentDeck],
    developmentDeckCursor: classicDevelopmentDeck.length - deckRemaining,
    playedKnightCounts: Object.fromEntries(viewer.players.map((player) => [player.id, player.playedKnights])),
    trades: Object.fromEntries(viewer.trades.map((trade) => [trade.id, trade])),
    eventSeq: viewer.eventSeq,
    rng: { seed, index: 0, policy: "SEEDED_DETERMINISTIC" },
  };
  if (viewer.lastRoll) state.lastRoll = viewer.lastRoll;
  if (viewer.longestRoadOwner) state.longestRoadOwner = viewer.longestRoadOwner;
  if (viewer.largestArmyOwner) state.largestArmyOwner = viewer.largestArmyOwner;
  if (viewer.thiefHexId) state.thiefHexId = viewer.thiefHexId;
  return state as ProjectedGameState;
};

const updateHiddenResourceCount = (count: number, event: GameEvent, playerId: PlayerId): number => {
  switch (event.type) {
    case "ROAD_BUILT":
      return event.playerId === playerId ? Math.max(0, count - resourceCount(event.cost)) : count;
    case "SETTLEMENT_BUILT":
      return event.playerId === playerId ? Math.max(0, count - resourceCount(event.cost)) : count;
    case "CITY_UPGRADED":
      return event.playerId === playerId ? Math.max(0, count - resourceCount(event.cost)) : count;
    case "SPECIAL_CARD_BOUGHT":
      return event.playerId === playerId ? Math.max(0, count - resourceCount(event.cost)) : count;
    case "RESOURCES_DISCARDED":
      return event.playerId === playerId ? Math.max(0, count - resourceCount(event.resources)) : count;
    case "THIEF_MOVED":
      if (!event.stolenResource) return count;
      if (event.playerId === playerId) return count + 1;
      if (event.stealFromPlayerId === playerId) return Math.max(0, count - 1);
      return count;
    case "MONOPOLY_PLAYED":
      if (event.playerId === playerId) return count + Object.values(event.collected).reduce((sum, value) => sum + value, 0);
      return Math.max(0, count - (event.collected[playerId] ?? 0));
    case "YEAR_OF_PLENTY_PLAYED":
      return event.playerId === playerId ? count + 2 : count;
    case "MARITIME_TRADED":
      return event.playerId === playerId ? Math.max(0, count - event.ratio + 1) : count;
    case "RESOURCES_PRODUCED":
      return count + resourceCount({ ...emptyResources(), ...event.gains[playerId] });
    case "TRADE_ACCEPTED":
      if (event.fromPlayerId === playerId) return Math.max(0, count - resourceCount(event.offered) + resourceCount(event.requested));
      if (event.toPlayerId === playerId) return Math.max(0, count + resourceCount(event.offered) - resourceCount(event.requested));
      return count;
    default:
      return count;
  }
};

export const applyEventsToViewerProjection = (
  viewer: ViewerState,
  events: readonly GameEvent[],
  seed: string,
  viewerId: PlayerId | "spectator",
  configOverrides: ViewerProjectionOverrides = {},
): ViewerState => {
  const projected = serializeForViewer(applyEvents(projectViewerToGameState(viewer, seed, configOverrides), events), viewerId);
  return {
    ...projected,
    resourceBank: viewer.resourceBank ?? projected.resourceBank,
    players: projected.players.map((player) => {
      if (player.resources) return player;
      const previous = viewer.players.find((candidate) => candidate.id === player.id);
      const hiddenResourceCount = events.reduce((count, event) => updateHiddenResourceCount(count, event, player.id), previous?.resourceCount ?? player.resourceCount);
      return { ...player, resourceCount: hiddenResourceCount };
    }),
  };
};
