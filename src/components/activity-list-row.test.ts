// @vitest-environment jsdom
import React, { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ href, children, replace: _replace, prefetch: _prefetch, ...props }: Record<string, unknown>) =>
    createElement("a", { href, ...props }, children as React.ReactNode)
}));
vi.mock("@/components/swipe-row-actions", () => ({
  SwipeRowActions: ({ editHref, canDelete, children }: { editHref?: string; canDelete: boolean; children: React.ReactNode }) =>
    createElement("div", { "data-testid": "swipe", "data-edit": editHref ?? "", "data-delete": String(canDelete) }, children)
}));

import { ActivityListRow } from "@/components/activity-list-row";
import { activityEditHref } from "@/lib/activity-navigation";

globalThis.React = React;
afterEach(cleanup);

const activity = { id: "activity-1", type: "note", occurredAt: new Date("2026-09-24T12:00:00Z"), note: { text: "Hello" } } as never;

function renderRow(actions?: { canUpdate: boolean; canDelete: boolean }) {
  render(createElement(ActivityListRow, { activity, returnTo: "/app?babyId=baby-1", timeZone: "UTC", volume: "oz", actions }));
}

describe("ActivityListRow", () => {
  it("is a plain link where the member can change nothing", () => {
    renderRow({ canUpdate: false, canDelete: false });
    expect(screen.queryByTestId("swipe")).toBeNull();
    renderRow();
    expect(screen.queryByTestId("swipe")).toBeNull();
  });

  it("can be swiped for the actions the member is allowed, returning to the same list", () => {
    renderRow({ canUpdate: true, canDelete: false });
    const swipe = screen.getByTestId("swipe");
    expect(swipe.getAttribute("data-edit")).toBe(activityEditHref("activity-1", "/app?babyId=baby-1"));
    expect(swipe.getAttribute("data-delete")).toBe("false");
    expect(swipe.querySelector("a")?.getAttribute("href")).toContain("/app/activities/activity-1");
  });
});
