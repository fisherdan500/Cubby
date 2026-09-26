// @vitest-environment jsdom
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PlatformHealthPanel } from "@/components/settings/platform-health-panel";
import type { PlatformHealth } from "@/server/services/platform-health";

globalThis.React = React;
const GIB = 1024 ** 3;
const now = new Date("2026-10-04T12:00:00.000Z");

function render(health: PlatformHealth) {
  document.body.innerHTML = renderToStaticMarkup(createElement(PlatformHealthPanel, { health, now, timeZone: "UTC" }));
  return document.body;
}

const healthy: PlatformHealth = {
  systemBackup: {
    lastRun: null,
    lastSuccess: { status: "succeeded", recordedAt: new Date("2026-10-04T03:15:00.000Z"), archiveName: "cubby-system-20261004T031500Z.tar", byteSize: 2 * GIB, households: 2, accounts: 5, photos: 140, failure: null }
  },
  householdBackups: { enabled: true, households: 2, stale: 0 },
  disks: [{ label: "photos and backups", freeBytes: 60 * GIB, totalBytes: 100 * GIB }],
  problems: []
};

describe("PlatformHealthPanel", () => {
  it("shows the newest whole-system backup, household backups and free space, all well", () => {
    const body = render(healthy);

    expect(body.textContent).toContain("Backups and storage");
    expect(body.textContent).toContain("Last made Oct 4, 3:15 AM, 9 hours ago · 2 GB · 2 households, 5 accounts, 140 photos");
    expect(body.textContent).toContain("On · every household backed up in the last 36 hours");
    expect(body.textContent).toContain("photos and backups: 60 GB free of 100 GB (60%)");
    expect(body.textContent).toContain("Everything looks fine.");
    expect(body.querySelector('[role="alert"]')).toBeNull();
  });

  it("asks for the nightly whole-system backup until the first one is made, and says when household backups are off", () => {
    const body = render({ ...healthy, systemBackup: { lastRun: null, lastSuccess: null }, householdBackups: { enabled: false, households: 0, stale: 0 } });

    expect(body.textContent).toContain("None yet. Set up the nightly backup (docs/INSTALL.md, step 4)");
    expect(body.textContent).toContain("Off. Turn on AUTOMATED_BACKUPS_ENABLED");
  });

  it("lists what needs attention, the same things the email says", () => {
    const body = render({
      ...healthy,
      problems: [
        { key: "system_backup_failed", message: "The last whole-system backup failed (Oct 4, 3:15 AM): the photos could not be read" },
        { key: "disk_low_photos_and_backups", message: "The disk holding photos and backups has 9 GB free (9%)." }
      ]
    });
    const alert = body.querySelector('[role="alert"]')!;

    expect([...alert.querySelectorAll("li")].map((item) => item.textContent)).toEqual([
      "The last whole-system backup failed (Oct 4, 3:15 AM): the photos could not be read",
      "The disk holding photos and backups has 9 GB free (9%)."
    ]);
    expect(body.textContent).toContain("Cubby emails you about these");
    expect(body.textContent).not.toContain("Everything looks fine.");
  });
});
