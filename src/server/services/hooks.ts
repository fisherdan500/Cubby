import { ActivityType, HouseholdRole, TimerState } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { activityInclude, createActivityForContext } from "@/server/services/activities";
import { hashSecret } from "@/server/services/integrations";
import type { HouseholdContext } from "@/server/auth/context";

export type ApiKeyContext = HouseholdContext & {
  apiKeyId: string;
  scopes: string[];
  babyId?: string | null;
};

export async function requireApiKey(request: Request, requiredScope: "read" | "write") {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (!token) throw new Error("unauthenticated");
  const key = await prisma.apiKey.findUnique({
    where: { keyHash: hashSecret(token) },
    include: { household: true }
  });
  if (!key || key.revokedAt || key.household.deletedAt) throw new Error("unauthenticated");
  if (key.expiresAt && key.expiresAt < new Date()) throw new Error("unauthenticated");
  if (!key.scopes.includes(requiredScope) && !key.scopes.includes("*")) throw new Error("forbidden");
  const actor = await prisma.householdMember.findFirst({
    where: {
      householdId: key.householdId,
      deletedAt: null,
      role: { in: [HouseholdRole.owner, HouseholdRole.parent] }
    },
    orderBy: { joinedAt: "asc" }
  });
  if (!actor) throw new Error("forbidden");
  await prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } });
  return {
    apiKeyId: key.id,
    scopes: key.scopes,
    babyId: key.babyId,
    userId: actor.userId,
    householdId: key.householdId,
    memberId: actor.id,
    role: actor.role
  } satisfies ApiKeyContext;
}

export function assertBabyAllowed(ctx: ApiKeyContext, babyId: string) {
  if (ctx.babyId && ctx.babyId !== babyId) throw new Error("forbidden");
}

export async function hookBabies(ctx: ApiKeyContext) {
  return prisma.baby.findMany({
    where: {
      householdId: ctx.householdId,
      deletedAt: null,
      ...(ctx.babyId ? { id: ctx.babyId } : {})
    },
    orderBy: { createdAt: "asc" }
  });
}

export async function hookBabyStatus(ctx: ApiKeyContext, babyId: string) {
  assertBabyAllowed(ctx, babyId);
  const baby = await prisma.baby.findFirst({ where: { id: babyId, householdId: ctx.householdId, deletedAt: null } });
  if (!baby) throw new Error("not_found");
  const [lastFeeding, lastDiaper, activeTimers] = await Promise.all([
    prisma.activityLog.findFirst({
      where: { householdId: ctx.householdId, babyId, deletedAt: null, type: ActivityType.feeding },
      include: activityInclude,
      orderBy: { occurredAt: "desc" }
    }),
    prisma.activityLog.findFirst({
      where: { householdId: ctx.householdId, babyId, deletedAt: null, type: ActivityType.diaper },
      include: activityInclude,
      orderBy: { occurredAt: "desc" }
    }),
    prisma.activityLog.findMany({
      where: { householdId: ctx.householdId, babyId, deletedAt: null, timerState: { in: [TimerState.running, TimerState.paused] } },
      include: activityInclude,
      orderBy: { startedAt: "desc" }
    })
  ]);
  return { baby, lastFeeding, lastDiaper, activeTimers };
}

export async function hookActivities(ctx: ApiKeyContext, babyId: string) {
  assertBabyAllowed(ctx, babyId);
  return prisma.activityLog.findMany({
    where: { householdId: ctx.householdId, babyId, deletedAt: null },
    include: activityInclude,
    orderBy: { occurredAt: "desc" },
    take: 100
  });
}

export async function hookCreateActivity(ctx: ApiKeyContext, babyId: string, raw: unknown) {
  assertBabyAllowed(ctx, babyId);
  return createActivityForContext({ ...(raw as object), babyId }, ctx);
}

export async function hookLatestMeasurements(ctx: ApiKeyContext, babyId: string) {
  assertBabyAllowed(ctx, babyId);
  return prisma.activityLog.findMany({
    where: { householdId: ctx.householdId, babyId, deletedAt: null, type: ActivityType.measurement },
    include: activityInclude,
    orderBy: { occurredAt: "desc" },
    take: 10
  });
}

export function hookReference() {
  return {
    activityTypes: Object.values(ActivityType),
    units: {
      volume: ["oz", "ml"],
      weight: ["lb", "kg", "g"],
      length: ["in", "cm"],
      temperature: ["F", "C"]
    },
    percentiles: "not_configured"
  };
}
