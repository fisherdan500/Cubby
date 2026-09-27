import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (relative: string) => readFileSync(fileURLToPath(new URL(`../../../${relative}`, import.meta.url)), "utf8");
const migration = () => read("prisma/migrations/20261003120000_invitation_email_delivery/migration.sql");

function functionBody(sql: string, name: string) {
  const match = new RegExp(`CREATE (?:OR REPLACE )?FUNCTION ${name.replace(/[.$"]/g, (c) => `\\${c}`)}\\(([\\s\\S]*?)AS \\$\\$([\\s\\S]*?)\\$\\$;`).exec(sql);
  expect(match, `missing function ${name}`).not.toBeNull();
  return { header: match?.[1] ?? "", body: match?.[2] ?? "" };
}

describe("invitation email delivery migration", () => {
  it("creates one encrypted delivery per invitation, cascading with its invitation and household", () => {
    const sql = migration();
    expect(sql).toContain('CREATE TABLE "InvitationEmailDelivery"');
    expect(sql).toContain('CREATE UNIQUE INDEX "InvitationEmailDelivery_inviteId_key" ON "InvitationEmailDelivery"("inviteId")');
    expect(sql).toMatch(/FOREIGN KEY \("inviteId"\) REFERENCES "Invite"\("id"\) ON DELETE CASCADE/);
    expect(sql).toMatch(/FOREIGN KEY \("householdId"\) REFERENCES "Household"\("id"\) ON DELETE CASCADE/);
    expect(sql).toMatch(/FOREIGN KEY \("keyVersion"\) REFERENCES "EmailDeliveryEncryptionKey"\("keyVersion"\) ON DELETE RESTRICT/);
  });

  it("keeps ciphertext only while a delivery can still be sent", () => {
    const sql = migration();
    expect(sql).toContain('"InvitationEmailDelivery_shape_check"');
    expect(sql).toMatch(/"state" IN \('queued','dispatching','retryable_failed'\) AND "ciphertext" IS NOT NULL/);
    expect(sql).toMatch(/"state" IN \('accepted','permanent_failed'\) AND "ciphertext" IS NULL AND "iv" IS NULL AND "authTag" IS NULL AND "aadDigest" IS NULL AND "keyVersion" IS NULL/);
  });

  it("enqueues only for a completed issuer operation that proves possession of the invitation's token", () => {
    const { header, body } = functionBody(migration(), "invitation_protocol.enqueue_manual_invitation_email_v1");
    expect(header).toContain("SECURITY DEFINER");
    expect(header).toContain("SET search_path=pg_catalog,invitation_protocol");
    for (const fragment of [
      "lock_global_security_transition_v1",
      "\"operationKind\" IN ('MANUAL_INVITE_CREATE','MANUAL_INVITE_REPLACE')",
      "'TERMINAL_FULL'",
      "reauthorize_invitation_carrier_v2",
      "\"tokenHash\"=token_hash",
      "\"householdId\"=identity_row.\"householdId\"",
      "\"status\"<>'pending'",
      "\"expiresAt\"<=clock_timestamp()",
      "\"invitedByUserId\" IS DISTINCT FROM (request_attestation).subject_user_id",
      "public.digest(convert_to(lower(btrim(invite_row.\"email\")),'UTF8'),'sha256')<>recipient_digest",
      "assert_invitation_issuer_authority_v2(identity_row,request_attestation,invite_row.\"role\",false,'manual_invite_email')",
      "\"activeWrite\"=true"
    ]) expect(body).toContain(fragment);
    expect(body.indexOf("reauthorize_invitation_carrier_v2")).toBeLessThan(body.indexOf("INSERT INTO public.\"InvitationEmailDelivery\""));
    expect(body.indexOf("assert_invitation_issuer_authority_v2")).toBeLessThan(body.indexOf("INSERT INTO public.\"InvitationEmailDelivery\""));
  });

  it("closes unsent deliveries when their invitation stops being pending", () => {
    const sql = migration();
    expect(sql).toMatch(/AFTER UPDATE OF "status" ON "Invite" FOR EACH ROW WHEN \(OLD\."status"='pending' AND NEW\."status"<>'pending'\)/);
    const { body } = functionBody(sql, "\"close_invitation_email_delivery_on_invite_change\"");
    expect(body).toContain("'cancelled'");
    expect(body).toContain('"ciphertext"=NULL');
  });

  it("claims only deliveries whose invitation is still pending and unexpired", () => {
    const { header, body } = functionBody(migration(), "\"claim_invitation_email_delivery\"");
    expect(header).toContain("SECURITY DEFINER");
    expect(body).toContain("'expired'");
    expect(body).toContain("'cancelled'");
    expect(body).toMatch(/invite\."status"='pending' AND invite\."expiresAt">clock_timestamp\(\)/);
    expect(body).toContain("FOR UPDATE OF delivery SKIP LOCKED");
  });

  it("grants each capability to exactly one dedicated role and hides ciphertext from the runtime role", () => {
    const sql = migration();
    expect(sql).toContain('REVOKE ALL ON TABLE "InvitationEmailDelivery" FROM PUBLIC');
    // Every column the pending-list query selects or filters on, and nothing encrypted.
    const runtimeGrant = /GRANT SELECT \(([^)]*)\) ON TABLE "InvitationEmailDelivery" TO cubby_runtime/.exec(sql);
    expect(runtimeGrant?.[1]?.split(",").sort()).toEqual(['"householdId"', '"id"', '"inviteId"', '"state"']);
    expect(sql).not.toMatch(/GRANT (ALL|SELECT|INSERT|UPDATE|DELETE)[^;(]*ON TABLE "InvitationEmailDelivery" TO/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION "claim_invitation_email_delivery"\(TEXT\),"accept_invitation_email_delivery"\(TEXT,TEXT,INTEGER,BYTEA\),"fail_invitation_email_delivery"\(TEXT,TEXT,TEXT\) TO cubby_email_delivery/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION invitation_protocol\.enqueue_manual_invitation_email_v1\([^)]*\) TO cubby_invitation_runtime/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION invitation_protocol\.enqueue_manual_invitation_email_v1\([^)]*\) FROM PUBLIC/);
  });

  it("keeps an encryption key in place while either queue still references it", () => {
    const { body } = functionBody(migration(), "\"enforce_email_delivery_key_reference\"");
    expect(body).toContain('"EmailChangeDelivery"');
    expect(body).toContain('"InvitationEmailDelivery"');
    expect(read("scripts/provision-email-delivery-keys.mjs")).toContain('"InvitationEmailDelivery"');
  });

  it("models the queue in Prisma and the tenant inventory", () => {
    expect(read("prisma/schema.prisma")).toMatch(/model InvitationEmailDelivery \{[\s\S]*inviteId\s+String\s+@unique/);
    expect(read("src/server/tenant-isolation-inventory.ts")).toContain('model: "InvitationEmailDelivery"');
  });
});
