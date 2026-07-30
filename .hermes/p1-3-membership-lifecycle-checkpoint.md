# P1-3 Membership Lifecycle Checkpoint

Updated: 2026-07-30 — active source-only remediation candidate

## Candidate identity

- Worktree: `C:\Projects\Cubby\worktrees\Cubby\p1-3-membership-lifecycle`
- Branch: `feat/p1-3-membership-lifecycle`
- Retained evidence commit / HEAD: `814f6382aaa262002a6e1c832c8938c08e8241af`
- Baseline / merge-base: `origin/main` / `2f405b87bb7cc66fa3921b37bc7609277fdc980c`
- Exact tracked/untracked inventory and canonical diff fingerprint are refreshed after each verified remediation slice and must be read from the current remediation evidence report before review.

This checkpoint supersedes the prior 2026-07-29 disposable-acceptance summary. Its historical test, inventory, Docker, and review claims are not evidence for this current uncommitted candidate.

## Current contract evidence

- New API keys and non-legacy webhooks are immutable, same-household capabilities of their issuing membership episode. Legacy capabilities remain explicitly unattributed, cannot be adopted or transferred, and API-key use fails closed.
- Self-leave, removal, and suspension contain API keys, endpoints, pending deliveries, notification preferences, push subscriptions, and queued notifications. Legacy endpoints are retired on every membership-closure path.
- A suspended member may authenticate solely to reach the separately guarded self-leave flow. Ordinary household context remains active-membership-only. The normal no-active-household landing redirects a suspended non-owner to `/app/settings/leave`.
- Leave idempotency is membership-episode-aware. Reusing an operation from an earlier episode produces a sanitized HTTP `409`, not a generic server error.
- Activity-side-effect issuer/recipient revalidation uses nonblocking `FOR SHARE SKIP LOCKED`; when concurrent membership closure holds a row, the corresponding outbox side effect is omitted fail-closed rather than forming an inverse lock cycle.
- Preview/UI warnings expose only safe codes and aggregate authority counts; no identities, URLs, endpoint payloads, prefixes, or secrets are exposed.

## Verification and review state

- Focused verification for the latest suspended-landing change passed before this checkpoint refresh; canonical verification and a fresh exact-tree independent review are required after the final tree is frozen.
- Static/source tests do not establish PostgreSQL contention behavior. A disposable PostgreSQL barrier/concurrency acceptance is separately unauthorized and unrun for this candidate.
- Browser/runtime rendering, normal-runtime migration, Docker/runtime operation, and external delivery testing are unauthorized and unrun.

## Boundaries

- No commit, push, PR, merge, deployment, normal/runtime database migration, server/worker/browser operation, cleanup, or publication occurred under this charter.
- Protected-owner transfer, P1-8 recovery work, scheduled-responsibility policy, and unmodeled capability domains remain outside this remediation.
