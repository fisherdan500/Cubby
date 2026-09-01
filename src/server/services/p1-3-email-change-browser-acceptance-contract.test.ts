import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const rehearsalUrl = new URL("../../../scripts/p1-3-email-change-browser.acceptance-rehearsal.ts", import.meta.url);

describe("P1-3 complete security browser acceptance contract", () => {
  it("bundles and drives the account-security and public recovery surfaces through the isolated CDP harness", () => {
    const source = readFileSync(rehearsalUrl, "utf8");

    expect(source).toContain("AccountSecurityPanel");
    expect(source).toContain("RecoveryPage");
    expect(source).toContain("runAccountSecurityAcceptance");
    expect(source).toContain("runRecoveryResetAcceptance");
    expect(source).toContain("P1_3_ACCOUNT_SECURITY_BROWSER_ACCEPTANCE_PASS");
    expect(source).toContain("P1_3_RECOVERY_RESET_BROWSER_ACCEPTANCE_PASS");
  });

  it("keeps status-before-retry, recovery display-once, neutral reset, email lifecycle, viewport, and storage assertions in the synthetic harness", () => {
    const source = readFileSync(rehearsalUrl, "utf8");

    for (const marker of [
      "password/status",
      "POST recovery:regenerate",
      "Display-once recovery codes",
      "recovery_same_id_metadata_missing",
      "POST email:status",
      "POST email:cancel",
      "POST email:cutover",
      "POST email:confirm",
      "sessionStorage",
      "localStorage",
      "375, 812",
      "1280, 900",
      "phase6_browser_bundle_cleanup_incomplete"
    ]) expect(source).toContain(marker);
    expect(source).toContain('action === "cutover" ? "issued"');
    expect(source).not.toContain('action === "cutover" ? "completed"');
  });
});
