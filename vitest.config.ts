import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 15000,
    hookTimeout: 30000,
    globalSetup: "./tests/setup.ts",
    include: ["tests/**/*.test.ts"],
  },
});
