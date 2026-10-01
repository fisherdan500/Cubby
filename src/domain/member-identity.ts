/**
 * How a member is shown when they have no picture.
 *
 * Most members never upload one, so this is the ordinary case rather than a fallback nobody sees.
 */

/**
 * One or two initials for a member's name.
 *
 * The first and last name give two letters; a single name gives one. A name written in a script
 * with no case, or one Cubby cannot split into words, keeps its own characters rather than being
 * discarded -- the household is whoever is in it. A name with nothing readable gets "?", because an
 * empty circle reads as something broken rather than as a person.
 */
export function memberInitials(name: string): string {
  const words = name
    .split(/\s+/)
    .map((word) => Array.from(word).filter((character) => /\p{L}|\p{N}/u.test(character)))
    .filter((characters) => characters.length > 0);

  if (words.length === 0) return "?";
  const first = words[0][0];
  const last = words.length > 1 ? words[words.length - 1][0] : "";
  return `${first}${last}`.toUpperCase();
}
