import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { requireUser } from "@/server/auth/session";
import { writeAudit } from "@/server/services/audit";

/**
 * Your own name.
 *
 * An account page rather than a household setting, for the same reason the picture is: the members
 * screen is gated on household member management, so a caretaker could never correct their own name
 * there.
 *
 * The subtlety is that Cubby shows a person as `displayName ?? user.name` everywhere - moments, the
 * full log, the members list - and `displayName` is seeded from the account name when a membership
 * is created. Writing only `User.name` would therefore change nothing a household can see. So a
 * membership still holding the old name has its copy CLEARED rather than rewritten: from then on it
 * follows the account, which means a later rename needs no carry at all and a seeded copy can never
 * again be mistaken for a name somebody chose. A membership named something else is left alone.
 *
 * Authorized through `requireUser`, not `getSession`: the latter is deliberately ungated so the
 * assisted-password-change corridor can authorize itself, and a corralled identity must not be able
 * to rename itself across every household by calling this route instead of navigating the app.
 */

const ownNameSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(80)
    // A name is read aloud in a household, not parsed. Control characters and bidi overrides only
    // ever make one render confusingly, so they are refused rather than stored.
    .refine((value) => !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value), {
      message: "name_contains_unprintable_characters"
    })
});

export async function updateOwnName(raw: unknown) {
  const user = await requireUser();
  const userId = user.id;
  const { name } = ownNameSchema.parse(raw);

  return runSerializableWithRetry(() => prisma.$transaction(async (tx) => {
    // Taken before the name is read, so two tabs renaming at once serialise here and the second
    // compares against the name the first committed rather than a stale one.
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
    const current = await tx.user.findFirst({ where: { id: userId }, select: { name: true } });
    if (!current) throw new Error("unauthenticated");
    if (current.name === name) return { name };

    // Read before the write, so each household's audit record can say what that household will now
    // show rather than asserting a change it never saw.
    // Ordered, because writeAudit takes a per-household advisory lock on that household's audit
    // chain: two people renaming themselves while sharing two households would otherwise be free to
    // take the two locks in opposite orders.
    const members = await tx.householdMember.findMany({
      where: { userId },
      select: { id: true, householdId: true, displayName: true },
      orderBy: { householdId: "asc" }
    });

    await tx.user.update({ where: { id: userId }, data: { name } });
    await tx.householdMember.updateMany({
      where: { userId, displayName: current.name },
      data: { displayName: null }
    });

    // An account with no memberships writes no audit record: writeAudit is per-household by
    // construction - the household scopes the chain lock, the chain order and the checkpoint - so
    // there is no chain for it to go in. Deliberate, not an oversight.
    for (const member of members) {
      // Which changed, never what it became: a person's name is household content, and audit
      // evidence is required to exclude it. What each household needs on the record is that the
      // rename happened and whether the name THIS household shows followed it - a household that
      // had renamed the member itself saw no change at all.
      const shownNameFollowed = member.displayName === null || member.displayName === current.name;
      await writeAudit(
        { householdId: member.householdId, userId, memberId: member.id },
        {
          action: "own_profile.name.update",
          entityType: "user",
          entityId: userId,
          after: { changed: ["name"], shownNameFollowed } as Prisma.InputJsonValue
        },
        tx
      );
    }

    return { name };
  }, { isolationLevel: "Serializable" }));
}

function isSerializableWriteConflict(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; meta?: { code?: unknown }; message?: unknown };
  return candidate.code === "P2034" ||
    (candidate.code === "P2010" && candidate.meta?.code === "40001") ||
    (typeof candidate.message === "string" && candidate.message.includes("could not serialize access"));
}

/** The appearance service retries the same way, for the same reason: it locks this very row. */
async function runSerializableWithRetry<T>(operation: () => Promise<T>) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isSerializableWriteConflict(error) || attempt === 2) throw error;
    }
  }
  throw new Error("operation_serialization_retry_exhausted");
}
