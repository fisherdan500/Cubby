import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

type Environment = Partial<Pick<NodeJS.ProcessEnv, "CUBBY_EMAIL_DELIVERY_KEYRING" | "CUBBY_EMAIL_DELIVERY_ACTIVE_KEY_VERSION">>;
type Binding = { deliveryId: string; userId: string; operationId: string; kind: string; recipientDigest: Buffer };
type Payload = { recipient: string; subject: string; text: string };
type Encrypted = { keyVersion: number; ciphertext: Buffer; iv: Buffer; authTag: Buffer; aadDigest: Buffer };

function parse(environment: Environment) {
  const active = Number(environment.CUBBY_EMAIL_DELIVERY_ACTIVE_KEY_VERSION);
  const raw = environment.CUBBY_EMAIL_DELIVERY_KEYRING;
  if (!raw || !Number.isSafeInteger(active) || active < 1) throw new Error("email_delivery_keyring_invalid");
  const keys = new Map<number, Buffer>();
  for (const item of raw.split(",")) {
    const [versionText, encoded] = item.split(":");
    const version = Number(versionText);
    const key = Buffer.from(encoded ?? "", "base64url");
    if (!Number.isSafeInteger(version) || version < 1 || keys.has(version) || !encoded || !/^[A-Za-z0-9_-]+$/.test(encoded) || key.length !== 32) throw new Error("email_delivery_keyring_invalid");
    keys.set(version, key);
  }
  if (!keys.has(active)) throw new Error("email_delivery_keyring_invalid");
  return { active, keys };
}

function aad(binding: Binding, keyVersion: number) {
  const frame = (value: string) => { const bytes = Buffer.from(value, "utf8"); const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length); return Buffer.concat([length, bytes]); };
  const version = Buffer.from([1]);
  const key = Buffer.alloc(4); key.writeUInt32BE(keyVersion);
  if (binding.recipientDigest.length !== 32) throw new Error("email_delivery_cipher_invalid");
  return Buffer.concat([version, frame(binding.deliveryId), frame(binding.userId), frame(binding.operationId), frame(binding.kind), binding.recipientDigest, key]);
}

export function emailDeliveryMessageId(deliveryId: string) {
  // RFC 4648 base32 consumes the high-order digest bits. Do not substitute a
  // Crockford alphabet or mask individual bytes: the value is a wire receipt.
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const digest = createHash("sha256").update(deliveryId, "utf8").digest();
  let bits = 0;
  let value = 0;
  let encoded = "";
  for (const byte of digest) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && encoded.length < 26) {
      encoded += alphabet[(value >>> (bits - 5)) & 31]!;
      bits -= 5;
    }
  }
  return `<ecv1.${encoded}@mail.cubby.local>`;
}

export function createEmailDeliveryCipher(environment: Environment = { CUBBY_EMAIL_DELIVERY_KEYRING: process.env.CUBBY_EMAIL_DELIVERY_KEYRING, CUBBY_EMAIL_DELIVERY_ACTIVE_KEY_VERSION: process.env.CUBBY_EMAIL_DELIVERY_ACTIVE_KEY_VERSION }) {
  const { active, keys } = parse(environment);
  return {
    encrypt(binding: Binding, payload: Payload): Encrypted {
      const iv = randomBytes(12);
      const associated = aad(binding, active);
      const cipher = createCipheriv("aes-256-gcm", keys.get(active)!, iv);
      cipher.setAAD(associated);
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
      return { keyVersion: active, ciphertext, iv, authTag: cipher.getAuthTag(), aadDigest: createHash("sha256").update(associated).digest() };
    },
    decrypt(binding: Binding, encrypted: Encrypted): Payload {
      try {
        const key = keys.get(encrypted.keyVersion);
        if (!key) throw new Error();
        const associated = aad(binding, encrypted.keyVersion);
        if (!createHash("sha256").update(associated).digest().equals(encrypted.aadDigest)) throw new Error();
        const decipher = createDecipheriv("aes-256-gcm", key, encrypted.iv);
        decipher.setAAD(associated);
        decipher.setAuthTag(encrypted.authTag);
        return JSON.parse(Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]).toString("utf8")) as Payload;
      } catch {
        throw new Error("email_delivery_cipher_invalid");
      }
    }
  };
}

export async function dispatchEmailChangeDelivery(database: Pick<PrismaClient, "$transaction">, workerToken: string, deps: { cipher: ReturnType<typeof createEmailDeliveryCipher>; smtp: { send: (payload: Payload & { messageId: string }) => Promise<{ responseCode: number; messageId: string; accepted: string[] }> } }) {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(workerToken)) throw new Error("email_delivery_worker_invalid");
  const claimed = await database.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<any[]>`SELECT * FROM "claim_email_change_delivery"(${workerToken})`;
    return rows[0] ?? null;
  }, { isolationLevel: "Serializable" });
  if (!claimed) return { status: "idle" as const };
  const binding = { deliveryId: claimed.id, userId: claimed.userId, operationId: claimed.operationId, kind: claimed.kind, recipientDigest: Buffer.from(claimed.recipientDigest) };
  const fail = async (code: "payload_decrypt" | "receipt_invalid" | "recipient_rejected" | "smtp_connection" | "smtp_rate_limited" | "smtp_temporary" | "smtp_timeout" | "smtp_auth" | "smtp_rejected") => {
    await database.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT "fail_email_change_delivery"(${claimed.id},${workerToken},${code})`;
    }, { isolationLevel: "Serializable" });
    return { status: "failed" as const, deliveryId: claimed.id, code };
  };
  let payload: Payload;
  try {
    payload = deps.cipher.decrypt(binding, { keyVersion: claimed.keyVersion!, ciphertext: Buffer.from(claimed.ciphertext!), iv: Buffer.from(claimed.iv!), authTag: Buffer.from(claimed.authTag!), aadDigest: Buffer.from(claimed.aadDigest!) });
  } catch {
    return fail("payload_decrypt");
  }
  const messageId = emailDeliveryMessageId(claimed.id);
  let receipt: { responseCode: number; messageId: string; accepted: string[] };
  try {
    receipt = await deps.smtp.send({ ...payload, messageId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const closedCode = ["recipient_rejected", "smtp_auth", "smtp_timeout", "smtp_rate_limited", "smtp_temporary", "smtp_rejected"].includes(message)
      ? message as "recipient_rejected" | "smtp_auth" | "smtp_timeout" | "smtp_rate_limited" | "smtp_temporary" | "smtp_rejected"
      : "smtp_connection";
    return fail(closedCode);
  }
  // SMTP acceptance is a delivery readiness fact, not an address-normalization
  // exercise.  The transport must acknowledge the one exact envelope target.
  if (receipt.responseCode !== 250 || receipt.messageId !== messageId || receipt.accepted.length !== 1 || receipt.accepted[0] !== payload.recipient) return fail("receipt_invalid");
  await database.$transaction(async (tx) => {
    const messageBytes = Buffer.from(receipt.messageId, "utf8");
    const length = Buffer.alloc(4); length.writeUInt32BE(messageBytes.length);
    const digest = createHash("sha256").update(Buffer.concat([length, messageBytes])).digest();
    await tx.$executeRaw`SELECT "accept_email_change_delivery"(${claimed.id},${workerToken},${250}::integer,${Uint8Array.from(digest)})`;
  }, { isolationLevel: "Serializable" });
  return { status: "accepted" as const, deliveryId: claimed.id };
}
