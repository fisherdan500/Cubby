FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN apt-get update -y && apt-get install -y --no-install-recommends build-essential openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY docker/sprout-stage-unlink.c /tmp/sprout-stage-unlink.c
RUN gcc -std=c17 -O2 -Wall -Wextra -Werror -o /usr/local/bin/cubby-sprout-stage-unlink /tmp/sprout-stage-unlink.c && rm /tmp/sprout-stage-unlink.c
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
COPY --from=builder /app/node_modules ./node_modules
RUN npm prune --omit=dev
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/standalone/server.js /app/server.js
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/dist/platform-owner.mjs ./platform-owner.mjs
COPY --from=builder /app/dist/integrity-check.mjs ./integrity-check.mjs
COPY --from=builder /usr/local/bin/cubby-sprout-stage-unlink /usr/local/bin/cubby-sprout-stage-unlink
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/dist/provision-security-runtime-role.mjs ./provision-security-runtime-role.mjs
COPY --from=builder /app/dist/provision-fresh-auth-attestation-keys.mjs ./provision-fresh-auth-attestation-keys.mjs
COPY --from=builder /app/dist/provision-email-delivery-keys.mjs ./provision-email-delivery-keys.mjs
COPY --from=builder /app/dist/provision-global-security-throttle-key.mjs ./provision-global-security-throttle-key.mjs
COPY --from=builder /app/dist/security-operator.mjs ./security-operator.mjs
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/cubby-entrypoint
RUN sed -i 's/\x0D$//' /usr/local/bin/cubby-entrypoint
RUN mkdir -p /var/lib/cubby/sprout-staging && chown -R node:node /app /var/lib/cubby
USER node
EXPOSE 3000
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENTRYPOINT ["/usr/local/bin/cubby-entrypoint"]
