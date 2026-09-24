// @vitest-environment jsdom
import React, { createElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ pathname: "/app" }));
vi.mock("next/navigation", () => ({ usePathname: () => navigation.pathname }));
// The undo request itself is covered with the other immediate operations; here it only has to
// report back which entry it was pinned to.
vi.mock("@/components/actions/activity-actions", () => ({
  UndoLastButton: ({ activityId, label, onCompleted }: { activityId: string; label: string; onCompleted: () => void }) =>
    createElement("button", { type: "button", "data-activity-id": activityId, onClick: onCompleted }, label)
}));

import { SavedEntryUndo } from "@/components/saved-entry-undo";
import { SAVED_ENTRY_UNDO_MS, rememberSavedEntry } from "@/lib/saved-entry-undo";

globalThis.React = React;

beforeEach(() => {
  sessionStorage.clear();
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  navigation.pathname = "/app";
});

describe("SavedEntryUndo", () => {
  it("shows nothing when nothing was just saved", () => {
    render(createElement(SavedEntryUndo));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("confirms the save with an Undo pinned to that entry, then steps aside by itself", () => {
    rememberSavedEntry(sessionStorage, { activityId: "activity-9", label: "Feeding" }, Date.now());
    render(createElement(SavedEntryUndo));

    expect(screen.getByRole("status").textContent).toContain("Feeding saved");
    expect(screen.getByRole("button", { name: "Undo" }).getAttribute("data-activity-id")).toBe("activity-9");

    act(() => { vi.advanceTimersByTime(SAVED_ENTRY_UNDO_MS); });
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("can be dismissed straight away", () => {
    rememberSavedEntry(sessionStorage, { activityId: "activity-9", label: "Feeding" }, Date.now());
    render(createElement(SavedEntryUndo));

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("says the entry was removed once the undo completes", () => {
    rememberSavedEntry(sessionStorage, { activityId: "activity-9", label: "Feeding" }, Date.now());
    render(createElement(SavedEntryUndo));

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));

    expect(screen.getByRole("status").textContent).toContain("Feeding removed");
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("stays while the parent is using it, so an Undo in progress is never pulled away", () => {
    rememberSavedEntry(sessionStorage, { activityId: "activity-9", label: "Feeding" }, Date.now());
    render(createElement(SavedEntryUndo));

    fireEvent.pointerDown(screen.getByRole("status"));
    act(() => { vi.advanceTimersByTime(SAVED_ENTRY_UNDO_MS * 2); });

    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
  });

  it("does not offer an undo that has already run out", () => {
    rememberSavedEntry(sessionStorage, { activityId: "activity-9", label: "Feeding" }, Date.now() - SAVED_ENTRY_UNDO_MS);
    render(createElement(SavedEntryUndo));
    expect(screen.queryByRole("status")).toBeNull();
  });
});
