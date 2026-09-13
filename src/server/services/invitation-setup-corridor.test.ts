import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/invitation-prisma", () => ({ invitationPrisma: { $queryRaw: vi.fn() } }));
vi.mock("@/server/auth/session", () => ({ getSession: vi.fn() }));
import { frameInvitationFields } from "@/server/services/invitation-attestation";
import { assertInvitationSetupCorridorAccess, createInvitationSetupCorridorSigner } from "@/server/services/invitation-setup-corridor";

const key = Buffer.alloc(32, 7);
const environment = {
  CUBBY_FRESH_AUTH_ATTESTATION_KEYRING: `7:${key.toString("base64url")}`,
  CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION: "7"
};

describe("invitation setup-corridor attestation", () => {
  it("domain-separates and length-frames the exact current session and subject", () => {
    const nonce = Buffer.alloc(32, 9);
    const issuedAt = new Date("2026-09-04T12:00:00.000Z");
    const signer = createInvitationSetupCorridorSigner(environment, () => nonce, () => issuedAt);
    const carrier = signer.sign({ ordinarySessionId: "session-1", subjectUserId: "user-1", purpose: "household_context" });

    const expected = createHmac("sha256", key).update(Buffer.concat([
      Buffer.from("cubby.invitation.setup-corridor-attestation.v1"),
      frameInvitationFields("session-1", "user-1", "household_context"), nonce,
      (() => { const value = Buffer.allocUnsafe(8); value.writeBigInt64BE((BigInt(issuedAt.getTime()) - 946684800000n) * 1000n); return value; })(),
      Buffer.from([0, 0, 0, 7])
    ])).digest();

    expect(carrier).toMatchObject({ keyVersion: 7, nonce, issuedAt, mac: expected });
  });

  it("rejects malformed purpose and random carrier lengths before database invocation", () => {
    const signer = createInvitationSetupCorridorSigner(environment);
    expect(() => signer.sign({ ordinarySessionId: "", subjectUserId: "user-1", purpose: "household_context" })).toThrow("invitation_setup_corridor_attestation_invalid");
    expect(() => signer.sign({ ordinarySessionId: "session-1", subjectUserId: "user-1", purpose: "bad\nvalue" })).toThrow("invitation_setup_corridor_attestation_invalid");
  });

  it("permits every reviewed setup owner only after bound setup classification and keeps neutral to bind sign-out or landing", () => {
    for (const owner of [
      "credential_reserve", "credential_submit", "credential_status", "credential_abandon",
      "invitation_review", "recovery_enrollment_reserve", "recovery_rehearsal_submit",
      "membership_accept_submit", "claim_close", "canonical_sign_out",
    ] as const) expect(() => assertInvitationSetupCorridorAccess("setup_required", owner)).not.toThrow();
    for (const owner of ["credential_submit", "invitation_review", "membership_accept_submit", "ordinary_global", "membership"] as const) {
      expect(() => assertInvitationSetupCorridorAccess("neutral", owner)).toThrow("invitation_setup_neutral");
    }
    for (const owner of ["post_signin_bind", "canonical_sign_out", "neutral_landing"] as const) {
      expect(() => assertInvitationSetupCorridorAccess("neutral", owner)).not.toThrow();
    }
  });

  it("lets an ordinary pre-existing member complete recovery readiness for a bound invitation without leaving household access", () => {
    const recoveryOwners = [
      "recovery_enrollment_reserve", "recovery_enrollment_fresh_auth", "recovery_enrollment_submit", "recovery_enrollment_status", "recovery_enrollment_abandon",
      "recovery_rehearsal_reserve", "recovery_rehearsal_submit", "recovery_rehearsal_status", "recovery_rehearsal_abandon",
    ] as const;
    for (const owner of [...recoveryOwners, "invitation_review", "membership_accept_submit", "membership"] as const) {
      expect(() => assertInvitationSetupCorridorAccess("ordinary", owner)).not.toThrow();
    }
    for (const owner of ["credential_reserve", "credential_submit", "credential_status", "credential_abandon"] as const) {
      expect(() => assertInvitationSetupCorridorAccess("ordinary", owner)).toThrow("invitation_setup_neutral");
    }
    for (const owner of recoveryOwners) {
      expect(() => assertInvitationSetupCorridorAccess("neutral", owner)).toThrow("invitation_setup_neutral");
    }
  });
});
