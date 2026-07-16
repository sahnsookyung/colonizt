export type HydrationOutcome = "room_only" | "full_replay" | "snapshot" | "snapshot_fallback" | "failure";

export interface RoomDiagnostics {
  recordHydration(outcome: HydrationOutcome): void;
  recordStoreValidationFailure(recordType: "room" | "command_result"): void;
  recordCommandConflict(path: "accepted" | "rejected"): void;
  recordAutomationPause(reason: "budget" | "stalled"): void;
}

export const noOpRoomDiagnostics: RoomDiagnostics = {
  recordHydration: () => undefined,
  recordStoreValidationFailure: () => undefined,
  recordCommandConflict: () => undefined,
  recordAutomationPause: () => undefined,
};
