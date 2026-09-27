import type { Prisma } from "@prisma/client";
import type { BrowserOperationContext } from "@/server/services/browser-operations";
import { lockPhotoWriteActor } from "@/server/services/photo-write-actor";
import { requirePermission } from "@/server/auth/context";
import { prisma } from "@/lib/db/prisma";
import { attachmentConfig } from "@/lib/env";
import { removeAttachmentObject } from "@/server/services/attachment-store";
import { newAttachmentStorageKey, STAGED_ATTACHMENT_TTL_MS } from "@/domain/attachments";

type Measurement = { byteSize: number; sha256: string };
// Operational unclaimed-storage allowance, aligned with one maximum restore archive.
export const MAX_UNCLAIMED_PHOTO_BYTES = 2 * 1024 * 1024 * 1024;
const globalPins = globalThis as typeof globalThis & { cubbyPhotoWritePins?: Set<string> };
const pins = globalPins.cubbyPhotoWritePins ??= new Set<string>();

/** Prisma may time out before its callback's filesystem work settles. */
export async function settledPhotoTransaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>, options?: { isolationLevel?: Prisma.TransactionIsolationLevel; maxWait?: number; timeout?: number }) {
  let callback: Promise<T> | undefined;
  try {
    return await prisma.$transaction((tx) => {
      callback = work(tx);
      return callback;
    }, options);
  } finally {
    await callback?.catch(() => undefined);
  }
}

/** Only new, durably owned identities; never a filesystem orphan scan. */
export async function sweepPhotoWriteIntents(now = new Date()) {
  const due = await prisma.attachmentWriteIntent.findMany({
    where: { state: "pending", nextAttemptAt: { lte: now } },
    orderBy: [{ nextAttemptAt: "asc" }, { storageKey: "asc" }], take: 100
  });
  for (const { storageKey } of due) {
    if (pins.has(storageKey)) continue;
    pins.add(storageKey);
    try {
      await settledPhotoTransaction(async (tx) => {
        await tx.$queryRaw`SELECT "storageKey" FROM "AttachmentWriteIntent" WHERE "storageKey" = ${storageKey} FOR UPDATE`;
        const intent = await tx.attachmentWriteIntent.findUnique({ where: { storageKey } });
        if (!intent || intent.state !== "pending") return;
        // An ambiguous successful commit must never become an eager unlink.
        if (await tx.attachment.findUnique({ where: { storageKey }, select: { id: true } })) return;
        await removeAttachmentObject(attachmentConfig.directory, storageKey);
        await tx.attachmentWriteIntent.updateMany({
          where: { storageKey, state: "pending" }, data: { state: "cleaned", cleanedAt: now }
        });
      });
    } catch {
      // Keep ownership even if this retry timestamp cannot be persisted.
      await prisma.attachmentWriteIntent.updateMany({
        where: { storageKey, state: "pending" }, data: { nextAttemptAt: new Date(now.getTime() + 15 * 60_000) }
      }).catch(() => undefined);
    } finally {
      pins.delete(storageKey);
    }
  }
}

/** Single-process exclusion spans every photo of a restore attempt, not merely its current write. */
export async function withPhotoWriteOwnership<T>(work: (reserve: (actor: BrowserOperationContext, purpose: "photo_upload" | "restore_photo", measured: Measurement) => Promise<string>) => Promise<T>) {
  const owned: string[] = [];
  try {
    return await work(async (actor, purpose, measured) => {
      const storageKey = newAttachmentStorageKey();
      pins.add(storageKey);
      owned.push(storageKey);
      // Separate commit survives domain rollback, but is itself freshly authorized.
      await settledPhotoTransaction(async (tx) => {
        const current = await lockPhotoWriteActor(tx, actor);
        requirePermission(current, purpose === "photo_upload" ? "feed.post" : "backup.manage");
        await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext('cubby.photo-staging'), 0)`;
        // One statement/snapshot: transfer replaces pending with staging atomically, never twice.
        const [usage] = await tx.$queryRaw<Array<{ stagedBytes: bigint }>>`
          SELECT COALESCE(SUM("byteSize"), 0)::bigint AS "stagedBytes" FROM (
            SELECT "byteSize" FROM "AttachmentWriteIntent" WHERE "state" = 'pending'
            UNION ALL
            SELECT "byteSize" FROM "Attachment" WHERE "state" = 'staging'
          ) AS unclaimed`;
        if (!usage || typeof usage.stagedBytes !== "bigint" || usage.stagedBytes < 0n ||
            !Number.isSafeInteger(measured.byteSize) || measured.byteSize <= 0 ||
            usage.stagedBytes + BigInt(measured.byteSize) > BigInt(MAX_UNCLAIMED_PHOTO_BYTES)) {
          throw new Error("attachment_staging_full");
        }
        await tx.attachmentWriteIntent.create({ data: {
          storageKey, householdId: current.householdId, purpose, byteSize: measured.byteSize, sha256: measured.sha256, state: "pending",
          nextAttemptAt: new Date(Date.now() + STAGED_ATTACHMENT_TTL_MS)
        } });
      });
      return storageKey;
    });
  } finally {
    for (const key of owned) pins.delete(key);
  }
}

export async function lockPhotoWriteIntent(tx: Prisma.TransactionClient, storageKey: string, householdId: string, measured: Measurement) {
  await tx.$queryRaw`SELECT "storageKey" FROM "AttachmentWriteIntent" WHERE "storageKey" = ${storageKey} FOR UPDATE`;
  const intent = await tx.attachmentWriteIntent.findUnique({ where: { storageKey } });
  if (!intent || intent.state !== "pending" || intent.householdId !== householdId ||
      intent.byteSize !== measured.byteSize || intent.sha256 !== measured.sha256) throw new Error("attachment_write_intent_unavailable");
}

/** Call only after creating the matching Attachment in this same transaction. */
export async function transferPhotoWriteIntent(tx: Prisma.TransactionClient, storageKey: string, householdId: string, measured: Measurement) {
  await lockPhotoWriteIntent(tx, storageKey, householdId, measured);
  const changed = await tx.attachmentWriteIntent.updateMany({
    where: { storageKey, householdId, state: "pending" }, data: { state: "transferred" }
  });
  if (changed.count !== 1) throw new Error("attachment_write_intent_unavailable");
}
