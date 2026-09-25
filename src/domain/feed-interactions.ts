import { z } from "zod";
import { feedTextSchema } from "@/domain/feed-post";
import { hasPermission, type HouseholdRoleName } from "@/domain/roles";

/**
 * Comments and reactions in the family feed (DEC-PROD-421). Every member may comment and react, on a
 * post or on a logged entry; a comment never changes the entry itself. Reactions show who reacted, by
 * name - never a number - so nothing in the feed becomes a score.
 */

export const FEED_COMMENT_MAX_LENGTH = 1000;

export const feedReactions = [
  { key: "love", emoji: "❤️", label: "love" },
  { key: "funny", emoji: "😂", label: "funny" },
  // Smiling face with hearts (Emoji 11, 2018): the first choice, face holding back tears (Emoji 14,
  // 2021), showed as an empty box on phones without it. Stored reactions keep the key, not the face.
  { key: "aww", emoji: "🥰", label: "aww" },
  { key: "celebrate", emoji: "🎉", label: "celebrate" },
  { key: "well_done", emoji: "👏", label: "well done" }
] as const;

export type FeedReactionKey = (typeof feedReactions)[number]["key"];
export const feedReactionKeys = feedReactions.map((reaction) => reaction.key) as [FeedReactionKey, ...FeedReactionKey[]];

export const feedParentKinds = ["post", "activity"] as const;
export type FeedParentKind = (typeof feedParentKinds)[number];

const parentSchema = z.object({
  parentKind: z.enum(feedParentKinds),
  parentId: z.string().min(1).max(200)
});

/** What a comment or reaction belongs to: a family post, or a logged entry. */
export function parseFeedParent(raw: unknown) {
  const { parentKind, parentId } = parentSchema.parse(raw);
  return { parentKind, parentId };
}

export type FeedParent = ReturnType<typeof parseFeedParent>;

export function parseFeedCommentInput(raw: unknown) {
  const { body } = z.object({ body: feedTextSchema(FEED_COMMENT_MAX_LENGTH) }).parse(raw);
  return { body };
}

/** A reaction is set on or off rather than toggled, so a retried request lands the same way twice. */
export function parseFeedReactionInput(raw: unknown) {
  const { parentKind, parentId, reaction, on } = parentSchema
    .extend({ reaction: z.enum(feedReactionKeys), on: z.boolean() })
    .parse(raw);
  return { parentKind, parentId, reaction, on };
}

/** Only the author edits a comment. */
export function canEditFeedComment(role: HouseholdRoleName, isAuthor: boolean) {
  return isAuthor && hasPermission(role, "feed.comment");
}

/** The author removes their own comment; owners, admins and parents may remove any. */
export function canRemoveFeedComment(role: HouseholdRoleName, isAuthor: boolean) {
  return hasPermission(role, "feed.moderate") || (isAuthor && hasPermission(role, "feed.comment"));
}

export type FeedReactionSummary = {
  key: FeedReactionKey;
  emoji: string;
  label: string;
  names: string[];
  mine: boolean;
};

/**
 * The reactions on one post or entry, in the fixed order, each with the names of who chose it - the
 * viewer first, as "You". Reactions nobody chose are left out.
 */
export function summarizeFeedReactions(
  rows: Array<{ reaction: string; memberId: string | null; name: string }>,
  viewerMemberId: string
): FeedReactionSummary[] {
  return feedReactions.flatMap((reaction) => {
    const chosen = rows.filter((row) => row.reaction === reaction.key);
    if (chosen.length === 0) return [];
    const mine = chosen.some((row) => row.memberId === viewerMemberId);
    const others = chosen.filter((row) => row.memberId !== viewerMemberId).map((row) => row.name);
    return [{ ...reaction, names: mine ? ["You", ...others] : others, mine }];
  });
}

/** "Sam", "You and Alex", "You, Alex and Grandma". */
export function joinNames(names: string[]) {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
