import { describe, expect, it } from "vitest";
import { isAuthorizedBrowserOperation410 } from "@/lib/browser-operation-terminal";

const operationId = "bmo_0123456789abcdefghjkmnpqrs";

describe("authorized browser-operation 410", () => {
  it("accepts only an exact successful terminal envelope", () => {
    expect(isAuthorizedBrowserOperation410(410, { ok: true, data: { status: "expired", operationId, code: "operation_abandoned" } }, operationId)).toBe(true);
    expect(isAuthorizedBrowserOperation410(410, { status: "expired", operationId, code: "operation_result_expired" }, operationId)).toBe(true);
  });

  it.each([
    [410, { ok: false }],
    [410, { ok: true, data: { status: "expired", operationId: "bmo_1123456789abcdefghjkmnpqrs", code: "operation_abandoned" } }],
    [410, { ok: true, data: { status: "stale", operationId, code: "stale_context" } }],
    [410, { ok: true, data: { status: "expired", operationId, code: "unrelated" } }],
    [404, { ok: true, data: { status: "expired", operationId, code: "operation_abandoned" } }]
  ])("rejects unauthenticated terminal shape %#", (status, payload) => {
    expect(isAuthorizedBrowserOperation410(status, payload, operationId)).toBe(false);
  });
});
