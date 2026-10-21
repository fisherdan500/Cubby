// @vitest-environment jsdom
/**
 * Saying something about an entry at the moment it is logged.
 *
 * Photos already travel with a new entry, so a feed, a bath or a nap arrives in Moments with its
 * pictures. Words did not: the family could comment on an entry only by finding it in Moments
 * afterwards, which is a different screen, a different moment, and usually a thing nobody goes back
 * to do. The comment box now sits with the photo picker on the new-entry form.
 *
 * The comment is a real Moments comment -- attributed to whoever logged the entry, repliable, and
 * identical to one typed in Moments later -- not a second private notes field. Notes are private
 * text ON the entry; a comment is a response UNDER it that the household can see and answer.
 *
 * WHY IT IS SENT SEPARATELY, AFTER THE SAVE. A comment needs a parent that already exists:
 * `FeedComment` carries a composite foreign key to a live `ActivityLog` row, and the server checks
 * the parent is live before it will write one. So the entry is created first and the comment posted
 * against the id the save returns. That ordering is deliberate and has a visible consequence worth
 * protecting: if the comment fails, THE ENTRY IS STILL SAVED. Losing a nap because a sentence did
 * not send would be a far worse trade than an entry arriving without its comment.
 */
import React, { createElement } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultUnitPreferences } from "@/domain/unit-preferences";

const routerPush = vi.fn();
const routerReplace = vi.fn();
const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: routerReplace, refresh: routerRefresh })
}));

import { ActivityForm } from "@/components/forms/activity-form";

globalThis.React = React;

type Call = { url: string; method: string; body: Record<string, unknown> };

let calls: Call[] = [];
let commentShouldFail = false;
let activitySaveOutcome: Record<string, unknown> = { action: "create", activityId: "activity-new-1" };

/** The activity save returns the new entry's id; the comment endpoint accepts it as a parent. */
function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    calls.push({ url, method, body });

    if (url.includes("/api/activities") && url.includes("issue=1")) {
      return jsonResponse({ ok: true, data: { status: "open", operationId: "bmo_aaaaaaaaaaaaaaaaaaaaaaaaaa", bindingId: "binding-a" } });
    }
    if (url.includes("/api/activities")) {
      return jsonResponse({
        ok: true,
        data: { status: "completed", outcome: activitySaveOutcome }
      });
    }
    if (url.includes("/api/feed/comments") && url.includes("issue=1")) {
      return jsonResponse({ ok: true, data: { status: "open", operationId: "bmo_cccccccccccccccccccccccccc", bindingId: "binding-1" } });
    }
    if (url.includes("/api/feed/comments")) {
      if (commentShouldFail) return jsonResponse({ ok: false, error: { code: "server_error", message: "nope" } }, 500);
      return jsonResponse({ ok: true, data: { status: "completed", operationId: "bmo_cccccccccccccccccccccccccc", outcome: { operationId: "bmo_cccccccccccccccccccccccccc", kind: "feed_comment", code: "created", commentId: "comment-1" } } });
    }
    if (url.includes("/api/browser-operations/partition")) {
      // runFeedOperation resolves the household partition before it will issue anything; without
      // this it throws operation_partition_unavailable and never reaches the comment endpoint.
      return jsonResponse({ ok: true, data: { version: 1, scope: "household", partition: "a".repeat(64) } });
    }
    if (url.includes("/api/browser-operations/")) {
      return jsonResponse({ ok: true, data: { status: "open" } });
    }
    return jsonResponse({ ok: true, data: {} });
  }));
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function renderNewFeed() {
  render(
    createElement(ActivityForm, {
      babies: [{ id: "baby-1", name: "Avery" }],
      type: "feeding" as const,
      selectedBabyId: "baby-1",
      appTimeZone: "UTC",
      unitPreferences: defaultUnitPreferences,
      medicineNames: [],
      supplementNames: []
    })
  );
}

/**
 * React owns this form through `action={submit}`, and jsdom implements neither
 * HTMLFormElement.requestSubmit nor React's action dispatch -- a click does nothing here. So the
 * action is invoked the way React invokes it: with the form's own live FormData. This drives the
 * REAL submit path (same function, same payload the browser would send), it only skips the browser
 * plumbing jsdom lacks.
 */
async function submitForm() {
  const form = screen.getByRole("button", { name: /^Log / }).closest("form") as HTMLFormElement & {
    // React stores the action prop on the DOM node's props in its internal fiber.
    [key: string]: unknown;
  };
  const fiberKey = Object.keys(form).find((k) => k.startsWith("__reactProps$"));
  const props = fiberKey ? (form[fiberKey] as { action?: (data: FormData) => unknown }) : undefined;
  if (!props?.action) throw new Error("activity form exposes no React action to submit");
  await act(async () => {
    await props.action!(new FormData(form));
  });
}

function commentCalls() {
  return calls.filter((c) => c.url.includes("/api/feed/comments") && !c.url.includes("issue=1"));
}

beforeEach(() => {
  calls = [];
  commentShouldFail = false;
  activitySaveOutcome = { action: "create", activityId: "activity-new-1" };
  routerPush.mockClear();
  routerReplace.mockClear();
  routerRefresh.mockClear();
  sessionStorage.clear();
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("saying something about an entry while logging it", () => {
  it("offers a comment box on a NEW entry", () => {
    renderNewFeed();
    expect(screen.getByLabelText(/comment/i)).toBeTruthy();
  });

  it("does not offer one while EDITING, where the save would drop it", () => {
    // Same reasoning as the photo picker directly above it: editing reaches a different save path
    // that never claims a comment, so offering the box would promise something that silently fails.
    render(
      createElement(ActivityForm, {
        babies: [{ id: "baby-1", name: "Avery" }],
        type: "feeding" as const,
        selectedBabyId: "baby-1",
        initial: { notes: "existing" },
        activityId: "activity-1",
        appTimeZone: "UTC",
        unitPreferences: defaultUnitPreferences,
        medicineNames: [],
        supplementNames: []
      })
    );
    expect(screen.queryByLabelText(/comment/i)).toBeNull();
  });

  it("posts the comment against the entry the save just created", async () => {
    const user = userEvent.setup();
    renderNewFeed();
    await user.type(screen.getByLabelText(/comment/i), "She finally finished a whole bottle");
    await submitForm();

    await waitFor(() => expect(commentCalls()).toHaveLength(1));
    const posted = commentCalls()[0];
    expect(posted.body.parentKind).toBe("activity");
    // The id the activity save returned -- not a guess, not the form's own state.
    expect(posted.body.parentId).toBe("activity-new-1");
    expect(posted.body.body).toBe("She finally finished a whole bottle");
  });

  it("sends the comment only AFTER the entry exists", async () => {
    const user = userEvent.setup();
    renderNewFeed();
    await user.type(screen.getByLabelText(/comment/i), "A note for the family");
    await submitForm();

    await waitFor(() => expect(commentCalls()).toHaveLength(1));
    const activitySave = calls.findIndex((c) => c.url.includes("/api/activities") && !c.url.includes("issue=1"));
    const commentPost = calls.findIndex((c) => c.url.includes("/api/feed/comments") && !c.url.includes("issue=1"));
    expect(activitySave).toBeGreaterThanOrEqual(0);
    expect(commentPost).toBeGreaterThan(activitySave);
  });

  it("sends nothing when the comment box is left empty", async () => {
    const user = userEvent.setup();
    renderNewFeed();
    await submitForm();
    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
    expect(commentCalls()).toHaveLength(0);
  });

  it("ignores a comment of only whitespace", async () => {
    const user = userEvent.setup();
    renderNewFeed();
    await user.type(screen.getByLabelText(/comment/i), "    ");
    await submitForm();
    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
    expect(commentCalls()).toHaveLength(0);
  });

  it("trims the comment it sends", async () => {
    // Sabotage found this gap: sending the raw text passed every test, because the only
    // whitespace case tested was whitespace-ONLY, which the empty guard already stops.
    const user = userEvent.setup();
    renderNewFeed();
    await user.type(screen.getByLabelText(/comment/i), "   she loved it   ");
    await submitForm();

    await waitFor(() => expect(commentCalls()).toHaveLength(1));
    expect(commentCalls()[0].body.body).toBe("she loved it");
  });

  it("sends no comment when the save created no entry", async () => {
    // An edit-shaped outcome carries no created id. There is nothing to hang a comment on, and
    // inventing a parent would attach it to the wrong entry -- or to none.
    activitySaveOutcome = { action: "update", activityId: "activity-existing-1" };
    const user = userEvent.setup();
    renderNewFeed();
    await user.type(screen.getByLabelText(/comment/i), "orphan");
    await submitForm();

    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
    expect(commentCalls()).toHaveLength(0);
  });

  it("still saves the entry when the comment fails to send", async () => {
    // The entry is the thing that matters. A comment that does not send is a disappointment;
    // a nap that vanishes because of it would be a bug worth reverting this feature over.
    commentShouldFail = true;
    const user = userEvent.setup();
    renderNewFeed();
    await user.type(screen.getByLabelText(/comment/i), "This one will not send");
    await submitForm();

    await waitFor(() => expect(commentCalls()).toHaveLength(1));
    // The form still completes: the entry was created and the screen moves on.
    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
  });
});
