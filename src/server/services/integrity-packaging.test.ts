import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("integrity command packaging", () => {
  it("bundles the command during build and copies it into the runner image", async () => {
    const root = process.cwd();
    const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const dockerfile = await readFile(path.join(root, "Dockerfile"), "utf8");

    expect(packageJson.scripts["build:integrity"]).toContain("scripts/integrity-check.ts");
    expect(packageJson.scripts.build).toContain("build:integrity");
    expect(dockerfile).toContain("/app/dist/integrity-check.mjs ./integrity-check.mjs");
  });
});
