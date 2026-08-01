import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock("@/server/services/sprout-source-retention", () => ({ runSproutSourceRetention: mocks.run }));

import { startSproutSourceRetentionScheduler } from "@/server/sprout-source-retention-scheduler";

describe("Sprout source retention scheduler", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    globalThis.__cubbySproutSourceRetentionScheduler__ = undefined;
  });

  it("runs cleanup immediately and schedules bounded retries without duplicate loops", async () => {
    const first = await startSproutSourceRetentionScheduler();
    const second = await startSproutSourceRetentionScheduler();

    expect(first).toBe(second);
    expect(mocks.run).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(mocks.run).toHaveBeenCalledTimes(2);
  });

  it("sanitizes a failed cleanup tick and continues retry scheduling", async () => {
    mocks.run.mockRejectedValue(new Error("private staging path"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const state = await startSproutSourceRetentionScheduler();
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);

    expect(state.timer).not.toBeNull();
    expect(error).toHaveBeenCalledWith("sprout_source_retention_tick_failed", "sprout_source_retention_failed");
    expect(JSON.stringify(error.mock.calls)).not.toContain("private staging path");
  });
});
