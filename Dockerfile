# BuildKit is required for the cache mounts below (Docker Compose v2 and `docker build` use it by
# default). They only hold recomputable caches - the npm download cache and Next's incremental
# compiler cache - so a cold builder produces an identical image, just more slowly.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm ci

FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
ARG NEXT_PUBLIC_CUBBY_P13_RECOVERY_SCHEMA_OBSERVER=""
ENV NEXT_PUBLIC_CUBBY_P13_RECOVERY_SCHEMA_OBSERVER=$NEXT_PUBLIC_CUBBY_P13_RECOVERY_SCHEMA_OBSERVER
ARG CUBBY_P13_RECOVERY_ROUTE_ORIGIN_OBSERVER=""
ENV CUBBY_P13_RECOVERY_ROUTE_ORIGIN_OBSERVER=$CUBBY_P13_RECOVERY_ROUTE_ORIGIN_OBSERVER
RUN apt-get update -y && apt-get install -y --no-install-recommends build-essential openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY docker/sprout-stage-unlink.c /tmp/sprout-stage-unlink.c
RUN gcc -std=c17 -O2 -Wall -Wextra -Werror -o /usr/local/bin/cubby-sprout-stage-unlink /tmp/sprout-stage-unlink.c && rm /tmp/sprout-stage-unlink.c
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build:household-deletion-readiness
RUN node dist/household-deletion-readiness-guard.mjs
# `npm run build` starts with prisma generate; a second standalone generate step only cost time.
RUN --mount=type=cache,target=/app/.next/cache npm run build

FROM node:22-bookworm-slim AS runner-dependencies
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
# Runtime dependencies install straight from the lockfile instead of copying the builder's full
# node_modules and pruning it on every build, so this layer stays cached until package.json,
# package-lock.json or the Prisma schema changes. The Prisma CLI is a runtime dependency (the
# entrypoint runs migrate deploy), so --omit=dev keeps it. --ignore-scripts suppresses the
# @prisma/client postinstall, which cannot see the schema yet; the explicit generate replaces it.
# Everything under /app is installed and copied as node from here on. A later recursive chown of
# /app would rewrite every node_modules and .next file into a fresh layer, which measured ~5 minutes
# of every rebuild; /app is still empty here, so this chown is free and the ownership is identical.
RUN mkdir -p /var/lib/cubby/sprout-staging && chown -R node:node /app /var/lib/cubby
USER node
COPY --chown=node:node package.json package-lock.json* ./
RUN --mount=type=cache,target=/home/node/.npm,uid=1000,gid=1000 npm ci --omit=dev --ignore-scripts
COPY --chown=node:node prisma ./prisma
RUN npx --no-install prisma generate

FROM runner-dependencies AS runner-public
COPY --from=builder --chown=node:node /app/public ./public

FROM runner-public AS runner-standalone
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/standalone/server.js /app/server.js

FROM runner-standalone AS runner-static
COPY --from=builder --chown=node:node /app/.next/static ./.next/static

FROM runner-static AS runner-runtime-artifacts
COPY --from=builder --chown=node:node /app/dist/platform-owner.mjs ./platform-owner.mjs
COPY --from=builder --chown=node:node /app/dist/integrity-check.mjs ./integrity-check.mjs
COPY --from=builder /usr/local/bin/cubby-sprout-stage-unlink /usr/local/bin/cubby-sprout-stage-unlink
COPY --from=builder --chown=node:node /app/prisma ./prisma
COPY --from=builder --chown=node:node /app/dist/provision-security-runtime-role.mjs ./provision-security-runtime-role.mjs
COPY --from=builder --chown=node:node /app/dist/provision-invitation-runtime-roles.mjs ./provision-invitation-runtime-roles.mjs
COPY --from=builder --chown=node:node /app/dist/provision-fresh-auth-attestation-keys.mjs ./provision-fresh-auth-attestation-keys.mjs
COPY --from=builder --chown=node:node /app/dist/provision-email-delivery-keys.mjs ./provision-email-delivery-keys.mjs
COPY --from=builder --chown=node:node /app/dist/provision-global-security-throttle-key.mjs ./provision-global-security-throttle-key.mjs
COPY --from=builder --chown=node:node /app/dist/provision-platform-setup-code.mjs ./provision-platform-setup-code.mjs
COPY --from=builder --chown=node:node /app/dist/provision-database-timezone.mjs ./provision-database-timezone.mjs
COPY --from=builder --chown=node:node /app/dist/security-operator.mjs ./security-operator.mjs
COPY --from=builder --chown=node:node /app/dist/household-deletion-readiness-guard.mjs /app/scripts/household-deletion-readiness-guard.mjs
COPY --from=builder --chown=node:node /app/dist/p1-3-node-builtin-probe.mjs /app/scripts/p1-3-node-builtin-probe.mjs
COPY --chown=node:node scripts/p1-3-standalone-bootstrap-probe.cjs /app/scripts/p1-3-standalone-bootstrap-probe.cjs

FROM runner-runtime-artifacts AS runner-filesystem
# Fails closed if the runtime paths are missing or not owned by the unprivileged runtime user.
RUN test -d /var/lib/cubby/sprout-staging && test -O /var/lib/cubby/sprout-staging && test -O /app/server.js

FROM runner-filesystem AS runner
USER root
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/cubby-entrypoint
RUN sed -i 's/\x0D$//' /usr/local/bin/cubby-entrypoint
USER node
EXPOSE 3000
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENTRYPOINT ["/usr/local/bin/cubby-entrypoint"]
