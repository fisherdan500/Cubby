// @vitest-environment jsdom
import React, { createElement, Fragment } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
import { BabyLifecycleButton } from "@/components/actions/baby-lifecycle-button";
import { MemberAccessManager } from "@/components/settings/member-access-manager";

globalThis.React = React;
beforeEach(() => { vi.spyOn(window, "confirm").mockReturnValue(false); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("durable lifecycle browser-operation clients", () => {
  it("mounts reversible baby lifecycle controls", () => {
    render(createElement(Fragment, null,
      createElement(BabyLifecycleButton, { babyId: "baby-a", babyName: "Avery", inactive: false }),
      createElement(BabyLifecycleButton, { babyId: "baby-b", babyName: "Blake", inactive: true })
    ));
    expect(screen.getByRole("button", { name: "Deactivate" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reactivate" })).toBeTruthy();
  });

  it("mounts member and invitation administration and honors cancellation", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    render(createElement(MemberAccessManager, {
      viewerRole: "owner",
      members: [
        { id: "owner", name: "Owner", email: "owner@example.com", role: "owner", disabledAt: null },
        { id: "member", name: "Jordan", email: "jordan@example.com", role: "parent", disabledAt: null }
      ],
      invites: [{ id: "invite", email: "invitee@example.com", role: "parent", expiresAt: "2030-01-01T00:00:00.000Z" }],
      timeZone: "UTC"
    }));

    await userEvent.click(screen.getByRole("button", { name: "Suspend" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Revoke" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Revoke all pending invitations" })).toBeTruthy();
  });
});
