// @vitest-environment jsdom
import React, { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn(), issue: vi.fn(), submit: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }) }));
vi.mock("@/app/app/calendar/actions", () => ({
  issueCalendarEventAction: mocks.issue,
  createCalendarEventAction: mocks.submit
}));
vi.mock("@/lib/browser-operation-tab-scope", () => ({ tabScopedBrowserOperationStorageKey: async (_partition: string, key: string) => `${key}:tab:test` }));

import { CalendarEventSubmission } from "@/components/calendar-event-submission";

const MountedCalendarEventSubmission = CalendarEventSubmission as React.ComponentType<{ successHref: string }>;

globalThis.React = React;

function partitionResponse(partition = "household-a") {
  return { status: 200, ok: true, json: async () => ({ ok: true, data: { version: 1, scope: "household", partition } }) } as Response;
}

function mountedForm() {
  const children = createElement(
    React.Fragment,
    null,
    createElement("input", { name: "title", defaultValue: "Checkup" }),
    createElement("button", { type: "submit" }, "Save Event")
  );
  return createElement(MountedCalendarEventSubmission, { successHref: "/app/calendar?babyId=baby-1" }, children);
}

beforeEach(() => {
  sessionStorage.clear();
  vi.resetAllMocks();
  globalThis.fetch = vi.fn().mockResolvedValue(partitionResponse());
});
afterEach(cleanup);

describe("CalendarEventSubmission", () => {
  it("mounts, retains the server reservation, submits the same ID, and navigates on completion", async () => {
    const operationId = "bmo_0123456789abcdefghjkmnpqrs";
    mocks.issue.mockResolvedValue({ status: "open", operationId });
    mocks.submit.mockResolvedValue({ status: "completed", operationId, eventId: "event-1" });

    render(mountedForm());
    await userEvent.click(screen.getByRole("button", { name: "Save Event" }));

    await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
    const submitted = mocks.submit.mock.calls[0][0] as FormData;
    expect(submitted.get("operationId")).toBe(operationId);
    expect(submitted.get("title")).toBe("Checkup");
    expect(mocks.push).toHaveBeenCalledWith("/app/calendar?babyId=baby-1&eventId=event-1");
    expect(Object.keys(sessionStorage).filter((key) => key.startsWith("cubby:calendar-operation:"))).toHaveLength(0);
  });

  it("rehydrates a retained prepared Calendar reservation and submits the same ID", async () => {
    const operationId = "bmo_0123456789abcdefghjkmnpqrs";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "/api/browser-operations/partition") return partitionResponse();
      return { status: 202, ok: true, json: async () => ({ ok: true, data: { status: "prepared", operationId } }) } as Response;
    });
    globalThis.fetch = fetchMock;
    mocks.issue.mockResolvedValue({ status: "open", operationId });
    mocks.submit
      .mockResolvedValueOnce({ status: "pending", operationId })
      .mockResolvedValueOnce({ status: "completed", operationId, eventId: "event-1" });

    render(mountedForm());
    await userEvent.click(screen.getByRole("button", { name: "Save Event" }));
    await screen.findByRole("alert");
    const retainedKey = Object.keys(sessionStorage).find((key) => key.startsWith("cubby:calendar-operation:"));
    expect(retainedKey).toBeDefined();
    cleanup();
    render(mountedForm());
    await userEvent.click(screen.getByRole("button", { name: "Save Event" }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/app/calendar?babyId=baby-1&eventId=event-1"));
    expect(mocks.issue).toHaveBeenCalledTimes(1);
    expect(mocks.submit).toHaveBeenCalledTimes(2);
    expect((mocks.submit.mock.calls[1][0] as FormData).get("operationId")).toBe(operationId);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/browser-operations/partition", "/api/browser-operations/partition", `/api/browser-operations/${operationId}`
    ]);
  });

  it("does not reuse an in-memory event operation after the mounted household partition changes", async () => {
    const operationIdA = "bmo_0123456789abcdefghjkmnpqrs";
    const operationIdB = "bmo_1123456789abcdefghjkmnpqrs";
    const partitions = [partitionResponse(), partitionResponse("household-b")];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "/api/browser-operations/partition") return partitions.shift()!;
      return { status: 202, ok: true, json: async () => ({ ok: true, data: { status: "prepared", operationId: operationIdA } }) } as Response;
    });
    globalThis.fetch = fetchMock;
    mocks.issue
      .mockResolvedValueOnce({ status: "open", operationId: operationIdA })
      .mockResolvedValueOnce({ status: "open", operationId: operationIdB });
    mocks.submit
      .mockResolvedValueOnce({ status: "pending", operationId: operationIdA })
      .mockResolvedValueOnce({ status: "completed", operationId: operationIdB, eventId: "event-b" });

    render(mountedForm());
    await userEvent.click(screen.getByRole("button", { name: "Save Event" }));
    await screen.findByRole("alert");
    await userEvent.click(screen.getByRole("button", { name: "Save Event" }));

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/app/calendar?babyId=baby-1&eventId=event-b"));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/browser-operations/partition",
      "/api/browser-operations/partition"
    ]);
    expect(mocks.issue).toHaveBeenCalledTimes(2);
    expect((mocks.submit.mock.calls[1][0] as FormData).get("operationId")).toBe(operationIdB);
  });

  it("announces an assertive live error when partition lookup fails", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("offline"));
    render(mountedForm());

    await userEvent.click(screen.getByRole("button", { name: "Save Event" }));

    const alert = await screen.findByRole("alert");
    expect(alert.getAttribute("aria-live")).toBe("assertive");
    expect(alert.textContent).toContain("Could not reach Cubby");
    expect(mocks.issue).not.toHaveBeenCalled();
  });
});
