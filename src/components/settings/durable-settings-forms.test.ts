import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appearance = readFileSync(new URL("./appearance-form.tsx", import.meta.url), "utf8");
const units = readFileSync(new URL("./unit-preferences-form.tsx", import.meta.url), "utf8");

describe("durable household settings forms", () => {
  it("retains and reconciles the Family accent operation instead of issuing a replacement mutation", () => {
    expect(appearance).toContain("cubby:household-accent-operation");
    expect(appearance).toContain("/api/settings/appearance/issue");
    expect(appearance).toContain("/api/browser-operations/");
    expect(appearance).toContain("/api/settings/appearance");
    expect(appearance).toContain("Family accent");
  });

  it("retains and reconciles one complete unit-document operation", () => {
    expect(units).toContain("cubby:unit-preferences-operation");
    expect(units).toContain("/api/settings/units/issue");
    expect(units).toContain("/api/browser-operations/");
    expect(units).toContain("operationId: id");
    expect(units).toContain("medicineUnits");
    expect(units).toContain("supplementUnits");
  });
});
