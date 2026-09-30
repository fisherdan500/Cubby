/**
 * Delivery authorization for baby photos, against real PostgreSQL.
 *
 * A mock that returns a row cannot prove a Prisma relation predicate excludes anything - the query is
 * never executed. These cases run the production where-builder against real rows, so a widened filter
 * that accidentally serves a hidden baby's photo, another household's photo, or a staged upload fails
 * here.
 */
import { afterAll, describe, expect, it } from "vitest";
import { AttachmentState, AttachmentType, HouseholdRole } from "@prisma/client";
import { randomBytes } from "node:crypto";

import { prisma } from "@/lib/db/prisma";
import { servableAttachmentWhere } from "@/server/services/attachments";

afterAll(async () => {
  await prisma.$disconnect();
});

let sequence = 0;

async function createHousehold(label: string) {
  sequence += 1;
  const user = await prisma.user.create({
    data: { name: `${label} Owner`, email: `baby-photo-delivery-${sequence}@acceptance.invalid`, emailVerified: true }
  });
  const household = await prisma.household.create({ data: { name: `${label} Household`, createdByUserId: user.id } });
  const member = await prisma.householdMember.create({
    data: { householdId: household.id, userId: user.id, role: HouseholdRole.owner, displayName: `${label} Owner` }
  });
  return { household, member };
}

function photoData(
  householdId: string,
  memberId: string,
  overrides: { state?: AttachmentState; babyId?: string | null; postId?: string | null; type?: AttachmentType } = {}
) {
  const state = overrides.state ?? AttachmentState.available;
  return {
    householdId,
    type: overrides.type ?? AttachmentType.baby_photo,
    state,
    storageKey: randomBytes(16).toString("hex"),
    byteSize: 2048,
    sha256: randomBytes(32).toString("hex"),
    mimeType: "image/jpeg",
    width: 512,
    height: 512,
    babyId: overrides.babyId ?? null,
    postId: overrides.postId ?? null,
    createdByMemberId: memberId,
    activatedAt: state === AttachmentState.staging ? null : new Date()
  };
}

/** Exactly what production asks the database, so the predicate itself is under test. */
async function servable(householdId: string, id: string) {
  return prisma.attachment.findFirst({ where: servableAttachmentWhere(householdId, id), select: { id: true } });
}

describe("baby photo delivery authorization, against real PostgreSQL", () => {
  it("serves a baby's current photo", async () => {
    const { household, member } = await createHousehold("Serves");
    const baby = await prisma.baby.create({ data: { householdId: household.id, name: "Visible", timezone: "UTC" } });
    const photo = await prisma.attachment.create({ data: photoData(household.id, member.id, { babyId: baby.id }) });

    expect(await servable(household.id, photo.id)).not.toBeNull();
  });

  it("refuses the photo of a hidden baby", async () => {
    // Hiding a baby has to hide their picture too, or the child stays visible after being removed.
    const { household, member } = await createHousehold("Hidden");
    const baby = await prisma.baby.create({ data: { householdId: household.id, name: "Hidden", timezone: "UTC" } });
    const photo = await prisma.attachment.create({ data: photoData(household.id, member.id, { babyId: baby.id }) });
    await prisma.baby.update({ where: { id: baby.id }, data: { deletedAt: new Date() } });

    expect(await servable(household.id, photo.id)).toBeNull();
  });

  it("refuses a photo belonging to another household", async () => {
    const owner = await createHousehold("Owner");
    const other = await createHousehold("Other");
    const baby = await prisma.baby.create({ data: { householdId: owner.household.id, name: "Theirs", timezone: "UTC" } });
    const photo = await prisma.attachment.create({ data: photoData(owner.household.id, owner.member.id, { babyId: baby.id }) });

    // The requester's own household is the scope, so asking from elsewhere must find nothing.
    expect(await servable(other.household.id, photo.id)).toBeNull();
  });

  it("refuses a staged photo that no baby has claimed", async () => {
    const { household, member } = await createHousehold("Staged");
    const photo = await prisma.attachment.create({
      data: photoData(household.id, member.id, { state: AttachmentState.staging })
    });

    expect(await servable(household.id, photo.id)).toBeNull();
  });

  it("refuses a retired photo inside its recovery window", async () => {
    // Recoverable must not mean publicly readable.
    const { household, member } = await createHousehold("Retired");
    const baby = await prisma.baby.create({ data: { householdId: household.id, name: "Replaced", timezone: "UTC" } });
    const now = new Date();
    const photo = await prisma.attachment.create({
      data: {
        // Built as a retired row from the start: the lifecycle check requires a deleted row to carry
        // both deletedAt and purgeAfter, so it cannot be spread over an available row's defaults.
        ...photoData(household.id, member.id, { babyId: baby.id, state: AttachmentState.deleted }),
        deletedAt: now,
        purgeAfter: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
        deletedByMemberId: member.id
      }
    });

    expect(await servable(household.id, photo.id)).toBeNull();
  });

  it("still serves a feed photo on a live post", async () => {
    const { household, member } = await createHousehold("Feed");
    const baby = await prisma.baby.create({ data: { householdId: household.id, name: "Feed", timezone: "UTC" } });
    const post = await prisma.feedPost.create({
      data: { householdId: household.id, babyId: baby.id, authorMemberId: member.id, body: "post", occurredAt: new Date() }
    });
    const photo = await prisma.attachment.create({
      data: { ...photoData(household.id, member.id, { type: AttachmentType.feed_photo, postId: post.id }), position: 0 }
    });

    expect(await servable(household.id, photo.id)).not.toBeNull();
  });

  it("still refuses a feed photo whose post was removed", async () => {
    const { household, member } = await createHousehold("Removed");
    const post = await prisma.feedPost.create({
      data: { householdId: household.id, authorMemberId: member.id, body: "gone", occurredAt: new Date() }
    });
    const photo = await prisma.attachment.create({
      data: { ...photoData(household.id, member.id, { type: AttachmentType.feed_photo, postId: post.id }), position: 0 }
    });
    await prisma.feedPost.update({ where: { id: post.id }, data: { deletedAt: new Date() } });

    expect(await servable(household.id, photo.id)).toBeNull();
  });

  it("still refuses a feed photo on a live post about a hidden baby", async () => {
    const { household, member } = await createHousehold("FeedHidden");
    const baby = await prisma.baby.create({ data: { householdId: household.id, name: "FeedHidden", timezone: "UTC" } });
    const post = await prisma.feedPost.create({
      data: { householdId: household.id, babyId: baby.id, authorMemberId: member.id, body: "post", occurredAt: new Date() }
    });
    const photo = await prisma.attachment.create({
      data: { ...photoData(household.id, member.id, { type: AttachmentType.feed_photo, postId: post.id }), position: 0 }
    });
    await prisma.baby.update({ where: { id: baby.id }, data: { deletedAt: new Date() } });

    expect(await servable(household.id, photo.id)).toBeNull();
  });
});
