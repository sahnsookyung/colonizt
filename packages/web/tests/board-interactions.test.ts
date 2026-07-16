import { describe, expect, it } from "vitest";
import { createDemoGame } from "@colonizt/demo-state";
import { boardBounds, firstStealTarget, roadBuildingCandidateEdgesFor } from "../src/board-interactions.js";

describe("board interaction policy", () => {
  it("offers unique first roads and only compatible continuations", () => {
    const options = [["e1", "e2"], ["e1", "e3"], ["e4", "e5"], ["e4", "e5"]];
    expect(roadBuildingCandidateEdgesFor(options, [], 2)).toEqual(["e1", "e4"]);
    expect(roadBuildingCandidateEdgesFor(options, ["e1"], 2)).toEqual(["e2", "e3"]);
    expect(roadBuildingCandidateEdgesFor(options, ["e1", "e2"], 2)).toEqual([]);
  });

  it("computes a padded view box around every board vertex", () => {
    const state = createDemoGame("board-bounds");
    const vertices = Object.values(state.board.vertices);
    const bounds = boardBounds(state);
    expect(bounds.minX).toBeCloseTo(Math.min(...vertices.map((vertex) => vertex.x)) - 1.1);
    expect(bounds.minY).toBeCloseTo(Math.min(...vertices.map((vertex) => vertex.y)) - 1.1);
    expect(bounds.minX + bounds.width).toBeCloseTo(Math.max(...vertices.map((vertex) => vertex.x)) + 1.1);
    expect(bounds.minY + bounds.height).toBeCloseTo(Math.max(...vertices.map((vertex) => vertex.y)) + 3);
  });

  it("chooses the highest-pressure robber victim with stable turn-order ties", () => {
    const state = createDemoGame("steal-target-ranking");
    const hex = Object.values(state.board.hexes).find((candidate) => candidate.id !== state.thiefHexId && (state.board.adjacency.hexToVertices[candidate.id]?.length ?? 0) >= 2);
    if (!hex) throw new Error("Expected a non-robber hex");
    const vertices = state.board.adjacency.hexToVertices[hex.id]!;
    state.settlements[vertices[0]!] = "p2";
    state.settlements[vertices[1]!] = "p3";
    state.players.p2!.resources.ore = 2;
    state.players.p3!.resources.ore = 1;
    state.players.p3!.score = 2;
    expect(firstStealTarget(state, "p1", hex.id)).toBe("p3");

    state.players.p2!.score = 2;
    state.players.p2!.resources.ore = 1;
    expect(firstStealTarget(state, "p1", hex.id)).toBe("p2");
  });
});
