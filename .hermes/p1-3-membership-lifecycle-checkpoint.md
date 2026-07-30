# P1-3 Membership Lifecycle Checkpoint

Updated: disposable PostgreSQL acceptance (2026-07-29)

## Provenance

- Worktree: `C:\Projects\Cubby\worktrees\Cubby\p1-3-membership-lifecycle`
- Branch: `feat/p1-3-membership-lifecycle`
- HEAD/base: `2f405b87bb7cc66fa3921b37bc7609277fdc980c`
- Merge-base with `origin/main`: `2f405b87bb7cc66fa3921b37bc7609277fdc980c`
- Initial tracked status: clean
- Dependency state before editing: `node_modules` absent; install is limited to `npm ci` from the existing lockfile, with manifest/lockfile hashes checked before and after.

## Verified

- Final verification passed after independent-review remediation: 99 test files / 724 tests, lint with no warnings or errors, typecheck, production build (including Prisma generation), and `git diff --check`.
- Two independent final pre-commit reviews found no blocking findings. One noted only a future protocol hardening: bind intentional idempotency replay more explicitly to the membership episode if arbitrary API clients may reuse an old operation ID after re-invitation.
- Disposable PostgreSQL acceptance passed in an isolated `postgres:16-alpine` container using tmpfs storage and an ephemeral loopback port. `prisma migrate deploy` applied all 20 migrations and `prisma migrate status` reported the schema up to date.
- Four real-database acceptance tests passed: historical episode plus recipient-bound re-entry, concurrent current-episode uniqueness, concurrent duplicate leave idempotency, and invite-accept/leave serialization. Direct SQL confirmed history `2 total / 1 current`, the uniqueness race `1 total / 1 current`, invite/leave `1 total / 0 current`, and duplicate leave `1 membership / 1 audit`.
- PostgreSQL exposed both expected unique indexes, including the partial `HouseholdMember_one_current_episode_key` with `WHERE deletedAt IS NULL`. The temporary test file and labeled acceptance container were removed after evidence capture; no persistent volume was created.
- The complete tracked diff and all 12 untracked files were inspected. The combined working-tree summary is 17 files, 1,157 additions, and 42 deletions; the added-line security scan found no credential, injection, unsafe deserialization, eval/exec, SQL-formatting, or debug-log match.
- `package.json` and `package-lock.json` exactly match HEAD after `npm ci` (`661bc8c82ee4fb4ecb7d362e0f472ca604475e9a` and `fc69bdb0a51a12df17b7412b55e22dd5e8721d5a`, respectively).
- Slice 2 RED was observed for the absent service, API route, and leave form, plus the recipient-invitation race boundary. GREEN evidence is 62 focused tests passing with `npm run typecheck` passing.
- Active and suspended non-owner roles are accepted by the service after fresh-session acquisition and transaction-time revalidation; the protected owner and wrong household/name fail closed.
- Leave atomically closes only the current membership episode with `closureReason=self_left`, a unique stable `leaveOperationId`, audit attribution to that episode, and a content-minimized stable receipt. Duplicate operation identity returns the original receipt without another write/audit.
- The leave transaction uses the invitation-policy advisory lock, revokes pending invitations issued by or addressed to the leaver, deletes household/user notification preferences, and soft-revokes household/user push subscriptions. Global sessions and other-household memberships are not mutated because no household-scoped session model exists.
- The settings surface displays supported warnings for sole delegated-admin status, member-authored running/paused timers, pending invitations, and notification authority; it requires exact household-name confirmation and synchronously suppresses duplicate submits while persisting one operation identity in session storage across reload/reauthentication retries.
- An authenticated user with multiple current episodes can explicitly select an active or suspended membership as the leave target; unowned household IDs fail closed before preview.
- Existing re-invitation acceptance remains recipient-bound and creates a new episode rather than restoring the self-left episode.
- Slice 1 RED was observed in the focused re-entry regression and migration-contract tests; after the minimal changes, 39 focused tests passed and `npm run typecheck` passed.
- Valid re-invitation now looks up only a current (`deletedAt: null`) membership and creates a new membership row when only removed history exists. The focused test verifies the new ID/invited role, no historical-row update, and audit attribution to the new episode.
- The Prisma schema no longer exposes the historical global household/user unique key. Migration `20260729230000_membership_episodes` replaces it with a PostgreSQL partial unique index over `(householdId, userId) WHERE deletedAt IS NULL` without rewriting membership rows.
- Required control-plane evidence and decision lines 1577-1610 were read before editing.
- Invitation acceptance serializes invite/member/user reads and preserves the existing absent, active same-role, active conflicting-role, suspended, recipient, expiry, revocation, and audit outcomes in focused tests.
- Manager removal preserves a soft-deleted membership row; activity attribution uses a required restrictive membership relation and audit attribution can reference the membership.
- Fresh-session validation and transaction-time session revalidation helpers already exist.
- The protected owner role exists and ordinary member management cannot remove/suspend it.
- Current source models household/user-scoped push subscriptions and notification preferences, pending invitations with inviter user identity, household API keys, webhook endpoints, calendar events/reminders, and activity timers.
- Better Auth sessions are global user sessions, not household- or membership-scoped sessions.

## Present but unverified

- Runtime rendering/navigation after a final sole-household leave is present in source but has not been exercised in a browser or normal runtime under this charter.

## Missing

- No selected-slice source requirement remains missing.

## Blocked/deferred

- Applying migrations to any normal/runtime database is prohibited.
- Coverage assignments and server-side drafts have no confirmed current model; leave-time warning or mutation behavior for them is blocked rather than invented.
- Scheduled-responsibility ownership is ambiguous in the current calendar/reminder schema (no confirmed membership assignee); reassignment/cancellation behavior is blocked rather than invented.
- Household-scoped sessions, delegated grants/capabilities, device ownership, offline caches, and membership-scoped integrations are not modeled. Global Better Auth sessions must not be deleted merely for leaving one household because global identity and other-household continuity must remain intact.
- A user whose only current membership is suspended cannot establish a Better Auth session under the existing suspension guard. Authenticated users with another active membership/platform authority can now select and leave a suspended episode, but suspended-only authentication remains blocked by that existing auth contract rather than bypassed.
- Ordinary ownership transfer, support access, permanent household deletion, global-account deletion/anonymization/merge, email/recovery lifecycle, P1-8 recovery, invitation UX redesign, deployment, commit/push/PR/merge, and worktree/branch cleanup remain outside this milestone.
