import { defineConfig } from "vitest/config";
import swc from "unplugin-swc";

export default defineConfig({
  plugins: [
    swc.vite({
      module: { type: "es6" },
      jsc: {
        target: "es2022",
        parser: { syntax: "typescript", decorators: true },
        transform: {
          legacyDecorator: true,
          decoratorMetadata: true,
        },
      },
    }),
  ],
  test: {
    globals: true,
    testTimeout: 15000,
    setupFiles: ["src-v2/test-setup.ts"],
    include: ["src-v2/**/*.spec.ts", "src-v2/**/*.e2e-spec.ts"],
    pool: "forks",
  },
});
