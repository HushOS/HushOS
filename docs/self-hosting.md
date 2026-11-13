# Self-hosting HushOS

The stack has four parts:

- a web service;
- a background worker;
- a migration job;
- PostgreSQL.

TanStack Start and Nitro host the UI and the Elysia API together.

What is implemented:

- Email-first OPAQUE authentication, client account-key wrapping, recovery, password changes, master/recovery-key rotation, remembered device access, and permanent deletion.
- Drive's encrypted folder tree, resumable uploads and streaming downloads, against the object store described under [Drive object storage](#drive-object-storage).

## Contents

1. [Run the full stack locally](#run-the-full-stack-locally)
2. [The worker](#the-worker)
3. [Public HTTPS deployment](#public-https-deployment)
4. [Container publishing](#container-publishing)
5. [Startup migrations and rolling updates](#startup-migrations-and-rolling-updates)
6. [PlanetScale or another external Postgres](#planetscale-or-another-external-postgres)
7. [Updating and backups](#updating-and-backups)
8. [Remote development](#remote-development)
9. [Authentication and email](#authentication-and-email)
10. [Sharing](#sharing)
11. [Operators and the management area](#operators-and-the-management-area)
12. [Reports](#reports)
13. [Referrals and affiliates](#referrals-and-affiliates)
14. [Security headers](#security-headers)
15. [Billing (optional)](#billing-optional)
16. [PostgreSQL 18 upgrades](#postgresql-18-upgrades)
17. [Drive object storage](#drive-object-storage)
18. [Groups](#groups)
19. [Logs and storage allowances](#logs-and-storage-allowances)
20. [Upgrading from older versions](#upgrading-from-older-versions)

## Run the full stack locally

Install Docker with Compose 2.24.4+ (needed for the external-database override). Then:

```sh
git clone https://github.com/HushOS/HushOS
cd HushOS
cp .env.production.example .env
docker compose up -d --build
```

That is the whole first run. The template works as it is on `http://localhost:5173`:

- The bundled [Garage](https://garagehq.deuxfleurs.fr/) holds the files. The web service reaches it inside Compose; browsers reach it on `127.0.0.1:9000`.
- The OPAQUE server setup is made on first start and kept in the database.
- Email goes to the web container's log (`EMAIL_ADAPTER=log`). `docker compose logs web` shows each verification link.

Stop any host development server using port 5173 first, or set `PORT`.

### Before anyone else uses it

Edit `.env`:

1. Give `POSTGRES_PASSWORD`, `STORAGE_SECRET_ACCESS_KEY`, `GARAGE_RPC_SECRET` (`openssl rand -hex 32`) and `GARAGE_ADMIN_TOKEN` real random values before the first start. They are baked into the database and Garage volumes.
2. Set `APP_ORIGIN` and `STORAGE_ENDPOINT` to the public HTTPS origins your proxy serves.
3. Switch the mail adapter to `smtp`, `resend` or `ses`.

### What Compose starts

| Service       | Role                                                         |
| ------------- | ------------------------------------------------------------ |
| `db`          | PostgreSQL 18                                                |
| `garage`      | The object store for Drive                                   |
| `garage-init` | One-shot bootstrap: layout, key, bucket, CORS, lifecycle     |
| `migrate`     | One-shot job: waits for Postgres, runs `drizzle-kit migrate` |
| `web`         | UI and API                                                   |
| `worker`      | Background jobs                                              |

- The migration job must complete before the app starts. It uses `packages/db/drizzle.config.ts` and the checked-in SQL migrations.
- `/api/health` checks the app process.
- `/api/ready` checks a real database query and is the container health check.

Open [http://localhost:5173/app](http://localhost:5173/app). API health is at [http://localhost:5173/api/health](http://localhost:5173/api/health).

- Compose publishes the app on `127.0.0.1:5173`.
- PostgreSQL stays inside the container network.
- The development override publishes PostgreSQL on port 5433 for host tools.

### Changing the port

- Set `PORT=8080` in `.env`, or run `PORT=8080 docker compose up -d --build`, to publish a different host port.
- The container still listens on `5173`. Update a host-based proxy's upstream port to match.
- Outside Docker, `PORT=8080 bun run start` changes the app's listening port directly.

### The images

- **Web.** Nitro v3 with the `bun` preset.
    - `bun run build` produces the deployable `apps/web/.output` directory; `bun run start` runs its server entry on Bun.
    - Nitro serves static assets, the TanStack Start SSR handler, and the mounted Elysia API.
    - The image holds that `.output` directory, Bun, and Drizzle Kit for optional startup migrations.
    - Its entrypoint drops root privileges before starting the web process as `bun`.
- **Migrations.** `packages/db/Dockerfile` builds the migration image with Bun and Drizzle Kit. It runs as the unprivileged `bun` user.
- **Worker.** A Bun base plus one bundled file, built from `packages/jobs/Dockerfile`. See [The worker](#the-worker).

## The worker

The worker runs background jobs with [pg-boss](https://pgboss.io). pg-boss keeps its queue in a `pgboss` schema inside the same database. Each job also runs once at start, so a backlog after downtime clears.

| Job                    | When                  | What it does                                                                                                                                                                                                 |
| ---------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Auth cleanup           | Every five minutes    | Sweeps expired sessions, attempts and rate-limit rows                                                                                                                                                        |
| Billing reconciliation | Daily                 | Re-reads every billing customer from the provider, when billing is enabled. Queues the end of any pooled family member's personal plan still live or not yet refunded                                        |
| Dissolved family plans | When queued           | Sets a dissolved family's plan that can still charge, or a renewing plan whose payer is no longer in the family, to end at its period's end, with no refund. See [Dissolved families](#dissolved-families)   |
| End personal plans     | When queued           | Ends a family member's own personal plan at Polar once their files draw from the family's pool, and refunds the unused days. See [Members who pay for a personal plan](#members-who-pay-for-a-personal-plan) |
| Expire uploads         | Hourly                | Aborts uploads past their expiry. Finishes ones that stalled while completing when the store holds the object                                                                                                |
| Deletion outbox        | Every five minutes    | Drains the object deletion outbox                                                                                                                                                                            |
| Replication            | Every five minutes    | Copies every completed object to the replica bucket, when one is configured                                                                                                                                  |
| Purge                  | Every fifteen minutes | Purges trash and superseded versions past 30 days, and deletes tombstones past 90 days. See the notes below                                                                                                  |
| Dissolved families     | Hourly                | Deletes the records of a family dissolved more than 30 days ago, once Purge has deleted its folders. See the notes below                                                                                     |
| Dissolved family mail  | Every minute          | Emails a dissolved family's last member, and whoever was still joining it, each once. Only with families on. See [Dissolved families](#dissolved-families)                                                   |
| Accounting audit       | Nightly               | Logs any drift between `used_bytes` and the objects                                                                                                                                                          |
| Object audit           | Nightly               | Confirms a page of objects at the store, least recently confirmed first. See the notes below                                                                                                                 |
| Replica audit          | Weekly                | Audits the replica the same way; a miss re-queues the copy                                                                                                                                                   |
| Tiering                | Nightly               | A no-op unless `STORAGE_COLD_CLASS` is set                                                                                                                                                                   |
| Evidence copies        | Every five minutes    | Copies reported objects to the evidence bucket, when one is configured                                                                                                                                       |
| Orphan sweep           | Nightly               | Lists a bounded page of the bucket and deletes objects older than seven days that neither the object table nor the deletion outbox names. Continues from where it stopped                                    |

More on some jobs:

- **Dissolved family plans** emails the payer the date, once a period. It runs again every time they resume the plan.
- **Purge** also fans deletions out under purged folders. It deletes family folders deleted, or retired by dissolving their family, more than 30 days ago.
- **Dissolved families** also retires the folders of a family dissolved before this release. See [Dissolved families](#dissolved-families).
- **Dissolved family mail** tells the last member the day the family's folders are deleted. It tells whoever was still joining (accepted or invited) that the family no longer exists.
- **Object audit** marks a lost object `missing`, so the app says the file is unavailable rather than failing to decrypt. With a replica, a primary copy the replica still holds is copied back instead.

### Settings

What the worker needs:

- **Always:** `DATABASE_URL`, and the same `STORAGE_*` settings as the web service. It deletes from and finalises uploads in the bucket.
- **Optional:** the `STORAGE_REPLICA_*` and `STORAGE_EVIDENCE_*` settings.
- **With billing enabled:** `APP_ORIGIN`, `BILLING_PROVIDER`, `POLAR_ACCESS_TOKEN`, `POLAR_ENVIRONMENT` and `BILLING_GRACE_DAYS`. Never the webhook secret.
- **With families on:** `GROUPS_ENABLED`, which the worker reads as the web service does. Give both the same value.
- **With families on, for email:** `APP_ORIGIN` and the same `EMAIL_*` settings as the web service, plus the `SMTP_*`, `RESEND_API_KEY` or `AWS_*` ones its adapter uses.

What the worker emails, with families on:

- a dissolved family's last member, and whoever was still joining it;
- with billing on too, the family's payer when it sets their plan to end;
- with billing on too, the payer of a family plan who is no longer in the family, when it sets that plan to end.

Without the email settings:

- The plan is still set to end.
- The worker logs `Plan ending email not sent` or `Family dissolved emails not sent` each time it tries.
- The dissolved family emails wait a week for settings that work, then are left unsent.

`compose.yaml` passes them to both services.

On a platform such as Coolify, the worker runs as a second service from the published image:

- Run it without a domain or published ports.
- Allow at least 45 seconds for shutdown, so its 30-second graceful stop can finish.

### Schema and privileges

- The worker migrates only pg-boss's own schema on start.
- The application schema is migrated by the `migrate` job or the web image's startup migration, never by the worker.
- At start it waits up to ten minutes for the newest migration it was built against. It exits if that never arrives, so a release can roll the two images in any order.

Its database role needs:

- `CREATE` on the database (the Compose role has it), and ownership of the `pgboss` schema it creates.
- `SELECT`, `INSERT`, `UPDATE` and `DELETE` on every application table, with `USAGE` on their schema. These are the same privileges as the web app: the worker purges trash, drains the deletion outbox, replicates objects, expires uploads and answers reports.
- `USAGE` on the `drizzle` schema with `SELECT` on `drizzle.__drizzle_migrations`.

It checks all of this before taking a job. It refuses to start without it, naming what is missing. The GRANT block for a split-role setup is under [One role per process](#one-role-per-process).

## Public HTTPS deployment

Use your hosting platform's HTTPS ingress or a reverse proxy you manage. Point one hostname, such as `https://hushos.example.com`, at the app:

| Proxy location         | Upstream                |
| ---------------------- | ----------------------- |
| On the same host       | `http://127.0.0.1:5173` |
| On the Compose network | `http://web:5173`       |

- Route all paths to that upstream, including `/api` and static assets.
- The UI and API share the public origin. The application needs no separate API hostname.
- Your proxy or platform owns domain routing and TLS.

### Settings the proxy decides

- `APP_ORIGIN`: the exact public HTTPS origin. It controls email links, social metadata, and allowed auth mutations.
- `TRUSTED_PROXY_HEADER`: the header your proxy fills with the client address.
    - Use `x-forwarded-for` for Caddy, nginx and Traefik, and `cf-connecting-ip` behind Cloudflare.
    - Without it, every visitor shares the proxy's address and one rate-limit budget.
    - Without it, Polar (which picks the checkout currency from that address) sees the proxy's country.
- `TRUSTED_COUNTRY_HEADER`: if the proxy also geolocates, the header carrying the visitor's country code (`cf-ipcountry` behind Cloudflare).
    - The pricing page then opens in their currency.
    - Without it, the browser's language decides, and a selector on the page lets anyone change it.

### How the pieces talk

- The browser's auth client is an Eden Treaty client typed by the Elysia app, so request and response types come from the route schemas.
- Server-side rendering reads sessions in process without HTTP.
- Database credentials are supplied to the app at runtime and never enter browser assets.
- Remote browser crypto APIs need HTTPS. Localhost has a [secure-context exception](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts) for local development.

Upgrading from a deployment with a separate API service? See [Separate API service](#separate-api-service).

## Container publishing

The GitHub Actions workflow runs `bun run check` (lint, format, and typecheck), `bun run test`, and `bun run build` on pull requests and pushes to `main`. Successful pushes to `main` then build and publish these Linux AMD64 images on native AMD64 runners:

| Service    | Image                           |
| ---------- | ------------------------------- |
| Web        | `ghcr.io/hushos/hushos-web`     |
| Migrations | `ghcr.io/hushos/hushos-migrate` |
| Worker     | `ghcr.io/hushos/hushos-worker`  |

### Tags and labels

- Each image receives a `sha-<full-commit-sha>` tag.
- `latest` moves to a commit's images once its Linux test suites pass, and only forward. An older commit's run that finishes late, or a re-run of one, leaves it on the later commit.
- A release (CONTRIBUTING.md, Releasing) also tags its images `X.Y.Z`, `X.Y` and `X`. They are copied by digest from that commit's `sha-<commit>` images: the same images main published, not a rebuild.
- The version tags appear shortly after the GitHub release, once CI for the commit has finished.
- Pin a deployment to one version, or one commit tag, for all three.
- Each image is labelled `org.opencontainers.image.version` (the product version in `package.json`, which between releases is still the last release's) and `org.opencontainers.image.revision` (the commit).

### Registry and forks

- Image names derive from the lowercase GitHub repository name, so forks publish under their own namespace.
- All three HushOS images are public and support anonymous pulls.
- Publishing uses the workflow's `GITHUB_TOKEN` with `packages: write`. No separate registry secret is required.
- Forks create private GHCR packages by default. Set their visibility to public to allow anonymous pulls. See [GitHub's container registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).
- The web image includes both the UI and Elysia API. It uses the current origin, so the same image runs behind any hostname without an API URL build argument.

### Deploy webhook

The optional deployment job calls `DEPLOY_WEBHOOK_URL` with `DEPLOY_WEBHOOK_TOKEN` after `latest` moves to the commit. It then verifies `/api/ready` reports that commit (or a later one).

- Enable it with the repository variable `DEPLOY_ENABLED=true`, and set `DEPLOY_ORIGIN`.
- Point the platform at the `latest` tags.
- Deploys run one at a time.
- A commit is skipped rather than deployed if `latest` has moved past it (a later commit's run then deploys), or if it is older than the release `/api/ready` reports. A late or re-run job never rolls production back.
- For Coolify, a single deploy webhook can target both web and worker. List their resource UUIDs, separated by a comma, in its `uuid` query parameter.
- Keep hosting configuration and credentials in your platform and GitHub settings.

### Running the published images

Copy `compose.yaml`, `compose.images.yaml`, and `.env.production.example` (as `.env`) to the host, then:

```sh
docker compose -f compose.yaml -f compose.images.yaml up -d
```

`latest` follows `main`, every merged change, as hushos.com does. To run releases instead, pin all three images to one version:

| `HUSHOS_IMAGE_TAG` | Follows                             |
| ------------------ | ----------------------------------- |
| `1.4.2`            | That release only                   |
| `1.4`              | Its patch releases                  |
| `1`                | Everything until a breaking release |
| `sha-<commit>`     | One exact build                     |

Releases and their notes are at `https://github.com/HushOS/HushOS/releases`. Read them before moving a pin.

The OPAQUE server setup can be generated without the repository:

```sh
docker run --rm oven/bun:1-slim sh -c 'cd /tmp && bun add --silent @serenity-kit/opaque >/dev/null && bun -e "import { ready, server } from \"@serenity-kit/opaque\"; await ready; console.log(server.createSetup())"'
```

Put the output in `OPAQUE_SERVER_SETUP` if you want the setup in the environment rather than in the database. Keep it: existing credentials depend on it.

### Building the images yourself

```sh
docker build -f apps/web/Dockerfile -t hushos-web:local .
docker build -f packages/jobs/Dockerfile --target worker -t hushos-worker:local .
```

The included Nitro configuration targets Bun. A different runtime needs a compatible deployment preset and database driver configuration.

## Startup migrations and rolling updates

Compose runs migrations as a separate job. Platforms that roll individual web containers can instead let the web image migrate on start:

1. Set `MIGRATION_DATABASE_URL_FILE` to a mounted file containing a direct PostgreSQL connection with migration permissions.
2. Mount it read-only, owned by root with mode `0400`.
3. Keep `DATABASE_URL` restricted to application queries.

How the web image uses it:

- It starts as root and applies migrations using that file.
- It removes migration environment variables, then permanently drops privileges to `bun` before opening the HTTP server.
- The web process cannot read the root-owned migration secret.
- Without `MIGRATION_DATABASE_URL_FILE`, the web image skips migrations. Keep running the separate migration job first, as the included Compose configuration does.

The image runs the same `bun run db:migrate` command, Drizzle Kit configuration, and SQL as local development and the separate migration image.

### Rolling out safely

- Serialize deployments so only one migration process runs at a time.
- Failure exits the new container before it becomes ready. Configure the platform to retain the old healthy container until its replacement passes `/api/ready`.
- Supply `SERVER_SHUTDOWN_TIMEOUT=30` and a container stop grace period longer than 30 seconds, so requests drain.
- Old and new versions overlap, so schema changes must be backward compatible. Add new structures first. Remove obsolete columns or constraints in a later release, after old containers have stopped.
- A failed application rollout does not undo migrations already applied.
- Some releases lock tables, need checks first, or must not overlap with older containers. Read [Release migration notes](#release-migration-notes) for every release you move past.

### One role per process

With an owner that migrates, an application role and a worker role, the two runtime roles need the same table privileges. The owner grants them for the tables that exist and for the ones later migrations add:

```sql
grant usage on schema public, drizzle to hushos_app, hushos_worker;
grant select, insert, update, delete on all tables in schema public to hushos_app, hushos_worker;
grant usage, select on all sequences in schema public to hushos_app, hushos_worker;
alter default privileges for role hushos_owner in schema public
    grant select, insert, update, delete on tables to hushos_app, hushos_worker;
alter default privileges for role hushos_owner in schema public
    grant usage, select on sequences to hushos_app, hushos_worker;
grant select on drizzle.__drizzle_migrations to hushos_worker;
```

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

What the override does:

- It disables the local database service by default.
- It removes the migration job's local database dependency.
- It passes your external connection to the web service and migrator.
- `POSTGRES_PASSWORD` may remain as the unused generated local value, because the base Compose file still validates it during configuration.

No PlanetScale account or database is provisioned automatically. When running the app outside Docker, provide `DATABASE_URL` at runtime and run migrations from the repository root with the target environment loaded:

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

### On the published images

1. Read the release notes of every version between yours and the next one (`https://github.com/HushOS/HushOS/releases`). An **Upgrade notes** section at the top of a release says what to do before or after moving to it: a setting to change, a migration that takes a while, a minimum client version raised.
2. Move `HUSHOS_IMAGE_TAG`.
3. Run `docker compose -f compose.yaml -f compose.images.yaml up -d`.

Each release's **Server images** section lists the web, worker and migrate images with the digest the version tag names, to pull or pin exactly those.

### Keeping data

- The migrator tracks applied migrations and can run repeatedly. Keep the same `.env` and persistent volumes.
- `docker compose down` stops services and retains data; adding `--volumes` deletes it.
- Back up the `postgres18_data` volume/data and the OPAQUE server setup according to your deployment policy. For PlanetScale, use its database backup facilities as well.

## Remote development

Expose the development server on port 5173 through Tailscale Serve or another trusted HTTPS proxy. The browser uses `/api` on that same origin, so only one upstream is needed.

- Vite listens on all interfaces and answers LAN addresses and `*.ts.net` hostnames. Add other hostnames to `allowedHosts` in `apps/web/vite.config.ts`.
- Signing in from a remote hostname needs `APP_ORIGIN` set to that HTTPS origin, because auth requests are rejected unless their `Origin` matches it.
- Development API CORS allows all origins for external tooling; production uses same-origin access.
- Browser crypto APIs require a secure context. HTTP localhost works on the same device; remote hostnames and LAN IPs need HTTPS.

The repository does not configure DNS, certificates, or Tailscale.

## Authentication and email

### The OPAQUE server setup

- With no `OPAQUE_SERVER_SETUP` in the environment, the web service makes one on first start and keeps it in the database.
- `bun run setup` generates one for the environment instead.
- Either way, preserve it and never regenerate it on restart: existing credentials depend on it.
- Prefer the environment. Kept in the database, the setup sits beside the password records, and a copy of the database is then all an offline password guess needs.
- A production instance without it in the environment warns at start.
- To move one the database made, copy the `value` of its `server_secrets` row (`opaque-setup:<OPAQUE_SERVER_SETUP_ID>`) into `OPAQUE_SERVER_SETUP`.

The startup plugin validates server environment with T3 Env and Zod. An invalid email adapter fails startup.

### Auth and email settings

| Setting                                                                                                     | Purpose                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_ORIGIN`                                                                                                | Exact public origin, HTTPS except HTTP localhost. No path, query, or credentials.                                                                   |
| `OPERATOR_NAME`, `OPERATOR_JURISDICTION`, `OPERATOR_CONTACT`                                                | Optional legal name, jurisdiction and contact email of whoever runs the instance. See [notes](#operator-and-contact-settings).                      |
| `OPERATOR_ADDRESS`, `OPERATOR_PHONE`                                                                        | Optional postal address and phone of whoever runs the instance, shown on `/support`. Write line breaks in the address as `\n`.                      |
| `SALES_CONTACT`                                                                                             | Optional email for teams and sales questions. The website's "Talk to us" writes to it; unset, there is no "Talk to us".                             |
| `HELP_CONTACT`                                                                                              | Optional email for people using this instance. Help in the app's account menu writes to it; unset, there is no Help.                                |
| `SECURITY_CONTACT`                                                                                          | Optional email for vulnerability reports. Set, the web serves `/.well-known/security.txt`. See [notes](#operator-and-contact-settings).             |
| `APPLE_APP_IDS`                                                                                             | Optional. The iOS apps allowed to open this instance's links and fill its saved passwords. See [phone apps](#phone-app-settings).                   |
| `ANDROID_APP_PACKAGE`                                                                                       | The Android app's package; default `com.hushos.app`.                                                                                                |
| `ANDROID_APP_CERT_SHA256`                                                                                   | Optional. SHA-256 fingerprints of the certificates that sign your Android build. See [phone apps](#phone-app-settings).                             |
| `PLAY_STORE_URL`                                                                                            | Optional. The Android app's Google Play listing. See [phone apps](#phone-app-settings).                                                             |
| `APP_STORE_URL`                                                                                             | Optional. The iPhone app's App Store listing. See [phone apps](#phone-app-settings).                                                                |
| `OPAQUE_SERVER_SETUP`                                                                                       | Optional. The server-side OPAQUE setup every password depends on. Never change it once set. See [above](#the-opaque-server-setup).                  |
| `OPAQUE_SERVER_SETUP_ID`                                                                                    | Stable identifier for that setup; default `primary`.                                                                                                |
| `INITIAL_STORAGE_QUOTA_BYTES`                                                                               | Initial allowance for newly created accounts; default `2147483648` (2 GiB).                                                                         |
| `REFERRAL_BONUS_BYTES`, `REFERRAL_SIGNUP_CAP_BYTES`, `REFERRAL_PAID_BONUS_BYTES`, `REFERRAL_PAID_CAP_BYTES` | Referrals, paid in storage. `0` turns a reward off. See [Referrals and affiliates](#referrals-and-affiliates).                                      |
| `TRUSTED_PROXY_HEADER`                                                                                      | Header your proxy sets with the client address, such as `x-forwarded-for`. Required behind a proxy so rate limits key on clients.                   |
| `TRUSTED_COUNTRY_HEADER`                                                                                    | Optional. Header a geolocating proxy sets with the visitor's country code, such as `cf-ipcountry`. Picks the currency the pricing page shows first. |
| `EMAIL_ADAPTER`                                                                                             | `smtp`, `resend`, `ses`, or `log`. See [the `log` adapter](#the-log-adapter).                                                                       |
| `EMAIL_FROM`                                                                                                | Sender address, optionally with display name.                                                                                                       |
| `SMTP_HOST`, `SMTP_PORT`                                                                                    | SMTP endpoint; local defaults `127.0.0.1:1025`.                                                                                                     |
| `SMTP_SECURE`, `SMTP_REQUIRE_TLS`                                                                           | Implicit TLS and required STARTTLS respectively.                                                                                                    |
| `SMTP_USER`, `SMTP_PASSWORD`                                                                                | Set both if SMTP requires authentication.                                                                                                           |
| `RESEND_API_KEY`                                                                                            | Required for the Resend adapter.                                                                                                                    |
| `AWS_REGION`                                                                                                | Required for SES. The AWS SDK supports workload credentials or environment credentials.                                                             |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`                                           | Optional explicit AWS credentials; access key and secret must be supplied together.                                                                 |

#### Operator and contact settings

- `OPERATOR_NAME`, `OPERATOR_JURISDICTION` and `OPERATOR_CONTACT` are shown on the terms, privacy and GDPR pages, for example `HushOS, Inc.` and `a Delaware corporation`. They are named in the terms and privacy policy.
- `OPERATOR_ADDRESS` and `OPERATOR_PHONE` are shown on `/support` with the legal name and contact email. The App Store asks for a support page with both.
- `SECURITY_CONTACT`: the served `/.well-known/security.txt` follows RFC 9116 and names it. Its `Expires` is six months out and moves forward each day. Unset, the file is not served.

#### Phone app settings

`APPLE_APP_IDS`:

- Format: `TEAMID.bundle.id` (for example `ABCDE12345.com.hushos.app`), comma separated.
- Set, the web serves `/.well-known/apple-app-site-association`. Share links, family invitations and app pages then open in the app.
- Your build's Associated Domains must list `applinks:` and `webcredentials:` with this host (`HUSHOS_LINK_HOST` in `App/Local.xcconfig`, docs/release/signing.md).

`ANDROID_APP_CERT_SHA256`:

- Format: colon separated hex, comma separated. Get them from `keytool -list -v` or the Play Console's app signing page.
- Set, the web serves `/.well-known/assetlinks.json`. Android then opens share links, family invitations and app pages in the app.
- Your build must answer this host (`-PdefaultOrigin=https://<your host>`, docs/release/signing.md).

`PLAY_STORE_URL`:

- Format: `https://play.google.com/store/apps/details?id=…`.
- Set, the home page, the family plans and phone apps posts, and the family page show Google's Get it on Google Play badge linking to it. Unset, no Google Play badge.
- hushos.com sets its own listing. Leave it unset unless the people using your server should install that app.

`APP_STORE_URL`:

- Format: `https://apps.apple.com/app/…/id…`.
- Set, the same pages show Apple's Download on the App Store badge linking to it. Unset, no App Store badge.
- hushos.com sets its own listing.

#### Storing the OPAQUE setup

Unset, `OPAQUE_SERVER_SETUP` is made on first start and kept in the database (`server_secrets`), so it lives and dies with the database backup. Set it to carry an existing setup to a new database.

#### The `log` adapter

- `EMAIL_ADAPTER=log` writes each message to the web service's log instead of sending it.
- It is the template's default, for a first run. Never use it for an instance other people use.
- Anyone who can read that log can finish another person's sign-up, so a production instance using it warns at start.

### Mail in development and production

- The development override runs Mailpit at SMTP port 1025 with its inbox at `http://localhost:8025`. `bun run infra:up` starts it with PostgreSQL.
- For a local full-stack preview, use `docker compose -f compose.yaml -f compose.dev.yaml up -d --build`. The override points container SMTP to `mailpit`.
- The base production stack has no mail capture service. Configure a reachable SMTP provider, Resend, or SES, and verify your sender/domain with it.
- Mail images use absolute URLs under `APP_ORIGIN`, which must be reachable by recipients.

### What email and the database hold

- Verification links expire after 30 minutes and use a URL fragment, so their tokens do not enter HTTP paths or access logs.
- Recovery additionally requires the independently generated recovery phrase.
- Email delivery never includes passwords or encryption keys.
- The database stores account metadata, public keys, encrypted private/root-key bundles, and hashed session/challenge tokens. See [the protocol](opaque-auth-design.md) for the precise boundary.

### Sessions

- Account sessions use HttpOnly, SameSite=Lax, Path=/ cookies. HTTPS adds Secure and the `__Host-` prefix.
- Session validity and credential revision are checked before remembered device unlock.
- Serve production over HTTPS.
- A cookie or database backup alone does not contain the plaintext account key. The OPAQUE setup is still a sensitive server secret and must be protected.

### Recovery and deletion

- The server cannot recover lost encryption keys from email alone. Users must retain their recovery kit.
- Keep database and OPAQUE setup backups together, encrypted and access controlled.
- A reset replaces the recovery phrase for future reset authorization. An old recovery kit plus its old wrapped-key bundle can still recover the unchanged root key offline.
- Deleting an account removes live database records. Operator backups and mail-provider retention follow your separate retention policy.

### Password changes and key rotation

- Account settings require a fresh current-password exchange for password changes and key rotation. Each operation revokes existing sessions and pending recovery attempts.
- Recovery-key rotation replaces the phrase. Master-key rotation replaces the root and phrase while preserving identity keys. Users must save a new recovery kit after either.
- Master-key rotation is restricted to accounts with no used or reserved storage, until encrypted Drive objects can participate in the operation.
- Old backups and recovery kits can still expose their old roots. Rotating a root does not revoke identity private keys already extracted from those copies.

## Sharing

Shares to accounts and links for anyone both keep the server out of the key:

- An account share is sealed between two identity keys. The recipient is told by email, through the same adapter as verification mail.
- A link's key rides in the URL fragment, which browsers never send. Its optional password is stretched on the visitor's device.

Configuration:

- Nothing is needed beyond `APP_ORIGIN` (the address in the email and in links) and the email adapter.
- Visitor routes under `/api/drive/links/` take no session. They are bounded per address and per token.
- So a reverse proxy must pass the real client address, the way it does for sign-in.

### Link tokens and access logs

- A link's token names the link to the server. Whoever holds it can fetch the link's encrypted tree; the key to open it stays in the fragment.
- The API takes the token only in the `x-link-token` request header, never in a path, so it does not land in a proxy's access log through the API.
- A proxy must pass that header through unchanged.
- A client from before this release used paths with the token in them. Those paths now answer 410 "Update HushOS to open links".

The page itself is still `/s/<token>`, so the token is in the path of that one request. The app's own logs record it as `/s/:token`. Keep `/s/` out of your reverse proxy's access logs too, or log those requests without the path.

With nginx:

```nginx
location /s/ {
    access_log off;
    proxy_pass http://127.0.0.1:5173;
}
```

With Caddy 2.8 and later: `log_skip /s/*` in the site block.

A link page does not ask for the session until the visitor chooses to sign in or save a copy. But the request for the page itself is a top-level navigation. A visitor who is signed in to this instance sends their session cookie with it, and the server could tie that request to their account.

### Live folders

Open folders stay current without a reload. While the tab is visible, the app polls every eight seconds:

- the workspace's change feed, `GET /api/drive/workspaces/:id/changes?since=`;
- the feed of every share it holds, `GET /api/drive/shares/:id/changes?cursor=`, which answers 410 once the share ends.

The share feed:

- carries only changes inside the share, deletions included;
- uses an opaque cursor sealed by the server and bound to the share;
- so a grantee learns nothing of the rest of the owner's drive or how often it changes.

Only the folders a change touched are refetched. A poll with nothing new costs one row.

### Stopping a share or a link

Stopping cuts the server off at once and then rotates keys. The owner's device gives the shared item and everything beneath it fresh keys. It re-seals what is still shared: remaining shares, remaining links, every version's content key. Whoever was cut off holds no key that still opens anything.

- Rotation runs in the background of the owner's tab, in batches of 200 nodes. If the tab closes first, it resumes the next time that account opens Drive.
- While it runs, nothing can be moved out of the rotated folder.
- Objects are never re-encrypted. A former member gets nothing further from the API. Once any download URL they held has expired (fifteen minutes for shared content), they get nothing further from the store.
- A password link made before this release cannot be re-sealed without its password, and is stopped by the rotation. Its owner makes a new one.

### No sharing in family folders

Family folders take no shares or links (docs/groups-design.md 3.4).

- The web never offered Share there.
- The server now refuses, with 409 `family-sharing`, to make a share or link in one, to seal one again, or to change its password or expiry. Stopping one still works.
- A server of an earlier release with families on (`GROUPS_ENABLED`, on by default) accepted them from any API client, though no HushOS app made them.
- The web and native apps refuse to re-key an item that has one. A key change below the folder's top level stops until they are stopped. The web says "An item in this family folder has shares or links".

To find any (hushos.com, with families off, has none):

```sql
select 'share' as kind, s.id, s.workspace_id, s.node_id from drive_shares s
  join workspaces w on w.id = s.workspace_id
  where w.owner_kind = 'group' and s.revoked_at is null
union all
select 'link', l.id, l.workspace_id, l.node_id from drive_links l
  join workspaces w on w.id = l.workspace_id
  where w.owner_kind = 'group' and l.revoked_at is null;
```

To stop them:

- Use the API: `DELETE /api/drive/shares/:id` or `/api/drive/links/:id` with `{ workspaceId }`, as any member of the family. This also marks the folder due for a key change, so whoever held it is cut off.
- Stopping them in SQL instead must also set `rotation_due_at = coalesce(rotation_due_at, now())` on the folder's `workspaces` row. Otherwise the recipient keeps a key that opens it.

## Operators and the management area

Every account is a member. An operator is a member whose role was raised from the command line; no request can do it:

```bash
bun run admin:grant someone@example.com
```

`bun run admin:revoke` reverses it.

Operators see a Management entry in the sidebar and `/app/admin`, which shows:

- counts of accounts, workspaces, stored bytes and objects;
- the deletion and replication backlogs;
- when the store audit last ran, and every object the audit could not find at the store;
- how many reports are open.

What operators never see there:

- Names and file contents are never shown. The operator holds no key that could show them, except the key a reporter sealed to them (next section).
- The API answers a member on `/api/admin/*` with 404, the same as a page that does not exist.

## Reports

Anyone who can see something through a link or a share can report it, signed in or not:

- the Report button on a link's page;
- "Report…" on an item under Shared with me.

How the item's key reaches operators:

- The reporter's device seals the item's key to the identity key of every current operator (a sealed box per operator). The server stores only sealed copies, and the operators alone can open them.
- That key is the item's node key. It opens everything beneath the item, every version of a file, and anything the owner adds under it later, not only the snapshot below.
- The operators are the ones the server lists, which is to say whoever runs the instance.
- An instance with no operator takes no reports. Grant one first.
- An operator promoted later cannot open reports filed before the promotion, since nothing was sealed to them. Another operator can.

### What a report holds

- The category and the reporter's reason.
- Who reported: the account and the share they saw it through, or an optional email and, for an anonymous visitor, an HMAC of their address. The HMAC allows one open report per address and node. All of it, and the reason, is deleted when the report is released.
- Whose files they are, and how the reporter could see them.
- No digest of the content. An operator who needs one (to file with an authority, say) works it out on their own device from the opened file, with SHA-256 on the report page, for files up to 64 MiB.
- A snapshot of the reported subtree: every live node beneath the reported one, up to 2,000, with the envelopes and object framing needed to open it later. The snapshot is what makes a report outlive the owner's deletions.

### The server hash key

- The address HMAC, and every rate-limit bucket built from an address, an email or an account, is keyed under the server hash key.
- That key is never written to the database. A plain hash of an IPv4 address is undone in seconds, and a key kept beside the hashes would undo them as quickly.
- With `OPAQUE_SERVER_SETUP` in the environment, the key is derived from it (HKDF-SHA-256), so every web process and every restart agree.
- Without it, each process makes its own at random. Rate limits then count per process. Both they and the one-open-report check start over when the process restarts.
- Set `OPAQUE_SERVER_SETUP` for an instance that runs more than one web process.

### Triage

Reports are triaged at `/app/admin/reports`. The queue orders open reports by age and shows a clock per category:

- one hour for terrorist content;
- 48 hours for intimate images;
- a day for child sexual abuse material;
- longer for the rest.

These are defaults for ordering, not legal advice.

Opening a report's content decrypts on the operator's device under their own identity. It writes a "viewed" entry to the report's record. Every action is on the record with who took it:

- Dismiss.
- Remove the content: trashed in the owner's workspace where they cannot restore it, with every share and link on it revoked, in the same step that closes the report.
- Mark as filed with an authority and their reference.
- Keep on or release a hold.
- Suspend or reinstate the uploader. Their sessions end at once and sign-in is refused until reinstated.
- Add a note.

Only an open report is resolved. A closed report that is still held is reopened first, then resolved again. A released one is not resolved at all.

### Holds and evidence

While a report is open, and afterwards for as long as it is held, the deletion outbox leaves the reported objects in the primary bucket whatever the owner does. The operator reads them from there.

When a report is released:

- A report marked filed is always held.
- A report closed without a hold (dismissed or removed), or whose hold is released after it closed, is released.
- Release is final. The report cannot be resolved again, held, reopened, re-sealed to a new operator or read again. A report about the same thing must be filed anew.
- The report records when it was released. Every one of those actions checks that under a lock on the report, so two operators acting at once cannot undo it.

A release:

- lets the bytes go to ordinary deletion;
- deletes the operators' sealed copies of the item's key;
- deletes who reported it (the account and the share it was seen through, or the anonymous reporter's address HMAC and email), the reason in the reporter's words, and the uploader's email;
- clears the snapshot's envelopes, signatures and signers;
- deletes the report's evidence requests, and has the worker delete its evidence copy.

What stays: the category, the record of what operators did (the "reported" entry loses its actor), and the snapshot's shape. The worker needs its object ids to find the evidence copies it deletes.

The release ends the server's part, not what an operator kept. An operator who opened the report had the item's node key on their device and could have kept it. That key opens the item, every version, and everything the owner adds beneath it later, for anyone who also has the ciphertext. Whoever runs the instance should treat operator devices accordingly.

#### The evidence bucket

Optionally, the worker also copies every reported object to a separate evidence bucket:

- within five minutes of the report;
- under `reports/<reportId>/<objectId>`;
- and deletes the copies of every released report, however it closed.

A report released before the worker reached it is never copied.

- Give that bucket its own credentials and set them on the worker only, so a compromised web container cannot reach it.
- Turn on object lock or a retention rule there where the provider offers one.
- Without these settings, every report shows "no evidence store configured" and the hold is the only preservation.

The operator reads the evidence copy from the report page ("Fetch from the evidence store"):

1. The web service records a request.
2. The worker answers it within seconds with a presigned URL per object, fifteen minutes long.
3. The operator's browser reads the objects from the evidence bucket directly, decrypting on their device.

That is how a held report stays readable if its primary copy goes missing, without the web service ever holding the evidence credentials. Once the report is released, no request is taken, answered or served.

What this means for the bucket:

- Its endpoint must be reachable from the operator's browser, not only from the worker.
- It needs a CORS rule allowing `GET` with the `Range` header from `APP_ORIGIN`, the same rule as the primary bucket.
- Add it to `CSP_CONNECT_SRC` (see [Content Security Policy](#content-security-policy)).

| Variable                                                                                                                                                                                       | Purpose                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `STORAGE_EVIDENCE_ENDPOINT`, `STORAGE_EVIDENCE_REGION`, `STORAGE_EVIDENCE_BUCKET`, `STORAGE_EVIDENCE_ACCESS_KEY_ID`, `STORAGE_EVIDENCE_SECRET_ACCESS_KEY`, `STORAGE_EVIDENCE_FORCE_PATH_STYLE` | Optional bucket the worker copies reported objects to; set all or none. Worker only. Nothing in the web app can read or delete there. |

### Evidence packets and filing

"Download evidence packet" builds a zip on the operator's device. It holds:

- the report as text and JSON;
- the record;
- every file's MD5, SHA-1 and SHA-256;
- the category's guidance on handling and where to file;
- the files themselves.

For child sexual abuse material, the packet carries hashes and metadata only. Possessing the files is itself the offence, and the reporting channels take them directly. Every packet download is on the report's record.

Reporting to authorities is the operator's act, not the software's. HushOS records what was filed where; it does not file. Which authority applies depends on where the instance is operated and where the people involved are:

- NCMEC's CyberTipline for child sexual abuse material seen by a US provider;
- the national hotline in the INHOPE network elsewhere;
- the police for threats.

Keep the report held while any of that is pending.

## Referrals and affiliates

Every account has an invite link (`/r/<code>`, shown under Invite friends in Drive).

| Setting                     | Default | What it is                                                  |
| --------------------------- | ------- | ----------------------------------------------------------- |
| `REFERRAL_BONUS_BYTES`      | 1 GiB   | What each side of an invite earns at sign-up                |
| `REFERRAL_SIGNUP_CAP_BYTES` | 5 GiB   | The most an inviter earns that way                          |
| `REFERRAL_PAID_BONUS_BYTES` | 5 GiB   | What an inviter earns when an invitee first pays for a plan |
| `REFERRAL_PAID_CAP_BYTES`   | 50 GiB  | The most they earn that way                                 |

- Someone who signs up through the link gets `REFERRAL_BONUS_BYTES` of extra storage, and so does the inviter, until the inviter has earned `REFERRAL_SIGNUP_CAP_BYTES` that way.
- When someone they invited first pays for a plan, the inviter earns `REFERRAL_PAID_BONUS_BYTES` more, up to `REFERRAL_PAID_CAP_BYTES`.
- `0` turns a reward off.
- Every reward is a storage entitlement, never money. Rewards are ordinary entitlements, granted when the new account finishes setting up or when Polar reports the first paid order.

### Affiliates

Affiliates are creators an operator enrols at `/app/admin/affiliates`. The Polar access token needs the `discounts:read` and `discounts:write` scopes as well as the ones billing already uses, or enrolment is refused.

Each affiliate gets:

- a page at `/go/<slug>` that shows the plans with their percentage off;
- a coupon code, registered as a discount with Polar when billing is on, so it applies at checkout and can be typed there;
- a commission on the net amount of every paid order from people who signed up through them.

Commissions:

- are recorded from Polar's `order.paid` webhook, once per order;
- are shown as owed until an operator marks them paid. Paying them is done outside HushOS.

A creator whose HushOS account is linked sees their code and earnings on their own Invite friends page.

- The operator links the account by email.
- An email with no account yet is kept, and linked once an account signs up with it.
- Without billing, affiliates can still be enrolled and attributed, but no discount exists to apply.

If an affiliate is removed while one of their orders is being paid, that order's commission can't be recorded:

- The web server logs an error, `Commission not recorded: its affiliate was removed while the order was paid`.
- The log names the order, discount, affiliate, code, amount and currency, under `billing` in its console output (JSON in production).
- Pay that commission by hand.

### Codes made at Polar

Any discount created directly at Polar with a code has a page too, at `/go/<code>`, with no affiliate and no commission.

- It shows the discount as Polar holds it: a percentage or a fixed amount, its plans and its end date.
- It carries the code to checkout the same way.
- A code that has ended, not started or run out of redemptions has no page.
- That lookup needs the `discounts:read` scope.

## Security headers

### Release header and self-reload

Every response carries two headers:

- `x-hushos-release`: the git commit the image was built from (`HUSHOS_RELEASE_SHA`, set by the published images).
- `x-hushos-version`: the product version the build carries (from `package.json` at build time; between releases, the last release's).

An open tab asks `/api/ready` for it every minute while visible, when it comes back into view, and on navigation. After a deploy, the tab reloads itself at the next quiet moment:

- at once on a public page;
- on the next navigation from a sign-in form;
- in the app, once no upload is running, with a banner until then.

### Headers on every response

- `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Cross-Origin-Opener-Policy`.
- A `Permissions-Policy` that turns off camera, microphone, location and payment.
- `Strict-Transport-Security` for a year, when `APP_ORIGIN` is HTTPS.

### Content Security Policy

Every page carries one:

- Scripts run only from the app's origin and, for the one inline script that hydrates the router, under a nonce minted per request.
- WebAssembly is allowed (`wasm-unsafe-eval`, for OPAQUE, libsodium, argon2 and pdf.js); `eval` is not.
- Previews draw from blob and data URLs the page makes itself.
- Workers and the media player frame come from the app.
- The page may connect only to itself, to the object store as presigned URLs address it (derived from `STORAGE_ENDPOINT`, `STORAGE_BUCKET` and `STORAGE_FORCE_PATH_STYLE`), and to whatever `CSP_CONNECT_SRC` adds.

| Variable                                       | Purpose                                                                                                                                                                     |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ANALYTICS_SCRIPT_URL`, `ANALYTICS_WEBSITE_ID` | Optional, web only. A self-hosted [Umami](https://umami.is) script (`https://analytics.example.com/script.js`) and the website id it gave you. See [Analytics](#analytics). |
| `CSP_CONNECT_SRC`                              | Optional, web only. Extra origins the browser may fetch from, space or comma separated.                                                                                     |

- Set `CSP_CONNECT_SRC` to the evidence bucket as presigned URLs address it (`https://<bucket>.<endpoint host>`, or the endpoint itself in path style), so operators can read evidence copies.
- A reverse proxy that adds its own `Content-Security-Policy` would combine with this one (browsers enforce both). Leave that to the app.
- The policy does not cover the object store itself. The store's CORS rule is what lets the browser read from it, as described under [Drive object storage](#drive-object-storage).

#### Analytics

- Set both `ANALYTICS_SCRIPT_URL` and `ANALYTICS_WEBSITE_ID` and the public pages load the script: home, pricing, blog, comparisons, offer and invite pages, legal pages.
- Nothing under `/app`, the sign-in, sign-up and recovery pages, or shared links ever does.
- A navigation from a public page into one of those is filtered before the beacon leaves.
- The script's origin is added to the Content Security Policy for scripts and connections.
- Umami sets no cookie.

## Notifications

Off by default while the apps that show them are built: `NOTIFICATIONS_ENABLED=true` turns them on. The web service reads it and `PUSH_RELAY_URL`; the worker only deletes events past 30 days, flag or not. The design is `docs/devices-design.md` 5; the relay is `docs/push-relay-plan.md`.

- **What happens.** Each event (a new sign-in, a device removed, something shared, a family invitation, someone waiting to join) is a row. A push names it by a random id, and the device fetches it over its own session and writes the notification itself. Nothing in a push says what happened.
- **The phone apps** can only be reached through Apple and Google with HushOS's own credentials, so pings for them go to the relay: `PUSH_RELAY_URL`, `https://push.hushos.com` by default. Set it empty to send none.
    - The server names its relay to the apps in `GET /api/notifications/settings` (`relay`). An app registers its token there and hands the server only the handle.
    - The apps use `https://push.hushos.com` only (a debug build also a relay on the developer's computer). A server with `PUSH_RELAY_URL` empty, or naming another relay, gets no phone pushes, and the apps hide their Notifications section: a push token is never handed to a host a server chose.
- **What the relay learns:** that a handle got a ping, from your server's address, at a time, and its class: `security` (a sign-in, a device removed) or `other`. It holds each device's APNs or FCM token, which identifies the device to Apple or Google, never the account or what happened. Apple and Google learn that a device received a ping at a time, and its tag, which stays the same for each account on that device: they can tell how many HushOS accounts a phone holds and how often each is pinged.
- **A ping can locate a device.** Every ping wakes the device to fetch from your server, so your server, or anyone who learns a handle, can make a phone connect and log its address, up to the relay's limits. Every ping shows a notification, so this is seen, not prevented.
- **Browsers** need no relay: the server pushes to the browser's own push service (Google's, Mozilla's, Apple's or Microsoft's, and no other host), encrypted to the browser and signed with this server's VAPID key, which it makes at first use and keeps in the database (`server_secrets`). The push carries only the event id; an open, unlocked HushOS tab writes the words, and otherwise the browser shows "New activity in HushOS". The push service learns that a browser received an encrypted push at a time.
- **What the server keeps:** each device's relay handle or browser subscription, the events for 30 days, and two toggles per account (Shared with you, Families). Security notices cannot be turned off.

## Two-step sign-in

Off by default: `TWO_STEP_ENABLED=true` lets accounts turn it on. Only `true` and `false` are accepted; any other value (`1`, `yes`) fails the environment check, so the web service answers 500 and fails its health check. Only the web service reads it and the two keys below; the worker only trims the security log. The design is `docs/two-step-design.md`.

- **What it is.** After the password, an account that has the step on gets no session and no keys until it passes a second step: a code from an authenticator app, a backup code, or its recovery phrase. The same step is asked before a password change, a key rotation, deleting the account, and any change to the step itself.
- **What it protects.** It is the server's rule. It stops someone who has a password from signing in to your server. It does not change how files are encrypted, and it does nothing against whoever controls the server, or holds a copy of its database with the OPAQUE setup.
- **With the flag off,** nobody can turn the step on, and the routes that set it up or manage it answer 501. An account that already has the step is still asked for it: turning the flag off is never a way past someone's second step. Such an account also cannot remove its step until the flag is on again.
- **Clients.** A client that cannot answer the step is told to update (409 `update-required`) when it signs in to an account that has it. The web app and the iPhone and Android apps from version 1.6 offer the settings and answer the step. An older phone app is told to update when it signs in to an account that has the step on.
- **`TWO_STEP_KEY`** (optional): 32 bytes, Base64url without padding. It seals authenticator secrets and keys the hash backup codes are stored under.
    - Unset, the key is derived from the OPAQUE server setup (HKDF-SHA-256, with its own `info`), wherever the setup lives. Moving the setup from the database to the environment changes nothing here.
    - Keep it outside the database, as you keep the setup. With the setup in `server_secrets`, the derived key sits beside what it seals and protects nothing against a copy of the database.
    - To make one: `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='`.
    - Both keys are read from the environment only. There is no `TWO_STEP_KEY_FILE` or `TWO_STEP_PREVIOUS_KEY_FILE` yet.
- **Rotating the key.** Set the new key as `TWO_STEP_KEY` and the old one as `TWO_STEP_PREVIOUS_KEY`.
    - Each row records which key it was made under, and the server reads under the current key, the previous one, and the derived one. So setting `TWO_STEP_KEY` for the first time needs no previous key.
    - **Only one rotation of an explicit key is safe for now.** Nothing re-seals older rows yet, and the server knows three keys at most: the current one, the previous one and the derived one. Going from the derived key to a first `TWO_STEP_KEY` loses nothing, and neither does one rotation after that, with the old key kept as `TWO_STEP_PREVIOUS_KEY` for as long as the instance runs. A second rotation drops the key before the previous one, and every authenticator secret and backup-code set still under it stops working. Wait for a release that re-seals before rotating again.
    - A row whose key the server no longer has is never treated as a wrong answer. The person is told that two-step sign-in is unavailable on this server right now (503) and to use their recovery phrase, and nothing is counted against them. The server logs an error with the row's kind and the id of the key it was made under (`twoStep.row`, `twoStep.sealedWith`; the id is the first 8 bytes of the key's SHA-256, not a secret). Putting the missing key back as `TWO_STEP_PREVIOUS_KEY` repairs it. Until then only the recovery phrase gets that person in. A backup-code set is unavailable only when none of its unused codes is under a key the server has.
    - Backup codes can never be re-keyed, because the server never holds them in plain text. A set keeps verifying under its own key until its owner makes a new one.
- **What the server keeps:**
    - each method's kind, when it was added, and when it was last used, to the hour;
    - each authenticator secret, sealed under the key above, which the running server can open;
    - backup codes only as a keyed Argon2id hash;
    - a security log per account for 90 days: the kind of event, the kind of method and the kind of device, never a name, an address or a browser.
- **Limits on wrong answers.** A step allows five answers. Codes, from an app or a backup set, have a budget of ten in 15 minutes. Each known device has its own, for sign-ins that prove the device's key and for changes made from its session; every sign-in that proves no device shares one. Wrong answers in a row are also counted, and the hundredth from devices HushOS doesn't recognise pauses the authenticator app on such devices until a backup code or the recovery phrase is used.
    - The 15-minute budgets are rate-limit buckets under [the server hash key](#the-server-hash-key). With the OPAQUE setup kept in the database, they count per process and start over when a process restarts. So do the hourly caps on the failed-step notice (one) and on failed-step lines in the security log (ten).
    - The count to 100 is a row in the database: it holds across processes and restarts, whatever the setup.
- **Notices.** Every change to the step, a backup code or the recovery phrase used, and a run of wrong answers after a correct password are emailed to the account. They cannot be turned off, and they name only the kind of method and the time. They go by email only: the apps' push notifications do not carry them yet.
- **You can turn anyone's step off.** Anyone with write access to the database can delete a person's methods, because the step is a server rule. The management area has no button for it.
- **Losing everything.** The recovery phrase passes the step. Someone who has lost every method, their backup codes and the phrase cannot sign in, and neither email nor the operator's pages can let them in.
- **Rolling back** past the release that added the tables is covered under [Release migration notes](#release-migration-notes).

## Billing (optional)

Self-hosted instances have no billing. Leave `BILLING_PROVIDER=none`, and every account keeps the allowance set by `INITIAL_STORAGE_QUOTA_BYTES`.

The hosted service sells storage plans through [Polar](https://polar.sh) as merchant of record. Polar collects payment, handles sales tax and VAT, and issues invoices. HushOS keeps the customer and subscription mapping locally and derives storage entitlements from it. Polar never sees file names, content, or keys.

| Setting                | Purpose                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `BILLING_PROVIDER`     | `none` (default) or `polar`.                                                                                              |
| `POLAR_ACCESS_TOKEN`   | Organisation access token. Its scopes are listed [below](#access-token-scopes).                                           |
| `POLAR_WEBHOOK_SECRET` | Secret of the webhook endpoint pointed at `https://<APP_ORIGIN>/api/billing/webhook`.                                     |
| `POLAR_ENVIRONMENT`    | `production` (default) or `sandbox`. Tokens and webhook secrets are specific to each environment.                         |
| `BILLING_GRACE_DAYS`   | Days an allowance outlives its billing period, so a late renewal or a payment retry does not cut anyone off. Default `3`. |

`BILLING_GRACE_DAYS` does not cover a lapsed plan. A plan whose retries ran out (`unpaid`), whose first payment never went through (`incomplete`), or that is paused gives nothing from the reconcile that sees it.

### Access token scopes

`POLAR_ACCESS_TOKEN` needs:

- always: `checkouts:write`, `customers:read`, `customers:write`, `customer_sessions:write`, `subscriptions:read`, `subscriptions:write`, `orders:read`, `products:read`;
- with families on: `members:write`, `refunds:read` and `refunds:write`;
- for affiliates: `discounts:read` and `discounts:write`;
- for `bun run polar:seed` runs that change products: `products:write`.

The token needs no scopes beyond those.

### Polar dashboard settings

- Keep "Enable subscription unit changes" off (confirmed off in the sandbox, spike E7). Then no portal raise makes an order HushOS didn't ask for, and every change of places goes through HushOS's checks.
- In the Customer Portal settings, keep "Enable subscription plan changes" and "Enable subscription seat management" off.
    - With plan changes on, Polar's portal lets any subscriber move to any product in the organisation: a family onto a personal plan, or the reverse. That goes around HushOS's storage check and tier rules.
    - HushOS's own pages already make every plan change: "Switch to …" for a personal plan, under Billing; Change plan for a family.
- In the same Customer Portal settings, keep "Allow multiple subscriptions" off. Polar then refuses a second paid checkout for a family's customer (proved in the sandbox), on top of HushOS's one open checkout per family.

### Plans are Polar products

Prices and names are edited in the Polar dashboard, never in code.

#### Seeding the catalogue

- `bun run polar:seed` creates the launch catalogue (Plus, Pro, Max; monthly and yearly) in whichever organisation `POLAR_ACCESS_TOKEN` belongs to. It skips products that already exist.
- With `--update`, it also brings existing products' prices, descriptions, and metadata in line with the script. A changed price replaces the old one for new checkouts and plan changes; current subscribers keep theirs.
- The token needs `products:write` for those runs.

#### Currencies

- Each product carries one fixed price per currency. The organisation's default currency (USD) is required; the others are optional.
- Polar charges a customer in their local currency when the product has one, and falls back to the default otherwise.
- The pricing page shows the same currency. It is chosen from `TRUSTED_COUNTRY_HEADER`, then the browser's language, with a selector to change it.
- The currencies and amounts live in the seed script's table.

#### What makes a product a plan

A product is offered as a HushOS plan when:

- it is recurring;
- it has a fixed price in the default currency;
- it carries two metadata keys: `hushos_plan` (any value) and `quota_bytes` (the storage it grants, as an integer).

Monthly and yearly are separate products. Archiving a product hides it from the pricing page while existing subscribers keep it.

#### Family plan products

A product that also carries `hushos_group_kind` is a group plan, and is never offered as a personal one.

A **family plan** has:

- `hushos_group_kind: family`;
- `hushos_plan`;
- `quota_bytes`: the whole family's pool, the same whatever the member count;
- `included_members`.

Per currency, it has one fixed base price and one graduated unit price:

- the first tier free up to `included_members`;
- the second tier at the per-member rate, with no upper bound;
- `minimum_units` equal to `included_members`.

Polar checks only that currencies share that structure. So HushOS drops a family product:

- whose currencies disagree on the free tier's bound or the minimum;
- whose bound differs from `included_members`;
- whose per-member amount is not a whole number of minor units;
- that carries `quota_bytes_per_member` (reserved for company plans, whose pool grows per member).

A family product may also carry `hushos_tier` (`plus`, `pro` or `max`):

- One with any other value is dropped.
- One without it is read as the single Family plan from before the tiers. The pages stop offering it as soon as any tier is on sale. Families on it keep it.

#### Seeded prices

`bun run polar:seed` creates the three family tiers, monthly and yearly. Four members are included in each.

| Family tier | Pool   | Monthly (USD, EUR) | Monthly (GBP) | Monthly (INR) | Yearly (USD, EUR) | Yearly (GBP) | Yearly (INR) |
| ----------- | ------ | ------------------ | ------------- | ------------- | ----------------- | ------------ | ------------ |
| Family Plus | 800 GB | 10                 | 8             | 399           | 96                | 72           | 3,900        |
| Family Pro  | 2 TB   | 20                 | 16            | 799           | 192               | 144          | 7,800        |
| Family Max  | 4 TB   | 30                 | 24            | 1,399         | 288               | 216          | 13,800       |

- A member past the included ones costs 1.50 USD or EUR, 1.20 GBP or 59 INR a month.
- Yearly, a member past the included ones costs ten months: 15 USD or EUR, 12 GBP, 590 INR.
- A year is a round total that splits into twelve.
- Personal plans likewise cost 48, 96 and 144 USD or EUR, 36, 72 and 108 GBP, and 1,980, 3,900 and 6,900 INR a year.
- The prices are in `packages/billing/src/seed-prices.ts`.

#### Pricing rules

Before it calls Polar, the script refuses a yearly price that:

- doesn't split into twelve whole units of its currency; or
- costs more than ten months (the pages say "2 months free").

Those are HushOS's own pricing rules, not the app's. To price otherwise, change `priceProblem` in that file. Then:

- With a year that doesn't split, the pricing page shows every yearly price in that currency as a yearly total.
- With a year dearer than ten months, it drops the saving label everywhere.

A changed price reaches Polar only with `--update`, for new checkouts and plan changes. Subscribers keep the price they have.

#### Archiving the old Family plan

- `--archive-legacy-family` archives the single "Family (monthly)" and "Family (yearly)", only once all six tier products exist.
- Families already on them keep them.
- It runs only when you run it, and the archive needs `products:write`.

### Family plans

With `BILLING_PROVIDER=polar` and `GROUPS_ENABLED=true`, a family's storage and seats come from its plan instead of `GROUP_AREA_QUOTA_BYTES` and `GROUP_SEAT_LIMIT_DEFAULT`.

#### The family at Polar

- Each family is one Polar team customer, external id `group:<groupId>`.
- It is created when a member holding the family's `billing` role starts checkout.
- That member is the team's owner (external id: their user id) and the family's payer.
- Polar is told the family is a "HushOS family", never its name or its members.

#### The pool

- The plan's `units` is the number of places bought.
- A family without a live plan has one place (its organizer) and an empty pool. Nothing is stored in its folders free.
- Every folder of a family draws from the one pool. So do its members' own files (My files) while the plan is live: until its period ends, plus `BILLING_GRACE_DAYS`.
- Each member's own allowance (the free base, referral bonuses, operator grants) is set aside, not added. It counts again the moment they leave, are removed or the plan ends.
- Someone whose files then take more than their own allowance can still read, download and delete everything. Uploads are refused until they make room or buy a plan. Nothing is deleted.
- A member who pays for a personal plan draws from the pool too, from the moment they're let in (or the family's plan goes live). See [Members who pay for a personal plan](#members-who-pay-for-a-personal-plan).
- Letting someone in is refused (`409 pool-full`) when their own files are more than the pool has free (docs/families-shared-pool.md 3).

What each person sees of usage:

- A family's managers (the organizer and anyone holding `members` or `billing`) see each member's own usage, rounded up to the whole GiB. Never names, counts or contents.
- Every member sees the family's total and the family folders' total, counted part by part in whole GiB.
- So no figure gives away one person's exact usage.

#### Buying places

- Only the payer adds places.
- A place is charged at once, prorated by the second.
- The newcomer is let in only after Polar accepts the charge.
- HushOS refuses a family above 20 members, since Polar caps nothing. One raise may fill a family to that limit, and the payer sees its charge before confirming.

When the charge doesn't go through:

- A declined card (402 `PaymentFailed`) changes nothing at Polar or here, and is reported as such.
- A bank that wants the payer to confirm (402 `PaymentActionRequired`) sends them to the portal.
- Polar answers a raise, or an upgrade, before it charges the order the change makes (a second or two later in the sandbox). So HushOS waits up to six seconds before it tells the payer their bank wants them to confirm.

Timing:

- A place purchase or plan change answers within about 25 seconds, however slowly Polar answers.
- Its reads are cut short and the wait shrinks to fit. The change itself always gets its full 15 s, and is sent only while that still fits.
- A change whose answer is lost (a timeout, a 5xx) is answered from the plan as Polar holds it when read again.
- If it can't be read, the payer is told it isn't clear yet, never that nothing was charged.

When a raise counts as paid:

- Only once its own order is there and paid, with no other order waiting.
- Its own order is a `subscription_update` order for the product that wasn't among the plan's orders just before the raise. Polar leaves a change order's `units` null, so it can't be told by its places.
- No order yet is not a paid one.
- A decline is answered with `code: declined`. The page offers Card and invoices beside a retry.

When a place opens:

- Only once it is paid for.
- HushOS counts the places Polar holds as paid only while no order of the plan waits for payment (`orders:read`). Waiting means a `pending` order with something due, or a `draft` Polar hasn't finalized.
- So a raise awaiting the bank opens nothing until its `order.paid` arrives, or the next reconcile finds it paid.

#### Raises waiting on the bank

- A raise whose order has waited more than 7 days for the bank (an unanswered 3-D Secure or e-mandate prompt) is cut back, at the end of the period, to the places paid for.
- The cut is withdrawn if the order is paid later.
- A raise made within 7 days of a renewal can therefore be billed once at that renewal before it is cut back.
- The order itself stays at Polar.

#### Fewer places

- Fewer places take effect at the end of the period.
- Never below the members already in the family, or the plan's included count.
- They block new admissions from the moment they are made.
- A raise deletes a scheduled cut at Polar. HushOS records the cut and schedules it again.
- If Polar refuses, the worker retries it (`billing.reissue-cut`, with backoff). The daily reconcile asks again until it is in place.

#### Changing tier

The payer moves the family between tiers billed the same way. Places carry over.

- **A bigger tier** starts at once. The product changes at Polar with `invoice` proration, so the difference for the rest of the period is charged now. A refused charge changes nothing.
- **A smaller tier** starts at the end of the period (`next_period`) and refunds nothing. It is refused while the family (its folders and its members' own files) stores more than its pool.

Which tier a family has paid for, and so its pool, comes from Polar's orders, re-read on every reconcile. It is the product of the subscription's newest paid, unrefunded checkout, renewal or change order.

- A paid upgrade gives its tier.
- An unpaid one leaves the last paid order's tier in force. The pool is the lesser of that tier's and the product's, so a smaller tier at a renewal counts at once.
- A paid renewal of the bigger tier gives it, even while the change order still waits.
- A refund in full (status `refunded`, or refunds reaching what the order charged) falls back to the order paid before.
- A partial refund keeps the tier.
- A plan first seen with nothing paid has no pool until it is.

Guards:

- If an unpaid upgrade's paid plan is no longer offered (archived), nothing is scheduled. The family keeps the smaller storage and is listed under **Plan changes stuck** with the reason, until the upgrade is paid or the plan is set by hand.
- No place can be bought while the product differs from the tier paid for, read from Polar's orders just before.
- A place purchase and an upgrade never run at once for a family. Each holds a two-minute claim on the family's row. The other is told "Another change to this plan is in progress. Try again in a moment."
- A raise Polar bills on a product other than the one it was asked on (the plan changed in the dashboard meanwhile) lets nobody in. Its order is recorded as never paying for a tier.
- If the product has been bigger than the tier paid for for more than 7 days, the plan is moved back to the tier paid for at the end of the period. The 7 days count from the oldest unpaid change order for it, or from when HushOS first saw the difference. The move is withdrawn as soon as the two match.

#### An upgrade paid after its revert

**It is not credited back.** If an upgrade's order was paid only after the 7-day rule had moved the family back at a renewal, the family is on the smaller tier and Polar has the money for the bigger one.

- HushOS logs `Unconfirmed upgrade reverted at the period end` when it schedules the revert.
- To refund, open the subscription's `subscription_update` order for the bigger product in the Polar dashboard (Sales → Orders, filter by the customer `group:<groupId>`). Refund it in full, or for the part of the period the family did not have.
- Or call `refunds.create` with that order's id.
- The payer can also choose the bigger tier again.

#### Scheduled changes and retries

Polar keeps a scheduled move and a scheduled cut side by side, one call each. An upgrade drops both, so HushOS records them and asks again for the cut (not the move, which the upgrade replaced).

- A re-issue is sent only when Polar holds something else.
- A reconcile within 15 minutes of the same re-issue sends nothing, and queues a retry for when the window ends. So the deliveries a re-issue causes never repeat it, and a needed one is not lost.
- Retries go to `billing.reissue-pending`, a `stately` queue keyed by the family. The family's row also claims its one pending retry, so a family never has more than one.
- A re-send that fails (Polar down, a 5xx, a timeout) is retried with backoff for as long as it takes, up to six hours apart.
- Only answers of 200 that Polar then didn't keep count. After 5 in a row, HushOS stops and logs `Family plan’s scheduled change given up: Polar would not keep it` at error level.
- It lists the family under **Plan changes stuck** on the management page (Management, `/app/admin`), with the change it wanted. Set the change on the subscription in the Polar dashboard. The row goes, and the count starts again, once Polar holds it.
- If a retry can't be queued (the worker hasn't made `billing.reissue-pending` yet after an upgrade), the family's claim is let go so the next reconcile queues it.
- `billing.reissue-cut`, the queue before it, is still worked so jobs already in it drain. It can be deleted once empty.

#### The payer

- While a family's plan is live (active and not set to cancel), its payer cannot delete their account, leave the family or be removed from it. This holds even when another member holds `billing`.
- Meanwhile, nobody can dissolve the family by leaving last or deleting their account.
- They are told to cancel the plan first. Handing billing over is not built yet.
- Cancelling (at the end of the period, in Polar's portal) frees the payer at once. They can leave, be removed or delete their account.
- The family keeps its paid places and pool until the period ends. Then the plan ends as any other does. `BILLING_GRACE_DAYS` covers only a renewal that is late, not a plan that has ended.
- A payer who is no longer a member can still open the portal and schedule fewer places while the plan is live. So they can always stop paying.
- A live plan whose payer's account is gone (a checkout paid after they deleted it) is revoked at Polar as soon as a sync or a delivery sees it, and logged. A plan already set to cancel runs out instead.

#### A family plan whose payment failed, or that is paused

A plan that is `unpaid`, `incomplete` or `paused` gives the family no pool and no extra places, from the reconcile that sees it.

**What the family page says.** "Family Pro's payment didn't go through", with the way forward for whoever reads it:

- the payer: choose a plan, or the billing portal if it offers to retry the payment;
- another `billing` holder: choose a plan, and pay from then on;
- a member: a plain statement, no payment actions.

**When it is revoked.** Polar still holds such a plan. So it is revoked before anything could leave it charging beside another plan, or on the card of someone who has gone:

- before a family checkout (and the payer takeover in it);
- before its payer leaves the family or is removed;
- before its payer's account is deleted;
- by the job for a dissolved family (see [Dissolved families](#dissolved-families)).

**Where they are found.** In the mirror, and in Polar's list of the team customer's subscriptions.

- One whose delivery never arrived is then written to the mirror.
- One whose product the catalogue can't read (archived or edited) is written as it stands, giving nothing. It is named "Family plan" on the page rather than by Polar's product id.
- Every reconcile keeps that one as Polar has it. So it leaves the page once ended, and a payment on it is the family's.
- Every read of a family's plans at Polar reads every page of the list.

**Each is read again first.** Any plan live at Polar is the family's plan: the checkout is refused and the plan written to the mirror. Live means paid again in the portal, or a past-due one the mirror missed, which Polar's customer state doesn't list.

##### Confirming before a checkout

- A checkout ends them only once the person has confirmed them, in a dialog that says they end now, even if the checkout isn't finished.
- The request carries the ids of the plans the dialog showed.
- The family is read again. Unless every plan found is among those ids, the person is asked again (`ends-lapsed`). One the page still showed that has ended since is no matter.
- They are ended before a payer takeover changes anything at Polar. So a revoke Polar refuses leaves the payer as they were, with the plan still on their card for their own leave and deletion.
- A takeover that fails after the revoke leaves the plan ended, as the dialog said.

##### Confirming before a leave or removal

A leave and a removal each end the plan only once confirmed, by plan id:

- The call carries `endsLapsed`: the ids of the plans the person was shown.
- Unless every such plan the person pays for is among them, the server answers `ends-lapsed` with each plan's id, name and standing, ending nothing.
- The dialog names them and asks again.

A leave:

- runs the leave's own rule first. A leave it refuses ends nothing.
- Its dialog names the plan up front, for a payer whose `billing` was taken too.
- A member's summary says whether they pay for it, with the ids only for that person.

A removal:

- asks first: `POST /api/groups/:id/members/:userId/remove-preview`, for `members` holders.
- The preview changes nothing at Polar, though it may write the family's plans it finds to the mirror. It refuses at once a payer of a live plan.
- It runs before any demotion, hold or folder walk, so cancelling changes nothing.
- It ends the plan only after every check of the call and every rule of the write itself. Those run first in a transaction that is rolled back. So removing the family's only `billing` holder, or a member list a departure overtook, ends nothing.
- Only a race between that preview and the write can refuse it after the revoke. The retry removes them.

The question, and every leave or removal of a payer, read Polar. So they are paced at twenty a person a family every ten minutes.

The member list doesn't offer to remove the only `billing` holder. It says someone else must be made the organizer first.

##### A payer whose plan runs again

A payer whose plan Polar shows live again and not set to end can't leave, be removed or delete their account. That covers a plan paid in the portal a moment ago, before its delivery, or one resumed while HushOS was ending it (which the revoke then leaves alone).

- Exception: if they are the last member, they can leave, and the dissolved family's job sets the plan to end.
- They are told that it runs, on their card, and to cancel it in the billing portal at hushos.com or contact support. Those words work in the apps, and where the family's page doesn't open.
- The family is read again.

##### Plans on a product HushOS can't read

- They are written to the mirror whatever their state, live included, so a plan that can charge is never lost.
- But such a plan is never the family's plan, its places or pool. Nor does it make its payer one who pays for the family, since its tier can't be read.
- Its payer is told the same as above, and support resolves it in Polar.
- Whether a plan's product reads is kept in its own column (`group_billing_subscriptions.product_unread`). So a plan Polar moves from one unreadable product to another stays unread.

##### When Polar can't list the plans

- The dissolved family's job reads the list first, so a plan the mirror never held is set to end too.
- A list that can't be read, or whose plans can't all be read and recorded, is owed (`group_billing_customers.plans_unlisted_since`, cleared only once every plan listed is recorded).
- While owed, the daily reconcile reads it again until it can, the management page lists it under **Family plans not listed**, and the family isn't purged.
- A lapsed plan paid as its revoke reads it is read again and set to end by the job's retry, never left renewing.
- Polar refusing to list or read the family's plans for this lookup refuses the change.
- A 4xx other than 404 (a token without the scope, a request Polar rejects) is also logged at error level each time: `Polar refused to read a family’s plans; checkouts, leaves and removals wait`. One that lasts refuses every such change for every family until it is fixed.

##### When Polar refuses the revoke

- Every refusal (a period Polar shows paid, locked, any other 4xx, no answer) is logged once at error level with the subscription. The message is `A lapsed family plan could not be revoked`, or, when locked, Polar's reason.
- It is listed on the management page under **Lapsed plans not ended** until a revoke lands or the plan is no longer lapsed (live again, or ended). What asked for it (a deletion, a leave, a new plan) waits on it.
- A locked plan says "Polar is still working on a change to the family's Family Pro plan, so it can't be ended yet." and logs `A lapsed family plan could not be revoked: Polar says it is locked` at error level.
- A 5xx or no answer refuses but keeps the ending.

##### Plans HushOS won't end yet

Never ended by a checkout, a leave, a removal or a deletion (both are refused, with what to do instead):

- an `incomplete` plan younger than a day: a checkout still waiting on the bank. Polar documents no window, and Stripe, under it, expires an incomplete first payment after 23 hours.
- an `unpaid` plan whose current period has a paid order: a payment Polar hasn't applied, or a failed seat-change invoice marking the whole plan unpaid.

##### Payments after the revoke

- The ending is written before Polar is asked, keyed by the family's id. `personal_plan_endings.user_id` is then the family's id and `group_id` is null. Whether an ending is a family's is told by the subscription's row in `group_billing_subscriptions`.
- The orders already paid are noted as used.
- A payment Polar takes for the plan afterwards is refunded whole by the `billing.end-personal-plan` job, run for the family. Its comment is "Paid after HushOS ended this plan, which no longer runs".
- It is retried, and listed under **Refunds owed** (as "family <id>") after five failures.
- If Polar still shows the plan running (the revoke never landed and the payment restored it), the ending is dropped and the payment is the family's.
- The job then grants what its delivery would have earned: the affiliate commission (by its discount, else the creator the payer signed up through), and the paid bonus for whoever invited the payer.

#### One plan per family

##### One open checkout

- A family has one checkout open at Polar at a time (`group_checkouts`). It is claimed in one statement, so two requests at once can't both win.
- It holds while it can still be paid: until the `expires_at` Polar gives the checkout. Polar's checkout sessions last 24 hours, which HushOS assumes only when Polar gives none.
- Meanwhile, another `billing` holder is refused, before the takeover or anything else changes: "Someone else in the family started a checkout 5 minutes ago. If they finish it, the family has its plan. If not, you can choose a plan in about 24 hours."
- A holder who left, was removed or lost `billing` keeps the family's claim while their checkout can still be paid.

For the person holding the claim:

- Choosing the same plan with the same places and currency gets the same link back, from any network. The billing address is not part of the choice.
- Choosing anything else later (another plan, or other places or currency) lets their own open checkout go and opens a new one.
- One of theirs still being opened in another tab is never replaced, so two tabs at once make one checkout.
- Their earlier checkout may still be paid. If both are, the reconcile keeps one plan and refunds the other whole.

Before refusing, and before giving the same link back, HushOS asks Polar about that checkout:

- One it says expired or failed frees the family at once.
- One paid sends the family to be read again.

The claim:

- is held by a token, renewed before the payer takeover and before Polar's checkout is made. So a request that stalled while another took the family's claim stops before it changes anything more.
- Only the request holding the claim records its checkout.
- A checkout Polar fails to make, or one refused on the way, lets the claim go.
- A plan that goes live clears it.
- The daily reconcile deletes expired ones. A family's purge deletes its row, and an account's deletion its claims.

##### When two plans run anyway

This can happen through checkouts opened before this release, a plan made in Polar's dashboard, or a cancelled plan Polar reinstated beside the one bought since.

Any reconcile keeps the plan supplying the family now:

- That is the one with `group_billing_subscriptions.served_since`: when a plan began supplying the family without a break. Only the family's plan has it.
- With none, it keeps the oldest by Polar's `created_at`.

`served_since` is cleared the moment a plan stops: when it lapses (unpaid, paused, incomplete), ends, is superseded, or runs beside the family's plan. `served_until` is brought back to that moment if its period ran on. So a plan that lapses and resumes after the family bought a replacement is the one revoked, and its new charge refunded.

For every other plan, the reconcile:

1. Marks it superseded, in the same write that applies Polar's state. It chooses the plan to keep in that write, under the family's lock and from its rows, so two reconciles curing at once never end both. The pool, places and tier never act on a superseded plan, nor does a later run take it for the family's, while its revoke waits on Polar.
2. Revokes it.
3. Refunds whole every payment on it made (by `created_at`) after the last period it served the family (`served_until`, or its own end if earlier). For a plan that never served it, that is everything: one made beside the family's plan, recorded while still incomplete, or written by a delivery racing another.

Safeguards:

- A reconcile never marks ended a plan another delivery wrote after it began reading Polar. So two deliveries at once can't sweep each other's plan.
- With any plan missing Polar's `created_at`, none is revoked, on that reconcile or any later one. It is logged at error level each time: `A family has two live plans and Polar gives no creation time; none revoked`. Both stay under **More than one plan** for an operator to decide in Polar.

The refund:

- goes through the `billing.end-personal-plan` job, run for the family's id;
- is logged as `A family had two live plans: one is revoked and its overlap refunded`, and listed under **Plans revoked to refund**;
- Polar keeps its fee on that refund.

Affiliate commission on an order refunded whole:

- An unpaid commission is taken back. The order is kept (`affiliate_withdrawn_orders`), so a delivery arriving after never records it again.
- One already paid out is marked (`affiliate_earnings.order_refunded_at`) and logged at error level once, for an operator to settle with the affiliate.

##### More than one plan

**More than one plan** on the management page lists every family and every account with more than one subscription that can still charge, with their statuses. That means a double charge, or one waiting to happen. Check them in Polar's dashboard.

- Can still charge: live, or unpaid, incomplete or paused.
- A live one already set to end at its period's end is left out, since it charges no more unless resumed.

#### Products HushOS can no longer read

A subscription whose product HushOS can no longer read (its metadata or prices edited, so the catalogue drops it) is left as it was and logged.

- The family keeps its places and pool, and its payer stays the payer, until the product is fixed.
- It follows Polar's status, end and period all the same. Only its product, tier and places stay as last read.
- Once Polar ends it, it is recorded as ended. It never counts as live or keeps a dissolved family from the purge.
- If Polar reinstates it, it is the family's plan again with its tier, and a dissolved family's job sets it to end.

#### Switching billing off

Switching back to `BILLING_PROVIDER=none` stops reading pools.

- Every family folder falls back to its own allowance. That is 0 for folders created while billing was on.
- So their owners can read, download and delete, but not upload, until an operator grants storage to those workspaces (see the admin storage grants).
- Seat limits a plan wrote stay as they were.
- `group_storage` and the billing tables are left in place, and are read again if billing returns.

#### Members who pay for a personal plan

A member who pays for a personal plan stops paying for it when their files join the pool. Once let in (or once the family's plan goes live), the worker's `billing.end-personal-plan` job:

- revokes their personal subscription at Polar at once;
- refunds the unused part of the current period, prorated by the second from the revoke, before tax, on every order that paid for that period: a renewal, and a mid-period upgrade's change order.

How the refund is worked out:

- Every order's unused share is summed. A mid-period downgrade's credit is taken off; an upgrade paid from that credit is added.
- Each order's share is of its net amount, less other people's pending or succeeded refunds, rounded down.
- It is placed on the orders, at most what Polar will refund on each (net amount plus any balance applied).
- Polar refunds the matching tax itself, and keeps its own fee.
- Credit left in the customer's balance is not paid out.
- An order paid after HushOS saw them pooled (a renewal that slipped past the revoke) is refunded whole.

Never refunding twice:

- Each refund carries HushOS's key in its `hushos_refund` metadata. It is matched against the order's refunds at Polar before every call. So retries, replayed deliveries and the daily reconcile never refund twice.
- One person's runs never work one plan at once. Each holds a two-minute lease on the plan's row, on the database's clock, renewed between steps and checked before every refund. It uses rows, not an advisory lock, so it holds behind a transaction-mode pooler.
- After a refund call that timed out or got a 5xx, HushOS doesn't ask again for 10 minutes, since Polar can still make it.

What Polar won't refund on the period's orders (as when the customer's balance paid them):

- is refunded on the customer's earlier card-paid orders, newest first, within what Polar takes back on each, counting refunds already made first;
- unspent balance is never paid out;
- a disputed order's share is dropped, never moved;
- an earlier order that fails five times in a row is given up and listed under Refunds owed. (A charge too old for Stripe comes back from Polar as a 500.)
- What no order can carry, and what a dispute dropped, is logged and listed under **Not refundable through Polar** on the management page, for an operator to decide.

Failures:

- A failure is retried ten times over about a day.
- A refund that fails five times in a row is listed under **Refunds owed** on the management page, with the order and amount, and logged at error level.
- It is asked for again at most once a day, until it lands or an operator refunds it by hand in Polar's dashboard.
- Any refund on the order from HushOS's first ask on, with or without its key, counts as HushOS's.
- A pending refund, anyone's, keeps the order open, so one that later fails is owed again.

Other rules:

- A personal plan Polar answers as `unpaid`, `incomplete` or `paused` is revoked by this job with nothing refunded, since nothing paid for it is still in force (see [When a personal plan's payment fails, or it is paused](#when-a-personal-plans-payment-fails-or-it-is-paused)). A payment Polar takes for it afterwards is refunded whole.
- While their files draw from a family's pool, buying or resuming a personal plan is refused (`409`, `code: in-family`).
- Someone who leaves before the job runs keeps their plan.
- The token needs `refunds:read` and `refunds:write` for this. Without them, plans are still ended and every refund is listed as owed.

### Webhooks and reconciliation

Subscribe the webhook endpoint to these events:

- `customer.*`;
- `subscription.*`;
- `order.*`;
- `refund.updated`. It tells HushOS at once when a refund it made fails after it succeeded. Without it, the daily reconcile finds it, up to a day later.

Set the endpoint's API version to `2026-10`, the version HushOS calls the API with.

- Polar shapes webhook payloads by the version set on the endpoint (its `api_version`), never by the client's.
- Changing it affects only events created afterwards.
- Polar releases an API version each quarter, and removes a deprecated one at the next release.
- `2026-04`, which HushOS used before, became deprecated when `2026-10` became Current on 1 October 2026. By Polar's schedule it goes at the January 2027 release, so move an endpoint still on it before then.

How deliveries are handled:

- Every delivery is verified with the Standard Webhooks signature and recorded by its message id.
- It is answered by re-reading the customer's state from Polar. So duplicate, reordered, or missed deliveries cannot corrupt local state.
- The worker also re-reads every billing customer once a day.
- Both the web and worker services need the billing settings.

For local development, use a sandbox organisation and relay deliveries with Polar's CLI:

```sh
polar listen http://localhost:5173/api/billing/webhook
```

### When a subscription ends

- Its entitlement is revoked and the allowance returns to the base quota.
- Content is never deleted or made unreadable.

Deleting an account:

- revokes every personal plan that can still charge: the customer's active and trialing plans, every subscription Polar lists for the customer that hasn't ended, and every one the mirror holds as not ended (past due, unpaid, incomplete, paused);
- deletes the Polar customer first;
- refuses to proceed if Polar cannot be reached.

### When a personal plan's payment fails, or it is paused

What each Polar status means for a personal plan:

| Polar status                                                                               | Storage                                                     | Mirror                                               | Billing page, checkout                                                                                                                                           |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `active`, `trialing`                                                                       | the plan's, until its period ends plus `BILLING_GRACE_DAYS` | kept                                                 | the current plan: switching changes it in place, prorated                                                                                                        |
| `past_due` (Polar retrying a renewal)                                                      | the plan's, until its period ends plus `BILLING_GRACE_DAYS` | kept                                                 | the current plan, shown as payment overdue with Update card                                                                                                      |
| `unpaid` (Polar's retries ran out), `incomplete` (a first payment that never went through) | Free's, from the reconcile that sees it, mid-period too     | kept with Polar's status, read again every reconcile | not the current plan: Free, with "the payment didn't go through", a new plan (which revokes this one first), or Polar's portal if it offers to retry the payment |
| `paused`                                                                                   | Free's, from the reconcile that sees it                     | kept, read again every reconcile                     | not the current plan: Free, with "paused", Resume in portal or a new plan, which revokes this one first                                                          |
| `canceled`, `incomplete_expired`, or gone at Polar (404)                                   | Free's                                                      | recorded as ended (Polar's `ended_at`, or now)       | Free                                                                                                                                                             |

#### The grace days

- They stretch a period that ran out (a renewal that is late while Polar retries), not a payment that has lapsed.
- That matches the terms ("If payment still fails, the plan ends and your allowance returns to the free tier").
- From the person's side, an `unpaid` plan has ended, though Polar may still take the payment.

#### Nothing is deleted

- Nothing is deleted when storage drops to Free.
- Someone over it can still read, download and delete everything.
- Uploads, and anything else that adds to the space, are refused until they make room, pay or choose a plan.
- Trash and earlier versions are purged after 30 days whatever the plan, as always. The storage-full dialog removes them only on a click.

#### A new checkout revokes a lapsed plan first

Why: Polar's portal can retry what is owed when a card is added (it does for `past_due`), and a paused plan resumes on its date. Leaving one beside a new plan could charge for both.

Before a checkout, HushOS reads each `unpaid`, `incomplete` or `paused` personal plan at Polar:

- One Polar shows live again (paid in the portal a moment ago) is the current plan. The choice switches it in place, prorated.
- Otherwise, it records the ending and the orders already paid, then reads the plan again. One paid in between is kept and switched in place, never revoked with that payment counted as used.
- Then it revokes it.
- Gone at Polar (404), or already ended, is nothing to do.
- A family ending its owner left before it was revoked is dropped and taken over.

The billing page asks first: "Choose Max? 1 TB for $15 a month. This ends Pro, whose payment didn't go through, then opens Polar's checkout". It asks even when the person arrives from the pricing page, or from a plan chosen at sign-up.

When the revoke doesn't go through:

- A refusal Polar answers (a 4xx: 403 without an end, 409 `SubscriptionLocked`) refuses the checkout and leaves the plan its owner's.
- A locked plan says "Polar is still working on a change to your Pro plan, so it can’t be ended yet. Try again later, or contact support." and logs `A lapsed personal plan could not be revoked: Polar says it is locked` at error level.
- A 5xx or no answer at all (a timeout) also refuses the checkout, but keeps the ending, since the revoke may have landed. The plan-ending job reads Polar before refunding anything.
- A checkout while the plan-ending job holds the plan's ending is refused ("still being ended"), so the two never work it at once.

An unpaid or incomplete plan whose current period already has a paid order not refunded whole is never revoked. That is a payment Polar hasn't applied to its status yet.

- This assumes Polar starts a new period when a renewal fails. That is not yet confirmed in the sandbox.
- The checkout says "Polar shows a payment for your Pro plan that hasn’t taken effect yet, so it can’t be ended. Try again in a few minutes, or contact support."

Nothing paid for is still in force:

- Polar pauses a plan only at the end of a period, which was used in full.
- A resume (on its date, or by hand) starts a new period and charges for it at once (Polar's Managing subscriptions page).
- An unpaid plan's renewal, and an incomplete plan's first payment, were never paid.

#### A payment taken after HushOS revoked a lapsed plan is refunded whole

- The ending is written before Polar is asked (`personal_plan_endings.group_id` null, settled), with every order already paid noted `none`.
- An `order.paid` for an order of that plan that wasn't paid then (paid in the portal, or a dunning email answered) is noted, and the ending opened again, in one transaction.
- The worker's `billing.end-personal-plan` job then decides.

If Polar shows the plan ended (gone at Polar, 404, counts as ended):

- The order is refunded whole, before tax. Polar refunds the tax.
- The comment is "Paid after HushOS ended this plan, which no longer runs".
- It is keyed and retried as every plan-ending refund is.
- After five failures in a row, it is logged at error level and listed under **Refunds owed**.

If it still runs, the revoke never landed and the payment restored a plan its owner kept:

- The ending is dropped. In the same transaction, its noted orders are settled `none` (no later lapsed ending of the plan refunds them) and marked `rewards_pending`.
- Their affiliate commission and the inviter's referral reward, which the delivery held back, are granted by the job after it refreshes the person's plans. If granting fails, the next run grants them (the daily reconcile queues it).
- The mark is apart from the refund's status, so a family ending that later refunds part of the order doesn't erase it.
- If its owner joins a family while the plan runs again under such an ending, the job drops it first. The family's ending then takes the plan over in the same run.

Edge cases:

- A redelivery of an order noted and never worked queues the job again.
- An ending isn't closed while a payment noted on it is still unworked. So one that lands while the job runs is refunded by its retry.
- A late delivery of an order already paid at the revoke (a paused plan's last period, used in full) is left alone, and earns its commission as usual.
- A part paid from the customer's balance isn't moved onto earlier card orders. It is listed under **Not refundable through Polar**.

#### Someone whose files join a family's pool

- Their lapsed personal plan is revoked by the same job, with nothing refunded, for the same reason: nothing paid for is still in force.
- It is recorded the same way, so a payment taken for it afterwards is refunded whole.
- A paused plan left alone would resume on its date and charge, only to be refunded with Polar keeping its fee.
- An ending its owner's leaving dropped, or an earlier lapsed one whose revoke never landed, is taken over.
- A lapsed plan Polar won't revoke (locked, an outage) is logged and retried, without holding back the person's other endings.
- The family screens say so before they pay or are let in: "Your Pro plan, whose payment didn't go through, ends when the family's plan starts. Nothing is refunded: no part of it is in use."

#### Plans not revoked

- A lapsed plan whose owner never starts another checkout, isn't pooled and doesn't delete their account stays at Polar until Polar ends it.
- It gives nothing meanwhile.
- It comes back if its owner pays in the portal or resumes it, or, for a paused plan, when Polar resumes it on its date. Polar then charges for a new period, and the reconcile gives its storage again.

#### Untested at Polar

- Whether its portal takes a payment for an `unpaid` plan (as it does for `past_due`) is not documented, and the sandbox hasn't been tried. If it doesn't, choosing a plan is the way back.
- Polar's docs disagree on whether dunning ends in `unpaid` or `canceled`. Both are handled.
- **A plan change left unpaid.** If a mid-period upgrade's invoice is never paid and Polar then answers the whole plan as `unpaid`, the storage the person had paid for at the old tier stops at once too. Nothing of that period is refunded. Whether Polar ever does this for a change invoice is not known.

## PostgreSQL 18 upgrades

The bundled image is `postgres:18-alpine`, with a named `postgres18_data` volume mounted at `/var/lib/postgresql`.

- PostgreSQL 18 uses a versioned data directory under that mount.
- A PostgreSQL 17 data directory must not be mounted into PostgreSQL 18 and started as-is.

For an existing 17 installation:

1. Keep the old volume and take a logical `pg_dump`/`pg_dumpall` backup.
2. Restore into a fresh PostgreSQL 18 volume and verify accounts/data.
3. Point the application at it and run the checked-in migrations.

Alternatively, use a planned `pg_upgrade` procedure for your deployment.

- Retain the old volume and verified backup until the upgrade is accepted.
- `docker compose down --volumes` is not an upgrade procedure.

## Drive object storage

Drive keeps file bytes in an S3-compatible bucket and the folder tree in PostgreSQL. The store only ever holds ciphertext, under keys named by workspace and object id.

Browsers upload to and download from the bucket directly, through presigned URLs. So:

- the bucket's endpoint must be reachable from every browser, not only from the containers;
- it needs a CORS rule allowing `PUT` and `GET` (with the `Range` header) from `APP_ORIGIN` and exposing `ETag`.

### The download service worker

- Downloads are decrypted in the browser and streamed to disk through a service worker. The app registers it from `/download-sw.js` with scope `/hushos-download/`.
- Audio and video previews play through the same worker.
- Both paths are static files served by the web container.
- A reverse proxy in front of it must pass them through unchanged: same origin, `text/javascript` content type, no caching that outlives a deploy. Otherwise browsers fall back to holding each download in memory.

### Storage settings

| Variable                                                                                                                                                                                 | Purpose                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STORAGE_INTERNAL_ENDPOINT`                                                                                                                                                              | Optional. Where the web and worker services reach the store when that differs from the browser's URL: `http://garage:3900` for the bundled Garage inside Compose. Presigned URLs keep `STORAGE_ENDPOINT`. |
| `STORAGE_ENDPOINT`                                                                                                                                                                       | Public S3 endpoint URL the browser can reach                                                                                                                                                              |
| `STORAGE_REGION`                                                                                                                                                                         | Region the endpoint expects (`auto` for R2, `us-east-1` for the bundled Garage)                                                                                                                           |
| `STORAGE_BUCKET`                                                                                                                                                                         | One bucket per instance                                                                                                                                                                                   |
| `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`                                                                                                                                     | Credentials scoped to that bucket                                                                                                                                                                         |
| `STORAGE_FORCE_PATH_STYLE`                                                                                                                                                               | `true` for Garage and most self-hosted stores, `false` for R2, B2 and S3                                                                                                                                  |
| `DRIVE_MAX_FILE_BYTES`                                                                                                                                                                   | Per-file upload limit; default 32 GiB, ceiling just under 80 GiB                                                                                                                                          |
| `DRIVE_CLIENT_MINIMUMS`                                                                                                                                                                  | Optional. The oldest client version the Drive API still serves, per client name, as product versions. See [Client minimums](#client-minimums).                                                            |
| `STORAGE_REPLICA_ENDPOINT`, `STORAGE_REPLICA_REGION`, `STORAGE_REPLICA_BUCKET`, `STORAGE_REPLICA_ACCESS_KEY_ID`, `STORAGE_REPLICA_SECRET_ACCESS_KEY`, `STORAGE_REPLICA_FORCE_PATH_STYLE` | Optional second bucket the worker copies every object to; set all or none. Only the worker receives these settings                                                                                        |
| `STORAGE_COLD_CLASS`                                                                                                                                                                     | Optional. The provider's infrequent-access storage class as the S3 API spells it (`STANDARD_IA` on R2 and AWS). Worker only. See [Cold storage](#cold-storage).                                           |
| `DRIVE_ORPHAN_SWEEP_PAUSED_UNTIL`                                                                                                                                                        | Optional ISO timestamp. Until then the worker skips the orphan sweep. Worker only. See [After restoring the database](#after-restoring-the-database-from-a-backup).                                       |

#### Client minimums

- Format: `web/1.0.0,ios/1.0.0,android/1.0.0`.
- Every Drive request carries `HushOS-Client: name/version`.
- A client below its minimum is refused with 426 and told to update. The web app tells the person to reload.
- Clients from before 1.0.0 sent a protocol number (`ios/3`). They count as older than any product-version minimum.
- Clients with no entry are served whatever their version.
- Whole-number minimums written before 1.0.0 (`web/3`) still work as they did for those old clients, and every product-version client passes them. The server logs a deprecation warning at startup: replace them with product versions.

#### Cold storage

- With `STORAGE_COLD_CLASS` set, the worker moves objects nobody has read for 90 days to that class nightly.
- It moves them back to `STANDARD` once read again.
- Leave it unset on Garage and B2, which have one class.

### The bundled Garage

The `garage` service runs a single [Garage](https://garagehq.deuxfleurs.fr/) node from `scripts/garage.toml`.

- It keeps one copy of each object, written with fsync, in the `garage_meta` and `garage_data` volumes.
- Its S3 API listens on `127.0.0.1:9000`. Change the host port with `STORAGE_PORT`.
- Its RPC and admin ports are not published.

On every start, `garage-init` (`scripts/garage-init.ts`):

1. assigns the node's layout the first time;
2. imports the access key from `STORAGE_ACCESS_KEY_ID` and `STORAGE_SECRET_ACCESS_KEY`;
3. creates `STORAGE_BUCKET`;
4. allows browser requests from `APP_ORIGIN`;
5. adds the rule that aborts incomplete multipart uploads after 3 days.

#### Keys

- Garage wants a key identifier of at least 8 characters.
- It cannot change a key's secret or reuse a deleted identifier.
- To rotate the secret, set a new `STORAGE_ACCESS_KEY_ID` with it. The old key stays until you delete it:

```sh
docker compose exec garage /garage key delete --yes <old id>
```

#### Behind a public hostname

1. Route a second hostname, such as `https://storage.hushos.example.com`, to `127.0.0.1:9000`.
2. Set `STORAGE_ENDPOINT` to that URL.
3. The web and worker services reach it inside Compose through `STORAGE_INTERNAL_ENDPOINT=http://garage:3900`, while presigned URLs carry the public one.
4. `STORAGE_REGION` stays `us-east-1`, the region `scripts/garage.toml` names.

#### Backups and upgrades

- One node on one disk is not a backup. Configure the replica bucket, or back up both Garage volumes with the database.
- `compose.yaml` pins the Garage release (v2.5.0).
- Garage does not support downgrades from v2.5.0. A node that has run it must not go back to v2.4 or older.
- So back up both Garage volumes before you pull a `compose.yaml` that moves the pin. Keep the backup until the new release has run cleanly.

Any hosted S3-compatible bucket works instead. Point the `STORAGE_*` settings at it and drop the `garage` services from your Compose command.

### After restoring the database from a backup

Objects the restored database no longer knows about must not be deleted before the object audit has listed what is missing.

1. Set `DRIVE_ORPHAN_SWEEP_PAUSED_UNTIL` on the worker before starting it, to at least the backup's age plus a day.
2. Let the nightly object audit run, or trigger it by restarting the worker, which runs every job once at start.
3. Read its events for objects marked `missing`, and recover those from the replica.
4. Only then let the pause lapse.

### Cleanup at the store

Cleanup is the application's job. Nothing at the bucket should expire objects on its own.

- The worker aborts abandoned multipart uploads and deletes objects through an outbox.
- With a replica configured, a published object's primary copy is deleted only once the replica holds it. The replica copy goes 30 days later, which is the window for undoing a bad purge.
- A lifecycle rule that aborts incomplete multipart uploads after 3 days is the second layer. `garage-init` sets it on the bundled Garage. On R2, B2 and S3, add it in the provider's console.

## Groups

Families (groups of accounts that share family folders, docs/groups-design.md) are on by default on the web and in both phone apps.

Upgrading from a release where families defaulted off? See [Families on by default](#families-on-by-default).

### Storage without billing

With `BILLING_PROVIDER=none`, nothing is pooled:

- A family folder's storage is its own allowance (`GROUP_AREA_QUOTA_BYTES`), drawn from nobody's plan.
- So every family folder is free storage, bounded only by the limits below.
- Each member's own files keep their own allowance (`INITIAL_STORAGE_QUOTA_BYTES` and any grants).
- There is no setting for one pool per family without Polar.

### Storage with billing

- With Polar billing, a family's folders and its members' own files share its plan's pool.
- Its seats come from the plan (see [Family plans](#family-plans)).
- No setting was added for the shared pool. `GROUP_SEAT_LIMIT_DEFAULT`, `GROUP_AREA_QUOTA_BYTES` and `GROUP_AREA_LIMIT` mean what they did.

### Group settings

| Setting                       | Purpose                                                                                                                                              |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GROUPS_ENABLED`              | Default `true`. Set `false` to hide families. See [Turning families off](#turning-families-off).                                                     |
| `GROUP_SEAT_LIMIT_DEFAULT`    | Active members a group may have, its creator included; default `6`, at most `10000`. Ignored with `BILLING_PROVIDER=polar`.                          |
| `GROUP_AREA_QUOTA_BYTES`      | The allowance each new group area starts with; default `10737418240` (10 GiB). Ignored with `BILLING_PROVIDER=polar`.                                |
| `GROUP_AREA_LIMIT`            | Areas a group may have; default `10`, at most `50`. A higher value stops the server at startup.                                                      |
| `GROUP_OWNED_LIMIT`           | Live groups one account may create and still belongs to; default `3`. For company groups, which are not available yet.                               |
| `GROUP_WRITE_CLIENT_MINIMUMS` | Optional, same format as `DRIVE_CLIENT_MINIMUMS`. The oldest client the family-changing routes serve. See [Family-write rules](#family-write-rules). |

#### Turning families off

With `GROUPS_ENABLED=false`:

- The group and invitation routes answer 501.
- `/api/drive/spaces` lists only the personal space.
- `/api/drive/capabilities` tells clients families are off, so the web shows none.

hushos.com sets it `true`, with paid family plans.

A deployment that turns it off keeps existing family data, but does not stop serving all of it:

- Drive's own routes (listing, download, upload, rename, trash) still answer an active member who names a family folder by its id. No HushOS client does that with the switch off.
- The worker keeps purging, sweeping and expiring invitations there.
- Turning it back on serves the families as they were.

#### Seats and areas

`GROUP_SEAT_LIMIT_DEFAULT`:

- Seats are counted when someone is admitted, never when they are invited.
- A lower limit never removes anyone.
- With `BILLING_PROVIDER=polar`, a family has the places its plan bought, or only its organizer without one.

`GROUP_AREA_QUOTA_BYTES`:

- An area's storage is its own, and is not drawn from any member's allowance.
- With `BILLING_PROVIDER=polar`, a family's areas share its plan's pool instead (see [Family plans](#family-plans)).

`GROUP_AREA_LIMIT` and `GROUP_OWNED_LIMIT`:

- A group they handed on and left no longer counts toward `GROUP_OWNED_LIMIT`.
- An account is in one family at most, whatever `GROUP_OWNED_LIMIT` says (see [One family per account](#one-family-per-account)).
- So without billing, one account can hand itself one family's areas: by default 10 × 10 GiB. With Polar billing, a family's areas draw on its plan's pool instead.
- Each area also adds about 2.7 MiB to the largest request body a group's managers may send, since a roster carries every area's workspace documents again.
- That is about 35 MiB at the default and about 141 MiB at the maximum of 50, which is why the maximum is 50.

#### Family-write rules

`GROUP_WRITE_CLIENT_MINIMUMS`:

- covers letting people in, roles, removals, family folders, key seals and successions;
- does not floor reads, invitations, accepting, leaving and joining;
- the floor is the higher of this and `DRIVE_CLIENT_MINIMUMS`, so it can only raise it;
- it doesn't change the built-in family-write number web tabs are held to.

Servers that run families refuse family changes from web tabs that follow older family-write rules. They answer 426 and "Update HushOS to do this. Reload the page to get the latest version."

- A tab opened before an upgrade that changed those rules keeps opening files and sharing until it reloads. It can't let anyone in or change roles (docs/optional-verification.md 7.3).
- The web sends the rules it follows as a number in the `HushOS-Group-Write` header. It is bumped only when they change (`GROUP_WRITE_PROTOCOL` in `packages/groups/src/protocol.ts`).
- So an upgrade that leaves them alone refuses no open tab, whatever the release version says.
- A tab that sends no number counts as old. Phones aren't asked for it.
- The number is built in and needs nothing set. Raise `GROUP_WRITE_CLIENT_MINIMUMS` to hold back particular client versions as well.

### One family per account

An account is in one family at most, with billing or without it (docs/families-shared-pool.md).

- Creating a family while in one, accepting an invitation to another, and being let into another are refused (`409 in-family`).
- The database holds the rule with a unique index on active family memberships.
- Accepting an invitation is refused too, not only being let in. So the other family's managers never see someone who is in a family waiting to join.
- Someone may still be in any number of company groups when those exist.

Upgrading to the release with this rule needs a check first. See [One-family release](#one-family-release-20261018222928_one_family).

### Dissolved families

A family is dissolved when its last active member leaves or deletes their account.

1. Its folders are retired at once, as deleting a family folder retires one.
2. Nothing can reopen the family. Invitations, acceptances and every change to it are refused, and no member sees it.
3. 30 days later, the Purge job deletes the folders with their files, versions and key changes. Their stored objects go through the deletion outbox. With a replica, the replica copy goes 30 days after the primary one.
4. Then the `groups.purge-dissolved` job (hourly) deletes the family's records: memberships, signed member lists, key changes, invitations and its storage pool. The keys sealed to members already went when each of them left.

Members' own files are never touched, including files they moved out of the family folders.

#### Who is emailed

- The last member: the day on or after which the folders are deleted. That day is in UTC. The purge runs every fifteen minutes, and a report holding a folder delays it further.
- Everyone who had accepted and was not let in, or held an invitation still open: that the family no longer exists. Dissolving ends those acceptances and revokes those invitations.
- When the last member deleted their account, only the people still joining are emailed.
- Nobody else is emailed by it (the payer has the plan-ending email), and nobody at all with `GROUPS_ENABLED=false`.

How sending works:

- The rows are written in the dissolving transaction, and each email is claimed before it is sent. So a refused leave emails nobody, and two runs never both send one.
- A send that fails is tried again 15 minutes later, behind the others, so addresses that always fail never hold up the rest. Failing includes the provider being down, or its reply lost to a timeout (the person may then get the email twice).
- A run stops after three failures.
- A worker that crashes between the claim and the send loses that email.

#### What holds the purge

- **A report holds a folder, and the family's records with it.** While an open or held report names a folder, that folder stays, and so does the family's row. Both go on the first runs after the report is released.
- **A plan that can still charge holds the records, not the files**, with billing on. That is any subscription of the family not ended, `canceled` or `incomplete_expired`. The folders still go after 30 days. The family's row waits until the plan has ended.

#### Dissolving a family ends its plan at the period's end

- The worker's `billing.cancel-dissolved` job sets every plan of a dissolved family that can still charge, and isn't already ending, to cancel at its period's end (`cancel_at_period_end`).
- It emails the payer the date.
- Nothing is revoked or refunded. The payer keeps what they paid for until then, as when they cancel the plan themselves.
- Leaving queues the job at once. Every reconcile queues it too. So a family dissolved by its last member deleting their account, or a missed delivery, is caught by the daily reconcile at the latest.
- The job reads Polar first, sets each plan under the same per-plan claim raises take, and reads it again under the claim. So retries, deliveries and two workers never set it twice or mail twice.
- A failure at Polar is retried ten times, backing off from a minute to six hours.
- The mail goes once the plan shows as ending. A set whose answer was lost (a timeout) is mailed by the retry.
- A mail that failed (the worker has no email settings, the provider was down) is sent by the next run, which every reconcile queues while the mail is owed.

**A payer who resumes it** in Polar's portal has it set to end again on the next delivery, every time. A payer who is no longer a member can still open the portal. A resume is the payer's own click, so this never loops. They are emailed at most once per plan per period.

#### When Polar refuses to end it

A 403 `InactiveSubscription` refusal (Polar won't change a plan that isn't active, such as one past due) is handled like this. (An unpaid, incomplete or paused plan is never sent; see below.)

- It is not retried.
- It is logged as `Polar refused to end a dissolved family’s plan: cancel it in Polar` at error level.
- The plan is listed on the management page until it is set to end.
- Neither the job nor any reconcile asks Polar again until the plan's status, period or ending changes.
- Cancel it in Polar.

Every other error is retried with backoff:

- 409 `SubscriptionLocked` (an update pending, as during a renewal);
- a token error (401, or any 403 other than `InactiveSubscription`);
- 402, 422, 429, a 5xx and a timeout.

A job that fails all ten tries is queued again by the next reconcile.

A failure Polar keeps repeating (a token without `subscriptions:write`, or a revoked one) would leave the plan renewing.

- So the first failed run is recorded (`dissolve_failing_since`).
- A plan no reconcile has seen ending a day later is listed on the management page as failing. So is one that renews within two days, at once.
- Fix the token or cancel it in Polar. The row goes once a reconcile sees the plan ending.

#### A paused, unpaid or incomplete plan

That is a plan paused in Polar's portal, one whose payment retries ran out, or one whose first payment never went through.

- It counts as one that can still charge.
- The reconcile keeps it with Polar's status and reads it again each time. It records it as ended only once Polar ends it (`ended_at`, or `canceled` or `incomplete_expired`), or no longer has it.
- It gives the family no storage and no extra places.

Polar sets only an active plan to end. Left alone, such a plan resumes, or is paid for a family that is gone. So the `billing.cancel-dissolved` job revokes it, as a family checkout revokes a lapsed plan (see [A family plan whose payment failed, or that is paused](#a-family-plan-whose-payment-failed-or-that-is-paused)):

- Its ending is written first, keyed by the family's id, so a payment Polar takes afterwards is refunded whole.
- An `incomplete` plan less than a day old (a first checkout still waiting on the bank) is left for a day, and asked about again by the next reconcile.
- Nothing paid for it is still in force.
- A revoke Polar refuses (a 4xx, or a period it shows paid while the plan is unpaid) is recorded. It is logged as `Dissolved family’s lapsed plan couldn’t be revoked: revoke it in Polar` at error level, and listed on the management page as not active until it has ended. The purge waits for the end.
- An outage, or the plan-ending job holding the plan, is retried.
- A scheduled change HushOS gave up on is listed only while its plan is live.

#### Plans an earlier release recorded as ended while unpaid or incomplete

- An earlier release's reconcile ended them, and they are not read again. So a payment taken after that renews for a family that may be gone.
- The query below lists them (`swept_unpaid`).
- Since this release, a new match is one Polar no longer has, which needs nothing. An older one may be a plan Polar still holds.
- Check it in Polar, or have the next reconcile read it again:

```sql
update group_billing_subscriptions set ended_at = null where id = '<subscription id>'
```

The reconcile then records what Polar answers (ended, or kept), and ends it again if Polar no longer has it.

#### A deleted family's plan that Polar bills again

That is a plan reinstated or resumed after it ended, after the purge deleted the family. It is revoked: nothing it charges for exists.

How it is found:

- Every delivery for the family's customer. It also reads the subscription the delivery names (`data.id` of a `subscription.*`, `data.subscription_id` of an `order.*`) whatever its status, and lists the customer's subscriptions at Polar once.
- The daily reconcile, which already reads every family customer HushOS made, deleted ones included. This costs one customer-state read a deleted family a day, and nothing more unless that state lists a plan or HushOS is still ending one.
- The daily read sees only `active` and `trialing` plans. A plan reinstated straight into `past_due` or `unpaid` is found by its own deliveries, and by the daily run only once it is active.

What HushOS does:

1. Writes the plan to the mirror.
2. Logs `A deleted family’s plan is billing again: revoked, and what it took refunded` at error level.
3. Works it as a lapsed plan's revoke (see [When a personal plan's payment fails, or it is paused](#when-a-personal-plans-payment-fails-or-it-is-paused)), keyed by the family's id: the ending first, under the plan-ending lease, then the plan's orders, then the revoke.

Which orders are refunded:

- Every order made (by its `created_at`) at or after the cutoff, whenever it is paid, is refunded whole. The `billing.end-personal-plan` job does it, run for the family's id, once Polar shows the plan ended, with the usual retries and **Refunds owed**.
- The cutoff is `personal_plan_endings.paid_after`, written once with the ending, from `group_billing_subscriptions.served_until`.
- `served_until` is the end of the last period in which it was the family's plan while active or trialing, or its own end if earlier. A past-due or unpaid period gave nothing and never counts.
- For a plan that never served the family, the cutoff is the epoch, since HushOS gave nothing for it.
- Earlier orders paid for time the family had, and are never refunded, even when paid late. One an earlier ending already owes a refund for stays owed.
- The cutoff is read only from `served_until`, which nothing on this path writes. So a run that fails midway (Polar's order list unavailable) and is retried computes the same one.
- A plan HushOS had already revoked, that Polar reinstates, charges and ends again between two reads, is guarded by each charge's own `order.paid` delivery. That delivery notes it on that ending for the job to refund.
- It is refunded automatically because a payment on it buys nothing: the family, its folders and its pool are gone.
- An order to be refunded earns no commission. Its `order.paid` delivery reconciles the family first, which notes the order on the ending before the delivery decides rewards.

When the revoke doesn't go through:

- A revoke Polar refuses or doesn't answer is logged and never given up.
- The job revokes it before refunding anything, and the next delivery or daily reconcile asks again.
- Once Polar shows the plan ended (or no longer has it), the end is recorded from Polar's `ended_at`. So an ending whose revoke answer was lost stops being read.

A `group:` customer HushOS never made (made by hand in Polar) is logged, never revoked.

The management page lists these under **Deleted families billed** while one still bills, while its refunds are made, and for 30 days after.

#### With billing off

With `BILLING_PROVIDER=none`, a dissolved family is purged by the same rule:

- It waits while the mirror holds a plan of it that can still charge: not ended, not `canceled` or `incomplete_expired`, and not set to end with its period over.
- It goes once its plans have all ended. So a family dissolved with billing on, whose plan was set to end and ran out after billing was turned off, is purged.
- With billing off, nothing reads Polar, so the mirror's last word stands.
- A family whose plan was still running when billing was turned off waits until billing comes back on, or until an operator who has checked it in Polar records its end.

#### Staging copies

**Never run a copy of the production database against the production Polar organisation.** For example, a staging server restored from a backup, with the production `POLAR_ACCESS_TOKEN`.

- Billing acts on every customer the database names. Since this release, that includes revoking plans and refunding payments.
- Give a staging copy a sandbox token, or `BILLING_PROVIDER=none`.

#### Kept after the purge

- The family's billing records, by the family's ID, for accounting: its Polar customer and subscriptions, and any personal plan ended because someone joined it, with its refunds.
- Reports and their snapshots.
- The deletion outbox's rows.
- The area key commitments its member lists named (32-byte digests and the family's ID), so no folder key it used is ever another family's.

A purged family's ID stays taken:

- Creating a family under it is refused while any of those commitments or billing records name it.
- A family whose member lists named no folder key, and that never had a billing record, leaves nothing that names its ID. Its creator could make a new, empty family under it again.
- Every family the apps make names one.

#### Finding what is waiting

- **Families dissolved before the dissolved families release** get 30 days from the upgrade. See [Dissolved families release](#dissolved-families-release-20261020151204_group_billing_no_group_fk).
- The job takes an advisory lock per family, so a run started while another is working skips that family.

To find what is waiting, and why:

```sql
select g.id, g.dissolved_at,
    (select count(*) from workspaces w where w.group_id = g.id) as folders_left,
    exists (select 1 from drive_reports r join workspaces w on w.id = r.workspace_id
            where w.group_id = g.id and (r.status = 'open' or r.held_at is not null)) as report_hold,
    -- With billing on or off: a plan the mirror holds as able to charge keeps the family.
    exists (select 1 from group_billing_subscriptions b
            where b.group_id = g.id and b.ended_at is null and b.status not in ('canceled', 'incomplete_expired')
              and not (b.cancel_at_period_end and b.current_period_end < now())) as plan_live,
    exists (select 1 from group_billing_subscriptions b
            where b.group_id = g.id and b.ended_at is null and b.dissolve_refused_at is not null
              and not b.cancel_at_period_end) as refused_at_polar,
    exists (select 1 from group_billing_subscriptions b
            where b.group_id = g.id and b.ended_at is null
              and (b.dissolve_failing_since < now() - interval '1 day'
                   or (b.dissolve_failing_since is not null
                       and b.current_period_end < now() + interval '2 days'))) as failing_at_polar,
    exists (select 1 from group_billing_subscriptions b
            where b.group_id = g.id and b.ended_at is not null
              and b.status in ('unpaid', 'incomplete')) as swept_unpaid
from groups g
where g.dissolved_at is not null
order by g.dissolved_at;
```

What the server stores for a group, and what it can and cannot read, is in `docs/groups-server.md`.

## Logs and storage allowances

### Logs

Nitro emits one evlog completion event for each request, including pre-parser auth rejections.

- Production output (`NODE_ENV=production`, which the images and `bun run start` set) is JSON. Development output is readable text.
- Redaction is enabled in both environments, with an auth-specific field allowlist.
- Logs contain request IDs, routes, status, duration, and operation outcomes.
- They exclude auth bodies, cookies, keys, passwords, recovery phrases, every field named for an envelope or a signature, the settings key, link tokens, and raw protocol/provider/database errors.
- No external drain is configured.

### Allowances

- A personal workspace and initial quota are created in the signup transaction.
- Quota counts use PostgreSQL bigint and serialize as decimal strings.
- Extra entitlements are separate, expiring/revocable records, keyed by what granted them: a billing subscription, a referral, or an operator.
- Changing the initial-quota environment variable affects new accounts only.

Operator grants:

- An operator adds storage from an account's page under Management: Add storage, an amount up to 100 TB, optionally an end date and a note.
- It counts at once, and is listed with the account's other grants with who added it.
- It is logged as `storage-granted` with the operator's and the account's ids.
- Only these grants can be revoked there (`storage-revoked`). A plan's or an invite bonus's ends through its own system.
- Revoking never deletes files. While they take more than the allowance, uploads are refused.

### Enforcement

Drive's folder tree is live: folders, names and moves are encrypted end to end, and every write is serialised per workspace. Upload enforcement lands with uploads:

- ciphertext bytes are reserved atomically before upload URLs are issued;
- object sizes are verified at completion;
- retained trash and versions count against the allowance;
- usage is released only after object deletion.

## Upgrading from older versions

Read the release notes of every version you move past first (see [On the published images](#on-the-published-images)). The notes below cover changes that still matter if you run an older version.

### Separate API service

From a deployment that still runs a separate API service:

- Remove the old API service and its separate hostname routing.
- `--remove-orphans` removes the old service container while preserving database volumes.
- Remove unused `WEB_ORIGIN`, `VITE_API_URL`, and `API_INTERNAL_URL` settings.
- Deploy matching versions of the web, worker, and migration images.

### Families on by default

**Upgrading to the families release changes behaviour.**

- `GROUPS_ENABLED` used to default to `false`, and now defaults to `true`.
- A deployment that never set it starts offering families to every account once the new web containers are up.
- To keep families off, set `GROUPS_ENABLED=false` before upgrading.

### Release migration notes

Common to most of these:

- Drizzle applies all pending migrations in one transaction. Locks are held until it commits.
- A migration waits at most five seconds for each lock (`lock_timeout`), and fails rather than queue requests behind it. Run it again.
- "Containers of the previous release" means old containers still running beside new ones during a rolling update.
- With a split-role setup, the default privileges under [One role per process](#one-role-per-process) cover new tables.

#### Devices release (`20261016013230_devices`)

- Gives every live session a device, and adds `sessions.device_id` as nullable.
- Drizzle applies all pending migrations in one transaction. So `sessions` stays locked against every signed-in request from the moment the column is added until the run commits.
- On a table of a few thousand sessions, that is milliseconds. On millions, it is a short outage, so pick a quiet moment there.
- The migration waits at most five seconds for that lock (`lock_timeout`) and fails rather than queue requests behind it. Run it again.
- While old containers still run, a sign-in through one of them makes a session without a device. The new containers do not accept it: that person is asked to sign in again.
- A later release deletes sessions still without a device and makes the column `NOT NULL`. Take it only once no container of the previous release is left.

#### Groups release (`20261016032459_workspace_owners` through `20261016081643_group_tables`)

- Labels every workspace with its owner and adds the group tables.
- It first counts workspaces without a `personal_workspaces` row, with an ordinary read. It refuses to run if there are any, naming how many. Assign or delete those before migrating.
- It then takes an exclusive lock on `workspaces` until drizzle's single transaction commits. That blocks reads as well as writes of the table, and every Drive request touches it.
- The new columns are added without rewriting the table, and its checks without scanning it. But a unique index is built under that lock: seconds on a large instance, so pick a quiet moment.
- The group tables' foreign keys to `users` hold a lock on `users` until the same commit. That blocks sign-ups and account changes (not reads) meanwhile.
- It waits at most five seconds for the lock (`lock_timeout`) and fails rather than queue requests behind it. Run it again.
- Containers of the previous release keep signing people up meanwhile, since `owner_kind` defaults to `personal`. The next release drops that default and validates the checks.

#### Re-keyed records release (`20261017062152_rekeyed_origins`)

What it changes:

- Adds the origin and drop columns to `drive_nodes` and `file_versions`, the origin signers to `drive_report_items`, and the new table `drive_origin_drops`.
- Replaces the signature checks.
- The columns are nullable with no default, and every check on an existing table is added `NOT VALID`. So nothing is rewritten or scanned.
- A later release validates the six checks.

Locks:

- The `ALTER`s hold an exclusive lock on both Drive tables (every Drive request) until drizzle's single transaction commits: milliseconds.
- The new table is created first. Its foreign key locks `workspaces` against writes until then, so the migration takes `workspaces` before the Drive tables, as live writes do.
- It waits at most five seconds for each lock (`lock_timeout`) and fails rather than queue requests behind it. Run it again.

Before migrating, check that no row has a signer without a signature. The replaced checks refuse that on any later update of that row. This must answer 0 and 0 (it does on hushos.com):

```sql
select (select count(*) from drive_nodes where metadata_signature is null and metadata_signer is not null) as nodes, (select count(*) from file_versions where signature is null and signer is not null) as versions;
```

Who it affects:

- Origins are written only in family folders (behind `GROUPS_ENABLED`). Personal workspaces, and the shipped iOS and Android apps, see no change.
- Only with families on, while containers of the previous release still run beside the new ones:
    - Their purges and sweeps of re-keyed family rows fail the new origin checks: purging a node or a version, releasing an upload, purging a displaced version. They clear the envelope but not the origin. That fails closed, and the job or request is retried by a new container.
    - Their renames and rotations of re-keyed rows leave a stale origin. Readers show it as "couldn't confirm" (never as anyone's fault). The next honest rotation drops it for good (recorded as a drop).
- So roll quickly. Turn families on only after the server and web of this release are out (they deploy together).

#### Group billing release (`20261017121401_group_billing`)

- Adds three empty tables: `group_billing_customers`, `group_billing_subscriptions` and `group_storage`.
- Their foreign keys briefly lock `groups` and `users` against writes until the run commits (milliseconds; five-second lock timeout).
- Nothing changes for an instance without billing or groups.
- A family created before billing was turned on keeps its folders' free allowances (`GROUP_AREA_QUOTA_BYTES` each) until it buys a plan, which may be never. Turning billing on does not take them away.
- None exist on hushos.com, where groups have never been on.

#### Drop evidence release (`20261017153848_origin_drop_evidence`)

- Adds five nullable columns to `drive_origin_drops` (`previous_envelope`, `previous_key_epoch`, `node_kind`, `object_id`, `content_suite`), and a check added `NOT VALID`.
- Nothing is rewritten or scanned. The lock on that table (written only when a rotation drops an origin in a family folder) lasts milliseconds; five-second lock timeout.
- Rows recorded before it stay all null, and cannot be checked against the previous re-keyer's signature. Every drop after it records them.
- While containers of the previous release still run, a drop through one of them records a row without them, which the check allows. So with families on, roll quickly.
- None exist on hushos.com, where groups have never been on.
- A later release validates the check.

#### Family folder deletion release (`20261017170455_group_area_deletion`)

What it adds:

- `workspaces.deleted_at`, and a partial index on it.
- A check (`NOT VALID`) that only a group's area is ever deleted.
- The empty table `group_area_commitments`: every area and top-folder key commitment a stored roster lists, refused across groups. It has no foreign key, so it outlives a group.
- Rosters stored before this release are not backfilled, so their commitments are not guarded.

Locks and running it:

- The column is nullable with no default, so nothing is rewritten.
- The index starts empty. Building it reads `workspaces` once under the lock.
- It waits at most five seconds for each lock and fails rather than queue requests. Run it again.
- Deleted family folders are purged by the existing `drive.purge` job 30 days after deletion (Drive's trash retention). Nothing to configure.
- A later release validates the check.

#### One-family release (`20261018222928_one_family`)

What it adds (see [One family per account](#one-family-per-account)):

- `group_memberships.group_kind`, copied from each group;
- a unique constraint `groups_id_kind`;
- the composite foreign key `group_memberships_group_kind_fk`;
- the partial unique index `group_memberships_one_family_idx`.

It first counts accounts active in more than one family, since the previous release allowed it. If there are any, it stops and changes nothing. The new containers then fail their startup migration, and the previous ones keep serving.

Find those accounts on the release you run now:

```sql
select m.user_id, array_agg(g.name) as families
from group_memberships m
join groups g on g.id = m.group_id
where g.kind = 'family' and m.state = 'active'
group by m.user_id
having count(*) > 1;
```

Have each person listed leave every family but one (Leave family, on the family's page), then upgrade.

- The migration does not pick a family for them.
- The organizer, the payer and a family's last manager can't simply be marked as gone, because the family's signed member list depends on them. They hand those roles on first, as leaving asks.

Locks:

- Its `ALTER`s take an exclusive lock on `groups` and then `group_memberships`, and hold it until drizzle's single transaction commits.
- That blocks every read of either table meanwhile, Drive's access checks included: a family folder's authorization joins `group_memberships`. So every Drive request to a family folder waits.
- That is milliseconds on a small instance, and seconds on one with many memberships, since the backfill rewrites each row and the index is built under the lock.
- It waits at most five seconds for each lock (`lock_timeout`). A lock it can't get in time, or a deadlock with a live request, fails the migration with nothing applied. It is simply run again.

Containers of the previous release keep working beside the new ones:

- They insert memberships without the new column, which defaults to `family`, the only kind they can create. A later release drops the default.
- They don't know the rule. Through one of them, someone in a family can still accept another family's invitation; a new container then refuses letting them in.
- An admission or creation the index refuses there answers `invalid` instead of `in-family`.
- Nobody gets into two families either way.

To take the schema back by hand, in one transaction:

```sql
drop index group_memberships_one_family_idx; alter table group_memberships drop constraint group_memberships_group_kind_fk; alter table group_memberships drop column group_kind; alter table groups drop constraint groups_id_kind;
```

Then delete the `20261018222928_one_family` row from `drizzle.__drizzle_migrations`, and run the previous release's images only.

#### Invitation address index (`20261018235021_invitation_email_index`)

- Adds a partial index on the address of open invitations, for the list of invitations an account sees under Account → Family.
- Building it locks `group_invitations` against writes until the run commits: milliseconds, five-second lock timeout. Run it again if it times out.
- Containers of the previous release are unaffected.

#### Refund-disputed release (`20261019171449_refund_disputed`)

- Adds `disputed` to the status check on `personal_plan_refunds`.
- Re-adding the check scans that small table under its lock: milliseconds, five-second lock timeout.
- Containers of the previous release don't cascade, and treat a disputed refund as a failure.

#### Personal plan endings release (`20261019161551_personal_plan_endings`)

- Adds two empty tables, `personal_plan_endings` and `personal_plan_refunds`. The second's foreign key points at the first only.
- So nothing existing is locked, rewritten or scanned; five-second lock timeout.
- Containers of the previous release don't queue `billing.end-personal-plan`. The worker of this release creates the queue, and the daily reconcile catches any pooled member a previous container let in.
- With a split-role setup, the default privileges under [One role per process](#one-role-per-process) cover the new tables.

#### Family moves release (`20261019181225_drive_moves`)

- Adds six nullable `move_*` columns to `drive_uploads`.
- Adds a check that they are all set or all null (`NOT VALID`: nothing is rewritten or scanned; a later release validates it).
- Adds the partial unique index `drive_uploads_one_move_idx`, which holds no row yet. Building it reads `drive_uploads` once while the run holds its lock: milliseconds, five-second lock timeout.
- Moves exist only with families on (`GROUPS_ENABLED`).
- While containers of the previous release still run beside the new ones, a move begun on a new container and completed (or expired) on an old one publishes the copy without deleting the original. Both count, until the person deletes one.
- So roll quickly, and turn families on after the rollout.

#### Dissolved families release (`20261020151204_group_billing_no_group_fk`)

- Drops the foreign keys from `group_billing_customers` and `group_billing_subscriptions` to `groups`. So a family's billing records are kept, by its id, when the worker purges a family dissolved more than 30 days ago (see [Dissolved families](#dissolved-families)).
- Dropping them takes a brief lock on those tables and on `groups`: milliseconds, nothing scanned or rewritten, five-second lock timeout.

**Families dissolved before the upgrade get 30 days from the upgrade, not from when they were dissolved.**

- The migration retires their folders as of the upgrade, and sets their `dissolved_at` to the upgrade time.
- So nothing of theirs is deleted for 30 days after it, however long ago they were dissolved. The previous release's privacy policy said nothing deletes them.
- This runs whether or not families are on (`GROUPS_ENABLED`): the purge jobs are scheduled either way.
- To keep such a family's data past those 30 days, export or copy it first. There is no switch to turn the purge off.
- The migration updates only dissolved families' rows, under the same lock.

Containers of the previous release never delete a group, so they are unaffected. One that dissolves a family during the rollout leaves its folders live. The worker of this release retires them on its next hourly run, as of then.

#### Dissolved family plans release (`dissolve_cancels`)

- Adds six columns to `group_billing_subscriptions`:
    - `dissolve_cancels` (`integer not null default 0`, which Postgres adds without rewriting the table);
    - the nullable `dissolve_cancelled_at`, `dissolve_mailed_period_end`, `dissolve_refused_at`, `dissolve_refusal` and `dissolve_refused_state`.
- Its second migration (`dissolve_failing`) adds a nullable `dissolve_failing_since`.
- It also stops the reconcile from recording a paused family plan as ended.
- The lock on that small table lasts milliseconds; five-second lock timeout.
- Containers of the previous release don't queue `billing.cancel-dissolved`. The worker of this release creates the queue. Its first daily reconcile queues the job for every dissolved family whose plan can still charge.

#### Change numbers release (`20261020213416_change_seq_renumber`)

It changes no schema.

The problem it fixes:

- Before it, a batch of folders took one `change_seq` for the whole batch. Such batches come from `POST /api/drive/folders`, which only the create-folder dialog sends with more than one folder, for a path such as `one/two/three`.
- A change feed page that ended inside such a batch made every later pull skip the rest of it.
- New batches take one number per folder.

What the migration does:

- It gives every row that still shares a number a new one at the head of its workspace, parents first. It moves that workspace's counter up by as many.
- Devices that skipped those folders receive them again, and apply them like any change, without a rebuild.
- Only rows that still share a number move, so running it twice is harmless.

Locks:

- No table lock.
- The new numbers stay unique because every number comes from the workspace's counter (`nextChangeSeq`/`moreChangeSeqs`, under the `workspaces` row). The migration moves that counter past the numbers it hands out.
- It also locks, `FOR UPDATE` in id order, the `workspaces` rows of the workspaces that have a shared number. That only keeps those workspaces quiet.
- Writes that number nodes there wait until drizzle's single transaction commits: the time of two scans of `drive_nodes`' numbered rows, plus the update.
- Not every Drive write takes that row (an upload's first step inserts its node without a number), but none of those number a node. Reads, sign-ups and every other workspace carry on.
- It waits at most five seconds for a row and fails rather than queue requests behind it.
- A deadlock aborts it with nothing applied. Run it again. Deadlocks can come from the tombstone sweep (it deletes `drive_nodes` rows before updating `workspaces`), or a move between a family folder and a personal workspace (it locks the family folder's row first, not in id order).

Nothing breaks during a rolling update. Containers of the previous release keep giving a batch one number until they stop. The next release (which makes the index unique) renumbers those first.

Before migrating, run these read-only checks.

(1) What will move, and whether every shared number looks like a folder batch. `not_a_folder_batch` must be 0:

```sql
with g as (select workspace_id, change_seq, count(*) n, count(*) filter (where kind <> 'folder') non_folders, count(*) filter (where purged_at is not null) tombstones, count(distinct created_at) created_ats, count(distinct created_by) creators from drive_nodes where change_seq is not null group by 1,2 having count(*) > 1) select count(*) groups, coalesce(sum(n),0) rows_to_renumber, count(distinct workspace_id) workspaces, max(n) largest_group, (select max(c) from (select sum(n) c from g group by workspace_id) x) max_rows_one_workspace, count(*) filter (where non_folders > 0 or tombstones > 0 or created_ats > 1 or creators > 1) not_a_folder_batch from g;
```

(2) No node is numbered above its workspace's counter. Must be 0:

```sql
select count(*) from drive_nodes n join workspaces w on w.id = n.workspace_id where n.change_seq > w.change_seq;
```

(3) The table's size:

```sql
select reltuples::bigint rows, pg_size_pretty(pg_relation_size('drive_nodes')) heap, pg_size_pretty(pg_relation_size('drive_nodes_change_idx')) idx from pg_class where relname = 'drive_nodes';
```

Right before migrating, check there is no long transaction that would hold a lock past the five seconds:

```sql
select pid, state, now() - xact_start age, left(query, 80) from pg_stat_activity where xact_start < now() - interval '5 seconds';
```

#### Unique change numbers release (`20261020214235_change_seq_unique`)

It must follow the change numbers release (`20261020213416_change_seq_renumber`), and only once no container older than that release runs.

- An older container gives a batch of folders one number, which this release's index refuses.
- So its multi-folder creations (the create-folder dialog's `one/two/three` paths) would fail as a conflict.

What it does:

1. Renumbers, exactly as that release did, any rows that still share a number: the batches older containers wrote while it rolled out. Check with query (1) there.
2. Builds a unique index under a temporary name.
3. Drops `drive_nodes_change_idx`, and renames the new one in its place.

Locks, in the order live writes take them:

- The `workspaces` rows of workspaces that still have a shared number (`FOR UPDATE`; none if the previous release ran alone).
- Then `drive_nodes` in `SHARE` mode. Reads go on, and every Drive write waits while the rows move and the index is built: milliseconds on a small instance, seconds on a large one.
- The drop and rename then hold `drive_nodes` exclusively, reads included, until drizzle's single transaction commits: milliseconds.
- The drop first waits for every open read of `drive_nodes` to finish (share-feed polls, a `pg_dump`), while new reads queue behind it. So it waits at most one second. The other locks wait at most five.
- A lock not had in time, or a deadlock with a live write (the tombstone sweep, or a move between a family folder and a personal workspace), fails it with nothing applied. Run it again.
- If a number is still shared when the index is built, the build fails with nothing applied.

**Don't deploy it during the backup window.** A `pg_dump` holds its read of `drive_nodes` until it finishes, so the drop would time out on every attempt.

Before migrating, run checks (1) to (3) of the previous release again, and the long-transaction check right before.

To take the schema back by hand:

```sql
drop index drive_nodes_change_idx; create index drive_nodes_change_idx on drive_nodes (workspace_id, change_seq) where change_seq is not null;
```

Then delete the `20261020214235_change_seq_unique` row from `drizzle.__drizzle_migrations`.

#### One plan per family release (`20261026164003_family_one_checkout`)

What it adds:

- An empty table, `group_checkouts`, which takes no lock on any existing table.
- Nullable columns with no default:
    - on `affiliate_earnings`: `order_refunded_at`;
    - on `group_billing_subscriptions`: `superseded_at`, `superseded_by`, `superseded_paid_after`, `served_since`;
    - on `personal_plan_endings`: `orders_noted_at`, and `attempt` (NOT NULL with a constant default).
- Only the catalog changes. Then each family's current plan is given `served_since`: its current period's start, one row per family. So a plan Polar reinstates beside it before the first reconcile is not taken for the family's.

Locks:

- Each table's ACCESS EXCLUSIVE lock blocks its reads as well as its writes until drizzle's single transaction commits (milliseconds); five-second lock timeout.

Containers of the previous release neither read nor write `group_checkouts`.

- While they run, they don't refuse a second family checkout, and their live-plan read doesn't skip a superseded plan.
- Every reconcile on this release still keeps the family to one plan.
- With a split-role setup, the default privileges under [One role per process](#one-role-per-process) cover the new table.

The same release's `20261104093754_affiliate_withdrawn_orders` adds an empty table, `affiliate_withdrawn_orders`.

- It holds order ids HushOS refunded whole, so a late delivery never records commission on one.
- It takes no lock on any existing table.
- With a split-role setup, the default privileges cover it.

#### Unpaid family plans release (no migration)

- It stops the reconcile from recording a family plan Polar answers as `unpaid` or `incomplete` as ended.
- Plans an earlier release ended so stay ended until read again (see [Plans an earlier release recorded as ended while unpaid or incomplete](#plans-an-earlier-release-recorded-as-ended-while-unpaid-or-incomplete)).

#### Unpaid personal plans release (`20261021073123_personal_plan_lapsed`)

What it changes:

- Drops NOT NULL from `personal_plan_endings.group_id` (catalog only).
- Adds `personal_plan_refunds.rewards_pending` (`boolean not null default false`, no rewrite).
- A null group marks a lapsed plan HushOS revoked itself (see [When a personal plan's payment fails, or it is paused](#when-a-personal-plans-payment-fails-or-it-is-paused)).

Locks:

- Both run in one transaction, holding each table's ACCESS EXCLUSIVE lock until it commits: milliseconds. Both tables are small (empty on hushos.com on 2026-10-21); five-second lock timeout.
- Endings are locked before refunds. A refund insert landing at that instant takes them the other way round (its foreign key's check), so the two can deadlock.
- Postgres then aborts one, and running the migration again finishes it.

During the rollout:

- Containers of the previous release never write a null group.
- A worker of the previous release could run the plan-ending job for such an ending during the rollout (only once a payment arrives for a revoked plan). It would refund by its own rule, prorated over the period, not the order whole.
- So roll the worker together with the web service.

Behaviour:

- It stops the reconcile from recording a personal plan Polar answers as `unpaid`, `incomplete` or `paused` as ended.
- It keeps such a plan with Polar's status and reads it again on every reconcile. A checkout revokes it at Polar first.
- Storage is unchanged: such a plan gave nothing before and gives nothing now.
- Plans an earlier release ended so stay ended here. One Polar makes active again comes back through the customer's state on its next delivery, as before.

#### Dissolved family emails release (`20261104085718_group_dissolve_notices`)

- Adds one empty table, `group_dissolve_notices`.
- Its foreign keys briefly lock `groups`, `users` and `group_invitations` against writes until the run commits (milliseconds; five-second lock timeout).
- A family dissolved by a container of the previous release during the rollout owes no email, and closes nothing pending.
- One dissolved by this release before its worker runs waits for it (a week at most).
- Nothing is written with `GROUPS_ENABLED=false`.

#### Two-step sign-in tables release (`20261112160538_two_step`, `20261112174853_two_step_session_guard`)

This release adds the database side of two-step sign-in ([docs/two-step-design.md](two-step-design.md)) and nothing else. No route makes a second-step method yet, so nothing changes for anyone until a later release turns the feature on.

What the first migration adds:

- Five empty tables: `two_step_factors`, `two_step_backup_codes`, `two_step_attempts`, `two_step_state` and `account_security_events`.
- `sessions.two_step_at`, nullable with no default, and `account_devices.two_step_failures`, with a constant default. Neither rewrites its table.
- `two-step` among the purposes the check on `opaque_login_attempts` accepts.

What the second adds:

- A trigger on `sessions`, `sessions_two_step_guard`, the first trigger in the schema. It refuses a new session that did not pass the second step (`two_step_at` is null) for an account that has a confirmed method. It also refuses an `UPDATE` that hands such a session to that account or gives it a new token.
- It is there for rolling updates and rollbacks. A release from before two-step sign-in does not know the step, and would sign such an account in with the password alone. With the trigger, that sign-in fails instead: the older container answers 500. Its log carries only the error's code, `23514` (a check violation); Postgres's own log names `sessions_two_step_guard`.
- Accounts without a confirmed method are not affected, and neither are sessions that were open before an account turned the step on.
- It covers sign-in only. An older container still skips the step at a password change, a rotation and account deletion, which need a live session and the password. So finish a rollout before people turn the step on, and don't roll back past this release once they have.
- The trigger's function runs as the role that owns it, the one that migrates (`SECURITY DEFINER`, with a fixed `search_path`). So it reads `two_step_factors` whatever the application role was granted, and a split-role setup that missed a grant on the new table still signs people in. Nobody else may call it: `EXECUTE` is revoked from `PUBLIC`, which a trigger does not need.

Locks:

- The two `ALTER TABLE ... ADD COLUMN` take an exclusive lock on `account_devices` and then `sessions`, and hold it until drizzle's single transaction commits. Every signed-in request waits meanwhile: milliseconds, since no row is rewritten. The check on `two_step_failures` reads `account_devices` once under that lock.
- The new tables' foreign keys lock `users` and `account_devices` against writes, and the trigger locks `sessions` against writes, until the run commits.
- Replacing the check on `opaque_login_attempts` takes an exclusive lock on it and reads it once. Every sign-in and password confirmation that starts or finishes meanwhile waits: milliseconds, since the table holds only attempts of the last few minutes.
- Each lock waits at most five seconds (`lock_timeout`). A lock not had in time, or a deadlock with a live request, fails the migration with nothing applied. Run it again.

Containers of the previous release keep working beside the new ones: they never write the new columns, and no account has a method yet.

To take the schema back, run the two undo scripts that ship beside the migrations, as the role that migrates, in this order:

```bash
psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/db/drizzle/20261112174853_two_step_session_guard/undo.sql
psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/db/drizzle/20261112160538_two_step/undo.sql
```

- Each is one transaction, and removes its own row from `drizzle.__drizzle_migrations`. `ON_ERROR_STOP=1` makes `psql` stop and report the first error instead of running on.
- The first removes only the trigger. From then on an older container signs every account in with the password alone, whatever methods it has.
- The second drops the tables and columns. That deletes every account's methods, backup codes and security log, and so turns the second step off for everyone who had it. Take a backup first; nothing else brings them back.
- The second stops, changing nothing, in two cases:
    - while the trigger is still there;
    - while any account has a confirmed method, until you say the deletion is meant. It names how many accounts. To go ahead:

        ```bash
        PGOPTIONS="-c hushos.delete_two_step=yes" psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/db/drizzle/20261112160538_two_step/undo.sql
        ```

        A pooler may refuse startup options. Then set it in the same session instead:

        ```bash
        psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -c "set hushos.delete_two_step = 'yes'" -f packages/db/drizzle/20261112160538_two_step/undo.sql
        ```

        Either form needs a connection that keeps its session for the whole run: a direct one, as `MIGRATION_DATABASE_URL` is meant to be, or a pooler in session mode. Through a pooler in transaction mode the setting may not reach the script, which then refuses as if it were never given.

- It locks `two_step_factors` and `opaque_login_attempts` exclusively until it commits, so sign-ins wait for it: milliseconds. The first lock is taken before the accounts are counted, so no method can be confirmed between the count and the drop.
- Because it locks `two_step_factors` first, it can deadlock with a sign-in that is under way. Postgres then aborts one of the two. The script is one transaction, so it applies whole or not at all: stop the app first, or run it again.
- Then run the previous release's images only: this release's worker waits for the migrations and exits without them.
- `packages/db/src/two-step.migration.test.ts` runs both scripts against a migrated database and checks that the schema is exactly what it was before.
