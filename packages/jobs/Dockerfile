FROM oven/bun:1.4.0 AS manifests
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/web/package.json ./apps/web/package.json
COPY packages/crypto/package.json ./packages/crypto/package.json
COPY packages/env/package.json ./packages/env/package.json
COPY packages/auth/package.json ./packages/auth/package.json
COPY packages/emails/package.json ./packages/emails/package.json
COPY packages/config/package.json ./packages/config/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/jobs/package.json ./packages/jobs/package.json
COPY packages/logging/package.json ./packages/logging/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/utils/package.json ./packages/utils/package.json

FROM manifests AS build
RUN bun install --frozen-lockfile --filter @hushos/jobs
COPY tsconfig.base.json ./
COPY packages/config ./packages/config
COPY packages/env ./packages/env
COPY packages/logging ./packages/logging
COPY packages/db ./packages/db
COPY packages/jobs ./packages/jobs
RUN bun run --cwd packages/jobs build

FROM oven/bun:1.4.0-slim AS worker
WORKDIR /app
ENV NODE_ENV=production
ARG RELEASE_SHA
ENV HUSHOS_RELEASE_SHA=$RELEASE_SHA
COPY --from=build /app/packages/jobs/dist/worker.js ./worker.js
USER bun
CMD ["bun", "worker.js"]
