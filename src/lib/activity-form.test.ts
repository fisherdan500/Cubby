import { describe, expect, it } from "vitest";
import {
  activityFormCancelHref,
  activityFormSuccessHref,
  hasActivityDetail,
  resolveActivityUnit,
  resolveFormUnit,
  resolveItemDoseUnit
} from "@/lib/activity-form";

describe("hasActivityDetail", () => {
  it("returns false when optional fields have no saved value", () => {
    expect(hasActivityDetail(undefined, ["location"])).toBe(false);
    expect(hasActivityDetail({ location: "", concern: false, note: null }, ["location", "concern", "note"])).toBe(false);
  });

  it("returns true for saved text, numeric zero, or enabled flags", () => {
    expect(hasActivityDetail({ location: "Nursery" }, ["location"])).toBe(true);
    expect(hasActivityDetail({ amount: 0 }, ["amount"])).toBe(true);
    expect(hasActivityDetail({ blowout: true }, ["blowout"])).toBe(true);
  });
});

describe("activity unit defaults", () => {
  it("uses saved, preferred, then built-in units in that order", () => {
    expect(resolveActivityUnit({ saved: "mL", preferred: "oz", fallback: "oz" })).toBe("mL");
    expect(resolveActivityUnit({ preferred: "mL", fallback: "oz" })).toBe("mL");
    expect(resolveActivityUnit({ fallback: "oz" })).toBe("oz");
  });

  it("ignores blank saved and preferred units", () => {
    expect(resolveActivityUnit({ saved: " ", preferred: "", fallback: "lb" })).toBe("lb");
  });

  it("keeps a persisted blank unit blank while defaults apply only to new activity", () => {
    expect(resolveFormUnit({ editing: true, saved: null, preferred: "mL", fallback: "oz" })).toBe("");
    expect(resolveFormUnit({ editing: false, saved: null, preferred: "mL", fallback: "oz" })).toBe("mL");
  });

  it("uses only the matching named item default", () => {
    const units = { Acetaminophen: "mL", Ibuprofen: "tablet" };

    expect(resolveItemDoseUnit({ name: " acetaminophen ", units })).toBe("mL");
    expect(resolveItemDoseUnit({ name: "Unknown", units })).toBe("");
    expect(resolveItemDoseUnit({ saved: "drops", name: "Acetaminophen", units })).toBe("drops");
  });
});

describe("activity form destinations", () => {
  it("uses explicit safe cancel and success destinations", () => {
    const detailHref = "/app/activities/activity-1?returnTo=%2Fapp%2Fhistory%3FbabyId%3Dbaby-1";

    expect(activityFormCancelHref({ returnTo: detailHref, babyId: "baby-1", allowActivityDestination: true })).toBe(detailHref);
    expect(activityFormSuccessHref({ successTo: detailHref, babyId: "baby-1", allowActivityDestination: true })).toBe(detailHref);
  });

  it("rejects unsafe explicit destinations", () => {
    expect(activityFormCancelHref({ returnTo: "https://example.com/app", babyId: "baby-1", returnDate: "2026-07-13" })).toBe(
      "/app?babyId=baby-1&date=2026-07-13"
    );
    expect(activityFormSuccessHref({ successTo: "//example.com/app", babyId: "baby-1" })).toBe("/app?babyId=baby-1");
  });

  it("rejects nested activity cancel destinations unless the route explicitly trusts one", () => {
    expect(
      activityFormCancelHref({
        returnTo: "/app/activities/activity-1/edit?returnTo=%2Fapp",
        babyId: "baby-1",
        returnDate: "2026-07-13"
      })
    ).toBe("/app?babyId=baby-1&date=2026-07-13");
  });

  it("keeps create success tied to the submitted baby and selected date", () => {
    expect(activityFormSuccessHref({ babyId: "baby-2", returnDate: "2026-07-13" })).toBe(
      "/app?babyId=baby-2&date=2026-07-13"
    );
  });
});
