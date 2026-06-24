import type { GameConfig, PlayerId } from "@colonizt/game-core";
import { isLobbySeatOccupied, isLobbySeatReadyToStart, lobbyReadiness } from "@colonizt/protocol";
import type { Room, RoomSettings, Seat } from "./room-manager.js";

export type LobbySettingsUpdate = Partial<Omit<RoomSettings, "mode">>;
export type PublicSeat = Seat & { displayName?: string };

export const publicSeatsForRoom = (room: Room, displayNameForUser: (userId: PlayerId) => string): PublicSeat[] =>
  room.seats.map((seat) => ({
    ...seat,
    ...(seat.userId ? { displayName: seat.displayName ?? displayNameForUser(seat.userId) } : {}),
    ...(seat.botId ? { displayName: `Bot ${seat.seatIndex + 1}` } : {}),
  }));

export const readyConnected = (seat: Seat): boolean =>
  isLobbySeatReadyToStart(seat);

export const startableSeatsForRoom = (room: Room): Seat[] =>
  room.seats.filter(readyConnected);

export const canStartLobby = (room: Room): boolean => {
  if (room.status !== "LOBBY") return false;
  if (room.settings.botFill) return room.seats.every((seat) => isLobbySeatOccupied(seat) && readyConnected(seat));
  const minPlayers = room.settings.minPlayers ?? 2;
  return lobbyReadiness(room.seats, minPlayers).canStart;
};

const mergeRules = (
  current: GameConfig["rules"] | undefined,
  update: GameConfig["rules"] | undefined,
): GameConfig["rules"] | undefined => {
  if (!update) return current;
  return {
    ...current,
    ...update,
    ...(update.mapPreset ? { mapRandomized: true } : {}),
  };
};

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
};

const comparableSettings = (settings: RoomSettings): RoomSettings => ({
  ...settings,
  ...(settings.rules?.mapPreset ? { rules: { ...settings.rules, mapRandomized: true } } : {}),
});

const sameSettings = (left: RoomSettings, right: RoomSettings): boolean =>
  JSON.stringify(stableValue(comparableSettings(left))) === JSON.stringify(stableValue(comparableSettings(right)));

export const applyLobbySettings = (
  room: Room,
  settings: LobbySettingsUpdate,
): { ok: true; seats: Seat[]; settings: RoomSettings } | { ok: false; code: string; message: string } => {
  const occupied = room.seats.filter(isLobbySeatOccupied);
  const nextMaxPlayers = settings.maxPlayers ?? room.settings.maxPlayers ?? room.seats.length;
  const nextMinPlayers = settings.minPlayers ?? room.settings.minPlayers ?? 2;
  if (!Number.isInteger(nextMaxPlayers) || nextMaxPlayers < 2 || nextMaxPlayers > 4) {
    return { ok: false, code: "INVALID_ROOM_SETTINGS", message: "Max players must be between 2 and 4" };
  }
  if (!Number.isInteger(nextMinPlayers) || nextMinPlayers < 2 || nextMinPlayers > 4 || nextMinPlayers > nextMaxPlayers) {
    return { ok: false, code: "INVALID_ROOM_SETTINGS", message: "Min players must be between 2 and max players" };
  }
  if (occupied.length > nextMaxPlayers) {
    return { ok: false, code: "ROOM_HAS_TOO_MANY_PLAYERS", message: "Cannot shrink below occupied seats" };
  }
  if (occupied.some((seat) => seat.seatIndex >= nextMaxPlayers)) {
    return { ok: false, code: "ROOM_HAS_OCCUPIED_CLOSED_SEAT", message: "Remove players or bots from seats before closing them" };
  }

  const nextSeats = room.seats.slice(0, nextMaxPlayers);
  while (nextSeats.length < nextMaxPlayers) {
    nextSeats.push({ seatIndex: nextSeats.length, ready: false, connected: false });
  }
  const nextRules = mergeRules(room.settings.rules, settings.rules);
  const nextSettings = {
    ...room.settings,
    ...settings,
    mode: room.settings.mode,
    minPlayers: nextMinPlayers,
    maxPlayers: nextMaxPlayers,
    ...(nextRules ? { rules: nextRules } : {}),
  };
  const settingsChanged = !sameSettings(room.settings, nextSettings);
  const seatCountChanged = nextSeats.length !== room.seats.length;

  return {
    ok: true,
    seats: nextSeats.map((seat, index) => ({
      ...seat,
      seatIndex: index,
      ready: seat.botId ? true : settingsChanged || seatCountChanged ? false : seat.ready,
      connected: seat.botId ? true : seat.connected,
    })),
    settings: nextSettings,
  };
};
