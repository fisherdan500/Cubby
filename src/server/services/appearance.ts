import { prisma } from "@/lib/db/prisma";
import { accentThemeSchema, parseAccentTheme } from "@/domain/appearance";
import { getHouseholdContext, requirePermission } from "@/server/auth/context";
import { requireUser } from "@/server/auth/session";
import { writeAudit } from "@/server/services/audit";

export async function getHouseholdAppearance() {
  const ctx = await getHouseholdContext();
  requirePermission(ctx, "activity.read");
  const settings = await prisma.householdSettings.findUnique({
    where: { householdId: ctx.householdId },
    select: { accentTheme: true }
  });
  return { accentTheme: parseAccentTheme(settings?.accentTheme) };
}

export async function getCurrentAppearanceTheme() {
  const user = await requireUser().catch(() => null);
  if (!user) return "sage" as const;
  const member = await prisma.householdMember.findFirst({
    where: { userId: user.id, deletedAt: null, household: { deletedAt: null } },
    select: { household: { select: { settings: { select: { accentTheme: true } } } } },
    orderBy: { joinedAt: "asc" }
  });
  return parseAccentTheme(member?.household.settings?.accentTheme);
}

export async function updateHouseholdAppearance(raw: unknown) {
  const ctx = await getHouseholdContext();
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
