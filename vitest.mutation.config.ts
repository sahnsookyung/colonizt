import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "packages/game-core/tests/engine.test.ts",
      "packages/game-core/tests/invariants.test.ts",
      "packages/server/tests/command-idempotency.test.ts",
      "packages/server/tests/replay-hydration.test.ts",
      "packages/server/tests/room-lifecycle.test.ts",
    ],
  },
});
