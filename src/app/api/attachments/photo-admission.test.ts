import { afterEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ stage: vi.fn() }));
vi.mock("@/server/auth/context", () => ({ getEffectiveHouseholdContext: async () => ({ role: "owner" }), requirePermission: vi.fn() }));
vi.mock("@/server/services/attachments", () => ({ stageFeedPhoto: m.stage }));
import { POST } from "./feed-photos/route";
function upload(body: BodyInit, signal?: AbortSignal) { return new Request("https://cubby.test/photo", { method: "POST", body, signal, duplex: "half" } as RequestInit); }
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });
it("holds one pre-body slot until staging really settles", async () => {
  let finish!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((r) => { entered = r; });
  m.stage.mockImplementationOnce(async () => { entered(); await new Promise<void>((r) => { finish = r; }); });
  const first = POST(upload("photo"));
  await ready;
  try {
    const second = upload("photo");
    const read = vi.spyOn(second.body!, "getReader");
    expect((await POST(second)).status).toBe(429);
    expect(read).not.toHaveBeenCalled();
  } finally { finish(); await first; }
  expect((await POST(upload("photo"))).status).toBe(201);
});
it.each(["deadline", "abort"])("cancels the actual photo reader on %s", async (reason) => {
  vi.useFakeTimers();
  const abort = new AbortController();
  const cancel = vi.fn();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const request = upload(new ReadableStream<Uint8Array>({ start(c) { controller = c; }, cancel }), abort.signal);
  const pending = POST(request);
  await Promise.resolve(); await Promise.resolve();
  try {
    if (reason === "deadline") await vi.advanceTimersByTimeAsync(120_001); else { abort.abort(); await Promise.resolve(); }
    expect(cancel).toHaveBeenCalledOnce();
    expect((await pending).status).toBe(408);
    expect(m.stage).not.toHaveBeenCalled();
  } finally { if (!cancel.mock.calls.length) controller.close(); await pending; }
  expect(request.body!.locked).toBe(false);
});
