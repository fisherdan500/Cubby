import { describe, expect, it } from "vitest";
import { createGlobalSecurityOperationMetadata } from "@/lib/global-security-operation-metadata";

describe("global security browser-operation metadata", () => {
  it("mints opaque random metadata that cannot verify password, recovery-code, or email guesses offline", () => {
    const first = createGlobalSecurityOperationMetadata();
    const identicalGuess = createGlobalSecurityOperationMetadata();
    const differentGuess = createGlobalSecurityOperationMetadata();

    for (const metadata of [first, identicalGuess, differentGuess]) {
      expect(metadata.operationId).toMatch(/^gso_[0-9abcdefghjkmnpqrstvwxyz]{26}$/);
      expect(metadata.openingFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(metadata.intentFingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(identicalGuess).not.toEqual(first);
    expect(differentGuess).not.toEqual(first);
    expect(JSON.stringify([first, identicalGuess, differentGuess])).not.toMatch(/password|recovery|code|email|example/i);
  });
});
