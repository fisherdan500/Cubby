import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { createInvitationServices } from "@/server/services/invitation-service";

const migrationPath = fileURLToPath(new URL("../../../prisma/migrations/20260904120000_invitation_protocol_v2/migration.sql", import.meta.url));
const routePath = fileURLToPath(new URL("./invitation-route-layer.ts", import.meta.url));

function migration() {
  return readFileSync(migrationPath, "utf8");
}

/** All applied migrations that precede the invitation migration, concatenated in order. */
function canonicalMigrations() {
  const dir = fileURLToPath(new URL("../../../prisma/migrations/", import.meta.url));
  return readdirSync(dir).filter((name) => name < "20260904120000").sort()
    .map((name) => { try { return readFileSync(resolve(dir, name, "migration.sql"), "utf8"); } catch { return ""; } }).join("");
}

function procedureBody(source: string, name: string) {
  const matches = [...source.matchAll(new RegExp(`CREATE OR REPLACE FUNCTION invitation_protocol\\.${name}\\([\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$;`, "g"))];
  const body = matches.at(-1)?.[1];
  expect(body, `missing body for ${name}`).toBeTruthy();
  return body ?? "";
}

/** Extracts named top-level declarations so route behaviour runs without the Next request runtime. */
function compiledDeclarations(path: string, names: string[], dependencies: Record<string, unknown> = {}) {
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const declarations = names.map((name) => {
    const node = source.statements.find((candidate) =>
      (ts.isFunctionDeclaration(candidate) && candidate.name?.text === name) ||
      (ts.isVariableStatement(candidate) && candidate.declarationList.declarations.some((declaration) => declaration.name.getText(source) === name)));
    if (!node) throw new Error(`source_declaration_absent:${name}`);
    return node.getText(source).replace(/^export\s+/, "");
  }).join("\n");
  const compiled = ts.transpileModule(declarations, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return runInNewContext(`${compiled}\n({${names.join(",")}})`, { exports: {}, Buffer, ...dependencies });
}

// Every runtime procedure that row-locks canonical Global Security state must order the shared
// transition lock first; canonical operations always take it before their own row locks.
const bridgeProcedures = [
  "close_invitation_presentation_v2", "bind_post_signin_invitation_claim_v2", "issue_invitation_review_v2",
  "reserve_manual_invite_create_v2", "submit_manual_invite_create_v2", "status_manual_invite_create_v2", "abandon_manual_invite_create_v2",
  "reserve_manual_invite_replace_v2", "submit_manual_invite_replace_v2", "status_manual_invite_replace_v2", "abandon_manual_invite_replace_v2",
  "reserve_invitation_credential_setup_v2", "submit_invitation_credential_setup_v2", "status_invitation_credential_setup_v2", "abandon_invitation_credential_setup_v2",
  "reserve_invitation_recovery_enrollment_v2", "authorize_invitation_recovery_enrollment_fresh_auth_v2", "bind_invitation_recovery_enrollment_fresh_auth_v2",
  "submit_invitation_recovery_enrollment_v2", "status_invitation_recovery_enrollment_v2", "abandon_invitation_recovery_enrollment_v2",
  "reserve_invitation_recovery_rehearsal_v2", "submit_invitation_recovery_rehearsal_v2", "status_invitation_recovery_rehearsal_v2", "abandon_invitation_recovery_rehearsal_v2",
  "reserve_invitation_acceptance_v2", "submit_invitation_acceptance_v2", "status_invitation_acceptance_v2", "abandon_invitation_acceptance_v2",
  "revoke_invitation_v2", "revoke_all_invitations_v2", "classify_invitation_setup_corridor_v2"
];

describe("canonical Global Security lock ordering", () => {
  it("acquires the canonical transition lock before any row lock on every bridged runtime path", () => {
    const source = migration();
    expect(source).toContain("hashtextextended('global-security-transition:v1', 0)");
    for (const name of bridgeProcedures) {
      const body = procedureBody(source, name);
      const transition = body.indexOf("lock_global_security_transition_v1");
      expect(transition, `${name} takes the canonical transition lock`).toBeGreaterThanOrEqual(0);
      for (const rowLock of ["FOR UPDATE", "FOR SHARE", "lock_invitation_protocol_v2", "lock_invitation_operation_v2", "lock_invitation_claim_v2"]) {
        const index = body.indexOf(rowLock);
        if (index >= 0) expect(transition, `${name} takes the transition lock before ${rowLock}`).toBeLessThan(index);
      }
    }
  });

  it("places the transition lock inside the executable block of every procedure that takes it", () => {
    const source = migration();
    let covered = 0;
    for (const match of source.matchAll(/CREATE OR REPLACE FUNCTION invitation_protocol\.([a-z0-9_]+)\(.*?AS \$\$(.*?)\$\$;/gs)) {
      const [, name, body] = match;
      const lock = body.indexOf("lock_global_security_transition_v1();");
      if (lock < 0) continue;
      covered += 1;
      const begin = /\bBEGIN\b/.exec(body);
      const declare = /\bDECLARE\b/.exec(body);
      expect(begin, `${name} has an executable block`).not.toBeNull();
      // A statement emitted before BEGIN, or ahead of a DECLARE section, is invalid PL/pgSQL and
      // fails at CREATE FUNCTION rather than at runtime.
      expect(lock, `${name} locks inside its executable block`).toBeGreaterThan(begin!.index + begin![0].length - 1);
      if (declare) expect(lock, `${name} locks after its DECLARE section`).toBeGreaterThan(declare.index);
    }
    expect(covered).toBe(32);
  });

  it("grants execute on every canonical helper a security-invoker trigger calls from invitation paths", () => {
    const source = migration();
    // These run as the invitation protocol owner because their calling triggers are security invoker.
    // Several fire only as deferred constraint triggers at commit, so a missing grant surfaces as a
    // late insufficient-privilege failure rather than at the originating statement.
    for (const signature of [
      'public."assert_global_security_binding_current_authorization"(TEXT,TEXT,TEXT,TEXT,"GlobalSecurityOperationKey",INTEGER,INTEGER)',
      'public."assert_global_security_stale_finalization"(TEXT,TEXT,TEXT,TEXT,"GlobalSecurityOperationKey",INTEGER,INTEGER)',
      'public."assert_recovery_code_set_issuance_authorization"(TEXT,TEXT,TEXT,INTEGER,INTEGER,"FreshAuthGrantState")',
      'public."assert_recovery_session_expiry_finalization"(TEXT,TEXT,TEXT)',
      'public."assert_session_revoke_success_finalization"(TEXT,TEXT,"GlobalSecurityOperationBinding")',
      'public."global_security_terminal_outcome_valid"("GlobalSecurityOperationKey","GlobalSecurityOperationStatus",TEXT)',
      'public."lock_global_security_operation_identity_v1"(TEXT,TEXT)'
    ]) {
      expect(source, `${signature} is executable by the invitation protocol owner`)
        .toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO invitation_protocol_owner_NOLOGIN;`);
    }
  });

  it("runs commit-time deferred guards as definer so execute-only invitation roles can satisfy them", () => {
    const source = migration();
    // A deferred constraint trigger fires at COMMIT, outside the calling SECURITY DEFINER procedure,
    // so CURRENT_USER is the session role. The invitation login roles are execute-only with no table
    // rights, so a security-invoker guard cannot read the relations it validates and raises 42501.
    // The canonical throttle-core migration already established this definer pattern for its own
    // finalization guards; these three were simply never reached before the invitation bridge.
    for (const name of [
      "enforce_recovery_code_set_exact_ten",
      "enforce_recovery_code_set_issuance_finalization",
      "enforce_recovery_session_consumption_binding"
    ]) {
      expect(source, `${name} runs as definer at commit time`)
        .toContain(`ALTER FUNCTION public."${name}"() SECURITY DEFINER;`);
      // Definer without a pinned search path would be unsafe.
      expect(source, `${name} keeps a fixed search path`)
        .toContain(`ALTER FUNCTION public."${name}"() SET search_path = pg_catalog, public;`);
    }
  });

  it("leaves no commit-time deferred guard as security invoker on any relation invitation mutates", () => {
    const source = migration();
    const canonical = canonicalMigrations();
    const Q = '"';
    const between = (text: string, from: number, open: string, close: string) => {
      const a = text.indexOf(open, from);
      if (a < 0) return null;
      const b = text.indexOf(close, a + open.length);
      return b < 0 ? null : { value: text.slice(a + open.length, b), end: b };
    };

    // Functions that execute as their owner rather than the calling session role.
    const definer = new Set<string>();
    for (const chunk of canonical.split("CREATE ").slice(1)) {
      const head = chunk.startsWith("OR REPLACE FUNCTION ") ? chunk.slice(20) : chunk.startsWith("FUNCTION ") ? chunk.slice(9) : null;
      if (head === null || !head.startsWith(Q)) continue;
      const name = between(head, 0, Q, Q);
      const bodyAt = head.indexOf("AS $$");
      if (!name || bodyAt < 0) continue;
      if (head.slice(0, bodyAt).includes("SECURITY DEFINER")) definer.add(name.value);
    }
    for (const chunk of (canonical + source).split("ALTER FUNCTION public.").slice(1)) {
      const name = between(chunk, 0, Q, Q);
      const stop = chunk.indexOf(";");
      if (name && stop > 0 && chunk.slice(0, stop).includes("SECURITY DEFINER")) definer.add(name.value);
    }

    // Every public relation any invitation procedure mutates.
    const mutated = new Set<string>();
    for (const verb of ["INSERT INTO public.", "UPDATE public.", "DELETE FROM public."]) {
      let at = source.indexOf(verb);
      while (at >= 0) {
        const name = between(source, at + verb.length - 1, Q, Q);
        if (name) mutated.add(name.value);
        at = source.indexOf(verb, at + verb.length);
      }
    }
    expect(mutated.size).toBeGreaterThan(0);

    // A deferred constraint trigger runs at COMMIT, after the calling definer procedure has returned,
    // so CURRENT_USER is the session role. Invitation sessions are execute-only login roles with no
    // table rights, so any such guard must be definer or it fails closed with insufficient privilege.
    const invoker: string[] = [];
    for (const chunk of canonical.split("CREATE CONSTRAINT TRIGGER ").slice(1)) {
      const statement = chunk.slice(0, Math.max(chunk.indexOf(";"), 0));
      if (!statement.includes("DEFERRABLE INITIALLY DEFERRED")) continue;
      const table = between(statement, statement.indexOf("ON "), Q, Q);
      const fn = between(statement, statement.indexOf("EXECUTE FUNCTION "), Q, Q);
      if (table && fn && mutated.has(table.value) && !definer.has(fn.value)) invoker.push(table.value + " -> " + fn.value);
    }
    expect(invoker, "commit-time guards on invitation-mutated relations must run as definer").toEqual([]);
  });

  it("fixes the search path of every canonical trigger function invoked from invitation-only procedures", () => {
    const source = migration();
    for (const name of [
      "enforce_account_security_version_transition", "enforce_global_security_binding_write_once", "enforce_global_security_operation_write_once",
      "enforce_recovery_code_initial_state", "enforce_recovery_code_set_exact_ten", "enforce_recovery_code_set_issuance_finalization",
      "enforce_recovery_code_set_transition", "enforce_recovery_code_transition", "enforce_recovery_enrollment_failure_finalization",
      "enforce_recovery_enrollment_success_finalization", "enforce_recovery_session_consumption_binding", "enforce_recovery_session_transition",
      "guard_global_security_event_insert", "guard_global_security_operation_insert", "lock_global_security_transition_v1",
      "prevent_global_security_event_mutation"
    ]) {
      expect(source, `${name} keeps a fixed search path when invoked under invitation-only paths`)
        .toContain(`ALTER FUNCTION public."${name}"() SET search_path = pg_catalog, public;`);
    }
  });
});

describe("server-held recovery enrollment mapping authorization", () => {
  it("publishes an authorization procedure that reads the bridge mapping without canonical mutation", () => {
    const source = migration();
    const body = procedureBody(source, "authorize_invitation_recovery_enrollment_fresh_auth_v2");
    expect(body).toContain('bridge_row."globalSecurityOperationId"');
    expect(body).toContain('"subjectUserId"<>(request_attestation).subject_user_id');
    expect(body).toContain('"ordinarySessionId"<>(request_attestation).ordinary_session_id');
    expect(/(INSERT INTO|UPDATE|DELETE FROM)\s+public\./.test(body)).toBe(false);
    expect(source).toContain("'authorize_invitation_recovery_enrollment_fresh_auth_v2'");
    expect(source).toMatch(/FUNCTION invitation_protocol\.authorize_invitation_recovery_enrollment_fresh_auth_v2[^$]+SET search_path=pg_catalog,invitation_protocol/);
  });

  it("keeps the disposable grant contract counting the new runtime procedure", () => {
    const harness = readFileSync(fileURLToPath(new URL("../../../scripts/p1-3-invitation.acceptance-rehearsal.ts", import.meta.url)), "utf8");
    expect(harness).toContain("'authorize_invitation_recovery_enrollment_fresh_auth_v2'");
    expect(harness).toContain('if (grants !== "33|33")');
    const granted = [...migration().matchAll(/runtime_procedures TEXT\[\]:=ARRAY\[(.*?)\];/gs)][0]?.[1] ?? "";
    // Every granted runtime procedure plus the separately granted corridor classifier.
    expect([...granted.matchAll(/'([a-z0-9_]+)'/g)].length + 1).toBe(33);
  });

  it("rejects a browser-supplied mapping that differs from the server-held identity before any grant exists", async () => {
    const { authorizedRecoveryEnrollmentGrantIdentity } = compiledDeclarations(routePath, ["recoveryGrantIdentityPattern", "authorizedRecoveryEnrollmentGrantIdentity"]);
    const server = "gso_abcdefghjkmnpqrstvwxyz2345";
    const authorize = vi.fn(async () => ({ operationId: "op-1", status: "authorized", globalSecurityOperationId: server }));

    expect(await authorizedRecoveryEnrollmentGrantIdentity(authorize, { operationId: "op-1", request: {}, supplied: server })).toBe(server);
    expect(await authorizedRecoveryEnrollmentGrantIdentity(authorize, { operationId: "op-1", request: {}, supplied: "gso_zzzzzzzzzzzzzzzzzzzzzzzzzz" })).toBe(null);
    expect(await authorizedRecoveryEnrollmentGrantIdentity(authorize, { operationId: "other", request: {}, supplied: server })).toBe(null);
    expect(await authorizedRecoveryEnrollmentGrantIdentity(async () => ({ operationId: "op-1", globalSecurityOperationId: "not-a-gso" }), { operationId: "op-1", request: {}, supplied: "not-a-gso" })).toBe(null);
    expect(await authorizedRecoveryEnrollmentGrantIdentity(async () => null, { operationId: "op-1", request: {}, supplied: server })).toBe(null);
  });

  it("authorizes the server mapping before issuing the canonical grant and never issues on mismatch", async () => {
    const source = readFileSync(routePath, "utf8");
    expect(source.indexOf("authorizedRecoveryEnrollmentGrantIdentity")).toBeLessThan(source.indexOf("issueFreshAuthGrantForCurrentPassword(prisma"));
    expect(source).toContain("operationId: authorizedGlobalSecurityOperationId");
  });
});

describe("canonical recovery issuance effects", () => {
  it("orders set creation, ten code inserts, then grant consumption, and closes restricted reset carriers", () => {
    const body = procedureBody(migration(), "submit_invitation_recovery_enrollment_v2");
    const set = body.indexOf('INSERT INTO public."RecoveryCodeSet"');
    const codes = body.indexOf('INSERT INTO public."RecoveryCode"');
    const consume = body.indexOf('UPDATE public."FreshAuthGrant" SET "state"=\'consumed\'');
    expect(set).toBeGreaterThanOrEqual(0);
    expect(codes).toBeGreaterThan(set);
    expect(consume).toBeGreaterThan(codes);
    expect(body).toContain("'recovery_set_regenerated'");
    expect(body).toContain('UPDATE public."RecoverySession" SET "state"=\'closed\'');
    expect(body.indexOf("'recovery_set_regenerated'")).toBeLessThan(set);
  });

  it("writes exactly the canonical private issuance event once the set is complete", () => {
    const body = procedureBody(migration(), "submit_invitation_recovery_enrollment_v2");
    const event = body.indexOf("'recovery','code_set_generated'");
    expect(event).toBeGreaterThan(body.indexOf('UPDATE public."FreshAuthGrant" SET "state"=\'consumed\''));
    expect(body.split("'recovery','code_set_generated'").length - 1).toBe(1);
  });
});

describe("rehearsal persisted set states", () => {
  it("uses persisted PostgreSQL enum labels and forbids the rehearsal_required self-transition", () => {
    const body = procedureBody(migration(), "reserve_invitation_recovery_rehearsal_v2");
    expect(body).not.toContain("'saveAcknowledged'");
    expect(body).not.toContain("'rehearsalRequired'");
    expect(body).toContain("'save_acknowledged'");
    expect(body).toContain("'rehearsal_required'");
    const selfTransition = /SET "state"='rehearsal_required'[^;]*"state" IN \('save_acknowledged','rehearsal_required'\)/;
    expect(selfTransition.test(body)).toBe(false);
    expect(procedureBody(migration(), "submit_invitation_recovery_rehearsal_v2")).toContain("set_row.\"state\"<>'rehearsal_required'");
  });
});

describe("browser fixture credential accounts", () => {
  it("seeds credential accounts the way the invitation protocol does, so Better Auth can find them", () => {
    const fixtures = readFileSync(fileURLToPath(new URL("../../../scripts/p1-3-invitation-browser-fixtures.ts", import.meta.url)), "utf8");
    // The invitation protocol writes accountId equal to the user id for a credential account. A
    // fixture that invents a different accountId cannot be found by credential sign-in, which
    // surfaces only as a generic 401 once a flow actually signs that account in.
    expect(migration()).toContain("created_user_id,'credential',created_user_id");
    expect(fixtures).toContain("accountId: userId");
    expect(fixtures).toContain("accountId: issuer.userId");
    for (const invented of ["p13_browser_existing_credential_", "p13_browser_owner_credential_"]) {
      expect(fixtures, `${invented} is not a valid credential accountId`).not.toContain(`accountId: \`${invented}`);
    }
  });
});

describe("existing-recipient browser flow classification", () => {
  it("names its own failing stage instead of surfacing a bare CDP code", () => {
    const harness = readFileSync(fileURLToPath(new URL("../../../scripts/p1-3-invitation.acceptance-rehearsal.ts", import.meta.url)), "utf8");
    // The existing-recipient flow previously had no stage tracking, so any failure inside it reduced
    // to the generic browser CDP code and identified nothing.
    for (const stage of ["claim", "geometry", "sign_in", "acceptance"]) {
      expect(harness, `existing recipient ${stage} is a fixed category`)
        .toContain(`"p1_3_invitation_acceptance_browser_existing_recipient_${stage}_failed"`);
    }
    for (const stage of ["recovery_generate", "recovery_copy", "recovery_confirm", "invitation_accept", "post_accept_navigation"]) {
      expect(harness, `existing recipient acceptance ${stage} is a fixed category`)
        .toContain(`"p1_3_invitation_acceptance_browser_existing_recipient_acceptance_${stage}_failed"`);
    }
    expect(harness).toContain("p13InvitationExistingRecipientWorkflowFailureCode(stage, error)");
    expect(harness).toContain('rehearseAndAcceptP13Invitation(client, recipient, true, true, "existing_recipient")');
    // The new-user flow keeps its own prefix, so the two flows stay distinguishable.
    expect(harness).toContain('flow === "new_user" ? p13InvitationNewUserAcceptanceFailureCode(stage, error) : p13InvitationExistingRecipientAcceptanceFailureCode(stage, error)');
  });
});

describe("recovery rehearsal reservation", () => {
  it("returns every field the route needs to verify the typed code and sign the attestation", () => {
    const body = procedureBody(migration(), "reserve_invitation_recovery_rehearsal_v2");
    for (const field of ["operationIdentityId", "credentialVersion", "sessionSecurityVersion", "recoverySetVersion", "salt", "derivedKey", "kdfVersion"]) {
      expect(body, `reserve returns ${field}`).toContain(`'${field}'`);
    }
    // Byte fields cross the JSONB boundary as hex so the service can rebuild exact Buffers.
    expect(body).toContain("encode(challenge_row.\"nonce\",'hex')");
    expect(body).toContain("encode(code_row.\"salt\",'hex')");
    expect(body).toContain("encode(code_row.\"derivedKey\",'hex')");
    // Both the idempotent re-reservation and the first reservation must carry the same shape.
    expect(body.split("jsonb_build_object('operationId',operation_id,'status','prepared'").length - 1).toBe(2);
  });

  it("rebuilds exact buffers so the reservation passes the route guard", async () => {
    const nonce = Buffer.alloc(32, 3), salt = Buffer.alloc(16, 4), derivedKey = Buffer.alloc(32, 5);
    const runtime = { $queryRaw: vi.fn().mockResolvedValue([{ receipt: {
      operationId: "11111111-1111-4111-8111-111111111111", status: "prepared",
      operationIdentityId: "22222222-2222-4222-8222-222222222222",
      credentialVersion: 2, sessionSecurityVersion: 3, recoverySetVersion: 4, kdfVersion: 1,
      nonce: nonce.toString("hex"), salt: salt.toString("hex"), derivedKey: derivedKey.toString("hex")
    } }]) };
    const carrier = { keyVersion: 1, nonce: Buffer.alloc(32), issuedAt: new Date(), mac: Buffer.alloc(32) };
    const services = createInvitationServices({ runtime, expiry: runtime, maintenance: runtime, signer: { signRequest: vi.fn(() => carrier) } as never });
    const reserved = await services.rehearsal.reserve({ operationId: "11111111-1111-4111-8111-111111111111", selectedRecoveryCodeId: "code-1", acknowledgement: "I SAVED MY RECOVERY CODES", request: {
      ordinarySessionId: "s", subjectUserId: "u", issuerMembershipEpisodeId: null, subjectMembershipEpisodeId: null,
      openingFingerprint: Buffer.alloc(32, 1), intentFingerprint: Buffer.alloc(32, 2)
    } }) as Record<string, unknown>;
    expect(Buffer.isBuffer(reserved.nonce) && (reserved.nonce as Buffer).equals(nonce)).toBe(true);
    expect(Buffer.isBuffer(reserved.salt) && (reserved.salt as Buffer).equals(salt)).toBe(true);
    expect(Buffer.isBuffer(reserved.derivedKey) && (reserved.derivedKey as Buffer).equals(derivedKey)).toBe(true);
    expect(reserved.kdfVersion).toBe(1);
  });

  it("never returns verifier material to the browser", () => {
    const source = readFileSync(routePath, "utf8");
    const reserveResponse = source.slice(source.indexOf('if (route === "recovery-rehearsal-reserve")'), source.indexOf('if (route === "recovery-rehearsal-submit")'));
    expect(reserveResponse).toContain("nonce: reservation.nonce.toString(\"base64url\")");
    for (const secret of ["salt", "derivedKey"]) {
      expect(reserveResponse, `${secret} stays server-side`).not.toContain(`${secret}:`);
    }
  });
});

describe("issuance attestation carrier", () => {
  it("bounds every signed version so the reconstructed vector cast cannot overflow", () => {
    const carrier = procedureBody(migration(), "reauthorize_invitation_carrier_v2");
    expect(carrier).toContain("cubby.invitation.recovery-enrollment-attestation.v1");
    expect(carrier).toContain("^recovery-v1:[1-9][0-9]{0,8}:[1-9][0-9]{0,8}:[1-9][0-9]{0,8}:[0-9a-f]{64}$");
  });
});

describe("lost-response recovery submit", () => {
  const request = {
    ordinarySessionId: "session-1", subjectUserId: "user-1", issuerMembershipEpisodeId: null, subjectMembershipEpisodeId: null,
    openingFingerprint: Buffer.alloc(32, 1), intentFingerprint: Buffer.alloc(32, 2)
  };
  const carrier = { keyVersion: 1, nonce: Buffer.alloc(32), issuedAt: new Date(), mac: Buffer.alloc(32) };
  const signer = { signRequest: vi.fn(() => carrier), signRecoveryIssuance: vi.fn(() => ({ ...carrier, target: "recovery-v1:1:1:1:" + "aa".repeat(32) })) };
  const operationId = "11111111-1111-4111-8111-111111111111";
  const records = Array.from({ length: 10 }, (_, index) => ({ codeId: `code-${index + 1}`, ordinal: index + 1, salt: Buffer.alloc(16, index + 1), derivedKey: Buffer.alloc(32, index + 1), kdfVersion: 1 as const }));

  it("never mints another verifier batch for an already terminal issuance", async () => {
    const runtime = { $queryRaw: vi.fn().mockResolvedValue([{ receipt: { operationId, status: "generated", outcomeCode: "recovery_codes_generated", credentialVersion: 1, sessionSecurityVersion: 1, recoverySetVersion: 2 } }]) };
    const prepareBatch = vi.fn(async () => ({ records, digest: Buffer.alloc(32, 9), codes: [] }));
    const services = createInvitationServices({ runtime, expiry: runtime, maintenance: runtime, signer: signer as never });
    const receipt = await services.recoveryEnrollment.submit({ operationId, request, prepareBatch });
    expect(prepareBatch).not.toHaveBeenCalled();
    expect(runtime.$queryRaw.mock.calls.length).toBe(1);
    expect(receipt).toMatchObject({ operationId, status: "generated" });
    expect(JSON.stringify(receipt)).not.toContain("displayOnce");
  });

  it("fails closed with a safe receipt when authenticated status is not usable", async () => {
    // The protocol denies neutrally. Throwing a bare error here would break the neutral-denial
    // contract the runtime probe asserts, and would surface as an unclassifiable probe failure.
    for (const status of ["unavailable", "unknown", "abandoned", "completed"]) {
      const runtime = { $queryRaw: vi.fn().mockResolvedValue([{ receipt: { operationId, status } }]) };
      const prepareBatch = vi.fn(async () => ({ records, digest: Buffer.alloc(32, 9), codes: [] }));
      const services = createInvitationServices({ runtime, expiry: runtime, maintenance: runtime, signer: signer as never });
      const receipt = await services.recoveryEnrollment.submit({ operationId, request, prepareBatch }) as Record<string, unknown>;
      expect(receipt?.status, `${status} denies neutrally`).toBe("unavailable");
      expect(receipt?.operationId).toBe(operationId);
      expect(prepareBatch, `${status} mints no verifier batch`).not.toHaveBeenCalled();
      expect(runtime.$queryRaw.mock.calls.length, `${status} issues no submit query`).toBe(1);
      expect(JSON.stringify(receipt)).not.toContain("codeEntries");
    }
  });

  it("fails closed when the authorized issuance versions are not safe integers", async () => {
    for (const bad of [0, -1, 1.5, 2 ** 31, "3"]) {
      const runtime = { $queryRaw: vi.fn().mockResolvedValue([{ receipt: { operationId, status: "prepared", credentialVersion: 1, sessionSecurityVersion: 1, recoverySetVersion: bad } }]) };
      const prepareBatch = vi.fn(async () => ({ records, digest: Buffer.alloc(32, 9), codes: [] }));
      const services = createInvitationServices({ runtime, expiry: runtime, maintenance: runtime, signer: signer as never });
      const receipt = await services.recoveryEnrollment.submit({ operationId, request, prepareBatch }) as Record<string, unknown>;
      expect(receipt?.status, `version ${String(bad)} denies neutrally`).toBe("unavailable");
      expect(prepareBatch).not.toHaveBeenCalled();
    }
  });

  it("mints exactly one batch for a prepared issuance and submits that same batch", async () => {
    const runtime = { $queryRaw: vi.fn()
      .mockResolvedValueOnce([{ receipt: { operationId, status: "prepared", credentialVersion: 1, sessionSecurityVersion: 1, recoverySetVersion: 1 } }])
      .mockResolvedValueOnce([{ receipt: { operationId, status: "generated", displayOnce: true } }]) };
    const prepareBatch = vi.fn(async () => ({ records, digest: Buffer.alloc(32, 9), codes: [] }));
    const services = createInvitationServices({ runtime, expiry: runtime, maintenance: runtime, signer: signer as never });
    await services.recoveryEnrollment.submit({ operationId, request, prepareBatch });
    expect(prepareBatch).toHaveBeenCalledTimes(1);
    expect(runtime.$queryRaw.mock.calls.length).toBe(2);
  });
});
