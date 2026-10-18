# Groups milestone 1d: families on iOS and Android

Milestone 1c shipped families on the web (`docs/groups-design.md` 9). The phones show none: a member reaches family folders only in a browser, the iOS Files location and the Android DocumentsProvider list the personal drive only, and the native apps' identity successions carry no successor consent (flag F8). This plan brings families to both apps without a second implementation of any rule the web worker enforces: every rule lives once in `crates/hushos-core`, pinned to its TypeScript twin by shared fixtures in both directions and by the differential fuzzer, and the apps only fetch, store and draw.

Each step below is one pull request with the full review (an independent review, then a `verify-hushos` live run where the web is touched, then a maintain-verification pass), and lists what it tests and what screenshot or simulator check proves it. Steps are ordered by dependency; a step never ships a code path a later step is needed to make safe.

## What already exists, and what does not

**In the Rust core already** (`crates/hushos-core/AGENTS.md`): roster acceptance with marks, the join mark and join code, both formats, area grants and key seals, `area_write_version`, `area_root_check`, group writer trust and the rekeyed verdicts (`group_metadata_rekeyed_integrity`, `metadata_origin_carry`, `*_compat_sign`), `roster_first`, `roster_next`, `roster_entry_own`, `pin_after`, `trust_as_group_does`, and `identity_succeed` co-signing consent.

**Only in the web worker** (`packages/crypto/src/session.ts`, `session-groups.ts`) until this plan:

1. the family write rules: which key a write may use (root-path rooting, `KEY_CHANGE_PENDING`), a walk's pending keys and `NOT_CARRIED`, the area root decided by its commitment (`rootSeen`), the write version and its block reasons (F9, F14);
2. a rotation's per-record decision (`rekeyRecord`: carry the origin after `carryOrigin`, drop it, make the record its own origin, or re-seal) and the verdict glue around the rekeyed readers (own records by personal trust, others by the roster);
3. the device store: the sealed chain record (`hushos/group/device-store/v1`), the cache with `cacheVersion` 2, the record's own pin, and the `withoutCache` fallback; the settings-pin rules (`apps/web/src/lib/groups/pins.ts`: never lower, compare and set, areas only from opened grants);
4. the join preview (`groupJoinPreview`) and the ten-compared, two-typed check (`join.ts:confirmJoin`);
5. consent for earlier links (the backfill signer);
6. staged chains and the roster calls a manager sends (admit with grants and a key seal, removal with every area's rotation and a succession, a folder's key replacement, a folder's deletion), with the outbox's resend-the-same-bytes rule (F7).

## Steps

### Core 1: the family write rules (this branch)

`crates/hushos-core/src/area_ledger.rs`: `AreaLedger`, a `uniffi::Object` holding an unlocked session's workspace and node keys and deciding every write in a family folder exactly as the worker does. The worker's key store moved into `packages/crypto/src/area-ledger.ts` so the twin is the code the web runs; `session.ts` and `session-groups.ts` call it. Also `previous_root_key_wrap`/`_open` (option A's label) and a node-key context checked as the web checks it.

The review of the first commit (Opus and Fable) found a critical defect the port had copied from the web worker: area state was keyed by area alone, so any committed chain listing an area set its write version, and another family's `uncommit` or forget touched it. A removed member who manages a second family the victim is in could list the area at an old version and, with the server serving the old top level, have the victim write under a key the removed member holds. Fixed in both twins in this PR:

- write version, block reason, root-seen version and root node are kept per (family, area); an area resolves only through the family `openArea` derived its id under, and another family's listing of it, or of the account's own personal workspace (`openPersonalWorkspace`, at the drive's unlock), is ignored and reported (`foreignListings`), never a lock; commit, uncommit and forget touch only their own family's areas; only a root at the write version names the root node;
- a chain older than the one held is refused (`OLDER_CHAIN`), so a background acceptance that loses a race with the foreground's writes no record or pin, and the web's data layer reads again quietly (`lib/groups/sync.ts`, three tries, then it says the server keeps serving an older member list); another chain at the version held is never committed (`SPLIT_CHAIN`), and the worker passes its committed chain to acceptance as a mark, so a split view within a session is the fork, the hard warning;
- an old top level served again never lowers the root-seen version, and once the root node is known any other top-level node is refused without touching it;
- a walk runs `requireWritable` first in both twins; the core gains `rotate_drop_all` (Core 2's `rotate_node` moved the pending mark after the records, as the web's `rotateKey` marks it).

- **Tests:** 22 Rust unit tests in `area_ledger.rs` and one in `drive.rs` (each rule, refused and allowed); 29 shared scenarios (`fixtures/area-ledger-scenarios.json`), the reviewers' two-family attack, another family's refusal and another family forgotten among them (each fails on the first commit's code), whose stated outcomes both twins must give and whose full outcomes each twin's fixture holds for the other to match step for step; every key envelope one twin made or served (option A's previous-root label included) opened by the other; two rule oracles on every run (each successful create, re-wrap or walk key under a parent rooted at the write version; each node a write made writable at once); a worker test of the lost race (`session.groups.test.ts`); fuzz target `area_ledger` in both twins asserting the oracles, with a fast-check generator of random step sequences (two families included) in the differential; break-checks of every rule in Rust. The TypeScript runner calls the worker's own ledger functions (`commit`, `uncommit`, `forgetGroup`, `openArea`, `openListedNode`, `newNodeKey`, `rewrapNode`, `rotateKey`); it does not reach the worker's grant opening (`openAreaGrant` needs an unlocked account and a holder's seal, and has its own shared cases) or `rekeyNode`'s records (Core 2).
- **Proof:** `core:check`, the crypto suite, the web's groups and drive tests, `fuzz:diff`, 30 s of cargo-fuzz and Jazzer on `area_ledger`, bindings regenerated and both apps built. No simulator: nothing user-visible changes.
- **Apps write family folders only through the ledger.** `node_wrap`, `node_open` and `previous_root_key_open` stay exported (personal folders, shares, the shipped apps) but check none of these rules. Every wrap, re-wrap, create and walk in a family folder goes through `new_node_key`, `rewrap_node` and `rotate_key` (since Core 2, `rotate_node`), and keys for writes come from `writable_node_key` only; app reviews reject anything else.

### Core 2: walks, re-keyed records and verdicts

The rotation's record half, twin of `rekeyRecord`/`legacyRecord`/`rekeyNode` (extracted from `session.ts` into a pure module the worker calls, as Core 1 did): `AreaLedger::rotate_node(ws, node, target, signer)` returns the whole rotated node (key envelope, metadata and versions each re-keyed raw, the origin carried after the bound check, dropped with `drop_origin`, or made from the writer's record; no legacy signature in a family folder). A node with shares or links in a family folder is refused (sharing there is hidden, design 3.4). `AreaLedger::record_verdict` is the verdict glue of `session-groups.ts:verdicts` (this account's records by its own keys, everyone else's by `group_writer_trust`, a rekeyed record with the node key at its epoch from the ledger), and `copy_form` is `judgeWith` for copies out of a family folder. `rotate_key`'s early pending mark goes away: `rotate_node` marks pending only after the records are re-keyed, as the worker does.

- **Tests:** shared fixtures: nodes rotated by each twin read by the other's rekeyed verdict (`bound: true`, the origin's verdict kept, a removed member's file `former-member`), a carried origin, a dropped one (unbound wrap, a gone writer), an unsigned record re-sealed; fuzz: the `record_integrity` seeds extended with rotated nodes; Rust tests for each branch with break-checks.
- **Proof:** as Core 1. No simulator.
- **Built (PR #66, review fixes after it):** the worker's record half is `packages/crypto/src/rotation-records.ts` and its verdict glue `group-verdicts.ts`; the core's are `rotation_records.rs` and `group_verdicts.rs` behind `rotate_node`, `record_verdict` and `copy_form`, with `open_account` binding readers and seeds to the unlocked account and `uncommit(group_id, fork)` recording the fork; `rotate_key` is no longer exported. The review (Opus, Fable) found the web's walk re-sealing served shares in family folders: a hostile server could list a share to its own key and receive every re-keyed node key. Both twins now refuse a family-folder node with shares or links (`SHARED_IN_FAMILY`): sharing stays hidden in family folders (design 3.4, "Shares inside family folders") because a walker can vouch only for shares it can tell were made by someone entitled to, to keys they vouched for, and in a family folder that ledger is each member's own, so re-sealing whatever the server lists would let the server add recipients. The Drive walk reports the refusal and stops after its retries. Both twins also refuse a second walk of a pending node and a copy of a re-keyed record served without its epoch (a refusal of unsigned records under a replaced key was tried and reverted: it would stall honest walks at a deleted member's records; the residual is in docs/integrity-design.md); `groupVerify` and `record_verdict` take the family from the ledger. Remaining twin differences: the core walks family folders only (no `legacyRecord`); `record_verdict` takes the account from `open_account`, the web from its session; personal keys come from the writers passed, not the Drive trust set. Fixtures `rotations` in both area-ledger files (eleven cases, read across and walked across), Rust unit tests with break-checks, `record_integrity` seeds from every re-keyed record.

### Core 3: the device record and the pins

Twins of the device store and the pin rules: `group_device_record_seal/open` (HKDF from the account root, info `hushos/group/device-store/v1`, associated data `["hushos/group/device-store",1,userId,groupId,store]`), `GroupChainCache` read and written as the web writes it (`cacheVersion` 2, `areaRoots`, `retiredAreas`), and `accept_served(record, settings_pin, served)`: accept continuing from the record's cache; if that is refused, accept from roster version 1 with the cache left out and **the record's own pin kept as a mark**, never against the settings pin alone (design 2.7: a server can serve older settings). `merge_pin` and `pin_ahead` move from `apps/web/src/lib/groups/pins.ts` into `packages/crypto` so they have a twin. A pin's areas come only from `open_area`'s result.

- **Tests:** shared fixtures: a record sealed by each twin opens in the other; a record from another account or group, or after a master-key rotation, refused; a cache refused (damaged, a newer `cacheVersion`) takes the from-version-1 path and a chain cut below the record's pin is still a rollback; `merge_pin` conflict, lower and higher cases; fuzz kind `device_record` in `pins`.
- **Proof:** as Core 1.
- **Built:** `crates/hushos-core/src/device_record.rs`; the web's acceptance order moved into `packages/crypto/src/record-acceptance.ts` (`acceptFromRecord`, `sync.ts` calls it) and `mergePin`/`pinAhead` into `packages/crypto/src/pins.ts`. `accept_served` is an `AreaLedger` method (it needs the committed chain, the settings and the account's store key) and answers `FetchFromVersionOne` where the web fetches again. The review (two, "merge after fixes") added: a per-family floor (the highest chain committed this session) that a refusal's uncommit never drops, in both twins, so a run that lost to a background commit can never take an older chain after a refusal; `Overtaken { split }` and `served_race_message`; a race on the continuation fetching from version 1 once; the account's root held by `open_account`, re-checked at commit; `use_settings` with the downgrade refusal; records written in commit order (the web's `putChain` refuses a lower version); `OpenedArea` carrying its family.

### Core 4: the join preview and successor consent

`group_join_preview(served, marks)` (the served chain verified as acceptance would, nothing kept; the join code of the roster where this account's entry last became active) and `join_check(code, hidden, typed)` (two hidden positions the app draws with the system CSPRNG, kept only for that showing; the typed words must be the code's there). `succession_consent_sign(user_id, link, old, new)` and `links_needing_consent(history)`, twins of the web's backfill (only links between two version 2 identities, each uploaded at its own key version).

- **Tests:** shared fixtures: a preview over a made-up first key or another admission gives another code (`join-mark-made-up-first-keys` probes reused); consent signed by the core verifies in the web and in the server's check (`packages/db/src/auth.consent.test.ts` reads the core's fixture); a version 1 link is never offered for consent.
- **Proof:** as Core 1.

### Core 5a: staged chains, admission and roles

Twins of `groupStage`/`restage` and the call bodies that change who holds what: a staged acceptance of the device's own signed, unsent roster (never a mark, never cached), the admit body (roster, grants of every area's current key, a key seal for a new `members` holder), role changes (granting `members` with a key seal, taking it away with a group key succession and its seals), and the organizer handover (`billing` and `members` to another adult member before leaving). The app persists the outbox (sealed with the device record's key) and resends the same bytes until a definite answer (F7).

- **Tests:** shared fixtures: bodies built by each twin accepted by the other's `roster_check_next` and by the server's checks (`packages/groups/src/server.test.ts` reads the core's fixture); a staged chain refused as a cache and as a pin; a resend after an unknown outcome is byte-identical.
- **Proof:** as Core 1, plus a `verify-hushos` run where the web admits a member a core-built roster added.

### Core 5b: removal, key replacement, folder deletion and repair

The bodies that rotate areas: removal (roster marking left, a rotation per live area: new area key, root key, `previous_root_key_wrap`, grants to every remaining member, a succession when a holder leaves), a folder's key replacement (route 24), a folder's deletion (the tombstone roster, route 30), and the previous-root repair (route 28, only from a key this device opened itself). Each staged and resent as in 5a.

- **Tests:** as 5a, plus: a removal body that leaves any live area unrotated is refused by both twins and the server; a deletion carries exactly one tombstone and nothing else; a repair never uses a served previous envelope's key.
- **Proof:** as 5a, with the web removing a member a core-built removal body removed and every folder reading `former-member` for their files.

### iOS 1: spaces and family folders, read only

`HushOSKit`: `GroupsAPI` (routes 2, 3, 5, 6, 25), `FamilySync` (an actor: fetch, `accept_served` with the device record in `local/groups/` under `Unbacked`, the settings pin through `updateSettings`, `open_area`, the root listed through the ledger), and a `Family` space beside the personal one in `DriveStore`. Screens: Families in Account (a row per family, as the web's sidebar row: decision 1c), the family page (members, roles, "Verified by Lindqvist family" in Info), the family folder list (the same Files list, read only), the hard warning ("Lindqvist family's member list was shown differently to you") and Couldn't check states. Native structure, Paper accent, no custom cards (apps/ios/AGENTS.md).

- **Records in commit order:** `FamilySync` writes the record `accept_served` returns only if no stored record is at a later roster version (a compare under the same file lock), and before it settles the pin into settings, as the web does; `FetchFromVersionOne` is called again with the same record; `Overtaken` is read again three times, then `served_race_message`.
- **Tests:** `HushOSKitTests` with the stub server: a served chain short of the device record is refused and the family shows Couldn't check; a fork shows the warning and opens nothing; a not-member answer wipes local state but keeps the settings pin (D7 reversed); a late acceptance never writes an older record over a newer one.
- **Proof:** simulator screenshots (iPhone 18 Pro) of the Families row, a family page, a family folder with a file a web member wrote, and its Info line; the same account on the web shows the same names and marks.

### iOS 2: writes in family folders

Every Drive write in a family folder goes through `AreaLedger`: new folders, uploads (begin and the background queue), renames, moves inside the folder, trash. `KEY_CHANGE_PENDING` and the server's 409 `rotating` are the same wait in the queue; `NOT_CARRIED` and `NOT_COMMITTED_ROOT` show as Couldn't check. Copy and move across spaces re-upload (the server copies within one workspace). No Share or link actions in family folders.

- **Tests:** stub-server tests: an upload into a folder reached through the previous root waits and goes once the walk re-keyed it; a root whose key is not the committed one makes the folder read only.
- **Proof:** simulator: upload a photo into a family folder, see it on the web with no mark; with the web mid-removal (a walk running), the iOS upload shows waiting and lands after.

### iOS 3: joining

The invitation link (`/join#invite=`, `AppLinks`), accept, the own-words screen for the admin to read, then the join code: ten words shown, two blanked at positions the phone draws, typed as the admin reads them; "They match" accepts with the join mark and pins; "They don't match" keeps nothing. Pending state survives a relaunch (the sealed joins record).

- **Tests:** `join_check` wired so a wrong typed word, or a code that changed since it was shown, keeps nothing; positions are not sent anywhere (a stub-server assertion on every request body).
- **Proof:** simulator screenshots of each join screen; the web admin's screen shows the same twelve words; after joining, the family folder opens on the phone.

### iOS 4: leaving, and members' due work

Leave (route 20, with the organizer and last-holder refusals as the server words them), the local wipe, and the member side of a removal: walks of family folders this device has its own reason to run (`ownReasonToWalk`), in the foreground and, by owner decision, as a `BGProcessingTask` so a walk finishes while the app is closed, through `rotate_node`. A background acceptance and a foreground one can race; the ledger's floor (Core 3: never dropped by a refusal) and `commit` refusing an older chain (Core 1) keep the loser from committing, and the record is still written only in commit order (no record over one at a later roster version), so the loser writes no older record or pin. The background task and the app share one `AreaLedger` only within a process; across processes the record's version compare is what holds.

- **Tests:** leaving wipes the family's keys, record and Files domain, and keeps the settings pin; a walk resumes after the app is killed mid-batch (the pending keys are dropped, the batch resent).
- **Proof:** simulator: leave a family; its folders vanish from the app and Files; the web shows the member as left.

### iOS 5a: managing members (invite, let in, roles, handover)

Every manager action the web has, except billing (owner decision): invite by email, pending admissions with the newcomer's words checked against the served identity (the admin's version 3 pin), "Let them in" (Core 5a's admit body), granting and taking away `members`, and the organizer handover.

- **Tests:** stub-server tests of the outbox: an unknown outcome resends the same bytes; `stale` drops and re-signs over the winner; taking `members` away carries a succession.
- **Proof:** simulator plus web, two accounts: the phone lets a web newcomer in; both screens show the same join code; the phone makes them a manager and the web shows the role.

### iOS 5b: removing, replacing keys, deleting a folder

Remove (Core 5b's removal body, then the walks), "Replace keys" on a folder, "Delete family folder" with the web's dialog wording, and the previous-root repair when a walk reports it.

- **Tests:** as 5a, plus a deletion refused while someone is still to be marked left (409 `left-due`).
- **Proof:** the phone removes the web member and the web shows every folder's key replaced; the phone deletes a folder and it leaves the web's spaces list.

### iOS 6: family folders in Files

**Yes, one File Provider domain per family**, identifier `com.hushos.app.family.<groupId>`, display name the family's name, owned by (account, origin, group) exactly as the drive domain is owned today. Why: design 3.4 already promises one Files location per space; a family folder that exists only inside the app is the thing members will notice first; and the ledger makes the extension safe (it fills its own `AreaLedger` from listings, as the worker does after a reload, and runs the same acceptance from its record). Costs that decide the shape: the extension accepts from the device record (one chain read and a cache continuation, no ML-DSA from version 1 unless the record is refused); the domain is removed on leave, not-member, or a fork; Files writes that meet `KEY_CHANGE_PENDING` answer `NSFileProviderError(.serverUnreachable)` so Files retries instead of deleting the item (never `noSuchItem`, apps/ios/AGENTS.md). Read first, writes in the same step only if the PR stays reviewable; otherwise a step of their own after this one.

- **Tests:** `FilesGate` refuses a family domain whose recorded owner differs; a domain for a family the account left is removed with `.removeAll`.
- **Proof:** simulator: Files shows "Lindqvist family" under Locations; open a file the web wrote; after leaving, the location is gone.

### iOS 7: billing, read only

**No purchase, and no link out.** Apple's guideline 3.1.1 requires in-app purchase to unlock features or storage; 3.1.3(f) exempts a free companion app to a paid web-based cloud storage service only "provided there is no purchasing inside the app, or calls to action for purchase outside of the app". The US storefront now allows links to outside purchase (3.1.1(a), the 3.1.3 introduction); the owner chose not to use that: the same app everywhere, read only.

- The family page shows the plan, the pool and who pays, read only, with no "upgrade" wording, no link and no button: one line says billing is managed on the web.
- Never the Polar portal, and no storefront check.
- **Tests:** a unit test that no family or account screen holds a link or button to a billing page (a scan of the view tree's URLs in a snapshot test).
- **Proof:** simulator screenshot of the family page's plan section.

### Android 1 to 6

The same steps in the same order, on Compose and Material 3 Expressive: spaces and family folders read only (Android 1), writes through `AreaLedger` with `KEY_CHANGE_PENDING` as a WorkManager retry (Android 2), joining (Android 3), leaving and walks in WorkManager so they finish while the app is closed (Android 4, owner decision), every manager action the web has except billing (Android 5a and 5b), and **one DocumentsProvider root per family** (Android 6: `Root.COLUMN_ROOT_ID` `family:<groupId>`, title the family's name, `notifyChange` on the roots URI when a family appears or goes; the provider fills its own ledger under `vaultLock`, one per session, as `SharedLoad` does for trust). Tests are JVM unit tests with the core built for the host (`TrustLoadsTest` style); proof is emulator screenshots (`Pixel_9_API_36`) and the system Files app showing the family root, since `adb shell content` cannot query the provider.

**Billing on Android (Android 7):** the app ships on Google Play (owner decision). Play's payments policy requires Play Billing for digital services, with US-only programs (external content links, alternative billing) that need enrolment and fees; the owner treats Play like Apple: the plan read only, one line that billing is managed on the web, no link and no button. The sideloaded release build follows the same rule, so the two builds do not differ.

### Then: re-keyed records in personal folders (W1)

`rekeyedFor` stays group-only until every client that reads personal rows reads origins. Order:

1. iOS and Android read rekeyed rows in personal folders (Core 2's verdicts, already used for family folders) and send a protocol version that says so (`ios/4`, `android/4`);
2. both apps write the re-keyed form in personal rotations with the honest legacy signature beside it (`*_compat_sign`, decision D2);
3. server and web widen `rekeyedFor` to personal workspaces, and the server refuses a legacy re-seal from a client below protocol 4 on rows that carry an origin (D9 already refuses it; this makes it the update prompt instead of a stuck rotation).

Each is one PR; the third needs the minimum-version decision below. Test: a personal rotation by each client keeps an editor's file reading as the editor on the other two; a shipped (protocol 3) app's rotation is refused with "Update HushOS", never silently dropping an origin.

### Then: the consent gate (W2)

1. Both apps send `consent` with every succession (`identity_succeed` already returns it) and run the backfill once per account (Core 4).
2. The server answers a succession without consent 409 "Update HushOS" (`docs/groups-server.md` 5), once both apps have shipped step 1 and the minimum-version window has passed. F8 closes in `docs/groups-invariants.md`.

## The UniFFI surface

Objects (no constructors except where stated; Swift and Kotlin cannot forge them): `AcceptedRosters`, `SuccessionCache` (constructor), `AreaLedger` (constructor; one per unlocked session per process). Records cross as plain data; keys cross as `SecretBytes` copies the app wipes.

- Core 1: `AreaLedger::{commit (refuses an older chain: OLDER_CHAIN), uncommit, forget_group, clear, open_area, is_area, read_version, write_version, require_writable, open_listed_node, node_key, key_at_epoch, writable_node_key, new_node_key, forget_node_key, rewrap_node, rotate_key, rotate_commit, rotate_drop, rotate_drop_all, open_personal_workspace, foreign_listings, refuse_own_workspace}`; `ServedNodeKey`, `RotatingNodeKey`, `HeldNodeKey`, `NewNodeKey`, `RotatedKey`, `AreaOpened`, `AreaBlock`, `ForeignListing`; `previous_root_key_wrap/open`.
- Core 2: `AreaLedger::{rotate_node, record_verdict, copy_form, open_account}`, `uncommit(group_id, fork)` (`rotate_key` withdrawn); `RotatingNode`, `RotatingVersion`, `ServedRekey`, `RotatedNode`, `RotatedVersion`, `RotatedRecord`, `RekeyOut`, `GroupWriter`, `RecordReader`, `RecordStatement`, `ServedRecord`, `RecordVerdict`.
- Core 3: `AreaLedger::{open_account (now with the account root), use_settings, legacy_settings, accept_served, group_device_record_seal, group_device_record_open}` (`commit` is no longer exported: apps commit only through `accept_served`), `merge_pin`, `pin_ahead`, `served_race_message`; `ServedChain`, `ServedAcceptance` (`Accepted`, `Fork`, `RecordUnreadable`, `FetchFromVersionOne`, `Overtaken`), `DeviceStore` (`Outbox`, `Joins`), `OpenedArea` (object; `AreaOpened::pin_area`), `PinMerge`.
- Core 4: `group_join_preview`, `join_check`, `succession_consent_sign`, `links_needing_consent`.
- Core 5a: `stage_roster`, `admit_body`, `roles_body`, `handover_body`.
- Core 5b: `removal_body`, `area_rotation_body`, `area_delete_body`, `previous_root_repair`.

App review rules for Core 3: the only `next` an app passes `merge_pin` is `ServedAcceptance::Accepted`'s `pin`, and the only `opened` areas are `AreaOpened::pin_area`; records reach disk in commit order.

Rules for every addition: no parameter named after a C keyword; doc comment with a runnable example; a unit test in the same file; a fixture in both directions for anything sealed, signed or decided; a fuzz target or kind for anything that parses served data.

## Decisions

Taken by the owner (2026-10-18):

- **Manager actions:** the phones get every manager action the web has (invite, let in, remove, roles, organizer handover, replace keys, delete folder); billing is the exception.
- **iOS billing:** read only everywhere, no link out; the app says billing is managed on the web.
- **Android:** ships on Google Play; billing as on iOS (read only, no link).
- **Background key changes:** yes: `BGProcessingTask` on iOS, WorkManager on Android. The older-chain refusal (Core 1) is required for it.

- **Files and DocumentsProvider:** one location per family: yes (iOS 6, Android 6).
- **Minimum app version** for W1 step 3 and W2 step 2: 1.0.0.

Still open: whether Files writes ship with reads (iOS 6).
