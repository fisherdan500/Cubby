import { afterEach, describe, expect, it, vi } from "vitest";

async function loadEnv() {
  vi.resetModules();
  return (await import("@/lib/env")).env;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("APP_TIMEZONE", () => {
  it("defaults to America/New_York when unset or blank", async () => {
    vi.stubEnv("APP_TIMEZONE", "   ");
    expect((await loadEnv()).APP_TIMEZONE).toBe("America/New_York");
  });

  it("accepts a real IANA zone", async () => {
    vi.stubEnv("APP_TIMEZONE", "Europe/London");
    expect((await loadEnv()).APP_TIMEZONE).toBe("Europe/London");
  });

  it("refuses a mistyped zone instead of silently falling back", async () => {
    vi.stubEnv("APP_TIMEZONE", "America/New_Yrok");
    await expect(loadEnv()).rejects.toThrow(/APP_TIMEZONE must be an IANA time zone name/);
  });
});
