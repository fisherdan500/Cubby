// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionActivityReporter } from "@/components/session-activity-reporter";

describe("SessionActivityReporter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  });

  it("reports once only after the authenticated document has rendered and become visible", async () => {
    render(createElement(SessionActivityReporter));
    await act(async () => {});
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith("/api/account/session-activity", expect.objectContaining({ method: "POST", keepalive: true, body: JSON.stringify({ requestClass: "foreground_document_navigation" }) }));
  });

  it("does not report a hidden/background render", async () => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    render(createElement(SessionActivityReporter));
    await act(async () => {});
    expect(fetch).not.toHaveBeenCalled();
  });
});
