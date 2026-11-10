# Company storage: regions, own buckets, retention and backups

**Status:** a design, written on 10 November 2026 and revised twice the same day: after an independent review (one critical, six high and twelve medium findings, and the low ones), and after a second round (one high, eight medium and the low ones). All are applied. Section 17 says where this document differs from what the reviewer recommended. Nothing here is built. The second round found nothing critical and nothing that changes the architecture, and called the document ready to commit after this pass. Leaving for another server (10.4, 10.5) is the exception: it is redesigned here, has had no review in this form, and is not ready to build.

This document specifies where file contents are stored and how that is managed: regions an operator sets up from the management pages, a company's choice of region, a company's own bucket, the test that proves a bucket works, the CORS and access documents to paste, moving between buckets, retention, backups and exports.

**Built so far:** PRs 1, 2 and 3 of section 16.

- PR 1: `object_stores` and `storage_regions`, the environment's stores as rows, `store_id` on objects, uploads and the outbox, the store chosen in `begin`'s transaction, and `storeFor`.
- PR 2: the outbox of 8.4 (`packages/db/src/outbox.ts`), "known at this store" with a sweep and a cursor per store, the backup mark by compare-and-set with `drive_objects.backup_store_id`, replication limited to the store the replica backs up, account deletion through the outbox, worker loops that survive one failure, and the step that runs after a migration (`packages/db/src/after-migrate.ts`). 8.4 ends with what it settled where this document was silent.

- PR 3: what a store may do to the server (2.4): a guard every store call goes through (`packages/drive/src/bounds.ts`: the total deadline, the breaker with slow successes, the cap), reads bounded by the row's size in `copyFrom`, answers the SDK parses read to 1 MiB, and worker loops that take their stores in turn and keep each within its share of a run (`packages/drive/src/turns.ts`). 2.4 ends with what it settled where this document was silent or wrong.

Section 1 describes the code as it was before PR 1.

It builds on `docs/companies-design.md` (the company core, whose section 6 leaves the hooks used here), `docs/drive-design.md` (objects, uploads, purge, the deletion outbox), `docs/self-hosting.md` ("Drive object storage") and `docs/two-step-design.md` (the second step).

The owner's decisions of 10 November 2026 are fixed inputs:

- an operator adds and edits regions and buckets from the management pages, not only through environment variables;
- any S3-compatible store, with a Test button and the backup settings on the same page;
- the CORS configuration is shown ready to copy and paste;
- data residency covers file contents only; accounts and the folder tree stay in the one database;
- a company may store its files in its own bucket, and then pays for seats only;
- object backups per region and a company's exports are configured on the page; database backups only show their last-run status there;
- retention, scheduled exports and restore are in this release; single sign-on and custom domains are not.

Four answers given to the review's questions are fixed too:

- a second step covers one activation, not a window of time;
- an operator who does not run the infrastructure is not a supported role, which is why the storage page has a capability of its own;
- an Owner may restore an older export on purpose; every member is told and it is recorded;
- exports default to a key that cannot delete.

Three more, to the second round's questions:

- there is one worker, and it is stated as what it is: the process that holds every key and also reads responses from servers company Owners run (2.4, decision 24). A second worker for company stores is the alternative, if own buckets see real use;
- a backup's key cannot delete, by default, as an export's cannot (10.1);
- no transfer worker is built (7.2).

**Leaving for a self-hosted server (10.4, 10.5) comes after this release, unless the owner decides otherwise** (decision 2). Until it ships, every page and string says "backups" and "exports", never "a way to leave".

Where a direction cannot be delivered as asked, section 17 says so and section 18 asks.

Plans, seat prices and what a company on its own bucket pays are the billing design's. This document only leaves it the hook (4.4).

## 0. Decisions in short

| Question                          | Decision                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What a store is                   | One S3-compatible bucket: an endpoint, a signing region, a bucket name, a path-style flag and a key. Every store is a row. A store added on the page has its secret sealed in the database. The stores the environment describes are rows with fixed ids and no secret.                                                                                                            |
| What a region is                  | A label people choose ("European Union"), pointing at one store, with an optional backup store.                                                                                                                                                                                                                                                                                    |
| The stores set in the environment | Stay in the environment. Their rows hold no address and no key. The primary is the first region, shown read-only. A deployment that sets nothing new changes nothing.                                                                                                                                                                                                              |
| Which store an object is in       | Each object row names its store, never null. Reads follow the row; new uploads follow the workspace (the company's own bucket, else the company's region, else the default region), decided inside the transaction that records the upload.                                                                                                                                        |
| Residency                         | File contents at rest only. A company picks its region when it is created. Accounts, member lists, the folder tree and sealed keys stay in the one database. Four more things fall outside the region, and the screens name them (4.2).                                                                                                                                            |
| A company's own bucket            | Set by an Owner on the web. Only the company's folders use it; nobody's personal files do. HushOS holds a key scoped to that bucket. Its address is `https`, port 443, with the bucket in the host name unless the operator has listed its host (4.3).                                                                                                                             |
| Secrets                           | Two keys, both required before a store is saved, neither derived from anything else. One seals region and company keys, which the web process must use to sign URLs. Backup and export keys are sealed to a key pair only the worker holds. No route returns a secret.                                                                                                             |
| Who may change storage            | Operators who hold the `storage` capability, granted from the command line, for regions; a company's Owner for its bucket, region and export target; an Admin for retention. Drafts and tests need no second step. Anything that takes effect needs one, and is recorded.                                                                                                          |
| The test                          | A profile per kind of store. Regions and company buckets: server checks, then a real upload and ranged download through the worker that does real transfers in the browser. Backup and export stores: server checks on the worker, with no CORS rule and no delete right demanded. Nothing becomes usable before it passes, and a draft that never passes is deleted after 7 days. |
| The same bucket twice             | Before a store is used, a backup attached or a move started, a random marker written through one store must not be readable through the other, in both directions, one probe at a time. Names cannot rule this out; asking the buckets can.                                                                                                                                        |
| CORS and policy                   | Generated from the deployment's own origin and shown as JSON and XML to copy, with the minimal access policy. An optional button applies the CORS rule with an admin key typed for that one call and never stored.                                                                                                                                                                 |
| Content Security Policy           | Built per request, for the page and for the worker that transfers: the region stores for everyone, a company's bucket only for its members and the people its files are shared with. An open tab that lacks an origin it needs checks before it transfers, and reloads. No separate transfer worker is built (7.2).                                                                |
| Moving                            | A background copy of ciphertext, object by object, verified, resumable, with no re-encryption. Every read is bounded by the size on the object's row. A row flips when its copy is verified. An old copy is kept for as long as the operator's database backups reach back, seven days at least, and is deleted only after the new copy is seen again.                             |
| The deletion outbox               | One row per copy to remove, keyed by object and store, so a moved object's old copy and its later purge never collide, a new row replaces a finished one for the same copy, and a cancelled move withdraws what it queued.                                                                                                                                                         |
| A store someone else runs         | Every read is bounded by the size on the object's row, every request has a total deadline, and each store gets a bounded share of each worker run, so one slow bucket cannot hold up the others (2.4).                                                                                                                                                                             |
| Retention                         | Per company, 7 to 365 days, for Trash and for the earlier version of a file. A shorter setting waits 7 days before it purges anything.                                                                                                                                                                                                                                             |
| Object backups                    | Per region: a second bucket the worker copies every object to, on a schedule, with a check that reads copies back. Today's replica, made per region. By default its key cannot delete, and HushOS then removes nothing from it; a nightly list says what the operator may.                                                                                                         |
| Finding lost files                | An audit with a stated length for one full pass per store. An app that gets "not found" on a signed URL reports it, and that object is checked and healed at once. A lost object is looked for only in the region stores and in its own company's stores. A company's Owners and Admins are told about files missing from their own bucket.                                        |
| Exports                           | A company's schedule (daily by default) copies new objects and a signed snapshot of its metadata to a bucket the company names. By default HushOS's key cannot delete there, and HushOS deletes nothing; each run lists what the company may safely remove. Missing objects are healed from it.                                                                                    |
| Restore                           | Missing bytes come back from the backup or the export on their own. Restoring a whole company into another HushOS is specified (10.4, 10.5) and comes after this release unless the owner decides otherwise. No item-level point-in-time.                                                                                                                                          |
| Database backups                  | The page shows what a backup job reports, and the WAL archiver's last time when Postgres exposes it. HushOS does not run them.                                                                                                                                                                                                                                                     |
| Phones                            | They follow signed URLs. With a company's bucket, someone other than the operator controls a host the phones talk to, so both apps cap what they read and refuse redirects from a store (PR 10). A company bucket must be `https` with a publicly trusted certificate.                                                                                                             |

## 1. What the code does today

Checked against the code on 10 November 2026.

- **One store per deployment, from the environment.** `packages/env/src/storage.ts` reads `STORAGE_ENDPOINT`, `STORAGE_INTERNAL_ENDPOINT`, `STORAGE_REGION`, `STORAGE_BUCKET`, the key pair and `STORAGE_FORCE_PATH_STYLE`. `primaryStore()` in `packages/drive/src/storage.ts` builds one client from them, once per process.
- **A second bucket, worker only.** `STORAGE_REPLICA_*`, all or none. `drive.replicate` copies every object nobody has copied yet, every five minutes. `drive.audit-replica` runs weekly.
- **A third bucket for reports.** `STORAGE_EVIDENCE_*`, worker only: copies of what was reported.
- **Object keys** are `ws/{workspaceId}/{objectId}`, unique across the deployment (`drive_objects.object_key`).
- **Browsers talk to the store directly.** The server signs one `PUT` URL per part (always a multipart upload, 8 MiB parts, the exact `Content-Length` signed) and `GET` URLs for downloads. Signed URLs last an hour for members and 15 minutes for shares and links.
- **What the web client sends and reads** (`packages/crypto/src/session.ts`, in the auth worker):
    - a part: `PUT` by `XMLHttpRequest` with `Content-Type: application/octet-stream`, and it reads the `ETag` response header;
    - a chunk or a thumbnail: `fetch` with `Range: bytes=a-b`, expecting 206 (200 is accepted for a chunk) and reading the body;
    - nothing else. It sends no `HEAD`.
- **Cleanup is the application's.** Objects are deleted through an outbox (`drive_object_deletions`). With a replica, the primary copy goes only once the replica holds it, and the replica copy 30 days later. An orphan sweep lists the bucket under `ws/` and deletes keys no row names that are older than 7 days. An audit confirms objects exist at the right size and copies a lost one back from the replica.
- **Cold storage** moves objects unread for 90 days to `STORAGE_COLD_CLASS`, when set. It reads `drive_objects.last_read_at`.
- **Retention is one number.** `TRASH_RETENTION_DAYS` is 30, for Trash, for the one earlier version a file keeps, and for a deleted family folder. Capabilities serve it as `trashRetentionDays`.
- **The policy is fixed at start.** `apps/web/server/plugins/security-headers.ts` computes the store's origin once from the environment and puts it in `connect-src` on every response, assets included. `CSP_CONNECT_SRC` adds origins by hand (the evidence bucket).
- **Operators** have `/app/admin` (overview, accounts, workspaces, reports, affiliates) behind `requireAdmin`. There is no page for storage and no record of what an operator changed.
- **The phones** fetch signed URLs with their own HTTP clients. Neither app checks the URL's host. iOS allows only local networking outside HTTPS; Android refuses cleartext in release builds.
- **The deletion outbox is keyed by the object alone.** `drive_object_deletions.object_id` is its primary key. `retireObjectIfUnreferenced` inserts with `onConflictDoNothing`. A finished row gets `done_at` and is never deleted. The orphan sweep counts a key as known when any outbox row names it, finished or not (`knownObjectKeys`). All four matter to a move (8.4).
- **Copies trust the source.** `copyFrom` takes the size from the source's own `HEAD` answer and reads each range with `transformToByteArray()`, with no bound and no total deadline. `replicateObjects` stops at the first object that throws.
- **An upload picks its store before its transaction.** `beginUpload` calls `createMultipart` on the store and then opens the repository's transaction.
- **The audit looks at 200 objects a night** (`drive.audit-objects` at 04:20, least recently confirmed first), and at 200 of the replica's a week.
- **Who holds which secret.** `compose.yaml` gives `OPAQUE_SERVER_SETUP` to the web service only. The replica's and the evidence bucket's settings go to the worker only, so that a web container someone has broken into can reach neither (`docs/self-hosting.md`).

## 2. Stores and regions

### 2.1 The model

- A **store** is one bucket with the means to use it. Its kind says what it is for:

    | Kind      | Used for                                                | Set by               |
    | --------- | ------------------------------------------------------- | -------------------- |
    | `region`  | The objects of everyone whose files live in that region | An operator          |
    | `backup`  | The second copy of a region's objects                   | An operator          |
    | `company` | The objects of one company's folders                    | That company's Owner |
    | `export`  | One company's scheduled export                          | That company's Owner |

- A **region** is what people pick: a short code (`eu`), a label ("European Union"), the store it points at, an optional backup store, and two switches (default; offered to companies).
- **The stores the environment describes are rows too,** with fixed ids and nothing secret in them:

    | Row                             | Id                                     | Kind     | What the row holds                                   |
    | ------------------------------- | -------------------------------------- | -------- | ---------------------------------------------------- |
    | The environment's primary store | `00000000-0000-4000-8000-000000000001` | `region` | `source = 'environment'`; no endpoint, bucket or key |
    | The environment's replica       | `00000000-0000-4000-8000-000000000002` | `backup` | The same                                             |
    - The migration inserts both, and one region, code `default`, pointing at the first with the second as its backup store, marked default and offered.
    - Their endpoint, bucket and key stay in the environment. A process fills them in from its own variables when it opens the row. The web process has no replica variables, so it cannot open the second row, exactly as today.
    - The worker records at start whether its environment describes the replica (`object_stores.env_present`). When it does not, the default region has no working backup, as today.
    - The page shows both read-only, with "Set in this server's environment".
    - `drive_objects.store_id`, `drive_uploads.store_id` and the outbox's `store_id` are never null, and their column default is the first id. A container of the previous release, which writes no store id during a rolling update, therefore writes the right one.
    - **Null means "none" and nothing else.** An object with no backup copy has a null `backup_store_id`; a region with no backup has a null `backup_store_id`. The first revision used null for "the environment's store" on some columns and for "none" on others. After the default region moved off the environment's store, an outbox row's null backup could not be read, and a move could not name the environment's store as a target, so it could not be cancelled.
    - So a self-hoster who never opens the page sees no change, and no secret moves into the database unasked.

- The evidence bucket stays in the environment and is not a row. It is the operator's, not a region's. One evidence bucket serves every region (decision 15).

### 2.2 Which store

New uploads, decided at `begin` and written on the upload row:

1. the workspace belongs to a company with its own bucket in use (`groups.store_id`): that store;
2. else the workspace belongs to a company: its region's store (`groups.region_id`, set when the company is created, to the region chosen or to the default at that moment, and never null for a company);
3. else (personal spaces and families): the default region's store.

- **The store is chosen inside the transaction that records the upload.** Today `beginUpload` starts the multipart upload first and opens its transaction afterwards. With more than one store, a move could start, and for a small company finish, between the two, and strand the object at the store it left. The repository's `beginUpload` now reads the workspace's company and region under share locks on the rows a move's switch takes for update (the company's `groups` row when there is one, and the row of the region whose store it reads), writes the upload row with its `store_id` and no multipart id, and commits. The multipart upload is then started at that store and its id written to the row, in an update that applies only while the row is still open and has none. When that update finds no such row (a slow store answered after the row was expired), the multipart upload just started is aborted. An upload row still without an id a minute after `begin` is expired like any other, at the next expiry run (every five minutes).
    - **A store that refuses the multipart start has the `begin` undone whole,** in one transaction: the reservation, the upload row, its pending version and object, and a new file's node. It is not left for expiry. A client sends a failed `begin` again with the same ids, and before stores were rows a store's refusal left nothing for those ids to collide with. Only an open row that never got a multipart id is undone this way.
    - If the write of the id itself fails, the multipart upload just started is aborted and the row is left for expiry.
- Everything after `begin` follows the row it made: parts are signed against the upload's store, completion checks that store, and the object row carries it. Downloads, thumbnails, copies, audits and deletions read the object's own store id. So during a move, and after a company changes region, every object is read from where it actually is.
- A person's own files never follow a company. Someone in a US-region company still has their personal space in the default region.

### 2.3 Endpoints HushOS will talk to

The endpoint field makes the server send requests to an address someone typed. These rules apply when a store is saved and again on every connection.

- `https` only, and for a company's store port 443 only. `http` is accepted only for a loopback or private address, and only when the operator has set `STORAGE_ALLOW_PRIVATE_ENDPOINTS=true` (a self-hoster with a store on the same network). A company's store is never `http` and never private, whatever that setting says.
- No user name, password, query or fragment in the URL. A path is refused.
- **The host name's grammar.** Labels of letters, digits and hyphens, 1 to 63 characters each, lower-cased, 253 characters in all, no trailing dot, no wildcard and no underscore. A punycode name is accepted as typed and never converted. An IP literal is accepted only for an operator's store.
- **The bucket's grammar** is the environment schema's: `^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$` (`packages/env/src/storage.ts`). A company's bucket may hold no dot, since it becomes a host label (4.3).
- **Where it may connect: global unicast addresses only.** An allowlist, not a list of refusals.
    - IPv4: any address outside the IANA special-purpose registry. That rules out 0.0.0.0/8, 10/8, 100.64/10, 127/8, 169.254/16 (which includes cloud metadata services), 172.16/12, 192.0.0.0/24, 192.0.2.0/24, 192.88.99.0/24, 192.168/16, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24, 224.0.0.0/4 and 240.0.0.0/4.
    - IPv6: inside 2000::/3 only, and not 2001::/32 (Teredo), 2001:db8::/32, 2002::/16 (6to4), or 64:ff9b::/96 and 64:ff9b:1::/48 (NAT64). A mapped or compatible IPv4 form is judged by the IPv4 address inside it.
- **It is checked twice.**
    - On the parsed host name, when that is a literal address. A literal never reaches a resolver, so the second check alone would miss it.
    - On the address the socket connects to, through a validating `lookup` on the HTTPS agent the S3 client is given (`requestHandler: { httpsAgent }`). The review ran this under Bun 1.4.4 with SDK 3.1164.0: a refusing lookup aborts the request, a kept-alive connection stays pinned to the address it validated, the certificate is checked against the name, and a 307 is not followed. So a name that answers a public address first and a private one later is refused at connect.
    - The rebinding test in section 15 stays as a pinned regression: an SDK or runtime upgrade could change this.
- **The preflight check is a raw request,** not an SDK call (5.2). It goes through the same agent, with `redirect: 'manual'`.
- Redirects are never followed, by the SDK or by anything else.
- **What an error says.** The person sees which check failed and a class of reason (refused, timed out, not allowed, wrong signature, not found, bad certificate). The store's response body is never shown or logged: it would turn the field into a way to read from other hosts.
- **One bucket, one store, among the operator's own.** A `region` or `backup` store may not name an endpoint host and bucket that another `region` or `backup` store names, compared lower-cased, with no trailing dot and the default port (`shared-bucket`). This catches an honest mistake and nothing more: one bucket has many names (a provider's regional and dual-stack hosts, a jurisdiction host, a CNAME). 2.5 is the control.
- **No name check between companies.** The second revision refused a company's store that named a bucket another company's store named. That told anyone who can make a company whether some company stores at a bucket they guessed, and a draft that never expired let them block the bucket's real owner. It protected nothing: two companies on one bucket are kept apart by what HushOS does there (4.3), and a company bucket that is really a region's is caught by 2.5's probe. A company's store and its export target are compared with nothing by name.

### 2.4 A store someone else runs

A company's endpoint is a server its Owner chose and may run themselves. Controlling where requests go (2.3) is half of it. The other half is what comes back.

- **Every read is bounded by what the database says, never by what the store says.**
    - A copy takes the object's size from its row (`drive_objects.ciphertext_size`). The source's `HEAD` must report exactly that size, or the copy fails (`size-mismatch`) before a byte is read.
    - Each ranged read is streamed and cut off at the length of the range asked for. A longer body is an error, not more memory. `copyFrom` loses `transformToByteArray()`.
    - A listing, a multipart upload's part list and an error body are read to at most 1 MiB.
- **Every request has a total deadline,** not only a connect and an idle one: 10 seconds to connect, 30 seconds idle, and in all 60 seconds plus one second for every 256 KiB expected. It covers the whole call, the SDK's retries included: one abort signal spans every attempt. A store that sends a byte a minute is cut off.
    - The rate is a setting (`STORAGE_MIN_BYTES_PER_SECOND`, default 262144). An honest store behind a slow uplink needs a lower one. The page shows the rate each store's last test measured.
- **A cap per company store:** two requests at a time from the worker and four from the web process. One company's slow bucket cannot occupy the worker.
- **A circuit breaker per store.** Five failures or timeouts in a row open it for 60 seconds: calls answer `unavailable` at once, then one trial call decides. It is per process, in memory.
    - **Slow successes count too, for background work.** Five calls in a row that each succeed but take more than half their deadline mark the store slow for 60 seconds. The worker's jobs skip a slow store for that time. Calls a person is waiting on (an upload beginning, listing its parts, completing) still go, under the cap.
- **A share of each run, not a place at the head of the line.** The worker's loops are shared between stores: the outbox, the audit, backups, the daily check, exports and moves. A store that answers every call just inside its deadline never trips a breaker that counts failures. Two hundred outbox rows for one such store would hold the outbox for over three hours a run, for every tenant.
    - Each run of each job groups its work by store and takes one item from each store in turn.
    - A store may use at most `STORAGE_STORE_RUN_SECONDS` of wall time in one run of one job (default 60). What is left of its work waits for the next run.
    - So one slow store delays another store's work in a run by at most that budget plus one request's deadline, however many rows it has waiting. Section 15 pins that bound.
- **The web process** calls a store when an upload begins, lists its parts and completes. Those calls carry the deadline, the cap and the breaker, so a company's dead bucket fails that company's uploads quickly and nobody else's.
- **The phones.** Both apps read a signed URL's answer whole today (Android's `range()` uses `readBytes()`; iOS uses `data(for:)`), and neither sets a redirect policy. With a company's bucket, a host its Owner controls answers members' and link visitors' phones. Both apps cap a read at the length of the range they asked for and refuse redirects from a store. That is in PR 10, for every store. The web client already bounds its reads.
- **What this does not do.** It does not run company-store work in a process of its own. There is one worker. It holds every key (both sealing keys, the export signing key, and the environment's replica and evidence credentials), and it is also the process that reads responses from servers company Owners run. The bounds above are what stands between a hostile answer and those keys. A mistake in them, or in the code that parses a store's answer, reaches everything. A second worker for company stores, holding only the keys those stores need, is the stronger containment, at the cost of one more service to run (decision 24).

**Settled when it was built (PR 3),** where the rules above were silent, or wrong about the code:

- **The numbers, and why.** None is measured (decision 33).
    - 10 seconds to connect: a handshake with a store that is there takes under one.
    - 30 seconds idle: longer than any pause a working store makes inside a request.
    - 60 seconds for the whole call: room for the SDK's three attempts at a store that answers, and the longest anyone waits for a call that moves no bytes.
    - 256 KiB/s: a 64 MiB copy part gets 60 + 256 seconds. `STORAGE_MIN_BYTES_PER_SECOND` accepts 1024 to 1073741824; zero would be no deadline, and is refused at start.
    - 1 MiB of listing: a page of 1,000 of HushOS's keys is about a third of that.
    - Five in a row and 60 seconds, for the breaker and for slow: more than one bad request, and short enough that a store that came back is used again within a run or two.
    - `STORAGE_STORE_RUN_SECONDS` accepts 1 to 1500: under the 30 minutes pg-boss gives a run before it calls it lost.
- **One guard per store and process** (`createGuard`). Every request `createObjectStore` makes is inside it, a copy's reads from its source included (they are the source's calls: its deadline, its cap, its breaker). The raw S3 client is no longer reachable from outside the store. Signing a URL makes no request and is not guarded.
- **The deadline is enforced twice.** The call's one signal goes to every request, so the SDK cannot begin an attempt after it and an attempt in flight is cut off. And the call itself ends at the deadline whatever the SDK does. It ends with `StoreDeadlineError`, never the SDK's `AbortError`, which the request log takes for a client that went away.
- **The deadline covers the wait for a place under the cap.** A call that waits out its deadline in line never reaches the store, and says nothing to the breaker.
- **Calls that belong together share a deadline.** Every page of a part list is one call. Completing a multipart upload and the look that follows are one call. The store calls of one outbox row (the look, then the delete) share one deadline, so a row's lock and transaction are held for 60 seconds at most. `REMOVAL_IDLE_SECONDS` stays at 180 as the bound behind that one.
- **"Bytes expected" includes bytes the store moves itself.** Completing a multipart upload and rewriting an object into another storage class send almost nothing, and the store then assembles or copies the whole object. Both get the allowance for the object's size, from its row. S3 says a completion can take minutes; a flat 60 seconds would have failed large uploads at a healthy store. The 30 seconds idle still apply to each attempt. A completion cut off anyway leaves the upload `completing`, and a second try or the expiry job finishes it, as before.
- **What counts as a failure for the breaker:** no answer (a timeout, a reset, a passed deadline), a 5xx, 408 or 429, and an answer that broke a bound. A 4xx is the store answering: it closes a half-open breaker and never opens one. A missing object, a missing upload and a refused key are all answers.
- **Half-open admits one call.** Nothing else goes until it ends. A call admitted before the breaker opened changes nothing when it ends, whichever way: only the trial decides.
- **Slow is measured from when a call has its place,** against its own deadline, so waiting for the cap is not the store being slow. Exactly half is not slow. A failure starts the count again.
- **An open breaker is `StoreUnavailableError` with code `breaker-open`;** a store this process cannot open is the same error without a code. The Drive API already answered 503 `unavailable` for any error it does not know, so no route changed.
- **The cap is built and nothing uses it.** No process can open a company's store before PR 4 and PR 10. `createObjectStore` takes `cap`, and `COMPANY_STORE_CAP` holds 2 and 4 for whoever opens one. The operator's own stores, the environment's included, have no cap.
- **"The size on its row" is not always `drive_objects`.**
    - An evidence copy takes the size the report's snapshot recorded (`drive_report_items.ciphertext_size`), which is still there after the owner purges.
    - A published object purged before its backup copy was made has no row, and its outbox row holds no size. That copy takes the source's own size and refuses it above the largest object an upload can make (10,000 sealed chunks and a trailer, just under 80 GiB). The source of a backup copy is a region's store, never a company's (decision 21). A size on the outbox row would close this; it needs a migration, and is left for PR 7, which rebuilds the copy job.
- **A source that does not hold the object** fails the copy as `not-found`; one at another size, `size-mismatch`. Either is before any byte is read.
- **A page was not fair before a turn could be.** The outbox, backup deletions and expired uploads were listed oldest first across every store, so a store with 200 rows waiting was the whole page and no other store's rows were even read. They are now listed by each row's place in its own store's line (`row_number() over (partition by store …)` in the `ORDER BY`), so a page holds the first row of every store, then the second of each. The audit takes a page per store that holds objects (`listStoresHoldingObjects`). A store alone gets the page it always did.
- **A share is looked at before each item, never during one.** An item that began inside the share finishes under its own deadlines. For the outbox an item is one row, so the bound is the share and one request's deadline, as section 15 pins. For a copy an item is the whole copy, of as many requests as the row's size needs.
- **A run that deferred anything is sent again at once** (`leftForNextRun`). The share bounds how long one run keeps other stores waiting, not how fast a backlog drains: without this, one healthy store's backup of large files would have dropped to 60 seconds of copying every five minutes. The queues let one run of a job be active at a time, so the next run starts when this one ends. Work left because a store is unwell (`avoided`) waits for the schedule.
- **Each job, where the rule needed a choice:**
    - **Expiring uploads** takes turns and keeps shares, and does not ask whether a store is well. An expired upload holds reserved bytes, and giving them back is the database's work. An open breaker refuses the abort at once. An upload the store never started asks no store and waits for no turn.
    - **A backup copy** calls two stores: either one unwell, or out of its share, ends that pair's run.
    - **The orphan sweep** takes one page of each store in turn and writes the cursor after every page.
    - **Evidence copies** count the share of the store a reported object is read from. The evidence bucket is the operator's and every copy lands there: its health is asked, its time is not rationed. A report with objects a run did not try keeps its status and comes round again.
    - **Tiering** has one store. Its share and its health still hold.
- **Stores are served one after another, not side by side.** Fifty slow stores each take their share of one run in turn. The slow mark and the breaker are what keep that short. Serving them in parallel is for the moves (8.2), which specify it.
- **The audit's page is per store now,** so two stores are 400 objects a night, not 200. PR 7's budget replaces the fixed page.

### 2.5 The same bucket twice

Two rows that name one bucket are fatal in three ways. A move between them copies each object onto itself and then deletes "the old copy", which is the only one. A backup that is its own primary passes every check. A store that sweeps a whole bucket for orphans deletes another store's objects. No comparison of names can rule this out, so HushOS asks the buckets.

- **The probe.** The worker writes 32 random bytes to `hushos-test/identity/{random}` through store A and reads them back through A, retrying for up to ten seconds. A store that cannot show its own write is not judged: `unavailable`. It then asks for that key through store B, three times over five seconds, so that a store without read-after-write, or a caching proxy in front of one, does not give a false "different". If B returns the bytes, the two are one bucket: `same-bucket`. Then the same the other way round: a marker written through B must not be readable through A. It deletes its markers afterwards. Where a key cannot delete, the markers stay; each is 32 bytes.
- **When, and against what:**

    | When                                                                          | A                | Must not be readable through                                                                                                                                        |
    | ----------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
    | A store passes its test, before it is `ready` (any kind)                      | The new store    | Every `region` store and every `backup` store that is `ready` or `checking`, the environment's primary (region stores sweep whole buckets), and the evidence bucket |
    | A backup store is attached to a region                                        | The backup       | The region's store                                                                                                                                                  |
    | A move starts, and again when it finishes, before any old copy may be deleted | The target       | The source                                                                                                                                                          |
    | An export target is set to a bucket other than the company's own              | The export store | The company's current store                                                                                                                                         |

- The worker runs it (`storage.identity`), because only the worker can open every kind of store (2.6).
- **One probe at a time.** `storage.identity` runs under one lock for the deployment, and a store whose test has passed is `checking` until its probe has. Two drafts of one bucket tested at the same moment would otherwise each pass against the `ready` stores alone, both become region stores, and each sweep the other's objects. Run one after the other, the first meets the second in `checking` and is refused.
- **Two companies that name one bucket** are not probed against each other: there may be hundreds of companies. Nor are their names compared (2.3). They are kept apart by what HushOS does in a company bucket, which is only ever under that company's own workspace prefixes (4.3).
- When a probe cannot run because a store is down, the store is not made ready and the move does not start: `unavailable`.

### 2.6 Secrets

Two keys. Neither is derived from anything else, and both must be set before the first store is saved on the page.

- The first revision derived one key from the OPAQUE server setup, "which the worker already has". It does not: `compose.yaml` gives the setup to the web service only. And one key for every kind would have undone a boundary the guide draws today, that the replica's and the evidence bucket's keys go to the worker alone.

| Variable                                                | Set on         | Seals                                              | Who can open                                                    |
| ------------------------------------------------------- | -------------- | -------------------------------------------------- | --------------------------------------------------------------- |
| `STORAGE_SECRETS_KEY` (or `_FILE`): 32 bytes, base64url | Web and worker | `region` and `company` stores                      | Both. The web process signs upload and download URLs with these |
| `STORAGE_WORKER_KEY` (or `_FILE`): a 32-byte seed       | Worker only    | `backup` and `export` stores                       | The worker alone                                                |
| `STORAGE_WORKER_PUBLIC_KEY`                             | Web            | Nothing; it is the public half of the worker's key | The web process seals to it and cannot open what it sealed      |

- `bun run storage:keys` prints all three.
- **A symmetric seal** (region, company). XChaCha20-Poly1305 under `STORAGE_SECRETS_KEY`:
    - plaintext: the canonical JSON `{"accessKeyId":"…","secretAccessKey":"…"}`;
    - nonce: 24 random bytes, stored;
    - associated data: the canonical JSON `["hushos/storage/credentials",2,storeId,kind,groupId,endpoint,internalEndpoint,signingRegion,bucket,pathStyle]`, with null for a field a store lacks.
    - So a row whose address, signing region, kind or company is changed in the database no longer opens. The server never sends a key to an address, or on behalf of a company, it was not saved for.
- **A worker seal** (backup, export). The unsigned hybrid seal `companies-design.md` 2.5 uses for the ledger's ten-minute keys (an ephemeral X25519 key and an ML-KEM-768 ciphertext, then XChaCha20-Poly1305), to the public keys derived from the worker's seed, with the same plaintext and associated data. The web process seals when the form is saved.
- `secret_key_id` is the first 8 bytes of SHA-256 of the sealing key, or of the worker's public keys.
- **What this keeps from the web process, and what it does not.** A backup or export key typed into the form passes through the web process once, in the request that saves it. After that the web process cannot read it back. So a web container broken into later cannot read a backup key, or use one directly. One that is already broken into when the key is typed can keep it. A deployment that wants no backup key ever to touch the web process keeps its backup in the environment (the environment's replica), which stays supported for exactly that reason.
- **It can still get the worker to act.** The second revision said such a container "cannot delete a region's backup". That was false. Whoever can write the database can:
    - queue deletions the worker then carries out with its own key: outbox rows whose backup copy is already due. That is true of the environment's replica today. What bounds it is a backup key that cannot delete, which is now the default (10.1);
    - re-point a backup store's row at a bucket of their own, with a seal the worker accepts. The worker's seal is unsigned and its public keys are not secret. Copies made from then on go to the wrong bucket; the ones already made are untouched. It is ciphertext either way, and the backup check (10.1) finds a region whose backup no longer holds its objects.
- **The web's copy of the worker's public key comes from its own environment,** never from the database. Someone who can write the database could otherwise swap it for their own.
- **Before the first store is saved.** S2, S21 and S29 answer `secrets-key` (409) unless this process has `STORAGE_SECRETS_KEY`, the worker has reported the same key id at its start (`storage_worker_state`), and, for a backup or export store, `STORAGE_WORKER_PUBLIC_KEY` is set and matches what the worker reported. The page says which is missing.
- **Rotation.** `STORAGE_SECRETS_PREVIOUS_KEY` and `STORAGE_WORKER_PREVIOUS_KEY`. Each row records its key id, and the worker reseals under the current one.
- **Write-only.** No route returns the secret or the whole access key id. A store's view carries `keyHint`, the last four characters of the access key id. Changing the endpoint, the bucket or the path-style flag asks for the secret again.
- **A process that cannot open a store's secret** fails that store's requests with `unavailable` and logs once. It never falls back to another store. Tests of backup and export stores therefore run on the worker (5.1).
- **In memory.** A process keeps opened stores for 60 seconds, keyed by store id and row version. A replaced key is used at most that long.

## 3. The operator's Storage page

`/app/admin/storage`, web only.

### 3.1 Who may open it

- `requireAdmin` operators manage accounts and reports today. This page can relocate every object in the deployment and schedule the originals for deletion. So it has a capability of its own, `storage`, granted from the command line (`bun run admin:grant --storage <email>`), as the admin flag itself is. An operator without it, and every member, gets 404.
- An operator who does not run the infrastructure is not a supported role. Whoever holds `storage` can already destroy everything, by design. The capability is there so that a support operator's stolen session is not enough.

### 3.2 What it shows

- **Regions.** Each with its label, whether it is the default, whether companies may pick it, its store (endpoint, bucket, key hint, status, last test, last daily check), its backup store and schedule, where each says it is, how many objects and bytes it holds, how many are not backed up yet, how long a full audit pass takes and when the last one finished (10.1), how many objects are missing, and a move if one is running.
- **Add a region.** Label and code; then the store: endpoint, signing region, bucket, access key id, secret, and "Path-style addresses". The form says what each store usually wants (section 14). Saving makes a draft. The page then shows the documents of section 6 and the test of section 5. A region can be activated only when its store has passed.
- **Backups.** Per region: the backup store (the same form, with the test profile of 5.1), how often objects are copied, whether its key can delete and whether pruning is on, the last night's list of what may be removed, the last check and its result.
- **Database backups.** The status of 10.6.
- **Changes.** The record of who changed what (3.4).
- **The keys.** Whether `STORAGE_SECRETS_KEY` is set and matches the worker's, and whether the worker's sealing key is set (2.6). Never a key.
- **A list to keep.** "Download this list" gives every store's address, bucket and key hint, with no secret, for the operator's own records (8.6).

It never shows a secret, a file name or a person's files.

### 3.3 The second step

- **Drafts and tests need none.** Saving a draft store, editing it, running its test and applying the CORS rule change nothing anyone depends on. A draft holds no object, is in nobody's policy but its editor's settings page, and cannot be pointed at.
- **Anything that takes effect needs one:** a step token of purpose `operator-storage` or `company-storage`, added to the purposes `docs/two-step-design.md` lists.

    | Takes effect                                                                       | Route              |
    | ---------------------------------------------------------------------------------- | ------------------ |
    | Activating a region: its store, label, switches and backup, in one call            | S8                 |
    | Changing a live region: default, offered, label, backup store, schedule or pruning | S9                 |
    | Replacing the key of a store in use                                                | S3, S33            |
    | Starting or cancelling a move                                                      | S10, S12, S25, S27 |
    | Deleting a store that is not a draft                                               | S7, S32            |
    | A company's retention, export target or pruning taking effect                      | S28, S29           |
    | Freezing a company to leave (10.5, if built)                                       | S50                |

- **One token covers one activation, not a window.** Adding a region is one stepped call, not four.
- An operator or Owner without a second step cannot change where files are kept. The page tells them to turn it on first.
- With two-step switched off for the whole deployment (`TWO_STEP_ENABLED` unset), the call asks for the password instead: the one-use OPAQUE exchange that removing a device uses, tagged `storage`. A self-hoster who has not enabled two-step is not locked out of their own storage page.
- Reading the page needs no step.
- **This depends on two-step's step tokens.** Their database layer is on main and their routes are in review. PR 6 follows them (section 16).

### 3.4 The record

`operator_events`:

```
id, actor_user_id, action, subject_kind, subject_id, detail jsonb, created_at
```

- **Append-only by a trigger** (`operator_events_append_only`, which refuses UPDATE and DELETE). A grant would not do: the default compose file connects every process as one owner role, which no grant restrains.
- Actions: `store.create`, `store.update`, `store.credentials`, `store.test`, `store.cors`, `store.delete`, `store.same-bucket`, `region.activate`, `region.update`, `region.default`, `move.start`, `move.cancel`, `move.blocked`, `backup.check`, `export.restore`.
- `detail` holds what changed (old and new endpoint, bucket, label, switches, a test's pass or fail per check). It never holds a secret or an access key id beyond the hint.
- It is the operator's own record of operator actions, with who and when. It is not a company's activity. It covers storage only; widening it to the rest of `/app/admin` is its own change (decision 18).

**A company's storage changes are activity, and go in its sealed ledger** (`companies-design.md` 3.8). Like every recorded request there, each one a member makes carries a detail record from their device and is refused without one (400 `audit`):

| Action                | When                                                                                                            | Record                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `storage-changed`     | An own bucket is saved, replaced, given a new key or removed; a move starts or is cancelled; the region changes | Yes                                                                          |
| `storage-moved`       | A company's move ends, or is blocked                                                                            | No: the server's own                                                         |
| `retention-changed`   | A retention setting is saved, or a pending one withdrawn                                                        | Yes                                                                          |
| `data-export-changed` | The export target, its key, the schedule or pruning changes                                                     | Yes                                                                          |
| `data-export-run`     | A run is started by hand                                                                                        | Yes                                                                          |
| `operator-changed`    | An operator moves the region a company's files are in, changes its backup, or re-points it                      | No: the operator is not a member, as the company spec has it for this action |

- The names avoid `export`, which the company spec already uses for the Activity page's CSV.
- An operator's move of a region writes one `operator-changed` fact into the ledger of every company whose files are in that region, at its start and at its end. The first revision relocated a company's contents with no entry in its ledger.
- Each is also a security notice to every Owner and Admin.
- The five that are new are in `companies-design.md` 3.8's table, added with this document. `operator-changed` was there already.

## 4. A company's region and its own bucket

### 4.1 Region

- Creating a company (`companies-design.md` 3.1) gains a choice, "Where files are kept", listing the regions marked offered. One offered region means no choice is shown.
- The choice is on the creation call as `regionId` and stored in `groups.region_id`.
- Changing it later is a move (section 8), started by an Owner.
- Families and personal spaces have no choice. They use the default region.

### 4.2 What the screens say

HushOS does not know where its own database is. The operator states it: `DATA_HOME_LABEL` (for example `the European Union`), shown wherever a region is. Unset, the strings say "on this server".

File contents at rest are in the chosen region. Four things are not, and the strings carry all four: the database; ciphertext passing through the server that copies it during a move, a backup or an export; a region's backup, which may be somewhere else; and a reported file's copy.

- **Creating a company, under the choice:**

    > File contents are stored in the region you choose. Your account details, the list of members and the encrypted folder structure are stored in {home} for every company. Backup copies are kept in {backup home}. Encrypted files pass through our servers in {home} when they are moved or backed up, and a file someone reports is copied to storage we keep for reports.

    `{backup home}` is what the region's backup store says about where it is. A region with no backup says "No backup copy is kept" instead.

- **Company settings, Storage:**

    > Files in {company}'s folders are stored in {region}. Account details, the list of members and the encrypted folder structure are stored in {home}. Backup copies are kept in {backup home}. Encrypted files pass through our servers in {home} when they are moved or backed up. A file someone reports is copied to storage we keep for reports, which may be in another region.

- **The security page:**

    > A company can choose where the contents of its files are stored. That choice covers file contents at rest only. Sign-in details, member lists, and the encrypted folder structure and keys are stored in {home}, whichever region a company picks. Backup copies of a region may be kept somewhere else; each company's storage page says where. When files are moved, backed up or exported, their encrypted bytes pass through our servers in {home}. A file someone reports is copied to storage we keep for reports. Someone outside the region who opens a shared file downloads it to wherever they are.
    >
    > Whoever runs a HushOS server decides which bucket a region's name points at, and can change it. No app can check where bytes are stored.
    >
    > Your own files, outside any company, are stored in the default region, which is {default region} today.

- **Deletion.** Wherever "Items here are deleted after {n} days" is shown in settings, one line under it:

    > Deleted files stay in backup copies for 30 days more, and after that until the people who run this server clear them. Exports to your own storage keep them until you remove them there.
    - Where a region's backup key can delete and pruning is on (10.1), the first sentence is "Deleted files leave backup copies up to 30 days later."
    - With pruning turned on for the export (10.2), the second sentence is "Exports keep them until the last export that lists them is removed."
    - The first sentence is weaker than the second revision's, and that is the price of a backup key that cannot delete: HushOS no longer removes a backup copy itself. Whoever runs the server must say how often they clear what the lists name (decision 34).

- **A member's own files, in Account:** unchanged. Nothing there mentions a company's region, because a company's choice does not move them.

These are the strings to ship. They replace "The service we run keeps its servers and your files in the European Union" on `/teams` once a second region is offered.

**Changing the default region** moves no existing file. From then on new personal and family uploads are stored in the new one. A later move of that region does move them: a region's move takes every object of the workspaces that resolve to it (8.1), so personal and family files stored while another region was the default are pulled into it then. That move's start screen says how many. It is a stepped change (S9), recorded, and the security page's last line follows it. People are not told one by one (decision 26).

### 4.3 A company's own bucket

- **Where:** company settings, Storage, on the web. The phones show one line, "Stored in {company}'s own storage", and no controls.
- **Who:** an Owner. It moves every company file, changes what the company pays, and gives HushOS a key to something the company owns. An Admin sees the status and may run the test. This is a server rule read from the member list; nothing cryptographic depends on it, since every object is ciphertext wherever it sits.
- **The form** is the operator's: endpoint, signing region, bucket, access key id, secret, and path style where the rule below allows it. It shows the documents of section 6 filled in for this deployment, then runs the test of section 5.
- **Its address:** `https`, port 443, and virtual-hosted, meaning the bucket is in the host name. The origin members' browsers are then allowed to reach is that one bucket's. Path style is refused for a company (`path-style`): on a host shared between a provider's customers it would allow every bucket there (7.1).
    - The exception is a host the operator has listed (`STORAGE_COMPANY_PATH_STYLE_HOSTS`, exact names or `*.suffix` patterns). It is for a self-hosted deployment whose companies run their own MinIO or Garage, where one host serves one company.
    - **The list ships empty.** The second revision listed R2's S3 host, reasoning that requiring the bucket in the host name would exclude R2. The repository's own guide says otherwise: `STORAGE_FORCE_PATH_STYLE` is `false` for R2, B2 and S3 (`docs/self-hosting.md`, "Drive object storage"), so each is used with the bucket in the host name today. R2's own documentation was not opened to confirm it; the test is the authority (section 14).
- **What uses it:** the company's shared folders and its members' company areas. Never a member's personal space, never a family.
- **The bucket should be the company's and used for nothing else.**
    - Setting it up is refused when the first 1,000 keys under `ws/` include one that is not this company's (`not-empty`). That catches an honest mistake and nothing more: it is one look at a bucket the other side controls.
    - What keeps companies apart is that HushOS never acts on a prefix someone typed. Every read, write and delete follows an object row, and a row names its store. There is no prefix field.
    - HushOS only ever lists, reads, writes and deletes under `ws/{a workspace of this company}/`, `export/` and `hushos-test/`.
    - The orphan sweep in a company bucket walks only the prefixes of workspaces that ever stored there (`store_prefixes`), never the whole bucket. A prefix is recorded at a workspace's first upload to the store, and at the first copy a move or a heal makes into it. A deleted workspace's leftovers are under one of those prefixes, so they are swept too.
- **Turning it on** is a move from the region to the bucket (section 8). Turning it off is a move back.
- **Replacing its key.** An Owner can replace the key of a bucket in use (S33: the second step, and a `storage-changed` fact). The new key must pass the server checks of 5.2 against the same bucket before it replaces the old one. The address does not change. The same route replaces an export target's key. The second revision gave only operators a way to replace a live store's key, so a company whose key was rotated at its provider could only move away and back.
- **What the screen says:**

    > Files in {company}'s folders are stored in your bucket. HushOS holds a key to that one bucket so it can sign uploads and downloads and remove deleted files. Everything in it is encrypted on your devices first: HushOS cannot read it, and neither can your storage provider.
    >
    > Your account details, the list of members and the encrypted folder structure stay with HushOS in {home}. People's own files are not stored in your bucket.
    >
    > HushOS keeps no second copy of files in your bucket. Set up an export, or use your provider's own backups. If files go missing from your bucket, your Owners and Admins are told.

- **Location.** HushOS cannot check where a company's bucket is. The screen shows what the company types as its location, labelled as the company's own statement.
- **When the company is deleted.** Its objects are deleted from its bucket through the outbox, as from any store, while the key works. If the bucket is failing, the rows wait 30 days and are then abandoned. The Owner is told at deletion, and again then, that the bucket may still hold encrypted files and is theirs to remove. The key is discarded when the outbox for that store is empty or abandoned. Export deletions are cancelled and the export's key discarded at once (10.2).
- **When the plan lapses.** The billing design decides what a lapsed company may still do. Whatever it decides, HushOS moves no file on its own: files in the company's bucket stay there, and downloads are signed for as long as the company's space can be opened at all.

### 4.4 The hook for billing

- `groups.store_id` not null and in use means "own bucket". The billing read of a group gains `storage: 'hushos' | 'own'`.
- On its own bucket a company's areas have no storage cap: the free-space check answers "enough" for them. Used and reserved bytes are still counted and shown (decision 20).
- The per-file limit (`DRIVE_MAX_FILE_BYTES`) still applies.
- Starting a move to or from an own bucket asks billing first (`plan`, 402, when the plan does not match where the files would be). Which comes first, the plan change or the move, is the billing design's to say.
- **Moving back into a region with a cap needs room.** The move's start compares the bytes at the company's bucket with the free space of the pool they would count against, and answers `over-quota` (409) with both numbers when they do not fit. Which plan change makes room is the billing design's.

## 5. The test

A store is `draft` until its test passes, and nothing can be pointed at a draft. A passed test is good for 24 hours for starting a move. A draft that has not become `ready` within 7 days is deleted with its sealed secret (`storage.expire-drafts`), and a company has at most one draft of each kind. So a draft cannot be left to sit on anything.

### 5.1 A profile per kind

A backup or export bucket is never touched by a browser, and is better off with a key that cannot delete. One test for every kind would have demanded an open CORS rule and a delete right of both.

| Check                                                           | `region`, `company` | `backup`                              | `export` |
| --------------------------------------------------------------- | ------------------- | ------------------------------------- | -------- |
| `reach`, `list`, `write`, `read`, `range`, `multipart`, `abort` | Required            | Required                              | Required |
| `delete`                                                        | Required            | Reported                              | Reported |
| `preflight`                                                     | Required            | Not run                               | Not run  |
| The browser checks (5.3)                                        | Required            | Not run                               | Not run  |
| `rules`                                                         | Warns               | Warns, also when it finds a CORS rule | The same |
| `identity` (2.5)                                                | Required            | Required                              | Required |

- **`delete` on a backup or export store is reported, not required.** A key that cannot delete is the better key for both: nothing HushOS does, and nobody who steals the key from HushOS, can remove a copy. Where the key cannot delete, HushOS removes nothing from the bucket, and lists what its owner may safely remove (10.1, 10.2).
- **Where it runs.** Region and company tests run on the web process, which holds their key. Backup and export tests run on the worker, as a job (`storage.test`), since only the worker can open their key. The page polls for the result (S5).
- A test that passes its profile makes the store `checking` and queues 2.5's probe on the worker. The store is `ready` when that passes too.

### 5.2 What the server checks

With the store's key, under `hushos-test/{random}`:

| Check       | What it does                                                                                                        | A failure usually means                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `reach`     | Connects and signs a request for the bucket                                                                         | Wrong endpoint, a private or blocked address, a bad certificate                 |
| `list`      | Lists the bucket under the test prefix                                                                              | The key may not list this bucket, or the bucket name or signing region is wrong |
| `write`     | Puts a 1 KiB object                                                                                                 | The key may not write                                                           |
| `read`      | Gets it back and compares the bytes                                                                                 | The key may not read                                                            |
| `range`     | Gets bytes 100 to 199 and expects 206 with exactly those bytes                                                      | The store ignores ranges, which downloads and thumbnails depend on              |
| `multipart` | Starts a multipart upload, sends a 5 MiB part and a 1-byte part, lists the parts, completes it, and checks the size | Multipart is missing, or the key lacks the rights for it                        |
| `abort`     | Starts another and aborts it                                                                                        | Abandoned uploads could not be cleaned up                                       |
| `delete`    | Deletes both objects and confirms they are gone                                                                     | The key may not delete; or the bucket keeps versions or holds a retention lock  |
| `preflight` | Sends the two preflight requests a browser would, with this deployment's origin, and reads the answers              | The CORS rule is missing or does not allow the origin, method or header named   |
| `rules`     | Reads the bucket's lifecycle rules, versioning and CORS, where the store and the key allow it                       | Not a failure: see below                                                        |
| `identity`  | 2.5's probe                                                                                                         | This bucket is already in use under another name                                |

- `preflight` is `OPTIONS` on a signed part URL with `Origin`, `Access-Control-Request-Method: PUT` and `Access-Control-Request-Headers: content-type`, and on a signed object URL with `Access-Control-Request-Method: GET` and `Access-Control-Request-Headers: range`. It is a raw request through the validating agent, with redirects refused (2.3). It passes when the answers allow the origin, the method and the header, and, for the upload, a later real answer exposes `ETag`. Its failure names what is missing: "Your bucket does not allow uploads from https://hushos.com", "…does not allow the Content-Type header", "…does not let the page read the ETag header".
- `rules` warns and never fails:
    - a lifecycle rule that expires objects: "A rule on this bucket deletes objects after N days. HushOS files would disappear."; on a backup or export bucket: "…Copies of files you still have would disappear. Remove only what the list names.";
    - versioning on: "This bucket keeps old versions. Files HushOS deletes will still take space until your own rules remove them.";
    - a CORS rule on a backup or export bucket: "This bucket answers browsers. Nothing HushOS does needs that here.";
    - could not be read: "HushOS could not read this bucket's rules, so it cannot warn you about them."

### 5.3 What the browser checks

Real transfers do not run in the page. They run in the auth worker, under whatever policy governs that worker (7.2). A check made from the page could pass where an upload fails. So the browser check is run by the same worker, through the same code that uploads a part and reads a range.

The server's answer carries two signed URLs for the test prefix. The worker, in the tester's own browser:

1. sends a 64 KiB part with `PUT` and `Content-Type: application/octet-stream`, exactly as an upload does, and reads `ETag`;
2. asks for a range of the object the server wrote, and checks the status and the bytes.

The page posts what happened back (S5). The server completes or aborts and deletes.

For the worker to be allowed to connect to a store that is still a draft, the draft's origin is in the policy served on the storage settings pages to the people who may edit or test it (7.1). Saving a draft reloads the page, so the policy carrying the new origin is the one in force.

### 5.4 What a test cannot show

The page says this beside the result.

- It proves this server and this browser, on this network. It does not prove a colleague's office firewall lets them reach the bucket.
- It cannot prove the bucket is where anyone says it is, or that the provider keeps what it stores.
- It reads lifecycle rules only where the store and the key allow. Garage has no bucket policies at all.
- It proves the rule for this deployment's origin, not for an address added later.
- It runs once. A bucket its owner changes afterwards is caught, if at all, by the daily check.

### 5.5 The daily check

`storage.probe` on the worker, once a day for every store in use and hourly for one that is failing: the checks its profile requires, except `multipart`, `abort` and `identity`.

- Two failures in a row mark the store `failing`.
- Operators are told for a region or backup store; a company's Owners and Admins for its own bucket or export target: an email and a notification, naming the check that failed.
- Members see a line in the company's space: "Uploads to {company}'s storage are failing. Its admins have been told."
- HushOS keeps trying. It never moves anyone's files to another store on its own.
- A pass clears the mark.

## 6. What to paste

The page generates these from the deployment's settings. The origin is `APP_ORIGIN`; a deployment that serves the app on more than one origin lists each. The examples use `https://hushos.com` and a bucket named `acme-hushos`.

### 6.1 CORS

Derived from what the web client sends and reads (section 1): a `PUT` with `Content-Type`, a `GET` with `Range`, and the `ETag` of an uploaded part.

JSON, as the AWS S3 console, Cloudflare R2's dashboard and Wasabi's console take it:

```json
[
    {
        "AllowedOrigins": ["https://hushos.com"],
        "AllowedMethods": ["GET", "PUT"],
        "AllowedHeaders": ["content-type", "range"],
        "ExposeHeaders": ["ETag"],
        "MaxAgeSeconds": 3600
    }
]
```

XML, as the S3 API's `PutBucketCors` and the stores that follow it take it:

```xml
<CORSConfiguration>
    <CORSRule>
        <AllowedOrigin>https://hushos.com</AllowedOrigin>
        <AllowedMethod>GET</AllowedMethod>
        <AllowedMethod>PUT</AllowedMethod>
        <AllowedHeader>content-type</AllowedHeader>
        <AllowedHeader>range</AllowedHeader>
        <ExposeHeader>ETag</ExposeHeader>
        <MaxAgeSeconds>3600</MaxAgeSeconds>
    </CORSRule>
</CORSConfiguration>
```

- This is narrower than what the bundled Garage is given today (`GET`, `PUT`, `HEAD`, every header). The web client sends no `HEAD` and no other header, so the narrow rule is the one to recommend; `garage-init` can keep its own.
- **"Apply this for me."** A button sends the XML form through `PutBucketCors` and runs the test again.
    - **It never uses the stored key.** Setting a bucket's CORS takes more than an object key on most stores (section 14). A stored key with that right could also set a lifecycle rule that empties the bucket, so a thief of it could too. The button asks for an admin key for this one call. It is used once, in memory, and is never stored or logged.
    - It replaces the bucket's whole CORS configuration, so it first shows any rule already there and asks.
    - Where the store has no such call, or the person would rather not type an admin key, they paste the rule themselves.
    - It is not offered for a backup or export store, which needs no CORS rule (5.1).
- A changed rule can take a moment to apply (R2 says up to 30 seconds in rare cases). The test says "try again in a minute" on a preflight failure right after a change.

### 6.2 The key's access

The least the key needs, as an AWS-style policy:

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "HushOSObjects",
            "Effect": "Allow",
            "Action": [
                "s3:GetObject",
                "s3:PutObject",
                "s3:DeleteObject",
                "s3:AbortMultipartUpload",
                "s3:ListMultipartUploadParts"
            ],
            "Resource": "arn:aws:s3:::acme-hushos/*"
        },
        {
            "Sid": "HushOSBucket",
            "Effect": "Allow",
            "Action": ["s3:ListBucket"],
            "Resource": "arn:aws:s3:::acme-hushos"
        }
    ]
}
```

For a backup or export store, leave out `s3:DeleteObject`: a key that cannot delete is the better one there (5.1, 10.2). The page shows that variant on those forms.

Optional, read-only, each with what it buys:

| Action                                                   | Lets HushOS                                      |
| -------------------------------------------------------- | ------------------------------------------------ |
| `s3:GetBucketCORS`                                       | Notice if the CORS rule changes                  |
| `s3:GetLifecycleConfiguration`, `s3:GetBucketVersioning` | Warn about rules that would delete or keep files |

- The stored key is never given the right to set CORS, lifecycle rules or anything else about the bucket itself.
- The key should reach this bucket and nothing else. The page says so above the form.
- Stores without AWS-style policies get the equivalent in words (section 14): an R2 token with object read and write on one bucket; a Backblaze application key restricted to the bucket; a Garage key allowed to read and write the bucket.
- A second lifecycle rule is recommended, as today: abort multipart uploads left incomplete for 3 days.

## 7. The Content Security Policy

### 7.1 Per request

`connect-src` stops being fixed at start. For each page response it is `'self'` plus:

1. the environment's primary store's origin, as today;
2. the origin of every region store that is `ready` (a short list, the same for everyone, cached for 60 seconds);
3. for a signed-in person, the origin of each company store of a company they are an active member of, from the moment that store is `ready`, so a store a move is about to switch to is already allowed;
4. for a signed-in person, the origin of each company store that holds an item shared with them by a live share. Someone outside a company who was given one of its files must be able to download it;
5. on a link page (`/s/…`), the origin of the store holding what the link opens, so a visitor without an account can download from a company's bucket;
6. on a report's page, for an operator, the origin of the store holding the reported object, when its primary copy is what they read;
7. on the storage settings pages, for someone who may edit or test them (an operator with `storage`; a company's Owner or Admin), the origin of a draft store under test;
8. what `CSP_CONNECT_SRC` adds, as today.

- **How an origin is built.** From the row's validated host and bucket (2.3): `https://{bucket}.{host}` for a virtual-hosted store, `https://{host}` for path style. The result is parsed with `new URL()` and written as its `.origin`. It is refused when the parsed host is not exactly the one built, or when anything but an origin comes out. Today's `storeOrigin()` (`apps/web/server/csp.ts`) interpolates the bucket into the header value. A bucket that was never validated would be a header injection, and `new URL('https://*.example.com')` parses. The grammar and this rebuild close both.
- **Path style on a shared host allows every bucket there.** `https://s3.amazonaws.com` as an origin is every bucket at that provider, including one an attacker made. So a company's store is virtual-hosted and its origin is one bucket's, or it is on a host the operator has listed (4.3).
- **What a company can do to a member's policy.** Anyone can make a company, set an own bucket at a host they control, and invite someone. Once that person is let in, their policy lists that host on every page, their personal space included. On its own that reads nothing: a script must first be running in the page to send anything there. For a script that does get in, it is one more place to send to. It is not a new power. Such a script can already send what it reads out through HushOS itself: by uploading into a company its author made and the person was let into, or by sharing with its author's account. So the residual is low, and nothing here removes it.
    - The second revision said a transfer worker would remove it (7.2). It would not. The same script could start that worker itself and hand it plaintext and a URL.
- A company's bucket origin is never in a stranger's policy. Listing every company's bucket to every visitor would publish the customer list.
- The page costs one more read on a signed-in page load (the stores of the person's companies and shares), cached per session for 60 seconds.
- Nothing else in the policy changes. No other directive names a store: previews draw from blob URLs the page makes.
- **A link protected by a password** shows its store's origin in the page's policy before the password is typed. That is accepted (decision 25). Whoever holds the address of a link to a file in a company's bucket learns that bucket's host name, which names the provider and the bucket, before any password. They learn nothing else from it: no listing, no object, and no signed URL, which only the password gets. The alternative is a reload of the link page after the password.

### 7.2 The worker

Uploads and downloads run in the auth worker, a module worker loaded from a hashed asset that browsers keep for a year.

- **Not verified:** which policy governs a dedicated worker's requests in each engine. The specification says a worker loaded from the network uses the policy on its own script's response. Engines have at times used the creating page's policy instead. Today both carry the same fixed policy, so it has never mattered here.
- With a policy per person it does. A worker script cached last month carries last month's origins.
- **PR 5 opens with a test** in Chromium, Firefox and WebKit: a worker whose entry script allows origin A, made by a page that allows origin B, fetches from each. It settles one thing, which policy governs the existing auth worker's requests, and its result goes in this document.
    - **Where an engine applies the worker's own policy,** the auth worker is started from a `no-store` entry script, `/app/worker/auth.js`, served with the per-request policy. It does nothing but import the hashed asset. Its policy is then as fresh as the page's.
    - **Where an engine applies the page's policy,** the page's per-request policy is already the one in force, and the entry script changes nothing.
    - So the entry script is built unless all three engines apply the page's policy.
- **No transfer worker is built.** The second revision planned a second, small worker that alone could reach company buckets and never held a key or a plaintext byte, and said it would take company origins out of a script's reach. A script in the page can start that worker itself and hand it whatever it likes, so it contained nothing (7.1). What it would have bought is no reload when a person's origins change, and a way round decision 25. Neither is worth a second worker. The page's policy carries company origins as 7.1 lists them, and a change of origins is picked up by 7.3's check and a reload.

### 7.3 When someone's companies change

A page already open has the policy it was served with. When the spaces list names a store origin that policy lacks (someone was just let into a company with its own bucket, or a company is moving), the app cannot reach it.

- Each area in `GET /api/drive/spaces` carries its `storeOrigin` and, while a move is under way, `nextStoreOrigin`. A listing of items shared with the person carries each item's `storeOrigin` too: someone outside a company has no space of it to read the origin from. The page knows the origins it was served with.
- **Before an upload begins, and before it asks for a download URL,** the app checks the origin it would use against the ones it was served. If it lacks it, it does not start. It shows "Reload to keep working in {company}", and reloads by itself only when nothing is transferring and the account would not be locked by it.
- So an open tab never has a transfer fail against its policy. At worst it is asked to reload once.
- **A tab from before this check exists** has none. PR 10 raises the web's floor for company spaces (the company spec's company floor), so a tab that old is told to reload before it works in one.
- Being let in ends on a full page load, so this is rarely seen.

### 7.4 The phones

- No policy applies; they follow signed URLs.
- iOS's transport rules and Android's release configuration both need `https` with a certificate a phone trusts. A bucket behind a private certificate authority works in a browser that trusts it and fails on phones. The test cannot see that; the form says it.
- **They do change** (PR 10): a read is capped at the length of the range asked for, and redirects from a store are refused (2.4). The first revision said the phones needed no change to how they fetch. That was true only while every store was the operator's.
- They also need the strings of 4.2, the per-space retention of section 9, the "failing" line of 5.5, and the "not found" report of 10.3.

## 8. Moving

A move takes every object in a scope from wherever it is to one store. It never decrypts, re-encrypts or re-keys: the bytes are copied as they are.

| Scope     | When                                                               | Started by  |
| --------- | ------------------------------------------------------------------ | ----------- |
| `company` | A company changes region, turns its own bucket on, or turns it off | Its Owner   |
| `region`  | An operator points a region at another bucket                      | An operator |

Changing the endpoint or bucket of a store that holds objects is refused (`in-use`). The way to change a region's bucket is to add the new store and move the region to it. The environment's stores are rows now, so a region can be moved off the environment's primary and back onto it.

### 8.1 What a move covers

- **The work is every object of the scope that is not at the target,** wherever it is. The first revision said "objects still at the source". After a region's move had flipped a company's objects, that company's own move would have found none at its source and called itself done, with its objects somewhere else.
- **A company's scope** is the objects of that company's workspaces. **A region's scope** is the objects of every workspace whose uploads resolve to that region (2.2): personal spaces and families when it is the default, and the companies in it that have no bucket of their own.
- **Overlapping moves are refused** (`moving`). A company cannot start a move while its region is moving, and a region cannot while any company in it is. One scope, one move.

### 8.2 The steps

1. **Start.** Needs: a target that passed its test in the last 24 hours; no overlapping move; for a company, billing's check and room at the target (4.4); and 2.5's probe, target against source. One transaction, holding the company's or region's row for update, records the move as `preparing` and sets `switch_at` ten minutes on. Nothing else changes yet.
2. **Switch.** At `switch_at` the worker, under the same row's lock, points new uploads at the target (`groups.store_id` or `groups.region_id`, or the region's `store_id`), and the move becomes `copying`.
    - The ten minutes let pages loaded since the target became ready carry its origin. A tab older than that is asked to reload before it uploads (7.3).
    - An upload takes a share lock on the rows it reads its store from (2.2), and the switch updates one of them, so no upload can choose the source after the switch.
3. **Uploads in flight** finish where they began: their parts were signed for that store, and their row says so. Their objects are copied like any other once they are ready.
4. **Copy.** `storage.move` on the worker takes objects of the scope not at the target, in id order, a bounded batch per run, four at a time (two when either store is a company's, 2.4). For each:
    - check that the store the row names reports exactly the row's `ciphertext_size`, or fail this object (`size-mismatch`);
    - copy to the same key at the target, in 64 MiB parts, each read bounded (2.4), each sent with its SHA-256 so the target store refuses a damaged part (`copyFrom` with `verified`, as the evidence copy does today);
    - check the target reports exactly that size;
    - where the target did not confirm the digests it was sent, read the copy back and compare its SHA-256 with the source's;
    - then flip, in one transaction: `store_id` becomes the target only if it is still the store this copy read from; the object's backup mark is cleared (`backup_store_id` and `replicated_at` null), so the target region's backup copies it afresh; its storage class is `standard` again; and an outbox row is written for the copy left behind, `(object, the store it left)`, reason `moved`, held for this move (8.4).
    - If the row is gone (the file was purged meanwhile), or now names some other store, the copy just made is not wanted: an outbox row `(object, target)`, reason `stray`, removes it.
5. **Finish.** When no object of the scope is anywhere but the target, and no open upload of the scope names another store, the worker runs 2.5's probe again, target against source.
    - It passes: the move is `done`, and its held outbox rows get their date (8.4).
    - It fails: the move is `blocked`. Nothing is ever deleted for it, and operators are told that two stores have turned out to be one bucket.
6. **After the wait** the outbox deletes each old copy, but only after seeing the new one again (8.4). Until then reads come from wherever each row says, so both stores are in use.

### 8.3 What it does not disturb

- **Signed URLs** already handed out keep working for their hour: the old copy outlives them by days.
- **A file deleted during a move** is deleted from wherever its row said, through an outbox row of its own. The two rows for one object no longer collide (8.4).
- **The orphan sweep does not run on a store that is the target of a move still preparing or copying.** "Known at this store" (8.4) does not cover a copy that has landed and not yet flipped.
- **The backup mark is set by compare-and-set.** `markObjectReplicated` is unconditional today. A backup run racing a flip would mark an object as backed up in the old region's backup, and the new region's backup would never copy it. It becomes: set `backup_store_id` to B, and `replicated_at`, where the object is still at the store B backs up.
- **Reported objects.** A copy is made like any other. The old copy of an object under a hold is not deleted while the hold stands; the outbox already skips those. Evidence copies are untouched.
- **Missing objects** (the audit could not find them) are not copied. The move lists them and finishes without them; they stay `missing`.
- **The sealed ledger** and everything else in the database is not in any bucket. A move does not touch it, beyond the facts it writes (3.4).

### 8.4 The outbox, rebuilt

The deletion outbox is keyed by the object alone today (section 1). A move breaks that in two ways. After a flip the object needs a row for its old copy while the object is still live, so the row a later purge tries to add is silently dropped, the new copy is never deleted, and the sweep counts its key as known for ever. And a cancelled move left the row for the "old" copy in place, to delete what had become the live one.

- **The key is `(object_id, store_id)`:** one row per copy to remove, not per object.
- **Each row has a reason:** `purged` (the object is gone; today's rows), `moved` (the object lives on at another store and this copy is left over) or `stray` (a copy that lost a race).
- **An insert replaces a finished row for the same object and store.** Finished rows are kept 30 days (below), and a store can get an object back inside that time: a move out, the wait, and a move back, which decision 1 invites. A later purge then adds `(object, A, purged)` and meets the finished `(object, A, moved)` row. Today's `onConflictDoNothing` would drop the new row, and with it the deletion of the backup copy it carries. So an insert overwrites a row whose `done_at` is set, whole: reason, dates, hold, and the backup and export fields. An insert that meets an unfinished row leaves it, since that copy's removal is already queued, except that a `purged` reason replaces `moved` or `stray` and clears the row's hold.
- **A `moved` row is held** (`held_by_move`) until its move is `done`, and then gets its `not_before`. A `blocked` or `incomplete` move releases none.
- **How long an old copy is kept:** `DATABASE_BACKUP_RETENTION_DAYS`, which is how far back the operator might restore the database, and seven days at least. An operator who keeps 30 days of database backups keeps old copies 30 days. A database restored to before the flips would otherwise name copies already deleted (8.6).
- **Before a `moved` row deletes anything,** the worker looks up the object's row, asks the store it now names for the object, and requires the right size.
    - No row (purged since): delete; nothing depends on this copy.
    - Present at the right size: delete.
    - Absent or wrong: do not delete, mark the row `attention`, tell operators.
- **A flip back withdraws the row.** An object returns to a store that still holds its old copy without being copied again. First the worker asks that store for the object and requires the size on its row. A store that no longer has it, or has it at another size, gets a fresh copy like any other. Then the transaction that flips the object deletes the `moved` row for that store and writes one for the store it left. The outbox job and a flip both lock the row they act on, so a copy is never deleted while it is being taken back. If the job got there first, the flip finds no row and the bytes are copied back like any other.
- **A purge after a flip** adds `(object, current store)`, reason `purged`, which no longer collides with anything. It also clears the hold and the wait on that object's `moved` rows: nothing can be undone for an object that is gone.
- **Finished rows are deleted** 30 days after `done_at`, instead of kept for ever.
- **A backup copy under a key that cannot delete** (the default, 10.1) is not the outbox's to remove. The row records that the copy was left for the operator (`backup_left`) and finishes. The copy is named on the list of the night its row turns 30 days old (10.1), just before that row is removed with the other finished ones.
- **"Known at this store."** The orphan sweep of store S treats a key as known when an object row names it with `store_id` S or `backup_store_id` S, or an outbox row for that key and S has not finished. A row for another store, or a finished one, no longer makes a key known here.
- **A previous-release container** writes outbox rows with no store id during a rolling update. The column's default gives them the environment's primary, which is where every object is until a database store is first activated. 11.1 says what that rules out. (That was PR 1's release. PR 2 dropped the default: 11.1.)

**Settled when it was built (PR 2),** where the rules above were silent:

- **No row deletes the copy at the store its object's row names,** whatever its reason. The worker reads the object's row under the outbox row's lock; such a row is marked `attention` and nothing is deleted. A stray row for the store an object lives at, or an object id met twice, then costs a mark, not a file.
- **An object that arrives at a store clears what is queued for it there.** The flip (`flipObjectStore`, the only place `store_id` changes) withdraws an unfinished row for the target whose copy is still there, `moved` or `stray` alike: the bytes under one key are the same bytes. A row whose copy there is already deleted and that only waits to remove the backup copy is finished without removing it: the object is back at the store that backup serves, and its copy there is made afresh under the same key. Left unfinished, that row would have swallowed the `moved` row of the object's next move out, and the copy left at this store would never have been deleted.
- **A flip onto a fresh copy is refused when the outbox deleted at the target since that copy began** (`copy-needed`). The mover reads the database's clock before it copies and passes it; a deletion is stamped with the same clock after the store answered.
- **A purged, published object waits for its backup only as a `purged` row.** A `moved` or `stray` copy waits for no backup: the object lives on elsewhere.
- **Whether a backup copy is deleted is decided twice.** When the primary copy goes: if no region names that backup store with pruning on, the row finishes at once with `backup_left`. When the undo window has passed: if this worker's environment cannot open that backup, the row finishes with `backup_left` too, instead of failing for ever; and if a live object's row names that backup store as where its backup is, the copy is that object's and stays (two regions may share one backup store).
- **A finished row with `backup_left` is not removed after 30 days yet.** It is the only record that the copy is there until 10.1's nightly list (PR 7) names it; that list removes the row.
- **`attention` is not final.** The row is looked at again on later runs, behind the others, and is deleted, with the mark cleared, once the new copy is seen at its size. Operators are told by one log line when a row is first marked; a page (PR 8) shows the count.
- **A failed try is recorded on the row** (`failures`, `failed_at`), and rows are taken least-recently-failed first, so 200 rows for a store that is down cannot hold the outbox for every other store. The same for backup copies (`drive_objects.copy_failures`, left alone after ten in a row, 10.1).
- **A backup copy nothing accounts for is removed again.** When the mark finds neither the object at the store the copy was read from nor an outbox row for that copy, the copy just made is deleted from the backup, unless a row does name that backup for that key.
- **A purge that meets an unfinished purge of the same copy merges into it.** What either row knows is kept (that the object was published, that a backup copy exists and where) and the copy is removed again; the newer row is never simply dropped.
- **A purged copy stops waiting for its backup when its store says it is not there.** No backup of it can ever be made. A store that does not answer says nothing, and the row waits on.
- **Only a `ready` object flips.** A pending one is an upload in flight (8.2 step 3); a missing one is not copied (8.3). A copy made of either is queued as a stray.
- **A workspace deleted whole locks its objects before it queues them,** in the flip's order (the object, then its outbox rows), so a flip in flight is seen whole and the two cannot deadlock.
- **Account deletion queues its objects** (`queueWorkspaceObjects`), as a deleted family folder's purge does. The sweep was never the right tool: it removes no backup copy, and a report's hold means nothing to it.

### 8.5 Progress, stopping and cost

- The page shows objects and bytes done out of the total, the current rate, and what failed (by class, with a count). It promises no finish time.
- A copy that fails is retried on later runs. An object that fails ten times is listed and skipped. The move then ends as `incomplete`: new uploads stay at the target, the listed objects stay readable where they are, and no held row is released, so nothing is emptied.
- **Cancelling** starts the same move in the other direction; any store can be named as a target now. An object whose old copy is still there flips back without a copy, once that copy's size has been checked at the store (8.4).
- **Resuming** needs nothing: the work is "objects not at the target", and a copy that stopped halfway left at most an unfinished multipart upload, which is aborted.
- **The bytes pass through the worker.** A copy between two providers is read by the worker and written out, wherever the worker runs. Nothing is kept there. Section 17 says what that means for residency.
- **Who pays for the traffic:** the owner of each bucket, at their provider's rates. The start screen says how many bytes will be read, and that both copies are stored until the wait ends.
- **"No downtime" is true of reading, and of the phones.** Uploading from a browser tab opened before the target was ready needs one reload (7.3).

### 8.6 After restoring the database

`docs/self-hosting.md`, "After restoring the database", assumes one bucket. With stores in the database it must also say what follows. PR 8 changes the guide.

- A database restored to a point before a move's flips names the old store for objects whose only copy may now be at the new one. Keeping old copies for as long as database backups reach back (8.4) covers a restore within that time.
- For a restore outside it, the audit heals: an object missing at the store its row names is looked for under the same key in the stores that could rightly hold it (every region store, and its own company's), and its row is re-pointed to where it is found, after a size check (10.3).
- Stores added after the backup was taken are not in the restored database, and neither are their sealed keys. The operator adds them again, with their keys, before anything in them can be read. The page's "Download this list" (S17) exists so there is a record of them outside the database; the guide says to keep it with the backups.
- Until that is done, objects in a store the database does not know are `missing`, not lost.
- After a restore, `bun run drive:audit --all` runs a full audit pass at once instead of waiting for the nightly budget.

## 9. Retention

Per company, two numbers:

| Setting         | What it controls                                                      | Default | Range    |
| --------------- | --------------------------------------------------------------------- | ------- | -------- |
| Trash           | How long a trashed item, or a deleted company folder, can be restored | 30 days | 7 to 365 |
| Earlier version | How long the one earlier version of a file is kept                    | 30 days | 7 to 365 |

- **Who:** an Admin (the role that can open every company file), with the second step (3.3). It is a `retention-changed` fact in the ledger, with the Admin's detail record, and every Owner and Admin is told.
- **It does not add versions.** A file keeps its current version and the one before it. A third upload purges the oldest at once, as today. Retention only says how long the one earlier version lasts.
- **Quota.** Trash and earlier versions count against the company's storage until they are purged. A shorter setting frees space sooner; a longer one uses more. On a company's own bucket there is no cap, so it only changes how much the company stores.
- **Shortening waits.** A shorter setting applies from 7 days after it is saved (`retention_effective_at`). Until then the old one stands. The screen says how many items and bytes will be purged, and when. Otherwise one click would destroy everything in Trash at the next sweep.
    - **A still shorter setting saved during the wait starts the 7 days again.** Otherwise someone could save 29 days, wait six days, save 7, and have it apply the next day.
    - A setting saved during the wait that is no shorter than the one in force withdraws the pending change.
    - A longer pending value than the one waiting, but still shorter than the one in force, keeps the date already set.
- **Lengthening applies at once.**
- **The purge jobs** take the number from the workspace's company instead of a constant: `purgeExpiredTrash`, `purgeExpiredSupersededVersions` and `purgeDeletedAreas` join the workspace to its group and use its setting, falling back to `TRASH_RETENTION_DAYS`. Tombstones stay 90 days for everyone.
- **A hold wins.** A reported item under a hold outlives any retention, as today.
- **Clients.** Each space in `GET /api/drive/spaces` carries `retention: { trashDays, versionDays }`. The web and both phones say "Items here are deleted after {n} days" from it; in settings, the line of 4.2 under it says that backups and exports keep copies longer. Capabilities keep `trashRetentionDays` as the deployment's default for personal spaces and families.

Families and personal spaces keep 30 days. Nothing here lets them change it.

## 10. Backups, exports and restore

### 10.1 Object backups, per region

Today's replica, made a property of each region.

- A region may name a **backup store**. Its key is sealed to the worker (2.6), and attaching it runs 2.5's probe against the region's store. The worker copies every object of the region's store that has no backup yet, in batches.
- **How often:** every five minutes (today's behaviour, and the default), hourly or daily. The page shows how many objects are waiting.
- **The backup's key cannot delete, by default.** The form asks for a key that can write and read, and says why: nothing HushOS does, nobody who steals the key, and nobody who breaks into the web container and writes the database (2.6) can then remove a backup copy. The second revision accepted such a key and did not make it the default.
    - **What that does to pruning.** With such a key HushOS removes nothing from the backup. A purged object's backup copy stays until the operator removes it. Each night the worker writes `hushos-prune/{yyyymmdd}.txt` to the backup bucket: the keys of copies that turned 30 days past their object's purge, or past its move to another region, that day. Thirty days is the window for undoing a bad purge. Each file names that night's keys only, and the files stay until the operator removes them. The operator deletes exactly what they name, with a key of their own. The guide gives the command.
    - **Not by age.** An object is copied to the backup once. A lifecycle rule that expires objects by age therefore deletes the backup copies of files people still have. The form says so, and `rules` warns when it finds one (5.2).
    - **With a key that can delete,** and pruning turned on for that backup (`backup_prune`), it is as today: the backup copy goes 30 days after its object was purged.
    - Either way, an object's primary copy is deleted only once its backup exists.
    - The backup's audit (below) finds a live object whose backup copy has gone and clears its mark, so it is copied again.
- **A failed copy does not stop a run.** `replicateObjects` stops at the first object that throws today. A copy that fails is counted and retried on later runs. After ten failures the object is listed on the page and skipped, and the run goes on.
- **The audit has a budget per store,** not a fixed 200 objects.
    - Today's 200 a night would take about 500 days to pass once over 100,000 objects. A lost object would be found by whoever next opened the file.
    - Each store has a target for one full pass: 30 days for a store people read from, 90 for a backup (`STORAGE_AUDIT_PASS_DAYS`, `STORAGE_BACKUP_AUDIT_PASS_DAYS`).
    - Each night's run takes `ceil(objects ÷ target)` objects, least recently confirmed first, at no more than 20 requests a second.
    - The page shows, per store, "A full pass takes N days at the current size" and when the last one finished.
- **What an audit confirms:** that an object is there, at its size. It does not read the bytes. Corruption that keeps the size is found by the check's sample below, or when someone opens the file and their device refuses it.
- A primary copy that is lost and still in the backup is copied back (10.3). The first revision said "before anyone notices". The cadence never supported that, and it is gone.
- **The check** ("Check this backup"): the worker takes a sample (50 objects by default, at random, or one named object id), reads each from the backup, and compares its size and SHA-256 with the primary copy. The page shows how many matched, how long it took and the rate, with the date. This is the "test restore" the page offers; section 17 says what it is not.
- **Where a backup is** is the operator's to choose and to label. A backup of the EU region in a US bucket puts EU file contents in the US. The page shows both labels side by side and says nothing is enforced; the company's screens repeat the backup's label (4.2).
- A company's own bucket has no HushOS backup. Its export (10.2), or its provider, is its second copy.

### 10.2 A company's export

An Owner names a bucket (the same form, with the test profile of 5.1; kind `export`) and a schedule. The company's own bucket may be used, in which case only the snapshot is written and the objects are already there.

- **The key should not be able to delete, and that is the default.** The form asks for a key that can write and read, and says why: nothing HushOS does, and nobody who steals the key from HushOS, can then remove anything from the export. With such a key HushOS never deletes from the export bucket. Old snapshots and the objects of deleted files are the company's to remove, from the list each run writes (step 4), never by a rule that expires objects by age. The screen says so and shows how much the export holds.
- An Owner may instead give a key that can delete and turn pruning on.

Each run, `storage.export` on the worker:

1. **Objects.** Copies every ready object of the company's folders not yet exported to `export/objects/ws/{workspaceId}/{objectId}`, bounded and verified as a move's copy is, and marks each (`exported_at`). Objects never change, so each is copied once. A copy that fails is counted and retried on the next run; the run goes on.
2. **A snapshot of the metadata,** read in one repeatable-read transaction so that it is one moment of the database, and written to `export/meta/{yyyymmddThhmmssZ}-{seq}.hushos-export`: one gzip-compressed file of JSON lines.
    - Every object row in it carries `exported: true` or `false`, as of that moment. A restore treats a `false` one as missing; the next run exports it.
    - The first revision copied objects and then took the snapshot, with nothing tying the two together. A snapshot could list as present an object that was not yet in the export.
    - **The transaction is capped at five minutes.** A repeatable-read transaction holds back vacuum for the whole database while it is open, and one per company every hour adds up. A company whose metadata cannot be read in that time has its run fail and its Owners told. An operator can point exports at a read replica (`EXPORT_DATABASE_URL`), where a long transaction holds back nothing on the primary.
3. **Pruning, only where it was turned on:**
    - snapshots: the last `keep` are kept (14 by default, 2 to 90) and older ones deleted;
    - an exported object is deleted only when no kept snapshot lists it. A purged object's outbox row records the last snapshot that listed it (`export_last_seq`), and its exported copy goes when the oldest kept snapshot is newer than that.
    - So no kept snapshot names an object the export no longer holds. The first revision deleted an object 30 days after its purge, while up to 90 weekly snapshots could still list it.
4. **A list of what may go, every run, whether or not pruning is on:** `export/prune/{seq}.txt`. It names every snapshot older than the last `keep`, and every exported object that none of the last `keep` snapshots lists.
    - With the default key this is how a company prunes safely: it deletes exactly what the newest list names, with a key of its own.
    - An object is exported once, under a key that says nothing about its age or whether it is still wanted. So the natural rule, "expire objects older than N days", deletes live files from the export while their rows still say exported. The form says not to, and `rules` warns when it finds such a rule (5.2).

- **When the export is detached, or the company is deleted,** every pending deletion from that export is cancelled and its key is discarded. HushOS never touches that bucket again. Otherwise the last thing a deleted company's export would see is HushOS emptying it, a month later, of the files the export exists to keep.

**The schedule:** daily by default; hourly or weekly by choice. A snapshot is the whole of the company's metadata each time, so an hourly schedule is honoured only while a run takes under ten minutes. Past that the company is told and the schedule falls back to daily.

**What a snapshot holds:**

- the company's row, its policies, alert rules, verified domains, retention and storage settings;
- the member list as the server holds it (account ids, names, the address each joined with, roles, states) and every roster, succession, area list, share log entry and fork dismissal, as signed bytes;
- the group key seals, the company key seals and the kit seals, as stored;
- each folder: its workspace row, grants, nodes with their envelopes and signatures, file versions, object rows (framing, sizes and whether exported), shares and links with their sealed keys, and workspace documents;
- the sealed ledger rows and their ten-minute keys (`companies-design.md` 2.5);
- each member's public identity and its signed history.

A snapshot holds what the server held when it was taken. Someone removed since still appears, with their address, in every snapshot from before. With pruning on that is up to `keep` runs back; without it, for as long as the company keeps the files. The screen says so.

**What it never holds:** anyone's password record, account key envelopes, recovery envelope, sessions, devices, second-step secrets, or anything of a personal space or a family. A person's account is theirs, and a copy of it in the company's bucket would let whoever reads the bucket guess at their password offline.

**The file:**

```
{"format":"hushos-company-export","version":2,"groupId":"…","seq":41,"previous":"<sha256 of snapshot 40>","createdAt":"…","deployment":"<APP_ORIGIN>","keyId":"…","final":false,"rosterVersion":118,"rosterDigest":"…"}
{"table":"groups","row":{…}}
…
{"summary":true,"rows":123456,"objects":{"exported":98000,"pending":12}}
{"end":true,"sha256":"<of every byte before this line>","signature":"<base64url>"}
```

- **The signature** is Ed25519 over the canonical JSON `["hushos/export/snapshot",2,groupId,seq,previous,sha256,keyId]`, under the export signing key.
- **The counts are in a line of their own, before the end line,** so they are inside the hash the signature covers. In the second revision they sat in the end line, outside it.
- **That key is its own:** `EXPORT_SIGNING_KEY`, a 32-byte seed, set on the worker only. The first revision derived it from the OPAQUE server setup. That key could not have been rotated without replacing the setup, sits beside the database when the setup does, and is not on the worker at all. A rotated key signs from the next snapshot on. The page shows each public key with its id, and the verify tool takes a list.
- It protects a snapshot against being altered or cut short in the bucket. It is the server's word, no more: what makes the contents trustworthy on a restore is what makes them trustworthy today, the signatures and seals inside, which members' devices check against their own records.
- **It does not show that the newest snapshot is the newest.** Someone who can delete from the bucket can remove the last one, and the chain of `previous` then ends one earlier with nothing wrong in it. 10.5 says who notices.
- **What a snapshot shows someone who can read the bucket but holds no key:** who the members are, with the addresses they joined with; how many folders, files and versions there are, with sizes and times; who shared what item id with whom. No file name, no contents, no ledger detail.

**Checking an export** (in PR 12, not left for the day one is needed):

- `bun run export:verify <bucket>` reads every kept snapshot, checks the chain and each signature, and for the newest compares one listing of `export/objects/` with what the snapshot marks as exported: each such object must be there, at its size. It makes no request per object.
- The worker runs the same after each run, and the Storage screen shows the result beside it.
- **What verify finds missing is exported again.** For a live object that is marked exported and is absent from the listing, or there at another size, the worker clears `exported_at`. The next run copies it, and the snapshot after that lists it as present. The second revision noticed and did nothing.
- CI restores a snapshot's rows into a scratch database (`bun run company:restore --rows-only`) on every change to the exporter. A snapshot that nothing can read back is then caught when the exporter changes, not on the day someone needs it.

### 10.3 Finding and healing missing objects

When the audit finds an object missing at the store its row names, it looks, in order:

1. in the region's backup store;
2. in the company's export, when the object is a company's;
3. under the same key, in the other stores that could rightly hold it: every `region` store, and the `company` store of the workspace's own company. That is where a move, or a database restored to before one, would have left it (8.6).

- **Never in another company's bucket.** The second revision searched "every other store the worker can open". Each company's provider, or the server its Owner runs, would then have been asked for another tenant's workspace and object ids, which contradicts 4.3. And a store that answered with the right size would have had the row re-pointed to it: a personal file's row naming some company's bucket.
- Found in the backup or the export: it is copied back, bounded, and checked for size. **A row is never re-pointed to a `backup` or `export` store.** Those hold second copies under keys the web process cannot open, so nothing could be signed from them.
- Found at a region store, or at its own company's store: its row is re-pointed to that store after a size check. Nothing is copied.
- Found nowhere: it is marked `missing` and listed, as today.
- **An app that is told "not found" says so.** A client that gets 404 or `NoSuchKey` on a signed download URL it was just given reports it (S40). The server checks that the caller may open that object, exactly as it would to sign another URL, and queues an audit of that one object at once, which heals it when a copy exists. So a lost object is checked the first time anyone trips on it, not at its turn in a pass that takes a month.
    - **One queued audit per object, with a cooldown.** A report for an object that has an audit queued, or was audited in the last hour, queues nothing. The answer is the same either way, so it tells nobody whether someone else reported, or whether the object is there.
    - **Limits:** ten an hour per person. A link's visitor reports through the link's own route, limited to ten an hour per link and per address.
    - **It keeps no row of who asked, and none of what was asked for.** The job's row names the object and is deleted when the job completes, whatever it found. Left in place it would be a readable "this object was asked for at this time" in a company's area.
- **Who is told.** Operators, for a region. For a company's own bucket, its Owners and Admins: a notification and a mail on the first missing object, then a daily count while any remain, with the list on the Storage screen. Today nobody tells a company anything.

### 10.4 Leaving for another server: what it would take

**This section and 10.5 are for after this release, unless the owner decides otherwise** (decision 2). They are specified so the decision can be an informed one. Nothing else in this document depends on them. Until they are built, no page, mail or post calls an export a way to leave. They have been designed three times and reviewed in the first two forms only. Before PR 14 is built they need a review of their own, with the rule 10.5 adds written into `companies-design.md`.

The agreed direction was that an export restores into a self-hosted HushOS. A snapshot is not yet a company people can use there, and two earlier answers to that were wrong.

- **A restored company has no accounts.** A snapshot holds none (10.2), and must not.
- **The first revision's answer was wrong.** It had each member register on the new server under the same account id and upload their account envelopes there. On the web that means unlocking, or typing a recovery phrase, into a page the new server serves. That server is typically the employer's, and its script would then hold the keys to the member's personal account at the old server. Even from a phone, the new server would hold an envelope it could try passwords against, for that same identity.
- **The second revision's answer cost too much.** It gave each person a new account id. But folder lists, an employee area's assignee, share records and every stored signer name the old id. A person with a new id is on no folder until every list is signed again, and marking fifty entries left makes every folder's key change owed. It also ran into the member list's rules (`companies-design.md` 2.1): dropping a data admin replaces the company key, the kit follows `recovery`, nobody is admitted on a roster that drops a holder, and nobody signs the roster that marks themselves left. The first revision's fault was the envelopes, and the unlocking on the new server's page. It was never the id.

So: **nobody's password, account envelope, recovery phrase or identity key goes to the new server, and nobody's id changes.** Each person registers there under the id the member list already names, with a new password, a new identity and a new recovery phrase. They prove with their old identity, on a device that already holds it, that the new identity is theirs. The new identity is then folded into their own entry, as a signed key replacement is today.

- The same id at both servers links the person across them. The snapshot already does: it lists members by id.
- The new account is otherwise empty. Its personal space there is a new one. Nothing personal comes along.

**The tool.** `bun run company:restore <snapshot>` on the target deployment, run by its operator.

- It verifies the chain and the signature (the source deployment's public keys are given on the command line), refuses a company id the database already has, refuses when any member's id is already an account there, and inserts the rows.
- It reserves every member's id. No account can be registered under one except by 10.5's step 5.
- It points the company at a store holding the exported objects: the export bucket read in place, or a copy of it in a region.
- It warns when the snapshot is not marked `final` (10.5).
- After it, the company exists with its member list, and nobody can open it.

### 10.5 Moving a place

1. **Freezing, at the old server.** An Owner chooses "Prepare to move {company} to another server" (S50: stepped, recorded). The company becomes read-only there: no change to the member list, no upload. One last export runs, and its snapshot is marked `final`, with the member list's head (version and digest) in its first line. So the snapshot and every member's device agree on where the member list ends. An Owner can undo the freeze until the company is deleted there. Undoing it brings back the member list as it was frozen: nothing signed at the new server comes with it.
2. **Starting at the new server.** On its sign-up page the person chooses "I was a member of {company}" and gives the address they are listed with. Their device makes a new identity and a new recovery phrase, as any sign-up does, and they choose a new password. Nothing of their old account is typed or sent. The new server holds this as a pending registration under their reserved id. It is not an account yet: it can store nothing and opens nothing.
3. **A request, and a code.** The new server shows a request, as a link and as a QR code to scan: its own origin, the company, the member's id, a digest of the new identity's public keys, the key version that identity will have (one more than the member's entry names), and the snapshot it restored (sequence, digest, and the member list's head). Beside it, the same screen shows **a transfer code**, six characters such as `K7P-2QD`, which the device works out from the request:

    ```
    the first 30 bits of sha256(["hushos/group/transfer-code",1,groupId,userId,newOrigin,sha256(new identity public keys)])
    ```

    The code is never in the link, and never in what is scanned.

4. **The transfer statement, at the old server.** On a device signed in to their old account (the web at the old address, or a phone), "Move my place in {company}" takes the request, shows the new server's address and the company in plain words, and **asks for the code from the screen where they are signing up.** The device works the code out from the request and signs only when what was typed matches.
    - That is what ties the person at the old device to the request. Without it, the operator of the new server, or anyone who can reach its sign-up page, could start a registration under an Owner's id with an identity of their own, send that request's link to the Owner, and be sealed the group's and the company's keys when the Owner approved what looked like their own move. The second revision had exactly that hole.
    - A request someone else made has a code the person's own screen never showed. They would have to be told it, and type it in. The screen says: "Type the code shown where you are signing up. Never type a code someone sent you."
    - It then signs, under the old identity (the hybrid signature a member-list entry is checked against):

        ```
        ["hushos/group/transfer",2,groupId,userId,oldKeyVersion,newKeyVersion,sha256(new identity public keys),newOrigin,snapshotSeq,rosterVersion,rosterDigest]
        ```

    - The new identity signs it too, at the new server. A statement carries both halves, as a succession's consent does (`groups-server.md` section 5): the old identity over the statement with `"old"` appended, the new one over it with `"new"`.
    - The device first compares the request's member-list head with its own. If the new server's is older, it says what is missing ("This copy is from 3 November. Since then 2 people were removed.") and signs only if the person goes on.
    - The statement is public. It is carried back as a link or a file. The old identity's private keys never leave the device, and are never in a page the new server serves.

5. **Registration finishes with the statement.** The new server finishes a registration under a reserved id only when a statement for it verifies under the keys that id's entry names on the restored chain, and only for the identity the statement names (403 `transfer-required` otherwise). The account now exists. It is on the member list by its id, and it can open nothing yet: every seal and grant is still to its old identity.
6. **An Owner folds their own new identity in.** An Owner's old device holds the group's and the company's keys. It signs the next member list on top of the snapshot's head: its own entry moved to the new identity, with the same roles, and the group's and the company's keys sealed to it. That is a change to their own entry, signed under the keys it named before, which rule 8 already lets an Owner make (`companies-design.md` 2.1). If its own chain shows people as having left since the snapshot was taken, the same list marks them left. The new account uploads the list, the statement and the seals (S54). Uploader and signer are the same account id, as every roster route requires.
7. **Everyone else is folded in at the new server.** An Admin's or an Owner's device there verifies a member's statement against the entry on its chain, and signs a list that moves that entry to the new identity, with the keys and grants that person is owed sealed to it. Roles, folder lists, shares and every stored signer are untouched, since the id is the same.
    - **A guarded entry** (an Owner's, or a kit holder's who is not one) whose own person cannot sign for it is folded in by another Owner only after a fresh words check of the new keys, as `companies-design.md` 2.2 requires of every guarded fold-in. The statement does not replace that check. Whoever stole an Owner's old keys can sign a statement as easily as a link.

What this takes, and what it leaves:

- **One new rule about evidence, and none about who signs.** Today an entry moves to new keys when a succession link from the old identity to the new one verifies. Here there is no such link: the new identity belongs to an account at another server. The rule: in an `org` group, an entry may move to an identity whose key digest a transfer statement names, when both of the statement's signatures verify, the statement names this group, this member and the next key version, and its origin is the server the device is talking to. Who may sign such a list is unchanged: rule 8 for a guarded entry, any `members` holder for the rest. Nobody leaves and nobody is admitted, so the kit rule, the company key rule and "no admission on a roster that drops a holder" are not touched. The rule is not in `companies-design.md`. It changes what devices trust, and must be specified there and reviewed as the Owner rule was, before PR 14 is built.
- **The recovery kit plays no part.** This differs from the first review's recommendation, which had the first Owner start with it (section 17). An Owner with a device needs no kit: that device holds both keys. An Owner without one cannot be told from anyone else by a kit, which proves the company's key and not who is holding it. A company with no Owner able to sign is the company spec's lost-Owner case, and is recovered there (2.2), at the old server, before freezing.
- **What the restoring operator learns:** what a snapshot shows (10.2): members, addresses, the shape of the files. **What they control:** whether the company is available; which snapshot is restored; who may start a registration. **What they cannot do on their own:** add a member, give a role, change an entry or read a file. Every change to the member list is still signed by an Owner or an Admin and checked by devices. **What they can do with a member's help:** start a registration under that member's id, and get the member to approve it. The typed code is what stands against that. A member who types a code someone gave them hands over their place, and an Owner who does hands over the company's keys. Nothing in the member list can tell that from an honest move.
- **An older snapshot than the latest** is noticed by every device that signs a statement, since each compares heads, and by the Owner's, which re-applies the removals its own chain shows.
- **An Owner may restore an older snapshot on purpose.** Their device says what it is doing. Every member is told at the new server, on the company's first screen ("This copy of {company} is from {date}"), and it is the first fact in its ledger there.
- **The operator's own account** at the new server has an id of its own, which is no member's: the tool refuses a snapshot when it already has one of its member ids. An operator who is also a member registers their place under their member id, like anyone else. If their operator account holds the address they are listed with, it changes its address first (`companies-design.md` 3.2). How one person's two accounts there should sit together is not settled here, and is for PR 14's own review.
- **Roles need the second step.** The new server refuses a list that folds a new identity into an Owner's or an Admin's entry unless that account has a method (`step-required`).
- **Device approval.** A transferred person's first device at the new server is their first there, as for anyone who joins. The company's gate applies from the second.
- **A member with no device and no phrase for their old account** cannot sign a statement. An Owner removes them and lets them in afresh at the new server, under a new id, at what a removal costs. The company key reopens their company files, as after any lost account.
- **Personal files do not come along.** Moving a personal space is a separate matter and not in this design.
- **The cost:** a new rule of evidence in both cryptographic twins, a registration that waits for a statement, a flow on the server and on all three clients at both ends, and the freeze. It is the largest pull request in this document.

### 10.6 Database backups

HushOS does not run them and cannot see most of them: a volume snapshot, a `pg_dump` in a cron job and a provider's managed backups all happen outside the application. The page shows only what it can honestly know.

- **A report.** A backup job tells HushOS when it finished:

    ```sh
    curl -fsS -X POST "$APP_ORIGIN/api/admin/backups/database/report" \
        -H "Authorization: Bearer $BACKUP_REPORT_TOKEN" \
        -H "Content-Type: application/json" \
        -d '{"finishedAt":"2026-11-10T03:00:12Z","ok":true,"sizeBytes":812345678,"tool":"pg_dump"}'
    ```

    `BACKUP_REPORT_TOKEN` is a variable on the web service. The page shows the last report, and warns when the last good one is older than `DATABASE_BACKUP_EXPECTED_HOURS` (default 26).

- **The archiver.** Where Postgres archives its write-ahead log and the application's role can read `pg_stat_archiver`, the page also shows when a segment was last archived and whether the last attempt failed.
- **Otherwise** it says: "HushOS cannot see your database backups. Have your backup job report here." with the command above.
- It never says a backup is restorable. Only a restore drill shows that, and the guide says how to run one.

## 11. The server

### 11.1 Schema

- `object_stores`: `id`, `source` (`environment`, `database`), `kind` (`region`, `backup`, `company`, `export`), `group_id` (for the last two), `endpoint`, `internal_endpoint` (operator kinds only), `signing_region`, `bucket`, `path_style`, `origin` (as signed URLs address it, for the policy), `key_hint`, `seal` (`symmetric`, `worker`), `secret_key_id`, `secret_nonce`, `secret_sealed`, `status` (`draft`, `checking`, `ready`, `failing`, `retired`), `draft_until`, `env_present`, `tested_at`, `test_result`, `probed_at`, `probe_failures`, `audit_pass_started_at`, `audit_pass_finished_at`, `stated_location`, `version`, `created_at`, `updated_at`.
    - An `environment` row has no address, bucket or secret.
    - **Nothing may conclude "there is no backup" from `env_present`.** The migration writes the replica's row as absent, and it stays so until the first worker of this release starts. A deployment that has had a replica all along therefore has a row saying false for a while, and one whose worker is down has a row saying whatever the last worker said. Whether a backup can be written or deleted is decided by the worker's own environment when it acts. The column is for showing, on the page, what the last worker reported.
    - Unique on (endpoint host, bucket) among `database` rows of kind `region` or `backup` that are not retired, after 2.3's normalising. Company and export stores have no such index (2.3). 2.5 is the real check.
- `storage_regions`: `id`, `code` (unique), `label`, `store_id` (never null), `backup_store_id` (null: none), `backup_every` (`5m`, `hour`, `day`), `backup_prune` (false by default), `is_default` (one row), `offered`.
- `storage_worker_state`: one row the worker writes at start: the release it runs, the id of its `STORAGE_SECRETS_KEY`, its public sealing keys and their id, and the export signing public key and its id.
- `groups` gains `region_id`, `store_id`, `export_store_id`, `export_every`, `export_keep`, `export_prune`, `frozen_at` (10.5, if built), `trash_retention_days`, `version_retention_days`, `retention_effective_at`, and the pending values a shortening waits with.
- `drive_objects` gains `store_id` (not null; default the environment's primary until PR 2 dropped it), `backup_store_id` (null: no backup copy) beside `replicated_at`, `exported_at`, and `copy_failures`. An index on `store_id` (`drive_objects_store_idx`), built `CONCURRENTLY` after the migration.
- `drive_uploads` gains `store_id` (the same default); `multipart_id` becomes nullable (2.2).
- `drive_object_deletions`: the primary key becomes `(object_id, store_id)`. It gains `store_id` (the same default), `reason` (`purged`, `moved`, `stray`), `backup_store_id`, `export_store_id`, `export_last_seq`, `held_by_move`, `not_before`, `backup_left` and `attention`, and `failures` and `failed_at` (8.4). An insert replaces a finished row for the same key (8.4). `reason` defaults to `purged`, for a container of PR 1's release, whose every row is one; a later release drops that default.
- `store_prefixes`: `(store_id, workspace_id)`, written at a workspace's first upload to a company store and at the first copy made into it (4.3).
- `storage_moves`: `id`, `scope`, `group_id` or `region_id`, `from_store_id`, `to_store_id`, `state` (`preparing`, `copying`, `done`, `incomplete`, `blocked`, `cancelled`), `switch_at`, totals and counts, `cursor`, times.
- `storage_tests` (kept 24 hours), `storage_backup_checks`, `group_export_runs`, `database_backup_reports`, `operator_events` (with its trigger).
- `users` gains the `storage` capability beside the admin flag.
- The step token purposes gain `operator-storage` and `company-storage`.

**No account id on a company's storage rows.** A company's store, move, test or export run records no `created_by`, `started_by` or tester. Who did it is in the company's sealed ledger (3.4). A readable copy here would be the who-and-when the owner directed the server not to keep. Operator rows carry none either: who is in `operator_events`. What does stay readable about a company's storage is listed in section 12.

**The shape a previous release writes.** `replicated_at` set with `backup_store_id` null is written only by a worker of the previous release, which knows no backup but the environment's replica. The new worker rewrites those rows to name it, at every start. The release after this one adds the check that forbids the shape.

**A rolling update.** Every new column is nullable or defaulted, so containers of the previous release keep working **until the first database store is activated**. From then on, a previous-release web container would sign URLs at the environment's store for objects that are elsewhere (a failed download; nothing lost), and write outbox rows naming the wrong store (a deletion that finds nothing; the orphan sweep at the right store removes that copy a week later). So activation (S8, and a company's S25) is refused while `storage_worker_state` names an earlier release, and the release note says to finish the update before activating a store.

**What PR 1's migration leaves for PR 2's.** PR 2 already rewrites the outbox's key, so its migration also settles these two:

- **Four constraints added `NOT VALID`,** so that no existing row was read under the migration's lock: the foreign keys from `drive_objects`, `drive_uploads` and `drive_object_deletions` to `object_stores`, and the check `drive_uploads_multipart_started`. They bind every row written since. PR 2 validates them (`VALIDATE CONSTRAINT`, which reads the table under a lock that blocks no read or write, in a transaction of its own). `packages/db/src/constraints.test.ts` lists every unvalidated constraint in the schema and fails when one is added without a line there.
- **The three `store_id` column defaults.** They exist for containers of the release before PR 1, which name no store. Once that release is gone they are wrong: an insert that forgets its store silently means the environment's primary, which stops being right the day the default region is moved off it. PR 2 drops them, and from then on every insert names its store. It must not be deployed while a container older than PR 1's release still runs.

**What PR 2 did about both, and how.** Drizzle applies every pending migration in one transaction, so a `VALIDATE CONSTRAINT` there would read its table under whatever lock an earlier statement took, and `CREATE INDEX CONCURRENTLY` cannot run there at all. `bun run db:migrate` therefore runs a second step after drizzle-kit (`packages/db/src/after-migrate.ts`): each validation and each concurrent index build as a statement of its own, safe to run again, reported and left pending when it fails, and named by the worker at every start while pending. It validates PR 1's four, PR 2's own five, and the twelve older ones no release had validated; and it builds `drive_objects_store_idx`. `constraints.test.ts` now fails when a migration adds a constraint `NOT VALID` that this step does not validate.

`group_storage` already exists and is the family pool's table. Nothing here uses that name.

### 11.2 Code

- `primaryStore()` becomes `storeFor(storeId)`. `uploadStoreFor(tx, workspaceId)` implements 2.2 inside the repository's transaction. `replicaStore()` becomes a region's backup store. `evidenceStore()` is unchanged.
- `copyFrom` takes the expected size, bounds every read and carries a total deadline (2.4). Every store call goes through the per-store cap and breaker.
- The worker jobs take a store per row, serve the stores in turn, and keep each within its share of a run (2.4):
    - `expireUploads`, also for rows that never got a multipart id;
    - `deleteObjects`, one `(object, store)` row at a time, with 8.4's look before a `moved` deletion;
    - `replicateObjects`, by compare-and-set, and without stopping at the first failure;
    - `auditObjects`, with the budget of 10.1 and the search of 10.3, which never leaves the region stores and the workspace's own company's;
    - `sweepOrphans`: "known at this store", paused on a move's target, one cursor per store, and per-workspace prefixes in a company bucket;
    - `tierObjects` (the environment's primary only, as today);
    - `copyEvidence` (reads from the object's store).
- New jobs: `storage.probe`, `storage.test`, `storage.identity` (one at a time), `storage.expire-drafts`, `storage.move`, `storage.export`, `storage.backup-check`, `storage.backup-prune-list`, `storage.audit-object` (its row deleted when it completes).
- The policy plugin builds `storeOrigins` per request (section 7).

### 11.3 API contract

Base64url without padding; ids lowercase UUIDs; byte counts as decimal strings. Bodies are capped at 16 KiB. "Step" means the step-up of 3.3. `record` is a detail record as `companies-design.md` 2.5 defines one; a route that lists it answers 400 `audit` without a valid one. `StoreView` is `{ id, kind, source, endpoint, signingRegion, bucket, pathStyle, origin, keyHint, status, statedLocation, lastTest, lastProbeAt }` and never a secret.

Operator routes. Without the `storage` capability, 404 on all of them but S16.

| #   | Route                                              | Who                                     | Body → response                                                                                                                                                                                                                                                           |
| --- | -------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | `GET /api/admin/storage`                           | operator                                | → `{ home, regions: [{ id, code, label, isDefault, offered, store, backup, backupEvery, objects, bytes, unbacked, missing, audit: { passDays, lastFullPassAt }, move }], keys: { symmetric, worker }, databaseBackup }`                                                   |
| S2  | `POST /api/admin/storage/stores`                   | operator                                | `{ kind: 'region' \| 'backup', endpoint, internalEndpoint?, signingRegion, bucket, pathStyle, accessKeyId, secretAccessKey, statedLocation? }` → 201 `{ store }`, a draft; 409 `secrets-key`; 400 `invalid`                                                               |
| S3  | `PATCH /api/admin/storage/stores/:id`              | operator; step when the store is in use | `{ statedLocation? }`, or `{ accessKeyId, secretAccessKey }` to replace the key, or the address fields with the secret while a draft → `{ store }`; 409 `in-use` for an address change on a store in use                                                                  |
| S4  | `POST /api/admin/storage/stores/:id/test`          | operator                                | `{}` → for a region: `{ testId, server: [{ check, ok, reason? }], warnings, browser: { put: { url }, get: { url, start, end, sha256 } }, expiresAt }`; for a backup: 202 `{ testId }`, run on the worker                                                                  |
| S5  | `POST /api/admin/storage/stores/:id/test/:testId`  | operator                                | For a region: `{ put: { status, etag? }, get: { status, bytes?, sha256? } }` → `{ passed, checks }`. `GET` on the same path → `{ state, checks, warnings }`, for any kind. A pass queues 2.5's probe; the store is `ready` when it passes, or the test ends `same-bucket` |
| S6  | `POST /api/admin/storage/stores/:id/cors`          | operator                                | `{ replace: true, adminAccessKeyId, adminSecretAccessKey }` → `{ applied }`: sends 6.1's rule with the admin key given, which is used for this call and never stored; 409 `unsupported` when the store or that key refuses                                                |
| S7  | `DELETE /api/admin/storage/stores/:id`             | operator; step unless a draft           | → `{ deleted }`; 409 `in-use` while any region, object, upload or unfinished outbox row names it                                                                                                                                                                          |
| S8  | `POST /api/admin/storage/regions`                  | operator, step                          | `{ code, label, storeId, offered, isDefault?, backupStoreId?, backupEvery?, backupPrune? }` → 201 `{ region }`: activation, in one call; 409 `untested`, `same-bucket`, `updating`                                                                                        |
| S9  | `PATCH /api/admin/storage/regions/:id`             | operator, step                          | `{ label?, offered?, isDefault?, backupStoreId?, backupEvery?, backupPrune? }` → `{ region }`; 409 `same-bucket`                                                                                                                                                          |
| S10 | `POST /api/admin/storage/regions/:id/move`         | operator, step                          | `{ toStoreId }` → 201 `{ move }`; 409 `untested`, `moving`, `same-bucket`                                                                                                                                                                                                 |
| S11 | `GET /api/admin/storage/moves/:id`                 | operator                                | → `{ move: { id, scope, state, switchAt, objects, bytes, done, doneBytes, failed: [{ reason, count }], attention, startedAt, finishedAt } }`                                                                                                                              |
| S12 | `POST /api/admin/storage/moves/:id/cancel`         | operator, step                          | → `{ move }`, the reverse move                                                                                                                                                                                                                                            |
| S13 | `POST /api/admin/storage/regions/:id/backup/check` | operator                                | `{ sample?, objectId? }` → 202 `{ checkId }`                                                                                                                                                                                                                              |
| S14 | `GET /api/admin/storage/backup/checks/:id`         | operator                                | → `{ state, sampled, matched, missing, mismatched, seconds, bytes }`                                                                                                                                                                                                      |
| S15 | `GET /api/admin/storage/events?after=`             | operator                                | → `{ events, next }`                                                                                                                                                                                                                                                      |
| S16 | `POST /api/admin/backups/database/report`          | the report token                        | `{ finishedAt, ok, sizeBytes?, tool?, note? }` → `{ recorded }`. No session; on the auth edge's allowlist with its own bucket                                                                                                                                             |
| S17 | `GET /api/admin/storage/stores.txt`                | operator                                | → the list to keep: each store's kind, address, bucket and key hint, as text. No secret                                                                                                                                                                                   |

Company routes, under the company spec's switch and its `not-member` rule.

| #   | Route                                                                 | Who            | Body → response                                                                                                                                                                                                                           |
| --- | --------------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S20 | `GET /api/groups/:id/storage`                                         | active         | → `{ region: { id, label }, home, backupHome, own: boolean, retention }`; an Owner or Admin also gets `{ store, exportStore, export, move, pendingRetention, missing }`                                                                   |
| S21 | `PUT /api/groups/:id/storage/own`                                     | Owner          | `{ endpoint, signingRegion, bucket, pathStyle, accessKeyId, secretAccessKey, statedLocation?, record }` → `{ store }`, a draft; 400 `invalid` (`endpoint-private`, `port`, `path-style`, `not-empty`); 409 `secrets-key`                  |
| S22 | `POST /api/groups/:id/storage/stores/:storeId/test`                   | Owner or Admin | As S4                                                                                                                                                                                                                                     |
| S23 | `POST` and `GET /api/groups/:id/storage/stores/:storeId/test/:testId` | Owner or Admin | As S5                                                                                                                                                                                                                                     |
| S24 | `POST /api/groups/:id/storage/stores/:storeId/cors`                   | Owner          | As S6                                                                                                                                                                                                                                     |
| S25 | `POST /api/groups/:id/storage/move`                                   | Owner, step    | `{ to: { own: true } \| { regionId }, record }` → 201 `{ move }`; 409 `untested`, `moving`, `same-bucket`, `over-quota`, `updating`; 402 `plan`                                                                                           |
| S26 | `GET /api/groups/:id/storage/move`                                    | Owner or Admin | As S11                                                                                                                                                                                                                                    |
| S27 | `POST /api/groups/:id/storage/move/cancel`                            | Owner, step    | `{ record }` → as S12                                                                                                                                                                                                                     |
| S28 | `PUT /api/groups/:id/storage/retention`                               | Admin, step    | `{ trashDays, versionDays, record }` → `{ retention, pendingRetention? }`: `pendingRetention` carries `effectiveAt` and what will be purged                                                                                               |
| S29 | `PUT /api/groups/:id/storage/export`                                  | Owner, step    | `{ store: { …as S21 } \| { ownBucket: true } \| null, every: 'hour' \| 'day' \| 'week', keep, prune, record }` → `{ export }`; 409 `secrets-key`, `same-bucket`                                                                           |
| S30 | `GET /api/groups/:id/storage/export/runs`                             | Owner or Admin | → `{ runs: [{ seq, startedAt, finishedAt, state, objects, bytes, pending, snapshotKey, sha256, verified }], publicKeys }`                                                                                                                 |
| S31 | `POST /api/groups/:id/storage/export/run`                             | Owner          | `{ record }` → 202 `{ seq }`                                                                                                                                                                                                              |
| S32 | `DELETE /api/groups/:id/storage/own`                                  | Owner, step    | `{ record }` → `{ deleted }`; 409 `in-use` while any object, upload or unfinished outbox row names it                                                                                                                                     |
| S33 | `PATCH /api/groups/:id/storage/stores/:storeId`                       | Owner, step    | `{ accessKeyId, secretAccessKey, record }` → `{ store }`: replaces the key of the company's own bucket or export target while it is in use, after the server checks of its profile pass with the new key; 409 `untested` when they do not |

Any signed-in person, and a link's visitor through the link's own route:

| #   | Route                                                          | Who                                     | Body → response                                                                                                 |
| --- | -------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| S40 | `POST /api/drive/workspaces/:id/objects/:objectId/unreachable` | Whoever could be given a URL for it now | `{}` → `{ ok: true }`, the same whether or not an audit was queued (10.3); 404 as for any item they cannot open |

Leaving (10.4, 10.5). After this release unless the owner decides otherwise; listed so the cost is visible.

| #   | Route                                          | Who                                       | Body → response                                                                                                                                                                                                                          |
| --- | ---------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S50 | `POST /api/groups/:id/storage/freeze`          | Owner, step, at the old server            | `{ record }` → `{ frozenAt, seq }`; `DELETE` undoes it                                                                                                                                                                                   |
| S51 | `POST /api/transfers/registrations`            | Anyone, at the new server                 | `{ groupId, email, identity }` → `{ request }`: a pending registration under the member's reserved id, not an account. An address that is no member's gets a request no statement can finish, so the answer does not say who is a member |
| S52 | `POST /api/transfers/registrations/:id/finish` | Whoever holds that pending registration   | `{ statement, registration }` → a session for the new account; 403 `transfer-required` unless the statement verifies under the entry's keys                                                                                              |
| S53 | `GET /api/groups/:id/transfers`                | Owner or Admin                            | → `{ transfers }`: the statements of members still to be folded in                                                                                                                                                                       |
| S54 | `POST /api/groups/:id/transfers/claim`         | An Owner's new account, for its own entry | `{ statement, roster, seals }` → the head; 403 `step-required`                                                                                                                                                                           |

Changed routes:

- Creating a company takes `regionId` (400 `invalid` (`region`) for one not offered).
- A listing of items shared with the caller gains `storeOrigin` per item (7.3).
- `GET /api/drive/spaces`: each area gains `storeOrigin` and, during a move, `nextStoreOrigin`; each space gains `retention` and, for a company, `region: { label }`, `ownStorage`, `storageFailing` and `frozen`.
- `GET /api/groups/:id` for a company gains `storage: 'hushos' | 'own'` for billing.
- Every Drive write in a frozen company answers 409 `frozen`.

Error codes beyond the company spec's:

| Code                | Status | When                                                                                                                                                                 |
| ------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid`           | 400    | A field fails 2.3 or 4.3; the reason names the rule (`endpoint`, `endpoint-private`, `host`, `port`, `path-style`, `bucket`, `shared-bucket`, `not-empty`, `region`) |
| `audit`             | 400    | A company route that lists `record` was called without a valid one (the company spec's code)                                                                         |
| `untested`          | 409    | The store has not passed a test in the last 24 hours                                                                                                                 |
| `same-bucket`       | 409    | 2.5's probe found the store readable through another                                                                                                                 |
| `secrets-key`       | 409    | A sealing key is not set, or the web's and the worker's do not match (2.6); `data.missing` says which                                                                |
| `in-use`            | 409    | The store holds objects or something points at it                                                                                                                    |
| `moving`            | 409    | A move is already running in that scope, or in one that overlaps it                                                                                                  |
| `over-quota`        | 409    | A move back into a capped region would not fit; `data: { bytes, free }`                                                                                              |
| `updating`          | 409    | A process of an earlier release is still running (11.1)                                                                                                              |
| `unsupported`       | 409    | The store, or the key given, cannot do what was asked (S6)                                                                                                           |
| `frozen`            | 409    | The company is frozen to leave (10.5)                                                                                                                                |
| `plan`              | 402    | Billing says the plan does not match where the files would be                                                                                                        |
| `step-required`     | 403    | A role that needs the second step was given to an account without one (10.5)                                                                                         |
| `transfer-required` | 403    | A registration under a member's reserved id without a transfer statement that verifies (10.5)                                                                        |
| `unavailable`       | 503    | The store's secret cannot be opened by this process, the store did not answer, or its breaker is open                                                                |

Rate limits, through `consumeRateLimit`: tests 10 an hour per store and 30 a day per person (each moves about 5 MiB through the server); draft writes and storage changes 20 an hour per person; `export/run` once an hour per company; `unreachable` 10 an hour per person, and per link and address for a link's visitor; database reports 60 an hour.

Logs: store ids and classes of failure. Never an endpoint's response body, a secret, an admin key given to S6, or a signed URL.

## 12. What the server learns

Beyond what it holds today:

- every region's and backup's endpoint, bucket and key, which it must hold to sign and to clean up. The web process can open region and company keys. Only the worker can open backup and export keys, and the worker can open every kind (2.6);
- **a key to each company bucket and export bucket.** What that key lets HushOS, or whoever steals it, do: list, read, write and delete objects in that one bucket. Every object there is ciphertext, so it can destroy or damage a company's files; it cannot read them, and a damaged file fails to open on a member's device rather than opening as something else. With the export key this design asks for, which cannot delete, the worst a thief can do to an export is add to it;
- what each company says about where its bucket is.

**What it keeps readable about a company's storage.** The same list is in `companies-design.md` section 5, added with this document:

- its region; its own bucket's address and stated location; its export target, schedule and pruning;
- its retention settings, and a pending change with its date;
- a move's state and counts;
- when each of its stores last passed a test, to the hour (the 24-hour rule needs it);
- when each export run started and finished, and how much it copied;
- how many of its objects are missing;
- that it is frozen to leave, and since when (10.5, if built).

No account id is on any of these.

**What it does not keep readable:** who changed a company's storage, started a move or ran an export by hand. Those are in the company's sealed ledger (3.4). Who ran a test is recorded nowhere: a test changes nothing anyone depends on (3.3), so S22 and S23 carry no record, and a test's row holds its result and its hour.

**What an operator changed, when, and who:** `operator_events`. That is the operator's own record, not a company's.

It does not learn any file's name or contents, and nothing about what is inside a bucket beyond the keys it wrote itself. The "not found" report (S40) keeps no row of who asked, and its job's row, which names the object, is deleted when the job completes.

What others learn that they did not before:

- **A company's storage provider, and whoever runs the company's bucket,** sees the address of every device that uploads or downloads company files, and when. That includes people outside the company opening a share or a link. Today the operator's own provider sees that. Such a provider or server is never asked for another tenant's ids: healing looks only in the region stores and in a workspace's own company's stores (10.3).
- **Whoever can read an export** sees what 10.2 lists, including people removed since an older snapshot was taken.
- **Whoever holds a link's address** to a file in a company's bucket learns that bucket's host, before any password (7.1).
- **The operator of a server a company moves to** (10.5, if built) sees what a snapshot shows, and nothing of anyone's old account.

## 13. Threats

| Who                                                                          | What they try                                                                                                                                             | What stops or limits it                                                                                                                                                                                                                                                                                                                                                                                                                              | What remains                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A hostile operator                                                           | Points a region at a bucket they read                                                                                                                     | Nothing stops it; it gains them ciphertext they could already copy from the old bucket. The change needs the `storage` capability and the second step, and is recorded                                                                                                                                                                                                                                                                               | An operator can always destroy files. A backup whose key cannot delete limits what a stolen key can do. It does not bind the operator, who holds the bucket itself                                                                                                                                                         |
| A stolen operator session                                                    | Adds a store and moves a region to it                                                                                                                     | The `storage` capability, so a support operator's session is not enough; the step-up on activation and on the move; the record; old copies kept seven days at least                                                                                                                                                                                                                                                                                  | An operator who is phished through a relayed code. A security key stops that; the guide says to use one                                                                                                                                                                                                                    |
| An operator with the admin flag and no `storage`                             | Opens the Storage page                                                                                                                                    | 404                                                                                                                                                                                                                                                                                                                                                                                                                                                  | None                                                                                                                                                                                                                                                                                                                       |
| Two stores that are one bucket, by mistake or on purpose                     | A move that deletes its own target; a backup that is its own primary; a sweep that deletes another store's objects                                        | 2.5's probe before a store is ready, at a backup's attaching, and at a move's start and finish; the look at the new copy before any old one is deleted (8.4)                                                                                                                                                                                                                                                                                         | Someone who controls both buckets and makes one an alias of the other between a move's last probe and its deletions. They could already delete both                                                                                                                                                                        |
| A company Owner                                                              | Points "their bucket" at something they do not own                                                                                                        | They need a working key for it, so they already had it. A bucket that reads through to a region's, a backup's or the evidence bucket is `same-bucket` (2.5). Names are not compared between companies (2.3)                                                                                                                                                                                                                                          | Two companies on one bucket, kept apart by prefixes and by rows (4.3)                                                                                                                                                                                                                                                      |
| A company Owner who runs their own S3 server                                 | Answers with endless bodies, false sizes or a slow drip, to exhaust the worker, to hold up everyone's background work, or to fill a region on a move back | 2.4: reads bounded by the row's size, the source's size checked first, a total deadline that covers retries, a cap per store, a breaker that also counts slow successes, and a store's share of each run. The phones cap reads and refuse redirects                                                                                                                                                                                                  | They can make their own company's transfers fail, and delay other stores' background work in a run by at most one run budget. The worker that reads their answers holds every key (below)                                                                                                                                  |
| Someone who breaks into the worker, by a hostile store's answer or otherwise | Everything a store key can do                                                                                                                             | Nothing here. There is one worker. It holds both sealing keys, the export signing key, and the environment's replica and evidence credentials, and it is the process that parses responses from servers company Owners run                                                                                                                                                                                                                           | Every store's key, so every copy of every object's ciphertext, backups included, and the means to sign snapshots. No file's contents: those keys are never on a server. A separate worker for company stores would keep the backup keys and the signing key away from the process that reads hostile answers (decision 24) |
| A company Owner or their cloud admin                                         | Deletes objects in their bucket, adds a lifecycle rule, turns on a retention lock                                                                         | The test and the daily check warn about rules they can read. The audit and the "not found" report find lost objects, heal them from an export, and tell the Owners and Admins                                                                                                                                                                                                                                                                        | It is their data and their bucket. HushOS cannot stop it, and a hold cannot bind a bucket HushOS does not control (below)                                                                                                                                                                                                  |
| The same, against a report                                                   | Deletes a reported file's bytes to defeat a hold                                                                                                          | The evidence copy is made within five minutes of a report, to the operator's evidence bucket                                                                                                                                                                                                                                                                                                                                                         | A file deleted from the bucket before that copy. Without an evidence bucket configured, nothing preserves it; the operator page says so                                                                                                                                                                                    |
| Someone who makes a company and gets a person to join it                     | Adds a host they control to that person's policy, as somewhere a script could send data                                                                   | An origin that is one bucket's, or a host the operator listed (4.3); the host and bucket grammar                                                                                                                                                                                                                                                                                                                                                     | The host is in that person's policy on every page. It is one more place for a script that has already got in to send to, beside the ones HushOS itself gives such a script (uploading into that company, sharing with its author). It is not a way in (7.1)                                                                |
| Anyone who can type an endpoint                                              | Makes the server call internal addresses (cloud metadata, the database, an admin port)                                                                    | 2.3: global unicast addresses only, checked on a literal and on the connected address; `https`; port 443 for a company; no redirects, from the SDK or the raw preflight; no response bodies shown                                                                                                                                                                                                                                                    | A public address the server should not call is still callable, at ten tests an hour. The requests are signed S3 calls and carry nothing but the key the person typed                                                                                                                                                       |
| Someone who breaks into the web container                                    | Reads store keys; deletes a region and its backup                                                                                                         | It can open region and company keys, which it must hold to sign URLs. It cannot read or use backup or export keys directly: they are sealed to the worker (2.6). By default a backup's key cannot delete, so deletions it queues through the database remove no backup copy (10.1)                                                                                                                                                                   | A backup key typed while they are already inside. Where a backup's key can delete, backup copies removed through rows they write to the outbox. A backup store's row re-pointed at a bucket of theirs, which loses later copies and not earlier ones. Keeping the backup in the environment avoids the first and the third |
| Someone who copies the database                                              | Reads store secrets                                                                                                                                       | Sealed under keys that are never in the database. Both must be set in the environment, and neither is derived from anything kept there                                                                                                                                                                                                                                                                                                               | Nothing, without the environment as well                                                                                                                                                                                                                                                                                   |
| Someone who steals a store key                                               | Reads or destroys objects                                                                                                                                 | Ciphertext only. Clients check every chunk and signature, so tampering is noticed. A backup store's key is a different key, which the web process cannot open                                                                                                                                                                                                                                                                                        | Destruction of the primary copies; the backup and the 30-day window are the recovery                                                                                                                                                                                                                                       |
| A store that silently loses or corrupts objects                              | —                                                                                                                                                         | The audit, with a stated length for a full pass; a "not found" report checks that object at once; healing from the backup, the export, a region store or its own company's store; Owners and Admins told. Copies are verified by digest; clients fail closed on a damaged chunk                                                                                                                                                                      | An object lost between passes is found when someone opens it, and healed then if a copy exists. Corruption that keeps the size is found only by opening the file, or by the backup check's sample                                                                                                                          |
| A database restored to before a move                                         | Rows name copies that were deleted                                                                                                                        | Old copies are kept as long as the database backups reach back (8.4); the audit re-points a row to where its object is (8.6)                                                                                                                                                                                                                                                                                                                         | Stores added after the backup must be entered again by hand before their objects can be read                                                                                                                                                                                                                               |
| A dishonest server                                                           | Signs URLs for another bucket, or stores objects somewhere else than it says                                                                              | Nothing; clients do not and cannot check where bytes go                                                                                                                                                                                                                                                                                                                                                                                              | Residency is a promise the operator makes. It protects no key: everything sent is ciphertext                                                                                                                                                                                                                               |
| Someone who reads a company's export bucket                                  | Learns about the company                                                                                                                                  | No password record or account envelope is ever exported                                                                                                                                                                                                                                                                                                                                                                                              | The member list, including people removed since an older snapshot, and the shape of the company's files (10.2)                                                                                                                                                                                                             |
| Someone who can delete from the export bucket                                | Removes the newest snapshot, so that a restore is of an older company                                                                                     | With the default key, HushOS cannot, and neither can a thief of that key. The chain of snapshots does not show a missing last one; a `final` snapshot and members' own devices do (10.5)                                                                                                                                                                                                                                                             | A company restored with no member's device to compare against                                                                                                                                                                                                                                                              |
| The operator of the server a company moves to (10.5, if built)               | Reads personal accounts; plants members; takes a member's place; restores an old copy unnoticed                                                           | No password, account envelope or identity key of anyone's old account goes to the new server. A registration under a member's id finishes only with a statement signed under that member's old keys, and the old device signs only after the person types the code from their own sign-up screen. Every change to the member list is signed by an Owner or an Admin and checked by devices. An older copy is shown to everyone who signs a statement | Availability, and what a snapshot shows. A member talked into typing a code for a request that is not theirs; an Owner who is hands over the company's keys. A member who signs past the older-copy warning                                                                                                                |
| A removed member, where an older snapshot is restored                        | Takes their old place back                                                                                                                                | The Owner's device re-applies the removals its own chain shows. Folding anyone in is an Owner's or an Admin's signed act                                                                                                                                                                                                                                                                                                                             | An Owner or Admin who folds them in anyway                                                                                                                                                                                                                                                                                 |

## 14. Stores, one by one

What could be established from documentation opened on 10 November 2026, and what could not. The test is the authority: a store is supported when it passes, whatever a table says.

| Store         | Established                                                                                                                                                                                                                                                                                                                                               | From                                                                                            | Not established                                                                                                   |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Cloudflare R2 | Multipart calls, `ListObjectsV2`, ranged `GET`, `PutBucketCors` and lifecycle configuration are implemented. Signing region `auto`. Storage classes `STANDARD` and `STANDARD_IA` only. Signed URLs work only on the S3 API host, not on a custom domain, and last at most 7 days. The dashboard takes 6.1's JSON. A CORS change can take up to 30 seconds | R2's S3 API compatibility, presigned URLs and CORS pages                                        | Whether a signed `UploadPart` is documented (the page lists `PUT`); path-style or virtual-hosted is not discussed |
| Backblaze B2  | Signed URLs for upload and download. `PutBucketCors`, `GetBucketCors` and `DeleteBucketCors` exist, up to 100 rules. A key can be restricted to one bucket and then also needs `listAllBucketNames`; `writeFiles`, `readFiles`, `deleteFiles` and `listFiles` cover everything HushOS calls. The account's master key does not work with the S3 API       | B2's S3-compatible API, CORS rules and S3 app keys pages                                        | The endpoint and signing-region format; storage classes; lifecycle through the S3 API                             |
| Garage        | Multipart calls, `ListParts`, `ListObjectsV2`, `CopyObject`, signed URLs and bucket CORS are implemented. Lifecycle supports only aborting incomplete uploads and expiration. No storage classes, no versioning, no bucket policies or ACLs: access is Garage's own per-key permissions                                                                   | Garage's S3 compatibility page                                                                  | Checksum header behaviour                                                                                         |
| AWS S3        | The console takes CORS as JSON only; the API takes XML; up to 100 rules                                                                                                                                                                                                                                                                                   | The S3 user guide, "Elements of a CORS configuration"                                           | Nothing else was opened; S3 is the reference the SDK targets                                                      |
| Wasabi        | CORS can be set in the console as a JSON array of rules. Wasabi's own pages disagree on whether the S3 `cors` calls work, and one says its CORS handling is partial                                                                                                                                                                                       | Search results quoting Wasabi's CORS documentation; the pages themselves were not opened        | Whether `PutBucketCors` works; whether a browser upload with a preflight passes. Only the test can say            |
| MinIO         | Current AIStor documentation describes per-bucket CORS through `PutBucketCors` and a global `cors_allow_origin` setting. Older compatibility lists show `PutBucketCors` as unsupported                                                                                                                                                                    | Search results quoting MinIO's AIStor CORS pages and a mirrored older list; not opened directly | Which release added bucket CORS. An older server needs the global setting, and S6 answers `unsupported`           |

From the code, not from documentation: R2 rejects the SDK's default CRC checksums on signed and multipart requests, so clients are built with checksums only "when required" (`storage.ts`), and a Backblaze bucket under Object Lock refuses a copy without SHA-256 headers, which verified copies send. Found while PR 3 was built, and not fixed there: the bundled Garage (v2.5.0) refuses a verified copy of more than one part (over 64 MiB) with `InvalidDigest`. A verified copy of one part passes, and so does an unverified copy of several. It was seen with 5 MiB parts; a copy over 64 MiB sends the same requests. Evidence copies are the only verified ones, so an evidence bucket on Garage would refuse a reported file over 64 MiB.

From the review, and not from documentation opened for this document: setting a bucket's CORS takes more than an object key on most stores (an R2 admin token, Backblaze's `writeBuckets`, a Garage key that owns the bucket). 6.1's button therefore never uses the stored key. Whether each store serves signed URLs at a host name that carries the bucket, which 4.3 requires of a company's store, was not established from the stores' own pages either. The repository's guide sets `STORAGE_FORCE_PATH_STYLE` to `false` for R2, B2 and S3, which says each is used that way today. So 4.3's list of hosts where a company may use path style ships empty. A store that offers only path style on a host shared between customers can be a region's store and not a company's.

What "any S3-compatible store" costs, said plainly on the form: "HushOS works with stores that pass the test below. If yours does not, the result says which part failed."

## 15. Tests that must exist

Stores hold keys and decide where bytes go, so each of these is a Vitest suite beside the code, against real Postgres and a real S3-compatible store (the bundled Garage, with several buckets) where rows or bytes are the point. "A hostile store" below is a small test server that speaks enough S3 to misbehave on purpose.

- **Secrets:**
    - a sealed secret opens with its own row, and fails after the row's endpoint, bucket, signing region, kind, company or path-style is changed;
    - a backup or export secret sealed by the web process cannot be opened with anything the web process holds, and opens on the worker;
    - no route's response contains a secret or a whole access key id (every S route, by a seeded marker value), and S6's admin key reaches no row and no log line;
    - with either key unset, or the web's and the worker's keys differing, saving a store answers `secrets-key` and stores nothing;
    - a process without the key answers `unavailable` and uses no other store;
    - rotation reseals every row of each kind.
- **Endpoints:**
    - each address outside 2.3's allowlist, in IPv4 and IPv6, by literal and by name, including 0.0.0.0, 198.18.0.1, 240.0.0.1, a NAT64 address and a mapped private address;
    - a name that resolves public on the first lookup and private on the second is refused at connect (the pinned regression);
    - a redirect is not followed, from the SDK or from the raw preflight;
    - `http`, a port other than 443 and path style are refused for a company whatever the settings say, except a host on the operator's list;
    - a bucket with a character outside the grammar, a host with a wildcard, and a bucket carrying a line break never reach a policy header;
    - a store's error body never reaches a response or a log line.
- **A hostile store:**
    - a source that reports a larger size than the row fails the copy before any byte is read, and the target receives nothing;
    - a ranged answer longer than the range asked for is cut off, and the process's memory stays bounded;
    - a store that sends one byte a minute is cut off at the total deadline;
    - five failures open the breaker, calls then answer `unavailable` without a request, and another company's uploads are unaffected;
    - a store that answers every call successfully at 59 seconds, with 200 outbox rows of its own waiting, delays another store's deletions in that run by no more than `STORAGE_STORE_RUN_SECONDS` plus one request's deadline;
    - five slow successes in a row make the worker's jobs skip that store for 60 seconds, while a member's upload there still begins;
    - a retry by the SDK does not extend a request past its deadline;
    - on Android and iOS, a signed URL that answers with a redirect, or with more bytes than the range, is refused.
- **The same bucket:**
    - a store whose bucket is a region's under another host name is refused as `same-bucket`;
    - a backup that is its region's bucket cannot be attached;
    - a move between two rows naming one bucket does not start; and one whose target becomes the source's bucket before it finishes ends `blocked` with nothing deleted;
    - a store whose reads lag its writes by two seconds is still found to be the same bucket, and a store that hides a marker written through it is not judged at all;
    - the probe runs in both directions;
    - two drafts of one bucket whose tests pass at the same moment never both become `ready`;
    - a company's draft naming a bucket another company's store names is saved, and its answer is no different from any other draft's;
    - a draft older than 7 days is gone, with its sealed secret.
- **Which store:**
    - an upload in a company with its own bucket, in a company with a region, in a family and in a personal space each begin at the right store;
    - an upload that begins while a move switches lands at the source or at the target and is never stranded: with the switch held between the store's choice and the upload row's commit, the upload row names a store the move still accounts for;
    - an object row written by a container that sends no store id is read from the environment's primary;
    - an upload row with no multipart id after a minute is expired; and a store that answers the multipart start after that leaves no row with an id and no open multipart upload.
- **The test:**
    - each check fails for its own cause against a store set up to fail it (no list right, no delete right, no CORS rule, a rule missing `content-type`, a rule not exposing `ETag`, a wrong origin);
    - a backup store with no CORS rule and no delete right passes its profile, and a region store like it does not;
    - the browser check runs in the worker that does real transfers, and, in an engine where the worker's policy is its own, fails when that policy lacks the origin even though the page's has it;
    - a draft cannot be used; a pass older than 24 hours cannot start a move.
- **The outbox:**
    - an object moved and then purged leaves nothing at either store once the outbox has run, and neither key is known to the sweep afterwards;
    - the round trip: an object moved out, left until the old copy's wait is over and its row finished, moved back within 30 days, then purged. Nothing is left at either store or in either store's backup, and neither sweep knows the key;
    - a flip back to a store whose old copy is gone, or is there at another size, copies the bytes again instead of flipping;
    - under a backup key that cannot delete, a purged object's row finishes with the backup copy marked as left, and the copy is on a later night's list;
    - a move cancelled after flips, then eight days: every object is still readable, and no `moved` row is left for a store an object lives at;
    - a `moved` deletion whose new copy is absent deletes nothing and is marked `attention`;
    - the outbox job and a flip back on one object, started together in either order, never leave the object with no copy;
    - a row written with no store id (the previous release) deletes from the environment's primary;
    - finished rows are gone after 30 days and no longer make a key known.
- **Moves:**
    - bytes at the target equal bytes at the source for every object, by digest;
    - a download started before a flip finishes from the source;
    - an upload begun before the switch completes at the source and is then copied;
    - a worker killed mid-object resumes and leaves no unfinished multipart upload;
    - the orphan sweep does not run on a move's target while it copies;
    - a held object's old copy survives the wait;
    - a company's move after its region's move finds its objects wherever they are and ends with all of them at its target;
    - a company cannot start a move while its region moves, nor a region while a company in it does;
    - a backup run racing a flip does not mark the object as backed up in the old region's backup;
    - old copies are kept `DATABASE_BACKUP_RETENTION_DAYS`, and seven days when that is lower or unset;
    - a move back into a capped region that would not fit answers `over-quota` and changes nothing;
    - two workers never flip one object twice.
- **After a restore:** with the database put back to before a move's flips and the old copies gone, a full audit re-points every row to the store that holds its object and marks none missing.
- **Retention:** 6, 7, 365 and 366 days; a shorter setting purges nothing for 7 days and then exactly what it said; a still shorter one saved on day 6 starts the 7 days again; a longer one applies at once; a hold outlives it; a family's and a personal space's purge is unchanged; saving one without the step, or without a record, changes nothing.
- **Backups and the audit:**
    - a deleted object's primary copy waits for its backup;
    - one object that always fails to copy does not stop the others from being backed up, and is listed after ten tries;
    - the check reports a truncated and a missing backup copy;
    - a lost primary is healed from the backup, then from an export, then by re-pointing to a region store or to its own company's store;
    - a row is never re-pointed to a backup or export store, and no request naming the object reaches another company's bucket;
    - with the default key nothing is deleted from a backup; the night's list names exactly the keys purged more than 30 days ago and no live object's; and a live object whose backup copy was removed is copied again;
    - a row written straight into the outbox with a backup deletion already due removes no backup copy under the default key;
    - with 100,000 object rows the nightly budget is what a 30-day pass needs, and the page's "full pass" figure matches it;
    - a "not found" report from someone who may open the object queues its audit and heals it; one from someone who may not answers 404 and queues nothing; nothing readable records who reported;
    - a second report for the same object within the hour queues nothing and answers the same; the job's row is gone once it completes; a link's visitor is limited per link and per address;
    - a company's Owners and Admins are notified of a missing object in their bucket, and a member is not.
- **Exports:**
    - a snapshot contains no row of a personal space, a family, a password record, an account envelope or a session, checked by scanning the file for seeded markers;
    - an object uploaded while a run is copying appears in that run's snapshot as `exported: false`, and never as present when it is not in the bucket;
    - with a key that cannot delete, nothing is ever deleted from the export, and the run still succeeds;
    - with pruning on, an object purged long ago is still in the export while any kept snapshot lists it, and gone once none does;
    - each run's list names exactly the snapshots past `keep` and the exported objects none of the last `keep` lists, and never a file a kept snapshot lists;
    - a live object removed from the export bucket is found by verify from one listing, has its mark cleared, and is exported again by the next run;
    - an edited count in the summary line fails verify;
    - a snapshot whose transaction passes five minutes fails its run and leaves no transaction open;
    - detaching an export, or deleting the company, cancels every pending deletion from it and removes its key;
    - a snapshot's chain and signature verify under the worker's key, a truncated or edited one is refused by `export:verify` and by the restore tool, and a snapshot signed under a rotated key verifies with the list;
    - `company:restore --rows-only` loads the newest snapshot into a scratch database in CI;
    - an hourly schedule falls back to daily past ten minutes.
- **The policy:**
    - a member of a company with its own bucket gets its origin; a stranger and a member of another company do not;
    - someone outside a company with a live share of one of its files gets its origin, and loses it when the share stops;
    - an operator's report page gets the origin of the store holding the reported object;
    - an Admin who may run the test gets the draft's origin on the settings page, and a member does not;
    - a link page gets the origin of the store holding the linked item and no other company's, and no response before the password carries a signed URL;
    - a listing of items shared with someone carries each item's `storeOrigin`;
    - an app whose served origins lack the one it would upload to does not begin an upload and shows the reload line;
    - the worker test of 7.2 in Chromium, Firefox and WebKit; and, in each engine where the worker's own policy governs, a worker started from the entry script reaches an origin added after the hashed asset was cached.
- **The step and the capability:** an operator with the admin flag and no `storage` gets 404 on every S route; activation, a move, a key replaced on a live store and a company's retention are each refused without the step and accepted with it, once per token; a draft, a test and S6 need none; an Owner replacing a live bucket's key (S33) is refused without the step, without a record, and with a key that fails the server checks.
- **The record:** every stepped operator call produces one event; an UPDATE or DELETE on `operator_events` fails as the table's owner; a company's storage change without a detail record answers `audit`; an operator's region move writes one `operator-changed` fact per company in it; no company storage row holds an account id (a schema test).
- **Leaving (with PR 14, if built):** a registration under a member's id without a statement that verifies under that entry's keys is refused; the old device does not sign when the typed code differs from the request's, and the code is in no link and no scanned code; a statement for another server's origin, another company, another member or another key digest is refused, and so is one lacking either signature; `nextRoster` refuses another Owner's fold-in of a guarded entry without the fresh check; after everyone has moved, no folder list, share record or stored signer has changed; a fold-in into an Owner's or an Admin's entry, for an account without the second step, is refused; an older snapshot is shown as older to a device with a newer head; no route at the new server accepts an account envelope, a recovery envelope or a password record from elsewhere.
- **End to end (Playwright):** an operator adds a second bucket as a region and passes the test; a company is created in it and a file uploaded there is downloaded byte for byte; the company is moved to the other region while a download runs; an Owner sets an own bucket, moves to it and back.

## 16. Implementation plan

One change per pull request. "Clients" says which apps change. "Needs" says what must be merged first. The second revision's first pull request was four changes in one. It is split here into PRs 1 to 4, and the rest are renumbered.

| PR  | What                                                                                                                                                                                                                                                                                                                                     | Clients                                               | Needs                                                        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------ |
| 1   | `feat(db)`, `feat(drive)`: stores and regions as tables, with the environment's stores as rows; store ids on objects and uploads, never null; the store chosen in `begin`'s transaction, and the multipart id written only while the row is open. No page; nothing behaves differently                                                   | None                                                  | Nothing                                                      |
| 2   | `feat(db)`, `feat(drive)`: the outbox keyed by object and store, with reasons, holds, an insert that replaces a finished row, and finished rows removed after 30 days; "known at this store" in the orphan sweep; the backup mark by compare-and-set; loops that survive one failure                                                     | None                                                  | 1                                                            |
| 3   | `feat(drive)`: what a store may do to the server: reads bounded by the row's size, total deadlines that cover retries, the per-store cap, the breaker with slow successes, each store's share of a run and stores served in turn                                                                                                         | None                                                  | 1, 2                                                         |
| 4   | `feat(crypto)`, `feat(drive)`: the two sealing keys, `storage_worker_state`, sealing and opening a store's secret, `bun run storage:keys`. The worker's seal is the unsigned hybrid seal the company spec plans for its ledger (2.5 there); whichever is built first adds it to `packages/crypto` and the Rust core's fixtures           | None                                                  | 1                                                            |
| 5   | `feat(web)`: opened by the three-engine worker test. Then the policy per request, origins built from validated parts, and the auth worker's entry script where the test says it is needed                                                                                                                                                | Web                                                   | 1                                                            |
| 6   | `feat(web)`: the operator's Storage page: the `storage` capability, drafts that expire, the test with its profiles, the identity probe (both directions, one at a time), the documents of section 6, the one-shot CORS call, activation with the step, the record and its trigger, `storage.probe`, the endpoint rules, the list to keep | Web (operators)                                       | 1 to 5, and two-step's routes (its step 2)                   |
| 7   | `feat(drive)`: backups per region: backup stores sealed to the worker, a key that cannot delete by default with its nightly list, the schedule, the check, the audit budget, the "not found" report and healing within the stores that could rightly hold an object                                                                      | Web (operators); web, iOS, Android for the report     | 6                                                            |
| 8   | `feat(drive)`: moves, for a region, with the operator's screens; old copies kept by `DATABASE_BACKUP_RETENTION_DAYS`; the flip back's size check; re-pointing after a restore; the guide's "After restoring the database"                                                                                                                | Web (operators)                                       | 7                                                            |
| 9   | `feat(apps)`: a company's region at creation, the strings of 4.2, `spaces` fields, the "failing" line                                                                                                                                                                                                                                    | Web, iOS, Android                                     | 6, and the company spec's PR 5                               |
| 10  | `feat(apps)`: a company's own bucket, its move, replacing its key, the billing hook; `storeOrigin` on share listings and the web's floor for company spaces; reads capped and redirects refused on the phones                                                                                                                            | Web; iOS and Android (transfer code, one status line) | 8, 9, and the company spec's PR 13 (the ledger)              |
| 11  | `feat(apps)`: retention per company                                                                                                                                                                                                                                                                                                      | Web (setting); web, iOS, Android (wording)            | 9, and the company spec's PR 13                              |
| 12  | `feat(drive)`: exports, each run's list of what may go, healing from them, `export:verify` with re-export, and the CI restore of rows                                                                                                                                                                                                    | Web                                                   | 10                                                           |
| 13  | `feat(web)`: database backup reports                                                                                                                                                                                                                                                                                                     | Web (operators)                                       | Nothing for the route and table; 6 for its place on the page |
| 14  | `feat(apps)`: leaving for another server (10.4, 10.5). **After this release, unless the owner decides otherwise.** It needs a review of its own first, and its rule of evidence specified and reviewed in `companies-design.md`                                                                                                          | Server, core, web, iOS, Android, at both ends         | 12, the decision, and that review                            |
| 15  | `docs`: the self-hosting guide, the security page, the roadmap, and a post kept in drafts until companies switch on                                                                                                                                                                                                                      | Web                                                   | The rest                                                     |

**What can be built when:**

- **Now:** PR 1. Then PRs 2, 3 and 4, each as soon as what it needs is merged: none of the four waits on anything outside this document. Also PR 13's route and table (its status shows on the existing admin overview until PR 6 gives it a place), and PR 5's three-engine test, as a spike.
- **After two-step's routes are merged:** PRs 6, 7 and 8. The operator page's step-up needs two-step's step tokens. Their database layer is on main and their routes are in review.
- **After the company core's PR 5:** PR 9.
- **After the company core's activity ledger (its PR 13):** PRs 10, 11 and 12. Each records its changes in the ledger and is refused without a detail record, so the ledger must exist first.
- **After this release:** PR 14.

Notes:

- PRs 1 to 8 and 13 need no company. They are useful to self-hosters on their own.
- PRs 9 to 12 and 14 are behind `COMPANIES_ENABLED`.
- PRs 2, 3, 4, 8, 12 and 14 handle keys or bytes people cannot get back, and need the hardest review. PR 2's outbox change touches every deletion in Drive, not only moved objects.
- **For PR 2, from PR 1's review:**
    - its migration validates PR 1's four `NOT VALID` constraints and drops the three `store_id` defaults (11.1);
    - replication must be limited to objects at the store the replica backs up (the environment's primary) before a second region can exist. PR 1 still copies every unreplicated object to the one replica, whatever its store;
    - deleting an account removes its object rows by cascade, with no outbox rows, and relies on the orphan sweep to remove the bytes. The sweep walks only the environment's primary. With "known at this store" and a cursor per store, it must cover every store that can hold a personal space's objects, or account deletion must queue its objects;
    - `drive_objects.store_id` has no index (building one in PR 1's transaction would have locked the table for the build). One is needed, built `CONCURRENTLY` outside drizzle's transaction, before the first row is ever deleted from `object_stores`: the foreign key's check on that delete would otherwise scan every object.
- **For PR 3, from PR 2:** the outbox holds its row's lock, inside a database transaction, for the length of the store call that deletes a copy or looks for the new one. Until every store call has a total deadline, a store that hangs holds that transaction open. The jobs already take their rows fairly within a store (least recently failed first); taking stores in turn, and a store's share of a run, are PR 3's. Until then Postgres bounds it: both removals set `idle_in_transaction_session_timeout` to three minutes, so a store that accepts a request and never answers loses the row and its transaction, and the row is tried again. That ends the transaction, not the request: the worker's own call still waits on the store until PR 3 gives it a deadline.
    - **Done in PR 3.** Every store call has a total deadline, the calls of one removal share one, stores are taken in turn and each has its share of a run. The idle timeout stays, behind the deadline.
- **For PR 4, from PR 3:** whoever opens a `database` store passes `createObjectStore` the row's id (its breaker and cap are kept by id, across the 60 seconds a process keeps an opened store, 2.6) and, for a company's store, `cap: COMPANY_STORE_CAP.worker` or `.web`.
- **For PR 6, from PR 3:** the page shows the rate a store's last test measured (2.4). Nothing measures it yet. A store's health (`ok`, `slow`, `open`) is in each process's memory only; the daily check is where it would be recorded.
- **For PR 7, from PR 3:** an outbox row holds no size, so the backup copy of an object purged before it was copied is bounded by the format's ceiling and not by a row (2.4). `ciphertext_size` on `drive_object_deletions`, written when a copy is queued, closes it. The audit takes a fixed page per store.
- **For PR 8 and PR 12, from PR 3:** a move's and an export's loops take `createShares` and `inTurn` (`packages/drive/src/turns.ts`) and pass each copy the row's size.
- **For PR 7, from PR 2:** the worker's jobs take `backups`, the pairs of a store and its backup store that this worker keeps (today one at most, from the environment). Regions' own backups fill that list. Finished `backup_left` rows wait for the nightly list, which must remove them once it has named them. An object left alone after ten failed copies is only counted in the copy job's event (`skipped`). The audit still takes a fixed page, and a store that does not answer keeps its objects at the head of it.
    - **Two regions that share one backup store race.** One region's copy job writes a key there while the other region's due backup deletion, or the clean-up of a copy nothing accounts for, deletes the same key. PR 2's "live" check only spares a copy that an object's mark already names. It must also hold when this worker's backup for the object's current store is that store, whether or not the mark is set yet; or two regions must not share a backup store.
- **For PR 8, from PR 2:** a move calls `flipObjectStore` (with `databaseNow()` read before its copy), `releaseMoveHolds` when it is done, and nothing else of the outbox; `storesRepository.listSweepStores` must leave out a move's target while it prepares or copies. A worker of PR 1's or PR 2's release must not run beside one that makes `moved` rows: PR 1's deletes a held row. The three are not on `driveRepository` yet; PR 8 exports them.
    - **The row's lock does not outlive a dead worker, or a request Postgres gave up on.** X lives at B, and its old copy at A has an unfinished `moved` row. A mover (a cancelled move going back) sees A's copy at the right size. The worker's `DELETE` reaches A, and the worker dies, or its transaction is ended, before the mark commits. The mover flips with no fresh copy; the row shows nothing deleted, so the flip withdraws it and points X at A, where there are no bytes. B's copy is kept by the "new copy absent" look, so X is unreadable, not lost, until someone re-points it. PR 8 must close this before any move runs: the removal commits a mark that it has started, in a transaction of its own, before it calls the store; a flip refuses a target row whose removal has started and is not confirmed (`copy-needed`); and the job drives such a row's delete again and confirms it. PR 8 must also review `flipObjectStore` again as a whole, with that mark in it.
    - **A flip back after the old copy's row finished and was cleared away** answers `copy-needed`, as it must; the bytes are copied again. Nothing remembers that the object was ever at that store, so nothing can tell a copy someone put back by hand from one HushOS made. Not built further here.
- PR 3's share of a run is specified and built now, although it only bites once a company's bucket exists (PR 10). Until then every store is the operator's own.
- The setup screens are web only, as the owner decided. The phones change where a member reads something, and in how they read from a store (PR 10).
- An operator's move of a region (PR 8) can only write its `operator-changed` facts once the company ledger exists. PR 10 adds them. Until then no company can be switched on, so no company's files move unrecorded.

## 17. Where the directions cannot be delivered as asked

1. **"Any S3-compatible store."** Any store that passes the test. Two on the owner's list are doubtful before testing: Wasabi's own pages call its CORS handling partial, and MinIO servers older than its bucket-CORS release need a server-wide setting HushOS cannot apply. Stores also differ in what a key can be limited to, so "a key scoped to one bucket" is a request to the person, not something HushOS can enforce. A company's bucket must also answer at a host name of its own, or at a host the operator has listed (4.3), which not every store offers.
2. **"Test from there directly."** A web page can prove what its own browser and the HushOS server can do. It cannot prove another person's network reaches the bucket, that the bucket is where it is said to be, or that the provider is durable. The result says what was and was not shown.
3. **Residency.** File contents at rest are in the chosen region. These are not, and the strings of 4.2 say each:
    - the database, with member lists and the encrypted tree, is in one place for everyone;
    - during a move, a backup or an export between providers, ciphertext passes through the worker, wherever the worker runs;
    - a region's backup may be anywhere its operator put it;
    - a reported file is copied to the operator's evidence bucket, which may be elsewhere;
    - a person outside the region who opens a share or a link downloads from the region's bucket to wherever they are;
    - and the operator decides which bucket a region's name points at, and can change it.
4. **"Backups … and ability to test."** The check reads a sample of backup copies and compares them. It is not a timed restore of a region. The build plan's rule was to publish a restore objective only after a timed drill; that drill is an operator's procedure, to be written in the guide, not a button. The audit finds a lost object within its stated pass, not "before anyone notices".
5. **A way to leave.** A snapshot and the objects are not enough: a restored company has no accounts, and the safe way to give it some is a new rule of evidence in the member list and a flow on every client at both servers (10.5). That comes after this release unless the owner decides otherwise. Until it ships the product has backups and exports, and says so.
6. **Database backup status.** Only what a job reports, or what Postgres says about its own archiver. HushOS cannot verify a backup it did not make.
7. **Holds.** In a company's own bucket a hold cannot stop the company deleting bytes. The evidence copy is the preservation, and only when an evidence bucket is configured.
8. **Write-only keys.** No route returns a secret. The server still uses them, so an operator with the database and the environment can recover every one. A backup or export key also passes through the web process once, when it is typed. "Write-only" describes the page, not the operator's power.
9. **"No downtime."** True of reading, and of the phones. A browser tab opened before a new store was ready is asked to reload once before it uploads there (7.3).
10. **"From the management pages."** Regions, buckets, tests, backups and moves are. The two sealing keys and the `storage` capability are not: they are set in the environment and from the command line, on purpose. A page cannot be where the key that protects that page's own secrets is set, or where the right to use it is handed out.

**Where this revision differs from the review's recommendations.**

- **Leaving (H4).** The first review had the first Owner start with the recovery kit. Here the Owner's own old device signs them in, and the kit plays no part (10.5). The kit proves the company's key, not who is holding it, and an Owner with a device does not need it. The second review agreed, and found two things in what replaced it, both taken: a request someone else made could be approved by mistake (now a typed code), and a new account id reached every folder list, share and signer (now the id is kept, and a new identity is folded into the same entry).
- **The same bucket (C1).** The review asked that a marker not be readable through "any other store in use". Here it is checked against every store that sweeps a whole bucket, every backup, the evidence bucket, and the other end of a move or a backup. Company buckets are not probed against each other: there may be hundreds, and nothing HushOS does in one reaches outside that company's own prefixes.
- **Secrets (H3).** As recommended, with one addition: the web process takes the worker's public key from its own environment, not from a row someone who can write the database could change.
- **Exports (H5).** Both recommendations are taken: a key that cannot delete by default, and, where pruning is on, an object goes only when no kept snapshot lists it. That is by the last snapshot that listed it, not by a number of days.
- **Open tabs (M1).** The review asked for a delay before uploads switch. A delay alone does not help a tab that has been open for days, so the app also checks before it begins (7.3).
- **A link's page (low).** The origin shown before the password is accepted and stated (decision 25), not fixed. The light fix the second review saw needed a worker whose own policy governed its requests, and no transfer worker is built (7.2).
- **Separate worker (H2).** Not taken. The second review asked that the choice be put as it is: one worker that holds every key and reads responses from servers company Owners run (decision 24).
- **The second review.** Everything it recommended is taken as recommended, with two differences.
    - One goes further. A backup key that cannot delete has the pruning trap the review found in exports (an age rule deletes live copies), so backups get the same list of what may be removed (10.1).
    - One is narrower. The name check is dropped between company stores, where it was an oracle, and kept between the operator's own region and backup stores (2.3), where only operators see its answer.

## 18. Decisions to confirm

Ranked by how much each changes the build. Each has a recommendation. Those marked "changed" differ from an earlier revision.

1. **The environment's stores stay in the environment, as rows that hold no secret** (changed: they were not rows). _Recommendation: yes._ No secret is copied into the database by a migration, and a self-hoster who never opens the page is untouched. The cost: the first region cannot be edited on the page; to manage it there, add a region and move.
2. **Leaving for a self-hosted server (10.4, 10.5): after this release, unless the owner decides otherwise** (changed twice: no personal key goes to the new server, and nobody's id changes). _Recommendation: after it._ It needs a new rule of evidence in the member list, reviewed as the Owner rule was; a typed code, against a request that is not one's own; and a flow on all three clients at both servers. Ship backups, exports and their checks now, and keep "a way to leave" out of every page until it exists.
3. **What restore means in this release:** missing bytes heal by themselves; a whole company restores into another deployment only with decision 2. There is no "bring this folder back as it was on Tuesday". _Recommendation: yes; retention up to 365 days is the tool for that._
4. **Two sealing keys, both required in the environment, neither derived** (new). _Recommendation: yes._ The cost is two more variables to set before the first store is saved; `bun run storage:keys` prints them.
5. **The outbox is keyed by object and store, and an insert replaces a finished row** (new). _Recommendation: yes, in PR 2._ It changes every deletion in Drive, so it is the pull request to review hardest of the first four.
6. **A `storage` capability from the command line, apart from the admin flag** (new). _Recommendation: yes._
7. **Who changes a company's storage.** _Recommendation: an Owner for the bucket, the region and the export target; an Admin for retention and for running tests._
8. **No transfer worker. The policy is per request for the page, and the auth worker gets a fresh entry script wherever an engine applies the worker's own policy** (changed: the second revision planned a transfer worker, which would have contained nothing). _Recommendation: yes._ PR 5's test settles only which policy governs the worker.
9. **Drafts and tests need no second step; anything that takes effect needs one, once per activation; password re-entry where the deployment has two-step off** (changed). _Recommendation: yes._
10. **An old copy is kept as long as database backups reach back, seven days at least** (changed: it was a fixed 7). _Recommendation: yes._ A company on its own bucket stores both copies for that long; the start screen says so.
11. **Exports default to a key that cannot delete, and HushOS then deletes nothing; pruning is the Owner's choice** (changed). _Recommendation: yes._
12. **A company's bucket is `https`, on port 443, public, used by nothing else, and virtual-hosted unless the operator has listed its host** (changed: the list of such hosts ships empty). _Recommendation: yes._ `STORAGE_ALLOW_PRIVATE_ENDPOINTS` and the path-style list are the operator's to set. The cost: a provider that offers only path style on a shared host cannot hold a company's bucket.
13. **Retention between 7 and 365 days; a shorter setting waits 7 days, and a still shorter one starts the wait again.** _Recommendation: yes._
14. **Database backup status from a reported time and the archiver.** _Recommendation: both, with the plain "cannot see your backups" line when there is neither._
15. **Reported files of a company in another region are copied to the operator's one evidence bucket.** _Recommendation: keep one bucket and say so on the security page and in the terms._ An evidence bucket per region is possible later.
16. **Where the database is, is a label the operator sets** (`DATA_HOME_LABEL`). _Recommendation: yes; HushOS cannot know._
17. **The narrower CORS rule** (two methods, two headers) is the one shown, not the bundled Garage's wider one. _Recommendation: yes._
18. **An operator record that covers storage only.** _Recommendation: yes for now; widen it in its own change._
19. **A backup's key cannot delete, by default** (changed: it was accepted and not yet the default). _Recommendation: yes._ HushOS then removes nothing from a backup, and each night's list says what the operator may. It is what bounds a web container that can write the database (2.6). A key that can delete, with pruning on, stays possible.
20. **A company on its own bucket has no storage cap, and its usage is still counted and shown.** _Recommendation: yes; the price is the billing design's._
21. **No HushOS backup of a company's own bucket.** _Recommendation: yes, stated on the screen, with the export offered beside it._
22. **A snapshot is the whole of the metadata every run; hourly only while a run takes under ten minutes.** _Recommendation: yes._ Incremental snapshots are possible later through the change sequence.
23. **"Apply this for me" for CORS, with an admin key typed for that one call** (changed: it used the stored key). _Recommendation: yes._
24. **One worker that holds every key and reads responses from servers company Owners run** (restated). Company-store work stays in it, behind the bounds and the run budget of 2.4. _Recommendation: yes for now._ The alternative is a second worker for company stores that holds only their keys, so that a mistake in parsing a hostile store's answer cannot reach the backup keys or the export signing key. It costs one more service to run. Build it if own buckets see real use.
25. **A link's page lists its store's origin before the password is typed** (accepted). Whoever holds the link's address learns the company's bucket host and nothing more (7.1). The alternative, a reload of the link page after the password, is not built.
26. **People are not told one by one when the default region changes** (new). _Recommendation: yes; the security page names the default region, and existing files do not move._
27. **A full audit pass in 30 days for a store people read from, 90 for a backup** (new). _Recommendation: yes, with both as settings._
28. **Uploads switch to a move's target ten minutes after it starts, and an app checks before it uploads** (new). _Recommendation: yes._
29. **No name check between company stores, and a draft is deleted after 7 days** (new). _Recommendation: yes._ The check told anyone who can make a company where another one stores.
30. **A lost object is looked for only in region stores and its own company's stores, and a row is never re-pointed to a backup or an export** (new). _Recommendation: yes._
31. **Backups and exports each get a list of what may be removed, and nothing is pruned by age** (new). _Recommendation: yes._ It is what makes a key that cannot delete usable for longer than a few months.
32. **An Owner can replace the key of a bucket in use** (new, S33). _Recommendation: yes._
33. **A store's share of one worker run is 60 seconds, and the deadline's rate is a setting** (new). _Recommendation: yes, both as settings._ The numbers are design choices, unmeasured.
34. **With a backup key that cannot delete, a deleted file leaves the backups only when the operator clears what the nightly lists name** (new, and a consequence of decision 19). _Recommendation: accept it, and have hushos.com clear its backups on a stated schedule, monthly, written in the privacy policy._ The alternative for an operator who must promise a date is a backup key that can delete with pruning on, which gives back "30 days later" and gives up the protection of 2.6.
