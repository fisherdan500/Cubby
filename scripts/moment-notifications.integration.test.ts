import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Who actually receives a moment notification, against a real database.
 *
 * The audience rules are unit-tested in src/domain; this exercises the parts that only a database
 * can answer - preference rows, baby scope, membership, and retiring a subscription the push
 * service says is gone. web-push itself is mocked: the point is which endpoints Cubby decides to
 * send to and what it does with the answer, not whether Apple's servers are reachable.
 */

const sent: Array<{ endpoint: string; payload: Record<string, unknown> }> = [];
const failures = new Map<string, number>();

vi.mock("web-push", () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(async (subscription: { endpoint: string }, body: string) => {
      const status = failures.get(subscription.endpoint);
      if (status) {
        const error = new Error("push failed") as Error & { statusCode: number };
        error.statusCode = status;
        throw error;
      }
      sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(body) });
      return { statusCode: 201 };
    })
  }
}));

vi.mock("@/lib/env", async () => {
  const actual = await vi.importActual<typeof import("@/lib/env")>("@/lib/env");
  return {
    ...actual,
    env: { ...actual.env, APP_TIMEZONE: "America/New_York" },
    webPushConfig: {
      enabled: true,
      publicKey: "B".repeat(87),
      privateKey: "A".repeat(43),
      subject: "mailto:family@example.test",
      publicUrl: "https://cubby.example.test"
    }
  };
});

import { PrismaClient } from "@prisma/client";

import { momentNotificationRecipients, sendMomentNotification } from "@/server/services/moment-notifications";

const prisma = new PrismaClient();

const HOUSEHOLD = "h-push";
const AUTHOR = "m-author";
const PARTNER = "m-partner";
const GRANDMA = "m-grandma";
const BABY = "b-finley";
const OTHER_BABY = "b-other";

async function reset() {
  sent.length = 0;
  failures.clear();
  await prisma.$executeRawUnsafe(`DELETE FROM "PushSubscription" WHERE "householdId" = '${HOUSEHOLD}'`);
  await prisma.$executeRawUnsafe(`DELETE FROM "NotificationPreferenceBaby" WHERE "householdId" = '${HOUSEHOLD}'`);
  await prisma.$executeRawUnsafe(`DELETE FROM "NotificationPreference" WHERE "householdId" = '${HOUSEHOLD}'`);
  await prisma.$executeRawUnsafe(`DELETE FROM "FeedComment" WHERE "householdId" = '${HOUSEHOLD}'`);
  await prisma.$executeRawUnsafe(`DELETE FROM "FeedPost" WHERE "householdId" = '${HOUSEHOLD}'`);
}

/** A member opted in to everything, with one registered phone. */
async function optIn(memberId: string, endpoint: string, overrides: Record<string, unknown> = {}) {
  await prisma.notificationPreference.create({
    data: {
      householdId: HOUSEHOLD,
      memberId,
      status: "active",
      externalDeliveryEnabled: true,
      categories: ["moments"],
      channels: ["browser_push"],
      ...overrides
    }
  });
  await prisma.pushSubscription.create({
    data: {
      householdId: HOUSEHOLD,
      userId: `u-${memberId}`,
      endpoint,
      p256dh: "p256dh-value",
      auth: "auth-value"
    }
  });
}

beforeAll(async () => {
  await prisma.$executeRawUnsafe(`DELETE FROM "Household" WHERE id = '${HOUSEHOLD}'`);
  await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE id IN ('u-${AUTHOR}','u-${PARTNER}','u-${GRANDMA}')`);
  // Users first: a household records who created it, so it cannot exist before they do.
  for (const [memberId, name] of [[AUTHOR, "Daniel"], [PARTNER, "Ada"], [GRANDMA, "Rose"]] as const) {
    await prisma.user.create({ data: { id: `u-${memberId}`, name, email: `${memberId}@example.test`, emailVerified: true } });
  }
  await prisma.household.create({ data: { id: HOUSEHOLD, name: "Push Test", createdByUserId: `u-${AUTHOR}` } });
  for (const [memberId, name] of [[AUTHOR, "Daniel"], [PARTNER, "Ada"], [GRANDMA, "Rose"]] as const) {
    await prisma.householdMember.create({
      data: { id: memberId, householdId: HOUSEHOLD, userId: `u-${memberId}`, role: memberId === AUTHOR ? "owner" : "parent", displayName: name }
    });
  }
  await prisma.baby.create({ data: { id: BABY, householdId: HOUSEHOLD, name: "Finley", birthDate: new Date("2026-03-13T00:00:00Z") } });
  await prisma.baby.create({ data: { id: OTHER_BABY, householdId: HOUSEHOLD, name: "Robin", birthDate: new Date("2026-03-13T00:00:00Z") } });
});

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DELETE FROM "Household" WHERE id = '${HOUSEHOLD}'`);
  await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE id IN ('u-${AUTHOR}','u-${PARTNER}','u-${GRANDMA}')`);
  await prisma.$disconnect();
});

beforeEach(reset);

describe("a new post", () => {
  it("reaches the opted-in household and never its author", async () => {
    await optIn(PARTNER, "https://push.test/partner");
    await optIn(GRANDMA, "https://push.test/grandma");
    await optIn(AUTHOR, "https://push.test/author");

    const result = await sendMomentNotification({
      householdId: HOUSEHOLD,
      kind: "post",
      actorMemberId: AUTHOR,
      parentAuthorMemberId: AUTHOR,
      postId: "p-1",
      babyId: BABY
    });

    expect(result.sent).toBe(2);
    const endpoints = sent.map((item) => item.endpoint).sort();
    expect(endpoints).toEqual(["https://push.test/grandma", "https://push.test/partner"]);
    expect(endpoints).not.toContain("https://push.test/author");
  });

  it("says who posted and about whom, and nothing the post contains", async () => {
    await optIn(PARTNER, "https://push.test/partner");
    await sendMomentNotification({
      householdId: HOUSEHOLD,
      kind: "post",
      actorMemberId: AUTHOR,
      parentAuthorMemberId: AUTHOR,
      postId: "p-1",
      babyId: BABY
    });
    expect(sent[0].payload.body).toBe("Daniel posted a moment about Finley");
    expect(sent[0].payload.url).toBe("https://cubby.example.test/app/moments?post=p-1");
  });

  it("stays silent for a member who never opted in", async () => {
    // A subscription alone is not consent: external delivery defaults to off.
    await prisma.pushSubscription.create({
      data: { householdId: HOUSEHOLD, userId: `u-${PARTNER}`, endpoint: "https://push.test/partner", p256dh: "k", auth: "a" }
    });
    const result = await sendMomentNotification({
      householdId: HOUSEHOLD,
      kind: "post",
      actorMemberId: AUTHOR,
      parentAuthorMemberId: AUTHOR,
      postId: "p-1"
    });
    expect(result.sent).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("stays silent for a member who turned external delivery off", async () => {
    await optIn(PARTNER, "https://push.test/partner", { externalDeliveryEnabled: false });
    const result = await sendMomentNotification({
      householdId: HOUSEHOLD,
      kind: "post",
      actorMemberId: AUTHOR,
      parentAuthorMemberId: AUTHOR,
      postId: "p-1"
    });
    expect(result.sent).toBe(0);
  });
});

describe("a comment", () => {
  it("reaches the author and everyone who already replied, never the whole household", async () => {
    await optIn(AUTHOR, "https://push.test/author");
    await optIn(PARTNER, "https://push.test/partner");
    await optIn(GRANDMA, "https://push.test/grandma");
    await prisma.feedPost.create({ data: { id: "p-1", householdId: HOUSEHOLD, authorMemberId: AUTHOR, body: "hello", tags: [] } });
    await prisma.feedComment.create({ data: { householdId: HOUSEHOLD, postId: "p-1", authorMemberId: PARTNER, body: "lovely" } });

    // Grandma comments: the author and the earlier replier hear, and grandma does not hear herself.
    const result = await sendMomentNotification({
      householdId: HOUSEHOLD,
      kind: "comment",
      actorMemberId: GRANDMA,
      parentAuthorMemberId: AUTHOR,
      postId: "p-1"
    });

    expect(result.sent).toBe(2);
    expect(sent.map((item) => item.endpoint).sort()).toEqual([
      "https://push.test/author",
      "https://push.test/partner"
    ]);
  });

  it("reaches the earlier replier when the author replies to them", async () => {
    // The case a plain "notify the author" rule drops on the floor.
    await optIn(AUTHOR, "https://push.test/author");
    await optIn(PARTNER, "https://push.test/partner");
    await prisma.feedPost.create({ data: { id: "p-2", householdId: HOUSEHOLD, authorMemberId: AUTHOR, body: "hi", tags: [] } });
    await prisma.feedComment.create({ data: { householdId: HOUSEHOLD, postId: "p-2", authorMemberId: PARTNER, body: "nice" } });

    const result = await sendMomentNotification({
      householdId: HOUSEHOLD,
      kind: "comment",
      actorMemberId: AUTHOR,
      parentAuthorMemberId: AUTHOR,
      postId: "p-2"
    });

    expect(result.sent).toBe(1);
    expect(sent[0].endpoint).toBe("https://push.test/partner");
    expect(sent[0].payload.body).toBe("Daniel also commented");
  });

  it("ignores a removed comment when working out who is in the conversation", async () => {
    await optIn(AUTHOR, "https://push.test/author");
    await optIn(PARTNER, "https://push.test/partner");
    await prisma.feedPost.create({ data: { id: "p-3", householdId: HOUSEHOLD, authorMemberId: AUTHOR, body: "hi", tags: [] } });
    await prisma.feedComment.create({
      data: { householdId: HOUSEHOLD, postId: "p-3", authorMemberId: PARTNER, body: "gone", deletedAt: new Date() }
    });

    const recipients = await momentNotificationRecipients({
      householdId: HOUSEHOLD,
      kind: "comment",
      actorMemberId: GRANDMA,
      parentAuthorMemberId: AUTHOR,
      postId: "p-3"
    });
    expect(recipients).toEqual([AUTHOR]);
  });
});

describe("a reaction", () => {
  it("reaches only the author", async () => {
    await optIn(AUTHOR, "https://push.test/author");
    await optIn(PARTNER, "https://push.test/partner");
    await optIn(GRANDMA, "https://push.test/grandma");

    const result = await sendMomentNotification({
      householdId: HOUSEHOLD,
      kind: "reaction",
      actorMemberId: GRANDMA,
      parentAuthorMemberId: AUTHOR,
      postId: "p-1"
    });

    expect(result.sent).toBe(1);
    expect(sent[0].endpoint).toBe("https://push.test/author");
    expect(sent[0].payload.body).toBe("Rose reacted to your moment");
  });

  it("stays silent when the author reacts to their own moment", async () => {
    await optIn(AUTHOR, "https://push.test/author");
    const result = await sendMomentNotification({
      householdId: HOUSEHOLD,
      kind: "reaction",
      actorMemberId: AUTHOR,
      parentAuthorMemberId: AUTHOR,
      postId: "p-1"
    });
    expect(result.sent).toBe(0);
    expect(result.skipped).toBe("no_recipients");
  });
});

describe("a member's own choices", () => {
  it("respects a member watching only one baby", async () => {
    await optIn(PARTNER, "https://push.test/partner", { babyScope: "selected" });
    await prisma.notificationPreferenceBaby.create({
      data: {
        householdId: HOUSEHOLD,
        preferenceId: (await prisma.notificationPreference.findFirstOrThrow({ where: { householdId: HOUSEHOLD, memberId: PARTNER } })).id,
        babyId: OTHER_BABY
      }
    });

    const aboutFinley = await momentNotificationRecipients({
      householdId: HOUSEHOLD,
      kind: "post",
      actorMemberId: AUTHOR,
      parentAuthorMemberId: AUTHOR,
      babyId: BABY
    });
    expect(aboutFinley).not.toContain(PARTNER);

    const aboutRobin = await momentNotificationRecipients({
      householdId: HOUSEHOLD,
      kind: "post",
      actorMemberId: AUTHOR,
      parentAuthorMemberId: AUTHOR,
      babyId: OTHER_BABY
    });
    expect(aboutRobin).toContain(PARTNER);
  });

  it("sends a whole-family post to a member watching one baby", async () => {
    await optIn(PARTNER, "https://push.test/partner", { babyScope: "selected" });
    const recipients = await momentNotificationRecipients({
      householdId: HOUSEHOLD,
      kind: "post",
      actorMemberId: AUTHOR,
      parentAuthorMemberId: AUTHOR
    });
    expect(recipients).toContain(PARTNER);
  });

  it("skips a member whose chosen categories do not include moments", async () => {
    await optIn(PARTNER, "https://push.test/partner", { categories: ["timer_overdue"] });
    const recipients = await momentNotificationRecipients({
      householdId: HOUSEHOLD,
      kind: "post",
      actorMemberId: AUTHOR,
      parentAuthorMemberId: AUTHOR
    });
    expect(recipients).toEqual([]);
  });

  it("sends nothing to a member who chose NO categories", async () => {
    // An empty list is not consent. Membership of a category is a positive test here, the way
    // activities.ts reads the same column - anything else silently opts a member into a lock-screen
    // notification they never asked for.
    await optIn(PARTNER, "https://push.test/partner", { categories: [] });
    const recipients = await momentNotificationRecipients({
      householdId: HOUSEHOLD,
      kind: "post",
      actorMemberId: AUTHOR,
      parentAuthorMemberId: AUTHOR
    });
    expect(recipients).toEqual([]);
  });

  it("includes a member who chose moments explicitly", async () => {
    await optIn(PARTNER, "https://push.test/partner", { categories: ["moments"] });
    const recipients = await momentNotificationRecipients({
      householdId: HOUSEHOLD,
      kind: "post",
      actorMemberId: AUTHOR,
      parentAuthorMemberId: AUTHOR
    });
    expect(recipients).toEqual([PARTNER]);
  });

  it("skips a preference awaiting re-confirmation", async () => {
    // needsReview is the app's way of saying do not act on this preference yet, typically after a
    // restore. Acting on it anyway would notify someone on the strength of a stale choice.
    await optIn(PARTNER, "https://push.test/partner", { status: "needsReview" });
    const recipients = await momentNotificationRecipients({
      householdId: HOUSEHOLD,
      kind: "post",
      actorMemberId: AUTHOR,
      parentAuthorMemberId: AUTHOR
    });
    expect(recipients).toEqual([]);
  });

  it("skips a member who did not choose the browser push channel", async () => {
    await optIn(PARTNER, "https://push.test/partner", { channels: [] });
    const recipients = await momentNotificationRecipients({
      householdId: HOUSEHOLD,
      kind: "post",
      actorMemberId: AUTHOR,
      parentAuthorMemberId: AUTHOR
    });
    expect(recipients).toEqual([]);
  });

  it("resolves the post's author itself when the caller does not supply one", async () => {
    // The call sites deliberately omit parentAuthorMemberId so the lookup happens inside the send,
    // off the request path: a failure there must never report a saved comment as a failure.
    await optIn(AUTHOR, "https://push.test/author");
    await prisma.feedPost.create({ data: { id: "p-self", householdId: HOUSEHOLD, authorMemberId: AUTHOR, body: "hi", tags: [] } });
    const result = await sendMomentNotification({
      householdId: HOUSEHOLD,
      kind: "reaction",
      actorMemberId: PARTNER,
      postId: "p-self"
    });
    expect(result.sent).toBe(1);
    expect(sent[0].endpoint).toBe("https://push.test/author");
  });

  it("skips a suspended member", async () => {
    await optIn(PARTNER, "https://push.test/partner");
    await prisma.householdMember.update({ where: { id: PARTNER }, data: { disabledAt: new Date() } });
    try {
      const recipients = await momentNotificationRecipients({
        householdId: HOUSEHOLD,
        kind: "post",
        actorMemberId: AUTHOR,
        parentAuthorMemberId: AUTHOR
      });
      expect(recipients).not.toContain(PARTNER);
    } finally {
      await prisma.householdMember.update({ where: { id: PARTNER }, data: { disabledAt: null } });
    }
  });
});

describe("a phone that is gone", () => {
  it("retires a subscription the push service says no longer exists", async () => {
    await optIn(PARTNER, "https://push.test/partner");
    await optIn(GRANDMA, "https://push.test/grandma");
    failures.set("https://push.test/partner", 410);

    const result = await sendMomentNotification({
      householdId: HOUSEHOLD,
      kind: "post",
      actorMemberId: AUTHOR,
      parentAuthorMemberId: AUTHOR,
      postId: "p-1"
    });

    expect(result.sent).toBe(1);
    expect(result.pruned).toBe(1);
    const retired = await prisma.pushSubscription.findFirst({ where: { endpoint: "https://push.test/partner" } });
    expect(retired?.deletedAt).not.toBeNull();
    // The one that worked is untouched.
    const kept = await prisma.pushSubscription.findFirst({ where: { endpoint: "https://push.test/grandma" } });
    expect(kept?.deletedAt).toBeNull();
  });

  it("keeps a subscription that failed for a reason that may pass", async () => {
    // A 500 or a timeout is the push service having a bad day, not a phone that is gone.
    await optIn(PARTNER, "https://push.test/partner");
    failures.set("https://push.test/partner", 500);

    const result = await sendMomentNotification({
      householdId: HOUSEHOLD,
      kind: "post",
      actorMemberId: AUTHOR,
      parentAuthorMemberId: AUTHOR,
      postId: "p-1"
    });

    expect(result.sent).toBe(0);
    expect(result.pruned).toBe(0);
    const kept = await prisma.pushSubscription.findFirst({ where: { endpoint: "https://push.test/partner" } });
    expect(kept?.deletedAt).toBeNull();
  });

  it("never sends to an already retired subscription", async () => {
    await optIn(PARTNER, "https://push.test/partner");
    await prisma.pushSubscription.updateMany({
      where: { endpoint: "https://push.test/partner" },
      data: { deletedAt: new Date() }
    });
    const result = await sendMomentNotification({
      householdId: HOUSEHOLD,
      kind: "post",
      actorMemberId: AUTHOR,
      parentAuthorMemberId: AUTHOR,
      postId: "p-1"
    });
    expect(result.sent).toBe(0);
    expect(result.skipped).toBe("no_subscriptions");
  });
});
