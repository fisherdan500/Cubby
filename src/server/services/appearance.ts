import type { Prisma } from "@prisma/client";
import { BrowserOperationKey, BrowserOperationTargetKind } from "@prisma/client";
import { accentThemeSchema, parseAccentTheme } from "@/domain/appearance";
import { prisma } from "@/lib/db/prisma";
import { getEffectiveHouseholdContext, requirePermission } from "@/server/auth/context";
import { writeAudit } from "@/server/services/audit";
import {
  executeHouseholdBrowserOperation,
  getBrowserOperationContextForHousehold,
  issueHouseholdBrowserOperation
} from "@/server/services/browser-operations";

const appearanceSnapshotSchemaVersion = 1;
type AppearanceSnapshot = {
  settingsState: "absent" | "present";
  updatedAt: string | null;
  accentTheme: ReturnType<typeof parseAccentTheme>;
  schemaVersion: typeof appearanceSnapshotSchemaVersion;
};

export async function getHouseholdAppearance() {
  const ctx = await getEffectiveHouseholdContext();
  requirePermission(ctx, "activity.read");
  const settings = await prisma.householdSettings.findUnique({
    where: { householdId: ctx.householdId },
    select: { accentTheme: true }
  });
  return { accentTheme: parseAccentTheme(settings?.accentTheme) };
}

export async function getCurrentAppearanceTheme() {
  const ctx = await getEffectiveHouseholdContext();
  const settings = await prisma.householdSettings.findUnique({
    where: { householdId: ctx.householdId },
    select: { accentTheme: true }
  });
  return parseAccentTheme(settings?.accentTheme);
}

async function lockAndSnapshotAppearance(tx: Prisma.TransactionClient, householdId: string): Promise<AppearanceSnapshot> {
  await tx.$queryRaw`SELECT "householdId" FROM "HouseholdSettings" WHERE "householdId" = ${householdId} FOR UPDATE`;
  const settings = await tx.householdSettings.findUnique({
    where: { householdId },
    select: { accentTheme: true, updatedAt: true }
  });
  return settings
    ? { settingsState: "present", updatedAt: settings.updatedAt.toISOString(), accentTheme: parseAccentTheme(settings.accentTheme), schemaVersion: appearanceSnapshotSchemaVersion }
    : { settingsState: "absent", updatedAt: null, accentTheme: "sage", schemaVersion: appearanceSnapshotSchemaVersion };
}

export async function issueHouseholdAppearanceBrowserOperation(raw: { operationId?: unknown }) {
  const ctx = await getBrowserOperationContextForHousehold();
  return issueHouseholdBrowserOperation({
    ctx,
    operationId: raw.operationId,
    operationKey: BrowserOperationKey.householdAccentUpdate,
    targetKind: BrowserOperationTargetKind.settings,
    permission: "household.manage",
    targetSnapshot: (tx, lockedCtx) => lockAndSnapshotAppearance(tx, lockedCtx.householdId)
  });
}

export async function submitHouseholdAppearanceBrowserOperation(raw: { operationId?: unknown; accentTheme?: unknown }) {
  const accentTheme = accentThemeSchema.parse(raw.accentTheme);
  const ctx = await getBrowserOperationContextForHousehold();
  return executeHouseholdBrowserOperation({
    ctx,
    operationId: raw.operationId,
    operationKey: BrowserOperationKey.householdAccentUpdate,
    targetKind: BrowserOperationTargetKind.settings,
    permission: "household.manage",
    intent: { accentTheme },
    execute: async (tx, lockedCtx, binding) => {
      const opening = binding.targetSnapshot as AppearanceSnapshot;
      const current = await lockAndSnapshotAppearance(tx, lockedCtx.householdId);
      if (current.settingsState !== opening.settingsState || current.updatedAt !== opening.updatedAt || opening.schemaVersion !== appearanceSnapshotSchemaVersion) {
        throw new Error("stale_revision");
      }
      if (opening.settingsState === "absent") {
        await tx.householdSettings.create({ data: { householdId: lockedCtx.householdId, accentTheme } });
      } else {
        const updated = await tx.householdSettings.updateMany({
          where: { householdId: lockedCtx.householdId, updatedAt: new Date(opening.updatedAt!) },
          data: { accentTheme }
        });
        if (updated.count !== 1) throw new Error("stale_revision");
      }
      await writeAudit(lockedCtx, {
        action: "settings.appearance.update",
        entityType: "household",
        entityId: lockedCtx.householdId,
        before: { accentTheme: opening.accentTheme },
        after: { accentTheme }
      }, tx);
      return { kind: "household_accent", code: "ok", settingsScope: "household", accentTheme } as const;
    }
  });
}
