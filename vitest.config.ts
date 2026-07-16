import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/**/*.test.ts", "packages/**/*.test.tsx"],
    coverage: {
      provider: "v8",
      thresholds: {
        statements: 95,
        branches: 85,
        functions: 95.5,
        lines: 95.5,
      },
    },
  },
});
