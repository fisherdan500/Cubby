import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const schema = readFileSync(new URL("../../../prisma/schema.prisma", import.meta.url), "utf8");
const migration = readFileSync(new URL("../../../prisma/migrations/20260904120000_invitation_protocol_v2/migration.sql", import.meta.url), "utf8");
const routeLayer = readFileSync(new URL("./invitation-route-layer.ts", import.meta.url), "utf8");
const rootPage = readFileSync(new URL("../../app/page.tsx", import.meta.url), "utf8");
const appLayout = readFileSync(new URL("../../app/app/layout.tsx", import.meta.url), "utf8");
const onboardingPage = readFileSync(new URL("../../app/onboarding/page.tsx", import.meta.url), "utf8");

describe("invitation setup-corridor database authority", () => {
  it("persists a closed, unique-nonce receipt and exposes only the reviewed classifier", () => {
    expect(schema).toContain("model InvitationSetupCorridorAttestationReceipt");
    expect(schema).toContain("enum SetupCorridorResult");
    for (const token of [
      "CREATE TYPE invitation_protocol.invitation_setup_corridor_attestation AS",
      "CREATE TYPE invitation_protocol.setup_corridor_result AS ENUM ('setup_required','ordinary','neutral')",
      'CREATE TABLE invitation_protocol."InvitationSetupCorridorAttestationReceipt"',
      '"nonce" BYTEA NOT NULL UNIQUE',
      'CREATE OR REPLACE FUNCTION invitation_protocol.classify_invitation_setup_corridor_v2(session_id TEXT, setup_attestation invitation_protocol.invitation_setup_corridor_attestation)',
      "SECURITY DEFINER SET search_path=pg_catalog,invitation_protocol",
      'public."Session"', 'public."User"', 'public."FreshAuthAttestationKey"', 'INTERVAL \'10 minutes\'',
      'GRANT EXECUTE ON FUNCTION invitation_protocol.classify_invitation_setup_corridor_v2(TEXT,invitation_protocol.invitation_setup_corridor_attestation) TO cubby_invitation_runtime'
    ]) expect(migration).toContain(token);
    expect(migration).not.toContain('GRANT SELECT ON invitation_protocol."InvitationSetupCorridorAttestationReceipt" TO cubby_invitation_runtime');
  });

  it("enforces the classifier at setup dispatch and every top-level household entry before lookup", () => {
    expect(routeLayer).toContain('route === "post-signin-bind" ? "post_signin_bind" : "invitation_review"');
    expect(routeLayer).toContain('setupOwnerByRoute');
    expect(rootPage).toContain('currentInvitationSetupCorridor("neutral_landing")');
    expect(rootPage).toContain('corridor?.result === "setup_required"');
    expect(appLayout).toContain('requireInvitationSetupCorridor("membership")');
    expect(onboardingPage).toContain('currentInvitationSetupCorridor("membership")');
  });

  it("returns neutral rather than ordinary for an existing session without a credential account", () => {
    expect(migration).toContain('account_row public."Account"%ROWTYPE');
    expect(migration).toContain('SELECT * INTO account_row FROM public."Account" WHERE "userId"=user_row."id" AND "providerId"=\'credential\' AND "password" IS NOT NULL FOR UPDATE;');
    expect(migration).toContain('IF account_row."id" IS NULL THEN RETURN \'neutral\'; END IF;');
  });
});
