import { TimerState } from "@prisma/client";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db/prisma";
import {
  SELECTED_BABY_COOKIE,
  buildHeaderBabySelectorData,
  resolveSelectedBaby,
  type HeaderBabySelectorData
} from "@/lib/baby-selector";
import type { ActivityTypeName } from "@/domain/activity";
import { getHouseholdHome } from "@/server/services/households";

export async function getHeaderBabySelector(userId: string, requestedBabyId?: string | null): Promise<HeaderBabySelectorData | null> {
  const home = await getHouseholdHome(userId);
  if (!home) return null;

  const cachedBabyId = cookies().get(SELECTED_BABY_COOKIE)?.value;
  const selected = resolveSelectedBaby(home.household.babies, requestedBabyId, cachedBabyId);
  if (!selected) return null;

  const activeTimer = await prisma.activityLog.findFirst({
    where: {
      householdId: home.householdId,
      babyId: selected.id,
      deletedAt: null,
      timerState: { in: [TimerState.running, TimerState.paused] }
    },
    orderBy: [{ startedAt: "desc" }, { createdAt: "desc" }],
    select: { type: true }
  });

  return buildHeaderBabySelectorData(
    home.household.babies,
    selected.id,
    activeTimer?.type as ActivityTypeName | undefined
  );
}
