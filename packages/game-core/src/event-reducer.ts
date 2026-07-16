import {
  addResources,
  classicResourceBank,
  emptyResources,
  normalizedResources,
  resourceBundle,
  subtractResources,
} from "./resources.js";
import type {
  DevelopmentCardType,
  GameEvent,
  GameState,
  PlayerId,
  ResourceBundle,
  TradeOffer,
  TradeResponse,
} from "./types.js";
import { resources } from "./types.js";

export interface GameEventReducerContext {
  createDevelopmentDeck(seed: string): DevelopmentCardType[];
  normalizedCardCount(player: GameState["players"][PlayerId]): number;
  refreshLargestArmy(state: GameState): void;
  refreshLongestRoad(state: GameState): void;
  setupOrder(playerOrder: readonly PlayerId[]): PlayerId[];
  nextPendingDiscardPlayer(
    pending: Record<PlayerId, number>,
    submitted: Record<PlayerId, Partial<ResourceBundle>>,
  ): PlayerId | undefined;
  initialTradeResponses(
    state: GameState,
    trade: Pick<TradeOffer, "fromPlayerId" | "recipients">,
  ): Record<PlayerId, TradeResponse>;
}

const ensureResourceBank = (state: GameState): void => {
  if (state.resourceBank) {
    state.resourceBank = normalizedResources(state.resourceBank);
    return;
  }
  const bank = classicResourceBank();
  for (const player of Object.values(state.players)) {
    for (const resource of resources) bank[resource] -= player.resources[resource];
  }
  state.resourceBank = bank;
};

const returnToBank = (state: GameState, bundle: Partial<ResourceBundle>): void => {
  state.resourceBank = addResources(state.resourceBank, bundle);
};

const takeFromBank = (state: GameState, bundle: Partial<ResourceBundle>): void => {
  state.resourceBank = subtractResources(state.resourceBank, normalizedResources(bundle));
};

const reduceSetupEvent = (state: GameState, event: GameEvent, context: GameEventReducerContext): boolean => {
  if (event.type !== "SETUP_PLACED") return false;
  state.settlements[event.vertexId] = event.playerId;
  state.buildings[event.vertexId] = { owner: event.playerId, type: "settlement" };
  state.roads[event.edgeId] = event.playerId;
  state.players[event.playerId]!.resources = addResources(state.players[event.playerId]!.resources, event.startingResources);
  takeFromBank(state, event.startingResources);
  state.players[event.playerId]!.score += 1;
  context.refreshLongestRoad(state);
  const setupIndex = state.phase.type === "SETUP_PLACEMENT" ? state.phase.setupIndex + 1 : 0;
  const nextPlayer = context.setupOrder(state.playerOrder)[setupIndex];
  state.phase = nextPlayer
    ? { type: "SETUP_PLACEMENT", activePlayerId: nextPlayer, setupIndex }
    : { type: "WAITING_FOR_ROLL", activePlayerId: state.playerOrder[0] as PlayerId };
  return true;
};

const reduceProductionEvent = (state: GameState, event: GameEvent, context: GameEventReducerContext): boolean => {
  switch (event.type) {
    case "DICE_ROLLED":
      state.rng.index = event.rngIndex + 2;
      state.lastRoll = { dice: event.dice, sum: event.sum, ...(event.doublesMultiplier ? { doublesMultiplier: event.doublesMultiplier } : {}) };
      state.phase = { type: "ACTION_PHASE", activePlayerId: event.playerId };
      return true;
    case "SEVEN_ROLLED":
      state.phase = { type: "MOVING_THIEF", activePlayerId: event.playerId, rollerId: event.playerId, reason: "ROLL_7" };
      return true;
    case "DISCARD_REQUIRED": {
      const activeDiscarder = context.nextPendingDiscardPlayer(event.pending, {});
      state.phase = {
        type: "DISCARDING",
        activePlayerId: activeDiscarder ?? event.rollerId,
        rollerId: event.rollerId,
        pending: event.pending,
        submitted: {},
      };
      return true;
    }
    case "RESOURCES_DISCARDED": {
      state.players[event.playerId]!.resources = subtractResources(state.players[event.playerId]!.resources, event.resources);
      returnToBank(state, event.resources);
      if (state.phase.type === "DISCARDING") {
        const submitted = { ...state.phase.submitted, [event.playerId]: event.resources };
        const activeDiscarder = context.nextPendingDiscardPlayer(state.phase.pending, submitted);
        state.phase = activeDiscarder
          ? { ...state.phase, activePlayerId: activeDiscarder, submitted }
          : { type: "MOVING_THIEF", activePlayerId: state.phase.rollerId, rollerId: state.phase.rollerId, reason: "ROLL_7" };
      }
      return true;
    }
    case "THIEF_MOVED":
      state.thiefHexId = event.toHexId;
      if (event.stealFromPlayerId && event.stolenResource) {
        state.players[event.stealFromPlayerId]!.resources = subtractResources(state.players[event.stealFromPlayerId]!.resources, resourceBundle(event.stolenResource, 1));
        state.players[event.playerId]!.resources = addResources(state.players[event.playerId]!.resources, resourceBundle(event.stolenResource, 1));
      }
      if (event.reason === "ROLL_7") state.phase = { type: "ACTION_PHASE", activePlayerId: event.playerId };
      return true;
    case "RESOURCES_PRODUCED":
      for (const [playerId, gains] of Object.entries(event.gains)) {
        state.players[playerId]!.resources = addResources(state.players[playerId]!.resources, gains);
        takeFromBank(state, gains);
      }
      return true;
    default:
      return false;
  }
};

const reduceBuildingEvent = (state: GameState, event: GameEvent, context: GameEventReducerContext): boolean => {
  switch (event.type) {
    case "ROAD_BUILT":
      state.roads[event.edgeId] = event.playerId;
      state.players[event.playerId]!.resources = subtractResources(state.players[event.playerId]!.resources, event.cost);
      returnToBank(state, event.cost);
      context.refreshLongestRoad(state);
      return true;
    case "SETTLEMENT_BUILT":
      state.settlements[event.vertexId] = event.playerId;
      state.buildings[event.vertexId] = { owner: event.playerId, type: "settlement" };
      state.players[event.playerId]!.resources = subtractResources(state.players[event.playerId]!.resources, event.cost);
      returnToBank(state, event.cost);
      state.players[event.playerId]!.score += 1;
      context.refreshLongestRoad(state);
      return true;
    case "CITY_UPGRADED":
      state.buildings[event.vertexId] = { owner: event.playerId, type: "city" };
      state.settlements[event.vertexId] = event.playerId;
      state.players[event.playerId]!.resources = subtractResources(state.players[event.playerId]!.resources, event.cost);
      returnToBank(state, event.cost);
      state.players[event.playerId]!.score += 1;
      return true;
    case "PLIGHT_STRUCK":
      state.plightApplied = true;
      for (const destroyed of event.destroyed) {
        delete state.settlements[destroyed.vertexId];
        delete state.buildings[destroyed.vertexId];
        state.players[destroyed.playerId]!.score = Math.max(0, state.players[destroyed.playerId]!.score - (destroyed.buildingType === "city" ? 2 : 1));
      }
      context.refreshLongestRoad(state);
      return true;
    default:
      return false;
  }
};

const reduceDevelopmentEvent = (state: GameState, event: GameEvent, context: GameEventReducerContext): boolean => {
  switch (event.type) {
    case "SPECIAL_CARD_BOUGHT":
      state.players[event.playerId]!.resources = subtractResources(state.players[event.playerId]!.resources, event.cost);
      returnToBank(state, event.cost);
      if (event.cardId && event.cardType) {
        state.players[event.playerId]!.developmentCards = [
          ...(state.players[event.playerId]!.developmentCards ?? []),
          {
            id: event.cardId,
            type: event.cardType,
            ownerId: event.playerId,
            boughtTurn: state.turn,
            ...(event.cardType === "VICTORY_POINT" && state.phase.type === "GAME_OVER" ? { revealed: true } : {}),
          },
        ];
        state.developmentDeckCursor = Math.max(state.developmentDeckCursor, (event.deckIndex ?? state.developmentDeckCursor) + 1);
        state.players[event.playerId]!.specialCards = context.normalizedCardCount(state.players[event.playerId]!);
      } else {
        state.players[event.playerId]!.specialCards += 1;
      }
      return true;
    case "DEVELOPMENT_CARD_PLAYED": {
      const player = state.players[event.playerId]!;
      const card = player.developmentCards.find((candidate) => candidate.id === event.cardId);
      if (card) {
        card.playedTurn = state.turn;
        card.revealed = true;
      }
      player.playedDevelopmentCardTurn = state.turn;
      if (event.cardType === "KNIGHT") {
        player.playedKnights += 1;
        state.playedKnightCounts[event.playerId] = (state.playedKnightCounts[event.playerId] ?? 0) + 1;
      }
      player.specialCards = context.normalizedCardCount(player);
      return true;
    }
    case "ROAD_BUILDING_PLAYED":
    case "LONGEST_ROAD_UPDATED":
      return true;
    case "MONOPOLY_PLAYED": {
      const total = Object.values(event.collected).reduce((sum, count) => sum + count, 0);
      for (const [playerId, count] of Object.entries(event.collected)) {
        state.players[playerId]!.resources = subtractResources(state.players[playerId]!.resources, resourceBundle(event.resource, count));
      }
      state.players[event.playerId]!.resources = addResources(state.players[event.playerId]!.resources, resourceBundle(event.resource, total));
      return true;
    }
    case "YEAR_OF_PLENTY_PLAYED": {
      const gained = event.resources.reduce<ResourceBundle>((bundle, resource) => addResources(bundle, resourceBundle(resource, 1)), emptyResources());
      state.players[event.playerId]!.resources = addResources(state.players[event.playerId]!.resources, gained);
      takeFromBank(state, gained);
      return true;
    }
    case "LARGEST_ARMY_UPDATED":
      context.refreshLargestArmy(state);
      return true;
    default:
      return false;
  }
};

const reduceTradeEvent = (state: GameState, event: GameEvent, context: GameEventReducerContext): boolean => {
  switch (event.type) {
    case "MARITIME_TRADED":
      state.players[event.playerId]!.resources = subtractResources(state.players[event.playerId]!.resources, resourceBundle(event.offered, event.ratio));
      returnToBank(state, resourceBundle(event.offered, event.ratio));
      state.players[event.playerId]!.resources = addResources(state.players[event.playerId]!.resources, resourceBundle(event.requested, 1));
      takeFromBank(state, resourceBundle(event.requested, 1));
      return true;
    case "TRADE_OFFERED":
      state.trades[event.trade.id] = event.trade;
      return true;
    case "TRADE_CANCELLED":
      state.trades[event.tradeId]!.status = "CANCELLED";
      return true;
    case "TRADE_RESPONSE_RECORDED": {
      const trade = state.trades[event.tradeId];
      if (!trade || !event.playerId || !event.response) return true;
      trade.responses = trade.responses ?? context.initialTradeResponses(state, trade);
      trade.responses[event.playerId] = { playerId: event.playerId, status: event.response, respondedAtSeq: event.seq };
      return true;
    }
    case "TRADE_REJECTED":
      state.trades[event.tradeId]!.status = "REJECTED";
      return true;
    case "TRADE_ACCEPTED":
      state.players[event.fromPlayerId]!.resources = subtractResources(state.players[event.fromPlayerId]!.resources, event.offered);
      state.players[event.toPlayerId]!.resources = addResources(state.players[event.toPlayerId]!.resources, event.offered);
      state.players[event.toPlayerId]!.resources = subtractResources(state.players[event.toPlayerId]!.resources, event.requested);
      state.players[event.fromPlayerId]!.resources = addResources(state.players[event.fromPlayerId]!.resources, event.requested);
      state.trades[event.tradeId]!.status = "ACCEPTED";
      return true;
    case "TRADE_EXPIRED":
      state.trades[event.tradeId]!.status = "EXPIRED";
      return true;
    case "TRADE_CLOSED":
      state.trades[event.tradeId]!.status = "CLOSED";
      state.trades[event.tradeId]!.closedReason = event.reason;
      return true;
    default:
      return false;
  }
};

const reduceTurnEvent = (state: GameState, event: GameEvent, context: GameEventReducerContext): boolean => {
  switch (event.type) {
    case "TURN_ENDED":
      state.turn += 1;
      state.phase = { type: "WAITING_FOR_ROLL", activePlayerId: event.nextPlayerId };
      return true;
    case "GAME_OVER":
      for (const player of Object.values(state.players)) {
        for (const card of player.developmentCards ?? []) {
          if (card.type === "VICTORY_POINT") card.revealed = true;
        }
        player.specialCards = context.normalizedCardCount(player);
      }
      state.phase = { type: "GAME_OVER", winnerId: event.winnerId, reason: event.reason };
      return true;
    default:
      return false;
  }
};

export const reduceGameEvent = (
  state: GameState,
  event: GameEvent,
  context: GameEventReducerContext,
): GameState => {
  const next = structuredClone(state) as GameState;
  next.developmentDeck ??= context.createDevelopmentDeck(next.config.seed);
  next.developmentDeckCursor ??= 0;
  next.playedKnightCounts ??= {};
  ensureResourceBank(next);
  for (const player of Object.values(next.players)) {
    player.developmentCards ??= [];
    player.playedKnights ??= next.playedKnightCounts[player.id] ?? 0;
    player.hasLargestArmy ??= next.largestArmyOwner === player.id;
    player.specialCards = context.normalizedCardCount(player);
  }
  next.eventSeq = Math.max(next.eventSeq, event.seq);

  if (
    reduceSetupEvent(next, event, context)
    || reduceProductionEvent(next, event, context)
    || reduceBuildingEvent(next, event, context)
    || reduceDevelopmentEvent(next, event, context)
    || reduceTradeEvent(next, event, context)
    || reduceTurnEvent(next, event, context)
  ) return next;

  throw new Error(`Unsupported game event type ${String((event as unknown as { type?: unknown }).type)}`);
};
