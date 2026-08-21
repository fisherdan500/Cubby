// @vitest-environment jsdom
import React, { createElement } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/lib/browser-operation-tab-scope", () => ({ tabScopedBrowserOperationStorageKey: async (_partition: string, key: string) => `${key}:tab:test` }));
import { BabyForm } from "@/components/forms/baby-form";

globalThis.React = React;
const response = (status: number, body: unknown) => ({ status, ok: status >= 200 && status < 300, json: async () => body }) as Response;
let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  sessionStorage.clear();
  mocks.refresh.mockReset();
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { cleanup(); consoleError.mockRestore(); });

describe("BabyForm browser-v2 handling", () => {
  async function submitMountedBaby() {
    const name = screen.getByRole("textbox", { name: "Baby name" });
    await userEvent.type(name, "Avery");
    const form = name.closest("form") as HTMLFormElement;
    const reactPropsKey = Object.keys(form).find((key) => key.startsWith("__reactProps$"));
    expect(reactPropsKey).toBeDefined();
    const props = (form as unknown as Record<string, { action: (data: FormData) => Promise<void> }>)[reactPropsKey!];
    await act(async () => { await props.action(new FormData(form)); });
  }

  it("mounts the baby creation controls and accepts user input", async () => {
    render(createElement(BabyForm));
    const name = screen.getByRole("textbox", { name: "Baby name" }) as HTMLInputElement;
    const notes = screen.getByRole("textbox", { name: "Notes" }) as HTMLTextAreaElement;
    expect(screen.getByLabelText("Birth date")).toBeTruthy();
    expect(screen.getByLabelText("Feeding warning minutes")).toBeTruthy();
    expect(screen.getByLabelText("Diaper warning minutes")).toBeTruthy();
    expect(screen.getByLabelText("Timer warning minutes")).toBeTruthy();

    await userEvent.type(name, "Avery");
    await userEvent.type(notes, "Synthetic fixture");

    expect(name.value).toBe("Avery");
    expect(notes.value).toBe("Synthetic fixture");
    expect((screen.getByPlaceholderText("Feed warning minutes") as HTMLInputElement).value).toBe("240");
    expect(screen.getByRole("button", { name: "Add baby" })).toBeTruthy();
  });

  it("resumes a retained prepared Baby Create reservation with the same ID", async () => {
    const operationId = "bmo_0123456789abcdefghjkmnpqrs";
    const key = "cubby:baby-create-operation:household-a:tab:test";
    sessionStorage.setItem(key, operationId);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { ok: true, data: { version: 1, scope: "household", partition: "household-a" } }))
      .mockResolvedValueOnce(response(202, { ok: true, data: { status: "prepared", operationId } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { status: "completed", operationId } }));
    globalThis.fetch = fetchMock;
    render(createElement(BabyForm));
    await submitMountedBaby();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls[1][0]).toBe(`/api/browser-operations/${operationId}`);
    expect(fetchMock.mock.calls[2][0]).toBe("/api/babies");
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toMatchObject({ operationId, name: "Avery" });
    expect(sessionStorage.getItem(key)).toBeNull();
  });

  it("retains stale Baby Create state without issuing a replacement", async () => {
    const operationId = "bmo_0123456789abcdefghjkmnpqrs";
    const key = "cubby:baby-create-operation:household-a:tab:test";
    sessionStorage.setItem(key, operationId);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { ok: true, data: { version: 1, scope: "household", partition: "household-a" } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { status: "stale", operationId, code: "stale_context" } }));
    globalThis.fetch = fetchMock;
    render(createElement(BabyForm));
    await submitMountedBaby();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(sessionStorage.getItem(key)).toBe(operationId);
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/babies/issue")).toBe(false);
  });

  it("clears an authorized 410 before issuing and submitting a replacement", async () => {
    const oldId = "bmo_0123456789abcdefghjkmnpqrs";
    const newId = "bmo_1123456789abcdefghjkmnpqrs";
    const key = "cubby:baby-create-operation:household-a:tab:test";
    sessionStorage.setItem(key, oldId);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { ok: true, data: { version: 1, scope: "household", partition: "household-a" } }))
      .mockResolvedValueOnce(response(410, { ok: true, data: { status: "expired", operationId: oldId, code: "operation_result_expired" } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { status: "open", operationId: newId } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { status: "completed", operationId: newId } }));
    globalThis.fetch = fetchMock;
    render(createElement(BabyForm));
    await submitMountedBaby();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(fetchMock.mock.calls[2][0]).toBe("/api/babies/issue");
    expect(JSON.parse(String(fetchMock.mock.calls[3][1]?.body))).toMatchObject({ operationId: newId });
    expect(sessionStorage.getItem(key)).toBeNull();
  });
});
