import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ query: vi.fn(), create: vi.fn(), actor: vi.fn() }));
vi.mock("@/lib/db/prisma", () => ({ prisma: { $transaction: async (work: (tx: unknown) => unknown) => work({ $queryRaw: m.query, attachmentWriteIntent: { create: m.create } }) } }));
vi.mock("@/lib/env", () => ({ attachmentConfig: { directory: "/unused" } }));
vi.mock("@/server/services/attachment-store", () => ({ removeAttachmentObject: vi.fn() }));
vi.mock("@/server/services/photo-write-actor", () => ({ lockPhotoWriteActor: m.actor }));
vi.mock("@/server/auth/context", () => ({ requirePermission: vi.fn() }));
import { withPhotoWriteOwnership } from "./attachment-write-intents";
const actor = { householdId: "home", userId: "user", sessionId: "session", memberId: "member", role: "owner" } as const;
const measured = { byteSize: 4, sha256: "b".repeat(64) };
beforeEach(() => { vi.resetAllMocks(); m.actor.mockResolvedValue(actor); m.query.mockResolvedValue([{ stagedBytes: 0n }]); });
it("counts durable pending and unclaimed staging under serialization before reserving", async () => {
  m.query.mockResolvedValue([{ stagedBytes: 2n * 1024n * 1024n * 1024n }]);
  await expect(withPhotoWriteOwnership((reserve) => reserve(actor, "photo_upload", measured))).rejects.toThrow("attachment_staging_full");
  expect(m.create).not.toHaveBeenCalled();
  const statements = m.query.mock.calls.map(([sql]) => Array.from(sql as string[]).join("?"));
  expect(statements.some((sql) => sql.includes("pg_advisory_xact_lock"))).toBe(true);
  // Prisma cannot deserialize PostgreSQL void; return a supported scalar instead.
  expect(statements.find((sql) => sql.includes("pg_advisory_xact_lock"))).toContain("SELECT 1 AS locked FROM");
  const quota = statements.find((sql) => sql.includes('SUM("byteSize")'))!;
  expect(quota).toContain('"AttachmentWriteIntent"');
  expect(quota).toContain("'pending'");
  expect(quota).toContain('"Attachment"');
  expect(quota).toContain("'staging'");
  expect(quota).not.toContain("'transferred'");
  expect(quota).not.toContain("'available'");
});
it("allows the exact byte boundary and refuses unavailable accounting", async () => {
  m.query.mockResolvedValue([{ stagedBytes: 2n * 1024n * 1024n * 1024n - 4n }]);
  await expect(withPhotoWriteOwnership((reserve) => reserve(actor, "restore_photo", measured))).resolves.toMatch(/^[a-f0-9]{32}$/);
  m.query.mockResolvedValue([]);
  await expect(withPhotoWriteOwnership((reserve) => reserve(actor, "photo_upload", measured))).rejects.toThrow();
});
