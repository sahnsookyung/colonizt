import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/**/*.test.ts", "packages/**/*.test.tsx"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.{ts,tsx}"],
      exclude: [
        "packages/db/src/migrate.ts",
        "packages/web/src/main.tsx",
      ],
      thresholds: {
        statements: 95,
        branches: 85,
        functions: 95.5,
        lines: 95.5,
      },
    },
  },
});
