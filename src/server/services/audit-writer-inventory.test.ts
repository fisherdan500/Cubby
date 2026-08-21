import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const householdLeavePath = fileURLToPath(new URL("./household-leave.ts", import.meta.url));

describe("audit writer inventory", () => {
  it("routes household self-leave evidence through the centralized audit contract", () => {
    const source = readFileSync(householdLeavePath, "utf8");

    expect(source).toContain('writeAudit(');
    expect(source).not.toContain('tx.auditEvent.create({');
  });
});
