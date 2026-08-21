// @vitest-environment jsdom
import React, { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), setTheme: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("next-themes", () => ({ useTheme: () => ({ setTheme: mocks.setTheme }) }));
vi.mock("@/lib/browser-operation-tab-scope", () => ({ tabScopedBrowserOperationStorageKey: async (_partition: string, key: string) => `${key}:tab:test` }));

import { PersonalAppearanceForm } from "@/components/personal-appearance-form";

globalThis.React = React;

function response(status: number, body: unknown) {
  return { status, ok: status >= 200 && status < 300, json: async () => body } as Response;
}

beforeEach(() => {
  sessionStorage.clear();
  mocks.refresh.mockReset();
  mocks.setTheme.mockReset();
});
afterEach(cleanup);

describe("PersonalAppearanceForm", () => {
  it("mounts, obtains an account partition, persists the server reservation, and applies its completed mode", async () => {
    const operationId = "bmo_0123456789abcdefghjkmnpqrs";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { ok: true, data: { version: 1, scope: "account", partition: "account-a" } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { status: "open", operationId } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { status: "completed", operationId, outcome: { appearanceMode: "light", appearanceRevision: 1 } } }));
    globalThis.fetch = fetchMock;
    const user = userEvent.setup();

    render(createElement(PersonalAppearanceForm, { initialMode: "system", initialRevision: 0 }));
    await user.click(screen.getByRole("radio", { name: /Light/ }));
    await user.click(screen.getByRole("button", { name: "Save personal appearance" }));

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Personal appearance saved."));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/account/browser-operations/partition",
      "/api/account/appearance/issue",
      "/api/account/appearance"
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual({ operationId, appearanceMode: "light" });
    expect(sessionStorage.getItem("cubby:account-appearance-operation:account-a:tab:test")).toBeNull();
    expect(mocks.setTheme).toHaveBeenCalledWith("light");
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("resumes a retained prepared personal-appearance reservation with the same ID", async () => {
    const operationId = "bmo_0123456789abcdefghjkmnpqrs";
    sessionStorage.setItem("cubby:account-appearance-operation:account-a:tab:test", operationId);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { ok: true, data: { version: 1, scope: "account", partition: "account-a" } }))
      .mockResolvedValueOnce(response(202, { ok: true, data: { status: "prepared", operationId } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { status: "completed", operationId, outcome: { appearanceMode: "light", appearanceRevision: 1 } } }));
    globalThis.fetch = fetchMock;
    render(createElement(PersonalAppearanceForm, { initialMode: "system", initialRevision: 0 }));
    await userEvent.click(screen.getByRole("radio", { name: /Light/ }));
    await userEvent.click(screen.getByRole("button", { name: "Save personal appearance" }));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/account/browser-operations/partition", `/api/account/browser-operations/${operationId}`, "/api/account/appearance"
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual({ operationId, appearanceMode: "light" });
  });

  it("moves radio focus and selection with ArrowRight", async () => {
    render(createElement(PersonalAppearanceForm, { initialMode: "system", initialRevision: 0 }));
    const system = screen.getByRole("radio", { name: /System/ });
    system.focus();

    await userEvent.keyboard("{ArrowRight}");

    const light = screen.getByRole("radio", { name: /Light/ });
    expect(document.activeElement).toBe(light);
    expect(light.getAttribute("aria-checked")).toBe("true");
  });
});
