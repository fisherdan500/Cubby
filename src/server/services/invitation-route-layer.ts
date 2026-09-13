import { auth } from "@/lib/auth/auth";
import { prisma } from "@/lib/db/prisma";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getEffectiveHouseholdContext } from "@/server/auth/context";
import { getSession, requireFreshSession, requireGlobalSecurityContext } from "@/server/auth/session";
import { invitationFingerprint, prepareRecoveryVerifierBatch } from "@/server/services/invitation-attestation";
import { getInvitationServices } from "@/server/services/invitation-service";
import { issueFreshAuthGrantForCurrentPassword } from "@/server/services/global-security";
import { assertInvitationSetupCorridorAccess, classifyInvitationSetupCorridor, type InvitationSetupCorridorOwner } from "@/server/services/invitation-setup-corridor";

export const INVITATION_CLAIM_COOKIE = "cubby_invitation_claim";
// The claim reference is deliberately HttpOnly and never exposes an invitation token.
export const invitationResponseHeaders = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } as const;

type Json = Record<string, unknown>;
type RequestContext = {
  ordinarySessionId: string | null;
  subjectUserId: string | null;
  issuerMembershipEpisodeId: string | null;
  subjectMembershipEpisodeId: string | null;
  openingFingerprint: Buffer;
  intentFingerprint: Buffer | null;
};

export type InvitationRoute =
  | "claim" | "claim-close" | "post-signin-bind" | "review"
  | "credential-reserve" | "credential-submit" | "credential-status" | "credential-abandon"
  | "recovery-enrollment-reserve" | "recovery-enrollment-fresh-auth" | "recovery-enrollment-submit" | "recovery-enrollment-status" | "recovery-enrollment-abandon"
  | "recovery-rehearsal-reserve" | "recovery-rehearsal-submit" | "recovery-rehearsal-status" | "recovery-rehearsal-abandon"
  | "accept-reserve" | "accept-submit" | "accept-status" | "accept-abandon"
  | "manual-create" | "manual-replace" | "manual-status" | "manual-abandon" | "manual-replace-status" | "manual-replace-abandon"
  | "revoke" | "revoke-all";

const setupOwnerByRoute = {
  "claim-close": "claim_close",
  review: "invitation_review",
  "recovery-enrollment-reserve": "recovery_enrollment_reserve",
  "recovery-enrollment-fresh-auth": "recovery_enrollment_fresh_auth",
  "recovery-enrollment-submit": "recovery_enrollment_submit",
  "recovery-enrollment-status": "recovery_enrollment_status",
  "recovery-enrollment-abandon": "recovery_enrollment_abandon",
  "recovery-rehearsal-reserve": "recovery_rehearsal_reserve",
  "recovery-rehearsal-submit": "recovery_rehearsal_submit",
  "recovery-rehearsal-status": "recovery_rehearsal_status",
  "recovery-rehearsal-abandon": "recovery_rehearsal_abandon",
  "accept-reserve": "membership_accept_reserve",
  "accept-submit": "membership_accept_submit",
  "accept-status": "membership_accept_status",
  "accept-abandon": "membership_accept_abandon"
} as const satisfies Partial<Record<InvitationRoute, InvitationSetupCorridorOwner>>;

const p13RecoveryRouteOriginHeader = "X-Cubby-P13-Recovery-Origin";
type P13RecoveryRouteOriginStage = "setup_session_absent" | "setup_corridor_rejected" | "submit_service_error" | "submit_empty_receipt" | "submit_terminal_unavailable" | "submit_terminal_generated" | "submit_terminal_completed" | "submit_state_fresh_auth_bound" | "submit_state_prepared" | "submit_state_other" | "submit_receipt_invalid";
const p13RecoveryRouteOriginEnabled = process.env.CUBBY_P13_RECOVERY_ROUTE_ORIGIN_OBSERVER === "1" && process.env.CUBBY_P13_ACCEPTANCE_HEALTH_SENTINEL === "1";

function setupOwner(route: InvitationRoute): InvitationSetupCorridorOwner {
  const owner = setupOwnerByRoute[route as keyof typeof setupOwnerByRoute];
  if (!owner) throw new Error("invitation_request_invalid");
  return owner;
}

function response(data: unknown, status = 200, recoveryRouteOrigin?: P13RecoveryRouteOriginStage) {
  return NextResponse.json({ ok: true, data }, { status, headers: recoveryRouteOrigin && p13RecoveryRouteOriginEnabled ? { ...invitationResponseHeaders, [p13RecoveryRouteOriginHeader]: recoveryRouteOrigin } : invitationResponseHeaders });
}

function unavailable(operationId?: string, recoveryRouteOrigin?: P13RecoveryRouteOriginStage) {
  return response({ status: "unavailable", ...(operationId ? { operationId } : {}) }, 200, recoveryRouteOrigin);
}

function record(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invitation_request_invalid");
  return value as Json;
}

async function body(request: Request) {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new Error("invitation_request_invalid");
  return record(await request.json().catch(() => { throw new Error("invitation_request_invalid"); }));
}

function text(input: Json, key: string, max = 512) {
  const value = input[key];
  if (typeof value !== "string" || value.length < 1 || value.length > max) throw new Error("invitation_request_invalid");
  return value;
}

function uuid(input: Json, key: string) {
  const value = text(input, key, 64);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error("invitation_request_invalid");
  return value;
}

function digest(input: Json, key: string) {
  const value = text(input, key, 64);
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new Error("invitation_request_invalid");
  return Buffer.from(value, "hex");
}

function integer(input: Json, key: string, min = 1, max = 2_147_483_647) {
  const value = input[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new Error("invitation_request_invalid");
  return value;
}

function claimPresentation() {
  const value = cookies().get(INVITATION_CLAIM_COOKIE)?.value;
  const [claimIdentityId, presentationOperationId, extra] = value?.split(".") ?? [];
  if (extra || !claimIdentityId || !presentationOperationId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(claimIdentityId) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(presentationOperationId)) return null;
  return { claimIdentityId, presentationOperationId };
}

function fingerprint(scope: string, values: Json) {
  return invitationFingerprint(scope, values);
}

/** The protocol procedures recheck InvitationAccountSetup; this guard admits only its session corridor and never resolves household context. */
export async function requireInvitationSetupSession(owner: InvitationSetupCorridorOwner) {
  const session = await getSession();
  if (!session?.session?.id || !session.user?.id) return null;
  const result = await classifyInvitationSetupCorridor({ sessionId: session.session.id, userId: session.user.id, purpose: owner });
  assertInvitationSetupCorridorAccess(result, owner);
  return { sessionId: session.session.id, userId: session.user.id };
}

async function setupRequest(scope: InvitationRoute, input: Json, intent = false): Promise<{ session: { sessionId: string; userId: string }; request: RequestContext } | null> {
  const session = await requireInvitationSetupSession(setupOwner(scope));
  if (!session) return null;
  return {
    session,
    request: {
      ordinarySessionId: session.sessionId,
      subjectUserId: session.userId,
      issuerMembershipEpisodeId: null,
      subjectMembershipEpisodeId: null,
      openingFingerprint: digest(input, "openingFingerprint"),
      intentFingerprint: intent ? digest(input, "intentFingerprint") : null
    }
  };
}

function p13RecoverySubmitRouteOrigin(receipt: unknown): P13RecoveryRouteOriginStage {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return "submit_empty_receipt";
  const status = (receipt as Json).status;
  if (status === "unavailable") return "submit_terminal_unavailable";
  if (status === "generated") return "submit_terminal_generated";
  if (status === "completed") return "submit_terminal_completed";
  if (status === "fresh_auth_bound") return "submit_state_fresh_auth_bound";
  if (status === "prepared") return "submit_state_prepared";
  return typeof status === "string" ? "submit_state_other" : "submit_receipt_invalid";
}

const recoveryGrantIdentityPattern = /^gso_[0-9abcdefghjkmnpqrstvwxyz]{26}$/;

/**
 * The canonical operation identity belongs to the server-held bridge mapping. It is authorized here,
 * before any canonical grant exists, so a substituted browser identity mutates nothing.
 */
async function authorizedRecoveryEnrollmentGrantIdentity(
  authorize: (input: { operationId: string; request: RequestContext }) => Promise<unknown>,
  input: { operationId: string; request: RequestContext; supplied: string }
): Promise<string | null> {
  const receipt = await authorize({ operationId: input.operationId, request: input.request }).catch(() => null);
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return null;
  const authorized = (receipt as Json).globalSecurityOperationId;
  if ((receipt as Json).operationId !== input.operationId || typeof authorized !== "string" || !recoveryGrantIdentityPattern.test(authorized)) return null;
  return authorized === input.supplied ? authorized : null;
}

/** Recovery codes exist only in the in-memory batch; replay receipts never re-expose them. */
function recoveryEnrollmentDisplayOnceReceipt(
  operationId: string,
  receipt: unknown,
  batch: Awaited<ReturnType<typeof prepareRecoveryVerifierBatch>>
) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return receipt;
  const submitted = receipt as Json;
  if (submitted.operationId !== operationId || submitted.status !== "generated" || submitted.displayOnce !== true) return receipt;
  return {
    ...submitted,
    codeEntries: batch.codes.map((code, index) => ({ codeId: batch.records[index]!.codeId, code }))
  };
}

async function issuerRequest(input: Json, intent: boolean) {
  const session = await requireFreshSession();
  const household = await getEffectiveHouseholdContext();
  if (!session.session?.id || !session.user?.id || household.userId !== session.user.id) throw new Error("unauthenticated");
  return {
    household,
    request: {
      ordinarySessionId: session.session.id,
      subjectUserId: session.user.id,
      issuerMembershipEpisodeId: household.memberId,
      subjectMembershipEpisodeId: null,
      openingFingerprint: digest(input, "openingFingerprint"),
      intentFingerprint: intent ? digest(input, "intentFingerprint") : null
    } satisfies RequestContext
  };
}

function claimRequest(claimId: string, session: { sessionId: string; userId: string }, scope: string): RequestContext {
  return {
    ordinarySessionId: session.sessionId,
    subjectUserId: session.userId,
    issuerMembershipEpisodeId: null,
    subjectMembershipEpisodeId: null,
    openingFingerprint: fingerprint(scope, { claimIdentityId: claimId }),
    intentFingerprint: null
  };
}

function safeReservation(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (typeof input.operationIdentityId !== "string" || typeof input.credentialVersion !== "number" || typeof input.sessionSecurityVersion !== "number" || typeof input.recoverySetVersion !== "number" || !Buffer.isBuffer(input.nonce) || !Buffer.isBuffer(input.salt) || !Buffer.isBuffer(input.derivedKey)) return null;
  return {
    operationIdentityId: input.operationIdentityId,
    credentialVersion: input.credentialVersion,
    sessionSecurityVersion: input.sessionSecurityVersion,
    recoverySetVersion: input.recoverySetVersion,
    nonce: input.nonce,
    salt: input.salt,
    derivedKey: input.derivedKey,
    kdfVersion: input.kdfVersion === 1 ? 1 as const : null
  };
}

function errorResponse(error: unknown) {
  if (error instanceof Error && error.message === "invitation_request_invalid") return response({ status: "unavailable" });
  return unavailable();
}

export async function handleInvitationRoute(request: Request, route: InvitationRoute): Promise<NextResponse> {
  try {
    const services = await getInvitationServices();
    if (route === "claim") {
      const input = await body(request);
      const receipt = await services.claim({ token: text(input, "token", 1024), browserPartitionDigest: digest(input, "browserPartitionDigest") });
      const claimIdValue = receipt && typeof receipt === "object" ? (receipt as Json).claimIdentityId : null;
      const presentationOperationIdValue = receipt && typeof receipt === "object" ? (receipt as Json).operationId : null;
      const claimId = typeof claimIdValue === "string" ? claimIdValue : null;
      const presentationOperationId = typeof presentationOperationIdValue === "string" ? presentationOperationIdValue : null;
      const result = response(receipt ?? { status: "unavailable" });
      if (claimId && presentationOperationId && /^[0-9a-f-]{36}$/i.test(claimId) && /^[0-9a-f-]{36}$/i.test(presentationOperationId)) result.cookies.set(INVITATION_CLAIM_COOKIE, `${claimId}.${presentationOperationId}`, { httpOnly: true, secure: true, sameSite: "strict", path: "/" });
      return result;
    }
    if (route === "post-signin-bind" || route === "review") {
      const presentation = claimPresentation(); const session = await requireInvitationSetupSession(route === "post-signin-bind" ? "post_signin_bind" : "invitation_review");
      if (!presentation || !session) return unavailable();
      const requestContext = claimRequest(presentation.claimIdentityId, session, route);
      return response(route === "post-signin-bind"
        ? await services.bind({ sessionId: session.sessionId, claimIdentityId: presentation.claimIdentityId, request: { ...requestContext, operationId: presentation.presentationOperationId } })
        : await services.review({ sessionId: session.sessionId, claimIdentityId: presentation.claimIdentityId, request: { ...requestContext, operationId: presentation.presentationOperationId } }));
    }
    const input = await body(request);
    if (route === "claim-close") {
      const presentation = claimPresentation(); const session = await requireInvitationSetupSession("claim_close");
      if (!presentation || !session) return unavailable();
      const reason = input.reason;
      if (reason !== "explicit_close" && reason !== "expiry" && reason !== "revoke" && reason !== "consume") throw new Error("invitation_request_invalid");
      const receipt = await services.close({ claimIdentityId: presentation.claimIdentityId, reason, request: { ...claimRequest(presentation.claimIdentityId, session, route), operationId: presentation.presentationOperationId } });
      const result = response(receipt ?? { status: "unavailable" }); result.cookies.delete(INVITATION_CLAIM_COOKIE); return result;
    }
    if (route.startsWith("credential-")) {
      const presentation = claimPresentation(); if (!presentation) return unavailable();
      const operationId = uuid(input, "operationId");
      const base = { operationId, claimIdentityId: presentation.claimIdentityId, browserPartitionDigest: digest(input, "browserPartitionDigest"), recipientEmailDigest: digest(input, "recipientEmailDigest") };
      if (route === "credential-reserve") return response(await services.credential.reserve({ ...base, request: { ordinarySessionId: null, subjectUserId: null, issuerMembershipEpisodeId: null, subjectMembershipEpisodeId: null, openingFingerprint: digest(input, "openingFingerprint"), intentFingerprint: null } }));
      if (route === "credential-submit") {
        const authContext = await auth.$context;
        return response(await services.credential.submit({ ...base, displayName: text(input, "displayName"), password: text(input, "password", 1024), hashPassword: authContext.password.hash, request: { ordinarySessionId: null, subjectUserId: null, issuerMembershipEpisodeId: null, subjectMembershipEpisodeId: null, openingFingerprint: digest(input, "openingFingerprint"), intentFingerprint: digest(input, "intentFingerprint") } }));
      }
      return response(route === "credential-status" ? await services.credential.status(base) : await services.credential.abandon(base));
    }
    if (route.startsWith("recovery-enrollment-")) {
      const operationId = uuid(input, "operationId");
      let context: Awaited<ReturnType<typeof setupRequest>>;
      const needsIntent = route === "recovery-enrollment-submit" || route === "recovery-enrollment-fresh-auth";
      try { context = await setupRequest(route, input, needsIntent); } catch {
        return route === "recovery-enrollment-submit" ? unavailable(operationId, "setup_corridor_rejected") : unavailable(operationId);
      }
      if (!context) return route === "recovery-enrollment-submit" ? unavailable(operationId, "setup_session_absent") : unavailable(operationId);
      if (route === "recovery-enrollment-reserve") return response(await services.recoveryEnrollment.reserve({ operationId, request: context.request }));
      if (route === "recovery-enrollment-fresh-auth") {
        const supplied = text(input, "globalSecurityOperationId", 64);
        if (!context.request.intentFingerprint) throw new Error("invitation_request_invalid");
        const globalContext = await requireGlobalSecurityContext();
        if (globalContext.userId !== context.session.userId || globalContext.sessionId !== context.session.sessionId) return unavailable(operationId);
        const authorizedGlobalSecurityOperationId = await authorizedRecoveryEnrollmentGrantIdentity(
          (authorizeInput) => services.recoveryEnrollment.authorizeFreshAuth(authorizeInput),
          { operationId, request: context.request, supplied }
        );
        if (!authorizedGlobalSecurityOperationId) return unavailable(operationId);
        const authContext = await auth.$context;
        await issueFreshAuthGrantForCurrentPassword(prisma, globalContext, { operationId: authorizedGlobalSecurityOperationId, purpose: "recovery_enrollment", openingFingerprint: context.request.openingFingerprint.toString("hex"), intentFingerprint: context.request.intentFingerprint.toString("hex") }, text(input, "currentPassword", 128), { verify: authContext.password.verify });
        return response(await services.recoveryEnrollment.bindFreshAuth({ operationId, request: context.request }));
      }
      if (route === "recovery-enrollment-submit") {
        let receipt: unknown;
        let batch: Awaited<ReturnType<typeof prepareRecoveryVerifierBatch>> | null = null;
        try {
          receipt = await services.recoveryEnrollment.submit({
            operationId,
            request: context.request,
            // A terminal issuance never reaches this factory, so no second batch is ever minted.
            prepareBatch: async () => (batch = await prepareRecoveryVerifierBatch())
          });
        } catch { return unavailable(operationId, "submit_service_error"); }
        const recoveryRouteOrigin = p13RecoverySubmitRouteOrigin(receipt);
        if (recoveryRouteOrigin === "submit_empty_receipt") return unavailable(operationId, recoveryRouteOrigin);
        return response(batch ? recoveryEnrollmentDisplayOnceReceipt(operationId, receipt, batch) : receipt, 200, recoveryRouteOrigin);
      }
      return response(route === "recovery-enrollment-status" ? await services.recoveryEnrollment.status({ operationId, request: context.request }) : await services.recoveryEnrollment.abandon({ operationId, request: context.request }));
    }
    if (route.startsWith("recovery-rehearsal-")) {
      const operationId = uuid(input, "operationId"); const context = await setupRequest(route, input, false); if (!context) return unavailable(operationId);
      const selectedRecoveryCodeId = text(input, "selectedRecoveryCodeId");
      const rehearsalIntentFingerprint = fingerprint("recovery_rehearsal", { operationId, selectedRecoveryCodeId });
      const rehearsalRequest = { ...context.request, intentFingerprint: rehearsalIntentFingerprint };
      if (route === "recovery-rehearsal-reserve") {
        const acknowledgement = text(input, "acknowledgement");
        const reservationResult = await services.rehearsal.reserve({ operationId, selectedRecoveryCodeId, acknowledgement, request: rehearsalRequest });
        const reservation = safeReservation(reservationResult); if (!reservation || reservation.kdfVersion !== 1) return unavailable(operationId);
        const attestation = await services.rehearsal.attestReservation({ operationId, selectedRecoveryCodeId, recoveryCode: text(input, "recoveryCode", 128), request: rehearsalRequest, reservation: { ...reservation, kdfVersion: 1 } });
        return response({ operationId, status: "prepared", nonce: reservation.nonce.toString("base64url"), attestation: { keyVersion: attestation.keyVersion, nonce: attestation.nonce.toString("base64url"), mac: attestation.mac.toString("base64url") } });
      }
      if (route === "recovery-rehearsal-submit") return response(await services.rehearsal.submit({ operationId, selectedRecoveryCodeId, nonce: Buffer.from(text(input, "nonce", 128), "base64url"), attestation: { keyVersion: integer(input, "attestationKeyVersion"), mac: Buffer.from(text(input, "attestationMac", 128), "base64url") }, request: rehearsalRequest }));
      return response(route === "recovery-rehearsal-status" ? await services.rehearsal.status({ operationId, request: rehearsalRequest }) : await services.rehearsal.abandon({ operationId, request: rehearsalRequest }));
    }
    if (route.startsWith("accept-")) {
      const presentation = claimPresentation(); const operationId = uuid(input, "operationId"); const context = await setupRequest(route, input, route === "accept-submit"); if (!presentation || !context) return unavailable(operationId);
      if (route === "accept-reserve") return response(await services.acceptance.reserve({ operationId, claimIdentityId: presentation.claimIdentityId, reviewVersion: integer(input, "reviewVersion"), reviewSnapshotDigest: text(input, "reviewSnapshotDigest", 64), request: context.request }));
      if (route === "accept-submit") return response(await services.acceptance.submit({ operationId, reviewVersion: integer(input, "reviewVersion"), reviewSnapshotDigest: text(input, "reviewSnapshotDigest", 64), typedHouseholdName: text(input, "typedHouseholdName"), adminAcknowledgement: input.adminAcknowledgement === null ? null : text(input, "adminAcknowledgement"), request: context.request }));
      return response(route === "accept-status" ? await services.acceptance.status({ operationId, request: context.request }) : await services.acceptance.abandon({ operationId, request: context.request }));
    }
    const issuer = await issuerRequest(input, route === "manual-create" || route === "manual-replace" || route === "revoke" || route === "revoke-all");
    const operationId = uuid(input, "operationId");
    if (route === "manual-create") {
      if (input.action === "reserve") return response(await services.manualCreate.reserve({ operationId, householdId: issuer.household.householdId, role: text(input, "role", 32), expiresInHours: integer(input, "expiresInHours", 1, 720), recipientEmail: text(input, "recipientEmail", 320), request: issuer.request }));
      if (input.action === "submit") return response(await services.manualCreate.submit({ operationId, householdId: issuer.household.householdId, request: issuer.request }));
      throw new Error("invitation_request_invalid");
    }
    if (route === "manual-replace") {
      if (input.action === "reserve") return response(await services.manualReplace.reserve({ operationId, inviteId: text(input, "inviteId"), expiresInHours: integer(input, "expiresInHours", 1, 720), request: issuer.request }));
      if (input.action === "submit") return response(await services.manualReplace.submit({ operationId, inviteId: text(input, "inviteId"), request: issuer.request }));
      throw new Error("invitation_request_invalid");
    }
    if (route === "manual-status") return response(await services.manualCreate.status({ operationId, householdId: issuer.household.householdId, request: issuer.request }));
    if (route === "manual-abandon") return response(await services.manualCreate.abandon({ operationId, householdId: issuer.household.householdId, request: issuer.request }));
    if (route === "manual-replace-status") return response(await services.manualReplace.status({ operationId, inviteId: text(input, "inviteId"), request: issuer.request }));
    if (route === "manual-replace-abandon") return response(await services.manualReplace.abandon({ operationId, inviteId: text(input, "inviteId"), request: issuer.request }));
    if (route === "revoke") return response(await services.revoke({ inviteId: text(input, "inviteId"), operationId, request: issuer.request }));
    return response(await services.revokeAll({ householdId: issuer.household.householdId, operationId, acknowledgement: text(input, "acknowledgement"), request: issuer.request }));
  } catch (error) {
    return errorResponse(error);
  }
}
