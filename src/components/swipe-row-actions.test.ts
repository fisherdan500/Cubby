// @vitest-environment jsdom
import React, { createElement, Fragment } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, replace: _replace, prefetch: _prefetch, ...props }: Record<string, unknown>) =>
    createElement("a", { href, ...props }, children as React.ReactNode)
}));

import { SwipeRowActions } from "@/components/swipe-row-actions";

globalThis.React = React;
afterEach(cleanup);

// jsdom has no PointerEvent, and without one fireEvent drops the coordinates and pointer type. This
// carries exactly the fields the gesture reads, on top of MouseEvent's clientX/clientY.
if (!("PointerEvent" in window)) {
  class TestPointerEvent extends MouseEvent {
    pointerId: number;
    pointerType: string;
    isPrimary: boolean;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
      this.pointerType = init.pointerType ?? "";
      this.isPrimary = init.isPrimary ?? false;
    }
  }
  Object.defineProperty(window, "PointerEvent", { value: TestPointerEvent, configurable: true });
}

function row(id: string, options: { editHref?: string; canDelete?: boolean } = { editHref: `/app/activities/${id}/edit`, canDelete: true }) {
  return createElement(
    SwipeRowActions,
    { key: id, id, returnTo: "/app", editHref: options.editHref, canDelete: options.canDelete ?? false },
    createElement("a", { href: `/app/activities/${id}` }, `Feeding ${id}`)
  );
}

function swipe(target: Element, from: { x: number; y: number }, to: { x: number; y: number }, pointerType = "touch") {
  fireEvent.pointerDown(target, { pointerId: 1, pointerType, clientX: from.x, clientY: from.y, isPrimary: true });
  fireEvent.pointerMove(target, { pointerId: 1, pointerType, clientX: (from.x + to.x) / 2, clientY: (from.y + to.y) / 2 });
  fireEvent.pointerMove(target, { pointerId: 1, pointerType, clientX: to.x, clientY: to.y });
  fireEvent.pointerUp(target, { pointerId: 1, pointerType, clientX: to.x, clientY: to.y });
}

const content = (id = "a") => screen.getByRole("link", { name: `Feeding ${id}` });

/** Whether a tap would open the entry. The navigation itself is stopped here; jsdom cannot perform it. */
function tapOpensEntry(target: Element) {
  let opened = false;
  const listener = (event: Event) => {
    opened = !event.defaultPrevented;
    event.preventDefault();
  };
  document.addEventListener("click", listener);
  fireEvent.click(target);
  document.removeEventListener("click", listener);
  return opened;
}

describe("SwipeRowActions", () => {
  it("keeps Edit and Delete out of reach until the row is swiped", () => {
    render(row("a"));
    expect(screen.queryByRole("link", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("reveals Edit and Delete on a leftward swipe, without opening the entry", () => {
    render(row("a"));
    swipe(content(), { x: 300, y: 20 }, { x: 150, y: 24 });

    expect(screen.getByRole("link", { name: "Edit" }).getAttribute("href")).toBe("/app/activities/a/edit");
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
    // The click that ends a swipe is not a tap on the entry.
    expect(tapOpensEntry(content())).toBe(false);
  });

  it("springs back from a short swipe", () => {
    render(row("a"));
    swipe(content(), { x: 300, y: 20 }, { x: 280, y: 20 });
    expect(screen.queryByRole("link", { name: "Edit" })).toBeNull();
  });

  it("never swallows a later tap when the browser sent no click at the end of a swipe", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    render(row("a"));
    swipe(content(), { x: 300, y: 20 }, { x: 280, y: 20 }); // springs back; no click follows

    now.mockReturnValue(5_000);
    expect(tapOpensEntry(content())).toBe(true);
    now.mockRestore();
  });

  it("leaves a vertical drag to scroll the list", () => {
    render(row("a"));
    swipe(content(), { x: 300, y: 20 }, { x: 240, y: 200 });
    expect(screen.queryByRole("link", { name: "Edit" })).toBeNull();
    expect(tapOpensEntry(content())).toBe(true);
  });

  it("ignores a mouse drag, where the entry's own page already has Edit and Delete", () => {
    render(row("a"));
    swipe(content(), { x: 300, y: 20 }, { x: 150, y: 20 }, "mouse");
    expect(screen.queryByRole("link", { name: "Edit" })).toBeNull();
  });

  it("closes on a tap of the open row rather than opening the entry", () => {
    render(row("a"));
    swipe(content(), { x: 300, y: 20 }, { x: 150, y: 20 });
    tapOpensEntry(content()); // the click that ends the swipe

    expect(tapOpensEntry(content())).toBe(false);
    expect(screen.queryByRole("link", { name: "Edit" })).toBeNull();
  });

  it("keeps one row open at a time", () => {
    render(createElement(Fragment, null, row("a"), row("b")));
    swipe(content("a"), { x: 300, y: 20 }, { x: 150, y: 20 });
    swipe(content("b"), { x: 300, y: 80 }, { x: 150, y: 80 });

    expect(screen.getAllByRole("link", { name: "Edit" })).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Edit" }).getAttribute("href")).toBe("/app/activities/b/edit");
  });

  it("still asks before deleting", () => {
    render(row("a"));
    swipe(content(), { x: 300, y: 20 }, { x: 150, y: 20 });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    const confirmation = screen.getByRole("region", { name: "Confirm activity deletion" });
    expect(confirmation.textContent).toContain("Delete this activity?");
    expect(screen.getByRole("button", { name: "Keep" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(screen.queryByRole("region", { name: "Confirm activity deletion" })).toBeNull();
  });

  it("offers only the actions the member is allowed", () => {
    render(row("a", { editHref: "/app/activities/a/edit", canDelete: false }));
    swipe(content(), { x: 300, y: 20 }, { x: 150, y: 20 });
    expect(screen.getByRole("link", { name: "Edit" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });
});
