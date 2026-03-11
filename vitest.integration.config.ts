import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30000,
    hookTimeout: 30000,
    include: ["tests/integration/**/*.test.ts"],
    pool: "forks",
    fileParallelism: false,
  },
});
