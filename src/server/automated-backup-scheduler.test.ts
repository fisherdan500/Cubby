import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  reconcile: vi.fn(),
  scan: vi.fn(),
  sanitize: vi.fn()
}));

vi.mock("@/lib/env", () => ({
  automatedBackupConfig: {
    enabled: true,
    directory: "/var/lib/cubby/backups",
    intervalHours: 24,
    retentionCount: 30,
    pollMinutes: 15,
    retryMinutes: 60
  }
}));

vi.mock("@/server/services/automated-backups", () => ({
  reconcileAutomatedBackupStorage: mocks.reconcile,
  runAutomatedBackupScan: mocks.scan,
  sanitizeAutomatedBackupError: mocks.sanitize
}));

import { startAutomatedBackupScheduler } from "@/server/automated-backup-scheduler";

describe("automated backup scheduler", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    mocks.sanitize.mockReturnValue("backup_write_failed");
    globalThis.__cubbyAutomatedBackupScheduler__ = undefined;
  });

  it("starts once, reconciles first, and runs an immediate scan", async () => {
    const state = await startAutomatedBackupScheduler();

    expect(state.started).toBe(true);
    expect(mocks.reconcile).toHaveBeenCalledOnce();
    expect(mocks.scan).toHaveBeenCalledOnce();
  });

  it("does not create a duplicate loop in one process", async () => {
    const first = await startAutomatedBackupScheduler();
    const second = await startAutomatedBackupScheduler();

    expect(first).toBe(second);
    expect(mocks.reconcile).toHaveBeenCalledOnce();
  });

  it("continues with the immediate scan and timer when reconciliation fails", async () => {
    mocks.reconcile.mockRejectedValue(new Error("backup_directory_unavailable"));
    mocks.sanitize.mockReturnValue("backup_directory_unavailable");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const state = await startAutomatedBackupScheduler();

    expect(state.started).toBe(true);
    expect(state.timer).not.toBeNull();
    expect(mocks.scan).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith("backup_scheduler_reconcile_failed", "backup_directory_unavailable");
  });

  it("does not log raw scan failures", async () => {
    const failure = new Error("postgresql://user:secret@private-host/cubby");
    mocks.scan.mockRejectedValue(failure);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await startAutomatedBackupScheduler();

    expect(mocks.sanitize).toHaveBeenCalledWith(failure);
    expect(error).toHaveBeenCalledWith("backup_scheduler_tick_failed", "backup_write_failed");
    expect(JSON.stringify(error.mock.calls)).not.toContain("private-host");
    expect(JSON.stringify(error.mock.calls)).not.toContain("secret");
  });
});
