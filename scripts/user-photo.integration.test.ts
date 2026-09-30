/**
 * The user_photo foundation, against real PostgreSQL.
 *
 * A migration file that parses is not a migration that works. These tests read the live catalog and
 * exercise real writes, because the constraints are the only thing that can stop two concurrent
 * requests from giving one person two current pictures.
 */
import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const prisma = new PrismaClient();
const householdId = `h-${randomUUID()}`;
const otherHouseholdId = `h-${randomUUID()}`;
const userId = `u-${randomUUID()}`;
const otherUserId = `u-${randomUUID()}`;
let memberId = "";
let otherMemberId = "";

const digest = () => randomUUID().replace(/-/g, "");
const sha = () => randomUUID().replace(/-/g, "").padEnd(64, "0").slice(0, 64);

async function makeHousehold(id: string, uid: string, email: string): Promise<string> {
  // The user exists before the household, because a household records who created it.
  await prisma.user.create({ data: { id: uid, email, name: "Person", emailVerified: true } });
  await prisma.household.create({ data: { id, name: `House ${id.slice(0, 6)}`, createdByUserId: uid } });
  const member = await prisma.householdMember.create({
    data: { householdId: id, userId: uid, role: "owner", joinedAt: new Date() }
  });
  return member.id;
}

function photo(overrides: Record<string, unknown> = {}) {
  return {
    householdId,
    type: "user_photo" as const,
    state: "available" as const,
    storageKey: digest(),
    byteSize: 2048,
    sha256: sha(),
    mimeType: "image/jpeg",
    width: 512,
    height: 512,
    memberId,
    activatedAt: new Date(),
    ...overrides
  };
}

beforeAll(async () => {
  memberId = await makeHousehold(householdId, userId, `${userId}@example.test`);
  otherMemberId = await makeHousehold(otherHouseholdId, otherUserId, `${otherUserId}@example.test`);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("user photo attachment foundation, against real PostgreSQL", () => {
  it("has the enum value, the column, the index and the constraints in the live catalog", async () => {
    const [enumValue] = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*) AS count FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'AttachmentType' AND e.enumlabel = 'user_photo'`;
    expect(Number(enumValue.count)).toBe(1);

    const [column] = await prisma.$queryRaw<{ is_nullable: string }[]>`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'Attachment' AND column_name = 'memberId'`;
    // Nullable, or every existing feed photo would have had to name a member at migration time.
    expect(column.is_nullable).toBe("YES");

    const indexes = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'Attachment' AND indexname = 'Attachment_one_available_user_photo'`;
    expect(indexes).toHaveLength(1);

    const constraints = await prisma.$queryRaw<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
      WHERE conrelid = '"Attachment"'::regclass
        AND conname IN ('Attachment_user_photo_parent', 'Attachment_available_user_photo_has_member', 'Attachment_householdId_memberId_fkey')
      ORDER BY conname`;
    expect(constraints.map((c) => c.conname)).toEqual([
      "Attachment_available_user_photo_has_member",
      "Attachment_householdId_memberId_fkey",
      "Attachment_user_photo_parent"
    ]);
  });

  it("stores one person's picture", async () => {
    const created = await prisma.attachment.create({ data: photo() });
    expect(created.memberId).toBe(memberId);
    await prisma.attachment.delete({ where: { id: created.id } });
  });

  it("refuses a second current picture for the same person", async () => {
    // The partial unique index is the real guard: two concurrent claims cannot both win.
    const first = await prisma.attachment.create({ data: photo() });
    await expect(prisma.attachment.create({ data: photo() })).rejects.toThrow();
    await prisma.attachment.delete({ where: { id: first.id } });
  });

  it("allows a retired picture to sit alongside the current one", async () => {
    // Replacement keeps the old row for the recovery window, so the index must only bind 'available'.
    const now = new Date();
    const retired = await prisma.attachment.create({
      data: photo({ state: "deleted", activatedAt: now, deletedAt: now, purgeAfter: new Date(now.getTime() + 86_400_000) })
    });
    const current = await prisma.attachment.create({ data: photo() });

    expect([retired.state, current.state]).toEqual(["deleted", "available"]);
    await prisma.attachment.deleteMany({ where: { id: { in: [retired.id, current.id] } } });
  });

  it("refuses a picture that names a member from another household", async () => {
    // The composite foreign key, not application code, is what makes cross-tenant ownership
    // unrepresentable.
    await expect(prisma.attachment.create({ data: photo({ memberId: otherMemberId }) })).rejects.toThrow();
  });

  it("refuses a user photo that also claims a post or a baby", async () => {
    await expect(prisma.attachment.create({ data: photo({ postId: randomUUID() }) })).rejects.toThrow();
    await expect(prisma.attachment.create({ data: photo({ babyId: randomUUID() }) })).rejects.toThrow();
  });

  it("refuses an available user photo with no member at all", async () => {
    await expect(prisma.attachment.create({ data: photo({ memberId: null }) })).rejects.toThrow();
  });

  it("allows staging before anyone owns the bytes", async () => {
    // Upload happens before the claim, so a staged row legitimately has no owner yet.
    const staged = await prisma.attachment.create({
      data: photo({ state: "staging", memberId: null, activatedAt: null })
    });
    expect(staged.state).toBe("staging");
    await prisma.attachment.delete({ where: { id: staged.id } });
  });

  it("refuses to delete a member who still has a picture", async () => {
    // ON DELETE RESTRICT: a picture pins its owner, so a hard delete cannot silently orphan bytes
    // on disk. Production soft-deletes members, so this only guards direct or future hard deletes.
    const current = await prisma.attachment.create({ data: photo() });
    await expect(prisma.householdMember.delete({ where: { id: memberId } })).rejects.toThrow();
    await prisma.attachment.delete({ where: { id: current.id } });
  });

  it("leaves feed photos alone", async () => {
    // The widened lifecycle check must not have loosened what a feed photo requires.
    await expect(prisma.attachment.create({
      data: photo({ type: "feed_photo", memberId: null, postId: null, position: null })
    })).rejects.toThrow();
  });
});
