import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["test/**/*.test.ts", "eval/**/*.test.ts"],
    testTimeout: 30000,
    pool: "forks",
    poolOptions: {
      forks: { maxForks: 4 },
    },
  },
});
