import type { Prisma } from "@prisma/client";
import { BrowserOperationKey, BrowserOperationTargetKind } from "@prisma/client";
import {
  normalizeItemName,
  parseUnitPreferences,
  unitPreferencesSchema,
  type UnitPreferences
} from "@/domain/unit-preferences";
import { prisma } from "@/lib/db/prisma";
import { getEffectiveHouseholdContext, requirePermission } from "@/server/auth/context";
import { writeAudit } from "@/server/services/audit";
import {
  executeHouseholdBrowserOperation,
  getBrowserOperationContextForHousehold,
  issueHouseholdBrowserOperation
} from "@/server/services/browser-operations";

const unitSettingsSnapshotSchemaVersion = 1;

type UnitSettingsSnapshot = {
  settingsState: "absent" | "present";
  updatedAt: string | null;
  unitPreferences: UnitPreferences;
  schemaVersion: typeof unitSettingsSnapshotSchemaVersion;
};

export async function getActivityUnitPreferences() {
  const ctx = await getEffectiveHouseholdContext();
  requirePermission(ctx, "activity.read");
  return readPreferenceCatalog(ctx.householdId);
}

export async function getUnitPreferenceSettings() {
  const ctx = await getEffectiveHouseholdContext();
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

async function readPreferences(householdId: string) {
  const settings = await prisma.householdSettings.findUnique({
    where: { householdId },
    select: { unitPreferences: true }
  });
  return parseUnitPreferences(settings?.unitPreferences);
}

async function lockAndSnapshotUnitSettings(tx: Prisma.TransactionClient, householdId: string): Promise<UnitSettingsSnapshot> {
  await tx.$queryRaw`SELECT "householdId" FROM "HouseholdSettings" WHERE "householdId" = ${householdId} FOR UPDATE`;
  const settings = await tx.householdSettings.findUnique({
    where: { householdId },
    select: { unitPreferences: true, updatedAt: true }
  });
  if (!settings) {
    return {
      settingsState: "absent",
      updatedAt: null,
      unitPreferences: parseUnitPreferences(null),
      schemaVersion: unitSettingsSnapshotSchemaVersion
    };
  }
  return {
    settingsState: "present",
    updatedAt: settings.updatedAt.toISOString(),
    unitPreferences: parseUnitPreferences(settings.unitPreferences),
    schemaVersion: unitSettingsSnapshotSchemaVersion
  };
}

export async function issueUnitPreferencesBrowserOperation(raw: { operationId?: unknown }) {
  const ctx = await getBrowserOperationContextForHousehold();
  return issueHouseholdBrowserOperation({
    ctx,
    operationId: raw.operationId,
    operationKey: BrowserOperationKey.settingsUnitsUpdate,
    targetKind: BrowserOperationTargetKind.settings,
    permission: "household.manage",
    targetSnapshot: (tx, lockedCtx) => lockAndSnapshotUnitSettings(tx, lockedCtx.householdId)
  });
}

export async function submitUnitPreferencesBrowserOperation(raw: { operationId?: unknown } & Record<string, unknown>) {
  const { operationId: _operationId, ...payload } = raw;
  const preferences = unitPreferencesSchema.parse(payload);
  const unitPreferences = preferences as Prisma.InputJsonValue;
  const ctx = await getBrowserOperationContextForHousehold();
  return executeHouseholdBrowserOperation({
    ctx,
    operationId: raw.operationId,
    operationKey: BrowserOperationKey.settingsUnitsUpdate,
    targetKind: BrowserOperationTargetKind.settings,
    permission: "household.manage",
    intent: preferences,
    execute: async (tx, lockedCtx, binding) => {
      const opening = binding.targetSnapshot as UnitSettingsSnapshot;
      const current = await lockAndSnapshotUnitSettings(tx, lockedCtx.householdId);
      if (
        current.settingsState !== opening.settingsState ||
        current.updatedAt !== opening.updatedAt ||
        opening.schemaVersion !== unitSettingsSnapshotSchemaVersion
      ) {
        throw new Error("stale_revision");
      }
      if (opening.settingsState === "absent") {
        await tx.householdSettings.create({ data: { householdId: lockedCtx.householdId, unitPreferences } });
      } else {
        const updated = await tx.householdSettings.updateMany({
          where: { householdId: lockedCtx.householdId, updatedAt: new Date(opening.updatedAt!) },
          data: { unitPreferences }
        });
        if (updated.count !== 1) throw new Error("stale_revision");
      }
      await writeAudit(lockedCtx, {
        action: "settings.units.update",
        entityType: "household",
        entityId: lockedCtx.householdId,
        before: opening.unitPreferences as Prisma.InputJsonValue,
        after: preferences as Prisma.InputJsonValue
      }, tx);
      return { kind: "units_updated", code: "ok", settingsScope: "household" } as const;
    }
  });
}

function mergeCatalogNames(configured: string[], logged: string[]) {
  const names = new Map<string, string>();
  for (const name of [...configured, ...logged]) {
    const normalized = normalizeItemName(name);
    if (normalized && !names.has(normalized)) names.set(normalized, name.trim().replace(/\s+/g, " "));
  }
  return [...names.values()].sort((left, right) => left.localeCompare(right, "en-US", { sensitivity: "base" }));
}
