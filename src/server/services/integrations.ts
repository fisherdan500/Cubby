import { createHash, randomBytes } from "crypto";
import { WebhookEvent } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdContext, requirePermission } from "@/server/auth/context";
import { requireUser } from "@/server/auth/session";
import { writeAudit } from "@/server/services/audit";
import { lockActorForWrite, lockApiKeyForWrite, lockBabyForWrite, lockWebhookForWrite } from "@/server/services/mutation-locks";

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

const preferencesSchema = z.object({
  babyId: z.string().optional(),
  timerOverdue: z.coerce.boolean().default(true),
  activityCreated: z.coerce.boolean().default(false),
  reminders: z.coerce.boolean().default(true),
  quietHoursStart: z.string().optional(),
  quietHoursEnd: z.string().optional()
});

export function hashSecret(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export async function listApiKeys() {
  const ctx = await getHouseholdContext();
  requirePermission(ctx, "integration.manage");
  return prisma.apiKey.findMany({
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
}

export async function createApiKey(raw: unknown) {
  const requestContext = await getHouseholdContext();
  requirePermission(requestContext, "integration.manage");
  const input = apiKeySchema.parse(raw);
  const secret = `cubby_${randomBytes(24).toString("base64url")}`;

  return prisma.$transaction(async (tx) => {
    const ctx = await lockActorForWrite(tx, requestContext);
    requirePermission(ctx, "integration.manage");
    if (input.babyId) {
      const baby = await lockBabyForWrite(tx, ctx, input.babyId);
      if (baby.inactiveAt) throw new Error("baby_inactive");
    }
    const key = await tx.apiKey.create({
      data: {
        householdId: ctx.householdId,
        name: input.name,
        keyHash: hashSecret(secret),
        prefix: secret.slice(0, 12),
        scopes: input.scopes,
        babyId: input.babyId,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : undefined
      }
    });
    await writeAudit(ctx, {
      action: "api_key.create",
      entityType: "api_key",
      entityId: key.id,
      after: { name: key.name, prefix: key.prefix, scopes: key.scopes }
    }, tx);
    return { ...key, secret };
  });
}

export async function revokeApiKey(id: string) {
  const requestContext = await getHouseholdContext();
  requirePermission(requestContext, "integration.manage");
  return prisma.$transaction(async (tx) => {
    const ctx = await lockActorForWrite(tx, requestContext);
    requirePermission(ctx, "integration.manage");
    const key = await lockApiKeyForWrite(tx, ctx, id);
    const revoked = await tx.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
    await writeAudit(ctx, { action: "api_key.revoke", entityType: "api_key", entityId: id, after: { prefix: key.prefix } }, tx);
    return revoked;
  });
}

export async function listWebhooks() {
  const ctx = await getHouseholdContext();
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
  const requestContext = await getHouseholdContext();
  requirePermission(requestContext, "integration.manage");
  const input = webhookSchema.parse(raw);
  return prisma.$transaction(async (tx) => {
    const ctx = await lockActorForWrite(tx, requestContext);
    requirePermission(ctx, "integration.manage");
    const endpoint = await tx.webhookEndpoint.create({ data: { householdId: ctx.householdId, name: input.name, url: input.url, secret: randomBytes(32).toString("base64url"), events: input.events } });
    await writeAudit(ctx, { action: "webhook.create", entityType: "webhook", entityId: endpoint.id, after: { name: endpoint.name, url: endpoint.url, events: endpoint.events } }, tx);
    return endpoint;
  });
}

export async function deleteWebhook(id: string) {
  const requestContext = await getHouseholdContext();
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
    await writeAudit(ctx, { action: "webhook.delete", entityType: "webhook", entityId: id, after: { name: endpoint.name, url: endpoint.url } }, tx);
    return deleted;
  });
}

export async function savePushSubscription(raw: unknown) {
  const ctx = await getHouseholdContext();
  const user = await requireUser();
  requirePermission(ctx, "notification.manage");
  const input = subscriptionSchema.parse(raw);
  return prisma.pushSubscription.upsert({
    where: { endpoint: input.endpoint },
    update: {
      householdId: ctx.householdId,
      userId: user.id,
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
      userAgent: input.userAgent,
      deletedAt: null
    },
    create: {
      householdId: ctx.householdId,
      userId: user.id,
      endpoint: input.endpoint,
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
      userAgent: input.userAgent
    }
  });
}

export async function listNotificationPreferences() {
  const ctx = await getHouseholdContext();
  requirePermission(ctx, "notification.manage");
  return prisma.notificationPreference.findMany({
    where: { householdId: ctx.householdId, userId: ctx.userId },
    include: { baby: true },
    orderBy: { createdAt: "desc" }
  });
}

export async function saveNotificationPreference(raw: unknown) {
  const ctx = await getHouseholdContext();
  requirePermission(ctx, "notification.manage");
  const input = preferencesSchema.parse(raw);
  return prisma.notificationPreference.create({
    data: {
      householdId: ctx.householdId,
      userId: ctx.userId,
      babyId: input.babyId,
      timerOverdue: input.timerOverdue,
      activityCreated: input.activityCreated,
      reminders: input.reminders,
      quietHoursStart: input.quietHoursStart,
      quietHoursEnd: input.quietHoursEnd
    }
  });
}
