import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createEmailDeliveryCipher, dispatchEmailChangeDelivery, emailDeliveryMessageId } from "@/server/services/email-change-delivery";
import { createSmtpEmailDeliveryAdapter } from "@/server/services/smtp-email-delivery";

describe("email-change encrypted delivery payloads", () => {
  it("uses canonical lowercase RFC 4648 base32 digest bits in the stable Message-ID", () => {
    const encode = (bytes: Buffer) => {
      const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
      let bits = 0;
      let value = 0;
      let output = "";
      for (const byte of bytes) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5 && output.length < 26) {
          output += alphabet[(value >>> (bits - 5)) & 31]!;
          bits -= 5;
        }
      }
      return output;
    };
    const id = "delivery-1";
    const expected = `<ecv1.${encode(createHash("sha256").update(id, "utf8").digest())}@mail.cubby.local>`;
    expect(emailDeliveryMessageId(id)).toBe(expected);
  });

  it("encrypts with AES-256-GCM under exact delivery-bound AAD and decrypts only with the matching key", () => {
    const cipher = createEmailDeliveryCipher({ CUBBY_EMAIL_DELIVERY_KEYRING: "1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", CUBBY_EMAIL_DELIVERY_ACTIVE_KEY_VERSION: "1" });
    const binding = { deliveryId: "delivery-1", userId: "user-1", operationId: "gso_00000000000000000000000000", kind: "new_verification", recipientDigest: Buffer.alloc(32, 4) };
    const encrypted = cipher.encrypt(binding, { recipient: "new@example.invalid", subject: "Verify", text: "secret-token" });
    expect(encrypted).toMatchObject({ keyVersion: 1, ciphertext: expect.any(Buffer), iv: expect.any(Buffer), authTag: expect.any(Buffer), aadDigest: expect.any(Buffer) });
    expect(encrypted.iv).toHaveLength(12);
    expect(encrypted.authTag).toHaveLength(16);
    expect(JSON.stringify(encrypted)).not.toContain("secret-token");
    expect(cipher.decrypt(binding, encrypted)).toEqual({ recipient: "new@example.invalid", subject: "Verify", text: "secret-token" });
    expect(() => cipher.decrypt({ ...binding, operationId: "gso_11111111111111111111111111" }, encrypted)).toThrow("email_delivery_cipher_invalid");
  });

  it("fails closed for malformed or missing keyring state", () => {
    expect(() => createEmailDeliveryCipher({})).toThrow("email_delivery_keyring_invalid");
    expect(() => createEmailDeliveryCipher({ CUBBY_EMAIL_DELIVERY_KEYRING: "1:bad", CUBBY_EMAIL_DELIVERY_ACTIVE_KEY_VERSION: "1" })).toThrow("email_delivery_keyring_invalid");
  });

  it("records an exact SMTP acceptance receipt and atomically clears encrypted payload fields", async () => {
    const row = { id: "delivery-1", userId: "user-1", operationId: "gso_00000000000000000000000000", kind: "newVerification", recipientDigest: Buffer.alloc(32, 4), state: "queued", ciphertext: Buffer.from("cipher"), iv: Buffer.alloc(12), authTag: Buffer.alloc(16), aadDigest: Buffer.alloc(32), keyVersion: 1, attemptCount: 0 };
    const claimTx = { $queryRaw: vi.fn().mockResolvedValue([{ ...row, state: "dispatching", attemptCount: 1 }]) };
    const finishTx = { $executeRaw: vi.fn().mockResolvedValue(1) };
    const transactions = [claimTx, finishTx];
    const database = { $transaction: vi.fn(async (callback) => callback(transactions.shift())) };
    const cipher = { decrypt: vi.fn().mockReturnValue({ recipient: "new@example.invalid", subject: "Verify", text: "body" }) };
    const smtp = { send: vi.fn(async (payload: { messageId: string }) => ({ responseCode: 250, messageId: payload.messageId, accepted: ["new@example.invalid"] })) };
    await expect(dispatchEmailChangeDelivery(database as never, "worker-token-1234567890", { cipher: cipher as never, smtp })).resolves.toEqual({ status: "accepted", deliveryId: "delivery-1" });
    expect(finishTx.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it("uses configured SMTP and returns only accepted receipt metadata", async () => {
    const sendMail = vi.fn().mockResolvedValue({ response: "250 2.0.0 accepted", messageId: "<delivery-1@cubby.local>", accepted: ["new@example.invalid"], rejected: [] });
    const createTransport = vi.fn(() => ({ sendMail })) as never;
    const adapter = createSmtpEmailDeliveryAdapter({ SMTP_HOST: "smtp.example.invalid", SMTP_PORT: "587", SMTP_USER: "user", SMTP_PASSWORD: "password", EMAIL_FROM: "Cubby <noreply@example.invalid>", SMTP_CA_CERT: "synthetic-ca" }, { createTransport });
    await expect(adapter.send({ recipient: "new@example.invalid", subject: "Verify", text: "body", messageId: "<delivery-1@cubby.local>" })).resolves.toEqual({ responseCode: 250, messageId: "<delivery-1@cubby.local>", accepted: ["new@example.invalid"] });
    expect(sendMail).toHaveBeenCalledWith({ from: "Cubby <noreply@example.invalid>", to: "new@example.invalid", subject: "Verify", text: "body", messageId: "<delivery-1@cubby.local>" });
    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({ requireTLS: true, tls: { rejectUnauthorized: true, ca: "synthetic-ca" } }));
  });

  it("applies connection timeouts only when a caller asks for them", () => {
    const createTransport = vi.fn(() => ({ sendMail: vi.fn() })) as never;
    const environment = { SMTP_HOST: "smtp.example.invalid", SMTP_PORT: "587", SMTP_USER: "user", SMTP_PASSWORD: "password", EMAIL_FROM: "Cubby <noreply@example.invalid>" };

    createSmtpEmailDeliveryAdapter(environment, { createTransport });
    createSmtpEmailDeliveryAdapter(environment, { createTransport }, { connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 20_000 });

    const calls = (createTransport as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls;
    expect(calls[0]![0]).not.toHaveProperty("connectionTimeout");
    expect(calls[1]![0]).toMatchObject({ connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 20_000 });
  });

  it("classifies an exact-recipient SMTP rejection as permanent rather than a connection retry", async () => {
    const sendMail = vi.fn().mockResolvedValue({ response: "550 5.1.1 rejected", messageId: "<delivery-1@cubby.local>", accepted: [], rejected: ["new@example.invalid"] });
    const adapter = createSmtpEmailDeliveryAdapter({ SMTP_HOST: "smtp.example.invalid", SMTP_PORT: "465", SMTP_USER: "user", SMTP_PASSWORD: "password", EMAIL_FROM: "Cubby <noreply@example.invalid>" }, { createTransport: vi.fn(() => ({ sendMail })) as never });
    await expect(adapter.send({ recipient: "new@example.invalid", subject: "Verify", text: "body", messageId: "<delivery-1@cubby.local>" })).rejects.toThrow("recipient_rejected");

    const row = { id: "delivery-1", userId: "user-1", operationId: "gso_00000000000000000000000000", kind: "newVerification", recipientDigest: Buffer.alloc(32, 4), ciphertext: Buffer.from("cipher"), iv: Buffer.alloc(12), authTag: Buffer.alloc(16), aadDigest: Buffer.alloc(32), keyVersion: 1 };
    const claimTx = { $queryRaw: vi.fn().mockResolvedValue([row]) };
    const failTx = { $executeRaw: vi.fn().mockResolvedValue(1) };
    const transactions = [claimTx, failTx];
    const database = { $transaction: vi.fn(async (callback) => callback(transactions.shift())) };
    const cipher = { decrypt: vi.fn().mockReturnValue({ recipient: "new@example.invalid", subject: "Verify", text: "body" }) };
    await expect(dispatchEmailChangeDelivery(database as never, "worker-token-1234567890", { cipher: cipher as never, smtp: { send: vi.fn().mockRejectedValue(new Error("recipient_rejected")) } })).resolves.toEqual({ status: "failed", deliveryId: "delivery-1", code: "recipient_rejected" });
  });
});
