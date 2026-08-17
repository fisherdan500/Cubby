import { parseAccentTheme } from "@/domain/appearance";
import { prisma } from "@/lib/db/prisma";
import {
  getHouseholdContext,
  readHouseholdMemberCandidate
} from "@/server/auth/context";
import { requireUser } from "@/server/auth/session";
import type {
  HouseholdSelectionOption,
  HouseholdSelectionState
} from "@/components/household-selection-control";

export async function getHouseholdSelectionState(): Promise<HouseholdSelectionState> {
  const user = await requireUser();
  const memberships = await prisma.householdMember.findMany({
    where: {
      userId: user.id,
      disabledAt: null,
      deletedAt: null,
      household: { deletedAt: null }
    },
    select: {
      id: true,
      householdId: true,
      role: true,
      household: {
        select: {
          name: true,
          settings: { select: { accentTheme: true } }
        }
      }
    },
    orderBy: [{ household: { name: "asc" } }, { id: "asc" }]
  });
  const options: HouseholdSelectionOption[] = memberships.map((membership) => ({
    memberId: membership.id,
    householdId: membership.householdId,
    householdName: membership.household.name,
    role: membership.role,
    accentTheme: parseAccentTheme(membership.household.settings?.accentTheme)
  }));
  const candidate = readHouseholdMemberCandidate();
  if (candidate.status === "missing") return { status: "missing", selected: null, options };
  if (candidate.status === "invalid") return { status: "stale", selected: null, options };

  try {
    const context = await getHouseholdContext(candidate.value);
    const selected = options.find((option) => option.memberId === context.memberId) ?? null;
    if (!selected) return { status: "stale", selected: null, options };
    return { status: "selected", selected, options };
  } catch (error) {
    if (error instanceof Error && error.message === "not_found") {
      return { status: "stale", selected: null, options };
    }
    throw error;
  }
}

export async function authorizeHouseholdSelection(memberId: string) {
  return getHouseholdContext(memberId);
}

export async function clearHouseholdSelection() {
  await requireUser();
}
