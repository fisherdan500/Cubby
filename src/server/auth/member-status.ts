import { APIError } from "better-auth";
import { prisma } from "@/lib/db/prisma";

export const ACCOUNT_DISABLED_CODE = "ACCOUNT_DISABLED";
export const ACCOUNT_DISABLED_MESSAGE = "Your account is disabled.";

export async function assertUserCanStartSession(session: { userId: string }) {
  const activeMembership = await prisma.householdMember.findFirst({
    where: {
      userId: session.userId,
      disabledAt: null,
      deletedAt: null,
      household: { deletedAt: null }
    },
    select: { id: true }
  });
  if (activeMembership) return;

  const platformAuthority = await prisma.platformAuthority.findUnique({
    where: { ownerUserId: session.userId },
    select: { id: true }
  });
  if (platformAuthority) return;

  const suspendedMembership = await prisma.householdMember.findFirst({
    where: {
      userId: session.userId,
      disabledAt: { not: null },
      deletedAt: null,
      household: { deletedAt: null }
    },
    select: { id: true }
  });

  if (suspendedMembership) {
    throw new APIError("FORBIDDEN", {
      code: ACCOUNT_DISABLED_CODE,
      message: ACCOUNT_DISABLED_MESSAGE
    });
  }
}
