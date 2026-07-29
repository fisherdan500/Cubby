import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
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

  it("rejects malformed packaged arguments before loading environment configuration", async () => {
    const root = process.cwd();
    const directory = await mkdtemp(path.join(tmpdir(), "cubby-integrity-cli-"));
    const output = path.join(directory, "integrity-check.mjs");
    let databaseSentinelBundled = false;

    try {
      await build({
        entryPoints: [path.join(root, "scripts", "integrity-check.ts")],
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node22",
        plugins: [
          {
            name: "database-evaluation-sentinel",
            setup(context) {
              context.onResolve({ filter: /(?:^@\/lib\/db\/prisma$|src\/lib\/db\/prisma$)/ }, () => ({
                path: "database-evaluation-sentinel",
                namespace: "integrity-test"
              }));
              context.onLoad(
                { filter: /.*/, namespace: "integrity-test" },
                () => {
                  databaseSentinelBundled = true;
                  return {
                    contents:
                      'throw new Error("eager_database_module_loaded"); export const prisma = {};',
                    loader: "js"
                  };
                }
              );
            }
          }
        ],
        outfile: output,
        logLevel: "silent"
      });

      const result = spawnSync(process.execPath, [output, "--format", "json"], {
        cwd: directory,
        encoding: "utf8",
        env: { ...process.env, AUTOMATED_BACKUPS_ENABLED: "invalid" }
      });

      expect(databaseSentinelBundled).toBe(true);
      expect(result.status).toBe(4);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("Integrity command failed: integrity_command_usage\n");
      expect(result.stderr).not.toContain(root);
      expect(result.stderr).not.toContain("AUTOMATED_BACKUPS_ENABLED");
      expect(result.stderr).not.toContain("eager_database_module_loaded");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
