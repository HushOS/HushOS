# Contributing

This guide covers local setup, the commands, how the code is laid out, tests and releases. Bun 1.4.4 runs everything, the browser suite included.

- [Set up](#set-up)
- [Commands](#commands)
- [Accounts in development](#accounts-in-development)
- [Commits and sign-off](#commits-and-sign-off)
- [Editors](#editors)
- [Structure and imports](#structure-and-imports)
- [Web and API requests](#web-and-api-requests)
- [Database](#database)
- [Background jobs](#background-jobs)
- [Logging](#logging)
- [Packages](#packages)
- [Tests](#tests)
- [Browser tests](#browser-tests)
- [CI](#ci)
- [Fuzzing](#fuzzing)
- [Component playground](#component-playground)
- [Vendored packages](#vendored-packages)
- [Releasing](#releasing)
- [Project status](#project-status)

## Set up

### What you need

- Bun 1.4.4.
- Docker with Compose 2.24.4 or newer.
- Your editor opened at the **repository root**, so workspace settings and aliases resolve.

### Start the app

Start Docker, then:

```sh
bun install --frozen-lockfile
bun run setup      # writes .env
bun run infra:up   # Postgres, Mailpit and Garage in Docker
bun run db:migrate
bun run dev
```

Open [http://localhost:5173/app](http://localhost:5173/app).

- Docker runs PostgreSQL 18, Mailpit and Garage. The app runs on your machine with live reload.
- `bun run dev` does not start the containers. Run `bun run infra:up` once; Docker keeps them running.
- `bun run dev` also starts the background worker.
- No hosts-file edits, certificates or reverse proxy are needed.

### Local addresses

| Service     | Local address                    | Production example            |
| ----------- | -------------------------------- | ----------------------------- |
| Landing     | http://localhost:5173            | https://hushos.com            |
| Application | http://localhost:5173/app        | https://hushos.com/app        |
| API         | http://localhost:5173/api/health | https://hushos.com/api/health |
| Mailpit     | http://localhost:8025            |                               |
| Garage (S3) | 127.0.0.1:9000                   |                               |
| Postgres    | 127.0.0.1:5433                   |                               |

### The `.env` file

`bun run setup` writes the root `.env`.

- The first run creates it with a unique local database password and an OPAQUE server setup.
- Later runs keep every existing value and add any missing settings.
- Back up the OPAQUE setup with your database.
- The file configures both Compose and the app. Commands load it with Bun's `--env-file`.
- Database commands resolve `../../.env` from `packages/db`.

Keep the generated `.env` while you reuse the Postgres volume. Changing only the password variable does not change an existing role's password.

### Origins and ports

- Pages and the API share one origin. Browser API requests go to `/api`.
- Set `APP_ORIGIN` to the address you use. Authentication accepts requests only from that exact origin.
- HTTP is allowed for localhost. Remote access needs HTTPS.
- `5173` is the default port. Run `PORT=8080 bun run dev` (or `bun run start`) to use another, or set `PORT` in `.env`.
- Compose publishes `PORT` on the host too. Set `APP_ORIGIN` to match when you change it.

Browsers treat localhost as a [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts), so `crypto.subtle` works over local HTTP. From another device these APIs need HTTPS; see [self-hosting](docs/self-hosting.md).

### Postgres

- Postgres is published on `127.0.0.1:5433` for local tools.
- To move it, change `POSTGRES_PORT` and the port in `DATABASE_URL` together.
- Already running PostgreSQL? Set `DATABASE_URL` and skip `bun run infra:up`.
- `bun run infra:down` keeps the data. Remove volumes only to discard that database.

### The full Docker stack

`bun run selfhost:up` builds and runs everything in Docker, as a self-hoster would. It also uses port 5173, so stop the dev server first. Stop commands keep the database volumes.

### Phone apps

The iPhone and Android apps build on the Rust core in `crates/hushos-core`. Build the core once, and again after any change to it:

```sh
bun run core:apple     # then bun run ios:project and bun run ios:run
bun run core:android   # then bun run android:run
```

`apps/ios/AGENTS.md` and `apps/android/AGENTS.md` cover the toolchains, simulators and emulators.

## Commands

### Everyday

| Command             | What it does                                             |
| ------------------- | -------------------------------------------------------- |
| `bun run dev`       | Run the app and the worker with live reload              |
| `bun run build`     | Build the production app                                 |
| `bun run start`     | Run the built app on Bun                                 |
| `bun run check`     | Lint, format check and typecheck                         |
| `bun run typecheck` | Typecheck the root and every package                     |
| `bun run lint`      | Lint with Oxlint, failing on warnings                    |
| `bun run lint:fix`  | Apply available Oxlint fixes                             |
| `bun run format`    | Format the repository with Oxfmt                         |
| `bun run test`      | Run every package's Vitest suite (throwaway databases)   |
| `bun run e2e`       | Run the Playwright browser suite against the local stack |
| `bun run worker`    | Run the background worker on its own                     |

### Database and services

| Command                                 | What it does                                           |
| --------------------------------------- | ------------------------------------------------------ |
| `bun run setup`                         | Create or complete the root `.env`                     |
| `bun run infra:up` / `infra:down`       | Start or stop local Postgres, Mailpit and Garage       |
| `bun run selfhost:up` / `selfhost:down` | Build and start, or stop, the full Docker stack        |
| `bun run db:generate`                   | Generate a migration from the Drizzle schema           |
| `bun run db:migrate`                    | Apply checked-in migrations with Drizzle Kit           |
| `bun run db:studio`                     | Open Drizzle Studio                                    |
| `bun run admin:grant <email>`           | Make an account an operator (`admin:revoke` undoes it) |
| `bun run polar:seed`                    | Create the plan products in your Polar organisation    |

### Email, images and tokens

| Command                   | What it does                                                   |
| ------------------------- | -------------------------------------------------------------- |
| `bun run email:render`    | Render the email templates into `packages/emails/src/rendered` |
| `bun run email:preview`   | Live template preview at http://localhost:3001                 |
| `bun run email:build`     | Build the standalone preview                                   |
| `bun run email:start`     | Serve that built preview                                       |
| `bun run images:optimize` | Regenerate the email logos and optimise PNG assets             |
| `bun run tokens`          | Write the design tokens out for web, iOS and Android           |

### Phones and the Rust core

| Command               | What it does                                           |
| --------------------- | ------------------------------------------------------ |
| `bun run ios:run`     | Build the iPhone app and run it in the simulator       |
| `bun run android:run` | Build the Android debug app and run it in the emulator |
| `bun run core:test`   | Run the Rust workspace's tests                         |
| `bun run core:check`  | Rust format, Clippy and tests, the fuzz crate included |
| `bun run fixtures`    | Rewrite the shared crypto fixtures for both twins      |

Fuzzing and release commands are in [Fuzzing](#fuzzing) and [Releasing](#releasing).

### Adding UI components

Tailwind's configuration lives in `apps/web/src/styles.css`. Add more Base UI components with:

```sh
bunx shadcn@latest add dialog --cwd apps/web
```

## Accounts in development

### Sign up

1. Open `/register` and enter your email. You land on `/register/check-email`.
2. Open the verification message in [Mailpit](http://localhost:8025). It leads to `/register/complete`.
3. Choose your name and a password of 12–128 characters.
4. On `/setup/recovery-key`, save the 24-word recovery phrase or download its recovery kit. The QR code holds the same private phrase.
5. Confirm it is saved and choose "Continue to HushOS".

### What a new account gets

The signup transaction creates, together:

- a personal workspace;
- its workspace key, generated in the browser at random and granted to the account by wrapping it under the account key;
- a **2 GB** allowance, counted in 1024s as the app counts every size.

`INITIAL_STORAGE_QUOTA_BYTES` sets the allowance for future accounts. Paid plans add more through Polar; see [billing in the self-hosting guide](docs/self-hosting.md#billing-optional).

Drive reserves an upload's ciphertext size against the allowance before any byte moves. It counts as used once the store confirms the object. See [the Drive design](docs/drive-design.md).

### Sign-in and saved unlock

- `/login` unlocks the account key in a worker.
- A non-exportable Web Crypto device key in IndexedDB protects an encrypted account-key bundle in localStorage (Zustand persist).
- A refresh or new tab restores that key only after checking a live server session and the credential revision.
- Lock or sign-out removes saved device access in every tab.
- The server session slides. It ends after seven days without a request, and never lasts beyond thirty days from sign-in.

Non-exportability does not stop XSS: a compromised origin can still misuse a saved device key.

### Recovery and account settings

`/recover` needs both your email and your recovery phrase. It replaces your password and keeps the root key and permanent identity. It also revokes existing sessions and replaces the recovery phrase.

`/app/account` offers these changes. Each needs fresh OPAQUE password confirmation.

| Change                | What it does                                                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Password              | Keeps every encryption key                                                                                                  |
| Recovery-key rotation | Replaces the 24 words                                                                                                       |
| Master-key rotation   | Replaces the root key and recovery phrase, keeps identity keys, rewraps every workspace grant (workspace keys never change) |
| Permanent deletion    | Deletes the account                                                                                                         |

Security changes revoke other sessions. Rotations return you to the recovery setup page to save the new phrase.

### Email

- Emails use React Email and the HushOS logo.
- `EMAIL_ADAPTER` selects `smtp`, `resend` or `ses`; see [configuration](docs/self-hosting.md#authentication-and-email).
- Mailpit captures local mail without sending it anywhere.
- The email preview (`bun run email:preview`) runs apart from `bun run dev`.
- React Email's Resend preview setup is separate from `EMAIL_ADAPTER` and `RESEND_API_KEY`. Preview sending uses the CLI's saved configuration; delivery uses the server's environment.

### Social previews and appearance

- `/og.jpg` and `/og/<page>.jpg` are rendered with Takumi, the local Geist font and the logo.
- A share link's preview is generic by design. The server knows nothing about what is behind a link, so it has nothing to show.
- Appearance defaults to **System**. **Light** and **Dark** are saved in a cookie. System follows the operating system without a reload.

## Commits and sign-off

### Sign every commit

Every commit carries a `Signed-off-by: Your Name <you@example.com>` line. It certifies the [Developer Certificate of Origin](https://developercertificate.org/): you wrote the change, or otherwise have the right to submit it under AGPL-3.0-only.

- Add it with `git commit -s`.
- The name and email must match the commit's author.
- The DCO check on every pull request fails on any commit without one.
- To fix a branch you already pushed, run `git rebase --signoff origin/main` and force-push it.

A sign-off is a statement, not a cryptographic signature. Signing commits with an SSH or GPG key is welcome, but separate.

### Commit messages

Commit messages follow Conventional Commits: `type(scope): summary`, imperative and lowercase. AGENTS.md lists the types and scopes.

## Editors

### VS Code

- Install the recommended Oxc and Tailwind CSS extensions.
- Use a current release with native TypeScript 7 support.
- Accept the workspace TypeScript prompt if it appears. `.vscode/settings.json` points at the installed TypeScript 7 and enables `js/ts.experimental.useTsgo`.

The workspace turns on:

- Oxfmt on save, CSS and Tailwind included (Prettier is off);
- Oxlint safe fixes and type-aware diagnostics;
- non-relative and type-only auto-imports;
- class completion in `cn`, `cx`, `cva` and custom class-name properties.

### Zed

- Install **Oxc** and **TypeScript Language Server** (extension ID `tsgo`, language-server ID `typescript-ls`).
- The workspace pins the compiler to 7.0.2 and turns off `vtsls` and the older TypeScript language server.
- Settings keep your Oxc preferences, with the formatter pointed at the root `oxfmt.config.ts`.
- Oxlint keeps nested configuration on, so the web app's React and accessibility rules apply.

### Both

- Four-space indentation.
- Each package's `tsconfig.json` extends the root TypeScript defaults.
- `packages/config` is the source of truth for lint and format rules. The root files exist so editors find them.

## Structure and imports

### Where code goes

- Web pages and layouts live in `apps/web/src/routes/` as directory routes (`app/route.tsx`, `app/index.tsx`).
- Reusable UI lives in `src/components/`; shared helpers in `src/lib/`.
- Elysia handlers live in one Elysia instance per feature in `apps/web/src/lib/api/` (`auth`, `billing`, `drive`, `admin`, `groups`, `system`). Shared context, schemas and helpers are in `api/shared.server.ts`.
- `apps/web/src/lib/api.server.ts` composes them into one app, and `src/routes/api/$.ts` hands `/api` requests to it. A new route goes in its feature's file, inside that feature's `.guard(...)`.
- The guards are Elysia macros in `api/shared.server.ts`: `mutation` (a write carries this app's Origin and JSON), `client` (a named client at the minimums), `groupWrite` (the family-change floor), `session` (a signed-in `user`) and `admin` (an `operator`). A handler takes `user` or `operator` from its context, never from a helper it calls.
- A route outside every guard is public: add it to `PUBLIC` in `api/guards.test.ts` with why. That test fails for any other route that doesn't run its feature's checks.
- Extract more modules when reuse or complexity calls for it.
- `routeTree.gen.ts` is checked in. The dev server and the build regenerate it, and CI fails when the committed copy is stale.

### Imports

- Use `@/*` within the web app and `@hushos/*` between workspaces.
- Export shared runtime code through the owning package's `package.json`. Never import relatively into another workspace.
- Workspace packages export TypeScript source, which Vite and Bun compile with the app.
- Use `import type` for API contracts.
- Keep server runtime imports in server routes, server modules or `createIsomorphicFn().server(...)`, so the browser build leaves them out.

### Small packages

- `@hushos/shared` supplies only `API_SERVICE`, which `/api/health` returns.
- `@hushos/utils` is a placeholder that nothing imports yet.

## Web and API requests

### One server

- Nitro hosts TanStack Start and the mounted Elysia app on one origin.
- API endpoints sit under `/api`: `/api/health`, `/api/ready`, `/api/auth/*` and the rest.
- Local development needs no custom hostname or certificate.

### The browser client

- `apps/web/src/lib/api-client.ts` makes one Eden Treaty client, typed by the Elysia app's exported `Api` type. It runs only in the browser.
- Adapters wrap it per area: `auth-api.ts`, `billing-api.ts`, `drive-api.ts`, `growth-api.ts` and `groups/api.ts` in `apps/web/src/lib`.
- Server code reads the database directly, through server functions and `createIsomorphicFn().server(...)` branches. There is no in-process HTTP client.

### React Query and SSR

- Each SSR request gets a fresh QueryClient, with TanStack's hydration and streaming integration.
- For a query the server should render, use `ensureQueryData` in a loader and `useSuspenseQuery` in the page.

### Origins and CORS

- Auth mutations require `Origin` to match `APP_ORIGIN`. Auth uses HttpOnly cookies.
- Signing in from a LAN address or a Tailscale hostname needs `APP_ORIGIN` set to it, with HTTPS in front.
- The dev server answers LAN addresses and `*.ts.net` hostnames. Add others to `allowedHosts` in `apps/web/vite.config.ts`.
- In development the API answers cross-origin `GET` requests without credentials. Production allows no cross-origin API access.

## Database

### The client

- Import the shared `db` from `@hushos/db` in API and server code.
- `packages/db/src/client.ts` builds it from `DATABASE_URL`. Drizzle creates the PostgreSQL pool.
- Keep SQL in the database package. Web and auth code use its repository exports.

The web build bundles that module twice, once with Nitro's plugins and once with the app, so the web process holds two pools. The Nitro database plugin ends both on shutdown with `endPools()`.

Nitro runs only the plugins listed in `apps/web/nitro.config.ts`. Add a new one there.

### Schema

The pinned Drizzle v1 RC registers the tables from `packages/db/src/schema/index.ts` through `defineRelations`, which enables typed queries:

```ts
import { db } from '@hushos/db';

const workspaces = await db.query.workspaces.findMany();
```

The schema files in `packages/db/src/schema`:

- `auth.ts`
- `billing.ts`
- `drive.ts`
- `groups.ts`
- `growth.ts`
- `relations.ts`
- `storage.ts`
- `workspace-keys.ts`
- `workspaces.ts`
- `index.ts`, the barrel

### Migrations

1. Change the schema.
2. Run `bun run db:generate`.
3. Review the SQL.
4. Apply it with `bun run db:migrate`.
5. Commit the migration and snapshot in `packages/db/drizzle`.

Drizzle Kit reads `packages/db/drizzle.config.ts`. It uses `MIGRATION_DATABASE_URL` when set, otherwise `DATABASE_URL`.

## Background jobs

`@hushos/jobs` is the background worker, pg-boss on the same Postgres. It sweeps expired auth rows, reconciles billing, and runs Drive's expiry, purge, replication, deletion, audit, orphan-sweep and tiering jobs.

| Where                         | What                                    |
| ----------------------------- | --------------------------------------- |
| `packages/jobs/src/client.ts` | Queue names, payload types and policies |
| `packages/jobs/src/jobs/`     | Handlers                                |
| `packages/jobs/src/worker.ts` | The process                             |

- `bun run dev` starts it with the app. `bun run worker` runs it alone.
- Compose runs it as the `worker` service, from its own small image.
- The web app may only `enqueue()`. Never run scheduled or long work inside a request.
- pg-boss migrates its own `pgboss` schema. Do not add it to the Drizzle migrations.

## Logging

### Request events

- `@hushos/logging` owns the evlog dependency, its browser-safe error helpers and the Nitro integration.
- The evlog Nitro module emits one event per completed HTTP request: pages, server functions, static assets and the API.
- API paths log as service `HushOS API`; everything else as `HushOS Web`.
- Logs go to the console, as JSON in production. No external drain is configured, and there is no client logging.

### Request IDs

- The request-context plugin generates a UUID and returns it in `X-Request-ID`.
- Caller-provided IDs are not copied into logs.
- Treat the ID as a correlation label, never an identity or authorisation claim.

### Using the logger

In server code and async helpers:

```ts
import { useLogger, useRequestId } from '@/lib/logging.server';
import { createError, parseError } from '@hushos/logging';

useLogger().set({ action: 'example' });
const requestId = useRequestId();
```

- Elysia handlers also get `log` and `requestId` on their context. They reuse the current Nitro logger and never emit a second event.
- Direct SSR calls share that context. Later browser requests get their own IDs.
- Elysia's error hook records failures on the same logger and formats `EvlogError` responses.
- The root route uses `safeErrorHandler` from `@hushos/logging/nitro`, which wraps evlog's handler, for TanStack errors.

### The auth wrapper

TanStack Start supplies its default request handling and CSRF middleware. Before calling Elysia, the auth HTTP wrapper also enforces:

- the exact origin;
- a JSON content type;
- a streaming body limit, 16 KiB by default and larger for routes that carry identities or settings;
- rate limits;
- private, no-store responses.

Rejections still get the outer Nitro request event.

### Redaction

`packages/logging/src/privacy.ts` turns redaction on in development and production.

- Auth events keep only approved operational fields, with an allowlisted action and outcome.
- Bodies, headers, email addresses, cookies, passwords, OPAQUE payloads, key bundles, recovery phrases and raw errors are removed before console output and drains.
- Never attach raw requests, database or provider errors, or crypto state to a logger.

## Packages

### Auth: `@hushos/auth`

| Entry                | Role                                                                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `./server`           | Enrollment, sessions and authorisation checks. Takes tokens and plain values, never a request.                                                  |
| `./http`             | The only place auth touches HTTP: token cookies, the client address, guarding browser mutations. API handlers and server loaders go through it. |
| `./client`           | Runs the browser flow through the `CryptoTransport`, `DeviceKeyStore` and `AuthApi` adapters. Web routes own the UI.                            |
| `./api`              | `AuthApi`, the contract the client needs from the server (`packages/auth/src/api.ts`).                                                          |
| `./crypto-transport` | The boundary between the auth client and the crypto worker.                                                                                     |

Other entries: `./device-storage`, `./protocol`, `./worker`.

The web app implements `AuthApi` in `apps/web/src/lib/auth-api.ts` with the Eden Treaty client. A route or response change the client does not expect then fails `bun run typecheck` there.

Error handlers (`onError` in `api/shared.server.ts`) must return literal status codes. A plain `number` erases every inferred response type.

### Drive: `@hushos/drive`

| Entry                 | Role                                                                                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `./server`            | The tree and upload domain the Elysia handlers call                                                                                                      |
| `./client`            | Opens nodes through the crypto worker and turns intent into envelopes                                                                                    |
| `./transfers`         | The upload queue that runs across pages                                                                                                                  |
| `./downloads`         | Ordered ranged reads decrypted in the worker, written to a sink the app supplies, zipped for folders, plus a cached random-access reader for the viewers |
| `./journal`           | The IndexedDB upload journal                                                                                                                             |
| `./storage`           | The S3 client                                                                                                                                            |
| `./api`, `./protocol` | The contract and constants a native client would share                                                                                                   |

Other entries: `./catalogue`, `./jobs`, `./mirror`, `./tags`, `./trust`.

Drive's crypto primitives live in `@hushos/crypto/drive`.

### Families: `@hushos/groups`

See [docs/groups-server.md](docs/groups-server.md).

| Entry                 | Role                             |
| --------------------- | -------------------------------- |
| `./server`            | The domain the group routes call |
| `./api`, `./protocol` | Wire shapes and limits           |

- `./server` checks every roster, succession, seal and grant with `@hushos/crypto/group-trust/server`.
- Only then does `groupsRepository` store it, under the group's lock.
- Its tests (`packages/groups/src/server.test.ts`) run the real crypto core over a real database. The core's test kit binds generated identities to stored accounts.

### Crypto: `@hushos/crypto`

- Owns the protocol versions, OPAQUE client operations, HKDF, and the account-key and workspace-grant envelopes.
- Its crypto session has no React, HTTP or worker dependency.
- Server OPAQUE primitives are a separate export, `@hushos/crypto/server`.
- The phone apps do not use this package. They run its Rust twin, `crates/hushos-core`, through generated Swift and Kotlin bindings. The two are kept in step by shared fixtures and differential fuzzing.

### Billing: `@hushos/billing`

`@hushos/billing/server` wraps the Polar SDK (`@polar-sh/sdk`, API version `2026-10`, imported from `@polar-sh/sdk/2026-10`).

- It covers the catalogue, checkout, portal sessions, cancel and resume, webhooks and `reconcileCustomer`.
- Webhooks are only a trigger. Every handler re-reads the customer's state from Polar and rewrites the local subscription mirror and storage entitlements in one transaction.
- With `BILLING_PROVIDER=none`, nothing talks to Polar and the app hides every billing surface.

| File              | Role                                                                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/groups.ts`   | Family billing: team customer, checkout with units, raises and cuts, the payer's portal, `reconcileGroup`                                                                        |
| `src/provider.ts` | The Polar client and catalogue, shared by personal and family billing                                                                                                            |
| `src/endings.ts`  | Ending a personal plan, with its prorated refund, when that person's files join a family's pool (the worker's `billing.end-personal-plan` job; docs/families-shared-pool.md 5.1) |

The groups domain calls `ensureGroupSeat` before it writes an admission.

To work on billing locally:

1. Create a sandbox organisation at sandbox.polar.sh.
2. Put a sandbox token and webhook secret in `.env`, with `POLAR_ENVIRONMENT=sandbox`.
3. Add products with `hushos_plan` and `quota_bytes` metadata. `bun run polar:seed` creates them.
4. Relay deliveries with `polar listen http://localhost:5173/api/billing/webhook`.

Webhook payloads follow the API version set on the webhook endpoint, not the client's. Moving the import to another version means moving the endpoint too (docs/self-hosting.md, Billing).

### Email: `@hushos/emails`

`@hushos/emails/server` owns the SMTP, Resend and SES adapters. It fills templates rendered at build time, so React and React Email never load at runtime.

- `bun run email:render` renders `packages/emails/src/templates` into `packages/emails/src/rendered/*.ts`, with `{{verificationUrl}}` and `{{logoUrl}}` placeholders.
- The running server only substitutes those placeholders.
- Commit the rendered output. CI fails when it is stale.
- `bun run dev` renders them first. Nothing watches the templates after that.
- Edit templates with `bun run email:preview`, apart from the app.
- Use a public HTTPS app origin for images in delivered emails.

The email logo, `hushos-logo-square.png`, is the brand square from `apps/web/src/lib/brand.ts` at three times its displayed size. `bun run images:optimize` writes it to both the preview and `apps/web/public/email`. Keep the two in step when the mark changes.

### Secrets in the browser

Keep these out of logs and persistent browser storage:

- plaintext passwords and session tokens;
- OPAQUE states and export keys;
- root keys, workspace keys and private identity keys.

How the web app holds them:

- Zustand persists only the encrypted device bundle and the lock revision.
- The worker holds the unlocked root key in memory.
- The recovery screen receives the phrase only to display or export it, and clears it on lock.
- JavaScript cannot guarantee zeroisation of immutable strings or GC copies.

See the [auth protocol](docs/opaque-auth-design.md) for native-client boundaries and wire formats.

## Tests

Tests are required where a mistake costs money or data: billing, crypto, and transactional repository functions.

- Examples: the billing entitlement transaction, the billing server against a fake Polar with real webhook signatures, and the crypto envelopes.
- Add to them whenever you touch those paths.
- A new package that handles keys, quota or payments gets a suite.
- UI and marketing code is checked by hand.

### Vitest

- Every package uses Vitest. Tests live beside the code as `*.test.ts`.
- `bun run test` at the root runs them all through Turbo. `bun run --cwd packages/db test` runs one package.
- The root `vitest.config.ts` lists every package as a project. The VS Code Vitest extension (recommended in `.vscode/extensions.json`) finds them all and runs a single test from the gutter. Database setup runs on its own from `.env`.
- `packages/db/test/helpers.ts` creates accounts without the OPAQUE ceremony.
- Fixtures are fixed values, not generated ones, so a failure reproduces.
- The Polar SDK is replaced with `vi.mock`. Nothing in the tests reaches the network.
- Web tests use jsdom today. Browser mode with Playwright is the intended replacement, since the auth client needs Web Crypto, IndexedDB and workers, which jsdom lacks.
- Keep route tests outside `src/routes/` so TanStack does not treat them as routes.

### Database tests

- They run against a throwaway database: `DATABASE_URL`'s name with `_test` appended.
- `packages/db/test/global-setup.ts` creates and migrates it on each run. Set `TEST_DATABASE_URL` (in the shell or `.env`) to use another.
- Tables are truncated before every test. The development database is never touched.
- If the test database's migration ledger names a migration this checkout lacks (another branch migrated it), it is dropped and created again.

### Database tests in a worktree

Two checkouts on the same base share its `<name>_test_<package>` databases. One can then drop or truncate a database in the middle of the other's run.

So a linked worktree refuses to run database tests until its `.env` names a `TEST_DATABASE_URL` no other checkout uses. The main checkout is never refused.

Create a base database for the worktree once:

```sh
docker compose exec -T db psql -U hushos -d postgres -c "create database hushos_<worktree>"
```

Drop it and its `_test_*` databases when you remove the worktree.

### Before you submit

```sh
bun run check
bun run build
```

AGENTS.md also asks for `bun run format`, `bun run lint`, `bun run typecheck` and `bun run test` before every commit.

## Browser tests

### Run them

```sh
bun run infra:up   # Postgres, Mailpit and Garage
bun run e2e
```

- The Playwright suite lives in `e2e/`.
- If nothing listens on 5173, the dev server is started for you.
- Do not edit source files during a run. The dev server's full reloads reset the page mid-test.
- Use Playwright for any new browser check, not a one-off script.

### What they do

- Each spec registers its own accounts through the real sign-up flow, reading the verification link from Mailpit.
- From there it uses the app the way a person would: uploads, previews, sharing, links, families, recovery and the rest, one spec per area.
- Every test context sends its own `x-forwarded-for`, so sign-up's per-address email cap never trips.
- A dev server you start yourself needs `TRUSTED_PROXY_HEADER=x-forwarded-for` in `.env`. The example sets it.

### Test a server of your own

- Set `E2E_BASE_URL` to the server and `E2E_DATABASE_URL` to its database.
- The specs that make someone an operator reach the database directly. The root `.env` names yours.
- The admin script refuses the `hushos` database while `E2E_BASE_URL` is set.

### Traces

Traces of failures land in `test-results/`. Open one with:

```sh
bunx playwright show-trace <trace.zip>
```

### WebKit

WebKit is the engine behind Safari.

```sh
bunx playwright install webkit   # once
bun run e2e -- --project=webkit
```

## CI

### On every pull request and push to `main`

- `bun run check` (lint, format and typecheck), `bun run test` and `bun run build`.
- The Chromium suite (projects `chromium` and `mobile`) and the families-on suite, both against that one production build (`bun run start`, web and jobs worker).
- The Chromium suite is split into shards by measured time in `scripts/e2e-shard.sh`.
- A pull request that touches only Markdown or `docs/` skips the browser suites. MDX pages and `DESIGN.md` render in the app, so they do not count. A push to `main` always runs them.
- `CI ok` passes when every job that ran passed. It is the one check to require.

### Images and deploys

- After the check passes on `main`, CI builds and publishes the web, migration and worker images to GHCR.
- The deploy waits for those images and the Linux browser suites.
- See [self-hosting](docs/self-hosting.md#container-publishing) for image names and tags.

### WebKit

WebKit is not part of CI and gates neither pull requests nor deploys.

- `.github/workflows/webkit.yml` builds on macOS and runs the suite in four shards.
- It runs every night against `main`, by hand (Actions, WebKit, Run workflow, with an optional ref), and on a pull request labelled `full-ci`.
- Add `full-ci` to a change to on-device storage, device keys or the file viewer, where WebKit has differed.
- A failed nightly or manual run on `main` opens or updates a `WebKit failed on main` issue. A run cancelled because no macOS runner was free does not.
- Linux has only WebKitGTK, which behaves unlike Safari, so it runs on macOS.
- That runner has no Docker. `scripts/infra-native.sh` starts Postgres, Mailpit and Garage from Homebrew.

## Fuzzing

The crypto twins, `crates/hushos-core` and `packages/crypto`, are fuzzed on everything that parses or verifies bytes a server hands them.

### What is fuzzed

- **Statements:** the statement grammar; seal and grant statements and their openers (the key seal under varied contexts and readers too); identity envelopes and keys statements; device statements; drive record statements in all four forms.
- **Rosters and successions:** rosters and group key successions; acceptance of a whole roster history; succession links and consent; the links offered for successor consent and the consent signed for them.
- **Managers and admins:** a manager's roster calls (an admission with a served identity changed, role changes, the handover); the admin's join code over served rosters.
- **Sharing and contacts:** shares; fingerprints and pins.
- **Re-keying:** re-keyed record verdicts, personal and in a group's area; the re-keyed origin opener.
- **Joining:** join previews and the typed words of a join code; the hidden positions drawn for a join code; whole join sessions driven through both twins (held positions never move until a match, a restore only holds more, no join without a match).
- **Device and settings:** outbox entries as the device store holds them; settings documents as the ledger opens them.
- **Family folders:** opened from what route 25 serves, self-grants first.

### What every target checks

1. Nothing panics (Rust) or throws anything but a `CryptoError` (TypeScript).
2. What a parser accepts re-encodes to exactly its bytes.
3. A verify or open that says yes implies its statement builds.

Both twins share target names and input formats, so any finding replays in the other.

### The engines

| Engine         | Where                                                                                                |
| -------------- | ---------------------------------------------------------------------------------------------------- |
| Rust           | cargo-fuzz targets in `crates/hushos-core/fuzz`, its own workspace. Verdicts in `src/targets.rs`.    |
| TypeScript     | Jazzer.js targets in `packages/crypto/fuzz`. Verdicts in `verdicts.ts`, entry points in `jazzer.ts`. |
| Property tests | `packages/crypto/src/*.property.test.ts` (fast-check), run by `bun run test`                         |
| Differential   | `bun run fuzz:diff` feeds both twins the same inputs                                                 |

Rust:

- It builds with the nightly pinned in `fuzz/rust-toolchain.toml`. `rustup toolchain install` inside `fuzz/` installs it.
- It needs cargo-fuzz: `cargo install cargo-fuzz@0.13.2 --locked`.
- `accept` and `roster_build` build structured inputs with `arbitrary` (`src/structured.rs`).

TypeScript:

- Jazzer.js runs on Node 22 or later, from an esbuild bundle.
- Under Bun, Jazzer.js starts but never instruments, so it fuzzes blind.

Differential:

- It builds `crates/hushos-core/fuzz/examples/verdicts.rs` and feeds both twins seeds, fast-check edits of them, and whatever the corpora hold.
- Verdicts and outputs must match exactly. Refusal messages are not compared.
- `FUZZ_DIFF_RUNS` (default 150) sets the edits per target. At least half must be compared (neither twin skipping them as misshapen), and every seed must be.
- Corpus files replay newest first, up to `FUZZ_DIFF_CORPUS` (default 300) per directory.

### Run it

```sh
bun run fuzz                          # every target, both engines, 60 s each
bun run fuzz:rust accept --time 120   # one target, one engine
bun run fuzz:js roster
bun run fuzz:diff
bun run fuzz all roster --merge       # minimise a corpus (-merge=1), as CI does before caching it
```

- Runs are sequential, one fuzzer process at a time (`-jobs=1 -workers=1`, `CARGO_BUILD_JOBS=8`, `-rss_limit_mb=2048`).
- They wait while less than a fifth of memory is free.
- Locally they are capped at 120 s per target.
- Seeds are written from the shared fixtures into `crates/hushos-core/fuzz/corpus/<target>` and `packages/crypto/fuzz/corpus/<target>`. Both are gitignored; `bun run --cwd packages/crypto fuzz:seeds` rewrites them.

### Triage a finding

A crash lands in `crates/hushos-core/fuzz/artifacts/<target>/` or `packages/crypto/fuzz/artifacts/<target>/`. A divergence lands in `packages/crypto/fuzz/artifacts/diff-<target>-<hash>`.

1. **Reproduce.** Rust: `cd crates/hushos-core/fuzz && cargo fuzz run --fuzz-dir . <target> artifacts/<target>/<file>`. Minimise with `cargo fuzz tmin --fuzz-dir . <target> <file>` in the same directory. TypeScript, after any `bun run fuzz:js` has built the bundle: `node packages/crypto/node_modules/@jazzer.js/core/dist/cli.js packages/crypto/fuzz/.build/jazzer.cjs -f <target> <file>`.
2. **Replay in the other twin.** Copy the input into the other corpus directory and run `bun run fuzz:diff`, which replays both corpora.
3. **Fix.** Decide which twin is wrong against the design docs. Fix both if the rule was never written down. Add a regression test beside the code, or a case in the shared fixtures (`bun run fixtures`).
4. **Say so.** Note in the change if it moves what either twin accepts, and check the shipped clients.

### In CI

- `.github/workflows/fuzz.yml` runs on pull requests that touch either twin: every target for 30 s per engine, plus the differential.
- Every night it runs each target for 10 minutes per engine, on a corpus cached from the night before (minimised before it is saved).
- Crash and diverging inputs are uploaded as artifacts.
- The `Rust core tests` job in `ci.yml` runs `cargo test -p hushos-core` when `crates/`, the Cargo files or `packages/crypto` change.

## Component playground

### Open it

Run `bun run dev`, then open `http://localhost:5173/dev/components` (and `/dev/layers`).

- It shows every component in `src/components/ui/` and the main app pieces, in each variant, size and state.
- The app pieces sit on a frame drawn like the page sheet.

### The DialKit panel

The [DialKit](https://github.com/joshpuckett/dialkit) panel sits on the right, or behind a floating button on a phone. It starts with **Playground**:

- **Scheme:** light, dark and their high-contrast versions, set with the app's own `light`, `dark` and `hc` classes, without saving them.
- **Measure:** draws edges and px distances over each demo.
- **States:** forces hover and focus-visible through `data-force` attributes.

The panels below tune padding, radius, gap, icon size and offset, springs and the layers' shadows. A panel's copy button puts its values on the clipboard to paste back into code.

### Development only

- `src/router.tsx` adds the routes behind `import.meta.env.DEV`, which a build replaces with `false`. The routes, pages and DialKit never reach the output.
- `src/styles.css` keeps `src/dev` out of Tailwind's scan. The playground makes its own utilities in `src/dev/playground.css`.
- `bun run build` ends with `apps/web/scripts/check-dev-only.ts`, which fails if any of it does reach the output.
- The files live in `src/dev/`, outside `src/routes/`, so `routeTree.gen.ts` never changes.

### Add a component

1. Write a function in `src/dev/demos/` that returns a `<Demo id title note>` with its samples: `Row`, `Sample`, `States` for forced states, `SheetFrame` for a piece that sits on the page sheet.
2. Add it to `DEMOS` in `src/dev/components-page.tsx`.
3. Give it a `useDialKit(name, config, { id })` panel for the values worth tuning.

A rule worth showing gets a `Breakdown`: the demo large in a frame, with Measure drawn over it and a switch between two versions. A layer is one entry in `LAYERS` in `src/dev/layers.ts`.

## Vendored packages

SheetJS publishes `xlsx` releases after 0.18.5 only on its own CDN, not on npm. Installs from that CDN sometimes stalled CI: the headers arrived, the body never finished, and `bun install` waited until the job timed out.

So the tarball lives in `vendor/xlsx-0.20.3.tgz`.

- The root and `apps/web` `package.json` files point at it with `file:`.
- `bun.lock` records its sha512, so a changed file fails `--frozen-lockfile`.
- The Dockerfiles copy `vendor/` before they install.

To move to a new release:

1. Download its `.tgz` from `https://cdn.sheetjs.com/`.
2. Replace the file.
3. Update both specifiers.
4. Run `bun install`.

## Releasing

### One version

HushOS has one version for the server, the web app, the Docker images and both phone apps: `version` in the root `package.json`.

[release-please](https://github.com/googleapis/release-please) keeps it, through `.github/workflows/release.yml`, `release-please-config.json` and `.release-please-manifest.json`.

### How a release pull request forms

On every push to `main`, release-please reads the Conventional Commit subjects since the last release. It keeps one pull request open, `chore(main): release X.Y.Z`.

| Commit                             | Bump  |
| ---------------------------------- | ----- |
| `fix`, `perf`                      | Patch |
| `feat`                             | Minor |
| `!` or a `BREAKING CHANGE:` footer | Major |

The pull request writes the version into:

- `package.json` and the manifest;
- `MARKETING_VERSION` in `apps/ios/project.yml`;
- `versionName` in `apps/android/app/build.gradle.kts`;
- `hushos-core` in its `Cargo.toml` and both `Cargo.lock` files.

It also prepends the notes to `CHANGELOG.md`.

- The notes list features, bug fixes, performance and reverts.
- `docs`, `chore`, `ci`, `test`, `build`, `style` and `refactor` are left out. On their own they open no release pull request.
- `bun run check:versions` fails when any copy disagrees with `package.json`. CI reports that as a warning so it never holds up a deploy. The store build scripts refuse to build, and the release skips its image tags.

### Cut a release

1. Squash-merge the release pull request.
2. release-please tags the merge commit `vX.Y.Z` and publishes a GitHub release with the same notes.
3. The merge commit deploys like any push to `main`.

### Image tags

- CI publishes the merge commit's images as `sha-<commit>`, and moves `latest` to them once the Linux suites pass.
- `release.yml`'s images job copies those images by digest to `X.Y.Z` (web, worker and migrate). It also moves `X.Y` and `X`, but only while this is the highest release in them. Nothing is rebuilt.
- It copies once that commit's CI has passed the Linux suites: when the release appears if CI already has, otherwise when CI finishes.
- If CI failed, re-run it for that commit. The Release workflow copies the tags when the re-run passes.
- A re-run rebuilds `sha-<commit>` with a new digest, so an existing `X.Y.Z` stays on the old one. Running the Release workflow by hand with the tag replaces it, and skips the CI check.

Once all three images are tagged, the notes job writes a **Server images** section below the changelog:

- each image at `X.Y.Z` as a `docker pull` line pinned by digest;
- a link to the upgrade steps in docs/self-hosting.md.

That is `scripts/release-images-notes.sh`, which also runs by hand for a release whose tags exist. Every run rewrites the section between its marker comments rather than adding another.

### Android: the release workflow

When the release is published, `.github/workflows/android-release.yml`:

1. builds the signed bundle at the tag (`bundle-release.sh`);
2. checks its signer, version and supported phones against the previous release's APK (`apps/android/scripts/check-bundle.sh`);
3. puts it on Google Play's internal testing track (`apps/android/scripts/play-publish.sh`, androidpublisher edits through curl);
4. runs `release-apk.sh` for the APK and the notes' Android section.

The API skips Play Console's device-count review. So a change in supported phones stops at step 2, unless the workflow runs again with `-f accept-device-change=true`.

Production is by hand, after a check on a phone:

```sh
gh workflow run android-release.yml --ref vX.Y.Z -f action=promote
```

- Runs by hand always name the tag with `--ref`. `-f action=dry-run` validates without committing anything.
- The jobs run in the `play` environment, which only `v*` tags may use.
- They reach Google through Workload Identity Federation. There is no Google key anywhere.
- Without the environment's variables and the upload key, it logs a notice and does nothing.
- One-time setup (Google Cloud, Play Console, the environment) and the first dry run are in docs/release/google-play-ci.md.

### iPhone: the release workflow

`.github/workflows/ios-release.yml` runs when the release is published.

- **Sideload IPA:** built and attached to the release, with the notes' iOS section (`release-ipa.sh`).
- **App Store upload:** archived, signed with the `app-store` environment's API key, and uploaded to TestFlight (`archive.sh`).
- **Both skip with a warning** while GitHub's macOS runners lack the Xcode major version in `apps/ios/project.yml`. Build them by hand then (below).
- **App Review is a separate step, by hand:**

    ```sh
    gh workflow run ios-release.yml --ref vX.Y.Z -f action=submit -f whats-new="…"
    ```

    - `-f action=dry-run` reads everything and changes nothing.
    - `-f build=N` submits a re-upload made with `HUSHOS_BUILD_NUMBER`.

- Setup (the API key, the environment) is in docs/release/apple.md, section 7.

### By hand, for every release

After the tag and the GitHub release exist, in this order:

1. **Store builds.** The Play bundle, unless the Android release workflow sent it: `git checkout vX.Y.Z`, `bun run android:bundle`, then upload to Google Play (docs/release/google.md). The iPhone archive the same way, with `bun run ios:archive`, unless the iOS release workflow uploaded it.
2. **The APK.** The workflow attaches it. By hand: `bun run android:release-apk vX.Y.Z` from any up-to-date checkout of `main`.
3. **The unsigned IPA** for sideloading (AltStore, SideStore, iloader), unless the iOS release workflow attached it: `bun run ios:release-ipa vX.Y.Z`.

`android:release-apk`:

- builds the tag in a temporary worktree, and refuses a tag whose `package.json` names another version;
- signs with the upload key (as `android:bundle` gets it), at the Play bundle's version code, and refuses any other signing certificate;
- uploads `HushOS-X.Y.Z.apk` and its `.sha256` to the release, replacing earlier ones;
- writes the notes' **Android** section: the APK, its SHA-256, the upload certificate's SHA-256, how to check them, and why switching between Play and the APK needs an uninstall (different signing keys).

`ios:release-ipa`:

- builds the tag in a temporary worktree: Release, generic iOS arm64, `CODE_SIGNING_ALLOWED=NO`, the default app group, the App Store build's build number;
- signs each bundle ad hoc, only so it carries its entitlements for the sideloading tool to read;
- checks every bundle's version, build and group;
- uploads `HushOS-X.Y.Z-unsigned.ipa` and its `.sha256`, replacing earlier ones;
- writes the notes' **iOS** section.

The two are separate scripts because the IPA needs Xcode and no Android key. Run either again to replace its files.

A sideloading tool gives the app its team's app group (`group.com.hushos.app.<TEAMID>`). The app finds it in the profile the tool embeds (`AppGroup`, apps/ios/AGENTS.md).

`scripts/release-notes-section.sh` writes the notes sections. release-please's changelog is never touched.

### Upgrade notes

When self-hosters must act (a setting, a slow migration, a raised client minimum), edit the GitHub release after it is created. Put an **Upgrade notes** section at the top. docs/self-hosting.md sends self-hosters there before they move a pin.

### Build numbers

iOS `CFBundleVersion` and Android `versionCode` come from `scripts/build-number.sh`: the number of commits in `HEAD`'s history.

- Pull requests are squash-merged and `main` is never rewritten, so the number grows with every merge.
- Any full clone computes the same number for the same commit, on a laptop or in CI. A CI run number would exist only in CI, and restarts if the workflow is renamed.
- Store builds come from the release tag: `git checkout vX.Y.Z`, then `bun run ios:archive` and `bun run android:bundle` (docs/release).
- Both refuse a shallow clone, or a commit not on `origin/main`, whose count could pass the next `main` build's.
- `HUSHOS_BUILD_NUMBER` overrides the number for a second upload of one commit.

### Workspace packages

Workspace packages are `"private": true` at version `0.0.0` and never bumped. None is published; the product version is the root's.

### Client versions

The web app and both phone apps send the product version in `HushOS-Client`: `web/1.0.0`, `ios/1.0.0`, `android/1.0.0`.

- `meetsMinimum` in `packages/drive/src/protocol.ts` compares one with a minimum.
- Builds from before 1.0.0 sent the Drive protocol number (`ios/3`). They count as older than any product-version minimum.
- A whole-number minimum from before 1.0.0 (`web/3`) still holds those old builds and lets every product version through, with a deprecation warning at startup.
- `UPCOMING_PROTOCOL_MINIMUM` (1.0.0) is the floor for the protocol changes being built. Nothing enforces it yet.
- Operators set their own floors with `DRIVE_CLIENT_MINIMUMS`.

### The release token

A pull request opened with a workflow's own `GITHUB_TOKEN` starts no workflows, so CI would never run on the release pull request. `release.yml` never uses `GITHUB_TOKEN`. It uses, in order:

1. A GitHub App, when the repository variable `RELEASE_APP_ID` and the secret `RELEASE_APP_PRIVATE_KEY` are set. Permissions: contents, pull requests and issues, read and write. Installed on this repository only.
2. Otherwise a fine-grained token in the secret `RELEASE_PLEASE_TOKEN`, with contents and pull requests read and write.
3. With neither, the job logs a notice and succeeds without doing anything.

The App's commits pass the DCO check as a bot's. A token's commits carry the `signoff` in `release-please-config.json`, which must name the token owner's GitHub name and public email.

## Project status

HushOS 1.0 is Drive, with family plans, on the web and in the iPhone and Android apps. These are implemented and covered by the unit and browser suites:

- **Accounts:** email verification, OPAQUE authentication, remembered unlock, recovery, password changes, master and recovery-key rotation, identity keys, quota grants, devices, permanent deletion.
- **Drive:** the encrypted tree, resumable uploads, streaming downloads, previews, thumbnails, versions, trash and worker sweeps.
- **Sharing:** contacts, shares to accounts, links, save a copy, rotation on revoke and change feeds.
- **Families:** shared storage, family folders, signed member lists and key changes.
- **Operations:** reports with an evidence pipeline, Polar billing and the security headers.

The phone apps share `crates/hushos-core` for their cryptography.

What comes next is on the public roadmap, written in `apps/web/src/content/roadmap.ts`:

- **Now:** numbered releases, HushOS for companies, desktop apps.
- **Next:** editing in the browser, file tools, two-step sign-in and device approval.
- **Later:** notes and documents, editing together, messages, sign-in with a passkey.

HushOS is licensed under the [GNU Affero General Public License v3.0 only](LICENSE) (`AGPL-3.0-only`).
