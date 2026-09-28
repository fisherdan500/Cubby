import { createHash, createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  buildAssistedPasswordIntentCommitment,
  canAdminAssistHouseholdRole,
  createAssistedCredentialAttestationSigner,
  parseMemberAccountCreateSubmission,
  parseMemberPasswordResetSubmission,
  projectAssistedProcedureResult
} from "@/server/services/admin-assisted-accounts";
import { runAssistedSerializableTransaction } from "@/server/services/assisted-transaction-retry";

const operationId = "bmo_0123456789abcdefghjkmnpqrs";
const openingFingerprint = "a".repeat(64);
const intentFingerprint = "b".repeat(64);

function framed(value: Buffer | string) {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function i64(value: bigint) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigInt64BE(value);
  return bytes;
}

function i32(value: number) {
  const bytes = Buffer.alloc(4);
  bytes.writeInt32BE(value);
  return bytes;
}

describe("admin-assisted account request boundary", () => {
  it("normalizes the canonical mailbox and applies the approved create defaults", () => {
    expect(parseMemberAccountCreateSubmission({
      operationId,
      openingFingerprint,
      name: "  Casey Parent  ",
      email: "  Casey+Home@Example.TEST  ",
      password: "temporary-pass",
      passwordConfirmation: "temporary-pass"
    })).toMatchObject({
      operationId,
      openingFingerprint,
      name: "Casey Parent",
      email: "casey+home@example.test",
      role: "parent",
      requireFirstLoginPasswordChange: false
    });
  });

  it.each([
    { password: "short", passwordConfirmation: "short" },
    { password: "temporary-pass", passwordConfirmation: "different-pass" },
    { password: "temporary-pass", passwordConfirmation: "temporary-pass", email: "one@example.test,two@example.test" },
    { password: "temporary-pass", passwordConfirmation: "temporary-pass", browserMode: "unsafe" },
    { password: "temporary-pass", passwordConfirmation: "temporary-pass", secret: "must-not-be-metadata" }
  ])("rejects malformed or private create fields %#", (override) => {
    expect(() => parseMemberAccountCreateSubmission({
      operationId,
      openingFingerprint,
      name: "Casey",
      email: "casey@example.test",
      ...override
    })).toThrow("admin_assisted_request_invalid");
  });

  it("requires exact reset opening identity and strict boolean defaults", () => {
    expect(parseMemberPasswordResetSubmission({
      operationId,
      openingFingerprint,
      targetUserId: "user-target",
      credentialVersion: 4,
      sessionSecurityVersion: 7,
      password: "replacement-pass",
      passwordConfirmation: "replacement-pass"
    })).toEqual({
      operationId,
      openingFingerprint,
      targetUserId: "user-target",
      credentialVersion: 4,
      sessionSecurityVersion: 7,
      password: "replacement-pass",
      requireFirstLoginPasswordChange: false
    });
  });

  it.each([
    ["owner", "admin", true], ["owner", "parent", true], ["owner", "caretaker", true], ["owner", "read_only", true],
    ["admin", "admin", false], ["admin", "parent", true], ["admin", "caretaker", true], ["admin", "read_only", true],
    ["parent", "parent", false], ["caretaker", "parent", false], ["read_only", "parent", false]
  ] as const)("enforces %s -> %s as %s", (actor, target, permitted) => {
    expect(canAdminAssistHouseholdRole(actor, target)).toBe(permitted);
  });
});

describe("stable password intent", () => {
  const key = Buffer.alloc(32, 0x31);
  const encodedKey = key.toString("base64url");
  const base = {
    operationId,
    householdId: "household-1",
    actorUserId: "actor-user",
    actorSessionId: "actor-session",
    actorMemberId: "actor-member",
    operationKey: "member.account.create" as const,
    normalizedEmail: "casey@example.test",
    exactDisplayName: "Casey",
    role: "parent" as const,
    requireFirstLoginPasswordChange: false,
    password: "pa\u212Bssword"
  };

  it("matches an independently assembled SQL-style length frame", () => {
    const frame = Buffer.concat([
      Buffer.from("cubby.admin-assisted-browser-intent.v1", "utf8"),
      ...[
        operationId, "household-1", "actor-user", "actor-session", "actor-member", "member.account.create",
        "casey@example.test", "Casey", "parent"
      ].map(framed),
      framed(Buffer.from([0])),
      framed(Buffer.from(base.password.normalize("NFKC"), "utf8"))
    ]);
    expect(buildAssistedPasswordIntentCommitment(encodedKey, base)).toBe(createHmac("sha256", key).update(frame).digest("hex"));
  });

  it("is stable for identical drafts and conflicts on every approved intent field", () => {
    const first = buildAssistedPasswordIntentCommitment(encodedKey, base);
    expect(buildAssistedPasswordIntentCommitment(encodedKey, { ...base })).toBe(first);
    for (const changed of [
      { password: "different-password" }, { exactDisplayName: "Casey Changed" }, { normalizedEmail: "other@example.test" },
      { role: "caretaker" as const }, { requireFirstLoginPasswordChange: true }
    ]) expect(buildAssistedPasswordIntentCommitment(encodedKey, { ...base, ...changed })).not.toBe(first);
  });
});

describe("reset stable intent", () => {
  it("frames reset target identities in the approved order and canonicalizes NFKC", () => {
    const key = Buffer.alloc(32, 0x31);
    const input = { operationId, householdId: "h", actorUserId: "u", actorSessionId: "s", actorMemberId: "m",
      operationKey: "member.password.reset" as const, targetMemberId: "target-m", targetUserId: "target-u",
      requireFirstLoginPasswordChange: true, password: "pa\u212Bssword" };
    const frame = Buffer.concat([Buffer.from("cubby.admin-assisted-browser-intent.v1"),
      ...[operationId, "h", "u", "s", "m", "member.password.reset", "target-m", "target-u"].map(framed),
      framed(Buffer.from([1])), framed(input.password.normalize("NFKC"))]);
    const first = buildAssistedPasswordIntentCommitment(key.toString("base64url"), input);
    expect(first).toBe(createHmac("sha256", key).update(frame).digest("hex"));
    expect(buildAssistedPasswordIntentCommitment(key.toString("base64url"), { ...input, password: input.password.normalize("NFKC") })).toBe(first);
    for (const field of ["householdId", "actorUserId", "actorSessionId", "actorMemberId", "targetMemberId", "targetUserId"] as const) {
      expect(buildAssistedPasswordIntentCommitment(key.toString("base64url"), { ...input, [field]: "changed" })).not.toBe(first);
    }
  });
  it("fails closed on missing keys, extra secrets, invalid purpose and noncanonical fields", () => {
    const input = { operationId, householdId: "h", actorUserId: "u", actorSessionId: "s", actorMemberId: "m",
      operationKey: "member.password.reset", targetMemberId: "target-m", targetUserId: "target-u",
      requireFirstLoginPasswordChange: false, password: "temporary-pass" };
    const key = Buffer.alloc(32).toString("base64url");
    expect(() => buildAssistedPasswordIntentCommitment("", input)).toThrow("assisted_intent_key_invalid");
    for (const patch of [{ passwordConfirmation: "temporary-pass" }, { operationKey: "other" }, { targetMemberId: " m " }, { requireFirstLoginPasswordChange: "true" }]) {
      expect(() => buildAssistedPasswordIntentCommitment(key, { ...input, ...patch })).toThrow("assisted_intent_invalid");
    }
  });
});

describe("assisted credential attestation", () => {
  it("matches PostgreSQL framing including timestamp microseconds and nullable versions", () => {
    const key = Buffer.alloc(32, 0x42);
    const nonce = Buffer.alloc(32, 0x24);
    const issuedAt = new Date("2026-09-27T12:34:56.789Z");
    const passwordHash = "0123456789abcdef:" + "a".repeat(64);
    const signer = createAssistedCredentialAttestationSigner({
      CUBBY_FRESH_AUTH_ATTESTATION_KEYRING: `7:${key.toString("base64url")}`,
      CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION: "7"
    }, { now: () => issuedAt, randomBytes: () => nonce });
    const result = signer.sign({
      purpose: "member_account_create",
      actorUserId: "actor-user",
      actorSessionId: "actor-session",
      actorMemberId: "actor-member",
      householdId: "household-1",
      operationId,
      openingFingerprint,
      intentFingerprint,
      replacementPasswordHash: passwordHash,
      newValues: { normalizedEmail: "casey@example.test", exactDisplayName: "Casey", role: "parent", requireFirstLoginPasswordChange: true },
      oldCredentialVersion: null,
      oldSessionSecurityVersion: null
    });
    const passwordDigest = createHash("sha256").update(passwordHash, "utf8").digest();
    const newValuesFrame = Buffer.concat([framed("casey@example.test"), framed("Casey"), framed("parent"), Buffer.from([1])]);
    const postgresEpochMicros = BigInt(issuedAt.getTime() - Date.UTC(2000, 0, 1)) * 1000n;
    const frame = Buffer.concat([
      Buffer.from("cubby.admin-assisted-credential-mutation.v1", "utf8"),
      ...["member_account_create", "actor-user", "actor-session", "actor-member", "household-1", operationId, openingFingerprint, intentFingerprint].map(framed),
      framed(passwordDigest), framed(createHash("sha256").update(newValuesFrame).digest()), i64(-1n), i64(-1n), i64(postgresEpochMicros), framed(nonce), i32(7)
    ]);
    expect(result).toEqual({
      keyVersion: 7,
      nonce,
      issuedAt,
      replacementPasswordHashDigest: passwordDigest,
      mac: createHmac("sha256", key).update(frame).digest()
    });
  });

  it.each(["not-a-key", `${Buffer.alloc(31).toString("base64url")}=`, `${Buffer.alloc(33).toString("base64url")}`])(
    "rejects malformed or noncanonical key material: %s", (encoded) => {
      expect(() => createAssistedCredentialAttestationSigner({
        CUBBY_FRESH_AUTH_ATTESTATION_KEYRING: `1:${encoded}`,
        CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION: "1"
      })).toThrow("assisted_attestation_keyring_invalid");
    }
  );
});

describe("attestation boundary cases", () => {
  const key = Buffer.alloc(32, 0x42);
  const env = { CUBBY_FRESH_AUTH_ATTESTATION_KEYRING: `1:${key.toString("base64url")}`, CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION: "1" };
  const input = { purpose: "member_password_reset", actorUserId: "u", actorSessionId: "s", actorMemberId: "m", householdId: "h", operationId,
    openingFingerprint, intentFingerprint, replacementPasswordHash: "synthetic-hash",
    newValues: { targetUserId: "tu", targetMemberId: "tm", requireFirstLoginPasswordChange: false }, oldCredentialVersion: 4, oldSessionSecurityVersion: 7 };
  it("signs reset values, active key selection and signed pre-epoch microseconds exactly", () => {
    const nonce = Buffer.alloc(32, 3);
    const issuedAt = new Date("1999-12-31T23:59:59.999Z");
    const signer = createAssistedCredentialAttestationSigner({ ...env, CUBBY_FRESH_AUTH_ATTESTATION_KEYRING: `2:${Buffer.alloc(32, 1).toString("base64url")},${env.CUBBY_FRESH_AUTH_ATTESTATION_KEYRING}` }, { now: () => issuedAt, randomBytes: () => nonce });
    const result = signer.sign(input);
    const newValuesDigest = createHash("sha256").update(Buffer.concat([framed("tu"), framed("tm"), Buffer.from([0])])).digest();
    const frame = Buffer.concat([Buffer.from("cubby.admin-assisted-credential-mutation.v1"),
      ...["member_password_reset", "u", "s", "m", "h", operationId, openingFingerprint, intentFingerprint].map(framed),
      framed(createHash("sha256").update(input.replacementPasswordHash).digest()), framed(newValuesDigest), i64(4n), i64(7n), i64(-1000n), framed(nonce), i32(1)]);
    expect(result).toMatchObject({ keyVersion: 1, issuedAt, nonce, mac: createHmac("sha256", key).update(frame).digest() });
  });
  it("rejects absent, duplicate, overflow, noncanonical or excessive keyring entries", () => {
    const encoded = key.toString("base64url");
    for (const environment of [ {}, { ...env, CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION: "2" },
      ...["0", "-1", "2147483648", "01", "1e0", " 1"].map((version) => ({ CUBBY_FRESH_AUTH_ATTESTATION_KEYRING: `${version}:${encoded}`, CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION: version })),
      ...[`1:${encoded},1:${encoded}`, `1:${encoded},2:${encoded},3:${encoded}`, `1:${encoded}:`].map((ring) => ({ ...env, CUBBY_FRESH_AUTH_ATTESTATION_KEYRING: ring })) ]) {
      expect(() => createAssistedCredentialAttestationSigner(environment)).toThrow("assisted_attestation_keyring_invalid");
    }
  });
  it("accepts a valid 32-byte key whose encoding is not the canonical re-encoding", () => {
    // A real deployed keyring is shared with fresh-auth and invitation attestation, which validate
    // charset and length only. The last base64url character of a 32-byte value carries 2 unused
    // bits, so a generator may emit an encoding that Buffer.toString("base64url") would not
    // reproduce. Rejecting it here broke assisted account creation on an install where every other
    // feature using the same variable worked.
    const noncanonical = `${key.toString("base64url").slice(0, -1)}J`;
    expect(noncanonical).not.toBe(key.toString("base64url"));
    expect(Buffer.from(noncanonical, "base64url")).toHaveLength(32);
    expect(() => createAssistedCredentialAttestationSigner({
      CUBBY_FRESH_AUTH_ATTESTATION_KEYRING: `1:${noncanonical}`,
      CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION: "1"
    })).not.toThrow();
  });

  it("rejects invalid dates, null dates and wrong nonce sizes before signing", () => {
    for (const now of [() => new Date(NaN), () => null as unknown as Date]) {
      expect(() => createAssistedCredentialAttestationSigner(env, { now }).sign(input)).toThrow("assisted_attestation_input_invalid");
    }
    expect(() => createAssistedCredentialAttestationSigner(env, { randomBytes: () => Buffer.alloc(31) }).sign(input)).toThrow("assisted_attestation_input_invalid");
  });
  it("rejects purpose/value/version mismatch and extra fields without echoing the input", () => {
    const signer = createAssistedCredentialAttestationSigner(env);
    for (const patch of [{ purpose: "other" }, { oldCredentialVersion: null }, { oldSessionSecurityVersion: 0 },
      { newValues: { ...input.newValues, password: "private" } }, { private: "private" }]) {
      expect(() => signer.sign({ ...input, ...patch })).toThrow("assisted_attestation_input_invalid");
    }
  });
});

describe("database result projection", () => {
  it("adapts the SQL result and persisted member-only snapshot to the same frozen terminal shape", () => {
    expect(projectAssistedProcedureResult("member.account.create", operationId, {
      operationId, status: "completed", outcomeCode: "created", memberId: "member-new"
    })).toEqual({ status: "completed", operationId, outcome: { kind: "member_account", code: "created", memberId: "member-new" } });
    expect(projectAssistedProcedureResult("member.password.reset", operationId, {
      operationId, status: "completed", outcomeCode: "reset", outcomeKind: "member_password", targetMemberId: "member-old", compacted: false
    })).toEqual({ status: "completed", operationId, outcome: { kind: "member_password", code: "reset", memberId: "member-old" } });
  });

  it("projects compacted proof as expired and rejects malformed/private fields", () => {
    expect(projectAssistedProcedureResult("member.password.reset", operationId, {
      operationId, status: "completed", outcomeCode: "reset", outcomeKind: "member_password", targetMemberId: "member-old", compacted: true
    })).toEqual({ status: "expired", operationId, code: "operation_result_expired" });
    expect(() => projectAssistedProcedureResult("member.password.reset", operationId, {
      operationId, status: "completed", outcomeCode: "reset", targetMemberId: "member-old", passwordHashDigest: "leak"
    })).toThrow("assisted_operation_result_invalid");
  });
  it("accepts the exact SQL status table and projects only bounded terminal codes", () => {
    const terminalAt = new Date("2026-09-27T00:00:00Z");
    expect(projectAssistedProcedureResult("member.account.create", operationId, {
      operationId, status: "completed", outcomeCode: "created", outcomeKind: "member_account", targetMemberId: "m", terminalAt, compacted: false
    })).toEqual({ status: "completed", operationId, outcome: { kind: "member_account", code: "created", memberId: "m" } });
    for (const [key, outcomeCode] of [["member.account.create", "existing_account_invitation_required"], ["member.password.reset", "personal_recovery_unavailable"]] as const) {
      expect(projectAssistedProcedureResult(key, operationId, { operationId, status: "rejected", outcomeCode }))
        .toEqual({ status: "rejected", operationId, code: outcomeCode });
    }
    for (const outcomeCode of ["stale_context", "stale_target", "stale_revision"]) {
      expect(projectAssistedProcedureResult("member.password.reset", operationId, { operationId, status: "stale", outcomeCode }))
        .toEqual({ status: "stale", operationId, code: outcomeCode });
    }
    expect(projectAssistedProcedureResult("member.password.reset", operationId, {
      operationId, status: "pending", outcomeCode: null, outcomeKind: null, targetMemberId: "m", terminalAt: null, compacted: false
    })).toEqual({ status: "pending", operationId, code: "operation_unknown" });
  });
  it("rejects missing, ambiguous, cross-kind, nonterminal-compacted and private results", () => {
    const row = { operationId, status: "completed", outcomeCode: "reset", outcomeKind: "member_password", targetMemberId: "m", compacted: false };
    for (const candidate of [null, undefined, [], {}, { ...row, operationId: "different" }, { ...row, outcomeCode: "created" },
      { ...row, outcomeKind: "member_account" }, { ...row, targetMemberId: null }, { ...row, memberId: "m" },
      { ...row, terminalAt: null }, { ...row, terminalAt: new Date(NaN) }, { ...row, terminalAt: "2026-09-27" },
      { ...row, effects: { password: "private" } }, { ...row, compacted: "true" },
      { ...row, status: "pending", outcomeCode: null, outcomeKind: null, compacted: true },
      { operationId, status: "expired", outcomeCode: "operation_result_expired" },
      { operationId, status: "rejected", outcomeCode: "existing_account_invitation_required" },
      { operationId, status: "stale", outcomeCode: "unbounded" }]) {
      expect(() => projectAssistedProcedureResult("member.password.reset", operationId, candidate)).toThrow("assisted_operation_result_invalid");
    }
  });
});

describe("whole-transaction retry", () => {
  it.each(["55P03", "40001", "40P01", "P2034"])("retries %s at most three whole transactions", async (code) => {
    const action = vi.fn()
      .mockRejectedValueOnce({ code })
      .mockRejectedValueOnce({ code: "P2010", meta: { code } })
      .mockResolvedValue("ok");
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(runAssistedSerializableTransaction(action, sleep)).resolves.toBe("ok");
    expect(action).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[25], [75]]);
  });

  it("propagates the third failure unchanged after exactly two pauses", async () => {
    const failure = { code: "P2034", meta: { code: "40001" } };
    const action = vi.fn().mockRejectedValue(failure);
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(runAssistedSerializableTransaction(action, sleep)).rejects.toBe(failure);
    expect(action).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[25], [75]]);
  });
  it("does not trust unrelated meta codes, inherited messages or retry after a pause fails", async () => {
    for (const failure of [{ code: "42501", meta: { code: "40001" } }, { meta: { code: "40001" } }, { code: "P2010", meta: { message: "55P03" } }]) {
      const action = vi.fn().mockRejectedValue(failure);
      await expect(runAssistedSerializableTransaction(action, vi.fn())).rejects.toBe(failure);
      expect(action).toHaveBeenCalledTimes(1);
    }
    const pauseFailure = new Error("pause_failed");
    const action = vi.fn().mockRejectedValue({ code: "P2034" });
    await expect(runAssistedSerializableTransaction(action, vi.fn().mockRejectedValue(pauseFailure))).rejects.toBe(pauseFailure);
    expect(action).toHaveBeenCalledTimes(1);
  });
  it("does not retry authorization failures or substring matches", async () => {
    const sleep = vi.fn();
    const denied = vi.fn().mockRejectedValue(new Error("42501 permission denied 55P03"));
    await expect(runAssistedSerializableTransaction(denied, sleep)).rejects.toThrow("42501 permission denied 55P03");
    expect(denied).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
