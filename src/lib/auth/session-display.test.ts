import { describe, expect, it } from "vitest";
import { sessionDateLabel, sessionDeviceLabel } from "@/lib/auth/session-display";

describe("session display", () => {
  it("builds concise browser and device labels", () => {
    expect(sessionDeviceLabel("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/131.0 Safari/537.36")).toBe(
      "Chrome on Windows"
    );
    expect(sessionDeviceLabel("Mozilla/5.0 (iPhone) AppleWebKit/605.1 Version/18.0 Mobile/15E148 Safari/604.1")).toBe(
      "Safari on iPhone or iPad"
    );
    expect(sessionDeviceLabel(null)).toBe("Unknown browser");
  });

  it("handles invalid stored dates", () => {
    expect(sessionDateLabel("not-a-date")).toBe("Unknown");
  });
});
