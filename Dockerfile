FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

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
RUN npx prisma generate
RUN npm run build

FROM node:22-bookworm-slim AS runner-dependencies
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
COPY --from=builder /app/node_modules ./node_modules
RUN npm prune --omit=dev

FROM runner-dependencies AS runner-public
COPY --from=builder /app/public ./public

FROM runner-public AS runner-standalone
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/standalone/server.js /app/server.js

FROM runner-standalone AS runner-static
COPY --from=builder /app/.next/static ./.next/static

FROM runner-static AS runner-runtime-artifacts
COPY --from=builder /app/dist/platform-owner.mjs ./platform-owner.mjs
COPY --from=builder /app/dist/integrity-check.mjs ./integrity-check.mjs
COPY --from=builder /usr/local/bin/cubby-sprout-stage-unlink /usr/local/bin/cubby-sprout-stage-unlink
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/dist/provision-security-runtime-role.mjs ./provision-security-runtime-role.mjs
COPY --from=builder /app/dist/provision-invitation-runtime-roles.mjs ./provision-invitation-runtime-roles.mjs
COPY --from=builder /app/dist/provision-fresh-auth-attestation-keys.mjs ./provision-fresh-auth-attestation-keys.mjs
COPY --from=builder /app/dist/provision-email-delivery-keys.mjs ./provision-email-delivery-keys.mjs
COPY --from=builder /app/dist/provision-global-security-throttle-key.mjs ./provision-global-security-throttle-key.mjs
COPY --from=builder /app/dist/provision-database-timezone.mjs ./provision-database-timezone.mjs
COPY --from=builder /app/dist/security-operator.mjs ./security-operator.mjs
COPY --from=builder /app/dist/household-deletion-readiness-guard.mjs /app/scripts/household-deletion-readiness-guard.mjs
COPY --from=builder /app/dist/p1-3-node-builtin-probe.mjs /app/scripts/p1-3-node-builtin-probe.mjs
COPY scripts/p1-3-standalone-bootstrap-probe.cjs /app/scripts/p1-3-standalone-bootstrap-probe.cjs

FROM runner-runtime-artifacts AS runner-filesystem
RUN mkdir -p /var/lib/cubby/sprout-staging && chown -R node:node /app /var/lib/cubby

FROM runner-filesystem AS runner
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/cubby-entrypoint
RUN sed -i 's/\x0D$//' /usr/local/bin/cubby-entrypoint
USER node
EXPOSE 3000
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENTRYPOINT ["/usr/local/bin/cubby-entrypoint"]
