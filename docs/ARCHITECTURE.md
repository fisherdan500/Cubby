# Cubby Architecture

This document describes the current Cubby application structure for developers
and coding agents. It is intentionally implementation-oriented.

## Runtime Shape

Cubby is a Next.js App Router application deployed as a Docker Compose stack:

- `app`: Next.js standalone server on container port 3000.
- `postgres`: PostgreSQL 16 with the `cubby_postgres_data` named volume.

The production container runs `docker/entrypoint.sh`, which executes Prisma
migrations before starting the standalone Next server. Migration failure is a
hard startup boundary: the container exits and never reaches the server phase.
Sanitized `cubby_startup` phase markers provide operator-visible migration and
server progress without printing connection strings or credentials.

Startup provisions five isolated PostgreSQL principals: migration owner
`cubby_migrator`, ordinary application role `cubby_runtime`, restricted
`cubby_auth` identity/session persistence, and the narrow `cubby_email_delivery`
worker role, plus host-local `cubby_security_operator`. The operator can execute
only a fixed-search-path aggregate over incidents and has no table privileges,
role memberships, or app runtime connection. Better Auth can read the minimum identity records and persist Session
rows, while `cubby_runtime` can revoke or authorize sessions only through guarded
fixed-search-path procedures. Security-email recipients and message bodies
remain AES-256-GCM ciphertext until the dedicated worker claims them. That role
can execute claim/receipt procedures but cannot directly read or mutate the
outbox, key metadata, credential receipts, or account identity. Authenticated
TLS SMTP, exact-recipient 250 receipts, bounded database-clock retries, and
terminal ciphertext clearing are required; household backups exclude both the
delivery keyring and outbox rows.

### Global Security Phase 8 Candidate

Global sign-in throttling uses fixed database-clock windows for account,
client, and deployment identities. Incidents and failure evidence are one
serializable transaction. Successful credential evidence is a fixed-search-path
definer trigger on the Better Auth `cubby_auth` Session insert, so a session and
its evidence commit or roll back together. All `GlobalSecurityEvent` inserts
acquire the deployment transition advisory lock before identity allocation; the
private-history reader takes the same lock before its first-page maximum
sequence snapshot. Exports use a repeatable database snapshot. The
`cubby_security_operator` role can only call a content-free aggregate, launched
as a host-initiated child inside the app image, and has no Compose URL or table
access. The throttle key is startup-verified, never backed up/logged, and has no
rotation path until a maintenance gate. Phase 8 remains unreleased until Phase 9.

Docker Compose is the primary deployment path and has two distinct health
contracts. PostgreSQL liveness uses `pg_isready`; application readiness uses
`GET /api/health` inside the app container. That route performs a minimal Prisma
query and returns only `200 {"status":"ready"}` or a sanitized
`503 {"status":"unavailable"}`. The app depends on healthy PostgreSQL and does
not become healthy from HTTP reachability alone.

`scripts/update-preflight.ts` is the fail-closed, non-mutating normal-stack
inspection boundary. Its service discovery accepts both legacy JSON arrays and
Docker Compose 5.2 newline-delimited JSON objects before applying one strict
app/PostgreSQL state-and-health contract.
`scripts/backup-recovery-rehearsal.ts` owns the separately invoked disposable
fixed-baseline migration/update rehearsal. Operational
sequencing and forward-fix/restore boundaries are documented in
[Always-On Updates](ALWAYS_ON_UPDATES.md).

### Installability And Network Boundary

`public/manifest.webmanifest`, `src/components/pwa-register.tsx`, and
`public/sw.js` provide install metadata and a lightweight production
service-worker shell. Activity reads and writes still require network access;
Cubby does not implement an offline write queue, synchronization, or conflict
resolution. Offline expansion is intentionally deferred.

## Source Layout

- `src/app/app`: authenticated app pages such as Log Entry, Full Log, Calendar, Reports, Nursery, and Settings.
- `src/app/api`: HTTP route handlers for app actions, auth, exports, backups, hooks, notifications, timers, settings, and dashboard warnings.
- `src/components`: shared UI components and app shell pieces.
- `src/domain`: app-level domain constants such as roles and permissions.
- `src/lib`: shared runtime helpers, auth wiring, environment validation, Prisma client, and time utilities.
- `src/server/auth`: current-user and household context helpers.
- `src/server/services`: business logic used by pages and API routes.
- `src/app/api/invitations`: invitation protocol route handlers, each with an operation sidecar.
- `src/components/invitations`: invitation bootstrap, workflow, and manual management UI.
- `prisma`: Prisma schema, migrations, and seed script.

Pages and route handlers should stay thin. Put business rules, permission checks,
data shaping, and import/export behavior in `src/server/services`.

## Auth And Household Model

Cubby uses Better Auth with the Prisma adapter for users, sessions, accounts, and
verification records. The app's household model is separate from Better Auth:

- `Household` owns babies, members, activities, settings, API keys, webhooks, backups, imports, contacts, medicines, and calendar records.
- `HouseholdMember` connects a Better Auth user to a household role.
- Roles are `owner`, `admin`, `parent`, `caretaker`, and `read_only`.
- Permissions are defined in `src/domain/roles.ts`.

The first household creator is the protected owner and has full administrative
access. Owners can appoint delegated admins. Admins manage operational household
settings and lower-access members, but cannot change the owner or grant/revoke
Admin access. Parents can manage babies, notifications, exports, and activity;
caretakers manage their own activity; read-only members cannot write.

Server-side permission enforcement is required for every household-scoped read or
write. UI hiding is not enough.

Deployment-wide authority is separate from household membership:

- `PlatformAuthority` binds one explicit user as platform owner; household roles do
  not grant platform authority.
- `PlatformSettings` owns public-account registration and the `closed`,
  `invitation_only`, or `open` direct-household-creation policy. Missing or
  incomplete singleton rows fail closed.
- Membership invite tokens remain household-scoped. The retained future registration
  policy requires a submitted email to match an active invite case-insensitively and
  routes acceptance into the inviting household, but runtime signup is currently
  fail-closed until Cubby's complete initial-credential protocol is implemented.
- The retained first-account policy uses a PostgreSQL advisory lock; no current route
  exposes the password-signup writer.
  Direct household creation is serialized per user, rechecks membership inside the
  transaction, and holds a shared platform-settings lock while evaluating policy.
- Only the platform owner can change platform settings. Household owners and admins
  continue to manage household invitations under their household permissions.
- Platform-owner sessions remain valid without household membership. Both the
  application guard and PostgreSQL session-insert trigger recognize platform
  authority independently of household suspension state.

Settings pages are filtered by permission and guarded before household data is
loaded. Direct API and service calls remain authoritative; UI visibility is not
treated as an authorization boundary.

Better Auth sessions are personal to the signed-in user rather than household
resources. Any authenticated global user, including a user with no household,
can review only the privacy-minimized projection of their own sessions. Session
revocation requires explicit confirmation and a fresh current-password proof;
it does not derive authority from a household role or Better Auth `freshAge`.

Household member suspension is reversible and stored in
`HouseholdMember.disabledAt`; it does not delete the user, membership, role, or
history. Owners may suspend admins and lower roles, while admins may suspend only
lower roles. The protected owner and acting member cannot be suspended. Role,
removal, suspension, and restoration mutations lock the current actor and target
membership rows in deterministic order, re-read their current state, and enforce
the hierarchy inside the same transaction that writes the audit event.

Suspension is household-scoped. Request-time household resolution requires both
`deletedAt` and `disabledAt` to be null. A user with another active household
membership may still sign in, but cannot access a suspended household. A user
whose only current memberships are suspended receives exactly
`Your account is disabled.` after valid credential verification. Suspension
revokes all current user sessions. A PostgreSQL `Session` insert trigger takes
shared locks on current memberships so concurrent sign-in either commits first
and is revoked by suspension, or observes the suspension and is rejected. The
trigger's dedicated `CUB01` SQLSTATE is translated narrowly at the Better Auth
Prisma adapter boundary to the same `403 / ACCOUNT_DISABLED` response. Server
session reads also bypass Better Auth's cookie cache.

Lifecycle audits use `member.suspend` and `member.restore`. Duplicate requests
are idempotent after the locked current state is read and do not duplicate audit
events.

## Invitation Protocol v2 Candidate

Membership invitation, initial credential creation, and recovery readiness run
through the dedicated `invitation_protocol` PostgreSQL schema rather than
ordinary application SQL. Every operation is a fixed-search-path
`SECURITY DEFINER` procedure owned by the non-login role
`invitation_protocol_owner_NOLOGIN`. This program is not deployed: deployment,
cutover, and live invitation use are separately gated, and it is not released
behavior until then.

Three isolated login roles reach the schema, each with execute-only access to the
reviewed procedures for its purpose and no direct table rights:

- `cubby_invitation_runtime`: request-scoped invitation operations.
- `cubby_invitation_expiry_worker`: invitation expiry only.
- `cubby_invitation_maintenance_worker`: terminal operation compaction only.

Direct DML on `invitation_protocol` tables and direct reads of
`FreshAuthAttestationKey`, `RecoveryCodeSet`, and `RecoveryCode` are denied to all
three. The private audit helper is never granted to any login role; its effects
are reachable only through terminal guarded transitions.

### Operation Shape

Operations follow the established browser-operation pattern of reserve, submit,
status, and abandon against one client-supplied operation UUID, across the kinds
`PRESENTATION_CLAIM`, `MANUAL_INVITE_CREATE`, `MANUAL_INVITE_REPLACE`,
`CREDENTIAL_SETUP`, `RECOVERY_ENROLLMENT`, `RECOVERY_REHEARSAL`,
`MEMBERSHIP_ACCEPTANCE`, `INVITE_REVOKE`, and `INVITE_REVOKE_ALL`.

Each call carries a server-signed request attestation built from the fresh-auth
attestation keyring: session, subject, membership episodes, operation kind and
id, target, opening and intent fingerprints, purpose, nonce, and key version. The
procedure reverifies the MAC, re-reads the owning rows under lock, and records the
nonce in a replay registry, so a replayed carrier must match its stored
projection exactly or the operation conflicts. Route handlers stay thin; the
protocol is the authority.

### Token And Corridor Boundary

`/invite` receives the raw token only in the URL fragment.
`src/lib/invitation-token-cutover.ts` consumes the fragment and the browser
address is cleaned with `history.replaceState` before the single permitted
token-bearing request is issued. Only the token hash is persisted; no raw token
is stored, logged, or placed in a cookie. The claim reference lives in the
HttpOnly, `SameSite=Strict` `cubby_invitation_claim` cookie, and invitation
responses are `Cache-Control: no-store` with `Referrer-Policy: no-referrer`.

`classify_invitation_setup_corridor_v2` gates the corridor from an attestation-signed
session, returning exactly `setup_required`, `ordinary`, or `neutral`. It fails
neutral rather than disclosing whether an invitation exists. Generic sign-in
returns to `/invite/dispatch`, which binds the claim to the authenticated session
and forwards to review or to the app.

Recovery readiness and acceptance require an `InvitationAccountSetup` row anchored
to the invitation's lineage, with an immutable `accountOrigin`. Credential setup
creates it only for a new account (`invitation_created`); it never touches an
existing account, because that step is unauthenticated. An existing credentialed
account gets its row (`pre_existing`) only from `bind_post_signin_invitation_claim_v2`
after an authenticated, email-matched sign-in. The corridor always classifies a
pre-existing account as `ordinary`, even while an invitation claim is bound to it,
and an unbound open claim never changes anyone's classification, so an unfinished,
declined, revoked or expired invitation cannot remove an established member's
household access. Such a member completes recovery readiness and acceptance from
that ordinary session; the invitation procedures still authorize each step from the
bound setup row, operation binding, session and signed attestation.
A setup row already anchored to a different invitation fails the bind closed with the
neutral result; re-inviting such an account is not yet supported.

### Global Security Bridge

Recovery enrollment does not re-implement account security. Global Security
remains authoritative for fresh-authentication grants, recovery code sets and
codes, replay, and rehearsal terminalization. The bridge correlates the two
systems through `InvitationRecoveryEnrollmentBridge`, which holds a
server-created canonical `gso_…` operation identity alongside the invitation
operation. No invitation UUID is ever written into a canonical Global Security
operation field.

The enrollment sequence is reserve, server-held mapping authorization, fresh
password re-entry, bridge bind, then submit:

- The canonical operation identity is created by the server during reserve. A
  browser-supplied identity is authorized against the server-held mapping
  *before* any canonical grant exists, so a substituted identity mutates nothing.
- Fresh authentication is explicit password re-entry; framework freshness
  shortcuts are not accepted.
- Submit generates ten recovery codes as a verifier batch of salt, derived key,
  and KDF version with a batch digest. A dedicated issuance HMAC binds the
  credential version, session security version, recovery set version, and the
  verifier batch digest, and PostgreSQL reconstructs that vector before trusting
  it.
- An authenticated status that is not usable denies neutrally: submit returns the safe unavailable
  receipt rather than raising, so no verifier batch is minted and nothing is disclosed.
- Plaintext codes exist only in the response of the initial issuance. Replay
  returns authenticated status without redisclosure and never mints a second
  batch for the same issuance.
- Rehearsal consumes exactly one code, leaves nine active, and terminalizes the
  canonical issuance operation as `rehearsal_completed`.

### Lock Order And Invoked Graph

Canonical Global Security operations take the deployment transition advisory lock
before their first row lock. Invitation procedures row-lock the same canonical
state, so every bridged runtime procedure acquires that same
`global-security-transition:v1` lock first, before any invitation advisory lock or
row lock. Relying on the canonical statement triggers to acquire it later would
invert the order and deadlock.

Canonical guard triggers on the bridged relations are security invoker, so they
execute as the invitation protocol owner under the invitation-only search path.
The migration therefore pins a fixed search path on the invoked trigger graph and
grants the owner execute on the canonical assertion helpers those triggers call.
Several are deferred constraint triggers that only fire at commit, so a missing
grant surfaces as a late insufficient-privilege failure rather than at the
originating statement.

### Canonical Issuance Effects

Invitation submit mirrors the canonical `recovery-lifecycle.ts` sequence rather
than inventing a parallel one: close restricted reset carriers on a superseded
set, invalidate prior codes and sets, insert the new set, insert the ten codes,
consume the fresh-auth grant, then write exactly one private
`recovery`/`code_set_generated` event. The grant is consumed only once the
complete set exists, which is what the deferred issuance authorization requires
at commit.

### Acceptance-Only Diagnostics

The disposable acceptance runtime can observe why credential sign-in failed
without retaining request content. Behind two exact environment guards, the
sign-in throttle carrier reports one closed stage per request (for example
`lookup-miss`, `parse`, `invalid-credentials`, or the positive control
`handler-ok`), and `src/server/auth/acceptance-sign-in-rejection.ts` maps Better
Auth's fixed warnings to `user-not-found`, `credential-account-not-found`,
`password-not-found`, or `password-mismatch`. Outside those guards neither the
observer nor the logger is attached, and authentication responses never depend
on either.

## Data Model Overview

The Prisma schema uses PostgreSQL and keeps a household boundary on user-owned
data. Important model groups include:

- Auth: `User`, `Session`, `Account`, `Verification`.
- Platform: `PlatformAuthority`, `PlatformSettings`, `PlatformAuditEvent`.
- Household: `Household`, `HouseholdMember`, `Invite`, `HouseholdSettings`.
- Babies and tracking: `Baby`, `ActivityLog`, type-specific log tables, `Reminder`, `DashboardWarningDismissal`.
- Settings and admin: `AuditEvent`, `BackupRecord`.
- Integrations: `ApiKey`, `WebhookEndpoint`, `WebhookDelivery`.
- Notifications: `PushSubscription`, `NotificationPreference`, `NotificationLog`.
- Browser mutation infrastructure: `BrowserOperationBinding`, `BrowserMutationOperation`, and lifetime household operation tombstones. These rows are implementation/security state, not ordinary user history or logical household-export content.
- Invitation protocol (candidate, `invitation_protocol` schema): `InvitationLineage`, `InvitationOperationIdentity`, `InvitationPresentationClaim`, `InvitationOperationBinding`, `InvitationOperationResult`, `InvitationOperationTombstone`, `InvitationAccountSetup`, `InvitationRecoveryEnrollmentBridge`, `InvitationRecoveryRehearsalChallenge`, `InvitationProcedureTransitionBinding`, and `InvitationSetupCorridorAttestationReceipt`. These are protocol and security state, not ordinary household history or logical export content.
- Imports: `ImportBatch`, `ImportedRecord`.
- Reference and calendar data: `Contact`, `MedicineCatalog`, `CalendarEvent`, event join tables, `VaccineDocument`.

## Activity Pattern

Cubby uses `ActivityLog` as the aggregate record for tracked events. It stores
common fields such as household, baby, actor, type, start/end time, timezone,
notes, source, and external attribution. Type-specific tables extend the
aggregate for feature-specific details:

- Feeding, diaper, sleep, pumping, medicine, measurement, milestone, note, bath, play, mood, supplement, vaccine, and milk inventory records.

`Baby` lifecycle state is separate from deletion. `Baby.inactiveAt` removes a
baby from active tracking selectors and new activity/timer entry while
preserving history, edits, exports, reports, calendar visibility, and deletes.
Inactive babies therefore remain readable and correctable but cannot receive new
activities or resumed timers until reactivated.

Do not replace this with a separate-table-only model. New tracking types should
fit the aggregate pattern unless there is a clear architectural reason not to.

## Timezone And Date Rules

Timestamps are stored as instants in Prisma `DateTime` fields. User-facing date
grouping, selected-day ranges, reports, imports, and redirects use the app-level
`APP_TIMEZONE`.

Current rules:

- `APP_TIMEZONE` is set through Docker Compose and validated by `src/lib/env.ts`.
- New activity rows store `ActivityLog.timezone` from `APP_TIMEZONE`.
- Baby timezone columns are kept for compatibility but should not drive current date grouping.
- Sprout imports treat offset-less Sprout datetime strings as UTC instants, then Cubby displays and groups them with `APP_TIMEZONE`.
- Calendar-date-only values should remain stable as dates, not shifted into a different local day.

Use the existing time utilities and service helpers rather than hand-rolling date
math in pages.

## Feature Areas

### Appearance

Authenticated app routes are wrapped by `src/app/app/layout.tsx`, which resolves
the household accent and exposes it through `data-accent`. Semantic color tokens
in `src/styles/globals.css` provide light and dark palettes for the five curated
accent choices. Appearance changes go through `src/server/services/appearance.ts`
and require `household.manage`.

Personal appearance mode is separate global account state: `system`, `light`, or `dark`, defaulting to `system`. It is loaded independently of household selection and persisted through the separate account browser-operation ledger with Session/User reauthorization and revision compare-and-swap. `/account/appearance` remains available to authenticated users without a selected household. Signing out forces system/device behavior; Family accent remains household data and never supplies a personal mode.

Family accent and the complete household unit-preference document use the household browser-operation ledger. Their opening bindings freeze the selected household/member episode plus an absent-or-`updatedAt` HouseholdSettings snapshot; submission reauthorizes `household.manage`, replaces only the intended settings value under compare-and-swap, writes audit data atomically, and retains same-ID status/replay behavior. Neither setting may use the account operation ledger or silently merge stale form fields.

Notification preferences are one versioned complete document per exact active household-member episode. External delivery defaults off; the document has either `all` active babies or an explicit selected set, never both. Legacy ambiguity becomes inactive content-minimized needs-review evidence rather than a broader union. A later rejoin is a new episode and cannot inherit the former document. Current source work persists and reconciles the preference operation only; it does not deliver any external notification.

Activity recognition uses Cubby-original raster artwork under
`public/activity-art` through the shared `ActivityArtwork` component. Utility
actions such as navigation, settings, editing, and deletion continue to use
Lucide icons so controls remain familiar and accessible.

Cubby's fixed brand identity uses the original Cradle Cubby vector mark and the
shared `BrandMark`/`BrandLockup` components. Browser, Apple-touch, and maskable
PWA assets are generated from the SVG sources with `npm run brand:icons`. Brand
colors remain sage, ivory, and warm charcoal rather than following household
accent settings.

### Log Entry And Dashboard

`src/server/services/dashboard.ts` builds the Log Entry view: selected baby,
selected date, quick-action data, elapsed badges, daily summary, warning items,
active timers, and grouped timeline records.

Dashboard warnings are household-wide dismissible records keyed by baby, warning
type, and fingerprint. A warning reappears only when its underlying trigger
changes.

### Activities And Timers

`src/server/services/activities.ts` owns activity creation, updates, deletes,
undo behavior, timer transitions, and webhook/notification side effects. Pages
and API routes should call this service instead of writing activity tables
directly. Activity/timer writes lock and re-read the current actor membership
and baby inside the mutation transaction and fail closed when the baby is
Historical edits remain allowed for inactive babies, but editing must
not start or restart timers.

### Browser Mutation Operations

Ordinary household browser mutations use a versioned `bmo_` identity. Issuance stores a payload-free opening fingerprint over the current household/member episode, operation key, target, revision/state, and schema policy. First submit stores a separate intent fingerprint over the complete normalized payload plus that opening fingerprint. Existing Calendar, Dashboard Warning, and Baby lifecycle adapters use this contract; other declared operation keys remain fail-closed until their adapters are delivered.

Pending or unknown operations reconcile only under the same identity. Terminal safe results replay for 30 days, after which retention compacts them through the guarded database function into immutable content-free tombstones. Authorized compacted lookup returns HTTP-410-style `operation_result_expired`; foreign or former-member lookup remains existence-neutral. The retention scheduler emits only content-free counts. Startup readiness verifies required operation tables, compaction function, and binding/operation equality before reporting ready.

### Calendar

`src/server/services/calendar.ts` builds month data and event details. Calendar
pages filter by the header-selected baby and use `APP_TIMEZONE` for month/day
display.

### Reports

`src/server/services/reports.ts` computes report windows, statistics, growth
trends, activity summaries, heatmaps, and the Routine tab. Routine windows are
trailing `1w`, `2w`, or `1m` windows anchored to the Reports end date.

### Backups And Sprout Import

`src/server/services/backups.ts` owns Cubby JSON backup preview, export,
automated local-backup discovery/download status, and recovery. Version 2 is a
checksummed non-secret logical household snapshot read inside one repeatable-read
PostgreSQL transaction. Export fails while a running or paused timer exists.
Recovery accepts only a fresh household whose current member is its sole active
owner, then rechecks that invariant and restores the snapshot atomically in a
serializable transaction. The target `User`, owner membership, credentials,
sessions, role, and `disabledAt` state are preserved.

Version 2 includes allowlisted household settings, active/inactive babies,
non-deleted activities and coherent stopped-timer history, safe historical
attribution, contacts, medicine/supplement catalogs, calendar relations, and
reminders. It excludes authentication and membership state, invitations and
registration policy, integration secrets/runtime records, notifications,
operational history, warning dismissals, and vaccine attachment metadata and
file bytes. Legacy version 1 remains an explicitly partial, non-checksummed
fresh-target recovery path.

`src/server/services/automated-backups.ts` starts from Node instrumentation in
the existing app container, uses household-scoped advisory locking, writes
validated files into `/var/lib/cubby/backups`, and retains only the newest valid
associated automated versions. The disposable real-PostgreSQL automated export →
local file → restore → re-export rehearsal and exact safety boundary are
documented in [Backup Recovery](BACKUP_RECOVERY.md).
`src/server/services/sprout-import.ts` previews and imports Sprout Track backup
uploads into the current Cubby household.

Sprout restore accepts Sprout `.zip`, standalone `baby-tracker.db`, and `data.json`
backup shapes. It imports user-owned tracking data, matches or creates babies,
preserves caretaker names as historical attribution, and skips Sprout auth,
runtime secrets, API keys, push subscriptions, sessions, and email config.

SQLite reading uses `sql.js` loaded from runtime `node_modules` in a server-only
path. Docker-sensitive changes here should be verified inside the container.

### Hooks, Webhooks, And Notifications

API-key hooks live under `/api/hooks/v1`. Hook clients authenticate with
`Authorization: Bearer <key>`, and keys are stored hashed with prefix display and
revocation metadata. Hook reads can still reference inactive babies, but hook
writes go through the same activity service gating and cannot create activity
for inactive babies.

Webhook endpoint and delivery records are stored for activity/timer event
delivery. Browser push subscriptions, notification preferences, and notification
logs are stored for notification workflows.

## Clean-Room Boundary

Sprout Track is a one-time clean-room migration source for household-owned data,
not an ongoing workflow, parity, or compatibility target. Cubby must not copy
Sprout Track code, schemas, assets, exact UI text, credentials, route names, or
implementation structure.

## Testing Map

Service tests live near services in `src/server/services/*.test.ts`. Add focused
tests near the service that owns the behavior:

- Registration and invite policy: `registration.test.ts`, `invites.test.ts`.
- Role and member access policy: `roles.test.ts`, `member-access.test.ts`.
- Dashboard, warnings, date grouping: `dashboard.test.ts`.
- Reports and routine analytics: `reports.test.ts`.
- Sprout parsing/import mapping: `sprout-import.test.ts`.
- Invitation protocol schema, procedures, and grants: `invitation-protocol-schema.test.ts`.
- Invitation services and signed carriers: `invitation-service.test.ts`, `invitation-attestation.test.ts`, `invitation-carrier-compatibility.test.ts`.
- Global Security bridge integrity, lock order, and canonical issuance effects: `invitation-recovery-bridge-integrity.test.ts`.
- Invitation route layer, corridor, and transport: `invitation-route-layer.test.ts`, `invitation-setup-corridor.test.ts`, `invitation-recovery-transport.test.ts`.
- Disposable acceptance harness and closed diagnostic contracts: `p1-3-invitation-browser-harness.test.ts`, `p1-3-invitation-acceptance-contract.test.ts`, `p1-3-recovery-submit-probe-contract.test.ts`.

For UI, auth, schema, Docker, or import changes, use the verification guidance in
[Development](DEVELOPMENT.md).
