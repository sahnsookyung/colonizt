import { validateBoard } from "./board.js";
import { classicDevelopmentDeck, maxCitiesPerPlayer, maxRoadsPerPlayer, maxSettlementsPerPlayer } from "./game-constants.js";
import { classicResourceBankSize, emptyResources, isNonNegativeBundle, resourceCount } from "./resources.js";
import {
  resources,
  type DevelopmentCardId,
  type GameState,
  type PlayerId,
  type ResourceBundle,
  type Result,
  type TradeOffer,
  type ValidationError,
  type VertexId,
} from "./types.js";

const error = (code: ValidationError["code"], message: string): ValidationError => ({ code, message });

const normalizeExactBundle = (bundle: Partial<ResourceBundle>): ResourceBundle =>
  ({ ...emptyResources(), ...bundle });

const adjacentVertices = (state: GameState, vertexId: VertexId): VertexId[] => {
  const edges = state.board.adjacency.vertexToEdges[vertexId]!;
  return edges.flatMap((edgeId) => state.board.adjacency.edgeToVertices[edgeId]!).filter((id): id is VertexId => Boolean(id) && id !== vertexId);
};

const countRoads = (state: GameState, playerId: PlayerId): number =>
  Object.values(state.roads).filter((owner) => owner === playerId).length;

const countBuildings = (state: GameState, playerId: PlayerId, type: "settlement" | "city"): number =>
  Object.values(state.buildings).filter((building) => building.owner === playerId && building.type === type).length;

const tradeRecipientIds = (state: GameState, trade: TradeOffer): PlayerId[] =>
  trade.recipients === "ANY"
    ? state.playerOrder.filter((playerId) => playerId !== trade.fromPlayerId)
    : state.playerOrder.filter((playerId) => trade.recipients.includes(playerId));

const trueVictoryPoints = (state: GameState, playerId: PlayerId): number => {
  const player = state.players[playerId];
  if (!player) return 0;
  const victoryCards = player.developmentCards.filter((card) => card.type === "VICTORY_POINT").length;
  return player.score + victoryCards;
};

export const assertInvariants = (state: GameState): Result<true, ValidationError> => {
  const boardErrors = validateBoard(state.board);
  if (boardErrors.length > 0) return { ok: false, error: error("INVALID_BOARD", boardErrors.join("; ")) };
  if (state.thiefHexId && !state.board.hexes[state.thiefHexId]) return { ok: false, error: error("INVARIANT_VIOLATION", "thief is on an unknown hex") };
  if (!isNonNegativeBundle(state.resourceBank ?? emptyResources())) return { ok: false, error: error("INVARIANT_VIOLATION", "bank has negative resources") };
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
    const responses = trade.responses ?? {};
    const responseIds = Object.keys(responses);
    if (responseIds.length !== recipients.length || recipients.some((playerId) => !responses[playerId])) {
      return { ok: false, error: error("INVARIANT_VIOLATION", `trade ${trade.id} has invalid response entries`) };
    }
    for (const response of Object.values(responses)) {
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
  for (const resource of resources) {
    const held = Object.values(state.players).reduce((sum, player) => sum + player.resources[resource], 0);
    if (held + (state.resourceBank?.[resource] ?? 0) !== classicResourceBankSize) {
      return { ok: false, error: error("INVARIANT_VIOLATION", `${resource} bank accounting mismatch`) };
    }
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
