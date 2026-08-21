import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

const carriers = [
  ["activity.delete", "src/app/api/activities/[id]/route.ts", "src/components/actions/confirmed-activity-delete.tsx"],
  ["activity.create", "src/app/api/activities/route.ts", "src/components/forms/activity-form.tsx"],
  ["activity.update", "src/app/api/activities/[id]/route.ts", "src/components/forms/activity-form.tsx"],
  ["activity.undo_last", "src/app/api/activities/undo-last/route.ts", "src/components/actions/activity-actions.tsx"],
  ["activity.timer.pause", "src/app/api/timers/[id]/pause/route.ts", "src/components/actions/activity-actions.tsx"],
  ["activity.timer.resume", "src/app/api/timers/[id]/resume/route.ts", "src/components/actions/activity-actions.tsx"],
  ["activity.timer.stop", "src/app/api/timers/[id]/stop/route.ts", "src/components/actions/activity-actions.tsx"],
  ["baby.create", "src/app/api/babies/route.ts", "src/components/forms/baby-form.tsx"],
  ["baby.deactivate", "src/app/api/babies/[id]/deactivate/route.ts", "src/components/actions/baby-lifecycle-button.tsx"],
  ["baby.reactivate", "src/app/api/babies/[id]/reactivate/route.ts", "src/components/actions/baby-lifecycle-button.tsx"],
  ["dashboard.warning.dismiss", "src/app/api/dashboard/warnings/dismiss/route.ts", "src/components/dashboard/dashboard-warnings.tsx"],
  ["invite.create", "src/app/api/invites/route.ts", "src/components/forms/invite-form.tsx"],
  ["invite.revoke", "src/app/api/invites/[token]/revoke/route.ts", "src/components/settings/member-access-manager.tsx"],
  ["invite.revoke_all", "src/app/api/invites/revoke-all/route.ts", "src/components/settings/member-access-manager.tsx"],
  ["member.restore", "src/app/api/members/[id]/restore/route.ts", "src/components/settings/member-access-manager.tsx"],
  ["member.remove", "src/app/api/members/[id]/route.ts", "src/components/settings/member-access-manager.tsx"],
  ["member.role.update", "src/app/api/members/[id]/route.ts", "src/components/settings/member-access-manager.tsx"],
  ["member.suspend", "src/app/api/members/[id]/suspend/route.ts", "src/components/settings/member-access-manager.tsx"],
  ["notification.preference.save", "src/app/api/notifications/preferences/route.ts", "src/components/settings/notification-preference-form.tsx"],
  ["settings.units.update", "src/app/api/settings/units/route.ts", "src/components/settings/unit-preferences-form.tsx"],
  ["calendar_event.create", "src/app/app/calendar/actions.ts", "src/components/calendar-event-submission.tsx"],
  ["household.accent.update", "src/app/api/settings/appearance/route.ts", "src/components/settings/appearance-form.tsx"],
  ["account.appearance.update", "src/app/api/account/appearance/route.ts", "src/components/personal-appearance-form.tsx"]
] as const;

describe("ordinary browser carrier closure inventory", () => {
  it("covers exactly the closed 23-operation registry", () => {
    expect(carriers.map(([operation]) => operation)).toHaveLength(23);
    expect(new Set(carriers.map(([operation]) => operation)).size).toBe(23);
  });

  it.each(carriers)("%s exposes an explicit compacted result at its transport", (operation, ingress) => {
    const source = read(ingress);
    expect(source, operation).toContain("expired");
    if (operation === "calendar_event.create") expect(source).toContain('"expired"');
    else expect(source, operation).toContain("410");
  });

  it.each(carriers)("%s retains and reconciles the same browser operation in its client", (operation, _ingress, client) => {
    const source = read(client);
    expect(source, operation).toContain("sessionStorage");
    expect(source, operation).toMatch(/\/api\/(?:account\/)?browser-operations\/\$\{/);
    expect(source, operation).toContain("pending");
    expect(source, operation).toContain("completed");
    expect(source, operation).toContain("expired");
  });

  it.each(carriers)("%s has a server-issued, partitioned browser reservation with no browser-minted ID", (operation, _ingress, client) => {
    const source = read(client);
    const accountScoped = operation === "account.appearance.update";
    expect(source, operation).toContain(accountScoped ? "/api/account/browser-operations/partition" : "/api/browser-operations/partition");
    expect(source, operation).toContain("partition");
    expect(source, operation).toContain("sessionStorage");
    expect(source, operation).not.toContain("crypto.getRandomValues");
    expect(source, operation).not.toContain("createBrowserOperationId");
  });

  it("keeps the activity browser-v2 branches separate from historical UUID receipt compatibility", () => {
    for (const path of [
      "src/app/api/activities/route.ts",
      "src/app/api/activities/[id]/route.ts",
      "src/app/api/activities/undo-last/route.ts",
      "src/app/api/timers/[id]/pause/route.ts",
      "src/app/api/timers/[id]/resume/route.ts",
      "src/app/api/timers/[id]/stop/route.ts"
    ]) {
      const source = read(path);
      expect(source).toContain('operationId.startsWith("bmo_")');
      if (source.includes("clientMutationId")) {
        expect(source.indexOf('operationId.startsWith("bmo_")')).toBeLessThan(source.lastIndexOf("clientMutationId"));
      }
    }
  });
});
