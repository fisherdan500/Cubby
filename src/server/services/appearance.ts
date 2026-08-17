import { prisma } from "@/lib/db/prisma";
import { accentThemeSchema, parseAccentTheme } from "@/domain/appearance";
import { getEffectiveHouseholdContext, requirePermission } from "@/server/auth/context";
import { writeAudit } from "@/server/services/audit";

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

export async function updateHouseholdAppearance(raw: unknown) {
  const ctx = await getEffectiveHouseholdContext();
  requirePermission(ctx, "household.manage");
  const accentTheme = accentThemeSchema.parse((raw as { accentTheme?: unknown })?.accentTheme);
  const settings = await prisma.householdSettings.upsert({
    where: { householdId: ctx.householdId },
    update: { accentTheme },
    create: { householdId: ctx.householdId, accentTheme }
  });
  await writeAudit(ctx, {
    action: "settings.appearance.update",
    entityType: "household",
    entityId: ctx.householdId,
    after: { accentTheme }
  });
  return { accentTheme: parseAccentTheme(settings.accentTheme) };
}
