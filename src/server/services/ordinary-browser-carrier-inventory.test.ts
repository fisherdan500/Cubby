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
  ["member.restore", "src/app/api/members/[id]/restore/route.ts", "src/components/settings/member-access-manager.tsx"],
  ["member.remove", "src/app/api/members/[id]/route.ts", "src/components/settings/member-access-manager.tsx"],
  ["member.role.update", "src/app/api/members/[id]/route.ts", "src/components/settings/member-access-manager.tsx"],
  ["member.suspend", "src/app/api/members/[id]/suspend/route.ts", "src/components/settings/member-access-manager.tsx"],
  ["notification.preference.save", "src/app/api/notifications/preferences/route.ts", "src/components/settings/notification-preference-form.tsx"],
  ["settings.units.update", "src/app/api/settings/units/route.ts", "src/components/settings/unit-preferences-form.tsx"],
  ["calendar_event.create", "src/app/app/calendar/actions.ts", "src/components/calendar-event-submission.tsx"],
  ["household.accent.update", "src/app/api/settings/appearance/route.ts", "src/components/settings/appearance-form.tsx"],
  ["account.appearance.update", "src/app/api/account/appearance/route.ts", "src/components/personal-appearance-form.tsx"],
  ["planned_schedule.save", "src/app/api/babies/[id]/schedule/route.ts", "src/components/reports/planned-schedule.tsx"],
  ["feed_post.create", "src/app/api/feed/posts/route.ts", "src/components/feed/feed-post-actions.tsx"],
  ["feed_post.delete", "src/app/api/feed/posts/[id]/route.ts", "src/components/feed/feed-post-actions.tsx"],
  ["feed_post.update", "src/app/api/feed/posts/[id]/route.ts", "src/components/feed/feed-post-actions.tsx"],
  // Comments and reactions are written through the same feed carrier.
  ["feed_comment.create", "src/app/api/feed/comments/route.ts", "src/components/feed/feed-post-actions.tsx"],
  ["feed_comment.update", "src/app/api/feed/comments/[id]/route.ts", "src/components/feed/feed-post-actions.tsx"],
  ["feed_comment.delete", "src/app/api/feed/comments/[id]/route.ts", "src/components/feed/feed-post-actions.tsx"],
  ["feed_reaction.set", "src/app/api/feed/reactions/route.ts", "src/components/feed/feed-post-actions.tsx"],
  ["feed_post.restore", "src/app/api/feed/posts/[id]/restore/route.ts", "src/components/feed/feed-post-actions.tsx"]
] as const;

const deniedLegacyInvitationRoutes = [
  ["invite.create", "src/app/api/invites/route.ts"],
  ["invite.revoke", "src/app/api/invites/[token]/revoke/route.ts"],
  ["invite.revoke_all", "src/app/api/invites/revoke-all/route.ts"]
] as const;

describe("ordinary browser carrier closure inventory", () => {
  it("covers exactly the closed 29-operation browser-operation registry", () => {
    expect(carriers.map(([operation]) => operation)).toHaveLength(29);
    expect(new Set(carriers.map(([operation]) => operation)).size).toBe(29);
  });

  it.each(deniedLegacyInvitationRoutes)("%s remains an explicit fail-closed legacy route", (operation, ingress) => {
    const source = read(ingress);
    expect(source, operation).toContain('status: "unavailable"');
    expect(source, operation).toContain('Cache-Control": "no-store"');
    expect(source, operation).toContain('Referrer-Policy": "no-referrer"');
    expect(source, operation).not.toContain("browser-operations");
    expect(source, operation).not.toContain("@/server/services/invites");
    expect(source, operation).not.toContain("expired");
    expect(source, operation).not.toContain("410");
  });

  it("keeps token-free invitation carriers on retained same-ID status, replay, and expiry semantics", () => {
    const manager = read("src/components/invitations/manual-invitation-manager.tsx");
    const service = read("src/server/services/invitation-service.ts");
    const protocol = read("prisma/migrations/20260904120000_invitation_protocol_v2/migration.sql");

    expect(manager).toContain("sessionStorage");
    expect(manager).toContain("operationId");
    for (const endpoint of ["/api/invitations/manual/status", "/api/invitations/manual/replace/status", "/api/invitations/revoke", "/api/invitations/revoke-all"]) {
      expect(manager).toContain(endpoint);
    }
    expect(manager).not.toContain("/api/invites");
    expect(manager).not.toContain("browser-operations");

    for (const procedure of ["status_manual_invite_create_v2", "status_manual_invite_replace_v2", "revoke_invitation_v2", "revoke_all_invitations_v2", "expire_invitation_v2"]) {
      expect(service).toContain(procedure);
    }
    expect(protocol).toContain('"operationId" UUID NOT NULL UNIQUE');
    expect(protocol).toContain("EXCEPTION WHEN unique_violation");
    expect(protocol).toContain("status_manual_invite_create_v2','MANUAL_INVITE_CREATE','status','existing_identity_transition");
    expect(protocol).toContain("status_manual_invite_replace_v2','MANUAL_INVITE_REPLACE','status','existing_identity_transition");
    expect(protocol).toContain("revoke_invitation_v2','INVITE_REVOKE','atomic_submit','create_identity_binding_terminal_result_atomically");
    expect(protocol).toContain("revoke_all_invitations_v2','INVITE_REVOKE_ALL','atomic_submit','create_identity_binding_terminal_result_atomically");
    expect(protocol).toContain("IF result_row.\"intentFingerprint\" IS DISTINCT FROM intent_fingerprint THEN RAISE EXCEPTION 'invitation_operation_conflict'");
    expect(protocol).toContain("expire_invitation_v2','PRESENTATION_CLAIM','close:expiry','existing_claim_identities_and_invite_transition");
    expect(protocol).toContain("IF invite_row.\"status\"='expired' THEN RETURN");
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
