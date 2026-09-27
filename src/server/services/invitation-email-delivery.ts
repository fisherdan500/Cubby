import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { createEmailDeliveryCipher, emailDeliveryMessageId } from "@/server/services/email-change-delivery";
import { invitationEmailBinding, type InvitationEmailMessage } from "@/server/services/invitation-email";

type FailureCode = "payload_decrypt" | "receipt_invalid" | "recipient_rejected" | "smtp_connection" | "smtp_rate_limited" | "smtp_temporary" | "smtp_timeout" | "smtp_auth" | "smtp_rejected";
type Smtp = { send: (payload: InvitationEmailMessage & { messageId: string }) => Promise<{ responseCode: number; messageId: string; accepted: string[] }> };
type ClaimedRow = { id: string; inviteId: string; operationId: string; recipientDigest: Uint8Array; keyVersion: number | null; ciphertext: Uint8Array | null; iv: Uint8Array | null; authTag: Uint8Array | null; aadDigest: Uint8Array | null };

/** Mirrors the email-change dispatcher: claim under a lease, send the one decrypted message, then record the outcome. */
export async function dispatchInvitationEmailDelivery(database: Pick<PrismaClient, "$transaction">, workerToken: string, deps: { cipher: ReturnType<typeof createEmailDeliveryCipher>; smtp: Smtp }) {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(workerToken)) throw new Error("email_delivery_worker_invalid");
  const claimed = await database.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<ClaimedRow[]>`SELECT * FROM "claim_invitation_email_delivery"(${workerToken})`;
    return rows[0] ?? null;
  }, { isolationLevel: "Serializable" });
  if (!claimed) return { status: "idle" as const };
  const fail = async (code: FailureCode) => {
    await database.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT "fail_invitation_email_delivery"(${claimed.id},${workerToken},${code})`;
    }, { isolationLevel: "Serializable" });
    return { status: "failed" as const, deliveryId: claimed.id, code };
  };
  let payload: InvitationEmailMessage;
  try {
    const binding = invitationEmailBinding({ deliveryId: claimed.id, inviteId: claimed.inviteId, operationId: String(claimed.operationId), recipientDigest: Buffer.from(claimed.recipientDigest) });
    payload = deps.cipher.decrypt(binding, { keyVersion: claimed.keyVersion!, ciphertext: Buffer.from(claimed.ciphertext!), iv: Buffer.from(claimed.iv!), authTag: Buffer.from(claimed.authTag!), aadDigest: Buffer.from(claimed.aadDigest!) });
  } catch {
    return fail("payload_decrypt");
  }
  const messageId = emailDeliveryMessageId(claimed.id);
  let receipt: Awaited<ReturnType<Smtp["send"]>>;
  try {
    receipt = await deps.smtp.send({ ...payload, messageId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const closedCode = ["recipient_rejected", "smtp_auth", "smtp_timeout", "smtp_rate_limited", "smtp_temporary", "smtp_rejected"].includes(message) ? message as FailureCode : "smtp_connection";
    return fail(closedCode);
  }
  if (receipt.responseCode !== 250 || receipt.messageId !== messageId || receipt.accepted.length !== 1 || receipt.accepted[0] !== payload.recipient) return fail("receipt_invalid");
  await database.$transaction(async (tx) => {
    const messageBytes = Buffer.from(receipt.messageId, "utf8");
    const length = Buffer.alloc(4); length.writeUInt32BE(messageBytes.length);
    const digest = createHash("sha256").update(Buffer.concat([length, messageBytes])).digest();
    await tx.$executeRaw`SELECT "accept_invitation_email_delivery"(${claimed.id},${workerToken},${250}::integer,${Uint8Array.from(digest)})`;
  }, { isolationLevel: "Serializable" });
  return { status: "accepted" as const, deliveryId: claimed.id };
}
