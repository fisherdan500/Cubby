import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./baby-form.tsx", import.meta.url), "utf8");

describe("BabyForm browser-v2 handling", () => {
  it("retains one creation operation, issues it before submit, and reconciles it after refresh", () => {
    expect(source).toContain('const pendingKey = "cubby:baby-create-operation";');
    expect(source).toContain('fetch(`/api/browser-operations/${id}`, { cache: "no-store" })');
    expect(source).toContain('fetch("/api/babies/issue", {');
    expect(source).toContain('body: JSON.stringify({ operationId: id })');
    expect(source).toContain('body: JSON.stringify({ ...Object.fromEntries(formData), operationId: id })');
    expect(source).toContain('sessionStorage.removeItem(pendingKey)');
    expect(source).toContain('result.status === "completed"');
    expect(source).toContain('result.status === "pending"');
  });
});
