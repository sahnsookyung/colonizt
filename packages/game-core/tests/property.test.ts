import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { assertInvariants, createSeededBoard, replay, validateBoard } from "../src/index.js";
import { createDemoConfig, playBotGame } from "@colonizt/test-utils";

describe("property checks", () => {
  it("generated boards are valid and playable-shaped", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 24 }), (seed) => {
        const board = createSeededBoard(seed);
        expect(validateBoard(board)).toEqual([]);
        expect(Object.keys(board.vertices).length).toBeGreaterThan(8);
        expect(Object.keys(board.edges).length).toBeGreaterThan(8);
      }),
      { numRuns: 50 },
    );
  });

  it("random bot games preserve invariants and replay determinism", () => {
    const options = {
      botDifficulty: "easy" as const,
      botProfiles: {
        p1: "random" as const,
        p2: "random" as const,
        p3: "random" as const,
        p4: "random" as const,
      },
    };
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 24 }), (seed) => {
        const played = playBotGame(seed, 160, options);
        expect(assertInvariants(played.state).ok).toBe(true);
        const replayed = replay({ config: createDemoConfig(seed, options), board: played.state.board, events: played.events });
        expect(replayed).toEqual(played.state);
      }),
      { numRuns: 50 },
    );
  }, 240_000);
});
