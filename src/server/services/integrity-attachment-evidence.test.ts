import { describe, expect, it, vi } from "vitest";
import { ATTACHMENT_INVENTORY_QUERY, checkAttachmentInventory, normalizeAttachmentInventoryRows } from "@/server/services/integrity-attachment-evidence";

const key = (digit: string) => digit.repeat(32);
const record = (digit: string, state = "available") => ({ storageKey: key(digit), byteSize: 4, sha256: "a".repeat(64), state });

describe("attachment byte inventory", () => {
  it("recognizes pending write ownership without calling it a verified photo or a stray", async () => {
    const pending = record("7", "write_pending");
    expect(normalizeAttachmentInventoryRows([pending])).toEqual([pending]);
    const read = vi.fn();
    await expect(checkAttachmentInventory([pending], [key("7")], read)).resolves.toEqual({ status: "incomplete" });
    await expect(checkAttachmentInventory([pending], [], read)).resolves.toEqual({ status: "incomplete" });
    expect(read).not.toHaveBeenCalled();
  });

  it("still reports genuinely unknown files alongside a pending write", async () => {
    await expect(checkAttachmentInventory([record("7", "write_pending")], [key("7"), key("8")], vi.fn()))
      .resolves.toMatchObject({ status: "findings", count: 1 });
  });

  it("the shared bounded inventory includes only pending intents without overriding Attachment ownership", () => {
    expect(ATTACHMENT_INVENTORY_QUERY).toContain('FROM "AttachmentWriteIntent"');
    expect(ATTACHMENT_INVENTORY_QUERY).toContain("'write_pending'");
    expect(ATTACHMENT_INVENTORY_QUERY).toContain("intent.state = 'pending'");
    expect(ATTACHMENT_INVENTORY_QUERY).toContain("NOT EXISTS");
    expect(ATTACHMENT_INVENTORY_QUERY).toContain("LIMIT 100001");
  });

  it("is clean when every recorded photo's bytes are present and exact, and nothing else is stored", async () => {
    const read = vi.fn().mockResolvedValue(Buffer.from("jpeg"));
    await expect(checkAttachmentInventory([record("1"), record("2", "deleted"), record("3", "staging")], [key("1"), key("2"), key("3")], read))
      .resolves.toEqual({ status: "clean" });
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("counts missing or changed bytes and stray files, without naming any of them", async () => {
    const read = vi.fn(async (storageKey: string) => {
      if (storageKey === key("1")) throw new Error("attachment_bytes_missing");
      if (storageKey === key("2")) throw new Error("attachment_bytes_mismatch");
      return Buffer.from("jpeg");
    });
    const result = await checkAttachmentInventory([record("1"), record("2"), record("3")], [key("2"), key("3"), key("9")], read);

    expect(result).toEqual({ status: "findings", count: 3, evidence: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(JSON.stringify(result)).not.toContain(key("9"));
  });

  it("does not recheck photos already known to be unavailable, and treats a purged photo's leftover file as stray", async () => {
    const read = vi.fn().mockResolvedValue(Buffer.from("jpeg"));
    // key 4 belongs to an unavailable photo; key 5's photo was purged, so it is no longer listed.
    const result = await checkAttachmentInventory([record("4", "unavailable")], [key("4"), key("5")], read);
    expect(read).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "findings", count: 1 });
  });

  it("reports incomplete, not clean, when the store cannot be read", async () => {
    const read = vi.fn().mockRejectedValue(new Error("attachment_store_unavailable"));
    await expect(checkAttachmentInventory([record("1")], [key("1")], read)).resolves.toEqual({ status: "incomplete" });
  });

  it("accepts only well-formed inventory rows", () => {
    expect(normalizeAttachmentInventoryRows([{ storageKey: key("1"), byteSize: 4, sha256: "a".repeat(64), state: "available" }]))
      .toEqual([record("1")]);
    expect(normalizeAttachmentInventoryRows([{ storageKey: "../x", byteSize: 4, sha256: "a".repeat(64), state: "available" }])).toBeNull();
    expect(normalizeAttachmentInventoryRows([{ count: 3 }])).toBeNull();
  });
});
