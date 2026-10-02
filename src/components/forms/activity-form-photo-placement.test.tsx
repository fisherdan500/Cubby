// @vitest-environment jsdom
/**
 * Choosing a photo is offered only where the save can actually keep it.
 *
 * The picker lives in the shared activity form, which both logging a new entry and editing an existing
 * one use. Only the save that CREATES an entry claims photos, so offering the picker while editing
 * would let a family choose a picture, see the save succeed, and lose the photo with nothing said --
 * the silent-loss failure this project treats as the worst kind.
 *
 * Until editing can attach photos, the picker belongs on the create form only.
 */
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh, replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams()
}));

import { activityBrowserUpdateSchema } from "@/lib/validation/activity";

import { ActivityForm } from "./activity-form";

const babies = [{ id: "baby-1", name: "Wren" }];

const saved = {
  id: "act-1",
  babyId: "baby-1",
  type: "feeding" as const,
  occurredAt: new Date("2026-10-01T08:00:00.000Z"),
  startedAt: null,
  endedAt: null,
  durationSeconds: null,
  timezone: "Etc/UTC",
  notes: null,
  timerState: "none" as const,
  pausedAt: null,
  pausedSeconds: 0,
  updatedAt: new Date("2026-10-01T08:00:00.000Z"),
  detail: {}
};

function form(initial?: typeof saved) {
  return createElement(ActivityForm, {
    babies,
    type: "feeding",
    selectedBabyId: "baby-1",
    appTimeZone: "Etc/UTC",
    unitPreferences: {},
    medicineNames: [],
    supplementNames: [],
    lastFeeding: null,
    ...(initial ? { activityId: initial.id, initial } : {})
  } as never);
}

beforeEach(() => {
  cleanup();
});

describe("where a photo may be chosen", () => {
  it("offers photos while logging a new entry", () => {
    render(form());

    expect(screen.getByLabelText(/add a photo/i)).toBeTruthy();
  });

  it("does not offer photos while editing, because the save would drop them", () => {
    render(form(saved));

    // Offering it here would be a promise the save does not keep: only the save that creates an entry
    // claims photos, so the family would see success and lose the picture.
    expect(screen.queryByLabelText(/add a photo/i)).toBeNull();
  });

  it("refuses an edit that carries photo ids, rather than quietly succeeding without them", () => {
    // Hiding the control is presentation only. A stale tab, a replayed request, or any future caller
    // could still send ids, so the contract itself has to refuse them.
    const edit = {
      id: "act-1",
      expectedUpdatedAt: "2026-10-01T08:00:00.000Z",
      babyId: "baby-1",
      type: "feeding" as const,
      mode: "bottle" as const,
      amount: null,
      leftSeconds: null,
      rightSeconds: null,
      occurredAt: "2026-10-01T08:00:00.000Z"
    };

    expect(activityBrowserUpdateSchema.safeParse({ ...edit, attachmentIds: ["att-1"] }).success).toBe(false);
    // An ordinary edit is unaffected.
    expect(activityBrowserUpdateSchema.safeParse(edit).success).toBe(true);
  });
});
