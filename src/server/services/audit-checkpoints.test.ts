import { describe, expect, it, vi } from "vitest";
import { hashAuditEvent, hashLegacyAuditEvent } from "@/server/services/audit-integrity";
import { refreshHouseholdAuditCheckpoint, refreshPlatformAuditCheckpoint, readHouseholdAuditIntegrity } from "@/server/services/audit-checkpoints";

const base = {
  id: "audit-1",
  householdId: "household-1",
  action: "baby.create",
  entityType: "baby",
  entityId: "baby-1",
  schemaVersion: 1,
  createdAt: new Date("2026-08-22T00:00:00.000Z"),
  before: null,
  after: {}
};
const eventHash = hashLegacyAuditEvent(null, { ...base, createdAt: base.createdAt.toISOString() });

describe("audit checkpoint reader", () => {
  it("rejects absent, stale, and broken checkpoint evidence without returning audit content", async () => {
    const events = [{ ...base, previousHash: null, eventHash }];
    let checkpoint: { headHash: string; eventCount: number } | null = null;
    const database = {
      auditEvent: { findMany: async () => events },
      auditIntegrityCheckpoint: { findUnique: async () => checkpoint }
    };
    await expect(readHouseholdAuditIntegrity("household-1", database)).resolves.toEqual({ status: "missing" });

    checkpoint = { headHash: "f".repeat(64), eventCount: 1 };
    await expect(readHouseholdAuditIntegrity("household-1", database)).resolves.toEqual({ status: "stale" });

    checkpoint = { headHash: eventHash, eventCount: 1 };
    database.auditEvent.findMany = async () => [{ ...events[0], action: "baby.deactivate" }];
    await expect(readHouseholdAuditIntegrity("household-1", database)).resolves.toEqual({ status: "invalid" });
  });

  it("hashes only the canonical audit envelope when database rows include attribution columns", async () => {
    const events = [{
      ...base,
      previousHash: null,
      eventHash,
      actorUserId: "user-1",
      actorMemberId: "member-1",
      correlationId: null
    }];
    const database = {
      auditEvent: { findMany: async () => events },
      auditIntegrityCheckpoint: { findUnique: async () => ({ headHash: eventHash, eventCount: 1 }) }
    };

    await expect(readHouseholdAuditIntegrity("household-1", database)).resolves.toEqual({ status: "valid" });
  });

  it("detects a changed v2 baby scope even when the checkpoint head is unchanged", async () => {
    const envelope = {
      id: "audit-v2",
      householdId: "household-1",
      babyId: "baby-1",
      actorUserId: "user-1",
      actorMemberId: "member-1",
      actorUserSnapshot: "user-1",
      actorMemberSnapshot: "member-1",
      correlationId: "operation-1",
      action: "activity.create",
      entityType: "activity",
      entityId: "activity-1",
      schemaVersion: 2,
      createdAt: "2026-08-22T00:00:00.000Z",
      before: null,
      after: {}
    };
    const eventHash = hashAuditEvent(null, envelope);
    const event = { ...envelope, createdAt: new Date(envelope.createdAt), previousHash: null, eventHash };
    const database = {
      auditEvent: { findMany: async () => [event] },
      auditIntegrityCheckpoint: { findUnique: async () => ({ headHash: eventHash, eventCount: 1 }) }
    };

    await expect(readHouseholdAuditIntegrity("household-1", database)).resolves.toEqual({ status: "valid" });
    database.auditEvent.findMany = async () => [{ ...event, babyId: "baby-2" }];
    await expect(readHouseholdAuditIntegrity("household-1", database)).resolves.toEqual({ status: "invalid" });
  });

  it("persists a content-free checkpoint only after a valid canonical chain", async () => {
    const upsert = vi.fn();
    const database = {
      auditEvent: { findMany: async () => [{ ...base, previousHash: null, eventHash }] },
      auditIntegrityCheckpoint: { findUnique: async () => null, upsert }
    };
    const verifiedAt = new Date("2026-08-22T01:00:00.000Z");

    await expect(refreshHouseholdAuditCheckpoint("household-1", database, verifiedAt)).resolves.toEqual({
      headHash: eventHash,
      eventCount: 1,
      verifiedAt
    });
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: { scope: "household:household-1", headHash: eventHash, eventCount: 1, verifiedAt },
      update: { headHash: eventHash, eventCount: 1, verifiedAt }
    }));
  });

  it("persists a platform checkpoint from the closed platform chain", async () => {
    const platformEvent = {
      id: "platform-audit-1",
      action: "platform.owner.recover",
      entityType: "platform_authority",
      entityId: "platform",
      schemaVersion: 1,
      createdAt: new Date("2026-08-22T01:00:00.000Z"),
      previousHash: null,
      before: null,
      after: null
    };
    const platformHash = hashAuditEvent(null, {
      id: platformEvent.id,
      householdId: "platform",
      action: platformEvent.action,
      entityType: platformEvent.entityType,
      entityId: platformEvent.entityId,
      schemaVersion: platformEvent.schemaVersion,
      createdAt: platformEvent.createdAt.toISOString(),
      before: null,
      after: null
    });
    const upsert = vi.fn();
    const database = {
      platformAuditEvent: { findMany: async () => [{ ...platformEvent, eventHash: platformHash }] },
      auditIntegrityCheckpoint: { upsert }
    };

    await expect(refreshPlatformAuditCheckpoint(database)).resolves.toMatchObject({ headHash: platformHash, eventCount: 1 });
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ scope: "platform", headHash: platformHash, eventCount: 1 })
    }));
  });
});
