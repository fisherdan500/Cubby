import type { Prisma as PrismaTypes } from "@prisma/client";
import { BrowserOperationKey, BrowserOperationTargetKind, NotificationInterruptionLevel, Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { writeAudit } from "@/server/services/audit";
import {
  executeHouseholdBrowserOperation,
  getBrowserOperationContextForHousehold,
  issueHouseholdBrowserOperation
} from "@/server/services/browser-operations";

const notificationPreferenceSchemaVersion = 1 as const;
const categorySchema = z.enum(["timer_overdue", "activity_created", "reminder_due"]);
const channelSchema = z.enum(["browser_push"]);
const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const babyScopeSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("all") }).strict(),
  z.object({ mode: z.literal("selected"), babyIds: z.array(z.string().min(1)).default([]) }).strict()
]);

const documentSchema = z.object({
  externalDeliveryEnabled: z.coerce.boolean().default(false),
  babyScope: babyScopeSchema.default({ mode: "all" }),
  categories: z.array(categorySchema).default([]),
  channels: z.array(channelSchema).default([]),
  quietHoursStart: timeSchema.optional(),
  quietHoursEnd: timeSchema.optional(),
  interruptionLevel: z.enum(["passive", "normal", "time_sensitive"]).default("normal"),
  destinationIds: z.array(z.string().min(1)).default([])
}).strict().superRefine((value, context) => {
  if ((value.quietHoursStart === undefined) !== (value.quietHoursEnd === undefined)) {
    context.addIssue({ code: "custom", message: "quiet_hours_pair_required" });
  }
});

export type NotificationPreferenceDocument = z.infer<typeof documentSchema>;

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort();
}

export function normalizeNotificationPreferenceDocument(raw: unknown): NotificationPreferenceDocument {
  const parsed = documentSchema.parse(raw);
  return {
    ...parsed,
    categories: sortedUnique(parsed.categories),
    channels: sortedUnique(parsed.channels),
    destinationIds: sortedUnique(parsed.destinationIds),
    babyScope: parsed.babyScope.mode === "all"
      ? { mode: "all" }
      : { mode: "selected", babyIds: sortedUnique(parsed.babyScope.babyIds) }
  };
}

type PreferenceSnapshot = {
  documentState: "absent" | "present";
  revision: number | null;
  schemaVersion: number;
};

async function lockAndSnapshotPreference(tx: Pick<PrismaTypes.TransactionClient, "$queryRaw" | "notificationPreference">, householdId: string, memberId: string): Promise<PreferenceSnapshot> {
  await tx.$queryRaw`SELECT "id" FROM "NotificationPreference" WHERE "householdId" = ${householdId} AND "memberId" = ${memberId} FOR UPDATE`;
  const document = await tx.notificationPreference.findUnique({
    where: { householdId_memberId: { householdId, memberId } },
    select: { revision: true, schemaVersion: true }
  });
  if (!document) return { documentState: "absent", revision: null, schemaVersion: notificationPreferenceSchemaVersion };
  return { documentState: "present", revision: document.revision, schemaVersion: document.schemaVersion };
}

async function requireActiveSelectedBabies(tx: Pick<Prisma.TransactionClient, "baby">, householdId: string, babyIds: string[]) {
  for (const babyId of babyIds) {
    const baby = await tx.baby.findFirst({
      where: { id: babyId, householdId, inactiveAt: null, deletedAt: null },
      select: { id: true }
    });
    if (!baby) throw new Error("not_found");
  }
}

export async function getOwnNotificationPreference() {
  const ctx = await getBrowserOperationContextForHousehold();
  const document = await prisma.notificationPreference.findUnique({
    where: { householdId_memberId: { householdId: ctx.householdId, memberId: ctx.memberId } },
    include: { selectedBabies: { select: { babyId: true } } }
  });
  if (!document) return { state: "unsaved_off" as const, document: null };
  return {
    state: document.status === "needsReview" ? "needs_review" as const : "active" as const,
    document: {
      ...document,
      selectedBabyIds: document.selectedBabies.map((selection) => selection.babyId).sort()
    }
  };
}

export async function issueNotificationPreferenceBrowserOperation(raw: { operationId?: unknown }) {
  const ctx = await getBrowserOperationContextForHousehold();
  return issueHouseholdBrowserOperation({
    ctx,
    operationId: raw.operationId,
    operationKey: BrowserOperationKey.notificationPreferenceSave,
    targetKind: BrowserOperationTargetKind.preference,
    targetId: ctx.memberId,
    permission: "notification.manage",
    targetSnapshot: (tx, lockedCtx) => lockAndSnapshotPreference(tx, lockedCtx.householdId, lockedCtx.memberId)
  });
}

export async function submitNotificationPreferenceBrowserOperation(raw: { operationId?: unknown } & Record<string, unknown>) {
  const { operationId, ...documentInput } = raw;
  const document = normalizeNotificationPreferenceDocument(documentInput);
  const ctx = await getBrowserOperationContextForHousehold();
  return executeHouseholdBrowserOperation({
    ctx,
    operationId,
    operationKey: BrowserOperationKey.notificationPreferenceSave,
    targetKind: BrowserOperationTargetKind.preference,
    targetId: ctx.memberId,
    permission: "notification.manage",
    intent: document,
    execute: async (tx, lockedCtx, binding) => {
      const opening = binding.targetSnapshot as PreferenceSnapshot;
      if (opening.schemaVersion !== notificationPreferenceSchemaVersion) throw new Error("stale_revision");
      const current = await lockAndSnapshotPreference(tx, lockedCtx.householdId, lockedCtx.memberId);
      if (current.documentState !== opening.documentState || current.revision !== opening.revision) throw new Error("stale_revision");
      const selectedBabyIds = document.babyScope.mode === "selected" ? document.babyScope.babyIds : [];
      await requireActiveSelectedBabies(tx, lockedCtx.householdId, selectedBabyIds);
      const data = {
        status: "active" as const,
        schemaVersion: notificationPreferenceSchemaVersion,
        externalDeliveryEnabled: document.externalDeliveryEnabled,
        babyScope: document.babyScope.mode,
        categories: document.categories,
        channels: document.channels,
        quietHoursStart: document.quietHoursStart,
        quietHoursEnd: document.quietHoursEnd,
        interruptionLevel: document.interruptionLevel === "time_sensitive"
          ? NotificationInterruptionLevel.timeSensitive
          : document.interruptionLevel === "passive"
            ? NotificationInterruptionLevel.passive
            : NotificationInterruptionLevel.normal,
        destinationIds: document.destinationIds,
        migrationEvidence: Prisma.JsonNull
      };
      let preferenceId: string;
      let revision: number;
      if (opening.documentState === "absent") {
        const created = await tx.notificationPreference.create({
          data: { householdId: lockedCtx.householdId, memberId: lockedCtx.memberId, revision: 1, ...data },
          select: { id: true, revision: true }
        });
        preferenceId = created.id;
        revision = created.revision;
      } else {
        const updated = await tx.notificationPreference.updateMany({
          where: { householdId: lockedCtx.householdId, memberId: lockedCtx.memberId, revision: opening.revision! },
          data: { ...data, revision: { increment: 1 } }
        });
        if (updated.count !== 1) throw new Error("stale_revision");
        const persisted = await tx.notificationPreference.findUnique({
          where: { householdId_memberId: { householdId: lockedCtx.householdId, memberId: lockedCtx.memberId } },
          select: { id: true, revision: true }
        });
        if (!persisted) throw new Error("operation_integrity_error");
        preferenceId = persisted.id;
        revision = persisted.revision;
        await tx.notificationPreferenceBaby.deleteMany({ where: { preferenceId } });
      }
      if (selectedBabyIds.length) {
        await tx.notificationPreferenceBaby.createMany({
          data: selectedBabyIds.map((babyId) => ({ householdId: lockedCtx.householdId, preferenceId, babyId }))
        });
      }
      await writeAudit(lockedCtx, {
        action: "notification.preference.save",
        entityType: "notification_preference",
        entityId: preferenceId,
        after: { memberId: lockedCtx.memberId, revision, status: "active", externalDeliveryEnabled: document.externalDeliveryEnabled, babyScope: document.babyScope.mode }
      }, tx);
      return { kind: "notification_preference", code: "ok", revision, status: "active", externalDeliveryEnabled: document.externalDeliveryEnabled } as const;
    }
  });
}
