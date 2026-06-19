import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { env } from "@/lib/env";
import { getHouseholdContext, requirePermission } from "@/server/auth/context";
import { hashInviteToken } from "@/server/services/invites";
import { writeAudit } from "@/server/services/audit";

const registrationSettingsSchema = z.object({
  allowPublicRegistration: z.coerce.boolean().default(false),
  allowNewHouseholdCreation: z.coerce.boolean().default(false)
});

function envEnabled(value: string) {
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export async function ownerOrHouseholdExists() {
  const [households, owners] = await Promise.all([
    prisma.household.count({ where: { deletedAt: null } }),
    prisma.householdMember.count({ where: { deletedAt: null, role: "owner", household: { deletedAt: null } } })
  ]);
  return households > 0 || owners > 0;
}

export async function getAppRegistrationPolicy() {
  const firstSettings = await prisma.householdSettings.findFirst({
    orderBy: { createdAt: "asc" }
  });
  const hasOwner = await ownerOrHouseholdExists();
  const envPublic = envEnabled(env.ENABLE_REGISTRATION) && envEnabled(env.ALLOW_PUBLIC_REGISTRATION);

  return {
    hasOwner,
    firstOwnerAllowed: !hasOwner && envEnabled(env.ENABLE_REGISTRATION),
    publicRegistrationAllowed: envPublic || Boolean(firstSettings?.allowPublicRegistration),
    newHouseholdCreationAllowed: !hasOwner || Boolean(firstSettings?.allowNewHouseholdCreation)
  };
}

export async function getHouseholdSettings() {
  const ctx = await getHouseholdContext();
  requirePermission(ctx, "household.manage");
  return prisma.householdSettings.upsert({
    where: { householdId: ctx.householdId },
    update: {},
    create: { householdId: ctx.householdId }
  });
}

export async function updateRegistrationSettings(raw: unknown) {
  const ctx = await getHouseholdContext();
  requirePermission(ctx, "household.manage");
  const input = registrationSettingsSchema.parse(raw);
  const settings = await prisma.householdSettings.upsert({
    where: { householdId: ctx.householdId },
    update: input,
    create: {
      householdId: ctx.householdId,
      ...input
    }
  });
  await writeAudit(ctx, {
    action: "settings.registration.update",
    entityType: "household",
    entityId: ctx.householdId,
    after: input
  });
  return settings;
}

export async function signupPolicyForRequest(request: Request) {
  const body = await request.clone().json().catch(() => ({}));
  const callbackURL = typeof body.callbackURL === "string" ? body.callbackURL : "";
  const inviteToken = extractInviteToken(callbackURL);
  if (inviteToken) {
    const invite = await prisma.invite.findUnique({
      where: { tokenHash: hashInviteToken(inviteToken) },
      select: { id: true, status: true, expiresAt: true }
    });
    if (invite?.status === "pending" && invite.expiresAt > new Date()) {
      return { allowed: true, reason: "invite" as const };
    }
  }

  const policy = await getAppRegistrationPolicy();
  if (policy.firstOwnerAllowed) return { allowed: true, reason: "first_owner" as const };
  if (policy.publicRegistrationAllowed) return { allowed: true, reason: "public" as const };
  return { allowed: false, reason: "closed" as const };
}

export function extractInviteToken(value: string) {
  const match = value.match(/\/invite\/([^/?#]+)/);
  return match?.[1];
}
