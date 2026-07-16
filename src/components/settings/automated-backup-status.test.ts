import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AutomatedBackupStatus } from "@/components/settings/automated-backup-status";

const status = {
  config: { enabled: true, intervalHours: 24, retentionCount: 30, pollMinutes: 15, retryMinutes: 60 },
  latestSuccess: { createdAt: "2026-07-15T20:00:00.000Z", checksum: "a".repeat(64), itemCount: 12 },
  latestFailure: { createdAt: "2026-07-15T21:00:00.000Z", errorCode: "backup_write_failed" },
  nextDueAt: "2026-07-16T20:00:00.000Z",
  healthyVersionCount: 1,
  versions: [
    {
      healthy: true as const,
      filename: "cubby-backup-v2-20260715T200000Z-aaaaaaaaaaaa.json",
      exportedAt: "2026-07-15T20:00:00.000Z",
      householdName: "Home",
      checksum: "b".repeat(64),
      size: 2 * 1024 * 1024,
      itemCount: 7
    },
    {
      healthy: false as const,
      filename: "cubby-backup-v2-20260714T200000Z-bbbbbbbbbbbb.json",
      errorCode: "backup_invalid"
    }
  ],
  warnings: [{ filename: "broken.json", errorCode: "backup_invalid" }]
} satisfies Parameters<typeof AutomatedBackupStatus>[0]["status"];

describe("AutomatedBackupStatus", () => {
  it("renders operator status, correct units, actionable failures, and local download links", () => {
    const html = renderToStaticMarkup(createElement(AutomatedBackupStatus, { status }));

    expect(html).toContain("Healthy local versions: 1");
    expect(html).toContain("12 items");
    expect(html).toContain("7 items");
    expect(html).toContain("2.0 MB");
    expect(html).toContain("Check free disk space and host-directory permissions.");
    expect(html).toContain("The local file is corrupt or is not a valid Cubby v2 backup.");
    expect(html).toContain('role="alert"');
    expect(html).toContain("Download local version");
    expect(html).toContain("/api/backups/local/cubby-backup-v2-20260715T200000Z-aaaaaaaaaaaa.json");
  });

  it("keeps restore discovery separate from manual export creation", () => {
    const emptyStatus = { ...status, versions: [], healthyVersionCount: 0, warnings: [] };
    const html = renderToStaticMarkup(createElement(AutomatedBackupStatus, { status: emptyStatus }));

    expect(html).toContain("No discovered local automated versions yet.");
    expect(html).not.toContain("/api/backups/export");
  });
});
