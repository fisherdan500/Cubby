import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd());
const inventory = JSON.parse(readFileSync(resolve(root, "docs/design/p1-3-activation-readiness.json"), "utf8")) as {
  decision: string;
  state: string;
  release: string;
  requiredFamilies: Record<string, string[]>;
  genericBetterAuth: { allowed: string[]; denied: string[] };
  secrets: Record<string, string>;
};

describe("P1-3 indivisible activation inventory", () => {
  it("binds the complete unreleased review candidate to DEC-PROD-408", () => {
    expect(inventory).toMatchObject({ decision: "DEC-PROD-408", state: "review_candidate_unreleased" });
    expect(inventory.requiredFamilies.recovery).toContain("src/app/login/page.tsx");
  });
  it("keeps every required credential family source-present before the candidate can be released", () => {
    expect(inventory.release).toBe("all_or_none");
    for (const family of ["password", "recovery", "emailChange", "globalAccountSecurity"]) {
      expect(inventory.requiredFamilies[family]?.length).toBeGreaterThan(0);
      for (const relativePath of inventory.requiredFamilies[family] ?? []) expect(existsSync(resolve(root, relativePath))).toBe(true);
    }
  });

  it("requires the exact complete route, UI, status, and registry surfaces instead of accepting path-only readiness", () => {
    const required = [
      "src/app/account/security/page.operation.ts",
      "src/app/recovery/page.operation.ts",
      "src/components/account-security-panel.operation.ts"
    ];
    for (const relativePath of required) expect(existsSync(resolve(root, relativePath))).toBe(true);
    const passwordRoute = readFileSync(resolve(root, "src/app/api/account/security/password/route.ts"), "utf8");
    const recoveryRoute = readFileSync(resolve(root, "src/app/api/account/security/recovery/route.ts"), "utf8");
    const emailRoute = readFileSync(resolve(root, "src/app/api/account/security/email-change/route.ts"), "utf8");
    const resetRoute = readFileSync(resolve(root, "src/app/api/account/recovery/reset/route.ts"), "utf8");
    const accountPage = readFileSync(resolve(root, "src/app/account/security/page.tsx"), "utf8");
    const panel = readFileSync(resolve(root, "src/components/account-security-panel.tsx"), "utf8");
    expect(passwordRoute).toContain("configuredGlobalSecurityThrottleKey()");
    expect(recoveryRoute).toContain('input.action === "regenerate"');
    expect(emailRoute).toContain('input.action === "status" || input.action === "cancel" || input.action === "cutover" || input.action === "confirm"');
    expect(resetRoute).toContain("recoverPasswordWithCode(");
    expect(resetRoute).not.toContain("createFreshAuthAttestationSigner");
    expect(resetRoute).toContain("neutralRecoveryResponse()");
    for (const label of ["Regenerate recovery codes", "Check email-change status", "Cancel email change", "Confirm this device", "Check password-change status"]) expect(panel).toContain(label);
    expect(panel).toContain("createGlobalSecurityOperationMetadata");
    expect(panel).not.toContain("split(\"\").reverse()");
    expect(accountPage).toContain("requireUserPage()");
    expect(accountPage).not.toContain("requireHousehold");
    expect(passwordRoute).toContain("requireGlobalSecurityContext()");
    expect(recoveryRoute).toContain("requireGlobalSecurityContext()");
  });

  it("retains Better Auth sign-in as the sole generic credential endpoint", () => {
    expect(inventory.genericBetterAuth.allowed).toEqual(["/api/auth/sign-in/email"]);
    expect(inventory.genericBetterAuth.denied).toEqual(expect.arrayContaining(["/api/auth/sign-up/email", "/api/auth/change-password", "/api/auth/reset-password", "/api/auth/list-sessions"]));
    expect(readFileSync(resolve(root, "src/app/api/auth/[...all]/route.ts"), "utf8")).toContain('url.pathname !== "/api/auth/sign-in/email"');
    const authRoute = readFileSync(resolve(root, "src/app/api/auth/[...all]/route.ts"), "utf8");
    for (const denied of inventory.genericBetterAuth.denied) expect(authRoute).not.toContain(`url.pathname === "${denied}"`);
  });

  it("documents the deliberate display-only and manual-input secret boundaries", () => {
    expect(inventory.secrets).toEqual({ emailVerification: "manual_input_only", recoveryCodes: "display_once_enrollment_response_only", browserStorage: "safe_operation_metadata_only" });
  });
});
