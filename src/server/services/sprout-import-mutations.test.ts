import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import JSZip from "jszip";
import { hasPermission } from "@/domain/roles";

const previewRecords = new Map<
  string,
  {
    id: string;
    sourceFilename?: string;
    sourceFormat?: string;
    sourceDigest?: string;
    stagedFilename?: string;
    stagedNonce?: string;
    stagedAuthTag?: string;
    stagedKeyVersion?: string;
    sourceSystem?: string;
    parserAdapterVersion?: string;
    mappingOptionsFingerprint?: string;
    contextFingerprint?: string;
    status?: string;
    summary?: unknown;
    warnings?: string[];
    error?: string;
    completedResult?: unknown;
    createdAt?: Date;
    completedAt?: Date;
  }
>();
let nextBatchId = 1;

const mocks = vi.hoisted(() => ({
  SproutStagingWriteError: class SproutStagingWriteError extends Error {
    stagedFilename: string;

    constructor(stagedFilename: string) {
      super("sprout_staging_unavailable");
      this.stagedFilename = stagedFilename;
    }
  },
  transaction: vi.fn(),
  getHouseholdContext: vi.fn(),
  lockActor: vi.fn(),
  lockBaby: vi.fn(),
  requirePermission: vi.fn(),
  importedCount: vi.fn(),
  importedFind: vi.fn(),
  importedCreate: vi.fn(),
  batchCreate: vi.fn(),
  batchFindUnique: vi.fn(),
  batchUpdate: vi.fn(),
  batchUpdateMany: vi.fn(),
  backupCreate: vi.fn(),
  auditCreate: vi.fn(),
  webhookDeliveryCreate: vi.fn(),
  queryRaw: vi.fn(),
  babyFindMany: vi.fn(),
  babyCreate: vi.fn(),
  activityCreate: vi.fn(),
  eventCreate: vi.fn(),
  eventBabyUpsert: vi.fn(),
  stage: vi.fn(),
  readStaged: vi.fn(),
  removeStaged: vi.fn(),
  stagedPayloads: new Map<string, Buffer>()
}));

vi.mock("@/lib/db/prisma", () => ({ prisma: transactionClient() }));
vi.mock("@/server/auth/context", () => ({
  getHouseholdContext: mocks.getHouseholdContext,
  requirePermission: mocks.requirePermission
}));
vi.mock("@/server/services/mutation-locks", () => ({
  lockActorForWrite: mocks.lockActor,
  lockBabyForWrite: mocks.lockBaby
}));
vi.mock("@/server/services/sprout-staging", () => ({
  SproutStagingWriteError: mocks.SproutStagingWriteError,
  createSproutStagedFilename: () => "sprout-stage-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bin",
  readSproutStagingConfig: () => ({ directory: "/isolated/staging", keyFile: "/run/secrets/cubby_sprout_staging_key", keyVersion: "v1" }),
  stageSproutBytes: mocks.stage,
  readStagedSproutBytes: mocks.readStaged,
  removeStagedSproutBytes: mocks.removeStaged
}));

import { importSproutBackup, previewSproutBackup } from "@/server/services/sprout-import";

beforeEach(() => {
  vi.resetAllMocks();
  previewRecords.clear();
  mocks.stagedPayloads.clear();
  nextBatchId = 1;
  mocks.getHouseholdContext.mockResolvedValue(context("owner"));
  mocks.requirePermission.mockImplementation((ctx, permission) => {
    if (!hasPermission(ctx.role, permission)) throw new Error("forbidden");
  });
  mocks.transaction.mockImplementation((operation) => operation(transactionClient()));
  mocks.lockActor.mockResolvedValue(context("owner"));
  mocks.importedCount.mockResolvedValue(0);
  mocks.importedFind.mockResolvedValue(null);
  mocks.importedCreate.mockResolvedValue({});
  mocks.batchCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    const batch = { id: `batch-${nextBatchId++}`, createdAt: new Date(), ...data };
    previewRecords.set(batch.id, batch);
    return batch;
  });
  mocks.batchFindUnique.mockImplementation(async ({ where }: { where: { householdId_id: { id: string } } }) =>
    previewRecords.get(where.householdId_id.id) ?? null
  );
  mocks.batchUpdate.mockImplementation(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
    const batch = previewRecords.get(where.id) ?? { id: where.id };
    const updated = { ...batch, ...data };
    previewRecords.set(where.id, updated);
    return updated;
  });
  mocks.batchUpdateMany.mockImplementation(async ({ where, data }: { where: { id: string; status: string | { in: string[] }; createdAt?: { gt: Date } }; data: Record<string, unknown> }) => {
    const batch = previewRecords.get(where.id);
    const statuses = typeof where.status === "string" ? [where.status] : where.status.in;
    if (!batch || !statuses.includes(batch.status ?? "") || (where.createdAt && !(batch.createdAt && batch.createdAt > where.createdAt.gt))) return { count: 0 };
    previewRecords.set(where.id, { ...batch, ...data });
    return { count: 1 };
  });
  mocks.queryRaw.mockResolvedValue([{ id: "batch-1" }]);
  mocks.backupCreate.mockResolvedValue({});
  mocks.babyFindMany.mockResolvedValue([]);
  mocks.babyCreate.mockResolvedValue({ id: "baby-1", householdId: "household-1", inactiveAt: null });
  mocks.activityCreate.mockResolvedValue({ id: "activity-1", vaccine: null });
  mocks.eventCreate.mockResolvedValue({ id: "event-1" });
  mocks.eventBabyUpsert.mockResolvedValue({});
  mocks.removeStaged.mockResolvedValue(undefined);
  mocks.stage.mockImplementation(async (bytes: Buffer, _config: unknown, requestedFilename?: string) => {
    const stagedFilename = requestedFilename ?? `sprout-stage-${mocks.stagedPayloads.size + 1}.bin`;
    mocks.stagedPayloads.set(stagedFilename, Buffer.from(bytes));
    return {
      stagedFilename,
      stagedNonce: "AAAAAAAAAAAAAAAA",
      stagedAuthTag: "AAAAAAAAAAAAAAAAAAAAAA==",
      stagedKeyVersion: "v1",
      sourceDigest: createHash("sha256").update(bytes).digest("hex")
    };
  });
  mocks.readStaged.mockImplementation(async ({ stagedFilename }: { stagedFilename: string }) => mocks.stagedPayloads.get(stagedFilename));
});

describe("Sprout import mutation boundaries", () => {
  it("persists the pre-staging cleanup filename before a partial ciphertext write can fail", async () => {
    mocks.stage.mockImplementationOnce(async (_bytes: Buffer, _config: unknown, stagedFilename: string) => {
      throw new mocks.SproutStagingWriteError(stagedFilename);
    });

    await expect(previewSproutBackup(upload({ Baby: [] }))).rejects.toThrow("sprout_staging_unavailable");

    const ledger = previewRecords.get("batch-1");
    expect(ledger).toEqual(expect.objectContaining({ status: "failed", error: "sprout_import_failed" }));
    expect(ledger).not.toHaveProperty("sourceFilename");
    expect(ledger).not.toHaveProperty("sourceDigest");
    expect(ledger).toEqual(expect.objectContaining({ stagedFilename: expect.stringMatching(/^sprout-stage-[a-f0-9]{32}\.bin$/) }));
    expect(ledger).not.toHaveProperty("summary");
    expect(mocks.stage).toHaveBeenCalledWith(expect.any(Buffer), expect.anything(), ledger?.stagedFilename);
    expect(mocks.removeStaged).toHaveBeenCalledWith(ledger?.stagedFilename, expect.anything());
  });

  it("keeps a failed cleanup ledger without raw metadata when staged-metadata persistence fails", async () => {
    const persistenceError = new Error("stage_metadata_write_failed");
    const persistPreStagingLedger = mocks.batchUpdate.getMockImplementation();
    if (!persistPreStagingLedger) throw new Error("missing_batch_update_mock");
    mocks.batchUpdate.mockImplementationOnce(persistPreStagingLedger).mockRejectedValueOnce(persistenceError);

    await expect(previewSproutBackup(upload({ Baby: [] }))).rejects.toBe(persistenceError);

    const ledger = previewRecords.get("batch-1");
    expect(ledger).toEqual(expect.objectContaining({ status: "failed", error: "sprout_import_failed" }));
    expect(ledger).not.toHaveProperty("sourceFilename");
    expect(ledger).not.toHaveProperty("sourceDigest");
    expect(ledger).toEqual(expect.objectContaining({ stagedFilename: "sprout-stage-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bin" }));
    expect(ledger).not.toHaveProperty("summary");
    expect(mocks.removeStaged).not.toHaveBeenCalled();
  });

  it("keeps persisted staged bytes failed and noncommittable when preview transition fails", async () => {
    const transitionError = new Error("preview_transition_write_failed");
    const persistStagedMetadata = mocks.batchUpdate.getMockImplementation();
    if (!persistStagedMetadata) throw new Error("missing_batch_update_mock");
    mocks.batchUpdate
      .mockImplementationOnce(persistStagedMetadata)
      .mockImplementationOnce(persistStagedMetadata)
      .mockRejectedValueOnce(transitionError);

    await expect(previewSproutBackup(upload({ Baby: [] }))).rejects.toBe(transitionError);

    const ledger = previewRecords.get("batch-1");
    expect(ledger).toEqual(expect.objectContaining({
      status: "failed",
      sourceFilename: "data.json",
      sourceFormat: "json",
      sourceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      stagedFilename: "sprout-stage-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bin",
      stagedNonce: "AAAAAAAAAAAAAAAA",
      stagedAuthTag: "AAAAAAAAAAAAAAAAAAAAAA==",
      stagedKeyVersion: "v1",
      error: "sprout_import_failed"
    }));
    expect(ledger).not.toHaveProperty("parserAdapterVersion");
    expect(ledger).not.toHaveProperty("summary");

    await expect(importSproutBackup({ previewId: "batch-1" })).rejects.toThrow("sprout_preview_mismatch");
    expect(mocks.babyCreate).not.toHaveBeenCalled();
  });

  it("declares nullable interpretation binding columns in the schema migration for legacy previews", () => {
    const migrationUrl = new URL(
      "../../../prisma/migrations/20260801130000_sprout_preview_interpretation_binding/migration.sql",
      import.meta.url
    );
    expect(existsSync(migrationUrl)).toBe(true);
    const migration = readFileSync(migrationUrl, "utf8");
    const schema = readFileSync(new URL("../../../prisma/schema.prisma", import.meta.url), "utf8");

    expect(schema).toMatch(/model ImportBatch \{[\s\S]*?parserAdapterVersion\s+String\?[\s\S]*?mappingOptionsFingerprint\s+String\?[\s\S]*?contextFingerprint\s+String\?/);
    expect(migration).toContain('ADD COLUMN "parserAdapterVersion" TEXT');
    expect(migration).toContain('ADD COLUMN "mappingOptionsFingerprint" TEXT');
    expect(migration).toContain('ADD COLUMN "contextFingerprint" TEXT');
  });

  it("persists parser, mapping, and context interpretation bindings with a preview", async () => {
    const preview = await previewSproutBackup(upload({ Baby: [] }));

    expect(previewRecords.get(preview.previewId)).toEqual(expect.objectContaining({
      parserAdapterVersion: "sprout-import-adapter-v1",
      mappingOptionsFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      contextFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
    }));
  });

  it("fails closed before its transaction claim when a preview interpretation binding is missing or changed", async () => {
    for (const [field, value] of [
      ["parserAdapterVersion", undefined],
      ["mappingOptionsFingerprint", "changed-mapping-options"],
      ["contextFingerprint", "changed-context"]
    ] as const) {
      const preview = await previewSproutBackup(upload({ Baby: [] }));
      const stored = previewRecords.get(preview.previewId);
      if (!stored) throw new Error("missing_preview_record");
      previewRecords.set(preview.previewId, { ...stored, [field]: value });
      mocks.batchUpdateMany.mockClear();
      mocks.babyCreate.mockClear();

      await expect(importSproutBackup({ previewId: preview.previewId })).rejects.toThrow("sprout_preview_mismatch");

      expect(mocks.batchUpdateMany).not.toHaveBeenCalled();
      expect(mocks.babyCreate).not.toHaveBeenCalled();
    }
  });

  it("commits the exact staged reviewed bytes when the browser file changes after preview", async () => {
    const preview = await previewSproutBackup(upload({ Baby: [{ id: "reviewed", firstName: "Finley" }] }));
    const laterBrowserFile = upload({ Baby: [{ id: "later", firstName: "Changed" }] });

    await expect(importSproutBackup({ previewId: preview.previewId } as never)).resolves.toEqual(
      expect.objectContaining({ result: expect.objectContaining({ babies: 1 }) })
    );

    expect(laterBrowserFile.get("file")).not.toBeNull();
    expect(mocks.stage).toHaveBeenCalledOnce();
    expect(mocks.readStaged).toHaveBeenCalledOnce();
    expect(mocks.babyCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ name: "Finley" }) }));
  });

  it("replays a completed matching preview without repeating import side effects", async () => {
    const tables = { Baby: [{ id: "source-baby", firstName: "Finley" }] };
    const preview = await previewSproutBackup(upload(tables));

    const first = await importSproutBackup({ previewId: preview.previewId });
    expect(first).toEqual(expect.objectContaining({ result: expect.objectContaining({ created: 1 }) }));
    expect(first).not.toHaveProperty("source");
    expect(previewRecords.get(preview.previewId)?.completedResult).toEqual(first);
    const domainWrites = mocks.babyCreate.mock.calls.length;
    const importedRecordWrites = mocks.importedCreate.mock.calls.length;
    const batchTransitions = mocks.batchUpdate.mock.calls.length;
    const batchClaims = mocks.batchUpdateMany.mock.calls.length;
    const backupRecords = mocks.backupCreate.mock.calls.length;
    const auditEffects = mocks.auditCreate.mock.calls.length;
    const outboxEffects = mocks.webhookDeliveryCreate.mock.calls.length;

    await expect(importSproutBackup({ previewId: preview.previewId })).resolves.toEqual(first);

    expect(mocks.babyCreate).toHaveBeenCalledTimes(domainWrites);
    expect(mocks.importedCreate).toHaveBeenCalledTimes(importedRecordWrites);
    expect(mocks.batchUpdate).toHaveBeenCalledTimes(batchTransitions);
    expect(mocks.batchUpdateMany).toHaveBeenCalledTimes(batchClaims);
    expect(mocks.backupCreate).toHaveBeenCalledTimes(backupRecords);
    expect(mocks.auditCreate).toHaveBeenCalledTimes(auditEffects);
    expect(mocks.webhookDeliveryCreate).toHaveBeenCalledTimes(outboxEffects);
  });

  it("requires a fresh preview when a new browser file is selected", async () => {
    const preview = await previewSproutBackup(upload({ Baby: [] }));
    mocks.batchCreate.mockClear();
    mocks.batchUpdate.mockClear();

    await expect(importSproutBackup({ previewId: "unissued-preview" })).rejects.toThrow("sprout_preview_mismatch");

    expect(mocks.batchCreate).not.toHaveBeenCalled();
    expect(mocks.batchUpdate).not.toHaveBeenCalled();
    expect(mocks.babyCreate).not.toHaveBeenCalled();
  });

  it("requires a server-issued preview ID before import writes", async () => {
    await expect(importSproutBackup()).rejects.toThrow("sprout_preview_required");

    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.batchCreate).not.toHaveBeenCalled();
    expect(mocks.babyCreate).not.toHaveBeenCalled();
  });

  it("fails closed at the atomic claim when a preview is older than 24 hours", async () => {
    const preview = await previewSproutBackup(upload({ Baby: [{ id: "source-baby", firstName: "Finley" }] }));
    const expired = previewRecords.get(preview.previewId);
    if (!expired) throw new Error("missing_preview_record");
    previewRecords.set(preview.previewId, { ...expired, createdAt: new Date(Date.now() - (24 * 60 * 60 * 1000) - 1) });

    await expect(importSproutBackup({ previewId: preview.previewId })).rejects.toThrow("sprout_preview_expired");

    expect(mocks.batchUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: preview.previewId,
        status: "preview",
        createdAt: { gt: expect.any(Date) }
      })
    }));
    expect(mocks.readStaged).not.toHaveBeenCalled();
    expect(mocks.babyCreate).not.toHaveBeenCalled();
  });

  it("rejects a preview committed by a different authorized actor before writes", async () => {
    const preview = await previewSproutBackup(upload({ Baby: [] }));
    mocks.batchUpdate.mockClear();
    mocks.lockActor.mockResolvedValue({ ...context("owner"), userId: "user-2", memberId: "member-2" });

    await expect(importSproutBackup({ previewId: preview.previewId })).rejects.toThrow("sprout_preview_mismatch");

    expect(mocks.batchUpdate).not.toHaveBeenCalled();
    expect(mocks.babyCreate).not.toHaveBeenCalled();
  });

  it("rejects unsupported ZIP entries before preview or import database access", async () => {
    const formData = await zipUpload();

    await expect(previewSproutBackup(formData)).rejects.toThrow("sprout_zip_unsupported_entry");
    await expect(importSproutBackup({ previewId: "unissued-preview" })).rejects.toThrow("sprout_preview_mismatch");

    expect(mocks.importedCount).not.toHaveBeenCalled();
    expect(mocks.batchCreate).not.toHaveBeenCalled();
  });

  it("rechecks backup permission with the locked role before any import write", async () => {
    const preview = await previewSproutBackup(upload({ Baby: [] }));
    mocks.batchUpdate.mockClear();
    mocks.lockActor.mockResolvedValue(context("parent"));

    await expect(importSproutBackup({ previewId: preview.previewId })).rejects.toThrow("forbidden");

    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.batchUpdate).not.toHaveBeenCalled();
    expect(mocks.babyCreate).not.toHaveBeenCalled();
    expect(mocks.activityCreate).not.toHaveBeenCalled();
  });

  it("locks a matched inactive baby and imports its historical activity and event link atomically", async () => {
    const inactiveBaby = {
      id: "baby-1",
      householdId: "household-1",
      name: "Finley",
      birthDate: new Date("2026-03-13T00:00:00.000Z"),
      inactiveAt: new Date("2026-07-14T12:00:00.000Z")
    };
    mocks.babyFindMany.mockResolvedValue([inactiveBaby]);
    mocks.lockBaby.mockResolvedValue(inactiveBaby);

    const tables = {
      Baby: [{ id: "source-baby", firstName: "Finley", birthDate: "2026-03-13T00:00:00.000Z" }],
      Note: [{ id: "note-1", babyId: "source-baby", time: "2026-07-13T12:00:00.000Z", content: "Historical" }],
      CalendarEvent: [{ id: "event-1", title: "Appointment", startTime: "2026-07-13T14:00:00.000Z" }],
      BabyEvent: [{ id: "link-1", eventId: "event-1", babyId: "source-baby" }]
    };
    const preview = await previewSproutBackup(upload(tables));

    await expect(importSproutBackup({ previewId: preview.previewId })).resolves.toEqual(
      expect.objectContaining({ result: expect.objectContaining({ activities: 1, calendarEvents: 1 }) })
    );
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.importedCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ householdId: "household-1", importBatchId: "batch-1" })
      })
    );
    expect(mocks.lockBaby).toHaveBeenCalledWith(expect.anything(), context("owner"), "baby-1");
    expect(mocks.activityCreate).toHaveBeenCalledOnce();
    expect(mocks.activityCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          household: { connect: { id: "household-1" } },
          baby: { connect: { id: "baby-1" } },
          actorMember: { connect: { id: "member-1" } }
        })
      })
    );
    expect(mocks.eventBabyUpsert).toHaveBeenCalledWith({
      where: { babyId_eventId: { babyId: "baby-1", eventId: "event-1" } },
      update: {},
      create: { eventId: "event-1", babyId: "baby-1" }
    });
    expect(mocks.batchUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "complete" }) }));
  });

  it("does not downgrade a completed preview or create a false failure record when failure handling races replay", async () => {
    const importError = new Error("activity_write_failed");
    mocks.activityCreate.mockRejectedValueOnce(importError);
    const preview = await previewSproutBackup(upload({
      Baby: [{ id: "source-baby", firstName: "Finley" }],
      Note: [{ id: "note-1", babyId: "source-baby", time: "2026-07-13T12:00:00.000Z" }]
    }));
    mocks.batchUpdate.mockClear();
    let transactionCount = 0;
    mocks.transaction.mockImplementation(async (operation) => {
      transactionCount += 1;
      if (transactionCount === 2) {
        const completed = previewRecords.get(preview.previewId);
        if (!completed) throw new Error("missing_preview_record");
        previewRecords.set(preview.previewId, {
          ...completed,
          status: "complete",
          completedResult: { result: { created: 1 } }
        });
      }
      return operation(transactionClient());
    });

    await expect(importSproutBackup({ previewId: preview.previewId })).rejects.toBe(importError);

    expect(mocks.queryRaw).toHaveBeenCalledTimes(2);
    expect(mocks.batchUpdate).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "failed" })
    }));
    expect(mocks.backupCreate).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "failed" })
    }));
    expect(previewRecords.get(preview.previewId)).toEqual(expect.objectContaining({
      status: "complete",
      completedResult: { result: { created: 1 } }
    }));
  });

  it("rolls back domain writes then records a re-authorized failed import separately", async () => {
    const importError = new Error("activity_write_failed");
    mocks.activityCreate.mockRejectedValueOnce(importError);
    const preview = await previewSproutBackup(upload({
      Baby: [{ id: "source-baby", firstName: "Finley" }],
      Note: [{ id: "note-1", babyId: "source-baby", time: "2026-07-13T12:00:00.000Z" }]
    }));

    await expect(importSproutBackup({ previewId: preview.previewId })).rejects.toBe(importError);

    expect(mocks.transaction).toHaveBeenCalledTimes(2);
    expect(mocks.lockActor).toHaveBeenCalledTimes(2);
    expect(mocks.batchUpdateMany).toHaveBeenLastCalledWith({
      where: expect.objectContaining({
        id: preview.previewId,
        householdId: "household-1",
        sourceSystem: "sprout-track",
        actorUserId: "user-1",
        status: { in: ["preview", "running"] }
      }),
      data: expect.objectContaining({ status: "failed", error: "sprout_import_failed" })
    });

    expect(mocks.backupCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        householdId: "household-1",
        actorUserId: "user-1",
        kind: "sprout_import",
        status: "failed",
        error: "sprout_import_failed"
      })
    });
  });

  it("persists only the stable failure code when staged import bytes raise an unknown marked error", async () => {
    const marker = "SPROUT-SENSITIVE-MARKER-8c2af84b";
    const importError = new Error(`staging decrypt failed: ${marker}`);
    const preview = await previewSproutBackup(upload({ Baby: [] }));
    mocks.readStaged.mockRejectedValueOnce(importError);

    await expect(importSproutBackup({ previewId: preview.previewId })).rejects.toBe(importError);

    const batchFailure = mocks.batchUpdateMany.mock.calls.at(-1)?.[0];
    const backupFailure = mocks.backupCreate.mock.calls.at(-1)?.[0];
    const failedBatch = previewRecords.get(preview.previewId);
    expect(batchFailure).toEqual(expect.objectContaining({
      data: expect.objectContaining({ status: "failed", error: "sprout_import_failed" })
    }));
    expect(failedBatch).toEqual(expect.objectContaining({ status: "failed", error: "sprout_import_failed" }));
    expect(backupFailure).toEqual(expect.objectContaining({
      data: expect.objectContaining({ status: "failed", error: "sprout_import_failed" })
    }));
    expect(JSON.stringify([failedBatch, backupFailure])).not.toContain(marker);
  });
});

function upload(tables: Record<string, unknown[]>) {
  const form = new FormData();
  form.append("file", new Blob([JSON.stringify({ data: tables })], { type: "application/json" }), "data.json");
  return form;
}

async function zipUpload() {
  const zip = new JSZip();
  zip.file("data.json", JSON.stringify({ data: { Baby: [] } }));
  zip.file("notes.txt", "unexpected");
  const form = new FormData();
  form.append("file", new Blob([await zip.generateAsync({ type: "arraybuffer" })], { type: "application/zip" }), "sprout.zip");
  return form;
}

function context(role: "owner" | "parent") {
  return {
    userId: "user-1",
    householdId: "household-1",
    memberId: "member-1",
    role
  };
}

function transactionClient() {
  return {
    $transaction: mocks.transaction,
    $queryRaw: mocks.queryRaw,
    importedRecord: {
      count: mocks.importedCount,
      findUnique: mocks.importedFind,
      create: mocks.importedCreate
    },
    importBatch: {
      create: mocks.batchCreate,
      findUnique: mocks.batchFindUnique,
      update: mocks.batchUpdate,
      updateMany: mocks.batchUpdateMany
    },
    backupRecord: { create: mocks.backupCreate },
    auditEvent: { create: mocks.auditCreate },
    webhookDelivery: { create: mocks.webhookDeliveryCreate },
    baby: { findMany: mocks.babyFindMany, create: mocks.babyCreate },
    contact: { findFirst: vi.fn(), create: vi.fn() },
    medicineCatalog: { findFirst: vi.fn(), create: vi.fn() },
    householdSettings: { upsert: vi.fn(), update: vi.fn() },
    activityLog: { create: mocks.activityCreate },
    calendarEvent: { create: mocks.eventCreate },
    calendarEventBaby: { upsert: mocks.eventBabyUpsert },
    calendarEventContact: { upsert: vi.fn() },
    vaccineDocument: { create: vi.fn() }
  };
}
