import { createHash } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { requireUser } from "@/server/auth/session";
import {
  PLATFORM_SIGNUP_POLICY_LOCK_ID,
  PLATFORM_SINGLETON_ID
} from "@/server/services/platform-constants";

export { PLATFORM_SINGLETON_ID } from "@/server/services/platform-constants";

const platformRegistrationSettingsSchema = z.object({
  householdCreationMode: z.enum(["closed", "invitation_only", "open"]),
  allowPublicRegistration: z.boolean()
}).strict();

const platformRegistrationOperationIdSchema = z.object({
  operationId: z.string().min(1).max(128)
}).strict();

type RegistrationIntent = z.infer<typeof platformRegistrationSettingsSchema>;
type RegistrationSettingsSnapshot = RegistrationIntent & { revision: number };
type RegistrationOperation = {
  id: string;
  actorUserId: string;
  intentFingerprint: string;
  expectedRevision: number;
  householdCreationMode: RegistrationIntent["householdCreationMode"];
  allowPublicRegistration: boolean;
  status: "pending" | "completed" | "stale";
  result: unknown;
};

type PlatformRegistrationTransaction = {
  $executeRaw: any;
  $queryRaw: any;
  platformAuthority: { findFirst: any };
  platformSettings: { findUnique: any; updateMany: any };
  platformRegistrationOperation: { create: any; findFirst: any; update: any };
  platformAuditEvent: { create: any };
};

export type PlatformOwnerContext = {
  userId: string;
  authorityId: typeof PLATFORM_SINGLETON_ID;
};

export async function isPlatformOwner(userId: string) {
  const authority = await prisma.platformAuthority.findFirst({
    where: { id: PLATFORM_SINGLETON_ID, ownerUserId: userId },
    select: { id: true, ownerUserId: true }
  });
  return Boolean(authority);
}

export async function getPlatformOwnerContext(): Promise<PlatformOwnerContext> {
  const user = await requireUser();
  const authority = await prisma.platformAuthority.findFirst({
    where: { id: PLATFORM_SINGLETON_ID, ownerUserId: user.id },
    select: { id: true, ownerUserId: true }
  });
  if (!authority) throw new Error("forbidden");
  return { userId: user.id, authorityId: PLATFORM_SINGLETON_ID };
}

export async function getPlatformRegistrationSettings() {
  await getPlatformOwnerContext();
  const settings = await prisma.platformSettings.findUnique({
    where: { id: PLATFORM_SINGLETON_ID }
  });
  if (!settings) throw new Error("platform_uninitialized");
  return settings;
}

function fingerprint(intent: RegistrationIntent) {
  return createHash("sha256").update(JSON.stringify(intent)).digest("hex");
}

function settingsSnapshot(settings: {
  householdCreationMode: RegistrationIntent["householdCreationMode"];
  allowPublicRegistration: boolean;
  revision: number;
}): RegistrationSettingsSnapshot {
  return {
    householdCreationMode: settings.householdCreationMode,
    allowPublicRegistration: settings.allowPublicRegistration,
    revision: settings.revision
  };
}

function operationResult(operation: RegistrationOperation) {
  if (operation.status === "pending") return { operationId: operation.id, status: "pending" as const };
  if (!operation.result || typeof operation.result !== "object") throw new Error("not_found");
  return JSON.parse(JSON.stringify(operation.result));
}

async function lockAndReauthorizeOwner(
  tx: PlatformRegistrationTransaction,
  userId: string,
  authorizationFailure = "forbidden"
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PLATFORM_SIGNUP_POLICY_LOCK_ID})`;
  await tx.$queryRaw`SELECT "id"
    FROM "PlatformAuthority"
    WHERE "id" = ${PLATFORM_SINGLETON_ID}
    FOR UPDATE`;
  const authority = await tx.platformAuthority.findFirst({
    where: { id: PLATFORM_SINGLETON_ID, ownerUserId: userId },
    select: { id: true, ownerUserId: true }
  });
  if (!authority) throw new Error(authorizationFailure);
}

async function lockSettings(tx: PlatformRegistrationTransaction) {
  await tx.$queryRaw`SELECT "id"
    FROM "PlatformSettings"
    WHERE "id" = ${PLATFORM_SINGLETON_ID}
    FOR UPDATE`;
  const settings = await tx.platformSettings.findUnique({ where: { id: PLATFORM_SINGLETON_ID } });
  if (!settings) throw new Error("platform_uninitialized");
  return settings as {
    householdCreationMode: RegistrationIntent["householdCreationMode"];
    allowPublicRegistration: boolean;
    revision: number;
  };
}

async function lockOperationForOwner(
  tx: PlatformRegistrationTransaction,
  operationId: string,
  actorUserId: string
): Promise<RegistrationOperation> {
  await tx.$queryRaw`SELECT "id"
    FROM "PlatformRegistrationOperation"
    WHERE "id" = ${operationId} AND "actorUserId" = ${actorUserId}
    FOR UPDATE`;
  const operation = await tx.platformRegistrationOperation.findFirst({
    where: { id: operationId, actorUserId }
  });
  if (!operation || operation.actorUserId !== actorUserId) throw new Error("not_found");
  const normalizedIntent = {
    householdCreationMode: operation.householdCreationMode,
    allowPublicRegistration: operation.allowPublicRegistration
  };
  if (operation.intentFingerprint !== fingerprint(normalizedIntent)) throw new Error("not_found");
  return operation as RegistrationOperation;
}

export async function allocatePlatformRegistrationOperation(raw: unknown) {
  const user = await requireUser();
  const intent = platformRegistrationSettingsSchema.parse(raw);

  return prisma.$transaction(async (tx) => {
    const db = tx as unknown as PlatformRegistrationTransaction;
    await lockAndReauthorizeOwner(db, user.id);
    const settings = await lockSettings(db);
    const operation = await db.platformRegistrationOperation.create({
      data: {
        actorUserId: user.id,
        intentFingerprint: fingerprint(intent),
        expectedRevision: settings.revision,
        householdCreationMode: intent.householdCreationMode,
        allowPublicRegistration: intent.allowPublicRegistration
      }
    });
    return { operationId: operation.id, status: "pending" as const };
  }, { isolationLevel: "Serializable" });
}

export async function completePlatformRegistrationOperation(raw: unknown) {
  const user = await requireUser();
  const { operationId } = platformRegistrationOperationIdSchema.parse(raw);

  return prisma.$transaction(async (tx) => {
    const db = tx as unknown as PlatformRegistrationTransaction;
    await lockAndReauthorizeOwner(db, user.id);
    const settings = await lockSettings(db);
    const operation = await lockOperationForOwner(db, operationId, user.id);
    if (operation.status !== "pending") return operationResult(operation);

    const nextRevision = operation.expectedRevision + 1;
    const claimed = await db.platformSettings.updateMany({
      where: { id: PLATFORM_SINGLETON_ID, revision: operation.expectedRevision },
      data: {
        householdCreationMode: operation.householdCreationMode,
        allowPublicRegistration: operation.allowPublicRegistration,
        revision: { increment: 1 }
      }
    });

    if (claimed.count !== 1) {
      const current = await db.platformSettings.findUnique({ where: { id: PLATFORM_SINGLETON_ID } });
      if (!current) throw new Error("platform_uninitialized");
      const result = {
        operationId: operation.id,
        status: "stale" as const,
        settings: settingsSnapshot(current)
      };
      const stale = await db.platformRegistrationOperation.update({
        where: { id: operation.id },
        data: { status: "stale", result }
      });
      return operationResult(stale as RegistrationOperation);
    }

    const before = settingsSnapshot(settings);
    const after = {
      householdCreationMode: operation.householdCreationMode,
      allowPublicRegistration: operation.allowPublicRegistration,
      revision: nextRevision
    };
    const result = { operationId: operation.id, status: "completed" as const, settings: after };
    const audit = await db.platformAuditEvent.create({
      data: {
        actorUserId: user.id,
        action: "platform.registration.update",
        entityType: "platform_settings",
        entityId: PLATFORM_SINGLETON_ID,
        source: "application",
        before,
        after
      }
    });
    const completed = await db.platformRegistrationOperation.update({
      where: { id: operation.id },
      data: { status: "completed", result, auditEventId: audit.id }
    });
    return operationResult(completed as RegistrationOperation);
  }, { isolationLevel: "Serializable" });
}

export async function getPlatformRegistrationOperationStatus(raw: unknown) {
  const user = await requireUser();
  const { operationId } = platformRegistrationOperationIdSchema.parse(raw);

  return prisma.$transaction(async (tx) => {
    const db = tx as unknown as PlatformRegistrationTransaction;
    await lockAndReauthorizeOwner(db, user.id, "not_found");
    const operation = await db.platformRegistrationOperation.findFirst({
      where: { id: operationId, actorUserId: user.id }
    });
    if (!operation || operation.actorUserId !== user.id) throw new Error("not_found");
    const normalizedIntent = {
      householdCreationMode: operation.householdCreationMode,
      allowPublicRegistration: operation.allowPublicRegistration
    };
    if (operation.intentFingerprint !== fingerprint(normalizedIntent)) throw new Error("not_found");
    return operationResult(operation as RegistrationOperation);
  }, { isolationLevel: "Serializable" });
}
