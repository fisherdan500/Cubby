import { randomBytes, scrypt, timingSafeEqual } from "crypto";

const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const recoveryCodePattern = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{24}$/;
const recoveryScryptProfile = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

export type RecoveryCodeRecord = {
  salt: Buffer<ArrayBufferLike>;
  derivedKey: Buffer<ArrayBufferLike>;
  kdfVersion: 1;
};

function encodeCrockfordBase32(bytes: Buffer) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += alphabet[(value >> bits) & 31];
    }
  }
  if (bits !== 0) throw new Error("recovery_code_entropy_not_base32_aligned");
  return output;
}

export function generateRecoveryCodes(random = () => randomBytes(15)) {
  const codes = new Set<string>();
  while (codes.size < 10) {
    const encoded = encodeCrockfordBase32(random());
    codes.add(encoded.match(/.{1,4}/g)?.join("-") ?? "");
  }
  return [...codes];
}

export function normalizeRecoveryCode(input: string) {
  const normalized = input.toUpperCase().replace(/[\s-]/g, "");
  if (!recoveryCodePattern.test(normalized)) throw new Error("recovery_code_invalid_format");
  return normalized;
}

export async function hashRecoveryCode(code: string, salt: Buffer<ArrayBufferLike> = randomBytes(16)): Promise<RecoveryCodeRecord> {
  if (salt.length !== 16) throw new Error("recovery_code_salt_length_invalid");
  const normalized = normalizeRecoveryCode(code);
  const derivedKey = await new Promise<Buffer>((resolve, reject) => {
    scrypt(normalized, salt, 32, recoveryScryptProfile, (error, key) => {
      if (error) reject(error);
      else resolve(Buffer.from(key));
    });
  });
  return { salt, derivedKey, kdfVersion: 1 };
}

export async function verifyRecoveryCode(code: string, record: RecoveryCodeRecord) {
  if (record.salt.length !== 16) throw new Error("recovery_code_salt_length_invalid");
  if (record.derivedKey.length !== 32) throw new Error("recovery_code_derived_key_length_invalid");
  if (record.kdfVersion !== 1) throw new Error("recovery_code_kdf_version_invalid");
  const candidate = await hashRecoveryCode(code, record.salt);
  return timingSafeEqual(candidate.derivedKey as Buffer<ArrayBuffer>, record.derivedKey as Buffer<ArrayBuffer>);
}

const neutralRecoveryRecords = Array.from({ length: 9 }, (_, index): RecoveryCodeRecord => ({
  salt: Buffer.alloc(16, index + 1),
  derivedKey: Buffer.alloc(32, 0),
  kdfVersion: 1
}));

export async function performNeutralRecoveryCodeVerification(
  code: string,
  verify: (value: string, record: RecoveryCodeRecord) => Promise<boolean> = verifyRecoveryCode
) {
  for (const record of neutralRecoveryRecords) {
    await verify(code, record).catch(() => false);
  }
}
