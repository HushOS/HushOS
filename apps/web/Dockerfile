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
COPY packages/logging/package.json ./packages/logging/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/utils/package.json ./packages/utils/package.json

FROM manifests AS migration-deps
RUN bun install --frozen-lockfile --filter @hushos/db

FROM node:24-bookworm-slim AS build
COPY --from=manifests /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx
WORKDIR /app
COPY --from=manifests /app ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build --filter=@hushos/web

FROM oven/bun:1.4.0-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=5173
ARG RELEASE_SHA
ENV HUSHOS_RELEASE_SHA=$RELEASE_SHA
COPY --from=build /app/apps/web/.output ./.output
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=migration-deps /app/node_modules ./node_modules
COPY --from=migration-deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=migration-deps /app/packages/env/node_modules ./packages/env/node_modules
COPY packages/env/package.json ./packages/env/package.json
COPY packages/env/src ./packages/env/src
COPY packages/db/package.json packages/db/drizzle.config.ts ./packages/db/
COPY packages/db/src/schema ./packages/db/src/schema
COPY packages/db/drizzle ./packages/db/drizzle
COPY --chmod=755 apps/web/docker-entrypoint.sh /usr/local/bin/hushos-entrypoint
USER root
EXPOSE 5173
ENTRYPOINT ["hushos-entrypoint"]
CMD ["bun", ".output/server/index.mjs"]
