import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The postgres image runs its initdb-time temporary server with TCP disabled, and pg_isready without a
// host answers over the Unix socket, so a socket-only healthcheck can report service_healthy before the
// published TCP port serves the final server. The disposable lifecycle connects over TCP, so readiness must too.
describe("P1-3 disposable postgres readiness gate", () => {
  it("probes the TCP loopback listener the lifecycle connects through", () => {
    const compose = readFileSync(new URL("../../../scripts/p1-3-invitation.acceptance.compose.yml", import.meta.url), "utf8");
    const probe = compose.match(/^ {2}postgres:\r?\n[\s\S]*?^ {4}healthcheck:\r?\n {6}test: (\[.*\])\r?$/m)?.[1] ?? "";

    expect(probe).toContain("pg_isready");
    expect(probe).toMatch(/pg_isready -h 127\.0\.0\.1 -p 5432 /);
  });
});
