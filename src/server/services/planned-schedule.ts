import { BrowserOperationKey, type Prisma } from "@prisma/client";
import { z } from "zod";
import {
  PLANNED_SCHEDULE_SCHEMA_VERSION,
  parsePlannedScheduleItems,
  plannedScheduleDocumentSchema
} from "@/domain/planned-schedule";
import { hasPermission } from "@/domain/roles";
import { prisma } from "@/lib/db/prisma";
import { getEffectiveHouseholdContext, requirePermission } from "@/server/auth/context";
import { writeAudit } from "@/server/services/audit";
import {
  executeBrowserOperation,
  getBrowserOperationContextForBaby,
  issueBrowserOperation
} from "@/server/services/browser-operations";

/**
 * One caregiver-written plan per baby (DEC-PROD-148, DEC-PROD-420). Saving replaces the whole plan,
 * checked against the revision the editor was opened on, so a caregiver never overwrites a plan
 * someone else changed while they were editing. The audit trail records that a plan changed and
 * how many items it has - never what it says.
 */

const openingSchema = z.object({
  babyId: z.string().min(1).max(200),
  expectedRevision: z.number().int().nonnegative()
});

const snapshotSchema = z.object({
  kind: z.literal("planned-schedule-save"),
  schemaVersion: z.literal(1),
  babyId: z.string().min(1),
  revision: z.number().int().nonnegative()
}).strict();

export async function getPlannedSchedule(babyId: string) {
  const ctx = await getEffectiveHouseholdContext();
  requirePermission(ctx, "activity.read");
  const row = await prisma.plannedSchedule.findFirst({
    where: { householdId: ctx.householdId, babyId },
    select: { revision: true, document: true }
  });
  return {
    babyId,
    revision: row?.revision ?? 0,
    items: row ? plannedScheduleDocumentSchema.parse(row.document).items : [],
    canEdit: hasPermission(ctx.role, "baby.manage")
  };
}

export type PlannedScheduleView = Awaited<ReturnType<typeof getPlannedSchedule>>;

/** The plan's current revision, locked for the rest of the transaction; 0 when there is no plan. */
async function lockRevision(tx: Prisma.TransactionClient, householdId: string, babyId: string) {
  const rows = await tx.$queryRaw<Array<{ revision: number }>>`
    SELECT "revision" FROM "PlannedSchedule"
    WHERE "householdId" = ${householdId} AND "babyId" = ${babyId}
    FOR UPDATE
  `;
  return rows[0]?.revision ?? 0;
}

export async function issuePlannedScheduleBrowserOperation(raw: Record<string, unknown>) {
  const { babyId, expectedRevision } = openingSchema.parse(raw);
  const ctx = await getBrowserOperationContextForBaby(babyId);
  return issueBrowserOperation({
    ctx,
    operationId: raw.operationId,
    operationKey: BrowserOperationKey.plannedScheduleSave,
    opening: { babyId, expectedRevision },
    babyId,
    targetKind: "baby",
    targetId: babyId,
    permission: "baby.manage",
    validate: async (tx, lockedCtx, baby) => {
      if (await lockRevision(tx, lockedCtx.householdId, baby.id) !== expectedRevision) throw new Error("stale_revision");
    },
    targetSnapshot: async (tx, lockedCtx, baby) => ({
      kind: "planned-schedule-save",
      schemaVersion: 1,
      babyId: baby.id,
      revision: await lockRevision(tx, lockedCtx.householdId, baby.id)
    })
  });
}

export async function submitPlannedScheduleBrowserOperation(raw: Record<string, unknown>) {
  const { babyId } = openingSchema.pick({ babyId: true }).parse(raw);
  const items = parsePlannedScheduleItems(raw.items);
  const ctx = await getBrowserOperationContextForBaby(babyId);
  return executeBrowserOperation({
    ctx,
    operationId: raw.operationId,
    operationKey: BrowserOperationKey.plannedScheduleSave,
    intent: { babyId, items },
    babyId,
    permission: "baby.manage",
    validate: async (tx, lockedCtx, baby, binding) => {
      const snapshot = snapshotSchema.safeParse(binding.targetSnapshot);
      if (!snapshot.success || snapshot.data.babyId !== baby.id) throw new Error("not_found");
      if (await lockRevision(tx, lockedCtx.householdId, baby.id) !== snapshot.data.revision) throw new Error("stale_revision");
    },
    execute: async (tx, lockedCtx, baby) => {
      const current = await lockRevision(tx, lockedCtx.householdId, baby.id);
      const revision = current + 1;
      const document = { schemaVersion: PLANNED_SCHEDULE_SCHEMA_VERSION, items } as Prisma.InputJsonValue;
      if (current === 0) {
        await tx.plannedSchedule.create({ data: { householdId: lockedCtx.householdId, babyId: baby.id, revision, document } });
      } else {
        const updated = await tx.plannedSchedule.updateMany({
          where: { householdId: lockedCtx.householdId, babyId: baby.id, revision: current },
          data: { revision, document }
        });
        if (updated.count !== 1) throw new Error("stale_revision");
      }
      await writeAudit(lockedCtx, {
        action: "planned_schedule.save",
        entityType: "baby",
        entityId: baby.id,
        babyId: baby.id,
        after: { revision, itemCount: items.length }
      }, tx);
      return { kind: "planned_schedule", code: "ok", babyId: baby.id, revision, itemCount: items.length };
    }
  });
}
