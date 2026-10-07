// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";

const mocks = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn(), fetch: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }) }));
import { OnboardingForm } from "./onboarding-form";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.fetch.mockResolvedValue({ json: async () => ({ ok: true, data: { id: "target" } }) });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("allows keyboard selection between the two onboarding paths", async () => {
  // jsdom lacks CSS.escape; this test uses only the plain identifier onboardingPath.
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  const user = userEvent.setup();
  render(<OnboardingForm canRestore />);
  const choices = screen.getAllByRole("radio") as HTMLInputElement[];
  expect(choices[0].name).not.toBe("");
  expect(choices[0].name).toBe(choices[1].name);
  screen.getByRole("radio", { name: "Create a new household and first baby" }).focus();
  await user.keyboard("{ArrowDown}");
  expect((screen.getByRole("radio", { name: "Restore household backup" }) as HTMLInputElement).checked).toBe(true);
});

it.each([false, true])("preserves ordinary creation and its request shape (restore offered: %s)", async (canRestore) => {
  render(<OnboardingForm canRestore={canRestore} />);
  if (!canRestore) expect(screen.queryByRole("radio", { name: "Restore household backup" })).toBeNull();
  fireEvent.change(screen.getByLabelText("Household name"), { target: { value: "River Home" } });
  fireEvent.change(screen.getByLabelText("Baby name"), { target: { value: "Avery" } });
  fireEvent.change(screen.getByLabelText("Birth date"), { target: { value: "2026-01-01" } });
  fireEvent.submit(screen.getByRole("button", { name: "Start tracking" }).closest("form")!);
  await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/app"));
  expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toEqual({ householdName: "River Home", babyName: "Avery", birthDate: "2026-01-01" });
});

it("keeps a refused restore creation on onboarding with its server error", async () => {
  mocks.fetch.mockResolvedValue(responseError());
  render(<OnboardingForm canRestore />);
  fireEvent.click(screen.getByRole("radio", { name: "Restore household backup" }));
  fireEvent.change(screen.getByLabelText("Recovery-target household name"), { target: { value: "Recovery" } });
  fireEvent.submit(screen.getByRole("button", { name: "Create empty household and continue" }).closest("form")!);
  await screen.findByText("Household creation is closed.");
  expect(mocks.push).not.toHaveBeenCalled();
});

function responseError() {
  return { json: async () => ({ ok: false, error: { message: "Household creation is closed." } }) };
}

it("creates only a named recovery target and routes to existing backups", async () => {
  render(<OnboardingForm canRestore />);
  fireEvent.click(screen.getByRole("radio", { name: "Restore household backup" }));
  const name = screen.getByLabelText("Recovery-target household name") as HTMLInputElement;
  expect(name.maxLength).toBe(80);
  expect(screen.queryByLabelText("Baby name")).toBeNull();
  expect(screen.getByText(/v2 restores adopt the archived household name/)).toBeTruthy();
  expect(screen.getByText(/failed or cancelled restore leaves this empty household/)).toBeTruthy();
  fireEvent.change(name, { target: { value: "Recovery" } });
  fireEvent.submit(name.closest("form")!);
  await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/app/settings/backups"));
  expect(mocks.fetch).toHaveBeenCalledOnce();
  expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toEqual({ mode: "restore", householdName: "Recovery" });
});
