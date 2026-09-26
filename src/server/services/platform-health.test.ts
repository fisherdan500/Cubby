import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/prisma", () => ({ prisma: {} }));
vi.mock("@/server/services/platform-authority", () => ({ getPlatformOwnerContext: vi.fn() }));
vi.mock("@/server/services/smtp-email-delivery", () => ({ createSmtpEmailDeliveryAdapter: vi.fn() }));

import { readPlatformHealth, runPlatformHealthCheck, type PlatformHealthDeps } from "@/server/services/platform-health";

const now = new Date("2026-10-04T12:00:00.000Z");
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 60 * 60 * 1000);
const GIB = 1024 ** 3;

type Run = { status: string; recordedAt: Date; archiveName?: string | null; byteSize?: bigint | null; households?: number | null; accounts?: number | null; photos?: number | null; failure?: string | null };
type Alert = { key: string; activeSince: Date; lastSentAt: Date | null };

function machine(options: {
  runs?: Run[];
  households?: Array<{ lastAutomated: Date | null }>;
  householdBackupsEnabled?: boolean;
  disks?: Record<string, { freeShare: number; totalGiB?: number } | "unreadable">;
  alerts?: Alert[];
  owner?: string | null;
  sendFails?: boolean;
} = {}) {
  const runs = [...(options.runs ?? [{ status: "succeeded", recordedAt: hoursAgo(2), archiveName: "cubby-system-20261004T100000Z.tar", byteSize: 5n * BigInt(GIB), households: 2, accounts: 5, photos: 140 }])]
    .sort((left, right) => right.recordedAt.getTime() - left.recordedAt.getTime());
  let alerts: Alert[] = (options.alerts ?? []).map((alert) => ({ ...alert }));
  const sent: Array<{ recipient: string; subject: string; text: string }> = [];
  const disks = options.disks ?? { "/photos": { freeShare: 0.5 }, "/backups": { freeShare: 0.5 } };

  const deps: PlatformHealthDeps = {
    db: {
      systemBackupRun: {
        findFirst: vi.fn(async ({ where }: { where?: { status?: string } } = {}) =>
          runs.find((run) => !where?.status || run.status === where.status) ?? null)
      },
      household: {
        findMany: vi.fn(async () => (options.households ?? [{ lastAutomated: hoursAgo(3) }]).map((household, index) => ({
          id: `household-${index}`,
          backupRecords: household.lastAutomated ? [{ createdAt: household.lastAutomated }] : []
        })))
      },
      platformHealthAlert: {
        findMany: vi.fn(async () => alerts.map((alert) => ({ ...alert }))),
        deleteMany: vi.fn(async ({ where }: { where: { key: { notIn: string[] } } }) => {
          alerts = alerts.filter((alert) => where.key.notIn.includes(alert.key));
          return { count: 0 };
        }),
        createMany: vi.fn(async ({ data }: { data: Alert[] }) => {
          for (const row of data) if (!alerts.some((alert) => alert.key === row.key)) alerts.push({ ...row });
          return { count: data.length };
        }),
        updateMany: vi.fn(async ({ where, data }: { where: { key: { in: string[] } }; data: { lastSentAt: Date } }) => {
          for (const alert of alerts) if (where.key.in.includes(alert.key)) alert.lastSentAt = data.lastSentAt;
          return { count: where.key.in.length };
        })
      },
      platformAuthority: {
        findUnique: vi.fn(async () => (options.owner === null ? null : { owner: { email: options.owner ?? "owner@example.test" } }))
      }
    } as unknown as PlatformHealthDeps["db"],
    statfs: vi.fn(async (path: string) => {
      const disk = disks[path];
      if (!disk || disk === "unreadable") throw new Error("ENOENT");
      const blocks = ((disk.totalGiB ?? 100) * GIB) / 4096;
      return { bsize: 4096, blocks, bavail: Math.round(blocks * disk.freeShare) };
    }),
    createAdapter: () => ({
      send: vi.fn(async (message: { recipient: string; subject: string; text: string }) => {
        if (options.sendFails) throw new Error("smtp_temporary");
        sent.push(message);
      })
    }),
    config: { attachmentDirectory: "/photos", backupDirectory: "/backups", householdBackupsEnabled: options.householdBackupsEnabled ?? true, timeZone: "UTC" }
  };
  return { deps, sent, alerts: () => alerts };
}

const keys = async (deps: PlatformHealthDeps) => (await readPlatformHealth(now, deps)).problems.map((problem) => problem.key);

describe("platform health", () => {
  beforeEach(() => vi.clearAllMocks());

  it("finds nothing wrong when backups are recent and the disks have room", async () => {
    const { deps } = machine();
    const health = await readPlatformHealth(now, deps);

    expect(health.problems).toEqual([]);
    expect(health.systemBackup.lastSuccess).toMatchObject({ archiveName: "cubby-system-20261004T100000Z.tar", byteSize: 5 * GIB, households: 2, accounts: 5, photos: 140 });
    expect(health.householdBackups).toEqual({ enabled: true, households: 1, stale: 0 });
    // Photos and backups usually share one disk: it is reported once, not twice.
    expect(health.disks).toEqual([{ label: "photos and backups", freeBytes: 50 * GIB, totalBytes: 100 * GIB }]);
  });

  it("reports two disks separately when photos and backups are kept apart", async () => {
    const { deps } = machine({ disks: { "/photos": { freeShare: 0.5 }, "/backups": { freeShare: 0.3, totalGiB: 500 } } });
    expect((await readPlatformHealth(now, deps)).disks).toEqual([
      { label: "photos", freeBytes: 50 * GIB, totalBytes: 100 * GIB },
      { label: "backups", freeBytes: 150 * GIB, totalBytes: 500 * GIB }
    ]);
  });

  it("says when the last whole-system backup failed, with the script's own reason", async () => {
    const { deps } = machine({ runs: [
      { status: "succeeded", recordedAt: hoursAgo(26) },
      { status: "failed", recordedAt: hoursAgo(2), failure: "the database could not be dumped; is the postgres service running?" }
    ] });
    const health = await readPlatformHealth(now, deps);

    expect(health.problems).toEqual([{
      key: "system_backup_failed",
      message: "The last whole-system backup failed (Oct 4, 10:00 AM): the database could not be dumped; is the postgres service running?"
    }]);
  });

  it("says when whole-system backups have stopped, but not before the first one is ever made", async () => {
    expect(await keys(machine({ runs: [{ status: "succeeded", recordedAt: hoursAgo(40) }] }).deps)).toEqual(["system_backup_stale"]);
    expect(await keys(machine({ runs: [{ status: "succeeded", recordedAt: hoursAgo(30) }] }).deps)).toEqual([]);
    // Never set up: the platform page asks for it; an email every day would not.
    const never = machine({ runs: [] });
    expect(await keys(never.deps)).toEqual([]);
    expect((await readPlatformHealth(now, never.deps)).systemBackup).toEqual({ lastRun: null, lastSuccess: null });
  });

  it("counts households whose automatic backups stopped, only when they are switched on", async () => {
    const households = [{ lastAutomated: hoursAgo(3) }, { lastAutomated: hoursAgo(50) }, { lastAutomated: null }];
    const on = await readPlatformHealth(now, machine({ households }).deps);
    expect(on.householdBackups).toEqual({ enabled: true, households: 3, stale: 2 });
    expect(on.problems).toEqual([{ key: "household_backups_stale", message: "2 households have had no automatic backup for over 36 hours." }]);

    const off = await readPlatformHealth(now, machine({ households, householdBackupsEnabled: false }).deps);
    expect(off.householdBackups).toEqual({ enabled: false, households: 0, stale: 0 });
    expect(off.problems).toEqual([]);
  });

  it("warns when a disk holding photos or backups falls under a fifth free, and skips one it cannot read", async () => {
    const { deps } = machine({ disks: { "/photos": { freeShare: 0.12 }, "/backups": "unreadable" } });
    const health = await readPlatformHealth(now, deps);

    expect(health.disks).toEqual([{ label: "photos", freeBytes: 12 * GIB, totalBytes: 100 * GIB }]);
    expect(health.problems).toEqual([{ key: "disk_low_photos", message: "The disk holding photos has 12 GB free (12%)." }]);
  });
});

describe("platform health alerts", () => {
  it("emails the platform owner once when a problem starts, and not every hour after", async () => {
    const { deps, sent, alerts } = machine({ runs: [{ status: "succeeded", recordedAt: hoursAgo(40) }] });

    await expect(runPlatformHealthCheck(now, deps)).resolves.toEqual({ problems: 1, emailed: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ recipient: "owner@example.test", subject: "Cubby needs attention: backups or storage" });
    expect(sent[0]!.text).toContain("- No whole-system backup has succeeded since Oct 2, 8:00 PM.");
    expect(sent[0]!.text).toContain("Platform administration");
    expect(alerts()).toEqual([{ key: "system_backup_stale", activeSince: now, lastSentAt: now }]);

    const later = new Date(now.getTime() + 60 * 60 * 1000);
    await expect(runPlatformHealthCheck(later, deps)).resolves.toEqual({ problems: 1, emailed: 0 });
    expect(sent).toHaveLength(1);
  });

  it("reminds once a day while a problem lasts, and forgets it once it is fixed", async () => {
    const { deps, sent, alerts } = machine({
      runs: [{ status: "succeeded", recordedAt: hoursAgo(40) }],
      alerts: [
        { key: "system_backup_stale", activeSince: hoursAgo(30), lastSentAt: hoursAgo(25) },
        { key: "disk_low_backups", activeSince: hoursAgo(30), lastSentAt: hoursAgo(25) }
      ]
    });

    await expect(runPlatformHealthCheck(now, deps)).resolves.toEqual({ problems: 1, emailed: 1 });
    expect(sent[0]!.text).toContain("No whole-system backup has succeeded");
    // The disk has room again, so that alert is gone and would be sent afresh if it came back.
    expect(alerts()).toEqual([{ key: "system_backup_stale", activeSince: hoursAgo(30), lastSentAt: now }]);
  });

  it("tries again next time when the email cannot be sent", async () => {
    const { deps, alerts } = machine({ runs: [{ status: "failed", recordedAt: hoursAgo(1), failure: "the photos could not be read" }], sendFails: true });

    await expect(runPlatformHealthCheck(now, deps)).resolves.toEqual({ problems: 1, emailed: 0 });
    expect(alerts()).toEqual([{ key: "system_backup_failed", activeSince: now, lastSentAt: null }]);
  });

  it("sends nothing while there is no platform owner to tell", async () => {
    const { deps, sent } = machine({ runs: [{ status: "failed", recordedAt: hoursAgo(1), failure: "the photos could not be read" }], owner: null });

    await expect(runPlatformHealthCheck(now, deps)).resolves.toEqual({ problems: 1, emailed: 0 });
    expect(sent).toEqual([]);
  });

  it("sends nothing, and clears old alerts, when all is well", async () => {
    const { deps, sent, alerts } = machine({ alerts: [{ key: "disk_low_photos", activeSince: hoursAgo(5), lastSentAt: hoursAgo(5) }] });

    await expect(runPlatformHealthCheck(now, deps)).resolves.toEqual({ problems: 0, emailed: 0 });
    expect(sent).toEqual([]);
    expect(alerts()).toEqual([]);
  });
});
