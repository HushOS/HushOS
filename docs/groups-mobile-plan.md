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

`crates/hushos-core/src/area_ledger.rs`: `AreaLedger`, a `uniffi::Object` holding an unlocked session's workspace and node keys and deciding every write in a family folder exactly as the worker does. The worker's key store moved, unchanged, into `packages/crypto/src/area-ledger.ts` so the twin is the code the web runs; `session.ts` and `session-groups.ts` call it. Also `previous_root_key_wrap`/`_open` (option A's label) and a node-key context checked as the web checks it.

- **Tests:** 12 Rust unit tests in `area_ledger.rs` and one in `drive.rs` (each rule, refused and allowed); 18 shared scenarios (`fixtures/area-ledger-scenarios.json`) whose stated outcomes both twins must give, and whose full outcomes each twin's fixture holds for the other to match step for step; every key envelope one twin made or served (option A's previous-root label included) opened by the other; fuzz target `area_ledger` in both twins, with a fast-check generator of random step sequences in the differential; break-checks of every rule in Rust. The worker's own tests (session, group, rotation, join; the web's `lib/groups`) pass unchanged on the moved code.
- **Proof:** `core:check`, the crypto suite, `fuzz:diff`, 30 s of cargo-fuzz and Jazzer on `area_ledger`, bindings regenerated and both apps built. No simulator: nothing user-visible changes.

### Core 2: walks, re-keyed records and verdicts

The rotation's record half, twin of `rekeyRecord`/`legacyRecord`/`rekeyNode` (extracted from `session.ts` into a pure module the worker calls, as Core 1 did): `AreaLedger::rotate_node(ws, node, target, signer)` returns the whole rotated node (key envelope, metadata and versions each re-keyed raw, the origin carried after the bound check, dropped with `drop_origin`, or made from the writer's record; no legacy signature in a family folder). A node with shares or links in a family folder is refused (sharing there is hidden, design 3.4). `AreaLedger::record_verdict` is the verdict glue of `session-groups.ts:verdicts` (this account's records by its own keys, everyone else's by `group_writer_trust`, a rekeyed record with the node key at its epoch from the ledger), and `copy_form` is `judgeWith` for copies out of a family folder. `rotate_key`'s early pending mark goes away: `rotate_node` marks pending only after the records are re-keyed, as the worker does.

- **Tests:** shared fixtures: nodes rotated by each twin read by the other's rekeyed verdict (`bound: true`, the origin's verdict kept, a removed member's file `former-member`), a carried origin, a dropped one (unbound wrap, a gone writer), an unsigned record re-sealed; fuzz: the `record_integrity` seeds extended with rotated nodes; Rust tests for each branch with break-checks.
- **Proof:** as Core 1. No simulator.

### Core 3: the device record and the pins

Twins of the device store and the pin rules: `group_device_record_seal/open` (HKDF from the account root, info `hushos/group/device-store/v1`, associated data `["hushos/group/device-store",1,userId,groupId,store]`), `GroupChainCache` read and written as the web writes it (`cacheVersion` 2, `areaRoots`, `retiredAreas`), and `accept_served(record, settings_pin, served)`: accept continuing from the record's cache; if that is refused, accept from roster version 1 with the cache left out and **the record's own pin kept as a mark**, never against the settings pin alone (design 2.7: a server can serve older settings). `merge_pin` and `pin_ahead` move from `apps/web/src/lib/groups/pins.ts` into `packages/crypto` so they have a twin. A pin's areas come only from `open_area`'s result.

- **Tests:** shared fixtures: a record sealed by each twin opens in the other; a record from another account or group, or after a master-key rotation, refused; a cache refused (damaged, a newer `cacheVersion`) takes the from-version-1 path and a chain cut below the record's pin is still a rollback; `merge_pin` conflict, lower and higher cases; fuzz kind `device_record` in `pins`.
- **Proof:** as Core 1.

### Core 4: the join preview and successor consent

`group_join_preview(served, marks)` (the served chain verified as acceptance would, nothing kept; the join code of the roster where this account's entry last became active) and `join_check(code, hidden, typed)` (two hidden positions the app draws with the system CSPRNG, kept only for that showing; the typed words must be the code's there). `succession_consent_sign(user_id, link, old, new)` and `links_needing_consent(history)`, twins of the web's backfill (only links between two version 2 identities, each uploaded at its own key version).

- **Tests:** shared fixtures: a preview over a made-up first key or another admission gives another code (`join-mark-made-up-first-keys` probes reused); consent signed by the core verifies in the web and in the server's check (`packages/db/src/auth.consent.test.ts` reads the core's fixture); a version 1 link is never offered for consent.
- **Proof:** as Core 1.

### Core 5: staged chains and manager calls

Twins of `groupStage`/`restage` and the call bodies: a staged acceptance of the device's own signed, unsent roster (never a mark, never cached), the admit body (roster, grants of every area's current key, a key seal for a new `members` holder), the removal body (roster marking left, a rotation per live area: new area key, root key, `previous_root_key_wrap`, grants to every remaining member, a succession when a holder leaves), and the folder key replacement (route 24). The app persists the outbox (sealed with the device record's key) and resends the same bytes until a definite answer (F7).

- **Tests:** shared fixtures: bodies built by each twin accepted by the other's `roster_check_next` and by the server's checks (`packages/groups/src/server.test.ts` reads the core's fixture); a staged chain refused as a cache and as a pin; a resend after an unknown outcome is byte-identical.
- **Proof:** as Core 1, plus a `verify-hushos` run where the web admits a member a core-built roster added (server-side compatibility).

### iOS 1: spaces and family folders, read only

`HushOSKit`: `GroupsAPI` (routes 2, 3, 5, 6, 25), `FamilySync` (an actor: fetch, `accept_served` with the device record in `local/groups/` under `Unbacked`, the settings pin through `updateSettings`, `open_area`, the root listed through the ledger), and a `Family` space beside the personal one in `DriveStore`. Screens: Families in Account (a row per family, as the web's sidebar row: decision 1c), the family page (members, roles, "Verified by Lindqvist family" in Info), the family folder list (the same Files list, read only), the hard warning ("Lindqvist family's member list was shown differently to you") and Couldn't check states. Native structure, Paper accent, no custom cards (apps/ios/AGENTS.md).

- **Tests:** `HushOSKitTests` with the stub server: a served chain short of the device record is refused and the family shows Couldn't check; a fork shows the warning and opens nothing; a not-member answer wipes local state but keeps the settings pin (D7 reversed).
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

Leave (route 20, with the organizer and last-holder refusals as the server words them), the local wipe, and the member side of a removal: walks of family folders this device has its own reason to run (`ownReasonToWalk`), in the foreground and as a `BGProcessingTask`, through `rotate_node`.

- **Tests:** leaving wipes the family's keys, record and Files domain, and keeps the settings pin; a walk resumes after the app is killed mid-batch (the pending keys are dropped, the batch resent).
- **Proof:** simulator: leave a family; its folders vanish from the app and Files; the web shows the member as left.

### iOS 5: managing (invite, let in, remove)

Invite by email, pending admissions with the newcomer's words checked against the served identity (the admin's version 3 pin), "Let them in" (Core 5's admit body), remove (Core 5's removal body, then the walks). Folder deletion and the previous-root repair stay web only.

- **Tests:** stub-server tests of the outbox: an unknown outcome resends the same bytes; `stale` drops and re-signs over the winner.
- **Proof:** simulator plus web, two accounts: the phone lets a web newcomer in; both screens show the same join code; the phone removes them and the web shows every folder's key replaced.

### iOS 6: family folders in Files

**Yes, one File Provider domain per family**, identifier `com.hushos.app.family.<groupId>`, display name the family's name, owned by (account, origin, group) exactly as the drive domain is owned today. Why: design 3.4 already promises one Files location per space; a family folder that exists only inside the app is the thing members will notice first; and the ledger makes the extension safe (it fills its own `AreaLedger` from listings, as the worker does after a reload, and runs the same acceptance from its record). Costs that decide the shape: the extension accepts from the device record (one chain read and a cache continuation, no ML-DSA from version 1 unless the record is refused); the domain is removed on leave, not-member, or a fork; Files writes that meet `KEY_CHANGE_PENDING` answer `NSFileProviderError(.serverUnreachable)` so Files retries instead of deleting the item (never `noSuchItem`, apps/ios/AGENTS.md). Read first, writes in the same step only if the PR stays reviewable; otherwise iOS 7.

- **Tests:** `FilesGate` refuses a family domain whose recorded owner differs; a domain for a family the account left is removed with `.removeAll`.
- **Proof:** simulator: Files shows "Lindqvist family" under Locations; open a file the web wrote; after leaving, the location is gone.

### iOS 7: billing hand-off

**No purchase in the app, and no call to action outside the United States.** Apple's guideline 3.1.1 requires in-app purchase to unlock features or storage; 3.1.3(f) exempts a free companion app to a paid web-based cloud storage service only "provided there is no purchasing inside the app, or calls to action for purchase outside of the app". On the United States storefront, 3.1.1(a) and the 3.1.3 introduction now allow buttons and external links to other purchase methods. So:

- everywhere: the family page shows the plan, the pool and who pays, read only, with no "upgrade" wording;
- United States storefront only (`Storefront.current?.countryCode == "USA"`): a "Manage family plan" row opens **the web family page** (`/app/families/<groupId>`, its billing section) in the system browser;
- never the Polar portal directly. The portal knows nothing of HushOS's rules (who pays, handover only once the new payer added a card, seats counted at admission), and a portal link is a server-minted customer session, a bearer URL for card management that the app would hold; the web page mints it per request for a signed-in payer and also works for self-hosted servers without Polar. Cost: Safari has no HushOS session, so the person signs in on the web first.
- **Tests:** a unit test that the row exists only for the US storefront.
- **Proof:** simulator with the storefront set to the US and to another country (StoreKit configuration file): the row appears only in the first.

### Android 1 to 6

The same steps in the same order, on Compose and Material 3 Expressive: spaces and family folders read only (Android 1), writes through `AreaLedger` with `KEY_CHANGE_PENDING` as a WorkManager retry (Android 2), joining (Android 3), leaving and walks as an expedited `CoroutineWorker` (Android 4), managing (Android 5), and **one DocumentsProvider root per family** (Android 6: `Root.COLUMN_ROOT_ID` `family:<groupId>`, title the family's name, `notifyChange` on the roots URI when a family appears or goes; the provider fills its own ledger under `vaultLock`, one per session, as `SharedLoad` does for trust). Tests are JVM unit tests with the core built for the host (`TrustLoadsTest` style); proof is emulator screenshots (`Pixel_9_API_36`) and the system Files app showing the family root, since `adb shell content` cannot query the provider.

**Billing on Android:** the app is sideloaded today (`android:release`), where no store rule applies: the family page links to the web family page. If it ships on Google Play, Play's payments policy requires Play Billing for digital services, with the US external-content-links and alternative-billing programs (enrolment and fees) as the exception; the iOS rule (no call to action outside the US) would then apply there too. That is an owner decision before any Play listing.

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

- Core 1: `AreaLedger::{commit, uncommit, forget_group, clear, open_area, is_area, read_version, write_version, require_writable, open_listed_node, node_key, key_at_epoch, writable_node_key, new_node_key, forget_node_key, rewrap_node, rotate_key, rotate_commit, rotate_drop, refuse_own_workspace}`; `ServedNodeKey`, `RotatingNodeKey`, `HeldNodeKey`, `NewNodeKey`, `RotatedKey`, `AreaOpened`, `AreaBlock`; `previous_root_key_wrap/open`.
- Core 2: `AreaLedger::{rotate_node, record_verdict, copy_form}`; `RotatedNode`, `RotatedRecord`.
- Core 3: `group_device_record_seal/open`, `accept_served`, `merge_pin`, `pin_ahead`; `DeviceRecord`.
- Core 4: `group_join_preview`, `join_check`, `succession_consent_sign`, `links_needing_consent`.
- Core 5: `stage_roster`, `admit_body`, `removal_body`, `area_rotation_body`.

Rules for every addition: no parameter named after a C keyword; doc comment with a runnable example; a unit test in the same file; a fixture in both directions for anything sealed, signed or decided; a fuzz target or kind for anything that parses served data.

## Open decisions for the owner

1. **Manager actions on the phones.** Proposed: invite, let in and remove in 1d (iOS 5, Android 5); folder deletion, key repair and folder key replacement stay web only.
2. **iOS billing.** Proposed: read-only plan everywhere, a link to the web family page on the US storefront only. Accept that people sign in again on the web, or fund a one-time sign-in hand-off token (a new auth route and its review)?
3. **Android distribution.** Stay sideloaded (link freely) or list on Google Play (Play Billing rules, US programs)?
4. **Files and DocumentsProvider.** Confirm one location per family, and whether Files writes ship with reads.
5. **Minimum app version** for W1 step 3 and W2 step 2: how long protocol 3 apps keep working before "Update HushOS".
6. **Background walks.** `BGProcessingTask`/WorkManager walks, or only while the app is open?
