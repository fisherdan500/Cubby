import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rehearsalPrismaClientPath = process.env.REHEARSAL_PRISMA_CLIENT_PATH;
const aliases = [
  { find: "@", replacement: fileURLToPath(new URL("../src", import.meta.url)) },
  ...(rehearsalPrismaClientPath ? [{ find: /^@prisma\/client$/, replacement: rehearsalPrismaClientPath }] : [])
];

export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/performance-budgets-fixture.ts"],
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    // Five years of history is a large seed; the default 5s per-test timeout is for unit tests.
    testTimeout: 600_000,
    hookTimeout: 600_000
  },
  resolve: { alias: aliases }
});
