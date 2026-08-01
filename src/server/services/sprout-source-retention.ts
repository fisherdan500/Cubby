import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import {
  readSproutStagingConfig,
  removeStagedSproutBytes
} from "@/server/services/sprout-staging";
import { SPROUT_SOURCE_SYSTEM } from "@/server/services/sprout-import-contract";

const PREVIEW_RETENTION_MS = 24 * 60 * 60 * 1000;
const FAILED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const COMPLETE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RETRY_DELAY_MS = 15 * 60 * 1000;
const LEASE_DURATION_MS = 5 * 60 * 1000;
const FAILED_PREVIEW_WRITE_GRACE_MS = 15 * 60 * 1000;
const DEFAULT_LIMIT = 100;

type RetentionRow = {
  id: string;
  sourceSystem: string;
  sourceFilename: string | null;
  sourceFormat: string;
  sourceDigest: string | null;
  stagedFilename: string | null;
  stagedNonce: string | null;
  stagedAuthTag: string | null;
  stagedKeyVersion: string | null;
  status: string;
  createdAt: Date;
  completedAt: Date | null;
};

type RunOptions = {
  limit?: number;
};

export function sproutSourceRetentionWhere(now: Date) {
  return {
    sourceSystem: SPROUT_SOURCE_SYSTEM,
    rawSourceDeletedAt: null,
    stagedFilename: { not: null },
    AND: [
      {
        OR: [
          { rawSourceCleanupLeaseExpiresAt: null },
          { rawSourceCleanupLeaseExpiresAt: { lte: now } }
        ]
      },
      {
        OR: [
          { rawSourceCleanupNextRetryAt: null },
          { rawSourceCleanupNextRetryAt: { lte: now } }
        ]
      }
    ],
    OR: [
      {
        sourceDigest: { not: null },
        stagedNonce: { not: null },
        stagedAuthTag: { not: null },
        stagedKeyVersion: { not: null },
        OR: [
          { status: "preview", createdAt: { lte: new Date(now.getTime() - PREVIEW_RETENTION_MS) } },
          {
            status: "failed",
            OR: [
              { completedAt: { lte: new Date(now.getTime() - FAILED_RETENTION_MS) } },
              { completedAt: null, createdAt: { lte: new Date(now.getTime() - FAILED_RETENTION_MS) } }
            ]
          },
          {
            status: "complete",
            OR: [
              { completedAt: { lte: new Date(now.getTime() - COMPLETE_RETENTION_MS) } },
              { completedAt: null, createdAt: { lte: new Date(now.getTime() - COMPLETE_RETENTION_MS) } }
            ]
          }
        ]
      },
      {
        status: "failed",
        sourceDigest: null,
        createdAt: { lte: new Date(now.getTime() - FAILED_PREVIEW_WRITE_GRACE_MS) }
      }
    ]
  };
}

export async function runSproutSourceRetention(now = new Date(), options: RunOptions = {}) {
  const limit = boundedLimit(options.limit);
  const rows = await prisma.importBatch.findMany({
    where: sproutSourceRetentionWhere(now),
    orderBy: { createdAt: "asc" },
    take: limit,
    select: {
      id: true,
      sourceSystem: true,
      sourceFilename: true,
      sourceFormat: true,
      sourceDigest: true,
      stagedFilename: true,
      stagedNonce: true,
      stagedAuthTag: true,
      stagedKeyVersion: true,
      status: true,
      createdAt: true,
      completedAt: true
    }
  });
  const config = readSproutStagingConfig({
    SPROUT_STAGING_DIRECTORY: process.env.SPROUT_STAGING_DIRECTORY,
    SPROUT_STAGING_KEY_FILE: process.env.SPROUT_STAGING_KEY_FILE,
    SPROUT_STAGING_KEY_VERSION: process.env.SPROUT_STAGING_KEY_VERSION
  });
  const result = { deleted: 0, pending: 0, skipped: 0 };

  for (const row of rows as RetentionRow[]) {
    if (!row.stagedFilename) {
      result.skipped += 1;
      continue;
    }
    const leaseToken = randomUUID();
    const claimed = await prisma.importBatch.updateMany({
      where: retentionWhereForRow(row, now),
      data: {
        rawSourceCleanupPendingAt: now,
        rawSourceCleanupAttempts: { increment: 1 },
        rawSourceCleanupLastError: null,
        rawSourceCleanupLeaseToken: leaseToken,
        rawSourceCleanupLeaseExpiresAt: new Date(now.getTime() + LEASE_DURATION_MS)
      }
    });
    if (claimed.count !== 1) {
      result.skipped += 1;
      continue;
    }

    try {
      await removeStagedSproutBytes(row.stagedFilename, config);
    } catch {
      await prisma.importBatch.updateMany({
        where: ownedRetentionWhereForRow(row, leaseToken),
        data: {
          rawSourceCleanupPendingAt: now,
          rawSourceCleanupNextRetryAt: new Date(now.getTime() + RETRY_DELAY_MS),
          rawSourceCleanupLastError: "sprout_staging_unavailable",
          rawSourceCleanupLeaseToken: null,
          rawSourceCleanupLeaseExpiresAt: null
        }
      });
      result.pending += 1;
      continue;
    }

    const deleted = await prisma.importBatch.updateMany({
      where: ownedRetentionWhereForRow(row, leaseToken),
      data: {
        sourceFilename: null,
        sourceDigest: null,
        stagedFilename: null,
        stagedNonce: null,
        stagedAuthTag: null,
        stagedKeyVersion: null,
        summary: Prisma.JsonNull,
        warnings: [],
        error: null,
        rawSourceDeletedAt: now,
        rawSourceRetentionReceipt: retentionReceipt(row),
        rawSourceCleanupPendingAt: null,
        rawSourceCleanupNextRetryAt: null,
        rawSourceCleanupLastError: null,
        rawSourceCleanupLeaseToken: null,
        rawSourceCleanupLeaseExpiresAt: null
      }
    });
    if (deleted.count === 1) result.deleted += 1;
    else result.pending += 1;
  }

  return result;
}

function retentionWhereForRow(row: RetentionRow, now: Date) {
  return {
    id: row.id,
    ...sproutSourceRetentionWhere(now),
    sourceDigest: row.sourceDigest,
    stagedFilename: row.stagedFilename,
    stagedNonce: row.stagedNonce,
    stagedAuthTag: row.stagedAuthTag,
    stagedKeyVersion: row.stagedKeyVersion
  };
}

function ownedRetentionWhereForRow(row: RetentionRow, leaseToken: string) {
  return {
    id: row.id,
    sourceSystem: row.sourceSystem,
    rawSourceDeletedAt: null,
    sourceDigest: row.sourceDigest,
    stagedFilename: row.stagedFilename,
    stagedNonce: row.stagedNonce,
    stagedAuthTag: row.stagedAuthTag,
    stagedKeyVersion: row.stagedKeyVersion,
    status: row.status,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
    rawSourceCleanupLeaseToken: leaseToken
  };
}

function retentionReceipt(row: RetentionRow) {
  return {
    version: 1,
    sourceSystem: row.sourceSystem,
    sourceFormat: row.sourceFormat,
    terminalStatus: row.status,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null
  };
}

function boundedLimit(value: number | undefined) {
  if (!Number.isInteger(value) || !value || value < 1) return DEFAULT_LIMIT;
  return Math.min(value, DEFAULT_LIMIT);
}
