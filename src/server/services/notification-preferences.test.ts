import { existsSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getContext: vi.fn(),
  requirePermission: vi.fn(),
  preferenceFindUnique: vi.fn(),
  issue: vi.fn(),
  execute: vi.fn(),
  writeAudit: vi.fn()
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: { notificationPreference: { findUnique: mocks.preferenceFindUnique } }
}));
vi.mock("@/server/services/browser-operations", () => ({
  getBrowserOperationContextForHousehold: mocks.getContext,
  issueHouseholdBrowserOperation: mocks.issue,
  executeHouseholdBrowserOperation: mocks.execute
}));
vi.mock("@/server/services/audit", () => ({ writeAudit: mocks.writeAudit }));

import {
  issueNotificationPreferenceBrowserOperation,
  normalizeNotificationPreferenceDocument,
  submitNotificationPreferenceBrowserOperation
} from "@/server/services/notification-preferences";

const ctx = { userId: "user-1", sessionId: "session-1", householdId: "household-1", memberId: "episode-new", role: "parent" as const };
const operationId = "bmo_0123456789abcdefghjkmnpqrs";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getContext.mockResolvedValue(ctx);
  mocks.preferenceFindUnique.mockResolvedValue(null);
  mocks.issue.mockResolvedValue({ status: "open", operationId, bindingId: "binding-1" });
});

describe("notification preference document normalization", () => {
  it("accepts empty selected scope as a deliberate no-delivery document and defaults external delivery off", () => {
    expect(normalizeNotificationPreferenceDocument({ babyScope: { mode: "selected", babyIds: [] } })).toEqual(expect.objectContaining({
      babyScope: { mode: "selected", babyIds: [] },
      externalDeliveryEnabled: false,
      categories: [],
      channels: [],
      destinationIds: []
    }));
  });

  it("rejects ambiguous mixed all and selected baby scope", () => {
    expect(() => normalizeNotificationPreferenceDocument({ babyScope: { mode: "all", babyIds: ["baby-1"] } })).toThrow();
  });
});

describe("membership-episode notification preference operation", () => {
  it("opens an exact household/member-episode preference target without household.manage", async () => {
    mocks.issue.mockResolvedValue({ status: "open", operationId, bindingId: "binding-1" });

    await expect(issueNotificationPreferenceBrowserOperation({ operationId })).resolves.toMatchObject({ status: "open" });

    const input = mocks.issue.mock.calls[0][0];
    expect(input).toMatchObject({
      operationKey: "notificationPreferenceSave",
      targetKind: "preference",
      targetId: "episode-new",
      permission: "notification.manage"
    });
    const $queryRaw = vi.fn();
    await expect(input.targetSnapshot({ $queryRaw, notificationPreference: { findUnique: mocks.preferenceFindUnique } }, ctx)).resolves.toEqual({ documentState: "absent", revision: null, schemaVersion: 1 });
    expect($queryRaw).toHaveBeenCalledOnce();
  });

  it("creates one complete selected-scope document for the current episode only and audits it", async () => {
    mocks.execute.mockImplementation(async (input) => {
      const create = vi.fn().mockResolvedValue({ id: "pref-new", revision: 1 });
      const babyFindFirst = vi.fn().mockResolvedValue({ id: "baby-1" });
      const tx = {
        $queryRaw: vi.fn(),
        notificationPreference: { findUnique: mocks.preferenceFindUnique, create, updateMany: vi.fn() },
        baby: { findFirst: babyFindFirst },
        notificationPreferenceBaby: { deleteMany: vi.fn(), createMany: vi.fn() },
        auditEvent: { create: mocks.writeAudit }
      };
      await expect(input.execute(tx, ctx, { targetSnapshot: { documentState: "absent", revision: null, schemaVersion: 1 } })).resolves.toEqual({
        kind: "notification_preference", code: "ok", revision: 1, status: "active", externalDeliveryEnabled: false
      });
      expect(create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ householdId: "household-1", memberId: "episode-new", babyScope: "selected", interruptionLevel: "timeSensitive", externalDeliveryEnabled: false })
      }));
      expect(tx.notificationPreferenceBaby.createMany).toHaveBeenCalledWith({ data: [{ householdId: "household-1", preferenceId: "pref-new", babyId: "baby-1" }] });
      expect(mocks.writeAudit).toHaveBeenCalled();
      return { status: "completed", operationId, outcome: { kind: "notification_preference", code: "ok", revision: 1, status: "active", externalDeliveryEnabled: false } };
    });

    await expect(submitNotificationPreferenceBrowserOperation({
      operationId,
      babyScope: { mode: "selected", babyIds: ["baby-1"] },
      categories: ["activity_created"],
      channels: ["browser_push"],
      interruptionLevel: "time_sensitive",
      externalDeliveryEnabled: false
    })).resolves.toMatchObject({ status: "completed" });
    expect(mocks.execute).toHaveBeenCalled();
  });

  it("does not inherit a former episode document after rejoin", async () => {
    mocks.preferenceFindUnique.mockResolvedValue(null);
    await expect(issueNotificationPreferenceBrowserOperation({ operationId })).resolves.toMatchObject({ status: "open" });
    const snapshot = mocks.issue.mock.calls[0][0].targetSnapshot;
    const $queryRaw = vi.fn();
    await snapshot({ $queryRaw, notificationPreference: { findUnique: mocks.preferenceFindUnique } }, ctx);
    expect($queryRaw).toHaveBeenCalledOnce();
    expect(mocks.preferenceFindUnique).toHaveBeenCalledWith({ where: { householdId_memberId: { householdId: "household-1", memberId: "episode-new" } }, select: expect.any(Object) });
  });

  it("rejects a foreign selected baby without creating a document", async () => {
    const create = vi.fn();
    mocks.execute.mockImplementation(async (input) => input.execute({
      $queryRaw: vi.fn(),
      notificationPreference: { findUnique: vi.fn(), create, updateMany: vi.fn() },
      baby: { findFirst: vi.fn().mockResolvedValue(null) },
      notificationPreferenceBaby: { deleteMany: vi.fn(), createMany: vi.fn() },
      auditEvent: { create: mocks.writeAudit }
    }, ctx, { targetSnapshot: { documentState: "absent", revision: null, schemaVersion: 1 } }));

    await expect(submitNotificationPreferenceBrowserOperation({ operationId, babyScope: { mode: "selected", babyIds: ["foreign-baby"] } })).rejects.toThrow("not_found");
    expect(create).not.toHaveBeenCalled();
  });
});

describe("notification preference migration contract", () => {
  it("uses a deterministic, content-minimized fail-closed legacy preflight and leaves external delivery off", () => {
    const migrationUrl = new URL("../../../prisma/migrations/20260818110000_membership_episode_notification_preferences/migration.sql", import.meta.url);
    expect(existsSync(migrationUrl)).toBe(true);
    if (!existsSync(migrationUrl)) return;
    const migration = readFileSync(migrationUrl, "utf8");
    expect(migration).toContain('ALTER TABLE "NotificationPreference" RENAME TO "LegacyNotificationPreference"');
    expect(migration).toContain('CREATE TABLE "NotificationPreference"');
    expect(migration).toContain('"memberId" TEXT NOT NULL');
    expect(migration).toContain('"externalDeliveryEnabled" BOOLEAN NOT NULL DEFAULT FALSE');
    expect(migration).toContain('"NotificationPreference_householdId_memberId_key" UNIQUE ("householdId", "memberId")');
    expect(migration).toContain('CREATE TABLE "NotificationPreferenceBaby"');
    expect(migration).toContain('notification_preference_legacy_preflight_failed');
    expect(migration).toContain("needs_review");
    expect(migration).toContain("legacy_row_count");
    expect(migration).not.toMatch(/SET\s+"externalDeliveryEnabled"\s*=\s*TRUE/i);
  });
});
