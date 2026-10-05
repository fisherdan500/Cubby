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
    include: [
      "scripts/backup-recovery-rehearsal.test.ts",
      "scripts/backup-recovery-rehearsal.integration.test.ts",
      "scripts/backup-matrix-rehearsal.integration.test.ts",
      "scripts/backup-scale-rehearsal.integration.test.ts",
      "scripts/reports-equivalence.integration.test.ts",
      "scripts/moment-notifications.integration.test.ts"
    ],
    // The scale rehearsal seeds and restores thousands of entries, so its own hooks and cases declare
    // longer budgets individually. These defaults stay tight enough that an ordinary rehearsal hanging
    // is still reported as a failure rather than waiting ten minutes.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } }
  },
  resolve: { alias: aliases }
});
