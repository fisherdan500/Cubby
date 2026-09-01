"use client";

export type GlobalSecurityOperationMetadata = { operationId: string; openingFingerprint: string; intentFingerprint: string };

const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";

function randomHex(byteLength: number) {
  return Array.from(crypto.getRandomValues(new Uint8Array(byteLength)), (value) => value.toString(16).padStart(2, "0")).join("");
}

export function createGlobalSecurityOperationMetadata(): GlobalSecurityOperationMetadata {
  const operationId = `gso_${Array.from(crypto.getRandomValues(new Uint8Array(26)), (value) => alphabet[value & 31]).join("")}`;
  return { operationId, openingFingerprint: randomHex(32), intentFingerprint: randomHex(32) };
}
