import { describe, expect, it } from "vitest";

import { isSecurePublicUrl, publicAppUrl, readWebPushConfig } from "@/lib/web-push-config";

const PUBLIC_KEY = "B".repeat(87);
const PRIVATE_KEY = "A".repeat(43);
const CONFIGURED = {
  WEB_PUSH_VAPID_PUBLIC_KEY: PUBLIC_KEY,
  WEB_PUSH_VAPID_PRIVATE_KEY: PRIVATE_KEY,
  WEB_PUSH_CONTACT: "mailto:family@example.com",
  CUBBY_PUBLIC_URL: "https://cubby.example.com"
};

describe("web push configuration", () => {
  it("stays off, with a reason, when no keys are set", () => {
    const config = readWebPushConfig({ BETTER_AUTH_URL: "https://cubby.example.com" });
    expect(config.enabled).toBe(false);
    if (config.enabled) throw new Error("unreachable");
    // An install that never generated keys must behave exactly as before, not fail at startup.
    expect(config.reason).toContain("WEB_PUSH_VAPID_PUBLIC_KEY");
    expect(config.reason).toContain("WEB_PUSH_CONTACT");
  });

  it("names the one key that is missing", () => {
    const config = readWebPushConfig({ ...CONFIGURED, WEB_PUSH_VAPID_PRIVATE_KEY: undefined });
    expect(config.enabled).toBe(false);
    if (config.enabled) throw new Error("unreachable");
    expect(config.reason).toContain("WEB_PUSH_VAPID_PRIVATE_KEY");
    expect(config.reason).not.toContain("WEB_PUSH_VAPID_PUBLIC_KEY");
  });

  it("turns on when both keys and a contact are present", () => {
    const config = readWebPushConfig(CONFIGURED);
    expect(config.enabled).toBe(true);
    if (!config.enabled) throw new Error("unreachable");
    expect(config.publicKey).toBe(PUBLIC_KEY);
    expect(config.subject).toBe("mailto:family@example.com");
  });

  it("refuses a plain http public address rather than letting push silently never arrive", () => {
    // The failure this prevents: a phone cannot register a service worker outside a secure
    // context, so every notification would vanish with nothing to show why.
    const config = readWebPushConfig({ ...CONFIGURED, CUBBY_PUBLIC_URL: "http://192.168.1.50:3000" });
    expect(config.enabled).toBe(false);
    if (config.enabled) throw new Error("unreachable");
    expect(config.reason).toContain("https");
  });

  it("allows loopback, because a browser treats it as secure", () => {
    expect(readWebPushConfig({ ...CONFIGURED, CUBBY_PUBLIC_URL: "http://localhost:3000" }).enabled).toBe(true);
    expect(readWebPushConfig({ ...CONFIGURED, CUBBY_PUBLIC_URL: "http://127.0.0.1:3000" }).enabled).toBe(true);
  });

  it("prefers the public address over the internal one a proxy terminates", () => {
    // BETTER_AUTH_URL is legitimately internal behind a reverse proxy; a notification opening it
    // would not resolve from a phone.
    const config = readWebPushConfig({
      ...CONFIGURED,
      CUBBY_PUBLIC_URL: "https://cubby.example.com",
      BETTER_AUTH_URL: "http://10.0.0.5:3000"
    });
    expect(config.publicUrl).toBe("https://cubby.example.com");
  });

  it("falls back to BETTER_AUTH_URL so a direct install needs no new setting", () => {
    const config = readWebPushConfig({ ...CONFIGURED, CUBBY_PUBLIC_URL: undefined, BETTER_AUTH_URL: "https://cubby.example.com" });
    expect(config.enabled).toBe(true);
    expect(config.publicUrl).toBe("https://cubby.example.com");
  });

  it("rejects a key of the wrong length instead of failing later at send time", () => {
    expect(() => readWebPushConfig({ ...CONFIGURED, WEB_PUSH_VAPID_PUBLIC_KEY: "too-short" })).toThrow();
    expect(() => readWebPushConfig({ ...CONFIGURED, WEB_PUSH_VAPID_PRIVATE_KEY: "nope" })).toThrow();
  });

  it("requires a contact a push service can actually reach", () => {
    expect(() => readWebPushConfig({ ...CONFIGURED, WEB_PUSH_CONTACT: "family@example.com" })).toThrow();
    expect(readWebPushConfig({ ...CONFIGURED, WEB_PUSH_CONTACT: "https://example.com/contact" }).enabled).toBe(true);
  });

  it("trims a trailing slash so urls do not double up", () => {
    const config = readWebPushConfig({ ...CONFIGURED, CUBBY_PUBLIC_URL: "https://cubby.example.com/" });
    expect(config.publicUrl).toBe("https://cubby.example.com");
    expect(publicAppUrl(config.publicUrl, "/app/moments")).toBe("https://cubby.example.com/app/moments");
  });
});

describe("secure context", () => {
  it("accepts https and loopback, rejects a plain lan address", () => {
    expect(isSecurePublicUrl("https://cubby.example.com")).toBe(true);
    expect(isSecurePublicUrl("http://localhost:3000")).toBe(true);
    expect(isSecurePublicUrl("http://127.0.0.1:3000")).toBe(true);
    expect(isSecurePublicUrl("http://192.168.1.50:3000")).toBe(false);
    expect(isSecurePublicUrl("http://cubby.example.com")).toBe(false);
    expect(isSecurePublicUrl("not a url")).toBe(false);
  });
});

describe("click target", () => {
  it("builds an absolute url from the public address", () => {
    expect(publicAppUrl("https://cubby.example.com", "/app/moments")).toBe("https://cubby.example.com/app/moments");
    expect(publicAppUrl("https://cubby.example.com", "app/moments")).toBe("https://cubby.example.com/app/moments");
  });
});
