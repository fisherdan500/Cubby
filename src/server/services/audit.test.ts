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

  it("stores immutable actor identity snapshots with the event", async () => {
    await writeAudit(context, {
      action: "activity.create",
      entityType: "activity",
      entityId: "activity-1"
    });

    expect(mocks.auditEventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        schemaVersion: 1,
        actorUserSnapshot: "user-1",
        actorMemberSnapshot: "member-1"
      })
    });
  });

  it("redacts undeclared member self-leave payload fields", async () => {
    await writeAudit(context, {
      action: "member.self_leave",
      entityType: "household_member",
      entityId: "member-1",
      before: { role: "parent", email: "private@example.test" },
      after: { closureReason: "self_left", deletedAt: "2026-08-21T00:00:00.000Z", leaveOperationId: "operation-1", secret: "no" }
    });

    expect(mocks.auditEventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        before: { role: "parent" },
        after: {
          closureReason: "self_left",
          deletedAt: "2026-08-21T00:00:00.000Z",
          leaveOperationId: "operation-1"
        }
      })
    });
  });
});
