# Cubby

Cubby is a self-hostable baby-care tracker for families. It is a clean-room, original implementation inspired only by common baby-tracking product behavior.

## Docker Quick Start

1. Copy `.env.example` to `.env`.
2. Set a long random `BETTER_AUTH_SECRET`.
3. Run:

```bash
docker compose up --build
```

4. Open http://localhost:3000.

The compose stack includes the app and PostgreSQL. Postgres data is stored in the `cubby_postgres_data` named volume.

If port 3000 is already in use, set `APP_PORT=3002`, `BETTER_AUTH_URL=http://localhost:3002`, and `TRUSTED_ORIGINS=http://localhost:3002,http://127.0.0.1:3002` in `.env`, then open that port instead.

## Local Development

```bash
npm install
npm run db:generate
npm run dev
```

For local development outside Docker, set `DATABASE_URL` to a reachable PostgreSQL database.

## Verification

```bash
npm run lint
npm run typecheck
npm run test
npm run build
```

## Clean-Room Note

Do not copy code, schemas, UI, file structure, assets, text, route names, credentials, or implementation details from Sprout Track. Cubby uses only product-level behavior requirements.
