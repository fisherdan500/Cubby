import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: { enabled: false, intervalHours: 168 },
  run: vi.fn()
}));

vi.mock("@/lib/env", () => ({ integrityConfig: mocks.config }));
vi.mock("@/lib/db/prisma", () => ({ prisma: {} }));
vi.mock("@/server/services/integrity", () => ({ runScheduledIntegritySuite: mocks.run }));

import { startIntegrityScheduler } from "@/server/integrity-scheduler";

describe("integrity scheduler", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    mocks.config.enabled = false;
    mocks.config.intervalHours = 168;
    globalThis.__cubbyIntegrityScheduler__ = undefined;
  });

  it("does nothing unless explicitly enabled", async () => {
    const state = await startIntegrityScheduler();

    expect(state).toMatchObject({ started: false, running: false, timer: null });
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("starts once and schedules a bounded configured run", async () => {
    mocks.config.enabled = true;
    mocks.config.intervalHours = 24;
    mocks.run.mockResolvedValue({
      executed: true,
      report: { status: "clean", version: 1, findings: [], evidenceFingerprint: "a".repeat(64) }
    });

    const first = await startIntegrityScheduler();
    const second = await startIntegrityScheduler();

    expect(first).toBe(second);
    expect(first.started).toBe(true);
    expect(mocks.run).toHaveBeenCalledOnce();
    expect(first.timer).not.toBeNull();
  });
});
