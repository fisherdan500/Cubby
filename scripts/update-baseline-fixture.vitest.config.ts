import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/update-baseline-fixture.ts"],
    pool: "forks",
    poolOptions: { forks: { singleFork: true } }
  },
  resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } }
});
