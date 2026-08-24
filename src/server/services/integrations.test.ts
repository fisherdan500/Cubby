import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getEffectiveHouseholdContext: vi.fn(),
  requirePermission: vi.fn(),
  writeAudit: vi.fn(),
  transaction: vi.fn(),
  memberLock: vi.fn(),
  txMemberFindUnique: vi.fn(),
  apiKeyCreate: vi.fn(),
  apiKeyFindMany: vi.fn(),
  apiKeyFindFirst: vi.fn(),
  apiKeyUpdate: vi.fn(),
  txApiKeyCreate: vi.fn(),
  txApiKeyFindMany: vi.fn(),
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
  requireUser: vi.fn(),
  requireFreshSession: vi.fn()
}));

vi.mock("@/server/auth/context", () => ({
  getEffectiveHouseholdContext: mocks.getEffectiveHouseholdContext,
  requirePermission: mocks.requirePermission
}));
vi.mock("@/server/services/audit", () => ({ writeAudit: mocks.writeAudit }));
vi.mock("@/server/auth/session", () => ({ requireUser: mocks.requireUser, requireFreshSession: mocks.requireFreshSession }));
vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    apiKey: { create: mocks.apiKeyCreate, findMany: mocks.apiKeyFindMany, findFirst: mocks.apiKeyFindFirst, update: mocks.apiKeyUpdate },
    webhookEndpoint: { create: mocks.webhookCreate, findFirst: mocks.webhookFindFirst, update: mocks.webhookUpdate },
    pushSubscription: { upsert: mocks.pushSubscriptionUpsert },
    notificationPreference: { create: mocks.notificationPreferenceCreate },
    $transaction: mocks.transaction
  }
}));

import { createApiKey, createWebhook, deleteWebhook, listApiKeys, savePushSubscription } from "@/server/services/integrations";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getEffectiveHouseholdContext.mockResolvedValue({ userId: "owner-user", householdId: "household-1", memberId: "owner-member", role: "owner" });
  mocks.memberLock.mockResolvedValue([{ id: "owner-member" }]);
  mocks.txMemberFindUnique.mockResolvedValue({ id: "owner-member", userId: "owner-user", householdId: "household-1", role: "owner", disabledAt: null, deletedAt: null });
  const key = { id: "key-1", name: "Rehearsal", prefix: "cubby_test", scopes: ["read"] };
  const endpoint = { id: "webhook-1", name: "Rehearsal", url: "https://example.test/hook", events: ["activity_created"] };
  const preference = { id: "preference-1", householdId: "household-1", userId: "owner-user", babyId: "baby-1" };
  mocks.apiKeyCreate.mockResolvedValue(key); mocks.txApiKeyCreate.mockResolvedValue(key);
  mocks.apiKeyFindMany.mockResolvedValue([key]); mocks.txApiKeyFindMany.mockResolvedValue([key]);
  mocks.apiKeyFindFirst.mockResolvedValue(key); mocks.txApiKeyFindFirst.mockResolvedValue(key);
  mocks.apiKeyUpdate.mockResolvedValue(key); mocks.txApiKeyUpdate.mockResolvedValue(key);
  mocks.webhookCreate.mockResolvedValue(endpoint); mocks.txWebhookCreate.mockResolvedValue(endpoint);
  mocks.webhookFindFirst.mockResolvedValue(endpoint); mocks.txWebhookFindFirst.mockResolvedValue(endpoint);
  mocks.webhookUpdate.mockResolvedValue(endpoint); mocks.txWebhookUpdate.mockResolvedValue(endpoint);
  mocks.requireUser.mockResolvedValue({ id: "owner-user" });
  mocks.requireFreshSession.mockResolvedValue({ user: { id: "owner-user" }, session: { id: "session-1" } });
  mocks.pushSubscriptionUpsert.mockResolvedValue({ id: "subscription-1" });
  mocks.txPushSubscriptionUpsert.mockResolvedValue({ id: "subscription-1" });
  mocks.notificationPreferenceCreate.mockResolvedValue(preference);
  mocks.txNotificationPreferenceCreate.mockResolvedValue(preference);
  mocks.transaction.mockImplementation(async (callback) => callback({
    $queryRaw: mocks.memberLock,
    householdMember: { findUnique: mocks.txMemberFindUnique },
    apiKey: { create: mocks.txApiKeyCreate, findMany: mocks.txApiKeyFindMany, findFirst: mocks.txApiKeyFindFirst, update: mocks.txApiKeyUpdate },
    baby: { findFirst: mocks.txBabyFindFirst },
    webhookEndpoint: { create: mocks.txWebhookCreate, findFirst: mocks.txWebhookFindFirst, update: mocks.txWebhookUpdate },
    webhookDelivery: { updateMany: mocks.txWebhookDeliveryUpdateMany },
    pushSubscription: { upsert: mocks.txPushSubscriptionUpsert },
    notificationPreference: { create: mocks.txNotificationPreferenceCreate },
    auditEvent: { create: vi.fn() }
  }));
});

describe("capability mutation serialization", () => {
  it("fails closed instead of issuing a one-time API-key secret under the partial credential contract", async () => {
    await expect(createApiKey({ name: "Episode-bound key" })).rejects.toThrow("api_key_issuance_unavailable");
    expect(mocks.txApiKeyCreate).not.toHaveBeenCalled();
  });

  it("reads API-key inventory only after fresh-owner reauthorization under locks", async () => {
    mocks.memberLock.mockResolvedValue([{ userId: "owner-user", createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000) }]);
    await expect(listApiKeys()).resolves.toHaveLength(1);
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.txApiKeyFindMany).toHaveBeenCalledOnce();
    expect(mocks.apiKeyFindMany).not.toHaveBeenCalled();
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

  it("records a content-free audit event in the subscription write transaction", async () => {
    await expect(savePushSubscription({
      endpoint: "https://push.example.test/subscription",
      keys: { p256dh: "public-key", auth: "auth-key" }
    })).resolves.toEqual({ id: "subscription-1" });

    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ householdId: "household-1", memberId: "owner-member" }),
      expect.objectContaining({ action: "push_subscription.save", entityType: "push_subscription", entityId: "subscription-1" }),
      expect.anything()
    );
  });

  it("rejects API-key issuance before inspecting a requested baby scope", async () => {
    mocks.txMemberFindUnique.mockResolvedValue({
      id: "owner-member", userId: "owner-user", householdId: "household-1", role: "owner", disabledAt: null, deletedAt: null
    });
    mocks.txBabyFindFirst.mockResolvedValue(null);
    await expect(createApiKey({ name: "Foreign scope", babyId: "baby-foreign" })).rejects.toThrow("api_key_issuance_unavailable");
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

  it.each([
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
