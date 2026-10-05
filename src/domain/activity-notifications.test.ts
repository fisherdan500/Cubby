import { describe, expect, it } from "vitest";

import { activityNotificationText, activityPushPayloadSchema } from "@/domain/activity-notifications";

describe("activity notification lock-screen text", () => {
  it("names who logged which activity for which baby", () => {
    expect(
      activityNotificationText({
        actorName: " Daniel ",
        babyName: " Finley ",
        activityType: "feeding"
      })
    ).toEqual({
      title: "New activity",
      body: "Daniel logged feeding for Finley"
    });
  });

  it("accepts only the fixed content-free notification envelope", () => {
    const payload = {
      kind: "activity_created",
      title: "New activity",
      body: "Daniel logged medicine for Finley",
      url: "https://cubby.example.test/app/activities/activity-1",
      tag: "activity:activity-1"
    };

    expect(activityPushPayloadSchema.parse(payload)).toEqual(payload);
    expect(() => activityPushPayloadSchema.parse({ ...payload, notes: "private medicine details" })).toThrow();
  });
});
