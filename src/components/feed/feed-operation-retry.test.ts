// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/browser-operation-tab-scope", () => ({ tabScopedBrowserOperationStorageKey: async (_p: string, key: string) => key }));
import { runFeedOperation } from "./feed-post-actions";
const id = "bmo_0123456789abcdefghjkmnpqrs";
const key = "retry:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const response = (status: number, body: unknown) => ({ status, ok: status >= 200 && status < 300, json: async () => body }) as Response;
const envelope = (status: string, operationId = id) => ({ ok: true, data: { status, operationId, ...(status === "open" ? { bindingId: "binding" } : { outcome: { operationId, kind: "feed_post", code: "created", postId: "post-1" } }) } });
const partition = () => response(200, { ok: true, data: { version: 1, scope: "household", partition: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } });
const run = () => runFeedOperation("retry", "/api/feed/posts", "POST", { body: "A", babyId: null });
beforeEach(() => sessionStorage.clear());
describe("indeterminate feed HTTP outcomes", () => {
  it.each([
    [502, null], [200, null], [200, { ok: true }],
    [200, envelope("completed", "other")], [503, envelope("completed")],
    [200, { ok: true, data: { status: "completed", operationId: id } }]
  ])("retains submission identity for ambiguous %s/%j", async (status, body) => {
    const fetcher = vi.fn().mockResolvedValueOnce(partition()).mockResolvedValueOnce(response(200, envelope("open")))
      .mockResolvedValueOnce(response(status as number, body));
    globalThis.fetch = fetcher;
    expect((await run()).ok).toBe(false);
    expect(sessionStorage.getItem(key)).toBe(id);
    fetcher.mockResolvedValueOnce(partition()).mockResolvedValueOnce(response(200, envelope("completed")));
    expect((await run()).ok).toBe(true);
    expect(fetcher.mock.calls.map(([url]) => url).filter((url) => url === "/api/feed/posts")).toHaveLength(1);
    expect(fetcher.mock.calls[4][0]).toBe(`/api/browser-operations/${id}`);
  });
  it.each([[502, null], [404, { ok: false }], [200, envelope("completed", "other")], [410, { ok: true, data: { status: "expired", operationId: "other", code: "operation_abandoned" } }]])("retains an ambiguous status lookup %s/%j", async (status, body) => {
    sessionStorage.setItem(key, id);
    globalThis.fetch = vi.fn().mockResolvedValueOnce(partition()).mockResolvedValueOnce(response(status as number, body));
    expect((await run()).ok).toBe(false);
    expect(sessionStorage.getItem(key)).toBe(id);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
  it("clears only the exact authorized expiry, without issuing a replacement in the same click", async () => {
    sessionStorage.setItem(key, id);
    globalThis.fetch = vi.fn().mockResolvedValueOnce(partition()).mockResolvedValueOnce(response(410, { ok: true, data: { status: "expired", operationId: id, code: "operation_abandoned" } }));
    expect((await run()).ok).toBe(false);
    expect(sessionStorage.getItem(key)).toBeNull();
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});
