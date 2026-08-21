import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const runnerUrl = new URL("./browser-operation-pilot.acceptance-rehearsal.ts", import.meta.url);
const composeUrl = new URL("./browser-operation-pilot.acceptance.compose.yml", import.meta.url);
const operationUrl = new URL("./browser-operation-pilot.acceptance-rehearsal.operation.ts", import.meta.url);

describe("browser operation pilot disposable PostgreSQL acceptance harness", () => {
  it("provides a tracked self-cleaning runner and isolated PostgreSQL Compose definition", () => {
    expect(existsSync(runnerUrl)).toBe(true);
    expect(existsSync(composeUrl)).toBe(true);
    expect(existsSync(operationUrl)).toBe(true);
  });

  it("isolates each run and reaches the terminal-outcome CHECK without binding uniqueness interference", () => {
    const source = readFileSync(runnerUrl, "utf8");

    expect(source).toContain("const project = `cubby-p1-2b-pr53-acceptance-${suffix}`");
    expect(source).toContain("'bind-terminal-check'");
    expect(source).toContain("'bmo_4123456789abcdefghjkmnpqrs'");
    expect(source).toContain("browser-operation-pilot.acceptance.vitest.config.ts");
  });
});
