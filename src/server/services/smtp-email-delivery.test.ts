import nodemailer from "nodemailer";
import { describe, expect, it, vi } from "vitest";
import { createSmtpEmailDeliveryAdapter } from "@/server/services/smtp-email-delivery";
import { createEmailDeliveryCipher, dispatchEmailChangeDelivery } from "@/server/services/email-change-delivery";
import { dispatchInvitationEmailDelivery } from "@/server/services/invitation-email-delivery";
import { invitationEmailBinding } from "@/server/services/invitation-email";

const environment = { SMTP_HOST: "smtp.example.invalid", SMTP_PORT: "587", SMTP_USER: "synthetic-user", SMTP_PASSWORD: "synthetic-password", EMAIL_FROM: "Cubby <noreply@example.invalid>" };
const payload = { recipient: "member@example.test", subject: "Invitation", text: "synthetic message", messageId: "<test@cubby.local>" };

describe.each(["invitation", "email-change"] as const)("structured SMTP failures in %s delivery", (kind) => {
  it.each([
    [{ code: "EENVELOPE", responseCode: 550, command: "RCPT TO" }, "recipient_rejected"],
    [{ code: "EENVELOPE", responseCode: 550, command: "MAIL FROM" }, "smtp_rejected"],
    [{ code: "EAUTH", responseCode: 535 }, "smtp_auth"],
    [{ code: "EAUTH" }, "smtp_auth"],
    [{ code: "EMESSAGE", responseCode: 554 }, "smtp_rejected"],
    [{ code: "EENVELOPE", responseCode: 450 }, "smtp_temporary"],
    [{ code: "EAUTH", responseCode: 454 }, "smtp_temporary"],
    [{ code: "ECONNECTION", responseCode: 421 }, "smtp_temporary"],
    [{ code: "ETIMEDOUT" }, "smtp_timeout"],
    [{ code: "ECONNECTION" }, "smtp_connection"],
    [{ code: "ESOCKET" }, "smtp_connection"]
  ])("maps %j to %s without persisting provider detail", async (fields, expected) => {
    const cipher = createEmailDeliveryCipher({ CUBBY_EMAIL_DELIVERY_KEYRING: "1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", CUBBY_EMAIL_DELIVERY_ACTIVE_KEY_VERSION: "1" });
    const identity = { deliveryId: "delivery-1", inviteId: "invite-1", userId: "user-1", operationId: "11111111-1111-4111-8111-111111111111", recipientDigest: Buffer.alloc(32, 4) };
    const binding = kind === "invitation" ? invitationEmailBinding(identity) : { ...identity, kind: "newVerification" };
    const row = { ...identity, id: identity.deliveryId, kind: binding.kind, ...cipher.encrypt(binding, payload) };
    const finish = { $executeRaw: vi.fn().mockResolvedValue(1) };
    const transactions = [{ $queryRaw: vi.fn().mockResolvedValue([row]) }, finish];
    const database = { $transaction: vi.fn(async (callback) => callback(transactions.shift())) };
    const providerError = Object.assign(new Error("private-provider-detail"), { ...fields, response: "private-provider-detail" });
    const sendMail = vi.fn().mockRejectedValue(providerError);
    const smtp = createSmtpEmailDeliveryAdapter(environment, { createTransport: vi.fn(() => ({ sendMail })) as never });
    const dispatch = kind === "invitation" ? dispatchInvitationEmailDelivery : dispatchEmailChangeDelivery;
    await expect(dispatch(database as never, "worker-token-1234567890", { cipher, smtp })).resolves.toEqual({ status: "failed", deliveryId: identity.deliveryId, code: expected });
    expect(finish.$executeRaw.mock.calls[0]!.slice(1)).toContain(expected);
    expect(JSON.stringify(finish.$executeRaw.mock.calls)).not.toContain("private-provider-detail");
  });
});

describe("SMTP single-mailbox boundary", () => {
  it.each(["first@example.test,second@example.test", "first@example.test <second@example.test>", "Group:first@example.test;", "first@example.test\r\nBcc:second@example.test", "first@example.test\n", "first@example.test\t", "not-a-mailbox"])("rejects %j before sendMail", async (recipient) => {
    const sendMail = vi.fn().mockResolvedValue({ response: "250 accepted", messageId: payload.messageId, accepted: [recipient], rejected: [] });
    const adapter = createSmtpEmailDeliveryAdapter(environment, { createTransport: vi.fn(() => ({ sendMail })) as never });
    await expect(adapter.send({ ...payload, recipient })).rejects.toThrow("recipient_rejected");
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("builds an explicit one-mailbox envelope with the actual Nodemailer composer", async () => {
    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
    const envelopes: unknown[] = [];
    const sendMail = vi.fn(async (mail) => {
      const composed = await transport.sendMail(mail);
      envelopes.push(composed.envelope);
      return { response: "250 accepted", messageId: composed.messageId, accepted: composed.envelope.to, rejected: [] };
    });
    const adapter = createSmtpEmailDeliveryAdapter(environment, { createTransport: vi.fn(() => ({ sendMail })) as never });
    await expect(adapter.send(payload)).resolves.toEqual({ responseCode: 250, messageId: payload.messageId, accepted: [payload.recipient] });
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: { name: "", address: payload.recipient }, envelope: { from: environment.EMAIL_FROM, to: [payload.recipient] } }));
    expect(envelopes).toEqual([{ from: "noreply@example.invalid", to: [payload.recipient] }]);
  });
});
