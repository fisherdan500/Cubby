import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn(), issue: vi.fn(), submit: vi.fn() }));
vi.mock("@/server/services/appearance", () => ({ getHouseholdAppearance: mocks.get, issueHouseholdAppearanceBrowserOperation: mocks.issue, submitHouseholdAppearanceBrowserOperation: mocks.submit }));
vi.mock("@/server/services/unit-preferences", () => ({ getUnitPreferenceSettings: mocks.get, issueUnitPreferencesBrowserOperation: mocks.issue, submitUnitPreferencesBrowserOperation: mocks.submit }));

import { POST as issueAppearance } from "@/app/api/settings/appearance/issue/route";
import { PATCH as submitAppearance } from "@/app/api/settings/appearance/route";
import { POST as issueUnits } from "@/app/api/settings/units/issue/route";
import { PATCH as submitUnits } from "@/app/api/settings/units/route";

const operationId = "bmo_0123456789abcdefghjkmnpqrs";
const request = (body: unknown) => new Request("http://localhost/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("durable household settings routes", () => {
  beforeEach(() => vi.resetAllMocks());
  it.each([[issueAppearance, submitAppearance], [issueUnits, submitUnits]])("issues and exposes expired results for a durable settings operation", async (issue, submit) => {
    mocks.issue.mockResolvedValue({ status: "open", operationId, bindingId: "binding-1" });
    expect((await issue(request({ operationId }))).status).toBe(201);
    mocks.submit.mockResolvedValue({ status: "expired", operationId, code: "operation_result_expired" });
    expect((await submit(request({ operationId }))).status).toBe(410);
  });
});
