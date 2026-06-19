import { describe, expect, it } from "vitest";
import { createRoomSchema, protocolVersion, wsClientMessageSchema, websocketAuthMode } from "../src/index.js";

describe("protocol schemas", () => {
  it("keeps protocol constants explicit", () => {
    expect(protocolVersion).toBe(2);
    expect(websocketAuthMode).toBe("ticket");
  });

  it("rejects invalid websocket payloads before game-core", () => {
    expect(wsClientMessageSchema.safeParse({ type: "COMMAND", roomId: "r", clientSeq: 1, command: { type: "NOPE" } }).success).toBe(false);
  });

  it("accepts valid ping and command messages", () => {
    expect(wsClientMessageSchema.safeParse({ type: "PING", nonce: "n" }).success).toBe(true);
    expect(wsClientMessageSchema.safeParse({ type: "COMMAND", roomId: "r", clientSeq: 1, command: { type: "ROLL_DICE", playerId: "p1" } }).success).toBe(true);
  });

  it("accepts bot difficulty and optional rule room settings", () => {
    const parsed = createRoomSchema.safeParse({
      mode: "CLASSIC",
      botFill: true,
      ranked: false,
      minPlayers: 4,
      botDifficulty: "hard",
      rules: { diceDoubles: true, plight: true, plightTurn: 20 },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.botDifficulty).toBe("hard");
      expect(parsed.data.minPlayers).toBe(4);
      expect(parsed.data.rules).toMatchObject({ diceDoubles: true, plight: true, plightTurn: 20 });
    }
  });

  it("rejects impossible player-room start thresholds", () => {
    expect(createRoomSchema.safeParse({ mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 1 }).success).toBe(false);
    expect(createRoomSchema.safeParse({ mode: "CLASSIC", botFill: false, ranked: false, minPlayers: 5 }).success).toBe(false);
  });
});
