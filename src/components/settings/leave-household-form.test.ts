import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import {
  beginLeaveSubmission,
  finishLeaveSubmission,
  LeaveHouseholdForm
} from "@/components/settings/leave-household-form";

globalThis.React = React;

const preview = {
  householdId: "household-1",
  householdName: "River House",
  membershipId: "member-1",
  role: "admin" as const,
  suspended: false,
  protectedOwner: false,
  warnings: ["sole_admin", "active_timers", "pending_invitations", "notification_authority"] as const
};

describe("LeaveHouseholdForm", () => {
  it("shows supported source warnings, exact-name confirmation, and re-entry boundaries", () => {
    const html = renderToStaticMarkup(createElement(LeaveHouseholdForm, { preview }));
    const text = html.toLowerCase();

    expect(text).toContain("only remaining administrator");
    expect(text).toContain("running or paused timers");
    expect(text).toContain("pending invitations");
    expect(text).toContain("browser notification");
    expect(html).toContain("River House");
    expect(html).toContain('name="confirmation"');
    expect(html).toContain("Type the household name exactly");
    expect(html).toContain("new invitation");
    expect(html).toContain("Sign in again");
    expect(html).toContain("Leave household");
  });

  it("fails closed in the UI for the protected owner", () => {
    const html = renderToStaticMarkup(createElement(LeaveHouseholdForm, {
      preview: { ...preview, role: "owner", protectedOwner: true, warnings: [] }
    }));

    expect(html).toContain("transfer ownership");
    expect(html).not.toContain('name="confirmation"');
    expect(html).not.toContain("Leave household</button>");
  });

  it("synchronously suppresses duplicate submits and persists one operation identity across remounts", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value)
    };
    const create = vi.fn().mockReturnValueOnce("operation-1").mockReturnValue("operation-2");
    const firstMount = { busy: false };

    expect(beginLeaveSubmission(firstMount, "member-1", storage, create)).toBe("operation-1");
    expect(beginLeaveSubmission(firstMount, "member-1", storage, create)).toBeNull();
    finishLeaveSubmission(firstMount);

    const remount = { busy: false };
    expect(beginLeaveSubmission(remount, "member-1", storage, create)).toBe("operation-1");
    expect(create).toHaveBeenCalledOnce();
  });
});
