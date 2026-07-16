import { nanoid } from "nanoid";
import type { ChatMessage, Report, Room, Session } from "./room-manager.js";

export const createChatMessage = (
  session: Session,
  message: string,
  now = Date.now(),
  id = `chat_${nanoid(8)}`,
): ChatMessage => ({ id, userId: session.userId, message, createdAt: new Date(now).toISOString() });

export const createModerationReport = (
  room: Room,
  reporter: Session,
  reportedUserId: string,
  reason: string,
  id = `report_${nanoid(8)}`,
): Report => ({ id, reporterUserId: reporter.userId, reportedUserId, roomId: room.id, reason, status: "OPEN" });

export const createAnalyticsRecord = (
  event: { userId?: string; matchId?: string; eventName: string; payload: unknown },
  id = `analytics_${nanoid(10)}`,
) => ({ id, ...event });
