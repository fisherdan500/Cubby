import { describe, expect, it } from "vitest";
import { readIntegrityConfig } from "@/lib/integrity-config";

describe("readIntegrityConfig", () => {
  it("is disabled by default with a bounded weekly cadence", () => {
    expect(readIntegrityConfig({ INTEGRITY_CHECKS_ENABLED: undefined, INTEGRITY_CHECK_INTERVAL_HOURS: undefined })).toEqual({
      enabled: false,
      intervalHours: 168
    });
  });

  it("accepts only explicit enablement and bounded integer cadence", () => {
    expect(readIntegrityConfig({ INTEGRITY_CHECKS_ENABLED: "true", INTEGRITY_CHECK_INTERVAL_HOURS: "24" })).toEqual({
      enabled: true,
      intervalHours: 24
    });
    expect(() => readIntegrityConfig({ INTEGRITY_CHECKS_ENABLED: "yes" })).toThrow(/INTEGRITY_CHECKS_ENABLED/);
    expect(() => readIntegrityConfig({ INTEGRITY_CHECK_INTERVAL_HOURS: "0" })).toThrow(/INTEGRITY_CHECK_INTERVAL_HOURS/);
  });
});
