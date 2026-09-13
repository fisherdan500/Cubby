import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { createP13InvitationBrowserFixtures, disposeP13InvitationBrowserFixtures, type P13InvitationBrowserFixtures } from "./p1-3-invitation-browser-fixtures";
import { recoverySubmitQueryFailureClass } from "./p1-3-recovery-submit-probe-contract";
import { getInvitationServices } from "../src/server/services/invitation-service";
import { prepareRecoveryVerifierBatch } from "../src/server/services/invitation-attestation";
import { captureGlobalSecurityContext, issueFreshAuthGrantForCurrentPassword } from "../src/server/services/global-security";

async function run() {
  let stage: "fixture" | "credential" | "reserve" | "authorize" | "fresh_auth" | "bind" | "batch" | "submit" | "receipt" | "replay" = "fixture";
  let fixtures: P13InvitationBrowserFixtures | undefined;
  const owner = new PrismaClient({ datasourceUrl: process.env.FIXTURE_DATABASE_URL, log: [] });
  const runtime = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL, log: [] });
  const auth = new PrismaClient({ datasourceUrl: process.env.AUTH_DATABASE_URL, log: [] });
  try {
    fixtures = await createP13InvitationBrowserFixtures();
    const services = await getInvitationServices();
    const recipient = fixtures.newUser;
    const browserPartitionDigest = randomBytes(32);
    const claim = await services.claim({ token: recipient.invitationToken, browserPartitionDigest }) as { claimIdentityId?: string };
    recipient.invitationToken = "";
    if (typeof claim?.claimIdentityId !== "string") throw new Error();
    stage = "credential";
    const credentialId = randomUUID();
    const credentialRequest = { ordinarySessionId: null, subjectUserId: null, issuerMembershipEpisodeId: null, subjectMembershipEpisodeId: null, openingFingerprint: randomBytes(32), intentFingerprint: null };
    const credential = { operationId: credentialId, claimIdentityId: claim.claimIdentityId, browserPartitionDigest, recipientEmailDigest: createHash("sha256").update(recipient.email.toLowerCase()).digest() };
    await services.credential.reserve({ ...credential, request: credentialRequest });
    const created = await services.credential.submit({ ...credential, request: { ...credentialRequest, intentFingerprint: randomBytes(32) }, displayName: recipient.displayName, password: recipient.password, hashPassword }) as { status?: string };
    if (created?.status !== "continue_with_sign_in") throw new Error();
    const user = await owner.user.findUnique({ where: { email: recipient.email.toLowerCase() }, select: { id: true } });
    if (!user) throw new Error();
    const sessionId = randomUUID();
    // Fixture session only: full browser acceptance separately proves ordinary sign-in.
    await auth.session.create({ data: { id: sessionId, userId: user.id, token: randomBytes(32).toString("base64url"), expiresAt: new Date(Date.now() + 600_000) } });
    const operationId = randomUUID();
    const request = { ordinarySessionId: sessionId, subjectUserId: user.id, issuerMembershipEpisodeId: null, subjectMembershipEpisodeId: null, openingFingerprint: randomBytes(32), intentFingerprint: randomBytes(32) };
    stage = "reserve";
    const reserved = await services.recoveryEnrollment.reserve({ operationId, request: { ...request, intentFingerprint: null } }) as { status?: string; globalSecurityOperationId?: string };
    if (reserved?.status !== "prepared" || typeof reserved.globalSecurityOperationId !== "string" || !/^gso_[0-9abcdefghjkmnpqrstvwxyz]{26}$/.test(reserved.globalSecurityOperationId)) throw new Error();
    stage = "authorize";
    // The server-held mapping authorizes the canonical grant; the reserve receipt only echoes it.
    const authorized = await services.recoveryEnrollment.authorizeFreshAuth({ operationId, request }) as { status?: string; globalSecurityOperationId?: string };
    if (authorized?.status !== "authorized" || authorized.globalSecurityOperationId !== reserved.globalSecurityOperationId) throw new Error();
    stage = "fresh_auth";
    const globalContext = await captureGlobalSecurityContext(runtime, { userId: user.id, sessionId });
    await issueFreshAuthGrantForCurrentPassword(runtime, globalContext, { operationId: authorized.globalSecurityOperationId, purpose: "recovery_enrollment", openingFingerprint: request.openingFingerprint.toString("hex"), intentFingerprint: request.intentFingerprint.toString("hex") }, recipient.password, { verify: verifyPassword });
    stage = "bind";
    const bound = await services.recoveryEnrollment.bindFreshAuth({ operationId, request }) as { status?: string };
    if (bound?.status !== "fresh_auth_bound") throw new Error();
    stage = "batch";
    const batch = await prepareRecoveryVerifierBatch();
    if (batch.codes.length !== 10 || batch.records.length !== 10 || batch.digest.length !== 32) throw new Error();
    stage = "submit";
    const submitted = await services.recoveryEnrollment.submit({ operationId, request, prepareBatch: async () => batch }) as { operationId?: string; status?: string; displayOnce?: boolean };
    stage = "receipt";
    if (submitted?.operationId !== operationId || submitted.status !== "generated" || submitted.displayOnce !== true) throw new Error();
    const set = await owner.recoveryCodeSet.findFirst({ where: { userId: user.id, issuanceOperationId: reserved.globalSecurityOperationId }, select: { setVersion: true, state: true, freshAuthGrantId: true } });
    const grant = set ? await owner.freshAuthGrant.findUnique({ where: { id: set.freshAuthGrantId }, select: { state: true, operationId: true } }) : null;
    const count = set ? await owner.recoveryCode.count({ where: { userId: user.id, setVersion: set.setVersion, state: "active" } }) : 0;
    if (!set || set.state !== "generated" || grant?.state !== "consumed" || grant.operationId !== reserved.globalSecurityOperationId || count !== 10) throw new Error();
    stage = "replay";
    // A terminal issuance must reconcile through authenticated status without minting a second batch.
    let replayMinted = false;
    const replay = await services.recoveryEnrollment.submit({ operationId, request, prepareBatch: async () => { replayMinted = true; return prepareRecoveryVerifierBatch(); } }) as Record<string, unknown>;
    if (replayMinted || replay?.status !== "generated" || "displayOnce" in replay || "codeEntries" in replay) throw new Error();
    const setCount = await owner.recoveryCodeSet.count({ where: { userId: user.id } });
    const activeCount = await owner.recoveryCode.count({ where: { userId: user.id, state: "active" } });
    if (setCount !== 1 || activeCount !== 10) throw new Error();
    batch.codes.fill("");
  } catch (error) {
    process.send?.(`p1_3_recovery_service_${stage}_sqlstate_${recoverySubmitQueryFailureClass(error)}`);
    process.exitCode = 1;
  } finally {
    try {
      await Promise.all([owner.$disconnect(), runtime.$disconnect(), auth.$disconnect()]);
      await disposeP13InvitationBrowserFixtures(fixtures);
    } catch {
      process.send?.("p1_3_recovery_service_cleanup_failed");
      process.exitCode = 1;
    }
  }
}

if (process.env.CUBBY_P13_RECOVERY_SERVICE_PROBE === "1" && process.env.CUBBY_P13_ACCEPTANCE_HEALTH_SENTINEL === "1" && process.send) {
  void run();
} else {
  process.exitCode = 1;
}
