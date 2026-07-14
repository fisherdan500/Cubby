import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));

vi.stubGlobal("React", React);
const source = readFileSync(new URL("./calendar-drawer-shell.tsx", import.meta.url), "utf8");

describe("CalendarDrawerShell", () => {
  it("renders a labelled modal dialog with a non-tabbable backdrop", async () => {
    const { CalendarDrawerShell } = await import("@/components/calendar-drawer-shell");
    const html = renderToStaticMarkup(
      React.createElement(
        CalendarDrawerShell,
        {
          closeHref: "/app/calendar",
          restoreFocusSelector: '[data-calendar-day="2026-07-14"]',
          focusKey: "2026-07-14:summary"
        },
        React.createElement(
          "h2",
          { id: "calendar-drawer-title", tabIndex: -1, "data-calendar-drawer-heading": true },
          "July 14"
        )
      )
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="calendar-drawer-title"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('class="fixed inset-0 z-40"');
    expect(html).not.toContain("md:left-64");
  });

  it("wraps Shift+Tab from the initially focused heading", () => {
    expect(source).toContain("document.activeElement === heading");
  });

  it("refocuses the heading when the drawer content mode changes", () => {
    expect(source).toContain("[focusKey]");
  });

  it("restores the actual opener or the route-provided fallback across drawer remounts", () => {
    expect(source).toContain("restoreTargetRef");
    expect(source).toContain("fallbackSelectorRef");
    expect(source).toContain("document.activeElement instanceof HTMLElement");
    expect(source).toContain("document.activeElement !== document.body");
    expect(source).toContain('activeOpener?.matches("[data-calendar-add-event]")');
    expect(source).toContain("requestAnimationFrame");
  });
});