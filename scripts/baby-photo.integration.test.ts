import { afterAll, describe, expect, it } from "vitest";
import { AttachmentState, AttachmentType, HouseholdRole } from "@prisma/client";
import { randomBytes } from "node:crypto";

import { prisma } from "@/lib/db/prisma";

afterAll(async () => {
  await prisma.$disconnect();
});

let sequence = 0;

async function createHousehold(label: string) {
  sequence += 1;
  const user = await prisma.user.create({
    data: {
      name: `${label} Owner`,
      email: `baby-photo-${sequence}@acceptance.invalid`,
      emailVerified: true
    }
  });
  const household = await prisma.household.create({
    data: { name: `${label} Household`, createdByUserId: user.id }
  });
  const member = await prisma.householdMember.create({
    data: { householdId: household.id, userId: user.id, role: HouseholdRole.owner, displayName: `${label} Owner` }
  });
  return { user, household, member };
}

async function createBaby(householdId: string, name: string) {
  return prisma.baby.create({ data: { householdId, name, timezone: "UTC" } });
}

/** A distinct valid storage key per row; the column is globally unique. */
function storageKey() {
  return randomBytes(16).toString("hex");
}

type PhotoOverrides = {
  state?: AttachmentState;
  babyId?: string | null;
  postId?: string | null;
  type?: AttachmentType;
};

function photoData(householdId: string, memberId: string, overrides: PhotoOverrides = {}) {
  return {
    householdId,
    type: overrides.type ?? AttachmentType.baby_photo,
    state: overrides.state ?? AttachmentState.available,
    storageKey: storageKey(),
    byteSize: 2048,
    sha256: randomBytes(32).toString("hex"),
    mimeType: "image/jpeg",
    width: 512,
    height: 512,
    babyId: overrides.babyId ?? null,
    postId: overrides.postId ?? null,
    // The lifecycle check requires activatedAt on anything past staging, and forbids it on a
    // staged row. Derived from the state so each fixture is a row production could actually write.
    activatedAt: (overrides.state ?? AttachmentState.available) === AttachmentState.staging ? null : new Date(),
    createdByMemberId: memberId
  };
}

/** The exact rejection signal, so an unrelated failure cannot be mistaken for the constraint firing. */
async function expectConstraintViolation(operation: Promise<unknown>, constraint: string) {
  const error = await operation.then(() => null, (reason: unknown) => reason);
  expect(error, `expected ${constraint} to reject`).not.toBeNull();
  expect(String((error as Error).message)).toContain(constraint);
}

/** Refused by one of several guards that all forbid the row; names them so the reason stays exact. */
async function expectOneOfConstraintViolations(operation: Promise<unknown>, constraints: string[]) {
  const error = await operation.then(() => null, (reason: unknown) => reason);
  expect(error, `expected one of ${constraints.join(", ")} to reject`).not.toBeNull();
  const message = String((error as Error).message);
  expect(
    constraints.some((constraint) => message.includes(constraint)),
    `expected one of ${constraints.join(", ")} in: ${message.slice(0, 300)}`
  ).toBe(true);
}

describe("baby photo attachment foundation, against real PostgreSQL", () => {
  it("has the enum value, the column, the composite foreign key, the index and both checks in the live catalog", async () => {
    // Asserted against the DEPLOYED catalog, not the migration files: a file can be correct while
    // an earlier or later definition in the chain wins, and only the catalog shows what is live.
    const [enumValues] = await prisma.$queryRaw<{ values: string[] }[]>`
      SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS values
      FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'AttachmentType'
    `;
    // The full list, in declaration order. It grows as attachment types are added; what this pins
    // is that baby_photo is present and that no type was silently removed or reordered.
    expect(enumValues.values).toEqual(["feed_photo", "baby_photo", "user_photo"]);

    const columns = await prisma.$queryRaw<{ column_name: string; is_nullable: string; column_default: string | null }[]>`
      SELECT column_name, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'Attachment' AND column_name = 'babyId'
    `;
    expect(columns).toHaveLength(1);
    // Nullable with no default, or applying the migration would have rewritten every existing row.
    expect(columns[0].is_nullable).toBe("YES");
    expect(columns[0].column_default).toBeNull();

    const fks = await prisma.$queryRaw<{ definition: string; validated: boolean }[]>`
      SELECT pg_get_constraintdef(c.oid) AS definition, c.convalidated AS validated
      FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = 'Attachment' AND c.conname = 'Attachment_householdId_babyId_fkey'
    `;
    expect(fks).toHaveLength(1);
    // Composite on (householdId, babyId): a single-column babyId key would let a photo name a baby
    // in another household.
    expect(fks[0].definition).toBe(
      'FOREIGN KEY ("householdId", "babyId") REFERENCES "Baby"("householdId", id) ON UPDATE CASCADE ON DELETE CASCADE'
    );
    expect(fks[0].validated).toBe(true);

    const indexes = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'Attachment' AND indexname = 'Attachment_one_available_baby_photo'
    `;
    expect(indexes).toHaveLength(1);
    expect(indexes[0].indexdef).toContain("UNIQUE");
    // PostgreSQL rewrites an enum literal in a partial-index predicate to its cast form, so the
    // text is asserted by the shape the catalog actually stores rather than the shape written.
    expect(indexes[0].indexdef).toMatch(/WHERE .*baby_photo/);
    expect(indexes[0].indexdef).toMatch(/WHERE .*available/);
    expect(indexes[0].indexdef).toContain('ON public."Attachment" USING btree ("householdId", "babyId")');

    const checks = await prisma.$queryRaw<{ conname: string; definition: string; validated: boolean }[]>`
      SELECT c.conname, pg_get_constraintdef(c.oid) AS definition, c.convalidated AS validated
      FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = 'Attachment' AND c.contype = 'c'
        AND c.conname IN ('Attachment_baby_photo_parent', 'Attachment_available_baby_photo_has_baby')
      ORDER BY c.conname
    `;
    expect(checks.map((row) => row.conname)).toEqual([
      "Attachment_available_baby_photo_has_baby",
      "Attachment_baby_photo_parent"
    ]);
    expect(checks.every((row) => row.validated)).toBe(true);
  });

  it("serves at most one available photo per baby", async () => {
    const { household, member } = await createHousehold("One Photo");
    const baby = await createBaby(household.id, "Sprout");

    await prisma.attachment.create({ data: photoData(household.id, member.id, { babyId: baby.id }) });

    // A second available photo for the same baby is what a double-submitted replacement looks like.
    // maxPerParent in policy cannot stop it; only the database can.
    const duplicate = await prisma.attachment
      .create({ data: photoData(household.id, member.id, { babyId: baby.id }) })
      .then(() => null, (reason: unknown) => reason);
    expect(duplicate, "a second available photo for the same baby must be refused").not.toBeNull();
    // Prisma reports a unique violation as P2002 and names the COLUMNS of the violated index in
    // meta.target, not the index name. The column pair is what identifies the index here: no other
    // unique index on Attachment covers exactly (householdId, babyId).
    expect((duplicate as { code?: string }).code).toBe("P2002");
    expect((duplicate as { meta?: { target?: string[] } }).meta?.target).toEqual(["householdId", "babyId"]);

    const live = await prisma.attachment.count({
      where: { householdId: household.id, babyId: baby.id, state: AttachmentState.available }
    });
    expect(live).toBe(1);
  });

  it("lets a replaced photo stay recoverable without blocking its replacement", async () => {
    const { household, member } = await createHousehold("Replace");
    const baby = await createBaby(household.id, "Sprout");

    const first = await prisma.attachment.create({
      data: photoData(household.id, member.id, { babyId: baby.id })
    });
    // The 30-day recovery window: state leaves 'available' but the row and its bytes remain.
    await prisma.attachment.update({
      where: { id: first.id },
      data: { state: AttachmentState.deleted, deletedAt: new Date(), purgeAfter: new Date(Date.now() + 86_400_000) }
    });

    const second = await prisma.attachment.create({
      data: photoData(household.id, member.id, { babyId: baby.id })
    });

    expect(second.state).toBe(AttachmentState.available);
    // Had the index been scoped to deletedAt IS NULL instead of state, this replacement would have
    // been refused for 30 days.
    const rows = await prisma.attachment.count({ where: { householdId: household.id, babyId: baby.id } });
    expect(rows).toBe(2);
  });

  it("allows a staged baby photo with no baby yet, because staging precedes claiming", async () => {
    const { household, member } = await createHousehold("Staging");

    const staged = await prisma.attachment.create({
      data: photoData(household.id, member.id, { state: AttachmentState.staging, babyId: null })
    });

    expect(staged.babyId).toBeNull();
    expect(staged.state).toBe(AttachmentState.staging);
  });

  it("refuses a baby photo that reaches the served state with no baby", async () => {
    const { household, member } = await createHousehold("No Baby");

    await expectConstraintViolation(
      prisma.attachment.create({
        data: photoData(household.id, member.id, { state: AttachmentState.available, babyId: null })
      }),
      "Attachment_available_baby_photo_has_baby"
    );
  });

  it("refuses a baby photo owned by a post, and any other type owned by a baby", async () => {
    const { household, member } = await createHousehold("Disjoint");
    const baby = await createBaby(household.id, "Sprout");
    const post = await prisma.feedPost.create({
      data: { householdId: household.id, babyId: baby.id, authorMemberId: member.id, body: "hello" }
    });

    // Both the ownership check and the lifecycle check forbid this row; PostgreSQL reports whichever
    // it evaluates first, and the requirement is that it is refused, named by either guard.
    await expectOneOfConstraintViolations(
      prisma.attachment.create({
        data: photoData(household.id, member.id, { babyId: baby.id, postId: post.id })
      }),
      ["Attachment_baby_photo_parent", "Attachment_lifecycle_check"]
    );

    await expectConstraintViolation(
      prisma.attachment.create({
        data: photoData(household.id, member.id, { type: AttachmentType.feed_photo, babyId: baby.id })
      }),
      "Attachment_baby_photo_parent"
    );
  });

  it("refuses a photo naming a baby in another household", async () => {
    const mine = await createHousehold("Mine");
    const theirs = await createHousehold("Theirs");
    const theirBaby = await createBaby(theirs.household.id, "Not Mine");

    // The composite foreign key is what makes this impossible; a single-column key would accept it.
    await expectConstraintViolation(
      prisma.attachment.create({
        data: photoData(mine.household.id, mine.member.id, { babyId: theirBaby.id })
      }),
      "Attachment_householdId_babyId_fkey"
    );

    const leaked = await prisma.attachment.count({ where: { babyId: theirBaby.id } });
    expect(leaked).toBe(0);
  });

  it("keeps existing feed photos working untouched", async () => {
    const { household, member } = await createHousehold("Feed");
    const baby = await createBaby(household.id, "Sprout");
    const post = await prisma.feedPost.create({
      data: { householdId: household.id, babyId: baby.id, authorMemberId: member.id, body: "hello" }
    });

    const feedPhoto = await prisma.attachment.create({
      data: {
        ...photoData(household.id, member.id, { type: AttachmentType.feed_photo }),
        postId: post.id,
        position: 0
      }
    });

    expect(feedPhoto.babyId).toBeNull();
    expect(feedPhoto.state).toBe(AttachmentState.available);
  });

  it("still refuses a feed photo that goes live with no post", async () => {
    const { household, member } = await createHousehold("Feed Guard");

    // The lifecycle widening must keep the POST requirement for post-owned types. Relaxing the
    // available branch for everyone would let a feed photo become servable owned by nothing, which
    // the delivery path's post predicate assumes can never happen. Every other test in this file
    // passes with that relaxation in place, so this case is the one that pins it.
    await expectConstraintViolation(
      prisma.attachment.create({
        data: photoData(household.id, member.id, { type: AttachmentType.feed_photo, postId: null })
      }),
      "Attachment_lifecycle_check"
    );
  });

  it("still refuses a feed photo that goes live with a post but no position", async () => {
    const { household, member } = await createHousehold("Feed Position");
    const baby = await createBaby(household.id, "Sprout");
    const post = await prisma.feedPost.create({
      data: { householdId: household.id, babyId: baby.id, authorMemberId: member.id, body: "hello" }
    });

    await expectConstraintViolation(
      prisma.attachment.create({
        data: { ...photoData(household.id, member.id, { type: AttachmentType.feed_photo }), postId: post.id }
      }),
      "Attachment_lifecycle_check"
    );
  });

  it("lets the restricted runtime role read and write the new column", async () => {
    // A migration can deploy cleanly for the migrator role and still leave the application unable to
    // use the column. Nothing here connects as cubby_runtime, so its privilege is asserted directly.
    const [grants] = await prisma.$queryRaw<{ privileges: string[] }[]>`
      SELECT array_agg(DISTINCT privilege_type::text ORDER BY privilege_type::text) AS privileges
      FROM information_schema.column_privileges
      WHERE table_name = 'Attachment' AND column_name = 'babyId' AND grantee = 'cubby_runtime'
    `;
    expect(grants?.privileges ?? []).toEqual(expect.arrayContaining(["INSERT", "SELECT", "UPDATE"]));
  });
});
