import { BrowserOperationKey, type Prisma } from "@prisma/client";
import { z } from "zod";
import { attachmentTypeEnabled, type AttachmentTypeName } from "@/domain/attachments";
import {
  FEED_POST_RECOVERY_MS,
  canEditFeedPost,
  canRemoveFeedPost,
  feedPostRestorable,
  parseFeedPostEdit,
  parseFeedPostInput
} from "@/domain/feed-post";
import { hasPermission } from "@/domain/roles";
import { prisma } from "@/lib/db/prisma";
import { getEffectiveHouseholdContext, requirePermission } from "@/server/auth/context";
import { claimStagedFeedPhotos, removePostPhotos, restorePostPhotos } from "@/server/services/attachments";
import { writeAudit } from "@/server/services/audit";
import {
  executeHouseholdBrowserOperation,
  getBrowserOperationContextForHousehold,
  issueHouseholdBrowserOperation,
  type BrowserOperationContext
} from "@/server/services/browser-operations";

/**
 * Posts in the private family feed (DEC-PROD-421): words, photos (DEC-PROD-422), or both. A post is
 * about one baby, or the whole family, and whole-family posts appear in every baby's feed. Anyone but
 * read-only members may post; an author may edit their own post and remove it, and owners, admins and
 * parents may remove any. A removed post and its photos can be brought back for thirty days. The audit
 * trail records that a post was made, edited, removed or restored, never what it said or showed.
 */

const revisionSnapshotSchema = (kind: "feed-post-delete" | "feed-post-update") => z.object({
  kind: z.literal(kind),
  schemaVersion: z.literal(1),
  postId: z.string().min(1),
  updatedAt: z.string().datetime()
}).strict();
const deleteSnapshotSchema = revisionSnapshotSchema("feed-post-delete");
const updateSnapshotSchema = revisionSnapshotSchema("feed-post-update");
const restoreSnapshotSchema = z.object({
  kind: z.literal("feed-post-restore"),
  schemaVersion: z.literal(1),
  postId: z.string().min(1),
  deletedAt: z.string().datetime()
}).strict();

const postIdSchema = z.object({ postId: z.string().min(1).max(200) });

type PhotoOptions = { enabled?: Partial<Record<AttachmentTypeName, boolean>> };

const shownPhotos = {
  where: { state: "available" as const },
  orderBy: { position: "asc" as const },
  select: { id: true, width: true, height: true }
};

export async function listFeedPosts(params: {
  babyId?: string;
  from?: Date;
  to?: Date;
  tag?: string;
  // Only posts with a photo still shown: the Photos gallery, gathered from every post.
  withPhotos?: boolean;
  page?: { take: number; orderBy: Prisma.FeedPostOrderByWithRelationInput[]; cursor?: { id: string }; skip?: number };
}) {
  const ctx = await getEffectiveHouseholdContext();
  requirePermission(ctx, "activity.read");
  const posts = await prisma.feedPost.findMany({
    where: {
      householdId: ctx.householdId,
      deletedAt: null,
      ...(params.babyId ? { OR: [{ babyId: params.babyId }, { babyId: null }] } : {}),
      ...(params.from || params.to ? { occurredAt: { ...(params.from ? { gte: params.from } : {}), ...(params.to ? { lt: params.to } : {}) } } : {}),
      ...(params.tag ? { tags: { has: params.tag.toLowerCase() } } : {}),
      ...(params.withPhotos ? { photos: { some: { state: "available" as const } } } : {})
    },
    include: { author: { select: { displayName: true, user: { select: { name: true } } } }, photos: shownPhotos },
    ...(params.page ?? { orderBy: [{ occurredAt: "desc" as const }, { id: "desc" as const }], take: 200 })
  });
  return posts.map((post) => ({
    ...post,
    authorName: post.author?.displayName ?? post.author?.user.name ?? post.externalAuthorName ?? "Someone",
    edited: post.editedAt !== null,
    canEdit: canEditFeedPost(ctx.role, post.authorMemberId === ctx.memberId),
    canRemove: canRemoveFeedPost(ctx.role, post.authorMemberId === ctx.memberId)
  }));
}

export type FeedPostView = Awaited<ReturnType<typeof listFeedPosts>>[number];

/**
 * Posts removed in the last thirty days that this member may bring back: their own, or - for owners,
 * admins and parents - anyone's. Newest removal first.
 */
export async function listRemovedFeedPosts() {
  const ctx = await getEffectiveHouseholdContext();
  requirePermission(ctx, "feed.post");
  const moderator = hasPermission(ctx.role, "feed.moderate");
  const posts = await prisma.feedPost.findMany({
    where: {
      householdId: ctx.householdId,
      deletedAt: { gte: new Date(Date.now() - FEED_POST_RECOVERY_MS) },
      ...(moderator ? {} : { authorMemberId: ctx.memberId })
    },
    include: {
      author: { select: { displayName: true, user: { select: { name: true } } } },
      _count: { select: { photos: { where: { state: "deleted" } } } }
    },
    orderBy: [{ deletedAt: "desc" }, { id: "desc" }],
    take: 100
  });
  return posts.map((post) => ({
    id: post.id,
    babyId: post.babyId,
    body: post.body,
    occurredAt: post.occurredAt,
    deletedAt: post.deletedAt!,
    photoCount: post._count.photos,
    authorName: post.author?.displayName ?? post.author?.user.name ?? post.externalAuthorName ?? "Someone"
  }));
}

export async function issueFeedPostCreateBrowserOperation(raw: Record<string, unknown>) {
  const ctx = await getBrowserOperationContextForHousehold();
  return issueHouseholdBrowserOperation({
    ctx,
    operationId: raw.operationId,
    operationKey: BrowserOperationKey.feedPostCreate,
    targetKind: "post",
    permission: "feed.post",
    targetSnapshot: () => ({ kind: "feed-post-create", schemaVersion: 1 })
  });
}

export async function submitFeedPostCreateBrowserOperation(raw: Record<string, unknown>, options: PhotoOptions = {}) {
  const input = parseFeedPostInput({ body: raw.body ?? "", babyId: raw.babyId ?? null, attachmentIds: raw.attachmentIds ?? [] });
  if (input.attachmentIds.length > 0 && !attachmentTypeEnabled("feed_photo", options.enabled)) throw new Error("attachment_type_unavailable");
  const ctx = await getBrowserOperationContextForHousehold();
  return executeHouseholdBrowserOperation({
    ctx,
    operationId: raw.operationId,
    operationKey: BrowserOperationKey.feedPostCreate,
    intent: input,
    targetKind: "post",
    permission: "feed.post",
    execute: async (tx, lockedCtx) => {
      if (input.babyId) {
        const baby = await tx.baby.findFirst({ where: { id: input.babyId, householdId: lockedCtx.householdId, deletedAt: null }, select: { id: true } });
        if (!baby) throw new Error("not_found");
      }
      const post = await tx.feedPost.create({
        data: { householdId: lockedCtx.householdId, babyId: input.babyId, authorMemberId: lockedCtx.memberId, body: input.body, tags: input.tags },
        select: { id: true }
      });
      // The photos become visible exactly when the post does, or not at all.
      if (input.attachmentIds.length > 0) {
        await claimStagedFeedPhotos(tx, lockedCtx, { attachmentIds: input.attachmentIds, postId: post.id });
      }
      await writeAudit(lockedCtx, {
        action: "feed_post.create",
        entityType: "feed_post",
        entityId: post.id,
        ...(input.babyId ? { babyId: input.babyId } : {}),
        after: { tagCount: input.tags.length, ...(input.attachmentIds.length > 0 ? { photoCount: input.attachmentIds.length } : {}) }
      }, tx);
      return { kind: "feed_post", code: "created", postId: post.id } as const;
    }
  });
}

/** The live post, locked for the rest of the transaction, if this member may act on it. */
async function lockPost(
  tx: Prisma.TransactionClient,
  ctx: BrowserOperationContext,
  postId: string,
  allowed: (role: BrowserOperationContext["role"], isAuthor: boolean) => boolean
) {
  await tx.$queryRaw`SELECT "id" FROM "FeedPost" WHERE "id" = ${postId} AND "householdId" = ${ctx.householdId} FOR UPDATE`;
  const post = await tx.feedPost.findFirst({
    where: { id: postId, householdId: ctx.householdId, deletedAt: null },
    select: { id: true, authorMemberId: true, updatedAt: true }
  });
  if (!post) throw new Error("not_found");
  if (!allowed(ctx.role, post.authorMemberId === ctx.memberId)) throw new Error("forbidden");
  return post;
}

const lockRemovablePost = (tx: Prisma.TransactionClient, ctx: BrowserOperationContext, postId: string) => lockPost(tx, ctx, postId, canRemoveFeedPost);
const lockEditablePost = (tx: Prisma.TransactionClient, ctx: BrowserOperationContext, postId: string) => lockPost(tx, ctx, postId, canEditFeedPost);

export async function issueFeedPostUpdateBrowserOperation(raw: Record<string, unknown>) {
  const { postId } = postIdSchema.parse(raw);
  const ctx = await getBrowserOperationContextForHousehold();
  return issueHouseholdBrowserOperation({
    ctx,
    operationId: raw.operationId,
    operationKey: BrowserOperationKey.feedPostUpdate,
    targetKind: "post",
    targetId: postId,
    permission: "feed.post",
    targetSnapshot: async (tx, lockedCtx) => {
      const post = await lockEditablePost(tx, lockedCtx, postId);
      return { kind: "feed-post-update", schemaVersion: 1, postId: post.id, updatedAt: post.updatedAt.toISOString() };
    }
  });
}

export async function submitFeedPostUpdateBrowserOperation(raw: Record<string, unknown>) {
  const { postId } = postIdSchema.parse(raw);
  // Whether an empty caption is allowed depends on the post's photos, checked under the lock below.
  const input = parseFeedPostEdit({ body: raw.body }, { hasPhotos: true });
  const ctx = await getBrowserOperationContextForHousehold();
  return executeHouseholdBrowserOperation({
    ctx,
    operationId: raw.operationId,
    operationKey: BrowserOperationKey.feedPostUpdate,
    intent: { postId, ...input },
    targetKind: "post",
    targetId: postId,
    permission: "feed.post",
    validate: async (tx, lockedCtx, binding) => {
      const snapshot = updateSnapshotSchema.safeParse(binding.targetSnapshot);
      if (!snapshot.success || snapshot.data.postId !== postId) throw new Error("not_found");
      const post = await lockEditablePost(tx, lockedCtx, postId);
      if (post.updatedAt.toISOString() !== snapshot.data.updatedAt) throw new Error("stale_revision");
      if (input.body === "") {
        const photos = await tx.attachment.count({ where: { householdId: lockedCtx.householdId, postId, state: { in: ["available", "unavailable"] } } });
        if (photos === 0) throw new Error("validation_error");
      }
    },
    execute: async (tx, lockedCtx, binding) => {
      const snapshot = updateSnapshotSchema.parse(binding.targetSnapshot);
      const updated = await tx.feedPost.updateMany({
        where: { id: postId, householdId: lockedCtx.householdId, deletedAt: null, updatedAt: new Date(snapshot.updatedAt) },
        data: { body: input.body, tags: input.tags, editedAt: new Date() }
      });
      if (updated.count !== 1) throw new Error("stale_revision");
      await writeAudit(lockedCtx, { action: "feed_post.update", entityType: "feed_post", entityId: postId, after: { tagCount: input.tags.length } }, tx);
      return { kind: "feed_post", code: "updated", postId } as const;
    }
  });
}

export async function issueFeedPostDeleteBrowserOperation(raw: Record<string, unknown>) {
  const { postId } = postIdSchema.parse(raw);
  const ctx = await getBrowserOperationContextForHousehold();
  return issueHouseholdBrowserOperation({
    ctx,
    operationId: raw.operationId,
    operationKey: BrowserOperationKey.feedPostDelete,
    targetKind: "post",
    targetId: postId,
    permission: "feed.post",
    targetSnapshot: async (tx, lockedCtx) => {
      const post = await lockRemovablePost(tx, lockedCtx, postId);
      return { kind: "feed-post-delete", schemaVersion: 1, postId: post.id, updatedAt: post.updatedAt.toISOString() };
    }
  });
}

export async function submitFeedPostDeleteBrowserOperation(raw: Record<string, unknown>) {
  const { postId } = postIdSchema.parse(raw);
  const ctx = await getBrowserOperationContextForHousehold();
  return executeHouseholdBrowserOperation({
    ctx,
    operationId: raw.operationId,
    operationKey: BrowserOperationKey.feedPostDelete,
    intent: { postId },
    targetKind: "post",
    targetId: postId,
    permission: "feed.post",
    validate: async (tx, lockedCtx, binding) => {
      const snapshot = deleteSnapshotSchema.safeParse(binding.targetSnapshot);
      if (!snapshot.success || snapshot.data.postId !== postId) throw new Error("not_found");
      const post = await lockRemovablePost(tx, lockedCtx, postId);
      if (post.updatedAt.toISOString() !== snapshot.data.updatedAt) throw new Error("stale_revision");
    },
    execute: async (tx, lockedCtx, binding) => {
      const snapshot = deleteSnapshotSchema.parse(binding.targetSnapshot);
      const now = new Date();
      const removed = await tx.feedPost.updateMany({
        where: { id: postId, householdId: lockedCtx.householdId, deletedAt: null, updatedAt: new Date(snapshot.updatedAt) },
        data: { deletedAt: now, deletedByMemberId: lockedCtx.memberId }
      });
      if (removed.count !== 1) throw new Error("stale_revision");
      await removePostPhotos(tx, lockedCtx, { postId, now });
      await writeAudit(lockedCtx, { action: "feed_post.delete", entityType: "feed_post", entityId: postId }, tx);
      return { kind: "feed_post", code: "deleted", postId } as const;
    }
  });
}

/** The removed post, locked, if it is still within its thirty days and this member may bring it back. */
async function lockRestorablePost(tx: Prisma.TransactionClient, ctx: BrowserOperationContext, postId: string) {
  await tx.$queryRaw`SELECT "id" FROM "FeedPost" WHERE "id" = ${postId} AND "householdId" = ${ctx.householdId} FOR UPDATE`;
  const post = await tx.feedPost.findFirst({
    where: { id: postId, householdId: ctx.householdId, deletedAt: { not: null } },
    select: { id: true, authorMemberId: true, deletedAt: true }
  });
  if (!post?.deletedAt || !feedPostRestorable(post.deletedAt, new Date())) throw new Error("not_found");
  if (!canRemoveFeedPost(ctx.role, post.authorMemberId === ctx.memberId)) throw new Error("forbidden");
  return { ...post, deletedAt: post.deletedAt };
}

export async function issueFeedPostRestoreBrowserOperation(raw: Record<string, unknown>) {
  const { postId } = postIdSchema.parse(raw);
  const ctx = await getBrowserOperationContextForHousehold();
  return issueHouseholdBrowserOperation({
    ctx,
    operationId: raw.operationId,
    operationKey: BrowserOperationKey.feedPostRestore,
    targetKind: "post",
    targetId: postId,
    permission: "feed.post",
    targetSnapshot: async (tx, lockedCtx) => {
      const post = await lockRestorablePost(tx, lockedCtx, postId);
      return { kind: "feed-post-restore", schemaVersion: 1, postId: post.id, deletedAt: post.deletedAt.toISOString() };
    }
  });
}

/** Bring back the post as it was removed, and with it every photo whose bytes are still intact. */
export async function submitFeedPostRestoreBrowserOperation(raw: Record<string, unknown>) {
  const { postId } = postIdSchema.parse(raw);
  const ctx = await getBrowserOperationContextForHousehold();
  return executeHouseholdBrowserOperation({
    ctx,
    operationId: raw.operationId,
    operationKey: BrowserOperationKey.feedPostRestore,
    intent: { postId },
    targetKind: "post",
    targetId: postId,
    permission: "feed.post",
    validate: async (tx, lockedCtx, binding) => {
      const snapshot = restoreSnapshotSchema.safeParse(binding.targetSnapshot);
      if (!snapshot.success || snapshot.data.postId !== postId) throw new Error("not_found");
      const post = await lockRestorablePost(tx, lockedCtx, postId);
      if (post.deletedAt.toISOString() !== snapshot.data.deletedAt) throw new Error("stale_revision");
    },
    execute: async (tx, lockedCtx, binding) => {
      const snapshot = restoreSnapshotSchema.parse(binding.targetSnapshot);
      const restored = await tx.feedPost.updateMany({
        where: { id: postId, householdId: lockedCtx.householdId, deletedAt: new Date(snapshot.deletedAt) },
        data: { deletedAt: null, deletedByMemberId: null }
      });
      if (restored.count !== 1) throw new Error("stale_revision");
      await restorePostPhotos(tx, lockedCtx, { postId, now: new Date() });
      await writeAudit(lockedCtx, { action: "feed_post.restore", entityType: "feed_post", entityId: postId }, tx);
      return { kind: "feed_post", code: "restored", postId } as const;
    }
  });
}
