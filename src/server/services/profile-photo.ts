import { prisma } from "@/lib/db/prisma";
import { getEffectiveHouseholdContext } from "@/server/auth/context";

/**
 * The signed-in member's own profile picture in the household they are using.
 *
 * Constrained by both the household and the membership, because a picture belongs to a membership
 * rather than to a user: someone in two households has an independent picture in each, and neither
 * may reach the other. Only the available one -- a replaced picture stays recoverable but is no
 * longer theirs.
 *
 * No permission check beyond being a member: reading your own picture is not an administrative act.
 */
export async function getOwnProfilePhoto(): Promise<{ photoAttachmentId: string | null }> {
  const ctx = await getEffectiveHouseholdContext();
  const photo = await prisma.attachment.findFirst({
    where: {
      householdId: ctx.householdId,
      memberId: ctx.memberId,
      type: "user_photo",
      state: "available"
    },
    select: { id: true }
  });
  return { photoAttachmentId: photo?.id ?? null };
}
