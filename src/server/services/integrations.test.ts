import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getHouseholdContext: vi.fn(),
  requirePermission: vi.fn(),
  writeAudit: vi.fn(),
  transaction: vi.fn(),
  memberLock: vi.fn(),
  txMemberFindUnique: vi.fn(),
  apiKeyCreate: vi.fn(),
  apiKeyFindFirst: vi.fn(),
  apiKeyUpdate: vi.fn(),
  txApiKeyCreate: vi.fn(),
  txApiKeyFindFirst: vi.fn(),
  txApiKeyUpdate: vi.fn(),
  txBabyFindFirst: vi.fn(),
  webhookCreate: vi.fn(),
  webhookFindFirst: vi.fn(),
  webhookUpdate: vi.fn(),
  txWebhookCreate: vi.fn(),
  txWebhookFindFirst: vi.fn(),
  txWebhookUpdate: vi.fn(),
  txWebhookDeliveryUpdateMany: vi.fn(),
  pushSubscriptionUpsert: vi.fn(),
  txPushSubscriptionUpsert: vi.fn(),
  notificationPreferenceCreate: vi.fn(),
  txNotificationPreferenceCreate: vi.fn(),
  requireUser: vi.fn()
}));

vi.mock("@/server/auth/context", () => ({
  getHouseholdContext: mocks.getHouseholdContext,
  requirePermission: mocks.requirePermission
}));
vi.mock("@/server/services/audit", () => ({ writeAudit: mocks.writeAudit }));
vi.mock("@/server/auth/session", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    apiKey: { create: mocks.apiKeyCreate, findFirst: mocks.apiKeyFindFirst, update: mocks.apiKeyUpdate },
    webhookEndpoint: { create: mocks.webhookCreate, findFirst: mocks.webhookFindFirst, update: mocks.webhookUpdate },
    pushSubscription: { upsert: mocks.pushSubscriptionUpsert },
    notificationPreference: { create: mocks.notificationPreferenceCreate },
    $transaction: mocks.transaction
  }
}));

import { createApiKey, createWebhook, deleteWebhook, revokeApiKey, saveNotificationPreference, savePushSubscription } from "@/server/services/integrations";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getHouseholdContext.mockResolvedValue({ userId: "owner-user", householdId: "household-1", memberId: "owner-member", role: "owner" });
  mocks.memberLock.mockResolvedValue([{ id: "owner-member" }]);
  mocks.txMemberFindUnique.mockResolvedValue({ id: "owner-member", userId: "owner-user", householdId: "household-1", role: "owner", disabledAt: null, deletedAt: null });
  const key = { id: "key-1", name: "Rehearsal", prefix: "cubby_test", scopes: ["read"] };
  const endpoint = { id: "webhook-1", name: "Rehearsal", url: "https://example.test/hook", events: ["activity_created"] };
  const preference = { id: "preference-1", householdId: "household-1", userId: "owner-user", babyId: "baby-1" };
  mocks.apiKeyCreate.mockResolvedValue(key); mocks.txApiKeyCreate.mockResolvedValue(key);
  mocks.apiKeyFindFirst.mockResolvedValue(key); mocks.txApiKeyFindFirst.mockResolvedValue(key);
  mocks.apiKeyUpdate.mockResolvedValue(key); mocks.txApiKeyUpdate.mockResolvedValue(key);
  mocks.webhookCreate.mockResolvedValue(endpoint); mocks.txWebhookCreate.mockResolvedValue(endpoint);
  mocks.webhookFindFirst.mockResolvedValue(endpoint); mocks.txWebhookFindFirst.mockResolvedValue(endpoint);
  mocks.webhookUpdate.mockResolvedValue(endpoint); mocks.txWebhookUpdate.mockResolvedValue(endpoint);
  mocks.requireUser.mockResolvedValue({ id: "owner-user" });
  mocks.pushSubscriptionUpsert.mockResolvedValue({ id: "subscription-1" });
  mocks.txPushSubscriptionUpsert.mockResolvedValue({ id: "subscription-1" });
  mocks.notificationPreferenceCreate.mockResolvedValue(preference);
  mocks.txNotificationPreferenceCreate.mockResolvedValue(preference);
  mocks.transaction.mockImplementation(async (callback) => callback({
    $queryRaw: mocks.memberLock,
    householdMember: { findUnique: mocks.txMemberFindUnique },
    apiKey: { create: mocks.txApiKeyCreate, findFirst: mocks.txApiKeyFindFirst, update: mocks.txApiKeyUpdate },
    baby: { findFirst: mocks.txBabyFindFirst },
    webhookEndpoint: { create: mocks.txWebhookCreate, findFirst: mocks.txWebhookFindFirst, update: mocks.txWebhookUpdate },
    webhookDelivery: { updateMany: mocks.txWebhookDeliveryUpdateMany },
    pushSubscription: { upsert: mocks.txPushSubscriptionUpsert },
    notificationPreference: { create: mocks.txNotificationPreferenceCreate },
    auditEvent: { create: vi.fn() }
  }));
});

describe("capability mutation serialization", () => {
  it("binds each newly issued API key to the current membership episode", async () => {
    mocks.txMemberFindUnique.mockResolvedValue({
      id: "owner-member", userId: "owner-user", householdId: "household-1", role: "owner", disabledAt: null, deletedAt: null
    });

    await createApiKey({ name: "Episode-bound key" });

    expect(mocks.txApiKeyCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        householdId: "household-1",
        delegatedByMemberId: "owner-member",
        legacyUnattributed: false
      })
    });
  });

  it("binds each newly created webhook to the current membership episode", async () => {
    mocks.txMemberFindUnique.mockResolvedValue({
      id: "owner-member", userId: "owner-user", householdId: "household-1", role: "owner", disabledAt: null, deletedAt: null
    });

    await createWebhook({ name: "Episode-bound endpoint", url: "https://example.test/hook", events: ["activity_created"] });

    expect(mocks.txWebhookCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        householdId: "household-1",
        delegatedByMemberId: "owner-member",
        legacyUnattributed: false
      })
    });
  });

  it("rejects API-key issuance for a baby outside the locked household", async () => {
    mocks.txMemberFindUnique.mockResolvedValue({
      id: "owner-member", userId: "owner-user", householdId: "household-1", role: "owner", disabledAt: null, deletedAt: null
    });
    mocks.txBabyFindFirst.mockResolvedValue(null);
    await expect(createApiKey({ name: "Foreign scope", babyId: "baby-foreign" })).rejects.toThrow("not_found");
    expect(mocks.txApiKeyCreate).not.toHaveBeenCalled();
  });

  it("locks the webhook target before deletion", async () => {
    mocks.txMemberFindUnique.mockResolvedValue({
      id: "owner-member", userId: "owner-user", householdId: "household-1", role: "owner", disabledAt: null, deletedAt: null
    });
    await deleteWebhook("webhook-1");
    expect(mocks.memberLock).toHaveBeenCalledTimes(2);
    expect(mocks.txWebhookDeliveryUpdateMany).toHaveBeenCalledWith({
      where: { endpointId: "webhook-1", status: "pending" },
      data: { status: "failed", lastError: "endpoint_deleted", nextAttemptAt: null }
    });
    expect(mocks.txWebhookUpdate).toHaveBeenCalledOnce();
  });

  it("locks the API-key target before revocation", async () => {
    mocks.txMemberFindUnique.mockResolvedValue({
      id: "owner-member", userId: "owner-user", householdId: "household-1", role: "owner", disabledAt: null, deletedAt: null
    });
    await revokeApiKey("key-1");
    expect(mocks.memberLock).toHaveBeenCalledTimes(2);
    expect(mocks.txApiKeyUpdate).toHaveBeenCalledOnce();
  });

  it.each([
    ["API-key issuance", () => createApiKey({ name: "Rehearsal" })],
    ["API-key revocation", () => revokeApiKey("key-1")],
    ["webhook creation", () => createWebhook({ name: "Rehearsal", url: "https://example.test/hook", events: ["activity_created"] })],
    ["webhook deletion", () => deleteWebhook("webhook-1")]
  ])("rejects %s when the actor was suspended after request-context capture", async (_name, mutate) => {
    mocks.txMemberFindUnique.mockResolvedValue({
      id: "owner-member", userId: "owner-user", householdId: "household-1", role: "owner", disabledAt: new Date(), deletedAt: null
    });
    await expect(mutate()).rejects.toThrow("forbidden");
    expect(mocks.apiKeyCreate).not.toHaveBeenCalled();
    expect(mocks.apiKeyUpdate).not.toHaveBeenCalled();
    expect(mocks.webhookCreate).not.toHaveBeenCalled();
    expect(mocks.webhookUpdate).not.toHaveBeenCalled();
  });
});

describe("notification preference creation", () => {
  it("does not recreate notification authority after the member is closed", async () => {
    mocks.txMemberFindUnique.mockResolvedValue({
      id: "owner-member", userId: "owner-user", householdId: "household-1", role: "owner", disabledAt: null, deletedAt: new Date()
    });

    await expect(savePushSubscription({
      endpoint: "https://example.test/push",
      keys: { p256dh: "p256dh", auth: "auth" }
    })).rejects.toThrow("forbidden");
    await expect(saveNotificationPreference({ activityCreated: true })).rejects.toThrow("forbidden");

    expect(mocks.txPushSubscriptionUpsert).not.toHaveBeenCalled();
    expect(mocks.txNotificationPreferenceCreate).not.toHaveBeenCalled();
  });

  it("writes the current household with an explicitly scoped Baby preference", async () => {
    await saveNotificationPreference({
      babyId: "baby-1",
      timerOverdue: false,
      activityCreated: true,
      reminders: false,
      quietHoursStart: "22:00",
      quietHoursEnd: "07:00"
    });

    expect(mocks.txNotificationPreferenceCreate).toHaveBeenCalledWith({
      data: {
        householdId: "household-1",
        userId: "owner-user",
        babyId: "baby-1",
        timerOverdue: false,
        activityCreated: true,
        reminders: false,
        quietHoursStart: "22:00",
        quietHoursEnd: "07:00"
      }
    });
  });

  it("preserves the optional Baby scope for a household-wide preference", async () => {
    await saveNotificationPreference({});

    expect(mocks.txNotificationPreferenceCreate).toHaveBeenCalledWith({
      data: {
        householdId: "household-1",
        userId: "owner-user",
        babyId: undefined,
        timerOverdue: true,
        activityCreated: false,
        reminders: true,
        quietHoursStart: undefined,
        quietHoursEnd: undefined
      }
    });
  });
});
