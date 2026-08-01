import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HouseholdRole } from "@prisma/client";

const auth = vi.hoisted(() => ({
  context: null as null | { userId: string; householdId: string; memberId: string; role: HouseholdRole },
  afterInitialContext: null as null | (() => Promise<void>)
}));

const staging = vi.hoisted(() => ({
  remove: vi.fn()
}));

vi.mock("@/server/auth/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/auth/context")>();
  return {
    ...actual,
    getHouseholdContext: vi.fn(async () => {
      if (!auth.context) throw new Error("sprout_preview_commit_acceptance_context_not_set");
      const initialContext = auth.context;
      const afterInitialContext = auth.afterInitialContext;
      auth.afterInitialContext = null;
      if (afterInitialContext) await afterInitialContext();
      return initialContext;
    })
  };
});

vi.mock("@/server/services/sprout-staging", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/services/sprout-staging")>();
  return { ...actual, removeStagedSproutBytes: staging.remove };
});

import { prisma } from "@/lib/db/prisma";
import { importSproutBackup, previewSproutBackup } from "@/server/services/sprout-import";
import { runSproutSourceRetention } from "@/server/services/sprout-source-retention";

type Fixture = {
  userId: string;
  householdId: string;
  memberId: string;
};

function upload(tables: Record<string, unknown[]>) {
  const form = new FormData();
  form.set("file", new File([JSON.stringify({ data: tables })], "reviewed.json", { type: "application/json" }));
  return form;
}

async function seedFixture(name: string): Promise<Fixture> {
  const user = await prisma.user.create({
    data: { name, email: `${name.toLowerCase().replaceAll(" ", "-")}@acceptance.invalid`, emailVerified: true }
  });
  const household = await prisma.household.create({ data: { name: `${name} Household`, createdByUserId: user.id } });
  const member = await prisma.householdMember.create({
    data: { householdId: household.id, userId: user.id, role: HouseholdRole.owner, displayName: name }
  });
  auth.context = { userId: user.id, householdId: household.id, memberId: member.id, role: HouseholdRole.owner };
  return { userId: user.id, householdId: household.id, memberId: member.id };
}

async function scopedCounts(fixture: Fixture, previewId: string) {
  return Promise.all([
    prisma.importBatch.count({ where: { householdId: fixture.householdId } }),
    prisma.importedRecord.count({ where: { householdId: fixture.householdId, importBatchId: previewId } }),
    prisma.baby.count({ where: { householdId: fixture.householdId } }),
    prisma.backupRecord.count({ where: { householdId: fixture.householdId, kind: "sprout_import" } })
  ]);
}

beforeEach(() => {
  staging.remove.mockResolvedValue(undefined);
});

afterEach(() => {
  auth.context = null;
  auth.afterInitialContext = null;
  staging.remove.mockReset();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Sprout preview-to-commit disposable PostgreSQL acceptance", () => {
  it("stages ciphertext and commits those reviewed bytes without a later browser upload", async () => {
    const fixture = await seedFixture("Staged Bytes Owner");
    const preview = await previewSproutBackup(upload({ Baby: [{ id: "reviewed-baby", firstName: "Reviewed Finley" }] }));
    const staged = await prisma.importBatch.findUniqueOrThrow({ where: { id: preview.previewId } });
    const stagingRoot = process.env.SPROUT_STAGING_DIRECTORY;
    expect(stagingRoot).toBeTruthy();
    expect(staged).toMatchObject({
      householdId: fixture.householdId,
      actorUserId: fixture.userId,
      status: "preview",
      sourceFormat: "json",
      sourceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      stagedFilename: expect.stringMatching(/^sprout-stage-[a-f0-9]{32}\.bin$/)
    });
    const ciphertext = await readFile(path.join(stagingRoot!, staged.stagedFilename!));
    expect(ciphertext).not.toContain(Buffer.from("Reviewed Finley"));

    const committed = await importSproutBackup({ previewId: preview.previewId });

    expect(committed).toMatchObject({ result: { babies: 1, created: 1 } });
    await expect(prisma.baby.findFirstOrThrow({ where: { householdId: fixture.householdId } })).resolves.toMatchObject({ name: "Reviewed Finley" });
    expect(await scopedCounts(fixture, preview.previewId)).toEqual([1, 1, 1, 1]);
  });

  it("reauthorizes the actor after context capture before committing a preview", async () => {
    const fixture = await seedFixture("Reauthorization Owner");
    const preview = await previewSproutBackup(upload({ Baby: [{ id: "should-not-import", firstName: "Blocked" }] }));
    auth.afterInitialContext = async () => {
      await prisma.householdMember.update({ where: { id: fixture.memberId }, data: { disabledAt: new Date() } });
    };

    await expect(importSproutBackup({ previewId: preview.previewId })).rejects.toThrow("forbidden");

    await expect(prisma.importBatch.findUniqueOrThrow({ where: { id: preview.previewId } })).resolves.toMatchObject({ status: "preview" });
    expect(await scopedCounts(fixture, preview.previewId)).toEqual([1, 0, 0, 0]);
  });

  it("rejects a foreign-household actor from committing another household's preview without writes", async () => {
    const source = await seedFixture("Source Household Owner");
    const preview = await previewSproutBackup(upload({ Baby: [{ id: "source-baby", firstName: "Source Finley" }] }));
    const foreign = await seedFixture("Foreign Household Owner");

    await expect(importSproutBackup({ previewId: preview.previewId })).rejects.toThrow("sprout_preview_mismatch");

    await expect(prisma.importBatch.findUniqueOrThrow({ where: { id: preview.previewId } })).resolves.toMatchObject({
      householdId: source.householdId,
      status: "preview"
    });
    expect(await scopedCounts(source, preview.previewId)).toEqual([1, 0, 0, 0]);
    expect(await scopedCounts(foreign, preview.previewId)).toEqual([0, 0, 0, 0]);
  });

  it("atomically claims a preview for concurrent callers and replays its immutable completed result without duplicate effects", async () => {
    const fixture = await seedFixture("Concurrent Replay Owner");
    const preview = await previewSproutBackup(upload({ Baby: [{ id: "concurrent-baby", firstName: "Concurrent Finley" }] }));

    const [first, concurrent] = await Promise.all([
      importSproutBackup({ previewId: preview.previewId }),
      importSproutBackup({ previewId: preview.previewId })
    ]);
    const completed = await prisma.importBatch.findUniqueOrThrow({ where: { id: preview.previewId } });
    const immutableResult = Object.freeze(JSON.parse(JSON.stringify(completed.completedResult)));

    expect(completed).toMatchObject({ status: "complete", completedResult: immutableResult });
    expect(JSON.parse(JSON.stringify(first))).toEqual(immutableResult);
    expect(JSON.parse(JSON.stringify(concurrent))).toEqual(immutableResult);
    expect(await scopedCounts(fixture, preview.previewId)).toEqual([1, 1, 1, 1]);

    await expect(prisma.$executeRaw`
      UPDATE "ImportBatch"
      SET "completedResult" = ${JSON.stringify({ tampered: true })}::jsonb
      WHERE "id" = ${preview.previewId}
    `).rejects.toThrow("completed_sprout_import_result_immutable");

    const replay = await importSproutBackup({ previewId: preview.previewId });
    expect(replay).toEqual(immutableResult);
    expect(await scopedCounts(fixture, preview.previewId)).toEqual([1, 1, 1, 1]);
  });

  it("cleans an expired completed source while retaining its database replay receipt for an exact subsequent import replay", async () => {
    const fixture = await seedFixture("Retention Replay Owner");
    const preview = await previewSproutBackup(upload({ Baby: [{ id: "retained-baby", firstName: "Retained Finley" }] }));
    const completedResult = JSON.parse(JSON.stringify(await importSproutBackup({ previewId: preview.previewId })));
    const completed = await prisma.importBatch.findUniqueOrThrow({ where: { id: preview.previewId } });
    const retentionRunAt = new Date();
    const expiredAt = new Date(retentionRunAt.getTime() - 30 * 24 * 60 * 60 * 1000 - 1);

    await prisma.importBatch.update({ where: { id: preview.previewId }, data: { completedAt: expiredAt } });

    await expect(runSproutSourceRetention(retentionRunAt)).resolves.toEqual({ deleted: 1, pending: 0, skipped: 0 });

    const retained = await prisma.importBatch.findUniqueOrThrow({ where: { id: preview.previewId } });
    expect(staging.remove).toHaveBeenCalledWith(
      completed.stagedFilename,
      expect.objectContaining({ directory: process.env.SPROUT_STAGING_DIRECTORY })
    );
    expect(retained).toMatchObject({
      status: "complete",
      completedResult,
      sourceFilename: null,
      sourceDigest: null,
      stagedFilename: null,
      stagedNonce: null,
      stagedAuthTag: null,
      stagedKeyVersion: null,
      rawSourceDeletedAt: retentionRunAt,
      rawSourceRetentionReceipt: {
        version: 1,
        sourceSystem: "sprout-track",
        sourceFormat: "json",
        terminalStatus: "complete",
        completedAt: expiredAt.toISOString()
      }
    });

    await expect(importSproutBackup({ previewId: preview.previewId })).resolves.toEqual(completedResult);
    expect(await scopedCounts(fixture, preview.previewId)).toEqual([1, 1, 1, 1]);
  });

  it("retries and reconciles a filename-only failed pre-staging ledger after an immediate cleanup failure", async () => {
    const fixture = await seedFixture("Filename Only Retention Owner");
    const firstRunAt = new Date("2026-08-01T12:00:00.000Z");
    const ledger = await prisma.importBatch.create({
      data: {
        householdId: fixture.householdId,
        actorUserId: fixture.userId,
        sourceSystem: "sprout-track",
        sourceFormat: "pending",
        stagedFilename: "sprout-stage-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.bin",
        status: "failed",
        error: "sprout_import_failed",
        createdAt: new Date(firstRunAt.getTime() - 15 * 60 * 1000)
      }
    });
    staging.remove.mockRejectedValueOnce(new Error("EPERM")).mockResolvedValueOnce(undefined);

    await expect(runSproutSourceRetention(firstRunAt)).resolves.toEqual({ deleted: 0, pending: 1, skipped: 0 });
    await expect(prisma.importBatch.findUniqueOrThrow({ where: { id: ledger.id } })).resolves.toMatchObject({
      stagedFilename: ledger.stagedFilename,
      sourceDigest: null,
      rawSourceCleanupPendingAt: firstRunAt,
      rawSourceCleanupNextRetryAt: new Date("2026-08-01T12:15:00.000Z"),
      rawSourceCleanupLastError: "sprout_staging_unavailable"
    });

    const retryAt = new Date("2026-08-01T12:15:00.000Z");
    await expect(runSproutSourceRetention(retryAt)).resolves.toEqual({ deleted: 1, pending: 0, skipped: 0 });

    await expect(prisma.importBatch.findUniqueOrThrow({ where: { id: ledger.id } })).resolves.toMatchObject({
      status: "failed",
      sourceFilename: null,
      sourceDigest: null,
      stagedFilename: null,
      stagedNonce: null,
      stagedAuthTag: null,
      stagedKeyVersion: null,
      rawSourceDeletedAt: retryAt,
      rawSourceCleanupPendingAt: null,
      rawSourceCleanupNextRetryAt: null,
      rawSourceCleanupLastError: null,
      rawSourceRetentionReceipt: {
        version: 1,
        sourceSystem: "sprout-track",
        sourceFormat: "pending",
        terminalStatus: "failed"
      }
    });
    expect(staging.remove).toHaveBeenCalledTimes(2);
  });
});
