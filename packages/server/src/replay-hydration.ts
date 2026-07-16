import { isDeepStrictEqual } from "node:util";
import { assertInvariants, normalizeImportedState, replay, type GameEvent, type GameState, type ReplayLog } from "@colonizt/game-core";
import type { StoredRoomRecord } from "./event-store.js";
import type { HydrationOutcome } from "./room-diagnostics.js";

type StoredMatchRecord = NonNullable<StoredRoomRecord["match"]>;

const lastEventSeq = (match: StoredMatchRecord): number =>
  match.events.reduce((highest, event) => Math.max(highest, event.seq), 0);

const assertSnapshotBoundary = (match: StoredMatchRecord): void => {
  const snapshot = match.snapshot;
  if (!snapshot) return;
  if (snapshot.matchId !== match.id || snapshot.state.config.matchId !== match.id) {
    throw new Error(`Snapshot match identity does not match ${match.id}`);
  }
  if (snapshot.seq > lastEventSeq(match)) {
    throw new Error(`Snapshot sequence ${snapshot.seq} exceeds durable event sequence ${lastEventSeq(match)}`);
  }
  if (!isDeepStrictEqual(snapshot.state.config, match.config) || !isDeepStrictEqual(snapshot.state.board, match.board)) {
    throw new Error(`Snapshot config or board does not match ${match.id}`);
  }
};

const validatedHydratedState = (match: StoredMatchRecord, state: GameState): GameState => {
  const normalized = normalizeImportedState(state);
  if (normalized.config.matchId !== match.id) {
    throw new Error(`Hydrated match identity does not match ${match.id}`);
  }
  const invariants = assertInvariants(normalized);
  if (!invariants.ok) throw new Error(`Hydrated game invariant failed: ${invariants.error.message}`);
  const durableSeq = lastEventSeq(match);
  if (normalized.eventSeq !== durableSeq) {
    throw new Error(`Hydrated event sequence ${normalized.eventSeq} does not match durable event sequence ${durableSeq}`);
  }
  return normalized;
};

export const replayLogFromStoredMatch = (match: StoredMatchRecord): ReplayLog => {
  const { snapshot } = match;
  assertSnapshotBoundary(match);
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

export const hydrateGameFromStoredMatchWithOutcome = (match: StoredMatchRecord): { state: GameState; outcome: HydrationOutcome } => {
  try {
    return {
      state: validatedHydratedState(match, replay(replayLogFromStoredMatch(match))),
      outcome: match.snapshot ? "snapshot" : "full_replay",
    };
  } catch (snapshotError) {
    if (!match.snapshot) throw snapshotError;
    return {
      state: validatedHydratedState(match, replay({ config: match.config, board: match.board, events: match.events })),
      outcome: "snapshot_fallback",
    };
  }
};

export const hydrateGameFromStoredMatch = (match: StoredMatchRecord): GameState =>
  hydrateGameFromStoredMatchWithOutcome(match).state;
