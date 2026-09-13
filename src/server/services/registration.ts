import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { env } from "@/lib/env";

function envEnabled(value: string) {
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

type RegistrationPolicyReader = Pick<
  Prisma.TransactionClient,
  "household" | "platformAuditEvent" | "platformAuthority" | "platformSettings" | "user"
>;

type SignupPolicyReader = RegistrationPolicyReader;

export async function getAppRegistrationPolicy(db: RegistrationPolicyReader = prisma) {
  const [authority, settings] = await Promise.all([
    db.platformAuthority.findUnique({
      where: { id: "platform" },
      select: { id: true, ownerUserId: true }
    }),
    db.platformSettings.findUnique({
      where: { id: "platform" },
      select: { id: true, householdCreationMode: true, allowPublicRegistration: true }
    })
  ]);
  const platformOwnerBound = Boolean(authority);
  const completePolicy = platformOwnerBound && Boolean(settings);
  const householdCreationMode = completePolicy ? settings!.householdCreationMode : ("closed" as const);
  let bootstrapAccountAllowed = false;
  if (!platformOwnerBound && envEnabled(env.ENABLE_REGISTRATION)) {
    const [userCount, householdCount, auditEventCount] = await Promise.all([
      db.user.count(),
      db.household.count(),
      db.platformAuditEvent.count()
    ]);
    bootstrapAccountAllowed = userCount === 0 && householdCount === 0 && auditEventCount === 0;
  }

  return {
    platformOwnerBound,
    bootstrapAccountAllowed,
    publicRegistrationAllowed: completePolicy && Boolean(settings!.allowPublicRegistration),
    householdCreationMode,
    newHouseholdCreationAllowed: completePolicy && householdCreationMode === "open"
  };
}

export async function signupPolicyForRequest(_request: Request, db: SignupPolicyReader = prisma) {
  const policy = await getAppRegistrationPolicy(db);
  if (policy.bootstrapAccountAllowed) return { allowed: true, reason: "bootstrap" as const };
  if (policy.publicRegistrationAllowed) return { allowed: true, reason: "public" as const };
  return { allowed: false, reason: "closed" as const };
}
