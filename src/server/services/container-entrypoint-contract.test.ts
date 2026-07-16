import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const entrypoint = new URL("../../../docker/entrypoint.sh", import.meta.url).pathname.replace(
  /^\/(\w:)/,
  "$1"
);
const dockerfilePath = new URL("../../../Dockerfile", import.meta.url);
const packageJsonPath = new URL("../../../package.json", import.meta.url);
const sh = process.platform === "win32" ? "C:\\Program Files\\Git\\usr\\bin\\sh.exe" : "sh";

function runEntrypoint(migrationExit = 0) {
  const directory = mkdtempSync(join(tmpdir(), "cubby-entrypoint-"));
  const log = join(directory, "commands.log");
  const fakeNode = join(directory, "node");
  const launcher = join(directory, "launcher.sh");
  writeFileSync(
    fakeNode,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "$CUBBY_TEST_LOG"\nif [ "$1" = "node_modules/prisma/build/index.js" ]; then\n  printf '%s\\n' 'inherited output with postgresql://secret@private-host'\n  exit "$CUBBY_MIGRATION_EXIT"\nfi\nprintf 'entrypoint_pid=%s server_pid=%s\\n' "$CUBBY_EXPECTED_PID" "$$"\n`
  );
  chmodSync(fakeNode, 0o755);
  writeFileSync(launcher, '#!/bin/sh\nexport CUBBY_EXPECTED_PID="$$"\nexec sh "$1"\n');
  chmodSync(launcher, 0o755);

  const result = spawnSync(sh, [launcher, entrypoint], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`,
      CUBBY_TEST_LOG: log,
      CUBBY_MIGRATION_EXIT: String(migrationExit)
    }
  });

  return { ...result, commands: readFileSync(log, "utf8") };
}

describe("container entrypoint contract", () => {
  it("normalizes the copied entrypoint before direct Linux execution", () => {
    const dockerfile = readFileSync(dockerfilePath, "utf8");
    const copy = "COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/cubby-entrypoint";
    const normalize = String.raw`RUN sed -i 's/\x0D$//' /usr/local/bin/cubby-entrypoint`;
    const execute = 'ENTRYPOINT ["/usr/local/bin/cubby-entrypoint"]';

    expect(dockerfile).toContain(copy);
    expect(dockerfile).toContain(normalize);
    expect(dockerfile.indexOf(copy)).toBeLessThan(dockerfile.indexOf(normalize));
    expect(dockerfile.indexOf(normalize)).toBeLessThan(dockerfile.indexOf(execute));
  });

  it("runs migrations before starting the server", () => {
    const result = runEntrypoint();

    expect(result.status).toBe(0);
    expect(result.commands.trim().split("\n")).toEqual([
      "node_modules/prisma/build/index.js migrate deploy",
      "server.js"
    ]);
  });

  it("emits fixed migration success markers and execs the server", () => {
    const result = runEntrypoint();

    expect(result.stdout).toContain("cubby_startup phase=migration status=starting");
    expect(result.stdout).toContain("cubby_startup phase=migration status=succeeded");
    expect(result.stdout).toContain("cubby_startup phase=server status=starting");
    expect(result.stdout).toMatch(/entrypoint_pid=(\d+) server_pid=\1/);
  });

  it("fails closed with a fixed sanitized marker when migration fails", () => {
    const result = runEntrypoint(42);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(result.commands.trim()).toBe("node_modules/prisma/build/index.js migrate deploy");
    expect(output).toContain("cubby_startup phase=migration status=failed");
    expect(output).not.toContain("server status=starting");
    expect(output).not.toContain("postgresql://");
    expect(output).not.toContain("private-host");
  });

  it("has no legacy package-script startup path around the entrypoint", () => {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.["docker:start"]).toBeUndefined();
  });
});
