import type { HouseholdRole } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { requireUser } from "@/server/auth/session";
import { hasPermission, type Permission } from "@/domain/roles";

export type HouseholdContext = {
  userId: string;
  householdId: string;
  memberId: string;
  role: HouseholdRole;
};

export async function getHouseholdContext(householdId?: string): Promise<HouseholdContext> {
  const user = await requireUser();
  const member = await prisma.householdMember.findFirst({
    where: {
      userId: user.id,
      deletedAt: null,
      household: {
        deletedAt: null,
        ...(householdId ? { id: householdId } : {})
      }
    },
    orderBy: { joinedAt: "asc" }
  });

  if (!member) throw new Error("not_found");

  return {
    userId: user.id,
    householdId: member.householdId,
    memberId: member.id,
    role: member.role
  };
}

export function requirePermission(ctx: HouseholdContext, permission: Permission) {
  if (!hasPermission(ctx.role, permission)) throw new Error("forbidden");
}
