import { describe, expect, it } from "vitest";
import { createAnalyticsRecord, createChatMessage, createModerationReport } from "../src/room-content.js";
import type { Room, Session } from "../src/room-manager.js";

const session: Session = { token: "token", userId: "p1", displayName: "Player" };
const room = { id: "room-content" } as Room;

describe("room content records", () => {
  it("creates deterministic hand-safe chat, moderation, and analytics records", () => {
    expect(createChatMessage(session, "hello", 1_000, "chat-fixed")).toEqual({
      id: "chat-fixed", userId: "p1", message: "hello", createdAt: new Date(1_000).toISOString(),
    });
    expect(createModerationReport(room, session, "p2", "abuse", "report-fixed")).toEqual({
      id: "report-fixed", reporterUserId: "p1", reportedUserId: "p2", roomId: "room-content", reason: "abuse", status: "OPEN",
    });
    expect(createAnalyticsRecord({ userId: "p1", matchId: "match-1", eventName: "game_started", payload: { mode: "local" } }, "analytics-fixed")).toEqual({
      id: "analytics-fixed", userId: "p1", matchId: "match-1", eventName: "game_started", payload: { mode: "local" },
    });
  });
});
