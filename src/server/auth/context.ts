import type { HouseholdRole } from "@prisma/client";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db/prisma";
import { requireUser } from "@/server/auth/session";
import { hasPermission, type Permission } from "@/domain/roles";

export const SELECTED_HOUSEHOLD_MEMBER_COOKIE = "cubby_household_member";

export type HouseholdContext = {
  userId: string;
  householdId: string;
  memberId: string;
  role: HouseholdRole;
};

export type HouseholdMemberCandidate =
  | { status: "missing"; value: null }
  | { status: "invalid"; value: null }
  | { status: "present"; value: string };

export function readHouseholdMemberCandidate(): HouseholdMemberCandidate {
  const value = cookies().get(SELECTED_HOUSEHOLD_MEMBER_COOKIE)?.value;
  if (value === undefined) return { status: "missing", value: null };
  if (!isValidMembershipEpisodeId(value)) return { status: "invalid", value: null };
  return { status: "present", value };
}

export async function getHouseholdContext(memberId: string): Promise<HouseholdContext> {
  const user = await requireUser();
  if (!isValidMembershipEpisodeId(memberId)) throw new Error("not_found");
  return resolveHouseholdContext(user.id, memberId, "not_found");
}

export async function getEffectiveHouseholdContext(): Promise<HouseholdContext> {
  const user = await requireUser();
  const candidate = readHouseholdMemberCandidate();
  if (candidate.status === "missing") throw new Error("household_selection_required");
  if (candidate.status === "invalid") throw new Error("household_selection_stale");
  return resolveHouseholdContext(user.id, candidate.value, "household_selection_stale");
}

async function resolveHouseholdContext(
  userId: string,
  memberId: string,
  missingCode: "not_found" | "household_selection_stale"
): Promise<HouseholdContext> {
  const member = await prisma.householdMember.findFirst({
    where: {
      id: memberId,
      userId,
      disabledAt: null,
      deletedAt: null,
      household: { deletedAt: null }
    }
  });
  if (!member) throw new Error(missingCode);
  return {
    userId,
    householdId: member.householdId,
    memberId: member.id,
    role: member.role
  };
}

function isValidMembershipEpisodeId(value: string) {
  return value.length > 0 && value.length <= 191 && value.trim() === value && /^[A-Za-z0-9_-]+$/.test(value);
}

export function requirePermission(ctx: HouseholdContext, permission: Permission) {
  if (!hasPermission(ctx.role, permission)) throw new Error("forbidden");
}
