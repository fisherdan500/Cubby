import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "scripts/provision-email-delivery-keys.mjs"), "utf8");

describe("email delivery key provisioner", () => {
  it("records rotation only on an active-version change using database time", () => {
    expect(source).toContain('"retiredAt"=COALESCE("retiredAt",clock_timestamp())');
    expect(source).toContain('WHERE "keyVersion"<>');
    expect(source).toContain('SET "activeWrite"=true,"retiredAt"=NULL');
    expect(source).not.toContain("retiredAt: entry.activeWrite ? null : current?.retiredAt");
  });
});
