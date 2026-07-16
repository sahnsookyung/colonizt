import type { Room, RoomCleanupPolicy } from "./room-manager.js";
import { connectedSeatedHumanCount, connectedUserCount, isActiveRoom } from "./room-runtime.js";

export const cleanupDueAt = (room: Room, policy: RoomCleanupPolicy, now = Date.now()): number => {
  if (!isActiveRoom(room)) return Number.POSITIVE_INFINITY;
  const connectedSeatedHumans = connectedSeatedHumanCount(room);
  if (room.status === "LOBBY" && connectedSeatedHumans === 0) {
    return room.emptySince ? Date.parse(room.emptySince) + policy.emptyLobbyTtlMs : now;
  }
  if (room.status === "IN_GAME" && connectedSeatedHumans === 0) {
    return room.emptySince ? Date.parse(room.emptySince) + policy.emptyGameTtlMs : now;
  }
  if (room.status === "FINISHED" && connectedUserCount(room) === 0) {
    return room.emptySince ? Date.parse(room.emptySince) + policy.finishedRoomUnloadMs : now;
  }
  return Number.POSITIVE_INFINITY;
};

export const resumeRoomIfNeeded = (room: Room, now = Date.now()): boolean => {
  if (room.pauseReason === "STALLED_AUTOMATION") return false;
  if (!room.pausedAt) {
    if (room.emptySince && connectedSeatedHumanCount(room) > 0) {
      delete room.emptySince;
      return true;
    }
    return false;
  }
  if (connectedSeatedHumanCount(room) === 0) return false;
  const pausedDuration = Math.max(0, now - Date.parse(room.pausedAt));
  if (room.timer) room.timer.expiresAt += pausedDuration;
  for (const [tradeId, deadline] of room.tradeResponseDeadlines.entries()) {
    room.tradeResponseDeadlines.set(tradeId, deadline + pausedDuration);
  }
  delete room.pausedAt;
  delete room.pauseReason;
  delete room.emptySince;
  return true;
};

export const applyRoomCleanupPolicy = (room: Room, policy: RoomCleanupPolicy, now = Date.now()): boolean => {
  const nowIso = new Date(now).toISOString();
  const connectedSeatedHumans = connectedSeatedHumanCount(room);
  const connectedUsers = connectedUserCount(room);
  let changed = false;

  if (room.status === "LOBBY") {
    if (connectedSeatedHumans === 0) {
      if (!room.emptySince) {
        room.emptySince = nowIso;
        changed = true;
      }
      if (now - Date.parse(room.emptySince) >= policy.emptyLobbyTtlMs) {
        room.status = "EXPIRED";
        room.cleanupReason = "EMPTY_LOBBY_TTL";
        room.archivedAt = nowIso;
        changed = true;
      }
    } else if (room.emptySince) {
      delete room.emptySince;
      changed = true;
    }
  } else if (room.status === "IN_GAME") {
    if (connectedSeatedHumans === 0) {
      if (!room.emptySince) {
        room.emptySince = nowIso;
        changed = true;
      }
      if (!room.pausedAt) {
        room.pausedAt = nowIso;
        room.pauseReason = "EMPTY_ROOM";
        changed = true;
      }
      if (now - Date.parse(room.emptySince) >= policy.emptyGameTtlMs) {
        room.status = "ABANDONED";
        room.cleanupReason = "EMPTY_GAME_TTL";
        room.archivedAt = nowIso;
        changed = true;
      }
    } else if (resumeRoomIfNeeded(room, now)) {
      changed = true;
    }
  } else if (room.status === "FINISHED") {
    if (connectedUsers === 0) {
      if (!room.emptySince) {
        room.emptySince = nowIso;
        changed = true;
      }
      if (now - Date.parse(room.emptySince) >= policy.finishedRoomUnloadMs) {
        room.cleanupReason = "FINISHED_UNLOADED";
        room.archivedAt = nowIso;
        changed = true;
      }
    } else if (room.emptySince) {
      delete room.emptySince;
      changed = true;
    }
  }

  return changed;
};
