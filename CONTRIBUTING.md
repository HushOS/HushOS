# Contributing

Follow the root README to install dependencies, create `.env`, start Postgres, migrate, and start the app. Node.js 24 is the minimum; `.nvmrc` selects that major. Open the **repository root** in your editor so workspace configuration and aliases resolve consistently.

## Editors

### VS Code

Install the recommended Oxc and Tailwind CSS extensions. Use a current VS Code release with native TypeScript 7 support. Accept the workspace TypeScript prompt if shown; `.vscode/settings.json` points to the installed TypeScript 7 package and enables `js/ts.experimental.useTsgo`.

The workspace enables Oxfmt on save, Oxlint safe fixes and type-aware diagnostics, non-relative auto-imports, and type-only auto-imports. Prettier is disabled. CSS remains formatted by Oxfmt, including Tailwind CSS. Class completion covers `cn`, `cx`, `cva`, and custom class-name properties.

### Zed

Install **Oxc** and **TypeScript Language Server** (extension ID `tsgo`, current language-server ID `typescript-ls`). The workspace pins its compiler to 7.0.2 and disables `vtsls` and the older TypeScript language server. Settings preserve your Oxc preferences, with the formatter path adapted to the root `oxfmt.config.ts`. Oxlint keeps nested configuration enabled so the web's React/accessibility rules are picked up.

Both editors use four spaces. Per-package `tsconfig.json` files extend the root TypeScript defaults. `packages/config` is the authoritative source for shared lint and format rules; the root files support automatic editor discovery.

## Structure and imports

- Keep web pages and layouts in `src/routes/` using directory routes (`app/route.tsx`, `app/index.tsx`, etc.), reusable UI in `src/components/`, and shared helpers in `src/lib/`.
- Keep Elysia handlers in `apps/web/src/lib/api.server.ts`; `src/routes/api/$.ts` delegates `/api` requests to that app.
- Use `@/lib/...` within the web app and `@hushos/...` between packages.
- Export shared runtime code through the owning package's `package.json`. Avoid relative imports into another workspace.
- Use `import type` for API contracts. Keep runtime server imports within server routes, server modules, or `createIsomorphicFn().server(...)` implementations so the browser build excludes them.

## Web and API requests

Develop at `http://localhost:5173/app`; API endpoints live at `/api/health`, `/api/ready`, and `/api/greeting` on the same server. Nitro hosts both TanStack Start and the mounted Elysia app. Local development needs no custom hostname or certificate.

Use `getApi()` or `getApiFetch()` from `@/lib/api`. In the browser, they call the current origin. During SSR, they call Elysia directly and retain the outer request's logging context. `getApi()` exposes methods such as `.health.get()`; `getApiFetch()` takes full paths such as `/api/greeting`.

Development CORS applies to the public demo API; auth mutations require `Origin` to match `APP_ORIGIN`. Production does not enable cross-origin API access. Remote HTTPS can be provided by Tailscale Serve or your hosting platform; one origin serves both the UI and API.

## Database

Import the shared `db` instance from `@hushos/db` in API/server code. `packages/db/src/client.ts` initializes it once per process from `DATABASE_URL`; Drizzle creates the underlying PostgreSQL pool. The Nitro database plugin closes that client during shutdown with `db.$client.end()`.

The pinned Drizzle v1 RC registers the tables from `packages/db/src/schema/index.ts` through `relations: defineRelations(schema)`. This enables typed queries such as `db.query.workspaces.findMany()`. The schema barrel exports `auth.ts`, `workspaces.ts`, `storage.ts`, and `relations.ts`. Keep SQL queries in the database package; web and auth code use its repository exports.

```ts
import { db } from '@hushos/db';

const workspaces = await db.query.workspaces.findMany();
```

Schema changes should include the generated migration and snapshot in `packages/db/drizzle`. Run `bun run db:generate`, review the SQL, then apply it with `bun run db:migrate`. Drizzle Kit reads its own configuration from `packages/db/drizzle.config.ts`, using `MIGRATION_DATABASE_URL` when set and otherwise `DATABASE_URL`.

## Logging

`@hushos/logging` owns the evlog dependency and exposes its browser-safe error helpers and Nitro integration. The official evlog Nitro module emits one completed event per HTTP request, covering pages, server functions, static assets, and the Elysia API. API paths use service `HushOS API`; other paths use `HushOS Web`. Logs go to the console, with JSON output in production; no external drain is configured.

The request-context plugin generates a UUID and returns it in `X-Request-ID`. Caller-provided IDs are not copied into logs. It installs the runtime authentication redaction policy before requests are emitted. Treat the ID as a correlation label, not an identity or authorization claim.

In server code and async helpers:

```ts
import { useLogger, useRequestId } from '@/lib/logging.server';
import { createError, parseError } from '@hushos/logging';

useLogger().set({ action: 'example' });
const requestId = useRequestId();
```

Elysia handlers also receive `log` and `requestId` on their context. They reuse the current Nitro logger; they do not initialize or emit a second request event. Direct SSR calls share that context, while subsequent browser requests get their own IDs. Elysia's error hook records failures on the same logger and formats `EvlogError` responses; the root route uses `evlogErrorHandler` for TanStack errors.

TanStack Start supplies its default request handling and CSRF middleware. The auth HTTP wrapper additionally enforces the exact origin, JSON content type, a 16 KiB streaming body limit, rate limits, and private/no-store responses before calling Elysia. Rejections still receive the outer Nitro request event.

`packages/logging/src/privacy.ts` enables redaction in development and production. Auth events keep only approved operational fields, with an allowlisted action and outcome. Bodies, headers, email addresses, cookies, passwords, OPAQUE payloads, key bundles, recovery phrases, and raw errors are excluded before console output and drains. Never attach raw requests, database/provider errors, or crypto state to a logger. No client logging or external log drain is configured.

## Test tooling

Test infrastructure is ready, with **no test cases included**. Per `AGENTS.md`, agents must only add tests when explicitly requested by the user.

- Shared TypeScript packages: Bun's runner, with `--pass-with-no-tests`.
- Web: Vitest 5, jsdom, React Testing Library, user-event, and jest-dom. `src/test/setup.ts` installs DOM matchers and cleanup.
- Future tests should use `*.test.ts` or `*.test.tsx`. Keep route tests outside `src/routes/` so TanStack does not treat them as routes.
- `bun run test` runs all configured runners via Turbo. Use `bun run --cwd apps/web test:watch` for the web watch mode. Use `bun run test`, not bare `bun test`, at the repo root.

Before submitting a change, run:

```sh
bun run check
bun run build
```

CI runs `bun run check` (lint, format, and typecheck), `bun run test`, and `bun run build` on pull requests and pushes to `main`. After all three pass on `main`, it builds and publishes the web and migration images to GHCR. See [self-hosting](docs/self-hosting.md#container-publishing) for image names and tags.

## Environment and project status

`bun run setup` is idempotent, preserves existing settings, and adds missing auth/email defaults. `bun run infra:down` preserves data; avoid removing volumes unless you intend to discard that local database. Keep the generated `.env` when reusing the volume: changing only the password variable does not change an existing Postgres role's password.

This is the foundation for HushOS Drive and the later productivity suite. Email verification, OPAQUE authentication, remembered unlock, recovery, password changes, master/recovery-key rotation, identity-key provisioning, quota grants, and permanent deletion are implemented; Drive storage, content encryption, sharing, chat, and billing are future work. HushOS is licensed under the [GNU Affero General Public License v3.0 only](LICENSE) (`AGPL-3.0-only`).

## Authentication, cryptography, and email packages

`@hushos/auth/server` owns account enrollment, sessions, and authorization checks. `@hushos/auth/client` orchestrates the browser flow through `CryptoTransport` and `DeviceKeyStore` adapters; web routes own the UI. `@hushos/crypto` owns the protocol versions, OPAQUE client operations, HKDF, and account-key envelope. Its crypto session has no React, HTTP, or worker dependency. Other clients can reuse the protocol and primitives where WebAssembly/Web Crypto are available; native mobile runtime integration is still required. Server OPAQUE primitives have a separate `@hushos/crypto/server` export.

`@hushos/emails/server` owns rendering and SMTP/Resend/SES adapters. Templates live in `packages/emails/src/templates`. Run `bun run email:preview` independently from the app. The email PNG is rendered from `apps/web/src/components/logo.tsx`, at three times its displayed size; keep the preview and `apps/web/public/email` copies in sync when changing the mark. Use a public HTTPS app origin for images in delivered emails.

Keep plaintext passwords, session tokens, OPAQUE states, export keys, root keys, and private identity keys out of logs and persistent browser storage. Zustand persists only the encrypted device bundle and lock revision. The worker holds the unlocked root key in memory; the recovery screen temporarily receives the phrase to display/export it and clears it on lock. JavaScript cannot guarantee zeroization of immutable strings or GC copies. See the [auth protocol](docs/opaque-auth-design.md) for native-client boundaries and wire formats.
