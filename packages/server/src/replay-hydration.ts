import { normalizeImportedState, replay, type GameEvent, type GameState, type ReplayLog } from "@colonizt/game-core";
import type { StoredRoomRecord } from "./event-store.js";

type StoredMatchRecord = NonNullable<StoredRoomRecord["match"]>;

export const replayLogFromStoredMatch = (match: StoredMatchRecord): ReplayLog => {
  const { snapshot } = match;
  return snapshot
    ? {
      config: match.config,
      board: match.board,
      snapshot,
      events: match.events.filter((event: GameEvent) => event.seq > snapshot.seq),
    }
    : {
      config: match.config,
      board: match.board,
      events: match.events,
    };
};

export const hydrateGameFromStoredMatch = (match: StoredMatchRecord): GameState =>
  normalizeImportedState(replay(replayLogFromStoredMatch(match)));
