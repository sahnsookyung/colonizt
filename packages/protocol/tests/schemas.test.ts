import { describe, expect, it } from "vitest";
import { createRoomSchema, lobbyReadiness, protocolVersion, wsClientMessageSchema, websocketAuthMode } from "../src/index.js";

describe("protocol schemas", () => {
  it("keeps protocol constants explicit", () => {
    expect(protocolVersion).toBe(3);
    expect(websocketAuthMode).toBe("ticket");
  });

  it("rejects invalid websocket payloads before game-core", () => {
    expect(wsClientMessageSchema.safeParse({ type: "COMMAND", roomId: "r", clientSeq: 1, command: { type: "NOPE" } }).success).toBe(false);
  });

  it("accepts valid ping and command messages", () => {
    expect(wsClientMessageSchema.safeParse({ type: "PING", nonce: "n" }).success).toBe(true);
    expect(wsClientMessageSchema.safeParse({ type: "COMMAND", roomId: "r", clientSeq: 1, command: { type: "ROLL_DICE", playerId: "p1" } }).success).toBe(true);
    expect(wsClientMessageSchema.safeParse({ type: "COMMAND", roomId: "r", clientSeq: 2, command: { type: "MOVE_THIEF", playerId: "p1", hexId: "h1" } }).success).toBe(true);
    expect(wsClientMessageSchema.safeParse({ type: "COMMAND", roomId: "r", clientSeq: 3, command: { type: "PLAY_YEAR_OF_PLENTY", playerId: "p1", cardId: "c1", resources: ["grain", "ore"] } }).success).toBe(true);
  });

  it("accepts lobby control websocket messages", () => {
    expect(wsClientMessageSchema.safeParse({ type: "START_ROOM", roomId: "ABC123" }).success).toBe(true);
    expect(wsClientMessageSchema.safeParse({ type: "ADD_BOT", roomId: "ABC123" }).success).toBe(true);
    expect(wsClientMessageSchema.safeParse({ type: "REMOVE_BOT", roomId: "ABC123", seatIndex: 2 }).success).toBe(true);
    expect(wsClientMessageSchema.safeParse({ type: "REMOVE_BOT", roomId: "ABC123", seatIndex: 4 }).success).toBe(false);
    expect(wsClientMessageSchema.safeParse({ type: "UPDATE_DISPLAY_NAME", displayName: "Ada" }).success).toBe(true);
    expect(wsClientMessageSchema.safeParse({
      type: "UPDATE_ROOM_SETTINGS",
      roomId: "ABC123",
      settings: { minPlayers: 2, maxPlayers: 4, botDifficulty: "hard", rules: { mapPreset: "continent" } },
    }).success).toBe(true);
    expect(wsClientMessageSchema.safeParse({ type: "UPDATE_ROOM_SETTINGS", roomId: "ABC123", settings: { minPlayers: 4, maxPlayers: 2 } }).success).toBe(false);
  });

  it("accepts bot difficulty and optional rule room settings", () => {
    const parsed = createRoomSchema.safeParse({
      mode: "CLASSIC",
      botFill: true,
      ranked: false,
      minPlayers: 4,
      botDifficulty: "hard",
      rules: { diceDoubles: true, plight: true, plightTurn: 20, mapPreset: "islands", maxTurns: 100, maxTurnAdjudication: "leader" },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.botDifficulty).toBe("hard");
      expect(parsed.data.minPlayers).toBe(4);
      expect(parsed.data.rules).toMatchObject({ diceDoubles: true, plight: true, plightTurn: 20, mapPreset: "islands", maxTurns: 100, maxTurnAdjudication: "leader" });
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
  });

  it("computes lobby readiness from connected ready humans and bots", () => {
    const seats = [
      { seatIndex: 0, userId: "u1", ready: true, connected: true },
      { seatIndex: 1, userId: "u2", ready: true, connected: true },
      { seatIndex: 2, botId: "bot_3", ready: true, connected: true },
      { seatIndex: 3, userId: "u4", ready: false, connected: false },
    ];

    expect(lobbyReadiness(seats, 2)).toMatchObject({
      readyCount: 3,
      occupiedCount: 4,
      connectedOccupiedCount: 3,
      canStart: true,
    });
    expect(lobbyReadiness([{ ...seats[0]!, ready: true }, { ...seats[1]!, ready: false }], 2).canStart).toBe(false);
  });
});
