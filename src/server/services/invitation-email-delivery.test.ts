import { describe, expect, it, vi } from "vitest";
import { createEmailDeliveryCipher, emailDeliveryMessageId } from "@/server/services/email-change-delivery";
import { dispatchInvitationEmailDelivery } from "@/server/services/invitation-email-delivery";
import { invitationRecipientDigest, prepareInvitationEmailDelivery } from "@/server/services/invitation-email";
import { runEmailDeliveryBatch } from "@/server/services/email-delivery-worker";

const cipher = createEmailDeliveryCipher({ CUBBY_EMAIL_DELIVERY_KEYRING: "1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", CUBBY_EMAIL_DELIVERY_ACTIVE_KEY_VERSION: "1" });
const operationId = "11111111-1111-4111-8111-111111111111";
const message = { recipient: "member@example.test", subject: "Dana invited you to Home on Cubby", text: "https://cubby.test/invite#c=display-once-token" };

function claimedRow(overrides: Record<string, unknown> = {}) {
  const prepared = prepareInvitationEmailDelivery(cipher, { deliveryId: `ied_${"a".repeat(32)}`, inviteId: "inv_1", operationId, message });
  return { id: prepared.deliveryId, householdId: "household-1", inviteId: "inv_1", operationId, recipientDigest: prepared.recipientDigest, state: "dispatching", ...prepared.encrypted, attemptCount: 1, ...overrides };
}

function database(row: unknown) {
  const claimTx = { $queryRaw: vi.fn().mockResolvedValue(row ? [row] : []) };
  const finishTx = { $executeRaw: vi.fn().mockResolvedValue(1) };
  const transactions = [claimTx, finishTx];
  return { claimTx, finishTx, db: { $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(transactions.shift())) } };
}

const text = (query: unknown) => (Array.isArray(query) ? query : (query as { strings?: readonly string[] }).strings ?? []).join("?");

describe("invitation email dispatch", () => {
  it("is idle when nothing is queued", async () => {
    const { db } = database(null);
    await expect(dispatchInvitationEmailDelivery(db as never, "worker-token-1234567890", { cipher, smtp: { send: vi.fn() } })).resolves.toEqual({ status: "idle" });
  });

  it("decrypts under the invitation binding, sends the exact message and records the receipt", async () => {
    const row = claimedRow();
    const { db, claimTx, finishTx } = database(row);
    const smtp = { send: vi.fn(async (payload: { messageId: string; recipient: string }) => ({ responseCode: 250, messageId: payload.messageId, accepted: [payload.recipient] })) };
    await expect(dispatchInvitationEmailDelivery(db as never, "worker-token-1234567890", { cipher, smtp })).resolves.toEqual({ status: "accepted", deliveryId: row.id });
    expect(text(claimTx.$queryRaw.mock.calls[0]![0])).toContain("claim_invitation_email_delivery");
    expect(smtp.send).toHaveBeenCalledWith({ ...message, messageId: emailDeliveryMessageId(row.id) });
    expect(text(finishTx.$executeRaw.mock.calls[0]![0])).toContain("accept_invitation_email_delivery");
  });

  it("records a decrypt failure when the row's binding does not match its ciphertext", async () => {
    const { db, finishTx } = database(claimedRow({ inviteId: "inv_other" }));
    const smtp = { send: vi.fn() };
    await expect(dispatchInvitationEmailDelivery(db as never, "worker-token-1234567890", { cipher, smtp })).resolves.toMatchObject({ status: "failed", code: "payload_decrypt" });
    expect(smtp.send).not.toHaveBeenCalled();
    expect(text(finishTx.$executeRaw.mock.calls[0]![0])).toContain("fail_invitation_email_delivery");
  });

  it("classifies SMTP failures without exposing their detail", async () => {
    const { db, finishTx } = database(claimedRow());
    const smtp = { send: vi.fn(async () => { throw new Error("connect ECONNREFUSED 10.0.0.1:587 [REDACTED]"); }) };
    await expect(dispatchInvitationEmailDelivery(db as never, "worker-token-1234567890", { cipher, smtp })).resolves.toMatchObject({ status: "failed", code: "smtp_connection" });
    expect(finishTx.$executeRaw.mock.calls[0]!.slice(1)).toContain("smtp_connection");
    expect(JSON.stringify(finishTx.$executeRaw.mock.calls)).not.toContain("ECONNREFUSED");
  });

  it("uses the invitation recipient digest the database recomputes", () => {
    expect(claimedRow().recipientDigest).toEqual(invitationRecipientDigest(message.recipient));
  });
});

describe("email delivery worker batch", () => {
  it("drains both the email-change and the invitation queues", async () => {
    const dispatch = vi.fn().mockResolvedValueOnce({ status: "accepted" }).mockResolvedValueOnce({ status: "idle" });
    const dispatchInvitation = vi.fn().mockResolvedValueOnce({ status: "failed" }).mockResolvedValueOnce({ status: "accepted" }).mockResolvedValueOnce({ status: "idle" });
    const result = await runEmailDeliveryBatch({ database: {} as never, cipher: {} as never, smtp: {} as never, dispatch, dispatchInvitation, workerToken: () => "worker-token-1234567890" });
    expect(result).toEqual({ accepted: 2, failed: 1, idle: true });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatchInvitation).toHaveBeenCalledTimes(3);
  });
});
