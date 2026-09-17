import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const protocolMigrationPath = fileURLToPath(new URL("../../../prisma/migrations/20260904120000_invitation_protocol_v2/migration.sql", import.meta.url));
const changeMigrationPath = fileURLToPath(new URL("../../../prisma/migrations/20260915120000_invitation_recovery_notice_and_cross_lineage_takeover/migration.sql", import.meta.url));

// Qualified names exactly as they appear after "CREATE OR REPLACE FUNCTION invitation_protocol.".
const qualifiedNames = {
  originGuard: '"InvitationAccountSetup_origin_guard"',
  bind: "bind_post_signin_invitation_claim_v2",
  reviewSnapshot: "recompute_invitation_review_snapshot_v2",
} as const;

function definitions(source: string, qualifiedName: string) {
  const escaped = qualifiedName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...source.matchAll(new RegExp(`CREATE OR REPLACE FUNCTION invitation_protocol\\.${escaped}\\(([\\s\\S]*?)AS \\$\\$([\\s\\S]*?)\\$\\$;`, "g"))]
    .map((match) => ({ signature: match[1] ?? "", body: match[2] ?? "" }));
}

function only(source: string, qualifiedName: string) {
  const matches = definitions(source, qualifiedName);
  expect(matches, qualifiedName).toHaveLength(1);
  return matches[0]!;
}

describe("invitation recovery notice and cross-lineage takeover migration", () => {
  it("is a forward migration that replaces exactly the three named functions as the protocol owner", () => {
    expect(existsSync(changeMigrationPath)).toBe(true);
    const change = readFileSync(changeMigrationPath, "utf8");

    expect(change.trimStart().startsWith("BEGIN;")).toBe(true);
    expect(change.trimEnd().endsWith("COMMIT;")).toBe(true);
    const setRole = change.indexOf("SET ROLE invitation_protocol_owner_NOLOGIN;");
    const resetRole = change.indexOf("RESET ROLE;");
    expect(setRole).toBeGreaterThan(0);
    expect(resetRole).toBeGreaterThan(setRole);
    expect(change.match(/CREATE OR REPLACE FUNCTION /g)).toHaveLength(3);
    expect(change).not.toMatch(/\b(GRANT|REVOKE|ALTER|DROP)\b/);
    for (const qualifiedName of Object.values(qualifiedNames)) {
      const start = change.indexOf(`CREATE OR REPLACE FUNCTION invitation_protocol.${qualifiedName}(`);
      expect(start, qualifiedName).toBeGreaterThan(setRole);
      expect(start, qualifiedName).toBeLessThan(resetRole);
    }
  });

  describe("InvitationAccountSetup_origin_guard", () => {
    it("keeps userId, createdAt and accountOrigin fully immutable and the null-to-non-null rule unchanged", () => {
      const original = only(readFileSync(protocolMigrationPath, "utf8"), qualifiedNames.originGuard);
      const replacement = only(readFileSync(changeMigrationPath, "utf8"), qualifiedNames.originGuard);
      expect(replacement.signature).toBe(original.signature);
      expect(replacement.body).toContain('NEW."userId"<>OLD."userId"');
      expect(replacement.body).toContain('NEW."createdAt"<>OLD."createdAt"');
      expect(replacement.body).toContain('NEW."accountOrigin"<>OLD."accountOrigin"');
      // originLineageDigest is deliberately no longer in the unconditional immutability line: it may now
      // change, but only together with originLineageId (checked separately below).
      expect(replacement.body).not.toContain('NEW."originLineageDigest"<>OLD."originLineageDigest" THEN RAISE EXCEPTION');
      expect(replacement.body).toContain('IF OLD."originLineageId" IS NULL AND NEW."originLineageId" IS NOT NULL THEN RAISE EXCEPTION \'invitation_account_origin_no_rebind\'; END IF;');
    });

    it("requires originLineageId and originLineageDigest to change together or not at all, but only enforces this while the new lineage id is non-null", () => {
      const replacement = only(readFileSync(changeMigrationPath, "utf8"), qualifiedNames.originGuard);
      expect(replacement.body).toContain('IF NEW."originLineageId" IS NOT NULL AND (NEW."originLineageId" IS DISTINCT FROM OLD."originLineageId") <> (NEW."originLineageDigest" IS DISTINCT FROM OLD."originLineageDigest") THEN RAISE EXCEPTION \'invitation_account_origin_takeover_inconsistent\'; END IF;');
    });

    it("does not block the FK's ON DELETE SET NULL cascade, which sets originLineageId to NULL without touching originLineageDigest", () => {
      // InvitationAccountSetup.originLineageId REFERENCES InvitationLineage(id) ON DELETE SET NULL
      // (20260904120000_invitation_protocol_v2/migration.sql). If a referenced lineage is ever deleted,
      // Postgres performs that transition itself; the guard must not raise on it, or the cascade breaks.
      const replacement = only(readFileSync(changeMigrationPath, "utf8"), qualifiedNames.originGuard);
      expect(replacement.body).toMatch(/IF NEW\."originLineageId" IS NOT NULL AND /);
    });
  });

  describe("bind_post_signin_invitation_claim_v2", () => {
    it("has the same signature as the reviewed protocol", () => {
      const original = only(readFileSync(protocolMigrationPath, "utf8"), qualifiedNames.bind);
      const replacement = only(readFileSync(changeMigrationPath, "utf8"), qualifiedNames.bind);
      expect(replacement.signature).toBe(original.signature);
    });

    it("is identical to the reviewed protocol apart from the declared takeover variables and the cross-lineage block", () => {
      const original = only(readFileSync(protocolMigrationPath, "utf8"), qualifiedNames.bind);
      const replacement = only(readFileSync(changeMigrationPath, "utf8"), qualifiedNames.bind);

      // First isolate the DECLARE-line addition: exactly the two new variables, appended right after
      // setup_row's declaration.
      const declaredVars = ' prior_lineage_row invitation_protocol."InvitationLineage"%ROWTYPE; prior_invite_row public."Invite"%ROWTYPE;';
      const declareAnchor = 'setup_row invitation_protocol."InvitationAccountSetup"%ROWTYPE;';
      expect(replacement.body).toContain(declareAnchor + declaredVars);
      const replacementWithoutDeclaredVars = replacement.body.replace(declareAnchor + declaredVars, declareAnchor);

      // With the DECLARE addition removed, find the longest common prefix and suffix between the two
      // bodies; whatever remains in the middle of each is the only place they may still differ.
      let prefixLength = 0;
      while (prefixLength < original.body.length && prefixLength < replacementWithoutDeclaredVars.length && original.body[prefixLength] === replacementWithoutDeclaredVars[prefixLength]) prefixLength++;
      let suffixLength = 0;
      while (
        suffixLength < original.body.length - prefixLength && suffixLength < replacementWithoutDeclaredVars.length - prefixLength
        && original.body[original.body.length - 1 - suffixLength] === replacementWithoutDeclaredVars[replacementWithoutDeclaredVars.length - 1 - suffixLength]
      ) suffixLength++;

      const originalMiddle = original.body.slice(prefixLength, original.body.length - suffixLength);
      const replacementMiddle = replacementWithoutDeclaredVars.slice(prefixLength, replacementWithoutDeclaredVars.length - suffixLength);

      // The only original text that differs is the unconditional cross-lineage denial line (the common
      // suffix scan absorbs the shared trailing " END IF;" from both sides).
      expect(originalMiddle).toBe('IF setup_row."originLineageId" IS DISTINCT FROM lineage_row."id" THEN RAISE EXCEPTION \'invitation_bind_denied\';');

      // The replacement's differing middle must: still deny when the prior invitation is pending and
      // unexpired, otherwise take over the setup row onto the new lineage with a matching digest, and
      // must not be the unconditional denial verbatim (it is now conditional).
      expect(replacementMiddle).toContain('THEN RAISE EXCEPTION \'invitation_bind_denied\';');
      expect(replacementMiddle).toContain('"originLineageId"=lineage_row."id","originLineageDigest"=public.digest(convert_to(lineage_row."id",\'UTF8\'),\'sha256\')');
      expect(replacementMiddle).not.toBe(originalMiddle);
    });

    it("still denies bind when the prior lineage's own invitation remains pending and unexpired", () => {
      const replacement = only(readFileSync(changeMigrationPath, "utf8"), qualifiedNames.bind);
      const guardLine = 'IF prior_lineage_row."id" IS NOT NULL AND prior_invite_row."id" IS NOT NULL AND prior_invite_row."status"=\'pending\' AND prior_invite_row."expiresAt">clock_timestamp() THEN RAISE EXCEPTION \'invitation_bind_denied\'; END IF;';
      expect(replacement.body).toContain(guardLine);
    });

    it("takes over the setup row onto the new lineage with a matching digest, not an arbitrary one", () => {
      const replacement = only(readFileSync(changeMigrationPath, "utf8"), qualifiedNames.bind);
      expect(replacement.body).toContain('"originLineageId"=lineage_row."id","originLineageDigest"=public.digest(convert_to(lineage_row."id",\'UTF8\'),\'sha256\')');
    });
  });

  describe("recompute_invitation_review_snapshot_v2", () => {
    it("has the same signature as the reviewed protocol", () => {
      const original = only(readFileSync(protocolMigrationPath, "utf8"), qualifiedNames.reviewSnapshot);
      const replacement = only(readFileSync(changeMigrationPath, "utf8"), qualifiedNames.reviewSnapshot);
      expect(replacement.signature).toBe(original.signature);
    });

    it("adds hasPriorRecoveryCodes outside the integrity-protected digest, changing nothing else", () => {
      const original = only(readFileSync(protocolMigrationPath, "utf8"), qualifiedNames.reviewSnapshot);
      const replacement = only(readFileSync(changeMigrationPath, "utf8"), qualifiedNames.reviewSnapshot);

      // digest_text is computed over reviewVersion/disclosureCopyVersion/snapshot only; that statement
      // must be byte-identical, proving the new field cannot affect the disclosure integrity digest.
      const digestLine = (body: string) => body.split(/\r?\n/).find((line) => line.trimStart().startsWith("digest_text:="));
      expect(digestLine(replacement.body)).toBe(digestLine(original.body));
      expect(digestLine(original.body)).toBeTruthy();

      const addedField = ",'hasPriorRecoveryCodes',setup_row.\"recoverySetVersion\" IS NOT NULL";
      expect(replacement.body).toContain(addedField);
      expect(original.body).not.toContain("hasPriorRecoveryCodes");
      expect(replacement.body.replace(addedField, "")).toBe(original.body);
    });
  });
});
