import { BrowserOperationKey, type Prisma } from "@prisma/client";
import { z } from "zod";
import {
  canEditFeedComment,
  canRemoveFeedComment,
  parseFeedCommentInput,
  parseFeedParent,
  parseFeedReactionInput,
  summarizeFeedReactions,
  type FeedParent,
  type FeedParentKind,
  type FeedReactionSummary
} from "@/domain/feed-interactions";
import { hasPermission, type HouseholdRoleName } from "@/domain/roles";
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
 * Comments and reactions in the family feed (DEC-PROD-421), on a post or a logged entry. Every member
 * may comment and react, read-only members included; a comment never changes the entry it is on. The
 * author edits their comment; the author, or an owner, admin or parent, removes it. The audit trail
 * records what was done and what it was on, never what a comment said.
 */

const commentRevisionSchema = (kind: "feed-comment-update" | "feed-comment-delete") => z.object({
  kind: z.literal(kind),
  schemaVersion: z.literal(1),
  commentId: z.string().min(1),
  updatedAt: z.string().datetime()
}).strict();
const updateSnapshotSchema = commentRevisionSchema("feed-comment-update");
const deleteSnapshotSchema = commentRevisionSchema("feed-comment-delete");
const parentSnapshotSchema = (kind: "feed-comment-create" | "feed-reaction-set") => z.object({
  kind: z.literal(kind),
  schemaVersion: z.literal(1),
  parentKind: z.enum(["post", "activity"]),
  parentId: z.string().min(1)
}).strict();

const commentIdSchema = z.object({ commentId: z.string().min(1).max(200) });

/** How a comment or reaction is found for the thing it is on: `post:<id>` or `activity:<id>`. */
export function feedInteractionKey(kind: FeedParentKind, id: string) {
  return `${kind}:${id}`;
}

type MemberName = { displayName: string | null; user: { name: string } } | null;
const memberName = (member: MemberName, external: string | null) => member?.displayName ?? member?.user.name ?? external ?? "Someone";
const memberSelect = { select: { displayName: true, user: { select: { name: true } } } } as const;

export type FeedCommentView = {
  id: string;
  body: string;
  authorName: string;
  createdAt: Date;
  edited: boolean;
  canEdit: boolean;
  canRemove: boolean;
};

/** The live comments, oldest first, and the reactions for the posts and entries on screen. */
export async function listFeedInteractions(params: { postIds: string[]; activityIds: string[] }) {
  const ctx = await getEffectiveHouseholdContext();
  requirePermission(ctx, "activity.read");
  const comments: Record<string, FeedCommentView[]> = {};
  const reactions: Record<string, FeedReactionSummary[]> = {};
  const canRespond = hasPermission(ctx.role as HouseholdRoleName, "feed.comment");
  if (params.postIds.length === 0 && params.activityIds.length === 0) return { comments, reactions, canRespond };

  const parents = [
    ...(params.postIds.length ? [{ postId: { in: params.postIds } }] : []),
    ...(params.activityIds.length ? [{ activityId: { in: params.activityIds } }] : [])
  ];
  const [commentRows, reactionRows] = await Promise.all([
    prisma.feedComment.findMany({
      where: { householdId: ctx.householdId, deletedAt: null, OR: parents },
      include: { author: memberSelect },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }]
    }),
    prisma.feedReaction.findMany({
      where: { householdId: ctx.householdId, OR: parents },
      include: { member: memberSelect },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }]
    })
  ]);

  for (const row of commentRows) {
    const key = row.postId ? feedInteractionKey("post", row.postId) : feedInteractionKey("activity", row.activityId!);
    const isAuthor = row.authorMemberId === ctx.memberId;
    (comments[key] ??= []).push({
      id: row.id,
      body: row.body,
      authorName: memberName(row.author, row.externalAuthorName),
      createdAt: row.createdAt,
      edited: row.editedAt !== null,
      canEdit: canEditFeedComment(ctx.role as HouseholdRoleName, isAuthor),
      canRemove: canRemoveFeedComment(ctx.role as HouseholdRoleName, isAuthor)
    });
  }

  const reactionsByParent = new Map<string, Array<{ reaction: string; memberId: string | null; name: string }>>();
  for (const row of reactionRows) {
    const key = row.postId ? feedInteractionKey("post", row.postId) : feedInteractionKey("activity", row.activityId!);
    const list = reactionsByParent.get(key) ?? [];
    list.push({ reaction: row.reaction, memberId: row.memberId, name: memberName(row.member, row.externalReactorName) });
    reactionsByParent.set(key, list);
  }
  for (const [key, rows] of reactionsByParent) reactions[key] = summarizeFeedReactions(rows, ctx.memberId);

  return { comments, reactions, canRespond };
}

export type FeedInteractions = Awaited<ReturnType<typeof listFeedInteractions>>;

/** The post or entry being commented on or reacted to, if it is still in the feed. */
async function requireLiveParent(tx: Prisma.TransactionClient, ctx: BrowserOperationContext, parent: FeedParent) {
  const found = parent.parentKind === "post"
    ? await tx.feedPost.findFirst({ where: { id: parent.parentId, householdId: ctx.householdId, deletedAt: null }, select: { id: true } })
    : await tx.activityLog.findFirst({
        where: { id: parent.parentId, householdId: ctx.householdId, deletedAt: null, baby: { deletedAt: null } },
        select: { id: true }
      });
  if (!found) throw new Error("not_found");
}

function parentColumns(parent: FeedParent) {
  return parent.parentKind === "post"
    ? { postId: parent.parentId, activityId: null }
    : { postId: null, activityId: parent.parentId };
}

export async function issueFeedCommentCreateBrowserOperation(raw: Record<string, unknown>) {
  const parent = parseFeedParent(raw);
  const ctx = await getBrowserOperationContextForHousehold();
  return issueHouseholdBrowserOperation({
    ctx,
    operationId: raw.operationId,
    operationKey: BrowserOperationKey.feedCommentCreate,
    targetKind: parent.parentKind,
    targetId: parent.parentId,
    permission: "feed.comment",
    targetSnapshot: async (tx, lockedCtx) => {
      await requireLiveParent(tx, lockedCtx, parent);
      return { kind: "feed-comment-create", schemaVersion: 1, ...parent };
    }
  });
}

export async function submitFeedCommentCreateBrowserOperation(raw: Record<string, unknown>) {
  const parent = parseFeedParent(raw);
  const input = parseFeedCommentInput({ body: raw.body });
  const ctx = await getBrowserOperationContextForHousehold();
  return executeHouseholdBrowserOperation({
    ctx,
    operationId: raw.operationId,
    operationKey: BrowserOperationKey.feedCommentCreate,
    intent: { ...parent, ...input },
    targetKind: parent.parentKind,
    targetId: parent.parentId,
    permission: "feed.comment",
    validate: async (tx, lockedCtx, binding) => {
      const snapshot = parentSnapshotSchema("feed-comment-create").safeParse(binding.targetSnapshot);
      if (!snapshot.success || snapshot.data.parentKind !== parent.parentKind || snapshot.data.parentId !== parent.parentId) throw new Error("not_found");
      await requireLiveParent(tx, lockedCtx, parent);
    },
    execute: async (tx, lockedCtx) => {
      const comment = await tx.feedComment.create({
        data: { householdId: lockedCtx.householdId, ...parentColumns(parent), authorMemberId: lockedCtx.memberId, body: input.body },
        select: { id: true }
      });
      await writeAudit(lockedCtx, {
        action: "feed_comment.create",
        entityType: "feed_comment",
        entityId: comment.id,
        after: { parentKind: parent.parentKind }
      }, tx);
      return { kind: "feed_comment", code: "created", commentId: comment.id } as const;
    }
  });
}

/** The live comment, locked for the rest of the transaction, if this member may act on it. */
async function lockComment(
  tx: Prisma.TransactionClient,
  ctx: BrowserOperationContext,
  commentId: string,
  allowed: (role: HouseholdRoleName, isAuthor: boolean) => boolean
) {
  await tx.$queryRaw`SELECT "id" FROM "FeedComment" WHERE "id" = ${commentId} AND "householdId" = ${ctx.householdId} FOR UPDATE`;
  const comment = await tx.feedComment.findFirst({
    where: { id: commentId, householdId: ctx.householdId, deletedAt: null },
    select: { id: true, authorMemberId: true, updatedAt: true }
  });
  if (!comment) throw new Error("not_found");
  if (!allowed(ctx.role as HouseholdRoleName, comment.authorMemberId === ctx.memberId)) throw new Error("forbidden");
  return comment;
}

function issueCommentRevision(
  raw: Record<string, unknown>,
  operationKey: BrowserOperationKey,
  kind: "feed-comment-update" | "feed-comment-delete",
  allowed: (role: HouseholdRoleName, isAuthor: boolean) => boolean
) {
  const { commentId } = commentIdSchema.parse(raw);
  return getBrowserOperationContextForHousehold().then((ctx) => issueHouseholdBrowserOperation({
    ctx,
    operationId: raw.operationId,
    operationKey,
    targetKind: "comment",
    targetId: commentId,
    permission: "feed.comment",
    targetSnapshot: async (tx, lockedCtx) => {
      const comment = await lockComment(tx, lockedCtx, commentId, allowed);
      return { kind, schemaVersion: 1, commentId: comment.id, updatedAt: comment.updatedAt.toISOString() };
    }
  }));
}

export async function issueFeedCommentUpdateBrowserOperation(raw: Record<string, unknown>) {
  return issueCommentRevision(raw, BrowserOperationKey.feedCommentUpdate, "feed-comment-update", canEditFeedComment);
}

export async function issueFeedCommentDeleteBrowserOperation(raw: Record<string, unknown>) {
  return issueCommentRevision(raw, BrowserOperationKey.feedCommentDelete, "feed-comment-delete", canRemoveFeedComment);
}

export async function submitFeedCommentUpdateBrowserOperation(raw: Record<string, unknown>) {
  const { commentId } = commentIdSchema.parse(raw);
  const input = parseFeedCommentInput({ body: raw.body });
  const ctx = await getBrowserOperationContextForHousehold();
  return executeHouseholdBrowserOperation({
    ctx,
    operationId: raw.operationId,
    operationKey: BrowserOperationKey.feedCommentUpdate,
    intent: { commentId, ...input },
    targetKind: "comment",
    targetId: commentId,
    permission: "feed.comment",
    validate: async (tx, lockedCtx, binding) => {
      const snapshot = updateSnapshotSchema.safeParse(binding.targetSnapshot);
      if (!snapshot.success || snapshot.data.commentId !== commentId) throw new Error("not_found");
      const comment = await lockComment(tx, lockedCtx, commentId, canEditFeedComment);
      if (comment.updatedAt.toISOString() !== snapshot.data.updatedAt) throw new Error("stale_revision");
    },
    execute: async (tx, lockedCtx, binding) => {
      const snapshot = updateSnapshotSchema.parse(binding.targetSnapshot);
      const updated = await tx.feedComment.updateMany({
        where: { id: commentId, householdId: lockedCtx.householdId, deletedAt: null, updatedAt: new Date(snapshot.updatedAt) },
        data: { body: input.body, editedAt: new Date() }
      });
      if (updated.count !== 1) throw new Error("stale_revision");
      await writeAudit(lockedCtx, { action: "feed_comment.update", entityType: "feed_comment", entityId: commentId }, tx);
      return { kind: "feed_comment", code: "updated", commentId } as const;
    }
  });
}

export async function submitFeedCommentDeleteBrowserOperation(raw: Record<string, unknown>) {
  const { commentId } = commentIdSchema.parse(raw);
  const ctx = await getBrowserOperationContextForHousehold();
  return executeHouseholdBrowserOperation({
    ctx,
    operationId: raw.operationId,
    operationKey: BrowserOperationKey.feedCommentDelete,
    intent: { commentId },
    targetKind: "comment",
    targetId: commentId,
    permission: "feed.comment",
    validate: async (tx, lockedCtx, binding) => {
      const snapshot = deleteSnapshotSchema.safeParse(binding.targetSnapshot);
      if (!snapshot.success || snapshot.data.commentId !== commentId) throw new Error("not_found");
      const comment = await lockComment(tx, lockedCtx, commentId, canRemoveFeedComment);
      if (comment.updatedAt.toISOString() !== snapshot.data.updatedAt) throw new Error("stale_revision");
    },
    execute: async (tx, lockedCtx, binding) => {
      const snapshot = deleteSnapshotSchema.parse(binding.targetSnapshot);
      const removed = await tx.feedComment.updateMany({
        where: { id: commentId, householdId: lockedCtx.householdId, deletedAt: null, updatedAt: new Date(snapshot.updatedAt) },
        data: { deletedAt: new Date(), deletedByMemberId: lockedCtx.memberId }
      });
      if (removed.count !== 1) throw new Error("stale_revision");
      await writeAudit(lockedCtx, { action: "feed_comment.delete", entityType: "feed_comment", entityId: commentId }, tx);
      return { kind: "feed_comment", code: "deleted", commentId } as const;
    }
  });
}

export async function issueFeedReactionSetBrowserOperation(raw: Record<string, unknown>) {
  const parent = parseFeedParent(raw);
  const ctx = await getBrowserOperationContextForHousehold();
  return issueHouseholdBrowserOperation({
    ctx,
    operationId: raw.operationId,
    operationKey: BrowserOperationKey.feedReactionSet,
    targetKind: parent.parentKind,
    targetId: parent.parentId,
    permission: "feed.comment",
    targetSnapshot: async (tx, lockedCtx) => {
      await requireLiveParent(tx, lockedCtx, parent);
      return { kind: "feed-reaction-set", schemaVersion: 1, ...parent };
    }
  });
}

export async function submitFeedReactionSetBrowserOperation(raw: Record<string, unknown>) {
  const input = parseFeedReactionInput(raw);
  const parent = { parentKind: input.parentKind, parentId: input.parentId };
  const ctx = await getBrowserOperationContextForHousehold();
  return executeHouseholdBrowserOperation({
    ctx,
    operationId: raw.operationId,
    operationKey: BrowserOperationKey.feedReactionSet,
    intent: input,
    targetKind: input.parentKind,
    targetId: input.parentId,
    permission: "feed.comment",
    validate: async (tx, lockedCtx, binding) => {
      const snapshot = parentSnapshotSchema("feed-reaction-set").safeParse(binding.targetSnapshot);
      if (!snapshot.success || snapshot.data.parentKind !== parent.parentKind || snapshot.data.parentId !== parent.parentId) throw new Error("not_found");
      await requireLiveParent(tx, lockedCtx, parent);
    },
    execute: async (tx, lockedCtx) => {
      const mine = { householdId: lockedCtx.householdId, ...parentColumns(parent), memberId: lockedCtx.memberId, reaction: input.reaction };
      if (input.on) {
        const existing = await tx.feedReaction.findFirst({ where: mine, select: { id: true } });
        if (!existing) await tx.feedReaction.create({ data: mine, select: { id: true } });
      } else {
        await tx.feedReaction.deleteMany({ where: mine });
      }
      await writeAudit(lockedCtx, {
        action: "feed_reaction.set",
        entityType: parent.parentKind === "post" ? "feed_post" : "activity",
        entityId: parent.parentId,
        after: { reaction: input.reaction, on: input.on }
      }, tx);
      return { kind: "feed_reaction", code: "set", reaction: input.reaction, on: input.on } as const;
    }
  });
}
