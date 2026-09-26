import type { PlatformHealth } from "@/server/services/platform-health";

const GIB = 1024 ** 3;

function size(bytes: number) {
  return bytes < GIB ? `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB` : `${Math.round(bytes / GIB)} GB`;
}

function ago(date: Date, now: Date) {
  const hours = Math.round((now.getTime() - date.getTime()) / (60 * 60 * 1000));
  if (hours < 1) return "less than an hour ago";
  if (hours < 48) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/**
 * The platform owner's view of backups and free space: the newest whole-system backup, whether
 * households are backing up automatically, how full the disks are, and anything that needs
 * attention - the same problems the hourly check emails about.
 */
export function PlatformHealthPanel({ health, now, timeZone }: { health: PlatformHealth; now: Date; timeZone: string }) {
  const when = (date: Date) =>
    new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone }).format(date);
  const { lastSuccess } = health.systemBackup;
  const households = health.householdBackups;

  return (
    <section aria-labelledby="platform-health-heading" className="space-y-3">
      <h2 id="platform-health-heading" className="text-base font-semibold">Backups and storage</h2>

      {health.problems.length ? (
        <div role="alert" className="space-y-1 rounded-lg bg-danger/10 p-3 text-sm text-danger">
          <p className="font-semibold">Needs attention</p>
          <ul className="list-disc space-y-1 pl-5">
            {health.problems.map((problem) => <li key={problem.key}>{problem.message}</li>)}
          </ul>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Everything looks fine.</p>
      )}

      <dl className="grid gap-2 text-sm sm:grid-cols-[12rem_minmax(0,1fr)]">
        <dt className="font-semibold">Whole-system backup</dt>
        <dd className="text-muted-foreground">
          {lastSuccess
            ? [
                `Last made ${when(lastSuccess.recordedAt)}, ${ago(lastSuccess.recordedAt, now)}`,
                lastSuccess.byteSize === null ? null : size(lastSuccess.byteSize),
                `${lastSuccess.households ?? 0} households, ${lastSuccess.accounts ?? 0} accounts, ${lastSuccess.photos ?? 0} photos`
              ].filter(Boolean).join(" · ")
            : "None yet. Set up the nightly backup (docs/INSTALL.md, step 4) and it will appear here."}
        </dd>

        <dt className="font-semibold">Household backups</dt>
        <dd className="text-muted-foreground">
          {!households.enabled
            ? "Off. Turn on AUTOMATED_BACKUPS_ENABLED in .env for daily copies of each household."
            : households.stale === 0
              ? "On · every household backed up in the last 36 hours"
              : `On · ${households.stale} of ${households.households} households overdue`}
        </dd>

        <dt className="font-semibold">Free space</dt>
        <dd className="text-muted-foreground">
          {health.disks.length
            ? health.disks.map((disk) => (
                <span key={disk.label} className="block">
                  {disk.label}: {size(disk.freeBytes)} free of {size(disk.totalBytes)} ({Math.round((disk.freeBytes / Math.max(disk.totalBytes, 1)) * 100)}%)
                </span>
              ))
            : "Not available"}
        </dd>
      </dl>

      <p className="text-xs text-muted-foreground">
        Cubby emails you about these when one starts, then once a day until it is fixed.
      </p>
    </section>
  );
}
