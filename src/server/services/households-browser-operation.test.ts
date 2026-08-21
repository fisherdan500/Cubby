import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getHouseholdContext: vi.fn(),
  getLifecycleContext: vi.fn(),
  issueHousehold: vi.fn(),
  executeHousehold: vi.fn(),
  issueBaby: vi.fn(),
  executeBaby: vi.fn(),
  writeAudit: vi.fn()
}));

vi.mock("@/server/services/browser-operations", () => ({
  getBrowserOperationContextForHousehold: mocks.getHouseholdContext,
  getBrowserOperationContextForLifecycleBaby: mocks.getLifecycleContext,
  issueHouseholdBrowserOperation: mocks.issueHousehold,
  executeHouseholdBrowserOperation: mocks.executeHousehold,
  issueBrowserOperation: mocks.issueBaby,
  executeBrowserOperation: mocks.executeBaby
}));
vi.mock("@/server/services/audit", () => ({ writeAudit: mocks.writeAudit }));

import {
  issueCreateBabyBrowserOperation,
  submitCreateBabyBrowserOperation
} from "@/server/services/households";

const ctx = {
  userId: "user-1",
  sessionId: "session-1",
  householdId: "household-1",
  memberId: "member-1",
  role: "parent" as const
};
const operationId = "bmo_0123456789abcdefghjkmnpqrs";
const payload = {
  operationId,
  name: "Ada",
  birthDate: "2026-08-17",
  notes: "A note",
  feedingWarningMinutes: "240",
  diaperWarningMinutes: "240",
  sleepWarningMinutes: "360"
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getHouseholdContext.mockResolvedValue(ctx);
  mocks.issueHousehold.mockResolvedValue({ status: "open", operationId, bindingId: "binding-1" });
});

describe("baby create browser-v2 operation", () => {
  it("issues a typed baby-create binding with no mutable baby ID", async () => {
    await expect(issueCreateBabyBrowserOperation(payload)).resolves.toMatchObject({ status: "open", operationId });

    const input = mocks.issueHousehold.mock.calls[0]?.[0];
    expect(input).toMatchObject({
      ctx,
      operationId,
      operationKey: "babyCreate",
      targetKind: "baby",
      permission: "baby.manage"
    });
    expect(input.targetId).toBeUndefined();
    expect(input.targetSnapshot({} as never, ctx)).toEqual({ kind: "baby-create", schemaVersion: 1 });
  });

  it("submits the normalized create intent in the browser operation transaction without legacy receipt work", async () => {
    mocks.executeHousehold.mockImplementation(async (input) => {
      const babyCreate = vi.fn().mockResolvedValue({ id: "baby-1", name: "Ada" });
      await expect(input.execute({ baby: { create: babyCreate }, auditEvent: {} } as never, ctx, { targetSnapshot: { kind: "baby-create", schemaVersion: 1 } })).resolves.toEqual({
        kind: "baby_create", code: "ok", babyId: "baby-1"
      });
      expect(babyCreate).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ householdId: "household-1", name: "Ada" })
      }));
      expect(mocks.writeAudit).toHaveBeenCalledWith(ctx, expect.objectContaining({ action: "baby.create", entityId: "baby-1" }), expect.anything());
      return { status: "completed", operationId, outcome: { kind: "baby_create", code: "ok", babyId: "baby-1" } };
    });

    await expect(submitCreateBabyBrowserOperation(payload)).resolves.toMatchObject({ status: "completed", operationId });
    expect(mocks.executeHousehold).toHaveBeenCalledWith(expect.objectContaining({
      ctx,
      operationId,
      operationKey: "babyCreate",
      targetKind: "baby",
      permission: "baby.manage",
      intent: expect.objectContaining({ name: "Ada", feedingWarningMinutes: 240 })
    }));
  });
});
