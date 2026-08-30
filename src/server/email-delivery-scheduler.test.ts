import { describe, expect, it, vi } from "vitest";
import { runEmailDeliveryBatch } from "@/server/services/email-delivery-worker";

describe("email delivery scheduler", () => {
  it("drains a bounded batch with fresh claim authority and content-free totals", async () => {
    const dispatch = vi.fn()
      .mockResolvedValueOnce({ status: "accepted", deliveryId: "private-1" })
      .mockResolvedValueOnce({ status: "failed", deliveryId: "private-2", code: "smtp_rejected" })
      .mockResolvedValueOnce({ status: "idle" });
    const tokens = ["worker-token-000000000001", "worker-token-000000000002", "worker-token-000000000003"];

    await expect(runEmailDeliveryBatch({ database: {} as never, cipher: {} as never, smtp: {} as never, dispatch, workerToken: () => tokens.shift()! }, 10)).resolves.toEqual({ accepted: 1, failed: 1, idle: true });
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(dispatch.mock.calls.map((call) => call[1])).toEqual([
      "worker-token-000000000001",
      "worker-token-000000000002",
      "worker-token-000000000003"
    ]);
  });
});
