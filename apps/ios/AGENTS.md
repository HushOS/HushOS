# HushOS for iOS

SwiftUI app for iOS 26 and later, on the App Store (Android is on Google Play). The repository's root `AGENTS.md` applies here too.

## Targets and packages

| Folder           | Target                | Bundle id                      | Role                                                                  |
| ---------------- | --------------------- | ------------------------------ | --------------------------------------------------------------------- |
| `App/`           | `HushOS`              | `com.hushos.app`               | The app                                                               |
| `Files/`         | `HushOSFiles`         | `com.hushos.app.files`         | File Provider extension                                               |
| `FilesUI/`       | `HushOSFilesUI`       | `com.hushos.app.filesui`       | Sign-in action extension (OPAQUE sign-in inside Files)                |
| `Share/`         | `HushOSShare`         | `com.hushos.app.share`         | Save to HushOS share extension                                        |
| `Widgets/`       | `HushOSWidgets`       | `com.hushos.app.widgets`       | Live Activity for uploads and downloads (Dynamic Island, Lock Screen) |
| `Notifications/` | `HushOSNotifications` | `com.hushos.app.notifications` | Notification Service Extension: writes a push's notice                |

- Everything the targets share is the Swift package `Packages/HushOSKit`: keychain, Drive API, the vault that opens keys, OPAQUE sign-in.
- HushOSKit sits over `Packages/HushOSCore`, the UniFFI bindings of `crates/hushos-core`.

## Build and run

```sh
bun run core:apple      # Rust -> Packages/HushOSCore (needed once, and after any core change)
bun run ios:project     # XcodeGen: project.yml -> HushOS.xcodeproj (not committed)
bun run ios:build       # simulator build into apps/ios/DerivedData
bun run ios:run         # install and launch on the iPhone 18 Pro simulator (SIMULATOR=<udid> to pick another)
```

- The API is the web dev server on http://localhost:5173 (`bun dev` at the root). The simulator shares the host's network.
- A real phone defaults to `https://hushos.com` (`AppModel.defaultOrigin` under `#if !targetEnvironment(simulator)`); the simulator keeps `http://localhost:5173`.
- The sign-in screen has a field for another origin, on either.
- `Files/`, `FilesUI/` and `Share/` build in Swift 5 mode (`project.yml`). The File Provider API is callback based and Swift 6's sending-closure checks reject it.

### On a real iPhone

- `DEVELOPMENT_TEAM=<team id> bun run ios:device` builds for the plugged-in iPhone with automatic signing and installs it through `devicectl`.
- Xcode must be signed in to an Apple Developer Program account. The app group and keychain sharing are not available to free accounts.
- On a device the Files location starts disabled: Files > Browse > the ... menu > Edit > turn HushOS on.

### Entitlements

- Entitlements come from `App/HushOS.xcconfig`, not from the XcodeGen `entitlements:` block. A target-level setting would shadow the per-SDK choice.
    - The simulator gets `App/HushOS-Simulator.entitlements`, which adds the File Provider testing mode.
    - A device gets `App/HushOS.entitlements`.
- Simulator debug builds skip the disabled-domain step through `NSFileProviderDomain.testingModes = .alwaysEnabled`. That needs the `com.apple.developer.fileprovider.testing-mode` entitlement the app carries.
- A device build without that capability in its profile must drop the entitlement.
- Simulator builds embed entitlements in the binary's `__entitlements` section. Check them by reading `__TEXT,__entitlements`; `codesign -d --entitlements` shows an empty dictionary, and that is fine.

### Release builds

- `DEVELOPMENT_TEAM=<team id> bun run ios:archive` (`scripts/archive.sh`) archives for the App Store and uploads to App Store Connect. `UPLOAD=0` stops after the export.
- The unsigned IPA for sideloading: `bun run ios:release-ipa vX.Y.Z` (`scripts/release-ipa.sh`).
    - Release, generic iOS arm64, `CODE_SIGNING_ALLOWED=NO`, the default app group.
    - Each bundle is then signed ad hoc only to carry its entitlements (the app group, associated domains), which the sideloading tool reads to know what to request.
    - `keychain-access-groups` is left to the tool, since items are kept under the app group.
    - `--here` builds the checkout as it is without uploading.

### Debugging

- Extension logs:

    ```sh
    xcrun simctl spawn <udid> log show --last 2m --predicate 'subsystem == "com.hushos.app.files"'
    ```

- fileproviderd's own view: predicate `process == "fileproviderd" AND eventMessage CONTAINS "hushos"`.
- Inspect the mirror on the simulator with `sqlite3 <app group>/mirror.sqlite`.
- The simulator caches launch screens: reboot it after changing them.
- The simulator opens the document camera but can't capture ("Unable to capture media"). Try a scan on a device.
- Live Activity: requested, updated and ended correctly (ActivityKit log, SpringBoard aperture assertions). The compact island content was not legible in simulator captures; check on a device.

## How it fits together

### Session and keychain

- The session cookie, the remembered device (account key sealed under a device key) and the origin live in the shared keychain.
    - Access group: the app group. Service: `com.hushos.files`.
    - The extensions read the same session the app signed in with.
- Keychain items are replaced with `SecItemUpdate` (added only when missing), never deleted and added again. The app and both extensions read them, and a read between the two found no session.
- Signing out deletes the session, removes the Files domain and wipes everything of the account on the phone, the remembered device included. The next sign-in starts from the password.

### The app group

- The app group is `AppGroup.current` in HushOSKit, the same answer in every process. It covers the container, shared defaults, the keychain access group and background transfers' shared container.
- It is `APP_GROUP_ID` (`group.com.hushos.app` unless `App/Local.xcconfig` sets another), carried as `HushOSAppGroup` in every bundle's Info.plist.
- Exception: the bundle's `embedded.mobileprovision` grants `com.apple.security.application-groups` that don't include it. An extension without a profile reads its app's, two folders up. Then the group is:
    - the entry that extends it (`group.com.hushos.app.<TEAMID>`, what AltStore, SideStore and iloader give a sideloaded build);
    - else the profile's only group.
- App Store, TestFlight, simulator and unsigned builds carry no profile and keep `APP_GROUP_ID`.
- The profile is a CMS envelope. The plist is read from between its XML declaration and `</plist>` (no public CMS decoder on iOS).
- Tests: `AppGroupTests`, with fixtures in `Packages/HushOSKit/Tests/Fixtures` (real CMS envelopes signed with a throwaway key).

### Vault and keys

- `Vault` (an actor) opens the account key from the device memory, the workspace key from the grant, and node keys under their parents.
- It keeps a node-to-parent index in the app group container, so a cold extension process can find an item by listing its folder.
- Node keys and opened nodes are kept by workspace and node (`NodeTable`). The server picks a share's ids; keyed by id alone, a share could replace one of the account's own folder keys.
    - Look up a parent by `NodeRef(node.workspaceId, parentId)`. Id-only lookups prefer the own workspace.
    - A share into the own workspace, or whose node names another workspace, is refused before anything opens (`Vault.checkReceived`).
    - A write's reply is adopted only for the workspace written into.

### One account at a time

- Per account, never across. The queue's records (`BackgroundTransfers.Record.owner`) and Save to HushOS's notes (`ShareHandoff.owner`) say whose they are.
- `TransferOwnership` runs them only for that account and keeps them while nobody is signed in. It drops another account's (or an unowned one's) without a request to the server.
- `AccountStore` keys the group's account data by `AccountOwner`: the same user id on another server is another account.
- `TemporaryCopies.claim` does the same for each process's temporary folder (the app at sign-in, the Files extension through its gate).
- The app checks the keychain's account when it comes back on screen (`AppModel.checkAccount`), so a sign-in from the Files sheet replaces what it shows.
    - It runs over `SessionChange`: the same account's new session is adopted in place; another account's stops the last one's queue and notices first.
    - Every change but none drops the last session's family sync, ledger keys and vault (`SessionChange.forgetLastSession`).

### Out of backups

`HushOSKit/Unbacked.swift` keeps the account's data on this phone and out of iCloud and computer backups.

- Covered: decrypted files (`offline`, the queue's `transfers`, Save to HushOS's `share-staging`).
- Covered: anything naming what is in the drive.
    - `state/`: the kept-file lists, the last folder, recent searches and the last email.
    - `local/`: `files-parents.json`, `account-owner`, `files-domain-owner.json`, `mirror.sqlite*`, the families' records in `groups/` and the sealed rollback marks in `marks/`.
- Lists the app and its extensions share go in `state/` as JSON through `Unbacked.read`/`write`. Never in the app group's `UserDefaults` or the app's own: those are plists a backup takes.
- Only folders carry the mark. An atomic write replaces a file and drops its mark, and SQLite makes its side files when it likes.
    - So no loose file at the top of the group: put it in `local/`. An older version's loose files are moved there once by `apply()`.
- A folder sign-out removes is made again with `Unbacked.folder(_:)` before each write (the queue does), never with a bare `createDirectory`.
- Make any new top folder for such data with `Unbacked.folder(_:)`. Add its name to `Unbacked.names` and, if it belongs to the account, `AccountStore.accountFiles`.
- A restore can drop `isExcludedFromBackup`, so `Unbacked.apply()` marks everything again at every launch of the app, the Files extension and the share extension.
- The temporary folder is never backed up and needs no mark.
- Group folders and the mirror are `completeUntilFirstUserAuthentication`: background transfers need them while locked.
- `TemporaryCopies.sweep` runs in the app and the Files extension.

### Errors people read

- Every failure a person reads goes through `ErrorWords.say` (HushOSKit). It returns:
    - nil for a cancellation (show nothing);
    - HushOS's own words (`WordedError`, the core's sentence);
    - or the caller's fallback. Never an error's `localizedDescription`.
- `DriveAPI` turns a request cancelled under a cancelled task into `CancellationError`, not `transport`. A tab switched mid-load once set the offline line or, through Shared's `.task`, marked every file "Couldn't check".
- A request the system cancelled (`URLError.cancelled` while the task runs: a torn-down session, a killed request) stays `transport`, retried and reported. Otherwise a failed upload looks finished.
- A save or upload loop never takes a cancellation for success. Save to HushOS stages through `StagedSave`, which puts the shared copy back and always has words.
- Store-wide state (trust, mounts) is never left to a view's task to finish.

## Design rules

- Native structure and controls, Liquid Glass from the system. No custom cards or buttons.
- Colours, radii and spacing come from `Alpine` (`packages/tokens`, generated; see `App/Theme.swift`), in both appearances. The app keeps the system font.
- Tag pills lighten their ink in the dark.
- Icons: light = mark on sheet; dark = mark on transparent (iOS backs it); tinted = white mark on black (iOS's tinted and clear styles derive from it).
- Splash: black mark on white, white mark on black.
- A Photos picker inside a Menu never presents. Use a button and `.photosPicker`.

### Navigation bar

- Every screen uses the system navigation bar (`screenChrome` in Theme.swift), so the bars move where iOS puts them (iPhone Duo's vertical strip, the tab sidebar's toggle).
- A tab root (Home, Files, Shared, Account, Search, `root: true`) has its big title on the row with its buttons (`inlineLarge`).
- A pushed screen follows Apple's Files app: the browser toolbar role (title leading, after Back), a 20pt bold title in the title slot, on the same row as its buttons.
    - UIKit documents that a large inline title moves to its own row under the buttons once there is a Back button (`UINavigationItem.LargeTitleDisplayMode.inline`). So pushed screens never ask for one.
- What sits under the title (Shared's With me / By me, Home's tags row) is a section's header. Give such a section `listRowInsets` of zero and its rows explicit insets of 20, or the rows lose their margin.
- A folder's search is the system `.searchable` field under the bar.
- A link pushes onto a tab's stack only once that tab's screen has finished appearing (`onFinishedAppearing`, UIKit's viewDidAppear, Appeared.swift).
    - Used by Files (BrowseView), the Trash (AccountView) and a share link's page (SharedView).
    - Pushed earlier, the pushed screen's bar could be laid out before the tab had its safe area.

### Privacy on screen

- Nothing names a file on the Lock Screen. The Live Activity and transfer notifications carry counts, and a finished summary's second line says where a tap goes (Android's words).
- The app covers itself in the app switcher (`PrivacyCover`, a window above sheets).
- `PhraseGrid` hides the words while the screen is captured.
- Copies to the pasteboard are local-only and expire.

### Keyboards and password fields

- Third-party keyboards are refused (`AppDelegate`).
- The eye shows a password in place by switching the field's secure entry (`ShowablePasswordField`: no autocorrection, predictions or Writing Tools). This is safe only because the app refuses third-party keyboards.
- In the Files sign-in sheet (an extension that can't refuse them) it stays a secure field with the characters drawn over it (`revealed`).
- The recovery phrase goes into `PhraseEntry` (no autocorrection, predictions or Writing Tools).

## Screens

### Home

- Search pill, tags row with a manager, recent files, an Offline section.
- No type chips. Search's kind words (`ItemKind` in HushOSKit, the web's split) find "photos", "videos", "documents" and "folders".

### Files

- The tree, with search, tag filters and a floating add button.
- Scan document is VisionKit's document camera. Its pages are made into one PDF on the phone by `ScannedPDF` in `Uploads.swift`.
- Select mode with copy, cut, move and trash for many.
- A paste bar while the clipboard holds items.
- Same-name uploads get the same replace, keep both or skip prompt the web shows.

### Shared

- What others gave you, and By me (what you shared).

### Account

- Name, plan and storage, read only, with no way to buy (App Review 3.1.3(f)).
- Change password and delete account, through OPAQUE in the core.
- Contacts, Your twelve words, trash, sign out.
- What the plan card shows is decided by HushOSKit's `PlanDisplay`:
    - While `/api/auth/storage` names a `pool`, the card is the family's plan: "Shared with <family>" and the pool's figures. No Files row: the total is counted in whole GB.
    - It falls back to the personal plan when `pool` is absent or unreadable.
    - It names that plan only while it is live (`PlanStanding`, the web's `planStanding`: not ended and active, trialing or past_due).
    - Unpaid, incomplete or paused reads Free with the lapsed plan's words (`LapsedPlan`), said and never linked. Anything ended reads Free.
- "Not enough room" reads `StorageAllowance.free` (`availableBytes`), never quota less used.

### People

- A sheet from Account and from the Shared header.
- Add someone and Your twelve words rows sit above the list, sorted by name. Find someone appears from eight contacts.
- Your twelve words is `OwnWordsSheet` in `Sharing.swift`. It checks the served identity first (`Vault.currentOwnFingerprint`) and closes when the session ends.

### Markdown viewer

Markdown files (`text/markdown`, or `.md`, `.markdown`, `.mdx`) up to 2 MB open in `MarkdownView` instead of QuickLook's raw text. Larger ones go to QuickLook.

- HushOSKit's `MarkdownDocument` parses them with swift-markdown under the web's rules:
    - raw HTML dropped;
    - links to http, https or mailto only, and only on a tap;
    - images named and never fetched; a linked image opens its link;
    - a leading byte order mark dropped.
- Depth: swift-markdown builds its tree by recursion, and a background thread's stack holds only a few thousand levels.
    - So the depth is measured first on cmark's own tree with its iterator (`MarkdownDocument.depth`, swift-cmark used directly).
    - Past 64, the file is shown as its text.
    - Within it, quotes and lists are drawn 16 deep and emphasis and links 32; their words are plain past that.
- A file with more than 200,000 emphasis and link marks (`*`, `_`, `~`, `[`) is shown as its text before parsing. 2 MB of `*a* ` ran the Android parser out of memory.
- Big blocks come in pieces so the view lays out only what is on screen (`MarkdownDocument.cut`):
    - paragraphs and headings of at most 4,000 characters, cut between words;
    - lists and quotes of at most 200 in weight: a block each, a table row each, one per 200 characters. An item too heavy goes on in the next piece unmarked (`continued`);
    - image descriptions past 2,000 characters shortened;
    - code of 200 lines or 4,000 characters;
    - tables of 200 rows, 4,000 cells or 40,000 characters, repeating the head;
    - line and paragraph separators drawn as spaces (a line from Markdown counting 20 characters toward weight);
    - at most 50 columns, with a "…" column for the rest;
    - an image counted as at least 20 characters;
    - cells past 2,000 characters shortened with "…".
- Table columns stop at 320pt and wrap (`TableCellWidth`, since Grid measures rows at one line).
- Code with a line past 1,000 characters wraps.
- Tests: `MarkdownDocumentTests`.

### Keep downloaded

- Keep downloaded is the app's own feature (`Offline.swift`, app group container, one folder per version, the Offline section on Home).
- iOS Files never offers "Keep Downloaded" to third-party providers, even with `NSExtensionFileProviderSupportsPinning` and `allowsEvicting`. `contentPolicy`'s keep-downloaded case is macOS-only.
- Files' "Download Now" does work, through `fetchContents`.

## Mirror and catalogue

- `Mirror.swift` is the web's IndexedDB tree mirror in SQLite (raw SQLite3, no dependency) in the app group.

    | Table        | Holds                            |
    | ------------ | -------------------------------- |
    | `nodes`      | id, workspace, the row as served |
    | `cursors`    | feed cursor per workspace        |
    | `thumbnails` | sealed trailers by version id    |

- `Vault+Catalogue.swift` builds the catalogue the way `packages/drive/src/client.ts` does:
    - pull the whole feed once (a feed is state, not a log);
    - open rows parents first;
    - then `sync()` pulls only what changed since the cursor.
- `children(of:)`, `recents()`, `trash()` and thumbnails answer from it first. Shared folders (other workspaces) still go to the network.
- The store builds the catalogue after `loadRoot()` and calls `sync()` before every refresh. `catalogueVersion` bumps when lists change.

### Feed rules

- The feed's `resync` is heeded only on a pull's first page (the web client's rule).
    - The server answers it for any cursor above zero below the tombstones it dropped, so every later page of a refill carries it.
    - Heeding it there started the refill over for ever.
- Pulls and the build's read of the mirror take turns (`withFeedTurn`). Pulls interleave on the actor at every request, and a page applied after another pull's clear moved the cursor past rows the refill never brought back.
- A pull that cleared the mirror or started from nothing names no deletion. So the sync files the catalogue again from the mirror and lets go of rows it no longer holds up to its cursor (`letGo`).
- Any build over a filed catalogue owes what differs to the next sync (`catalogueOwed`), whoever ran it and whether a build failed first.
- The Files extension never pulls the mirror. It reads the server's feed from its own anchor (`changes(since:)`), where `resync` on any page is right: it answers `syncAnchorExpired`, and the anchor after re-enumerating is the head.
- Tests: `CatalogueFeedTests`.

## Sync, sharing state and Info

### Signalling Files

- The app signals Files after every live sync that changed something, so changes from other devices reach the Files location without a local write.
- A queued upload signals its folder as it lands (`BackgroundTransfers.land`).
- Every folder signal goes through `FilesDomain.signalFor` (the app's `DriveStore.signalFiles`). It picks a family folder's family location over the drive's, since a background launch may finish it before any screen and its sync exist.
- Nothing signals while the app isn't running. A change made elsewhere reaches an open Files location only once the app syncs.

### Who can open what

- `DriveStore.sharing` comes from `/shares/mine` and is asked again through `SharingRefresh` (HushOSKit):
    - at once after every restore (one row, many, a trash's Undo);
    - on reconnecting;
    - after a sync that applied a change in the own drive, at most once per 10 s, with one load at the interval's end.
- Why restores always load: the server leaves trashed items out, and a change can't say it was a restore.
- `sharing` is replaced only when the marks changed.
- `sharingVersion` moves when what the server lists changed (`SharingRefresh.listing`: share ids with roles, link ids). The marks miss a link replaced by another.
- Shared reloads By me on `sharingVersion` through one `.task(id:)`, only while its tab is on screen.
- Tests: `SharingRefreshTests`.
    - A restore loads even when the sync brought nothing.
    - One load per sync with changes, none without.
    - At most one per interval, with one at its end.
    - A restore is never held and answers a change waiting for the interval.
    - Requests during a load get one load begun after them.
    - By me follows the listing, not the marks.

### Info beside the list

- Info (`DriveStore.infoBeside`, HushOSKit's `InfoFollow`) follows the vault's rows, never the lists' caches.
- `Vault.standing(of:)` walks the item's folders in its own workspace and says one of:
    - live;
    - held: trashed, or a trashed folder above it;
    - removed: it or a folder above confirmed gone;
    - absent.
- Removal is `Vault.remove`: exactly one workspace's ref, used for trash, purge and feed tombstones, marked in `removedRows`. `forget` only drops a row to be read again.
- `InfoLookup.decide` is Android's `infoLookup`: close on a confirmed removal or a share no longer listed; show a live row; close a held one; keep the last row while it is only absent.
- The store looks again after each trash returns (`followInfo`), since the lists drop rows before the vault marks them gone.
- Nothing that only closes Info may change what the vault holds: no evictions, no re-opens. The children route leaves trashed rows out, so a listing is no verdict on what it doesn't name.
- A received share has no feed here. Its item missing from its own folder, listed afresh, closes Info on the lists alone (`InfoFollow.missing`, main's behaviour), and the vault keeps the row.

## Sign-in, sign-up and recovery

- Change password and delete account run through OPAQUE in the core.
- A password change or key rotation ends every session on the server, so the sheets sign in again with the new password themselves.
- `Account.swift` rotates the master key and reads the recovery key.

### Sign-up

- "Create an account" on the sign-in screen opens `SignupView` (`App/SignupView.swift`, a full-screen cover like `RecoveryView`). Steps:
    1. Email and the terms.
    2. The emailed link (`AppLink.register`, `/register/complete#verify=`, in the web's apple-app-site-association).
    3. Name and password (HushOSKit `SignupRules`: lengths in UTF-16 units as the web counts them, not Swift's `count`).
    4. `AppModel.createAccount`: `Auth.register` (OPAQUE and `accountCreate` in the core; the account key never crosses the FFI), then a normal sign-in.
- No plans, prices or codes anywhere on the way.
- A sign-up link opened while signed in is not used: a notice says to sign out first.
- An older TestFlight build that predates sign-up would catch `/register/complete` links and refuse them as web-only.

### Words waiting

- `WordsWaiting` (HushOSKit, `local/words-waiting.json`) marks a new account's words, and a recovery's, as waiting.
    - It is not in `state/`, which signing in to the new account wipes.
- `RootView` shows `FirstKitView` instead of the drive while the signed-in account is the one marked.
- That lasts until the check (`CheckWordsView`) confirms the phrase, or the server says it was confirmed elsewhere.

## Keys, trust and integrity

### Protocol and content suite

- The client speaks Drive protocol 3.
- `DriveAPI.clientHeader` sends the app's product version (`ios/1.0.0` form, from `MARKETING_VERSION`), which the server compares with its minimum.
- Uploads write content suite 3. `chunkEncrypt` pads; `chunkDecrypt` returns only the file's bytes.
- Every chunk (padding included) is fetched on a full read. Ranges and layouts take the version's suite (`OpenedVersion.layout`/`range`).
- Progress counts the file's own bytes (`FileProgress`), never chunks of padding.
- Copies reseal the version envelope in the core (`version_reseal`); the server keeps the object.

### Settings document

- The settings document is kept as JSON (`Settings` in `Settings.swift`), so fields other clients write survive every save.
- Edit it only through `updateSettings`, which retries a 409.
- It holds the pins and the sharing ledger:
    - `sharing.shares`: node to grantees;
    - `sharing.links`: link to node.
- A share or link joins the ledger after the server takes it and leaves before it is stopped. Rotation re-seals only what the ledger holds.
- Settings are sealed as version 2 under the settings key (made and stored on first save). Documents are written as version 2 (`Settings.json`), read as 1 or 2.
- `GET /api/auth/settings` always reports the stored sequence (`settingsVersion`, 0 for no row), with `settings` null for no row or a version 1 row.
    - The mark is checked against that sequence.
    - A version 1 row reads as empty.
    - Every save names the sequence and is sealed one above it (the sequence is bound into the seal).
- Master-key rotation rewraps the identity history and the settings key.
- Removals (`removedContacts`, `Settings.removeContact`) are forgotten oldest first for room (`fit`).
- A pin that doesn't fit is "Your contacts are full. Remove someone you no longer share with."
- `firstSeen` and every field another client wrote are kept.

### Rollback marks

- `RollbackMarks.swift`, `RollbackMarkStore`: the highest settings sequence, identity key version and identity version this phone has seen.
- One record per account in `local/marks/<slot>.json`.
- Sealed by the core under a key from the settings key (`rollback_marks_update`, the web's format), with the settings key's envelope beside it.
    - `Vault.marksKey`: kept envelope, then the vault's key, then the server's. Made only to keep a first mark.
- Checks are `SettingsMarks.check`/`IdentityMarks.check` over what `read` returns, and again over what the write found.
    - `SettingsMarks.check` with `document`: once a version 2 document was opened or saved, none or a version 1 row is refused at any sequence.
- `IdentityMarks` keeps the key version and the identity version. Once version 2 is opened, a version 1 identity for the account is refused at any key version. This is stricter than the web's same-key-version rule; every identity made since the release is version 2.
- Every Auth request a vault makes passes `as: session`, so it never goes out under another stored session.
- A record that does not open is `MarksWords.unreadable`; a mark that can't be kept is `MarksWords.unsaved`. The step it guards fails: an identity or settings are never taken without their mark.
- Deleted on every wipe with the rest of the account (`AccountStore.accountFiles`).
    - So are the plaintext files earlier versions kept across sign-outs (`local/settings-marks.json`, `local/identity-marks.json`). The first read folds them in and removes them.
- The app and its extensions share the marks, so every write is one open-raise-seal under `flock` on `local/marks.lock` (`FileLock`):
    - made only while the vault's own session is still stored and no sign-out came since it began;
    - `AccountStore` deletes the marks under the same lock, so a raise that waited through a sign-out writes nothing back;
    - the lock file itself is never deleted;
    - held only inside a `ProcessInfo.performExpiringActivity` assertion: a process suspended holding a lock in the group container is killed with 0xdead10cc;
    - never waited on without end (`LOCK_NB`, about a second of retries; one try when the system grants no time).
- A raise counts in this process at once (`MarkFloor`, forgotten at sign-out). So one the system gave no time to write still refuses a rollback here and goes into the next write.

### Contacts and pins

Contacts without comparing words: see `docs/optional-verification.md` 2, 6.2 to 6.7.

- Add someone is an email and Add (`Vault.addContact`): a first-seen pin (`fingerprint: ""`, `pin_of_served`) of the served keys, when their keys statement holds.
- Check it's Maya (They match, `Vault.theyMatch`) makes it verified.
- Continue (`Vault.continueWith`) takes keys that changed with no signed chain as first-seen, keeps the old signing key as previous and queues a re-seal (`ResealTo`, `resealShares`).
- Every pin rule is the core's: `pin_trust`, `key_commitment`, `compare_pin`, `pin_first_seen_of_legacy`, `guard_agrees`, `guard_entry_next`.
- `Vault+Trust.swift` (`stand`, the web's lib/contacts.ts) only orders reads and writes.
- A legacy pin becomes first-seen on the person's next act over the same classical keys under a holding statement.
- Pins are version 3: `mlDsaPublicKeyHash` + `kemPublicKeyHash` hex, v3 fingerprint, written by `ContactPin.of`.
- `verified` is the core's `pin_verified`.
- `ContactPin.compare` is the core's `compare_pin`. Outcomes:
    - same;
    - recheck: a legacy pin over the same classical keys, upgraded to first-seen on the next act;
    - succession: followed on the person's act from a verified or first-seen pin, which stays first-seen;
    - changed.
- Pins carry `keyVersion`, `previousSigningKeys` (oldest first), `keysReplacedAt` and, once a succession was followed, `resealShares: true`.
    - Agreed with web and Android. `resealShares` is written only when set, never cleared from here.
- Previous keys come only from the verified chain: from the first link whose old X25519, Ed25519 and ML-DSA digest are the pin's, as the core starts it (`ContactPin.chainStart`).
- A pin follows a succession only when the person taps "Check again" (`Vault.checkAgain`). The chain is always fetched whole (`from=1`).
- Followed grantees are queued (`ResealTo`) for the next `Vault.upgradeShares`, which also finishes a re-seal a succession left unfinished (`ResealPending`).
- The People notice is dismissed per device (`ReplacedKeysSeen`, in `state/`).
- `Contacts.swift` keeps the pins in the account settings document with compare-and-set and seals shares to a pinned contact.

### Contact guard

- `ContactGuard.swift` (`docs/optional-verification.md` 2.8): per account (`AccountOwner`) in `local/guard/<slot>.json`. The slot is the core's `contact_guard_slot`, found without a key.
- Sealed by the core (`contact_guard_seal`/`_open`): device-store envelope, HKDF of the settings key with the web's `hushos/contact-guard/v1`, associated data binding account, slot and kind.
- Uses the settings key the rollback marks use (`MarksKey`, its envelope kept beside the record).
- Out of backups. Deleted with the account on every wipe, under `local/guard.lock`.
- Every write is one read-change-write under that `flock`. A commit lands only over the revision it read (`GuardError.raced`).
- Acts that change trust write a pending record before the save, then the entry. The pending record holds the target commitment, the revision and the settings sequence each save attempt lands over.
- The next read settles a pending act (`guardFor`). A pending act settled silently that carries `resealShares` queues the re-seal (`ResealTo`) there too.
- A record that doesn't read or open (no account key, another settings key, damaged or swapped) is `GuardError.unreadable` ("HushOS couldn’t check this right now."), never first use.
- A write that fails is `unsaved`.
- Only a confirmed missing file (`GuardFile.missing`) reads as no guard. Any other read error, a folder that can't be searched included, is `unreadable`.
- Acts and judging reads take the vault's guard turn (`withGuardTurn`), one at a time per process.
- Verdicts read effective pins (`effectivePins`). A pin that disagrees with the guard vouches for nothing, and the guard's keys stand in, never verified.

### Opening received shares

- A received share opens under a pin, verified or first-seen, whose keys are the served ones and agree with this phone's contact guard (`Vault.trustGranter`).
- From someone never pinned, it pins the keys the share came with (first-seen, `firstSeen: "shared-with-me"`) and opens.
- These wait for the row's Open (`Vault.openWaiting`):
    - someone removed (`removedContacts`);
    - someone whose pin is gone while the guard holds them;
    - an unfollowed signed succession.
- A change with no chain is "<name>’s account changed. Review to open this."
- Shares open in suite 4 only, with the granter's current keys (`ShareOpener`). One signed with a key they replaced says "Ask <name> to share it again".

### Post-quantum identities

See `docs/identity-pq-design.md`.

- `Vault.identityKeys` opens the identity once (a `Task`, so concurrent callers never upgrade twice).
- It upgrades a version 1 identity before anything signs: `identity_upgrade`, `POST /api/auth/identity/upgrade`, then open what the server stored.
    - A 409 means another device won: re-read and open that.
- `DriveStore.loadRoot` calls `prepareIdentity()` first; every signed write goes through `identityKeys` anyway.
- Own words are `identity_fingerprint_of_keys` over the four public keys the core re-derived when it opened the identity.
- A contact's words come from a lookup only when `identity_verify_keys` holds (`Contact.upgraded`). Otherwise Check it's Maya says they need to sign in once more, and They match is off.
- Generations:
    - `forgetIdentity` raises `identityGeneration`; `forgetSigners` raises `signersGeneration`.
    - `identityKeys`, `allIdentities` and `signers` keep what they read only if the generation they began under is still current; otherwise they read again.
    - Any cache built from the identity across an `await` needs the same check.
- Report operators and rotation grantees use the served-identity shape (`ServedIdentity`, `ReportOperator.keys`). The core decides which operator KEM key counts.

### Signing writes

- Every write that sets a metadata or content-key envelope is signed (`Vault.signMetadata`/`signVersion`, Vault+Identity).
    - Root, folders, upload begin, the replacement's metadata, rename (over `metadataVersion + 1`), copy, rotation.
- The signing identity is re-checked against the served one at most every five minutes, so a succession on another device does not leave writes failing.
- Rotation, copy, rename and a replacement's new metadata check each record first and sign by its verdict:
    - `Signing.after` over the core's `*_reseal_sign` in place; `Signing.copy` over `*_copy_sign` for copies;
    - ordinary only when it verified;
    - saved when it verified as saved from a link;
    - re-sealed otherwise.
- Without the trust set a rotation waits (`RotationError.untrusted`, run again once it loads) and the others refuse.

### Reading and marks

- `TrustedSigners` (Integrity.swift) holds, per account:
    - the current signing key, which alone verifies;
    - the keys it replaced, which yield only `retiredKey`;
    - for the account's own identities and every verified pin's.
- Writers are named from pins only (`Writer`: "you", the pin's name, "someone you haven't checked"). The server sends `{ id }`.
- `DriveStore.trust` is a `TrustState`: pending (no marks), loaded, or failed. Failed marks every record "Couldn't check" with Try again, never no mark.
- `VerdictCache` keys verdicts on everything they depend on, both envelopes included.
- Earlier versions carry their own marks in the versions list and the viewer.

### Scoped ids

- Every id the app chooses comes from `Vault.mint(kind, in: workspace)` over the core's `new_id`.
    - Root, folders, uploads in the app, the queue, Save to HushOS and Files, copies, links, reports.
- The workspace is the one the item lands in: the parent's, which is the granter's inside a share. A report's is the reported item's.
- Each create sends the seed beside the id: `idSeed`, `versionIdSeed`, `objectIdSeed`, `linkIdSeed`, `reportIdSeed`.
- The server refuses any other id with 400 "This id was not made for this workspace".
- A copy within a drive mints a node and a version only: the object stays the source's.
- Nothing persists an id before its create succeeds. The queue keeps `SealedUpload`, made after the begin, so a resumed transfer only completes and never re-sends a create.

### Saved copies

- Saved copies are signed by where they came from.
    - "Save a copy" from a link (its files and the folders it makes) uses `Signing.savedFromLink`, the saved statements.
    - A copy out of someone's share or across drives uses `Signing.copy` with the original's verdict. A checked contact's verified file stays clean; anything else stays re-sealed.
- `SavedFromLink` shows no mark on rows or in the versions list.
- Info and the viewer show `SavedCopy.line` in muted ink, never in a warning's colour, and only when nothing about the item carries a mark.
    - "Saved from a link by you. HushOS can’t confirm who made the original."
    - "by <pin name>" for a checked contact.

## Sharing, links, reports and rotation

| File                     | Role                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------ |
| `HushOSKit/Shares.swift` | Mounts what others shared (identity opened once, `shareOpen`, the previous envelope during a rotation) |
| `Links.swift`            | The owner's link routes, `PublicAPI` (no cookie) and `LinkVault` for a visitor                         |
| `Reports.swift`          | Seals the node key to every operator                                                                   |
| `Contacts.swift`         | Pins in the settings document; seals shares to a pinned contact                                        |
| `Account.swift`          | Rotates the master key, reads the recovery key                                                         |

- Shares are suite 4 (4565 bytes). `ShareOpener` opens with `HybridPublicKey`: pinned Ed25519, served ML-DSA only if its digest is the pin's.
- Shares are sealed only hybrid, to a verified or first-seen pin that agrees with the guard, with the KEM key whose digest the pin holds (`Vault.trustGrantee`).
    - Used by the share sheet, rotation and the upgrade pass.
    - Rotation leaves out anyone who fails that and says who (`RotationOutcome.skipped`).
- The upgrade pass re-seals any ledger share not in suite 4 once the grantee has a version 3 pin. It runs again right after a words check.
- Link visitor routes send the token in `x-link-token`, never the path (`PublicAPI`).
- A link made against a stale epoch reloads the item and retries once.
- Writes land in the parent folder's workspace (a shared folder is the granter's).
- The server copies within one workspace only. So the paste bar refuses a cross-drive paste, and pasting into another drive re-uploads (`copyAcross`).

### Rotation

- Revoking a share rotates the subtree (`Vault+Rotation.swift`, the web's protocol).
- Work in depth order, parents first.
- Never a node beside its parent in one batch (`deferChildren`).
    - Why: the server judges each node on its own. Another device can win the parent while this one wins the child, sealed under a key nobody kept.
- A batch goes in parts of at most 4 MiB, each node whole (`rotationParts`). Each part is settled as it lands, so a later part that stops undoes only its own nodes.
    - Test: `RotationPartsTests`.
- A parent another device re-keyed is read from the server (`adoptServedKey`) before its children are wrapped under it.
    - Test: `RotationTests.aFolderAnotherDeviceReKeysFirstNeverLeavesWhatItHoldsUnderAKeyNobodyKept`.
- Previous keys are kept for children wrapped under them.
- Shares are re-sealed only to keys the pins vouch for.
- Password links without a kept password key are reported unsealable.

## Transfers

- Uploads and downloads run a Live Activity (`Widgets/`, Dynamic Island and Lock Screen).
- Transfers hold a UIKit background task, so a lock or Home press does not suspend them at once.
- Uploads into a family folder: see Families, below.

### Save to HushOS

- Files: `HushOSKit/SaveTargets.swift`, `Share/SaveModel.swift`/`SaveView.swift` (Android's SaveTargets).
- The picker lists Files' own folders, then each family this account is an accepted member of, under its name, with the folders this phone may write in.
- Every family call goes through the session's own `FamilySync.shared(for:)` (none once the session ended). Only while the sheet's session is still the keychain's (`SaveTargets.stands`, `SessionEnded`).
- Before sealing into a family folder, the family is checked again (`SaveTargets.open`).
- The file is then sealed as the queue's family upload (`SaveTargets.sealFamily` over `FamilyUploads.seal`).
- Its plaintext is kept beside the parts for a re-seal after a key change (`StagedSave.seal(keep:)`):
    - the sheet's copy is hard-linked in, never moved, so a refused family seal that removes the folder leaves the sheet the file to save elsewhere;
    - it sits under the queue folder's protection (`Unbacked.protectFile`), so a re-seal while locked can read it.
- The note carries the family (`ShareHandoff.family`). The app adopts it as a family record (`record.family`) that `FamilyUploads` finishes or seals again.
- Every share task and landed-part file names the server's upload (`ShareHandoff.taskDescription`, `etag-<upload>-<n>`).
    - The extension, the app's `finished` and `takeLanded`/`landedParts` take only the record's own upload's.
    - So a late part of an upload since sealed again never lands on the new one.
- The sheet finishes a family upload only when it lands (`SaveTargets.finishFamily`: the family opened, then the completion). Anything else changes nothing, and the released note goes to the app whole.
- The last folder keeps its family (`Places.Folder`, both or neither) and is checked again before it is offered.
- The quick actions keep to your own drive.
- Tests: `SaveTargetsTests`.

### Staging and sweeps

- Save to HushOS's plaintext is swept by owner, not by age alone.
- A staging folder, and a `transfers/<id>` folder before the copy moves in to be sealed (`StagedSave`), names the extension process that made it (`ShareHandoff.claim`, a marker, never a lock).
- It stays while that process may run: only ESRCH counts as gone. A sheet suspended mid-seal, whose folder holds the only copy, is never swept for being quiet.
- A queue folder with no note and no transfer goes when its claimant is gone, or after a day (`sweepOrphans`, run by the app's queue).
- Adopting a note writes the queue's records first, and only then removes the note and the part files it read (`ShareHandoff.adopt`).

## Files app (File Provider)

- `FileProviderExtension` is replicated (`NSFileProviderReplicatedExtension`).
    - Writes: folders, renames, moves, trash, uploads with thumbnails.
    - Thumbnails, and the change feed as sync anchor.
- `FileProviderUIController` shows the OPAQUE sign-in inside Files when the session is gone.
- `documentStorageURL` asserts in a replicated extension. Decrypt into the temp directory and let Files move the file.
- Items advertise write capabilities even for read-only paths. The simulator's volume refuses the read-only flags.

### The domain and its owner

- One domain identifier (`com.hushos.app.drive`) serves every account, so the domain has an owner.
- The owner is the account (user id and origin, `AccountOwner`) it was added for. It is recorded in `local/files-domain-owner.json` (`FilesDomainOwner`) when `FilesDomain.register(for:)` adds it.
- At every sign-in and signed-in launch (and after a sign-in from the Files sheet):
    - the same owner keeps the domain and what Files cached (removing it dropped Files' cache);
    - another owner, or none on record, gets it removed with `.removeAll` (pending folders and edits included: they are the other account's) and a fresh one added;
    - the new owner is recorded only after the old domain is gone.
- Never `reimportItems` for another account.
    - Files scans what it cached and calls `createItem` with `mayAlreadyExist`, and the extension created the last account's folders in the new account's drive.
    - Seen on the simulator after an expired session, and after a reinstall: uninstalling the app keeps the domain but drops the app group.
- The extension goes through `FilesGate` on every call (items, contents, writes, thumbnails, each enumerator pass). The session must match the recorded owner, else `NSFileProviderError(.notAuthenticated)`, and nothing reaches the server.
- Sign-out removes the domain with `.removeAll` and then the record.
- A new domain on iOS starts disabled until the person turns it on in Files (Browse, the ... menu, Edit, the HushOS switch).

### Signed out in Files

- A replicated location lists from what Files cached, so an ended session only showed a dead-end "You need to authenticate" alert.
- The extension's first `.notAuthenticated` signals the working set (`SignInPrompt`). Its failure puts the location in its signed-out state, where Files offers the sign-in sheet.
- After a sign-in, `FilesDomain.register` calls `signalErrorResolved`. Otherwise Files leaves the location "Syncing Paused" and read only.
- Files still keeps its "Authentication Required" page in the open folder until the folder is opened again.
    - Authenticate there closes at once when the session is good (`prepare(forError:)` checks first, so nobody signs in twice).
    - Sometimes that redraws the listing, sometimes not.
- Files may hand the UI controller a second request, so its once-only guard resets on every `prepare`.

### Errors and changes

- Never map an unknown error to `noSuchItem`: Files deletes the item locally.
- Only the server's "This item no longer exists." and its `trashed` code are `noSuchItem`.
    - `DriveAPIError.trashed`: the item or a folder above it is in the trash, which this location doesn't show.
    - Reporting `trashed` as a read error kept folders trashed on another device in Files indefinitely, retrying every few seconds, and a new folder of the same name showed up as "… 2".
- In `enumerateChanges`, report deletions before updates. A folder replaced by a new one of the same name arrives in one batch.
- The change feed marks a node deleted only on a verdict (gone, trashed, unopenable). A network or server failure fails the batch instead.

## Families

Plan: `docs/groups-mobile-plan.md` (groups 1d). The web's counterparts are named in each item.

### Routes and records

- `GroupsAPI.swift` reads routes 2, 3, 5, 6 and 25 with the session cookie (`DriveAPI.apiRequest`/`send`).
- Family ids go into paths and file names only as lowercase UUIDs (`FamilyRecords.valid`).
- A refusal is `GroupsAPIError` (status, code, words). Status 0 is no answer.
- Only 404 `not-member` wipes a family.

### Family sync

`FamilySync` is an actor, one per session per process (`FamilySync.shared(for: vault)`), one family at a time. It is the web's `sync.ts` + `pins.ts` over the core's `AreaLedger` (`Vault.areaLedger`).

1. `prepareLedger` opens the account and the personal workspace.
2. The settings are read first.
    - Every `loadSettings` hands the served settings key and document envelopes to the ledger (`useForFamilies` → `use_settings_envelope`).
    - The ledger opens them under the account root and takes the family and contact pins from what it opened. No app-built pin reaches the core.
3. `accept_served` with the device record.
    - `FetchFromVersionOne`: called again with the same record.
    - `Overtaken`: read again up to three times, then `served_race_message`.
    - `RecordUnreadable`: deleted and accepted again against the settings pin.
4. The record is written before route 25's folders are opened in the ledger.
    - `FamilyRecords`, `local/groups/<user>_<group>.json`, made with `Unbacked.folder`.
    - One compare under the folder's `flock`, never over a later roster version.
5. Route 25's folders are opened in the ledger (`open_family_area`).
    - This account's self-grant when current, else the area grant; the holder identity is opened by the ledger.
    - A self-grant it wraps is stored with route 23 (`GroupsAPI.putSelfGrant`); refusals other than not-member are ignored.
    - A grant or granter key that doesn't decode is passed as none, so a self-grant still opens.
    - No answer while reading the identity history fails the sync without forgetting anything.
6. Each top folder is listed through the ledger (`Vault.openListed`).
7. The settings pin is settled.
    - `merge_pin` with the acceptance's pin and the ledger's `pinArea`s only.
    - Compare and set in `saveGroupPin`, accepting again when the stored pin is ahead, conflicts or another device saved. Four tries.

### Self-grants

- Self-grants (route 23) are opened and stored through the ledger (Core 6).
- A folder whose granter's identity is gone opens once this phone (or the web) stored a self-grant at the current key.
- No key of a family folder crosses the FFI. `area_grant_open` and `open_area` are no longer exported.

### Family folders

- A folder is a family's only when route 25 lists it under the family and its id is derived under it (`checkId`).
- It is then a family folder for the session, whatever later syncs say (`Vault.familyWorkspaces`, `FamilySync.familyAreas`, `DriveStore.familyAreaGroups`).
- The personal workspace never is.
- Nodes there open only through `open_listed_node`.
- After a refusal or a fork, the core holds the family's keys back until the next acceptance.
    - `open_listed_node` refuses with "Check the family’s member list first."
    - `FamilyWords` says that as "Open the family again, then try again."
- Not-member, fork, a refusal, unchecked and waiting forget what was opened (`forgetWorkspaces`: keys, rows, ids in `files-parents.json`).
- `DriveStore.clearFamily` drops lists, names, thumbnails, marks and `tmp/opened/<id>`.
- No answer at all (`FamilySync.unanswered`, `AuthError.unreachable` included) leaves things as they were.
- A family folder row the server serves differently from what this process opened is opened through the ledger again (`Vault.open`), so a walk's re-key reaches the ledger's lineage.

### Writes in family folders

- Writes go through the ledger. `Vault.familyTarget` (`require_writable`) gates:
    - `createFolder`, `rename`, `move` within the folder, `copy` within the folder, `trash`;
    - `restore` back in place (a trash's Undo);
    - upload begin and completion.
- A folder route 25 named that the ledger doesn't hold is `FamilyWriteError.notOpen`, never the personal key path.
- Keys:
    - new keys from `new_node_key` (forgotten with `forget_node_key` when the server refuses);
    - keys a write seals under from `writable_node_key` at the epoch opened;
    - re-wraps from `rewrap_node`.
- Records signed again (a rename, a copy, a replacement's name, a copy out of the folder) take their form from `FamilySync.prior` (the core's `copy_form` over the committed chain), never the personal trust set.
- FamilySync registers itself as the vault's weak `familyJudge` on every sync.
- Share, links, report, keep, versions and `rotate` still call `refuseFamilyWrite` (`FamilyWriteError.unavailable`, "This isn’t available in family folders.").
- Any other write that meets a key change says "HushOS is finishing a key change for this folder. Try again in a moment." (`FamilyWords.core`).
- A move between one's own files and a family folder (either way: `Vault.relocate`, `movesAcross`) is the web's `lib/move-across.ts`.
    - Each file is downloaded at the version read and uploaded under the destination's keys with `moveOf` on begin.
    - The server deletes the source in the transaction that completes the upload. Nothing goes to the Trash; a source that changed fails `stale` and stays (`Vault.movedMeanwhile`).
    - A folder is made at the destination, its files moved one by one, and the source folder goes to the Trash once it holds only folders. Never purged.
- Into or out of someone's share nothing moves across drives (`Vault.mayMove`, `shareMoveRefused`): the server refuses `moveOf` there, so Copy is the route. Within one share a move is a plain move.
- The server's in-workspace move and copy are used only within one workspace.
- The move picker reaches writable family folders from Files' top level, and Files from a family folder. It offers a share only to items already in it, and never leaves a share for Files.

### Family uploads

- Uploads into a family folder go through the background queue with `Record.family` (group and workspace).
- Every decision is HushOSKit's `FamilyUploads` (`seal`, `finish`, `discard` over a `FamilyUpload` record, returning a `FamilyUploadStep`).
- BackgroundTransfers only applies the step (`apply`) and runs URLSession. Keep new recovery logic in the kit, where `FamilyQueueTests` can reach it.
- `seal` runs off the pump: `FamilySync.ensureOpen`, the folder listed in its own workspace, then `Vault.sealUpload(waiting:)`.
- Two seal at a time.

#### Key-change wait

- One wait (`KeyChangeWait`) covers:
    - the ledger's KEY_CHANGE_PENDING and "older workspace key";
    - the server's 409 `rotating` (`DriveAPIError.rotating`);
    - a 409 `stale` after a wait (`DriveAPIError.stale`).
- After each pause (5 s doubling to a minute) the folder is listed again and the upload sealed afresh.
- The family is checked again between pauses (`familyJudge.recheck`, sharing a check already running).
- The row says "Finishing a key change…" (`Record.keyChangeSince`, kept across launches).
- It gives up after 30 minutes with the web's words.

#### Completion

- The plaintext stays in the queue until the upload lands.
- A completion refused by a key change reached mid-flight aborts, deletes the `part-N` files and seals afresh from `content` (`FamilyUploads.finish`, which also opens the family after a background launch). Such refusals:
    - 409 `conflict` with `data.conflicted` (`DriveAPIError.conflicted`);
    - a late `rotating`/`stale`;
    - KEY_CHANGE_PENDING.
- `UploadLanded` lands, never fails. Cases:
    - a completed upload whose row doesn't open in this process;
    - a new version whose name record was refused after it went live (`published`): the queue keeps the record, and `Vault.repairLanded` signs the name again on later passes.
- Once `completeUpload` returns, no error after it may fail, abort or re-seal the upload.
- A replacement's name is re-signed only while `SealedUpload.landing` (its version id and the metadata version it replaced) still holds. A repeated completion is answered with the node as it is now, which may carry another member's rename or newer version.
- Callers of the foreground `Vault.upload` treat `UploadLanded` as done.
- An API 403 with a `code` is `DriveAPIError.forbidden` (a group manager's pause): final, never retried. Only the store's 403 (an expired part address) is retried.
- Part tasks are described `<record>|<piece>|<server upload id>`. A callback naming another upload than the record's is dropped.
- A sync that wipes a family calls `BackgroundTransfers.endFamily`, which fails its queued uploads and removes their plaintext.

### Family screens

- `App/Families.swift`.
- Account's Families section (route 2): hidden on a server without families or with none. A pass within a minute is reused; pull to refresh always checks.
- The family page shows:
    - the hard warning with Technical details;
    - Couldn't check with Try again;
    - not in it any more;
    - the join screen while waiting or unchecked;
    - previous keys;
    - folders the member list names that aren't its own;
    - Family folders;
    - Members, with roles from the accepted list and names from route 3;
    - Technical details.
- Each folder is a `FolderView`, read only (no Add, Select, paste bar) unless this device may write there.
- The screens offer writes only while `DriveStore.familyWritable` (the area is openable and `write == .writable`).
- Family items read as `.editor` while writable, `.viewer` otherwise, and never as own: no Share, Tags, Versions, Report, Keep or Save a copy; Select's Share and Tags are off.
- A family folder that can't be opened (cleared by a fork or refusal, or refused on listing) shows `FolderProblem.family` with FamilyWords' words and Try again (the family checked again). Never "Nothing here yet".
- A family folder on screen checks its family again when the last check is over three minutes old, and on returning to the foreground at most once a minute.
- Sign-out calls `FamilySync.forget()`, which drops the session's sync and wipes its ledger.

### Marks and Info in families

- `FamilyIntegrity.swift`: twins of trust.ts `recordIssues`/`sortIssues` and integrity-lines.ts.
- `FamilySync.verdicts(of:groupId:)` runs `record_verdict` on the name and current version, with writers built from route 6 and the current trust set at every call.
- Then the web's issues, lines and label:
    - `Keys don’t match` in the danger colour;
    - `Couldn’t check` with Try again;
    - `Changed by`/`Written by`, `Keys replaced by`;
    - `Checked: Verified by <family>` only when nothing is marked.
- Members nobody checked are named as route 3 names them, with the address (D10).
- Errors are worded by `FamilyWords`, never a `CoreError`'s description.
- The store judges again after every accepted sync and every `refreshSigners`.

### Joining

See `docs/optional-verification.md` 3.2, 3.3, 6.8.

- `FamilyJoin.swift` is the web's `join.ts`. Once route 2 says active:
    1. `join_first_use` (the family guard and any settings pin as marks);
    2. the version 4 joins record is kept (`FamilyRecords.put(.joins, …)`);
    3. `accept_joining` with it;
    4. then the guard, the device record, the folders and the settings pin;
    5. the joins record goes.
- A relaunch finishes from the joins record.
- A join committed in the core but not kept here is let go of (`forgetInCore`) before it runs again.
- `/join` is parsed (`AppLinks`) and listed in the web's apple-app-site-association. Every release handles it; a build that didn't would dead-end the invitation, so none may ship.
- Screens: `App/Join.swift`.
    - `InvitationSheet`: the web's words, Join and Not now.
    - `JoinSections`: "Waiting for Maya", which the family page shows for `waiting` and `unchecked`.
- While a join screen is open, `DriveStore.familyJoining` keeps background checks off the family. `DriveStore.joined` adopts the joined state.
- The hidden-words join (`group_join_preview`, `join_check`) is no longer called. `.holds` files from it are deleted at the end of a join and on every wipe.

### Family guard

See `docs/optional-verification.md` 2.8 "per family".

- `FamilyGuard.swift`: per account in `local/guard/<slot>.families.json`, beside the contact guard.
    - Same slot, same lock; sealed by `contact_guard_seal` with kind `families` under the settings key, its envelope beside it.
- Merged with the core's `merge_pin` and never lowered. A conflicting history is refused (`FamilyGuardConflict`).
- Every `accept_served`, `join_first_use`, `accept_joining` and `forget_group` gets it read afresh (`Vault.heldFamilyGuard`). A store that doesn't read is `.unreadable`, never absent.
- The guard an acceptance hands back is stored before the device record.
- `forgetInCore` is two-phase: store what `forget_group` hands back, then ask again. A guard that can't be stored stops the wipe with the storage words.
- A `not-member` wipe never touches it. Sign-out deletes it with the contact guard (`AccountStore`).
- The write barrier (the web worker's `requireGuardKept`):
    - every acceptance raises `Vault.familyGuardOwed` for its family before the core commits;
    - it is released only once the guard it hands back is stored (or it had none);
    - while raised, `familyTarget`, `writableKey` and a family upload's completion refuse with the storage words; reading goes on;
    - a failed store leaves it raised until a later sync stores the guard.

### Family checks

See `docs/optional-verification.md` 3.4, 7.2.

- `Settings.markFamilyChecks` writes `familyChecksSince` and the `before` records in the same compare-and-set save as any group pin (`Vault.saveGroupPin`).
- `FamilySync.familyChecked` (read after every accepted sync) turns what the member list vouches for into `seen` (no "Verified by") for a family taken on first use (`asFirstUse`).
- `FamilyCheck.swift`:
    - member labels (`memberStandings`);
    - Check it's Sam: `checkCode` syncs first, then `pair_code`;
    - `checkMatch` runs `pair_match` and saves the record and, when allowed, a verified pin through `commitTrust`.
- `groupWriters` passes first-seen pins as the family's word, so a planted entry over one is a key conflict.

### Leaving

Counterparts: Android's #252, the web's `family-leave.ts`.

- Leave family (route 20, `GroupsAPI.leave`) sits under Leaving on the family page.
- It is held back with `FamilyLeave.blocker`'s reason (the web's `leaveBlocker`).
- The dialog's state is the store's (`LeaveDialog`): a second press while one is in flight sends nothing.
- `ends-lapsed` names the plans (`FamilyLapsedPlan`), and the next press confirms them by id.
- A leave that lands (`FamilySync.leave`) runs the not-member wipe, which keeps the settings pin and the family guard.
- Account then reads its plan and storage again (`DriveStore.accountGeneration`).

### Walks (members' due work)

Counterparts: the web's `walks.ts` and runRotation's family case.

- A walk runs only where this device has its own reason (`FamilyArea.ownReasonToWalk`: a member-list key change it saw re-key the top folder).
- It runs through `rotate_node`, never the start route (`FamilyWalks.swift`).
- No batch holds a node beside its parent (`deferChildren`).
- A batch holds the folder's key lock (`FamilyLocks.keys`) from its first fresh key until each is committed or dropped. `Vault.newKey`/`rewrap` take it, so no write wraps under a pending key.
- A parent it needs that this vault hasn't opened is listed, or found through the folder's change feed from its start with no page cap (one under a trashed folder).
- Only ok/already commit; the rest drop.
- `FamilySync.releases` publishes every family let go of from any path (sync, reconcile, leave, join, background pass). `DriveStore.attachFamilies` shows them.
- `FamilySync.familyWork` says whether the background check is wanted. A join wants it with nothing due.
- The background check is a BGProcessingTask (`App/FamilyWalkTasks.swift`, `com.hushos.app.families.walks`) running `FamilySync.backgroundPass`:
    - bound to the session's tag;
    - `current` asked before every step;
    - `checkStop` (expiry) only between batches;
    - no answer, 408, 429 and 5xx are `FamilySync.transient` (retry);
    - only a confirmed not-member wipes.

### Managers: inviting and admitting

Counterparts: Android's #265, the web's outbox.ts and stageLocked. Needs #265's core change (a first-seen pin admits).

- On the family page for route 2's `members` holders (`App/FamilyManaging.swift`; every decision is in `FamilyManage.swift`):
    - Invite someone (route 11);
    - Waiting to join, with Not now (26) and Let them in;
    - Invitations, with Cancel invitation (13).
- Let them in:
    1. Pins the newcomer first-seen (`addContact`, `firstSeen: "family"`). A changed account goes to the changed-account steps.
    2. In the family's turn, sends any kept admission of theirs before signing anything new. A second press while one is unanswered sends that one again.
    3. Only then stages (`stageAdmit`): synced first, route 3's head checked against the chain, route 16's keys read again, the settings read afresh.
    4. Keeps the core's call (`admit_body`) in the outbox before it is sent (`FamilyRecords.outbox*`, beside the device records, one file per call).

#### Sending kept calls

- `sendKept` reads the settings afresh before every send. A failed read sends nothing; the call stays kept.
- It lets the core judge the kept call (`outbox_open`: held, landed, superseded, send).
- It sends its body byte for byte (`GroupsAPI.sendCall`, HushOS-Client `ios/` on every send, so the server never buys a place).
- On no answer it resends the same bytes.
- On `grants-due` it posts owed grants, then the same bytes.
- On `stale` it signs again over the winner.
- It takes `not-member` as the removal (`removedInTurn`, published). The wipe deletes the family's kept calls.
- Route 17's refusals say their own words (`ManageWords.call`).

#### The staging gate

One staging gate for every roster call (`stageCall`, Android #281's).

- Every kept call of the family is sent first. What each came to is kept for the screens (`keptEnds`).
- Nothing new is staged while any is still unresolved (`Staged.waiting`, said as "An earlier change to {family} hasn’t reached the server yet. Try again once it has.").
- An admission held for other keys, whose person no longer waits on route 16, is retired first (`retireOrphan`, as Android #281's):
    - in the member list just synced: landed and quiet;
    - neither: `stale`, said "An earlier admission of {first} wasn’t sent; let them in again.";
    - still waiting, or a read that didn't answer: kept;
    - not-member and a lost session are thrown.
- A store or list that can't be read throws, never reads as empty.
- Inside the family's turn only `run`/`removedInTurn` are used (`exclusive` isn't reentrant).

#### Saying what kept calls came to

- What kept calls the resume, the gate or an earlier handover let go of came to (a refusal, an overtaken admission or role change) is kept on disk before the entry is deleted.
    - `<user>_<group>.unsaid`, `FamilyRecords.keepUnsaid`, once per outbox id, wiped with the family.
- It stays until a screen says it.
    - `sayKeptEnds` reads `keptEnds()` and says them only while its session is current.
    - Then `dropKeptEnds` lets go of those alone.
- Each action drains them on every path, answered or thrown, and `landResumed` after every resume.
- After every await in these flows, the session is checked again and handed to each refresh.
- Then said until read (`NoticeQueue`).
- List loads are numbered per family (`ManagedLoads`).
- A 401 anywhere is the lost session.
- Tests: `FamilyManageTests`, `ManageNoticesTests` (stub: `FamilyManageStub.swift`).

### Managers: roles

Counterparts: Android's #276. Files: `HushOSKit/FamilyRoles.swift`, `App/FamilyManaging.swift`.

- A member's menu offers:
    - Let them manage the family / Stop them managing the family (`changeRole`, route 18, `roles_body`);
    - for the organizer, Make them the organizer (`handOver`: billing `To` them, then `StepDown`, `handover_body`).
- Each is confirmed in Android's RoleConfirm words (`FamilyRoleDialogs`).
- A promotion over someone not verified here asks Check it's {first} first, which opens their check.

#### Kept role changes

- `callFor` first sends their kept role change of the same operation (`RoleOperation`: grant, take, billing to them, step down).
    - The operation is noted beside the entry as `<…>.op` before it is written, since all four share their `member` route.
- Another operation, or an entry with no note, is sent too but never said as this one's. Its end is kept to be said, and this one goes on.
    - Landed or overtaken: a request the member list then already satisfies is done.
    - Settled: the loop goes on to the next entry and never sends that deleted entry again.
- While it is unresolved, this one answers `waiting`.
    - Except the handover's billing step (`waitsKept`): it stays pending with its record kept unstaged, so the next open goes on with it once the earlier change lands, as on Android.
- Then it stages through the gate, re-signing over another manager's win.
- Each attempt judges the freshly synced member list:
    - a promotion needs them verified now (`memberStandings`, settings and guard read together; `CheckFirstNeeded`);
    - billing is given only while this account holds it and no other handover is half done (`handoverToFinish`);
    - the step down only while the person it was handed to holds billing (else `organizerFirst`, or who holds it now).

#### The handover record

- The handover is kept before its first call (`FamilyRecords.markHandover`): `<user>_<group>.handover` in the outbox folder, wiped with the family.
- It is left as it is when the same handover is confirmed again, so `staged` survives a second press.
- It is `staged` once billing's call is kept.
- One this attempt made and never staged goes when a read before staging throws, so the next open never hands over a handover the screen said failed.
    - Unless billing's call to them is already kept (`billingKept`: an entry noted billing-to, about them), which is staged in fact.
- Whatever the marker says, billing's call ending marks the handover staged before its entry goes.
- Its step down refused for good retires the handover (`handoverHears`). Both are still organizers, and Finish handing over to {first} is the person's to press.
- The next open finishes it (`resumeOutbox(handed:)` → `finishHandover`). A failed sync is never read as done.
- `handed` is told only after the family's turn is let go of, since its listener syncs the family and `exclusive` is not reentrant.
- A resumed handover that needs a check first opens the same Check it's {first} first as a fresh Make them the organizer (`handed`).
- Both organizers: the page says "{first} is an organizer now, and so are you still." with Finish handing over to {first}.

#### Sessions and answers

- A settings read that doesn't answer is `pending` only for the caller's own kept call. `sendKept(only:)` reads whose it is from the entry; anyone else's, or one that doesn't open, is `other`.
- Answers land only in the session they began in (`familyAnswer`). A pending or refused end reads the family again.
- The change in progress and the open asks are per session. `resetFamilies` clears `roleAsk`/`checkFirstAsk` and resets `RoleChanges`, whose generation keeps the old session's late `end` from freeing the new one's.
- Tests: `FamilyRolesTests` (stub route 18 and `creatorSetsRoles` in `FamilyManageStub.swift`).

### Families in the Files app

Files: `FamilyFiles.swift`, `Files/FamilyFileProvider.swift`. The PR (#282) lists every wait followed by a destructive step and what it rechecks.

#### Locations and records

- One replicated domain per family, `com.hushos.app.family.<groupId>` (`FamilyFileIds`), named the family's name, read only.
- Its top level is the family's openable folders (route 25 proved, the ledger opened).
- Items are named `<workspace>:<node>`, never by node alone.
- Each location has a record in `local/files-family-domains.json` (`FamilyDomainRecords`) and stands only while the record does. A record holds:
    - owner, name, the family's folders;
    - the generation it was written at;
    - a revision new on every acceptance, so two acceptances of one account and generation still differ.
- The file also holds each family's revocation generation. All of it is written under `local/files-family-domains.lock`.
- An acceptance of a renamed family adds the existing domain again with the new name (`add` updates it).

#### Let-gos

- A definite let-go is posted by any process (`FamilyReleases(lettingGo:)`, `Revised.letsFilesGo`): a not-member wipe, a fork, a definite refusal, waiting or unchecked. It may be found by the app, the background pass or the extension's own sync.
- Never a let-go: a sync that failed for no answer, a timeout, a 408, 429 or 5xx, or a lost session. These are told apart by `Revised.cause` from `FamilySync.revisedRun`.
- The same classification (`FamilySync.transient` for "no verdict") decides whether a sync or a join cleans up its ledger and copies. So a busy server never uncommits what the location still serves.
- A let-go, in one locked write, moves the family's generation and deletes the record. It then deletes that process's copies of the record's folders.
- It then removes the domain with `.removeAll`, whether or not the write went, unless by then:
    - the record is someone else's: another account, or a session after the let-go's, here or (by the shared keychain) in another process;
    - or the record was written after the let-go.
- Each record keeps the generation it was written at. The queued removal carries the one its let-go moved the family to (a pending let-go's, once written).
    - So a removal that waited behind other calls while the app accepted the family again leaves the fresh location. All of this is checked under the store's lock.
- An acceptance that lands while the system is still removing the location (it found the location there and added nothing) gets it back once the removal finishes.
- The hook is bound to the session its sync was made in.
    - A late let-go of an ended session touches nothing.
    - Neither does one whose session isn't the shared keychain's any more (the same account signed in again in another process). This is asked inside the let-go's locked write, pending ones included.
- A let-go the store refuses (its lock not had, a write that fails, three tries) stays pending in the process, with the session it came from (dropped once that session ended).
    - It is written again before any acceptance or extension admission of the family, which stay refused until it is.
    - Another process sees only the record, so it relies on the domain's removal.

#### Removals and adds

- Every single-family removal goes through `removeVerified`: the let-go's, a sign-in's `reconcile`, `dropForeign`, a lost add's take-back.
    - Each passes the rule that makes it due, decided in the same locked read that notes the record. Nothing can land between the decision and that note.
    - It notes the record, removes, then rereads the record and the shared keychain under the lock.
    - A record written during the removal, while held by whoever the keychain holds now (the next account's included), is re-added through `addVerified`, whoever started the removal.
- Only `removeAll`, the account wipe, removes without it.
    - The account count it moves first refuses what began before it.
    - Its records' write keeps any record written since it began.
- A lost add's take-back goes through `removeVerified` too, so only a record written since it began gets the location back.
- An add whose record was superseded meanwhile by a newer acceptance of the signed-in account (which found the location and added nothing) keeps the location instead.
- `reconcile` is bound to its account. Before every removal and in the records' write, it asks that the shared keychain still holds `owner` and that no account change came since it was asked for.
    - Before each removal it rereads that family's record under the lock, so one accepted while an earlier removal waited stays.
- `dropForeign` asks the same of `current`.
- `FilesDomain.register` asks that its owner is still signed in after every wait.
- `FilesDomain.remove` keeps a drive location whose record another sign-in rewrote meanwhile.

#### Acceptance adds the location

- The app adds the record and then the domain when a sync of its session shows the family accepted (`DriveStore.show` → `FamilyFilesDomains.accepted`).
- It carries the generation the sync read before its check began (`FamilySync.Revised.filesGeneration`).
- It merges its folders with those already recorded at that generation, never taking one out (a stale extra only delays a sweep).
- A newer generation on disk refuses it, so an acceptance a revocation in any process overtook never writes the record back.
    - Asked again under the store's lock right before the domain is added, and once more after.
    - A let-go that landed during the add removes it again (`addVerified`, which the restoring add after a removal uses too).
- The generation an acceptance observes is the family's let-gos plus a store-wide account count.
    - `removeAll` (sign-out, another account in, deletion) moves that count at once, before any queued call.
    - So an acceptance begun before an account change in any process is refused for every family.
- It also carries its keychain session (`signedIn`), refused inside the write and around the add when the shared keychain holds another.
- A join's or member check's acceptance carries none and adds nothing; the next sync does.
- `FilesDomain.register` keeps the same account's family domains and tells each the session is back (`signalErrorResolved`, as the drive's).
    - It removes any without this account's record (`reconcile`).
- Another account in, a drive domain added anew, sign-out and deletion remove them all, each record only once its domain went.

#### Extension admission

- The extension admits a family call by the record first:
    - no record: `.noSuchItem` without asking the server, whoever is signed in, nobody included;
    - another account's record, or a record with nobody signed in: `.notAuthenticated`.
- Then through `FamilyFilesSource`:
    - syncs the family in the extension's own `FamilySync` (one vault per session, `Vault.shared(for:)`), at most once a minute;
    - keeps what it accepted on no answer, or while route 2 merely stops listing it;
    - refuses an item of any other workspace.
- Every public read goes through one helper (`serving`).
    - Its body awaits what it needs. Then, with nothing awaited after, it asks again: the record, a pending let-go, the session (this process's and the shared keychain's), and a copy's gate.
    - A session another process changed ends the session here and deletes its copies.
    - A refusal deletes the copy (and every copy of a family let go of).
- Only no answer (offline, a timeout, a 5xx), on route 2 or in the sync, keeps a view held from before.
- A 401 there asks for the sign-in sheet (`FamilyFilesError.signedOut`).
- The sign-in sheet is asked for per location, once until someone signs in (`SignInAsks`). So a family location that loses its session gets the sheet too.
- A location recorded for another account than the one signed in is refused alone (`FilesGate`'s `refusedForeign`).
    - The process is claimed for the account signed in, and a family location of the other account is removed.
    - Only nobody signed in clears the process (`changed(nil)`).
- `FilesGate` follows the session per copy epoch (`TemporaryCopies.follow`).
    - A new token, the same account's included, ends the old session in the process, so its late let-gos and downloads act for nothing.
    - `follow` takes only the session the keychain holds as it follows (read under the copies' lock). A call that read the old token before another followed the new one moves nothing back; the gate reads again.
    - A gate's cached value keeps the copy epoch it was made in, and is made again once that moved.

#### Listings and downloads

- A download hands Files the row its bytes are of, never one a listing learned meanwhile.
- A download goes to `opened/family/<workspace>/<node>/<version>/content` (`TemporaryCopies.openedFolder`, the layout the day-old sweep reads), under the family's copy gate.
    - It is handed to Files only if the record still stands.
    - However it ends (done, failed, cancelled), a revocation found then deletes every copy of the family's folders in the process, partials included.
- A folder's listing shows a row only while the row held is still in that folder. A file moved out, opened newer from its new folder, shows there alone.
- An item missing from the folder the index last saw it in (moved since, an index from before a cold launch), or whose indexed folder is gone, is `.unavailable`, and Files asks again. Only the feed confirms a deletion.
- A rename is compared with the location's own display name, so one whose add failed is tried again.
- Items declare adding (folders) and writing (files), though nothing is written.
    - Without them Files makes the item read only on disk and then fails to create it (`cannotSetMetadata`, EPERM).
- `createItem` and content, name or place changes are refused. The fields Files changes when a file is opened (last used, tags) are acknowledged.

#### Sweeps and folder records

- The extension sweeps family copies no record names (`sweepUnrecorded`):
    - when it starts;
    - when a domain goes;
    - as it refuses a family whose record is gone.
- So that the folders a sweep keeps stay current, the extension merges the folders it accepts into the record before serving them (a folder made while the app was closed).
    - Under the lock, only while its session stands, no let-go is pending, and the record is still its account's at the family's generation now.
- A folder the record couldn't be made to name (two tries) isn't served (`.unavailable`, retried on every call), while those it names are.

#### Change feed

- Changes come from each folder's own feed (`Vault.familyChanges`), anchored per folder (`FamilyAnchor`).
- The cursors are route 25's, read just before the folders they come with were checked. An anchor (a new folder's too) only ever takes those, so it never sits past a change the folders shown don't hold.
- A key change met while reading is no verdict (`FamilyFilesError.keyChanging`: the ledger's pending, older or newer key, epochs, `rotating`, `stale`).
    - The batch fails with the anchor where it was, the family is checked again, and Files asks again.
- A full listing (`folders`, `anchor`: Files' first look, or after its anchor expired) asks again the same way when a folder this source has shown open doesn't open now.
    - One it never showed open is left out, so it can't hold the others back.
- Every read shares one classifier for this (`serving`: `.keyChange`, and the cached check dropped). So a listing or look-up that meets a key change is asked again too, never a corrupt file.
- A folder the family still lists that doesn't open here yet (a re-key between the member list and the folders) is treated the same, in the feed and for its items.
- A folder the family no longer lists is deleted.

#### What counts as a deletion

- Only a node the server no longer has, or one whose own envelope doesn't open under a folder that did, is a deletion.
- Each folder is listed once per batch; its rows or its error are kept for the other changes in it.
    - A kept listing's row never replaces a newer one held, which a later listing of the batch may have opened after a move.
    - Only a trashed row stops being held up front.
- A live node whose named folder can't be listed (gone or trashed) is deleted only when:
    - the batch carries that folder's own trashed row or tombstone; or
    - the retried batch carries the same row (change sequence and folder, `Vault.feedSuspects`) and the folder still fails.
- A batch reads all its rows first, noting every such row, and fails once.
    - Notes are kept across failed batches and forgotten only when a batch succeeds. So a page settles in two reads however many rows it holds.
    - A node that moved meanwhile is read from its new folder.
- A node the listing of its named folder doesn't hold (moved or trashed after the feed was read) fails the batch as `.unavailable`, cursor kept. The retried feed carries its newer row.
    - The own drive's feed does the same (`Vault.listedNow`).
- One the listing names that doesn't open here (an id clash) is deleted.
- A listing that fails on some row asks the changed node's own envelope (`open`). One that can't be pinned on it fails the batch.
- Tests: `FamilyDomainsTests`, `FamilyFilesSourceTests`.

## Notifications

Design: `docs/devices-design.md` 5; as built: `docs/push-relay-plan.md`, PR 4.

- `HushOSKit/PushNotifications.swift`:
    - `PushRegistrar`: register, turn off, settle (a server whose relay changed) and forget, one at a time (`PushTurns`). `forget()` is synchronous (the wipe calls it) and moves a generation; a registration is written or put back only while its session is still signed in and the generation hasn't moved. Tests: `PushRegistrarTests`.
    - The registration (handle and `deleteSecret`) is the keychain's `push-registration`. Retired handles wait in `push-pending-deletions` (not account data) until their relay answers 204 or 404, retried at every start (`PushNotifications.retryDeletions`).
    - `catchUp()` lists `GET /api/notifications` when the app opens or comes back, signed in with notifications on; event ids shown go in `state/push-seen.json`.
    - `PushContactNames`: verified, not family-trusted contacts' names in the keychain's `push-contacts` (`ThisDeviceOnly`), written from `Vault.loadSettings` while notifications are on, deleted on every wipe. The extension names a sharer only from it.
- The words, the tag and which relay may be used are the core's (`notifications.rs`). Only `https://push.hushos.com`, or in a debug build `localhost`/`127.0.0.1`.
- `apns-sandbox` on the simulator and when the profile's `aps-environment` is development; `apns` otherwise. A profile without `aps-environment` (a sideloaded build) hides the section (`PushNotifications.available`).
- Every request refuses redirects (`RefuseRedirects`).
- `HushOSKit/PushContent.swift`: a notice into notification content, the same for the extension and the catch-up.
- `App/PhonePush.swift`: the token (from `AppDelegate`, 30-second timeout), permission asked from the switch and once per account by itself (`askOnce` over HushOSKit's `PushAsk`: on the drive's screen once it settles after a sign-in, a sign-up's words, or the first start of a build that asks; never while a sheet, dialog or alert is presented, checked again after the server's settings are read; where iOS allows HushOS already the app asks in its own words instead (MainView's "Turn on notifications?" alert, `PhonePush.offer`), and only Turn on registers; the record in `state/push-asked.json`, wiped with the account, marks `asked`, `retry` (a yes whose registration failed, made at the next start) and `decided` (the switch, either way), changed only by compare-and-set; tests: `PushAskTests`), a renewal at every signed-in start, the catch-up, taps (`opening`), and Account's section (`NotificationSettings`, loaded by Account: a section that draws nothing never runs its own task).
- `Notifications/NotificationService.swift`: writes the fallback first, then the notice; quiet fallback, written notices sound. The `push` category's hidden-preview placeholder is the fallback text (`TransferNotices.start`, which is also the delegate that routes taps and shows pushes in the foreground).
- Testing: the simulator gets a real sandbox APNs token. `xcrun simctl push` delivers a payload but does not run the service extension (seen 2026-11-09 on iOS 27), so the extension's own path is only proven on a device.
- In the simulator, a Toggle often ignores a plain injected tap; a tap with a short duration (0.15 s) works.

## Testing

Run HushOSKit's tests from `Packages/HushOSKit`:

```sh
xcodebuild -scheme HushOSKit -destination 'platform=iOS Simulator,id=<udid>' test
```

- There is no macOS slice of the core, so `swift test` does not link.
- A stub transport that holds a reply never blocks `startLoading`. CFNetwork loads every URLProtocol on one thread (`com.apple.CFNetwork.CustomProtocols`), so a wait there stalls every other request too. The stub holds off-thread and finishes on the loading thread.

### What the suites cover

Identity, trust and storage:

- `IdentityUpgradeTests` (stub server):
    - one upgrade for concurrent callers;
    - the race loser adopts the winner;
    - the version 1 form refused afterwards;
    - own words equal a contact's pin;
    - a signers read held on the history or settings across a forget is not kept.
- `RollbackMarkStoreTests`:
    - sealed and naming nothing;
    - refused under another key or none;
    - a swapped or damaged record refused;
    - never lowered; eight writers lose no raise;
    - an unwritten raise fails yet counts here;
    - plaintext marks folded and removed.
- `AccountStoreTests`: no mark survives a sign-out, deletion or removal.
- `GranterTrustTests`/`PinTrustTests`: v3 pins, comparison, sealing.
- `SuccessionFollowTests`, `SignedShareTests`, `ReportOperatorTests`.
- `ContactGuardStoreTests`, `ContactTrustTests` (stub server, `ContactServer`), `ContactSettingsTests`.
- `AppGroupTests`, `CatalogueFeedTests`, `SharingRefreshTests`, `MarkdownDocumentTests`, `SaveTargetsTests`, `RotationTests`: see their sections above.

Families:

- `FamilyJoinTests`:
    - a first-use join stores the guard, writes the marker in the pin's own save and vouches for nobody;
    - a phone-first join writes `before` records for older pins in that save;
    - a not-member wipe keeps the guard, and another history after it is the hard warning;
    - a guard that can't be stored writes no record, and the next try stores it;
    - a stop between the guard and the record finishes from the joins record; a chain short of the guard is refused;
    - a wipe waits for the guard it hands back;
    - the store merges and never goes down; sign-out deletes it.
- `FamilyCheckTests`:
    - They match saves the record and a verified pin, and the member reads Verified;
    - words that don't match save nothing;
    - a first-seen pin over other keys is a conflict;
    - `familyChecks` and the marker are kept through a save.
- `FamilySyncTests` (stub server, real rosters signed by the core):
    - a member's folder opens and its creator's file is Verified by the family;
    - a chain short of the device record is refused;
    - a fork shows the warning and nothing stays open;
    - not-member wipes and keeps the pin;
    - a late acceptance never writes an older record over a newer one;
    - a pin another device saved first is never written over;
    - a stored pin ahead is accepted up to;
    - three Overtaken runs say the server keeps serving an older list;
    - an unreadable record is reset;
    - a key conflict;
    - share, links, report, keep and versions refused before anything is sent.
- `FamilyWriteTests` (the same stub with a node tree and the write routes):
    - a new folder, rename and trash land under the folder's keys;
    - an upload into a folder reached through the previous root waits, and goes once the walk re-keyed it, under the walked key;
    - a top folder whose key isn't the committed one leaves the folder Couldn't check and refuses every write into what was opened before;
    - 409 `rotating` waits and retries; a `stale` before a wait fails; half an hour gives up;
    - a move within the folder is one server move re-wrapped by the ledger;
    - a move into one's own files uploads the bytes again and trashes the original, never the server's move or copy.
- `FamilyQueueTests` (`FamilyUploads`):
    - finishing from the stored record in a fresh process;
    - a key change mid-flight re-sealed under the walked key with no old part sent;
    - a completed upload whose row won't open landed exactly once;
    - a discarded upload aborted and its plaintext removed.
- `FamilyLinesTests`: former member, unattested re-key, mismatch naming, attested re-key lines, a bad signature's words.
- `FamilyLeaveTests`, `FamilyWalkTests`. The stub's key changes are `FamilyRotationStub.swift`: `replaceKeys`, `rekeyedElsewhere`, the rotation routes, the change feed, route 20.
- `FamilyManageTests`, `ManageNoticesTests` (stub: `FamilyManageStub.swift`).
- `FamilyRolesTests` (stub route 18 and `creatorSetsRoles` in `FamilyManageStub.swift`).
- `FamilyDomainsTests`, `FamilyFilesSourceTests`.

## Known residuals

Accepted by the owner; no fix in the app.

- A cold launch from a link can draw the pushed screen's navigation bar over the status bar, on iOS 26 and 27.0 (accepted 2026-10-29).
    - Back over the clock, the buttons over the battery. About 1 launch in 4 in the simulator; none seen on the Duo's 27.1 or the owner's 27.2.
    - It is an iOS bug. A Feedback report is drafted in PR #233.
- In a received share, a folder above Info's item trashed on another device leaves Info open until it is closed or an action on the item fails (accepted 2026-10-30, as on main).
- `FamilySync.forget()` on a session change clears the ledger of a vault the queue may still hold. A family upload sealing at that moment fails; its plaintext stays for Retry.
