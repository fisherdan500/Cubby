import { describe, expect, it } from "vitest";
import { activityDeleteError } from "@/lib/activity-delete";

describe("activityDeleteError", () => {
  it("returns no error for a successful API envelope", () => {
    expect(activityDeleteError(true, { ok: true })).toBeUndefined();
  });

  it("uses the API error message when deletion fails", () => {
    expect(activityDeleteError(false, { ok: false, error: { message: "You cannot delete this activity." } })).toBe(
      "You cannot delete this activity."
    );
  });

  it("uses a stable fallback for invalid or missing failure envelopes", () => {
    expect(activityDeleteError(false, null)).toBe("Could not delete this activity.");
    expect(activityDeleteError(true, { ok: false })).toBe("Could not delete this activity.");
  });
});
