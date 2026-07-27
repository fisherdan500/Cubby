# Capability-mutation hardening checkpoint

## Baseline
- Branch: `fix/capability-mutation-serialization`
- HEAD/base: `8b9735b74acede91bdb2fcb9c136c0c5066ccca6` / `origin/main` at the same revision.

## Verified
- API-key issuance locks/re-reads a scoped Baby after actor revalidation, validates household scope, and rejects inactive targets before issuance.
- API-key revocation and API-key-backed activity writes serialize on the same actor-then-key lock order; activity writes revalidate revoked/expired state and persisted write scope inside their transaction.
- Webhook deletion locks/re-reads the endpoint, retires only that endpoint's pending deliveries as `failed` with non-secret `endpoint_deleted`, soft-deletes/disables it, and writes the audit event in one transaction.
- Activity-side-effect enqueueing locks/rechecks each eligible endpoint (`householdId`, `enabled`, `deletedAt`, event subscription) before inserting delivery rows. Producer/delete interleavings therefore serialize on the endpoint lock.
- RED→GREEN focused evidence: pending-delivery retirement regression failed before implementation and then passed.
- Full verification after the final producer-lock correction:
  - `npm test`: 78 files / 583 tests passed.
  - `npm run lint`: passed.
  - `npm run typecheck`: passed.
  - `npm run build`: passed.
  - `git diff --check HEAD`: passed.
- Fresh independent read-only review: passed, recommendation `approve`, with no critical/high/medium/low findings.

## Present but unverified
- None for the authorized source-level candidate.

## Missing
- No remaining authorized code changes.

## Blocked or deferred
- No webhook dispatcher/sender exists in the current source tree. Before any dispatcher is added, it must re-read endpoint `enabled` and `deletedAt` immediately before sending. This is a deferred acceptance condition, not an implemented feature.
- No real PostgreSQL contention rehearsal was run. Existing Cubby application/database containers were active during preflight; no shared/runtime database was accessed. Unit tests and source review do not prove actual PostgreSQL lock waits or isolation behavior.

## Delivery gate
- Candidate is review-ready but uncommitted. Commit, push, PR creation, merge, deployment, and any disposable PostgreSQL rehearsal require separate explicit approval.
