import { applyEvents, createDevelopmentDeck, createGame, projectedResourceBank } from "./engine.js";
import { resources, schemaVersion, type SchemaVersion } from "./types.js";
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

const isString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isOptionalString = (value: unknown): boolean => value === undefined || isString(value);
const isNonNegativeInteger = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;
const isPositiveInteger = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0;
const isResource = (value: unknown): boolean => typeof value === "string" && resources.includes(value as (typeof resources)[number]);
const isStringArray = (value: unknown): boolean => Array.isArray(value) && value.every(isString);

const isResourceBundle = (value: unknown, partial = false): boolean => {
  if (!isObject(value)) return false;
  if (Object.keys(value).some((key) => !isResource(key))) return false;
  if (Object.values(value).some((count) => !isNonNegativeInteger(count))) return false;
  return partial || resources.every((resource) => isNonNegativeInteger(value[resource]));
};

const isCountRecord = (value: unknown): boolean =>
  isObject(value) && Object.entries(value).every(([key, count]) => isString(key) && isNonNegativeInteger(count));

const isTradeOffer = (value: unknown): boolean => {
  if (!isObject(value)) return false;
  const statuses = ["OPEN", "COLLECTING_RESPONSES", "ACCEPTED", "CANCELLED", "REJECTED", "EXPIRED", "CLOSED"];
  const closedReasons = ["TTL", "RESPONSE_TIMEOUT", "ALL_REJECTED", "TURN_ENDED", "MIGRATED"];
  const recipientsValid = value.recipients === "ANY" || isStringArray(value.recipients);
  const responsesValid = value.responses === undefined || (isObject(value.responses) && Object.values(value.responses).every((response) =>
    isObject(response)
    && isString(response.playerId)
    && ["PENDING", "WANTS_ACCEPT", "REJECTED"].includes(String(response.status))
    && (response.respondedAtSeq === undefined || isNonNegativeInteger(response.respondedAtSeq))));
  return isString(value.id)
    && isString(value.fromPlayerId)
    && isResourceBundle(value.offered)
    && isResourceBundle(value.requested)
    && recipientsValid
    && statuses.includes(String(value.status))
    && isNonNegativeInteger(value.createdAtSeq)
    && isNonNegativeInteger(value.expiresAtSeq)
    && responsesValid
    && (value.closedReason === undefined || closedReasons.includes(String(value.closedReason)));
};

/** Runtime guard for durable and wire-level game events. */
export const isGameEvent = (value: unknown): value is GameEvent => {
  if (!isObject(value)
    || !isPositiveInteger(value.schemaVersion)
    || !isPositiveInteger(value.seq)
    || !isString(value.type)) return false;

  const playerAndCost = () => isString(value.playerId) && isResourceBundle(value.cost);
  const tradeAndPlayer = () => isString(value.tradeId) && isString(value.playerId);
  switch (value.type) {
    case "SETUP_PLACED":
      return isString(value.playerId) && isString(value.vertexId) && isString(value.edgeId) && isResourceBundle(value.startingResources, true);
    case "DICE_ROLLED":
      return isString(value.playerId)
        && Array.isArray(value.dice) && value.dice.length === 2 && value.dice.every((die) => isPositiveInteger(die) && die <= 6)
        && isPositiveInteger(value.sum)
        && isNonNegativeInteger(value.rngIndex)
        && value.rngPolicy === "SEEDED_DETERMINISTIC"
        && (value.doublesMultiplier === undefined || isPositiveInteger(value.doublesMultiplier));
    case "SEVEN_ROLLED":
      return isString(value.playerId);
    case "DISCARD_REQUIRED":
      return isString(value.rollerId) && isCountRecord(value.pending);
    case "RESOURCES_DISCARDED":
      return isString(value.playerId) && isResourceBundle(value.resources) && (value.forced === undefined || typeof value.forced === "boolean");
    case "THIEF_MOVED":
      return isString(value.playerId) && isOptionalString(value.fromHexId) && isString(value.toHexId)
        && (value.reason === "ROLL_7" || value.reason === "KNIGHT")
        && isOptionalString(value.cardId) && isOptionalString(value.stealFromPlayerId)
        && (value.stolenResource === undefined || isResource(value.stolenResource));
    case "RESOURCES_PRODUCED":
      return isObject(value.gains) && Object.values(value.gains).every((bundle) => isResourceBundle(bundle, true))
        && (value.multiplier === undefined || isPositiveInteger(value.multiplier));
    case "ROAD_BUILT":
      return playerAndCost() && isString(value.edgeId);
    case "SETTLEMENT_BUILT":
    case "CITY_UPGRADED":
      return playerAndCost() && isString(value.vertexId);
    case "SPECIAL_CARD_BOUGHT": {
      const cardTypes = ["KNIGHT", "ROAD_BUILDING", "MONOPOLY", "YEAR_OF_PLENTY", "VICTORY_POINT"];
      const cardDetailsValid = (value.cardId === undefined && value.cardType === undefined)
        || (isString(value.cardId) && cardTypes.includes(String(value.cardType)));
      return playerAndCost() && isNonNegativeInteger(value.cardIndex) && cardDetailsValid
        && (value.deckIndex === undefined || isNonNegativeInteger(value.deckIndex));
    }
    case "DEVELOPMENT_CARD_PLAYED":
      return isString(value.playerId) && isString(value.cardId)
        && ["KNIGHT", "ROAD_BUILDING", "MONOPOLY", "YEAR_OF_PLENTY"].includes(String(value.cardType));
    case "ROAD_BUILDING_PLAYED":
      return isString(value.playerId) && isString(value.cardId) && isStringArray(value.edgeIds)
        && (value.edgeIds as unknown[]).length >= 1 && (value.edgeIds as unknown[]).length <= 2;
    case "MONOPOLY_PLAYED":
      return isString(value.playerId) && isString(value.cardId) && isResource(value.resource) && isCountRecord(value.collected);
    case "YEAR_OF_PLENTY_PLAYED":
      return isString(value.playerId) && isString(value.cardId) && Array.isArray(value.resources)
        && value.resources.length === 2 && value.resources.every(isResource);
    case "LARGEST_ARMY_UPDATED":
      return isOptionalString(value.playerId) && isNonNegativeInteger(value.knightCount);
    case "LONGEST_ROAD_UPDATED":
      return isOptionalString(value.playerId) && isNonNegativeInteger(value.length);
    case "MARITIME_TRADED":
      return isString(value.playerId) && isResource(value.offered) && isResource(value.requested)
        && (value.ratio === 2 || value.ratio === 3 || value.ratio === 4);
    case "TRADE_OFFERED":
      return isTradeOffer(value.trade);
    case "TRADE_CANCELLED":
    case "TRADE_REJECTED":
    case "TRADE_EXPIRED":
      return tradeAndPlayer();
    case "TRADE_RESPONSE_RECORDED":
      return isString(value.tradeId) && isOptionalString(value.fromPlayerId) && isOptionalString(value.playerId)
        && (value.recipientIds === undefined || isStringArray(value.recipientIds))
        && (value.response === undefined || value.response === "WANTS_ACCEPT" || value.response === "REJECTED");
    case "TRADE_ACCEPTED":
      return isString(value.tradeId) && isString(value.fromPlayerId) && isString(value.toPlayerId)
        && isResourceBundle(value.offered) && isResourceBundle(value.requested);
    case "TRADE_CLOSED":
      return isString(value.tradeId) && isOptionalString(value.playerId)
        && ["TTL", "RESPONSE_TIMEOUT", "ALL_REJECTED", "TURN_ENDED", "MIGRATED"].includes(String(value.reason));
    case "PLIGHT_STRUCK":
      return Array.isArray(value.destroyed) && value.destroyed.every((building) => isObject(building)
        && isString(building.playerId) && isString(building.vertexId)
        && (building.buildingType === "settlement" || building.buildingType === "city"));
    case "TURN_ENDED":
      return isString(value.playerId) && isString(value.nextPlayerId);
    case "GAME_OVER":
      return isString(value.winnerId) && (value.reason === "VICTORY_POINTS" || value.reason === "TURN_LIMIT");
    default:
      return false;
  }
};

export const validateReplayLog = (log: ReplayLog): ReplayValidationIssue[] => {
  const issues: ReplayValidationIssue[] = [];
  const snapshotSeq = log.snapshot && Number.isInteger(log.snapshot.seq) && log.snapshot.seq >= 0 ? log.snapshot.seq : 0;
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

  const ordered = log.events
    .map((event, index) => ({ event: event as unknown, index }))
    .sort((left, right) => {
      const leftSeq = isObject(left.event) && typeof left.event.seq === "number" ? left.event.seq : Number.POSITIVE_INFINITY;
      const rightSeq = isObject(right.event) && typeof right.event.seq === "number" ? right.event.seq : Number.POSITIVE_INFINITY;
      return leftSeq - rightSeq;
    });
  const firstExpectedSeq = snapshotSeq + 1;
  let expectedSeq = firstExpectedSeq;
  const seen = new Set<number>();
  for (const { event, index } of ordered) {
    if (!isObject(event)) {
      issues.push({ code: "INVALID_EVENT", message: "Replay event must be an object", index });
      continue;
    }
    if (typeof event.seq !== "number" || !Number.isInteger(event.seq) || event.seq < 1) {
      issues.push({ code: "INVALID_EVENT", message: "Replay event sequence must be a positive integer", index });
      continue;
    }
    const eventSeq = event.seq;
    if (typeof event.type !== "string" || event.type.length === 0) {
      issues.push({ code: "INVALID_EVENT", message: `Replay event ${eventSeq} is missing a type`, seq: eventSeq, index });
    } else if (!isGameEvent(event)) {
      issues.push({ code: "INVALID_EVENT", message: `Replay event ${eventSeq} has an unknown type or invalid payload`, seq: eventSeq, index });
    }
    if (!isSupportedSchemaVersion(event.schemaVersion)) {
      issues.push({
        code: "UNSUPPORTED_SCHEMA",
        message: `Replay event ${eventSeq} schema version ${String(event.schemaVersion)} is not supported`,
        seq: eventSeq,
        index,
      });
    }
    if (seen.has(eventSeq)) {
      issues.push({ code: "DUPLICATE_SEQUENCE", message: `Replay event sequence ${eventSeq} appears more than once`, seq: eventSeq, index });
      continue;
    }
    seen.add(eventSeq);
    if (eventSeq !== expectedSeq) {
      issues.push({
        code: expectedSeq === firstExpectedSeq ? "INVALID_SEQUENCE_START" : "MISSING_SEQUENCE",
        message: `Replay expected event sequence ${expectedSeq}, got ${eventSeq}`,
        seq: eventSeq,
        index,
      });
      expectedSeq = eventSeq + 1;
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
  next.resourceBank ??= projectedResourceBank(next);
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
