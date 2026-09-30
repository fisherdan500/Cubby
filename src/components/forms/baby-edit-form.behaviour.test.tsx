// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BabyEditForm } from "@/components/forms/baby-edit-form";

// The point of this form is that it sends only what changed. A form that PATCHes every field would
// let two people editing different details overwrite each other's work, and would look identical on
// screen, so these assertions are about the request body rather than the markup.

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const fetchMock = vi.fn();

const BABY = {
  id: "baby-1",
  name: "Sprout",
  birthDate: "2026-01-15",
  notes: "likes the blue blanket",
  feedingWarningMinutes: 180,
  diaperWarningMinutes: 120,
  sleepWarningMinutes: null
};

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

function sentBody() {
  return JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)) as Record<string, unknown>;
}

/**
 * React 18 drives `action={fn}` through Next's own form handling, which a synthetic click or submit
 * does not reach in jsdom. Invoking the prop with the form's real FormData is how the sibling
 * BabyForm test exercises the same pattern, and it still runs the component's own handler.
 */
async function save() {
  const form = screen.getByRole("button", { name: /Save changes/ }).closest("form") as HTMLFormElement;
  if (!form) throw new Error("baby_edit_form_not_found");
  const propsKey = Object.keys(form).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error("baby_edit_form_react_props_missing");
  const props = (form as unknown as Record<string, { action: (data: FormData) => Promise<void> }>)[propsKey];
  await act(async () => {
    await props.action(new FormData(form));
  });
}

describe("the baby edit form", () => {
  it("shows the baby's current details", () => {
    render(<BabyEditForm baby={BABY} />);
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Sprout");
    expect((screen.getByLabelText("Birth date") as HTMLInputElement).value).toBe("2026-01-15");
    expect((screen.getByLabelText("Notes") as HTMLTextAreaElement).value).toBe("likes the blue blanket");
  });

  it("leaves an unset threshold blank rather than showing a made-up number", () => {
    render(<BabyEditForm baby={BABY} />);
    expect((screen.getByLabelText(/Timer warning/) as HTMLInputElement).value).toBe("");
  });

  it("clears a threshold by sending null, not an empty string", async () => {
    // The schema clears on null and REJECTS "", so sending the emptied box verbatim made a
    // threshold settable but never unsettable. BABY.feedingWarningMinutes starts at 180.
    render(<BabyEditForm baby={BABY} />);
    fireEvent.change(screen.getByLabelText("Feed warning (min)"), { target: { value: "" } });
    await save();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(sentBody()).toEqual({ feedingWarningMinutes: null });
  });

  it("sends only the field that changed", async () => {
    render(<BabyEditForm baby={BABY} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Rosie" } });
    await save();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/babies/baby-1");
    expect(init.method).toBe("PATCH");
    expect(sentBody()).toEqual({ name: "Rosie" });
  });

  it("sends several changed fields together and nothing else", async () => {
    render(<BabyEditForm baby={BABY} />);
    fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "new note" } });
    fireEvent.change(screen.getByLabelText(/Feed warning/), { target: { value: "240" } });
    await save();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(sentBody()).toEqual({ notes: "new note", feedingWarningMinutes: "240" });
  });

  it("sends nothing at all when nothing was touched", async () => {
    render(<BabyEditForm baby={BABY} />);
    await save();

    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a whitespace-only name as no change rather than blanking it", async () => {
    render(<BabyEditForm baby={BABY} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "   " } });
    await save();

    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("can clear a note, which is a real change and not an absence", async () => {
    render(<BabyEditForm baby={BABY} />);
    fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "" } });
    await save();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(sentBody()).toEqual({ notes: "" });
  });

  it("refreshes the view after saving so the new name appears", async () => {
    render(<BabyEditForm baby={BABY} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Rosie" } });
    await save();
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it("reports a refusal and does not claim to have saved", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      // The real envelope from fail(): a human sentence in `message`, machine token in `code`.
      // This form surfaces the sentence and must not print the token at a parent.
      json: async () => ({
        ok: false,
        error: { code: "validation_error", message: "Please check the highlighted fields." }
      })
    });
    render(<BabyEditForm baby={BABY} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Rosie" } });
    await save();

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("Please check the highlighted fields.")
    );
    expect(screen.queryByRole("status")).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("survives an unreachable server without claiming success", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    render(<BabyEditForm baby={BABY} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Rosie" } });
    await save();

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("Could not reach Cubby. Try again.")
    );
    expect(refresh).not.toHaveBeenCalled();
  });
});
