import { describe, expect, it } from "vitest";
import { createDemoGame, withResources } from "@colonizt/demo-state";
import { emptyResources, resourceCount, schemaVersion, serializeForViewer, type GameEvent } from "@colonizt/game-core";
import { applyEventsToViewerProjection, projectViewerToGameState } from "../src/viewer-projection.js";

describe("viewer projection", () => {
  it("keeps viewer resources while redacting opponent resources in projected UI state", () => {
    let state = createDemoGame("viewer-projection");
    state = withResources(state, "p1", { timber: 2, brick: 1 });
    state = withResources(state, "p2", { ore: 3 });

    const viewer = serializeForViewer(state, "p1");
    const projected = projectViewerToGameState(viewer, "room-projection");

    expect(projected.players.p1?.resources).toMatchObject({ timber: 2, brick: 1 });
    expect(projected.players.p2?.resources).toEqual(emptyResources());
    expect(viewer.players.find((player) => player.id === "p2")?.resources).toBeUndefined();
  });

  it("updates hidden opponent resource counts from redacted events without exposing cards", () => {
    const state = createDemoGame("viewer-projection-events");
    const viewer = serializeForViewer(state, "p1");
    const event: GameEvent = {
      schemaVersion,
      seq: 1,
      type: "RESOURCES_PRODUCED",
      gains: {
        p2: { ore: 2 },
      },
    };

    const projected = applyEventsToViewerProjection(viewer, [event], "room-projection", "p1");
    const opponent = projected.players.find((player) => player.id === "p2");

    expect(opponent?.resources).toBeUndefined();
    expect(opponent?.resourceCount).toBe(resourceCount({ ...emptyResources(), ore: 2 }));
  });
});
