import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("@/server/services/browser-operation-retention", () => ({
  runHouseholdBrowserOperationRetention: mocks.run
}));

import { startBrowserOperationRetentionScheduler } from "@/server/browser-operation-retention-scheduler";

describe("browser operation retention scheduler", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.run.mockResolvedValue({ unresolvedAlertCount: 2, compactedCount: 1, deletedBindingCount: 1 });
    delete globalThis.__cubbyBrowserOperationRetentionScheduler__;
  });

  it("starts once, runs a bounded tick, and reports only content-free counts", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const first = await startBrowserOperationRetentionScheduler();
    const second = await startBrowserOperationRetentionScheduler();
    expect(first).toBe(second);
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(mocks.run).toHaveBeenCalledWith({ batchSize: 100 });
    expect(info).toHaveBeenCalledWith("browser_operation_retention_result", 2, 1, 1);
    first.timer && clearInterval(first.timer);
    info.mockRestore();
  });
});
