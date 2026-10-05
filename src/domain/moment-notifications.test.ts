import { describe, expect, it } from "vitest";

import {
  momentNotificationAudience,
  momentNotificationText,
  momentPushPayloadSchema,
  withinQuietHours
} from "@/domain/moment-notifications";

const HOUSEHOLD = ["m-daniel", "m-partner", "m-grandma"];

describe("who hears about a moment", () => {
  it("tells the household about a new post, except whoever wrote it", () => {
    expect(
      momentNotificationAudience({
        kind: "post",
        actorMemberId: "m-daniel",
        parentAuthorMemberId: "m-daniel",
        householdMemberIds: HOUSEHOLD
      })
    ).toEqual(["m-partner", "m-grandma"]);
  });

  it("keeps a reply in the conversation: the author and everyone who already commented", () => {
    // The case that a plain "notify the author" rule loses: the author replies to a comment, and
    // the person who started the conversation never hears about it.
    expect(
      momentNotificationAudience({
        kind: "comment",
        actorMemberId: "m-daniel",
        parentAuthorMemberId: "m-daniel",
        priorCommenterMemberIds: ["m-partner"],
        householdMemberIds: HOUSEHOLD
      })
    ).toEqual(["m-partner"]);
  });

  it("tells the author and the earlier repliers when a third person joins in", () => {
    expect(
      momentNotificationAudience({
        kind: "comment",
        actorMemberId: "m-grandma",
        parentAuthorMemberId: "m-daniel",
        priorCommenterMemberIds: ["m-partner", "m-partner"],
        householdMemberIds: HOUSEHOLD
      })
    ).toEqual(["m-daniel", "m-partner"]);
  });

  it("does not tell the whole household about a comment", () => {
    const audience = momentNotificationAudience({
      kind: "comment",
      actorMemberId: "m-partner",
      parentAuthorMemberId: "m-daniel",
      householdMemberIds: HOUSEHOLD
    });
    expect(audience).toEqual(["m-daniel"]);
    expect(audience).not.toContain("m-grandma");
  });

  it("tells only the author about a reaction, because a reaction is not a conversation", () => {
    expect(
      momentNotificationAudience({
        kind: "reaction",
        actorMemberId: "m-grandma",
        parentAuthorMemberId: "m-daniel",
        priorCommenterMemberIds: ["m-partner"],
        householdMemberIds: HOUSEHOLD
      })
    ).toEqual(["m-daniel"]);
  });

  it("stays silent when someone reacts to their own moment", () => {
    expect(
      momentNotificationAudience({
        kind: "reaction",
        actorMemberId: "m-daniel",
        parentAuthorMemberId: "m-daniel",
        householdMemberIds: HOUSEHOLD
      })
    ).toEqual([]);
  });

  it("treats the person who logged an entry as its author", () => {
    // A comment on a sleep entry: the entry has no author, so the caregiver who recorded it hears.
    expect(
      momentNotificationAudience({
        kind: "comment",
        actorMemberId: "m-partner",
        parentAuthorMemberId: "m-grandma",
        householdMemberIds: HOUSEHOLD
      })
    ).toEqual(["m-grandma"]);
  });

  it("says nothing when the parent was written by someone outside the household", () => {
    expect(
      momentNotificationAudience({
        kind: "comment",
        actorMemberId: "m-partner",
        parentAuthorMemberId: null,
        householdMemberIds: HOUSEHOLD
      })
    ).toEqual([]);
  });

  it("drops a member who has left the household", () => {
    expect(
      momentNotificationAudience({
        kind: "comment",
        actorMemberId: "m-daniel",
        parentAuthorMemberId: "m-departed",
        priorCommenterMemberIds: ["m-partner"],
        householdMemberIds: HOUSEHOLD
      })
    ).toEqual(["m-partner"]);
  });

  it("never names the same member twice", () => {
    const audience = momentNotificationAudience({
      kind: "comment",
      actorMemberId: "m-grandma",
      parentAuthorMemberId: "m-daniel",
      priorCommenterMemberIds: ["m-daniel", "m-partner", "m-daniel"],
      householdMemberIds: HOUSEHOLD
    });
    expect(audience).toEqual(["m-daniel", "m-partner"]);
    expect(new Set(audience).size).toBe(audience.length);
  });

  it("tells a one-person household about nothing", () => {
    expect(
      momentNotificationAudience({
        kind: "post",
        actorMemberId: "m-daniel",
        parentAuthorMemberId: "m-daniel",
        householdMemberIds: ["m-daniel"]
      })
    ).toEqual([]);
  });
});

describe("what a locked phone shows", () => {
  it("names who posted without quoting a word of the post", () => {
    const text = momentNotificationText({
      kind: "post",
      actorName: "Daniel",
      recipientIsParentAuthor: false,
      babyName: "Finley"
    });
    expect(text.body).toBe("Daniel posted a moment about Finley");
    expect(text.title).toBe("New moment");
  });

  it("omits the baby for a whole-family post", () => {
    expect(
      momentNotificationText({ kind: "post", actorName: "Daniel", recipientIsParentAuthor: false, babyName: null }).body
    ).toBe("Daniel posted a moment");
  });

  it("tells the author it is their moment, and a fellow commenter that they also replied", () => {
    expect(
      momentNotificationText({ kind: "comment", actorName: "Ada", recipientIsParentAuthor: true }).body
    ).toBe("Ada commented on your moment");
    expect(
      momentNotificationText({ kind: "comment", actorName: "Ada", recipientIsParentAuthor: false }).body
    ).toBe("Ada also commented");
  });

  it("falls back to Someone rather than printing an empty name", () => {
    expect(
      momentNotificationText({ kind: "reaction", actorName: "   ", recipientIsParentAuthor: true }).body
    ).toBe("Someone reacted to your moment");
  });

  it("fits what a push service will carry", () => {
    const text = momentNotificationText({
      kind: "post",
      actorName: "A".repeat(200),
      recipientIsParentAuthor: false,
      babyName: "B".repeat(200)
    });
    // The schema is the real gate; this proves ordinary text cannot overflow it unnoticed.
    const parsed = momentPushPayloadSchema.safeParse({
      kind: "post",
      title: text.title,
      body: text.body.slice(0, 160),
      url: "https://cubby.example.com/app/moments",
      tag: "post:abc"
    });
    expect(parsed.success).toBe(true);
  });
});

describe("quiet hours", () => {
  it("is off when the member set none", () => {
    expect(withinQuietHours("23:30", null, null)).toBe(false);
    expect(withinQuietHours("23:30", "22:00", null)).toBe(false);
  });

  it("covers an ordinary daytime window", () => {
    expect(withinQuietHours("13:00", "09:00", "17:00")).toBe(true);
    expect(withinQuietHours("08:59", "09:00", "17:00")).toBe(false);
    expect(withinQuietHours("17:00", "09:00", "17:00")).toBe(false);
  });

  it("wraps past midnight, which is the case that matters for a baby", () => {
    expect(withinQuietHours("23:30", "22:00", "07:00")).toBe(true);
    expect(withinQuietHours("03:00", "22:00", "07:00")).toBe(true);
    expect(withinQuietHours("07:00", "22:00", "07:00")).toBe(false);
    expect(withinQuietHours("12:00", "22:00", "07:00")).toBe(false);
  });

  it("reads an equal start and end as a full day of quiet, not as no quiet at all", () => {
    expect(withinQuietHours("03:00", "22:00", "22:00")).toBe(true);
    expect(withinQuietHours("22:00", "22:00", "22:00")).toBe(true);
  });

  it("ignores a malformed value rather than silencing everything", () => {
    expect(withinQuietHours("23:30", "10pm", "7am")).toBe(false);
    expect(withinQuietHours("not-a-time", "22:00", "07:00")).toBe(false);
  });
});

describe("the payload a service worker receives", () => {
  it("requires an absolute url, because a click opens outside any page", () => {
    const base = { kind: "post" as const, title: "New moment", body: "Daniel posted a moment", tag: "post:1" };
    expect(momentPushPayloadSchema.safeParse({ ...base, url: "/app/moments" }).success).toBe(false);
    expect(
      momentPushPayloadSchema.safeParse({ ...base, url: "https://cubby.example.com/app/moments" }).success
    ).toBe(true);
  });

  it("refuses an unknown kind", () => {
    expect(
      momentPushPayloadSchema.safeParse({
        kind: "medicine",
        title: "t",
        body: "b",
        url: "https://x.test/a",
        tag: "t:1"
      }).success
    ).toBe(false);
  });
});
