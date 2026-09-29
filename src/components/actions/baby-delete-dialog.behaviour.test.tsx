// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BabyDeleteDialog } from "@/components/actions/baby-delete-dialog";

// The server is what actually protects a baby; these prove the dialog does not undermine it. A
// disabled button that still submits, or a confirmation compared case-insensitively in the browser,
// would leave the phrase feeling enforced while being trivial to fumble.

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  refresh.mockReset();
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function open(props: { canRemove: boolean; babyName?: string }) {
  render(
    <BabyDeleteDialog babyId="baby-1" babyName={props.babyName ?? "Sprout"} canRemove={props.canRemove} />
  );
  fireEvent.click(screen.getByRole("button", { name: /Delete/ }));
}

function type(value: string) {
  fireEvent.change(screen.getByLabelText(/Type/), { target: { value } });
}

describe("the baby delete dialog", () => {
  it("asks for nothing until it is opened", () => {
    render(<BabyDeleteDialog babyId="baby-1" babyName="Sprout" canRemove />);
    expect(screen.queryByLabelText(/Type/)).toBeNull();
  });

  it("shows the exact phrase the server will require", () => {
    open({ canRemove: true });
    expect(screen.getByText("Yes Delete Baby Sprout")).toBeTruthy();
  });

  it("keeps the confirm button disabled until the phrase matches exactly", () => {
    open({ canRemove: true });
    const confirm = screen.getByRole("button", { name: /Remove profile/ });
    expect(confirm.hasAttribute("disabled")).toBe(true);

    type("Yes Delete Baby Sprou");
    expect(screen.getByRole("button", { name: /Remove profile/ }).hasAttribute("disabled")).toBe(true);

    // Right words, wrong case: the phrase is meant to be deliberate, so this must not pass.
    type("yes delete baby sprout");
    expect(screen.getByRole("button", { name: /Remove profile/ }).hasAttribute("disabled")).toBe(true);

    type("Yes Delete Baby Sprout");
    expect(screen.getByRole("button", { name: /Remove profile/ }).hasAttribute("disabled")).toBe(false);
  });

  it("sends nothing while the phrase is wrong", () => {
    open({ canRemove: true });
    type("nope");
    fireEvent.click(screen.getByRole("button", { name: /Remove profile/ }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The handler also returns early on a mismatched phrase. That guard is deliberately not asserted
  // here: React does not deliver synthetic clicks to an element its own tree marks disabled, so the
  // branch is unreachable from jsdom and any test claiming to cover it would pass either way. The
  // check that actually protects a baby is the server's, which the disposable PostgreSQL gate proves
  // by rejecting a wrong phrase posted straight to the service.

  it("asks to remove the profile only when the server said it has no history", async () => {
    open({ canRemove: true });
    type("Yes Delete Baby Sprout");
    fireEvent.click(screen.getByRole("button", { name: /Remove profile/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/babies/baby-1");
    expect(init.method).toBe("DELETE");
    const body = JSON.parse(String(init.body)) as { confirmation: string; mode: string };
    expect(body).toEqual({ confirmation: "Yes Delete Baby Sprout", mode: "remove" });
  });

  it("asks to hide a baby that has history, never to remove it", async () => {
    open({ canRemove: false });
    type("Yes Delete Baby Sprout");
    fireEvent.click(screen.getByRole("button", { name: /Delete baby/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)) as { mode: string };
    expect(body.mode).toBe("hide");
  });

  it("says plainly that history is kept, so nobody expects an erase", () => {
    open({ canRemove: false });
    expect(screen.getByText(/disappear from Cubby/)).toBeTruthy();
    expect(screen.getByText(/Nothing is erased/)).toBeTruthy();
  });

  it("warns that a removal cannot be undone", () => {
    open({ canRemove: true });
    expect(screen.getByText(/cannot be undone/)).toBeTruthy();
  });

  it("refreshes the view after a successful deletion so the baby disappears", async () => {
    open({ canRemove: false });
    type("Yes Delete Baby Sprout");
    fireEvent.click(screen.getByRole("button", { name: /Delete baby/ }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it("keeps the baby visible and explains itself when the server refuses", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ ok: false, error: { message: "baby_has_history" } })
    });
    open({ canRemove: true });
    type("Yes Delete Baby Sprout");
    fireEvent.click(screen.getByRole("button", { name: /Remove profile/ }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toMatch(/no longer be removed outright/);
    // Nothing disappears on a failure: the caller must not think it worked.
    expect(refresh).not.toHaveBeenCalled();
  });

  it("explains a rejected phrase without inventing a reason", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ ok: false, error: { message: "confirmation_mismatch" } })
    });
    open({ canRemove: true });
    type("Yes Delete Baby Sprout");
    fireEvent.click(screen.getByRole("button", { name: /Remove profile/ }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toMatch(/does not match/);
  });

  it("survives an unreachable server without claiming success", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    open({ canRemove: true });
    type("Yes Delete Baby Sprout");
    fireEvent.click(screen.getByRole("button", { name: /Remove profile/ }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(refresh).not.toHaveBeenCalled();
  });

  it("uses the baby's own name in the phrase, not a fixed word", () => {
    open({ canRemove: true, babyName: "Rosie Mae" });
    expect(screen.getByText("Yes Delete Baby Rosie Mae")).toBeTruthy();
    type("Yes Delete Baby Sprout");
    expect(screen.getByRole("button", { name: /Remove profile/ }).hasAttribute("disabled")).toBe(true);
  });

  it("closing puts everything back, so a stray phrase is not left armed", () => {
    open({ canRemove: true });
    type("Yes Delete Baby Sprout");
    fireEvent.click(screen.getByRole("button", { name: /Cancel/ }));
    fireEvent.click(screen.getByRole("button", { name: /Delete/ }));
    expect((screen.getByLabelText(/Type/) as HTMLInputElement).value).toBe("");
  });
});
