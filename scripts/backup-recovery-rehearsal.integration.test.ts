import { afterAll, describe, expect, it, vi } from "vitest";
import { ActivityType, HouseholdRole, TimerState } from "@prisma/client";
import { spawnSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const auth = vi.hoisted(() => ({
  context: null as null | { userId: string; householdId: string; memberId: string; role: HouseholdRole },
  user: null as null | { id: string; name: string; email: string; emailVerified: boolean }
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

vi.mock("@/server/auth/session", () => ({
  requireUser: vi.fn(async () => {
    if (!auth.user) throw new Error("rehearsal_user_not_set");
    return auth.user;
  })
}));

import { prisma } from "@/lib/db/prisma";
import {
  downloadLocalBackupFile,
  exportBackupJson,
  getAutomatedBackupStatus,
  previewBackupJson,
  restoreBackupJson
} from "@/server/services/backups";
import { parseBackup, payloadChecksum } from "@/server/services/backup-format";
import { runAutomatedBackupIfDue } from "@/server/services/automated-backups";
import { publishLocalBackup, readLocalBackup, scanLocalBackups } from "@/server/services/local-backup-storage";
import { provisionBackupRecoveryTarget } from "@/server/services/platform-backup-recovery";
import { createOnboardingHousehold } from "@/server/services/households";
import { lockHouseholdCreation } from "@/server/services/mutation-locks";
import {
  allocatePlatformRegistrationOperation,
  completePlatformRegistrationOperation
} from "@/server/services/platform-authority";
import { recoverPlatformOwner } from "@/server/services/platform-owner-binding";

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

const backupDirectory = process.env.AUTOMATED_BACKUP_DIRECTORY;
const rehearsalHandoffFile = process.env.REHEARSAL_HANDOFF_FILE;
if (!backupDirectory || !rehearsalHandoffFile) {
  throw new Error("rehearsal_environment_not_set");
}

const packagedPlatformOwnerCli = fileURLToPath(new URL("../dist/platform-owner.mjs", import.meta.url));

function runPackagedPlatformOwner(args: string[]) {
  return spawnSync(process.execPath, [packagedPlatformOwnerCli, ...args], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

async function waitForLockWaiters(queryFragment: string, minimumCount: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [result] = await prisma.$queryRaw<Array<{ waiterCount: number }>>`
      SELECT COUNT(*)::integer AS "waiterCount"
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND query ILIKE ${`%${queryFragment}%`}
    `;
    if ((result?.waiterCount ?? 0) >= minimumCount) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`rehearsal_lock_waiters_not_observed:${queryFragment}`);
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
    const targetUser = await prisma.user.create({
      data: { name: "target Owner", email: "target@rehearsal.invalid", emailVerified: true }
    });
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
    await prisma.account.create({
      data: { id: "target-account", accountId: targetUser.email, providerId: "credential", userId: targetUser.id, password: "not-a-real-password-hash" }
    });
    await prisma.platformAuthority.create({ data: { ownerUserId: source.user.id } });
    await prisma.platformSettings.create({
      data: {
        householdCreationMode: "closed",
        allowPublicRegistration: false
      }
    });

    auth.user = source.user;
    const policyOperation = await allocatePlatformRegistrationOperation({
      householdCreationMode: "open",
      allowPublicRegistration: true
    });

    let releaseSettingsLock!: () => void;
    let signalSettingsLockHeld!: () => void;
    const settingsLockHeld = new Promise<void>((resolve) => {
      signalSettingsLockHeld = resolve;
    });
    const settingsLockRelease = new Promise<void>((resolve) => {
      releaseSettingsLock = resolve;
    });
    const settingsLockHolder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id"
        FROM "PlatformSettings"
        WHERE "id" = 'platform'
        FOR UPDATE`;
      signalSettingsLockHeld();
      await settingsLockRelease;
    });
    await settingsLockHeld;

    const oldOwnerPolicyAttempt = completePlatformRegistrationOperation({ operationId: policyOperation.operationId });
    let authorityRecoveryAttempt!: ReturnType<typeof recoverPlatformOwner>;
    try {
      await waitForLockWaiters("PlatformSettings", 1);
      authorityRecoveryAttempt = recoverPlatformOwner({
        currentOwnerUserId: source.user.id,
        successorUserId: targetUser.id,
        confirmSuccessorEmail: targetUser.email
      });
      await waitForLockWaiters("PlatformAuthority", 1);
      expect(await prisma.platformAuthority.findUniqueOrThrow({
        where: { id: "platform" },
        select: { ownerUserId: true }
      })).toEqual({ ownerUserId: source.user.id });
    } finally {
      releaseSettingsLock();
      await settingsLockHolder;
    }
    await expect(oldOwnerPolicyAttempt).resolves.toMatchObject({
      status: "completed",
      settings: { householdCreationMode: "open", allowPublicRegistration: true }
    });
    await expect(authorityRecoveryAttempt).resolves.toMatchObject({ ownerUserId: targetUser.id });
    expect(await prisma.platformAuthority.findUniqueOrThrow({
      where: { id: "platform" },
      select: { ownerUserId: true }
    })).toEqual({ ownerUserId: targetUser.id });

    await recoverPlatformOwner({
      currentOwnerUserId: targetUser.id,
      successorUserId: source.user.id,
      confirmSuccessorEmail: source.user.email
    });
    await prisma.platformSettings.update({
      where: { id: "platform" },
      data: { householdCreationMode: "closed", allowPublicRegistration: false }
    });
    auth.user = null;

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

    const automatedAt = new Date("2026-07-15T21:50:13.000Z");
    const rehearsalConfig = {
      enabled: true,
      directory: backupDirectory,
      intervalHours: 24,
      retentionCount: 2,
      pollMinutes: 15,
      retryMinutes: 60
    };
    const concurrentAttempts = await Promise.all([
      runAutomatedBackupIfDue(source.household.id, automatedAt, rehearsalConfig),
      runAutomatedBackupIfDue(source.household.id, automatedAt, rehearsalConfig)
    ]);
    expect(concurrentAttempts.filter((attempt) => "completed" in attempt)).toHaveLength(1);
    expect(concurrentAttempts.filter((attempt) => "skipped" in attempt)).toHaveLength(1);
    expect(concurrentAttempts.find((attempt) => "skipped" in attempt)).toMatchObject({
      skipped: expect.stringMatching(/^(locked|not_due)$/)
    });
    const firstAutomated = concurrentAttempts.find((attempt) => "completed" in attempt);
    expect(firstAutomated).toMatchObject({ completed: true });
    const firstAutomatedRecord = await prisma.backupRecord.findFirstOrThrow({
      where: { householdId: source.household.id, kind: "automated_export", status: "complete" },
      orderBy: { createdAt: "desc" }
    });

    const localFilesAfterFirstRun = await scanLocalBackups(backupDirectory);
    expect(localFilesAfterFirstRun).toHaveLength(1);
    expect(localFilesAfterFirstRun[0]).toMatchObject({
      healthy: true,
      householdName: "Source Nursery"
    });

    const duplicateAttempt = await runAutomatedBackupIfDue(source.household.id, automatedAt, rehearsalConfig);
    expect(duplicateAttempt).toEqual({ skipped: "not_due" });
    expect(await scanLocalBackups(backupDirectory)).toHaveLength(1);

    auth.context = source.ctx;
    const automatedDownload = await downloadLocalBackupFile(localFilesAfterFirstRun[0]!.filename);
    const sourceBackup = JSON.parse(automatedDownload.body.toString("utf8")) as V2Envelope;
    expect(parseBackup(sourceBackup)).toMatchObject({ version: 2, checksumVerified: true });
    const unassociatedBackup = structuredClone(sourceBackup);
    unassociatedBackup.exportedAt = "2026-07-15T22:00:00.000Z";
    const unassociatedFile = await publishLocalBackup(
      backupDirectory,
      JSON.stringify(unassociatedBackup, null, 2)
    );
    expect(JSON.stringify(sourceBackup)).not.toContain("source-webhook-secret");
    expect(JSON.stringify(sourceBackup)).not.toContain("source-session-token");
    expect(JSON.stringify(sourceBackup)).not.toContain("source-only.pdf");
    expect(sourceBackup.payload.settings).not.toHaveProperty("allowPublicRegistration");
    expect(sourceBackup.payload.settings).not.toHaveProperty("allowNewHouseholdCreation");
    expect(localFilesAfterFirstRun[0]!.healthy && localFilesAfterFirstRun[0].checksum).toBe(sourceBackup.checksum);

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

    const otherActiveHouseholds = await prisma.household.findMany({
      where: { deletedAt: null },
      select: { id: true }
    });
    expect(otherActiveHouseholds).toEqual(expect.arrayContaining([
      { id: source.household.id },
      { id: staleTarget.household.id }
    ]));
    const retiredHouseholds = await prisma.household.updateMany({
      where: { id: { in: otherActiveHouseholds.map((household) => household.id) } },
      data: { deletedAt: new Date("2026-07-16T00:00:00.000Z") }
    });
    expect(retiredHouseholds.count).toBe(otherActiveHouseholds.length);
    expect(await prisma.household.count({ where: { deletedAt: null } })).toBe(0);

    const onboardingRacer = await prisma.user.create({
      data: {
        name: "Concurrent Onboarding Owner",
        email: "concurrent-onboarding@rehearsal.invalid",
        emailVerified: true
      }
    });
    auth.user = onboardingRacer;
    await prisma.platformSettings.update({
      where: { id: "platform" },
      data: { householdCreationMode: "open", allowPublicRegistration: false }
    });
    let releaseHouseholdCreationLock!: () => void;
    let signalHouseholdCreationLockHeld!: () => void;
    const householdCreationLockHeld = new Promise<void>((resolve) => {
      signalHouseholdCreationLockHeld = resolve;
    });
    const householdCreationLockRelease = new Promise<void>((resolve) => {
      releaseHouseholdCreationLock = resolve;
    });
    const lockHolder = prisma.$transaction(async (tx) => {
      await lockHouseholdCreation(tx);
      signalHouseholdCreationLockHeld();
      await householdCreationLockRelease;
    });
    await householdCreationLockHeld;

    const provisioningAttempt = provisionBackupRecoveryTarget({
      currentOwnerUserId: source.user.id,
      targetOwnerUserId: targetUser.id,
      confirmTargetOwnerEmail: targetUser.email,
      targetHouseholdName: "Racing Recovery Target",
      acknowledgement: "I_PROVISION_EMPTY_BACKUP_RECOVERY_TARGET"
    });
    const onboardingAttempt = createOnboardingHousehold({
      householdName: "Concurrent Onboarding Home",
      babyName: "Concurrent Baby"
    });
    try {
      await waitForLockWaiters("pg_advisory_xact_lock", 2);
    } finally {
      releaseHouseholdCreationLock();
      await lockHolder;
    }
    const [concurrentProvisioning, concurrentOnboarding] = await Promise.allSettled([
      provisioningAttempt,
      onboardingAttempt
    ]);
    expect(concurrentProvisioning).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ message: "backup_recovery_household_creation_not_closed" })
    });
    expect(concurrentOnboarding).toMatchObject({ status: "fulfilled" });
    expect(await prisma.household.count({ where: { deletedAt: null } })).toBe(1);
    await prisma.household.updateMany({
      where: { createdByUserId: onboardingRacer.id, deletedAt: null },
      data: { deletedAt: new Date("2026-07-16T00:01:00.000Z") }
    });
    await prisma.platformSettings.update({
      where: { id: "platform" },
      data: { householdCreationMode: "closed", allowPublicRegistration: false }
    });
    auth.user = null;
    expect(await prisma.household.count({ where: { deletedAt: null } })).toBe(0);

    const targetProvisioning = runPackagedPlatformOwner([
      "provision-backup-recovery-target",
      "--current-owner-user-id", source.user.id,
      "--target-owner-user-id", targetUser.id,
      "--confirm-target-owner-email", targetUser.email,
      "--target-household-name", "Fresh Target",
      "--acknowledgement", "I_PROVISION_EMPTY_BACKUP_RECOVERY_TARGET"
    ]);
    expect(targetProvisioning.status, `${targetProvisioning.stdout}${targetProvisioning.stderr}`).toBe(0);
    const targetHousehold = await prisma.household.findFirstOrThrow({
      where: { deletedAt: null, members: { some: { userId: targetUser.id, role: HouseholdRole.owner } } }
    });
    const targetMember = await prisma.householdMember.findFirstOrThrow({
      where: { householdId: targetHousehold.id, userId: targetUser.id, role: HouseholdRole.owner }
    });
    const target = {
      user: targetUser,
      household: targetHousehold,
      member: targetMember,
      ctx: context(targetUser.id, targetHousehold.id, targetMember.id)
    };
    expect(await prisma.household.count({ where: { deletedAt: null } })).toBe(1);
    expect(await prisma.platformAuditEvent.count({
      where: { action: "platform.backup_recovery.target.provision", entityId: target.household.id }
    })).toBe(1);
    expect(await prisma.auditEvent.count({
      where: {
        householdId: target.household.id,
        action: "backup.recovery.target.provision",
        entityId: target.household.id
      }
    })).toBe(1);
    await prisma.backupRecord.create({
      data: {
        householdId: target.household.id,
        actorUserId: target.user.id,
        kind: "restore",
        status: "failed",
        error: "fixture"
      }
    });
    auth.context = target.ctx;
    const removedAutomatedHistory = await prisma.backupRecord.deleteMany({
      where: { householdId: source.household.id, kind: "automated_export" }
    });
    expect(removedAutomatedHistory.count).toBeGreaterThanOrEqual(1);
    expect(await prisma.backupRecord.count({
      where: { householdId: source.household.id, kind: "automated_export" }
    })).toBe(0);
    expect((await scanLocalBackups(backupDirectory)).filter((version) => version.healthy)).not.toHaveLength(0);
    await expect(previewBackupJson(sourceBackup)).resolves.toMatchObject({ checksumVerified: true });
    await expect(getAutomatedBackupStatus()).resolves.toMatchObject({
      healthyVersionCount: 0,
      versions: []
    });
    await expect(downloadLocalBackupFile(automatedDownload.filename)).rejects.toThrow("not_found");

    const inspection = runPackagedPlatformOwner([
      "inspect-backup-recovery",
      "--current-owner-user-id", source.user.id,
      "--filename", automatedDownload.filename
    ]);
    expect(inspection.status, `${inspection.stdout}${inspection.stderr}`).toBe(0);
    expect(inspection.stdout).toContain(`\"filename\":\"${automatedDownload.filename}\"`);
    expect(inspection.stdout).toContain(`\"checksum\":\"${sourceBackup.checksum}\"`);
    expect(inspection.stdout).not.toContain("absolutePath");

    const authorization = runPackagedPlatformOwner([
      "authorize-backup-recovery",
      "--current-owner-user-id", source.user.id,
      "--target-household-id", target.household.id,
      "--target-owner-user-id", target.user.id,
      "--confirm-target-owner-email", target.user.email,
      "--filename", automatedDownload.filename,
      "--confirm-checksum", sourceBackup.checksum,
      "--confirm-source-household-name", "Source Nursery",
      "--acknowledgement", "I_AUTHORIZE_EXPLICIT_BACKUP_RECOVERY"
    ]);
    expect(authorization.status, `${authorization.stdout}${authorization.stderr}`).toBe(0);

    const recoveryRecord = await prisma.backupRecord.findUniqueOrThrow({
      where: { storageFilename: automatedDownload.filename }
    });
    expect(recoveryRecord).toMatchObject({
      householdId: target.household.id,
      actorUserId: null,
      kind: "recovery_authorized",
      status: "complete",
      checksum: sourceBackup.checksum
    });
    expect(await prisma.platformAuditEvent.count({
      where: { action: "platform.backup_recovery.authorize", entityId: recoveryRecord.id }
    })).toBe(1);
    expect(await prisma.auditEvent.count({
      where: {
        householdId: target.household.id,
        action: "backup.recovery.authorize",
        entityId: recoveryRecord.id
      }
    })).toBe(1);

    const replay = runPackagedPlatformOwner([
      "authorize-backup-recovery",
      "--current-owner-user-id", source.user.id,
      "--target-household-id", target.household.id,
      "--target-owner-user-id", target.user.id,
      "--confirm-target-owner-email", target.user.email,
      "--filename", automatedDownload.filename,
      "--confirm-checksum", sourceBackup.checksum,
      "--confirm-source-household-name", "Source Nursery",
      "--acknowledgement", "I_AUTHORIZE_EXPLICIT_BACKUP_RECOVERY"
    ]);
    expect(replay.status).not.toBe(0);
    expect(replay.stderr).toContain("backup_recovery_already_authorized");

    await expect(getAutomatedBackupStatus()).resolves.toMatchObject({
      healthyVersionCount: 1,
      versions: [expect.objectContaining({ filename: automatedDownload.filename })]
    });
    const recoveryDownload = await downloadLocalBackupFile(automatedDownload.filename);
    const recoveryBackup = JSON.parse(recoveryDownload.body.toString("utf8")) as V2Envelope;
    expect(recoveryBackup).toEqual(sourceBackup);
    await prisma.household.updateMany({
      where: { id: { in: otherActiveHouseholds.map((household) => household.id) } },
      data: { deletedAt: null }
    });
    const targetOwnerBefore = await prisma.user.findUniqueOrThrow({ where: { id: target.user.id } });
    const targetMemberBefore = await prisma.householdMember.findUniqueOrThrow({ where: { id: target.member.id } });
    await expect(previewBackupJson(sourceBackup)).resolves.toMatchObject({
      householdName: "Source Nursery",
      counts: { babies: 2, contacts: 1, catalogs: 2, activities: 3, calendarEvents: 1, reminders: 1 }
    });
    await expect(
      restoreBackupJson(recoveryBackup, { confirmation: "Fresh Target", previewChecksum: recoveryBackup.checksum })
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

    await prisma.activityLog.create({
      data: {
        householdId: source.household.id,
        babyId: activeBaby.id,
        actorMemberId: source.member.id,
        type: ActivityType.play,
        occurredAt: new Date("2026-07-16T09:00:00.000Z"),
        startedAt: new Date("2026-07-16T09:00:00.000Z"),
        endedAt: null,
        durationSeconds: null,
        timezone: "America/New_York",
        timerState: TimerState.running,
        play: { create: { activityName: "Active timer", location: "Nursery", intensity: "busy" } }
      }
    });

    const blockedAt = new Date(firstAutomatedRecord.createdAt.getTime() + 24 * 60 * 60 * 1000);
    const blockedAttempt = await runAutomatedBackupIfDue(source.household.id, blockedAt, {
      enabled: true,
      directory: backupDirectory,
      intervalHours: 24,
      retentionCount: 2,
      pollMinutes: 15,
      retryMinutes: 60
    });
    expect(blockedAttempt).toEqual({ failed: true, error: "backup_active_timer" });
    const filesAfterBlockedAttempt = (await scanLocalBackups(backupDirectory))
      .filter((file) => file.healthy)
      .map((file) => file.filename);
    expect(new Set(filesAfterBlockedAttempt)).toEqual(new Set([
      firstAutomatedRecord.storageFilename,
      unassociatedFile.filename
    ]));
    const blockedRecord = await prisma.backupRecord.findFirstOrThrow({
      where: { householdId: source.household.id, kind: "automated_export", status: "failed" },
      orderBy: { createdAt: "desc" }
    });

    await prisma.activityLog.updateMany({
      where: { householdId: source.household.id, timerState: TimerState.running },
      data: { timerState: TimerState.stopped, endedAt: new Date("2026-07-16T09:20:00.000Z"), durationSeconds: 1200 }
    });

    const retryAt = new Date(blockedRecord.createdAt.getTime() + 60 * 60 * 1000);
    const secondAutomated = await runAutomatedBackupIfDue(source.household.id, retryAt, {
      enabled: true,
      directory: backupDirectory,
      intervalHours: 24,
      retentionCount: 2,
      pollMinutes: 15,
      retryMinutes: 60
    });
    expect(secondAutomated).toMatchObject({ completed: true });
    const secondAutomatedRecord = await prisma.backupRecord.findFirstOrThrow({
      where: { householdId: source.household.id, kind: "automated_export", status: "complete" },
      orderBy: { createdAt: "desc" }
    });

    await prisma.contact.create({
      data: { householdId: source.household.id, name: "Retention marker" }
    });

    const nextDueAt = new Date(secondAutomatedRecord.createdAt.getTime() + 24 * 60 * 60 * 1000);
    const thirdAutomated = await runAutomatedBackupIfDue(source.household.id, nextDueAt, rehearsalConfig);
    expect(thirdAutomated).toMatchObject({ completed: true });
    const thirdAutomatedRecord = await prisma.backupRecord.findFirstOrThrow({
      where: { householdId: source.household.id, kind: "automated_export", status: "complete" },
      orderBy: { createdAt: "desc" }
    });

    await prisma.contact.create({
      data: { householdId: source.household.id, name: "Second retention marker" }
    });
    const fourthDueAt = new Date(thirdAutomatedRecord.createdAt.getTime() + 24 * 60 * 60 * 1000);
    const fourthAutomated = await runAutomatedBackupIfDue(source.household.id, fourthDueAt, rehearsalConfig);
    expect(fourthAutomated).toMatchObject({ completed: true });
    const fourthAutomatedRecord = await prisma.backupRecord.findFirstOrThrow({
      where: { householdId: source.household.id, kind: "automated_export", status: "complete" },
      orderBy: { createdAt: "desc" }
    });
    expect(await prisma.backupRecord.findUniqueOrThrow({
      where: { id: secondAutomatedRecord.id },
      select: { status: true }
    })).toEqual({ status: "pruned" });
    await expect(readLocalBackup(backupDirectory, secondAutomatedRecord.storageFilename!))
      .rejects.toThrow("backup_invalid");

    const finalFiles = (await scanLocalBackups(backupDirectory)).filter((file) => file.healthy);
    const finalFilenames = finalFiles.map((file) => file.filename);
    expect(finalFilenames).toHaveLength(4);
    expect(finalFilenames).toContain(unassociatedFile.filename);
    expect(finalFilenames).toContain(firstAutomatedRecord.storageFilename);
    expect(finalFilenames).toContain(thirdAutomatedRecord.storageFilename);
    expect(finalFilenames).toContain(fourthAutomatedRecord.storageFilename);

    const failedAt = new Date(fourthAutomatedRecord.createdAt.getTime() + 24 * 60 * 60 * 1000);
    const failedPublication = await runAutomatedBackupIfDue(source.household.id, failedAt, rehearsalConfig, {
      publish: (root, json, options) => publishLocalBackup(root, json, {
        ...options,
        afterTempFileSynced: () => {
          throw Object.assign(new Error("simulated disk full after fsync"), { code: "ENOSPC" });
        }
      })
    });
    expect(failedPublication).toEqual({ failed: true, error: "backup_write_failed" });
    const failedPublicationRecord = await prisma.backupRecord.findFirstOrThrow({
      where: { householdId: source.household.id, kind: "automated_export", status: "failed" },
      orderBy: { createdAt: "desc" }
    });
    expect(failedPublicationRecord.error).toBe("backup_write_failed");
    const filesAfterFailure = (await scanLocalBackups(backupDirectory))
      .filter((file) => file.healthy)
      .map((file) => file.filename);
    expect(new Set(filesAfterFailure)).toEqual(new Set(finalFilenames));
    expect((await readdir(backupDirectory)).filter((filename) => filename.endsWith(".tmp"))).toEqual([]);
    await Promise.all(finalFilenames.map((filename) => readLocalBackup(backupDirectory, filename)));

    const baselineHandoff = JSON.parse(await readFile(rehearsalHandoffFile, "utf8"));
    await prisma.backupRecord.update({
      where: { id: fourthAutomatedRecord.id },
      data: { householdId: baselineHandoff.householdId, actorUserId: baselineHandoff.userId }
    });
    await writeFile(rehearsalHandoffFile, JSON.stringify({
      ...baselineHandoff,
      filename: fourthAutomatedRecord.storageFilename,
      checksum: fourthAutomatedRecord.checksum
    }), { mode: 0o600 });
  });
});
