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

  it("removes the photo post with the entry on a hard delete (soft delete keeps it)", async () => {
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

describe("the link survives a backup", () => {
  it("keeps the photo with its entry through an export and restore", async () => {
    // The photo bytes always survived; the LINK did not, so a restored household showed the entry and
    // its picture as two separate moments and the entry's Photos section was empty. Nothing reported
    // it -- the post count was identical. This asserts the column is actually stored and readable,
    // which is the part the backup format reads.
    const { post } = await postWithPhoto({ linkTo: activityId });

    const exported = await prisma.feedPost.findUniqueOrThrow({
      where: { id: post.id },
      select: { id: true, activityId: true, photos: { select: { id: true } } }
    });

    expect(exported.activityId).toBe(activityId);
    expect(exported.photos.length).toBeGreaterThan(0);

    // A restore recreates the post against the restored entry; the composite key must accept it.
    const restored = await prisma.feedPost.create({
      data: {
        householdId,
        babyId,
        authorMemberId: memberId,
        body: "",
        occurredAt: new Date("2026-10-01T09:00:00.000Z"),
        activityId: exported.activityId
      },
      select: { activityId: true }
    });
    expect(restored.activityId).toBe(activityId);
  });
});

describe("logging an entry with a photo, in one transaction", () => {
  it("keeps the entry and its photo together when the save succeeds", async () => {
    // What the log form does: the picture is staged first, then one transaction creates the entry, its
    // photo post, and claims the picture. Proven here against the real database because the promise is
    // transactional -- a mocked test cannot show that a failure leaves nothing behind.
    const staged = await prisma.attachment.create({
      data: {
        householdId,
        type: "feed_photo",
        state: "staging",
        storageKey: randomBytes(16).toString("hex"),
        byteSize: 4,
        sha256: randomBytes(32).toString("hex"),
        mimeType: "image/jpeg",
        width: 800,
        height: 600,
        createdByMemberId: memberId
      }
    });

    const saved = await prisma.$transaction(async (tx) => {
      const activity = await tx.activityLog.create({
        data: {
          household: { connect: { id: householdId } },
          baby: { connect: { id: babyId } },
          actorMember: { connect: { id: memberId } },
          type: "feeding",
          occurredAt: new Date("2026-10-01T10:00:00.000Z"),
          timezone: "Etc/UTC"
        }
      });
      const post = await tx.feedPost.create({
        data: { householdId, babyId, authorMemberId: memberId, body: "", activityId: activity.id },
        select: { id: true }
      });
      await tx.attachment.update({
        where: { id: staged.id },
        data: { state: "available", postId: post.id, position: 0, activatedAt: new Date() }
      });
      return { activityId: activity.id, postId: post.id };
    });

    const linked = await prisma.feedPost.findUniqueOrThrow({
      where: { id: saved.postId },
      select: { activityId: true, photos: { select: { id: true, state: true, postId: true } } }
    });
    expect(linked.activityId).toBe(saved.activityId);
    expect(linked.photos).toHaveLength(1);
    // Still an ordinary feed photo on a real post, which is what keeps delivery and backups working.
    expect(linked.photos[0]!.state).toBe("available");
    expect(linked.photos[0]!.postId).toBe(saved.postId);
  });

  it("leaves no entry and no claimed photo when the save fails", async () => {
    // The family taps Save, something goes wrong, and they must be left with nothing -- not an entry
    // that claims a picture it never got, and not a picture attached to an entry that does not exist.
    const staged = await prisma.attachment.create({
      data: {
        householdId,
        type: "feed_photo",
        state: "staging",
        storageKey: randomBytes(16).toString("hex"),
        byteSize: 4,
        sha256: randomBytes(32).toString("hex"),
        mimeType: "image/jpeg",
        width: 800,
        height: 600,
        createdByMemberId: memberId
      }
    });
    const before = await prisma.activityLog.count({ where: { householdId } });

    await expect(prisma.$transaction(async (tx) => {
      const activity = await tx.activityLog.create({
        data: {
          household: { connect: { id: householdId } },
          baby: { connect: { id: babyId } },
          actorMember: { connect: { id: memberId } },
          type: "sleep",
          occurredAt: new Date("2026-10-01T22:00:00.000Z"),
          timezone: "Etc/UTC"
        }
      });
      const post = await tx.feedPost.create({
        data: { householdId, babyId, authorMemberId: memberId, body: "", activityId: activity.id },
        select: { id: true }
      });
      await tx.attachment.update({
        where: { id: staged.id },
        data: { state: "available", postId: post.id, position: 0, activatedAt: new Date() }
      });
      throw new Error("save_failed");
    })).rejects.toThrow("save_failed");

    // Every part of the save is undone together.
    expect(await prisma.activityLog.count({ where: { householdId } })).toBe(before);
    const photo = await prisma.attachment.findUniqueOrThrow({ where: { id: staged.id } });
    expect([photo.state, photo.postId]).toEqual(["staging", null]);
  });
});

describe("the audit row a photo save writes, against real PostgreSQL", () => {
  // A photo save writes a feed_post.create audit row inside the same transaction as the entry. Its
  // payload is minimized against a strict schema, so a wrong shape throws AFTER the entry, the post
  // and the claim have run -- rolling the whole save back and losing the entry the family just typed.
  // That shipped once. The unit suite now validates the payload, but only the real audit writer proves
  // the row actually lands: it hashes into the household's audit chain and parses for real here.
  //
  // The payload is built by the same domain function the service uses, not retyped as a literal, so
  // this moves if parseFeedPostInput's shape moves.
  it("persists, chained, for the payload this path produces", async () => {
    const { parseFeedPostInput } = await import("../src/domain/feed-post");
    const { writeAudit } = await import("../src/server/services/audit");

    const attachmentIds = [`att-${randomUUID()}`];
    const parsed = parseFeedPostInput({ body: "", babyId, attachmentIds });

    const post = await prisma.feedPost.create({
      data: { householdId, babyId, authorMemberId: memberId, body: "", tags: parsed.tags, activityId }
    });

    const before = await prisma.auditEvent.count({ where: { householdId } });

    await writeAudit({ householdId, userId, memberId, role: "parent" }, {
      action: "feed_post.create",
      entityType: "feed_post",
      entityId: post.id,
      babyId,
      after: {
        tagCount: parsed.tags.length,
        ...(parsed.attachmentIds.length > 0 ? { photoCount: parsed.attachmentIds.length } : {})
      }
    }, prisma);

    const row = await prisma.auditEvent.findFirst({
      where: { householdId, entityId: post.id, action: "feed_post.create" }
    });

    expect(await prisma.auditEvent.count({ where: { householdId } })).toBe(before + 1);
    expect(row?.after).toEqual({ tagCount: 0, photoCount: 1 });
    // A row with no chain hash would be invisible to the integrity check, so the save would look
    // audited while the chain had a hole in it.
    expect(row?.eventHash).toBeTruthy();
  });

  it("refuses to record the entry id, so provenance cannot be smuggled past the schema", async () => {
    // Naming the entry in the audit payload would be useful, but the schema is strict and deliberately
    // keeps only non-identifying counts. Adding a field needs a schema change, not an extra key -- and
    // the attempt must fail loudly rather than being dropped.
    const { writeAudit } = await import("../src/server/services/audit");
    const post = await prisma.feedPost.create({
      data: { householdId, babyId, authorMemberId: memberId, body: "", tags: [], activityId }
    });
    const before = await prisma.auditEvent.count({ where: { householdId } });

    await expect(writeAudit({ householdId, userId, memberId, role: "parent" }, {
      action: "feed_post.create",
      entityType: "feed_post",
      entityId: post.id,
      babyId,
      after: { activityId, photoCount: 1 }
    }, prisma)).rejects.toThrow();

    // and it must not have written a partial row
    expect(await prisma.auditEvent.count({ where: { householdId } })).toBe(before);
  });
});
