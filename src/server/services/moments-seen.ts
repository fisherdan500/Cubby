import { prisma } from "@/lib/db/prisma";
import { getEffectiveHouseholdContext, requirePermission } from "@/server/auth/context";

/**
 * The unseen-moments badge: how many moments arrived since this member last looked at Moments.
 *
 * "Moment" here means a feed POST. The mixed feed also shows logged activities, but a household
 * logs activities all day - counting them would pin the badge at 9+ permanently and teach everyone
 * to ignore it. The badge answers "did someone share something while I was away?", which is what
 * the push notification asks too.
 *
 * A member's own posts never count toward their own badge, for the same reason the actor is never
 * notified of their own action: they were looking at the screen when they posted.
 *
 * No marker row means this member has never opened Moments. Zero then, not "everything ever":
 * badging a brand-new member with the household's whole history is noise, and the first visit
 * writes the marker and starts the clock.
 */
export async function countUnseenMoments(): Promise<number> {
  const ctx = await getEffectiveHouseholdContext();
  requirePermission(ctx, "activity.read");
  const marker = await prisma.momentsSeenMarker.findUnique({
    where: { householdId_memberId: { householdId: ctx.householdId, memberId: ctx.memberId } },
    select: { seenAt: true }
  });
  if (!marker) return 0;
  return prisma.feedPost.count({
    where: {
      householdId: ctx.householdId,
      deletedAt: null,
      createdAt: { gt: marker.seenAt },
      NOT: { authorMemberId: ctx.memberId }
    }
  });
}

/**
 * This member just looked at Moments: move their marker to now. Called from the Moments pages'
 * server render, so "seen" means the page was actually served - not that a notification was
 * delivered or a tab was opened somewhere. Upsert keeps it one row per member, and the composite
 * member reference keeps it same-tenant by construction.
 */
export async function markMomentsSeen(): Promise<void> {
  const ctx = await getEffectiveHouseholdContext();
  requirePermission(ctx, "activity.read");
  const now = new Date();
  await prisma.momentsSeenMarker.upsert({
    where: { householdId_memberId: { householdId: ctx.householdId, memberId: ctx.memberId } },
    create: { householdId: ctx.householdId, memberId: ctx.memberId, seenAt: now },
    update: { seenAt: now }
  });
}
