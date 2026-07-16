import { assertValidReplayLog, isGameEvent, type BoardGraph, type GameConfig, type GameEvent, type GameState } from "@colonizt/game-core";
import { createRoomSchema } from "@colonizt/protocol";
import { z } from "zod";
import type { StoredCommandResult, StoredRoomRecord } from "./event-store.js";

const roomStatusSchema = z.enum(["LOBBY", "IN_GAME", "FINISHED", "EXPIRED", "ABANDONED"]);
const roomPauseReasonSchema = z.enum(["EMPTY_ROOM", "STALLED_AUTOMATION"]);

const roomSeatSchema = z.object({
  seatIndex: z.number().int().min(0).max(3),
  userId: z.string().optional(),
  botId: z.string().optional(),
  displayName: z.string().optional(),
  ready: z.boolean(),
  connected: z.boolean(),
});

const roomTimerSchema = z.object({
  activePlayerId: z.string().min(1),
  expiresAt: z.number().finite().nonnegative(),
});

const matchSnapshotSchema = z.object({
  matchId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  state: z.custom<GameState>((value) => typeof value === "object" && value !== null, "snapshot state must be an object"),
});

const storedMatchSchema = z.object({
  id: z.string().min(1),
  config: z.custom<GameConfig>((value) => typeof value === "object" && value !== null, "match config must be an object"),
  board: z.custom<BoardGraph>((value) => typeof value === "object" && value !== null, "match board must be an object"),
  events: z.array(z.custom<GameEvent>(isGameEvent, "event payload is invalid")),
  snapshot: matchSnapshotSchema.optional(),
  endedAt: z.string().optional(),
  winnerUserId: z.string().optional(),
});

const storedRoomRecordSchema = z.object({
  id: z.string().min(1),
  code: z.string().optional(),
  status: roomStatusSchema,
  hostUserId: z.string().min(1),
  settings: createRoomSchema,
  createdAt: z.string().min(1),
  lastActivityAt: z.string().optional(),
  emptySince: z.string().optional(),
  pausedAt: z.string().optional(),
  pauseReason: roomPauseReasonSchema.optional(),
  tradeResponseDeadlines: z.record(z.string(), z.number().finite().nonnegative()).optional(),
  timer: roomTimerSchema.optional(),
  archivedAt: z.string().optional(),
  cleanupReason: z.string().optional(),
  seats: z.array(roomSeatSchema).min(2).max(4),
  match: storedMatchSchema.optional(),
});

const commandEventSchema = z.custom<GameEvent>(isGameEvent, "event payload is invalid");

const storedCommandResultSchema = z.object({
  roomId: z.string().min(1),
  matchId: z.string().optional(),
  userId: z.string().min(1),
  clientSeq: z.number().int().nonnegative(),
  commandHash: z.string().min(1),
  ok: z.boolean(),
  events: z.array(commandEventSchema).optional(),
  seqStart: z.number().int().positive().optional(),
  seqEnd: z.number().int().positive().optional(),
  rejectionCode: z.string().optional(),
  rejectionMessage: z.string().optional(),
}).superRefine((result, context) => {
  if (!result.events?.length) return;
  const first = result.events[0]!.seq;
  const last = result.events.at(-1)!.seq;
  if (result.seqStart !== undefined && result.seqStart !== first) {
    context.addIssue({ code: "custom", path: ["seqStart"], message: `seqStart ${result.seqStart} does not match first event ${first}` });
  }
  if (result.seqEnd !== undefined && result.seqEnd !== last) {
    context.addIssue({ code: "custom", path: ["seqEnd"], message: `seqEnd ${result.seqEnd} does not match last event ${last}` });
  }
  for (const [index, event] of result.events.entries()) {
    const expectedSeq = first + index;
    if (event.seq !== expectedSeq) {
      context.addIssue({ code: "custom", path: ["events", index, "seq"], message: `expected contiguous event seq ${expectedSeq}, got ${event.seq}` });
    }
  }
});

const describeIssues = (issues: z.core.$ZodIssue[]): string =>
  issues.map((issue) => `${issue.path.join(".") || "record"}: ${issue.message}`).join("; ");

export const validateStoredRoomRecord = (record: StoredRoomRecord): StoredRoomRecord => {
  const parsed = storedRoomRecordSchema.safeParse(record);
  if (!parsed.success) {
    throw new Error(`Invalid stored room ${record.id || "<unknown>"}: ${describeIssues(parsed.error.issues)}`);
  }
  const stored = parsed.data as StoredRoomRecord;
  if (stored.match) {
    assertValidReplayLog({
      config: stored.match.config,
      board: stored.match.board,
      events: stored.match.events,
    });
  }
  return stored;
};

export const validateStoredCommandResult = (result: StoredCommandResult): StoredCommandResult => {
  const parsed = storedCommandResultSchema.safeParse(result);
  if (!parsed.success) {
    throw new Error(`Invalid stored command result ${result.roomId}:${result.userId}:${result.clientSeq}: ${describeIssues(parsed.error.issues)}`);
  }
  return parsed.data as StoredCommandResult;
};
