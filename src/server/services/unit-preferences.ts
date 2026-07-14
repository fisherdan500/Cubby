import type { Prisma } from "@prisma/client";
import {
  normalizeItemName,
  parseUnitPreferences,
  unitPreferencesSchema,
  type UnitPreferences
} from "@/domain/unit-preferences";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdContext, requirePermission } from "@/server/auth/context";
import { writeAudit } from "@/server/services/audit";

export async function getActivityUnitPreferences() {
  const ctx = await getHouseholdContext();
  requirePermission(ctx, "activity.read");
  return readPreferenceCatalog(ctx.householdId);
}

export async function getUnitPreferenceSettings() {
  const ctx = await getHouseholdContext();
  requirePermission(ctx, "household.manage");
  return readPreferenceCatalog(ctx.householdId);
}

async function readPreferenceCatalog(householdId: string) {
  const [preferences, medicineLogs, supplementLogs] = await Promise.all([
    readPreferences(householdId),
    prisma.medicineLog.findMany({
      where: { activity: { householdId, deletedAt: null } },
      select: { name: true },
      distinct: ["name"],
      orderBy: { name: "asc" }
    }),
    prisma.supplementLog.findMany({
      where: { activity: { householdId, deletedAt: null } },
      select: { name: true },
      distinct: ["name"],
      orderBy: { name: "asc" }
    })
  ]);

  return {
    preferences,
    medicineNames: mergeCatalogNames(Object.keys(preferences.medicineUnits), medicineLogs.map(({ name }) => name)),
    supplementNames: mergeCatalogNames(Object.keys(preferences.supplementUnits), supplementLogs.map(({ name }) => name))
  };
}

export async function updateUnitPreferences(raw: unknown) {
  const ctx = await getHouseholdContext();
  requirePermission(ctx, "household.manage");
  const preferences = unitPreferencesSchema.parse(raw);
  const unitPreferences = preferences as Prisma.InputJsonValue;

  await prisma.householdSettings.upsert({
    where: { householdId: ctx.householdId },
    update: { unitPreferences },
    create: { householdId: ctx.householdId, unitPreferences }
  });
  await writeAudit(ctx, {
    action: "settings.units.update",
    entityType: "household",
    entityId: ctx.householdId,
    after: preferences
  });
  return preferences;
}

async function readPreferences(householdId: string) {
  const settings = await prisma.householdSettings.findUnique({
    where: { householdId },
    select: { unitPreferences: true }
  });
  return parseUnitPreferences(settings?.unitPreferences);
}

function mergeCatalogNames(configured: string[], logged: string[]) {
  const names = new Map<string, string>();
  for (const name of [...configured, ...logged]) {
    const normalized = normalizeItemName(name);
    if (normalized && !names.has(normalized)) names.set(normalized, name.trim().replace(/\s+/g, " "));
  }
  return [...names.values()].sort((left, right) => left.localeCompare(right, "en-US", { sensitivity: "base" }));
}
