import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { getSession } from "@/server/auth/session";
import { writeAudit } from "@/server/services/audit";

/**
 * Your own name.
 *
 * An account page rather than a household setting, for the same reason the picture is: the members
 * screen is gated on `member.manage`, so a caretaker could never correct their own name there.
 *
 * The subtlety is that Cubby shows a person as `displayName ?? user.name` everywhere - moments, the
 * full log, the members list - and `displayName` is seeded from the account name when a membership
 * is created. Writing only `User.name` would therefore change nothing a household can see. So the
 * memberships still echoing the old name are carried forward with it, and any membership somebody
 * deliberately named something else is left alone.
 */

const ownNameSchema = z.object({ name: z.string().trim().min(1).max(80) });

export async function getOwnProfileName() {
  const session = await getSession();
  if (!session?.user) throw new Error("unauthenticated");
  const user = await prisma.user.findFirst({ where: { id: session.user.id }, select: { name: true } });
  if (!user) throw new Error("unauthenticated");
  return { name: user.name };
}

export async function updateOwnName(raw: unknown) {
  const session = await getSession();
  if (!session?.user) throw new Error("unauthenticated");
  const userId = session.user.id;
  const { name } = ownNameSchema.parse(raw);

  const audits: Array<{ householdId: string; memberId: string }> = [];
  const previous = await prisma.$transaction(async (tx) => {
    // Take the row before reading the name being replaced, so two tabs renaming at once cannot
    // interleave and leave a membership echoing a name the account no longer has.
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
    const user = await tx.user.findFirst({ where: { id: userId }, select: { name: true } });
    if (!user) throw new Error("unauthenticated");
    if (user.name === name) return null;

    await tx.user.update({ where: { id: userId }, data: { name } });
    // Only the memberships that were still showing the old account name. A membership named
    // something else is somebody's deliberate choice and is not ours to overwrite.
    await tx.householdMember.updateMany({
      where: { userId, displayName: user.name },
      data: { displayName: name }
    });
    const members = await tx.householdMember.findMany({
      where: { userId },
      select: { id: true, householdId: true }
    });
    for (const member of members) audits.push({ householdId: member.householdId, memberId: member.id });
    return user.name;
  }, { isolationLevel: "Serializable" });

  if (previous === null) return { name };

  // One record per household, because a household's audit trail should show the rename that changed
  // how this person appears in it.
  for (const entry of audits) {
    await writeAudit(
      { householdId: entry.householdId, userId, memberId: entry.memberId },
      {
        action: "own_profile.name.update",
        entityType: "user",
        entityId: userId,
        before: { name: previous } as Prisma.InputJsonValue,
        after: { name } as Prisma.InputJsonValue
      }
    );
  }

  return { name };
}
