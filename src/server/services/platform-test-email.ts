import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db/prisma";
import { writePlatformAudit } from "@/server/services/audit";
import { getPlatformOwnerContext } from "@/server/services/platform-authority";
import { PLATFORM_SINGLETON_ID } from "@/server/services/platform-constants";
import { createSmtpEmailDeliveryAdapter } from "@/server/services/smtp-email-delivery";

export type SmtpFailureReason = "authentication" | "connection" | "temporary" | "rejected" | "unknown";

export type PlatformTestEmailResult =
  | { status: "sent"; recipient: string }
  | { status: "not_configured" }
  | { status: "throttled"; retryAfterSeconds: number }
  | { status: "failed"; reason: SmtpFailureReason; responseCode: number | null; recipient: string };

type TestAdapter = { send: (payload: { recipient: string; subject: string; text: string; messageId: string }) => Promise<unknown> };

// Short enough that a wrong host or port answers the owner in seconds, not nodemailer's two minutes.
const TEST_TIMEOUTS = { connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 20_000 };
// Process-wide across route bundles, not durable or shared between app instances.
// A minute after actual settlement bounds repeated diagnostics without blocking normal setup.
const TEST_EMAIL_COOLDOWN_MS = 60_000;
const admission = globalThis as typeof globalThis & { cubbyTestEmailAdmission?: { inFlight: boolean; nextAllowedAt: number } };
const gate = admission.cubbyTestEmailAdmission ??= { inFlight: false, nextAllowedAt: 0 };
const CONNECTION_CODES = new Set(["ECONNECTION", "ETIMEDOUT", "ESOCKET", "EDNS", "ECONNREFUSED", "ECONNRESET", "ETLS"]);

/**
 * Sorts a send failure into the few things an owner can act on, keeping only the server's numeric
 * reply code: the raw error text can repeat the server's banner or parts of the login exchange.
 */
export function classifySmtpFailure(error: unknown): { reason: SmtpFailureReason; responseCode: number | null } {
  const details = typeof error === "object" && error !== null ? (error as { code?: unknown; responseCode?: unknown; message?: unknown }) : {};
  const responseCode = typeof details.responseCode === "number" && Number.isInteger(details.responseCode) ? details.responseCode : null;
  const code = typeof details.code === "string" ? details.code : "";
  const message = typeof details.message === "string" ? details.message : "";
  if (message === "smtp_temporary" || (responseCode !== null && responseCode >= 400 && responseCode < 500)) return { reason: "temporary", responseCode };
  if (message === "smtp_auth" || code === "EAUTH" || responseCode === 530 || responseCode === 534 || responseCode === 535) return { reason: "authentication", responseCode };
  if (message === "smtp_connection" || message === "smtp_timeout" || CONNECTION_CODES.has(code)) return { reason: "connection", responseCode };
  if (message === "recipient_rejected" || message === "smtp_rejected" || code === "EENVELOPE" || (responseCode !== null && responseCode >= 500)) {
    return { reason: "rejected", responseCode };
  }
  return { reason: "unknown", responseCode };
}

/**
 * Sends one message, now, to the platform owner's own address, so the owner can prove the mail
 * settings work without starting an email change. It can reach no other address.
 */
export async function sendPlatformTestEmail(
  createAdapter: () => TestAdapter = () => createSmtpEmailDeliveryAdapter(undefined, undefined, TEST_TIMEOUTS)
): Promise<PlatformTestEmailResult> {
  const owner = await getPlatformOwnerContext();
  const user = await prisma.user.findUnique({ where: { id: owner.userId }, select: { email: true } });
  if (!user) throw new Error("forbidden");

  const remaining = gate.nextAllowedAt - performance.now();
  if (gate.inFlight || remaining > 0) {
    return { status: "throttled", retryAfterSeconds: gate.inFlight ? 60 : Math.ceil(remaining / 1000) };
  }
  gate.inFlight = true;
  try {
    return await sendAndAudit(owner.userId, user.email, createAdapter);
  } finally {
    gate.nextAllowedAt = performance.now() + TEST_EMAIL_COOLDOWN_MS;
    gate.inFlight = false;
  }
}

async function sendAndAudit(userId: string, recipient: string, createAdapter: () => TestAdapter): Promise<PlatformTestEmailResult> {
  let result: PlatformTestEmailResult;
  let adapter: TestAdapter | null = null;
  try {
    adapter = createAdapter();
  } catch {
    result = { status: "not_configured" };
  }
  if (adapter) {
    try {
      await adapter.send({
        recipient,
        subject: "Cubby test email",
        text: "This is a test message from your Cubby server. If you are reading it, Cubby can send email.",
        messageId: `<cubby-test.${randomUUID()}@mail.cubby.local>`
      });
      result = { status: "sent", recipient };
    } catch (error) {
      result = { status: "failed", ...classifySmtpFailure(error), recipient };
    }
  }

  const outcome = result!.status === "failed" ? `failed_${result!.reason}` : result!.status;
  await prisma.$transaction((tx) => writePlatformAudit({
    action: "platform.email.test",
    entityType: "platform_authority",
    entityId: PLATFORM_SINGLETON_ID,
    actorUserId: userId,
    source: `email_test_${outcome}`
  }, tx));
  return result!;
}
