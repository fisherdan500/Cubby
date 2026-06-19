import { createHash } from "crypto";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdContext, requirePermission } from "@/server/auth/context";
import { activityInclude, createActivity } from "@/server/services/activities";

const restoreSchema = z.object({
  version: z.literal(1),
  babies: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      birthDate: z.string().nullable().optional(),
      timezone: z.string().default("UTC"),
      notes: z.string().nullable().optional()
    })
  ),
  activities: z.array(z.record(z.string(), z.unknown())).default([])
});

export async function exportBackupJson() {
  const ctx = await getHouseholdContext();
  requirePermission(ctx, "backup.manage");
  const [household, babies, activities] = await Promise.all([
    prisma.household.findUniqueOrThrow({ where: { id: ctx.householdId } }),
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
    notes: activity.notes ?? undefined
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
  const babyMap = new Map<string, string>();

  for (const baby of input.babies) {
    const existing = await prisma.baby.findFirst({
      where: { householdId: ctx.householdId, deletedAt: null, name: baby.name }
    });
    const saved =
      existing ??
      (await prisma.baby.create({
        data: {
          householdId: ctx.householdId,
          name: baby.name,
          birthDate: baby.birthDate ? new Date(baby.birthDate) : undefined,
          timezone: baby.timezone,
          notes: baby.notes ?? undefined
        }
      }));
    babyMap.set(baby.id, saved.id);
  }

  let restored = 0;
  for (const activity of input.activities) {
    const originalBabyId = typeof activity.babyId === "string" ? activity.babyId : "";
    const babyId = babyMap.get(originalBabyId) ?? originalBabyId;
    if (!babyId) continue;
    const created = await createActivity({ ...activity, babyId }).catch(() => null);
    if (created) restored += 1;
  }

  await prisma.backupRecord.create({
    data: {
      householdId: ctx.householdId,
      actorUserId: ctx.userId,
      kind: "restore",
      status: "complete",
      itemCount: restored
    }
  });
  return { restored };
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
