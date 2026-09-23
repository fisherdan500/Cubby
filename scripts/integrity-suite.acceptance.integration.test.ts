import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { ActivityType, HouseholdRole, TimerState } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { runDatabaseIntegritySuite } from "@/server/services/integrity";

// The integrity checks are raw SQL that the suite runs inside a read-only snapshot, and a query that
// fails is reported as "incomplete" rather than thrown. A misspelled column would therefore look like
// an unavailable check forever, so every check is exercised here against a real PostgreSQL schema:
// clean data reports clean, and a seeded violation reports exactly that check with exactly that count.

async function seedHousehold(label: string) {
  const user = await prisma.user.create({
    data: {
      name: `${label} Owner`,
      email: `${label.toLowerCase().replaceAll(" ", "-")}-${randomUUID()}@acceptance.invalid`,
      emailVerified: true
    }
  });
  const household = await prisma.household.create({
    data: { name: `${label} Household`, createdByUserId: user.id }
  });
  const member = await prisma.householdMember.create({
    data: { householdId: household.id, userId: user.id, role: HouseholdRole.owner, displayName: `${label} Owner` }
  });
  const baby = await prisma.baby.create({
    data: { householdId: household.id, name: `${label} Baby`, timezone: "UTC" }
  });
  return { user, household, member, baby };
}

// Audit events are append-only, so a household is torn down through its own cascade: the purge trigger
// is what permits those rows to go, exactly as a real household deletion would. The owning user stays;
// a user without a household violates nothing, and removing one would only invite restrict errors.
async function removeHousehold(householdId: string) {
  await prisma.household.delete({ where: { id: householdId } });
}

// Backup file evidence would read the runtime's storage directory, which this disposable database has
// no business touching. With no completed backup records seeded the reader is never called, and this
// one says so out loud rather than quietly returning a fabricated file.
const unusedBackupReader = async () => {
  throw new Error("integrity_acceptance_backup_reader_unused");
};

async function checkResult(id: string) {
  const report = await runDatabaseIntegritySuite(prisma, { backupReader: unusedBackupReader });
  return report.findings.find((finding) => finding.id === id) ?? null;
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe("integrity suite disposable PostgreSQL acceptance", () => {
  it("reports every database check as clean over well-formed household data", async () => {
    const { user, household, member, baby } = await seedHousehold("Clean Integrity");
    await prisma.activityLog.create({
      data: {
        householdId: household.id,
        babyId: baby.id,
        actorMemberId: member.id,
        type: ActivityType.sleep,
        occurredAt: new Date("2026-09-01T09:00:00.000Z"),
        startedAt: new Date("2026-09-01T09:00:00.000Z"),
        endedAt: new Date("2026-09-01T10:00:00.000Z"),
        durationSeconds: 3600,
        timezone: "UTC",
        timerState: TimerState.stopped,
        sleep: { create: { sleepType: "nap", location: "Crib" } }
      }
    });
    const contact = await prisma.contact.create({
      data: { householdId: household.id, name: "Clean Integrity Pediatrician" }
    });
    await prisma.calendarEvent.create({
      data: {
        householdId: household.id,
        title: "Clean Integrity Checkup",
        startTime: new Date("2026-09-02T14:00:00.000Z"),
        babies: { create: { babyId: baby.id } },
        contacts: { create: { contactId: contact.id } }
      }
    });
    for (const chainOrder of [1, 2, 3]) {
      await prisma.auditEvent.create({
        data: {
          householdId: household.id,
          actorUserId: user.id,
          actorMemberId: member.id,
          action: "activity.create",
          entityType: "activity",
          entityId: `clean-integrity-entity-${chainOrder}`,
          schemaVersion: 3,
          chainOrder
        }
      });
    }

    try {
      const report = await runDatabaseIntegritySuite(prisma, { backupReader: unusedBackupReader });
      const reportedIds = report.findings.map(({ id }) => id);

      for (const id of [
        "household_relation_consistency",
        "active_owner_membership_consistency",
        "timer_state_consistency",
        "audit_reference_consistency",
        "activity_detail_type_consistency",
        "calendar_event_relation_consistency",
        "audit_chain_sequence_consistency",
        "sprout_import_mapping_consistency"
      ]) {
        // An unavailable check would surface under the same id, so this covers both a false finding
        // and a query that cannot run at all.
        expect(reportedIds, `${id} should be clean and runnable`).not.toContain(id);
      }
    } finally {
      await removeHousehold(household.id);
    }
  });

  it("reports an activity whose detail row belongs to a different type", async () => {
    const { household, member, baby } = await seedHousehold("Detail Mismatch");
    const activity = await prisma.activityLog.create({
      data: {
        householdId: household.id,
        babyId: baby.id,
        actorMemberId: member.id,
        type: ActivityType.sleep,
        occurredAt: new Date("2026-09-03T09:00:00.000Z"),
        timezone: "UTC",
        sleep: { create: { sleepType: "nap" } }
      }
    });

    try {
      expect(await checkResult("activity_detail_type_consistency")).toBeNull();

      // A restore or an out-of-band writer attaching the wrong detail table: the row still reads as a
      // sleep to every list view, while its own detail says feeding.
      await prisma.sleepLog.delete({ where: { activityId: activity.id } });
      await prisma.feedingLog.create({ data: { activityId: activity.id, mode: "bottle", amount: 120, unit: "ml" } });

      expect(await checkResult("activity_detail_type_consistency")).toMatchObject({
        id: "activity_detail_type_consistency",
        severity: "error",
        count: 1
      });

      // A second detail row alongside the right one is the other half of the same invariant.
      await prisma.feedingLog.delete({ where: { activityId: activity.id } });
      await prisma.sleepLog.create({ data: { activityId: activity.id, sleepType: "nap" } });
      expect(await checkResult("activity_detail_type_consistency")).toBeNull();
      await prisma.bathLog.create({ data: { activityId: activity.id } });

      expect(await checkResult("activity_detail_type_consistency")).toMatchObject({ count: 1 });
    } finally {
      await removeHousehold(household.id);
    }
  });

  it("reports a calendar event linked to another household's baby or contact", async () => {
    const first = await seedHousehold("Calendar Owner");
    const second = await seedHousehold("Calendar Stranger");
    const event = await prisma.calendarEvent.create({
      data: {
        householdId: first.household.id,
        title: "Calendar Owner Checkup",
        startTime: new Date("2026-09-04T14:00:00.000Z"),
        babies: { create: { babyId: first.baby.id } }
      }
    });

    try {
      expect(await checkResult("calendar_event_relation_consistency")).toBeNull();

      await expect(prisma.calendarEventBaby.create({
        data: { householdId: first.household.id, eventId: event.id, babyId: second.baby.id }
      })).rejects.toMatchObject({ code: "P2003" });
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
        await tx.$executeRaw`
          INSERT INTO "CalendarEventBaby" ("householdId", "eventId", "babyId")
          VALUES (${first.household.id}, ${event.id}, ${second.baby.id})
        `;
      });

      expect(await checkResult("calendar_event_relation_consistency")).toMatchObject({
        id: "calendar_event_relation_consistency",
        severity: "error",
        count: 1
      });

      const strangerContact = await prisma.contact.create({
        data: { householdId: second.household.id, name: "Calendar Stranger Contact" }
      });
      await expect(prisma.calendarEventContact.create({
        data: { householdId: first.household.id, eventId: event.id, contactId: strangerContact.id }
      })).rejects.toMatchObject({ code: "P2003" });
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
        await tx.$executeRaw`
          INSERT INTO "CalendarEventContact" ("householdId", "eventId", "contactId")
          VALUES (${first.household.id}, ${event.id}, ${strangerContact.id})
        `;
      });

      // The raw inserts model storage corruption after proving that ordinary writes are rejected.
      // Baby and contact links are counted together, so the second violation raises the same count.
      expect(await checkResult("calendar_event_relation_consistency")).toMatchObject({ count: 2 });

      await prisma.calendarEventBaby.delete({
        where: { babyId_eventId: { babyId: second.baby.id, eventId: event.id } }
      });
      await prisma.calendarEventContact.delete({
        where: { contactId_eventId: { contactId: strangerContact.id, eventId: event.id } }
      });
      expect(await checkResult("calendar_event_relation_consistency")).toBeNull();

      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
        await tx.$executeRaw`
          UPDATE "CalendarEventBaby"
          SET "householdId" = ${second.household.id}
          WHERE "eventId" = ${event.id} AND "babyId" = ${first.baby.id}
        `;
      });
      try {
        expect(await checkResult("calendar_event_relation_consistency")).toMatchObject({ count: 1 });
      } finally {
        await prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
          await tx.$executeRaw`
            UPDATE "CalendarEventBaby"
            SET "householdId" = ${first.household.id}
            WHERE "eventId" = ${event.id} AND "babyId" = ${first.baby.id}
          `;
        });
      }

      const ownerContact = await prisma.contact.create({
        data: { householdId: first.household.id, name: "Calendar Owner Contact" }
      });
      await prisma.calendarEventContact.create({
        data: { householdId: first.household.id, eventId: event.id, contactId: ownerContact.id }
      });
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
        await tx.$executeRaw`
          UPDATE "CalendarEventContact"
          SET "householdId" = ${second.household.id}
          WHERE "eventId" = ${event.id} AND "contactId" = ${ownerContact.id}
        `;
      });
      try {
        expect(await checkResult("calendar_event_relation_consistency")).toMatchObject({ count: 1 });
      } finally {
        await prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
          await tx.$executeRaw`
            UPDATE "CalendarEventContact"
            SET "householdId" = ${first.household.id}
            WHERE "eventId" = ${event.id} AND "contactId" = ${ownerContact.id}
          `;
        });
      }
      expect(await checkResult("calendar_event_relation_consistency")).toBeNull();
    } finally {
      await removeHousehold(first.household.id);
      await removeHousehold(second.household.id);
    }
  });

  it("reports a household whose audit chain skips a number", async () => {
    const { user, household, member } = await seedHousehold("Audit Chain");

    async function appendAuditEvent(chainOrder: number) {
      await prisma.auditEvent.create({
        data: {
          householdId: household.id,
          actorUserId: user.id,
          actorMemberId: member.id,
          action: "activity.create",
          entityType: "activity",
          entityId: `audit-chain-entity-${chainOrder}`,
          schemaVersion: 3,
          chainOrder
        }
      });
    }

    try {
      await appendAuditEvent(1);
      await appendAuditEvent(2);
      expect(await checkResult("audit_chain_sequence_consistency")).toBeNull();

      // Audit rows cannot be deleted, so a gap arrives the only way it can: a row written out of band
      // that claims a number the chain never reached.
      await appendAuditEvent(4);

      expect(await checkResult("audit_chain_sequence_consistency")).toMatchObject({
        id: "audit_chain_sequence_consistency",
        severity: "error",
        count: 1
      });

      // Filling the gap restores a contiguous 1..4, which is what a clean chain looks like.
      await appendAuditEvent(3);
      expect(await checkResult("audit_chain_sequence_consistency")).toBeNull();
    } finally {
      await removeHousehold(household.id);
    }
  });

  it("keeps household identifiers out of the report it publishes", async () => {
    const { user, household, member, baby } = await seedHousehold("Report Privacy");
    const activity = await prisma.activityLog.create({
      data: {
        householdId: household.id,
        babyId: baby.id,
        actorMemberId: member.id,
        type: ActivityType.bath,
        occurredAt: new Date("2026-09-05T09:00:00.000Z"),
        timezone: "UTC",
        bath: { create: {} }
      }
    });
    await prisma.bathLog.delete({ where: { activityId: activity.id } });
    await prisma.moodLog.create({ data: { activityId: activity.id, mood: "content" } });

    try {
      const report = await runDatabaseIntegritySuite(prisma, { backupReader: unusedBackupReader });
      expect(report.findings.map(({ id }) => id)).toContain("activity_detail_type_consistency");

      const serialized = JSON.stringify(report);
      for (const identifier of [household.id, baby.id, member.id, activity.id, user.id]) {
        expect(serialized).not.toContain(identifier);
      }
    } finally {
      await removeHousehold(household.id);
    }
  });
});
