import { describe, expect, it } from "vitest";
import { noOpRoomDiagnostics } from "../src/room-diagnostics.js";

describe("no-op room diagnostics", () => {
  it("accepts every diagnostic signal when metrics are intentionally disabled", () => {
    expect(() => {
      noOpRoomDiagnostics.recordHydration("full_replay");
      noOpRoomDiagnostics.recordStoreValidationFailure("room");
      noOpRoomDiagnostics.recordCommandConflict("accepted");
      noOpRoomDiagnostics.recordAutomationPause("stalled");
    }).not.toThrow();
  });
});
