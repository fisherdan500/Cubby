import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    // .tsx tests render components in jsdom via their own `// @vitest-environment jsdom` pragma, so
    // the default stays node and only the files that need a DOM pay for one.
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"]
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url))
    }
  },
  // Component tests render JSX without importing React in every file. automatic is what Next itself
  // uses, so the tests compile the same way the app does.
  esbuild: {
    jsx: "automatic"
  }
});
