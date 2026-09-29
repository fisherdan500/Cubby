import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Coverage for the simplified-signup redefinition (DEC-PROD-426/427/428).
//
// invitation-protocol-schema.test.ts deliberately pins the ORIGINAL 20260904120000 file and its
// assertions there stay true and untouched: that migration is applied and immutable. Without the
// assertions below the suite would keep asserting the retired guards exist and stay green while the
// deployed protocol no longer enforces them.

const originalPath = fileURLToPath(
  new URL("../../../prisma/migrations/20260904120000_invitation_protocol_v2/migration.sql", import.meta.url),
);
const simplifiedPath = fileURLToPath(
  new URL("../../../prisma/migrations/20261004120000_invitation_simplified_signup/migration.sql", import.meta.url),
);

function acceptanceBody(migration: string) {
  const expression = new RegExp(
    "CREATE OR REPLACE FUNCTION invitation_protocol\\.submit_invitation_acceptance_v2\\([\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$;",
    "g",
  );
  const matches = [...migration.matchAll(expression)];
  const match = matches.at(-1);
  expect(match, "missing submit_invitation_acceptance_v2 body").not.toBeUndefined();
  return match?.[1] ?? "";
}

describe("simplified invitation signup migration", () => {
  const simplified = readFileSync(simplifiedPath, "utf8");
  const original = readFileSync(originalPath, "utf8");
  const body = acceptanceBody(simplified);

  it("is the last definition of submit_invitation_acceptance_v2", () => {
    // Guards against a later migration silently reinstating the retired behaviour.
    expect(simplifiedPath > originalPath).toBe(true);
    expect(simplified).toContain("CREATE OR REPLACE FUNCTION invitation_protocol.submit_invitation_acceptance_v2");
  });

  it("preserves the exact 7-argument signature so grants and callers are unchanged", () => {
    expect(simplified).toMatch(
      /submit_invitation_acceptance_v2\(operation_id UUID, review_version INTEGER, review_snapshot_digest TEXT, intent_fingerprint BYTEA, typed_household_name TEXT, nullable_admin_acknowledgement TEXT, request_attestation invitation_protocol\.invitation_request_attestation\)/,
    );
    expect(simplified).toContain("SECURITY DEFINER");
    expect(simplified).toContain("SET search_path=pg_catalog,invitation_protocol");
  });

  it("no longer requires a rehearsed recovery code set", () => {
    expect(body).not.toContain(`setup_row."setupState"<>'rehearsed'`);
    expect(body).not.toContain(`"state"='rehearsed' FOR UPDATE`);
    expect(body).not.toMatch(/set_row\."userId" IS NULL/);
  });

  it("no longer counts remaining active recovery codes", () => {
    expect(body).not.toContain("remainingActiveCount<>9");
    expect(body).not.toContain(`FROM public."RecoveryCode" WHERE "userId"=user_row."id" AND "state"='active'`);
  });

  it("no longer requires the typed household name or the admin acknowledgement", () => {
    expect(body).not.toContain("I UNDERSTAND ADMIN ACCESS");
    expect(body).not.toMatch(/normalize\(typed_household_name/);
  });

  it("accepts every legitimate pre-acceptance state, including recovery_generated", () => {
    // recovery_generated is the mid-rehearsal state. Omitting it would permanently strand any
    // account stopped partway through the retired flow, with no UI route back.
    expect(body).toContain(
      `UPDATE invitation_protocol."InvitationAccountSetup" SET "setupState"='accepted' WHERE "userId"=user_row."id" AND "setupState" IN ('credential_created','credential_existing','recovery_generated','rehearsed');`,
    );
  });

  it("excludes 'accepted' from the terminal write so replay stays the only path for accepted rows", () => {
    const update = body.match(/UPDATE invitation_protocol\."InvitationAccountSetup"[^;]*;/)?.[0] ?? "";
    expect(update).not.toContain("'accepted','");
    expect(update).not.toContain(",'accepted'");
  });

  it("preserves the inviter authority recheck including owner-only-for-admin", () => {
    expect(body).toContain(`invite_row."role"='admin'`);
    expect(body).toMatch(/actor_membership|inviter/);
  });

  it("preserves the membership outcome matrix", () => {
    for (const outcome of ["already_member_same_role", "reentered", "created"]) {
      expect(body).toContain(outcome);
    }
  });

  it("preserves the Invite pending->accepted compare-and-set conflict", () => {
    expect(body).toContain("invitation_operation_conflict");
  });

  it("preserves terminal replay idempotency", () => {
    expect(body).toContain("TERMINAL_FULL");
  });

  it("adds no constraint requiring recovery codes for any user (DEC-PROD-428)", () => {
    expect(simplified).not.toMatch(/CHECK[^;]*RecoveryCodeSet/i);
    expect(simplified).not.toMatch(/NOT NULL[^;]*recoverySetVersion/i);
  });

  it("leaves the original migration's assertions intact", () => {
    // The applied migration is immutable; its retired guards must still be present in that file.
    expect(original).toContain("remainingActiveCount<>9");
    expect(original).toContain("I UNDERSTAND ADMIN ACCESS");
  });
});
