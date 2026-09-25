import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ runAttachmentRetention: vi.fn() }));
vi.mock("@/server/services/attachment-retention", () => ({ runAttachmentRetention: mocks.runAttachmentRetention }));

afterEach(() => {
  delete globalThis.__cubbyAttachmentRetentionScheduler__;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("attachment retention scheduler", () => {
  it("runs retention at start and then every fifteen minutes, once per process", async () => {
    vi.useFakeTimers();
    mocks.runAttachmentRetention.mockResolvedValue({ purged: 0, staleUploads: 0 });
    const { startAttachmentRetentionScheduler } = await import("@/server/attachment-retention-scheduler");

    await startAttachmentRetentionScheduler();
    await startAttachmentRetentionScheduler();
    expect(mocks.runAttachmentRetention).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(mocks.runAttachmentRetention).toHaveBeenCalledTimes(2);
  });

  it("logs a failed run by code only and keeps going", async () => {
    mocks.runAttachmentRetention.mockRejectedValue(new Error("/var/lib/cubby/attachments/objects/ab/secret-path"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { startAttachmentRetentionScheduler } = await import("@/server/attachment-retention-scheduler");

    await expect(startAttachmentRetentionScheduler()).resolves.toBeDefined();
    expect(error).toHaveBeenCalledWith("attachment_retention_tick_failed", "attachment_retention_failed");
    expect(JSON.stringify(error.mock.calls)).not.toContain("secret-path");
  });
});
