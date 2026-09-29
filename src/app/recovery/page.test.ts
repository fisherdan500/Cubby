// @vitest-environment jsdom
import React, { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RecoveryPage from "@/app/recovery/page";

globalThis.React = React;

beforeEach(() => sessionStorage.clear());
afterEach(() => cleanup());

describe("RecoveryPage", () => {
  it("uses visible labels and a native recovery form", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, data: { status: "submitted" } }) });
    render(createElement(RecoveryPage));
    for (const id of ["recovery-email", "recovery-code", "recovery-new-password"]) {
      expect(document.querySelector(`label[for="${id}"]`)).toBeTruthy();
    }
    await userEvent.type(screen.getByLabelText("Email address"), "person@example.test");
    await userEvent.type(screen.getByLabelText("Recovery code"), "ABCD-EFGH-JKMN-PQRS-TVWX-YZ01");
    await userEvent.type(screen.getByLabelText("New password"), "new password");
    fireEvent.submit(screen.getByRole("form", { name: "Recover your account" }));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledOnce());
  });

  it("retains only safe operation metadata and reuses it after an ambiguous response", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, data: { status: "submitted", signInRequired: true } }) });
    globalThis.fetch = fetchMock;
    render(createElement(RecoveryPage));
    await userEvent.type(screen.getByLabelText("Email address"), "person@example.test");
    await userEvent.type(screen.getByLabelText("Recovery code"), "ABCD-EFGH-JKMN-PQRS-TVWX-YZ01");
    await userEvent.type(screen.getByLabelText("New password"), "new password");
    await userEvent.click(screen.getByRole("button", { name: "Reset password" }));
    await waitFor(() => expect(sessionStorage.getItem("cubby:global-security:recovery-reset-operation")).toBeTruthy());
    const retained = sessionStorage.getItem("cubby:global-security:recovery-reset-operation")!;
    // Assert the SHAPE, not the absence of substrings. The retained blob is an operation id plus two hex
    // digests, so a literal like /ABCD/i also matches hex that legitimately contains "abcd" — roughly one
    // run in 500 failed this on a correct implementation, and a flaky security assertion is worse than
    // none because it trains people to re-run it. Exactly these three keys, each in its own exact format,
    // leaves no room for an email, a recovery code or a password to hide.
    expect(Object.keys(JSON.parse(retained)).sort()).toEqual([
      "intentFingerprint",
      "openingFingerprint",
      "operationId"
    ]);
    expect(JSON.parse(retained)).toEqual({
      operationId: expect.stringMatching(/^gso_[0-9abcdefghjkmnpqrstvwxyz]{26}$/),
      openingFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      intentFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/)
    });
    await userEvent.type(screen.getByLabelText("Email address"), "person@example.test");
    await userEvent.type(screen.getByLabelText("Recovery code"), "ABCD-EFGH-JKMN-PQRS-TVWX-YZ01");
    await userEvent.type(screen.getByLabelText("New password"), "new password");
    await userEvent.click(screen.getByRole("button", { name: "Reset password" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const first = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    const second = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
    expect(second.operationId).toBe(first.operationId);
    expect(second.openingFingerprint).toBe(first.openingFingerprint);
    expect(second.intentFingerprint).toBe(first.intentFingerprint);
    expect(sessionStorage.getItem("cubby:global-security:recovery-reset-operation")).toBeNull();
  });

  it("allows only one public recovery submit while metadata and network work are in flight", async () => {
    let resolveFetch!: (value: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; }));
    globalThis.fetch = fetchMock;
    render(createElement(RecoveryPage));
    await userEvent.type(screen.getByLabelText("Email address"), "person@example.test");
    await userEvent.type(screen.getByLabelText("Recovery code"), "ABCD-EFGH-JKMN-PQRS-TVWX-YZ01");
    await userEvent.type(screen.getByLabelText("New password"), "new password");
    const submit = screen.getByRole("button", { name: "Reset password" });
    await userEvent.click(submit);
    await userEvent.type(screen.getByLabelText("Email address"), "person@example.test");
    await userEvent.type(screen.getByLabelText("Recovery code"), "ABCD-EFGH-JKMN-PQRS-TVWX-YZ01");
    await userEvent.type(screen.getByLabelText("New password"), "new password");
    await userEvent.click(submit);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    resolveFetch({ ok: true, json: async () => ({ ok: true, data: { status: "submitted" } }) } as Response);
  });
});
