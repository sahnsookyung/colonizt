import type { GameEvent, GameState } from "@colonizt/game-core";
import type { EventStore, StoredCommandResult } from "./event-store.js";
import type { Room } from "./room-manager.js";

export const persistAcceptedEvents = async (
  eventStore: EventStore,
  room: Room,
  nextState: GameState,
  events: GameEvent[],
  commandResult?: StoredCommandResult,
): Promise<void> => {
  if (eventStore.commitEvents) {
    await eventStore.commitEvents(room, events, commandResult);
    return;
  }
  await eventStore.appendEvents(room, events);
  if (commandResult) await eventStore.persistCommandResult?.(commandResult);
  if (nextState.phase.type === "GAME_OVER") await eventStore.markFinished(room, nextState.phase.winnerId);
  else await eventStore.persistRoom(room);
};
