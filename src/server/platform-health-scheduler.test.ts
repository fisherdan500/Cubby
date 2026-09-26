import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ runPlatformHealthCheck: vi.fn() }));
vi.mock("@/server/services/platform-health", () => ({ runPlatformHealthCheck: mocks.runPlatformHealthCheck }));

afterEach(() => {
  delete globalThis.__cubbyPlatformHealthScheduler__;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("platform health scheduler", () => {
  it("checks at start and then every hour, once per process", async () => {
    vi.useFakeTimers();
    mocks.runPlatformHealthCheck.mockResolvedValue({ problems: 0, emailed: 0 });
    const { startPlatformHealthScheduler } = await import("@/server/platform-health-scheduler");

    await startPlatformHealthScheduler();
    await startPlatformHealthScheduler();
    expect(mocks.runPlatformHealthCheck).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(mocks.runPlatformHealthCheck).toHaveBeenCalledTimes(2);
  });

  it("logs a failed check by code only and keeps going", async () => {
    mocks.runPlatformHealthCheck.mockRejectedValue(new Error("connect ECONNREFUSED smtp.secret.example:587"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { startPlatformHealthScheduler } = await import("@/server/platform-health-scheduler");

    await expect(startPlatformHealthScheduler()).resolves.toBeDefined();
    expect(error).toHaveBeenCalledWith("platform_health_tick_failed", "platform_health_failed");
    expect(JSON.stringify(error.mock.calls)).not.toContain("smtp.secret.example");
  });
});
