import { canViewerSeeTrade } from "./engine.js";
import { emptyResources, resourceCount } from "./resources.js";
import type { GameEvent, GameState, PlayerId, ResourceBundle, TradeOffer } from "./types.js";

export interface SerializedPlayer {
  id: PlayerId;
  name: string;
  color: string;
  score: number;
  specialCards: number;
  longestRoadLength: number;
  hasLongestRoad: boolean;
  resourceCount: number;
  resources?: ResourceBundle;
}

export interface ViewerState {
  schemaVersion: GameState["schemaVersion"];
  viewerId: PlayerId | "spectator";
  board: GameState["board"];
  players: SerializedPlayer[];
  playerOrder: PlayerId[];
  phase: GameState["phase"];
  turn: number;
  roads: GameState["roads"];
  settlements: GameState["settlements"];
  buildings: GameState["buildings"];
  longestRoadOwner: GameState["longestRoadOwner"];
  trades: TradeOffer[];
  eventSeq: number;
  lastRoll: GameState["lastRoll"];
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
  board: state.board,
  players: state.playerOrder.map((playerId) => {
    const player = state.players[playerId]!;
    return {
      id: player.id,
      name: player.name,
      color: player.color,
      score: player.score,
      specialCards: player.specialCards,
      longestRoadLength: player.longestRoadLength,
      hasLongestRoad: player.hasLongestRoad,
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
  trades: Object.values(state.trades).map((trade) => serializeTradeForViewer(trade, viewerId, state.playerOrder)),
  eventSeq: state.eventSeq,
  lastRoll: state.lastRoll,
});

export const serializeEventForViewer = (event: GameEvent, viewerId: PlayerId | "spectator", knownPlayerIds?: readonly PlayerId[]): GameEvent => {
  switch (event.type) {
    case "SETUP_PLACED":
      return viewerId === event.playerId ? event : { ...event, startingResources: {} };
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

export const serializeEventsForViewer = (events: readonly GameEvent[], viewerId: PlayerId | "spectator", knownPlayerIds?: readonly PlayerId[]): GameEvent[] =>
  events.map((event) => serializeEventForViewer(event, viewerId, knownPlayerIds));
