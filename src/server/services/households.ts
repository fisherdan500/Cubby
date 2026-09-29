import { BrowserOperationKey, BrowserOperationTargetKind, HouseholdRole, TimerState, type Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { env } from "@/lib/env";
import { onboardingSchema, babySchema } from "@/lib/validation/onboarding";
import { requireUser } from "@/server/auth/session";
import { getEffectiveHouseholdContext, requirePermission } from "@/server/auth/context";
import { writeAudit } from "@/server/services/audit";
import { lockActorAndBabyForWrite, lockActorForWrite, lockHouseholdCreation } from "@/server/services/mutation-locks";
import { getAppRegistrationPolicy } from "@/server/services/registration";
import { PLATFORM_SINGLETON_ID } from "@/server/services/platform-constants";
import {
  executeBrowserOperation,
  executeHouseholdBrowserOperation,
  getBrowserOperationContextForHousehold,
  getBrowserOperationContextForLifecycleBaby,
  issueBrowserOperation,
  issueHouseholdBrowserOperation
} from "@/server/services/browser-operations";

type BabyQueryOptions = {
  includeInactive?: boolean;
};

export async function listHouseholdsForUser(userId: string) {
  return prisma.householdMember.findMany({
    where: { userId, disabledAt: null, deletedAt: null, household: { deletedAt: null } },
    include: { household: true },
    orderBy: [{ household: { name: "asc" } }, { id: "asc" }]
  });
}

export async function createOnboardingHousehold(raw: unknown) {
  const user = await requireUser();
  if (!user.emailVerified) throw new Error("email_not_verified");
  const input = onboardingSchema.parse(raw);
  const birthDate = input.birthDate ? new Date(input.birthDate) : undefined;

  return prisma.$transaction(async (tx) => {
    await lockHouseholdCreation(tx);
    const currentMemberships = await tx.householdMember.findMany({
      where: { userId: user.id, deletedAt: null, household: { deletedAt: null } },
      include: { household: true },
      orderBy: { joinedAt: "asc" }
    });
    const activeMembership = currentMemberships.find((member) => !member.disabledAt);
    if (activeMembership) return activeMembership.household;
    if (currentMemberships.length > 0) throw new Error("suspended_membership_must_leave");

    await tx.$queryRaw`SELECT "id"
      FROM "PlatformSettings"
      WHERE "id" = ${PLATFORM_SINGLETON_ID}
      FOR SHARE`;
    const policy = await getAppRegistrationPolicy(tx);
    if (!policy.newHouseholdCreationAllowed) throw new Error("forbidden");

    const created = await tx.household.create({
      data: {
        name: input.householdName,
        createdByUserId: user.id,
        members: {
          create: {
            userId: user.id,
            role: HouseholdRole.owner,
            displayName: user.name
          }
        },
        babies: {
          create: {
            name: input.babyName,
            birthDate,
            timezone: env.APP_TIMEZONE
          }
        },
        settings: {
          create: {
            allowPublicRegistration: false,
            allowNewHouseholdCreation: false
          }
        }
      },
      include: {
        settings: true,
        members: { select: { id: true } },
        babies: { select: { id: true } }
      }
    });
    const actorContext = {
      userId: user.id,
      householdId: created.id,
      memberId: created.members[0]?.id
    };
    await writeAudit(actorContext, {
      action: "household.create",
      entityType: "household",
      entityId: created.id,
      after: {}
    }, tx);
    const initialBaby = created.babies[0];
    if (!initialBaby) throw new Error("household_initial_baby_missing");
    await writeAudit(actorContext, {
      action: "baby.create",
      entityType: "baby",
      entityId: initialBaby.id,
      babyId: initialBaby.id,
      after: {}
    }, tx);
    const { members: _members, babies: _babies, ...household } = created;
    return household;
  });
}

export async function addBaby(raw: unknown) {
  const ctx = await getEffectiveHouseholdContext();
  requirePermission(ctx, "baby.manage");
  const input = babySchema.parse(raw);
  return prisma.$transaction(async (tx) => {
    const lockedCtx = await lockActorForWrite(tx, ctx);
    requirePermission(lockedCtx, "baby.manage");
    const baby = await tx.baby.create({
      data: {
        householdId: lockedCtx.householdId,
        name: input.name,
        birthDate: input.birthDate ? new Date(input.birthDate) : undefined,
        timezone: env.APP_TIMEZONE,
        notes: input.notes || undefined,
        feedingWarningMinutes: input.feedingWarningMinutes,
        diaperWarningMinutes: input.diaperWarningMinutes,
        sleepWarningMinutes: input.sleepWarningMinutes
      }
    });
    await writeAudit(lockedCtx, {
      action: "baby.create",
      entityType: "baby",
      entityId: baby.id,
      babyId: baby.id,
      after: {}
    }, tx);
    return baby;
  });
}

const babyCreateSnapshot = { kind: "baby-create", schemaVersion: 1 } as const;

export async function issueCreateBabyBrowserOperation(raw: Record<string, unknown>) {
  const ctx = await getBrowserOperationContextForHousehold();
  return issueHouseholdBrowserOperation({
    ctx,
    operationId: raw.operationId,
    operationKey: BrowserOperationKey.babyCreate,
    targetKind: BrowserOperationTargetKind.baby,
    permission: "baby.manage",
    targetSnapshot: () => babyCreateSnapshot
  });
}

export async function submitCreateBabyBrowserOperation(raw: Record<string, unknown>) {
  const { operationId, ...inputRaw } = raw;
  const input = babySchema.parse(inputRaw);
  const ctx = await getBrowserOperationContextForHousehold();
  return executeHouseholdBrowserOperation({
    ctx,
    operationId,
    operationKey: BrowserOperationKey.babyCreate,
    targetKind: BrowserOperationTargetKind.baby,
    permission: "baby.manage",
    intent: input,
    validate: async (_tx, _ctx, binding) => {
      const opening = binding.targetSnapshot as typeof babyCreateSnapshot;
      if (opening.kind !== babyCreateSnapshot.kind || opening.schemaVersion !== babyCreateSnapshot.schemaVersion) {
        throw new Error("stale_revision");
      }
    },
    execute: async (tx, lockedCtx) => {
      const baby = await tx.baby.create({
        data: {
          householdId: lockedCtx.householdId,
          name: input.name,
          birthDate: input.birthDate ? new Date(input.birthDate) : undefined,
          timezone: env.APP_TIMEZONE,
          notes: input.notes || undefined,
          feedingWarningMinutes: input.feedingWarningMinutes,
          diaperWarningMinutes: input.diaperWarningMinutes,
          sleepWarningMinutes: input.sleepWarningMinutes
        }
      });
      await writeAudit(lockedCtx, {
        action: "baby.create",
        entityType: "baby",
        entityId: baby.id,
        babyId: baby.id,
        after: {}
      }, tx);
      return { kind: "baby_create", code: "ok", babyId: baby.id } as const;
    }
  });
}

function babyWhereClause(householdId: string, options?: BabyQueryOptions) {
  return {
    householdId,
    deletedAt: null,
    ...(options?.includeInactive ? {} : { inactiveAt: null })
  };
}

function nestedBabyWhereClause(options?: BabyQueryOptions) {
  return {
    deletedAt: null,
    ...(options?.includeInactive ? {} : { inactiveAt: null })
  };
}

export async function listBabies(options?: BabyQueryOptions) {
  const ctx = await getEffectiveHouseholdContext();
  requirePermission(ctx, "activity.read");
  return prisma.baby.findMany({
    where: babyWhereClause(ctx.householdId, options),
    orderBy: { createdAt: "asc" }
  });
}

export async function getHouseholdHome(options?: BabyQueryOptions) {
  const ctx = await getEffectiveHouseholdContext();
  const member = await prisma.householdMember.findFirst({
    where: {
      id: ctx.memberId,
      userId: ctx.userId,
      disabledAt: null,
      deletedAt: null,
      household: { deletedAt: null }
    },
    include: {
      household: {
        include: {
          settings: true,
          babies: {
            where: nestedBabyWhereClause(options),
            orderBy: { createdAt: "asc" }
          }
        }
      }
    }
  });
  return member;
}

export async function deactivateBaby(babyId: string, inactiveAt = new Date()) {
  const requestContext = await getEffectiveHouseholdContext();
  requirePermission(requestContext, "baby.manage");

  return prisma.$transaction(async (tx) => {
    const { ctx, baby } = await lockActorAndBabyForWrite(tx, requestContext, babyId);
    requirePermission(ctx, "baby.manage");
    if (baby.inactiveAt) return baby;

    const activeTimer = await tx.activityLog.findFirst({
      where: {
        householdId: ctx.householdId,
        babyId: baby.id,
        deletedAt: null,
        timerState: { in: [TimerState.running, TimerState.paused] }
      },
      select: { id: true }
    });
    if (activeTimer) throw new Error("baby_has_active_timer");

    const updated = await tx.baby.update({
      where: { id: baby.id },
      data: { inactiveAt }
    });
    await writeAudit(
      ctx,
      {
        action: "baby.deactivate",
        entityType: "baby",
        entityId: baby.id,
        babyId: baby.id,
        before: { inactiveAt: baby.inactiveAt },
        after: { inactiveAt }
      },
      tx
    );
    return updated;
  });
}

export async function reactivateBaby(babyId: string) {
  const requestContext = await getEffectiveHouseholdContext();
  requirePermission(requestContext, "baby.manage");

  return prisma.$transaction(async (tx) => {
    const { ctx, baby } = await lockActorAndBabyForWrite(tx, requestContext, babyId);
    requirePermission(ctx, "baby.manage");
    if (!baby.inactiveAt) return baby;

    const updated = await tx.baby.update({
      where: { id: baby.id },
      data: { inactiveAt: null }
    });
    await writeAudit(
      ctx,
      {
        action: "baby.reactivate",
        entityType: "baby",
        entityId: baby.id,
        babyId: baby.id,
        before: { inactiveAt: baby.inactiveAt },
        after: { inactiveAt: null }
      },
      tx
    );
    return updated;
  });
}

const browserLifecycleInputSchema = z.object({ babyId: z.string().min(1) });
const lifecycleSnapshotSchema = z.object({
  inactiveAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime()
}).strict();

type BrowserLifecycleAction = "deactivate" | "reactivate";

function lifecycleOperationKey(action: BrowserLifecycleAction) {
  return action === "deactivate" ? BrowserOperationKey.babyDeactivate : BrowserOperationKey.babyReactivate;
}

function lifecycleSnapshot(baby: { inactiveAt: Date | null; updatedAt: Date }) {
  return { inactiveAt: baby.inactiveAt?.toISOString() ?? null, updatedAt: baby.updatedAt.toISOString() };
}

function assertLifecycleSnapshot(action: BrowserLifecycleAction, snapshot: unknown, baby: { inactiveAt: Date | null; updatedAt: Date }) {
  const expected = lifecycleSnapshotSchema.parse(snapshot);
  const actual = lifecycleSnapshot(baby);
  if (expected.updatedAt !== actual.updatedAt || expected.inactiveAt !== actual.inactiveAt) throw new Error("not_found");
  if (action === "deactivate" && baby.inactiveAt) throw new Error("not_found");
  if (action === "reactivate" && !baby.inactiveAt) throw new Error("not_found");
}

async function runBrowserLifecycleTransition(
  tx: Prisma.TransactionClient,
  ctx: Awaited<ReturnType<typeof getBrowserOperationContextForLifecycleBaby>>,
  baby: { id: string; inactiveAt: Date | null },
  action: BrowserLifecycleAction
) {
  if (action === "deactivate") {
    const activeTimer = await tx.activityLog.findFirst({
      where: {
        householdId: ctx.householdId,
        babyId: baby.id,
        deletedAt: null,
        timerState: { in: [TimerState.running, TimerState.paused] }
      },
      select: { id: true }
    });
    if (activeTimer) throw new Error("baby_has_active_timer");
  }

  const inactiveAt = action === "deactivate" ? new Date() : null;
  await tx.baby.update({ where: { id: baby.id }, data: { inactiveAt } });
  await writeAudit(ctx, {
    action: `baby.${action}`,
    entityType: "baby",
    entityId: baby.id,
    babyId: baby.id,
    before: { inactiveAt: baby.inactiveAt },
    after: { inactiveAt }
  }, tx);
}

async function issueBrowserLifecycleOperation(raw: Record<string, unknown>, action: BrowserLifecycleAction) {
  const { babyId } = browserLifecycleInputSchema.parse(raw);
  const ctx = await getBrowserOperationContextForLifecycleBaby(babyId);
  return issueBrowserOperation({
    ctx,
    operationId: raw.operationId,
    operationKey: lifecycleOperationKey(action),
    opening: { babyId },
    babyId,
    targetKind: "baby",
    targetId: babyId,
    permission: "baby.manage",
    allowInactiveTarget: action === "reactivate",
    targetSnapshot: (_tx, _ctx, baby) => lifecycleSnapshot(baby),
    validate: async (_tx, _ctx, baby) => {
      if (action === "deactivate" && baby.inactiveAt) throw new Error("not_found");
      if (action === "reactivate" && !baby.inactiveAt) throw new Error("not_found");
    }
  });
}

async function submitBrowserLifecycleOperation(raw: Record<string, unknown>, action: BrowserLifecycleAction) {
  const { babyId } = browserLifecycleInputSchema.parse(raw);
  const ctx = await getBrowserOperationContextForLifecycleBaby(babyId);
  return executeBrowserOperation({
    ctx,
    operationId: raw.operationId,
    operationKey: lifecycleOperationKey(action),
    intent: { babyId },
    babyId,
    permission: "baby.manage",
    allowInactiveTarget: action === "reactivate",
    validate: async (_tx, _ctx, baby, binding) => assertLifecycleSnapshot(action, binding.targetSnapshot, baby),
    execute: async (tx, lockedCtx, baby) => {
      await runBrowserLifecycleTransition(tx, lockedCtx, baby, action);
      return { kind: "baby_lifecycle", code: "ok", babyId: baby.id, inactive: action === "deactivate" };
    }
  });
}

export function issueDeactivateBabyBrowserOperation(raw: Record<string, unknown>) {
  return issueBrowserLifecycleOperation(raw, "deactivate");
}

export function submitDeactivateBabyBrowserOperation(raw: Record<string, unknown>) {
  return submitBrowserLifecycleOperation(raw, "deactivate");
}

export function issueReactivateBabyBrowserOperation(raw: Record<string, unknown>) {
  return issueBrowserLifecycleOperation(raw, "reactivate");
}

export function submitReactivateBabyBrowserOperation(raw: Record<string, unknown>) {
  return submitBrowserLifecycleOperation(raw, "reactivate");
}
