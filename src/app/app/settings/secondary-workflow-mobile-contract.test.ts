import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const backupsSource = readFileSync(new URL("./backups/page.tsx", import.meta.url), "utf8");
const integrationsSource = readFileSync(new URL("./integrations/page.tsx", import.meta.url), "utf8");
const membersSource = readFileSync(new URL("./members/page.tsx", import.meta.url), "utf8");
const appShellSource = readFileSync(new URL("../../../components/app-shell.tsx", import.meta.url), "utf8");
const cardSource = readFileSync(new URL("../../../components/ui/card.tsx", import.meta.url), "utf8");
const inputSource = readFileSync(new URL("../../../components/ui/input.tsx", import.meta.url), "utf8");
const inviteFormSource = readFileSync(new URL("../../../components/forms/invite-form.tsx", import.meta.url), "utf8");
const globalsSource = readFileSync(new URL("../../../styles/globals.css", import.meta.url), "utf8");
const integrationFormsSource = readFileSync(
  new URL("../../../components/settings/integration-forms.tsx", import.meta.url),
  "utf8"
);
const memberManagerSource = readFileSync(
  new URL("../../../components/settings/member-access-manager.tsx", import.meta.url),
  "utf8"
);
const notificationFormSource = readFileSync(
  new URL("../../../components/settings/notification-preference-form.tsx", import.meta.url),
  "utf8"
);

describe("secondary workflow mobile contracts", () => {
  it("allows backup grid columns and cards to shrink below their content width", () => {
    expect(cardSource).toContain('"min-w-0 rounded-lg');
    expect(backupsSource).toContain('<section className="min-w-0 space-y-4">');
    expect(backupsSource).toContain('<Card className="min-w-0 space-y-3">');
    expect(backupsSource).toContain('className="break-words font-black"');
  });

  it("wraps integration rows and breaks opaque integration values", () => {
    expect(integrationsSource.match(/<section className="min-w-0 space-y-4">/g) ?? []).toHaveLength(2);
    expect(integrationsSource).toContain('className="flex min-w-0 flex-wrap items-center justify-between gap-3');
    expect(integrationsSource).toContain('className="min-w-0 flex-1"');
    expect(integrationsSource).toContain('className="break-all text-sm text-muted-foreground"');
    expect(integrationsSource).toContain('className="break-words text-xs text-muted-foreground"');
    expect(integrationFormsSource).toContain('<span className="break-all font-mono font-bold">');
  });

  it("keeps member grids, controls, and actions within their available width", () => {
    expect(membersSource).toContain('className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]"');
    expect(membersSource).toContain('<section className="min-w-0 space-y-4">');
    expect(inputSource).toContain('"min-h-11 min-w-0 w-full');
    expect(inviteFormSource).toContain('<form action={submit} className="min-w-0 space-y-3">');
    expect(inviteFormSource).toContain('className="min-h-11 min-w-0 w-full');
    expect(memberManagerSource).toContain('className="mt-3 flex flex-wrap gap-2"');
    expect(memberManagerSource).toContain('className="flex min-w-0 flex-1 basis-64 gap-2"');
    expect(memberManagerSource).not.toContain('sm:grid-cols-[minmax(0,1fr)_auto_auto]');
  });

  it("reserves mobile fixed-nav clearance when focus scrolls a control into view", () => {
    expect(appShellSource).toContain('<main className="app-shell-content');
    expect(globalsSource).toContain("@media (max-width: 767px)");
    expect(globalsSource).toContain(".app-shell-content :where(");
    expect(globalsSource).toContain("scroll-margin-block: 6rem;");
  });

  it("uses shared visible focus styling for quiet-hour time inputs", () => {
    expect(notificationFormSource).toContain('import { Input } from "@/components/ui/input";');
    expect(notificationFormSource).toContain('<Input name="quietHoursStart" type="time"');
    expect(notificationFormSource).toContain('<Input name="quietHoursEnd" type="time"');
    expect(notificationFormSource).not.toContain('<input name="quietHoursStart"');
    expect(notificationFormSource).not.toContain('<input name="quietHoursEnd"');
  });
});
