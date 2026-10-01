/**
 * Which logged entry a photo post belongs to.
 *
 * Almost every post belongs to no entry; a post created by adding a photo to an entry carries that
 * entry's id. Only the shape is settled here -- that the entry exists, is not deleted, and is in the
 * caller's household is checked inside the write transaction, where the household is locked.
 */

/**
 * The entry id a post should be linked to, or null for an ordinary post.
 *
 * @throws when the value is present but not a string, so a crafted payload fails rather than being
 * silently coerced.
 */
export function parseFeedPostActivityLink(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw new Error("invalid");
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}
