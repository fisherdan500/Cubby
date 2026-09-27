import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createEmailDeliveryCipher } from "@/server/services/email-change-delivery";
import { invitationEmailBinding } from "@/server/services/invitation-email";
import { queueManualInvitationEmail } from "@/server/services/invitation-email-queue";
import { dispatchInvitationEmailDelivery } from "@/server/services/invitation-email-delivery";

const keyring = { CUBBY_EMAIL_DELIVERY_KEYRING: "1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", CUBBY_EMAIL_DELIVERY_ACTIVE_KEY_VERSION: "1" };
const environment = { SMTP_HOST: "smtp.example.invalid", SMTP_PORT: "587", SMTP_USER: "user", SMTP_PASSWORD: "[REDACTED]", EMAIL_FROM: "Cubby <noreply@example.invalid>", ...keyring, BETTER_AUTH_URL: "https://cubby.test", APP_TIMEZONE: "UTC" };
const operationId = "11111111-1111-4111-8111-111111111111";
const request = { ordinarySessionId: "session-1", subjectUserId: "user-1", issuerMembershipEpisodeId: "member-1", subjectMembershipEpisodeId: null, openingFingerprint: Buffer.alloc(32, 1), intentFingerprint: Buffer.alloc(32, 2) };
const invite = { id: "inv_1", email: "member@example.test", expiresAt: new Date("2030-01-08T12:00:00.000Z"), household: { name: "Home" }, invitedBy: { name: "Dana" } };

function setup(overrides: { invite?: unknown; enqueue?: ReturnType<typeof vi.fn> } = {}) {
  const findFirst = vi.fn().mockResolvedValue("invite" in overrides ? overrides.invite : invite);
  const enqueue = overrides.enqueue ?? vi.fn().mockResolvedValue({ operationId, status: "queued" });
  return { findFirst, enqueue, deps: { database: { invite: { findFirst } } as never, environment } };
}

const input = (enqueue: unknown) => ({ services: { manualEmail: { enqueue } } as never, operationId, operationKind: "MANUAL_INVITE_CREATE" as const, target: "household-1", householdId: "household-1", inviteToken: "display-once-token", request });

describe("queueManualInvitationEmail", () => {
  it.each([
    ["MANUAL_INVITE_CREATE", "ABCDEFAB-ABCD-4ABC-8ABC-ABCDEFABCDEF"],
    ["MANUAL_INVITE_CREATE", "abcdefAB-abcd-4abc-8aBc-abcdefabcdef"],
    ["MANUAL_INVITE_REPLACE", "ABCDEFAB-ABCD-4ABC-8ABC-ABCDEFABCDEF"],
    ["MANUAL_INVITE_REPLACE", "abcdefAB-abcd-4abc-8aBc-abcdefabcdef"]
  ] as const)("dispatches %s ciphertext after PostgreSQL canonicalizes UUID %s", async (operationKind, operationId) => {
    const { enqueue, deps } = setup();
    await expect(queueManualInvitationEmail({ ...input(enqueue), operationKind, target: operationKind === "MANUAL_INVITE_REPLACE" ? "old-invite" : "household-1", operationId }, deps)).resolves.toBe("queued");
    const { delivery } = enqueue.mock.calls[0]![0];
    const row = { id: delivery.deliveryId, inviteId: invite.id, operationId: operationId.toLowerCase(), recipientDigest: delivery.recipientDigest, ...delivery.encrypted };
    const finish = { $executeRaw: vi.fn().mockResolvedValue(1) };
    const transactions = [{ $queryRaw: vi.fn().mockResolvedValue([row]) }, finish];
    const database = { $transaction: vi.fn(async (callback) => callback(transactions.shift())) };
    const smtp = { send: vi.fn(async (message: { messageId: string; recipient: string }) => ({ responseCode: 250, messageId: message.messageId, accepted: [message.recipient] })) };
    await expect(dispatchInvitationEmailDelivery(database as never, "worker-token-1234567890", { cipher: createEmailDeliveryCipher(keyring), smtp })).resolves.toMatchObject({ status: "accepted" });
    expect(smtp.send).toHaveBeenCalledTimes(1);
    expect(smtp.send).toHaveBeenCalledWith(expect.objectContaining({ recipient: invite.email }));
  });

  it.each(["first@example.test,second@example.test", "first@example.test <second@example.test>", "first@example.test\r\nBcc:second@example.test", "first@example.test\n", "not-a-mailbox"])("does not enqueue a malformed stored recipient: %j", async (email) => {
    const { enqueue, deps } = setup({ invite: { ...invite, email } });
    await expect(queueManualInvitationEmail(input(enqueue), deps)).resolves.toBe("not_queued");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("finds the new invitation by token hash in the issuer's household and queues its encrypted email", async () => {
    const { findFirst, enqueue, deps } = setup();
    await expect(queueManualInvitationEmail(input(enqueue), deps)).resolves.toBe("queued");
    const tokenHash = createHash("sha256").update("display-once-token", "utf8").digest("hex");
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { tokenHash, householdId: "household-1", status: "pending" } }));
    const call = enqueue.mock.calls[0]![0];
    expect(call).toMatchObject({ operationId, operationKind: "MANUAL_INVITE_CREATE", target: "household-1", tokenHash, request });
    expect(JSON.stringify(call)).not.toContain("display-once-token");
    const cipher = createEmailDeliveryCipher(keyring);
    const message = cipher.decrypt(invitationEmailBinding({ deliveryId: call.delivery.deliveryId, inviteId: "inv_1", operationId, recipientDigest: call.delivery.recipientDigest }), call.delivery.encrypted);
    expect(message.recipient).toBe("member@example.test");
    expect(message.text).toContain("https://cubby.test/invite#c=display-once-token");
    expect(message.text).toContain("Dana invited you to join Home on Cubby.");
  });

  it("reports not_queued, without throwing, when email is unavailable, the invitation is missing, or the queue refuses", async () => {
    const unavailable = setup();
    await expect(queueManualInvitationEmail(input(unavailable.enqueue), { ...unavailable.deps, environment: { ...environment, SMTP_HOST: "" } })).resolves.toBe("not_queued");
    expect(unavailable.enqueue).not.toHaveBeenCalled();
    const missing = setup({ invite: null });
    await expect(queueManualInvitationEmail(input(missing.enqueue), missing.deps)).resolves.toBe("not_queued");
    expect(missing.enqueue).not.toHaveBeenCalled();
    const refused = setup({ enqueue: vi.fn().mockRejectedValue(new Error("invitation_email_enqueue_invalid")) });
    await expect(queueManualInvitationEmail(input(refused.enqueue), refused.deps)).resolves.toBe("not_queued");
  });
});
