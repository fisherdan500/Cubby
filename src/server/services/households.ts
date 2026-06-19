import { HouseholdRole } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { onboardingSchema, babySchema } from "@/lib/validation/onboarding";
import { requireUser } from "@/server/auth/session";
import { getHouseholdContext, requirePermission } from "@/server/auth/context";
import { writeAudit } from "@/server/services/audit";
import { getAppRegistrationPolicy } from "@/server/services/registration";

export async function listHouseholdsForUser(userId: string) {
  return prisma.householdMember.findMany({
    where: { userId, deletedAt: null, household: { deletedAt: null } },
    include: { household: true },
    orderBy: { joinedAt: "asc" }
  });
}

export async function createOnboardingHousehold(raw: unknown) {
  const user = await requireUser();
  const input = onboardingSchema.parse(raw);
  const birthDate = input.birthDate ? new Date(input.birthDate) : undefined;

  const existing = await listHouseholdsForUser(user.id);
  if (existing.length > 0) return existing[0].household;

  const policy = await getAppRegistrationPolicy();
  if (!policy.newHouseholdCreationAllowed) throw new Error("forbidden");

  return prisma.household.create({
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
          timezone: input.timezone
        }
      },
      settings: {
        create: {
          allowPublicRegistration: false,
          allowNewHouseholdCreation: false
        }
      }
    },
    include: { settings: true }
  });
}

export async function addBaby(raw: unknown) {
  const ctx = await getHouseholdContext();
  requirePermission(ctx, "baby.manage");
  const input = babySchema.parse(raw);
  const baby = await prisma.baby.create({
    data: {
      householdId: ctx.householdId,
      name: input.name,
      birthDate: input.birthDate ? new Date(input.birthDate) : undefined,
      timezone: input.timezone,
      notes: input.notes || undefined,
      feedingWarningMinutes: input.feedingWarningMinutes,
      diaperWarningMinutes: input.diaperWarningMinutes,
      sleepWarningMinutes: input.sleepWarningMinutes
    }
  });
  await writeAudit(ctx, {
    action: "baby.create",
    entityType: "baby",
    entityId: baby.id,
    after: baby
  });
  return baby;
}

export async function listBabies() {
  const ctx = await getHouseholdContext();
  requirePermission(ctx, "activity.read");
  return prisma.baby.findMany({
    where: { householdId: ctx.householdId, deletedAt: null },
    orderBy: { createdAt: "asc" }
  });
}

export async function getHouseholdHome(userId: string) {
  const member = await prisma.householdMember.findFirst({
    where: { userId, deletedAt: null, household: { deletedAt: null } },
    include: {
      household: {
        include: {
          babies: {
            where: { deletedAt: null },
            orderBy: { createdAt: "asc" }
          }
        }
      }
    },
    orderBy: { joinedAt: "asc" }
  });
  return member;
}
