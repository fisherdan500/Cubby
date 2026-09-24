import { describe, expect, it } from "vitest";
import { activityRowActions } from "@/lib/activity-row-actions";

describe("activityRowActions", () => {
  it("offers a row's Edit and Delete exactly where its detail page would", () => {
    const own = { actorMemberId: "member-1" };
    const theirs = { actorMemberId: "member-2" };

    expect(activityRowActions({ memberId: "member-1", role: "parent" }, theirs)).toEqual({ canUpdate: true, canDelete: true });
    expect(activityRowActions({ memberId: "member-1", role: "read_only" }, own)).toEqual({ canUpdate: false, canDelete: false });
    // A caretaker may change what they recorded themselves, and nothing anyone else did.
    expect(activityRowActions({ memberId: "member-1", role: "caretaker" }, own)).toEqual({ canUpdate: true, canDelete: true });
    expect(activityRowActions({ memberId: "member-1", role: "caretaker" }, theirs)).toEqual({ canUpdate: false, canDelete: false });
  });
});
