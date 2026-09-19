// @vitest-environment jsdom
import React, { createElement } from "react";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SecurityHistory } from "@/components/settings/security-history";

globalThis.React = React;
const response = (status: number, body: unknown) => ({ status, ok: status >= 200 && status < 300, json: async () => body, blob: async () => new Blob([JSON.stringify(body)]) }) as Response;
afterEach(cleanup);
beforeEach(() => { vi.restoreAllMocks(); URL.createObjectURL = vi.fn(() => "blob:security-history"); URL.revokeObjectURL = vi.fn(); HTMLAnchorElement.prototype.click = vi.fn(); });

describe("SecurityHistory", () => {
  it("uses one named h1 standalone and a named h2 when embedded", () => {
    globalThis.fetch = vi.fn().mockResolvedValue(response(200, { ok: true, data: { events: [], nextCursor: null } }));
    const standalone = render(createElement(SecurityHistory, { accountScope: "user-one", timeZone: "UTC" }));
    expect(screen.getByRole("heading", { level: 1, name: "Security history" })).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);

    standalone.unmount();
    render(createElement(SecurityHistory, { accountScope: "user-one", timeZone: "UTC", headingLevel: 2 }));
    expect(screen.getByRole("heading", { level: 2, name: "Security history" })).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });

  it("loads safe paginated history and never renders internal identifiers", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(response(200, { ok: true, data: { events: [{ handle: "opaque-handle", eventClass: "session", action: "session_management", outcome: "revoked", occurredAt: "2026-08-29T12:00:00.000Z" }], nextCursor: "opaque-cursor" } }));
    render(createElement(SecurityHistory, { accountScope: "user-one", timeZone: "UTC" }));
    expect(await screen.findByText("Session Management")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Load more" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("opaque-handle");
    expect(String(globalThis.fetch)).not.toContain("sessionStorage");
  });

  it("uses focusable inline export confirmation and cleans up the object URL", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { ok: true, data: { events: [], nextCursor: null } }))
      .mockResolvedValueOnce(response(200, { schemaVersion: 1, exportType: "cubby_global_security_history", exportedAt: "2026-08-29T12:00:00.000Z", events: [] }));
    globalThis.fetch = fetchMock;
    const user = userEvent.setup();
    render(createElement(SecurityHistory, { accountScope: "user-one", timeZone: "UTC" }));
    await screen.findByText("No security history is available yet.");
    await user.click(screen.getByRole("button", { name: "Export history" }));
    const confirmation = screen.getByRole("region", { name: "Confirm security history export" });
    expect(document.activeElement).toBe(within(confirmation).getByRole("button", { name: "Cancel" }));
    await user.click(within(confirmation).getByRole("button", { name: "Download export" }));
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:security-history"));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Export history" })));
    expect(fetchMock.mock.calls[1]).toEqual(["/api/account/security-history/export", expect.objectContaining({ method: "POST", body: JSON.stringify({ confirmed: true }) })]);
  });

  it("restores export focus after cancellation and announces successful pagination with success semantics", async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(response(200, { ok: true, data: { events: [{ handle: "opaque-one", eventClass: "credential", action: "sign_in", outcome: "sign_in_succeeded", occurredAt: "2026-08-29T12:00:00.000Z" }], nextCursor: "next" } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { events: [{ handle: "opaque-two", eventClass: "credential", action: "sign_in", outcome: "sign_in_succeeded", occurredAt: "2026-08-29T12:01:00.000Z" }], nextCursor: null } }));
    const user = userEvent.setup();
    render(createElement(SecurityHistory, { accountScope: "user-one", timeZone: "UTC" }));
    await screen.findByRole("button", { name: "Load more" });
    await user.click(screen.getByRole("button", { name: "Export history" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Export history" })));
    await user.click(screen.getByRole("button", { name: "Load more" }));
    const notice = await screen.findByText("More security history loaded.");
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.className).toContain("text-success");
  });

  it("clears rendered private history when the authenticated account scope changes", async () => {
    let resolveSecond!: (value: Response) => void;
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(response(200, { ok: true, data: { events: [{ handle: "first", eventClass: "credential", action: "first_account_event", outcome: "completed", occurredAt: "2026-08-29T12:00:00.000Z" }], nextCursor: null } }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveSecond = resolve; }));
    const view = render(createElement(SecurityHistory, { accountScope: "user-one", timeZone: "UTC" }));
    expect(await screen.findByText("First Account Event")).toBeTruthy();

    view.rerender(createElement(SecurityHistory, { accountScope: "user-two", timeZone: "UTC" }));
    expect(screen.queryByText("First Account Event")).toBeNull();
    await act(async () => resolveSecond(response(200, { ok: true, data: { events: [], nextCursor: null } })));
  });

  it("ignores a late private-history response from the previous account scope", async () => {
    const resolvers: Array<(value: Response) => void> = [];
    globalThis.fetch = vi.fn(() => new Promise<Response>((resolve) => { resolvers.push(resolve); }));
    const view = render(createElement(SecurityHistory, { accountScope: "user-one", timeZone: "UTC" }));
    view.rerender(createElement(SecurityHistory, { accountScope: "user-two", timeZone: "UTC" }));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(2));

    await act(async () => resolvers[1]!(response(200, { ok: true, data: { events: [{ handle: "second", eventClass: "credential", action: "second_account_event", outcome: "completed", occurredAt: "2026-08-29T12:01:00.000Z" }], nextCursor: null } })));
    expect(await screen.findByText("Second Account Event")).toBeTruthy();
    await act(async () => resolvers[0]!(response(200, { ok: true, data: { events: [{ handle: "first", eventClass: "credential", action: "late_first_account_event", outcome: "completed", occurredAt: "2026-08-29T12:02:00.000Z" }], nextCursor: null } })));

    expect(screen.queryByText("Late First Account Event")).toBeNull();
    expect(screen.getByText("Second Account Event")).toBeTruthy();
  });
});
