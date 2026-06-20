import { canViewerSeeTrade, publicVictoryPoints } from "./engine.js";
import { emptyResources, resourceCount } from "./resources.js";
import type { DevelopmentCard, GameEvent, GameState, PlayerId, ResourceBundle, TradeOffer, ViewerPublicConfig } from "./types.js";

export interface SerializedPlayer {
  id: PlayerId;
  name: string;
  color: string;
  score: number;
  specialCards: number;
  developmentCardCount: number;
  developmentCards?: DevelopmentCard[];
  longestRoadLength: number;
  hasLongestRoad: boolean;
  hasLargestArmy: boolean;
  playedKnights: number;
  playedDevelopmentCardTurn?: number;
  resourceCount: number;
  resources?: ResourceBundle;
}

export interface ViewerState {
  schemaVersion: GameState["schemaVersion"];
  viewerId: PlayerId | "spectator";
  config: ViewerPublicConfig;
  board: GameState["board"];
  players: SerializedPlayer[];
  playerOrder: PlayerId[];
  phase: GameState["phase"];
  turn: number;
  roads: GameState["roads"];
  settlements: GameState["settlements"];
  buildings: GameState["buildings"];
  longestRoadOwner: GameState["longestRoadOwner"];
  largestArmyOwner: GameState["largestArmyOwner"];
  thiefHexId: GameState["thiefHexId"];
  trades: TradeOffer[];
  eventSeq: number;
  lastRoll: GameState["lastRoll"];
  developmentDeckRemaining: number;
  tradeResponseDeadlines?: Record<string, number>;
}

const canViewerSeeTradeResources = (trade: TradeOffer, viewerId: PlayerId | "spectator", knownPlayerIds?: readonly PlayerId[]): boolean =>
  canViewerSeeTrade({ playerOrder: knownPlayerIds ? [...knownPlayerIds] : [] }, trade, viewerId);

const withoutResponses = (trade: TradeOffer): TradeOffer => {
  const copy = { ...trade };
  delete copy.responses;
  return copy;
};

const serializeTradeForViewer = (trade: TradeOffer, viewerId: PlayerId | "spectator", knownPlayerIds?: readonly PlayerId[]): TradeOffer => {
  if (canViewerSeeTradeResources(trade, viewerId, knownPlayerIds)) return trade;
  return withoutResponses({ ...trade, offered: emptyResources(), requested: emptyResources() });
};

export const serializeForViewer = (state: GameState, viewerId: PlayerId | "spectator"): ViewerState => ({
  schemaVersion: state.schemaVersion,
  viewerId,
  config: {
    victoryPoints: state.config.victoryPoints,
    maxPlayers: state.config.maxPlayers,
    turnSeconds: state.config.turnSeconds,
    playerOrder: state.config.playerOrder,
    playerNames: state.config.playerNames,
    playerColors: state.config.playerColors,
    ...(state.config.botDifficulty ? { botDifficulty: state.config.botDifficulty } : {}),
    ...(state.config.rules ? { rules: state.config.rules } : {}),
  },
  board: state.board,
  players: state.playerOrder.map((playerId) => {
    const player = state.players[playerId]!;
    return {
      id: player.id,
      name: player.name,
      color: player.color,
      score: publicVictoryPoints(state, player.id),
      specialCards: player.specialCards,
      developmentCardCount: player.developmentCards?.filter((card) => !card.playedTurn).length ?? player.specialCards,
      ...((viewerId === playerId || state.phase.type === "GAME_OVER") ? { developmentCards: player.developmentCards ?? [] } : {}),
      longestRoadLength: player.longestRoadLength,
      hasLongestRoad: player.hasLongestRoad,
      hasLargestArmy: player.hasLargestArmy,
      playedKnights: player.playedKnights,
      ...(player.playedDevelopmentCardTurn !== undefined ? { playedDevelopmentCardTurn: player.playedDevelopmentCardTurn } : {}),
      resourceCount: resourceCount(player.resources),
      ...(viewerId === playerId ? { resources: player.resources } : {}),
    };
  }),
  playerOrder: state.playerOrder,
  phase: state.phase,
  turn: state.turn,
  roads: state.roads,
  settlements: state.settlements,
  buildings: state.buildings,
  longestRoadOwner: state.longestRoadOwner,
  largestArmyOwner: state.largestArmyOwner,
  thiefHexId: state.thiefHexId,
  trades: Object.values(state.trades).map((trade) => serializeTradeForViewer(trade, viewerId, state.playerOrder)),
  eventSeq: state.eventSeq,
  lastRoll: state.lastRoll,
  developmentDeckRemaining: Math.max(0, state.developmentDeck.length - state.developmentDeckCursor),
});

export const serializeEventForViewer = (event: GameEvent, viewerId: PlayerId | "spectator", knownPlayerIds?: readonly PlayerId[], gameOver = false): GameEvent => {
  switch (event.type) {
    case "SETUP_PLACED":
      return viewerId === event.playerId ? event : { ...event, startingResources: {} };
    case "SPECIAL_CARD_BOUGHT":
      return viewerId === event.playerId || gameOver
        ? event
        : {
            schemaVersion: event.schemaVersion,
            seq: event.seq,
            type: event.type,
            playerId: event.playerId,
            cost: event.cost,
            cardIndex: event.cardIndex,
          };
    case "RESOURCES_DISCARDED":
      return viewerId === event.playerId || gameOver ? event : { ...event, resources: emptyResources() };
    case "THIEF_MOVED": {
      const viewerCanSee = gameOver || viewerId === event.playerId || viewerId === event.stealFromPlayerId;
      if (viewerCanSee) return event;
      const redacted = { ...event };
      delete redacted.stolenResource;
      return redacted;
    }
    case "RESOURCES_PRODUCED":
      return {
        ...event,
        gains: Object.fromEntries(
          Object.entries(event.gains).map(([playerId, gains]) => [playerId, viewerId === playerId ? gains : {}]),
        ),
      };
    case "TRADE_OFFERED": {
      return { ...event, trade: serializeTradeForViewer(event.trade, viewerId, knownPlayerIds) };
    }
    case "TRADE_RESPONSE_RECORDED": {
      const viewerCanSee = viewerId !== "spectator" && (
        viewerId === event.fromPlayerId
        || Boolean(event.recipientIds?.includes(viewerId))
      );
      return viewerCanSee ? event : { schemaVersion: event.schemaVersion, seq: event.seq, type: event.type, tradeId: event.tradeId };
    }
    case "TRADE_ACCEPTED": {
      const canSeeResources = viewerId === event.fromPlayerId || viewerId === event.toPlayerId;
      return canSeeResources ? event : { ...event, offered: emptyResources(), requested: emptyResources() };
    }
    default:
      return event;
  }
};

export const serializeEventsForViewer = (events: readonly GameEvent[], viewerId: PlayerId | "spectator", knownPlayerIds?: readonly PlayerId[], gameOver = false): GameEvent[] =>
  events.map((event) => serializeEventForViewer(event, viewerId, knownPlayerIds, gameOver));
