import { ActivityType, HouseholdRole, TimerState, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { activityInclude, createActivityForContext } from "@/server/services/activities";
import { hashSecret } from "@/server/services/integrations";
import type { HouseholdContext } from "@/server/auth/context";

export type ApiKeyContext = HouseholdContext & {
  apiKeyId: string;
  scopes: string[];
  babyId?: string | null;
};

function apiKeyToken(request: Request) {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (!token) throw new Error("unauthenticated");
  return token;
}

export async function withApiKey<T>(
  request: Request,
  requiredScope: "read" | "write",
  action: (ctx: ApiKeyContext, tx: Prisma.TransactionClient) => Promise<T>
) {
  const keyHash = hashSecret(apiKeyToken(request));
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "ApiKey" WHERE "keyHash" = ${keyHash} FOR UPDATE
    `;
    if (locked.length !== 1) throw new Error("unauthenticated");

    const key = await tx.apiKey.findUnique({ where: { id: locked[0].id }, include: { household: true } });
    if (!key || key.revokedAt || key.household.deletedAt) throw new Error("unauthenticated");
    if (key.expiresAt && key.expiresAt < new Date()) throw new Error("unauthenticated");
    if (!key.scopes.includes(requiredScope) && !key.scopes.includes("*")) throw new Error("forbidden");

    const actor = await tx.householdMember.findFirst({
      where: {
        householdId: key.householdId,
        disabledAt: null,
        deletedAt: null,
        role: { in: [HouseholdRole.owner, HouseholdRole.admin, HouseholdRole.parent] }
      },
      orderBy: { joinedAt: "asc" }
    });
    if (!actor) throw new Error("forbidden");

    await tx.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } });
    return action({
      apiKeyId: key.id,
      scopes: key.scopes,
      babyId: key.babyId,
      userId: actor.userId,
      householdId: key.householdId,
      memberId: actor.id,
      role: actor.role
    }, tx);
  });
}

export async function requireApiKey(request: Request, requiredScope: "read" | "write") {
  return withApiKey(request, requiredScope, async (ctx) => ctx);
}

export function assertBabyAllowed(ctx: ApiKeyContext, babyId: string) {
  if (ctx.babyId && ctx.babyId !== babyId) throw new Error("forbidden");
}

export async function hookBabies(ctx: ApiKeyContext, db: Pick<Prisma.TransactionClient, "baby"> = prisma) {
  return db.baby.findMany({
    where: {
      householdId: ctx.householdId,
      deletedAt: null,
      ...(ctx.babyId ? { id: ctx.babyId } : {})
    },
    orderBy: { createdAt: "asc" }
  });
}

export async function hookBabyStatus(ctx: ApiKeyContext, babyId: string, db: Pick<Prisma.TransactionClient, "baby" | "activityLog"> = prisma) {
  assertBabyAllowed(ctx, babyId);
  const baby = await db.baby.findFirst({ where: { id: babyId, householdId: ctx.householdId, deletedAt: null } });
  if (!baby) throw new Error("not_found");
  const [lastFeeding, lastDiaper, activeTimers] = await Promise.all([
    db.activityLog.findFirst({
      where: { householdId: ctx.householdId, babyId, deletedAt: null, type: ActivityType.feeding },
      include: activityInclude,
      orderBy: { occurredAt: "desc" }
    }),
    db.activityLog.findFirst({
      where: { householdId: ctx.householdId, babyId, deletedAt: null, type: ActivityType.diaper },
      include: activityInclude,
      orderBy: { occurredAt: "desc" }
    }),
    db.activityLog.findMany({
      where: { householdId: ctx.householdId, babyId, deletedAt: null, timerState: { in: [TimerState.running, TimerState.paused] } },
      include: activityInclude,
      orderBy: { startedAt: "desc" }
    })
  ]);
  return { baby, lastFeeding, lastDiaper, activeTimers };
}

export async function hookActivities(ctx: ApiKeyContext, babyId: string, db: Pick<Prisma.TransactionClient, "activityLog"> = prisma) {
  assertBabyAllowed(ctx, babyId);
  return db.activityLog.findMany({
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

export async function hookLatestMeasurements(ctx: ApiKeyContext, babyId: string, db: Pick<Prisma.TransactionClient, "activityLog"> = prisma) {
  assertBabyAllowed(ctx, babyId);
  return db.activityLog.findMany({
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
