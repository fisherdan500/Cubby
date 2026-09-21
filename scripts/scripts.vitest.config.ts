import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The self-contained tests that live beside the scripts they cover. The main suite only looks inside
 * `src`, so these ran only when someone remembered the exact `npx vitest run --config ...` line for
 * each one; `npm run test:scripts` is a gate that runs them all.
 *
 * Excluded are the tests a rehearsal runs inside its own disposable environment: those need a database
 * and are covered by the rehearsal gates instead.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/**/*.test.ts"],
    exclude: ["**/node_modules/**", "scripts/**/*.integration.test.ts", "scripts/**/*.acceptance*.test.ts"]
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) }
  }
});
