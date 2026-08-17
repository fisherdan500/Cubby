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
      "scripts/backup-recovery-rehearsal.integration.test.ts"
    ],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } }
  },
  resolve: { alias: aliases }
});
