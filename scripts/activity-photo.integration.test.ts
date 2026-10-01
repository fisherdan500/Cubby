/**
 * A photo added to a logged entry, against real PostgreSQL.
 *
 * The point of this gate is the part no mocked test can prove: that the migration applies, that the
 * composite foreign key refuses a cross-household link in the database itself, and above all that a
 * photo added to an entry is still an ORDINARY FEED PHOTO ON A REAL POST.
 *
 * That last property is why the design works. Private delivery and the backup export both select
 * feed photos through their parent post, so a photo with no post would be unreachable in the app and
 * would silently travel in no backup -- the worst available failure, because nothing reports it. The
 * delivery and backup predicates are asserted here unchanged, against real rows.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { PrismaClient, Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const prisma = new PrismaClient();

const userId = `u-${randomUUID()}`;
const householdId = `h-${randomUUID()}`;
const otherHouseholdId = `h-${randomUUID()}`;
let memberId = "";
let otherMemberId = "";
let babyId = "";
let otherBabyId = "";
let activityId = "";
let foreignActivityId = "";

beforeAll(async () => {
  await prisma.user.create({ data: { id: userId, email: `${userId}@example.test`, name: "Parent", emailVerified: true } });
  for (const [hid, name] of [[householdId, "Ours"], [otherHouseholdId, "Theirs"]] as const) {
    await prisma.household.create({ data: { id: hid, name, createdByUserId: userId } });
  }
  memberId = (await prisma.householdMember.create({ data: { householdId, userId, role: "parent", joinedAt: new Date() } })).id;
  otherMemberId = (await prisma.householdMember.create({ data: { householdId: otherHouseholdId, userId, role: "parent", joinedAt: new Date() } })).id;
  babyId = (await prisma.baby.create({ data: { householdId, name: "Wren" } })).id;
  otherBabyId = (await prisma.baby.create({ data: { householdId: otherHouseholdId, name: "Someone else" } })).id;

  const activity = await prisma.activityLog.create({
    data: {
      household: { connect: { id: householdId } },
      baby: { connect: { id: babyId } },
      actorMember: { connect: { id: memberId } },
      type: "feeding",
      occurredAt: new Date("2026-10-01T08:00:00.000Z"),
      timezone: "Etc/UTC"
    }
  });
  activityId = activity.id;

  const foreign = await prisma.activityLog.create({
    data: {
      household: { connect: { id: otherHouseholdId } },
      baby: { connect: { id: otherBabyId } },
      actorMember: { connect: { id: otherMemberId } },
      type: "feeding",
      occurredAt: new Date("2026-10-01T08:00:00.000Z"),
      timezone: "Etc/UTC"
    }
  });
  foreignActivityId = foreign.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function postWithPhoto(opts: { linkTo: string | null }) {
  const post = await prisma.feedPost.create({
    data: {
      householdId,
      babyId,
      authorMemberId: memberId,
      body: "Finished the whole bottle",
      occurredAt: new Date("2026-10-01T08:00:00.000Z"),
      activityId: opts.linkTo
    }
  });
  const photo = await prisma.attachment.create({
    data: {
      householdId,
      postId: post.id,
      type: "feed_photo",
      state: "available",
      // Attachment_storage_check requires exactly these shapes.
      storageKey: randomBytes(16).toString("hex"),
      byteSize: 4,
      sha256: randomBytes(32).toString("hex"),
      mimeType: "image/jpeg",
      width: 800,
      height: 600,
      position: 0,
      activatedAt: new Date()
    }
  });
  return { post, photo };
}

describe("the migration", () => {
  it("applies, so FeedPost can record the entry a photo belongs to", async () => {
    const column = await prisma.$queryRaw<{ is_nullable: string }[]>`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'FeedPost' AND column_name = 'activityId'
    `;
    expect(column[0]?.is_nullable).toBe("YES");
  });

  it("enforces the link through the household, not just the entry id", async () => {
    const fk = await prisma.$queryRaw<{ constraint_name: string }[]>`
      SELECT constraint_name FROM information_schema.table_constraints
      WHERE table_name = 'FeedPost' AND constraint_type = 'FOREIGN KEY'
        AND constraint_name = 'FeedPost_householdId_activityId_fkey'
    `;
    expect(fk).toHaveLength(1);
  });
});

describe("a photo added to a logged entry", () => {
  it("links the post to the entry", async () => {
    const { post } = await postWithPhoto({ linkTo: activityId });

    const stored = await prisma.feedPost.findUniqueOrThrow({ where: { id: post.id }, select: { activityId: true } });
    expect(stored.activityId).toBe(activityId);
  });

  it("is still a feed photo on a real post, which is what keeps it deliverable", async () => {
    const { post, photo } = await postWithPhoto({ linkTo: activityId });

    const stored = await prisma.attachment.findUniqueOrThrow({ where: { id: photo.id } });
    // Not a new attachment type, and emphatically not parentless.
    expect([stored.type, stored.postId, stored.memberId, stored.babyId]).toEqual(["feed_photo", post.id, null, null]);
  });

  it("is selected by the unchanged delivery predicate", async () => {
    const { photo } = await postWithPhoto({ linkTo: activityId });

    // The exact shape src/server/services/attachments.ts uses for feed photos.
    const deliverable = await prisma.attachment.findFirst({
      where: {
        id: photo.id,
        householdId,
        state: "available",
        postId: { not: null },
        post: { deletedAt: null, OR: [{ babyId: null }, { baby: { deletedAt: null } }] }
      },
      select: { id: true }
    });
    expect(deliverable?.id).toBe(photo.id);
  });

  it("travels in the backup, because the export filter still matches it", async () => {
    const { photo } = await postWithPhoto({ linkTo: activityId });

    // The exact feed_photo clause the backup export uses.
    const exported = await prisma.attachment.findFirst({
      where: {
        id: photo.id,
        type: "feed_photo",
        postId: { not: null },
        post: { deletedAt: null, OR: [{ babyId: null }, { baby: { deletedAt: null } }] }
      },
      select: { id: true }
    });
    expect(exported?.id).toBe(photo.id);
  });

  it("is found by the entry, so Moments can show them as one", async () => {
    const { post } = await postWithPhoto({ linkTo: activityId });

    const posts = await prisma.feedPost.findMany({
      where: { householdId, activityId },
      select: { id: true, photos: { select: { id: true } } }
    });
    expect(posts.map((p) => p.id)).toContain(post.id);
    expect(posts.every((p) => p.photos.length > 0)).toBe(true);
  });
});

describe("tenant safety", () => {
  it("refuses a post linked to another household's entry", async () => {
    // The composite foreign key makes this impossible in the database, not merely discouraged.
    await expect(
      prisma.feedPost.create({
        data: {
          householdId,
          babyId,
          authorMemberId: memberId,
          body: "Crafted",
          occurredAt: new Date(),
          activityId: foreignActivityId
        }
      })
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  });

  it("keeps an ordinary post unlinked", async () => {
    const { post } = await postWithPhoto({ linkTo: null });

    const stored = await prisma.feedPost.findUniqueOrThrow({ where: { id: post.id }, select: { activityId: true } });
    expect(stored.activityId).toBeNull();
  });

  it("unlinks nothing but the post when the entry is deleted", async () => {
    const activity = await prisma.activityLog.create({
      data: {
        household: { connect: { id: householdId } },
        baby: { connect: { id: babyId } },
        actorMember: { connect: { id: memberId } },
        type: "sleep",
        occurredAt: new Date("2026-10-01T20:00:00.000Z"),
        timezone: "Etc/UTC"
      }
    });
    const { post } = await postWithPhoto({ linkTo: activity.id });

    await prisma.activityLog.delete({ where: { id: activity.id } });

    // ON DELETE CASCADE: no post is left pointing at an entry that no longer exists.
    expect(await prisma.feedPost.findUnique({ where: { id: post.id } })).toBeNull();
  });
});
