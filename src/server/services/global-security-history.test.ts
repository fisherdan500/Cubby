import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createGlobalSecurityHistoryHandle,
  decodeGlobalSecurityHistoryCursor,
  encodeGlobalSecurityHistoryCursor,
  exportGlobalSecurityHistory,
  listGlobalSecurityHistory,
  parseGlobalSecurityHistoryLimit
} from "@/server/services/global-security-history";

const { key } = vi.hoisted(() => ({ key: Buffer.alloc(32, 13).toString("base64url") }));

vi.mock("@/lib/env", () => ({ env: { CUBBY_THROTTLE_KEY: key } }));

const context = { userId: "user-1", sessionId: "session-1", credentialVersion: 2, sessionSecurityVersion: 3 };
const row = (sequence: bigint, eventId = `event-${sequence}`) => ({
  sequence,
  eventId,
  eventClass: "throttle",
  outcome: "quiet_started",
  occurredAt: new Date("2026-08-29T12:00:00.000Z"),
  operationKey: null,
  windowStartedAt: new Date("2026-08-29T11:45:00.000Z"),
  failureCount: 20,
  quietUntil: null,
  snapshotMaxSequence: 9n,
  exportedAt: new Date("2026-08-29T12:00:01.000Z")
});

describe("global security history cursor and projection", () => {
  it("uses the versioned binary cursor with a full domain-separated HMAC and rejects foreign or malformed values", () => {
    const cursor = encodeGlobalSecurityHistoryCursor("user-1", { snapshotMaxSequence: 9n, lastSequence: 7n });
    const [payload, mac] = cursor.split(".");
    const payloadBytes = Buffer.from(payload!, "base64url");
    const frame = (value: string) => Buffer.concat([Buffer.from([0, 0, 0, Buffer.byteLength(value)]), Buffer.from(value)]);
    expect(payloadBytes.subarray(0, 19)).toEqual(Buffer.from([1, 0, 0, 0, 0, 0, 0, 0, 9, 0, 0, 0, 0, 0, 0, 0, 7, 0, 6]));
    expect(mac).toBe(createHmac("sha256", Buffer.alloc(32, 13)).update(Buffer.concat([frame("cubby:phase8:history-cursor:v1"), payloadBytes])).digest("base64url"));
    expect(decodeGlobalSecurityHistoryCursor("user-1", cursor)).toEqual({ snapshotMaxSequence: 9n, lastSequence: 7n });
    expect(() => decodeGlobalSecurityHistoryCursor("user-2", cursor)).toThrow("security_history_cursor_invalid");
    expect(() => decodeGlobalSecurityHistoryCursor("user-1", `${payload}.x`)).toThrow("security_history_cursor_invalid");
  });

  it("returns only safe history fields, opaque event handles, and a stable snapshot cursor", async () => {
    const query = vi.fn().mockResolvedValue([row(9n), row(8n), row(7n)]);
    const result = await listGlobalSecurityHistory({ $queryRaw: query } as never, context, { limit: 2 });

    expect(result.events).toEqual(expect.arrayContaining([expect.objectContaining({
      handle: expect.stringMatching(/^[A-Za-z0-9_-]{30}$/), eventClass: "throttle", action: "sign_in_protection", outcome: "quiet_started",
      incident: { windowStartedAt: new Date("2026-08-29T11:45:00.000Z"), windowEndedAt: new Date("2026-08-29T12:00:00.000Z"), approximateFailures: "20-49", guidance: ["change_password", "review_sessions"] }
    })]));
    expect(decodeGlobalSecurityHistoryCursor(context.userId, result.nextCursor!)).toEqual({ snapshotMaxSequence: 9n, lastSequence: 8n });
    expect(JSON.stringify(result)).not.toMatch(/event-9|sequence|incidentId|normalizedKey|user-1|session-1/i);
    expect(query.mock.calls[0]?.[0].join(" ")).toContain("read_global_security_history");
  });

  it("uses the same safe projection for an oldest-first repeatable-read export and enforces its hard cap", async () => {
    const query = vi.fn().mockResolvedValue([row(1n), row(2n)]);
    const transaction = vi.fn(async (callback) => callback({ $queryRaw: query }));
    const result = await exportGlobalSecurityHistory({ $transaction: transaction } as never, context);

    expect(result).toEqual(expect.objectContaining({ schemaVersion: 1, exportType: "cubby_global_security_history", exportedAt: expect.any(Date), events: expect.any(Array) }));
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "RepeatableRead", maxWait: 5_000, timeout: 15_000 });
    expect(query.mock.calls[0]?.[0].join(" ")).toContain("read_global_security_history");
    await expect(exportGlobalSecurityHistory({ $transaction: vi.fn(async (callback) => callback({ $queryRaw: vi.fn().mockResolvedValue(Array.from({ length: 100001 }, (_, index) => row(BigInt(index + 1)))) })) } as never, context)).rejects.toThrow("security_history_export_too_large");
  });

  it("strictly bounds request limits and does not expose input IDs through a handle", () => {
    expect(parseGlobalSecurityHistoryLimit(null)).toBe(50);
    expect(parseGlobalSecurityHistoryLimit("100")).toBe(100);
    expect(() => parseGlobalSecurityHistoryLimit("01")).toThrow("security_history_query_invalid");
    expect(createGlobalSecurityHistoryHandle("user-1", "event-1")).not.toContain("event-1");
  });
});
