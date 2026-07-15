import { createHash } from "crypto";
import { TimerState, type Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { parseAccentTheme } from "@/domain/appearance";
import { parseUnitPreferences } from "@/domain/unit-preferences";
import { activityCreateSchema } from "@/lib/validation/activity";
import { getHouseholdContext, requirePermission } from "@/server/auth/context";
import { activityInclude, restoreHistoricalActivityForContext } from "@/server/services/activities";
import { writeAudit } from "@/server/services/audit";
import { lockActorForWrite, lockBabyForWrite } from "@/server/services/mutation-locks";

const backupDateTime = z.string().datetime({ offset: true });
const backupTimerMetadata = z
  .object({
    timerState: z.enum(["none", "running", "paused", "stopped"]).optional(),
    durationSeconds: z.number().int().nonnegative().nullable().optional(),
    pausedAt: backupDateTime.nullable().optional(),
    pausedSeconds: z.number().int().nonnegative().optional()
  })
  .passthrough();

const timerMetadataFields = ["timerState", "durationSeconds", "pausedAt", "pausedSeconds"] as const;
const timerCapableBackupTypes = new Set(["feeding", "sleep", "pumping", "play"]);

type BackupActivityInput = z.infer<typeof activityCreateSchema>;

function parseHistoricalTimerMetadata(rawActivity: Record<string, unknown>, activity: BackupActivityInput) {
  const metadata = backupTimerMetadata.parse(rawActivity);
  const presentFields = timerMetadataFields.filter((field) => Object.prototype.hasOwnProperty.call(rawActivity, field));

  if (activity.activeTimer || metadata.timerState === "running" || metadata.timerState === "paused") {
    throw new Error("backup_active_timer");
  }
  if (metadata.timerState === undefined) {
    if (presentFields.length) throw new Error("backup_invalid_timer");
    return undefined;
  }
  if (presentFields.length !== timerMetadataFields.length) throw new Error("backup_invalid_timer");

  const hasStartedAt = activity.startedAt !== undefined;
  const hasEndedAt = activity.endedAt !== undefined;
  const wallSeconds =
    hasStartedAt && hasEndedAt
      ? Math.max(0, Math.round((new Date(activity.endedAt!).getTime() - new Date(activity.startedAt!).getTime()) / 1000))
      : null;

  if (metadata.timerState === "none") {
    if (
      metadata.durationSeconds === undefined ||
      metadata.pausedAt !== null ||
      metadata.pausedSeconds !== 0 ||
      metadata.durationSeconds !== wallSeconds
    ) {
      throw new Error("backup_invalid_timer");
    }
    return undefined;
  }

  if (
    !timerCapableBackupTypes.has(activity.type) ||
    !hasStartedAt ||
    !hasEndedAt ||
    metadata.durationSeconds == null ||
    metadata.pausedAt !== null ||
    metadata.pausedSeconds === undefined ||
    metadata.durationSeconds + metadata.pausedSeconds !== wallSeconds
  ) {
    throw new Error("backup_invalid_timer");
  }
  return {
    timerState: metadata.timerState,
    durationSeconds: metadata.durationSeconds,
    pausedSeconds: metadata.pausedSeconds
  };
}

const restoreSchema = z.object({
  version: z.literal(1),
  settings: z
    .object({
      accentTheme: z.unknown().optional(),
      unitPreferences: z.unknown().optional()
    })
    .optional(),
  babies: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      birthDate: backupDateTime.nullable().optional(),
      timezone: z.string().default("UTC"),
      notes: z.string().nullable().optional(),
      inactiveAt: backupDateTime.nullable().optional()
    })
  ),
  activities: z.array(z.record(z.string(), z.unknown())).default([])
});

export async function exportBackupJson() {
  const ctx = await getHouseholdContext();
  requirePermission(ctx, "backup.manage");
  const [household, settings, babies, activities] = await Promise.all([
    prisma.household.findUniqueOrThrow({ where: { id: ctx.householdId } }),
    prisma.householdSettings.findUnique({ where: { householdId: ctx.householdId } }),
    prisma.baby.findMany({ where: { householdId: ctx.householdId, deletedAt: null }, orderBy: { createdAt: "asc" } }),
    prisma.activityLog.findMany({
      where: { householdId: ctx.householdId, deletedAt: null },
      include: activityInclude,
      orderBy: { occurredAt: "asc" }
    })
  ]);
  const payload = {
    version: 1 as const,
    exportedAt: new Date().toISOString(),
    household: { id: household.id, name: household.name },
    settings: {
      accentTheme: parseAccentTheme(settings?.accentTheme),
      unitPreferences: parseUnitPreferences(settings?.unitPreferences)
    },
    babies,
    activities: activities.map(activityToInput)
  };
  const json = JSON.stringify(payload, null, 2);
  await prisma.backupRecord.create({
    data: {
      householdId: ctx.householdId,
      actorUserId: ctx.userId,
      kind: "export",
      status: "complete",
      itemCount: babies.length + activities.length,
      checksum: createHash("sha256").update(json).digest("hex")
    }
  });
  return json;
}

function dateValue(date: Date | null | undefined) {
  return date ? date.toISOString() : undefined;
}

function decimalValue(value: unknown) {
  return value == null ? undefined : String(value);
}

type BackupActivity = Prisma.ActivityLogGetPayload<{ include: typeof activityInclude }>;

function activityToInput(activity: BackupActivity) {
  const base = {
    babyId: activity.babyId,
    type: activity.type,
    occurredAt: activity.occurredAt.toISOString(),
    startedAt: dateValue(activity.startedAt),
    endedAt: dateValue(activity.endedAt),
    timezone: activity.timezone,
    notes: activity.notes ?? undefined,
    activeTimer: activity.timerState === TimerState.running || activity.timerState === TimerState.paused,
    timerState: activity.timerState,
    durationSeconds: activity.durationSeconds,
    pausedAt: activity.pausedAt?.toISOString() ?? null,
    pausedSeconds: activity.pausedSeconds
  };

  if (activity.feeding) {
    return {
      ...base,
      mode: activity.feeding.mode,
      amount: decimalValue(activity.feeding.amount),
      unit: activity.feeding.unit ?? undefined,
      side: activity.feeding.side ?? undefined,
      bottleType: activity.feeding.bottleType ?? undefined,
      food: activity.feeding.food ?? undefined,
      leftSeconds: activity.feeding.leftSeconds ?? undefined,
      rightSeconds: activity.feeding.rightSeconds ?? undefined
    };
  }
  if (activity.diaper) {
    return {
      ...base,
      kind: activity.diaper.kind,
      color: activity.diaper.color ?? undefined,
      consistency: activity.diaper.consistency ?? undefined,
      rashConcern: activity.diaper.rashConcern,
      condition: activity.diaper.condition ?? undefined,
      blowout: activity.diaper.blowout,
      creamApplied: activity.diaper.creamApplied
    };
  }
  if (activity.sleep) {
    return {
      ...base,
      sleepType: activity.sleep.sleepType ?? undefined,
      location: activity.sleep.location ?? undefined,
      quality: activity.sleep.quality ?? undefined
    };
  }
  if (activity.pumping) {
    return {
      ...base,
      amount: decimalValue(activity.pumping.amount),
      leftAmount: decimalValue(activity.pumping.leftAmount),
      rightAmount: decimalValue(activity.pumping.rightAmount),
      unit: activity.pumping.unit ?? undefined,
      inventoryAction: activity.pumping.inventoryAction ?? undefined
    };
  }
  if (activity.medicine) {
    return {
      ...base,
      name: activity.medicine.name,
      dose: decimalValue(activity.medicine.dose),
      unit: activity.medicine.unit ?? undefined,
      contactId: activity.medicine.contactId ?? undefined
    };
  }
  if (activity.measurement) {
    return {
      ...base,
      weight: decimalValue(activity.measurement.weight),
      weightUnit: activity.measurement.weightUnit ?? undefined,
      length: decimalValue(activity.measurement.length),
      lengthUnit: activity.measurement.lengthUnit ?? undefined,
      headCircumference: decimalValue(activity.measurement.headCircumference),
      headUnit: activity.measurement.headUnit ?? undefined,
      temperature: decimalValue(activity.measurement.temperature),
      temperatureUnit: activity.measurement.temperatureUnit ?? undefined,
      measurementType: activity.measurement.measurementType ?? undefined
    };
  }
  if (activity.milestone) return { ...base, title: activity.milestone.title, category: activity.milestone.category ?? undefined };
  if (activity.note) return { ...base, text: activity.note.text, category: activity.note.category ?? undefined };
  if (activity.bath) {
    return {
      ...base,
      bathType: activity.bath.bathType ?? undefined,
      products: activity.bath.products ?? undefined,
      waterTemp: activity.bath.waterTemp ?? undefined
    };
  }
  if (activity.play) {
    return {
      ...base,
      activityName: activity.play.activityName ?? undefined,
      location: activity.play.location ?? undefined,
      intensity: activity.play.intensity ?? undefined
    };
  }
  if (activity.mood) {
    return {
      ...base,
      mood: activity.mood.mood,
      intensity: activity.mood.intensity ?? undefined,
      context: activity.mood.context ?? undefined
    };
  }
  if (activity.supplement) {
    return {
      ...base,
      name: activity.supplement.name,
      dose: decimalValue(activity.supplement.dose),
      unit: activity.supplement.unit ?? undefined
    };
  }
  if (activity.vaccine) {
    return {
      ...base,
      name: activity.vaccine.name,
      dose: activity.vaccine.dose ?? undefined,
      lot: activity.vaccine.lot ?? undefined,
      provider: activity.vaccine.provider ?? undefined,
      dueDate: dateValue(activity.vaccine.dueDate),
      documentUrl: activity.vaccine.documentUrl ?? undefined
    };
  }
  if (activity.milkInventory) {
    return {
      ...base,
      action: activity.milkInventory.action,
      amount: decimalValue(activity.milkInventory.amount),
      unit: activity.milkInventory.unit ?? undefined,
      storage: activity.milkInventory.storage ?? undefined,
      label: activity.milkInventory.label ?? undefined
    };
  }
  return base;
}

export async function restoreBackupJson(raw: unknown) {
  const ctx = await getHouseholdContext();
  requirePermission(ctx, "backup.manage");
  const input = restoreSchema.parse(raw);
  const hasAccentTheme = input.settings?.accentTheme !== undefined;
  const hasUnitPreferences = input.settings?.unitPreferences !== undefined;
  const settings = {
    ...(hasAccentTheme ? { accentTheme: parseAccentTheme(input.settings?.accentTheme) } : {}),
    ...(hasUnitPreferences
      ? { unitPreferences: parseUnitPreferences(input.settings?.unitPreferences) as Prisma.InputJsonValue }
      : {})
  };
  const activities = input.activities.map((rawActivity) => {
    const activity = activityCreateSchema.parse(rawActivity);
    backupDateTime.parse(activity.occurredAt);
    if (activity.startedAt) backupDateTime.parse(activity.startedAt);
    if (activity.endedAt) backupDateTime.parse(activity.endedAt);
    if (activity.type === "vaccine" && activity.dueDate) backupDateTime.parse(activity.dueDate);
    return {
      input: activity,
      timer: parseHistoricalTimerMetadata(rawActivity, activity)
    };
  });

  return prisma.$transaction(
    async (tx) => {
      const lockedCtx = await lockActorForWrite(tx, ctx);
      requirePermission(lockedCtx, "backup.manage");
      if (hasAccentTheme || hasUnitPreferences) {
        await tx.householdSettings.upsert({
          where: { householdId: lockedCtx.householdId },
          update: settings,
          create: { householdId: lockedCtx.householdId, ...settings }
        });
      }

      const babyMap = new Map<string, string>();
      const existingBabies = await tx.baby.findMany({
        where: { householdId: lockedCtx.householdId, deletedAt: null },
        orderBy: { id: "asc" }
      });
      const existingByName = new Map(existingBabies.map((baby) => [baby.name, baby]));
      for (const baby of input.babies) {
        const saved =
          existingByName.get(baby.name) ??
          (await tx.baby.create({
            data: {
              householdId: lockedCtx.householdId,
              name: baby.name,
              birthDate: baby.birthDate ? new Date(baby.birthDate) : undefined,
              timezone: baby.timezone,
              notes: baby.notes ?? undefined
            }
          }));
        babyMap.set(baby.id, saved.id);
        existingByName.set(baby.name, saved);
      }

      const targetBabyIds = new Set(input.babies.map((baby) => babyMap.get(baby.id)!));
      for (const { input: activity } of activities) {
        targetBabyIds.add(babyMap.get(activity.babyId) ?? activity.babyId);
      }
      const lockedBabies = new Map<string, Awaited<ReturnType<typeof lockBabyForWrite>>>();
      for (const babyId of [...targetBabyIds].sort()) {
        lockedBabies.set(babyId, await lockBabyForWrite(tx, lockedCtx, babyId));
      }

      for (const { input: activity, timer } of activities) {
        const babyId = babyMap.get(activity.babyId) ?? activity.babyId;
        await restoreHistoricalActivityForContext({ ...activity, babyId }, lockedCtx, tx, timer);
      }

      for (const baby of input.babies) {
        const babyId = babyMap.get(baby.id)!;
        const current = lockedBabies.get(babyId)!;
        const inactiveAt = baby.inactiveAt ? new Date(baby.inactiveAt) : null;
        const next = await applyRestoredBabyLifecycle(tx, lockedCtx, current, inactiveAt);
        lockedBabies.set(babyId, next);
      }

      await tx.backupRecord.create({
        data: {
          householdId: lockedCtx.householdId,
          actorUserId: lockedCtx.userId,
          kind: "restore",
          status: "complete",
          itemCount: activities.length
        }
      });
      return { restored: activities.length };
    },
    { maxWait: 10_000, timeout: 120_000 }
  );
}

async function applyRestoredBabyLifecycle(
  tx: Prisma.TransactionClient,
  ctx: Awaited<ReturnType<typeof lockActorForWrite>>,
  before: Awaited<ReturnType<typeof lockBabyForWrite>>,
  inactiveAt: Date | null
) {
  if (!before.inactiveAt && inactiveAt) {
    const activeTimer = await tx.activityLog.findFirst({
      where: {
        householdId: ctx.householdId,
        babyId: before.id,
        deletedAt: null,
        timerState: { in: [TimerState.running, TimerState.paused] }
      },
      select: { id: true }
    });
    if (activeTimer) throw new Error("baby_has_active_timer");
  }
  if ((before.inactiveAt?.getTime() ?? null) === (inactiveAt?.getTime() ?? null)) return before;

  const after = await tx.baby.update({ where: { id: before.id }, data: { inactiveAt } });
  if (!before.inactiveAt || !inactiveAt) {
    await writeAudit(
      ctx,
      {
        action: inactiveAt ? "baby.deactivate" : "baby.reactivate",
        entityType: "baby",
        entityId: before.id,
        before,
        after
      },
      tx
    );
  }
  return after;
}

export async function listBackupRecords() {
  const ctx = await getHouseholdContext();
  requirePermission(ctx, "backup.manage");
  return prisma.backupRecord.findMany({
    where: { householdId: ctx.householdId },
    orderBy: { createdAt: "desc" },
    take: 50
  });
}
