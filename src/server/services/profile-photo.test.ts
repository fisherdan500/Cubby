/**
 * Your own profile picture, for the page that sets it.
 *
 * Scoped to the signed-in member's own membership in the household they are using. A picture
 * belongs to a membership rather than to a user, so someone in two households has an independent
 * picture in each, and this must never reach across to the other one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted above the file, so the spies have to be hoisted with it.
const { findFirst, getContext } = vi.hoisted(() => ({ findFirst: vi.fn(), getContext: vi.fn() }));

vi.mock("@/lib/db/prisma", () => ({ prisma: { attachment: { findFirst } } }));
vi.mock("@/server/auth/context", () => ({ getEffectiveHouseholdContext: getContext }));

import { getOwnProfilePhoto } from "./profile-photo";

beforeEach(() => {
  findFirst.mockReset();
  getContext.mockReset();
  getContext.mockResolvedValue({ householdId: "house-1", memberId: "member-1", userId: "user-1", role: "caretaker" });
});

describe("loading your own profile picture", () => {
  it("asks only for your own available picture in this household", async () => {
    findFirst.mockResolvedValue({ id: "att-1" });

    await getOwnProfilePhoto();

    // The household and the membership both constrain it: a picture is owned by a membership, so
    // the same person in another household must not see this one.
    expect(findFirst.mock.calls[0][0].where).toEqual({
      householdId: "house-1",
      memberId: "member-1",
      type: "user_photo",
      state: "available"
    });
  });

  it("gives back the attachment id when there is one", async () => {
    findFirst.mockResolvedValue({ id: "att-1" });
    expect(await getOwnProfilePhoto()).toEqual({ photoAttachmentId: "att-1" });
  });

  it("gives back nothing when the member has no picture", async () => {
    findFirst.mockResolvedValue(null);
    expect(await getOwnProfilePhoto()).toEqual({ photoAttachmentId: null });
  });

  it("does not ask for a retired picture", async () => {
    findFirst.mockResolvedValue(null);
    await getOwnProfilePhoto();
    // A replaced picture stays recoverable but is not yours any more.
    expect(findFirst.mock.calls[0][0].where.state).toBe("available");
  });
});
