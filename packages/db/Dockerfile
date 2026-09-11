FROM oven/bun:1.4.0 AS manifests
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/web/package.json ./apps/web/package.json
COPY packages/crypto/package.json ./packages/crypto/package.json
COPY packages/env/package.json ./packages/env/package.json
COPY packages/auth/package.json ./packages/auth/package.json
COPY packages/billing/package.json ./packages/billing/package.json
COPY packages/emails/package.json ./packages/emails/package.json
COPY packages/config/package.json ./packages/config/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/jobs/package.json ./packages/jobs/package.json
COPY packages/logging/package.json ./packages/logging/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/utils/package.json ./packages/utils/package.json

FROM manifests AS migration-deps
RUN bun install --frozen-lockfile --filter @hushos/db

FROM node:24-bookworm-slim AS migrate
COPY --from=manifests /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY --from=migration-deps /app/node_modules ./node_modules
COPY --from=migration-deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=migration-deps /app/packages/env/node_modules ./packages/env/node_modules
COPY packages/env/package.json ./packages/env/package.json
COPY packages/env/src ./packages/env/src
COPY packages/db/package.json packages/db/drizzle.config.ts ./packages/db/
COPY packages/db/src/schema ./packages/db/src/schema
COPY packages/db/drizzle ./packages/db/drizzle
USER node
WORKDIR /app/packages/db
CMD ["bun", "run", "db:migrate"]

