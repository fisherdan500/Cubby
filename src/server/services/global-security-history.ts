import { createHmac, timingSafeEqual } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { configuredGlobalSecurityThrottleKey } from "@/server/services/global-security-throttling";
import type { GlobalSecurityContext } from "@/server/services/global-security";

const HISTORY_HANDLE_DOMAIN = "cubby:phase8:history-handle:v1";
const HISTORY_CURSOR_DOMAIN = "cubby:phase8:history-cursor:v1";
const CURSOR_VERSION = 1;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const EXPORT_MAXIMUM_EVENTS = 100000;

type HistoryDatabase = Pick<PrismaClient, "$queryRaw" | "$transaction">;
type HistoryTransaction = Pick<Prisma.TransactionClient, "$queryRaw">;

type HistoryRow = {
  sequence: bigint | null;
  eventId: string | null;
  eventClass: string | null;
  outcome: string | null;
  occurredAt: Date | null;
  operationKey: string | null;
  windowStartedAt: Date | null;
  failureCount: number | null;
  quietUntil: Date | null;
  snapshotMaxSequence: bigint | null;
  exportedAt: Date;
};

export type SecurityHistoryIncident = {
  windowStartedAt: Date;
  windowEndedAt: Date;
  approximateFailures: "5-9" | "10-19" | "20-49" | "50+";
  guidance: readonly ["change_password", "review_sessions"];
};

export type SecurityHistoryEvent = {
  handle: string;
  eventClass: string;
  action: string;
  outcome: string;
  occurredAt: Date;
  operationKey?: string;
  incident?: SecurityHistoryIncident;
};

type Cursor = { snapshotMaxSequence: bigint; lastSequence: bigint };

function frameUtf8(value: string) {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function historyKey() {
  return Buffer.from(configuredGlobalSecurityThrottleKey(), "base64url");
}

function signCursor(payload: Buffer) {
  return createHmac("sha256", historyKey())
    .update(Buffer.concat([frameUtf8(HISTORY_CURSOR_DOMAIN), payload]))
    .digest();
}

function cursorInvalid(): never {
  throw new Error("security_history_cursor_invalid");
}

function exactBase64url(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const decoded = Buffer.from(value, "base64url");
  return decoded.toString("base64url") === value ? decoded : null;
}

export function createGlobalSecurityHistoryHandle(userId: string, eventId: string) {
  return createHmac("sha256", historyKey())
    .update(Buffer.concat([frameUtf8(HISTORY_HANDLE_DOMAIN), frameUtf8(userId), frameUtf8(eventId)]))
    .digest()
    .subarray(0, 22)
    .toString("base64url");
}

export function encodeGlobalSecurityHistoryCursor(userId: string, cursor: Cursor) {
  const userBytes = Buffer.from(userId, "utf8");
  if (userBytes.length === 0 || userBytes.length > 65535 || cursor.snapshotMaxSequence < 1n || cursor.lastSequence < 1n || cursor.lastSequence > cursor.snapshotMaxSequence) {
    cursorInvalid();
  }
  const payload = Buffer.allocUnsafe(19 + userBytes.length);
  payload.writeUInt8(CURSOR_VERSION, 0);
  payload.writeBigUInt64BE(cursor.snapshotMaxSequence, 1);
  payload.writeBigUInt64BE(cursor.lastSequence, 9);
  payload.writeUInt16BE(userBytes.length, 17);
  userBytes.copy(payload, 19);
  return `${payload.toString("base64url")}.${signCursor(payload).toString("base64url")}`;
}

export function decodeGlobalSecurityHistoryCursor(userId: string, token: string): Cursor {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return cursorInvalid();
  const payload = exactBase64url(parts[0]);
  const mac = exactBase64url(parts[1]);
  if (!payload || !mac || mac.length !== 32) return cursorInvalid();
  const expectedMac = signCursor(payload);
  if (!timingSafeEqual(mac, expectedMac) || payload.length < 19 || payload.readUInt8(0) !== CURSOR_VERSION) return cursorInvalid();
  const snapshotMaxSequence = payload.readBigUInt64BE(1);
  const lastSequence = payload.readBigUInt64BE(9);
  const userLength = payload.readUInt16BE(17);
  if (userLength === 0 || payload.length !== 19 + userLength || snapshotMaxSequence < 1n || lastSequence < 1n || lastSequence > snapshotMaxSequence) return cursorInvalid();
  const cursorUser = payload.subarray(19).toString("utf8");
  if (!Buffer.from(cursorUser, "utf8").equals(payload.subarray(19)) || cursorUser !== userId) return cursorInvalid();
  return { snapshotMaxSequence, lastSequence };
}

export function parseGlobalSecurityHistoryLimit(value: string | null) {
  if (value === null) return DEFAULT_LIMIT;
  if (!/^(?:[1-9][0-9]{0,2})$/.test(value)) throw new Error("security_history_query_invalid");
  const limit = Number(value);
  if (limit < 1 || limit > MAX_LIMIT) throw new Error("security_history_query_invalid");
  return limit;
}

function actionFor(eventClass: string) {
  return ({
    credential: "sign_in",
    grant: "current_password",
    recovery: "account_recovery",
    email_change: "email_change",
    session: "session_management",
    throttle: "sign_in_protection",
    operation_outcome: "security_operation"
  } as Record<string, string>)[eventClass] ?? "security_event";
}

function incidentFor(row: HistoryRow): SecurityHistoryIncident | undefined {
  if (!row.windowStartedAt || row.failureCount === null) return undefined;
  const approximateFailures = row.failureCount >= 50 ? "50+" : row.failureCount >= 20 ? "20-49" : row.failureCount >= 10 ? "10-19" : "5-9";
  return {
    windowStartedAt: row.windowStartedAt,
    windowEndedAt: row.quietUntil ?? new Date(row.windowStartedAt.getTime() + 15 * 60 * 1000),
    approximateFailures,
    guidance: ["change_password", "review_sessions"]
  };
}

function projectRow(userId: string, row: HistoryRow): SecurityHistoryEvent {
  if (!row.eventId || !row.eventClass || !row.outcome || !row.occurredAt) throw new Error("security_history_projection_invalid");
  const incident = incidentFor(row);
  return {
    handle: createGlobalSecurityHistoryHandle(userId, row.eventId),
    eventClass: row.eventClass,
    action: actionFor(row.eventClass),
    outcome: row.outcome,
    occurredAt: row.occurredAt,
    ...(row.operationKey ? { operationKey: row.operationKey } : {}),
    ...(incident ? { incident } : {})
  };
}

async function readRows(
  database: Pick<HistoryTransaction, "$queryRaw">,
  context: GlobalSecurityContext,
  input: { snapshotMaxSequence: bigint | null; lastSequence: bigint | null; limit: number; oldestFirst: boolean }
) {
  return database.$queryRaw<HistoryRow[]>`
    SELECT * FROM "read_global_security_history"(
      ${context.userId}, ${context.sessionId}, ${context.credentialVersion}::INTEGER, ${context.sessionSecurityVersion}::INTEGER,
      ${input.snapshotMaxSequence}::BIGINT, ${input.lastSequence}::BIGINT, ${input.limit}::INTEGER, ${input.oldestFirst}
    )
  `;
}

export async function listGlobalSecurityHistory(
  database: Pick<HistoryDatabase, "$queryRaw">,
  context: GlobalSecurityContext,
  input: { limit?: number; cursor?: string }
) {
  const limit = input.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error("security_history_query_invalid");
  const cursor = input.cursor === undefined ? null : decodeGlobalSecurityHistoryCursor(context.userId, input.cursor);
  const rows = await readRows(database, context, {
    snapshotMaxSequence: cursor?.snapshotMaxSequence ?? null,
    lastSequence: cursor?.lastSequence ?? null,
    limit: limit + 1,
    oldestFirst: false
  });
  const eventRows = rows.filter((row) => row.eventId !== null);
  const page = eventRows.slice(0, limit);
  const last = page.at(-1);
  return {
    events: page.map((row) => projectRow(context.userId, row)),
    nextCursor: eventRows.length > limit && last && last.snapshotMaxSequence !== null && last.sequence !== null
      ? encodeGlobalSecurityHistoryCursor(context.userId, { snapshotMaxSequence: last.snapshotMaxSequence, lastSequence: last.sequence })
      : null
  };
}

export async function exportGlobalSecurityHistory(database: HistoryDatabase, context: GlobalSecurityContext) {
  const rows = await database.$transaction(async (tx) => readRows(tx, context, {
    snapshotMaxSequence: null,
    lastSequence: null,
    limit: EXPORT_MAXIMUM_EVENTS + 1,
    oldestFirst: true
  }), { isolationLevel: "RepeatableRead", maxWait: 5_000, timeout: 15_000 });
  const eventRows = rows.filter((row) => row.eventId !== null);
  if (eventRows.length > EXPORT_MAXIMUM_EVENTS) throw new Error("security_history_export_too_large");
  return {
    schemaVersion: 1,
    exportType: "cubby_global_security_history",
    exportedAt: rows[0]?.exportedAt ?? new Date(0),
    events: eventRows.map((row) => projectRow(context.userId, row))
  } as const;
}

export const globalSecurityHistoryExportFilename = "cubby-global-security-history-v1-UTC.json";
