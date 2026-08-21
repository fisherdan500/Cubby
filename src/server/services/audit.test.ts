import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auditEventCreate: vi.fn()
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    auditEvent: { create: mocks.auditEventCreate }
  }
}));

import { writeAudit } from "@/server/services/audit";

const context = {
  userId: "user-1",
  householdId: "household-1",
  memberId: "member-1",
  role: "owner" as const
};

describe("household audit contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects an unclassified action before writing arbitrary audit payload data", async () => {
    await expect(
      writeAudit(context, {
        action: "unclassified.action",
        entityType: "unknown",
        entityId: "entity-1",
        after: { secret: "must-not-be-stored" }
      })
    ).rejects.toThrow("audit_action_unclassified");

    expect(mocks.auditEventCreate).not.toHaveBeenCalled();
  });

  it("redacts activity free text before persisting a classified audit event", async () => {
    await writeAudit(context, {
      action: "activity.create",
      entityType: "activity",
      entityId: "activity-1",
      after: {
        type: "feeding",
        notes: "private care content",
        documentUrl: "https://private.example/document"
      }
    });

    expect(mocks.auditEventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        after: { type: "feeding" }
      })
    });
  });
});
