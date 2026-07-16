import { describe, expect, it } from "vitest";
import { applyCommand, canBuildRoad, getLegalActions } from "@colonizt/game-core";
import { createDemoGame } from "@colonizt/demo-state";
import {
  acceptedStoredCommandResult,
  commandIdempotencyKey,
  commandPayloadHash,
  rejectedStoredCommandResult,
  replayStoredCommandResult,
} from "../src/command-idempotency.js";

describe("command idempotency policy", () => {
  const setupCommand = () => {
    const state = createDemoGame("idempotency-policy");
    const vertexId = getLegalActions(state, "p1").find((action) => action.type === "PLACE_SETUP")?.vertices[0];
    if (!vertexId) throw new Error("Expected a legal setup vertex");
    const edgeId = state.board.adjacency.vertexToEdges[vertexId]?.find((candidate) => canBuildRoad(state, "p1", candidate, vertexId));
    if (!edgeId) throw new Error("Expected a legal setup edge");
    const result = applyCommand(state, { type: "PLACE_SETUP", playerId: "p1", vertexId, edgeId });
    if (!result.ok) throw new Error(result.error.message);
    return { state, command: { type: "PLACE_SETUP", playerId: "p1", vertexId, edgeId } as const, result };
  };

  it("builds an unambiguous key and a stable payload hash", () => {
    const { command } = setupCommand();
    expect(commandIdempotencyKey("room_1", "user_2", 17)).toBe("room_1:user_2:17");
    expect(commandPayloadHash(command)).toBe(commandPayloadHash({ ...command }));
    expect(commandPayloadHash(command)).not.toBe(commandPayloadHash({ ...command, vertexId: "v_other" }));
  });

  it("captures accepted event bounds and replays the original response", () => {
    const { state, command, result } = setupCommand();
    const stored = acceptedStoredCommandResult({
      roomId: "room_1",
      matchId: state.config.matchId,
      userId: "p1",
      clientSeq: 3,
      commandHash: commandPayloadHash(command),
      events: result.value.events,
    });

    expect(stored.seqStart).toBe(result.value.events[0]?.seq);
    expect(stored.seqEnd).toBe(result.value.events.at(-1)?.seq);
    expect(replayStoredCommandResult(result.value.nextState, stored, stored.commandHash)).toMatchObject({
      ok: true,
      replayed: true,
      events: result.value.events,
      state: result.value.nextState,
      seqStart: stored.seqStart,
      seqEnd: stored.seqEnd,
    });
  });

  it("does not invent sequence bounds for accepted commands without events", () => {
    const stored = acceptedStoredCommandResult({
      roomId: "room_1",
      matchId: "match_1",
      userId: "p1",
      clientSeq: 4,
      commandHash: "hash",
      events: [],
    });
    expect(stored.seqStart).toBeUndefined();
    expect(stored.seqEnd).toBeUndefined();
    const state = createDemoGame("idempotency-no-events");
    const replayed = replayStoredCommandResult(state, { ...stored, events: undefined }, "hash");
    expect(replayed).toEqual({
      ok: true,
      replayed: true,
      events: [],
      state,
    });
    expect("seqStart" in replayed).toBe(false);
    expect("seqEnd" in replayed).toBe(false);
  });

  it("replays stored rejections with safe fallbacks", () => {
    const rejected = rejectedStoredCommandResult({
      roomId: "room_1",
      matchId: "match_1",
      userId: "p1",
      clientSeq: 5,
      commandHash: "hash",
      code: "INVALID_PHASE",
      message: "Wrong phase",
    });
    expect(replayStoredCommandResult(undefined, rejected, "hash")).toEqual({ ok: false, code: "INVALID_PHASE", message: "Wrong phase" });
    expect(replayStoredCommandResult(undefined, { ...rejected, rejectionCode: undefined, rejectionMessage: undefined }, "hash"))
      .toEqual({ ok: false, code: "COMMAND_REJECTED", message: "Command was rejected" });
  });

  it("rejects sequence reuse for a different payload before considering room state", () => {
    const stored = rejectedStoredCommandResult({
      roomId: "room_1",
      matchId: "match_1",
      userId: "p1",
      clientSeq: 6,
      commandHash: "original",
      code: "INVALID_PHASE",
      message: "Wrong phase",
    });
    expect(replayStoredCommandResult(undefined, stored, "different")).toEqual({
      ok: false,
      code: "CLIENT_SEQ_CONFLICT",
      message: "Client sequence was already used for a different command",
    });
  });

  it("reports a missing active game for a matching accepted result", () => {
    const stored = acceptedStoredCommandResult({
      roomId: "room_1",
      matchId: "match_1",
      userId: "p1",
      clientSeq: 7,
      commandHash: "hash",
      events: [],
    });
    expect(replayStoredCommandResult(undefined, stored, "hash")).toEqual({
      ok: false,
      code: "ROOM_NOT_IN_GAME",
      message: "Room is not in game",
    });
  });
});
