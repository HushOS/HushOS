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

Develop at `http://localhost:5173/app`; API endpoints live under `/api` on the same server (`/api/health`, `/api/ready`, `/api/auth/*`). Nitro hosts both TanStack Start and the mounted Elysia app. Local development needs no custom hostname or certificate.

The browser reaches the API through the `AuthApi` and `BillingApi` adapters in `apps/web/src/lib/auth-api.ts` and `apps/web/src/lib/billing-api.ts` (one Eden Treaty client, typed by the Elysia app). Server code reads the database directly through server functions and `createIsomorphicFn().server(...)` branches; there is no in-process HTTP client.

Auth mutations require `Origin` to match `APP_ORIGIN`, so signing in from a LAN address or a Tailscale hostname needs `APP_ORIGIN` set to that origin and HTTPS in front of it. The dev server answers LAN addresses and `*.ts.net` hostnames; add others to `allowedHosts` in `apps/web/vite.config.ts`. Production does not enable cross-origin API access.

## Database

Import the shared `db` instance from `@hushos/db` in API/server code. `packages/db/src/client.ts` initializes it once per process from `DATABASE_URL`; Drizzle creates the underlying PostgreSQL pool. The Nitro database plugin closes that client during shutdown with `db.$client.end()`.

The pinned Drizzle v1 RC registers the tables from `packages/db/src/schema/index.ts` through `relations: defineRelations(schema)`. This enables typed queries such as `db.query.workspaces.findMany()`. The schema barrel exports `auth.ts`, `workspaces.ts`, `workspace-keys.ts`, `storage.ts`, and `relations.ts`. Keep SQL queries in the database package; web and auth code use its repository exports.

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

`@hushos/jobs` is the background worker: queue names, payload types and policies live in `packages/jobs/src/client.ts`, handlers under `packages/jobs/src/jobs`, and `packages/jobs/src/worker.ts` is the process (`bun run worker`, or `bun run dev` starts it with the app). The web app may only `enqueue()`; never run scheduled or long work inside a request. pg-boss migrates its `pgboss` schema itself; do not add it to the Drizzle migrations.

`packages/logging/src/privacy.ts` enables redaction in development and production. Auth events keep only approved operational fields, with an allowlisted action and outcome. Bodies, headers, email addresses, cookies, passwords, OPAQUE payloads, key bundles, recovery phrases, and raw errors are excluded before console output and drains. Never attach raw requests, database/provider errors, or crypto state to a logger. No client logging or external log drain is configured.

## Tests

Tests exist where a mistake costs money or data: the billing entitlement transaction, the billing server against a fake Polar with real webhook signatures, and the crypto envelopes. Add to them whenever you touch those paths, and add a suite when a new package handles keys, quota, or payments. UI and marketing code is checked by hand.

- Every package uses Vitest (`bun run test` at the root runs them all through Turbo; `bun run --cwd packages/db test` runs one). Tests live beside the code as `*.test.ts`. The root `vitest.config.ts` lists every package as a project, so the Vitest extension in VS Code (recommended in `.vscode/extensions.json`) discovers all of them and runs a single test from the gutter; the database setup runs on its own from `.env`.
- Database tests run against a throwaway database named after `DATABASE_URL` with `_test` appended, created and migrated by `packages/db/test/global-setup.ts` on each run; set `TEST_DATABASE_URL` to use another. Tables are truncated before every test, so the development database is never touched.
- `packages/db/test/helpers.ts` creates accounts without the OPAQUE ceremony. Fixtures are fixed values, not generated ones, so a failure reproduces.
- The Polar SDK is replaced with `vi.mock`; nothing in the tests reaches the network.
- Web: Vitest with jsdom today. Browser mode with Playwright is the intended replacement, since the auth client depends on Web Crypto, IndexedDB and workers that jsdom does not implement. Keep route tests outside `src/routes/` so TanStack does not treat them as routes.

Before submitting a change, run:

```sh
bun run check
bun run build
```

CI runs `bun run check` (lint, format, and typecheck), `bun run test`, and `bun run build` on pull requests and pushes to `main`. After all three pass on `main`, it builds and publishes the web and migration images to GHCR. See [self-hosting](docs/self-hosting.md#container-publishing) for image names and tags.

## Environment and project status

`bun run setup` is idempotent, preserves existing settings, and adds missing auth/email defaults. `bun run infra:down` preserves data; avoid removing volumes unless you intend to discard that local database. Keep the generated `.env` when reusing the volume: changing only the password variable does not change an existing Postgres role's password.

This is the foundation for HushOS Drive and the later productivity suite. Email verification, OPAQUE authentication, remembered unlock, recovery, password changes, master/recovery-key rotation, identity-key provisioning, quota grants, and permanent deletion are implemented; Drive storage, content encryption, sharing, chat, and billing are future work. HushOS is licensed under the [GNU Affero General Public License v3.0 only](LICENSE) (`AGPL-3.0-only`).

## Billing package

`@hushos/billing/server` wraps the Polar SDK (`@polar-sh/sdk`, the `2026-04` API version) behind a few functions: catalogue, checkout, portal session, cancel and resume, webhook handling, and `reconcileCustomer`. Webhooks are a trigger only: every handler re-reads the customer's state from Polar and rewrites the local subscription mirror and storage entitlements in one transaction. With `BILLING_PROVIDER=none` nothing in the package talks to Polar and the app hides every billing surface. To work on it locally, create a sandbox organisation at sandbox.polar.sh, add products with `hushos_plan` and `quota_bytes` metadata, put a sandbox token and webhook secret in `.env` with `POLAR_ENVIRONMENT=sandbox`, and relay deliveries with `polar listen http://localhost:5173/api/billing/webhook`.

## Authentication, cryptography, and email packages

`@hushos/auth/server` owns account enrollment, sessions, and authorization checks; its functions take session or enrollment tokens and plain values, never a request. `@hushos/auth/http` is the only place auth touches HTTP: it reads and writes the token cookies, resolves the client address, and guards browser-originated mutations, so API handlers and server loaders go through it. `@hushos/auth/client` orchestrates the browser flow through `CryptoTransport`, `DeviceKeyStore` and `AuthApi` adapters; web routes own the UI. `AuthApi` (`packages/auth/src/api.ts`) is the contract the client needs from the server; the web app implements it in `apps/web/src/lib/auth-api.ts` with an Eden Treaty client typed by the Elysia app, so a route or response change that the client does not expect fails `bun run typecheck` there. Error handlers in `api.server.ts` must return literal status codes: a plain `number` erases every inferred response type. `@hushos/crypto` owns the protocol versions, OPAQUE client operations, HKDF, and the account-key and workspace-grant envelopes. Its crypto session has no React, HTTP, or worker dependency. Other clients can reuse the protocol and primitives where WebAssembly/Web Crypto are available; native mobile runtime integration is still required. Server OPAQUE primitives have a separate `@hushos/crypto/server` export.

`@hushos/emails/server` owns the SMTP/Resend/SES adapters and fills templates that were rendered at build time: `bun run email:render` renders `packages/emails/src/templates` into `packages/emails/src/rendered/*.ts` with `{{verificationUrl}}` and `{{logoUrl}}` placeholders, and the running server only substitutes those, so React and React Email never load at runtime. Commit the rendered output; CI fails when it is stale. `bun run dev` renders them first, so a fresh dev session starts with current templates; nothing watches the template files after that. Run `bun run email:preview` independently from the app to edit templates. The email PNG is rendered from `apps/web/src/components/logo.tsx`, at three times its displayed size; keep the preview and `apps/web/public/email` copies in sync when changing the mark. Use a public HTTPS app origin for images in delivered emails.

Keep plaintext passwords, session tokens, OPAQUE states, export keys, root keys, workspace keys, and private identity keys out of logs and persistent browser storage. Zustand persists only the encrypted device bundle and lock revision. The worker holds the unlocked root key in memory; the recovery screen temporarily receives the phrase to display/export it and clears it on lock. JavaScript cannot guarantee zeroization of immutable strings or GC copies. See the [auth protocol](docs/opaque-auth-design.md) for native-client boundaries and wire formats.
