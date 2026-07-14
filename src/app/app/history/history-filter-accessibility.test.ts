import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

describe("history filter accessibility", () => {
  it("gives type and search controls persistent labels", () => {
    expect(source).toContain('htmlFor="history-type"');
    expect(source).toContain('id="history-type"');
    expect(source).toContain('htmlFor="history-search"');
    expect(source).toContain('id="history-search"');
  });

  it("replaces the source entry when entering focused activity detail", () => {
    expect(source).toMatch(/<Link\s+replace\s+prefetch=\{false\}\s+href=\{activityDetailHref/);
  });
});