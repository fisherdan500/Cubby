import { describe, expect, it } from "vitest";
import { generateRecoveryCodes, hashRecoveryCode, normalizeRecoveryCode, verifyRecoveryCode } from "@/server/services/recovery-codes";

describe("offline recovery code generation", () => {
  it("creates ten display-once normalized 120-bit Crockford Base32 recovery codes", () => {
    let index = 0;
    const codes = generateRecoveryCodes(() => {
      const bytes = Buffer.alloc(15, 0xab);
      bytes[14] = index++;
      return bytes;
    });
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[0-9A-HJKMNPQRSTVWXYZ]{4}(?:-[0-9A-HJKMNPQRSTVWXYZ]{4}){5}$/);
  });

  it("normalizes, hashes, and verifies recovery codes with the frozen scrypt-v1 profile", async () => {
    const normalized = normalizeRecoveryCode(" abcd-efgh- jkmn-pqrs-tvwx-yz01 ");
    const salt = Buffer.alloc(16, 0x5a);
    const record = await hashRecoveryCode(normalized, salt);

    expect(normalized).toBe("ABCDEFGHJKMNPQRSTVWXYZ01");
    expect(record).toMatchObject({ salt, derivedKey: expect.any(Buffer), kdfVersion: 1 });
    expect(record.derivedKey).toHaveLength(32);
    await expect(verifyRecoveryCode(normalized, record)).resolves.toBe(true);
    await expect(verifyRecoveryCode("ABCDEFGHJKMNPQRSTVWXYZ02", record)).resolves.toBe(false);
  });

  it("rejects a recovery code or KDF record outside the exact frozen representation", async () => {
    expect(() => normalizeRecoveryCode("ABCD-EFGH-JKMN-PQRS-TVWX-YZ0I")).toThrow("recovery_code_invalid_format");
    await expect(hashRecoveryCode("ABCDEFGHJKMNPQRSTVWXYZ01", Buffer.alloc(15))).rejects.toThrow("recovery_code_salt_length_invalid");
    await expect(verifyRecoveryCode("ABCDEFGHJKMNPQRSTVWXYZ01", { salt: Buffer.alloc(16), derivedKey: Buffer.alloc(31), kdfVersion: 1 })).rejects.toThrow("recovery_code_derived_key_length_invalid");
    await expect(verifyRecoveryCode("ABCDEFGHJKMNPQRSTVWXYZ01", { salt: Buffer.alloc(16), derivedKey: Buffer.alloc(32), kdfVersion: 2 as 1 })).rejects.toThrow("recovery_code_kdf_version_invalid");
  });
});
