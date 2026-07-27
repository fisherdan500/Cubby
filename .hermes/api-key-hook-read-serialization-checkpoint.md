# API-key hook-read serialization checkpoint

## Scope and baseline
- Worktree: `C:\Projects\Cubby\worktrees\Cubby\api-key-hook-read-serialization`
- Branch: `fix/api-key-hook-read-serialization`
- Base: `origin/main` / `1cfbbf1dc042b978bec5ad7a94cbfe7e8983f66b`
- No commit, push, PR, merge, deployment, Docker/runtime action, or database rehearsal has occurred.

## Implemented
- Traced all hook API-key consumers: five GET endpoints and the activity POST endpoint.
- Added `withApiKey()` in `src/server/services/hooks.ts`. It locks the API-key row by unique key hash in a transaction, re-reads/revalidates key, household, scope, and actor state, records last use, and runs protected GET work before releasing the lock.
- All five GET routes use `withApiKey()` and pass the same transaction client into database-backed read helpers.
- Activity POST uses `requireApiKey()` only to finish validation before its existing activity-write transaction. That existing write transaction independently locks/revalidates the key; this avoids a nested transaction self-deadlock while retaining revoke/write serialization.
- Added `src/server/services/hooks.test.ts` with RED→GREEN coverage for locked revalidation and revoked-key rejection before protected read invocation.

## Verification
- Focused hooks/activities/integrations/mutation-lock tests: 54 passed.
- Full `npm test`: 79 files, 585 tests passed.
- `npm run lint`, `npm run typecheck`, `npm run build`, and `git diff --check HEAD`: passed.
- Fresh independent source review: approved with no critical/high/medium/low findings.

## Deferred acceptance
- Mock/source tests do not prove real PostgreSQL lock waiting, isolation, or deadlock behavior.
- A separately approved isolated PostgreSQL concurrency rehearsal should prove GET versus API-key revocation serialization and POST activity creation versus revocation settles without deadlock.
- The separately identified webhook producer/delete real-interleaving acceptance remains unverified; source coordination is present but no real PostgreSQL barrier test was run.

## Next gate
- Separate User authorization is required before committing this candidate. Push, PR, merge, deployment, and any isolated PostgreSQL rehearsal remain separate approvals.
