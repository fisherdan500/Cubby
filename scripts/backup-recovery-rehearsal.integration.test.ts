import { afterAll, describe, expect, it, vi } from "vitest";
import { ActivityType, HouseholdRole, TimerState } from "@prisma/client";

const auth = vi.hoisted(() => ({
  context: null as null | { userId: string; householdId: string; memberId: string; role: HouseholdRole }
}));

vi.mock("@/server/auth/context", () => ({
  getHouseholdContext: vi.fn(async () => {
    if (!auth.context) throw new Error("rehearsal_context_not_set");
    return auth.context;
  }),
  requirePermission: (context: { role: HouseholdRole }) => {
    if (context.role !== HouseholdRole.owner) throw new Error("forbidden");
  }
}));

import { prisma } from "@/lib/db/prisma";
import { exportBackupJson, previewBackupJson, restoreBackupJson } from "@/server/services/backups";
import { parseBackup, payloadChecksum } from "@/server/services/backup-format";

type V2Envelope = ReturnType<typeof parseBackup> extends infer _Result ? {
  format: "cubby-household-backup";
  version: 2;
  exportedAt: string;
  checksum: string;
  payload: Record<string, any>;
} : never;

function context(userId: string, householdId: string, memberId: string) {
  return { userId, householdId, memberId, role: HouseholdRole.owner };
}

function normalizedPayload(backup: V2Envelope) {
  const payload = structuredClone(backup.payload);
  const babyIds = new Map<string, string>(payload.babies.map((baby: any) => [baby.id, `baby:${baby.name}`]));
  const contactIds = new Map<string, string>(payload.contacts.map((contact: any) => [contact.id, `contact:${contact.name}`]));

  payload.babies = payload.babies.map(({ id: _id, ...baby }: any) => baby).sort((a: any, b: any) => a.name.localeCompare(b.name));
  payload.contacts = payload.contacts.map(({ id: _id, ...contact }: any) => contact).sort((a: any, b: any) => a.name.localeCompare(b.name));
  payload.catalogs = payload.catalogs.map(({ id: _id, ...catalog }: any) => catalog).sort((a: any, b: any) => a.name.localeCompare(b.name));
  payload.activities = payload.activities
    .map(({ id: _id, babyId, contactId, ...activity }: any) => ({
      ...activity,
      babyId: babyIds.get(babyId),
      contactId: contactId === null ? null : contactIds.get(contactId)
    }))
    .sort((a: any, b: any) => `${a.occurredAt}:${a.type}`.localeCompare(`${b.occurredAt}:${b.type}`));
  payload.calendarEvents = payload.calendarEvents
    .map(({ id: _id, babyIds: eventBabyIds, contactIds: eventContactIds, ...event }: any) => ({
      ...event,
      babyIds: eventBabyIds.map((id: string) => babyIds.get(id)).sort(),
      contactIds: eventContactIds.map((id: string) => contactIds.get(id)).sort()
    }))
    .sort((a: any, b: any) => a.title.localeCompare(b.title));
  payload.reminders = payload.reminders
    .map(({ id: _id, babyId, ...reminder }: any) => ({ ...reminder, babyId: babyIds.get(babyId) }))
    .sort((a: any, b: any) => a.title.localeCompare(b.title));
  return payload;
}

async function createOwnerHousehold(suffix: string, householdName: string) {
  const user = await prisma.user.create({
    data: { name: `${suffix} Owner`, email: `${suffix}@rehearsal.invalid`, emailVerified: true }
  });
  const household = await prisma.household.create({
    data: { name: householdName, createdByUserId: user.id }
  });
  const member = await prisma.householdMember.create({
    data: { householdId: household.id, userId: user.id, role: HouseholdRole.owner, displayName: `${suffix} owner` }
  });
  return { user, household, member, ctx: context(user.id, household.id, member.id) };
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe("disposable PostgreSQL backup recovery rehearsal", () => {
  it("exports, restores into a fresh owner household, and re-exports equivalent non-secret data", async () => {
    const source = await createOwnerHousehold("source", "Source Nursery");
    const target = await createOwnerHousehold("target", "Fresh Target");
    const staleTarget = await createOwnerHousehold("stale-target", "Stale Target");

    await prisma.householdSettings.create({
      data: {
        householdId: source.household.id,
        allowPublicRegistration: true,
        allowNewHouseholdCreation: true,
        activityOrder: ["play", "medicine", "vaccine"],
        activityVisibility: { play: true, vaccine: true },
        unitPreferences: { volume: "mL", weight: "kg", length: "cm", temperature: "C" },
        dateFormat: "yyyy-MM-dd",
        timeFormat: "HH:mm",
        sleepLocations: ["Crib", "Carrier"],
        medicines: ["Acetaminophen"],
        supplements: ["Vitamin D"],
        nurseryModeEnabled: false,
        pwaInstallPromptEnabled: false,
        accentTheme: "terracotta"
      }
    });
    await prisma.householdSettings.create({ data: { householdId: target.household.id } });

    const activeBaby = await prisma.baby.create({
      data: {
        householdId: source.household.id,
        name: "Avery",
        birthDate: new Date("2025-12-20T00:00:00.000Z"),
        timezone: "America/New_York",
        notes: "Active baby",
        feedingWarningMinutes: 180,
        preferredUnits: { volume: "mL" }
      }
    });
    const inactiveBaby = await prisma.baby.create({
      data: {
        householdId: source.household.id,
        name: "Riley",
        timezone: "UTC",
        notes: "Historical profile",
        inactiveAt: new Date("2026-07-01T12:00:00.000Z")
      }
    });
    const doctor = await prisma.contact.create({
      data: {
        householdId: source.household.id,
        name: "Dr. Rivera",
        kind: "pediatrician",
        phone: "+1-555-0100",
        email: "doctor@rehearsal.invalid",
        notes: "Primary contact"
      }
    });
    await prisma.medicineCatalog.createMany({
      data: [
        { householdId: source.household.id, name: "Acetaminophen", typicalDoseSize: "2.5", unit: "mL", active: true },
        { householdId: source.household.id, name: "Vitamin D", typicalDoseSize: "1", unit: "drop", active: false, isSupplement: true }
      ]
    });

    const stoppedPlay = await prisma.activityLog.create({
      data: {
        householdId: source.household.id,
        babyId: activeBaby.id,
        actorMemberId: source.member.id,
        type: ActivityType.play,
        occurredAt: new Date("2026-07-14T10:00:00.000Z"),
        startedAt: new Date("2026-07-14T10:00:00.000Z"),
        endedAt: new Date("2026-07-14T10:10:00.000Z"),
        durationSeconds: 480,
        timezone: "America/New_York",
        notes: "Floor time",
        source: "sprout",
        externalActorName: "Grandma Jo",
        timerState: TimerState.stopped,
        pausedSeconds: 120,
        play: { create: { activityName: "Tummy time", location: "Nursery", intensity: "gentle" } }
      }
    });
    await prisma.activityLog.create({
      data: {
        householdId: source.household.id,
        babyId: inactiveBaby.id,
        actorMemberId: source.member.id,
        type: ActivityType.medicine,
        occurredAt: new Date("2026-06-30T15:00:00.000Z"),
        timezone: "UTC",
        notes: "Historical dose",
        source: "manual",
        medicine: { create: { name: "Acetaminophen", dose: "2.5", unit: "mL", contactId: doctor.id } }
      }
    });
    const vaccineActivity = await prisma.activityLog.create({
      data: {
        householdId: source.household.id,
        babyId: activeBaby.id,
        actorMemberId: source.member.id,
        type: ActivityType.vaccine,
        occurredAt: new Date("2026-07-10T14:00:00.000Z"),
        timezone: "America/New_York",
        source: "manual",
        vaccine: {
          create: {
            name: "DTaP",
            dose: "1",
            lot: "LOT-REHEARSAL",
            provider: "Dr. Rivera",
            dueDate: new Date("2026-09-10T14:00:00.000Z"),
            documentUrl: "/attachments/source-only.pdf",
            documents: {
              create: {
                originalName: "card.pdf",
                storedName: "source-only.pdf",
                mimeType: "application/pdf",
                fileSize: 128,
                sourcePath: "/source-only/card.pdf"
              }
            }
          }
        }
      }
    });

    await prisma.calendarEvent.create({
      data: {
        householdId: source.household.id,
        title: "Pediatric appointment",
        description: "Routine follow-up",
        startTime: new Date("2026-07-20T14:00:00.000Z"),
        endTime: new Date("2026-07-20T14:30:00.000Z"),
        eventType: "appointment",
        location: "Clinic",
        color: "sage",
        reminderMinutes: 30,
        source: "sprout",
        externalCaretakerNames: ["Grandma Jo"],
        babies: { create: [{ babyId: activeBaby.id }, { babyId: inactiveBaby.id }] },
        contacts: { create: [{ contactId: doctor.id }] }
      }
    });
    await prisma.reminder.create({
      data: {
        householdId: source.household.id,
        babyId: activeBaby.id,
        kind: "medicine",
        title: "Evening medicine",
        cadenceMinutes: 480,
        dueAt: new Date("2026-07-15T22:00:00.000Z"),
        enabled: true
      }
    });

    await prisma.session.create({
      data: { token: "source-session-token", expiresAt: new Date("2099-01-01T00:00:00.000Z"), userId: source.user.id }
    });
    await prisma.account.create({
      data: { id: "source-account", accountId: source.user.email, providerId: "credential", userId: source.user.id, password: "not-a-real-password-hash" }
    });
    await prisma.invite.create({
      data: {
        householdId: source.household.id,
        email: "invitee@rehearsal.invalid",
        role: HouseholdRole.parent,
        tokenHash: "source-invite-token-hash",
        invitedByUserId: source.user.id,
        expiresAt: new Date("2099-01-01T00:00:00.000Z")
      }
    });
    await prisma.apiKey.create({
      data: { householdId: source.household.id, name: "Source key", keyHash: "source-api-key-hash", prefix: "cubby_src", scopes: ["activity:write"] }
    });
    const endpoint = await prisma.webhookEndpoint.create({
      data: { householdId: source.household.id, name: "Source webhook", url: "https://rehearsal.invalid/hook", secret: "source-webhook-secret", events: ["activity_created"] }
    });
    await prisma.webhookDelivery.create({
      data: { householdId: source.household.id, endpointId: endpoint.id, event: "activity_created", activityId: stoppedPlay.id, status: "pending" }
    });
    const subscription = await prisma.pushSubscription.create({
      data: { householdId: source.household.id, userId: source.user.id, endpoint: "https://push.rehearsal.invalid/source", p256dh: "source-p256dh", auth: "source-auth" }
    });
    await prisma.notificationPreference.create({
      data: { householdId: source.household.id, userId: source.user.id, subscriptionId: subscription.id, babyId: activeBaby.id }
    });
    await prisma.notificationLog.create({
      data: { householdId: source.household.id, userId: source.user.id, activityId: stoppedPlay.id, kind: "activity", title: "Source only", status: "pending" }
    });
    await prisma.dashboardWarningDismissal.create({
      data: { householdId: source.household.id, babyId: activeBaby.id, type: "feeding", fingerprint: "source-only", dismissedByMemberId: source.member.id }
    });
    await prisma.auditEvent.create({
      data: { householdId: source.household.id, actorUserId: source.user.id, actorMemberId: source.member.id, action: "source.setup", entityType: "household", entityId: source.household.id }
    });
    await prisma.importBatch.create({
      data: { householdId: source.household.id, actorUserId: source.user.id, sourceSystem: "sprout", sourceFormat: "json", status: "complete" }
    });

    await prisma.auditEvent.create({
      data: { householdId: target.household.id, actorUserId: target.user.id, actorMemberId: target.member.id, action: "household.create", entityType: "household", entityId: target.household.id }
    });
    await prisma.backupRecord.create({
      data: { householdId: target.household.id, actorUserId: target.user.id, kind: "restore", status: "failed", error: "fixture" }
    });

    auth.context = source.ctx;
    const sourceBackup = JSON.parse(await exportBackupJson()) as V2Envelope;
    expect(parseBackup(sourceBackup)).toMatchObject({ version: 2, checksumVerified: true });
    expect(JSON.stringify(sourceBackup)).not.toContain("source-webhook-secret");
    expect(JSON.stringify(sourceBackup)).not.toContain("source-session-token");
    expect(JSON.stringify(sourceBackup)).not.toContain("source-only.pdf");
    expect(sourceBackup.payload.settings).not.toHaveProperty("allowPublicRegistration");
    expect(sourceBackup.payload.settings).not.toHaveProperty("allowNewHouseholdCreation");

    const corrupt = structuredClone(sourceBackup);
    corrupt.payload.household.name = `${corrupt.payload.household.name}!`;
    expect(() => parseBackup(corrupt)).toThrow("backup_checksum_mismatch");
    const dangling = structuredClone(sourceBackup);
    dangling.payload.activities[0].babyId = "missing-baby";
    dangling.checksum = payloadChecksum(dangling.payload);
    expect(() => parseBackup(dangling)).toThrow(/backup_dangling_reference/);

    auth.context = staleTarget.ctx;
    await expect(previewBackupJson(sourceBackup)).resolves.toMatchObject({ checksumVerified: true });
    await prisma.contact.create({ data: { householdId: staleTarget.household.id, name: "Concurrent fixture write" } });
    await expect(
      restoreBackupJson(sourceBackup, { confirmation: "Stale Target", previewChecksum: sourceBackup.checksum })
    ).rejects.toThrow("backup_target_not_empty");
    expect(await prisma.baby.count({ where: { householdId: staleTarget.household.id } })).toBe(0);
    expect((await prisma.household.findUniqueOrThrow({ where: { id: staleTarget.household.id } })).name).toBe("Stale Target");

    auth.context = target.ctx;
    const targetOwnerBefore = await prisma.user.findUniqueOrThrow({ where: { id: target.user.id } });
    const targetMemberBefore = await prisma.householdMember.findUniqueOrThrow({ where: { id: target.member.id } });
    await expect(previewBackupJson(sourceBackup)).resolves.toMatchObject({
      householdName: "Source Nursery",
      counts: { babies: 2, contacts: 1, catalogs: 2, activities: 3, calendarEvents: 1, reminders: 1 }
    });
    await expect(
      restoreBackupJson(sourceBackup, { confirmation: "Fresh Target", previewChecksum: sourceBackup.checksum })
    ).resolves.toMatchObject({ restored: 10, legacyPartial: false });

    expect(await prisma.user.findUniqueOrThrow({ where: { id: target.user.id } })).toEqual(targetOwnerBefore);
    expect(await prisma.householdMember.findUniqueOrThrow({ where: { id: target.member.id } })).toEqual(targetMemberBefore);
    expect(await prisma.householdMember.count({ where: { householdId: target.household.id } })).toBe(1);
    expect(await prisma.baby.count({ where: { householdId: target.household.id, inactiveAt: { not: null } } })).toBe(1);
    expect(await prisma.activityLog.findFirstOrThrow({
      where: { householdId: target.household.id, type: ActivityType.play },
      select: { timerState: true, durationSeconds: true, pausedSeconds: true, source: true, externalActorName: true }
    })).toEqual({
      timerState: TimerState.stopped,
      durationSeconds: 480,
      pausedSeconds: 120,
      source: "sprout",
      externalActorName: "Grandma Jo"
    });
    expect(await prisma.calendarEventBaby.count({ where: { event: { householdId: target.household.id } } })).toBe(2);
    expect(await prisma.calendarEventContact.count({ where: { event: { householdId: target.household.id } } })).toBe(1);
    expect(await prisma.vaccineDocument.count({ where: { vaccineLog: { activity: { householdId: target.household.id } } } })).toBe(0);

    const excludedTargetCounts = await Promise.all([
      prisma.invite.count({ where: { householdId: target.household.id } }),
      prisma.apiKey.count({ where: { householdId: target.household.id } }),
      prisma.webhookEndpoint.count({ where: { householdId: target.household.id } }),
      prisma.webhookDelivery.count({ where: { householdId: target.household.id } }),
      prisma.pushSubscription.count({ where: { householdId: target.household.id } }),
      prisma.notificationPreference.count({ where: { householdId: target.household.id } }),
      prisma.notificationLog.count({ where: { householdId: target.household.id } }),
      prisma.importBatch.count({ where: { householdId: target.household.id } }),
      prisma.dashboardWarningDismissal.count({ where: { householdId: target.household.id } })
    ]);
    expect(excludedTargetCounts).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(await prisma.householdSettings.findUniqueOrThrow({
      where: { householdId: target.household.id },
      select: { allowPublicRegistration: true, allowNewHouseholdCreation: true }
    })).toEqual({ allowPublicRegistration: false, allowNewHouseholdCreation: false });

    const targetBackup = JSON.parse(await exportBackupJson()) as V2Envelope;
    expect(normalizedPayload(targetBackup)).toEqual(normalizedPayload(sourceBackup));
    await expect(
      restoreBackupJson(sourceBackup, { confirmation: "Source Nursery", previewChecksum: sourceBackup.checksum })
    ).rejects.toThrow("backup_target_not_empty");
    expect(await prisma.activityLog.count({ where: { householdId: target.household.id } })).toBe(3);
    expect(vaccineActivity.id).toBeTruthy();
  });
});
