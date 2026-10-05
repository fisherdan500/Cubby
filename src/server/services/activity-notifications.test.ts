import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  activityFindFirst: vi.fn(),
  logFindMany: vi.fn(),
  logUpdateMany: vi.fn(),
  preferenceFindMany: vi.fn(),
  subscriptionFindMany: vi.fn(),
  subscriptionUpdateMany: vi.fn(),
  setVapidDetails: vi.fn(),
  sendNotification: vi.fn(),
  pushEnabled: true
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    activityLog: { findFirst: mocks.activityFindFirst },
    notificationLog: { findMany: mocks.logFindMany, updateMany: mocks.logUpdateMany },
    notificationPreference: { findMany: mocks.preferenceFindMany },
    pushSubscription: { findMany: mocks.subscriptionFindMany, updateMany: mocks.subscriptionUpdateMany }
  }
}));

vi.mock("web-push", () => ({
  default: {
    setVapidDetails: mocks.setVapidDetails,
    sendNotification: mocks.sendNotification
  }
}));

vi.mock("@/lib/env", () => ({
  env: { APP_TIMEZONE: "America/New_York" },
  webPushConfig: {
    get enabled() { return mocks.pushEnabled; },
    publicKey: "B".repeat(87),
    privateKey: "A".repeat(43),
    subject: "mailto:family@example.test",
    publicUrl: "https://cubby.example.test"
  }
}));

vi.mock("@/lib/timezone", () => ({
  displayFormatter: vi.fn(() => ({ format: () => "12:00" }))
}));

import {
  queueActivityNotificationFromBrowserOperationResult,
  sendActivityNotification
} from "@/server/services/activity-notifications";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pushEnabled = true;
  mocks.activityFindFirst.mockResolvedValue({
    id: "activity-1",
    babyId: "baby-1",
    type: "feeding",
    actorMember: { displayName: "Daniel", user: { name: "Dan" } },
    baby: { name: "Finley" }
  });
  mocks.logFindMany.mockResolvedValue([{ id: "log-1", userId: "recipient-user" }]);
  mocks.preferenceFindMany.mockResolvedValue([
    {
      member: { userId: "recipient-user" },
      quietHoursStart: null,
      quietHoursEnd: null
    }
  ]);
  mocks.subscriptionFindMany.mockResolvedValue([
    {
      id: "subscription-1",
      userId: "recipient-user",
      endpoint: "https://push.example.test/recipient",
      p256dh: "public-key",
      auth: "auth-key"
    }
  ]);
  mocks.sendNotification.mockResolvedValue({ statusCode: 201 });
  mocks.subscriptionUpdateMany.mockResolvedValue({ count: 0 });
  mocks.logUpdateMany.mockResolvedValue({ count: 1 });
});

describe("activity-created browser push", () => {
  it("delivers each pending opted-in activity log with content-free text", async () => {
    const result = await sendActivityNotification({ householdId: "household-1", activityId: "activity-1" });

    expect(result).toEqual({ sent: 1, pruned: 0, skipped: "" });
    expect(mocks.preferenceFindMany).toHaveBeenCalledWith({
      where: {
        householdId: "household-1",
        status: "active",
        externalDeliveryEnabled: true,
        categories: { has: "activity_created" },
        channels: { has: "browser_push" },
        OR: [
          { babyScope: "all" },
          { babyScope: "selected", selectedBabies: { some: { babyId: "baby-1" } } }
        ],
        member: {
          is: {
            householdId: "household-1",
            userId: { in: ["recipient-user"] },
            disabledAt: null,
            deletedAt: null
          }
        }
      },
      select: {
        quietHoursStart: true,
        quietHoursEnd: true,
        member: { select: { userId: true } }
      }
    });
    expect(mocks.sendNotification).toHaveBeenCalledOnce();
    expect(mocks.sendNotification).toHaveBeenCalledWith(
      {
        endpoint: "https://push.example.test/recipient",
        keys: { p256dh: "public-key", auth: "auth-key" }
      },
      JSON.stringify({
        kind: "activity_created",
        title: "New activity",
        body: "Daniel logged feeding for Finley",
        url: "https://cubby.example.test/app/activities/activity-1",
        tag: "activity:activity-1"
      })
    );
    expect(mocks.logUpdateMany).toHaveBeenCalledTimes(2);
    expect(mocks.logUpdateMany).toHaveBeenLastCalledWith({
      where: {
        id: { in: ["log-1"] },
        householdId: "household-1",
        activityId: "activity-1",
        status: "failed",
        error: expect.stringMatching(/^delivery_claimed:/)
      },
      data: { status: "delivered", sentAt: expect.any(Date), error: null }
    });
  });

  it("stays silent during the recipient's quiet hours", async () => {
    mocks.preferenceFindMany.mockResolvedValue([
      {
        member: { userId: "recipient-user" },
        quietHoursStart: "00:00",
        quietHoursEnd: "23:59"
      }
    ]);

    const result = await sendActivityNotification({ householdId: "household-1", activityId: "activity-1" });

    expect(result).toEqual({ sent: 0, pruned: 0, skipped: "no_recipients" });
    expect(mocks.sendNotification).not.toHaveBeenCalled();
    expect(mocks.logUpdateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: { status: "failed", sentAt: null, error: "quiet_hours" }
    }));
  });

  it("retires only a subscription the push service reports as gone", async () => {
    const gone = Object.assign(new Error("gone"), { statusCode: 410 });
    mocks.sendNotification.mockRejectedValue(gone);
    mocks.subscriptionUpdateMany.mockResolvedValue({ count: 1 });

    const result = await sendActivityNotification({ householdId: "household-1", activityId: "activity-1" });

    expect(result).toEqual({ sent: 0, pruned: 1, skipped: "" });
    expect(mocks.subscriptionUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ["subscription-1"] }, householdId: "household-1", deletedAt: null },
      data: { deletedAt: expect.any(Date) }
    });
    expect(mocks.logUpdateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: { status: "failed", sentAt: null, error: "push_failed" }
    }));
  });

  it("keeps a subscription after a transient push failure", async () => {
    const transient = Object.assign(new Error("temporary"), { statusCode: 500 });
    mocks.sendNotification.mockRejectedValue(transient);

    const result = await sendActivityNotification({ householdId: "household-1", activityId: "activity-1" });

    expect(result).toEqual({ sent: 0, pruned: 0, skipped: "" });
    expect(mocks.subscriptionUpdateMany).not.toHaveBeenCalled();
    expect(mocks.logUpdateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: { status: "failed", sentAt: null, error: "push_failed" }
    }));
  });

  it("allows only one concurrent dispatcher to claim and send a pending log", async () => {
    let pending = true;
    mocks.logUpdateMany.mockImplementation(async ({ where, data }) => {
      if (where.status === "pending" && data.status === "failed") {
        if (!pending) return { count: 0 };
        pending = false;
        return { count: 1 };
      }
      return { count: 1 };
    });

    const results = await Promise.all([
      sendActivityNotification({ householdId: "household-1", activityId: "activity-1" }),
      sendActivityNotification({ householdId: "household-1", activityId: "activity-1" })
    ]);

    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.sent).sort()).toEqual([0, 1]);
  });

  it("recovers a pending post-commit log from terminal reconciliation and makes later replays no-ops", async () => {
    let pending = true;
    let claimCalls = 0;
    mocks.logUpdateMany.mockImplementation(async ({ where, data }) => {
      if (where.status === "pending" && data.status === "failed") {
        claimCalls += 1;
        if (!pending) return { count: 0 };
        pending = false;
        return { count: 1 };
      }
      return { count: 1 };
    });
    const result = {
      status: "completed",
      operationId: "bmo_0123456789abcdefghjkmnpqrs",
      outcome: { kind: "activity", code: "ok", activityId: "activity-1", action: "create" }
    } as const;

    queueActivityNotificationFromBrowserOperationResult({ householdId: "household-1", result });
    await vi.waitFor(() => expect(mocks.sendNotification).toHaveBeenCalledTimes(1));

    queueActivityNotificationFromBrowserOperationResult({ householdId: "household-1", result });
    await vi.waitFor(() => expect(claimCalls).toBe(2));
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
  });

  it("marks a claimed log failed when push is not configured", async () => {
    mocks.pushEnabled = false;

    const result = await sendActivityNotification({ householdId: "household-1", activityId: "activity-1" });

    expect(result.skipped).toBe("push_disabled");
    expect(mocks.sendNotification).not.toHaveBeenCalled();
    expect(mocks.logUpdateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: { status: "failed", sentAt: null, error: "push_disabled" }
    }));
  });

  it("marks a claimed log failed when the activity was removed before delivery", async () => {
    mocks.activityFindFirst.mockResolvedValue(null);

    const result = await sendActivityNotification({ householdId: "household-1", activityId: "activity-1" });

    expect(result.skipped).toBe("activity_gone");
    expect(mocks.sendNotification).not.toHaveBeenCalled();
    expect(mocks.logUpdateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: { status: "failed", sentAt: null, error: "activity_gone" }
    }));
  });

  it("marks a claimed log failed when current consent no longer permits delivery", async () => {
    mocks.preferenceFindMany.mockResolvedValue([]);

    const result = await sendActivityNotification({ householdId: "household-1", activityId: "activity-1" });

    expect(result.skipped).toBe("no_recipients");
    expect(mocks.sendNotification).not.toHaveBeenCalled();
    expect(mocks.logUpdateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: { status: "failed", sentAt: null, error: "not_eligible" }
    }));
  });

  it("marks a claimed log failed when the opted-in member has no live subscription", async () => {
    mocks.subscriptionFindMany.mockResolvedValue([]);

    const result = await sendActivityNotification({ householdId: "household-1", activityId: "activity-1" });

    expect(result.skipped).toBe("no_subscriptions");
    expect(mocks.sendNotification).not.toHaveBeenCalled();
    expect(mocks.logUpdateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: { status: "failed", sentAt: null, error: "no_subscription" }
    }));
  });
});
