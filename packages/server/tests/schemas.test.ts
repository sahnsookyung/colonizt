import { describe, expect, it } from "vitest";
import { createRoomSchema, wsClientMessageSchema } from "../src/schemas.js";

describe("WebSocket schemas", () => {
  it("rejects invalid payloads before game-core", () => {
    expect(wsClientMessageSchema.safeParse({ type: "COMMAND", roomId: "r", clientSeq: 1, command: { type: "NOPE" } }).success).toBe(false);
  });

  it("accepts valid ping and command messages", () => {
    expect(wsClientMessageSchema.safeParse({ type: "PING", nonce: "n" }).success).toBe(true);
    expect(wsClientMessageSchema.safeParse({ type: "COMMAND", roomId: "r", clientSeq: 1, command: { type: "ROLL_DICE", playerId: "p1" } }).success).toBe(true);
  });

  it("accepts explicit room leave messages", () => {
    expect(wsClientMessageSchema.safeParse({ type: "LEAVE_ROOM", roomId: "ABC123" }).success).toBe(true);
  });

  it("accepts bot difficulty and optional rule room settings", () => {
    const parsed = createRoomSchema.safeParse({
      mode: "CLASSIC",
      botFill: true,
      ranked: false,
      minPlayers: 4,
      maxPlayers: 4,
      botDifficulty: "hard",
      rules: { diceDoubles: true, plight: true, plightTurn: 20, mapPreset: "continent" },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.botDifficulty).toBe("hard");
      expect(parsed.data.minPlayers).toBe(4);
      expect(parsed.data.maxPlayers).toBe(4);
      expect(parsed.data.rules).toMatchObject({ diceDoubles: true, plight: true, plightTurn: 20, mapPreset: "continent" });
    }
  });

  it("rejects invalid map presets", () => {
    expect(createRoomSchema.safeParse({ mode: "CLASSIC", botFill: true, ranked: false, rules: { mapPreset: "archipelago" } }).success).toBe(false);
  });

  it("accepts standard map presets without legacy mapRandomized flags", () => {
    expect(createRoomSchema.safeParse({ mode: "CLASSIC", botFill: true, ranked: false, rules: { mapPreset: "standard" } }).success).toBe(true);
  });

  it("rejects impossible player-room start thresholds", () => {
    expect(createRoomSchema.safeParse({ mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 1 }).success).toBe(false);
    expect(createRoomSchema.safeParse({ mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 5 }).success).toBe(false);
    expect(createRoomSchema.safeParse({ mode: "CLASSIC", botFill: false, ranked: false, maxPlayers: 1 }).success).toBe(false);
    expect(createRoomSchema.safeParse({ mode: "CLASSIC", botFill: false, ranked: false, maxPlayers: 5 }).success).toBe(false);
    expect(createRoomSchema.safeParse({ mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 4, maxPlayers: 2 }).success).toBe(false);
  });
});
