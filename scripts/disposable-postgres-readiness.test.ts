import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDir, "..");

function composeFiles() {
  const inScripts = readdirSync(scriptsDir)
    .filter((name) => name.endsWith("compose.yml"))
    .map((name) => path.join(scriptsDir, name));
  return [...inScripts, path.join(repoRoot, "docker-compose.yml")];
}

describe("disposable PostgreSQL readiness", () => {
  // The official postgres image runs a TEMPORARY server during initdb that listens on the unix
  // socket ONLY. `pg_isready` with no -h talks to that socket, so a healthcheck without -h reports
  // healthy while the database is still initializing - and that temporary server is then shut down
  // before the real one starts.
  //
  // Every observed CI flake in the disposable gates is a symptom of that window:
  //   FATAL: the database system is shutting down      (connected as the temp server stopped)
  //   database "browser_operation_..." does not exist  (connected before initdb created it)
  //   could not serialize access / deadlock            (work landed on a half-initialized server)
  //
  // Connecting over TCP is what the rehearsals themselves do, so the healthcheck has to prove the
  // TCP listener is up, not merely the socket.
  it("every Compose healthcheck waits on the TCP listener, not the init-only socket", () => {
    const offenders: string[] = [];

    for (const file of composeFiles()) {
      const text = readFileSync(file, "utf8");
      for (const line of text.split(/\r?\n/)) {
        if (!line.includes("pg_isready")) continue;
        // -h <host> is the only thing that forces a TCP connection; without it libpq picks the
        // unix socket, which is live during initdb.
        if (!/pg_isready\s+(-\w+\s+\S+\s+)*-h\s/.test(line)) {
          offenders.push(`${path.relative(repoRoot, file)}: ${line.trim()}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("covers every Compose file in the repository, so a new one cannot skip the rule", () => {
    const files = composeFiles();
    // A guard that silently matches nothing is worse than no guard.
    expect(files.length).toBeGreaterThanOrEqual(19);
    expect(files.filter((file) => readFileSync(file, "utf8").includes("pg_isready")).length).toBeGreaterThanOrEqual(19);
  });
});
