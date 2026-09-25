import { BrowserOperationKey, type Prisma } from "@prisma/client";
import { z } from "zod";
import { canRemoveFeedPost, parseFeedPostInput } from "@/domain/feed-post";
import { prisma } from "@/lib/db/prisma";
import { getEffectiveHouseholdContext, requirePermission } from "@/server/auth/context";
import { writeAudit } from "@/server/services/audit";
import {
  executeHouseholdBrowserOperation,
  getBrowserOperationContextForHousehold,
  issueHouseholdBrowserOperation,
  type BrowserOperationContext
} from "@/server/services/browser-operations";

/**
 * Text posts in the private family feed (DEC-PROD-421). A post is about one baby, or the whole
 * family, and whole-family posts appear in every baby's feed. Anyone but read-only members may post;
 * an author may remove their own post, and owners, admins and parents any. The audit trail records
 * that a post was made or removed, never what it said.
 */

const deleteSnapshotSchema = z.object({
  kind: z.literal("feed-post-delete"),
  schemaVersion: z.literal(1),
  postId: z.string().min(1),
  updatedAt: z.string().datetime()
}).strict();

const postIdSchema = z.object({ postId: z.string().min(1).max(200) });

export async function listFeedPosts(params: {
  babyId?: string;
  from?: Date;
  to?: Date;
  tag?: string;
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
      ...(params.tag ? { tags: { has: params.tag.toLowerCase() } } : {})
    },
    include: { author: { select: { displayName: true, user: { select: { name: true } } } } },
    ...(params.page ?? { orderBy: [{ occurredAt: "desc" as const }, { id: "desc" as const }], take: 200 })
  });
  return posts.map((post) => ({
    ...post,
    authorName: post.author?.displayName ?? post.author?.user.name ?? post.externalAuthorName ?? "Someone",
    canRemove: canRemoveFeedPost(ctx.role, post.authorMemberId === ctx.memberId)
  }));
}

export type FeedPostView = Awaited<ReturnType<typeof listFeedPosts>>[number];

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

export async function submitFeedPostCreateBrowserOperation(raw: Record<string, unknown>) {
  const input = parseFeedPostInput({ body: raw.body, babyId: raw.babyId ?? null });
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
      await writeAudit(lockedCtx, {
        action: "feed_post.create",
        entityType: "feed_post",
        entityId: post.id,
        ...(input.babyId ? { babyId: input.babyId } : {}),
        after: { tagCount: input.tags.length }
      }, tx);
      return { kind: "feed_post", code: "created", postId: post.id } as const;
    }
  });
}

/** The live post, locked for the rest of the transaction, if this member may remove it. */
async function lockRemovablePost(tx: Prisma.TransactionClient, ctx: BrowserOperationContext, postId: string) {
  await tx.$queryRaw`SELECT "id" FROM "FeedPost" WHERE "id" = ${postId} AND "householdId" = ${ctx.householdId} FOR UPDATE`;
  const post = await tx.feedPost.findFirst({
    where: { id: postId, householdId: ctx.householdId, deletedAt: null },
    select: { id: true, authorMemberId: true, updatedAt: true }
  });
  if (!post) throw new Error("not_found");
  if (!canRemoveFeedPost(ctx.role, post.authorMemberId === ctx.memberId)) throw new Error("forbidden");
  return post;
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
      const removed = await tx.feedPost.updateMany({
        where: { id: postId, householdId: lockedCtx.householdId, deletedAt: null, updatedAt: new Date(snapshot.updatedAt) },
        data: { deletedAt: new Date(), deletedByMemberId: lockedCtx.memberId }
      });
      if (removed.count !== 1) throw new Error("stale_revision");
      await writeAudit(lockedCtx, { action: "feed_post.delete", entityType: "feed_post", entityId: postId }, tx);
      return { kind: "feed_post", code: "deleted", postId } as const;
    }
  });
}
