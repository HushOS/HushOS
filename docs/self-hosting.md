# Self-hosting HushOS

The stack contains a web service, a background worker, a migration job, and PostgreSQL. TanStack Start and Nitro host the UI and Elysia API together. Email-first OPAQUE authentication, client account-key wrapping, recovery, password changes, master/recovery-key rotation, remembered device access, and permanent deletion are implemented. Drive storage and content encryption are not yet implemented.

## Run the full stack locally

Install Docker with Compose 2.24.4+ (for the external-database override). With Bun installed, run `bun run setup` to create `.env`; alternatively copy `.env.example` to `.env` and replace every `change-me` with the same long, URL-safe random database password.

Before the first `docker compose up`, set the mail adapter in `.env`. The setup script's default `SMTP_HOST=127.0.0.1` points at the web container itself once the app runs in Docker, and a failed verification email is the first thing every new user would hit. Use your provider's SMTP host, or `EMAIL_ADAPTER=resend` with `RESEND_API_KEY`, or `EMAIL_ADAPTER=ses` with AWS credentials. `.env.production.example` lists every required setting with a placeholder.

Stop any host development server using port 5173, then run:

```sh
docker compose up -d --build --remove-orphans
```

Compose starts four services: `db`, the one-shot `migrate` job, `web`, and `worker`. The worker runs background jobs (today: sweeping expired sessions, attempts and rate-limit rows every five minutes and once at start, and a daily billing reconciliation when billing is enabled; later: Drive upload reconciliation and object cleanup) with [pg-boss](https://pgboss.io), which keeps its queue in a `pgboss` schema inside the same database. It is its own small image (`hushos-worker`: a Bun base plus one bundled file, built from `packages/jobs/Dockerfile`), needs only `DATABASE_URL` (plus `APP_ORIGIN`, `BILLING_PROVIDER`, `POLAR_ACCESS_TOKEN`, `POLAR_ENVIRONMENT` and `BILLING_GRACE_DAYS` when billing is enabled; it never needs the webhook secret), and runs as a second service on a platform such as Coolify from that published image. The worker migrates its own schema on start. Its database role needs `CREATE` on the database (the Compose role has it) and must own the `pgboss` schema it creates. Cleanup also requires `SELECT` and `DELETE` on `account_enrollments`, `opaque_login_attempts`, `account_recovery_attempts`, `sessions`, and `auth_rate_limits`, plus `USAGE` on their schema. Run it without a domain or published ports and allow at least 45 seconds for shutdown so its 30-second graceful stop can finish.

Open [http://localhost:5173/app](http://localhost:5173/app). API health is available at [http://localhost:5173/api/health](http://localhost:5173/api/health). Compose publishes the app on `127.0.0.1:5173`; PostgreSQL remains inside the container network. The development override publishes PostgreSQL on port 5433 for host tools.

Set `PORT=8080` in `.env` or run `PORT=8080 docker compose up -d --build` to publish a different host port. The container still listens on `5173`; update a host-based proxy’s upstream port to match. Outside Docker, `PORT=8080 bun run start` changes the app’s listening port directly.

The migration job waits for Postgres, runs `drizzle-kit migrate`, and must complete successfully before the app starts. It uses `packages/db/drizzle.config.ts` and the checked-in SQL migrations. `/api/health` checks the app process; `/api/ready` checks a real database query and is the container health check.

The web uses Nitro v3 with the `bun` preset. `bun run build` produces the deployable `apps/web/.output` directory; `bun run start` runs its server entry on Bun. Nitro serves static assets, the TanStack Start SSR handler, and the mounted Elysia API.

The app image contains Nitro's self-contained `.output` directory and Bun, plus Node 24 and Drizzle Kit for optional startup migrations. Its entrypoint drops root privileges before starting the web process as `bun`. `packages/db/Dockerfile` builds the separate migration image with Node 24, Bun, and Drizzle Kit; it runs as the unprivileged `node` user.

## Public HTTPS deployment

Use your hosting platform's HTTPS ingress or a reverse proxy you manage. Point one hostname, such as `https://hushos.example.com`, at the app:

| Proxy location         | Upstream                |
| ---------------------- | ----------------------- |
| On the same host       | `http://127.0.0.1:5173` |
| On the Compose network | `http://web:5173`       |

Route all paths to that upstream, including `/api` and static assets. The UI and API share the public origin. Your proxy or platform owns domain routing and TLS. Set `APP_ORIGIN` to that exact public HTTPS origin; it controls email links, social metadata, and allowed auth mutations. Set `TRUSTED_PROXY_HEADER` to the header your proxy fills with the client address (`x-forwarded-for` for Caddy, nginx and Traefik; `cf-connecting-ip` behind Cloudflare). Without it every visitor shares the proxy's address and one rate-limit budget, and Polar, which picks the checkout currency from that address, sees the proxy's country. If the proxy also geolocates, set `TRUSTED_COUNTRY_HEADER` to the header carrying the visitor's country code (`cf-ipcountry` behind Cloudflare) so the pricing page opens in their currency; without it the browser's language decides, and a selector on the page lets anyone change it. The application needs no separate API hostname.

The browser's auth client is an Eden Treaty client typed by the Elysia app, so the request and response types come from the route schemas; server-side rendering reads sessions in process without HTTP. Database credentials are supplied to the app at runtime and never enter browser assets. Remote browser crypto APIs need HTTPS; localhost has a [secure-context exception](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts) for local development.

For an existing deployment, remove the old API service and its separate hostname routing. `--remove-orphans` removes the old service container while preserving database volumes. Remove unused `WEB_ORIGIN`, `VITE_API_URL`, and `API_INTERNAL_URL` settings. Deploy matching versions of the web, worker, and migration images.

## Container publishing

The GitHub Actions workflow runs `bun run check` (lint, format, and typecheck), `bun run test`, and `bun run build` on pull requests and pushes to `main`. Successful pushes to `main` then build and publish these Linux AMD64 images on native AMD64 runners:

| Service    | Image                           |
| ---------- | ------------------------------- |
| Web        | `ghcr.io/hushos/hushos-web`     |
| Migrations | `ghcr.io/hushos/hushos-migrate` |
| Worker     | `ghcr.io/hushos/hushos-worker`  |

Each image receives `latest` and `sha-<full-commit-sha>` tags. Use the same commit tag for all three images when pinning a deployment. Image names derive from the lowercase GitHub repository name, so forks publish under their own namespace.

All three HushOS images are public and support anonymous pulls. Publishing uses the workflow's `GITHUB_TOKEN` with `packages: write`; no separate registry secret is required. Forks create private GHCR packages by default; set their visibility to public to allow anonymous pulls. See [GitHub's container registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

The web image includes both the UI and Elysia API. It uses the current origin, so the same image can run behind any hostname without an API URL build argument. Publishing uploads images to GHCR. The optional deployment job calls `DEPLOY_WEBHOOK_URL` with `DEPLOY_WEBHOOK_TOKEN` after all three images publish, then verifies `/api/ready` reports the published commit. Enable it with the repository variable `DEPLOY_ENABLED=true` and set `DEPLOY_ORIGIN`. For Coolify, a single deploy webhook can target both web and worker by listing their resource UUIDs separated by a comma in its `uuid` query parameter. Keep hosting configuration and credentials in your platform and GitHub settings.

To run the published images without a source checkout, copy `compose.yaml`, `compose.images.yaml`, and `.env.production.example` (as `.env`) to the host, then:

```sh
docker compose -f compose.yaml -f compose.images.yaml up -d
```

`HUSHOS_IMAGE_TAG=sha-<commit>` pins all three images to one release. The OPAQUE server setup can be generated without the repository:

```sh
docker run --rm oven/bun:1-slim sh -c 'cd /tmp && bun add --silent @serenity-kit/opaque >/dev/null && bun -e "import { ready, server } from \"@serenity-kit/opaque\"; await ready; console.log(server.createSetup())"'
```

Put the output in `OPAQUE_SERVER_SETUP` once and keep it; existing credentials depend on it.

To build the app image directly:

```sh
docker build -f apps/web/Dockerfile -t hushos-web:local .
docker build -f packages/jobs/Dockerfile --target worker -t hushos-worker:local .
```

The included Nitro configuration targets Bun. A different runtime needs a compatible deployment preset and database driver configuration.

## Startup migrations and rolling updates

Compose runs migrations as a separate job. Platforms that roll individual web containers can instead set `MIGRATION_DATABASE_URL_FILE` to a mounted file containing a direct PostgreSQL connection with migration permissions. Mount it read-only, owned by root with mode `0400`. The web image starts as root, applies migrations using that file, removes migration environment variables, then permanently drops privileges to `bun` before opening the HTTP server. The web process cannot read the root-owned migration secret. Keep `DATABASE_URL` restricted to application queries.

The image runs the same `bun run db:migrate` command, Drizzle Kit configuration, and SQL as local development and the separate migration image. Serialize deployments so only one migration process runs at a time. Failure exits the new container before it becomes ready; configure the hosting platform to retain the old healthy container until its replacement passes `/api/ready`. Supply `SERVER_SHUTDOWN_TIMEOUT=30` and a container stop grace period longer than 30 seconds to allow requests to drain.

Rolling releases require backward-compatible schema changes because old and new application versions overlap. Add new structures first; remove obsolete columns or constraints in a later release after old containers have stopped. A failed application rollout does not undo migrations already applied.

Without `MIGRATION_DATABASE_URL_FILE`, the web image skips migrations. Continue running the separate migration job first, as the included Compose configuration does.

## PlanetScale or another external Postgres

Drizzle ORM and Kit are pinned to the matching **v1 release candidate**, `1.0.0-rc.4`. The `pg` driver supports local PostgreSQL and PlanetScale Postgres using the same schema.

1. Run the setup step to create `.env`.
2. Set `DATABASE_URL` to the connection string from PlanetScale's Connect panel. Preserve `sslmode=verify-full`; certificate verification is not disabled in code.
3. If your application connection uses a pooler, optionally set `MIGRATION_DATABASE_URL` to a direct connection with migration permissions.
4. Configure your public HTTPS origin as above.
5. Run:

```sh
docker compose -f compose.yaml -f compose.external-db.yaml up -d --build
```

The override disables the local database service by default, removes the migration job's local database dependency, and passes your external connection to the web service and migrator. `POSTGRES_PASSWORD` may remain as the unused generated local value because the base Compose file still validates it during configuration.

No PlanetScale account or database is provisioned automatically. When running the app outside Docker, provide `DATABASE_URL` at runtime. Run migrations from the repository root with the target environment loaded:

```sh
bun run db:migrate
```

Migrations create the workspace, account, OPAQUE credential, wrapped-key, enrollment, session, recovery, identity, and quota schemas. They do not create a Drive file tree or object-storage protocol.

## Updating and backups

Back up before applying schema changes. To export the bundled Postgres database without exposing credentials on the command line:

```sh
mkdir -p backups
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' > backups/hushos.sql
```

After reviewing changes and migrations:

```sh
docker compose up -d --build
```

The migrator tracks applied migrations and can run repeatedly. Keep the same `.env` and persistent volumes. `docker compose down` stops services and retains data; adding `--volumes` deletes it. Back up the `postgres18_data` volume/data and OPAQUE server setup according to your deployment policy. For PlanetScale, use its database backup facilities as well.

## Remote development

Expose the development server on port 5173 through Tailscale Serve or another trusted HTTPS proxy. The browser uses `/api` on that same origin, so only one upstream is needed. Vite listens on all interfaces and answers LAN addresses and `*.ts.net` hostnames; add other hostnames to `allowedHosts` in `apps/web/vite.config.ts`. Signing in from a remote hostname needs `APP_ORIGIN` set to that HTTPS origin, because auth requests are rejected unless their `Origin` matches it. Development API CORS allows all origins for external tooling; production uses same-origin access.

Browser crypto APIs require a secure context. HTTP localhost works on the same device; remote hostnames and LAN IPs need HTTPS. The repository does not configure DNS, certificates, or Tailscale.

## Authentication and email

Run `bun run setup` once and preserve its generated `OPAQUE_SERVER_SETUP`. The startup plugin validates server environment with T3 Env and Zod. A missing setup or invalid selected email adapter fails startup. Never regenerate the OPAQUE setup on restart: existing credentials depend on it.

| Setting                                                           | Purpose                                                                                                                                                            |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `APP_ORIGIN`                                                      | Exact public origin, HTTPS except HTTP localhost. No path, query, or credentials.                                                                                  |
| `OPERATOR_NAME`, `OPERATOR_JURISDICTION`                          | Optional legal name and jurisdiction of whoever runs the instance, for example `HushOS, Inc.` and `a Delaware corporation`; named in the terms and privacy policy. |
| `OPAQUE_SERVER_SETUP`                                             | Persistent server-only OPAQUE setup generated by `bun run setup`.                                                                                                  |
| `OPAQUE_SERVER_SETUP_ID`                                          | Stable identifier for that setup; default `primary`.                                                                                                               |
| `INITIAL_STORAGE_QUOTA_BYTES`                                     | Initial allowance for newly created accounts; default `1073741824` (1 GiB).                                                                                        |
| `TRUSTED_PROXY_HEADER`                                            | Header your proxy sets with the client address, such as `x-forwarded-for`. Required behind a proxy so rate limits key on clients, not the proxy.                   |
| `TRUSTED_COUNTRY_HEADER`                                          | Header a geolocating proxy sets with the visitor's country code, such as `cf-ipcountry`; chooses the currency the pricing page shows first. Optional.              |
| `EMAIL_ADAPTER`                                                   | `smtp`, `resend`, or `ses`.                                                                                                                                        |
| `EMAIL_FROM`                                                      | Sender address, optionally with display name.                                                                                                                      |
| `SMTP_HOST`, `SMTP_PORT`                                          | SMTP endpoint; local defaults `127.0.0.1:1025`.                                                                                                                    |
| `SMTP_SECURE`, `SMTP_REQUIRE_TLS`                                 | Implicit TLS and required STARTTLS respectively.                                                                                                                   |
| `SMTP_USER`, `SMTP_PASSWORD`                                      | Set both if SMTP requires authentication.                                                                                                                          |
| `RESEND_API_KEY`                                                  | Required for the Resend adapter.                                                                                                                                   |
| `AWS_REGION`                                                      | Required for SES. The AWS SDK supports workload credentials or environment credentials.                                                                            |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` | Optional explicit AWS credentials; access key and secret must be supplied together.                                                                                |

The development override runs MailHog at SMTP port 1025 and its inbox at `http://localhost:8025`. `bun run infra:up` starts it with PostgreSQL. For a local full-stack preview use `docker compose -f compose.yaml -f compose.dev.yaml up -d --build`; the override points container SMTP to `mailhog`. The base production stack has no mail capture service: configure a reachable SMTP provider, Resend, or SES. Mail images use absolute URLs under `APP_ORIGIN`, which must be reachable by recipients. Verify your sender/domain with the chosen provider.

Verification links expire after 30 minutes and use a URL fragment, so their tokens do not enter HTTP paths or access logs. Recovery additionally requires the independently generated recovery phrase. Email delivery never includes passwords or encryption keys. The database stores account metadata, public keys, encrypted private/root-key bundles, and hashed session/challenge tokens. See [the protocol](opaque-auth-design.md) for the precise boundary.

Account sessions use HttpOnly, SameSite=Lax, Path=/ cookies; HTTPS adds Secure and the `__Host-` prefix. Session validity and credential revision are checked before remembered device unlock. Serve production over HTTPS. A cookie or database backup alone does not contain the plaintext account key, but the OPAQUE setup is a sensitive server secret and must be protected.

The server cannot recover lost encryption keys from email alone. Users must retain their recovery kit. Keep database and OPAQUE setup backups together, encrypted and access controlled. A reset replaces the recovery phrase for future reset authorization; an old recovery kit plus its old wrapped-key bundle can still recover the unchanged root key offline. Deleting an account removes live database records; operator backups and mail-provider retention follow your separate retention policy.

Account settings require a fresh current-password exchange for password changes and key rotation. Each operation revokes existing sessions and pending recovery attempts. Recovery-key rotation replaces the phrase; master-key rotation replaces the root and phrase while preserving identity keys. Users must save a new recovery kit after either rotation. Master-key rotation is restricted to accounts with no used or reserved storage until encrypted Drive objects can participate in the operation. Old backups and recovery kits can still expose their old roots; rotating a root does not revoke identity private keys already extracted from those copies.

## Billing (optional)

Self-hosted instances have no billing: leave `BILLING_PROVIDER=none` and every account keeps the allowance set by `INITIAL_STORAGE_QUOTA_BYTES`. The hosted service sells storage plans through [Polar](https://polar.sh) as merchant of record, which collects payment, handles sales tax and VAT, and issues invoices. HushOS keeps the customer and subscription mapping locally and derives storage entitlements from it; Polar never sees file names, content, or keys.

| Setting                | Purpose                                                                                                                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BILLING_PROVIDER`     | `none` (default) or `polar`.                                                                                                                                                        |
| `POLAR_ACCESS_TOKEN`   | Organisation access token with `checkouts:write`, `customers:read`, `customers:write`, `customer_sessions:write`, `subscriptions:read`, `subscriptions:write`, and `products:read`. |
| `POLAR_WEBHOOK_SECRET` | Secret of the webhook endpoint pointed at `https://<APP_ORIGIN>/api/billing/webhook`.                                                                                               |
| `POLAR_ENVIRONMENT`    | `production` (default) or `sandbox`. Tokens and webhook secrets are specific to each environment.                                                                                   |
| `BILLING_GRACE_DAYS`   | Days an allowance outlives its billing period, so a late renewal or a payment retry does not cut anyone off. Default `3`.                                                           |

Plans are Polar products, so prices and names are edited in the Polar dashboard, never in code. `bun run polar:seed` creates the launch catalogue (Plus, Pro, Max; monthly and yearly) in whichever organisation `POLAR_ACCESS_TOKEN` belongs to, skipping products that already exist; with `--update` it also brings existing products' prices, descriptions, and metadata in line with the script, replacing a changed price for new checkouts while current subscribers keep theirs. The token needs `products:write` for those runs. Each product carries one fixed price per currency, with the organisation's default currency (USD) required and the others optional; Polar charges a customer in their local currency when the product has one and falls back to the default otherwise, and the pricing page shows the same currency, chosen from `TRUSTED_COUNTRY_HEADER`, then the browser's language, with a selector to change it. The currencies and amounts live in the seed script's table. A product is offered as a HushOS plan when it is recurring, has a fixed price in the default currency, and carries two metadata keys: `hushos_plan` (any value) and `quota_bytes` (the storage it grants, as an integer). Monthly and yearly are separate products. Archiving a product hides it from the pricing page while existing subscribers keep it.

Subscribe the webhook endpoint to the `customer.*`, `subscription.*`, and `order.*` events. Every delivery is verified with the Standard Webhooks signature, recorded by its message id, and answered by re-reading the customer's state from Polar, so duplicate, reordered, or missed deliveries cannot corrupt local state. The worker also re-reads every billing customer once a day. Both the web and worker services need the billing settings.

When a subscription ends, its entitlement is revoked and the allowance returns to the base quota; content is never deleted or made unreadable. Deleting an account revokes any active subscription and deletes the Polar customer first, and refuses to proceed if Polar cannot be reached. For local development, use a sandbox organisation and relay deliveries with Polar's CLI: `polar listen http://localhost:5173/api/billing/webhook`.

## PostgreSQL 18 upgrades

The bundled image is `postgres:18-alpine`, with a named `postgres18_data` volume mounted at `/var/lib/postgresql`. PostgreSQL 18 uses a versioned data directory under that mount. A PostgreSQL 17 data directory must not be mounted into PostgreSQL 18 and started as-is.

For an existing 17 installation, keep the old volume, take a logical `pg_dump`/`pg_dumpall` backup, restore into a fresh PostgreSQL 18 volume, verify accounts/data, then point the application at it and run the checked-in migrations. Alternatively use a planned `pg_upgrade` procedure for your deployment. Retain the old volume and verified backup until the upgrade is accepted. `docker compose down --volumes` is not an upgrade procedure.

## Logs and storage allowances

Nitro emits one evlog completion event for each request, including pre-parser auth rejections. Production output (`NODE_ENV=production`, which the images and `bun run start` set) is JSON; development output is readable text. Redaction is enabled in both environments, with an auth-specific field allowlist. Logs contain request IDs, routes, status, duration, and operation outcomes; they exclude auth bodies, cookies, keys, passwords, recovery phrases, and raw protocol/provider/database errors. No external drain is configured.

A personal workspace and initial quota are created in the signup transaction. Quota counts use PostgreSQL bigint and serialize as decimal strings. Extra entitlements are separate, expiring/revocable records keyed by the billing subscription that granted them. Changing the initial-quota environment variable affects new accounts only.

Drive upload enforcement remains future work: reserve ciphertext bytes atomically before issuing upload URLs, verify actual object sizes, account for retained trash and versions, and release usage only after object deletion. The current allowance schema does not claim those storage operations exist.
