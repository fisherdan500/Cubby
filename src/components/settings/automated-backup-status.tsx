import React from "react";
import Link from "next/link";

type AutomatedBackupStatusProps = {
  status: {
    config: {
      enabled: boolean;
      intervalHours: number;
      retentionCount: number;
      pollMinutes: number;
      retryMinutes: number;
    };
    latestSuccess: {
      createdAt: string;
      checksum: string | null;
      itemCount: number | null;
    } | null;
    latestFailure: {
      createdAt: string;
      errorCode: string | null;
    } | null;
    nextDueAt: string | null;
    healthyVersionCount: number;
    versions: Array<
      | {
          healthy: true;
          filename: string;
          exportedAt: string;
          householdName: string;
          checksum: string;
          size: number;
          itemCount: number;
        }
      | {
          healthy: false;
          filename: string;
          errorCode: string;
        }
    >;
    warnings: Array<{
      filename: string;
      errorCode: string;
    }>;
  };
};

function formatSize(size: number) {
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.ceil(size / 1024))} KB`;
}

function failureMessage(code: string | null) {
  const messages: Record<string, string> = {
    backup_active_timer: "Finish or stop all running and paused timers.",
    backup_directory_unavailable: "Check the backup bind mount and host-directory permissions.",
    backup_invalid: "The local file is corrupt or is not a valid Cubby v2 backup.",
    backup_retention_failed: "The new version is safe, but old-version cleanup must be retried.",
    backup_too_large: "The household snapshot exceeds the 25 MiB backup limit.",
    backup_write_failed: "Check free disk space and host-directory permissions."
  };
  return code ? messages[code] ?? "Check server logs for the sanitized backup failure code." : "Unknown backup failure.";
}

export function AutomatedBackupStatus({ status }: AutomatedBackupStatusProps) {
  return (
    <div className="space-y-4">
      <div className="rounded-md bg-muted p-3">
        <p className="font-black">Automation {status.config.enabled ? "enabled" : "disabled"}</p>
        <p className="text-sm text-muted-foreground">
          Every {status.config.intervalHours} hours, retry after {status.config.retryMinutes} minutes, retain {status.config.retentionCount} healthy versions.
        </p>
        <p className="text-sm text-muted-foreground">
          Healthy local versions: {status.healthyVersionCount}
          {status.nextDueAt ? ` · Next due ${new Date(status.nextDueAt).toLocaleString()}` : ""}
        </p>
        {status.latestSuccess ? (
          <p className="text-sm text-muted-foreground">
            Last success {new Date(status.latestSuccess.createdAt).toLocaleString()}
            {status.latestSuccess.checksum ? ` · ${status.latestSuccess.checksum.slice(0, 12)}` : ""}
            {status.latestSuccess.itemCount !== null ? ` · ${status.latestSuccess.itemCount} items` : ""}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">No successful automated local backup yet.</p>
        )}
        {status.latestFailure ? (
          <p role="alert" className="text-sm text-muted-foreground">
            Latest failure: {status.latestFailure.errorCode} at {new Date(status.latestFailure.createdAt).toLocaleString()}. {failureMessage(status.latestFailure.errorCode)}
          </p>
        ) : null}
      </div>

      {status.warnings.length ? (
        <div role="alert" className="rounded-md bg-muted p-3 text-sm text-muted-foreground">
          Some local files are unhealthy or missing and do not count toward retention.
        </div>
      ) : null}

      {status.versions.length ? (
        <div className="space-y-3">
          {status.versions.map((version) =>
            version.healthy ? (
              <div key={version.filename} className="rounded-md bg-muted p-3">
                <p className="break-words font-black">{version.householdName}</p>
                <p className="text-sm text-muted-foreground">
                  {new Date(version.exportedAt).toLocaleString()} · {version.itemCount} items · {version.checksum.slice(0, 12)} · {formatSize(version.size)}
                </p>
                <Link
                  href={`/api/backups/local/${version.filename}`}
                  prefetch={false}
                  className="mt-3 inline-flex min-h-11 items-center justify-center rounded-lg border border-border bg-card px-4 py-2 text-sm font-semibold text-foreground transition-colors hover:bg-muted"
                >
                  Download local version
                </Link>
              </div>
            ) : (
              <div key={version.filename} className="rounded-md bg-muted p-3">
                <p className="break-words font-black">{version.filename}</p>
                <p role="alert" className="text-sm text-muted-foreground">
                  Unhealthy local backup: {version.errorCode}. {failureMessage(version.errorCode)}
                </p>
              </div>
            )
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No discovered local automated versions yet.</p>
      )}
    </div>
  );
}
