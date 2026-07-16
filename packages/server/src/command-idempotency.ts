import type { GameCommand, GameEvent, GameState, PlayerId } from "@colonizt/game-core";
import type { StoredCommandResult } from "./event-store.js";
import { hashCommandPayload } from "./security.js";

export type CommandResult = {
  ok: true;
  events: GameEvent[];
  state: GameState;
  replayed?: boolean;
  seqStart?: number;
  seqEnd?: number;
} | {
  ok: false;
  code: string;
  message: string;
};

export const commandIdempotencyKey = (roomId: string, userId: PlayerId, clientSeq: number): string =>
  `${roomId}:${userId}:${clientSeq}`;

export const commandPayloadHash = (command: GameCommand): string => hashCommandPayload(command);

export const rejectedStoredCommandResult = (input: {
  roomId: string;
  matchId: string;
  userId: PlayerId;
  clientSeq: number;
  commandHash: string;
  code: string;
  message: string;
}): StoredCommandResult => ({
  roomId: input.roomId,
  matchId: input.matchId,
  userId: input.userId,
  clientSeq: input.clientSeq,
  commandHash: input.commandHash,
  ok: false,
  rejectionCode: input.code,
  rejectionMessage: input.message,
});

export const acceptedStoredCommandResult = (input: {
  roomId: string;
  matchId: string;
  userId: PlayerId;
  clientSeq: number;
  commandHash: string;
  events: GameEvent[];
}): StoredCommandResult => {
  const result: StoredCommandResult = {
    roomId: input.roomId,
    matchId: input.matchId,
    userId: input.userId,
    clientSeq: input.clientSeq,
    commandHash: input.commandHash,
    ok: true,
    events: input.events,
  };
  if (input.events[0]) result.seqStart = input.events[0].seq;
  if (input.events.at(-1)) result.seqEnd = input.events.at(-1)!.seq;
  return result;
};

export const replayStoredCommandResult = (
  state: GameState | undefined,
  result: StoredCommandResult,
  commandHash: string,
): CommandResult => {
  if (result.commandHash !== commandHash) {
    return { ok: false, code: "CLIENT_SEQ_CONFLICT", message: "Client sequence was already used for a different command" };
  }
  if (!result.ok) {
    return { ok: false, code: result.rejectionCode ?? "COMMAND_REJECTED", message: result.rejectionMessage ?? "Command was rejected" };
  }
  if (!state) return { ok: false, code: "ROOM_NOT_IN_GAME", message: "Room is not in game" };
  const replayed: CommandResult = {
    ok: true,
    events: result.events ?? [],
    state,
    replayed: true,
  };
  if (result.seqStart !== undefined) replayed.seqStart = result.seqStart;
  if (result.seqEnd !== undefined) replayed.seqEnd = result.seqEnd;
  return replayed;
};
