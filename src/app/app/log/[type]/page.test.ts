// @vitest-environment jsdom
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUserPage: vi.fn(),
  getHouseholdHome: vi.fn(),
  getActivityUnitPreferences: vi.fn()
}));

globalThis.React = React;

vi.mock("next/navigation", () => ({ notFound: vi.fn(), redirect: vi.fn() }));
vi.mock("@/server/auth/session", () => ({ requireUserPage: mocks.requireUserPage }));
vi.mock("@/server/services/households", () => ({ getHouseholdHome: mocks.getHouseholdHome }));
vi.mock("@/server/services/unit-preferences", () => ({ getActivityUnitPreferences: mocks.getActivityUnitPreferences }));
vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children, timerBabyId }: { children: React.ReactNode; timerBabyId?: string }) =>
    createElement("main", { "data-timer-baby-id": timerBabyId }, children)
}));
vi.mock("@/components/forms/activity-form", () => ({
  ActivityForm: ({ selectedBabyId }: { selectedBabyId?: string }) =>
    createElement("div", { "data-form-baby-id": selectedBabyId })
}));
vi.mock("@/components/forms/activity-form-header", () => ({ ActivityFormHeader: () => createElement("span") }));
vi.mock("@/components/ui/card", () => ({ Card: ({ children }: { children: React.ReactNode }) => createElement("section", null, children) }));

import LogActivityPage from "@/app/app/log/[type]/page";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUserPage.mockResolvedValue({ id: "user-1", name: "Parent" });
  mocks.getHouseholdHome.mockResolvedValue({
    household: {
      babies: [
        { id: "baby-a", name: "Avery" },
        { id: "baby-b", name: "Blake" }
      ]
    }
  });
  mocks.getActivityUnitPreferences.mockResolvedValue({ preferences: {}, medicineNames: [], supplementNames: [] });
});

describe("log activity timer scope", () => {
  it("uses the validated form baby as the shell timer scope", async () => {
    document.body.innerHTML = renderToStaticMarkup(
      await LogActivityPage({ params: { type: "feeding" }, searchParams: { babyId: "baby-b" } })
    );

    expect(document.querySelector("main")?.getAttribute("data-timer-baby-id")).toBe("baby-b");
    expect(document.querySelector("[data-form-baby-id]")?.getAttribute("data-form-baby-id")).toBe("baby-b");
  });
});
