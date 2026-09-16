import { createHash, randomBytes } from "crypto";
import { BrowserOperationKey, BrowserOperationTargetKind, WebhookEvent } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { getEffectiveHouseholdContext, requirePermission } from "@/server/auth/context";
import { requireFreshSession, requireUser } from "@/server/auth/session";
import { SESSION_FRESH_AGE_SECONDS } from "@/lib/auth/auth";
import { writeAudit } from "@/server/services/audit";
import { executeHouseholdBrowserOperation, getBrowserOperationContextForHousehold, issueHouseholdBrowserOperation } from "@/server/services/browser-operations";
import { lockActorForWrite, lockApiKeyForContainment, lockApiKeyForWrite, lockBabyForWrite, lockWebhookForWrite } from "@/server/services/mutation-locks";

const apiKeySchema = z.object({
  name: z.string().trim().min(1),
  scopes: z.array(z.string()).default(["read"]),
  babyId: z.string().optional(),
  expiresAt: z.string().optional()
});

const webhookSchema = z.object({
  name: z.string().trim().min(1),
  url: z.string().url(),
  events: z.array(z.nativeEnum(WebhookEvent)).min(1).default([WebhookEvent.activity_created])
});

const subscriptionSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1)
  }),
  userAgent: z.string().optional()
});


export function hashSecret(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export async function listApiKeys() {
  const freshSession = await requireFreshSession();
  const requestContext = await getEffectiveHouseholdContext();
  return prisma.$transaction(async (tx) => {
    const ctx = await lockActorForWrite(tx, requestContext);
    await reauthorizeApiKeyOwner(tx, ctx, freshSession);
    return tx.apiKey.findMany({
      where: { householdId: ctx.householdId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        prefix: true,
        scopes: true,
        babyId: true,
        expiresAt: true,
        revokedAt: true,
        lastUsedAt: true,
        createdAt: true
      }
    });
  });
}

export async function createApiKey(raw: unknown) {
  void raw;
  throw new Error("api_key_issuance_unavailable");
}

const apiKeyRevokeBrowserSchema = z.object({ operationId: z.unknown(), apiKeyId: z.string().min(1) }).strict();

async function reauthorizeApiKeyOwner(tx: { $queryRaw: typeof prisma.$queryRaw }, ctx: { userId: string; role: string }, freshSession: Awaited<ReturnType<typeof requireFreshSession>>) {
  if (ctx.role !== "owner" || freshSession.user.id !== ctx.userId) throw new Error("not_found");
  const sessions = await tx.$queryRaw<Array<{ userId: string; createdAt: Date; expiresAt: Date }>>`
    SELECT "userId", "createdAt", "expiresAt" FROM "lock_actor_session_for_operation"(${freshSession.user.id}, ${freshSession.session.id})
  `;
  const session = sessions[0];
  if (!session || session.userId !== freshSession.user.id || session.expiresAt <= new Date()) throw new Error("unauthenticated");
  if (Date.now() - session.createdAt.getTime() >= SESSION_FRESH_AGE_SECONDS * 1000) throw new Error("fresh_authentication_required");
}

export async function issueApiKeyRevokeBrowserOperation(raw: unknown) {
  const input = apiKeyRevokeBrowserSchema.parse(raw);
  const freshSession = await requireFreshSession();
  const ctx = await getBrowserOperationContextForHousehold();
  if (ctx.role !== "owner") throw new Error("forbidden");
  return issueHouseholdBrowserOperation({
    ctx, operationId: input.operationId, operationKey: BrowserOperationKey.apiKeyRevoke,
    targetKind: BrowserOperationTargetKind.apiKey, targetId: input.apiKeyId, permission: "integration.manage",
    reauthorize: (tx, lockedCtx) => reauthorizeApiKeyOwner(tx, lockedCtx, freshSession),
    targetSnapshot: async (tx, lockedCtx) => {
      if (lockedCtx.role !== "owner") throw new Error("forbidden");
      const key = await lockApiKeyForContainment(tx, lockedCtx, input.apiKeyId);
      return { version: 1, revokedAt: key.revokedAt?.toISOString() ?? null };
    }
  });
}

export async function submitApiKeyRevokeBrowserOperation(raw: unknown) {
  const input = apiKeyRevokeBrowserSchema.parse(raw);
  const freshSession = await requireFreshSession();
  const ctx = await getBrowserOperationContextForHousehold();
  if (freshSession.user.id !== ctx.userId || ctx.role !== "owner") throw new Error("forbidden");
  return executeHouseholdBrowserOperation({
    ctx, operationId: input.operationId, operationKey: BrowserOperationKey.apiKeyRevoke,
    targetKind: BrowserOperationTargetKind.apiKey, targetId: input.apiKeyId, permission: "integration.manage", intent: {},
    reauthorize: (tx, lockedCtx) => reauthorizeApiKeyOwner(tx, lockedCtx, freshSession),
    execute: async (tx, lockedCtx, binding) => {
      const opening = binding.targetSnapshot as { version?: unknown };
      if (opening.version !== 1) throw new Error("stale_revision");
      const key = await lockApiKeyForContainment(tx, lockedCtx, input.apiKeyId);
      if (key.revokedAt) return { kind: "api_key", code: "already_revoked" } as const;
      await tx.apiKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } });
      await writeAudit(lockedCtx, { action: "api_key.revoke", entityType: "api_key", entityId: key.id, correlationId: String(input.operationId) }, tx);
      return { kind: "api_key", code: "revoked" } as const;
    }
  });
}

export async function listWebhooks() {
  const ctx = await getEffectiveHouseholdContext();
  requirePermission(ctx, "integration.manage");
  return prisma.webhookEndpoint.findMany({
    where: { householdId: ctx.householdId, deletedAt: null },
    include: {
      deliveries: {
        orderBy: { createdAt: "desc" },
        take: 5
      }
    },
    orderBy: { createdAt: "desc" }
  });
}

export async function createWebhook(raw: unknown) {
  const requestContext = await getEffectiveHouseholdContext();
  requirePermission(requestContext, "integration.manage");
  const input = webhookSchema.parse(raw);
  return prisma.$transaction(async (tx) => {
    const ctx = await lockActorForWrite(tx, requestContext);
    requirePermission(ctx, "integration.manage");
    const endpoint = await tx.webhookEndpoint.create({
      data: {
        householdId: ctx.householdId,
        delegatedByMemberId: ctx.memberId,
        legacyUnattributed: false,
        name: input.name,
        url: input.url,
        secret: randomBytes(32).toString("base64url"),
        events: input.events
      }
    });
    await writeAudit(ctx, { action: "webhook.create", entityType: "webhook", entityId: endpoint.id, after: { events: endpoint.events } }, tx);
    return endpoint;
  });
}

export async function deleteWebhook(id: string) {
  const requestContext = await getEffectiveHouseholdContext();
  requirePermission(requestContext, "integration.manage");
  return prisma.$transaction(async (tx) => {
    const ctx = await lockActorForWrite(tx, requestContext);
    requirePermission(ctx, "integration.manage");
    const endpoint = await lockWebhookForWrite(tx, ctx, id);
    await tx.webhookDelivery.updateMany({
      where: { endpointId: id, status: "pending" },
      data: { status: "failed", lastError: "endpoint_deleted", nextAttemptAt: null }
    });
    const deleted = await tx.webhookEndpoint.update({ where: { id }, data: { deletedAt: new Date(), enabled: false } });
    await writeAudit(ctx, { action: "webhook.delete", entityType: "webhook", entityId: id }, tx);
    return deleted;
  });
}

export async function savePushSubscription(raw: unknown) {
  const ctx = await getEffectiveHouseholdContext();
  const user = await requireUser();
  requirePermission(ctx, "notification.manage");
  const input = subscriptionSchema.parse(raw);
  return prisma.$transaction(async (tx) => {
    const lockedCtx = await lockActorForWrite(tx, ctx);
    requirePermission(lockedCtx, "notification.manage");
    const subscription = await tx.pushSubscription.upsert({
      where: { endpoint: input.endpoint },
      update: {
        householdId: lockedCtx.householdId,
        userId: user.id,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        userAgent: input.userAgent,
        deletedAt: null
      },
      create: {
        householdId: lockedCtx.householdId,
        userId: user.id,
        endpoint: input.endpoint,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        userAgent: input.userAgent
      }
    });
    await writeAudit(lockedCtx, {
      action: "push_subscription.save",
      entityType: "push_subscription",
      entityId: subscription.id
    }, tx);
    return subscription;
  });
}
