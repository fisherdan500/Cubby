/**
 * Reading a baby's profile picture for display.
 *
 * Storing and claiming a picture is useless if no read path returns it, so this covers the shape
 * the UI depends on: each baby carries the id of its current picture, and only the current one.
 * A retired picture inside its recovery window must not come back, or removing a photo would
 * appear to do nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  getEffectiveHouseholdContext: vi.fn(),
  requirePermission: vi.fn()
}));

vi.mock("@/lib/db/prisma", () => ({ prisma: { baby: { findMany: mocks.findMany } } }));

vi.mock("@/server/auth/context", () => ({
  getEffectiveHouseholdContext: mocks.getEffectiveHouseholdContext,
  requirePermission: mocks.requirePermission
}));

const { listBabies } = await import("@/server/services/households");

describe("listing babies with their pictures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getEffectiveHouseholdContext.mockResolvedValue({ householdId: "household-1", memberId: "member-1" });
    mocks.requirePermission.mockReturnValue(undefined);
    mocks.findMany.mockResolvedValue([]);
  });

  it("asks only for the picture that is currently served", async () => {
    await listBabies();

    const query = mocks.findMany.mock.calls[0][0];
    expect(query.include?.attachments ?? query.select?.attachments).toBeDefined();
    const attachments = (query.include ?? query.select).attachments;
    // available excludes both a staged upload nobody claimed and a retired one still inside its
    // thirty-day recovery window.
    expect(attachments.where).toMatchObject({ type: "baby_photo", state: "available" });
    // Only the id is needed to build a URL; bytes and digests must not ride along on a list read.
    expect(attachments.select).toEqual({ id: true });
  });

  it("gives each baby its own picture id, and null when it has none", async () => {
    mocks.findMany.mockResolvedValue([
      { id: "baby-1", name: "One", attachments: [{ id: "att-1" }] },
      { id: "baby-2", name: "Two", attachments: [] }
    ]);

    const babies = await listBabies();

    expect(babies).toMatchObject([
      { id: "baby-1", photoAttachmentId: "att-1" },
      { id: "baby-2", photoAttachmentId: null }
    ]);
  });

  it("does not leak the raw attachment rows to the client", async () => {
    // The UI needs an id, not an attachment record; leaving the relation on the response would ship
    // storage details into the browser.
    mocks.findMany.mockResolvedValue([{ id: "baby-1", name: "One", attachments: [{ id: "att-1" }] }]);

    const [baby] = await listBabies();

    expect(baby).not.toHaveProperty("attachments");
  });
});
