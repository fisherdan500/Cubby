// @vitest-environment jsdom
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUserPage: vi.fn(),
  getHouseholdHome: vi.fn(),
  getActivityForEdit: vi.fn(),
  getActivityUnitPreferences: vi.fn()
}));

globalThis.React = React;

vi.mock("next/navigation", () => ({ notFound: vi.fn(), redirect: vi.fn() }));
vi.mock("@/server/auth/session", () => ({ requireUserPage: mocks.requireUserPage }));
vi.mock("@/server/services/households", () => ({ getHouseholdHome: mocks.getHouseholdHome }));
vi.mock("@/server/services/activities", () => ({ getActivityForEdit: mocks.getActivityForEdit }));
vi.mock("@/server/services/unit-preferences", () => ({ getActivityUnitPreferences: mocks.getActivityUnitPreferences }));
vi.mock("@/lib/activity-navigation", () => ({
  activityDetailHref: () => "/app/activities/activity-1",
  activityFallbackHref: () => "/app",
  safeActivityReturnTo: () => null
}));
vi.mock("@/lib/activity-page-error", () => ({ activityUnavailableOrThrow: () => null }));
vi.mock("@/lib/baby-selector", () => ({ activityEditBabies: (babies: unknown[]) => babies }));
vi.mock("@/lib/activity-edit-initial", () => ({ activityEditInitial: () => ({}) }));
vi.mock("@/lib/env", () => ({ env: { APP_TIMEZONE: "Etc/UTC" } }));
vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children, timerBabyId, timerActivityType }: { children: React.ReactNode; timerBabyId?: string; timerActivityType?: string }) =>
    createElement("main", { "data-timer-baby-id": timerBabyId, "data-timer-activity-type": timerActivityType }, children)
}));
vi.mock("@/components/forms/activity-form", () => ({ ActivityForm: () => createElement("div") }));
vi.mock("@/components/forms/activity-form-header", () => ({ ActivityFormHeader: () => createElement("span") }));
vi.mock("@/components/ui/card", () => ({ Card: ({ children }: { children: React.ReactNode }) => createElement("section", null, children) }));

import EditActivityPage from "@/app/app/activities/[id]/edit/page";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUserPage.mockResolvedValue({ id: "user-1", name: "Parent" });
  mocks.getHouseholdHome.mockResolvedValue({ household: { babies: [{ id: "baby-b", name: "Blake" }] } });
  mocks.getActivityForEdit.mockResolvedValue({
    id: "activity-1",
    type: "sleep",
    babyId: "baby-b",
    occurredAt: new Date("2026-09-22T12:00:00.000Z")
  });
  mocks.getActivityUnitPreferences.mockResolvedValue({ preferences: {}, medicineNames: [], supplementNames: [] });
});

describe("edit activity timer scope", () => {
  it("uses the activity's authoritative baby for the shell timer bar", async () => {
    document.body.innerHTML = renderToStaticMarkup(
      await EditActivityPage({ params: { id: "activity-1" }, searchParams: {} })
    );

    expect(document.querySelector("main")?.getAttribute("data-timer-baby-id")).toBe("baby-b");
    expect(document.querySelector("main")?.getAttribute("data-timer-activity-type")).toBe("sleep");
  });
});
