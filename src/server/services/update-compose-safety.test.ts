import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const normal = readFileSync(new URL("../../../docker-compose.yml", import.meta.url), "utf8");
const rehearsal = readFileSync(
  new URL("../../../scripts/backup-recovery-rehearsal.compose.yml", import.meta.url),
  "utf8"
);
const healthEndpoint = "http://127.0.0.1:3000/api/health";

function appBlock(compose: string) {
  return compose.match(/\r?\n  app:\r?\n([\s\S]*?)(?=\r?\nvolumes:)/)?.[1] ?? "";
}

function healthcheckBlock(app: string) {
  return app.match(/healthcheck:\r?\n((?: {6}.*\r?\n)+)/)?.[1] ?? "";
}

describe("update compose safety", () => {
  it("uses the internal readiness endpoint for normal and rehearsal app health", () => {
    for (const compose of [normal, rehearsal]) {
      const app = appBlock(compose);
      const healthcheck = healthcheckBlock(app);
      expect(app).toContain("healthcheck:");
      expect(healthcheck).toContain(healthEndpoint);
      expect(healthcheck).toContain('["CMD", "node", "-e"');
      expect(healthcheck).not.toMatch(/postgresql|password|secret|https?:\/\/(?!127\.0\.0\.1:3000)/i);
    }
  });

  it("preserves database dependency, restart, and persistent mount contracts", () => {
    expect(appBlock(normal)).toContain("condition: service_healthy");
    expect(appBlock(rehearsal)).toContain("condition: service_healthy");
    expect(normal.match(/restart: unless-stopped/g)).toHaveLength(2);
    expect(rehearsal).not.toContain("restart:");
    expect(normal).toContain("cubby_postgres_data:/var/lib/postgresql/data");
    expect(normal).toContain("/var/lib/cubby/backups");
    expect(rehearsal).toContain("rehearsal_postgres_data:/var/lib/postgresql/data");
    expect(rehearsal).toContain("/var/lib/cubby/backups");
  });

  it("bounds readiness checks and allows startup grace for migrations", () => {
    const normalApp = appBlock(normal);
    const rehearsalApp = appBlock(rehearsal);

    expect(normalApp).toMatch(/healthcheck:[\s\S]*interval: 10s[\s\S]*timeout: 5s[\s\S]*retries: 6[\s\S]*start_period: 60s/);
    expect(rehearsalApp).toMatch(/healthcheck:[\s\S]*interval: 2s[\s\S]*timeout: 3s[\s\S]*retries: 45[\s\S]*start_period: 60s/);
  });
});
