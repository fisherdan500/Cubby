import { z } from "zod";
import { hasPermission, type HouseholdRoleName } from "@/domain/roles";

/**
 * A text post in the family feed (DEC-PROD-421): a caption about one baby or the whole family, with
 * #tags taken from the text itself so there is nothing extra to fill in. Photos join later, behind the
 * attachment gate.
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

/** Family-written feed text - a caption or a comment: trimmed, never empty, at most `max` long. */
export function feedTextSchema(max: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(max)
    // Line breaks are fine in a caption; other control characters are not.
    .refine((value) => !/[\u0000-\u0009\u000b-\u001f\u007f]/.test(value));
}

const inputSchema = z.object({
  body: feedTextSchema(FEED_POST_MAX_LENGTH),
  babyId: z.string().min(1).max(200).nullable()
});

export function parseFeedPostInput(raw: unknown) {
  const { body, babyId } = inputSchema.parse(raw);
  return { body, babyId, tags: feedPostTags(body) };
}

export type FeedPostInput = ReturnType<typeof parseFeedPostInput>;

/** An edit changes the caption only; who the post is about stays as it was shared. */
export function parseFeedPostEdit(raw: unknown) {
  const { body } = z.object({ body: feedTextSchema(FEED_POST_MAX_LENGTH) }).parse(raw);
  return { body, tags: feedPostTags(body) };
}

/** Only the author edits a post, and only while their role still lets them post. */
export function canEditFeedPost(role: HouseholdRoleName, isAuthor: boolean) {
  return isAuthor && hasPermission(role, "feed.post");
}

/** An author may remove their own post; owners, admins and parents may remove any. */
export function canRemoveFeedPost(role: HouseholdRoleName, isAuthor: boolean) {
  return hasPermission(role, "feed.moderate") || (isAuthor && hasPermission(role, "feed.post"));
}
