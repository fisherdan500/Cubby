// @vitest-environment jsdom
import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { PlatformTestEmail } from "@/components/settings/platform-test-email";
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
import { testEmailMessage } from "@/components/settings/platform-test-email";

describe("testEmailMessage", () => {
  it("renders the server throttling outcome from HTTP 429", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({ ok: true, data: { status: "throttled", retryAfterSeconds: 60 } }) });
    vi.stubGlobal("fetch", fetch);
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(PlatformTestEmail)));
      await act(async () => container.querySelector("button")!.click());
      expect(container.querySelector('[role="status"]')?.textContent).toContain("Wait 60 seconds");
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(container.querySelector("button")!.disabled).toBe(false);
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  });

  it("explains the server cooldown without suggesting another immediate send", () => {
    expect(testEmailMessage({ status: "throttled", retryAfterSeconds: 60 })).toBe("A test email is still running or was just attempted. Wait 60 seconds before trying again.");
  });

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
