import { applyEvents, createDevelopmentDeck, createGame } from "./engine.js";
import { schemaVersion } from "./types.js";
import type { BoardGraph, GameConfig, GameEvent, GameState } from "./types.js";

export interface ReplayLog {
  config: GameConfig;
  board: BoardGraph;
  events: GameEvent[];
}

export const replay = (log: ReplayLog): GameState => {
  const initial = createGame(log.config, log.board);
  const ordered = [...log.events].sort((left, right) => left.seq - right.seq);
  return applyEvents(initial, ordered);
};

export const normalizeImportedState = (state: GameState): GameState => {
  const next = structuredClone(state) as GameState;
  next.schemaVersion = schemaVersion;
  next.developmentDeck ??= createDevelopmentDeck(next.config.seed);
  next.developmentDeckCursor ??= 0;
  next.playedKnightCounts ??= Object.fromEntries(next.playerOrder.map((playerId) => [playerId, next.players[playerId]?.playedKnights ?? 0]));
  if (!next.thiefHexId) {
    const thiefHexId = Object.values(next.board.hexes).find((hex) => hex.resource === "desert")?.id ?? Object.keys(next.board.hexes).sort()[0];
    if (thiefHexId) next.thiefHexId = thiefHexId;
  }
  for (const playerId of next.playerOrder) {
    const player = next.players[playerId];
    if (!player) continue;
    player.developmentCards ??= [];
    player.playedKnights ??= next.playedKnightCounts[playerId] ?? 0;
    player.hasLargestArmy ??= next.largestArmyOwner === playerId;
  }
  for (const trade of Object.values(next.trades)) {
    if (trade.status !== "OPEN") continue;
    trade.status = "CLOSED";
    trade.closedReason = "MIGRATED";
    delete trade.responses;
  }
  return next;
};
