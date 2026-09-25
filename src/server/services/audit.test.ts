import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashAuditEvent } from "@/server/services/audit-integrity";

const mocks = vi.hoisted(() => ({
  auditEventCreate: vi.fn(),
  auditEventCount: vi.fn(),
  auditCheckpointUpsert: vi.fn(),
  platformAuditEventCreate: vi.fn()
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    auditEvent: { create: mocks.auditEventCreate, count: mocks.auditEventCount },
    auditIntegrityCheckpoint: { upsert: mocks.auditCheckpointUpsert },
    platformAuditEvent: { create: mocks.platformAuditEventCreate }
  }
}));

import { writeAudit, writePlatformAudit } from "@/server/services/audit";

const context = {
  userId: "user-1",
  householdId: "household-1",
  memberId: "member-1",
  role: "owner" as const
};

describe("household audit contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auditEventCount.mockResolvedValue(1);
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

  it("rejects undeclared activity payload fields before persisting audit evidence", async () => {
    await expect(
      writeAudit(context, {
        action: "activity.create",
        entityType: "activity",
        entityId: "activity-1",
        after: {
          type: "feeding",
          notes: "private care content",
          documentUrl: "https://private.example/document"
        }
      })
    ).rejects.toThrow();

    expect(mocks.auditEventCreate).not.toHaveBeenCalled();
  });

  it("stores immutable actor identity snapshots with the event", async () => {
    await writeAudit(context, {
      action: "activity.create",
      entityType: "activity",
      entityId: "activity-1"
    });

    expect(mocks.auditEventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        schemaVersion: 3,
        actorUserSnapshot: "user-1",
        actorMemberSnapshot: "member-1",
        previousHash: null,
        eventHash: expect.stringMatching(/^[a-f0-9]{64}$/)
      })
    });
  });

  it("rejects undeclared member self-leave payload fields", async () => {
    await expect(
      writeAudit(context, {
        action: "member.self_leave",
        entityType: "household_member",
        entityId: "member-1",
        before: { role: "parent", email: "private@example.test" },
        after: { closureReason: "self_left", deletedAt: "2026-08-21T00:00:00.000Z", leaveOperationId: "operation-1", secret: "no" }
      })
    ).rejects.toThrow();

    expect(mocks.auditEventCreate).not.toHaveBeenCalled();
  });

  it("never stores the words of a family post or comment", async () => {
    for (const [action, after] of [
      ["feed_post.update", { tagCount: 1, body: "private caption" }],
      ["feed_comment.create", { parentKind: "post", body: "private comment" }],
      ["feed_comment.update", { body: "private comment" }],
      ["feed_reaction.set", { reaction: "love", on: true, note: "private" }]
    ] as const) {
      await expect(writeAudit(context, { action, entityType: "feed_comment", entityId: "comment-1", after })).rejects.toThrow();
    }
    expect(mocks.auditEventCreate).not.toHaveBeenCalled();

    await writeAudit(context, { action: "feed_comment.create", entityType: "feed_comment", entityId: "comment-1", after: { parentKind: "activity" } });
    expect(mocks.auditEventCreate).toHaveBeenCalledTimes(1);
  });

  it("rejects undeclared integration token material for every classified action", async () => {
    await expect(
      writeAudit(context, {
        action: "api_key.create",
        entityType: "api_key",
        entityId: "key-1",
        after: { prefix: "a-secret-derived-token-prefix" }
      })
    ).rejects.toThrow();

    expect(mocks.auditEventCreate).not.toHaveBeenCalled();
  });

  it("classifies every member role transition emitted by the writer", async () => {
    await writeAudit(context, {
      action: "member.admin.revoke",
      entityType: "household_member",
      entityId: "member-2",
      before: { role: "admin" },
      after: { role: "parent" }
    });

    expect(mocks.auditEventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "member.admin.revoke" })
    });
  });

  it("binds an activity audit event to its authorized baby scope", async () => {
    await writeAudit(context, {
      action: "activity.create",
      entityType: "activity",
      entityId: "activity-1",
      babyId: "baby-1"
    });

    expect(mocks.auditEventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ babyId: "baby-1" })
    });
  });

  it("hashes the persisted household scope, attribution, and correlation fields into the canonical event envelope", async () => {
    await writeAudit(context, {
      action: "activity.create",
      entityType: "activity",
      entityId: "activity-1",
      babyId: "baby-1",
      correlationId: "operation-1"
    } as never);

    const data = mocks.auditEventCreate.mock.calls[0]?.[0].data;
    const envelope = {
      id: data.id,
      householdId: data.householdId,
      babyId: data.babyId,
      actorUserId: data.actorUserId,
      actorMemberId: data.actorMemberId,
      actorUserSnapshot: data.actorUserSnapshot,
      actorMemberSnapshot: data.actorMemberSnapshot,
      correlationId: data.correlationId,
      chainOrder: data.chainOrder,
      action: data.action,
      entityType: data.entityType,
      entityId: data.entityId,
      schemaVersion: data.schemaVersion,
      createdAt: data.createdAt.toISOString(),
      before: data.before ?? null,
      after: data.after ?? null
    };

    expect(data.correlationId).toBe("operation-1");
    expect(data.eventHash).toBe(hashAuditEvent(data.previousHash, envelope));
  });

  it("refreshes the household checkpoint in the same writer boundary as every appended audit event", async () => {
    await writeAudit(context, {
      action: "activity.create",
      entityType: "activity",
      entityId: "activity-1"
    });

    const data = mocks.auditEventCreate.mock.calls[0]?.[0].data;
    expect(mocks.auditCheckpointUpsert).toHaveBeenCalledWith({
      where: { scope: "household:household-1" },
      create: expect.objectContaining({ scope: "household:household-1", headHash: data.eventHash, eventCount: 1 }),
      update: expect.objectContaining({ headHash: data.eventHash, eventCount: 1 })
    });
  });

  it("assigns a lock-serialized durable household chain order before hashing the event", async () => {
    mocks.auditEventCount.mockResolvedValueOnce(0).mockResolvedValueOnce(1);

    await writeAudit(context, {
      action: "activity.create",
      entityType: "activity",
      entityId: "activity-1"
    });

    expect(mocks.auditEventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ schemaVersion: 3, chainOrder: 1 })
    });
  });

  it("writes platform evidence through a versioned content-free contract", async () => {
    await writePlatformAudit({
      action: "platform.owner.bootstrap",
      entityType: "platform_authority",
      entityId: "platform"
    });

    expect(mocks.platformAuditEventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "platform.owner.bootstrap",
        entityType: "platform_authority",
        entityId: "platform",
        schemaVersion: 3,
        actorUserId: null,
        previousHash: null,
        eventHash: expect.stringMatching(/^[a-f0-9]{64}$/)
      })
    });
    expect(mocks.platformAuditEventCreate.mock.calls[0]?.[0].data).not.toHaveProperty("after");
    expect(mocks.platformAuditEventCreate.mock.calls[0]?.[0].data).not.toHaveProperty("before");
  });

  it("hashes persisted platform attribution and source metadata", async () => {
    await writePlatformAudit({
      action: "platform.owner.bootstrap",
      entityType: "platform_authority",
      entityId: "platform",
      actorUserId: "owner-1",
      source: "host_local"
    });

    const data = mocks.platformAuditEventCreate.mock.calls[0]?.[0].data;
    const envelope = {
      id: data.id,
      householdId: "platform",
      actorUserId: data.actorUserId,
      actorUserSnapshot: data.actorUserSnapshot,
      source: data.source,
      chainOrder: data.chainOrder,
      correlationId: data.correlationId,
      action: data.action,
      entityType: data.entityType,
      entityId: data.entityId,
      schemaVersion: data.schemaVersion,
      createdAt: data.createdAt.toISOString(),
      before: null,
      after: null
    };

    expect(data.eventHash).toBe(hashAuditEvent(data.previousHash, envelope));
  });
});
