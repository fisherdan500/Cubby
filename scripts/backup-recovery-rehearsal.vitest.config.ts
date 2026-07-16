import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/backup-recovery-rehearsal.integration.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } }
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) }
  }
});
