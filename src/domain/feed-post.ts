import { z } from "zod";
import { hasPermission, type HouseholdRoleName } from "@/domain/roles";

/**
 * A post in the family feed (DEC-PROD-421): a caption about one baby or the whole family, with #tags
 * taken from the text itself so there is nothing extra to fill in, and up to ten photos
 * (DEC-PROD-422). A post needs words or at least one photo.
 */

export const FEED_POST_MAX_LENGTH = 2000;
const MAX_TAGS = 20;

// A tag starts a word: "#firsts" counts, "page.html#section" does not.
const TAG_PATTERN = /(^|\s)#([\p{L}\p{N}_]{1,40})/gu;

export function feedPostTags(body: string) {
  const tags: string[] = [];
  for (const match of body.matchAll(TAG_PATTERN)) {
    const tag = match[2].toLowerCase();
    if (!tags.includes(tag)) tags.push(tag);
    if (tags.length === MAX_TAGS) break;
  }
  return tags;
}

/**
 * Family-written feed text - a caption or a comment: trimmed, at most `max` long, and not empty
 * unless something else (a post's photos) carries it.
 */
export function feedTextSchema(max: number, options: { allowEmpty?: boolean } = {}) {
  return z
    .string()
    .trim()
    .min(options.allowEmpty ? 0 : 1)
    .max(max)
    // Line breaks are fine in a caption; other control characters are not.
    .refine((value) => !/[\u0000-\u0009\u000b-\u001f\u007f]/.test(value));
}

export const FEED_POST_MAX_PHOTOS = 10;

const attachmentIdsSchema = z
  .array(z.string().min(1).max(200))
  .max(FEED_POST_MAX_PHOTOS)
  .refine((ids) => new Set(ids).size === ids.length)
  .default([]);

const inputSchema = z.object({
  body: feedTextSchema(FEED_POST_MAX_LENGTH, { allowEmpty: true }),
  babyId: z.string().min(1).max(200).nullable(),
  attachmentIds: attachmentIdsSchema
}).refine((input) => input.body.length > 0 || input.attachmentIds.length > 0, { message: "feed_post_empty" });

export function parseFeedPostInput(raw: unknown) {
  const { body, babyId, attachmentIds } = inputSchema.parse(raw);
  return { body, babyId, tags: feedPostTags(body), attachmentIds };
}

export type FeedPostInput = ReturnType<typeof parseFeedPostInput>;

/**
 * An edit changes the caption only; who the post is about and its photos stay as they were shared.
 * A post with photos may have its caption cleared; one without must keep some words.
 */
export function parseFeedPostEdit(raw: unknown, options: { hasPhotos?: boolean } = {}) {
  const { body } = z.object({ body: feedTextSchema(FEED_POST_MAX_LENGTH, { allowEmpty: options.hasPhotos }) }).parse(raw);
  return { body, tags: feedPostTags(body) };
}

/** A removed post, and its photos, can be brought back for thirty days (DEC-PROD-146). */
export const FEED_POST_RECOVERY_MS = 30 * 24 * 60 * 60 * 1000;

export function feedPostRestorable(deletedAt: Date, now: Date) {
  return now.getTime() < deletedAt.getTime() + FEED_POST_RECOVERY_MS;
}

/** Only the author edits a post, and only while their role still lets them post. */
export function canEditFeedPost(role: HouseholdRoleName, isAuthor: boolean) {
  return isAuthor && hasPermission(role, "feed.post");
}

/** An author may remove their own post; owners, admins and parents may remove any. */
export function canRemoveFeedPost(role: HouseholdRoleName, isAuthor: boolean) {
  return hasPermission(role, "feed.moderate") || (isAuthor && hasPermission(role, "feed.post"));
}
