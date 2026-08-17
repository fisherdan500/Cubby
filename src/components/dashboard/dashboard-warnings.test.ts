import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./dashboard-warnings.tsx", import.meta.url), "utf8");

describe("DashboardWarnings", () => {
  it("restores the warning and retains its operation identity after a transport failure", () => {
    expect(source).toContain("catch {");
    expect(source).toContain("setHidden((current) => {");
    expect(source).toContain("Could not reach Cubby. Check your connection and try again.");
    expect(source).toContain("role=\"alert\"");

    const transportStart = source.lastIndexOf("catch {");
    const transportFailure = source.slice(transportStart, source.indexOf("\n  }\n", transportStart));
    expect(transportFailure).not.toContain("operationIds.current.delete(key)");
  });

  it("rehydrates retained identities and reconciles pending, stale, expired, and foreign statuses before another dismissal", () => {
    expect(source).toContain("cubby:dashboard-warning-operation:");
    expect(source).toContain("/api/browser-operations/${operationId}");
    expect(source).toContain("response.status === 410");
    expect(source).toContain("status === \"pending\"");
    expect(source).toContain("status === \"stale\"");
    expect(source).toContain("response.status === 404");
  });
});
