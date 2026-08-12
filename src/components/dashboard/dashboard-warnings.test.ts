import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./dashboard-warnings.tsx", import.meta.url), "utf8");

describe("DashboardWarnings", () => {
  it("restores the warning and retains its operation identity after a transport failure", () => {
    expect(source).toContain("catch {");
    expect(source).toContain("setHidden((current) => {");
    expect(source).toContain("Could not reach Cubby. Check your connection and try again.");
    expect(source).toContain("role=\"alert\"");

    const transportFailure = source.slice(source.indexOf("catch {"), source.indexOf("finally {") === -1 ? undefined : source.indexOf("finally {"));
    expect(transportFailure).not.toContain("operationIds.current.delete(key)");
  });
});
