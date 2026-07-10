# AGENTS.md

This guide applies to the whole Cubby repository. It is written for Codex and
other coding agents working in this project.

## Start Here

Before making non-trivial changes, read:

1. `README.md`
2. `docs/ARCHITECTURE.md`
3. `docs/DEVELOPMENT.md`

If the work involves future features, product planning, or backlog grooming, read
`docs/ROADMAP.md` after the current-state docs. Do not treat roadmap items as
implemented unless the code or current-state docs confirm them.

Then inspect the files that own the requested behavior. Do not rely only on prior
conversation context when the repo can answer the question.

## Project Rules

- Keep changes focused on the user request.
- Prefer existing service/module patterns over new architecture.
- Put business logic in `src/server/services` instead of page or route-handler bodies.
- Enforce household membership and permissions server-side for every household-scoped read or write.
- Preserve Better Auth and the invite-first household model.
- Preserve the protected owner and delegated-admin model: only owners may grant or revoke Admin access.
- Preserve the `ActivityLog` aggregate plus type-specific detail table pattern.
- Keep timestamps as stored instants and group/display them through `APP_TIMEZONE`.
- Treat Docker Compose as the primary deployment path.
- Respect the current dark operational UI direction and existing app shell patterns.
- Design and check Cubby UI mobile-first; most use is expected from phones, with desktop kept tidy but secondary.
- Do not run destructive git commands unless the user explicitly asks for them.
- Preserve unrelated user changes in a dirty worktree.

## Clean-Room Sprout Track Rule

Cubby may use Sprout Track only for product-level behavior discovery and backup
data compatibility. Do not copy Sprout Track code, Prisma schema, route names,
assets, exact UI text, credentials, implementation structure, or icon art.

Sprout backup support must remain a Cubby importer that maps user-owned tracking
data into Cubby's own schema. It must not import Sprout secrets, auth records,
API keys, sessions, push subscriptions, email config, or runtime credentials.

## Implementation Guidance

- Use `rg` or `rg --files` first when searching.
- Use `apply_patch` for manual file edits.
- Keep comments sparse and only where they clarify non-obvious logic.
- Add or update tests near the owning service for behavior changes.
- Avoid broad refactors while adding a feature or fixing a bug.
- Keep page links and redirects preserving selected `babyId` and relevant date/filter params when the current workflow depends on them.
- Use structured parsing or existing helpers for dates, imports, backups, and exports instead of ad hoc string manipulation.

## Verification Expectations

Choose the smallest verification set that covers the risk:

- Docs-only: review links/headings and run `git status --short`.
- TypeScript/UI behavior: run `npm run typecheck`, `npm run lint`, and targeted tests.
- Service logic: run targeted Vitest tests plus `npm run test` when the change is shared.
- Prisma schema changes: run Prisma validation/generation, migrations, tests, and `npm run build`.
- Auth, registration, permissions, import, backup, or integration changes: include permission/cross-household tests.
- Docker-sensitive changes, especially Sprout SQLite import or startup behavior: run `docker compose up --build -d` and inspect app logs.

Full verification set:

```bash
npm run lint
npm run typecheck
npm run test
npm run build
docker compose up --build -d
```

If you cannot run a relevant verification command, say so in the final response
and explain why.
