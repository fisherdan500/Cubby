import { describe, expect, it } from "vitest";
import {
  activityBackLabel,
  canonicalTimerReturnTo,
  activityDetailHref,
  activityEditHref,
  activityFallbackHref,
  safeActivityReturnTo
} from "@/lib/activity-navigation";

describe("activityBackLabel", () => {
  it.each([
    ["/app?babyId=baby-1", "Back to Dashboard"],
    ["/app/history?babyId=baby-1", "Back to Full Log"],
    ["/app/moments?babyId=baby-1&filter=milestone", "Back to Moments"],
    // A link saved before the rename still returns to Moments, which /app/feed forwards to.
    ["/app/feed?babyId=baby-1", "Back to Moments"],
    ["/app/calendar?babyId=baby-1", "Back to Calendar"]
  ])("labels source %s", (source, label) => {
    expect(activityBackLabel(source)).toBe(label);
  });

  it("falls back to Dashboard for an unknown application source", () => {
    expect(activityBackLabel("/app/settings")).toBe("Back to Dashboard");
  });
});

describe("safeActivityReturnTo", () => {
  it.each([
    "/app",
    "/app?babyId=baby-1&date=2026-07-13",
    "/app/history?babyId=baby-1&type=feeding&search=night+feed&cursor=activity-25",
    "/app/calendar?babyId=baby-1&month=2026-07&date=2026-07-13"
  ])("accepts internal application source %s", (value) => {
    expect(safeActivityReturnTo(value)).toBe(value);
  });

  it.each([
    undefined,
    "",
    "https://example.com/app",
    "//example.com/app",
    "/login",
    "/application",
    "/app/activities/activity-1",
    "/app/%61ctivities/activity-1",
    "/app/activit%69es/activity-1",
    "/app/activities/activity-1/edit?returnTo=%2Fapp",
    "/app/history/../activities/activity-1",
    "/app//activities/activity-1",
    "/app/history/..%2Factivities/activity-1",
    "/app/%",
    "/app/%ZZ",
    "/app/%FF",
    "/app/%80",
    "/app/%C0%AF"
  ])("rejects unsafe or nested source %s", (value) => {
    expect(safeActivityReturnTo(value)).toBeUndefined();
  });

  it("rejects duplicate return parameters represented as an array", () => {
    expect(safeActivityReturnTo(["/app", "/app/history"])).toBeUndefined();
  });
});

describe("activity route hrefs", () => {
  const source = "/app/history?babyId=baby-1&type=feeding&search=night feed";

  it("encodes the source once in a detail URL", () => {
    expect(activityDetailHref("activity-1", source)).toBe(
      "/app/activities/activity-1?returnTo=%2Fapp%2Fhistory%3FbabyId%3Dbaby-1%26type%3Dfeeding%26search%3Dnight%2Bfeed"
    );
  });

  it("preserves the original source in an edit URL", () => {
    expect(activityEditHref("activity-1", source)).toBe(
      "/app/activities/activity-1/edit?returnTo=%2Fapp%2Fhistory%3FbabyId%3Dbaby-1%26type%3Dfeeding%26search%3Dnight%2Bfeed"
    );
  });

  it("omits unsafe sources", () => {
    expect(activityDetailHref("activity-1", "https://example.com/app")).toBe("/app/activities/activity-1");
  });
});

describe("activityFallbackHref", () => {
  it("uses the activity baby and configured timezone date", () => {
    expect(
      activityFallbackHref({
        babyId: "baby-1",
        occurredAt: new Date("2026-07-14T02:30:00.000Z"),
        timeZone: "America/New_York"
      })
    ).toBe("/app?babyId=baby-1&date=2026-07-13");
  });
});

describe("canonicalTimerReturnTo", () => {
  it("preserves a non-activity application route with its query", () => {
    expect(canonicalTimerReturnTo("/app/calendar?babyId=baby-1&date=2026-09-22"))
      .toBe("/app/calendar?babyId=baby-1&date=2026-09-22");
  });

  it("unwraps one validated outer source from an activity or edit route", () => {
    expect(canonicalTimerReturnTo("/app/activities/a?returnTo=%2Fapp%2Fhistory%3FbabyId%3Dbaby-1"))
      .toBe("/app/history?babyId=baby-1");
    expect(canonicalTimerReturnTo("/app/activities/a/edit?returnTo=%2Fapp%2Fcalendar%3FbabyId%3Dbaby-1"))
      .toBe("/app/calendar?babyId=baby-1");
  });

  it.each([
    "/app/activities/a",
    "/app/activities/a?returnTo=",
    "/app/activities/a?returnTo=%2Fapp&returnTo=%2Fapp%2Fhistory",
    "/app/activities/a?returnTo=https%3A%2F%2Fexample.com%2Fapp",
    "/app/activities/a?returnTo=%2Fapp%2Factivities%2Fb"
  ])("falls back safely for an invalid activity source: %s", (href) => {
    expect(canonicalTimerReturnTo(href)).toBe("/app");
  });
});
