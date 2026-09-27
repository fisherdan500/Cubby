// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/browser-operation-tab-scope", () => ({ tabScopedBrowserOperationStorageKey: async (_p: string, key: string) => key }));
import { runFeedOperation } from "./feed-post-actions";
const id = "bmo_0123456789abcdefghjkmnpqrs";
const partition = "a".repeat(64);
const response = (data: unknown, status = 200) => new Response(JSON.stringify({ ok: true, data }), { status });
const cases = [
  ["/api/feed/posts", "POST", { body: "draft" }, { kind: "feed_post", code: "created", postId: "p" }],
  ["/api/feed/posts/p", "PATCH", {}, { kind: "feed_post", code: "updated", postId: "p" }],
  ["/api/feed/posts/p", "DELETE", {}, { kind: "feed_post", code: "deleted", postId: "p" }],
  ["/api/feed/posts/p/restore", "POST", {}, { kind: "feed_post", code: "restored", postId: "p" }],
  ["/api/feed/comments", "POST", { body: "draft" }, { kind: "feed_comment", code: "created", commentId: "c" }],
  ["/api/feed/comments/c", "PATCH", {}, { kind: "feed_comment", code: "updated", commentId: "c" }],
  ["/api/feed/comments/c", "DELETE", {}, { kind: "feed_comment", code: "deleted", commentId: "c" }],
  ["/api/feed/reactions", "PUT", { reaction: "love", on: true }, { kind: "feed_reaction", code: "set", reaction: "love", on: true }]
] as const;
beforeEach(() => sessionStorage.clear());

it.each(["partition", "issuance"])("does not submit after invalid %s", async (stage) => {
  globalThis.fetch = vi.fn().mockResolvedValueOnce(response({ version: 1, scope: "household", partition: stage === "partition" ? "not-a-partition" : partition }))
    .mockResolvedValueOnce(response({ status: "open", operationId: 123, bindingId: "binding" }));
  expect((await runFeedOperation("invalid", "/api/feed/posts", "POST", { body: "Keep" })).ok).toBe(false);
  expect(sessionStorage.length).toBe(0); expect(globalThis.fetch).toHaveBeenCalledTimes(stage === "partition" ? 1 : 2);
});

it("validates a reaction against its detached original intent", async () => {
  const fields = { reaction: "love", on: true };
  let settle!: (response: Response) => void;
  globalThis.fetch = vi.fn().mockResolvedValueOnce(response({ version: 1, scope: "household", partition }))
    .mockResolvedValueOnce(response({ status: "open", operationId: id, bindingId: "binding" }))
    .mockImplementationOnce(() => new Promise<Response>((resolve) => { settle = resolve; }));
  const pending = runFeedOperation("mutation", "/api/feed/reactions", "PUT", fields);
  await vi.waitFor(() => expect(settle).toBeTypeOf("function")); fields.on = false;
  settle(response({ status: "completed", operationId: id, outcome: { operationId: id, kind: "feed_reaction", code: "set", reaction: "love", on: true } }));
  expect((await pending).ok).toBe(true);
});
it.each([true, false])("retires a valid old reaction receipt after reload without acknowledging the new %s intent", async (previousOn) => {
  const key = `reloaded-reaction:${partition}`;
  sessionStorage.setItem(key, id); // ID survived reload; immutable original intent did not.
  const fetcher = vi.fn().mockResolvedValueOnce(response({ version: 1, scope: "household", partition }))
    .mockResolvedValueOnce(response({ status: "completed", operationId: id, outcome: { operationId: id, kind: "feed_reaction", code: "set", reaction: "love", on: previousOn } }));
  globalThis.fetch = fetcher;
  const result = await runFeedOperation("reloaded-reaction", "/api/feed/reactions", "PUT", { reaction: "love", on: !previousOn });
  expect(result.ok).toBe(false); // The new opposite intent was never sent.
  expect(sessionStorage.getItem(key)).toBeNull(); // The valid old receipt must not trap the slot.
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it.each([
  {}, { kind: "feed_reaction", code: "set", reaction: "love", on: "true" },
  { kind: "feed_reaction", code: "set", reaction: "funny", on: true },
  { kind: "feed_reaction", code: "bogus", reaction: "love", on: true }
])("does not retire malformed or wrong-target reloaded reaction receipts %j", async (outcome) => {
  const key = `unknown-reaction:${partition}`;
  sessionStorage.setItem(key, id);
  globalThis.fetch = vi.fn().mockResolvedValueOnce(response({ version: 1, scope: "household", partition }))
    .mockResolvedValueOnce(response({ status: "completed", operationId: id, outcome: { operationId: id, ...outcome } }));
  expect((await runFeedOperation("unknown-reaction", "/api/feed/reactions", "PUT", { reaction: "love", on: false })).ok).toBe(false);
  expect(sessionStorage.getItem(key)).toBe(id);
  expect(globalThis.fetch).toHaveBeenCalledTimes(2);
});
it.each(cases)("checks submit and reconciliation terminal variants for %s %s", async (url, method, fields, outcome) => {
  const key = `strict:${partition}`;
  const invalid = [{}, { ...outcome, operationId: undefined }, { ...outcome, operationId: "bmo_zzzzzzzzzzzzzzzzzzzzzzzzzz" },
    { ...outcome, operationId: "bmo_short" }, { ...outcome, kind: "other" }, { ...outcome, code: "bogus" }, { ...outcome, extra: true },
    ...( "postId" in outcome ? [{ ...outcome, postId: "" }, { kind: outcome.kind, code: outcome.code }, ...(url === "/api/feed/posts" ? [] : [{ ...outcome, postId: "wrong" }])] : []),
    ...( "commentId" in outcome ? [{ ...outcome, commentId: "" }, { kind: outcome.kind, code: outcome.code }, ...(url === "/api/feed/comments" ? [] : [{ ...outcome, commentId: "wrong" }])] : []),
    ...( "reaction" in outcome ? [{ ...outcome, reaction: "bogus" }, { ...outcome, on: "true" }, { ...outcome, reaction: "funny" }, { ...outcome, on: false }] : [])];
  for (const terminal of [...invalid.map((value) => ({ status: "completed", outcome: { operationId: id, ...value } })), { status: "stale", code: "bogus" }, { status: "rejected", code: "stale_revision" }]) {
    sessionStorage.clear();
    const fetcher = vi.fn().mockResolvedValueOnce(response({ version: 1, scope: "household", partition }))
      .mockResolvedValueOnce(response({ status: "open", operationId: id, bindingId: "binding" }))
      .mockResolvedValueOnce(response({ ...terminal, operationId: id }));
    globalThis.fetch = fetcher;
    expect((await runFeedOperation("strict", url, method, fields)).ok).toBe(false);
    expect(sessionStorage.getItem(key)).toBe(id);
    fetcher.mockResolvedValueOnce(response({ version: 1, scope: "household", partition })).mockResolvedValueOnce(response({ ...terminal, operationId: id }));
    expect((await runFeedOperation("strict", url, method, fields)).ok).toBe(false);
    expect(sessionStorage.getItem(key)).toBe(id);
    fetcher.mockResolvedValueOnce(response({ version: 1, scope: "household", partition })).mockResolvedValueOnce(response({ status: "completed", operationId: id, outcome: { operationId: id, ...outcome } }));
    expect((await runFeedOperation("strict", url, method, fields)).ok).toBe(true);
    expect(sessionStorage.getItem(key)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(7);
  }
});
