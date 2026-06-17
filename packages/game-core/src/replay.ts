import { applyEvents, createGame } from "./engine.js";
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
  for (const trade of Object.values(next.trades)) {
    if (trade.status !== "OPEN") continue;
    trade.status = "CLOSED";
    trade.closedReason = "MIGRATED";
    delete trade.responses;
  }
  return next;
};
