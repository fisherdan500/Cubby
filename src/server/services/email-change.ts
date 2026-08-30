import { createHash, randomBytes, randomUUID } from "node:crypto";
import { GlobalSecurityOperationKey, type PrismaClient } from "@prisma/client";
import { setSessionCookie } from "better-auth/cookies";
import { assertGlobalSecurityOperationId, issueFreshAuthGrantForCurrentPasswordInTransaction, lockGlobalSecurityContext, preauthorizeFreshAuthThrottle, type FreshAuthThrottleContext, type GlobalSecurityContext } from "@/server/services/global-security";
import { optionalConfiguredGlobalSecurityThrottleKey } from "@/server/services/global-security-throttling";
import { createEmailDeliveryCipher } from "@/server/services/email-change-delivery";
import { hashInviteToken } from "@/server/services/invites";

type Database = Pick<PrismaClient, "$transaction">;
type Cipher = ReturnType<typeof createEmailDeliveryCipher>;

type ProcedureDatabase = Pick<PrismaClient, "$transaction">;

/**
 * These lifecycle transitions intentionally have no Prisma mutation fallback.
 * Their database procedures are the authority for token readiness, immutable
 * receipts, version advances, session revocation, and content-free events.
 */
export async function verifyEmailChangeToken(database: ProcedureDatabase, input: { userId: string; operationId: string; token: string }) {
  if (!input.token || input.token.length > 1024) throw new Error("email_change_token_invalid");
  return database.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ state: "verified" | "rejected" }>>`SELECT result_state AS state FROM "verify_email_change_token"(${input.userId},${input.operationId},${input.token})`;
    const row = rows[0];
    if (!row) throw new Error("email_change_verification_unavailable");
    return { operationId: input.operationId, status: row.state };
  }, { isolationLevel: "Serializable" });
}

export async function completeVerifiedEmailChange(
  database: ProcedureDatabase,
  input: { userId: string; operationId: string; oldSessionId: string; successorSessionId: string; successorToken: string; successorExpiresAt: Date },
  deps: { generateInviteToken?: () => string; cipher?: Cipher } = {}
) {
  if (!input.successorToken || input.successorToken.length > 1024) throw new Error("email_change_successor_token_invalid");
  const tokenDigest = createHash("sha256").update(input.successorToken, "utf8").digest();
  return database.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('global-security-transition:v1',0))`;
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended('email-identity:v1:' || "normalize_security_email_v1"("email"),0))
      FROM "User" WHERE "id"=${input.userId}
    `;
    const candidates = await tx.$queryRaw<Array<{ oldInviteId: string; householdId: string; role: string; invitedByUserId: string; expiresAt: Date; newEmail: string; inviterEmail: string }>>`
      SELECT invite."id" AS "oldInviteId",invite."householdId",invite."role"::text,invite."invitedByUserId",invite."expiresAt",
             change."normalizedNewEmail" AS "newEmail",inviter."email" AS "inviterEmail"
      FROM "EmailChange" change
      JOIN "User" changing_user ON changing_user."id"=change."userId"
      JOIN "Invite" invite ON "normalize_security_email_v1"(invite."email")="normalize_security_email_v1"(changing_user."email")
      JOIN "User" inviter ON inviter."id"=invite."invitedByUserId"
      WHERE change."userId"=${input.userId} AND change."operationId"=${input.operationId}
        AND invite."status"='pending' AND invite."expiresAt">clock_timestamp()
      ORDER BY invite."id" FOR UPDATE OF invite
      /* email_change_cutover_invitation_candidates */
    `;
    const generateInviteToken = deps.generateInviteToken ?? (() => randomBytes(32).toString("base64url"));
    const replacements = candidates.map((candidate) => {
      const token = generateInviteToken();
      return { oldInviteId: candidate.oldInviteId, newInviteId: randomUUID(), token, tokenHash: hashInviteToken(token) };
    });
    const preparedDeliveries: Array<Record<string, unknown>> = [];
    if (replacements.length) {
      const cipher = deps.cipher ?? createEmailDeliveryCipher();
      const newEmail = candidates[0]!.newEmail;
      const addDelivery = (kind: "invitation_reissue" | "inviter_notice", recipient: string, subject: string, text: string) => {
        const id = randomUUID();
        const recipientDigest = createHash("sha256").update(recipient.toLowerCase().trim()).digest();
        const encrypted = cipher.encrypt({ deliveryId: id, userId: input.userId, operationId: input.operationId, kind, recipientDigest }, { recipient, subject, text });
        preparedDeliveries.push({ id, kind, recipientDigestHex: recipientDigest.toString("hex"), ciphertextHex: encrypted.ciphertext.toString("hex"), ivHex: encrypted.iv.toString("hex"), authTagHex: encrypted.authTag.toString("hex"), aadDigestHex: encrypted.aadDigest.toString("hex"), keyVersion: encrypted.keyVersion });
      };
      addDelivery("invitation_reissue", newEmail, "Your Cubby invitations were reissued", `Replacement invitation tokens:\n${replacements.map(({ token }) => token).join("\n")}\nEach invitation still requires explicit acceptance.`);
      const inviters = new Map<string, string>();
      for (const candidate of candidates) inviters.set(candidate.inviterEmail.toLowerCase().trim(), candidate.inviterEmail);
      for (const recipient of inviters.values()) addDelivery("inviter_notice", recipient, "A Cubby invitation was reissued", "A pending Cubby invitation you sent was reissued after an account email change. The new address is not disclosed.");
    }
    const preparedInvitations = replacements.map(({ oldInviteId, newInviteId, tokenHash }) => ({ oldInviteId, newInviteId, tokenHash }));
    const rows = await tx.$queryRaw<Array<{ state: "completed" | "rejected" }>>`SELECT result_state AS state FROM "complete_verified_email_change"(${input.userId},${input.operationId},${input.oldSessionId},${input.successorSessionId},${input.successorToken},${Uint8Array.from(tokenDigest)},${input.successorExpiresAt}::timestamp(3),${JSON.stringify(preparedInvitations)}::jsonb,${JSON.stringify(preparedDeliveries)}::jsonb)`;
    const row = rows[0];
    if (!row) throw new Error("email_change_completion_unavailable");
    return { operationId: input.operationId, status: row.state };
  }, { isolationLevel: "Serializable" });
}

export async function confirmEmailChangeRotationCookie(database: ProcedureDatabase, input: { userId: string; operationId: string; successorSessionId: string; successorToken: string }) {
  const tokenDigest = createHash("sha256").update(input.successorToken, "utf8").digest();
  return database.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ state: "confirmed" | "failed" }>>`SELECT result_state AS state FROM "confirm_email_change_rotation_cookie"(${input.userId},${input.operationId},${input.successorSessionId},${Uint8Array.from(tokenDigest)})`;
    const row = rows[0];
    if (!row) throw new Error("email_change_cookie_confirmation_unavailable");
    return { operationId: input.operationId, status: row.state };
  }, { isolationLevel: "Serializable" });
}

type SessionCookieContext = Parameters<typeof setSessionCookie>[0];
type SessionCookiePayload = Parameters<typeof setSessionCookie>[1];

export async function emitEmailChangeSuccessorCookie(
  database: ProcedureDatabase,
  input: {
    userId: string;
    operationId: string;
    successorSessionId: string;
    successorToken: string;
    cookieContext: SessionCookieContext;
    session: SessionCookiePayload["session"];
    user: SessionCookiePayload["user"];
  },
  deps: { setCookie?: typeof setSessionCookie } = {}
) {
  try {
    if (input.session.id !== input.successorSessionId || input.session.userId !== input.userId || input.session.token !== input.successorToken || input.user.id !== input.userId) {
      throw new Error("email_change_successor_cookie_binding_invalid");
    }
    await (deps.setCookie ?? setSessionCookie)(input.cookieContext, { session: input.session, user: input.user }, false);
    return { operationId: input.operationId, status: "issued" as const };
  } catch {
    await failEmailChangeRotationCookie(database, { userId: input.userId, operationId: input.operationId });
    return { operationId: input.operationId, status: "signed_out" as const };
  }
}

export async function confirmEmailChangeSuccessorCookieForAuthenticatedSession(
  database: ProcedureDatabase,
  authenticated: GlobalSecurityContext & { sessionToken: string },
  input: { operationId: string }
) {
  return confirmEmailChangeRotationCookie(database, {
    userId: authenticated.userId,
    operationId: input.operationId,
    successorSessionId: authenticated.sessionId,
    successorToken: authenticated.sessionToken
  });
}

export async function cancelVerifiedEmailChange(database: ProcedureDatabase, input: { userId: string; operationId: string; sessionId: string }) {
  return database.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ state: "cancelled" }>>`SELECT result_state AS state FROM "cancel_email_change"(${input.userId},${input.operationId},${input.sessionId})`;
    if (rows.length !== 1) throw new Error("email_change_cancellation_unavailable");
    return { operationId: input.operationId, status: rows[0]!.state };
  }, { isolationLevel: "Serializable" });
}

/** A passive worker-only closure; it intentionally trusts the database clock. */
export async function expireVerifiedEmailChange(database: ProcedureDatabase, input: { userId: string; operationId: string }) {
  return database.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ state: "expired" }>>`SELECT result_state AS state FROM "expire_email_change"(${input.userId},${input.operationId})`;
    if (rows.length !== 1) throw new Error("email_change_expiry_unavailable");
    return { operationId: input.operationId, status: rows[0]!.state };
  }, { isolationLevel: "Serializable" });
}

export async function expireUnconfirmedEmailChangeRotation(database: ProcedureDatabase, input: { userId: string; operationId: string }) {
  return database.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ state: "failed" }>>`SELECT result_state AS state FROM "expire_unconfirmed_email_change_rotation"(${input.userId},${input.operationId})`;
    if (rows.length !== 1) throw new Error("email_change_cookie_expiry_unavailable");
    return { operationId: input.operationId, status: rows[0]!.state };
  }, { isolationLevel: "Serializable" });
}

export async function failEmailChangeRotationCookie(database: ProcedureDatabase, input: { userId: string; operationId: string }) {
  return database.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ state: "failed" }>>`SELECT result_state AS state FROM "fail_email_change_rotation_cookie"(${input.userId},${input.operationId})`;
    if (rows.length !== 1) throw new Error("email_change_cookie_failure_unavailable");
    return { operationId: input.operationId, status: rows[0]!.state };
  }, { isolationLevel: "Serializable" });
}

/** Returns no address, token, or delivery content: only successor-authorized metadata. */
export async function getVerifiedEmailChangeStatus(database: ProcedureDatabase, input: { userId: string; operationId: string; sessionId: string }) {
  return database.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ state: string; old_address_notice_failed: boolean; cookie_state: string }>>`SELECT result_state AS state,old_address_notice_failed,cookie_state FROM "get_email_change_status"(${input.userId},${input.operationId},${input.sessionId})`;
    if (rows.length !== 1) throw new Error("email_change_status_unavailable");
    return { operationId: input.operationId, status: rows[0]!.state, oldAddressNoticeFailed: rows[0]!.old_address_notice_failed, cookieState: rows[0]!.cookie_state };
  }, { isolationLevel: "Serializable" });
}

export async function initiateVerifiedEmailChange(
  database: Database,
  expected: GlobalSecurityContext,
  input: { operationId: string; openingFingerprint: string; intentFingerprint: string; newEmail: string },
  currentPassword: string,
  deps: { verifier?: { verify: (input: { hash: string; password: string }) => Promise<boolean> }; generateToken?: () => string; cipher?: Cipher; throttleContext?: FreshAuthThrottleContext } = {},
  serializationAttempt = 0
) {
  const verifier = deps.verifier ?? { verify: async () => false };
  const operationId = assertGlobalSecurityOperationId(input.operationId);
  // Keep proof evidence outside this larger email/notification transaction.
  // In production this commits a failed proof before the caller receives the
  // rejection; successful proof is then reauthorized below under the identity
  // lock before the email change is created.
  try {
    const configuredThrottleKey = deps.throttleContext?.key ?? optionalConfiguredGlobalSecurityThrottleKey();
    const proof = configuredThrottleKey
      ? await preauthorizeFreshAuthThrottle(
          database,
          expected,
          { operationId, purpose: "email_change", openingFingerprint: input.openingFingerprint, intentFingerprint: input.intentFingerprint },
          currentPassword,
          verifier,
          { key: configuredThrottleKey, client: deps.throttleContext?.client ?? "unknown_client" }
        )
      : undefined;
    if (proof && !proof.valid) throw new Error("current_password_invalid");
    return await database.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('global-security-transition:v1', 0))`;
    const normalizedRows = await tx.$queryRaw<Array<{ normalized: string }>>`SELECT "normalize_security_email_v1"(${input.newEmail}) AS normalized`;
    const normalized = normalizedRows[0]?.normalized;
    if (!normalized) throw new Error("email_change_invalid_target");
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('email-identity:v1:' || ${normalized},0))`;
    const context = await lockGlobalSecurityContext(tx, expected);
    if (context.credentialVersion !== expected.credentialVersion || context.sessionSecurityVersion !== expected.sessionSecurityVersion) throw new Error("stale_security_version");
    const identities = await tx.$queryRaw<Array<{ email: string; normalizedCurrentEmail: string }>>`
      SELECT "email", "normalize_security_email_v1"("email") AS "normalizedCurrentEmail"
      FROM "User" WHERE "id"=${context.userId}
    `;
    if (identities.length !== 1 || identities[0]!.normalizedCurrentEmail === normalized) throw new Error("email_change_invalid_target");

    const binding = await tx.globalSecurityOperationBinding.findFirst({ where: { userId: context.userId, operationId } });
    const operation = binding && await tx.globalSecurityOperation.findFirst({
      where: { bindingId: binding.id, userId: context.userId, operationId },
      select: { operationKey: true, intentFingerprint: true, status: true, outcomeCode: true }
    });
    const existing = await tx.emailChange.findFirst({ where: { userId: context.userId, operationId }, select: { normalizedNewEmail: true, state: true } });
    if (binding || operation || existing) {
      if (
        !binding ||
        !operation ||
        binding.userId !== context.userId ||
        binding.sessionId !== context.sessionId ||
        binding.operationKey !== GlobalSecurityOperationKey.emailChange ||
        binding.securityVersion !== context.credentialVersion ||
        binding.sessionSecurityVersion !== context.sessionSecurityVersion ||
        binding.openingFingerprint !== input.openingFingerprint ||
        binding.state !== "submitted" ||
        operation.operationKey !== GlobalSecurityOperationKey.emailChange ||
        operation.intentFingerprint !== input.intentFingerprint
      ) throw new Error("idempotency_conflict");
      if (existing) {
        if (existing.normalizedNewEmail !== normalized || !["pending", "verified"].includes(existing.state)) throw new Error("idempotency_conflict");
        return { operationId, status: existing.state };
      }
      if (operation.status === "rejected" && operation.outcomeCode === "collision_rejected") {
        return { operationId, status: "rejected" as const };
      }
      if (operation.status !== "pending") throw new Error("idempotency_conflict");
    }

    const collisions = await tx.$queryRaw<Array<{ collision: boolean }>>`SELECT EXISTS(SELECT 1 FROM "User" WHERE "normalize_security_email_v1"("email")=${normalized} AND "id"<>${context.userId}) OR EXISTS(SELECT 1 FROM "EmailChange" WHERE "normalizedNewEmail"=${normalized} AND "state" IN ('pending','verified')) AS "collision"`;
    if (collisions[0]?.collision) {
      await issueFreshAuthGrantForCurrentPasswordInTransaction(tx, context, { operationId, purpose: "email_change", openingFingerprint: input.openingFingerprint, intentFingerprint: input.intentFingerprint }, currentPassword, verifier, undefined, undefined, proof && configuredThrottleKey ? { key: configuredThrottleKey, client: deps.throttleContext?.client ?? "unknown_client", preverified: true } : undefined);
      await tx.$executeRaw`SELECT "reject_email_change_collision"(${context.userId},${operationId})`;
      return { operationId, status: "rejected" as const };
    }
    await tx.$executeRaw`SELECT "supersede_email_changes"(${context.userId},${operationId})`;
    const grant = await issueFreshAuthGrantForCurrentPasswordInTransaction(tx, context, { operationId, purpose: "email_change", openingFingerprint: input.openingFingerprint, intentFingerprint: input.intentFingerprint }, currentPassword, verifier, undefined, undefined, proof && configuredThrottleKey ? { key: configuredThrottleKey, client: deps.throttleContext?.client ?? "unknown_client", preverified: true } : undefined);
    const times = await tx.$queryRaw<Array<{ createdAt: Date; expiresAt: Date }>>`SELECT anchor."createdAt",anchor."createdAt"+INTERVAL '60 minutes' AS "expiresAt" FROM (SELECT clock_timestamp() AS "createdAt") anchor`;
    const emailChangeId = randomUUID();
    const token = deps.generateToken?.() ?? randomBytes(32).toString("base64url");
    const cipher = deps.cipher ?? createEmailDeliveryCipher();
    await tx.emailChange.create({ data: { id: emailChangeId, userId: context.userId, operationId, freshAuthGrantId: grant.grantId, securityVersion: context.credentialVersion, sessionSecurityVersion: context.sessionSecurityVersion, normalizedNewEmail: normalized, verificationDigest: createHash("sha256").update(token).digest("hex"), state: "pending", createdAt: times[0]!.createdAt, updatedAt: times[0]!.createdAt, expiresAt: times[0]!.expiresAt } });
    const deliveries = [
      { kind: "newVerification" as const, recipient: normalized, normalizedRecipient: normalized, subject: "Verify your Cubby email change", text: `Verification token: ${token}` },
      { kind: "oldRequest" as const, recipient: identities[0]!.email, normalizedRecipient: identities[0]!.normalizedCurrentEmail, subject: "Cubby email change requested", text: "An email change was requested. The new address is not disclosed." },
      // These notices are encrypted now but are not claimable until the
      // guarded cutover commits.  This keeps their content atomic with the
      // initial operation while preventing a pre-cutover send.
      { kind: "newCutover" as const, recipient: normalized, normalizedRecipient: normalized, subject: "Your Cubby email was changed", text: "Your Cubby email change is complete." },
      { kind: "oldCutover" as const, recipient: identities[0]!.email, normalizedRecipient: identities[0]!.normalizedCurrentEmail, subject: "Cubby email changed", text: "The email on your Cubby account was changed." }
    ].map((delivery) => {
      const id = randomUUID();
      const recipientDigest = createHash("sha256").update(delivery.normalizedRecipient).digest();
      const kind = delivery.kind === "newVerification" ? "new_verification" : delivery.kind === "oldRequest" ? "old_request" : delivery.kind === "newCutover" ? "new_cutover" : "old_cutover";
      const encrypted = cipher.encrypt({ deliveryId: id, userId: context.userId, operationId, kind, recipientDigest }, { recipient: delivery.recipient, subject: delivery.subject, text: delivery.text });
      return { id, userId: context.userId, emailChangeId, operationId, kind: delivery.kind, recipientDigest: Uint8Array.from(recipientDigest), state: "queued" as const, ciphertext: Uint8Array.from(encrypted.ciphertext), iv: Uint8Array.from(encrypted.iv), authTag: Uint8Array.from(encrypted.authTag), aadDigest: Uint8Array.from(encrypted.aadDigest), keyVersion: encrypted.keyVersion, attemptCount: 0, nextAttemptAt: times[0]!.createdAt, createdAt: times[0]!.createdAt, updatedAt: times[0]!.createdAt };
    });
    await tx.emailChangeDelivery.createMany({ data: deliveries });
      return { operationId, status: "pending" as const };
    }, { isolationLevel: "Serializable" });
  } catch (error) {
    const errorCode = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    const errorMessage = error instanceof Error ? error.message.toLowerCase() : "";
    if (serializationAttempt < 1 && (errorCode === "P2034" || errorMessage.includes("40001") || errorMessage.includes("could not serialize") || errorMessage.includes("write conflict") || errorMessage.includes("deadlock"))) {
      return initiateVerifiedEmailChange(database, expected, input, currentPassword, deps, serializationAttempt + 1);
    }
    if (error instanceof Error && error.message.includes("stale_security_version")) {
      try {
        await database.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT result_state FROM "stale_email_change"(${expected.userId},${operationId})`;
        }, { isolationLevel: "Serializable" });
      } catch (closureError) {
        if (!(closureError instanceof Error) || !closureError.message.includes("email_change_stale_unavailable")) throw closureError;
      }
    }
    throw error;
  }
}
