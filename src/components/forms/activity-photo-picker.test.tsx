// @vitest-environment jsdom
/**
 * Choosing photos while logging an entry.
 *
 * The entry does not exist yet, so each picture is uploaded privately as it is chosen and stays unused
 * until the save attaches it. That is what lets the family add a photo at the moment they log, rather
 * than having to save, reopen the entry and come back to it.
 *
 * A picture that fails to upload must leave nothing behind and must not block the entry being logged.
 */
import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ActivityPhotoPicker } from "./activity-photo-picker";

const file = (name = "wren.jpg") => new File([new Uint8Array([1, 2, 3])], name, { type: "image/jpeg" });

function mockUpload(...results: { ok: boolean; attachmentId?: string; message?: string }[]) {
  let call = 0;
  globalThis.fetch = vi.fn(async () => {
    const result = results[Math.min(call++, results.length - 1)]!;
    return {
      ok: result.ok,
      json: async () => (result.ok
        ? { ok: true, data: { attachmentId: result.attachmentId } }
        : { ok: false, error: { message: result.message ?? "That photo is too large." } })
    };
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  cleanup();
  // jsdom has no object URLs; the component uses them only for a local preview.
  let next = 0;
  URL.createObjectURL = vi.fn(() => `blob:preview-${next++}`);
  URL.revokeObjectURL = vi.fn();
});

describe("choosing a photo while logging", () => {
  it("uploads the picture as soon as it is chosen", async () => {
    mockUpload({ ok: true, attachmentId: "att-1" });
    render(createElement(ActivityPhotoPicker, { onChange: vi.fn() }));

    await userEvent.upload(screen.getByLabelText(/add a photo/i), file());

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe("/api/attachments/feed-photos");
    expect((init as RequestInit).method).toBe("POST");
  });

  it("hands the save the pictures it should attach", async () => {
    const onChange = vi.fn();
    mockUpload({ ok: true, attachmentId: "att-1" });
    render(createElement(ActivityPhotoPicker, { onChange }));

    await userEvent.upload(screen.getByLabelText(/add a photo/i), file());

    // The ids are what the save claims, inside the transaction that creates the entry.
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(["att-1"]));
  });

  it("keeps several pictures in the order they were chosen", async () => {
    const onChange = vi.fn();
    mockUpload({ ok: true, attachmentId: "att-1" }, { ok: true, attachmentId: "att-2" });
    render(createElement(ActivityPhotoPicker, { onChange }));

    const input = screen.getByLabelText(/add a photo/i);
    await userEvent.upload(input, file("one.jpg"));
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(["att-1"]));
    await userEvent.upload(input, file("two.jpg"));

    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(["att-1", "att-2"]));
  });

  it("keeps both pictures when the second is chosen the instant the first finishes", async () => {
    // Two photos added in quick succession must both survive.
    //
    // Honest about its reach: in this environment the waits needed to drive two uploads also flush the
    // re-render, so this does NOT by itself distinguish a stale read of the chosen list from a correct
    // one -- a deliberate stale read still passes here. The component uses functional updaters so the
    // question cannot arise; the equivalent mistake in `remove` IS caught by its own test below. Left
    // in place because it pins the user-visible requirement, not because it proves the mechanism.
    const onChange = vi.fn();
    const deferred: (() => void)[] = [];
    let call = 0;
    globalThis.fetch = vi.fn(() => {
      const id = `att-${++call}`;
      return new Promise((resolve) => {
        deferred.push(() => resolve({ ok: true, json: async () => ({ ok: true, data: { attachmentId: id } }) }));
      });
    }) as unknown as typeof fetch;
    render(createElement(ActivityPhotoPicker, { onChange }));

    const input = screen.getByLabelText(/add a photo/i);
    await userEvent.upload(input, file("one.jpg"));
    // Let the first upload settle so the single-flight guard clears, but do NOT wait on the state
    // update -- that wait is what used to refresh the closure and hide a stale read.
    deferred[0]!();
    await waitFor(() => expect(onChange).toHaveBeenCalled());

    await userEvent.upload(input, file("two.jpg"));
    deferred[1]!();

    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(["att-1", "att-2"]));
    expect(screen.getAllByRole("img")).toHaveLength(2);
  });

  it("shows the chosen picture so the family can see what they added", async () => {
    mockUpload({ ok: true, attachmentId: "att-1" });
    render(createElement(ActivityPhotoPicker, { onChange: vi.fn() }));

    await userEvent.upload(screen.getByLabelText(/add a photo/i), file());

    await waitFor(() => expect(screen.getAllByRole("img").length).toBeGreaterThan(0));
  });

  it("lets a picture be removed before the entry is saved", async () => {
    const onChange = vi.fn();
    mockUpload({ ok: true, attachmentId: "att-1" });
    render(createElement(ActivityPhotoPicker, { onChange }));

    await userEvent.upload(screen.getByLabelText(/add a photo/i), file());
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(["att-1"]));

    await userEvent.click(screen.getByRole("button", { name: /remove/i }));

    // Nothing was attached yet, so removing it simply leaves it out of the save.
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith([]));
  });

  it("says what went wrong and attaches nothing when an upload fails", async () => {
    const onChange = vi.fn();
    mockUpload({ ok: false, message: "That photo is too large." });
    render(createElement(ActivityPhotoPicker, { onChange }));

    await userEvent.upload(screen.getByLabelText(/add a photo/i), file());

    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/too large/i));
    expect(onChange).not.toHaveBeenCalledWith(["att-1"]);
  });

  it("keeps an earlier picture when a later one fails", async () => {
    const onChange = vi.fn();
    mockUpload({ ok: true, attachmentId: "att-1" }, { ok: false, message: "That photo is too large." });
    render(createElement(ActivityPhotoPicker, { onChange }));

    const input = screen.getByLabelText(/add a photo/i);
    await userEvent.upload(input, file("one.jpg"));
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(["att-1"]));
    await userEvent.upload(input, file("two.jpg"));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    // The good picture is still going to be attached; one failure does not discard the other.
    expect(onChange).toHaveBeenLastCalledWith(["att-1"]);
  });

  it("uploads one picture at a time when the same file is chosen twice quickly", async () => {
    let release: (value: unknown) => void = () => {};
    const calls: string[] = [];
    globalThis.fetch = vi.fn((url: string) => {
      calls.push(String(url));
      return new Promise((resolve) => { release = resolve; });
    }) as unknown as typeof fetch;
    render(createElement(ActivityPhotoPicker, { onChange: vi.fn() }));

    const input = screen.getByLabelText(/add a photo/i);
    await userEvent.upload(input, file());
    await userEvent.upload(input, file());

    expect(calls).toHaveLength(1);
    release({ ok: true, json: async () => ({ ok: true, data: { attachmentId: "att-1" } }) });
  });
});
