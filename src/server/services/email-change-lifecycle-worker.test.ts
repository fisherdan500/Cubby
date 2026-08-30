import { describe, expect, it, vi } from "vitest";
import { runEmailChangeLifecycleWorkerTick } from "@/server/services/email-change-lifecycle-worker";

describe("email-change lifecycle worker", () => {
  it("runs one bounded database-clock lifecycle batch", async () => {
    const database = { $queryRaw: vi.fn().mockResolvedValue([{ expiredChanges: 3, expiredRotations: 2 }]) };
    await expect(runEmailChangeLifecycleWorkerTick(database as never, 25)).resolves.toEqual({ expiredChanges: 3, expiredRotations: 2 });
    expect(database.$queryRaw).toHaveBeenCalledOnce();
    expect(database.$queryRaw.mock.calls[0]![0].join(" ")).toContain('run_email_change_lifecycle_batch');
  });

  it("rejects an invalid batch bound before database access", async () => {
    const database = { $queryRaw: vi.fn() };
    await expect(runEmailChangeLifecycleWorkerTick(database as never, 0)).rejects.toThrow("email_change_lifecycle_batch_invalid");
    expect(database.$queryRaw).not.toHaveBeenCalled();
  });
});
