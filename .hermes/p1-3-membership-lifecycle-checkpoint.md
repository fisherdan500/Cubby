# P1-3 Membership Lifecycle Checkpoint

Updated: 2026-07-30 — post-review remediation in progress

## Candidate identity

- Worktree: `C:\Projects\Cubby\worktrees\Cubby\p1-3-membership-lifecycle`
- Branch: `feat/p1-3-membership-lifecycle`
- Published P1-3 evidence range: `814f6382aaa262002a6e1c832c8938c08e8241af` through `3d3645630ac63f2f5db7451d59874840e4c1fad0`
- Baseline / merge-base: `origin/main` / `2f405b87bb7cc66fa3921b37bc7609277fdc980c`
- The current worktree contains a bounded post-review fix. Its exact fingerprint and verification state must be refreshed before any merge decision.

The historical published range above is retained only as review context. It is not approval for the current post-review fix.

## Current contract evidence

- New API keys and non-legacy webhooks are immutable, same-household capabilities of their issuing membership episode. Legacy capabilities remain explicitly unattributed, cannot be adopted or transferred, and API-key use fails closed.
- Self-leave, removal, and suspension contain API keys, endpoints, pending deliveries, notification preferences, push subscriptions, and queued notifications. Legacy endpoints are retired on every membership-closure path.
- A suspended member may authenticate solely to reach the separately guarded self-leave flow. Ordinary household context remains active-membership-only. The normal no-active-household landing redirects a suspended non-owner to `/app/settings/leave`.
- Leave idempotency is membership-episode-aware. Reusing an operation from an earlier episode produces a sanitized HTTP `409`, not a generic server error.
- Activity-side-effect issuer/recipient revalidation uses nonblocking `FOR SHARE SKIP LOCKED`; when concurrent membership closure holds a row, the corresponding outbox side effect is omitted fail-closed rather than forming an inverse lock cycle.
- Preview/UI warnings expose only safe codes and aggregate authority counts; no identities, URLs, endpoint payloads, prefixes, or secrets are exposed.

## Verification and review state

- The targeted self-leave regression test is required to pass before the final candidate is frozen. Canonical verification and a fresh exact-tree independent review are required after that final tree is frozen.
- Static/source tests do not establish PostgreSQL contention behavior. The earlier disposable acceptance remains historical evidence only; any changed contention predicate requires a separately scoped exact-candidate acceptance decision.
- Browser/runtime rendering, normal-runtime migration, Docker/runtime operation, and external delivery testing are unauthorized and unrun.

## Boundaries

- Published history includes local commits, a pushed branch, and PR #37. The current post-review fix is uncommitted and unpushed; merge, deployment, normal/runtime database migration, server/worker/browser operation, and external delivery remain unperformed.
- Protected-owner transfer, P1-8 recovery work, scheduled-responsibility policy, and unmodeled capability domains remain outside this remediation.
