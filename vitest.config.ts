import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 15000,
    hookTimeout: 30000,
    globalSetup: "./tests/setup.ts",
    setupFiles: ["./tests/worker-setup.ts"],
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/integration/**"],
    pool: "forks",
    fileParallelism: false,
    sequence: {
      // Run unit tests before E2E
      files: "list",
    },
  },
});
