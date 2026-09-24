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

globalThis.React = React;

afterEach(() => {
  cleanup();
  navigation.pathname = "/app";
});

function renderNav() {
  render(createElement(MobileBottomNav, { selectedBabyId: "baby-1", userName: "Parent" }));
  return screen.getByRole("button", { name: "More" });
}

describe("MobileBottomNav", () => {
  it("keeps four tabs and moves Settings, appearance and sign-out behind More", async () => {
    const more = renderNav();
    for (const label of ["Log", "Full Log", "Calendar", "Reports"]) {
      expect(screen.getByRole("link", { name: label }).getAttribute("href")).toContain("babyId=baby-1");
    }

    await userEvent.click(more);

    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("link", { name: "Settings" }).getAttribute("href")).toBe("/app/settings");
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    // Nursery is retired: it duplicated Log Entry once dark became the default.
    expect(screen.queryByRole("link", { name: "Nursery" })).toBeNull();
  });

  it("moves focus into the sheet on open and back to More on Escape", async () => {
    const more = renderNav();
    await userEvent.click(more);
    expect(document.activeElement).toBe(screen.getByRole("link", { name: "Settings" }));

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: "More" })).toBeNull();
    expect(document.activeElement).toBe(more);
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
    navigation.pathname = "/app/settings/units";
    const more = renderNav();
    expect(more.className).toContain("text-primary");
  });
});
