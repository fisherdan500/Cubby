import { randomUUID } from "node:crypto";
import { statfs as statFileSystem } from "node:fs/promises";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { attachmentConfig, automatedBackupConfig, env } from "@/lib/env";
import { getPlatformOwnerContext } from "@/server/services/platform-authority";
import { createSmtpEmailDeliveryAdapter } from "@/server/services/smtp-email-delivery";

/**
 * Backup and storage health for the platform owner. A backup that has quietly stopped - a full disk,
 * a broken mount - is found out only when it is needed, so Cubby checks every hour and emails the
 * owner when something needs attention: the last whole-system backup failed, whole-system or
 * household backups have stopped for over a day and a half, or a disk holding photos or backups is
 * nearly full. One email when a problem starts, then one a day while it lasts. Messages name no
 * household and hold nothing from any household's data.
 */

const HOUR_MS = 60 * 60 * 1000;
export const BACKUP_STALE_MS = 36 * HOUR_MS;
const REMINDER_MS = 24 * HOUR_MS;
const LOW_DISK_SHARE = 0.2;
const GIB = 1024 ** 3;
// Short enough that an unreachable mail server does not hold up the next check.
const SEND_TIMEOUTS = { connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 20_000 };

type Mailer = { send: (message: { recipient: string; subject: string; text: string; messageId: string }) => Promise<unknown> };

export type PlatformHealthDeps = {
  db: Pick<PrismaClient, "systemBackupRun" | "household" | "platformHealthAlert" | "platformAuthority">;
  statfs: (path: string) => Promise<{ bsize: number; blocks: number; bavail: number }>;
  createAdapter: () => Mailer;
  config: { attachmentDirectory: string; backupDirectory: string; householdBackupsEnabled: boolean; timeZone: string };
};

export type SystemBackupRunView = {
  status: string;
  recordedAt: Date;
  archiveName: string | null;
  byteSize: number | null;
  households: number | null;
  accounts: number | null;
  photos: number | null;
  failure: string | null;
};
export type DiskView = { label: string; freeBytes: number; totalBytes: number };
export type PlatformHealthProblem = { key: string; message: string };
export type PlatformHealth = {
  systemBackup: { lastRun: SystemBackupRunView | null; lastSuccess: SystemBackupRunView | null };
  householdBackups: { enabled: boolean; households: number; stale: number };
  disks: DiskView[];
  problems: PlatformHealthProblem[];
};

function defaultDeps(): PlatformHealthDeps {
  return {
    db: prisma,
    statfs: (path) => statFileSystem(path),
    createAdapter: () => createSmtpEmailDeliveryAdapter(undefined, undefined, SEND_TIMEOUTS),
    config: {
      attachmentDirectory: attachmentConfig.directory,
      backupDirectory: automatedBackupConfig.directory,
      householdBackupsEnabled: automatedBackupConfig.enabled,
      timeZone: env.APP_TIMEZONE
    }
  };
}

function runView(run: Awaited<ReturnType<PlatformHealthDeps["db"]["systemBackupRun"]["findFirst"]>>): SystemBackupRunView | null {
  if (!run) return null;
  return {
    status: run.status,
    recordedAt: run.recordedAt,
    archiveName: run.archiveName,
    byteSize: run.byteSize === null ? null : Number(run.byteSize),
    households: run.households,
    accounts: run.accounts,
    photos: run.photos,
    failure: run.failure
  };
}

async function readDisks(deps: PlatformHealthDeps): Promise<DiskView[]> {
  const read = async (label: string, path: string) => {
    try {
      const stats = await deps.statfs(path);
      return { label, freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize };
    } catch {
      return null;
    }
  };
  const [photos, backups] = await Promise.all([read("photos", deps.config.attachmentDirectory), read("backups", deps.config.backupDirectory)]);
  // The usual install keeps both on one disk: say so once rather than warn twice.
  if (photos && backups && photos.totalBytes === backups.totalBytes && photos.freeBytes === backups.freeBytes) {
    return [{ ...photos, label: "photos and backups" }];
  }
  return [photos, backups].filter((disk): disk is DiskView => disk !== null);
}

function formatWhen(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone }).format(date);
}

export function formatBytes(bytes: number) {
  if (bytes < GIB) return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
  return `${Math.round(bytes / GIB)} GB`;
}

/** What the platform page shows and what the hourly check emails about, read now. */
export async function readPlatformHealth(now: Date, deps: PlatformHealthDeps): Promise<PlatformHealth> {
  const [lastRunRow, lastSuccessRow, disks] = await Promise.all([
    deps.db.systemBackupRun.findFirst({ orderBy: { recordedAt: "desc" } }),
    deps.db.systemBackupRun.findFirst({ where: { status: "succeeded" }, orderBy: { recordedAt: "desc" } }),
    readDisks(deps)
  ]);
  const lastRun = runView(lastRunRow);
  const lastSuccess = runView(lastSuccessRow);

  let householdBackups = { enabled: false, households: 0, stale: 0 };
  if (deps.config.householdBackupsEnabled) {
    // A household with no baby yet, or made in the last day and a half, has nothing to be late with.
    const households = await deps.db.household.findMany({
      where: { deletedAt: null, createdAt: { lt: new Date(now.getTime() - BACKUP_STALE_MS) }, babies: { some: {} } },
      select: {
        id: true,
        backupRecords: { where: { kind: "automated_export", status: "complete" }, orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true } }
      }
    });
    const stale = households.filter((household) => {
      const newest = household.backupRecords[0]?.createdAt;
      return !newest || now.getTime() - newest.getTime() > BACKUP_STALE_MS;
    }).length;
    householdBackups = { enabled: true, households: households.length, stale };
  }

  const problems: PlatformHealthProblem[] = [];
  const when = (date: Date) => formatWhen(date, deps.config.timeZone);
  if (lastRun?.status === "failed") {
    problems.push({ key: "system_backup_failed", message: `The last whole-system backup failed (${when(lastRun.recordedAt)}): ${lastRun.failure ?? "no reason was recorded"}` });
  }
  // Before the first one there is nothing to have stopped; the platform page asks for it instead.
  if (lastSuccess && now.getTime() - lastSuccess.recordedAt.getTime() > BACKUP_STALE_MS) {
    problems.push({ key: "system_backup_stale", message: `No whole-system backup has succeeded since ${when(lastSuccess.recordedAt)}.` });
  }
  if (householdBackups.stale > 0) {
    const count = householdBackups.stale;
    problems.push({ key: "household_backups_stale", message: `${count} ${count === 1 ? "household has" : "households have"} had no automatic backup for over 36 hours.` });
  }
  for (const disk of disks) {
    const share = disk.totalBytes > 0 ? disk.freeBytes / disk.totalBytes : 0;
    if (share < LOW_DISK_SHARE) {
      problems.push({
        key: `disk_low_${disk.label.replace(/ /g, "_")}`,
        message: `The disk holding ${disk.label} has ${formatBytes(disk.freeBytes)} free (${Math.round(share * 100)}%).`
      });
    }
  }
  return { systemBackup: { lastRun, lastSuccess }, householdBackups, disks, problems };
}

/** The platform page's view. Only the platform owner may see it. */
export async function getPlatformHealth(now = new Date()) {
  await getPlatformOwnerContext();
  return readPlatformHealth(now, defaultDeps());
}

/**
 * The hourly check: emails the platform owner about each problem when it starts and once a day while
 * it lasts, and forgets each one once it is fixed. An email that cannot be sent is tried again next
 * hour.
 */
export async function runPlatformHealthCheck(now = new Date(), deps: PlatformHealthDeps = defaultDeps()) {
  const { problems } = await readPlatformHealth(now, deps);
  const activeKeys = problems.map((problem) => problem.key);
  await deps.db.platformHealthAlert.deleteMany({ where: { key: { notIn: activeKeys } } });
  const known = await deps.db.platformHealthAlert.findMany();
  const knownByKey = new Map(known.map((alert) => [alert.key, alert]));
  const fresh = problems.filter((problem) => !knownByKey.has(problem.key));
  if (fresh.length) {
    await deps.db.platformHealthAlert.createMany({
      data: fresh.map((problem) => ({ key: problem.key, activeSince: now, lastSentAt: null })),
      skipDuplicates: true
    });
  }
  const due = problems.filter((problem) => {
    const lastSentAt = knownByKey.get(problem.key)?.lastSentAt;
    return !lastSentAt || now.getTime() - lastSentAt.getTime() >= REMINDER_MS;
  });
  if (!due.length) return { problems: problems.length, emailed: 0 };

  const authority = await deps.db.platformAuthority.findUnique({ where: { id: "platform" }, select: { owner: { select: { email: true } } } });
  const recipient = authority?.owner.email;
  if (!recipient) return { problems: problems.length, emailed: 0 };
  try {
    await deps.createAdapter().send({
      recipient,
      subject: "Cubby needs attention: backups or storage",
      text: [
        "Cubby found something that needs your attention:",
        "",
        ...due.map((problem) => `- ${problem.message}`),
        "",
        "Platform administration in Cubby shows the latest backups and free space.",
        "You will get a reminder each day until it is fixed."
      ].join("\n"),
      messageId: `<cubby-health.${randomUUID()}@mail.cubby.local>`
    });
  } catch {
    return { problems: problems.length, emailed: 0 };
  }
  await deps.db.platformHealthAlert.updateMany({ where: { key: { in: due.map((problem) => problem.key) } }, data: { lastSentAt: now } });
  return { problems: problems.length, emailed: due.length };
}
