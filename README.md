# HushOS

A foundation for an open-source, self-hostable, end-to-end encrypted productivity suite, starting with HushOS Drive. Email verification, OPAQUE registration/sign-in, remembered device unlock, recovery-key password reset, password changes, master/recovery-key rotation, permanent account deletion, and initial storage allowances are implemented. Account encryption keys are generated and wrapped on the client. Drive file storage, content encryption, sharing, chat, and paid checkout remain future work.

## Stack

- Bun workspaces and Turborepo; **Node.js 24+**, Bun 1.4.0, TypeScript 7.0.2.
- TanStack Start + React Query on **Vite 8**, with Nitro v3 targeting Bun in production.
- Tailwind v4, shadcn/ui **Base UI**, and locally bundled Fontsource Variable **Geist Sans / Geist Mono**.
- Elysia **2.0.0-beta.12** mounted at `/api` inside TanStack Start, with typed Eden Treaty and Eden Fetch clients.
- PostgreSQL 18 and Drizzle ORM / Kit **1.0.0-rc.4**, compatible with PlanetScale Postgres.
- Shared Oxlint, type-aware linting, and Oxfmt; four-space indentation.

```text
apps/
    web/
        src/routes/                 Pages, layouts, and TanStack route definitions
        src/lib/                    API clients, React Query options, utilities
        src/components/ui/          shadcn Base UI components
        src/lib/api.server.ts       Elysia handlers mounted by src/routes/api/$.ts
        server/plugins/             Request IDs and database shutdown
        nitro.config.ts             Nitro server and logging configuration
packages/
    auth/                           Registration, sessions, browser auth client
    crypto/                         Versioned OPAQUE and account-key cryptography
    emails/                         React Email templates and SMTP/Resend/SES delivery
    env/                            T3 Env and Zod server configuration
    config/                         Shared Oxlint / Oxfmt configuration
    db/                             Drizzle client, schema, migrations
    shared/                         Dummy shared constants package
    utils/                          Dummy shared runtime utilities package
    logging/                        Shared evlog core and error helpers
```

## Start locally

Install Node.js 24+, Bun 1.4.0, and Docker with Compose 2.24.4+ (or newer). Start Docker, then:

```sh
bun install --frozen-lockfile
bun run setup
bun run infra:up
bun run db:migrate
bun run dev
```

Open [http://localhost:5173/app](http://localhost:5173/app). Development uses localhost directly; no hosts-file edits, certificates, or reverse proxy are required. Docker runs PostgreSQL 18 and MailHog; the app runs on your host with live reload.

| Surface     | Local address                    | Production example            |
| ----------- | -------------------------------- | ----------------------------- |
| Landing     | http://localhost:5173            | https://hushos.com            |
| Application | http://localhost:5173/app        | https://hushos.com/app        |
| API         | http://localhost:5173/api/health | https://hushos.com/api/health |

`bun run setup` creates a root `.env` with a unique local database password and OPAQUE server setup. Subsequent runs preserve existing values and append missing settings. Back up the OPAQUE setup with your database. This file configures Compose and app processes. Commands use Bun's `--env-file` option to load it; database commands resolve `../../.env` from `packages/db`.

Pages and API endpoints share one origin. Browser API requests use `/api`; server-side Eden clients call the mounted Elysia app directly within the current request. Set `APP_ORIGIN` to the address you use; authentication accepts requests only from that exact origin. HTTP is allowed for localhost; remote access requires HTTPS.

`5173` is the default app port. To use another available port, run `PORT=8080 bun run dev` or `PORT=8080 bun run start`; Compose uses `PORT` for its published host port too. You can also set `PORT` in the root `.env`. Set `APP_ORIGIN` to the matching origin when changing the port.

The public health/demo API allows development CORS. Authentication requires the configured origin and uses HttpOnly cookies.

Browsers treat localhost as a [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts), so APIs such as `crypto.subtle` work over local HTTP. Access from another device requires HTTPS for these APIs; see [self-hosting](docs/self-hosting.md).

Postgres is published on `127.0.0.1:5433` for local tools. Change `POSTGRES_PORT` and the port in `DATABASE_URL` together if necessary. If you already have PostgreSQL, set `DATABASE_URL` and skip `bun run infra:up`.

## Commands

| Command                                 | Purpose                                                |
| --------------------------------------- | ------------------------------------------------------ |
| `bun run dev`                           | Run the app with live reload                           |
| `bun run build`                         | Build the production app                               |
| `bun run start`                         | Run the built app on Bun                               |
| `bun run check`                         | Lint, format check, and TypeScript checks              |
| `bun run format`                        | Format the repository with Oxfmt                       |
| `bun run lint:fix`                      | Apply available Oxlint fixes                           |
| `bun run db:generate`                   | Generate a migration from the Drizzle schema           |
| `bun run db:migrate`                    | Apply checked-in migrations with Drizzle Kit           |
| `bun run db:studio`                     | Open Drizzle Studio                                    |
| `bun run test`                          | Run the prepared test runners; initially no test cases |
| `bun run infra:up` / `infra:down`       | Start/stop local Postgres and MailHog                  |
| `bun run selfhost:up` / `selfhost:down` | Build/start or stop the full Docker stack              |

Stop the development server before switching to the full self-hosted stack, which also uses port 5173. Stop commands retain database volumes.

## Accounts and email previews

Open `/register`, enter your email, and continue to `/register/check-email`. Open the verification message in [MailHog](http://localhost:8025) to reach `/register/complete`. Choose your name and a password of 12–128 characters. The dedicated `/setup/recovery-key` page then lets you save the 24-word recovery phrase or download its recovery kit. Confirm it is saved and choose “Continue to HushOS” to open the app. The QR code contains that same private phrase.

New accounts receive a personal workspace and **1 GiB** allowance in the same signup transaction. `INITIAL_STORAGE_QUOTA_BYTES` controls the allowance for future accounts. Paid storage entitlements have a separate schema; there is no checkout or billing webhook yet, and uploads are not implemented.

`/login` unlocks the account key in a worker. A non-exportable Web Crypto device key in IndexedDB protects an encrypted account-key bundle in localStorage through Zustand persist. Refreshes and new tabs restore that key only after checking a live server session and credential revision. Explicit lock or sign-out removes saved device access across tabs. The server session lasts up to seven days. Browser origin compromise can still misuse a saved device key; non-exportability does not prevent XSS.

Use `/recover` with access to both your email and recovery phrase to replace your password while preserving the root key and permanent identity. Recovery revokes existing sessions and replaces the recovery phrase. Account settings at `/app/account` offer password changes, recovery-key rotation, master-key rotation, and permanent deletion, each requiring fresh OPAQUE password confirmation. Password changes preserve encryption keys; recovery rotation replaces the 24 words; master-key rotation replaces the root and recovery phrase while preserving identity keys. Security changes revoke other sessions, and rotations return you to the recovery setup page to save the new phrase. Master-key rotation is currently available only while the workspace has no used or reserved storage. Accounts created during earlier development iterations may lack recovery/identity/workspace records; the application does not invent or overwrite their encryption keys during migration.

Emails use React Email and the existing HushOS logo. `EMAIL_ADAPTER` selects `smtp`, `resend`, or `ses`; see [configuration](docs/self-hosting.md#authentication-and-email). MailHog captures local mail without sending it externally.

Email previews run separately from `bun run dev`:

```sh
bun run email:preview  # Live template preview at http://localhost:3001
bun run email:build   # Build the standalone preview
bun run email:start   # Serve that built preview
```

React Email's Resend preview setup is separate from the application's `EMAIL_ADAPTER` and `RESEND_API_KEY` settings. Preview sending uses the CLI's saved configuration. Production delivery uses the server's environment.

Public social previews at `/og.jpg` and `/share-og.jpg` use Takumi, the local Geist font, and the existing logo. The sharing preview is generic; real share pages are future work. `bun run images:optimize` regenerates email logos and optimizes PNG assets.

Appearance defaults to **System**, with **Light** and **Dark** options saved in a cookie. System follows operating-system changes without a reload.

## Development conventions

Keep the structure simple. Web pages and layouts live directly in TanStack route files, reusable UI lives in `components/`, and shared helpers live in `lib/`. API handlers live together in `apps/web/src/lib/api.server.ts`, mounted by the TanStack server route `src/routes/api/$.ts`. Extract more modules as needed. Generated `routeTree.gen.ts` is tracked and regenerated by dev, build, and typecheck commands.

`@/*` resolves inside the web app. Cross-workspace imports use public exports such as `@hushos/shared` and `@hushos/utils`. Both dummy packages are consumed by the UI and API handlers. They export TypeScript source, which Vite and Bun compile as part of app builds.

The Elysia module exports its `Api` type. `apps/web/src/lib/api.ts` exposes `getApi()` (Eden Treaty) and `getApiFetch()` (Eden Fetch), using TanStack's `createIsomorphicFn` to keep server imports out of the browser. Example React Query options in `src/lib/queries.ts` demonstrate both clients with cancellation and timeouts. Authentication orchestration lives in `@hushos/auth/client` and uses the same-origin auth API. Each SSR request gets a fresh QueryClient with TanStack's hydration/streaming integration. The sample queries load after hydration; future SSR-critical queries can use `ensureQueryData` in a loader and `useSuspenseQuery` in the page component.

Tailwind's CSS configuration lives in `apps/web/src/styles.css`. Add more Base UI components with:

```sh
bunx shadcn@latest add dialog --cwd apps/web
```

Editor setup, test tooling, and contribution details are in [CONTRIBUTING.md](CONTRIBUTING.md). Deployment, PlanetScale, and backups are in [docs/self-hosting.md](docs/self-hosting.md).

## License

HushOS is licensed under the [GNU Affero General Public License v3.0 only](LICENSE) (`AGPL-3.0-only`).
