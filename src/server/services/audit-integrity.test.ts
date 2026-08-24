import { describe, expect, it } from "vitest";
import { hashAuditEvent, verifyAuditChain } from "@/server/services/audit-integrity";

describe("audit integrity chain", () => {
  const first = {
    id: "audit-1",
    householdId: "household-1",
    action: "baby.create",
    entityType: "baby",
    entityId: "baby-1",
    schemaVersion: 3,
    createdAt: "2026-08-22T00:00:00.000Z",
    before: undefined,
    after: {}
  };

  it("produces a stable hash regardless of JSON object key order", () => {
    const left = hashAuditEvent(null, { ...first, after: { type: "medicine", timerState: "none" } });
    const right = hashAuditEvent(null, { ...first, after: { timerState: "none", type: "medicine" } });

    expect(left).toBe(right);
    expect(left).toMatch(/^[a-f0-9]{64}$/);
  });

  it("detects tampering and broken predecessor links", () => {
    const firstHash = hashAuditEvent(null, first);
    const second = { ...first, id: "audit-2", action: "baby.deactivate", createdAt: "2026-08-22T00:01:00.000Z" };
    const secondHash = hashAuditEvent(firstHash, second);

    expect(verifyAuditChain([
      { ...first, previousHash: null, eventHash: firstHash },
      { ...second, previousHash: firstHash, eventHash: secondHash }
    ])).toEqual({ valid: true });

    expect(verifyAuditChain([
      { ...first, previousHash: null, eventHash: firstHash },
      { ...second, action: "baby.reactivate", previousHash: firstHash, eventHash: secondHash }
    ])).toEqual({ valid: false, reason: "event_hash_mismatch", index: 1 });
  });
});
