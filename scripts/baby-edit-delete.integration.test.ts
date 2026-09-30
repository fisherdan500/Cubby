import { afterAll, describe, expect, it, vi } from "vitest";
import { ActivityType, DiaperKind, HouseholdRole } from "@prisma/client";

const auth = vi.hoisted(() => {
  const state = {
    context: null as null | { userId: string; householdId: string; memberId: string; role: HouseholdRole },
    capturedRequestContext: async () => {
      if (!state.context) throw new Error("baby_edit_delete_context_not_set");
      return state.context;
    }
  };
  return state;
});

vi.mock("@/server/auth/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/auth/context")>();
  return {
    ...actual,
    getHouseholdContext: vi.fn(auth.capturedRequestContext),
    getEffectiveHouseholdContext: vi.fn(auth.capturedRequestContext)
  };
});

import { prisma } from "@/lib/db/prisma";
import { readHouseholdAuditIntegrity, refreshHouseholdAuditCheckpoint } from "@/server/services/audit-checkpoints";
import { deleteBaby, removeBabyProfile, updateBaby } from "@/server/services/households";
import { buildHouseholdV2Snapshot } from "@/server/services/backups";

afterAll(async () => {
  await prisma.$disconnect();
});

let sequence = 0;

/** A household with an owner, wired into the mocked request context. */
async function createHousehold(label: string) {
  sequence += 1;
  const user = await prisma.user.create({
    data: {
      name: `${label} Owner`,
      email: `baby-edit-delete-${sequence}@acceptance.invalid`,
      emailVerified: true
    }
  });
  const household = await prisma.household.create({
    data: { name: `${label} Household`, createdByUserId: user.id }
  });
  const member = await prisma.householdMember.create({
    data: {
      householdId: household.id,
      userId: user.id,
      role: HouseholdRole.owner,
      displayName: `${label} Owner`
    }
  });
  auth.context = {
    userId: user.id,
    householdId: household.id,
    memberId: member.id,
    role: HouseholdRole.owner
  };
  // Created directly rather than through onboarding, so the household needs its checkpoint before
  // the real integrity reader will report anything but `missing`.
  await refreshHouseholdAuditCheckpoint(household.id, prisma);
  return { user, household, member };
}

async function createBaby(householdId: string, name: string) {
  return prisma.baby.create({ data: { householdId, name, timezone: "UTC" } });
}

/**
 * The EXACT rejection message, never a substring. Prisma embeds the offending source lines in its
 * error text, so `rejects.toThrow("baby_has_history")` also matches a foreign-key error raised from
 * a line that merely mentions that string - a sabotaged precondition passed the gate that way.
 */
async function expectRejection(operation: Promise<unknown>, message: string) {
  const error = await operation.then(() => null, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(message);
}

/**
 * The household's integrity state against the checkpoint taken at creation. Deliberately does NOT
 * refresh first: refreshing rewrites headHash and eventCount from whatever rows exist at that
 * moment, which erases the very difference `stale` reports, so a chain with rows DELETED off its
 * tail would still read `valid`. Reading against the original checkpoint is what makes a dropped
 * audit row detectable.
 */
async function auditIntegrity(householdId: string) {
  return readHouseholdAuditIntegrity(householdId, prisma);
}

describe("baby edit and delete disposable PostgreSQL acceptance", () => {
  it("edits a baby and records which fields changed without recording their values", async () => {
    const { household } = await createHousehold("Edit");
    const baby = await createBaby(household.id, "Original Name");

    await updateBaby(baby.id, { name: "Corrected Name", notes: "prefers the blue blanket" });

    const stored = await prisma.baby.findUniqueOrThrow({ where: { id: baby.id } });
    expect(stored.name).toBe("Corrected Name");
    expect(stored.notes).toBe("prefers the blue blanket");

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { householdId: household.id, babyId: baby.id, action: "baby.update" }
    });
    const after = JSON.stringify(event.after);
    expect(after).toContain("name");
    expect(after).toContain("notes");
    // The audit records WHICH details changed, never the child's details themselves.
    expect(after).not.toContain("Corrected Name");
    expect(after).not.toContain("blue blanket");
    expect(await auditIntegrity(household.id)).toMatchObject({ status: "valid" });
  });

  it("removes an unreferenced baby row outright and leaves the audit chain valid", async () => {
    const { household } = await createHousehold("Remove");
    // Created directly, as the Sprout import does: no audit events, so nothing references it.
    const baby = await createBaby(household.id, "Placeholder");

    await removeBabyProfile(baby.id, { confirmation: "Yes Delete Baby Placeholder" });

    expect(await prisma.baby.findUnique({ where: { id: baby.id } })).toBeNull();
    // The removal is itself audited, with no babyId that would dangle after the row is gone.
    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { householdId: household.id, action: "baby.remove" }
    });
    expect(event.babyId).toBeNull();
    expect(event.entityId).toBe(baby.id);
    expect(await auditIntegrity(household.id)).toMatchObject({ status: "valid" });
  });

  it("refuses to remove a baby that any audit event references, and writes nothing", async () => {
    const { household } = await createHousehold("Referenced");
    const baby = await createBaby(household.id, "Referenced Baby");
    // An edit leaves an audit event behind, which is exactly what must block a row deletion.
    await updateBaby(baby.id, { notes: "now referenced" });

    await expectRejection(
      removeBabyProfile(baby.id, { confirmation: "Yes Delete Baby Referenced Baby" }),
      "baby_has_history"
    );

    const stored = await prisma.baby.findUniqueOrThrow({ where: { id: baby.id } });
    expect(stored.deletedAt).toBeNull();
    expect(await auditIntegrity(household.id)).toMatchObject({ status: "valid" });
  });

  it("hides a baby with history, keeps its rows, and keeps the audit chain valid", async () => {
    const { household, member } = await createHousehold("History");
    const baby = await createBaby(household.id, "Rosie");
    const activity = await prisma.activityLog.create({
      data: {
        householdId: household.id,
        babyId: baby.id,
        actorMemberId: member.id,
        type: ActivityType.diaper,
        occurredAt: new Date("2026-09-01T09:00:00.000Z"),
        timezone: "UTC",
        diaper: { create: { kind: DiaperKind.wet } }
      }
    });

    await deleteBaby(baby.id, { confirmation: "Yes Delete Baby Rosie" });

    const stored = await prisma.baby.findUniqueOrThrow({ where: { id: baby.id } });
    expect(stored.deletedAt).not.toBeNull();
    // Nothing is erased: the history survives, which is what makes this reversible.
    const storedActivity = await prisma.activityLog.findUniqueOrThrow({ where: { id: activity.id } });
    expect(storedActivity.deletedAt).not.toBeNull();
    expect(await prisma.diaperLog.findUnique({ where: { activityId: activity.id } })).not.toBeNull();
    expect(await auditIntegrity(household.id)).toMatchObject({ status: "valid" });
  });

  it("refuses the wrong confirmation phrase and changes nothing", async () => {
    const { household } = await createHousehold("Confirmation");
    const baby = await createBaby(household.id, "Rosie");

    await expectRejection(
      deleteBaby(baby.id, { confirmation: "yes delete baby rosie" }),
      "confirmation_mismatch"
    );
    await expectRejection(
      deleteBaby(baby.id, { confirmation: "Yes Delete Baby Wrong" }),
      "confirmation_mismatch"
    );
    await expectRejection(
      removeBabyProfile(baby.id, { confirmation: "Yes Delete Baby rosie" }),
      "confirmation_mismatch"
    );

    const stored = await prisma.baby.findUniqueOrThrow({ where: { id: baby.id } });
    expect(stored.deletedAt).toBeNull();
    expect(
      await prisma.auditEvent.count({ where: { householdId: household.id, action: "baby.delete" } })
    ).toBe(0);
  });

  it("refuses to touch a baby in another household", async () => {
    const first = await createHousehold("Tenant A");
    const strangerBaby = await createBaby(first.household.id, "Stranger");
    // Switch the request context to a different household; the baby id is now foreign.
    await createHousehold("Tenant B");

    await expectRejection(updateBaby(strangerBaby.id, { name: "Taken Over" }), "not_found");
    await expectRejection(
      deleteBaby(strangerBaby.id, { confirmation: "Yes Delete Baby Stranger" }), "not_found"
    );
    await expectRejection(
      removeBabyProfile(strangerBaby.id, { confirmation: "Yes Delete Baby Stranger" }), "not_found"
    );

    const stored = await prisma.baby.findUniqueOrThrow({ where: { id: strangerBaby.id } });
    expect(stored.name).toBe("Stranger");
    expect(stored.deletedAt).toBeNull();
  });
  it("NEGATIVE CONTROL: audit rows cannot be deleted, and the reader notices a rewritten one", async () => {
    // Every other test asserts `valid`. Without a control, an instrument that ALWAYS returned
    // valid would satisfy them all and the audit-chain assertions would prove nothing.
    const { household } = await createHousehold("Control");
    const throwaway = await createBaby(household.id, "Throwaway");
    await removeBabyProfile(throwaway.id, { confirmation: "Yes Delete Baby Throwaway" });
    expect(await auditIntegrity(household.id)).toMatchObject({ status: "valid" });

    const target = await prisma.auditEvent.findFirstOrThrow({
      where: { householdId: household.id, babyId: null, action: "baby.remove" }
    });

    // A database trigger makes AuditEvent append-only, so deletion is refused outright - a
    // stronger guarantee than the application-level Restrict this feature relies on.
    const deletion = await prisma
      .$executeRaw`DELETE FROM "AuditEvent" WHERE "id" = ${target.id}`
      .then(() => null, (reason: unknown) => reason);
    expect(deletion).not.toBeNull();
    expect(String(deletion)).toContain("audit_event_append_only");
    expect(await prisma.auditEvent.count({ where: { id: target.id } })).toBe(1);

    // Rewriting a hash is the damage the reader must catch. UPDATE is also trigger-guarded, so
    // corrupt the CHECKPOINT instead: the reader compares the chain against it and must not
    // report `valid` when they disagree.
    await prisma.auditIntegrityCheckpoint.update({
      where: { scope: `household:${household.id}` },
      data: { eventCount: 999 }
    });
    const damaged = await auditIntegrity(household.id);
    expect(damaged.status).not.toBe("valid");
  });
  it("can still produce a backup after a baby with a calendar event is hidden", async () => {
    // The regression this guards: the exporter drops hidden babies but kept their calendar links
    // and notification selections, so the payload named a baby it did not carry and the format's
    // own dangling-reference check refused EVERY future export for that household.
    const { household, member } = await createHousehold("Backup");
    const baby = await createBaby(household.id, "Hidden");

    const event = await prisma.calendarEvent.create({
      data: {
        householdId: household.id,
        title: "Checkup",
        startTime: new Date("2026-02-01T10:00:00.000Z")
      }
    });
    await prisma.calendarEventBaby.create({
      data: { householdId: household.id, babyId: baby.id, eventId: event.id }
    });
    const preference = await prisma.notificationPreference.create({
      data: { householdId: household.id, memberId: member.id, babyScope: "selected" }
    });
    await prisma.notificationPreferenceBaby.create({
      data: { householdId: household.id, preferenceId: preference.id, babyId: baby.id }
    });

    // Give it history so it takes the hide path rather than permanent removal.
    await prisma.activityLog.create({
      data: {
        householdId: household.id,
        babyId: baby.id,
        actorMemberId: member.id,
        type: ActivityType.diaper,
        occurredAt: new Date("2026-02-01T09:00:00.000Z"),
        timezone: "UTC",
        diaper: { create: { kind: DiaperKind.wet } }
      }
    });
    await deleteBaby(baby.id, { confirmation: "Yes Delete Baby Hidden" });

    // Reaching a result at all is half the proof: buildHouseholdV2Snapshot runs the payload
    // through v2PayloadSchema, whose superRefine throws backup_dangling_reference when anything
    // names a baby the payload does not carry. Before the fix this call threw, and kept throwing
    // for every future export of this household.
    const { payload } = await buildHouseholdV2Snapshot(prisma, household.id);

    expect(payload.babies.map((row) => row.id)).not.toContain(baby.id);
    expect(payload.calendarEvents.length).toBeGreaterThan(0);
    for (const item of payload.calendarEvents) expect(item.babyIds ?? []).not.toContain(baby.id);
    for (const pref of payload.notificationPreferences) {
      expect(pref.babyIds ?? []).not.toContain(baby.id);
    }
  });
});
