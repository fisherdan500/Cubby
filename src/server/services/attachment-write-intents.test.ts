import { beforeEach, expect, it, vi } from "vitest";
vi.mock("@/server/auth/context", () => ({ requirePermission: vi.fn() }));
const m = vi.hoisted(() => ({ create: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(), attachment: vi.fn(), remove: vi.fn(), transaction: vi.fn() }));
vi.mock("@/lib/db/prisma", () => ({ prisma: { attachmentWriteIntent: m, $transaction: m.transaction } }));
vi.mock("@/lib/env", () => ({ attachmentConfig: { directory: "/owned" } }));
vi.mock("@/server/services/attachment-store", () => ({ removeAttachmentObject: m.remove }));
import * as ownership from "./attachment-write-intents";
const key = "a".repeat(32);
const measured = { byteSize: 4, sha256: "b".repeat(64) };
const row = { storageKey: key, householdId: "home", state: "pending", ...measured };
const actor = { householdId: "home", userId: "user", sessionId: "session", memberId: "member", role: "owner" } as const;
const tx = { attachmentWriteIntent: m, attachment: { findUnique: m.attachment }, $queryRaw: vi.fn(), session: { findFirst: vi.fn() }, householdMember: { findFirst: vi.fn() } };
beforeEach(() => {
  vi.resetAllMocks();
  m.create.mockImplementation(async ({ data }) => data);
  m.findMany.mockResolvedValue([row]);
  m.findUnique.mockResolvedValue(row);
  m.updateMany.mockResolvedValue({ count: 1 });
  m.attachment.mockResolvedValue(null);
  m.remove.mockResolvedValue(undefined);
  m.transaction.mockImplementation(async (work) => work(tx));
  tx.session.findFirst.mockResolvedValue({ id: actor.sessionId });
  tx.householdMember.findFirst.mockResolvedValue(actor);
  tx.$queryRaw.mockResolvedValue([{ stagedBytes: 0n }]);
});
it("retries known ownership cleanup after unlink failure without losing the row", async () => {
  expect(ownership).toHaveProperty("sweepPhotoWriteIntents");
  m.remove.mockRejectedValueOnce(new Error("EIO"));
  await ownership.sweepPhotoWriteIntents();
  expect(m.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ state: "cleaned" }) }));
  await ownership.sweepPhotoWriteIntents();
  expect(m.remove).toHaveBeenCalledTimes(2);
  expect(m.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ state: "cleaned" }) }));
});
it.each(["transferred", "attachment"])("never unlinks %s ownership after ambiguous commit", async (kind) => {
  expect(ownership).toHaveProperty("sweepPhotoWriteIntents");
  if (kind === "transferred") m.findUnique.mockResolvedValue({ ...row, state: "transferred" });
  else m.attachment.mockResolvedValue({ storageKey: key });
  await ownership.sweepPhotoWriteIntents();
  expect(m.remove).not.toHaveBeenCalled();
});
it("keeps the pin after transaction rejection until the real IO callback settles", async () => {
  expect(ownership).toHaveProperty("settledPhotoTransaction");
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  m.transaction.mockImplementationOnce(async (work) => work(tx)).mockImplementationOnce((work) => {
    void work(tx).catch(() => undefined);
    return Promise.reject(new Error("transaction expired"));
  });
  let finished = false;
  const operation = ownership.withPhotoWriteOwnership(async (reserve) => {
    const ownKey = await reserve(actor, "photo_upload", measured);
    m.findMany.mockResolvedValue([{ ...row, storageKey: ownKey }]);
    await ownership.settledPhotoTransaction(async () => { entered(); await held; });
  }).catch(() => { finished = true; });
  await started;
  await ownership.sweepPhotoWriteIntents(new Date("2099-01-01"));
  expect(finished).toBe(false);
  expect(m.remove).not.toHaveBeenCalled();
  release();
  await operation;
  expect(finished).toBe(true);
});
it("rejects terminal, foreign or mismatched ownership before a resumed write", async () => {
  for (const bad of [{ state: "cleaned" }, { householdId: "other" }, { byteSize: 5 }]) {
    m.findUnique.mockResolvedValue({ ...row, ...bad });
    await expect(ownership.lockPhotoWriteIntent(tx as never, key, "home", measured)).rejects.toThrow("attachment_write_intent_unavailable");
  }
});
