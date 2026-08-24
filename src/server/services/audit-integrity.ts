import { createHash } from "node:crypto";

type AuditHashInput = {
  id: string;
  householdId: string;
  babyId?: string | null;
  actorUserId?: string | null;
  actorMemberId?: string | null;
  actorUserSnapshot?: string | null;
  actorMemberSnapshot?: string | null;
  correlationId?: string | null;
  source?: string | null;
  chainOrder?: number;
  action: string;
  entityType: string;
  entityId: string;
  schemaVersion: number;
  createdAt: string;
  before?: unknown;
  after?: unknown;
};

type ChainedAuditEvent = AuditHashInput & {
  previousHash: string | null;
  eventHash: string;
};

type ChainVerification =
  | { valid: true }
  | { valid: false; reason: "previous_hash_mismatch" | "event_hash_mismatch"; index: number };

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => {
          const leftBytes = Buffer.from(left, "utf8");
          const rightBytes = Buffer.from(right, "utf8");
          return leftBytes.length - rightBytes.length || Buffer.compare(leftBytes, rightBytes);
        })
        .map(([key, entry]) => [key, canonicalValue(entry)])
    );
  }
  throw new Error("audit_integrity_value_invalid");
}

export function hashAuditEvent(previousHash: string | null, event: AuditHashInput) {
  const envelope = JSON.stringify(canonicalValue({ previousHash, event }));
  return createHash("sha256").update(envelope).digest("hex");
}

function legacyCanonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("audit_integrity_value_invalid");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(legacyCanonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => {
        const leftBytes = Buffer.from(left, "utf8");
        const rightBytes = Buffer.from(right, "utf8");
        return leftBytes.length - rightBytes.length || Buffer.compare(leftBytes, rightBytes);
      })
      .map(([key, child]) => `${JSON.stringify(key)}:${legacyCanonicalJson(child)}`)
      .join(",")}}`;
  }
  throw new Error("audit_integrity_value_invalid");
}

export function hashLegacyAuditEvent(previousHash: string | null, event: AuditHashInput) {
  const orderedEvent = {
    action: event.action,
    after: event.after ?? null,
    before: event.before ?? null,
    createdAt: event.createdAt,
    entityId: event.entityId,
    entityType: event.entityType,
    householdId: event.householdId,
    id: event.id,
    schemaVersion: event.schemaVersion
  };
  return createHash("sha256").update(`{"event":${legacyCanonicalJson(orderedEvent)},"previousHash":${previousHash === null ? "null" : JSON.stringify(previousHash)}}`).digest("hex");
}

export function verifyAuditChain(events: readonly ChainedAuditEvent[]): ChainVerification {
  let previousHash: string | null = null;
  for (const [index, event] of events.entries()) {
    if (event.previousHash !== previousHash) return { valid: false, reason: "previous_hash_mismatch", index };
    const { previousHash: _previousHash, eventHash, ...input } = event;
    const computedHash: string = event.schemaVersion === 1
      ? hashLegacyAuditEvent(previousHash, input)
      : hashAuditEvent(previousHash, input);
    if (computedHash !== eventHash) return { valid: false, reason: "event_hash_mismatch", index };
    previousHash = eventHash;
  }
  return { valid: true };
}
