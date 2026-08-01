import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  updateMany: vi.fn(),
  remove: vi.fn(),
  config: vi.fn()
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    importBatch: {
      findMany: mocks.findMany,
      updateMany: mocks.updateMany
    }
  }
}));

vi.mock("@/server/services/sprout-staging", () => ({
  readSproutStagingConfig: mocks.config,
  removeStagedSproutBytes: mocks.remove
}));

import { runSproutSourceRetention, sproutSourceRetentionWhere } from "@/server/services/sprout-source-retention";

const now = new Date("2026-07-31T12:00:00.000Z");
const config = { directory: "/var/lib/cubby/sprout-staging", keyFile: "/run/secrets/cubby_sprout_staging_key", keyVersion: "v1" };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.config.mockReturnValue(config);
  mocks.remove.mockResolvedValue(undefined);
  mocks.updateMany.mockResolvedValue({ count: 1 });
});

describe("Sprout encrypted-source retention", () => {
  it("selects a failed pre-staging cleanup ledger with only its durable filename after a bounded grace period", () => {
    const where = sproutSourceRetentionWhere(now);

    expect(where).not.toHaveProperty("sourceDigest");
    expect(where.OR).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "failed",
        sourceDigest: null,
        createdAt: { lte: new Date("2026-07-31T11:45:00.000Z") }
      })
    ]));
  });

  it.each([
    ["preview", new Date("2026-07-30T12:00:00.000Z"), null],
    ["failed", new Date("2026-07-20T12:00:00.000Z"), new Date("2026-07-24T12:00:00.000Z")],
    ["complete", new Date("2026-06-01T12:00:00.000Z"), new Date("2026-07-01T12:00:00.000Z")]
  ] as const)("deletes an expired %s staged source at its retention boundary", async (status, createdAt, completedAt) => {
    const row = stagedRow({ status, createdAt, completedAt });
    mocks.findMany.mockResolvedValue([row]);

    await expect(runSproutSourceRetention(now)).resolves.toEqual({ deleted: 1, pending: 0, skipped: 0 });

    expect(mocks.remove).toHaveBeenCalledWith("sprout-stage-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bin", config);
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ sourceSystem: "sprout-track", rawSourceDeletedAt: null }),
      take: 100
    }));
  });

  it("does not select a preview, failure, or completion before its retention cutoff", async () => {
    mocks.findMany.mockResolvedValue([]);

    await runSproutSourceRetention(now);

    const where = mocks.findMany.mock.calls[0]?.[0]?.where;
    expect(where.OR[0].OR).toEqual(expect.arrayContaining([
      { status: "preview", createdAt: { lte: new Date("2026-07-30T12:00:00.000Z") } },
      expect.objectContaining({ status: "failed" }),
      expect.objectContaining({ status: "complete" })
    ]));
  });

  it("eventually deletes a failed pre-preview ledger whose metadata persistence or preview transition never completed", async () => {
    const row = stagedRow({
      status: "failed",
      createdAt: new Date("2026-07-24T12:00:00.000Z"),
      completedAt: null,
      sourceFilename: null,
      summary: null,
      warnings: [],
      error: "sprout_import_failed"
    });
    mocks.findMany.mockResolvedValue([row]);

    await expect(runSproutSourceRetention(now)).resolves.toEqual({ deleted: 1, pending: 0, skipped: 0 });

    expect(mocks.remove).toHaveBeenCalledWith(row.stagedFilename, config);
    expect(mocks.updateMany.mock.calls[0]?.[0]?.where.OR[0].OR).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "failed",
        OR: expect.arrayContaining([{ completedAt: null, createdAt: { lte: new Date("2026-07-24T12:00:00.000Z") } }])
      })
    ]));
  });

  it("reasserts the selected source metadata and current eligibility when claiming cleanup", async () => {
    const row = stagedRow({ status: "preview", createdAt: new Date("2026-07-30T12:00:00.000Z") });
    mocks.findMany.mockResolvedValue([row]);

    await runSproutSourceRetention(now);

    const claim = mocks.updateMany.mock.calls[0]?.[0];
    expect(claim.where).toEqual(expect.objectContaining({
      id: row.id,
      sourceSystem: "sprout-track",
      rawSourceDeletedAt: null,
      sourceDigest: row.sourceDigest,
      stagedFilename: row.stagedFilename,
      stagedNonce: row.stagedNonce,
      stagedAuthTag: row.stagedAuthTag,
      stagedKeyVersion: row.stagedKeyVersion
    }));
    expect(claim.where.AND).toEqual(expect.arrayContaining([
      expect.objectContaining({ OR: expect.arrayContaining([{ rawSourceCleanupLeaseExpiresAt: null }]) }),
      expect.objectContaining({ OR: expect.arrayContaining([{ rawSourceCleanupNextRetryAt: null }]) })
    ]));
    expect(claim.where.OR[0].OR).toEqual(expect.arrayContaining([
      { status: "preview", createdAt: { lte: new Date("2026-07-30T12:00:00.000Z") } }
    ]));
  });

  it("does not erase a just-completed batch after a stale preview cleanup claim", async () => {
    const row = stagedRow({ status: "preview", createdAt: new Date("2026-07-30T12:00:00.000Z") });
    mocks.findMany.mockResolvedValue([row]);
    mocks.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

    await expect(runSproutSourceRetention(now)).resolves.toEqual({ deleted: 0, pending: 1, skipped: 0 });

    const finalUpdate = mocks.updateMany.mock.calls[1]?.[0];
    expect(finalUpdate.where).toEqual(expect.objectContaining({
      id: row.id,
      sourceSystem: "sprout-track",
      rawSourceDeletedAt: null,
      sourceDigest: row.sourceDigest,
      stagedFilename: row.stagedFilename,
      stagedNonce: row.stagedNonce,
      stagedAuthTag: row.stagedAuthTag,
      stagedKeyVersion: row.stagedKeyVersion
    }));
    expect(finalUpdate.where).toEqual(expect.objectContaining({
      status: "preview",
      createdAt: row.createdAt,
      completedAt: row.completedAt,
      rawSourceCleanupLeaseToken: expect.any(String)
    }));
  });

  it("atomically replaces raw staging metadata with a minimized immutable receipt after deletion", async () => {
    const row = stagedRow({ status: "complete", completedAt: new Date("2026-06-01T12:00:00.000Z") });
    mocks.findMany.mockResolvedValue([row]);

    await runSproutSourceRetention(now);

    const finalUpdate = mocks.updateMany.mock.calls[1]?.[0];
    expect(finalUpdate).toEqual({
      where: expect.objectContaining({ id: row.id, rawSourceDeletedAt: null }),
      data: expect.objectContaining({
        sourceFilename: null,
        sourceDigest: null,
        stagedFilename: null,
        stagedNonce: null,
        stagedAuthTag: null,
        stagedKeyVersion: null,
        summary: expect.anything(),
        warnings: [],
        error: null,
        rawSourceDeletedAt: now,
        rawSourceCleanupPendingAt: null,
        rawSourceCleanupNextRetryAt: null,
        rawSourceCleanupLastError: null,
        rawSourceCleanupLeaseToken: null,
        rawSourceCleanupLeaseExpiresAt: null,
        rawSourceRetentionReceipt: {
          version: 1,
          sourceSystem: "sprout-track",
          sourceFormat: "json",
          terminalStatus: "complete",
          createdAt: "2026-05-01T12:00:00.000Z",
          completedAt: "2026-06-01T12:00:00.000Z"
        }
      })
    });
  });

  it("keeps raw metadata and a cleanup-pending state when deletion fails, then retries after the bounded delay", async () => {
    const row = stagedRow({ status: "failed", completedAt: new Date("2026-07-20T12:00:00.000Z") });
    mocks.findMany.mockResolvedValue([row]);
    mocks.remove.mockRejectedValueOnce(new Error("EPERM"));

    await expect(runSproutSourceRetention(now, { limit: 1 })).resolves.toEqual({ deleted: 0, pending: 1, skipped: 0 });

    const failedUpdate = mocks.updateMany.mock.calls[1]?.[0];
    expect(failedUpdate.data).toEqual(expect.objectContaining({
      rawSourceCleanupPendingAt: now,
      rawSourceCleanupNextRetryAt: new Date("2026-07-31T12:15:00.000Z"),
      rawSourceCleanupLastError: "sprout_staging_unavailable"
    }));
    expect(failedUpdate.data).not.toHaveProperty("stagedFilename");
    expect(failedUpdate.data).not.toHaveProperty("rawSourceDeletedAt");

    mocks.updateMany.mockClear();
    await expect(runSproutSourceRetention(new Date("2026-07-31T12:15:00.000Z"), { limit: 1 })).resolves.toEqual({ deleted: 1, pending: 0, skipped: 0 });
    expect(mocks.remove).toHaveBeenCalledTimes(2);
  });
});

function stagedRow(overrides: Partial<Record<string, unknown>>) {
  return {
    id: "batch-1",
    sourceSystem: "sprout-track",
    sourceFilename: "private-export.json",
    sourceFormat: "json",
    sourceDigest: "a".repeat(64),
    stagedFilename: "sprout-stage-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bin",
    stagedNonce: "AAAAAAAAAAAAAAAA",
    stagedAuthTag: "AAAAAAAAAAAAAAAAAAAAAA==",
    stagedKeyVersion: "v1",
    status: "preview",
    summary: { source: { filename: "private-export.json" } },
    completedResult: { source: { filename: "private-export.json" } },
    warnings: ["private warning"],
    error: "private error",
    createdAt: new Date("2026-05-01T12:00:00.000Z"),
    completedAt: null,
    rawSourceDeletedAt: null,
    rawSourceCleanupLeaseToken: null,
    ...overrides
  };
}
