import { applyEvents, createDevelopmentDeck, createGame } from "./engine.js";
import { schemaVersion, type SchemaVersion } from "./types.js";
import type { BoardGraph, GameConfig, GameEvent, GameState } from "./types.js";

const supportedSchemaVersions = new Set<SchemaVersion>([1, 2, schemaVersion]);

export interface ReplayLog {
  config: GameConfig;
  board: BoardGraph;
  events: GameEvent[];
  snapshot?: ReplaySnapshot;
}

export interface ReplaySnapshot {
  seq: number;
  state: GameState;
}

export interface ReplayValidationIssue {
  code:
    | "INVALID_SNAPSHOT"
    | "INVALID_EVENT"
    | "UNSUPPORTED_SCHEMA"
    | "DUPLICATE_SEQUENCE"
    | "MISSING_SEQUENCE"
    | "INVALID_SEQUENCE_START";
  message: string;
  seq?: number;
  index?: number;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isSupportedSchemaVersion = (value: unknown): value is SchemaVersion =>
  typeof value === "number" && supportedSchemaVersions.has(value as SchemaVersion);

export const validateReplayLog = (log: ReplayLog): ReplayValidationIssue[] => {
  const issues: ReplayValidationIssue[] = [];
  const snapshotSeq = log.snapshot?.seq;
  if (log.snapshot) {
    const currentSnapshotSeq = log.snapshot.seq;
    if (!Number.isInteger(currentSnapshotSeq) || currentSnapshotSeq < 0) {
      issues.push({ code: "INVALID_SNAPSHOT", message: "Replay snapshot sequence must be a non-negative integer" });
    }
    if (log.snapshot.state.eventSeq !== currentSnapshotSeq) {
      issues.push({
        code: "INVALID_SNAPSHOT",
        message: `Replay snapshot state eventSeq ${log.snapshot.state.eventSeq} does not match snapshot seq ${currentSnapshotSeq}`,
        seq: currentSnapshotSeq,
      });
    }
    if (!isSupportedSchemaVersion(log.snapshot.state.schemaVersion)) {
      issues.push({
        code: "UNSUPPORTED_SCHEMA",
        message: `Replay snapshot schema version ${String(log.snapshot.state.schemaVersion)} is not supported`,
        seq: currentSnapshotSeq,
      });
    }
  }

  const ordered = [...log.events].sort((left, right) => left.seq - right.seq);
  const firstExpectedSeq = (snapshotSeq ?? 0) + 1;
  let expectedSeq = firstExpectedSeq;
  const seen = new Set<number>();
  for (const [index, event] of ordered.entries()) {
    if (!isObject(event)) {
      issues.push({ code: "INVALID_EVENT", message: "Replay event must be an object", index });
      continue;
    }
    if (!Number.isInteger(event.seq) || event.seq < 1) {
      issues.push({ code: "INVALID_EVENT", message: "Replay event sequence must be a positive integer", index });
      continue;
    }
    if (typeof event.type !== "string" || event.type.length === 0) {
      issues.push({ code: "INVALID_EVENT", message: `Replay event ${event.seq} is missing a type`, seq: event.seq, index });
    }
    if (!isSupportedSchemaVersion(event.schemaVersion)) {
      issues.push({
        code: "UNSUPPORTED_SCHEMA",
        message: `Replay event ${event.seq} schema version ${String(event.schemaVersion)} is not supported`,
        seq: event.seq,
        index,
      });
    }
    if (seen.has(event.seq)) {
      issues.push({ code: "DUPLICATE_SEQUENCE", message: `Replay event sequence ${event.seq} appears more than once`, seq: event.seq, index });
      continue;
    }
    seen.add(event.seq);
    if (event.seq !== expectedSeq) {
      issues.push({
        code: event.seq < expectedSeq ? "DUPLICATE_SEQUENCE" : expectedSeq === firstExpectedSeq ? "INVALID_SEQUENCE_START" : "MISSING_SEQUENCE",
        message: `Replay expected event sequence ${expectedSeq}, got ${event.seq}`,
        seq: event.seq,
        index,
      });
      expectedSeq = event.seq + 1;
      continue;
    }
    expectedSeq += 1;
  }
  return issues;
};

export const assertValidReplayLog = (log: ReplayLog): void => {
  const issues = validateReplayLog(log);
  if (issues.length > 0) {
    throw new Error(`Invalid replay log: ${issues.map((issue) => issue.message).join("; ")}`);
  }
};

export const replay = (log: ReplayLog): GameState => {
  assertValidReplayLog(log);
  const initial = log.snapshot ? structuredClone(log.snapshot.state) as GameState : createGame(log.config, log.board);
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
    const thiefHexId = Object.values(next.board.hexes).find((hex) => hex.resource === "desert")?.id
      ?? Object.keys(next.board.hexes).sort((left, right) => left.localeCompare(right))[0];
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
