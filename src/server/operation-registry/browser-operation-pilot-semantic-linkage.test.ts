import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

describe("browser operation pilot semantic linkage", () => {
  it("declares the invite revoke exposure and service as one browser-operation pair", () => {
    const checker = read("src/server/operation-registry/checker.ts");
    const invites = read("src/server/services/invites.semantic.ts");

    expect(checker).toContain('["invite.revoke", "src/server/services/invites.ts", "submitInviteRevokeBrowserOperation"]');
    expect(checker).toContain("declarations.length !== 56");
    expect(invites).toContain('kind: "service", id: "invite.revoke", ownerModule: "src/server/services/invites.ts", exportName: "submitInviteRevokeBrowserOperation"');
  });

  it("links selected carrier operation IDs to their browser-operation adapters", () => {
    const checker = read("src/server/operation-registry/checker.ts");
    const calendar = read("src/server/services/calendar.semantic.ts");
    const dashboard = read("src/server/services/dashboard.semantic.ts");
    const households = read("src/server/services/households.semantic.ts");

    expect(checker).toContain('["baby.deactivate", "src/server/services/households.ts", "submitDeactivateBabyBrowserOperation"]');
    expect(checker).toContain('["baby.reactivate", "src/server/services/households.ts", "submitReactivateBabyBrowserOperation"]');
    expect(checker).toContain('["calendar_event.create", "src/server/services/calendar.ts", "submitCalendarEventBrowserOperation"]');
    expect(checker).toContain('["dashboard.warning.dismiss", "src/server/services/dashboard.ts", "dismissDashboardWarningBrowserOperation"]');
    expect(households).toContain('exportName: "submitDeactivateBabyBrowserOperation"');
    expect(households).toContain('exportName: "submitReactivateBabyBrowserOperation"');
    expect(calendar).toContain('exportName: "submitCalendarEventBrowserOperation"');
    expect(dashboard).toContain('exportName: "dismissDashboardWarningBrowserOperation"');
  });
});
