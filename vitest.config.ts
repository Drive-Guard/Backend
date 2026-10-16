import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["test/global.ts"],
    setupFiles: ["test/setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    // Os testes escrevem no mesmo banco: um arquivo por vez.
    fileParallelism: false,
    pool: "forks",
  },
});
