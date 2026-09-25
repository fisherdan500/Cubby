import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ purgeDueAttachments: vi.fn(), sweepStaleBackupUploads: vi.fn() }));
vi.mock("@/server/services/attachments", () => ({ purgeDueAttachments: mocks.purgeDueAttachments }));
vi.mock("@/server/services/backup-upload", () => ({ sweepStaleBackupUploads: mocks.sweepStaleBackupUploads }));

import { runAttachmentRetention } from "@/server/services/attachment-retention";

describe("attachment retention", () => {
  it("purges due attachments and clears stale backup uploads in one pass", async () => {
    const now = new Date("2026-09-30T12:00:00Z");
    mocks.purgeDueAttachments.mockResolvedValue({ purged: 2 });
    mocks.sweepStaleBackupUploads.mockResolvedValue(1);

    await expect(runAttachmentRetention(now)).resolves.toEqual({ purged: 2, staleUploads: 1 });
    expect(mocks.purgeDueAttachments).toHaveBeenCalledWith(now);
    expect(mocks.sweepStaleBackupUploads).toHaveBeenCalledWith(now);
  });
});
