// @vitest-environment jsdom
import React, { createElement } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ pathname: "/app" }));
vi.mock("next/navigation", () => ({ usePathname: () => navigation.pathname }));
vi.mock("@/components/sign-out-button", () => ({
  SignOutButton: () => createElement("button", { type: "button" }, "Sign out")
}));
vi.mock("@/components/theme-toggle", () => ({
  ThemeToggle: () => createElement("button", { type: "button" }, "Toggle theme")
}));

import { MobileBottomNav } from "@/components/mobile-bottom-nav";
import type { HouseholdRoleName } from "@/domain/roles";

globalThis.React = React;

afterEach(() => {
  cleanup();
  navigation.pathname = "/app";
});

function renderNav(role?: HouseholdRoleName) {
  render(createElement(MobileBottomNav, { selectedBabyId: "baby-1", userName: "Parent", role }));
  return screen.getByRole("button", { name: "More" });
}

describe("MobileBottomNav", () => {
  it("keeps four tabs, with Moments in place of Full Log, and moves the rest behind More", async () => {
    const more = renderNav();
    for (const label of ["Log", "Moments", "Calendar", "Reports"]) {
      expect(screen.getByRole("link", { name: label }).getAttribute("href")).toContain("babyId=baby-1");
    }
    expect(screen.queryByRole("link", { name: "Full Log" })).toBeNull();

    await userEvent.click(more);

    expect(more.getAttribute("aria-expanded")).toBe("true");
    // The feed is meant to replace the Full Log in time (DEC-PROD-421); until then it is one tap further.
    expect(screen.getByRole("link", { name: "Full Log" }).getAttribute("href")).toBe("/app/history?babyId=baby-1");
    expect(screen.getByRole("link", { name: "Settings" }).getAttribute("href")).toBe("/app/settings");
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    // Nursery is retired: it duplicated Log Entry once dark became the default.
    expect(screen.queryByRole("link", { name: "Nursery" })).toBeNull();
  });

  it("moves focus into the sheet on open and back to More on Escape", async () => {
    const more = renderNav();
    await userEvent.click(more);
    expect(document.activeElement).toBe(screen.getByRole("link", { name: "Full Log" }));

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: "More" })).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  it("stays open for a tap on one of its items on an iPhone, where the tap moves focus nowhere", async () => {
    const more = renderNav();
    await userEvent.click(more);
    const settings = screen.getByRole("link", { name: "Settings" });

    // Safari on iPhone does not focus a tapped link or button: the tap only takes focus away from the
    // item focused when the sheet opened, with nothing receiving it.
    act(() => {
      settings.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      (document.activeElement as HTMLElement).dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
    });

    expect(screen.getByRole("group", { name: "More" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Settings" }).getAttribute("href")).toBe("/app/settings");
  });

  it("closes when focus leaves the sheet", async () => {
    const more = renderNav();
    await userEvent.click(more);
    expect(screen.getByRole("group", { name: "More" })).toBeTruthy();

    const outside = document.createElement("button");
    document.body.append(outside);
    act(() => outside.focus());

    expect(screen.queryByRole("group", { name: "More" })).toBeNull();
    outside.remove();
  });

  it("marks More as the current place on the pages it holds", () => {
    for (const pathname of ["/app/settings/units", "/app/history"]) {
      navigation.pathname = pathname;
      const more = renderNav();
      expect(more.className).toContain("text-primary");
      cleanup();
    }
  });

  it("marks the Moments tab current on Moments", () => {
    navigation.pathname = "/app/moments";
    renderNav();
    expect(screen.getByRole("link", { name: "Moments" }).getAttribute("href")).toBe("/app/moments?babyId=baby-1");
    expect(screen.getByRole("link", { name: "Moments" }).getAttribute("aria-current")).toBe("page");
    // "Feed" means feeding the baby; no tab uses it for anything else.
    expect(screen.queryByRole("link", { name: "Feed" })).toBeNull();
  });
});

describe("what a relative's bottom bar shows", () => {
  // A phone has no sidebar: this bar is the only chrome. These assert the rendered DOM rather than
  // the source text -- an earlier version grepped for the identifiers `canSeeFullLog` and
  // `gridColumns`, which a mutation could satisfy while changing what every tab decided.
  it("gives a relative only Moments, and keeps the entry form away", () => {
    renderNav("read_only");
    expect(screen.queryByRole("link", { name: /Moments/ })).not.toBeNull();
    expect(screen.queryByRole("link", { name: /^Log$/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /Calendar/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /Reports/ })).toBeNull();
  });

  it("leaves a caretaker's bar complete", () => {
    renderNav("caretaker");
    for (const name of [/^Log$/, /Moments/, /Calendar/, /Reports/]) {
      expect(screen.queryByRole("link", { name }), String(name)).not.toBeNull();
    }
  });

  it("sizes the grid to the tabs it actually renders, leaving no dead cells", () => {
    // With the Log, Calendar and Reports tabs gone, a hardcoded five-column grid would leave three
    // visible gaps in a relative's bar.
    const { container } = render(
      createElement(MobileBottomNav, { selectedBabyId: "baby-1", userName: "Parent", role: "read_only" as HouseholdRoleName })
    );
    const grid = container.querySelector("nav > div");
    const tabCount = grid?.querySelectorAll("a").length ?? 0;
    // Tabs plus the More button.
    expect(grid?.className).toContain(`grid-cols-${tabCount + 1}`);
    expect(grid?.className).not.toContain("grid-cols-5");
  });

  it("drops Full Log from a relative's More sheet", async () => {
    const user = userEvent.setup();
    const more = renderNav("read_only");
    await act(async () => {
      await user.click(more);
    });
    expect(screen.queryByRole("link", { name: /Full Log/ })).toBeNull();
  });

  it("keeps Full Log in a caretaker's More sheet", async () => {
    const user = userEvent.setup();
    const more = renderNav("caretaker");
    await act(async () => {
      await user.click(more);
    });
    expect(screen.queryByRole("link", { name: /Full Log/ })).not.toBeNull();
  });
});
