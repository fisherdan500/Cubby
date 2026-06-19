import { createHash, randomBytes } from "crypto";
import { WebhookEvent } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdContext, requirePermission } from "@/server/auth/context";
import { requireUser } from "@/server/auth/session";
import { writeAudit } from "@/server/services/audit";

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
  const ctx = await getHouseholdContext();
  requirePermission(ctx, "integration.manage");
  const input = apiKeySchema.parse(raw);
  const secret = `cubby_${randomBytes(24).toString("base64url")}`;
  const key = await prisma.apiKey.create({
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
  });
  return { ...key, secret };
}

export async function revokeApiKey(id: string) {
  const ctx = await getHouseholdContext();
  requirePermission(ctx, "integration.manage");
  const key = await prisma.apiKey.findFirst({ where: { id, householdId: ctx.householdId } });
  if (!key) throw new Error("not_found");
  const revoked = await prisma.apiKey.update({
    where: { id },
    data: { revokedAt: new Date() }
  });
  await writeAudit(ctx, {
    action: "api_key.revoke",
    entityType: "api_key",
    entityId: id,
    after: { prefix: key.prefix }
  });
  return revoked;
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
  const ctx = await getHouseholdContext();
  requirePermission(ctx, "integration.manage");
  const input = webhookSchema.parse(raw);
  const endpoint = await prisma.webhookEndpoint.create({
    data: {
      householdId: ctx.householdId,
      name: input.name,
      url: input.url,
      secret: randomBytes(32).toString("base64url"),
      events: input.events
    }
  });
  await writeAudit(ctx, {
    action: "webhook.create",
    entityType: "webhook",
    entityId: endpoint.id,
    after: { name: endpoint.name, url: endpoint.url, events: endpoint.events }
  });
  return endpoint;
}

export async function deleteWebhook(id: string) {
  const ctx = await getHouseholdContext();
  requirePermission(ctx, "integration.manage");
  const endpoint = await prisma.webhookEndpoint.findFirst({ where: { id, householdId: ctx.householdId, deletedAt: null } });
  if (!endpoint) throw new Error("not_found");
  return prisma.webhookEndpoint.update({
    where: { id },
    data: { deletedAt: new Date(), enabled: false }
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
