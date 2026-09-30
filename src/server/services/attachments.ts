import type { Prisma } from "@prisma/client";
import {
  STAGED_ATTACHMENT_TTL_MS,
  attachmentPolicy,
  attachmentPurgeAfter,
  attachmentTypeEnabled,
  type AttachmentTypeName
} from "@/domain/attachments";
import { prisma } from "@/lib/db/prisma";
import { attachmentConfig } from "@/lib/env";
import { getEffectiveHouseholdContext, requirePermission, type HouseholdContext } from "@/server/auth/context";
import {
  readAttachmentObject,
  readAttachmentThumbnail,
  removeAttachmentObject,
  removeAttachmentThumbnail,
  writeAttachmentObject,
  writeAttachmentThumbnail
} from "@/server/services/attachment-store";
import { writeAudit } from "@/server/services/audit";
import { getBrowserOperationContextForHousehold } from "@/server/services/browser-operations";
import { lockPhotoWriteActor } from "@/server/services/photo-write-actor";
import { withPhotoWriteOwnership, lockPhotoWriteIntent, transferPhotoWriteIntent, settledPhotoTransaction } from "@/server/services/attachment-write-intents";
import { makeFeedPhotoThumbnail, processAttachmentPhoto, processFeedPhoto } from "@/server/services/feed-photo-processing";

/**
 * The attachment lifecycle (DEC-PROD-141-147) for its first type, feed photos (DEC-PROD-422):
 * staged on upload, activated by the post that claims them, served only after a fresh check of the
 * viewer and of the bytes, privately recoverable for thirty days after removal, then purged to a
 * tombstone. Audit records say what happened to which attachment, never its name or content.
 */

type Options = {
  enabled?: Partial<Record<AttachmentTypeName, boolean>>;
  now?: Date;
  size?: "full" | "thumbnail";
  /**
   * Versions the caller already holds. When one matches, no bytes are read, hashed or returned.
   * Authorization is unaffected: they are compared only after the viewer, household, post and baby have
   * all been checked, so holding a correct version is never a way past a check (DEC-PROD-144).
   */
  knownDigests?: string[];
};
type Actor = Pick<HouseholdContext, "householdId" | "userId" | "memberId" | "role">;

const TYPE = "feed_photo" as const;
const directory = () => attachmentConfig.directory;

function rejectionReason(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  return code === "attachment_too_large" ? "too_large" : "unsupported_format";
}

/** Keep an uploaded photo, re-saved and verified, until a post claims it or it expires unclaimed. */
export async function stageFeedPhoto(upload: Buffer, options: Options = {}) {
  const ctx = await getBrowserOperationContextForHousehold();
  requirePermission(ctx, "feed.post");
  if (!attachmentTypeEnabled(TYPE, options.enabled)) throw new Error("attachment_type_unavailable");

  let photo;
  try {
    photo = await processFeedPhoto(upload);
  } catch (error) {
    await prisma.$transaction(async (tx) => {
      const current = await lockPhotoWriteActor(tx, ctx);
      requirePermission(current, "feed.post");
      await writeAudit(current, {
        action: "attachment.reject",
        entityType: "attachment",
        entityId: "upload",
        after: { type: TYPE, reason: rejectionReason(error) }
      }, tx);
    });
    throw error;
  }

  return withPhotoWriteOwnership(async (reserve) => {
    const storageKey = await reserve(ctx, "photo_upload", photo);
    return await settledPhotoTransaction(async (tx) => {
      const current = await lockPhotoWriteActor(tx, ctx);
      requirePermission(current, "feed.post");
      await lockPhotoWriteIntent(tx, storageKey, current.householdId, photo);
      await writeAttachmentObject(directory(), storageKey, photo.bytes, { byteSize: photo.byteSize, sha256: photo.sha256 });
      const attachment = await tx.attachment.create({
        data: {
          householdId: ctx.householdId,
          type: TYPE,
          storageKey,
          byteSize: photo.byteSize,
          sha256: photo.sha256,
          mimeType: photo.mimeType,
          width: photo.width,
          height: photo.height,
          createdByMemberId: ctx.memberId
        },
        select: { id: true }
      });
      await writeAudit(current, { action: "attachment.stage", entityType: "attachment", entityId: attachment.id, after: { type: TYPE } }, tx);
      await transferPhotoWriteIntent(tx, storageKey, current.householdId, photo);
      return { attachmentId: attachment.id, width: photo.width, height: photo.height };
    });
  });
}

/**
 * Attach this member's own staged photos to a post, in the order given, inside the post's own
 * transaction: they become visible exactly when the post does.
 */
export async function claimStagedFeedPhotos(
  tx: Prisma.TransactionClient,
  ctx: Actor,
  params: { attachmentIds: string[]; postId: string; now?: Date }
) {
  const ids = params.attachmentIds;
  if (new Set(ids).size !== ids.length || ids.length > attachmentPolicy.feed_photo.maxPerParent) {
    throw new Error("attachment_invalid_selection");
  }
  if (ids.length === 0) return;
  const now = params.now ?? new Date();
  await tx.$queryRaw`SELECT "id" FROM "Attachment" WHERE "householdId" = ${ctx.householdId} AND "id" = ANY(${ids}) FOR UPDATE`;
  const staged = await tx.attachment.findMany({
    where: {
      id: { in: ids },
      householdId: ctx.householdId,
      type: TYPE,
      state: "staging",
      createdByMemberId: ctx.memberId,
      createdAt: { gt: new Date(now.getTime() - STAGED_ATTACHMENT_TTL_MS) }
    },
    select: { id: true }
  });
  if (staged.length !== ids.length) throw new Error("not_found");
  for (const [position, id] of ids.entries()) {
    const claimed = await tx.attachment.updateMany({
      where: { id, householdId: ctx.householdId, state: "staging" },
      data: { state: "available", postId: params.postId, position, activatedAt: now }
    });
    if (claimed.count !== 1) throw new Error("not_found");
  }
  await writeAudit(ctx, {
    action: "attachment.activate",
    entityType: "feed_post",
    entityId: params.postId,
    after: { type: TYPE, count: ids.length }
  }, tx);
}

const BABY_TYPE = "baby_photo" as const;

/**
 * Keep an uploaded baby profile picture, re-saved and verified, until a baby claims it or it expires
 * unclaimed.
 *
 * Gated on `baby.manage`, NOT on `feed.post`. A caretaker may post to the family feed but may not
 * manage a baby, and a child's profile picture is part of that child's identity rather than feed
 * content - so the permission that guards renaming a baby is the one that guards their picture.
 */
export async function stageBabyPhoto(upload: Buffer, options: Options = {}) {
  const ctx = await getBrowserOperationContextForHousehold();
  requirePermission(ctx, "baby.manage");
  if (!attachmentTypeEnabled(BABY_TYPE, options.enabled)) throw new Error("attachment_type_unavailable");

  let photo;
  try {
    photo = await processAttachmentPhoto(upload, BABY_TYPE);
  } catch (error) {
    await prisma.$transaction(async (tx) => {
      const current = await lockPhotoWriteActor(tx, ctx);
      requirePermission(current, "baby.manage");
      await writeAudit(current, {
        action: "attachment.reject",
        entityType: "attachment",
        entityId: "upload",
        after: { type: BABY_TYPE, reason: rejectionReason(error) }
      }, tx);
    });
    throw error;
  }

  return withPhotoWriteOwnership(async (reserve) => {
    const storageKey = await reserve(ctx, "photo_upload", photo);
    return await settledPhotoTransaction(async (tx) => {
      // Re-checked against the locked actor row: a member demoted between the request and the
      // commit must not have their upload land anyway.
      const current = await lockPhotoWriteActor(tx, ctx);
      requirePermission(current, "baby.manage");
      await lockPhotoWriteIntent(tx, storageKey, current.householdId, photo);
      await writeAttachmentObject(directory(), storageKey, photo.bytes, { byteSize: photo.byteSize, sha256: photo.sha256 });
      const attachment = await tx.attachment.create({
        data: {
          householdId: ctx.householdId,
          type: BABY_TYPE,
          storageKey,
          byteSize: photo.byteSize,
          sha256: photo.sha256,
          mimeType: photo.mimeType,
          width: photo.width,
          height: photo.height,
          createdByMemberId: ctx.memberId
        },
        select: { id: true }
      });
      await writeAudit(current, { action: "attachment.stage", entityType: "attachment", entityId: attachment.id, after: { type: BABY_TYPE } }, tx);
      await transferPhotoWriteIntent(tx, storageKey, current.householdId, photo);
      return { attachmentId: attachment.id, width: photo.width, height: photo.height };
    });
  });
}

/**
 * Make this member's own staged photo the baby's current picture, retiring the previous one in the
 * same transaction.
 *
 * Both writes have to be one transaction: the partial unique index permits only one photo per baby
 * in the served state, so activating before retiring would be refused, and retiring without
 * activating would leave the baby with no picture. The old row keeps its thirty-day recovery window
 * rather than being erased.
 */
export async function claimStagedBabyPhoto(attachmentId: string, babyId: string, options: Options = {}) {
  // The browser-operation context, not the plain household one: lockPhotoWriteActor pins the actor's
  // session row as well as their membership, so it needs the session this request arrived on.
  const ctx = await getBrowserOperationContextForHousehold();
  requirePermission(ctx, "baby.manage");
  if (!attachmentTypeEnabled(BABY_TYPE, options.enabled)) throw new Error("attachment_type_unavailable");
  const now = options.now ?? new Date();

  return prisma.$transaction(async (tx) => {
    const current = await lockPhotoWriteActor(tx, ctx);
    requirePermission(current, "baby.manage");

    // Hidden babies are excluded: a soft-deleted baby must not gain a new picture.
    const baby = await tx.baby.findFirst({
      where: { id: babyId, householdId: ctx.householdId, deletedAt: null },
      select: { id: true }
    });
    if (!baby) throw new Error("not_found");

    // Lock this baby's photo rows before reading them, or two concurrent replacements each see no
    // predecessor, each activate, and the second fails on the unique index instead of replacing.
    await tx.$queryRaw`SELECT "id" FROM "Attachment" WHERE "householdId" = ${ctx.householdId} AND "babyId" = ${babyId} FOR UPDATE`;

    const previous = await tx.attachment.findMany({
      where: { householdId: ctx.householdId, babyId, type: BABY_TYPE, state: "available" },
      select: { id: true }
    });
    for (const row of previous) {
      await tx.attachment.updateMany({
        where: { id: row.id, householdId: ctx.householdId, state: "available" },
        data: { state: "deleted", deletedAt: now, purgeAfter: attachmentPurgeAfter(now), deletedByMemberId: ctx.memberId }
      });
    }

    const claimed = await tx.attachment.updateMany({
      where: {
        id: attachmentId,
        householdId: ctx.householdId,
        type: BABY_TYPE,
        state: "staging",
        createdByMemberId: ctx.memberId
      },
      data: { state: "available", babyId, activatedAt: now }
    });
    if (claimed.count !== 1) throw new Error("not_found");

    await writeAudit(current, {
      action: "attachment.activate",
      entityType: "baby",
      entityId: babyId,
      after: { type: BABY_TYPE }
    }, tx);

    return { attachmentId, babyId };
  });
}

function startOfUtcDay(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * The bytes of an available photo, for a current household member, on a live post - checked again
 * on every request. Missing, foreign, removed or switched-off photos all answer alike. Bytes that
 * went missing or changed stop being served from that moment.
 *
 * With `size: "thumbnail"`, a small copy for grids after exactly the same checks: the one kept, or
 * one made from the verified photo and kept for next time.
 *
 * Returns a `digest` identifying the exact bytes, so a caller can say what it already holds. Passing that
 * back as `knownDigest` skips reading and hashing the file when it still matches - but only AFTER every
 * check above has passed, so a held version never substitutes for authorization (DEC-PROD-144).
 */
export async function openAttachment(id: string, options: Options = {}) {
  const ctx = await getEffectiveHouseholdContext();
  requirePermission(ctx, "activity.read");
  const now = options.now ?? new Date();
  const attachment = await prisma.attachment.findFirst({
    where: {
      id,
      householdId: ctx.householdId,
      state: "available",
      post: { deletedAt: null, OR: [{ babyId: null }, { baby: { deletedAt: null } }] }
    },
    select: { id: true, type: true, storageKey: true, byteSize: true, sha256: true, mimeType: true }
  });
  if (!attachment || !attachmentTypeEnabled(attachment.type, options.enabled)) throw new Error("not_found");

  const thumbnail = options.size === "thumbnail";
  // The small copy is derived from the photo but is not the same bytes, so it carries its own version.
  // Sharing one would let a caller reuse the thumbnail as the full photo, or the reverse.
  const digest = thumbnail ? `${attachment.sha256}-thumbnail` : attachment.sha256;

  // Authorization is complete by here: viewer, permission, household, post and baby have all been
  // checked, and a photo this household may not see has already thrown. Only now can a held version
  // stand in for the bytes.
  const notModified = (options.knownDigests ?? []).includes(digest);

  let bytes: Buffer | null = null;
  if (!notModified) {
    bytes = thumbnail ? await readAttachmentThumbnail(directory(), attachment.storageKey) : null;
    if (!bytes) bytes = await readVerifiedPhoto(ctx, attachment, now, thumbnail);
  }

  const viewedToday = await prisma.auditEvent.findFirst({
    where: {
      householdId: ctx.householdId,
      action: "attachment.view",
      entityType: "attachment",
      entityId: attachment.id,
      actorMemberId: ctx.memberId,
      createdAt: { gte: startOfUtcDay(now) }
    },
    select: { id: true }
  });
  if (!viewedToday) {
    // The photo was looked at. That it came from the caller's own store does not make it unviewed.
    await writeAudit(ctx, { action: "attachment.view", entityType: "attachment", entityId: attachment.id, after: { type: attachment.type } });
  }
  return notModified
    ? { bytes: null, mimeType: attachment.mimeType, digest, notModified: true }
    : { bytes, mimeType: attachment.mimeType, digest, notModified: false };
}

type ServedAttachment = { id: string; type: AttachmentTypeName; storageKey: string; byteSize: number; sha256: string };

function verifiedByteFailure(error: unknown) {
  return error instanceof Error && ["attachment_bytes_missing", "attachment_bytes_mismatch"].includes(error.message);
}

/**
 * The stored photo, checked against its record - or, for a thumbnail, a small copy made from it and
 * kept for next time. Bytes that went missing or changed mark the photo unavailable from now on.
 */
async function readVerifiedPhoto(ctx: HouseholdContext, attachment: ServedAttachment, now: Date, thumbnail: boolean) {
  let photo: Buffer;
  try {
    photo = await readAttachmentObject(directory(), attachment.storageKey, { byteSize: attachment.byteSize, sha256: attachment.sha256 });
  } catch (error) {
    if (!verifiedByteFailure(error)) throw error;
    const reason = error instanceof Error && error.message === "attachment_bytes_mismatch" ? "bytes_mismatch" : "bytes_missing";
    await prisma.$transaction(async (tx) => {
      const marked = await tx.attachment.updateMany({
        where: { id: attachment.id, householdId: ctx.householdId, state: "available" },
        data: { state: "unavailable", unavailableAt: now }
      });
      if (marked.count === 1) {
        await writeAudit(ctx, { action: "attachment.unavailable", entityType: "attachment", entityId: attachment.id, after: { type: attachment.type, reason } }, tx);
      }
    });
    throw new Error("not_found");
  }
  if (!thumbnail) return photo;
  // Should a thumbnail ever fail to be made, the photo itself still shows.
  const small = await makeFeedPhotoThumbnail(photo).catch(() => null);
  if (!small) return photo;
  // Serving it does not wait on keeping it; the next view makes it again if keeping failed.
  await writeAttachmentThumbnail(directory(), attachment.storageKey, small).catch(() => undefined);
  return small;
}

/** When a post is removed, its photos become privately recoverable for thirty days. */
export async function removePostPhotos(tx: Prisma.TransactionClient, ctx: Actor, params: { postId: string; now?: Date }) {
  const now = params.now ?? new Date();
  const removed = await tx.attachment.updateMany({
    where: { householdId: ctx.householdId, postId: params.postId, state: { in: ["available", "unavailable"] } },
    data: { state: "deleted", deletedAt: now, deletedByMemberId: ctx.memberId, purgeAfter: attachmentPurgeAfter(now) }
  });
  if (removed.count > 0) {
    await writeAudit(ctx, { action: "attachment.delete", entityType: "feed_post", entityId: params.postId, after: { type: TYPE, count: removed.count } }, tx);
  }
  return removed.count;
}

/**
 * When a removed post comes back within the window, its photos come back with it - each only after
 * its bytes are checked again. A photo whose bytes did not survive stays unavailable.
 */
export async function restorePostPhotos(tx: Prisma.TransactionClient, ctx: Actor, params: { postId: string; now?: Date }) {
  const now = params.now ?? new Date();
  const removed = await tx.attachment.findMany({
    where: { householdId: ctx.householdId, postId: params.postId, state: "deleted", purgeAfter: { gt: now } },
    select: { id: true, type: true, storageKey: true, byteSize: true, sha256: true }
  });
  let count = 0;
  let unavailableCount = 0;
  for (const attachment of removed) {
    const intact = await readAttachmentObject(directory(), attachment.storageKey, { byteSize: attachment.byteSize, sha256: attachment.sha256 })
      .then(() => true, (error: unknown) => {
        if (!verifiedByteFailure(error)) throw error;
        return false;
      });
    await tx.attachment.updateMany({
      where: { id: attachment.id, householdId: ctx.householdId, state: "deleted" },
      data: intact
        ? { state: "available", deletedAt: null, deletedByMemberId: null, purgeAfter: null }
        : { state: "unavailable", unavailableAt: now }
    });
    if (intact) count += 1;
    else unavailableCount += 1;
  }
  if (removed.length > 0) {
    await writeAudit(ctx, { action: "attachment.restore", entityType: "feed_post", entityId: params.postId, after: { type: TYPE, count, unavailableCount } }, tx);
  }
  return { count, unavailableCount };
}

/**
 * Erase the bytes of removals past their thirty days and of uploads nothing claimed within a day.
 * Each is rechecked under a lock first, so a photo restored or claimed meanwhile is left alone; the
 * row stays behind as a tombstone.
 */
export async function purgeDueAttachments(now = new Date(), limit = 100) {
  const staleBefore = new Date(now.getTime() - STAGED_ATTACHMENT_TTL_MS);
  const due = { OR: [{ state: "deleted" as const, purgeAfter: { lte: now } }, { state: "staging" as const, createdAt: { lte: staleBefore } }] };
  const candidates = await prisma.attachment.findMany({ where: due, select: { id: true }, orderBy: { createdAt: "asc" }, take: limit });
  let purged = 0;
  for (const candidate of candidates) {
    const done = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Attachment" WHERE "id" = ${candidate.id} FOR UPDATE`;
      const attachment = await tx.attachment.findFirst({
        where: { id: candidate.id, ...due },
        select: { id: true, householdId: true, type: true, state: true, storageKey: true }
      });
      if (!attachment) return false;
      await removeAttachmentObject(directory(), attachment.storageKey);
      await removeAttachmentThumbnail(directory(), attachment.storageKey);
      await tx.attachment.updateMany({ where: { id: attachment.id, state: attachment.state }, data: { state: "purged", purgedAt: now } });
      await writeAudit({ householdId: attachment.householdId, userId: null, memberId: null }, {
        action: "attachment.purge",
        entityType: "attachment",
        entityId: attachment.id,
        after: { type: attachment.type, reason: attachment.state === "deleted" ? "expired" : "unclaimed" }
      }, tx);
      return true;
    });
    if (done) purged += 1;
  }
  return { purged };
}
