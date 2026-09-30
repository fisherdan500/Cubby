/**
 * Serving a profile picture of a person.
 *
 * The delivery predicate is the one place where getting ownership wrong leaks a file, so these run
 * the REAL exported predicate rather than asserting a mock's arguments.
 *
 * The judgement call this pins: a DISABLED or REMOVED membership's picture stops being served, but a
 * merely inactive person's does not. A removed person's face should not keep appearing in the
 * household, and unlike a hidden baby there is no "still visible" flag to lean on - deletedAt and
 * disabledAt on the membership are what decide it.
 */
import { describe, expect, it } from "vitest";

import { servableAttachmentWhere } from "./attachments";

describe("which profile pictures may be served", () => {
  const where = servableAttachmentWhere("household-1", "att-1");

  it("scopes every branch to the household and the served state", () => {
    expect(where).toMatchObject({ id: "att-1", householdId: "household-1", state: "available" });
    // No cross-household read is possible regardless of which ownership branch matches.
    expect(where.householdId).toBe("household-1");
  });

  it("offers exactly three ownership branches", () => {
    // Feed, baby, member. A fourth or missing branch means an ownership kind is either unservable or
    // served without its own rule.
    expect(Array.isArray(where.OR)).toBe(true);
    expect(where.OR).toHaveLength(3);
  });

  it("keeps the feed branch exactly as it was", () => {
    // This slice must not loosen feed delivery. The branch still demands a post, a live post, and a
    // visible baby when the post names one.
    expect(where.OR).toContainEqual({
      postId: { not: null },
      post: { deletedAt: null, OR: [{ babyId: null }, { baby: { deletedAt: null } }] }
    });
  });

  it("keeps the baby branch exactly as it was", () => {
    expect(where.OR).toContainEqual({ postId: null, type: "baby_photo", baby: { deletedAt: null } });
  });

  it("serves a user photo only for a live, enabled membership", () => {
    // disabledAt and deletedAt both null: a removed or suspended person's picture stops being
    // served. postId null keeps it disjoint from the feed branch.
    expect(where.OR).toContainEqual({
      postId: null,
      type: "user_photo",
      member: { deletedAt: null, disabledAt: null }
    });
  });

  it("never serves a user photo through a post relation", () => {
    // If the user branch omitted postId: null it would overlap the feed branch, and a member photo
    // wrongly carrying a postId would become servable by the wrong rule.
    const userBranch = (where.OR as Record<string, unknown>[]).find((branch) => branch.type === "user_photo");
    expect(userBranch).toBeDefined();
    expect(userBranch!.postId).toBeNull();
  });

  it("requires an owner on every non-feed branch, so a staged upload is never served", () => {
    // A staged row has no owner at all. Each non-feed branch names its owner relation, so staging
    // cannot satisfy any of them.
    const branches = where.OR as Record<string, unknown>[];
    for (const branch of branches.filter((candidate) => candidate.postId === null)) {
      const ownerKeys = Object.keys(branch).filter((key) => key === "baby" || key === "member");
      expect(ownerKeys).toHaveLength(1);
    }
  });
});
