# Contributing

Follow the root README to install dependencies, create `.env`, start Postgres, migrate, and start the app. Bun 1.4.2 runs everything, the browser suite included. Open the **repository root** in your editor so workspace configuration and aliases resolve consistently.

## Commits and sign-off

Every commit carries a sign-off: a `Signed-off-by: Your Name <you@example.com>` line certifying the [Developer Certificate of Origin](https://developercertificate.org/), that you wrote the change or otherwise have the right to submit it under the project's license (AGPL-3.0-only). Add it with `git commit -s`; the name and email must match the commit's author. The DCO check on every pull request fails on any commit without one. To fix a branch already pushed, run `git rebase --signoff origin/main` and force-push the branch.

A sign-off is a statement, not a cryptographic signature: signing commits with an SSH or GPG key is welcome but separate. Commit messages follow Conventional Commits (`type(scope): summary`, imperative and lowercase; see AGENTS.md).

## Editors

### VS Code

Install the recommended Oxc and Tailwind CSS extensions. Use a current VS Code release with native TypeScript 7 support. Accept the workspace TypeScript prompt if shown; `.vscode/settings.json` points to the installed TypeScript 7 package and enables `js/ts.experimental.useTsgo`.

The workspace enables Oxfmt on save, Oxlint safe fixes and type-aware diagnostics, non-relative auto-imports, and type-only auto-imports. Prettier is disabled. CSS remains formatted by Oxfmt, including Tailwind CSS. Class completion covers `cn`, `cx`, `cva`, and custom class-name properties.

### Zed

Install **Oxc** and **TypeScript Language Server** (extension ID `tsgo`, current language-server ID `typescript-ls`). The workspace pins its compiler to 7.0.2 and disables `vtsls` and the older TypeScript language server. Settings preserve your Oxc preferences, with the formatter path adapted to the root `oxfmt.config.ts`. Oxlint keeps nested configuration enabled so the web's React/accessibility rules are picked up.

Both editors use four spaces. Per-package `tsconfig.json` files extend the root TypeScript defaults. `packages/config` is the authoritative source for shared lint and format rules; the root files support automatic editor discovery.

## Browser tests

`bun run e2e` runs the Playwright suite in `e2e/` against the local stack: start `bun run infra:up` first (Postgres, Mailpit, Garage); the dev server is started for you when nothing listens on 5173. Every test context sends its own `x-forwarded-for`, so sign-up's per-address email cap never trips; a dev server you start yourself needs `TRUSTED_PROXY_HEADER=x-forwarded-for` in `.env` (the example sets it). Each run registers its own account through the real sign-up flow, reading the verification link from Mailpit, then uploads, previews, downloads, moves, copies, restores an earlier version and locks the way a person would; a second file registers two people who pin each other's fingerprints and checks the operator area, a third shares a folder between two people, uploads into it as an editor, and revokes, and a fourth opens links as a visitor with no account, with and without a password, keeps a copy while signed in, and sees a stopped link stop. Do not edit source files while it runs: the dev server's full reloads reset the page mid-test. Traces of failures land in `test-results/`; open one with `bunx playwright show-trace <trace.zip>`. `bunx playwright install webkit` once, then `bun run e2e -- --project=webkit`, runs the same suite on WebKit, the engine behind Safari. CI runs Chromium and the phone project on Linux, and WebKit on a macOS runner (Linux has only WebKitGTK, which behaves unlike Safari); that runner has no Docker, so `scripts/infra-native.sh` starts Postgres, Mailpit and Garage from Homebrew instead. Use Playwright for any new browser check rather than a one-off script.

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

## Fuzzing

The crypto twins, `crates/hushos-core` and `packages/crypto`, are fuzzed on everything that parses or verifies bytes a server hands them: the statement grammar, rosters and group key successions, the seal and grant statements and openers (the key seal under varied contexts and readers too), identity envelopes and keys statements, succession links and consent, shares, device statements, fingerprints and pins, acceptance of a whole roster history, drive record statements in all four forms, re-keyed record verdicts (personal and in a group's area), and the re-keyed origin opener. Each target asserts three things: nothing panics (Rust) or throws anything but a `CryptoError` (TypeScript); what a parser accepts re-encodes to exactly its bytes; a verify or open that says yes implies its statement builds. The same target names and input formats serve both twins, so any finding replays in the other.

- **Rust**: cargo-fuzz targets in `crates/hushos-core/fuzz` (its own workspace; the verdict code is `src/targets.rs`). It builds with the nightly pinned in `fuzz/rust-toolchain.toml` (`rustup toolchain install` inside `fuzz/` installs it) and needs cargo-fuzz: `cargo install cargo-fuzz@0.13.2 --locked`. `accept` and `roster_build` build structured inputs with `arbitrary` (`src/structured.rs`).
- **TypeScript**: Jazzer.js targets in `packages/crypto/fuzz` (`verdicts.ts`, entry points in `jazzer.ts`). They run on Node 22 or later from an esbuild bundle: under Bun, Jazzer.js starts but never instruments, so it fuzzes blind.
- **Property tests**: `packages/crypto/src/*.property.test.ts` (fast-check) run with `bun run test`.
- **Differential**: `bun run fuzz:diff` builds `crates/hushos-core/fuzz/examples/verdicts.rs` and feeds both twins the same inputs (seeds, fast-check edits of them, and whatever the corpora hold); the verdicts and outputs must match exactly. Refusal messages are not compared. `FUZZ_DIFF_RUNS` (default 150) sets the edits per target; at least half of them must be compared (neither twin skipping them as misshapen), and every seed must be. Corpus files are replayed newest first, up to `FUZZ_DIFF_CORPUS` (default 300) per directory.

```sh
bun run fuzz                          # every target, both engines, 60 s each
bun run fuzz:rust accept --time 120   # one target, one engine
bun run fuzz:js roster
bun run fuzz:diff
bun run fuzz all roster --merge       # minimise a corpus (-merge=1), as CI does before caching it
```

Runs are sequential, one fuzzer process at a time (`-jobs=1 -workers=1`, `CARGO_BUILD_JOBS=8`, `-rss_limit_mb=2048`), wait while less than a fifth of memory is free, and are capped at 120 s per target locally. Seeds are written from the shared fixtures into `crates/hushos-core/fuzz/corpus/<target>` and `packages/crypto/fuzz/corpus/<target>` (gitignored; `bun run --cwd packages/crypto fuzz:seeds` rewrites them).

A crash lands in `crates/hushos-core/fuzz/artifacts/<target>/` or `packages/crypto/fuzz/artifacts/<target>/`, a divergence in `packages/crypto/fuzz/artifacts/diff-<target>-<hash>`. To triage:

1. Reproduce: `cd crates/hushos-core/fuzz && cargo fuzz run --fuzz-dir . <target> artifacts/<target>/<file>`, or `node packages/crypto/node_modules/@jazzer.js/core/dist/cli.js packages/crypto/fuzz/.build/jazzer.cjs -f <target> <file>` after any `bun run fuzz:js` has built the bundle. `cargo fuzz tmin --fuzz-dir . <target> <file>` (in the same directory) minimises a Rust crash.
2. Replay the input in the other twin: copy it into the other corpus directory and run `bun run fuzz:diff`, which replays both corpora.
3. Decide which twin is wrong against the design docs, fix both if the rule was never written down, and add a regression test beside the code (or a case in the shared fixtures, `bun run fixtures`). Say in the change if it moves what either twin accepts, and check the shipped clients.

CI (`.github/workflows/fuzz.yml`) runs every target for 30 s per engine and the differential on pull requests that touch either twin, and every night each target for 10 minutes per engine on a corpus cached from the night before (minimised before it is saved), uploading crash and diverging inputs as artifacts. The `Rust core tests` job in `ci.yml` runs `cargo test -p hushos-core` on every pull request.

## Environment and project status

`bun run setup` is idempotent, preserves existing settings, and adds missing auth/email defaults. `bun run infra:down` preserves data; avoid removing volumes unless you intend to discard that local database. Keep the generated `.env` when reusing the volume: changing only the password variable does not change an existing Postgres role's password.

HushOS 1.0 is Drive. Accounts (email verification, OPAQUE authentication, remembered unlock, recovery, password changes, master/recovery-key rotation, identity keys, quota grants, permanent deletion), Drive (encrypted tree, resumable uploads, streaming downloads, previews, thumbnails, versions, trash, worker sweeps), sharing (contacts, shares to accounts, links, save a copy, rotation on revoke, change feeds), reports with an evidence pipeline, Polar billing, and the security headers are implemented and covered by the unit and browser suites. The rest of the productivity suite, chat first, builds on the same packages. HushOS is licensed under the [GNU Affero General Public License v3.0 only](LICENSE) (`AGPL-3.0-only`).

## Billing package

`@hushos/billing/server` wraps the Polar SDK (`@polar-sh/sdk`, the `2026-10` API version, imported from `@polar-sh/sdk/2026-10`) behind a few functions: catalogue, checkout, portal session, cancel and resume, webhook handling, and `reconcileCustomer`. Webhooks are a trigger only: every handler re-reads the customer's state from Polar and rewrites the local subscription mirror and storage entitlements in one transaction. With `BILLING_PROVIDER=none` nothing in the package talks to Polar and the app hides every billing surface. To work on it locally, create a sandbox organisation at sandbox.polar.sh, add products with `hushos_plan` and `quota_bytes` metadata, put a sandbox token and webhook secret in `.env` with `POLAR_ENVIRONMENT=sandbox`, and relay deliveries with `polar listen http://localhost:5173/api/billing/webhook`. Webhook payloads follow the API version set on the webhook endpoint, not the client's, so moving the import to another version also means moving the endpoint (docs/self-hosting.md, Billing). Family billing lives in `src/groups.ts` (team customer, checkout with units, raises and cuts, the payer's portal, `reconcileGroup`), with the client and the catalogue shared through `src/provider.ts`; the groups domain calls `ensureGroupSeat` before an admission is written.

## Authentication, cryptography, and email packages

`@hushos/auth/server` owns account enrollment, sessions, and authorization checks; its functions take session or enrollment tokens and plain values, never a request. `@hushos/auth/http` is the only place auth touches HTTP: it reads and writes the token cookies, resolves the client address, and guards browser-originated mutations, so API handlers and server loaders go through it. `@hushos/auth/client` orchestrates the browser flow through `CryptoTransport`, `DeviceKeyStore` and `AuthApi` adapters; web routes own the UI. `AuthApi` (`packages/auth/src/api.ts`) is the contract the client needs from the server; the web app implements it in `apps/web/src/lib/auth-api.ts` with an Eden Treaty client typed by the Elysia app, so a route or response change that the client does not expect fails `bun run typecheck` there. Error handlers in `api.server.ts` must return literal status codes: a plain `number` erases every inferred response type. `@hushos/drive` follows the same split: `./server` is the tree and upload domain the Elysia handlers call, `./client` opens nodes through the crypto worker and turns intent into envelopes, `./transfers` is the upload queue that runs across pages, `./downloads` is the download engine (ordered ranged reads decrypted in the worker, written to a sink the app supplies, zipped for folders, plus a cached random-access reader the viewers use), `./journal` is the IndexedDB upload journal, `./storage` is the S3 client, and `./api` and `./protocol` are the contract and constants a native client would share. Drive's crypto primitives live in `@hushos/crypto/drive`. `@hushos/groups` follows the same split for families (docs/groups-server.md): `./server` is the domain the group routes call, which checks every roster, succession, seal and grant with the crypto core's `@hushos/crypto/group-trust/server` entry before `groupsRepository` stores it under the group's lock; `./api` and `./protocol` are the wire shapes and limits. Its tests (`packages/groups/src/server.test.ts`) run the real core over a real database, with the core's test kit binding generated identities to stored accounts. `@hushos/crypto` owns the protocol versions, OPAQUE client operations, HKDF, and the account-key and workspace-grant envelopes. Its crypto session has no React, HTTP, or worker dependency. Other clients can reuse the protocol and primitives where WebAssembly/Web Crypto are available; native mobile runtime integration is still required. Server OPAQUE primitives have a separate `@hushos/crypto/server` export.

`@hushos/emails/server` owns the SMTP/Resend/SES adapters and fills templates that were rendered at build time: `bun run email:render` renders `packages/emails/src/templates` into `packages/emails/src/rendered/*.ts` with `{{verificationUrl}}` and `{{logoUrl}}` placeholders, and the running server only substitutes those, so React and React Email never load at runtime. Commit the rendered output; CI fails when it is stale. `bun run dev` renders them first, so a fresh dev session starts with current templates; nothing watches the template files after that. Run `bun run email:preview` independently from the app to edit templates. The email PNG is rendered from `apps/web/src/components/logo.tsx`, at three times its displayed size; keep the preview and `apps/web/public/email` copies in sync when changing the mark. Use a public HTTPS app origin for images in delivered emails.

Keep plaintext passwords, session tokens, OPAQUE states, export keys, root keys, workspace keys, and private identity keys out of logs and persistent browser storage. Zustand persists only the encrypted device bundle and lock revision. The worker holds the unlocked root key in memory; the recovery screen temporarily receives the phrase to display/export it and clears it on lock. JavaScript cannot guarantee zeroization of immutable strings or GC copies. See the [auth protocol](docs/opaque-auth-design.md) for native-client boundaries and wire formats.
