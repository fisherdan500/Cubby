import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  feedPostFindFirst: vi.fn(),
  householdMemberFindFirst: vi.fn(),
  householdMemberFindMany: vi.fn(),
  preferenceFindMany: vi.fn(),
  subscriptionFindMany: vi.fn(),
  subscriptionUpdateMany: vi.fn(),
  setVapidDetails: vi.fn(),
  sendNotification: vi.fn()
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    activityLog: { findFirst: vi.fn() },
    baby: { findFirst: vi.fn() },
    feedComment: { findMany: vi.fn() },
    feedPost: { findFirst: mocks.feedPostFindFirst },
    householdMember: {
      findFirst: mocks.householdMemberFindFirst,
      findMany: mocks.householdMemberFindMany
    },
    notificationPreference: { findMany: mocks.preferenceFindMany },
    pushSubscription: {
      findMany: mocks.subscriptionFindMany,
      updateMany: mocks.subscriptionUpdateMany
    }
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
    enabled: true,
    publicKey: "B".repeat(87),
    privateKey: "A".repeat(43),
    subject: "mailto:family@example.test",
    publicUrl: "https://cubby.example.test"
  }
}));

import { momentPushPayloadSchema } from "@/domain/moment-notifications";
import { sendMomentNotification } from "@/server/services/moment-notifications";

beforeEach(() => {
  vi.restoreAllMocks();
  mocks.feedPostFindFirst.mockReset().mockResolvedValue({ id: "post-1" });
  mocks.householdMemberFindFirst.mockReset().mockResolvedValue({
    displayName: "Daniel",
    user: { name: "Daniel" }
  });
  mocks.householdMemberFindMany
    .mockReset()
    .mockResolvedValueOnce([
      { id: "actor" },
      { id: "recipient-a" },
      { id: "recipient-b" }
    ])
    .mockResolvedValueOnce([
      { id: "recipient-a", userId: "user-a" },
      { id: "recipient-b", userId: "user-b" }
    ]);
  mocks.preferenceFindMany.mockReset().mockResolvedValue([
    {
      memberId: "recipient-a",
      quietHoursStart: null,
      quietHoursEnd: null,
      babyScope: "all",
      selectedBabies: []
    },
    {
      memberId: "recipient-b",
      quietHoursStart: null,
      quietHoursEnd: null,
      babyScope: "all",
      selectedBabies: []
    }
  ]);
  mocks.subscriptionFindMany.mockReset().mockResolvedValue([
    {
      id: "subscription-a",
      endpoint: "https://push.example.test/a",
      p256dh: "key-a",
      auth: "auth-a",
      userId: "user-a"
    },
    {
      id: "subscription-b",
      endpoint: "https://push.example.test/b",
      p256dh: "key-b",
      auth: "auth-b",
      userId: "user-b"
    }
  ]);
  mocks.subscriptionUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  mocks.sendNotification.mockReset().mockRejectedValue(Object.assign(new Error("gone"), { statusCode: 410 }));
});

describe("moment notification failure isolation", () => {
  it("continues the batch and prunes a dead subscription when another payload is invalid", async () => {
    const realParse = momentPushPayloadSchema.parse.bind(momentPushPayloadSchema);
    vi.spyOn(momentPushPayloadSchema, "parse")
      .mockImplementationOnce(() => {
        throw new Error("invalid payload");
      })
      .mockImplementation((value) => realParse(value));

    await expect(sendMomentNotification({
      householdId: "household-1",
      kind: "post",
      actorMemberId: "actor",
      parentAuthorMemberId: "actor",
      postId: "post-1"
    })).resolves.toEqual({ sent: 0, pruned: 1, skipped: "" });

    expect(mocks.sendNotification).toHaveBeenCalledOnce();
    expect(mocks.subscriptionUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ["subscription-b"] }, householdId: "household-1", deletedAt: null },
      data: { deletedAt: expect.any(Date) }
    });
  });
});
