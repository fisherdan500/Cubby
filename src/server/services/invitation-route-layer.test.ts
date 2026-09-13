import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd());

const targetRoutes = [
  "claim", "claim/close", "post-signin-bind", "review",
  "credentials/reserve", "credentials/submit", "credentials/status", "credentials/abandon",
  "recovery/enrollment/reserve", "recovery/enrollment/submit", "recovery/enrollment/status", "recovery/enrollment/abandon",
  "recovery/rehearsal/reserve", "recovery/rehearsal/submit", "recovery/rehearsal/status", "recovery/rehearsal/abandon",
  "accept/reserve", "accept/submit", "accept/status", "accept/abandon",
  "manual/create", "manual/replace", "manual/status", "manual/abandon", "manual/replace/status", "manual/replace/abandon",
  "revoke", "revoke-all"
];

describe("reviewed invitation route layer", () => {
  it("owns every reviewed invitation endpoint with an operation sidecar", () => {
    for (const route of targetRoutes) {
      expect(existsSync(resolve(root, `src/app/api/invitations/${route}/route.ts`))).toBe(true);
      expect(existsSync(resolve(root, `src/app/api/invitations/${route}/route.operation.ts`))).toBe(true);
    }
  });

  it("uses the dedicated procedure service and an HTTP-only setup corridor", () => {
    const source = readFileSync(resolve(root, "src/server/services/invitation-route-layer.ts"), "utf8");
    expect(source).toContain("getInvitationServices");
    expect(source).toContain("requireInvitationSetupSession");
    expect(source).toContain("HttpOnly");
    expect(source).toContain("sameSite: \"strict\"");
    expect(source).toContain("Cache-Control");
    expect(source).not.toContain("invitation_protocol.status_operation_v2");
  });

  it("reduces only the recovery-submit terminal status to the active disposable header taxonomy", () => {
    const source = readFileSync(resolve(root, "src/server/services/invitation-route-layer.ts"), "utf8");
    expect(source).toContain('status === "completed"');
    expect(source).toContain('status === "fresh_auth_bound"');
    expect(source).toContain('status === "prepared"');
    expect(source).toContain('"submit_state_other"');
    expect(source).toContain('"submit_receipt_invalid"');
    expect(source).not.toContain("JSON.stringify(receipt)");
  });

  it("neutrally denies token-bearing legacy handlers and fixes generic sign-in to the dispatch callback", () => {
    for (const route of [
      "src/app/api/invites/route.ts",
      "src/app/api/invites/revoke-all/route.ts",
      "src/app/api/invites/[token]/accept/route.ts",
      "src/app/api/invites/[token]/revoke/route.ts"
    ]) {
      const source = readFileSync(resolve(root, route), "utf8");
      expect(source).toContain('status: "unavailable"');
      expect(source).not.toContain('"@/server/services/invites"');
    }
    const authForm = readFileSync(resolve(root, "src/components/auth/auth-form.tsx"), "utf8");
    expect(authForm).toContain('callbackURL: "/invite/dispatch"');
  });
});
