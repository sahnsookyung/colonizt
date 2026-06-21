import { describe, expect, it } from "vitest";
import { runConcurrentBotRooms } from "../../../scripts/concurrent-bot-rooms.js";

describe("concurrent bot room isolation", () => {
  it("runs five simultaneous four-bot rooms to completion without cross-room state interference", async () => {
    const summary = await runConcurrentBotRooms();

    expect(summary).toMatchObject({ ok: true, roomCount: 5, botsPerRoom: 4, totalBots: 20 });
    expect(summary.rooms).toHaveLength(5);
    expect(new Set(summary.rooms.map((room) => room.roomId)).size).toBe(5);
    expect(new Set(summary.rooms.flatMap((room) => room.botIds)).size).toBe(20);
    expect(summary.rooms.every((room) => room.events > 0 && room.turns > 0)).toBe(true);
  }, 30_000);
});
