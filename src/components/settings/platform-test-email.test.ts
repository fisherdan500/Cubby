import { describe, expect, it } from "vitest";
import { testEmailMessage } from "@/components/settings/platform-test-email";

describe("testEmailMessage", () => {
  it("names the recipient and the likely next check after a successful send", () => {
    expect(testEmailMessage({ status: "sent", recipient: "owner@example.test" })).toContain("owner@example.test");
  });

  it("lists every setting to fill in when mail is not configured", () => {
    const message = testEmailMessage({ status: "not_configured" });
    for (const name of ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD", "EMAIL_FROM", "docker compose up -d"]) {
      expect(message).toContain(name);
    }
  });

  it.each([
    ["authentication", "SMTP_PASSWORD"],
    ["connection", "SMTP_HOST"],
    ["temporary", "Try again"],
    ["rejected", "EMAIL_FROM"],
    ["unknown", "activity log"]
  ] as const)("points a %s failure at %s", (reason, hint) => {
    expect(testEmailMessage({ status: "failed", reason, responseCode: null, recipient: "owner@example.test" })).toContain(hint);
  });

  it("includes the server's reply code when there is one", () => {
    expect(testEmailMessage({ status: "failed", reason: "authentication", responseCode: 535, recipient: "owner@example.test" })).toContain("535");
  });
});
