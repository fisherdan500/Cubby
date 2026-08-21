// @vitest-environment jsdom
import React, { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ resolveStorageKey: vi.fn() }));
vi.mock("@/lib/browser-operation-tab-scope", () => ({
  tabScopedBrowserOperationStorageKey: mocks.resolveStorageKey
}));

import { BrowserOperationRecovery, discoverCurrentTabSavedBrowserOperations, discoverSavedBrowserOperations } from "@/components/browser-operation-recovery";

globalThis.React = React;
const householdId = "bmo_0123456789abcdefghjkmnpqrs";
const accountId = "bmo_1123456789abcdefghjkmnpqrs";

beforeEach(() => {
  sessionStorage.clear();
  mocks.resolveStorageKey.mockImplementation(async (_partition: string, pointerKey: string) => pointerKey);
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function seed(scope: "household" | "account", operationId: string, namespace = "namespace-a") {
  sessionStorage.setItem("cubby:browser-operation-tab-namespace:partition-a", namespace);
  const prefix = scope === "account" ? "cubby:account-appearance-operation:partition-a" : "cubby:baby-create-operation:partition-a";
  const key = `${prefix}:tab:${namespace}`;
  sessionStorage.setItem(key, operationId);
  return key;
}

describe("BrowserOperationRecovery", () => {
  it("ignores copied pointers outside the current tab namespace", () => {
    const current = seed("household", householdId, "namespace-current");
    sessionStorage.setItem("cubby:baby-create-operation:partition-a:tab:namespace-copied", accountId);
    expect(discoverSavedBrowserOperations(sessionStorage)).toEqual([{ operationId: householdId, scope: "household", keys: [current] }]);
  });

  it("binds every pointer to its own partition namespace", () => {
    sessionStorage.setItem("cubby:browser-operation-tab-namespace:household-a:member-a", "namespace-a");
    sessionStorage.setItem("cubby:browser-operation-tab-namespace:household-b:member-b", "namespace-b");
    const householdKey = "cubby:baby-create-operation:household-a:member-a:tab:namespace-a";
    const accountKey = "cubby:account-appearance-operation:household-b:member-b:tab:namespace-b";
    sessionStorage.setItem(householdKey, householdId);
    sessionStorage.setItem(accountKey, accountId);
    sessionStorage.setItem("cubby:baby-create-operation:household-a:member-a:tab:namespace-b", householdId);

    expect(discoverSavedBrowserOperations(sessionStorage)).toEqual([
      { operationId: accountId, scope: "account", keys: [accountKey] },
      { operationId: householdId, scope: "household", keys: [householdKey] }
    ]);
  });

  it("rejects a longer partition key carrying a shorter partition namespace", () => {
    sessionStorage.setItem("cubby:browser-operation-tab-namespace:household-a", "namespace-household");
    sessionStorage.setItem("cubby:browser-operation-tab-namespace:household-a:member-a", "namespace-member");
    const validKey = "cubby:baby-create-operation:household-a:member-a:tab:namespace-member";
    sessionStorage.setItem(validKey, accountId);
    sessionStorage.setItem("cubby:baby-create-operation:household-a:member-a:tab:namespace-household", householdId);

    expect(discoverSavedBrowserOperations(sessionStorage)).toEqual([
      { operationId: accountId, scope: "household", keys: [validKey] }
    ]);
  });

  it("resolves a copied tab namespace before exposing recovery pointers", async () => {
    seed("household", householdId, "namespace-copied");
    mocks.resolveStorageKey.mockImplementation(async (partition: string, pointerKey: string) => {
      sessionStorage.setItem(`cubby:browser-operation-tab-namespace:${partition}`, "namespace-current");
      return `${pointerKey}:tab:namespace-current`;
    });
    await expect(discoverCurrentTabSavedBrowserOperations(sessionStorage)).resolves.toEqual([]);
    expect(mocks.resolveStorageKey).toHaveBeenCalledWith("partition-a", expect.stringContaining("browser-operation-recovery-probe"));
  });

  it("abandons household and account pointers through their authenticated routes and clears only authorized 410", async () => {
    const householdKey = seed("household", householdId);
    const accountKey = seed("account", accountId);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return {
        status: 410,
        json: async () => ({ ok: true, data: { status: "expired", operationId: url.includes("/account/") ? accountId : householdId, code: "operation_abandoned" } })
      } as Response;
    });
    globalThis.fetch = fetchMock;
    render(createElement(BrowserOperationRecovery));

    await userEvent.click(await screen.findByRole("button", { name: "Discard 2 saved requests" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Discard/ })).toBeNull());

    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      [`/api/account/browser-operations/${accountId}`, "DELETE"],
      [`/api/browser-operations/${householdId}`, "DELETE"]
    ]);
    expect(sessionStorage.getItem(householdKey)).toBeNull();
    expect(sessionStorage.getItem(accountKey)).toBeNull();
  });

  it("retains a pointer and reports an error when abandonment is not authorized", async () => {
    const key = seed("household", householdId);
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 404 } as Response);
    render(createElement(BrowserOperationRecovery));

    await userEvent.click(await screen.findByRole("button", { name: "Discard 1 saved request" }));
    expect((await screen.findByRole("alert")).textContent).toContain("remain available for reconciliation");
    expect(sessionStorage.getItem(key)).toBe(householdId);
  });
});
