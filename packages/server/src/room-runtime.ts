import type { GameState, PlayerId } from "@colonizt/game-core";
import type { Room, RoomLivenessState } from "./room-manager.js";

export const connectedSeatedHumanCount = (room: Pick<Room, "seats">): number =>
  room.seats.filter((seat) => seat.userId && seat.connected).length;

export const connectedUserCount = (room: Pick<Room, "seats" | "spectators">): number => {
  const connectedIds = new Set<PlayerId>();
  for (const seat of room.seats) {
    if (seat.userId && seat.connected) connectedIds.add(seat.userId);
  }
  for (const spectatorId of room.spectators) connectedIds.add(spectatorId);
  return connectedIds.size;
};

export const isActiveRoom = (room: Pick<Room, "archivedAt" | "status">): boolean =>
  !room.archivedAt && room.status !== "EXPIRED" && room.status !== "ABANDONED";

export const livenessStateForRoom = (room: Room): RoomLivenessState => {
  if (room.archivedAt && room.cleanupReason === "FINISHED_UNLOADED") return "FINISHED_UNLOADED";
  if (room.archivedAt || room.status === "EXPIRED" || room.status === "ABANDONED") return "CLOSED";
  if (room.pauseReason === "STALLED_AUTOMATION") return "STALLED";
  if (room.pausedAt) return "PAUSED_EMPTY";
  if (room.status === "LOBBY" && connectedSeatedHumanCount(room) === 0) return "IDLE_LOBBY";
  return "ACTIVE";
};

export const roomTimerKey = (state?: GameState): string | undefined => {
  if (!state || !("activePlayerId" in state.phase)) return undefined;
  return `${state.config.matchId}:${state.turn}:${state.phase.type}:${state.phase.activePlayerId}`;
};
