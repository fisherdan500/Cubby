# Admin-assisted accounts phase one

This is a design-only phase for two Members & Access actions: an authorized owner or admin may create a new credential-backed household member, and may replace the password of an eligible existing member. It does not implement code or migrations, add public signup or emailed recovery, adopt an existing account, replace invitations, or change offline behavior. The normative contract is [`admin-assisted-accounts-protocol.json`](admin-assisted-accounts-protocol.json).

## Decisions

- `memberAccountCreate` / `member.account.create` and `memberPasswordReset` / `member.password.reset` are the only new browser-operation keys. Their enum-only migration precedes migrations that use them. Existing Browser V2 and Global Security self-password-change behavior remain the substrates.
- Owners may create or reset admins, parents, caretakers, and read-only members. Admins may create or reset only parents, caretakers, and read-only members. The household owner, platform owner, actor's own user ID, removed target, and any reset target with another nondeleted membership are denied. The cross-household predicate deliberately ignores membership suspension and household deletion.
- Assisted create accepts only a new normalized email. An existing email terminates as `existing_account_invitation_required`, with no identity, credential, membership, assisted-state, or audit effect. It points only to the retained invitation workflow.
- Assisted create writes `User.emailVerified = false`. `src/lib/auth/auth.ts` enables email/password sign-in without `requireEmailVerification`, so that account can sign in; the false value remains security-significant because `src/server/services/households.ts` and `src/server/services/platform-owner-binding.ts` keep their verified-mailbox guards. Unchecked create signs in normally, validates the immutable assisted-origin membership, selects it, and reaches `/app`.
- Both checkboxes default off. Checked create/reset binds the requirement to the new credential version. Unchecked assisted reset is an expressly authorized clear for that replacement credential. No form, route, or general flag setter may update the requirement directly.
- The truthful reset denial is “For privacy, this password cannot be reset here. Personal emailed recovery is not available yet.” Phase one has no fake recovery link. Invitation and offline recovery data and paths remain present and unchanged.
- Password and confirmation exist only in request memory. Confirmation is dropped after equality validation. The salted replacement hash is computed before the transaction; only SHA-256 of that random salted hash is attested and retained as credential evidence. Plaintext, confirmation, plaintext digests, or a usable verifier never enter browser storage, audit, operation payloads, or receipts.

### Required-change transition matrix

Any nonnull `AssistedAccountState.requiredChangeCredentialVersion` is restricted, including an invalid or mismatched value. Failing closed avoids turning corrupted state into ordinary access.

Credential-version advance first rebinds any existing requirement to the new current version inside the same canonical transaction. Checked assisted replacement then sets it to the new version; unchecked assisted replacement clears it only within the completed assisted closure. Existing offline recovery preserves and rebinds it. A canonical self password change may clear it only after the existing `PasswordChangeCredentialMutation` created by `apply_password_change_credential_mutation`, completed `password_change/changed` operation, terminal binding, current version attribution, and matching account are all proven by the deferred closure. The existing receipt has no password-hash field, so this design does not invent one. Any future credential writer must preserve and rebind or be rejected by the guard.

The restricted self-change path additionally calls Better Auth's `verifyPassword` against the current stored hash with the proposed replacement. `node_modules/@better-auth/utils/dist/password.node.mjs` normalizes through NFKC for both hashing and verification. Wrong current password, confirmation mismatch, or a replacement that is equivalent after NFKC leaves the obligation intact; a genuinely different replacement completes the canonical atomic transition and clears it. Ordinary self-change behavior is not broadened by this phase.

## Source integration

### Locking and browser operations

`src/server/services/browser-operations.ts` currently accesses the operation identity or binding before `preActorLock`, so `preActorLock` cannot satisfy the required order. The two assisted keys receive an earlier `preIdentityLock` on reserve, submit, status, and abandon. It runs before operation identity or binding access; other keys retain their existing hook.

The assisted order is exact: acquire `global-security-transition:v1`, take `LOCK TABLE "HouseholdMember" IN EXCLUSIVE MODE NOWAIT`, then acquire every potentially conflicting platform, user, security-state, credential, Session, SessionSecurityActivity, grant, recovery, member, household, and existing browser-operation row lock with NOWAIT in the protocol's deterministic order. Existing parent rows needed by FK checks are prelocked with `FOR KEY SHARE NOWAIT`; updated/deleted rows use `FOR UPDATE NOWAIT`. Rows created by the same transaction need no second lock. A create email absence remains protected by the unique constraint and Serializable retry.

This resolves the concrete inversion in which an ordinary writer holds Session and waits for HouseholdMember while assisted work holds the member-table fence and wants Session: assisted work never waits for that Session. Narrow fixed-search-path definer helpers `lock_actor_session_for_assisted_operation_nowait` and `lock_user_sessions_for_assisted_operation_nowait` are added beside, not substituted for, the blocking helpers in `prisma/migrations/20260916120000_actor_session_lock_function/migration.sql`; runtime never gets raw Session `FOR UPDATE`. SQLSTATE `55P03`, `40001`, and `40P01` roll back and retry the whole Serializable transaction at most three attempts with 0/25/75 ms backoff. Status and abandon use the same order and terminal replay does not apply a stale mutable-version predicate.

The acceptance race pauses an ordinary writer after its Session lock, starts assisted work, observes the assisted NOWAIT rollback, releases the writer, and then proves both operations can complete on retry without an unhandled deadlock. Hashing remains outside this lock window.

### Stable submitted intent

The salted replacement hash cannot identify a retried intent because it changes on every HTTP request. Before the generic browser fingerprint, the server therefore computes a domain-separated HMAC-SHA-256 commitment with `configuredGlobalSecurityThrottleKey()` and domain `cubby.admin-assisted-browser-intent.v1`. `CUBBY_THROTTLE_KEY` is already a stable 32-byte configured key with no normal rotation path; no new secret is added, and absence fails closed.

The length-framed commitment covers operation ID, household, actor user/session/member, operation key, canonical target, normalized email, exact trimmed name, database role literal, checkbox byte, and NFKC UTF-8 password bytes as applicable. Confirmation is excluded. Its domain differs from throttle identifiers, credential evidence, and fresh-auth attestations. Only the keyed commitment plus nonsecret canonical fields reaches `browserIntentFingerprint`; it is never a password verifier endpoint input.

The client retains only operation ID, opening fingerprint, and nonsecret draft identity in session storage. Passwords remain in memory. Identical retry fields produce the same commitment; any changed password, checkbox, name, email, or role conflicts rather than acknowledging a newer edit. Status needs no password. After navigation, an unsubmitted binding asks for password re-entry or explicit abandon/new draft and never guesses or automatically resets.

### Reset, recovery carriers, and version attribution

Reset advances both versions and sets both `lastCredentialOperationId` and `lastSessionSecurityOperationId` to the assisted `bmo_…` ID in the transaction that writes the replacement hash, checkbox result, receipt, audit, and terminal browser result. It revokes target Sessions, active SessionSecurityActivity, and issued grants.

After the version update makes every restricted recovery carrier stale, each is closed through its own legal lifecycle in this order: terminalize its own `GlobalSecurityOperation` as `stale/stale_security_version`; terminalize its own `GlobalSecurityOperationBinding`; update the retained `RecoverySession` from `restricted` to `closed`; and write its content-free `operation_outcome/stale_security_version` event. This is the sequence used by `src/server/services/recovery-lifecycle.ts` around the stale finalization and is required by the guards in `prisma/migrations/20260824140000_global_security_foundation/migration.sql`. Recovery codes, sets, and history remain. Any associated guard failure rolls back the entire assisted reset.

### Persistence, closure, retention, and replay

`AssistedCredentialMutation`, `AssistedAccountState`, and the six Session proof columns use the exact SQL types, nullability, keys, checks, and lifecycle listed in the protocol. The receipt has one live FK only: `targetUserId -> User(id) ON DELETE/UPDATE CASCADE`. The state has one live FK only: its `userId` PK to User with the same actions. Actor, Session, member, household, account, binding, and assisted-origin identifiers are immutable historical snapshots, so ordinary revocation, removal, deletion, or Browser V2 compaction neither deletes nor mutates the evidence. Removed origin membership is retained as a snapshot and the bridge fails closed on current reauthorization; origin reassignment or adoption is impossible.

Ordinary UPDATE, DELETE, and TRUNCATE are blocked. The only assisted receipt/state delete is the existing disabled User hard-delete lifecycle's FK cascade, proven by the retention trigger observing the parent already absent; no purge API is added. Logical household backup excludes assisted state, receipts, proofs, full operations, and tombstones. Full-system recovery includes them.

Browser full results retain the existing 30-day compaction. The guarded compactor inserts the exact content-free tombstone and deletes the matching full operation/binding in one transaction. The retained assisted receipt has no FK to either representation, so it neither blocks compaction nor disappears. Historical status proves a result from the terminal binding/full operation plus receipt, or their exact tombstone/receipt handoff.

Closure is bidirectional. `AssistedCredentialMutation_success_closure` is an AFTER INSERT DEFERRABLE INITIALLY DEFERRED constraint trigger; `BrowserMutationOperation_assisted_receipt_closure` is an AFTER INSERT OR UPDATE DEFERRABLE INITIALLY DEFERRED constraint trigger for a completed assisted key. At commit they prove exactly one receipt, exact binding/operation/actor/target/account/member/household identity, both version attributions, selected checkbox and origin state, current hash digest for commit only, all reset revocations/closures, and exactly one content-free audit. Direct SQL completion without a receipt, receipt without completion, checkbox/member mismatch, duplicate evidence, or partial reset rolls back.

Terminal replay is distinct from commit closure. It reauthorizes the current actor Session, membership, role/hierarchy, protected target rules, target scope, and cross-household denial, but never compares the target's current password hash, versions, or Session count to old receipt values. Later self-change, assisted reset, or sign-in cannot invalidate the historical outcome, repeat the mutation, or clear a newer requirement. Runtime has no receipt SELECT; `get_assisted_account_operation_status_v1` is an execute-only fixed-projection definer that returns no hash, MAC, or Session identifier. Existing-email rejection uses the proper deterministic terminal schema with zero effects.

### Authentication proof and restricted navigation

Installed Better Auth 1.6.19 verifies the password before `internalAdapter.createSession` in `node_modules/better-auth/dist/api/routes/sign-in.mjs`. Its internal adapter generates the token before the create hook; `node_modules/better-auth/dist/db/with-hooks.mjs` merges hook `{data}` into the insert; `parseSessionOutput` filters `returned: false`; email sign-in returns token and user, not a Session object. `src/lib/auth/auth.ts` wraps the complete Better Auth route handler in one `AsyncLocalStorage.run`, and the verifier wrapper stores only the successful purpose and SHA-256 of the exact stored hash in that request's store. Failed verification stores nothing.

The Session create-before hook binds user, generated-token digest, stored-hash digest, purpose, signed `TIMESTAMP(3)` issuedAt, 32-byte nonce, and key version into private `input: false, returned: false` fields. The HMAC frame encodes the PostgreSQL timestamp as signed i64 microseconds since 2000; millisecond precision makes the low three digits zero. The database accepts at most five seconds of future skew and ten minutes of age, with active or still-valid prior rotation key and unique nonce. New `cubby_auth` Session inserts require all fields. Null proof is confined to trusted existing rows and the existing email-rotation definer identity.

Assisted credential attestations are purpose-separated signers beside `src/server/services/fresh-auth-attestation.ts`, reuse its active/prior `CUBBY_FRESH_AUTH_ATTESTATION_KEYRING`, and sign issuedAt in the same finite freshness window. The restricted corridor invokes the existing canonical engine in `src/server/services/global-security.ts`; it does not add a credential writer or broad grant.

The lexically first Session proof trigger takes the global lock before checking the current stored credential hash. Sign-in first commits a Session that reset then deletes; reset first changes the hash so the old-password Session insert fails. Session, current-version SessionSecurityActivity, and sign-in-success event remain atomic.

`src/server/auth/session.ts` exposes a private classification of `ordinary`, `restricted`, or `unauthenticated`. Public/default `getSession` may return null for restricted identity, but `requireUserPage`, root, login, and app layout use the private classification to redirect direct app URLs, settings bookmarks, root, login, and reload to `/account/required-password-change` without a login loop. Root theme uses `DEFAULT_APPEARANCE_MODE` without reading private preference. Ordinary APIs return `password_change_required` without data.

The corridor allowlist is identity-only page/status, server-constant-purpose canonical self change, canonical exact-current-session sign-out, and minimal post-sign-in dispatch. It has no household context. Origin membership selection occurs only after restriction clears and the user signs in again. `src/server/auth/context.ts` and `src/server/services/invitation-setup-corridor.ts` remain unavailable while restricted.

### In-flight ordinary writes

A session classified ordinary before reset is not sufficient authorization for a later transaction. Browser writers use a closed server-derived `BrowserHouseholdWriteContext` with required Session ID. API-key and system writers have separate discriminants and existing capability validators; they cannot supply a fake or optional Session.

`src/server/services/mutation-locks.ts` calls `lock_actor_session_for_browser_write_v1` before the member lock. It locks/revalidates the Session, active SessionSecurityActivity, current session-security version, AccountSecurityState, and null required-change obligation; aged but otherwise current Sessions remain valid. Then it locks and revalidates membership. The protocol inventories every current `lockActorForWrite` caller in activities, audit reader, backups, export, integrations, households, and Sprout import, plus other browser writer families using BrowserOperationContext or account/global helpers. Account appearance and global/page mutation helpers enforce the corresponding carrier; the restricted exception is only canonical self change.

For `savePushSubscription`, write-first locks and commits the upsert before reset later revokes the Session. Reset-first makes Session/version/requirement revalidation fail before upsert, so a deleted or stale subscription cannot be resurrected.

## Hard source constraint

The current source has no safe adapter transaction spanning Better Auth password verification and Session insert. A before-hook read followed by an unbound insert is rejected. The signed stored-hash/token proof and earliest database trigger are therefore required. The assisted lock fence likewise cannot make a blocking call after taking its member-table lock: every potentially conflicting assisted row acquisition is NOWAIT and participates in whole-transaction retry. These are closed implementation decisions, not alternative sketches.

## Acceptance checklist

- [ ] Run the focused design contract RED before artifact repair, then GREEN with negative in-memory deletion and contradiction fixtures for every critical security section.
- [ ] Prove role matrix, protected targets, existing-email zero effects, `emailVerified=false`, exact origin-home navigation, and truthful no-email-recovery copy.
- [ ] Prove identical/lost-reply commitment replay; changed password, checkbox, name, email, or role conflict; and navigation never auto-submits without the password.
- [ ] Exercise the deterministic Session-first ordinary-writer versus assisted NOWAIT race and all `55P03`/serialization/deadlock whole-transaction retries.
- [ ] Prove reset's exact version attribution and legal closure of every pending restricted recovery carrier; inject every associated guard failure and require full rollback.
- [ ] Prove both deferred closure directions, exact identity/checkbox/origin equality, one audit, direct-SQL negative cases, and no-gap 30-day compaction with retained receipt.
- [ ] Prove checked reset → unchecked reset, checked reset → offline recovery → still restricted, self change after rebind, rollback does not clear, and later transitions do not corrupt historical replay.
- [ ] Prove wrong current, mismatched confirmation, and same NFKC password retain the obligation; a genuinely different password clears only with the canonical receipt.
- [ ] Prove direct app/settings/root/login/reload reach the corridor, theme fallback is public, ordinary APIs disclose no data, and no household context exists before clear.
- [ ] Prove every browser writer uses a server-derived Session carrier; API-key/system paths retain their validators; and push subscription write-first/reset-first has no resurrection.
- [ ] Exercise signed issuedAt age/future skew, 32-byte nonce uniqueness, active/prior key rotation, concurrent ALS isolation, both sign-in/reset orderings, and trusted legacy/email-rotation exceptions.
- [ ] Run the focused contract tests, `npx tsc --noEmit --incremental false`, and scoped lint. Implementation later must also run the full auth/role/database/browser acceptance gates named in the protocol before release.
- [ ] Freeze a fresh independent review, then require exact-head CI before publication.
