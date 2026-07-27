import type { Prisma } from "@prisma/client";
import type { HouseholdContext } from "@/server/auth/context";

export async function lockHouseholdCreation(tx: Prisma.TransactionClient) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"cubby.household-creation"}), 0)`;
}

export async function lockActorForWrite(tx: Prisma.TransactionClient, ctx: HouseholdContext) {
  await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "HouseholdMember" WHERE "id" = ${ctx.memberId} FOR UPDATE`;
  const actor = await tx.householdMember.findUnique({ where: { id: ctx.memberId } });
  if (!actor || actor.householdId !== ctx.householdId || actor.deletedAt || actor.disabledAt) throw new Error("forbidden");
  return { ...ctx, role: actor.role };
}

export async function lockApiKeyForWrite(tx: Prisma.TransactionClient, ctx: HouseholdContext, apiKeyId: string) {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "ApiKey" WHERE "id" = ${apiKeyId} AND "householdId" = ${ctx.householdId} FOR UPDATE`;
  if (locked.length !== 1) throw new Error("unauthenticated");
  const key = await tx.apiKey.findFirst({ where: { id: apiKeyId, householdId: ctx.householdId } });
  if (!key || key.revokedAt || (key.expiresAt && key.expiresAt < new Date())) throw new Error("unauthenticated");
  return key;
}

export async function lockWebhookForWrite(tx: Prisma.TransactionClient, ctx: HouseholdContext, webhookId: string) {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "WebhookEndpoint" WHERE "id" = ${webhookId} AND "householdId" = ${ctx.householdId} AND "deletedAt" IS NULL FOR UPDATE`;
  if (locked.length !== 1) throw new Error("not_found");
  const endpoint = await tx.webhookEndpoint.findFirst({ where: { id: webhookId, householdId: ctx.householdId, deletedAt: null } });
  if (!endpoint) throw new Error("not_found");
  return endpoint;
}

export async function lockBabyForWrite(tx: Prisma.TransactionClient, ctx: HouseholdContext, babyId: string) {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Baby" WHERE "id" = ${babyId} AND "householdId" = ${ctx.householdId} AND "deletedAt" IS NULL FOR UPDATE`;
  if (locked.length !== 1) throw new Error("not_found");
  const baby = await tx.baby.findFirst({ where: { id: babyId, householdId: ctx.householdId, deletedAt: null } });
  if (!baby) throw new Error("not_found");
  return baby;
}

export async function lockActorAndBabyForWrite(tx: Prisma.TransactionClient, ctx: HouseholdContext, babyId: string) {
  const lockedCtx = await lockActorForWrite(tx, ctx);
  const baby = await lockBabyForWrite(tx, lockedCtx, babyId);
  return { ctx: lockedCtx, baby };
}
