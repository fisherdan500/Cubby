import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { Prisma, type PrismaClient } from "@prisma/client";
import { env } from "@/lib/env";

const ACCOUNT_DOMAIN = "cubby:phase8:account-identifier:v1";
const CLIENT_DOMAIN = "cubby:phase8:client:v1";
const DEPLOYMENT_DOMAIN = "cubby:phase8:deployment:v1";
const UNKNOWN_CLIENT = "unknown_client";
const DEPLOYMENT_VALUE = "deployment_v1";
const base64urlKey = /^[A-Za-z0-9_-]{43}$/;
const strictIpv4 = /^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/;

export type GlobalSecurityThrottleTransaction = Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw">;
type ThrottleDatabase = Pick<PrismaClient, "$transaction">;

export type GlobalSecurityThrottleInput = {
  key: string;
  userId?: string;
  accountIdentifier?: string;
  client: string;
};

export type GlobalSecurityThrottleResult = {
  quiet: boolean;
  deadline: Date | null;
};

function readThrottleKey(encoded: string): Buffer {
  const key = Buffer.from(encoded, "base64url");
  if (!base64urlKey.test(encoded) || key.length !== 32 || !timingSafeEqual(Buffer.from(encoded), Buffer.from(key.toString("base64url")))) {
    throw new Error("global_security_throttle_key_invalid");
  }
  return key;
}

export function configuredGlobalSecurityThrottleKey(): string {
  if (!env.CUBBY_THROTTLE_KEY) throw new Error("global_security_throttle_key_invalid");
  readThrottleKey(env.CUBBY_THROTTLE_KEY);
  return env.CUBBY_THROTTLE_KEY;
}

export function optionalConfiguredGlobalSecurityThrottleKey(): string | undefined {
  if (!env.CUBBY_THROTTLE_KEY) return undefined;
  readThrottleKey(env.CUBBY_THROTTLE_KEY);
  return env.CUBBY_THROTTLE_KEY;
}

function frameIdentity(domain: string, value: string): Buffer {
  const domainBytes = Buffer.from(domain, "utf8");
  const valueBytes = Buffer.from(value, "utf8");
  const frame = Buffer.allocUnsafe(8 + domainBytes.length + valueBytes.length);
  frame.writeUInt32BE(domainBytes.length, 0);
  domainBytes.copy(frame, 4);
  frame.writeUInt32BE(valueBytes.length, 4 + domainBytes.length);
  valueBytes.copy(frame, 8 + domainBytes.length);
  return frame;
}

export function deriveThrottleIdentity(encodedKey: string, domain: string, value: string): string {
  return createHmac("sha256", readThrottleKey(encodedKey)).update(frameIdentity(domain, value)).digest("base64url");
}

export function normalizeThrottleAccountIdentifier(value: string): string {
  return value.trim().toLowerCase();
}

export function canonicalizeTrustedClient(trustedProxyHops: number, forwardedFor: string | null | undefined): string {
  if (trustedProxyHops === 0) return UNKNOWN_CLIENT;
  if (trustedProxyHops !== 1) throw new Error("global_security_trusted_proxy_hops_invalid");
  if (!forwardedFor || forwardedFor.split(",").length !== 1) return UNKNOWN_CLIENT;
  const candidate = forwardedFor.trim();
  if (!candidate) return UNKNOWN_CLIENT;
  if (isIP(candidate) === 4) {
    if (!strictIpv4.test(candidate) || candidate.split(".").some((part) => Number(part) > 255)) return UNKNOWN_CLIENT;
    return candidate;
  }
  const ipv6Candidate = candidate.startsWith("[") && candidate.endsWith("]") ? candidate.slice(1, -1) : candidate;
  if (isIP(ipv6Candidate) === 6) {
    try {
      const hostname = new URL(`http://[${ipv6Candidate}]/`).hostname.toLowerCase();
      return hostname.slice(1, -1);
    } catch {
      return UNKNOWN_CLIENT;
    }
  }
  return UNKNOWN_CLIENT;
}

function deriveThrottleKeys(input: GlobalSecurityThrottleInput) {
  if ((input.userId === undefined) !== (input.accountIdentifier === undefined)) throw new Error("global_security_throttle_input_invalid");
  const accountKey = input.accountIdentifier === undefined
    ? null
    : deriveThrottleIdentity(input.key, ACCOUNT_DOMAIN, `account_identifier_v1\0${normalizeThrottleAccountIdentifier(input.accountIdentifier)}`);
  const clientKey = deriveThrottleIdentity(input.key, CLIENT_DOMAIN, `client_v1\0${input.client || UNKNOWN_CLIENT}`);
  const deploymentKey = deriveThrottleIdentity(input.key, DEPLOYMENT_DOMAIN, DEPLOYMENT_VALUE);
  return { accountKey, clientKey, deploymentKey };
}

function normalizeResult(rows: Array<{ quiet: boolean; deadline: Date | null }>): GlobalSecurityThrottleResult {
  const result = rows[0];
  if (!result || typeof result.quiet !== "boolean") throw new Error("global_security_throttle_unavailable");
  return { quiet: result.quiet, deadline: result.deadline ? new Date(result.deadline) : null };
}

function isSerializableConflict(error: unknown) {
  const candidate = error as { code?: unknown; message?: unknown; meta?: { code?: unknown } };
  return candidate?.code === "P2034" || candidate?.meta?.code === "40001" || (typeof candidate?.message === "string" && (candidate.message.includes("40001") || candidate.message.includes("could not serialize")));
}

async function runSerializableThrottle<T>(database: ThrottleDatabase, action: (tx: Prisma.TransactionClient) => Promise<T>) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await database.$transaction(action, { isolationLevel: "Serializable" });
    } catch (error) {
      if (!isSerializableConflict(error) || attempt === 2) throw error;
    }
  }
  throw new Error("global_security_throttle_unavailable");
}

async function callThrottleProcedure(
  tx: GlobalSecurityThrottleTransaction,
  procedure: "global_security_throttle_precheck" | "global_security_throttle_failure",
  input: GlobalSecurityThrottleInput
): Promise<GlobalSecurityThrottleResult> {
  const keys = deriveThrottleKeys(input);
  const rows = await tx.$queryRaw<Array<{ quiet: boolean; deadline: Date | null }>>`
    SELECT "quiet", "deadline" FROM ${Prisma.raw(`"${procedure}"`)}(${input.userId ?? null},${keys.accountKey},${keys.clientKey},${keys.deploymentKey})
  `;
  return normalizeResult(rows);
}

export async function precheckGlobalSecurityThrottle(database: ThrottleDatabase, input: GlobalSecurityThrottleInput): Promise<GlobalSecurityThrottleResult> {
  return runSerializableThrottle(database, (tx) => precheckGlobalSecurityThrottleInTransaction(tx, input));
}

export async function precheckGlobalSecurityThrottleInTransaction(tx: GlobalSecurityThrottleTransaction, input: GlobalSecurityThrottleInput): Promise<GlobalSecurityThrottleResult> {
  return callThrottleProcedure(tx, "global_security_throttle_precheck", input);
}

export async function recordGlobalSecurityThrottleFailure(database: ThrottleDatabase, input: GlobalSecurityThrottleInput): Promise<GlobalSecurityThrottleResult> {
  return runSerializableThrottle(database, (tx) => recordGlobalSecurityThrottleFailureInTransaction(tx, input));
}

export async function recordGlobalSecurityThrottleFailureInTransaction(tx: GlobalSecurityThrottleTransaction, input: GlobalSecurityThrottleInput): Promise<GlobalSecurityThrottleResult> {
  return callThrottleProcedure(tx, "global_security_throttle_failure", input);
}

export async function writeGlobalSecurityEvent(
  tx: Pick<Prisma.TransactionClient, "$executeRaw">,
  userId: string,
  eventType: "credential" | "grant" | "recovery" | "email_change" | "session" | "operation_outcome",
  outcome: string,
  operationId?: string
) {
  await tx.$executeRaw`SELECT "write_global_security_event"(${userId},${eventType},${outcome},${operationId ?? null})`;
}
