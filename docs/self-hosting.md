# Self-hosting HushOS

The stack is four parts: a web service, a background worker, a migration job, and PostgreSQL. TanStack Start and Nitro host the UI and the Elysia API together.

What is implemented:

- Email-first OPAQUE authentication, client account-key wrapping, recovery, password changes, master/recovery-key rotation, remembered device access, and permanent deletion.
- Drive's encrypted folder tree, resumable uploads and streaming downloads, against the object store described under [Drive object storage](#drive-object-storage).

## Run the full stack locally

Install Docker with Compose 2.24.4+ (needed for the external-database override). Then:

```sh
git clone https://github.com/HushOS/HushOS
cd HushOS
cp .env.production.example .env
docker compose up -d --build
```

That is the whole first run. The template works as it is on `http://localhost:5173`:

- The bundled MinIO holds the files. The web service reaches it inside Compose; browsers reach it on `127.0.0.1:9000`.
- The OPAQUE server setup is made on first start and kept in the database.
- Email goes to the web container's log (`EMAIL_ADAPTER=log`); `docker compose logs web` shows each verification link.

Stop any host development server using port 5173 first, or set `PORT`.

### Before anyone else uses it

Edit `.env`:

1. Give `POSTGRES_PASSWORD` and `STORAGE_SECRET_ACCESS_KEY` real random values before the first start. They are baked into the database and MinIO volumes.
2. Set `APP_ORIGIN` and `STORAGE_ENDPOINT` to the public HTTPS origins your proxy serves.
3. Switch the mail adapter to `smtp`, `resend` or `ses`.

### What Compose starts

| Service      | Role                                                         |
| ------------ | ------------------------------------------------------------ |
| `db`         | PostgreSQL 18                                                |
| `minio`      | The object store for Drive                                   |
| `minio-init` | One-shot bucket bootstrap                                    |
| `migrate`    | One-shot job: waits for Postgres, runs `drizzle-kit migrate` |
| `web`        | UI and API                                                   |
| `worker`     | Background jobs                                              |

The migration job must complete before the app starts. It uses `packages/db/drizzle.config.ts` and the checked-in SQL migrations. `/api/health` checks the app process; `/api/ready` checks a real database query and is the container health check.

Open [http://localhost:5173/app](http://localhost:5173/app). API health is at [http://localhost:5173/api/health](http://localhost:5173/api/health). Compose publishes the app on `127.0.0.1:5173`; PostgreSQL stays inside the container network. The development override publishes PostgreSQL on port 5433 for host tools.

### Changing the port

Set `PORT=8080` in `.env`, or run `PORT=8080 docker compose up -d --build`, to publish a different host port. The container still listens on `5173`; update a host-based proxy's upstream port to match. Outside Docker, `PORT=8080 bun run start` changes the app's listening port directly.

### The images

- **Web.** Nitro v3 with the `bun` preset. `bun run build` produces the deployable `apps/web/.output` directory; `bun run start` runs its server entry on Bun. Nitro serves static assets, the TanStack Start SSR handler, and the mounted Elysia API. The image holds that `.output` directory and Bun, plus Node 24 and Drizzle Kit for optional startup migrations. Its entrypoint drops root privileges before starting the web process as `bun`.
- **Migrations.** `packages/db/Dockerfile` builds the migration image with Node 24, Bun, and Drizzle Kit. It runs as the unprivileged `node` user.
- **Worker.** A Bun base plus one bundled file, built from `packages/jobs/Dockerfile`. See [The worker](#the-worker).

## The worker

The worker runs background jobs with [pg-boss](https://pgboss.io), which keeps its queue in a `pgboss` schema inside the same database. Each job also runs once at start, so a backlog after downtime clears.

| Job                    | When                  | What it does                                                                                                                                                                                                                                                  |
| ---------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth cleanup           | Every five minutes    | Sweeps expired sessions, attempts and rate-limit rows                                                                                                                                                                                                         |
| Billing reconciliation | Daily                 | Re-reads every billing customer from the provider, when billing is enabled                                                                                                                                                                                    |
| Expire uploads         | Hourly                | Aborts uploads past their expiry; finishes ones that stalled while completing when the store holds the object                                                                                                                                                 |
| Deletion outbox        | Every five minutes    | Drains the object deletion outbox                                                                                                                                                                                                                             |
| Replication            | Every five minutes    | Copies every completed object to the replica bucket, when one is configured                                                                                                                                                                                   |
| Purge                  | Every fifteen minutes | Purges trash and superseded versions past 30 days; fans deletions out under purged folders; deletes tombstones past 90 days                                                                                                                                   |
| Accounting audit       | Nightly               | Logs any drift between `used_bytes` and the objects                                                                                                                                                                                                           |
| Object audit           | Nightly               | Confirms a page of objects at the store, least recently confirmed first. A lost one is marked `missing` so the app says the file is unavailable rather than failing to decrypt. With a replica, a primary copy the replica still holds is copied back instead |
| Replica audit          | Weekly                | Audits the replica the same way; a miss re-queues the copy                                                                                                                                                                                                    |
| Tiering                | Nightly               | A no-op unless `STORAGE_COLD_CLASS` is set                                                                                                                                                                                                                    |
| Evidence copies        | Every five minutes    | Copies reported objects to the evidence bucket, when one is configured                                                                                                                                                                                        |
| Orphan sweep           | Nightly               | Lists a bounded page of the bucket and deletes objects older than seven days that neither the object table nor the deletion outbox names, continuing from where it stopped                                                                                    |

### Settings

The worker needs `DATABASE_URL` and the same `STORAGE_*` settings as the web service, since it deletes from and finalises uploads in the bucket. Optional: the `STORAGE_REPLICA_*` and `STORAGE_EVIDENCE_*` settings. When billing is enabled: `APP_ORIGIN`, `BILLING_PROVIDER`, `POLAR_ACCESS_TOKEN`, `POLAR_ENVIRONMENT`, `BILLING_GRACE_DAYS`, and never the webhook secret.

It runs as a second service on a platform such as Coolify from the published image. Run it without a domain or published ports, and allow at least 45 seconds for shutdown so its 30-second graceful stop can finish.

### Schema and privileges

The worker migrates only pg-boss's own schema on start. The application schema is migrated by the `migrate` job or the web image's startup migration, never by the worker. At start it waits up to ten minutes for the newest migration it was built against, then exits if that never arrives, so a release can roll the two images in any order.

Its database role needs:

- `CREATE` on the database (the Compose role has it), and ownership of the `pgboss` schema it creates.
- `SELECT`, `INSERT`, `UPDATE` and `DELETE` on every application table, with `USAGE` on their schema. These are the same privileges as the web app: the worker purges trash, drains the deletion outbox, replicates objects, expires uploads and answers reports.
- `USAGE` on the `drizzle` schema with `SELECT` on `drizzle.__drizzle_migrations`.

It checks all of this before taking a job and refuses to start without it, naming what is missing. The GRANT block for a split-role setup is under [Startup migrations and rolling updates](#startup-migrations-and-rolling-updates).

## Public HTTPS deployment

Use your hosting platform's HTTPS ingress or a reverse proxy you manage. Point one hostname, such as `https://hushos.example.com`, at the app:

| Proxy location         | Upstream                |
| ---------------------- | ----------------------- |
| On the same host       | `http://127.0.0.1:5173` |
| On the Compose network | `http://web:5173`       |

Route all paths to that upstream, including `/api` and static assets. The UI and API share the public origin, and the application needs no separate API hostname. Your proxy or platform owns domain routing and TLS.

Settings the proxy decides:

- `APP_ORIGIN`: the exact public HTTPS origin. It controls email links, social metadata, and allowed auth mutations.
- `TRUSTED_PROXY_HEADER`: the header your proxy fills with the client address (`x-forwarded-for` for Caddy, nginx and Traefik; `cf-connecting-ip` behind Cloudflare). Without it every visitor shares the proxy's address and one rate-limit budget, and Polar, which picks the checkout currency from that address, sees the proxy's country.
- `TRUSTED_COUNTRY_HEADER`: if the proxy also geolocates, the header carrying the visitor's country code (`cf-ipcountry` behind Cloudflare), so the pricing page opens in their currency. Without it the browser's language decides, and a selector on the page lets anyone change it.

How the pieces talk:

- The browser's auth client is an Eden Treaty client typed by the Elysia app, so request and response types come from the route schemas.
- Server-side rendering reads sessions in process without HTTP.
- Database credentials are supplied to the app at runtime and never enter browser assets.
- Remote browser crypto APIs need HTTPS; localhost has a [secure-context exception](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts) for local development.

### Upgrading an older deployment

Remove the old API service and its separate hostname routing. `--remove-orphans` removes the old service container while preserving database volumes. Remove unused `WEB_ORIGIN`, `VITE_API_URL`, and `API_INTERNAL_URL` settings. Deploy matching versions of the web, worker, and migration images.

## Container publishing

The GitHub Actions workflow runs `bun run check` (lint, format, and typecheck), `bun run test`, and `bun run build` on pull requests and pushes to `main`. Successful pushes to `main` then build and publish these Linux AMD64 images on native AMD64 runners:

| Service    | Image                           |
| ---------- | ------------------------------- |
| Web        | `ghcr.io/hushos/hushos-web`     |
| Migrations | `ghcr.io/hushos/hushos-migrate` |
| Worker     | `ghcr.io/hushos/hushos-worker`  |

- Each image receives `latest` and `sha-<full-commit-sha>` tags. Pin a deployment with the same commit tag for all three.
- Image names derive from the lowercase GitHub repository name, so forks publish under their own namespace.
- All three HushOS images are public and support anonymous pulls. Publishing uses the workflow's `GITHUB_TOKEN` with `packages: write`; no separate registry secret is required.
- Forks create private GHCR packages by default; set their visibility to public to allow anonymous pulls. See [GitHub's container registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).
- The web image includes both the UI and Elysia API. It uses the current origin, so the same image runs behind any hostname without an API URL build argument.

### Deploy webhook

The optional deployment job calls `DEPLOY_WEBHOOK_URL` with `DEPLOY_WEBHOOK_TOKEN` after all three images publish, then verifies `/api/ready` reports the published commit. Enable it with the repository variable `DEPLOY_ENABLED=true` and set `DEPLOY_ORIGIN`. For Coolify, a single deploy webhook can target both web and worker by listing their resource UUIDs separated by a comma in its `uuid` query parameter. Keep hosting configuration and credentials in your platform and GitHub settings.

### Running the published images

Copy `compose.yaml`, `compose.images.yaml`, and `.env.production.example` (as `.env`) to the host, then:

```sh
docker compose -f compose.yaml -f compose.images.yaml up -d
```

`HUSHOS_IMAGE_TAG=sha-<commit>` pins all three images to one release.

The OPAQUE server setup can be generated without the repository:

```sh
docker run --rm oven/bun:1-slim sh -c 'cd /tmp && bun add --silent @serenity-kit/opaque >/dev/null && bun -e "import { ready, server } from \"@serenity-kit/opaque\"; await ready; console.log(server.createSetup())"'
```

Put the output in `OPAQUE_SERVER_SETUP` if you want the setup in the environment rather than in the database, and keep it: existing credentials depend on it.

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

The web image starts as root, applies migrations using that file, removes migration environment variables, then permanently drops privileges to `bun` before opening the HTTP server. The web process cannot read the root-owned migration secret. Without `MIGRATION_DATABASE_URL_FILE`, the web image skips migrations; keep running the separate migration job first, as the included Compose configuration does.

The image runs the same `bun run db:migrate` command, Drizzle Kit configuration, and SQL as local development and the separate migration image.

### Rolling out safely

- Serialize deployments so only one migration process runs at a time.
- Failure exits the new container before it becomes ready. Configure the platform to retain the old healthy container until its replacement passes `/api/ready`.
- Supply `SERVER_SHUTDOWN_TIMEOUT=30` and a container stop grace period longer than 30 seconds so requests drain.
- Old and new versions overlap, so schema changes must be backward compatible: add new structures first and remove obsolete columns or constraints in a later release, after old containers have stopped.
- A failed application rollout does not undo migrations already applied.

### One role per process

With an owner that migrates, an application role and a worker role, the two runtime roles need the same table privileges, granted by the owner for the tables that exist and for the ones later migrations add:

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

The override disables the local database service by default, removes the migration job's local database dependency, and passes your external connection to the web service and migrator. `POSTGRES_PASSWORD` may remain as the unused generated local value because the base Compose file still validates it during configuration.

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

- The migrator tracks applied migrations and can run repeatedly. Keep the same `.env` and persistent volumes.
- `docker compose down` stops services and retains data; adding `--volumes` deletes it.
- Back up the `postgres18_data` volume/data and the OPAQUE server setup according to your deployment policy. For PlanetScale, use its database backup facilities as well.

## Remote development

Expose the development server on port 5173 through Tailscale Serve or another trusted HTTPS proxy. The browser uses `/api` on that same origin, so only one upstream is needed.

- Vite listens on all interfaces and answers LAN addresses and `*.ts.net` hostnames; add other hostnames to `allowedHosts` in `apps/web/vite.config.ts`.
- Signing in from a remote hostname needs `APP_ORIGIN` set to that HTTPS origin, because auth requests are rejected unless their `Origin` matches it.
- Development API CORS allows all origins for external tooling; production uses same-origin access.
- Browser crypto APIs require a secure context. HTTP localhost works on the same device; remote hostnames and LAN IPs need HTTPS.

The repository does not configure DNS, certificates, or Tailscale.

## Authentication and email

With no `OPAQUE_SERVER_SETUP` in the environment, the web service makes one on first start and keeps it in the database; `bun run setup` generates one for the environment instead. Either way, preserve it and never regenerate it on restart: existing credentials depend on it. The startup plugin validates server environment with T3 Env and Zod; an invalid email adapter fails startup.

| Setting                                                                                                     | Purpose                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_ORIGIN`                                                                                                | Exact public origin, HTTPS except HTTP localhost. No path, query, or credentials.                                                                                                                                                                                                                               |
| `OPERATOR_NAME`, `OPERATOR_JURISDICTION`, `OPERATOR_CONTACT`                                                | Optional legal name, jurisdiction and contact email of whoever runs the instance, shown on the terms, privacy and GDPR pages, for example `HushOS, Inc.` and `a Delaware corporation`; named in the terms and privacy policy.                                                                                   |
| `OPAQUE_SERVER_SETUP`                                                                                       | Optional. The server-side OPAQUE setup every password depends on. Unset, the web service makes one on first start and keeps it in the database (`server_secrets`), so it lives and dies with the database backup; set it to carry an existing setup to a new database, and never change it afterwards.          |
| `OPAQUE_SERVER_SETUP_ID`                                                                                    | Stable identifier for that setup; default `primary`.                                                                                                                                                                                                                                                            |
| `INITIAL_STORAGE_QUOTA_BYTES`                                                                               | Initial allowance for newly created accounts; default `1073741824` (1 GiB).                                                                                                                                                                                                                                     |
| `REFERRAL_BONUS_BYTES`, `REFERRAL_SIGNUP_CAP_BYTES`, `REFERRAL_PAID_BONUS_BYTES`, `REFERRAL_PAID_CAP_BYTES` | Referrals, paid in storage: what each side of an invite earns at sign-up (default 1 GiB), the most an inviter earns that way (5 GiB), what an inviter earns when an invitee first pays for a plan (5 GiB), and the most they earn that way (50 GiB). `0` turns a reward off. Rewards are ordinary entitlements. |
| `TRUSTED_PROXY_HEADER`                                                                                      | Header your proxy sets with the client address, such as `x-forwarded-for`. Required behind a proxy so rate limits key on clients, not the proxy.                                                                                                                                                                |
| `TRUSTED_COUNTRY_HEADER`                                                                                    | Header a geolocating proxy sets with the visitor's country code, such as `cf-ipcountry`; chooses the currency the pricing page shows first. Optional.                                                                                                                                                           |
| `EMAIL_ADAPTER`                                                                                             | `smtp`, `resend`, `ses`, or `log`, which writes each message to the web service's log instead of sending it: the template's default, for a first run, never for an instance other people use.                                                                                                                   |
| `EMAIL_FROM`                                                                                                | Sender address, optionally with display name.                                                                                                                                                                                                                                                                   |
| `SMTP_HOST`, `SMTP_PORT`                                                                                    | SMTP endpoint; local defaults `127.0.0.1:1025`.                                                                                                                                                                                                                                                                 |
| `SMTP_SECURE`, `SMTP_REQUIRE_TLS`                                                                           | Implicit TLS and required STARTTLS respectively.                                                                                                                                                                                                                                                                |
| `SMTP_USER`, `SMTP_PASSWORD`                                                                                | Set both if SMTP requires authentication.                                                                                                                                                                                                                                                                       |
| `RESEND_API_KEY`                                                                                            | Required for the Resend adapter.                                                                                                                                                                                                                                                                                |
| `AWS_REGION`                                                                                                | Required for SES. The AWS SDK supports workload credentials or environment credentials.                                                                                                                                                                                                                         |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`                                           | Optional explicit AWS credentials; access key and secret must be supplied together.                                                                                                                                                                                                                             |

### Mail in development and production

- The development override runs MailHog at SMTP port 1025 with its inbox at `http://localhost:8025`. `bun run infra:up` starts it with PostgreSQL.
- For a local full-stack preview use `docker compose -f compose.yaml -f compose.dev.yaml up -d --build`; the override points container SMTP to `mailhog`.
- The base production stack has no mail capture service: configure a reachable SMTP provider, Resend, or SES, and verify your sender/domain with it.
- Mail images use absolute URLs under `APP_ORIGIN`, which must be reachable by recipients.

### What email and the database hold

- Verification links expire after 30 minutes and use a URL fragment, so their tokens do not enter HTTP paths or access logs.
- Recovery additionally requires the independently generated recovery phrase.
- Email delivery never includes passwords or encryption keys.
- The database stores account metadata, public keys, encrypted private/root-key bundles, and hashed session/challenge tokens. See [the protocol](opaque-auth-design.md) for the precise boundary.

### Sessions

Account sessions use HttpOnly, SameSite=Lax, Path=/ cookies; HTTPS adds Secure and the `__Host-` prefix. Session validity and credential revision are checked before remembered device unlock. Serve production over HTTPS. A cookie or database backup alone does not contain the plaintext account key, but the OPAQUE setup is a sensitive server secret and must be protected.

### Recovery and deletion

- The server cannot recover lost encryption keys from email alone. Users must retain their recovery kit.
- Keep database and OPAQUE setup backups together, encrypted and access controlled.
- A reset replaces the recovery phrase for future reset authorization; an old recovery kit plus its old wrapped-key bundle can still recover the unchanged root key offline.
- Deleting an account removes live database records; operator backups and mail-provider retention follow your separate retention policy.

### Password changes and key rotation

- Account settings require a fresh current-password exchange for password changes and key rotation. Each operation revokes existing sessions and pending recovery attempts.
- Recovery-key rotation replaces the phrase. Master-key rotation replaces the root and phrase while preserving identity keys. Users must save a new recovery kit after either.
- Master-key rotation is restricted to accounts with no used or reserved storage until encrypted Drive objects can participate in the operation.
- Old backups and recovery kits can still expose their old roots; rotating a root does not revoke identity private keys already extracted from those copies.

## Sharing

Shares to accounts and links for anyone both keep the server out of the key:

- An account share is sealed between two identity keys. The recipient is told by email through the same adapter as verification mail.
- A link's key rides in the URL fragment, which browsers never send. Its optional password is stretched on the visitor's device.

Nothing here needs configuration beyond `APP_ORIGIN` (the address in the email and in links) and the email adapter. Visitor routes under `/api/drive/links/` take no session and are bounded per address and per token, so a reverse proxy must pass the real client address the way it does for sign-in.

### Live folders

Open folders stay current without a reload. While the tab is visible, the app polls every eight seconds:

- the workspace's change feed, `GET /api/drive/workspaces/:id/changes?since=`;
- the feed of every share it holds, `GET /api/drive/shares/:id/changes?since=`, which answers 410 once the share ends.

Only the folders a change touched are refetched. A poll with nothing new costs one row.

### Stopping a share or a link

Stopping cuts the server off at once and then rotates keys. The owner's device gives the shared item and everything beneath it fresh keys and re-seals what is still shared (remaining shares, remaining links, every version's content key), so whoever was cut off holds no key that still opens anything.

- Rotation runs in the background of the owner's tab in batches of 200 nodes. If the tab closes first, it resumes the next time that account opens Drive.
- While it runs, nothing can be moved out of the rotated folder.
- Objects are never re-encrypted. The guarantee is that a former member gets nothing further from the API and, once any download URL they held has expired (fifteen minutes for shared content), nothing further from the store.
- A password link made before this release cannot be re-sealed without its password and is stopped by the rotation; its owner makes a new one.

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

Names and file contents are never shown there. The operator holds no key that could show them, except the key a reporter sealed to them (next section). The API answers a member on `/api/admin/*` with 404, the same as a page that does not exist.

## Reports

Anyone who can see something through a link or a share can report it, signed in or not: the Report button on a link's page, and "Report…" on an item under Shared with me.

The reporter's device seals the item's key to the identity key of every current operator (a sealed box per operator), so the server stores only sealed copies and the operators alone can open them. An instance with no operator takes no reports; grant one first. An operator promoted later cannot open reports filed before the promotion, since nothing was sealed to them; another operator can.

### What a report holds

- The category and the reporter's reason.
- Who reported: the account, or an optional email and a hash of the address for an anonymous visitor.
- Whose files they are, and how the reporter could see them.
- A SHA-256 of the plaintext, for a file the reporter's device could read in one pass (up to 64 MiB).
- A snapshot of the reported subtree: every live node beneath the reported one, up to 2,000, with the envelopes and object framing needed to open it later. The snapshot is what makes a report outlive the owner's deletions.

### Triage

Reports are triaged at `/app/admin/reports`. The queue orders open reports by age and shows a clock per category: one hour for terrorist content, 48 hours for intimate images, a day for child sexual abuse material, longer for the rest. These are defaults for ordering, not legal advice.

Opening a report's content decrypts on the operator's device under their own identity and writes a "viewed" entry to the report's record. Every action is on the record with who took it:

- Dismiss.
- Remove the content: trashed in the owner's workspace where they cannot restore it, with every share and link on it revoked.
- Mark as filed with an authority and their reference.
- Keep on or release a hold.
- Suspend or reinstate the uploader. Their sessions end at once and sign-in is refused until reinstated.
- Add a note.

### Holds and evidence

While a report is open, and afterwards for as long as it is held, the deletion outbox leaves the reported objects in the primary bucket whatever the owner does, and the operator reads them from there. A report marked filed is always held. A report dismissed without a hold releases the bytes to ordinary deletion.

Optionally, the worker also copies every reported object to a separate evidence bucket within five minutes of the report, under `reports/<reportId>/<objectId>`, and deletes the copies of reports dismissed without a hold.

- Give that bucket its own credentials and set them on the worker only, so a compromised web container cannot reach it.
- Turn on object lock or a retention rule there where the provider offers one.
- Without these settings every report shows "no evidence store configured" and the hold is the only preservation.

The operator reads the evidence copy from the report page ("Fetch from the evidence store"):

1. The web service records a request.
2. The worker answers it within seconds with a presigned URL per object, fifteen minutes long.
3. The operator's browser reads the objects from the evidence bucket directly, decrypting on their device.

That is how a filed report stays readable after its hold is released and the primary copy drained, without the web service ever holding the evidence credentials. It means the evidence bucket's endpoint must be reachable from the operator's browser, not only from the worker, and needs a CORS rule allowing `GET` with the `Range` header from `APP_ORIGIN`, the same rule as the primary bucket.

| Variable                                                                                                                                                                                       | Purpose                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `STORAGE_EVIDENCE_ENDPOINT`, `STORAGE_EVIDENCE_REGION`, `STORAGE_EVIDENCE_BUCKET`, `STORAGE_EVIDENCE_ACCESS_KEY_ID`, `STORAGE_EVIDENCE_SECRET_ACCESS_KEY`, `STORAGE_EVIDENCE_FORCE_PATH_STYLE` | Optional bucket the worker copies reported objects to; set all or none. Worker only. Nothing in the web app can read or delete there |

### Evidence packets and filing

"Download evidence packet" builds, on the operator's device, a zip with the report as text and JSON, the record, every file's MD5, SHA-1 and SHA-256, the category's guidance on handling and where to file, and the files themselves. For child sexual abuse material the packet carries hashes and metadata only, since possessing the files is itself the offence and the reporting channels take them directly. Every packet download is on the report's record.

Reporting to authorities is the operator's act, not the software's: HushOS records what was filed where, it does not file. Which authority applies depends on where the instance is operated and where the people involved are: NCMEC's CyberTipline for child sexual abuse material seen by a US provider, the national hotline in the INHOPE network elsewhere, the police for threats. Keep the report held while any of that is pending.

## Referrals and affiliates

Every account has an invite link (`/r/<code>`, shown under Invite friends in Drive).

- Someone who signs up through it gets `REFERRAL_BONUS_BYTES` of extra storage, and so does the inviter, until the inviter has earned `REFERRAL_SIGNUP_CAP_BYTES` that way.
- When someone they invited first pays for a plan, the inviter earns `REFERRAL_PAID_BONUS_BYTES` more, up to `REFERRAL_PAID_CAP_BYTES`.
- Every reward is a storage entitlement, never money, granted when the new account finishes setting up or when Polar reports the first paid order.

### Affiliates

Affiliates are creators an operator enrols at `/app/admin/affiliates`. The Polar access token needs the `discounts:read` and `discounts:write` scopes as well as the ones billing already uses, or enrolment is refused. Each affiliate gets:

- a page at `/go/<slug>` that shows the plans with their percentage off;
- a coupon code, registered as a discount with Polar when billing is on, so it applies at checkout and can be typed there;
- a commission on the net amount of every paid order from people who signed up through them.

Commissions are recorded from Polar's `order.paid` webhook, once per order, and shown as owed until an operator marks them paid; paying them is done outside HushOS. A creator whose HushOS account is linked sees their code and earnings on their own Invite friends page. Without billing, affiliates can still be enrolled and attributed, but no discount exists to apply.

### Codes made at Polar

Any discount created directly at Polar with a code has a page too, at `/go/<code>`, with no affiliate and no commission. It shows the discount (a percentage or a fixed amount, its plans and its end date, as Polar holds them) and carries the code to checkout the same way. A code that has ended, not started or run out of redemptions has no page. That lookup needs the `discounts:read` scope.

## Security headers

### Release header and self-reload

Every response carries `x-hushos-release`, the git commit the image was built from (`HUSHOS_RELEASE_SHA`, set by the published images). An open tab asks `/api/ready` for it every minute while visible, when it comes back into view and on navigation. After a deploy the tab reloads itself at the next quiet moment: at once on a public page, on the next navigation from a sign-in form, and in the app once no upload is running, with a banner until then.

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

| Variable                                       | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ANALYTICS_SCRIPT_URL`, `ANALYTICS_WEBSITE_ID` | Optional, web only. A self-hosted [Umami](https://umami.is) script (`https://analytics.example.com/script.js`) and the website id it gave you. Set both and the public pages (home, pricing, blog, comparisons, offer and invite pages, legal pages) load it; nothing under `/app`, the sign-in, sign-up and recovery pages, or shared links ever does, and a navigation from a public page into one of those is filtered before the beacon leaves. The script's origin is added to the Content Security Policy for scripts and connections. Umami sets no cookie. |
| `CSP_CONNECT_SRC`                              | Optional, web only. Extra origins the browser may fetch from, space or comma separated. Set it to the evidence bucket as presigned URLs address it (`https://<bucket>.<endpoint host>`, or the endpoint itself in path style) so operators can read evidence copies                                                                                                                                                                                                                                                                                                |

A reverse proxy that adds its own `Content-Security-Policy` would combine with this one (browsers enforce both), so leave that to the app. The policy does not cover the object store itself: the store's CORS rule is what lets the browser read from it, as described under [Drive object storage](#drive-object-storage).

## Billing (optional)

Self-hosted instances have no billing: leave `BILLING_PROVIDER=none` and every account keeps the allowance set by `INITIAL_STORAGE_QUOTA_BYTES`.

The hosted service sells storage plans through [Polar](https://polar.sh) as merchant of record, which collects payment, handles sales tax and VAT, and issues invoices. HushOS keeps the customer and subscription mapping locally and derives storage entitlements from it; Polar never sees file names, content, or keys.

| Setting                | Purpose                                                                                                                                                                                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BILLING_PROVIDER`     | `none` (default) or `polar`.                                                                                                                                                                                                                                |
| `POLAR_ACCESS_TOKEN`   | Organisation access token with `checkouts:write`, `customers:read`, `customers:write`, `customer_sessions:write`, `subscriptions:read`, `subscriptions:write`, `orders:read`, `products:read`, and, for affiliates, `discounts:read` and `discounts:write`. |
| `POLAR_WEBHOOK_SECRET` | Secret of the webhook endpoint pointed at `https://<APP_ORIGIN>/api/billing/webhook`.                                                                                                                                                                       |
| `POLAR_ENVIRONMENT`    | `production` (default) or `sandbox`. Tokens and webhook secrets are specific to each environment.                                                                                                                                                           |
| `BILLING_GRACE_DAYS`   | Days an allowance outlives its billing period, so a late renewal or a payment retry does not cut anyone off. Default `3`.                                                                                                                                   |

### Plans are Polar products

Prices and names are edited in the Polar dashboard, never in code.

- `bun run polar:seed` creates the launch catalogue (Plus, Pro, Max; monthly and yearly) in whichever organisation `POLAR_ACCESS_TOKEN` belongs to, skipping products that already exist. With `--update` it also brings existing products' prices, descriptions, and metadata in line with the script, replacing a changed price for new checkouts while current subscribers keep theirs. The token needs `products:write` for those runs.
- Each product carries one fixed price per currency, with the organisation's default currency (USD) required and the others optional. Polar charges a customer in their local currency when the product has one and falls back to the default otherwise. The pricing page shows the same currency, chosen from `TRUSTED_COUNTRY_HEADER`, then the browser's language, with a selector to change it. The currencies and amounts live in the seed script's table.
- A product is offered as a HushOS plan when it is recurring, has a fixed price in the default currency, and carries two metadata keys: `hushos_plan` (any value) and `quota_bytes` (the storage it grants, as an integer). Monthly and yearly are separate products.
- Archiving a product hides it from the pricing page while existing subscribers keep it.

### Webhooks and reconciliation

Subscribe the webhook endpoint to the `customer.*`, `subscription.*`, and `order.*` events. Every delivery is verified with the Standard Webhooks signature, recorded by its message id, and answered by re-reading the customer's state from Polar, so duplicate, reordered, or missed deliveries cannot corrupt local state. The worker also re-reads every billing customer once a day. Both the web and worker services need the billing settings.

### When a subscription ends

Its entitlement is revoked and the allowance returns to the base quota; content is never deleted or made unreadable. Deleting an account revokes any active subscription and deletes the Polar customer first, and refuses to proceed if Polar cannot be reached.

For local development, use a sandbox organisation and relay deliveries with Polar's CLI: `polar listen http://localhost:5173/api/billing/webhook`.

## PostgreSQL 18 upgrades

The bundled image is `postgres:18-alpine`, with a named `postgres18_data` volume mounted at `/var/lib/postgresql`. PostgreSQL 18 uses a versioned data directory under that mount. A PostgreSQL 17 data directory must not be mounted into PostgreSQL 18 and started as-is.

For an existing 17 installation:

1. Keep the old volume and take a logical `pg_dump`/`pg_dumpall` backup.
2. Restore into a fresh PostgreSQL 18 volume and verify accounts/data.
3. Point the application at it and run the checked-in migrations.

Alternatively use a planned `pg_upgrade` procedure for your deployment. Retain the old volume and verified backup until the upgrade is accepted. `docker compose down --volumes` is not an upgrade procedure.

## Drive object storage

Drive keeps file bytes in an S3-compatible bucket and the folder tree in PostgreSQL. The store only ever holds ciphertext under keys named by workspace and object id.

Browsers upload to and download from the bucket directly through presigned URLs, so:

- the bucket's endpoint must be reachable from every browser, not only from the containers;
- it needs a CORS rule allowing `PUT` and `GET` (with the `Range` header) from `APP_ORIGIN` and exposing `ETag`.

### The download service worker

Downloads are decrypted in the browser and streamed to disk through a service worker the app registers from `/download-sw.js` with scope `/hushos-download/`; audio and video previews play through the same worker. Both paths are static files served by the web container. A reverse proxy in front of it must pass them through unchanged (same origin, `text/javascript` content type, no caching that outlives a deploy), or browsers fall back to holding each download in memory.

| Variable                                                                                                                                                                                 | Purpose                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STORAGE_INTERNAL_ENDPOINT`                                                                                                                                                              | Optional. Where the web and worker services reach the store when that differs from the browser's URL: `http://minio:9000` for the bundled MinIO inside Compose. Presigned URLs keep `STORAGE_ENDPOINT`.                                                                                                                             |
| `STORAGE_ENDPOINT`                                                                                                                                                                       | Public S3 endpoint URL the browser can reach                                                                                                                                                                                                                                                                                        |
| `STORAGE_REGION`                                                                                                                                                                         | Region the endpoint expects (`auto` for R2, `us-east-1` for MinIO)                                                                                                                                                                                                                                                                  |
| `STORAGE_BUCKET`                                                                                                                                                                         | One bucket per instance                                                                                                                                                                                                                                                                                                             |
| `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`                                                                                                                                     | Credentials scoped to that bucket                                                                                                                                                                                                                                                                                                   |
| `STORAGE_FORCE_PATH_STYLE`                                                                                                                                                               | `true` for MinIO and most self-hosted stores, `false` for R2, B2 and S3                                                                                                                                                                                                                                                             |
| `DRIVE_MAX_FILE_BYTES`                                                                                                                                                                   | Per-file upload limit; default 32 GiB, ceiling just under 80 GiB                                                                                                                                                                                                                                                                    |
| `DRIVE_CLIENT_MINIMUMS`                                                                                                                                                                  | Optional. The oldest client version the Drive API still serves, per client name, as `web/1,cli/0.4`. Every Drive request carries `HushOS-Client: name/version`; a client below its minimum is refused with 426 and told to update (the web app tells the person to reload). Clients with no entry are served whatever their version |
| `STORAGE_REPLICA_ENDPOINT`, `STORAGE_REPLICA_REGION`, `STORAGE_REPLICA_BUCKET`, `STORAGE_REPLICA_ACCESS_KEY_ID`, `STORAGE_REPLICA_SECRET_ACCESS_KEY`, `STORAGE_REPLICA_FORCE_PATH_STYLE` | Optional second bucket the worker copies every object to; set all or none. Only the worker receives these settings                                                                                                                                                                                                                  |
| `STORAGE_COLD_CLASS`                                                                                                                                                                     | Optional. The provider's infrequent-access storage class as the S3 API spells it (`STANDARD_IA` on R2 and AWS). With it set, the worker moves objects nobody has read for 90 days to that class nightly and back to `STANDARD` once read again. Leave unset on MinIO and B2, which have one class. Worker only                      |
| `DRIVE_ORPHAN_SWEEP_PAUSED_UNTIL`                                                                                                                                                        | Optional ISO timestamp. Until then the worker skips the orphan sweep. Set it after restoring the database from a backup, to at least the backup's age plus a day, so objects the restored database no longer knows about are not deleted before the object audit has listed what is missing. Worker only                            |

### The bundled MinIO

The `minio` service stores data in the `minio_data` volume and listens on `127.0.0.1:9000` (change the host port with `STORAGE_PORT`). Its root credentials are `STORAGE_ACCESS_KEY_ID` and `STORAGE_SECRET_ACCESS_KEY`, and it allows browser requests from `APP_ORIGIN`.

To use it behind a public hostname, route a second hostname such as `https://storage.hushos.example.com` to `127.0.0.1:9000` and set `STORAGE_ENDPOINT` to that URL. The web and worker services reach it inside Compose through `STORAGE_INTERNAL_ENDPOINT=http://minio:9000` while presigned URLs carry the public one.

Any hosted S3-compatible bucket works instead: point the `STORAGE_*` settings at it and drop the `minio` services from your Compose command.

### After restoring the database from a backup

1. Set `DRIVE_ORPHAN_SWEEP_PAUSED_UNTIL` on the worker before starting it.
2. Let the nightly object audit run, or trigger it by restarting the worker, which runs every job once at start.
3. Read its events for objects marked `missing` and recover those from the replica.
4. Only then let the pause lapse.

### Cleanup at the store

Cleanup is the application's job, and nothing at the bucket should expire objects on its own:

- The worker aborts abandoned multipart uploads and deletes objects through an outbox.
- With a replica configured, a published object's primary copy is deleted only once the replica holds it, and the replica copy 30 days later, which is the window for undoing a bad purge.
- On R2, B2 and S3, add one lifecycle rule that aborts incomplete multipart uploads after 3 days as a second layer. MinIO does not accept a rule with only that action, so the bundled store relies on the worker alone.

## Logs and storage allowances

### Logs

Nitro emits one evlog completion event for each request, including pre-parser auth rejections.

- Production output (`NODE_ENV=production`, which the images and `bun run start` set) is JSON; development output is readable text.
- Redaction is enabled in both environments, with an auth-specific field allowlist.
- Logs contain request IDs, routes, status, duration, and operation outcomes. They exclude auth bodies, cookies, keys, passwords, recovery phrases, and raw protocol/provider/database errors.
- No external drain is configured.

### Allowances

- A personal workspace and initial quota are created in the signup transaction.
- Quota counts use PostgreSQL bigint and serialize as decimal strings.
- Extra entitlements are separate, expiring/revocable records keyed by the billing subscription that granted them.
- Changing the initial-quota environment variable affects new accounts only.

### Enforcement

Drive's folder tree is live: folders, names and moves are encrypted end to end and every write is serialised per workspace. Upload enforcement lands with uploads:

- ciphertext bytes are reserved atomically before upload URLs are issued;
- object sizes are verified at completion;
- retained trash and versions count against the allowance;
- usage is released only after object deletion.
