import { createHmac, randomBytes } from "node:crypto";

import { getSession } from "@/server/auth/session";
import { frameInvitationFields } from "@/server/services/invitation-attestation";

type KeyringEnvironment = Partial<Pick<NodeJS.ProcessEnv, "CUBBY_FRESH_AUTH_ATTESTATION_KEYRING" | "CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION">>;

export type SetupCorridorResult = "setup_required" | "ordinary" | "neutral";
export const neutralInvitationSetupCorridorOwners = ["post_signin_bind", "canonical_sign_out", "neutral_landing"] as const;
export const setupRequiredInvitationSetupCorridorOwners = [
  "credential_reserve", "credential_submit", "credential_status", "credential_abandon", "invitation_review", "claim_close", "recovery_enrollment_reserve", "recovery_enrollment_fresh_auth", "recovery_enrollment_submit", "recovery_enrollment_status", "recovery_enrollment_abandon",
  "recovery_rehearsal_reserve", "recovery_rehearsal_submit", "recovery_rehearsal_status", "recovery_rehearsal_abandon",
  "membership_accept_reserve", "membership_accept_submit", "membership_accept_status", "membership_accept_abandon", "canonical_sign_out"
] as const;
// Pre-existing members stay ordinary while bound to an invitation, so they complete recovery readiness from that session;
// the invitation procedures still authorize each step from the bound setup row, binding, session and attestation.
export const ordinaryInvitationSetupCorridorOwners = [
  "ordinary_global", "membership", "post_signin_bind", "invitation_review", "membership_accept_reserve", "membership_accept_submit", "membership_accept_status", "membership_accept_abandon", "canonical_sign_out",
  "recovery_enrollment_reserve", "recovery_enrollment_fresh_auth", "recovery_enrollment_submit", "recovery_enrollment_status", "recovery_enrollment_abandon",
  "recovery_rehearsal_reserve", "recovery_rehearsal_submit", "recovery_rehearsal_status", "recovery_rehearsal_abandon"
] as const;
export type InvitationSetupCorridorOwner =
  | typeof neutralInvitationSetupCorridorOwners[number]
  | typeof setupRequiredInvitationSetupCorridorOwners[number]
  | typeof ordinaryInvitationSetupCorridorOwners[number];
export type InvitationSetupCorridorAttestation = {
  ordinarySessionId: string;
  subjectUserId: string;
  purpose: string;
  keyVersion: number;
  nonce: Buffer;
  issuedAt: Date;
  mac: Buffer;
};

function keyring(environment: KeyringEnvironment) {
  const active = Number(environment.CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION);
  const configured = environment.CUBBY_FRESH_AUTH_ATTESTATION_KEYRING;
  if (!configured || !Number.isSafeInteger(active) || active < 1) throw new Error("invitation_setup_corridor_attestation_invalid");
  const keys = new Map<number, Buffer>();
  for (const entry of configured.split(",")) {
    const [versionText, encoded, extra] = entry.split(":");
    const version = Number(versionText);
    const value = encoded && /^[A-Za-z0-9_-]+$/.test(encoded) ? Buffer.from(encoded, "base64url") : null;
    if (extra || !value || value.length !== 32 || !Number.isSafeInteger(version) || version < 1 || keys.has(version)) throw new Error("invitation_setup_corridor_attestation_invalid");
    keys.set(version, value);
  }
  if (keys.size > 2 || !keys.has(active)) throw new Error("invitation_setup_corridor_attestation_invalid");
  return { active, key: keys.get(active)! };
}

function int32(value: number) {
  const output = Buffer.allocUnsafe(4);
  output.writeInt32BE(value);
  return output;
}

function timestamp(value: Date) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("invitation_setup_corridor_attestation_invalid");
  const output = Buffer.allocUnsafe(8);
  output.writeBigInt64BE((BigInt(value.getTime()) - 946684800000n) * 1000n);
  return output;
}

function validText(value: string) {
  return value.length > 0 && value.length <= 191 && value.trim() === value && !/[\0\r\n]/.test(value);
}

export function createInvitationSetupCorridorSigner(
  environment: KeyringEnvironment = {
    CUBBY_FRESH_AUTH_ATTESTATION_KEYRING: process.env.CUBBY_FRESH_AUTH_ATTESTATION_KEYRING,
    CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION: process.env.CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION
  },
  random: () => Buffer = () => randomBytes(32),
  now: () => Date = () => new Date()
) {
  const { active, key } = keyring(environment);
  return {
    sign(input: Pick<InvitationSetupCorridorAttestation, "ordinarySessionId" | "subjectUserId" | "purpose">): InvitationSetupCorridorAttestation {
      if (!validText(input.ordinarySessionId) || !validText(input.subjectUserId) || !validText(input.purpose)) throw new Error("invitation_setup_corridor_attestation_invalid");
      const nonce = Buffer.from(random());
      const issuedAt = now();
      if (nonce.length !== 32) throw new Error("invitation_setup_corridor_attestation_invalid");
      const payload = Buffer.concat([
        Buffer.from("cubby.invitation.setup-corridor-attestation.v1"),
        frameInvitationFields(input.ordinarySessionId, input.subjectUserId, input.purpose),
        nonce,
        timestamp(issuedAt),
        int32(active)
      ]);
      return { ...input, keyVersion: active, nonce, issuedAt, mac: createHmac("sha256", key).update(payload).digest() };
    }
  };
}

export async function classifyInvitationSetupCorridor(input: { sessionId: string; userId: string; purpose: string }): Promise<SetupCorridorResult> {
  try {
    const attestation = createInvitationSetupCorridorSigner().sign({ ordinarySessionId: input.sessionId, subjectUserId: input.userId, purpose: input.purpose });
    const { invitationPrisma } = await import("@/lib/db/invitation-prisma");
    const rows = await invitationPrisma.$queryRaw<Array<{ result: SetupCorridorResult }>>`
      SELECT invitation_protocol.classify_invitation_setup_corridor_v2(
        ${input.sessionId},
        ROW(${attestation.ordinarySessionId},${attestation.subjectUserId},${attestation.purpose},${attestation.keyVersion},${attestation.nonce},${attestation.issuedAt},${attestation.mac})::invitation_protocol.invitation_setup_corridor_attestation
      ) AS result
    `;
    const result = rows[0]?.result;
    return result === "setup_required" || result === "ordinary" || result === "neutral" ? result : "neutral";
  } catch {
    return "neutral";
  }
}

export function assertInvitationSetupCorridorAccess(result: SetupCorridorResult, owner: InvitationSetupCorridorOwner) {
  if (result === "ordinary" && ordinaryInvitationSetupCorridorOwners.includes(owner as never)) return result;
  if (result === "setup_required" && setupRequiredInvitationSetupCorridorOwners.includes(owner as never)) return result;
  if (result === "neutral" && neutralInvitationSetupCorridorOwners.includes(owner as never)) return result;
  throw new Error(result === "setup_required" ? "invitation_setup_required" : "invitation_setup_neutral");
}

export async function currentInvitationSetupCorridor(owner: InvitationSetupCorridorOwner) {
  const session = await getSession();
  if (!session?.session?.id || !session.user?.id) return null;
  const result = await classifyInvitationSetupCorridor({ sessionId: session.session.id, userId: session.user.id, purpose: owner });
  return { user: session.user, session: session.session, result };
}

export async function requireInvitationSetupCorridor(owner: InvitationSetupCorridorOwner) {
  const current = await currentInvitationSetupCorridor(owner);
  if (!current) return null;
  const { result } = current;
  assertInvitationSetupCorridorAccess(result, owner);
  return current;
}
