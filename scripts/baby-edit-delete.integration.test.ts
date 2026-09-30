import { afterAll, describe, expect, it, vi } from "vitest";
import { ActivityType, DiaperKind, HouseholdRole, ReminderKind } from "@prisma/client";

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
 * moment, which erases the very difference `stale` reports. Stated exactly, because the honest
 * scope is narrow: this makes the reader able to report CHECKPOINT/CHAIN DISAGREEMENT. It does
 * not demonstrate detection of dropped audit rows - the database refuses both DELETE and UPDATE
 * on AuditEvent outright, so that scenario is unreachable here. See the NEGATIVE CONTROL below.
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
    // Exact, not a substring scan: toContain("name") also passes for ["names"] or for a
    // changed list that picked up birthDate as well. The leak checks below stay as scans,
    // because there the whole point is that the value appears NOWHERE in the payload.
    expect(event.after).toEqual({ changed: ["name", "notes"] });
    // Scan the WHOLE row, not just `after`: a leak into any other column - a `before`
    // snapshot, a description - is the same disclosure, and scoping the scan to one column
    // cannot see it. Prior values are household content too, so they are scanned as well.
    const serialized = JSON.stringify(event);
    for (const value of ["Corrected Name", "blue blanket", "Original Name"]) {
      expect(serialized).not.toContain(value);
    }
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
    // One instant for the baby and its history: the service passes a single deletedAt to all
    // three writes, so a per-write new Date() would show up here as a mismatch.
    expect(storedActivity.deletedAt).toEqual(stored.deletedAt);
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
  // Scope, stated exactly: this establishes (a) audit rows cannot be deleted at all, and (b) the
  // integrity reader is not a constant - it reports `stale` when the stored checkpoint
  // disagrees with the chain. It does NOT establish detection of dropped rows, which is
  // untestable here precisely because the database refuses both DELETE and UPDATE.
  it("NEGATIVE CONTROL: audit rows cannot be deleted, and the reader is not a constant", async () => {
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
    // Assert the raised constraint, not the rendered sentence: a substring scan of Prisma error
    // text is the exact hazard the helper above documents.
    expect(deletion).toBeInstanceOf(Error);
    expect(/\baudit_event_append_only\b/.test((deletion as Error).message)).toBe(true);
    expect(await prisma.auditEvent.count({ where: { id: target.id } })).toBe(1);

    // Rewriting a hash is the damage the reader must catch. UPDATE is also trigger-guarded, so
    // corrupt the CHECKPOINT instead: the reader compares the chain against it and must not
    // report `valid` when they disagree.
    await prisma.auditIntegrityCheckpoint.update({
      where: { scope: `household:${household.id}` },
      data: { eventCount: 999 }
    });
    const damaged = await auditIntegrity(household.id);
    // Exact, not a negation: "missing" would also satisfy not.toBe("valid") and would mean
    // the checkpoint row vanished rather than the reader detecting disagreement.
    expect(damaged.status).toBe("stale");
  });
  it("can still produce a backup after a baby with links is hidden, without changing what the survivors mean", async () => {
    // The regression this guards: the exporter drops hidden babies but kept their calendar links,
    // notification selections and reminders, so the payload named a baby it did not carry and the
    // format's own dangling-reference check refused EVERY future export for that household.
    const { household, member } = await createHousehold("Backup");
    const hidden = await createBaby(household.id, "Hidden");
    const kept = await createBaby(household.id, "Kept");

    // An event linked ONLY to the baby being hidden. It must be omitted entirely: exporting it
    // with an empty baby list would make it household-wide on restore, because the calendar
    // reader treats "no baby links" as "applies to every baby".
    const soloEvent = await prisma.calendarEvent.create({
      data: { householdId: household.id, title: "Hidden only", startTime: new Date("2026-02-01T10:00:00.000Z") }
    });
    await prisma.calendarEventBaby.create({
      data: { householdId: household.id, babyId: hidden.id, eventId: soloEvent.id }
    });

    // An event shared with a baby that stays. It must survive, still scoped to that baby alone.
    const sharedEvent = await prisma.calendarEvent.create({
      data: { householdId: household.id, title: "Shared", startTime: new Date("2026-02-02T10:00:00.000Z") }
    });
    for (const babyId of [hidden.id, kept.id]) {
      await prisma.calendarEventBaby.create({
        data: { householdId: household.id, babyId, eventId: sharedEvent.id }
      });
    }

    // A truly household-wide event, which legitimately carries no baby links at all.
    const wideEvent = await prisma.calendarEvent.create({
      data: { householdId: household.id, title: "Everyone", startTime: new Date("2026-02-03T10:00:00.000Z") }
    });

    const preference = await prisma.notificationPreference.create({
      data: { householdId: household.id, memberId: member.id, babyScope: "selected" }
    });
    for (const babyId of [hidden.id, kept.id]) {
      await prisma.notificationPreferenceBaby.create({
        data: { householdId: household.id, preferenceId: preference.id, babyId }
      });
    }

    // Reminder.babyId is required and the hide path does not touch reminders, so an unfiltered
    // read dangles exactly like the calendar links did.
    await prisma.reminder.create({
      data: { householdId: household.id, babyId: hidden.id, kind: ReminderKind.feeding, title: "Feed Hidden" }
    });
    await prisma.reminder.create({
      data: { householdId: household.id, babyId: kept.id, kind: ReminderKind.feeding, title: "Feed Kept" }
    });

    // Give it history so it takes the hide path rather than permanent removal.
    await prisma.activityLog.create({
      data: {
        householdId: household.id,
        babyId: hidden.id,
        actorMemberId: member.id,
        type: ActivityType.diaper,
        occurredAt: new Date("2026-02-01T09:00:00.000Z"),
        timezone: "UTC",
        diaper: { create: { kind: DiaperKind.wet } }
      }
    });
    await deleteBaby(hidden.id, { confirmation: "Yes Delete Baby Hidden" });

    // Reaching a result at all is half the proof: buildHouseholdV2Snapshot runs the payload
    // through v2PayloadSchema, whose superRefine throws backup_dangling_reference when anything
    // names a baby the payload does not carry. Before the fix this call threw, and kept throwing
    // for every future export of this household.
    const { payload } = await buildHouseholdV2Snapshot(prisma, household.id);

    expect(payload.babies.map((row) => row.id)).toEqual([kept.id]);

    // The hidden-only event is gone; the shared one survives scoped to the surviving baby only;
    // the genuinely household-wide one keeps its empty list.
    const exported = new Map(payload.calendarEvents.map((item) => [item.id, item]));
    expect(exported.has(soloEvent.id)).toBe(false);
    expect(exported.get(sharedEvent.id)?.babyIds).toEqual([kept.id]);
    expect(exported.get(wideEvent.id)?.babyIds).toEqual([]);

    // The reminder for the hidden baby is dropped, the other is kept.
    expect(payload.reminders.map((item) => item.babyId)).toEqual([kept.id]);

    // The selection keeps its surviving baby, so the member's rules still mean what they meant.
    const preferences = payload.notificationPreferences ?? [];
    expect(preferences).toHaveLength(1);
    expect(preferences[0].babyScope).toEqual({ mode: "selected", babyIds: [kept.id] });
  });

  it("exports a selection whose only baby is hidden as an empty selection, not as everyone", async () => {
    // The degenerate case the partially-hidden test above cannot reach. Two things must hold:
    // the payload still validates (there is deliberately no .min(1) on the selected list), and
    // the scope stays "selected" with nothing in it. Normalising this to mode "all" would be a
    // silent widening - the member would start receiving notifications for every child.
    const { household, member } = await createHousehold("Degenerate");
    const hidden = await createBaby(household.id, "Solo");
    await createBaby(household.id, "Other");

    const preference = await prisma.notificationPreference.create({
      data: { householdId: household.id, memberId: member.id, babyScope: "selected" }
    });
    await prisma.notificationPreferenceBaby.create({
      data: { householdId: household.id, preferenceId: preference.id, babyId: hidden.id }
    });

    await prisma.activityLog.create({
      data: {
        householdId: household.id,
        babyId: hidden.id,
        actorMemberId: member.id,
        type: ActivityType.diaper,
        occurredAt: new Date("2026-03-01T09:00:00.000Z"),
        timezone: "UTC",
        diaper: { create: { kind: DiaperKind.wet } }
      }
    });
    await deleteBaby(hidden.id, { confirmation: "Yes Delete Baby Solo" });

    const { payload } = await buildHouseholdV2Snapshot(prisma, household.id);
    const preferences = payload.notificationPreferences ?? [];
    expect(preferences).toHaveLength(1);
    expect(preferences[0].babyScope).toEqual({ mode: "selected", babyIds: [] });
  });
});
