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

- The bundled [Garage](https://garagehq.deuxfleurs.fr/) holds the files. The web service reaches it inside Compose; browsers reach it on `127.0.0.1:9000`.
- The OPAQUE server setup is made on first start and kept in the database.
- Email goes to the web container's log (`EMAIL_ADAPTER=log`); `docker compose logs web` shows each verification link.

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

The migration job must complete before the app starts. It uses `packages/db/drizzle.config.ts` and the checked-in SQL migrations. `/api/health` checks the app process; `/api/ready` checks a real database query and is the container health check.

Open [http://localhost:5173/app](http://localhost:5173/app). API health is at [http://localhost:5173/api/health](http://localhost:5173/api/health). Compose publishes the app on `127.0.0.1:5173`; PostgreSQL stays inside the container network. The development override publishes PostgreSQL on port 5433 for host tools.

### Changing the port

Set `PORT=8080` in `.env`, or run `PORT=8080 docker compose up -d --build`, to publish a different host port. The container still listens on `5173`; update a host-based proxy's upstream port to match. Outside Docker, `PORT=8080 bun run start` changes the app's listening port directly.

### The images

- **Web.** Nitro v3 with the `bun` preset. `bun run build` produces the deployable `apps/web/.output` directory; `bun run start` runs its server entry on Bun. Nitro serves static assets, the TanStack Start SSR handler, and the mounted Elysia API. The image holds that `.output` directory, Bun, and Drizzle Kit for optional startup migrations. Its entrypoint drops root privileges before starting the web process as `bun`.
- **Migrations.** `packages/db/Dockerfile` builds the migration image with Bun and Drizzle Kit. It runs as the unprivileged `bun` user.
- **Worker.** A Bun base plus one bundled file, built from `packages/jobs/Dockerfile`. See [The worker](#the-worker).

## The worker

The worker runs background jobs with [pg-boss](https://pgboss.io), which keeps its queue in a `pgboss` schema inside the same database. Each job also runs once at start, so a backlog after downtime clears.

| Job                    | When                  | What it does                                                                                                                                                                                                                                                  |
| ---------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth cleanup           | Every five minutes    | Sweeps expired sessions, attempts and rate-limit rows                                                                                                                                                                                                         |
| Billing reconciliation | Daily                 | Re-reads every billing customer from the provider, when billing is enabled, and queues the end of any pooled family member's personal plan still live or not yet refunded                                                                                     |
| Dissolved family plans | When queued           | Sets a dissolved family's plan that can still charge to end at its period's end, with no refund, and emails its payer the date (once a period); again every time they resume it (Dissolved families, under Groups)                                            |
| End personal plans     | When queued           | Ends a family member's own personal plan at Polar once their files draw from the family's pool, and refunds the unused days (Family plans, under Billing)                                                                                                     |
| Expire uploads         | Hourly                | Aborts uploads past their expiry; finishes ones that stalled while completing when the store holds the object                                                                                                                                                 |
| Deletion outbox        | Every five minutes    | Drains the object deletion outbox                                                                                                                                                                                                                             |
| Replication            | Every five minutes    | Copies every completed object to the replica bucket, when one is configured                                                                                                                                                                                   |
| Purge                  | Every fifteen minutes | Purges trash and superseded versions past 30 days; fans deletions out under purged folders; deletes tombstones past 90 days; deletes family folders deleted, or retired by dissolving their family, more than 30 days ago                                     |
| Dissolved families     | Hourly                | Deletes the records of a family dissolved more than 30 days ago once Purge has deleted its folders, and retires the folders of a family dissolved before this release (Dissolved families, under Groups)                                                      |
| Accounting audit       | Nightly               | Logs any drift between `used_bytes` and the objects                                                                                                                                                                                                           |
| Object audit           | Nightly               | Confirms a page of objects at the store, least recently confirmed first. A lost one is marked `missing` so the app says the file is unavailable rather than failing to decrypt. With a replica, a primary copy the replica still holds is copied back instead |
| Replica audit          | Weekly                | Audits the replica the same way; a miss re-queues the copy                                                                                                                                                                                                    |
| Tiering                | Nightly               | A no-op unless `STORAGE_COLD_CLASS` is set                                                                                                                                                                                                                    |
| Evidence copies        | Every five minutes    | Copies reported objects to the evidence bucket, when one is configured                                                                                                                                                                                        |
| Orphan sweep           | Nightly               | Lists a bounded page of the bucket and deletes objects older than seven days that neither the object table nor the deletion outbox names, continuing from where it stopped                                                                                    |

### Settings

The worker needs `DATABASE_URL` and the same `STORAGE_*` settings as the web service, since it deletes from and finalises uploads in the bucket. Optional: the `STORAGE_REPLICA_*` and `STORAGE_EVIDENCE_*` settings. When billing is enabled: `APP_ORIGIN`, `BILLING_PROVIDER`, `POLAR_ACCESS_TOKEN`, `POLAR_ENVIRONMENT`, `BILLING_GRACE_DAYS`, and never the webhook secret. With billing and families on, it also needs the same `EMAIL_*` settings as the web service (and the `SMTP_*`, `RESEND_API_KEY` or `AWS_*` ones its adapter uses): it emails a dissolved family's payer when it sets their plan to end. Without them the plan is still set to end, and the worker logs `Plan ending email not sent` each time; `compose.yaml` passes them to both services.

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

- Each image receives a `sha-<full-commit-sha>` tag. `latest` moves to a commit's images once its Linux test suites pass, and only forward: an older commit's run that finishes late, or a re-run of one, leaves it on the later commit. A release (CONTRIBUTING.md, Releasing) also tags its images `X.Y.Z`, `X.Y` and `X`, copied by digest from that commit's `sha-<commit>` images: the same images main published, not a rebuild. The version tags appear shortly after the GitHub release, once CI for the commit has finished. Pin a deployment to one version, or one commit tag, for all three.
- Each image is labelled `org.opencontainers.image.version` (the product version in `package.json`, which between releases is still the last release's) and `org.opencontainers.image.revision` (the commit).
- Image names derive from the lowercase GitHub repository name, so forks publish under their own namespace.
- All three HushOS images are public and support anonymous pulls. Publishing uses the workflow's `GITHUB_TOKEN` with `packages: write`; no separate registry secret is required.
- Forks create private GHCR packages by default; set their visibility to public to allow anonymous pulls. See [GitHub's container registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).
- The web image includes both the UI and Elysia API. It uses the current origin, so the same image runs behind any hostname without an API URL build argument.

### Deploy webhook

The optional deployment job calls `DEPLOY_WEBHOOK_URL` with `DEPLOY_WEBHOOK_TOKEN` after `latest` moves to the commit, then verifies `/api/ready` reports it (or a later commit). Point the platform at the `latest` tags. Deploys run one at a time, and a commit that `latest` has moved past (a later commit's run then deploys), or that is older than the release `/api/ready` reports, is skipped rather than deployed, so a late or re-run job never rolls production back. Enable it with the repository variable `DEPLOY_ENABLED=true` and set `DEPLOY_ORIGIN`. For Coolify, a single deploy webhook can target both web and worker by listing their resource UUIDs separated by a comma in its `uuid` query parameter. Keep hosting configuration and credentials in your platform and GitHub settings.

### Running the published images

Copy `compose.yaml`, `compose.images.yaml`, and `.env.production.example` (as `.env`) to the host, then:

```sh
docker compose -f compose.yaml -f compose.images.yaml up -d
```

`latest` follows `main`, every merged change, as hushos.com does. To run releases instead, pin all three images to one version: `HUSHOS_IMAGE_TAG=1.4.2` stays on that release, `HUSHOS_IMAGE_TAG=1.4` takes its patch releases, `HUSHOS_IMAGE_TAG=1` everything until a breaking release. `HUSHOS_IMAGE_TAG=sha-<commit>` pins one exact build. Releases and their notes are at `https://github.com/HushOS/HushOS/releases`; read them before moving a pin.

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
- The devices release (`20261016013230_devices`) gives every live session a device and adds `sessions.device_id` as nullable. Drizzle applies all pending migrations in one transaction, so `sessions` stays locked against every signed-in request from the moment the column is added until the run commits: on a table of a few thousand sessions that is milliseconds, on millions it is a short outage, so pick a quiet moment there. The migration waits at most five seconds for that lock (`lock_timeout`) and fails rather than queue requests behind it; run it again. While old containers still run, a sign-in through one of them makes a session without a device, which the new containers do not accept: that person is asked to sign in again. A later release deletes sessions still without a device and makes the column `NOT NULL`; take it only once no container of the previous release is left.
- The groups release (`20261016032459_workspace_owners` through `20261016081643_group_tables`) labels every workspace with its owner and adds the group tables. It first counts workspaces without a `personal_workspaces` row, with an ordinary read, and refuses to run if there are any, naming how many: assign or delete those before migrating. It then takes an exclusive lock on `workspaces`, which blocks reads as well as writes of the table (every Drive request touches it), until drizzle's single transaction commits. The new columns are added without rewriting the table and its checks without scanning it, but a unique index is built under that lock: seconds on a large instance, so pick a quiet moment. The group tables' foreign keys to `users` hold a lock on `users` until the same commit, which blocks sign-ups and account changes (not reads) meanwhile. It waits at most five seconds for the lock (`lock_timeout`) and fails rather than queue requests behind it; run it again. Containers of the previous release keep signing people up meanwhile, since `owner_kind` defaults to `personal`; the next release drops that default and validates the checks.
- The re-keyed records release (`20261017062152_rekeyed_origins`) adds the origin and drop columns to `drive_nodes` and `file_versions`, the origin signers to `drive_report_items`, and the new table `drive_origin_drops`, and replaces the signature checks. The columns are nullable with no default and every check on an existing table is added `NOT VALID`, so nothing is rewritten or scanned, but the `ALTER`s hold an exclusive lock on both Drive tables (every Drive request) until drizzle's single transaction commits: milliseconds; the new table is created first, its foreign key locking `workspaces` against writes until then, so the migration takes `workspaces` before the Drive tables, as live writes do. It waits at most five seconds for each lock (`lock_timeout`) and fails rather than queue requests behind it; run it again. Before migrating, check that no row has a signer without a signature, which the replaced checks refuse on any later update of that row: `select (select count(*) from drive_nodes where metadata_signature is null and metadata_signer is not null) as nodes, (select count(*) from file_versions where signature is null and signer is not null) as versions;` must answer 0 and 0 (it does on hushos.com). Origins are written only in family folders (behind `GROUPS_ENABLED`); personal workspaces, and the shipped iOS and Android apps, see no change. Only with families on, while containers of the previous release still run beside the new ones: their purges and sweeps (purging a node or a version, releasing an upload, purging a displaced version) of re-keyed family rows fail the new origin checks, since they clear the envelope but not the origin; that fails closed, and the job or request is retried by a new container. Their renames and rotations of re-keyed rows leave a stale origin, which readers show as "couldn't confirm" (never as anyone's fault) and which the next honest rotation drops for good (recorded as a drop). So roll quickly, and turn families on only after the server and web of this release are out (they deploy together). A later release validates the six checks.
- The group billing release (`20261017121401_group_billing`) adds three empty tables, `group_billing_customers`, `group_billing_subscriptions` and `group_storage`. Their foreign keys briefly lock `groups` and `users` against writes until the run commits (milliseconds; five-second lock timeout). Nothing changes for an instance without billing or groups. A family created before billing was turned on keeps its folders' free allowances (`GROUP_AREA_QUOTA_BYTES` each) until it buys a plan, which may be never: turning billing on does not take them away. None exist on hushos.com, where groups have never been on.
- The drop evidence release (`20261017153848_origin_drop_evidence`) adds five nullable columns to `drive_origin_drops` (`previous_envelope`, `previous_key_epoch`, `node_kind`, `object_id`, `content_suite`) and a check added `NOT VALID`: nothing is rewritten or scanned, and the lock on that table (written only when a rotation drops an origin in a family folder) lasts milliseconds, five-second lock timeout. Rows recorded before it stay all null and cannot be checked against the previous re-keyer's signature; every drop after it records them. While containers of the previous release still run, a drop through one of them records a row without them, which the check allows, so with families on, roll quickly. None exist on hushos.com, where groups have never been on. A later release validates the check.
- The family folder deletion release (`20261017170455_group_area_deletion`) adds `workspaces.deleted_at`, a partial index on it and a check (`NOT VALID`) that only a group's area is ever deleted, and the empty table `group_area_commitments` (every area and top-folder key commitment a stored roster lists, refused across groups; no foreign key, so it outlives a group; rosters stored before this release are not backfilled, so their commitments are not guarded). The column is nullable with no default, so nothing is rewritten; the index starts empty, and building it reads `workspaces` once under the lock. It waits at most five seconds for each lock and fails rather than queue requests; run it again. Deleted family folders are purged by the existing `drive.purge` job 30 days after deletion (Drive's trash retention); nothing to configure. A later release validates the check.
- The one-family release (`20261018222928_one_family`) adds `group_memberships.group_kind` (copied from each group), a unique constraint `groups_id_kind`, the composite foreign key `group_memberships_group_kind_fk` and the partial unique index `group_memberships_one_family_idx` (One family per account, under Groups). It first counts accounts active in more than one family and stops, changing nothing, if there are any. Its `ALTER`s take an exclusive lock on `groups` and then `group_memberships` and hold it until drizzle's single transaction commits; that blocks every read of either table meanwhile, Drive's access checks included (a family folder's authorization joins `group_memberships`), so every Drive request to a family folder waits: milliseconds on a small instance, seconds on one with many memberships, since the backfill rewrites each row and the index is built under the lock. It waits at most five seconds for each lock (`lock_timeout`); a lock it can't get in time, or a deadlock with a live request, fails the migration with nothing applied, and it is simply run again. Containers of the previous release keep working beside the new ones: they insert memberships without the new column, which defaults to `family`, the only kind they can create (a later release drops the default), and they don't know the rule: through one of them someone in a family can still accept another family's invitation (a new container then refuses letting them in), and an admission or creation the index refuses there answers `invalid` instead of `in-family`. Nobody gets into two families either way. To take the schema back by hand, in one transaction: `drop index group_memberships_one_family_idx; alter table group_memberships drop constraint group_memberships_group_kind_fk; alter table group_memberships drop column group_kind; alter table groups drop constraint groups_id_kind;`, then delete the `20261018222928_one_family` row from `drizzle.__drizzle_migrations`, and run the previous release's images only.
- The invitation address index (`20261018235021_invitation_email_index`) adds a partial index on the address of open invitations, for the list of invitations an account sees under Account → Family. Building it locks `group_invitations` against writes until the run commits: milliseconds, five-second lock timeout; run it again if it times out. Containers of the previous release are unaffected.
- The refund-disputed release (`20261019171449_refund_disputed`) adds `disputed` to the status check on `personal_plan_refunds`; re-adding the check scans that small table under its lock, milliseconds, five-second lock timeout. Containers of the previous release don't cascade and treat a disputed refund as a failure.
- The personal plan endings release (`20261019161551_personal_plan_endings`) adds two empty tables, `personal_plan_endings` and `personal_plan_refunds` (the second's foreign key points at the first only), so nothing existing is locked, rewritten or scanned; five-second lock timeout. Containers of the previous release don't queue `billing.end-personal-plan`; the worker of this release creates the queue, and the daily reconcile catches any pooled member a previous container let in. With a split-role setup, the default privileges below cover the new tables.
- The family moves release (`20261019181225_drive_moves`) adds six nullable `move_*` columns to `drive_uploads`, a check that they are all set or all null (`NOT VALID`: nothing is rewritten or scanned; a later release validates it) and the partial unique index `drive_uploads_one_move_idx`, which holds no row yet; building it reads `drive_uploads` once while the run holds its lock, milliseconds, five-second lock timeout. Moves exist only with families on (`GROUPS_ENABLED`). While containers of the previous release still run beside the new ones, a move begun on a new container and completed (or expired) on an old one publishes the copy without deleting the original: both count, until the person deletes one. So roll quickly, and turn families on after the rollout.
- The dissolved families release (`20261020151204_group_billing_no_group_fk`) drops the foreign keys from `group_billing_customers` and `group_billing_subscriptions` to `groups`, so a family's billing records are kept, by its id, when the worker purges a family dissolved more than 30 days ago (Dissolved families, under Groups). Dropping them takes a brief lock on those tables and on `groups`: milliseconds, nothing scanned or rewritten, five-second lock timeout. **Families dissolved before the upgrade get 30 days from the upgrade, not from when they were dissolved:** the migration retires their folders as of the upgrade and sets their `dissolved_at` to the upgrade time, so nothing of theirs is deleted for 30 days after it, however long ago they were dissolved (the previous release's privacy policy said nothing deletes them). This runs whether or not families are on (`GROUPS_ENABLED`): the purge jobs are scheduled either way. To keep such a family's data past those 30 days, export or copy it first; there is no switch to turn the purge off. The migration updates only dissolved families' rows, under the same lock. Containers of the previous release never delete a group, so they are unaffected; one that dissolves a family during the rollout leaves its folders live, and the worker of this release retires them on its next hourly run, as of then.
- The dissolved family plans release (`dissolve_cancels`) adds six columns to `group_billing_subscriptions`: `dissolve_cancels` (`integer not null default 0`, which Postgres adds without rewriting the table) and the nullable `dissolve_cancelled_at`, `dissolve_mailed_period_end`, `dissolve_refused_at`, `dissolve_refusal` and `dissolve_refused_state`, and its second migration (`dissolve_failing`) a nullable `dissolve_failing_since`. It also stops the reconcile from recording a paused family plan as ended. The lock on that small table lasts milliseconds, five-second lock timeout. Containers of the previous release don't queue `billing.cancel-dissolved`; the worker of this release creates the queue, and its first daily reconcile queues the job for every dissolved family whose plan can still charge.
- The change numbers release (`20261020213416_change_seq_renumber`) changes no schema. Before it, a batch of folders (`POST /api/drive/folders`, which only the create-folder dialog sends with more than one folder, for a path such as `one/two/three`) took one `change_seq` for the whole batch, and a change feed page that ended inside such a batch made every later pull skip the rest of it. New batches take one number per folder. The migration gives every row that still shares a number a new one at the head of its workspace, parents first, and moves that workspace's counter up by as many; devices that skipped those folders receive them again and apply them like any change, without a rebuild. Only rows that still share a number move, so running it twice is harmless. Locks: no table lock. The new numbers stay unique because every number comes from the workspace's counter (`nextChangeSeq`/`moreChangeSeqs`, under the `workspaces` row), which the migration moves past the numbers it hands out; it also locks, `FOR UPDATE` in id order, the `workspaces` rows of the workspaces that have a shared number, which only keeps those workspaces quiet: writes that number nodes there wait until drizzle's single transaction commits, the time of two scans of `drive_nodes`' numbered rows plus the update. Not every Drive write takes that row (an upload's first step inserts its node without a number), but none of those number a node; reads, sign-ups and every other workspace carry on. It waits at most five seconds for a row and fails rather than queue requests behind it. A deadlock aborts it with nothing applied (the tombstone sweep deletes `drive_nodes` rows before updating `workspaces`; a move between a family folder and a personal workspace locks the family folder's row first, not in id order); run it again. Nothing breaks during a rolling update: containers of the previous release keep giving a batch one number until they stop, and the next release (which makes the index unique) renumbers those first. Before migrating, run these read-only checks: (1) what will move, and whether every shared number looks like a folder batch (`not_a_folder_batch` must be 0): `with g as (select workspace_id, change_seq, count(*) n, count(*) filter (where kind <> 'folder') non_folders, count(*) filter (where purged_at is not null) tombstones, count(distinct created_at) created_ats, count(distinct created_by) creators from drive_nodes where change_seq is not null group by 1,2 having count(*) > 1) select count(*) groups, coalesce(sum(n),0) rows_to_renumber, count(distinct workspace_id) workspaces, max(n) largest_group, (select max(c) from (select sum(n) c from g group by workspace_id) x) max_rows_one_workspace, count(*) filter (where non_folders > 0 or tombstones > 0 or created_ats > 1 or creators > 1) not_a_folder_batch from g;` (2) no node is numbered above its workspace's counter (must be 0): `select count(*) from drive_nodes n join workspaces w on w.id = n.workspace_id where n.change_seq > w.change_seq;` (3) the table's size: `select reltuples::bigint rows, pg_size_pretty(pg_relation_size('drive_nodes')) heap, pg_size_pretty(pg_relation_size('drive_nodes_change_idx')) idx from pg_class where relname = 'drive_nodes';` and, right before migrating, no long transaction that would hold a lock past the five seconds: `select pid, state, now() - xact_start age, left(query, 80) from pg_stat_activity where xact_start < now() - interval '5 seconds';`
- The unique change numbers release (`20261020214235_change_seq_unique`) must follow the change numbers release (`20261020213416_change_seq_renumber`) only once no container older than that release runs: an older one gives a batch of folders one number, which this release's index refuses, so its multi-folder creations (the create-folder dialog's `one/two/three` paths) would fail as a conflict. It first renumbers, exactly as that release did, any rows that still share a number (the batches older containers wrote while it rolled out; check with query (1) there), then builds a unique index under a temporary name, drops `drive_nodes_change_idx` and renames the new one in its place. Locks, in the order live writes take them: the `workspaces` rows of workspaces that still have a shared number (`FOR UPDATE`; none if the previous release ran alone), then `drive_nodes` in `SHARE` mode, so reads go on and every Drive write waits while the rows move and the index is built (milliseconds on a small instance, seconds on a large one); the drop and rename then hold `drive_nodes` exclusively, reads included, until drizzle's single transaction commits: milliseconds. The drop first waits for every open read of `drive_nodes` to finish (share-feed polls, a `pg_dump`) while new reads queue behind it, so it waits at most one second; the other locks wait at most five. A lock not had in time, or a deadlock with a live write (the tombstone sweep, or a move between a family folder and a personal workspace), fails it with nothing applied; run it again. Don't deploy it during the backup window: a `pg_dump` holds its read of `drive_nodes` until it finishes, so the drop would time out on every attempt. If a number is still shared when the index is built, the build fails with nothing applied. Before migrating, run checks (1) to (3) of the previous release again, and the long-transaction check right before. To take the schema back by hand: `drop index drive_nodes_change_idx; create index drive_nodes_change_idx on drive_nodes (workspace_id, change_seq) where change_seq is not null;`, then delete the `20261020214235_change_seq_unique` row from `drizzle.__drizzle_migrations`.
- The release that keeps unpaid family plans has no migration. It stops the reconcile from recording a family plan Polar answers as `unpaid` or `incomplete` as ended; plans an earlier release ended so stay ended until read again (Dissolved families, below).
- The release that keeps unpaid personal plans (`20261021073123_personal_plan_lapsed`) drops NOT NULL from `personal_plan_endings.group_id` (catalog only) and adds `personal_plan_refunds.rewards_pending` (`boolean not null default false`, no rewrite). Both run in one transaction holding each table's ACCESS EXCLUSIVE lock until it commits: milliseconds, both tables small (empty on hushos.com on 2026-10-21); five-second lock timeout. Endings are locked before refunds; a refund insert landing at that instant takes them the other way round (its foreign key's check), so the two can deadlock: Postgres aborts one, and running the migration again finishes it. A null group marks a lapsed plan HushOS revoked itself (When a personal plan's payment fails, under Billing). Containers of the previous release never write one; a worker of the previous release that runs the plan-ending job for such an ending during the rollout (only once a payment arrives for a revoked plan) would refund by its own rule, prorated over the period, not the order whole, so roll the worker together with the web service. It stops the reconcile from recording a personal plan Polar answers as `unpaid`, `incomplete` or `paused` as ended; it keeps such a plan with Polar's status and reads it again on every reconcile, and a checkout revokes it at Polar first (When a personal plan's payment fails, under Billing). Storage is unchanged: such a plan gave nothing before and gives nothing now. Plans an earlier release ended so stay ended here; one Polar makes active again comes back through the customer's state on its next delivery, as before.
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

On the published images, read the release notes of every version between yours and the next one first (`https://github.com/HushOS/HushOS/releases`): an **Upgrade notes** section at the top of a release says what to do before or after moving to it (a setting to change, a migration that takes a while, a minimum client version raised). Then move `HUSHOS_IMAGE_TAG` and run `docker compose -f compose.yaml -f compose.images.yaml up -d`. Each release's **Server images** section lists the web, worker and migrate images with the digest the version tag names, to pull or pin exactly those.

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

With no `OPAQUE_SERVER_SETUP` in the environment, the web service makes one on first start and keeps it in the database; `bun run setup` generates one for the environment instead. Either way, preserve it and never regenerate it on restart: existing credentials depend on it. Prefer the environment: kept in the database, the setup sits beside the password records, and a copy of the database is then all an offline password guess needs. A production instance without it warns at start. To move one the database made, copy the `value` of its `server_secrets` row (`opaque-setup:<OPAQUE_SERVER_SETUP_ID>`) into `OPAQUE_SERVER_SETUP`. The startup plugin validates server environment with T3 Env and Zod; an invalid email adapter fails startup.

| Setting                                                                                                     | Purpose                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_ORIGIN`                                                                                                | Exact public origin, HTTPS except HTTP localhost. No path, query, or credentials.                                                                                                                                                                                                                                                                                                      |
| `OPERATOR_NAME`, `OPERATOR_JURISDICTION`, `OPERATOR_CONTACT`                                                | Optional legal name, jurisdiction and contact email of whoever runs the instance, shown on the terms, privacy and GDPR pages, for example `HushOS, Inc.` and `a Delaware corporation`; named in the terms and privacy policy.                                                                                                                                                          |
| `OPERATOR_ADDRESS`, `OPERATOR_PHONE`                                                                        | Optional postal address and phone of whoever runs the instance, shown on `/support` with the legal name and contact email. The App Store asks for a support page with both. Write line breaks in the address as `\n`.                                                                                                                                                                  |
| `SALES_CONTACT`                                                                                             | Optional email for teams and sales questions. The website's "Talk to us" writes to it; unset, there is no "Talk to us".                                                                                                                                                                                                                                                                |
| `HELP_CONTACT`                                                                                              | Optional email for people using this instance. Help in the app's account menu writes to it; unset, there is no Help.                                                                                                                                                                                                                                                                   |
| `SECURITY_CONTACT`                                                                                          | Optional email for vulnerability reports. Set, the web serves `/.well-known/security.txt` (RFC 9116) naming it, with an `Expires` six months out that moves forward each day; unset, the file is not served.                                                                                                                                                                           |
| `APPLE_APP_IDS`                                                                                             | Optional. The iOS apps allowed to open this instance's links and fill its saved passwords, as `TEAMID.bundle.id` (for example `ABCDE12345.com.hushos.app`), comma separated. Set, the web serves `/.well-known/apple-app-site-association`, and share links and app pages open in the app. Your build's Associated Domains must list `applinks:` and `webcredentials:` with this host. |
| `ANDROID_APP_PACKAGE`                                                                                       | The Android app's package; default `com.hushos.app`.                                                                                                                                                                                                                                                                                                                                   |
| `ANDROID_APP_CERT_SHA256`                                                                                   | Optional. SHA-256 fingerprints of the certificates that sign your Android build, colon separated hex, comma separated (from `keytool -list -v` or the Play Console's app signing page). Set, the web serves `/.well-known/assetlinks.json` and Android opens share links and app pages in the app.                                                                                     |
| `OPAQUE_SERVER_SETUP`                                                                                       | Optional. The server-side OPAQUE setup every password depends on. Unset, the web service makes one on first start and keeps it in the database (`server_secrets`), so it lives and dies with the database backup; set it to carry an existing setup to a new database, and never change it afterwards.                                                                                 |
| `OPAQUE_SERVER_SETUP_ID`                                                                                    | Stable identifier for that setup; default `primary`.                                                                                                                                                                                                                                                                                                                                   |
| `INITIAL_STORAGE_QUOTA_BYTES`                                                                               | Initial allowance for newly created accounts; default `2147483648` (2 GiB).                                                                                                                                                                                                                                                                                                            |
| `REFERRAL_BONUS_BYTES`, `REFERRAL_SIGNUP_CAP_BYTES`, `REFERRAL_PAID_BONUS_BYTES`, `REFERRAL_PAID_CAP_BYTES` | Referrals, paid in storage: what each side of an invite earns at sign-up (default 1 GiB), the most an inviter earns that way (5 GiB), what an inviter earns when an invitee first pays for a plan (5 GiB), and the most they earn that way (50 GiB). `0` turns a reward off. Rewards are ordinary entitlements.                                                                        |
| `TRUSTED_PROXY_HEADER`                                                                                      | Header your proxy sets with the client address, such as `x-forwarded-for`. Required behind a proxy so rate limits key on clients, not the proxy.                                                                                                                                                                                                                                       |
| `TRUSTED_COUNTRY_HEADER`                                                                                    | Header a geolocating proxy sets with the visitor's country code, such as `cf-ipcountry`; chooses the currency the pricing page shows first. Optional.                                                                                                                                                                                                                                  |
| `EMAIL_ADAPTER`                                                                                             | `smtp`, `resend`, `ses`, or `log`, which writes each message to the web service's log instead of sending it: the template's default, for a first run, never for an instance other people use. Anyone who can read that log can finish another person's sign-up, so a production instance using it warns at start.                                                                      |
| `EMAIL_FROM`                                                                                                | Sender address, optionally with display name.                                                                                                                                                                                                                                                                                                                                          |
| `SMTP_HOST`, `SMTP_PORT`                                                                                    | SMTP endpoint; local defaults `127.0.0.1:1025`.                                                                                                                                                                                                                                                                                                                                        |
| `SMTP_SECURE`, `SMTP_REQUIRE_TLS`                                                                           | Implicit TLS and required STARTTLS respectively.                                                                                                                                                                                                                                                                                                                                       |
| `SMTP_USER`, `SMTP_PASSWORD`                                                                                | Set both if SMTP requires authentication.                                                                                                                                                                                                                                                                                                                                              |
| `RESEND_API_KEY`                                                                                            | Required for the Resend adapter.                                                                                                                                                                                                                                                                                                                                                       |
| `AWS_REGION`                                                                                                | Required for SES. The AWS SDK supports workload credentials or environment credentials.                                                                                                                                                                                                                                                                                                |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`                                           | Optional explicit AWS credentials; access key and secret must be supplied together.                                                                                                                                                                                                                                                                                                    |

### Mail in development and production

- The development override runs Mailpit at SMTP port 1025 with its inbox at `http://localhost:8025`. `bun run infra:up` starts it with PostgreSQL.
- For a local full-stack preview use `docker compose -f compose.yaml -f compose.dev.yaml up -d --build`; the override points container SMTP to `mailpit`.
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

### Link tokens and access logs

A link's token names the link to the server, and whoever holds it can fetch the link's encrypted tree (the key to open it stays in the fragment). The API takes it only in the `x-link-token` request header, never in a path, so it does not land in a proxy's access log through the API. A proxy must pass that header through unchanged. A client from before this release used paths with the token in them; those paths now answer 410 "Update HushOS to open links".

The page itself is still `/s/<token>`, so the token is in the path of that one request. The app's own logs record it as `/s/:token`. Keep `/s/` out of your reverse proxy's access logs too, or log those requests without the path. With nginx:

```nginx
location /s/ {
    access_log off;
    proxy_pass http://127.0.0.1:5173;
}
```

Caddy 2.8 and later: `log_skip /s/*` in the site block.

A link page does not ask for the session until the visitor chooses to sign in or save a copy. The request for the page itself is a top-level navigation, so a visitor who is signed in to this instance sends their session cookie with it, and the server could tie that request to their account.

### Live folders

Open folders stay current without a reload. While the tab is visible, the app polls every eight seconds:

- the workspace's change feed, `GET /api/drive/workspaces/:id/changes?since=`;
- the feed of every share it holds, `GET /api/drive/shares/:id/changes?cursor=`, which answers 410 once the share ends. It carries only changes inside the share, deletions included, with an opaque cursor sealed by the server and bound to the share, so a grantee learns nothing of the rest of the owner's drive or how often it changes.

Only the folders a change touched are refetched. A poll with nothing new costs one row.

### Stopping a share or a link

Stopping cuts the server off at once and then rotates keys. The owner's device gives the shared item and everything beneath it fresh keys and re-seals what is still shared (remaining shares, remaining links, every version's content key), so whoever was cut off holds no key that still opens anything.

- Rotation runs in the background of the owner's tab in batches of 200 nodes. If the tab closes first, it resumes the next time that account opens Drive.
- While it runs, nothing can be moved out of the rotated folder.
- Objects are never re-encrypted. The guarantee is that a former member gets nothing further from the API and, once any download URL they held has expired (fifteen minutes for shared content), nothing further from the store.
- A password link made before this release cannot be re-sealed without its password and is stopped by the rotation; its owner makes a new one.

### No sharing in family folders

Family folders take no shares or links (docs/groups-design.md 3.4). The web never offered Share there, and the server now refuses to make a share or link in one, or to seal one again or change its password or expiry, with 409 `family-sharing`; stopping one still works. A server of an earlier release with families on (`GROUPS_ENABLED`, on by default) accepted them from any API client, though no HushOS app made them. The web and native apps refuse to re-key an item that has one, so a key change below the folder's top level stops (the web says "An item in this family folder has shares or links") until they are stopped. To find any (hushos.com, with families off, has none):

```sql
select 'share' as kind, s.id, s.workspace_id, s.node_id from drive_shares s
  join workspaces w on w.id = s.workspace_id
  where w.owner_kind = 'group' and s.revoked_at is null
union all
select 'link', l.id, l.workspace_id, l.node_id from drive_links l
  join workspaces w on w.id = l.workspace_id
  where w.owner_kind = 'group' and l.revoked_at is null;
```

Stop each through the API (`DELETE /api/drive/shares/:id` or `/api/drive/links/:id` with `{ workspaceId }`, as any member of the family), which also marks the folder due for a key change so whoever held it is cut off. Stopping them in SQL instead must set `rotation_due_at = coalesce(rotation_due_at, now())` on the folder's `workspaces` row too, or the recipient keeps a key that opens it.

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

The reporter's device seals the item's key to the identity key of every current operator (a sealed box per operator), so the server stores only sealed copies and the operators alone can open them. That key is the item's node key: it opens everything beneath the item, every version of a file, and anything the owner adds under it later, not only the snapshot below. The operators are the ones the server lists, which is to say whoever runs the instance. An instance with no operator takes no reports; grant one first. An operator promoted later cannot open reports filed before the promotion, since nothing was sealed to them; another operator can.

### What a report holds

- The category and the reporter's reason.
- Who reported: the account and the share they saw it through, or an optional email and, for an anonymous visitor, an HMAC of their address, used to allow one open report per address and node. All of it, and the reason, is deleted when the report is released.
- Whose files they are, and how the reporter could see them.
- No digest of the content. An operator who needs one (to file with an authority, say) works it out on their own device from the opened file, with SHA-256 on the report page, for files up to 64 MiB.
- A snapshot of the reported subtree: every live node beneath the reported one, up to 2,000, with the envelopes and object framing needed to open it later. The snapshot is what makes a report outlive the owner's deletions.

The address HMAC, and every rate-limit bucket built from an address, an email or an account, is keyed under the server hash key, which is never written to the database: a plain hash of an IPv4 address is undone in seconds, and a key kept beside the hashes would undo them as quickly. With `OPAQUE_SERVER_SETUP` in the environment the key is derived from it (HKDF-SHA-256), so every web process and every restart agree. Without it each process makes its own at random: rate limits then count per process, and both they and the one-open-report check start over when the process restarts. Set `OPAQUE_SERVER_SETUP` for an instance that runs more than one web process.

### Triage

Reports are triaged at `/app/admin/reports`. The queue orders open reports by age and shows a clock per category: one hour for terrorist content, 48 hours for intimate images, a day for child sexual abuse material, longer for the rest. These are defaults for ordering, not legal advice.

Opening a report's content decrypts on the operator's device under their own identity and writes a "viewed" entry to the report's record. Every action is on the record with who took it:

- Dismiss.
- Remove the content: trashed in the owner's workspace where they cannot restore it, with every share and link on it revoked, in the same step that closes the report.
- Mark as filed with an authority and their reference.
- Keep on or release a hold.
- Suspend or reinstate the uploader. Their sessions end at once and sign-in is refused until reinstated.
- Add a note.

Only an open report is resolved. A closed report that is still held is reopened first, then resolved again; a released one is not resolved at all.

### Holds and evidence

While a report is open, and afterwards for as long as it is held, the deletion outbox leaves the reported objects in the primary bucket whatever the owner does, and the operator reads them from there. A report marked filed is always held. A report closed without a hold (dismissed or removed), or whose hold is released after it closed, is released, and release is final: it cannot be resolved again, held, reopened, re-sealed to a new operator or read again, and a report about the same thing must be filed anew. The report records when it was released, and every one of those actions checks that under a lock on the report, so two operators acting at once cannot undo it. A release:

- lets the bytes go to ordinary deletion;
- deletes the operators' sealed copies of the item's key;
- deletes who reported it (the account and the share it was seen through, or the anonymous reporter's address HMAC and email), the reason in the reporter's words, and the uploader's email;
- clears the snapshot's envelopes, signatures and signers;
- deletes the report's evidence requests, and has the worker delete its evidence copy.

The category, the record of what operators did (the "reported" entry loses its actor), and the snapshot's shape stay: the worker needs its object ids to find the evidence copies it deletes.

The release ends the server's part, not what an operator kept. An operator who opened the report had the item's node key on their device and could have kept it; that key opens the item, every version, and everything the owner adds beneath it later, for anyone who also has the ciphertext. Whoever runs the instance should treat operator devices accordingly.

Optionally, the worker also copies every reported object to a separate evidence bucket within five minutes of the report, under `reports/<reportId>/<objectId>`, and deletes the copies of every released report, however it closed. A report released before the worker reached it is never copied.

- Give that bucket its own credentials and set them on the worker only, so a compromised web container cannot reach it.
- Turn on object lock or a retention rule there where the provider offers one.
- Without these settings every report shows "no evidence store configured" and the hold is the only preservation.

The operator reads the evidence copy from the report page ("Fetch from the evidence store"):

1. The web service records a request.
2. The worker answers it within seconds with a presigned URL per object, fifteen minutes long.
3. The operator's browser reads the objects from the evidence bucket directly, decrypting on their device.

That is how a held report stays readable if its primary copy goes missing, without the web service ever holding the evidence credentials; once the report is released, no request is taken, answered or served. It means the evidence bucket's endpoint must be reachable from the operator's browser, not only from the worker, and needs a CORS rule allowing `GET` with the `Range` header from `APP_ORIGIN`, the same rule as the primary bucket.

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

Every response carries `x-hushos-release`, the git commit the image was built from (`HUSHOS_RELEASE_SHA`, set by the published images), and `x-hushos-version`, the product version the build carries (from `package.json` at build time; between releases, the last release's). An open tab asks `/api/ready` for it every minute while visible, when it comes back into view and on navigation. After a deploy the tab reloads itself at the next quiet moment: at once on a public page, on the next navigation from a sign-in form, and in the app once no upload is running, with a banner until then.

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

| Setting                | Purpose                                                                                                                                                                                                                                                                                                                           |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BILLING_PROVIDER`     | `none` (default) or `polar`.                                                                                                                                                                                                                                                                                                      |
| `POLAR_ACCESS_TOKEN`   | Organisation access token with `checkouts:write`, `customers:read`, `customers:write`, `customer_sessions:write`, `subscriptions:read`, `subscriptions:write`, `orders:read`, `products:read`, with families on `members:write`, `refunds:read` and `refunds:write`, and, for affiliates, `discounts:read` and `discounts:write`. |
| `POLAR_WEBHOOK_SECRET` | Secret of the webhook endpoint pointed at `https://<APP_ORIGIN>/api/billing/webhook`.                                                                                                                                                                                                                                             |
| `POLAR_ENVIRONMENT`    | `production` (default) or `sandbox`. Tokens and webhook secrets are specific to each environment.                                                                                                                                                                                                                                 |
| `BILLING_GRACE_DAYS`   | Days an allowance outlives its billing period, so a late renewal or a payment retry does not cut anyone off. Default `3`. A plan whose retries ran out (`unpaid`), whose first payment never went through (`incomplete`) or that is paused gives nothing from the reconcile that sees it.                                         |

### Plans are Polar products

Prices and names are edited in the Polar dashboard, never in code.

- `bun run polar:seed` creates the launch catalogue (Plus, Pro, Max; monthly and yearly) in whichever organisation `POLAR_ACCESS_TOKEN` belongs to, skipping products that already exist. With `--update` it also brings existing products' prices, descriptions, and metadata in line with the script, replacing a changed price for new checkouts while current subscribers keep theirs. The token needs `products:write` for those runs.
- Each product carries one fixed price per currency, with the organisation's default currency (USD) required and the others optional. Polar charges a customer in their local currency when the product has one and falls back to the default otherwise. The pricing page shows the same currency, chosen from `TRUSTED_COUNTRY_HEADER`, then the browser's language, with a selector to change it. The currencies and amounts live in the seed script's table.
- A product is offered as a HushOS plan when it is recurring, has a fixed price in the default currency, and carries two metadata keys: `hushos_plan` (any value) and `quota_bytes` (the storage it grants, as an integer). Monthly and yearly are separate products.
- A product that also carries `hushos_group_kind` is a group plan and is never offered as a personal one. A **family plan** has `hushos_group_kind: family`, `hushos_plan`, `quota_bytes` (the whole family's pool, the same whatever the member count) and `included_members`. Per currency it has one fixed base price and one graduated unit price: the first tier free up to `included_members`, the second the per-member rate with no upper bound, and `minimum_units` equal to `included_members`. Polar checks only that currencies share that structure, so HushOS drops a family product whose currencies disagree on the free tier's bound or the minimum, whose bound differs from `included_members`, whose per-member amount is not a whole number of minor units, or that carries `quota_bytes_per_member` (reserved for company plans, whose pool grows per member). A family product may also carry `hushos_tier` (`plus`, `pro` or `max`); one with any other value is dropped, and one without it is read as the single Family plan from before the tiers, which the pages stop offering as soon as any tier is on sale (families on it keep it). `bun run polar:seed` creates the three tiers, monthly and yearly: Family Plus (800 GB), Family Pro (2 TB) and Family Max (4 TB) at 10, 20 and 30 USD a month (the same in EUR; 8, 16 and 24 GBP; 399, 799 and 1,399 INR), four members included, then 1.50 USD or EUR, 1.20 GBP or 59 INR a member. A year is a round total that splits into twelve: 96, 192 and 288 USD or EUR, 72, 144 and 216 GBP, 3,900, 7,800 and 13,800 INR, with a member past the included ones at ten months (15 USD or EUR, 12 GBP, 590 INR); personal plans likewise cost 48, 96 and 144 USD or EUR, 36, 72 and 108 GBP and 1,980, 3,900 and 6,900 INR a year. The prices are in `packages/billing/src/seed-prices.ts`. Before it calls Polar, the script refuses a yearly price that doesn't split into twelve whole units of its currency, or that costs more than ten months (the pages say "2 months free"). Those are HushOS's own pricing rules, not the app's: to price otherwise, change `priceProblem` in that file. With a year that doesn't split, the pricing page shows every yearly price in that currency as a yearly total, and with one dearer than ten months it drops the saving label everywhere. A changed price reaches Polar only with `--update`, for new checkouts and plan changes; subscribers keep the price they have. `--archive-legacy-family` then archives the single "Family (monthly)" and "Family (yearly)", only once all six tier products exist; families already on them keep them. It runs only when you run it, and the archive needs `products:write`.
- Archiving a product hides it from the pricing page while existing subscribers keep it.

### Family plans

With `BILLING_PROVIDER=polar` and `GROUPS_ENABLED=true`, a family's storage and seats come from its plan instead of `GROUP_AREA_QUOTA_BYTES` and `GROUP_SEAT_LIMIT_DEFAULT`:

- Each family is one Polar team customer, external id `group:<groupId>`, created when a member holding the family's `billing` role starts checkout. That member is the team's owner (external id: their user id) and the family's payer. Polar is told the family is a "HushOS family", never its name or its members.
- The plan's `units` is the number of places bought. A family without a live plan has one place (its organizer) and an empty pool, so nothing is stored in its folders free. Every folder of a family draws from the one pool, and so do its members' own files (My files) while the plan is live, which is until its period ends plus `BILLING_GRACE_DAYS`: each member's own allowance (the free base, referral bonuses, operator grants) is set aside, not added, and counts again the moment they leave, are removed or the plan ends. Someone whose files then take more than their own allowance can still read, download and delete everything; uploads are refused until they make room or buy a plan, and nothing is deleted. A family's managers (the organizer and anyone holding `members` or `billing`) see each member's own usage rounded up to the whole GiB, never names, counts or contents; every member sees the family's total and the family folders' total, counted part by part in whole GiB, so no figure gives away one person's exact usage. A member who pays for a personal plan draws from the pool too, from the moment they're let in (or the family's plan goes live). Letting someone in is refused (`409 pool-full`) when their own files are more than the pool has free (docs/families-shared-pool.md 3).
- Only the payer adds places. A place is charged at once, prorated by the second, and the newcomer is let in only after Polar accepts the charge: a declined card (402 `PaymentFailed`) changes nothing at Polar or here and is reported as such, and a bank that wants the payer to confirm (402 `PaymentActionRequired`) sends them to the portal. A place opens only once it is paid for: HushOS counts the places Polar holds as paid only while no order of the plan waits for payment (`orders:read`), so a raise awaiting the bank opens nothing until its `order.paid` arrives or the next reconcile finds it paid. HushOS refuses a family above 20 members or a raise of more than 5 places at once, since Polar caps neither.
- The payer moves the family between tiers billed the same way. A bigger tier starts at once: the product changes at Polar with `invoice` proration, so the difference for the rest of the period is charged now, and a refused charge changes nothing. A smaller tier starts at the end of the period (`next_period`), refunds nothing, and is refused while the family (its folders and its members' own files) stores more than its pool. Places carry over. The tier a family has paid for, and so its pool, comes from Polar's orders, re-read on every reconcile: the product of the subscription's newest paid, unrefunded checkout, renewal or change order. A paid upgrade gives its tier; an unpaid one leaves the last paid order's tier in force (the pool is the lesser of that tier's and the product's, so a smaller tier at a renewal counts at once); a paid renewal of the bigger tier gives it even while the change order still waits; a refund in full (status `refunded`, or refunds reaching what the order charged) falls back to the order paid before, while a partial refund keeps the tier. If an unpaid upgrade's paid plan is no longer offered (archived), nothing is scheduled: the family keeps the smaller storage and is listed under **Plan changes stuck** with the reason, until the upgrade is paid or the plan is set by hand. No place can be bought while the product differs from the tier paid for, read from Polar's orders just before. A place purchase and an upgrade never run at once for a family: each holds a two-minute claim on the family's row, and the other is told "Another change to this plan is in progress. Try again in a moment." A raise Polar bills on a product other than the one it was asked on (the plan changed in the dashboard meanwhile) lets nobody in, and its order is recorded as never paying for a tier. If the product has been bigger than the tier paid for for more than 7 days (from the oldest unpaid change order for it, or from when HushOS first saw the difference), the plan is moved back to the tier paid for at the end of the period, and the move withdrawn as soon as the two match. A plan first seen with nothing paid has no pool until it is. Keep "Enable subscription unit changes" off in the dashboard (confirmed off in the sandbox, spike E7), so no portal raise makes an order HushOS didn't ask for. Polar keeps a scheduled move and a scheduled cut side by side, one call each; an upgrade drops both, so HushOS records them and asks again for the cut (not the move, which the upgrade replaced). A re-issue is sent only when Polar holds something else. A reconcile within 15 minutes of the same re-issue sends nothing and queues a retry for when the window ends, so the deliveries a re-issue causes never repeat it and a needed one is not lost. Retries go to `billing.reissue-pending`, a `stately` queue keyed by the family, and the family's row also claims its one pending retry, so a family never has more than one. A re-send that fails (Polar down, a 5xx, a timeout) is retried with backoff for as long as it takes, up to six hours apart. Only answers of 200 that Polar then didn't keep count: after 5 in a row HushOS stops, logs `Family plan’s scheduled change given up: Polar would not keep it` at error level, and lists the family under **Plan changes stuck** on the management page (Management, `/app/admin`), with the change it wanted. Set the change on the subscription in the Polar dashboard; the row goes, and the count starts again, once Polar holds it. If a retry can't be queued (the worker hasn't made `billing.reissue-pending` yet after an upgrade), the family's claim is let go so the next reconcile queues it. `billing.reissue-cut`, the queue before it, is still worked so jobs already in it drain; it can be deleted once empty.
- **An upgrade paid after its revert took effect is not credited back.** If an upgrade's order was paid only after the 7-day rule had moved the family back at a renewal, the family is on the smaller tier and Polar has the money for the bigger one. HushOS logs `Unconfirmed upgrade reverted at the period end` when it schedules the revert; to refund, open the subscription's `subscription_update` order for the bigger product in the Polar dashboard (Sales → Orders, filter by the customer `group:<groupId>`) and refund it, in full or for the part of the period the family did not have, or call `refunds.create` with that order's id. The payer can also choose the bigger tier again.
- Fewer places take effect at the end of the period, never below the members already in the family or the plan's included count, and block new admissions from the moment they are made. A raise deletes a scheduled cut at Polar, so HushOS records the cut and schedules it again; if Polar refuses, the worker retries it (`billing.reissue-cut`, with backoff) and the daily reconcile asks again until it is in place.
- While a family's plan is live (active and not set to cancel), its payer cannot delete their account, leave the family or be removed from it, even when another member holds `billing`, and nobody can dissolve the family by leaving last or deleting their account. They are told to cancel the plan first; handing billing over is not built yet. Cancelling (at the end of the period, in Polar's portal) frees the payer at once: they can leave, be removed or delete their account, and the family keeps its paid places and pool until the period ends, when the plan ends as any other does (`BILLING_GRACE_DAYS` covers only a renewal that is late, not a plan that has ended). A payer who is no longer a member can still open the portal and schedule fewer places while the plan is live, so they can always stop paying.
- A live plan whose payer's account is gone (a checkout paid after they deleted it) is revoked at Polar as soon as a sync or a delivery sees it, and logged. A plan already set to cancel runs out instead.
- **A family plan whose payment failed, or that is paused** (`unpaid`, `incomplete`, `paused`) gives the family no pool and no extra places from the reconcile that sees it, and the family page says so: "Family Pro's payment didn't go through", with the way forward for whoever reads it (the payer: choose a plan, or the billing portal if it offers to retry the payment; another `billing` holder: choose a plan, and pay from then on; a member: a plain statement, no payment actions). Polar still holds such a plan, so it is revoked before anything could leave it charging beside another plan, or on the card of someone who has gone: before a family checkout (and the payer takeover in it), before its payer leaves the family or is removed, before its payer's account is deleted, and by the job for a dissolved family (Dissolved families, below). They are found in the mirror and in Polar's list of the team customer's subscriptions (one whose delivery never arrived, which is then written to the mirror; one whose product the catalogue can't read, archived or edited, is written as it stands, giving nothing, named "Family plan" on the page rather than by Polar's product id, and kept as Polar has it by every reconcile, so it leaves the page once ended and a payment on it is the family's). Each is read again first, and any plan live at Polar (paid again in the portal, or a past-due one the mirror missed, which Polar's customer state doesn't list) is the family's plan: the checkout is refused and the plan written to the mirror. A checkout ends them only once the person has confirmed them in a dialog that says they end now, even if the checkout isn't finished; the request carries the ids of the plans the dialog showed, and is asked again (`ends-lapsed`), after the family is read again, unless every plan found is among them (one the page still showed that has ended since is no matter). They are ended before a payer takeover changes anything at Polar, so a revoke Polar refuses leaves the payer as they were, with the plan still on their card for their own leave and deletion; a takeover that fails after the revoke leaves the plan ended, as the dialog said. A leave and a removal each end the plan only once confirmed, by plan id: the call carries `endsLapsed` (the ids of the plans the person was shown), and unless every such plan the person pays for is among them the server answers `ends-lapsed` with each plan's id, name and standing, ending nothing, and the dialog names them and asks again. A leave runs the leave's own rule first (a leave it refuses ends nothing); its dialog names the plan up front, for a payer whose `billing` was taken too (a member's summary says whether they pay for it, with the ids only for that person). A removal asks first (`POST /api/groups/:id/members/:userId/remove-preview`, for `members` holders: it changes nothing at Polar, though it may write the family's plans it finds to the mirror, and it refuses at once a payer of a live plan), before any demotion, hold or folder walk, so cancelling changes nothing; the question and every leave or removal of a payer read Polar, so they are paced at twenty a person a family every ten minutes; and it ends the plan only after every check of the call and every rule of the write itself, run first in a transaction that is rolled back (so removing the family's only `billing` holder, or a member list a departure overtook, ends nothing); only a race between that preview and the write can refuse it after the revoke, and the retry removes them. The member list doesn't offer to remove the only `billing` holder: it says someone else must be made the organizer first. A payer whose plan Polar shows live again and not set to end (paid in the portal a moment ago, before its delivery, or resumed while HushOS was ending it, which the revoke then leaves alone) can't leave (unless they are the last member, when the dissolved family's job sets it to end), be removed or delete their account: told that it runs, on their card, to cancel it in the billing portal at hushos.com or contact support (words that work in the apps and where the family's page doesn't open), and the family is read again. A live plan on a product the catalogue can't read is never written to the mirror as live, since it would become the family's plan with no pool and one place; its payer is told the same, and support resolves it in Polar. Polar refusing to list or read the family's plans for this lookup refuses the change; a 4xx other than 404 (a token without the scope, a request Polar rejects) is also logged at error level each time (`Polar refused to read a family’s plans; checkouts, leaves and removals wait`), since one that lasts refuses every such change for every family until it is fixed. Every refusal (a period Polar shows paid, locked, any other 4xx, no answer) is logged once at error level with the subscription (as `A lapsed family plan could not be revoked`, or, locked, with Polar's reason) and listed on the management page under **Lapsed plans not ended** until a revoke lands or the plan is no longer lapsed (live again, or ended), since what asked for it (a deletion, a leave, a new plan) waits on it. Never ended, by a checkout, a leave, a removal or a deletion: an `incomplete` plan younger than a day (a checkout still waiting on the bank: Polar documents no window, and Stripe, under it, expires an incomplete first payment after 23 hours), and an `unpaid` plan whose current period has a paid order (a payment Polar hasn't applied, or a failed seat-change invoice marking the whole plan unpaid): both are refused with what to do instead. A locked plan says "Polar is still working on a change to the family's Family Pro plan, so it can't be ended yet." and logs `A lapsed family plan could not be revoked: Polar says it is locked` at error level; a 5xx or no answer refuses but keeps the ending. The ending is written before Polar is asked, keyed by the family's id (`personal_plan_endings.user_id` is then the family's id, `group_id` null; whether an ending is a family's is told by the subscription's row in `group_billing_subscriptions`), with the orders already paid noted as used. A payment Polar takes for the plan afterwards is refunded whole by the `billing.end-personal-plan` job, run for the family, comment "Paid after HushOS ended this plan, which no longer runs", retried, and listed under **Refunds owed** (as "family <id>") after five failures. If Polar still shows the plan running (the revoke never landed and the payment restored it), the ending is dropped and the payment is the family's: its affiliate commission (by its discount only, as a family's delivery earns it) is granted by the job.
- **More than one plan** on the management page lists every family and every account with more than one subscription that can still charge (live, or unpaid, incomplete or paused; a live one already set to end at its period's end is left out, since it charges no more unless resumed), with their statuses: a double charge, or one waiting to happen. Check them in Polar's dashboard.
- A raise whose order has waited more than 7 days for the bank (an unanswered 3-D Secure or e-mandate prompt) is cut back, at the end of the period, to the places paid for, and the cut is withdrawn if the order is paid later. A raise made within 7 days of a renewal can therefore be billed once at that renewal before it is cut back. The order itself stays at Polar.
- A subscription whose product HushOS can no longer read (its metadata or prices edited so the catalogue drops it) is left as it was and logged: the family keeps its places and pool, and its payer stays the payer, until the product is fixed.
- Switching back to `BILLING_PROVIDER=none` stops reading pools: every family folder falls back to its own allowance, which is 0 for folders created while billing was on, so their owners can read, download and delete but not upload until an operator grants storage to those workspaces (see the admin storage grants). Seat limits a plan wrote stay as they were. `group_storage` and the billing tables are left in place and are read again if billing returns.
- **A member who pays for a personal plan** stops paying for it when their files join the pool: once let in (or once the family's plan goes live), the worker's `billing.end-personal-plan` job revokes their personal subscription at Polar at once and refunds the unused part of the current period, prorated by the second from the revoke, on every order that paid for that period (a renewal, and a mid-period upgrade's change order), before tax: every order's unused share summed (a mid-period downgrade's credit taken off, an upgrade paid from that credit added), each order's share of its net amount less other people's pending or succeeded refunds, rounded down, and placed on the orders at most what Polar will refund on each (net amount plus any balance applied); Polar refunds the matching tax itself and keeps its own fee. Credit left in the customer's balance is not paid out. An order paid after HushOS saw them pooled (a renewal that slipped past the revoke) is refunded whole. Each refund carries HushOS's key in its `hushos_refund` metadata and is matched against the order's refunds at Polar before every call, so retries, replayed deliveries and the daily reconcile never refund twice. One person's runs never work one plan at once: each holds a two-minute lease on the plan's row, on the database's clock, renewed between steps and checked before every refund (rows, not an advisory lock, so it holds behind a transaction-mode pooler). After a refund call that timed out or got a 5xx, HushOS doesn't ask again for 10 minutes, since Polar can still make it. What Polar won't refund on the period's orders (as when the customer's balance paid them) is refunded on the customer's earlier card-paid orders, newest first, within what Polar takes back on each, counting refunds already made first; unspent balance is never paid out. A disputed order's share is dropped, never moved. An earlier order that fails five times in a row (a charge too old for Stripe comes back from Polar as a 500) is given up and listed under Refunds owed. What no order can carry, and what a dispute dropped, is logged and listed under **Not refundable through Polar** on the management page, for an operator to decide. A failure is retried ten times over about a day; a refund that fails five times in a row is listed under **Refunds owed** on the management page, with the order and amount, logged at error level, and asked for again at most once a day, until it lands or an operator refunds it by hand in Polar's dashboard (any refund on the order from HushOS's first ask on, with or without its key, counts as HushOS's; a pending refund, anyone's, keeps the order open, so one that later fails is owed again). A personal plan Polar answers as `unpaid`, `incomplete` or `paused` is revoked by this job with nothing refunded, since nothing paid for it is still in force (When a personal plan's payment fails, below); a payment Polar takes for it afterwards is refunded whole. While their files draw from a family's pool, buying or resuming a personal plan is refused (`409`, `code: in-family`). Someone who leaves before the job runs keeps their plan. The token needs `refunds:read` and `refunds:write` for this; without them plans are still ended and every refund is listed as owed.
- The token needs no scopes beyond those above. In the dashboard, keep "Enable subscription unit changes" off, so every change of places goes through HushOS's checks.

### Webhooks and reconciliation

Subscribe the webhook endpoint to the `customer.*`, `subscription.*`, `order.*` and `refund.updated` events (the last tells HushOS at once when a refund it made fails after it succeeded; without it the daily reconcile finds it, up to a day later). Set its API version to `2026-10`, the version HushOS calls the API with: Polar shapes webhook payloads by the version set on the endpoint (its `api_version`), never by the client's, and changing it affects only events created afterwards. Every delivery is verified with the Standard Webhooks signature, recorded by its message id, and answered by re-reading the customer's state from Polar, so duplicate, reordered, or missed deliveries cannot corrupt local state. The worker also re-reads every billing customer once a day. Both the web and worker services need the billing settings.

Polar releases an API version each quarter and removes a deprecated one at the next release. `2026-04`, which HushOS used before, became deprecated when `2026-10` became Current on 1 October 2026, and by Polar's schedule goes at the January 2027 release, so an endpoint still on it must be moved before then.

### When a subscription ends

Its entitlement is revoked and the allowance returns to the base quota; content is never deleted or made unreadable. Deleting an account revokes every personal plan that can still charge (the customer's active and trialing plans, every subscription Polar lists for the customer that hasn't ended, and every one the mirror holds as not ended: past due, unpaid, incomplete, paused) and deletes the Polar customer first, and refuses to proceed if Polar cannot be reached.

### When a personal plan's payment fails, or it is paused

What each Polar status means for a personal plan:

| Polar status                                                                               | Storage                                                     | Mirror                                               | Billing page, checkout                                                                                                                                           |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `active`, `trialing`                                                                       | the plan's, until its period ends plus `BILLING_GRACE_DAYS` | kept                                                 | the current plan: switching changes it in place, prorated                                                                                                        |
| `past_due` (Polar retrying a renewal)                                                      | the plan's, until its period ends plus `BILLING_GRACE_DAYS` | kept                                                 | the current plan, shown as payment overdue with Update card                                                                                                      |
| `unpaid` (Polar's retries ran out), `incomplete` (a first payment that never went through) | Free's, from the reconcile that sees it, mid-period too     | kept with Polar's status, read again every reconcile | not the current plan: Free, with "the payment didn't go through", a new plan (which revokes this one first), or Polar's portal if it offers to retry the payment |
| `paused`                                                                                   | Free's, from the reconcile that sees it                     | kept, read again every reconcile                     | not the current plan: Free, with "paused", Resume in portal or a new plan, which revokes this one first                                                          |
| `canceled`, `incomplete_expired`, or gone at Polar (404)                                   | Free's                                                      | recorded as ended (Polar's `ended_at`, or now)       | Free                                                                                                                                                             |

- **The grace days** stretch a period that ran out (a renewal that is late while Polar retries), not a payment that has lapsed. That matches the terms ("If payment still fails, the plan ends and your allowance returns to the free tier"): from the person's side an `unpaid` plan has ended, though Polar may still take the payment.
- **Nothing is deleted** when storage drops to Free. Someone over it can still read, download and delete everything; uploads, and anything else that adds to the space, are refused until they make room, pay or choose a plan. Trash and earlier versions are purged after 30 days whatever the plan, as always, and the storage-full dialog removes them only on a click.
- **A new checkout revokes a lapsed plan first.** Polar's portal can retry what is owed when a card is added (it does for `past_due`), and a paused plan resumes on its date, so leaving one beside a new plan could charge for both. Before a checkout, HushOS reads each `unpaid`, `incomplete` or `paused` personal plan at Polar; one Polar shows live again (paid in the portal a moment ago) is the current plan, and the choice switches it in place, prorated. Otherwise it records the ending and the orders already paid, reads the plan again (one paid in between is kept and switched in place, never revoked with that payment counted as used) and revokes it. Gone at Polar (404) or already ended is nothing to do. A family ending its owner left before it was revoked is dropped and taken over. A refusal Polar answers (a 4xx: 403 without an end, 409 `SubscriptionLocked`) refuses the checkout and leaves the plan its owner's; a locked plan says "Polar is still working on a change to your Pro plan, so it can’t be ended yet. Try again later, or contact support." and logs `A lapsed personal plan could not be revoked: Polar says it is locked` at error level. A 5xx or no answer at all (a timeout) also refuses the checkout but keeps the ending, since the revoke may have landed; the plan-ending job reads Polar before refunding anything. An unpaid or incomplete plan whose current period already has a paid order not refunded whole (a payment Polar hasn't applied to its status yet) is never revoked; this assumes Polar starts a new period when a renewal fails, not yet confirmed in the sandbox: the checkout says "Polar shows a payment for your Pro plan that hasn’t taken effect yet, so it can’t be ended. Try again in a few minutes, or contact support." A checkout while the plan-ending job holds the plan's ending is refused ("still being ended"), so the two never work it at once. Nothing paid for is still in force: Polar pauses a plan only at the end of a period, which was used in full, and a resume (on its date, or by hand) starts a new period and charges for it at once (Polar's Managing subscriptions page); an unpaid plan's renewal and an incomplete plan's first payment were never paid. The billing page asks first ("Choose Max? 1 TB for $15 a month. This ends Pro, whose payment didn't go through, then opens Polar's checkout"), including when the person arrives from the pricing page or from a plan chosen at sign-up.
- **A payment taken after HushOS revoked a lapsed plan is refunded whole.** The ending is written before Polar is asked (`personal_plan_endings.group_id` null, settled) with every order already paid noted `none`. An `order.paid` for an order of that plan that wasn't paid then (paid in the portal, or a dunning email answered) is noted and the ending opened again in one transaction, and the worker's `billing.end-personal-plan` job decides. If Polar shows the plan ended, the order is refunded whole, before tax (Polar refunds the tax), comment "Paid after HushOS ended this plan, which no longer runs", keyed and retried as every plan-ending refund is; after five failures in a row it is logged at error level and listed under **Refunds owed**. Gone at Polar (404) counts as ended. If it still runs, the revoke never landed and the payment restored a plan its owner kept: the ending is dropped and, in the same transaction, its noted orders are settled `none` (no later lapsed ending of the plan refunds them) and marked `rewards_pending`: their affiliate commission and the inviter's referral reward, which the delivery held back, are granted by the job after it refreshes the person's plans, and by the next run (the daily reconcile queues it) if granting fails. The mark is apart from the refund's status, so a family ending that later refunds part of the order doesn't erase it. If its owner joins a family while the plan runs again under such an ending, the job drops it first, so the family's ending takes the plan over in the same run. A redelivery of an order noted and never worked queues the job again. An ending isn't closed while a payment noted on it is still unworked, so one that lands while the job runs is refunded by its retry. A late delivery of an order already paid at the revoke (a paused plan's last period, used in full) is left alone and earns its commission as usual. A part paid from the customer's balance isn't moved onto earlier card orders; it is listed under **Not refundable through Polar**.
- **Someone whose files join a family's pool** has a lapsed personal plan revoked by the same job, with nothing refunded, for the same reason (nothing paid for is still in force), and recorded the same way, so a payment taken for it afterwards is refunded whole. A paused plan left alone would resume on its date and charge, only to be refunded with Polar keeping its fee. An ending its owner's leaving dropped, or an earlier lapsed one whose revoke never landed, is taken over. A lapsed plan Polar won't revoke (locked, an outage) is logged and retried without holding back the person's other endings. The family screens say so before they pay or are let in ("Your Pro plan, whose payment didn't go through, ends when the family's plan starts. Nothing is refunded: no part of it is in use.").
- **Untested at Polar:** whether its portal takes a payment for an `unpaid` plan (as it does for `past_due`) is not documented, and the sandbox hasn't been tried; if it doesn't, choosing a plan is the way back. Polar's docs also disagree on whether dunning ends in `unpaid` or `canceled`; both are handled.
- **Plans not revoked:** a lapsed plan whose owner never starts another checkout, isn't pooled and doesn't delete their account stays at Polar until Polar ends it. It gives nothing meanwhile. It comes back if its owner pays in the portal, resumes it, or, for a paused plan, when Polar resumes it on its date; Polar then charges for a new period, and the reconcile gives its storage again.
- **A plan change left unpaid (untested at Polar):** if a mid-period upgrade's invoice is never paid and Polar then answers the whole plan as `unpaid`, the storage the person had paid for at the old tier stops at once too, and nothing of that period is refunded. Whether Polar ever does this for a change invoice is not known.

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

| Variable                                                                                                                                                                                 | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STORAGE_INTERNAL_ENDPOINT`                                                                                                                                                              | Optional. Where the web and worker services reach the store when that differs from the browser's URL: `http://garage:3900` for the bundled Garage inside Compose. Presigned URLs keep `STORAGE_ENDPOINT`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `STORAGE_ENDPOINT`                                                                                                                                                                       | Public S3 endpoint URL the browser can reach                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `STORAGE_REGION`                                                                                                                                                                         | Region the endpoint expects (`auto` for R2, `us-east-1` for the bundled Garage)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `STORAGE_BUCKET`                                                                                                                                                                         | One bucket per instance                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`                                                                                                                                     | Credentials scoped to that bucket                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `STORAGE_FORCE_PATH_STYLE`                                                                                                                                                               | `true` for Garage and most self-hosted stores, `false` for R2, B2 and S3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `DRIVE_MAX_FILE_BYTES`                                                                                                                                                                   | Per-file upload limit; default 32 GiB, ceiling just under 80 GiB                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `DRIVE_CLIENT_MINIMUMS`                                                                                                                                                                  | Optional. The oldest client version the Drive API still serves, per client name, as product versions: `web/1.0.0,ios/1.0.0,android/1.0.0`. Every Drive request carries `HushOS-Client: name/version`; a client below its minimum is refused with 426 and told to update (the web app tells the person to reload). Clients from before 1.0.0 sent a protocol number (`ios/3`) and count as older than any product-version minimum. Clients with no entry are served whatever their version. Whole-number minimums written before 1.0.0 (`web/3`) still work as they did for those old clients, every product-version client passes them, and the server logs a deprecation warning at startup: replace them with product versions |
| `STORAGE_REPLICA_ENDPOINT`, `STORAGE_REPLICA_REGION`, `STORAGE_REPLICA_BUCKET`, `STORAGE_REPLICA_ACCESS_KEY_ID`, `STORAGE_REPLICA_SECRET_ACCESS_KEY`, `STORAGE_REPLICA_FORCE_PATH_STYLE` | Optional second bucket the worker copies every object to; set all or none. Only the worker receives these settings                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `STORAGE_COLD_CLASS`                                                                                                                                                                     | Optional. The provider's infrequent-access storage class as the S3 API spells it (`STANDARD_IA` on R2 and AWS). With it set, the worker moves objects nobody has read for 90 days to that class nightly and back to `STANDARD` once read again. Leave unset on Garage and B2, which have one class. Worker only                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `DRIVE_ORPHAN_SWEEP_PAUSED_UNTIL`                                                                                                                                                        | Optional ISO timestamp. Until then the worker skips the orphan sweep. Set it after restoring the database from a backup, to at least the backup's age plus a day, so objects the restored database no longer knows about are not deleted before the object audit has listed what is missing. Worker only                                                                                                                                                                                                                                                                                                                                                                                                                         |

### The bundled Garage

The `garage` service runs a single [Garage](https://garagehq.deuxfleurs.fr/) node from `scripts/garage.toml`: one copy of each object, written with fsync, in the `garage_meta` and `garage_data` volumes. Its S3 API listens on `127.0.0.1:9000` (change the host port with `STORAGE_PORT`); its RPC and admin ports are not published. On every start `garage-init` (`scripts/garage-init.ts`) assigns the node's layout the first time, imports the access key from `STORAGE_ACCESS_KEY_ID` and `STORAGE_SECRET_ACCESS_KEY`, creates `STORAGE_BUCKET`, allows browser requests from `APP_ORIGIN`, and adds the rule that aborts incomplete multipart uploads after 3 days.

Garage wants a key identifier of at least 8 characters and cannot change a key's secret or reuse a deleted identifier. To rotate the secret, set a new `STORAGE_ACCESS_KEY_ID` with it; the old key stays until you delete it with `docker compose exec garage /garage key delete --yes <old id>`.

To use it behind a public hostname, route a second hostname such as `https://storage.hushos.example.com` to `127.0.0.1:9000` and set `STORAGE_ENDPOINT` to that URL. The web and worker services reach it inside Compose through `STORAGE_INTERNAL_ENDPOINT=http://garage:3900` while presigned URLs carry the public one. `STORAGE_REGION` stays `us-east-1`, the region `scripts/garage.toml` names.

One node on one disk is not a backup. Configure the replica bucket, or back up both Garage volumes with the database.

Any hosted S3-compatible bucket works instead: point the `STORAGE_*` settings at it and drop the `garage` services from your Compose command.

### After restoring the database from a backup

1. Set `DRIVE_ORPHAN_SWEEP_PAUSED_UNTIL` on the worker before starting it.
2. Let the nightly object audit run, or trigger it by restarting the worker, which runs every job once at start.
3. Read its events for objects marked `missing` and recover those from the replica.
4. Only then let the pause lapse.

### Cleanup at the store

Cleanup is the application's job, and nothing at the bucket should expire objects on its own:

- The worker aborts abandoned multipart uploads and deletes objects through an outbox.
- With a replica configured, a published object's primary copy is deleted only once the replica holds it, and the replica copy 30 days later, which is the window for undoing a bad purge.
- A lifecycle rule that aborts incomplete multipart uploads after 3 days is the second layer. `garage-init` sets it on the bundled Garage; on R2, B2 and S3, add it in the provider's console.

## Groups

Families (groups of accounts that share family folders, docs/groups-design.md) are on by default on the web. The iOS and Android apps do not show families yet. Without billing (`BILLING_PROVIDER=none`) nothing is pooled: a family folder's storage is its own allowance (`GROUP_AREA_QUOTA_BYTES`), drawn from nobody's plan, so every family folder is free storage bounded only by the limits below, and each member's own files keep their own allowance (`INITIAL_STORAGE_QUOTA_BYTES` and any grants). There is no setting for one pool per family without Polar. With Polar billing, a family's folders and its members' own files share its plan's pool, and its seats come from the plan (Family plans, above). No setting was added for the shared pool: `GROUP_SEAT_LIMIT_DEFAULT`, `GROUP_AREA_QUOTA_BYTES` and `GROUP_AREA_LIMIT` mean what they did.

**Upgrading to the families release changes behaviour:** `GROUPS_ENABLED` used to default to `false`, and now defaults to `true`. A deployment that never set it starts offering families to every account once the new web containers are up. To keep families off, set `GROUPS_ENABLED=false` before upgrading.

| Setting                                 | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GROUPS_ENABLED`                        | Default `true`. Set `false` to hide families: the group and invitation routes answer 501, `/api/drive/spaces` lists only the personal space, and `/api/drive/capabilities` tells clients families are off, so the web shows none. hushos.com sets it `false` until paid family plans exist. A deployment that turns it off keeps existing family data, but does not stop serving all of it: Drive's own routes (listing, download, upload, rename, trash) still answer an active member who names a family folder by its id, which no HushOS client does with the switch off, and the worker keeps purging, sweeping and expiring invitations there. Turning it back on serves the families as they were.                                                                                                                            |
| `GROUP_SEAT_LIMIT_DEFAULT`              | Active members a group may have, its creator included; default `6`, at most `10000`. Seats are counted when someone is admitted, never when they are invited, and a lower limit never removes anyone. Ignored with `BILLING_PROVIDER=polar`: a family has the places its plan bought, or only its organizer without one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `GROUP_AREA_QUOTA_BYTES`                | The allowance each new group area starts with; default `10737418240` (10 GiB). An area's storage is its own and is not drawn from any member's allowance. Ignored with `BILLING_PROVIDER=polar`: a family's areas then share its plan's pool (Family plans, above).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `GROUP_AREA_LIMIT`, `GROUP_OWNED_LIMIT` | Areas a group may have (default `10`, at most `50`; a higher value stops the server at startup) and live groups one account may create and still belongs to (default `3`; a group they handed on and left no longer counts). An account is in one family at most whatever `GROUP_OWNED_LIMIT` says (One family per account, below), so without billing one account can hand itself one family's areas, by default 10 × 10 GiB; with Polar billing a family's areas draw on its plan's pool instead. `GROUP_OWNED_LIMIT` is for company groups, which are not available yet. Each area also adds about 2.7 MiB to the largest request body a group's managers may send (a roster carries every area's workspace documents again), about 35 MiB at the default and about 141 MiB at the maximum of 50, which is why the maximum is 50. |

### One family per account

An account is in one family at most, with billing or without it (docs/families-shared-pool.md). Creating a family while in one, accepting an invitation to another and being let into another are refused (`409 in-family`), and the database holds the rule with a unique index on active family memberships. Accepting an invitation is refused too, not only being let in, so the other family's managers never see someone who is in a family waiting to join. Someone may still be in any number of company groups when those exist.

**Upgrading to the release with this rule:** its migration (`one_family`) stops, and changes nothing, if any account is already active in two or more families, since the previous release allowed it. The new containers then fail their startup migration and the previous ones keep serving. Find those accounts on the release you run now:

```sql
select m.user_id, array_agg(g.name) as families
from group_memberships m
join groups g on g.id = m.group_id
where g.kind = 'family' and m.state = 'active'
group by m.user_id
having count(*) > 1;
```

Have each person listed leave every family but one (Leave family, on the family's page), then upgrade. The migration does not pick a family for them: the organizer, the payer and a family's last manager can't simply be marked as gone, because the family's signed member list depends on them, so they hand those roles on first, as leaving asks.

### Dissolved families

A family is dissolved when its last active member leaves or deletes their account. Its folders are retired at once, as deleting a family folder retires one, and nothing can reopen the family: invitations, acceptances and every change to it are refused, and no member sees it. 30 days later the Purge job deletes the folders with their files, versions and key changes, and their stored objects through the deletion outbox (with a replica, the replica copy goes 30 days after the primary one). Then the `groups.purge-dissolved` job (hourly) deletes the family's records: memberships, signed member lists, key changes, invitations and its storage pool (the keys sealed to members already went when each of them left). Members' own files are never touched, including files they moved out of the family folders.

- **A report holds a folder, and the family's records with it.** While an open or held report names a folder, that folder stays, and so does the family's row; both go on the first runs after the report is released.
- **A plan that can still charge holds the records, not the files**, with billing on: any subscription of the family not ended, `canceled` or `incomplete_expired`. The folders still go after 30 days; the family's row waits until the plan has ended.
- **Dissolving a family ends its plan at the period's end.** The worker's `billing.cancel-dissolved` job sets every plan of a dissolved family that can still charge and isn't already ending to cancel at its period's end (`cancel_at_period_end`), and emails the payer the date. Nothing is revoked or refunded: the payer keeps what they paid for until then, as when they cancel the plan themselves. Leaving queues the job at once; every reconcile queues it too, so a family dissolved by its last member deleting their account, or a delivery missed, is caught by the daily reconcile at the latest. The job reads Polar first, sets each plan under the same per-plan claim raises take, and reads it again under the claim, so retries, deliveries and two workers never set it twice or mail twice. A failure at Polar is retried ten times, backing off from a minute to six hours. The mail goes once the plan shows as ending: a set whose answer was lost (a timeout) is mailed by the retry, and a mail that failed (the worker has no email settings, the provider was down) is sent by the next run, which every reconcile queues while the mail is owed.
- **A payer who resumes it** in Polar's portal (a payer who is no longer a member can still open it) has it set to end again on the next delivery, every time: a resume is the payer's own click, so this never loops. They are emailed at most once per plan per period.
- **A refusal at Polar** (403 `InactiveSubscription`: Polar won't change a plan that isn't active, such as one past due; an unpaid, incomplete or paused plan is never sent, see below) is not retried. It is logged as `Polar refused to end a dissolved family’s plan: cancel it in Polar` at error level and the plan is listed on the management page until it is set to end; neither the job nor any reconcile asks Polar again until the plan's status, period or ending changes. Cancel it in Polar. Every other error is retried with backoff: 409 `SubscriptionLocked` (an update pending, as during a renewal), a token error (401, or a 403 other than the two above), 402, 422, 429, a 5xx and a timeout. A job that fails all ten tries is queued again by the next reconcile. A failure Polar keeps repeating (a token without `subscriptions:write`, or a revoked one) would leave the plan renewing, so the first failed run is recorded (`dissolve_failing_since`), and a plan no reconcile has seen ending a day later, or at once when it renews within two days, is listed on the management page as failing. Fix the token or cancel it in Polar; the row goes once a reconcile sees the plan ending.
- **A paused, unpaid or incomplete plan** (paused in Polar's portal; Polar's payment retries ran out; a first payment that never went through) counts as one that can still charge: the reconcile keeps it with Polar's status, reads it again each time, and records it as ended only once Polar ends it (`ended_at`, or `canceled` or `incomplete_expired`) or no longer has it. Such a plan gives the family no storage and no extra places. Polar sets only an active plan to end, and left alone it resumes or is paid for a family that is gone, so the `billing.cancel-dissolved` job revokes it, as a family checkout revokes a lapsed plan (Family plans, above): its ending first, keyed by the family's id, so a payment Polar takes afterwards is refunded whole. An `incomplete` plan less than a day old (a first checkout still waiting on the bank) is left for a day, and asked about again by the next reconcile. Nothing paid for it is still in force. A revoke Polar refuses (a 4xx, or a period it shows paid while the plan is unpaid) is recorded, logged as `Dissolved family’s lapsed plan couldn’t be revoked: revoke it in Polar` at error level and listed on the management page as not active until it has ended; the purge waits for the end. An outage, or the plan-ending job holding the plan, is retried. A scheduled change HushOS gave up on is listed only while its plan is live.
- **Plans an earlier release recorded as ended while `unpaid` or `incomplete`** (its reconcile ended them) are not read again, so a payment taken after that renews for a family that may be gone. The query below lists them (`swept_unpaid`). Since this release a new match is one Polar no longer has, which needs nothing; an older one may be a plan Polar still holds. Check it in Polar, or have the next reconcile read it again: `update group_billing_subscriptions set ended_at = null where id = '<subscription id>'`. It records what Polar answers (ended, or kept), and ends it again if Polar no longer has it.
- **A deleted family's plan that Polar bills again** (reinstated or resumed after it ended, after the purge deleted the family) is revoked: nothing it charges for exists. It is found by: every delivery for the family's customer, which also reads the subscription the delivery names (`data.id` of a `subscription.*`, `data.subscription_id` of an `order.*`) whatever its status, and lists the customer's subscriptions at Polar once; and the daily reconcile, which already reads every family customer HushOS made, deleted ones included, so this costs one customer-state read a deleted family a day and nothing more unless that state lists a plan or HushOS is still ending one. The daily read sees only `active` and `trialing` plans: a plan reinstated straight into `past_due` or `unpaid` is found by its own deliveries, and by the daily run only once it is active. HushOS writes the plan to the mirror, logs `A deleted family’s plan is billing again: revoked, and what it took refunded` at error level, and works it as a lapsed plan's revoke (When a personal plan's payment fails, below), keyed by the family's id: the ending first, under the plan-ending lease, then the plan's orders, then the revoke. Every order made (by its `created_at`) at or after the end of the last period that plan gave the family (`personal_plan_endings.paid_after`, written once with the ending, from `group_billing_subscriptions.served_until`: the end of the last period in which it was the family's plan while active or trialing, or its own end if earlier; a past-due or unpaid period gave nothing and never counts; the epoch for a plan that never served the family, since HushOS gave nothing for it), whenever it is paid, is refunded whole by the `billing.end-personal-plan` job run for the family's id, once Polar shows the plan ended, with the usual retries and **Refunds owed**; earlier ones paid for time the family had, and are never refunded, even when paid late, though one an earlier ending already owes a refund for stays owed. The cutoff is read only from `served_until`, which nothing on this path writes, so a run that fails midway (Polar's order list unavailable) and is retried computes the same one. A plan HushOS had already revoked that Polar reinstates, charges and ends again between two reads is guarded by each charge's own `order.paid` delivery, which notes it on that ending for the job to refund. It is refunded automatically because a payment on it buys nothing: the family, its folders and its pool are gone. An order to be refunded earns no commission: its `order.paid` delivery reconciles the family first, which notes the order on the ending before the delivery decides rewards. A revoke Polar refuses or doesn't answer is logged and never given up: the job revokes it before refunding anything, and the next delivery or daily reconcile asks again; once Polar shows the plan ended (or no longer has it), the end is recorded from Polar's `ended_at`, so an ending whose revoke answer was lost stops being read. A `group:` customer HushOS never made (made by hand in Polar) is logged, never revoked. The management page lists these under **Deleted families billed** while one still bills, while its refunds are made, and for 30 days after.
- **With billing off (`BILLING_PROVIDER=none`), a dissolved family is purged by the same rule:** it waits while the mirror holds a plan of it that can still charge (not ended, not `canceled` or `incomplete_expired`, and not set to end with its period over), and goes once its plans have all ended. So a family dissolved with billing on, whose plan was set to end and ran out after billing was turned off, is purged. With billing off nothing reads Polar, so the mirror's last word stands; a family whose plan was still running when billing was turned off waits until billing comes back on, or until an operator who has checked it in Polar records its end.
- **Never run a copy of the production database against the production Polar organisation** (a staging server restored from a backup, with the production `POLAR_ACCESS_TOKEN`): billing acts on every customer the database names, and since this release that includes revoking plans and refunding payments. Give a staging copy a sandbox token, or `BILLING_PROVIDER=none`.
- **Kept after the purge:** the family's billing records (its Polar customer and subscriptions, and any personal plan ended because someone joined it, with its refunds), by the family's ID, for accounting; reports and their snapshots; the deletion outbox's rows; and the area key commitments its member lists named (32-byte digests and the family's ID), so no folder key it used is ever another family's. A purged family's ID stays taken: creating a family under it is refused while any of those commitments or billing records name it. A family whose member lists named no folder key and that never had a billing record leaves nothing that names its ID, so its creator could make a new, empty family under it again; every family the apps make names one.
- **Families dissolved before this release** get 30 days from the upgrade (the release notes, under Rolling out safely).
- The job takes an advisory lock per family, so a run started while another is working skips that family. To find what is waiting, and why:

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

- Production output (`NODE_ENV=production`, which the images and `bun run start` set) is JSON; development output is readable text.
- Redaction is enabled in both environments, with an auth-specific field allowlist.
- Logs contain request IDs, routes, status, duration, and operation outcomes. They exclude auth bodies, cookies, keys, passwords, recovery phrases, every field named for an envelope or a signature, the settings key, link tokens, and raw protocol/provider/database errors.
- No external drain is configured.

### Allowances

- A personal workspace and initial quota are created in the signup transaction.
- Quota counts use PostgreSQL bigint and serialize as decimal strings.
- Extra entitlements are separate, expiring/revocable records keyed by what granted them: a billing subscription, a referral, or an operator.
- An operator adds storage from an account's page under Management (Add storage: an amount up to 100 TB, optionally an end date and a note). It counts at once, is listed with the account's other grants with who added it, and is logged as `storage-granted` with the operator's and the account's ids. Only these grants can be revoked there (`storage-revoked`); a plan's or an invite bonus's ends through its own system. Revoking never deletes files: while they take more than the allowance, uploads are refused.
- Changing the initial-quota environment variable affects new accounts only.

### Enforcement

Drive's folder tree is live: folders, names and moves are encrypted end to end and every write is serialised per workspace. Upload enforcement lands with uploads:

- ciphertext bytes are reserved atomically before upload URLs are issued;
- object sizes are verified at completion;
- retained trash and versions count against the allowance;
- usage is released only after object deletion.
