/**
 * What a member looks like before they have a picture.
 *
 * Most members will never upload one, so the fallback is the common case, not the edge case. It has
 * to be stable and recognisable: the same person always gets the same initials, and a name Cubby
 * cannot read still produces something rather than an empty circle.
 */
import { describe, expect, it } from "vitest";

import { memberInitials } from "./member-identity";

describe("the initials shown when a member has no picture", () => {
  it("takes the first letter of the first and last name", () => {
    expect(memberInitials("Avery Fisher")).toBe("AF");
  });

  it("uses one letter for a single name", () => {
    expect(memberInitials("Avery")).toBe("A");
  });

  it("skips middle names, so initials stay two letters", () => {
    expect(memberInitials("Avery Jane Fisher")).toBe("AF");
  });

  it("ignores extra spacing", () => {
    expect(memberInitials("  Avery   Fisher  ")).toBe("AF");
  });

  it("upper-cases what it finds", () => {
    expect(memberInitials("avery fisher")).toBe("AF");
  });

  it("falls back to a person mark when there is no name at all", () => {
    // An empty circle reads as broken; this reads as "someone".
    expect(memberInitials("")).toBe("?");
    expect(memberInitials("   ")).toBe("?");
  });

  it("keeps a non-latin name rather than discarding it", () => {
    // Cubby is used by whoever is in the household, and a name it cannot transliterate is still
    // that person's name.
    expect(memberInitials("李 明")).toBe("李明");
  });

  it("handles a name that is punctuation only", () => {
    expect(memberInitials("...")).toBe("?");
  });
});
