import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const protocolMigrationPath = fileURLToPath(new URL("../../../prisma/migrations/20260904120000_invitation_protocol_v2/migration.sql", import.meta.url));
const guardMigrationPath = fileURLToPath(new URL("../../../prisma/migrations/20260914120000_invitation_recovery_accepted_state_guard/migration.sql", import.meta.url));

const guardedProcedures = [
  "reserve_invitation_recovery_rehearsal_v2",
  "reserve_invitation_recovery_enrollment_v2",
  "submit_invitation_recovery_enrollment_v2",
] as const;

const acceptedGuard = "IF setup_row.\"setupState\"='accepted' THEN RAISE EXCEPTION 'invitation_recovery_unavailable'; END IF;";
const unguardedSetupUpdate = "UPDATE invitation_protocol.\"InvitationAccountSetup\" SET \"recoverySetVersion\"=set_version,\"setupState\"='recovery_generated' WHERE \"userId\"=(issuance_attestation).subject_user_id;";
const guardedSetupUpdate = "UPDATE invitation_protocol.\"InvitationAccountSetup\" SET \"recoverySetVersion\"=set_version,\"setupState\"='recovery_generated' WHERE \"userId\"=(issuance_attestation).subject_user_id AND \"setupState\"<>'accepted'; IF NOT FOUND THEN RAISE EXCEPTION 'invitation_recovery_unavailable'; END IF;";

function definitions(source: string, name: string) {
  return [...source.matchAll(new RegExp(`CREATE OR REPLACE FUNCTION invitation_protocol\\.${name}\\(([\\s\\S]*?)AS \\$\\$([\\s\\S]*?)\\$\\$;`, "g"))]
    .map((match) => ({ signature: match[1] ?? "", body: match[2] ?? "" }));
}

function firstWriteIndex(body: string) {
  const markers = ["create_invitation_identity_v2(", "write_invitation_binding_v2(", "INSERT INTO ", "UPDATE "];
  const positions = markers.map((marker) => body.indexOf(marker)).filter((position) => position >= 0);
  return positions.length > 0 ? Math.min(...positions) : -1;
}

describe("invitation recovery accepted-state guard migration", () => {
  it("is a forward migration that replaces exactly the three recovery procedures as the protocol owner", () => {
    expect(existsSync(guardMigrationPath)).toBe(true);
    const guard = readFileSync(guardMigrationPath, "utf8");

    expect(guard.trimStart().startsWith("BEGIN;")).toBe(true);
    expect(guard.trimEnd().endsWith("COMMIT;")).toBe(true);
    const setRole = guard.indexOf("SET ROLE invitation_protocol_owner_NOLOGIN;");
    const resetRole = guard.indexOf("RESET ROLE;");
    expect(setRole).toBeGreaterThan(0);
    expect(resetRole).toBeGreaterThan(setRole);
    expect(guard.match(/CREATE OR REPLACE FUNCTION /g)).toHaveLength(3);
    expect(guard).not.toMatch(/\b(GRANT|REVOKE|ALTER|DROP)\b/);
    for (const name of guardedProcedures) {
      const start = guard.indexOf(`CREATE OR REPLACE FUNCTION invitation_protocol.${name}(`);
      expect(start, name).toBeGreaterThan(setRole);
      expect(start, name).toBeLessThan(resetRole);
    }
  });

  it("refuses an already accepted setup before any write while keeping every other statement identical to the reviewed protocol", () => {
    expect(existsSync(guardMigrationPath)).toBe(true);
    const protocol = readFileSync(protocolMigrationPath, "utf8");
    const guard = readFileSync(guardMigrationPath, "utf8");

    for (const name of guardedProcedures) {
      const [original] = definitions(protocol, name);
      const replacements = definitions(guard, name);
      expect(replacements, name).toHaveLength(1);
      const [replacement] = replacements;
      expect(original, name).toBeDefined();
      expect(replacement!.signature, name).toBe(original!.signature);

      const body = replacement!.body;
      expect(body.split(acceptedGuard), name).toHaveLength(2);
      const guardIndex = body.indexOf(acceptedGuard);
      expect(guardIndex, name).toBeGreaterThan(body.indexOf("SELECT * INTO setup_row FROM invitation_protocol.\"InvitationAccountSetup\""));
      expect(firstWriteIndex(body), name).toBeGreaterThan(guardIndex);

      const withoutGuard = body.replace(new RegExp(`\\r?\\n {2}${acceptedGuard.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), "").replace(guardedSetupUpdate, unguardedSetupUpdate);
      expect(withoutGuard, name).toBe(original!.body);
    }
  });

  it("never moves an accepted setup back to recovery_generated", () => {
    expect(existsSync(guardMigrationPath)).toBe(true);
    const [submit] = definitions(readFileSync(guardMigrationPath, "utf8"), "submit_invitation_recovery_enrollment_v2");
    expect(submit?.body).toContain(guardedSetupUpdate);
    expect(submit?.body).not.toContain(unguardedSetupUpdate);
  });
});
