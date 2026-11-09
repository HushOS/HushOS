# HushOS for Android

- A Jetpack Compose app with Material 3 Expressive, minSdk 29.
- Its DocumentsProvider puts HushOS in the system file picker (Storage Access Framework) and in Files by Google.
    - Samsung's My Files never lists third-party providers.
- `:core` holds the UniFFI Kotlin bindings of `crates/hushos-core` and its shared libraries; `:app` is the app.
- The app is on Google Play (the iPhone app is on the App Store).
- The repository's root `AGENTS.md` applies here too.

## Build and run

```sh
bun run core:android    # Rust -> core/src/main/jniLibs and the generated Kotlin (needed once, and after any core change)
bun run android:build   # debug APK
bun run android:run     # boots the Pixel_9_API_36 emulator if needed, installs, forwards ports, launches
bun run android:device  # shrunk release APK, installed on a USB-connected phone
bun run android:release # shrunk release APK only, to sideload
bun run android:bundle  # signed App Bundle for Google Play (scripts/bundle-release.sh)
```

Toolchain on this Mac:

| Tool   | Where or which                                           |
| ------ | -------------------------------------------------------- |
| SDK    | `~/Library/Android/sdk` (platform 37, build-tools 37)    |
| NDK    | 27                                                       |
| JDK    | 21 at `/opt/homebrew/opt/openjdk@21`                     |
| Gradle | 9.6 through the wrapper                                  |
| AGP    | 9.4, with built-in Kotlin: do not apply `kotlin.android` |

- A fresh worktree has no `local.properties`. The dev tools then need `ANDROID_HOME=$HOME/Library/Android/sdk`.
- Run the unit tests on JDK 21. On JDK 26, Robolectric 4.16 fails every test with "Unsupported class file major version 70".
- `adb reverse tcp:5173` and `tcp:9000` let the emulator reach the web dev server and Garage on the host as localhost. The run script does it.
- The debug build talks to `http://localhost:5173`, which reaches the host through `adb reverse` (a USB phone too). The release build talks to `https://hushos.com`.
    - `defaultOrigin()` in `DriveViewModel.kt` reads the build type's `BuildConfig.DEFAULT_ORIGIN`.

### Real phones and release builds

- On the phone: enable Developer options and USB debugging, plug it in and accept the debugging prompt.
- Then `bun run android:device` builds the shrunk release APK (6.6 MB against 77 MB for debug) and `adb install -r`s it.
- `bun run android:release` only builds it. Sideload it from `apps/android/app/build/outputs/apk/release/app-release.apk`.
- R8 needs the keep rules in `app/proguard-rules.pro`: JNA and the generated `com.hushos.core` bindings are reached by name.
- Release builds are signed with the upload key from `apps/android/keystore.properties` or the `HUSHOS_UPLOAD_*` environment variables.
    - Without a key they fall back to the debug key, so a shrunk build still installs on a phone.
    - Play refuses a debug-signed bundle, and `scripts/bundle-release.sh` refuses to build one.
    - `docs/release/signing.md` and `docs/release/google.md` have the steps.

### Emulators

- If the emulator window ignores keys and buttons, it was started from a background shell. Quit it and start it from Android Studio or your own terminal (`emulator -avd Pixel_9_API_36`).
- `adb shell input text` into a focused field, then tapping the next field, mixes the two.
    - Move between fields with keyevent 61 (Tab) and submit with 66 (Enter).
- The foldable is `HushOS_Fold` (pixel_fold, android-36 google_apis arm64) in `~/.android/avd`.
    - avdmanager writes to `~/.config/.android/avd` unless `ANDROID_AVD_HOME` is set.
    - `adb emu fold` / `adb emu unfold`; `adb emu posture 2` is half open (`3` flat).
    - Rotate with `settings put system user_rotation`.
    - It has two displays: `screencap -d` the inner (`4619827259835644672`) or outer (`4619827551948147201`) one.
    - Folding locks this emulator whatever `fold_lock_behavior_setting` says: swipe the keyguard away.

## How it fits together

- The session, the remembered device and the origin live in `EncryptedSharedPreferences` under an Android Keystore master key.
- The provider runs in the app's process and reads the same file.
    - A missing session becomes `AuthenticationRequiredException`. The system shows it as a sign-in affordance that opens the app.
- `Vault` mirrors the iOS one:
    - keys opened on demand;
    - a node-to-parent index in `filesDir`;
    - downloads and uploads chunk by chunk through the core;
    - thumbnails as JPEG at upload.
- `HushOSDocumentsProvider` serves roots, children, recents (from the change feed), open (download to cache), write-back on close (a new version), thumbnails, create, rename, move and delete (to the trash).
- Writes use `workspaceOf(parentId)`, so an editor can add to a shared folder.

### Main files

Paths are under `app/src/main/kotlin/com/hushos/app/`.

| File                                           | Role                                                                                                  |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `data/Mirror.kt`, `data/Catalogue.kt`          | SQLite mirror of the feed (nodes, cursors, thumbnails) and the catalogue built from it                |
| `data/WriteBacks.kt`                           | Other apps' saves through the provider: one slot per file                                             |
| `data/TransferQueue.kt`                        | WorkManager transfer jobs, failed rows, sweeps                                                        |
| `data/Offline.kt`                              | Keep downloaded: private storage, one folder per version                                              |
| `data/Links.kt`                                | Owner link views, `PublicApi` without a cookie, `LinkVault` for a visitor, `Reports`                  |
| `data/Contacts.kt`                             | Pins, owned shares, shared-by-me rows; mirrors `packages/drive/src/trust.ts`                          |
| `data/Rotation.kt`                             | Re-keying a subtree when a share is revoked                                                           |
| `data/OwnIdentity.kt`                          | Opening and upgrading this account's identity; `OpenedIdentities`                                     |
| `data/ContactGuard.kt`, `data/ContactTrust.kt` | The contact guard and the trust acts over it                                                          |
| `data/Vault.kt`, `data/VaultFamilies.kt`       | The vault and its family write path                                                                   |
| `data/Reservations.kt`                         | The upload reservation ledger                                                                         |
| `data/Family*.kt`, `data/GroupsApi.kt`         | Families: sync, guard, sessions, join, check, manage, removal, walks, uploads, plan; the group routes |
| `data/SaveTargets.kt`                          | Save to HushOS targets, family folders included                                                       |
| `files/ProviderFamilies.kt`                    | Family roots in the Files app                                                                         |
| `ui/Screens.kt`, `ui/LinksUi.kt`               | Main screens; share sheet, link browser, report dialog, contacts sheet, phrase grid, `PeopleSheet`    |
| `ui/ContactsUi.kt`                             | `ContactStepSheet`                                                                                    |
| `ui/Adaptive.kt`                               | Window-size frame decisions                                                                           |
| `ui/MarkdownViewer.kt`                         | The in-app Markdown viewer                                                                            |
| `ui/Families.kt`, `ui/FamiliesModel.kt`        | Family screens and their model                                                                        |
| `ui/SignupScreen.kt`                           | Creating an account in the app                                                                        |

## Design rules

- The UI uses Material 3 Expressive with Alpine, the HushOS tokens (`packages/tokens`, generated as `com.hushos.tokens`), in `ui/Theme.kt`.
    - Light, dark, and a high-contrast pair of each that follows Android's contrast setting.
    - Roles Material has no slot for are read through `Alpine.colors`.
- Material 3 Expressive APIs need the 1.5.0 alpha line; the stable 1.4.0 hides them.
- A `Surface` in `HushOSTheme` paints the background, and `values-night/themes.xml` gives the window a dark theme.
    - Without both, dark mode showed grey text on white.
- Nested screens pass `contentWindowInsets = WindowInsets(0)`, because the outer Scaffold already pays the navigation bar inset.
- `SegmentedButton` must be called inside `SingleChoiceSegmentedButtonRow` unqualified: it is a member of the row scope.
- Compose dialogs shift up when the keyboard opens.
    - Read positions again after typing.
    - Hide the keyboard with Back (not Escape, which dismisses the dialog) before tapping a dialog button.

### Foldables and large screens

- `ui/Adaptive.kt` decides the frame from the window in dp (`navKind`, `tabletopSheetMax`, tested in `AdaptiveTest`):
    - the bottom bar below 600dp wide, below 480dp tall, or in tabletop;
    - the collapsed `WideNavigationRail` from medium;
    - its labels from expanded, until Info beside the list would leave the list under 360dp (the Fold opened flat: the rail folds to icons while Info is open).
- `Main` draws it through `NavigationSuiteScaffoldLayout` with the app's own bar and rail. The bar is the phone's unchanged `NavigationBar`.
- The tabs sit inside one `SupportingPaneScaffold`, so every window size has the same composition tree.
    - A fold, an unfold or a resize finds each screen's saved state where it left it.
- Never add a size-dependent branch around a screen: its `rememberSaveable` keys change and the folder, selection and sheets reset.
- Info is the navigator's Supporting destination (`rememberSupportingPaneScaffoldNavigator<String>`, the item id; saved across configuration changes).
    - Beside the list while the directive has two partitions: expanded, or book posture, where the panes split at the hinge.
    - Otherwise `Main` draws `InfoSheet`.
- `ItemActions` hands Info to `LocalInfo` instead of drawing it. `Main`'s own sheets provide no `LocalInfo`.
- Share and Tags from Info are `Main`'s `infoSheet`, so they survive a fold too.
- Info closes only on a removal the server confirmed (`infoLookup`):
    - the row held but not `NodeCache.live` (trashed, or a trashed folder above it in its own workspace);
    - `NodeCache.gone`: trashed from here, a feed tombstone, or a purge;
    - its workspace no longer among the listed shares;
    - for a received share's item only, its absence from the list its own parent shows after a refresh (`missingFromShareList`).
- `NodeCache.gone` is marked by `remove`, never `forget` (which drops a row to be read again). It is marked per workspace and node; once Info has shown a row it asks only about that workspace's node.
- `missingFromShareList` is a decision for Info alone. It never removes or evicts a cache row.
    - Versions that did lost trashed rows from the Trash and brought concurrent removals back. Trash, tombstone and purge keep `remove`.
- Only explicit folder refreshes count (`refresh`, a pull, or a first load of the folder the item is in now: `ParentRefresh`).
    - The reloads after a write or a settle don't; that only leaves Info open.
- A row merely absent (a rotation's `forgetRows`, a catalogue update reopening it) keeps the last one shown. One this process never held (after a restart) is looked up once.
- Residual: in a received share, a folder above Info's item trashed elsewhere leaves Info open until it is closed.
    - The item's own parent still lists it, and the owner's feed never reaches this device.
- In tabletop, `Sheet` bounds its content to the space below the fold, less what Material lays out around it (handle, bottom inset; `sheetContentMax`).
    - Never bound the sheet's own modifier: it sits ahead of Material's anchors and would open a full sheet at the top of the window.
    - With the keyboard up the limit lifts (`sheetLimit`).
- Continuity across a configuration change:
    - sheet and dialog targets, typed passwords and links, and upload questions are `retain`ed (Compose runtime-retain: kept in memory, never written to the saved-state bundle);
    - ids and choices without names are `rememberSaveable`.

## What the app does

The same four tabs as iOS: Home, Files, Shared and Account.

### Home and Files

- Home has search and a tags row, with a tag manager offering presets plus any hex colour.
- There are no type chips. Search's kind words (`data/ItemKind.kt`, the web's split) find "photos", "videos", "documents" and "folders".
- Files has search, tag filters and a floating add menu.
- Long press opens the item sheet, whose first row is Select. The FAB also offers "Select items".
- Selection shows a contextual bar for copy, cut, move and trash.
- A paste bar shows while the clipboard holds items. It refuses a cross-drive paste.
- Same-name uploads ask: replace, keep both, or skip.
- Keep downloaded lives in `data/Offline.kt` (private storage, one folder per version), with an Offline section on Home.
    - The item sheet scrolls; Keep downloaded sits right under Rename, so it is reachable without scrolling.

### Scan document

- Scan document in the add menu is Google's ML Kit document scanner (`play-services-mlkit-document-scanner`).
- Play services runs its camera and screens; HushOS asks for no camera permission.
- It hands back one PDF, which `DriveViewModel.uploadScan` uploads.
- A phone without Play services, or an emulator image without them, gets a notice instead.
- The library's own usage logging to Google is cut off by removing Datatransport's `cct` backend in `AndroidManifest.xml`.
    - Logcat confirms it as `TransportRuntime: Transport backend 'cct' is not registered`.

### Notifications

Design: `docs/devices-design.md` 5; as built: `docs/push-relay-plan.md`, PR 4.

- FCM only, without the Google Services plugin or `google-services.json`: `data/PushTokens.kt` sets Firebase up from `BuildConfig.FIREBASE_*`, which come from the Gradle properties `hushos.firebase.projectId`, `appId`, `apiKey`, `senderId` (or `HUSHOS_FIREBASE_*`).
    - A debug build without all four has no notifications, and Account hides the section.
    - A release build without them fails (`assembleRelease`, `bundleRelease`), and `check-bundle.sh` refuses a bundle whose manifest says `com.hushos.push.configured` false.
- `FirebaseInitProvider` is removed, FCM auto-init is off and `firebase_data_collection_default_enabled` is false in the manifest, so nothing reaches Google until "On this phone" is turned on. Datatransport's `cct` backend (see Scan document) also drops FCM's delivery metrics.
- Token steps (the token, its deletion) run on one serial executor (`PushTokens.steps`), so a quick off-then-on never registers a token about to be deleted.
- `data/PushNotifications.kt`:
    - `PushRegistrar`: register, turn off and settle hold `turn`; `forget` (the wipe) moves a generation under `state`, and every write of the registration happens under `state` only while its session is still signed in and the generation hasn't moved. Tests: `PushRegistrarTest`.
    - The registration (handle and `deleteSecret`) is in `Shared`'s encrypted preferences; a write that isn't committed deletes the new handle at the relay. Retired handles wait in `push-pending-deletions` (not account data) until their relay answers 204 or 404, retried at every start.
    - `catchUp` lists `GET /api/notifications` when the app opens or comes back; event ids shown are in `push-seen.json` (an account file).
    - The words, the tag and which relay may be used are the core's (`notifications.rs`): only `https://push.hushos.com`, or in a debug build `localhost`/`127.0.0.1`, and `10.0.2.2` only on the emulator. A sharer is named by the pin's name only.
- `PushService` checks the tag, fetches the event and posts within 9 seconds, else the fallback. Channels: Security (high), Shared with you, Families, Other activity (low, the fallback); notices and channels `VISIBILITY_PRIVATE` with a public version reading "New activity in HushOS"; local only. Whether a locked phone shows the private version is the person's lock-screen setting, not the app's.
- `POST_NOTIFICATIONS` is asked from the switch (`ui/NotificationsSection.kt`) and once per account by the app itself (`AskForNotifications` over `data/PushAsk.kt`):
    - from `Main`, once it has settled with the window's focus, so never while a sheet or dialog (each a window of its own) is up;
    - only on a server with notifications and a usable relay; allowed (or allowed before, or before Android 13), it registers as the switch does;
    - the record is `push-asked.json` in the app's files (an account file), written before the question; the switch counts as asking, so a person who turned it off is never turned back on. Tests: `PushAskTest`.
- `AccountStore.of(context)` calls `PushNotifications.forget`: the registration goes, its handle is held for deletion, the push notices are taken down and the FCM token deleted.
- Taps reach `MainActivity` as `com.hushos.app.push.OPEN:<devices|shared:false|families|app>`.

### Account and plan

- Account shows name, plan and storage, read only, with no way to buy.
- Account also has change password, delete account, Contacts and Your twelve words, trash, and sign out.
- `PlanDisplay` in `data/Auth.kt` decides the plan card:
    - While `/api/auth/storage` names a `pool`, the card is the family's plan, "Shared with <family>", with the pool's figures.
    - There is no Files row then: the total is counted in whole GB.
    - "Not enough room" reads `availableBytes`, never quota less used.
    - It falls back to the personal plan when `pool` is absent or unreadable.
- A plan is named only while it is live (`PlanStanding`, the web's `planStanding`): not ended, and active, trialing or past_due.
    - Unpaid, incomplete or paused reads Free with the lapsed plan's words (`LapsedPlan`), said and never linked.
    - Anything ended reads Free.

### People and your twelve words

- People (`PeopleSheet` in `ui/LinksUi.kt`) opens from Account and the Shared header.
- It has the add-by-email field, then a Your twelve words row, then the list sorted by name, with Find someone from eight contacts.
- Your twelve words is one `OwnWordsSheet`, drawn by `Main` while `DriveViewModel.showingOwnWords`.
    - It checks the served identity first (`Vault.currentOwnFingerprint`).

### Markdown viewer

- Markdown files (`text/markdown`, or `.md`, `.markdown`, `.mdx`) up to 2 MB open in HushOS's own `MarkdownViewer` (`ui/MarkdownViewer.kt`), not another app.
    - The app's root draws it while `DriveState.reading`.
- `openWith` in `ui/Screens.kt` routes them. Everything else goes through `openElsewhere`.
    - So does the viewer's Open with, which closes the viewer first so a no-app notice isn't hidden under it.
- `data/MarkdownDocument.kt` parses with commonmark-java under the web's rules, tested in `MarkdownDocumentTest`:
    - raw HTML dropped;
    - links to http, https or mailto only, and only on a tap;
    - images named and never fetched; a linked image opens its link;
    - a leading byte order mark dropped.
- Depth limits:
    - commonmark-java stops nesting blocks at 100.
    - Quotes and lists are drawn 16 deep, emphasis and links 32; their words are plain past that.
    - A `StackOverflowError` in the parser shows the file as its text.
- A file with more than 200,000 emphasis and link marks (`*`, `_`, `~`, `[`) is shown as its text before parsing.
    - Why: 2 MB of `*a* ` ran the Android parser out of memory.
- Big blocks come in pieces, as on iPhone (`MarkdownDocument.cut`):

| Block                   | Limit                                                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Paragraphs and headings | At most 4,000 characters, cut between words                                                                                                       |
| Lists and quotes        | At most 200 in weight: a block each, a table row each, one per 200 characters; an item too heavy goes on in the next piece unmarked (`continued`) |
| Image descriptions      | Shortened past 2,000 characters                                                                                                                   |
| Code                    | 200 lines or 4,000 characters                                                                                                                     |
| Tables                  | 200 rows, 4,000 cells or 40,000 characters, repeating the head                                                                                    |
| Table columns           | At most 50, with a "…" column for the rest                                                                                                        |
| Table cells             | Shortened with "…" past 2,000 characters                                                                                                          |

- In weights, line and paragraph separators are drawn as spaces, a line from Markdown counts 20 characters, and an image counts as at least 20 characters.
- A table is one measured grid with columns up to 320dp.
- Code with a line past 1,000 characters wraps: Compose can't represent a 300 KB line's width.

### Sign-up in the app

- "Create an account" on the sign-in screen runs the web's /register in the app (`ui/SignupScreen.kt`, `DriveViewModel.SignupFlow`):
    1. email and the terms;
    2. the emailed link (`/register/complete#verify=`, `AppLink.Register`, in the manifest's path filters and the web's app-links paths);
    3. name and password (`SignupRules`, the web's lengths in UTF-16 units);
    4. `Auth.register`: OPAQUE in the core, every key made by `account_create` (the account key never leaves Rust), `POST /api/auth/register/finish`;
    5. a normal sign-in.
- `SignupRules` is the only password check: the server never sees the password.
- No plans, prices or codes on the way.
- A file picker's sign-in screen sends sign-up to the app's own screen (`MainActivity.SIGN_UP`), where the link opens.
- The words come before Drive.
    - `RecoveryWords.begun(userId)` is set once the account exists, before any session.
    - `HushOSApp` shows the kit (`PhraseScreen(firstKit = true)`, read back from the account) whenever the signed-in account is the marker's.
    - It does so until the three-word check confirms it, or the server says it was confirmed elsewhere (`WordsWaiting`).
    - A recovery's new words use the same marker, so an app stopped on them shows them again too.
- A sign-up link opened while signed in is not used: a notice says to sign out first, and the link stays good.

## Data and sync

### Mirror and catalogue

- `data/Mirror.kt` (SQLiteOpenHelper: nodes, cursors, thumbnails) and `data/Catalogue.kt` mirror the web.
    - Pull the whole feed once, open rows parents first, then `sync()` pulls only changes.
- `listChildren`, `recents`, `trash` and `thumbnail` answer from the catalogue first.
- `NodeView.rawJson` keeps the row as served, for the mirror.
- The view model builds the catalogue after `loadRoot()` and syncs before every refresh.

### Feed cursors

- The app, the provider and the transfer jobs share one mirror, but each `Vault` pulls the feed from its own `catalogueCursor`.
    - Why: the mirror's cursor once let the app's sync swallow the changes the provider's catalogue never filed.
- That own cursor counts only within the mirror generation it was taken under (`Mirror.FeedState`).
    - Every clear bumps the generation and marks a refill owed until one reaches the head.
    - So a refill that failed partway is carried on from the mirror's cursor, never jumped by a vault that was already current.
- Pulls hold `Mirror.feedLock`.
- `resync` is heeded only on a pull's first page, as the web client does. Later refill pages sit below the dropped tombstones by nature.
- A refill carries no tombstones. So a build from a whole mirror at the head evicts (and marks gone) every cached row the mirror no longer holds.
- Any build over an existing catalogue (a reset, a failed rebuild, rows under an unseen folder) goes through `rebuildCatalogue`, which tells Files what differs.

### Who can open what

- `DriveState.access` comes from `/shares/mine`. `ui/SharingRefresh.kt` asks for it again:
    - at once after every restore (`write(restored = true)`, the batch, a trash's Undo);
    - after a sync that applied a change in the own drive, at most once per 10 s, with one load at the interval's end.
    - Why both: the server leaves trashed items out, and a change can't say it was a restore.
- `access` is replaced only when the marks changed.
    - The marks leave out expired links and count links.
- `accessLoads` moves when what the server lists changed (`SharingRefresh.listing`: share ids with roles, link ids). An open By me reloads on it.
- The trailing load is launched lazy and recorded before it starts: viewModelScope runs a body inline.
- Tests: `SharingRefreshTest`. It has iOS's `SharingRefreshTests` cases, plus a load due at once on an immediate dispatcher is neither lost nor left blocking the next.

## The Files app (DocumentsProvider)

### Telling Files about changes

- Files keeps a folder's listing until that folder's children URI is notified.
- Every `Vault` write, and every `Vault.sync` that touched something, notifies the folders it changed through `FilesRoots.foldersChanged`.
    - The top folder is notified by both `root` and its node id.
- A new write path that bypasses `Vault` must do the same.

### Polling and refresh

- Once Files has its listing, Android caches the HushOS process and freezes it within seconds, so a provider thread can't poll.
- `FilesPollService` polls every 30 s until 2 minutes after the last listing, or until the screen goes off.
    - It is a `JobService`, not WorkManager, which may run work in the process without a job.
    - The owner chose 30 s for 2 minutes over 10 s for 5 minutes.
- DocumentsUI itself waits about 10 s after a notification before it asks again.
- Its swipe-down calls the provider's `refresh` (logcat `RefreshTask: Provider supports refresh and has refreshed`).
    - That queues a sync behind any running pull, tells the folder, and holds the binder at most 5 s (`ProviderRefresh`).
    - A false answer makes DocumentsUI reload by itself.
- Whether Files by Google's pull-down calls `refresh` is unverified: the emulator images have no Files by Google.
- Tests: `FilesChangesTest`, `FilesRootsTest`, `FeedPullsTest`, `ProviderRefreshTest`.

### Provider rules

- Moves answer with the moved document's id. DocumentsContract reads null as a failure.
- A rename's, move's or restore's answer has no current version (as the server answers). The row keeps the version it held.
- Another app's write starts from the current version when its mode keeps the contents (`WriteModes`).
    - "wa" and "rw" keep it; "w", "wt" and "rwt" truncate.
    - This holds on the personal path and in family folders.
- A client reading on its main thread gets `NetworkOnMainThreadException` from the provider (StrictMode travels over binder), personal files too.
- Families in Files and other apps' saves have their own sections: [Families in the Files app](#families-in-the-files-app) and [Saves from other apps](#saves-from-other-apps-write-backs).

## Sharing, links, reports and rotation

- `data/Links.kt`: owner link views, `PublicApi` without a cookie, `LinkVault` for a visitor, `Reports`.
- `data/Contacts.kt`: pins, owned shares, shared-by-me rows, and the matching `Vault` functions.
- `Auth.rotateKeys` and `Auth.recoveryKey`.
- The UI lives in `ui/LinksUi.kt`: share sheet with People and Links, link browser, report dialog, contacts sheet, phrase grid.
- Shared folders open through `BrowseScreen(start = root)`.
    - So they get search, select, the paste bar and the add button, in the granter's workspace.
    - Pasting a copy across drives re-uploads (`copyAcross`). A cut never moves into or out of a share across drives (`Vault.mayMove`, `SHARE_MOVE_REFUSED`): the server refuses `moveOf` there, so Copy is the route.

### Rotation on revoke

- Revoking a share rotates the subtree (`data/Rotation.kt`, the same protocol as the web).
- Never send a node beside its parent in one batch (`deferChildren`).
    - Why: the server judges each node on its own. Another device can win the parent while this one wins the child, sealed under a key nobody kept.
- A batch goes in parts of at most 4 MiB, each node whole (`rotationParts`), in both walks. Each part is settled as it lands.
    - Test: `RotationPartsTest`.
- A parent another device re-keyed is read from the server (`adoptServedKey`) before its children are wrapped under it.
- Test: `RotationRaceTest`. FakeDrive judges each node; `rekeyedElsewhere` and `beforeRotationSend` stand in for the other device.

## Identity and trust

### Post-quantum identities

Design: `docs/identity-pq-design.md`.

- `data/OwnIdentity.kt`: `openOwnIdentity` opens the identity and upgrades a version 1 one before anything is signed.
    - The upgrade is `identity_upgrade`, `POST /api/auth/identity/upgrade`. A 409 adopts the identity another device stored.
    - `Vault.identityKeys()` goes through it, and `loadRoot` calls it first.
- `SettingsMark` keeps the settings sequence, whether a version 2 settings document was seen, and `(keyVersion, identityVersion)`.
    - It refuses the version 1 form once version 2 was seen.
- The rollback marks are one record per account in `noBackupFilesDir/marks/<slot>.json`.
    - Sealed by the core under a key from the settings key (`rollbackMarksUpdate`, the web's format).
    - `Vault.marksKey` finds the key: the envelope kept beside them, then the vault's key, then the server's (made only to keep a first mark).
    - A record that does not open is `MarksUnreadable`; a mark that can't be kept is `MarksUnsaved`. Either fails the step.
- `AccountStore.wipe` (sign-out, deletion, removal) deletes the marks.
    - It also deletes the plaintext `settings-seen.json` earlier versions kept across sign-outs. The first read folds it in and removes it.
- Own words are `identity_fingerprint_of_keys` over the four opened keys.
- `OpenedIdentities` (in `OwnIdentity.kt`) keeps the opened identity and the history for `Vault`.
    - Opened under its lock; `forget` waits for an open under way.
    - A history read is kept only while the identity it was read beside is still the one in use.
    - `OpenedIdentitiesTest` holds the fake server's reply to prove both.
- Trust loads overlap, handled in `Integrity.kt`:
    - The view model's `refreshTrust` (each call follows a change) keeps only the latest one begun (`TrustLoads`).
    - The provider's `trustFor` (asked from many threads per listing) shares one load (`SharedLoad`).
    - `reset` names the current vault under the provider's `vaultLock` (one Vault per session). A request still holding a dropped vault loads for itself, never shared or kept.
    - Tests: `TrustLoadsTest`, `SharedLoadTest`.
- A followed pin always keeps its own signing key among the previous ones (`previousKeysAfter`).

### Pins and shares

- `data/Contacts.kt` mirrors `packages/drive/src/trust.ts`.
- `ServedIdentity` is the served shape everywhere: lookups, granters, grantees, rotation work, operators.
- `ContactPin.trust` is the core's `pin_trust` (verified, seen, legacy, invalid); `compare` is its `compare_pin`.
- `commitment` is the core's `key_commitment`. Never use `fingerprint`, which every first-seen pin holds as `""`.
- `granterKeysOf` opens suite 4 with the pinned Ed25519 key and the served ML-DSA key whose digest the pin holds.
- A pin is written only over a contact whose keys statement holds (`Contact.upgraded`).
- Shares are suite 4 (`SHARE_SUITE`).
    - The re-seal pass seals anything older. It runs after this device's upgrade and after every words check.
- The web test fixtures (`crates/hushos-core/fixtures/web.json`) are parsed with `Auth.identityEnvelope`, as the app parses served ones.

### Contacts without comparing words

Design: `docs/optional-verification.md` sections 2 and 6. Twin of iOS's `Vault+Trust.swift` and `ContactGuard.swift`.

- `data/ContactGuard.kt` is the contact guard: one record per account in `noBackupFilesDir/guard/<contact_guard_slot>.json`.
    - Sealed by the core (`contact_guard_seal`/`_open`, HKDF from the settings key), with the settings key's envelope beside it.
    - Found through the vault's `marksKey`, as the rollback marks are.
- Failure states:
    - A record there that won't open is `GuardUnreadable`, never first use. Everyone pauses: "HushOS couldn’t check this right now."
    - A write that can't be kept is `GuardUnsaved`.
    - A commit over a stale revision is `GuardRaced`.
- Writes are read-change-write under one process-wide lock (the provider shares the process) and a sign-out generation.
- `AccountStore.wipe` deletes it (`ContactGuard.deleteAll`).
- `GuardTurn` serialises acts, and the readers that judge from the guard, across the app's and the provider's Vaults.
- `data/ContactTrust.kt` orders the reads and writes. Every rule is the core's: `pin_of_served`, `pin_trust`, `compare_pin`, `key_commitment`, `pin_first_seen_of_legacy`, `guard_agrees`, `guard_entry_next`.
    - `stand` says where this phone stands with one person.
    - `commitTrust` writes the pending act, saves, then commits the guard. It writes the act again before each compare-and-set attempt (`updateSettings(beforeSend =)`).
    - `guardFor` finishes a pending act whose save landed.
- Anything that leaves shares on older keys (`resealShares`: Continue, They match over new keys, a followed succession) is queued in `ShareSeals.queue`.
    - Queued before the save that owes it, and again when a later read finishes the act.
    - The re-seal pass seals queued people regardless of the seal record.
- Acts:
    - `addContact` (no words);
    - `lookup`, `continueWith`, `theyMatch`;
    - `remove` (records `removedContacts`);
    - `trustGrantee` (share, rotation via `granteeSealer`, the re-seal pass);
    - `trustGranter` (mounting: `MountPass` reads settings once per pass, one verdict per granter and full served identity, `Contact.trustKey`);
    - `openWaiting`.
- `Settings.setPinOnce`:
    - moves a pin stored under the id in other letters (raw JSON, every field) to the served id;
    - forgets the removal;
    - forgets removals oldest first for room;
    - refuses past 64 KiB with "Your contacts are full. Remove someone you no longer share with."
- Verdicts: `Trust.of` takes `effectivePins()` (the guarded view).
    - A first-seen pin's records read `SEEN`: no mark, and Info's "Added by" with "Not verified · Check it’s Maya" (`seenByOf`).
    - The mark's words are 6.12's. Its way out is Check it's Maya (a pin that vouches for nothing) or Check who wrote this (Add someone with `writer`, then the words).
    - `Main` shows that step (`DriveViewModel.contactStep`), so it outlives the mark.
- UI (`ui/ContactsUi.kt`): `ContactStepSheet` takes the place of the sheet it was met in.
    - It covers Add someone, Check it's Maya with the mismatch path and Remove, and "Maya's account changed" with both variants and Technical details.
- The share sheet's lookups (`Vault.shareeChanged`):
    - kept a minute (`cachedLookup`);
    - forgotten on Continue, They match and removal;
    - three at a time (`ShareeChecks`);
    - never on the sheet's own reloads;
    - a failure is said.
- Stop sharing never waits on Review.
- Tests: `ContactGuardTest`, `ContactTrustTest` (FakeDrive serves lookups, successions, `startOverGrace`, settings edits and a lost save answer), `SettingsTest`.

## Transfers

### Job names and accounts

- Transfer jobs carry no file or folder name in WorkManager (input, tags, output).
    - Why: its SQLite file keeps pruned jobs in free pages, and sign-out can't empty it.
- Names live in `JobNames` (`job-names.json`, an account file), which the panel and workers read. `JobNamesTest` holds the requests to it.
- Each job carries `TransferQueue.accountTag`, a digest of the user id.
    - The same account signing in again keeps its jobs; another account never runs them.
- A transfer job writes for its own account only.
    - It remembers the wipe generation it started in.
    - It does nothing for a job another account queued (`TransferQueue.sessionCurrent`, by the account tag that upload and keep jobs carry). Its failure output keeps its inputs.
    - The panel rebuilds rows only for its own account's jobs, under the same lock.
- Every write a job makes after a blocking call goes through `forItsAccount`, under the lock the wipe moves the generation in.
    - That covers its failed row, its notification, its `LandedJobs` mark, its waits and its landed row.
    - So nothing of an account that signed out reaches the next one.
- Every download (`Vault.download` → `Resumable.download`'s `guard`) writes only under the wipe's lock for the vault's account, after the copies lock.
    - A wipe that comes before the vault closes stops them.
- Sign-out closes the vault off the main thread, still before the wipe.

### Upload reservations ledger

- Every server upload reservation is on one ledger with one rule (`Reservations`, `upload-reservations.tsv`).
- Reading it:
    - Only a ledger that isn't there reads as empty.
    - Any other read failure, or a line that doesn't parse, is `LedgerUnreadable`: retried, and nothing is reserved or written over it.
    - Every begin, a queued job's or not (a share's upload, Files writing a file back), first reads the ledger (`requireReadable`).
- Writing it: a write is moved over the old ledger whole. A refused move fails the write and leaves the old one as it was.
- A reservation has a record from the moment `begin` returns until it is definitely settled. Settled means:
    - a completion that succeeded;
    - an abort answered as releasing it (200) or as completed (409 "already finished");
    - a 404 or 403, once the record's expiry and a 2-hour grace have passed.
- `DriveApi.abortUpload` maps the server's answers (`packages/drive/src/server.ts` over `packages/db/src/drive.ts` `abortUpload`):
    - A 404 or 403 is `GONE`, not released: `requireUploadAccess` answers them before the upload is looked at when this account lost the workspace.
    - The expiry is the later of begin's `upload.expiresAt` and the phone's begin time plus `UPLOAD_TTL_HOURS` (24).
    - The grace covers the hourly expiry sweep and its hour for completing uploads.
    - A 409 "finishing", a 5xx or no answer leave the record.
- Only `Reservations.settled` removes a record.
    - A failure, a key-change look, `endFamily`, a job's own removal, a cancel, a sweep and a process dying all leave it.
- AccountStore wipes the ledger only with the account (`Reservations.wipe`, under the ledger's lock).
    - The wipe moves the ledger's generation: a vault made before it adds nothing after.
    - So an upload still on its way at sign-out writes no record or landed row back.
- A record the disk refuses after `begin` is held in memory (flushed by the next write, cleared with the account).
    - The reservation is aborted at once, and the job is the network's when that abort isn't answered.

### Landed uploads

- A queued job's record becomes the job's landed row in the same write that settles it as completed. That happens when:
    - its completion is answered (`Reservations.completed`); or
    - an abort, from whichever run asked, hears "already finished" (the completion's answer was lost).
- From the completion on, nothing sends the file again.
    - Whatever fails after it in a queued job (the check of the node, a new version's name signed again meeting a key change or a refusal) is `Reservations.Landed`.
    - The key-change wait never retries `Landed`.
    - The landed version's name stays as it was, for the deferred landed-version name repair.
- The worker ends the job as uploaded when it finds a landed row: at its start, or as `Landed` before it reserves.
    - It forgets the row last, also after a clean landing.
- Both successful ends (a clean landing and a landed row) write the `LandedJobs` mark before deleting anything.
    - So a rerun after a stop during the end ends as uploaded.
- Before a queued job reserves, `Vault.upload` settles what the same job left (`settleJob`). One still unsettled makes the run the network's.
- Each worker run (`TransferQueue.runUpload`, the worker's body, tested on its own) first aborts every record no upload in this process is running (`settleAll`).
    - It ends as uploaded right there if that found its own upload landed, before the family or folder is looked at.

### Retry and ledger keys

- A job keeps its reservations under a ledger key: its own id, unless a Retry carried the first job's.
    - Carried as `uploadRequest`'s `ledger`, in its input and a `ledger:` tag.
    - `FailedTransfer.ledger` keeps it; the worker's failure, `endFamily` and the panel keep it too.
- A Retry's new job holds the failed one's records and landed row as they are; nothing is moved.
    - So a process dying anywhere in a Retry leaves only the row to retry again.
    - Two jobs of one key never reserve over each other.
- A row rebuilt from a failed WorkManager job (`FailedTransfer.fromWork`) keeps its family, folder workspace and ledger key.

### Testing uploads

- `UploadWorker` runs whole in `UploadWorkerTest` (androidx.work:work-testing).
    - `TestListenableWorkerBuilder` takes the request `uploadRequest` builds.
    - The test WorkManager needs a synchronous task executor too, or the worker's foreground notice blocks on its own query.

## Saves from other apps (write-backs)

Another app's saves of one file through the provider are coalesced in `data/WriteBacks.kt`. Test: `FilesSaveOrderTest`.

The core rule: the closed edits on disk are the truth. Rows and counters are only caches of them.

### Slots and generations

- Each file has one pending slot under `queue/writeback-<workspace>-<node>/`.
- Every save is a generation of its own: `<id>.bin` and `<id>.json` (generation, a save id never reused, and the target).
- A generation is published by one rename of `record.json`, so contents and identity change together.
    - A death before the rename leaves the earlier save pending.
    - The next look under the lock publishes a complete newer generation.
    - Generations nothing names go only under the lock.
- A generation's id carries its save number (`n<number>-<random>`, `numberOfId`), so a failed row and a ledger key say which save they are.
- A slot has its own id (`slot-id`), made with the slot.
- A slot folder is only ever deleted by a `WriteBacks` call under its lock that looks again first (the sweep's `removeIfEmpty` too).
    - `TransferQueue.discard`/`dropJob` refuse slot folders.
    - A slot is never deleted outside its lock.
- A slot is cleared contents first (`clear`).
- Clearing a settled slot (a landing, a cancel, a dismissal) deletes only what it settled.
    - It leaves a newer family save's `.staged` copy, and the slot id it publishes into.
- A failed staging leaves no empty slot folder.
- The old-slot sweep leaves a slot a family save is staged into.
- A slot whose bounds can't be read is never swept as empty.

### Edits

- Edits live under filesDir (`WriteBacks.EDITS`):
    - `edits/personal/<node>/<id>`;
    - `edits/family/<ws>/<node>/<id>` (via `FamilyCopies.edits(filesDir, ws)`).
- Each edit has the file it would replace beside it (`<id>.json`). Its target names the account (`account`, the user id).
- An open's edit is made, filled and opened only while its account is still here: under the wipe's lock, each step.
    - A sign-out between them deletes what was made and fails the open.
    - A start deletes an edit another account's target names instead of adopting it.
- At close the edit is renamed `<id>.<number>.closed` (no room needed) before anything that can fail.
- From then on it is deleted only when:
    - kept in the slot;
    - dismissed;
    - retired by a landing or cancel at or above its number;
    - its family is revoked, or the account signs out.
- `WriteBacks.isRetainedEdit` names every form an edit holding a save takes: open, `rescued-`, `.closed`, `.q<number>`. The sweep of targets asks it.
- The abandoned-edit cleanup never deletes an edit a row names, whatever its name (a close whose rename failed).

### Closing and numbering a save

- A save happens in the close callback, under the slot's lock, and only while the account that opened it is still here (`Reservations.whileAccount`).
- Close callbacks run on one thread of their own (`WriteBacks.closes`), never the main one, in close order.
    - The close handlers let nothing escape their thread.
- The close asks nothing of the network.
- Every save is numbered as its app closes the file (`WriteBacks.reserve`).
    - The number is above every number the file's saves had: every closed edit's and staging row's number, the counter and the slot.
    - The counter is kept past the slot in `filesDir/writeback-numbers`, wiped on sign-out.
    - `reserve` only reads: it never publishes or throws.
- A close takes its number and renames its edit in one hold of the slot lock (`reserveAndClose`).
- Then the save is kept (`WriteBacks.stage`, with a `fault` hook per step for tests):
    1. copy the edit into a generation (synced);
    2. write its description (synced);
    3. rename the record;
    4. only then delete the edit.
- So a failure anywhere leaves the edit and a staging row naming it and its number.
- One staging row per edit, however sweeps overlap.
- A generation whose publish fails is deleted: its edit and row are that save.
- A look whose record write fails still serves the newest complete generation.
- Saves, cancels and dismissals tell Files the folder's watched URI (`WriteBacks.notifyFolder`; `Target.root` for the top folder's "root" alias).

### Jobs

- Each save gets a job of its own, unless one of the slot's jobs is still waiting to start; that job sends it (`TransferQueue.enqueueSlot`).
    - Jobs are never chained, so no job's failure takes a newer save's job with it, with or without the transfers panel.
- A slot's job is queued only for the account that kept its save.
    - `enqueueSlot` takes that account generation and checks it again under the wipe's lock before writing the job's name or enqueueing.
    - A sign-out since publishes nothing.
- Jobs of a slot run one at a time (`JobLocks`).
- Each job sends a copy of whatever the slot holds. Its ledger key is the save's (`slot#id`).
    - It clears the slot only if it still holds that save.
    - A newer save is sent next in the same run.
- A sending copy counts as a send under way only while a job of this process holds the slot (`JobLocks.held`). A start deletes the others.
- A job that can't copy its save to send fails with a row for the kept save (Retry sends it), leaving no partial copy.
- Uploads replacing a file resolve it by workspace and node when they run, never through the folder it was queued from.
- Every save after the first in a run, and any after an earlier save's reservation was settled, goes out from a vault opened after the settling.
- None starts while an earlier save of the file has a reservation unsettled: the run retries.
    - A family file's removal is asked about first, so a removed family's saves end at once.
- A job's upload, and what its end means (the landing's bookkeeping), run in one `NonCancellable` block.
    - So WorkManager stopping the job mid-completion never loses a landing.
- The completion's version is kept on the row, though the rename after it answers without one (`packages/db` renameNode).
- A job whose completion landed (a landed row) runs its landing's bookkeeping whatever its end says, and a contents-keeping edit starts from it.
- A slot job WorkManager failed without running it makes no row, so the sweep gives its save a job.
    - That is a job queued behind a predecessor that failed: no `message` in its output.
- A job that finds nothing to send lets a waiting summary out (`TransferNotices.settled`).

### Reads and opens

- Every open (`r` included) reads the slot while it has a save, whatever its job's state, even after WorkManager prunes it.
- Reads, contents-keeping opens and listings all take one choice, `newestLocked`.
    - It is the pending save, or a retained `.closed` edit above the bounds; never an edit that was never closed.
    - Listings means `WriteBacks.pendingMeta` (a pending save's size and date) and the family poll's signature.
- `copyNewestTo` starts every contents-keeping open, and a read, from the newest kept contents by number.
    - It lists closed edits directly, row or not.
    - It reads the bounds, lists the kept contents and copies its choice all under the slot's lock.
- Reads and listings never write a slot.
    - `current` only reads: the newest complete generation above the bounds.
    - `recovered` (publish, tidy) runs only on account-guarded paths: a save, a take, a landing, a cancel, a dismissal, every reconcile.
- A read's pending copy is made under the wipe's lock.

### Landings

- A landing moves the sent copy to the read copy of the version it became (this account's own drive). Then it records the landing on disk.
- The landing marker lives in `writeback-numbers/<slot>` (`filesDir/writeback-numbers/<slot>`, wiped on sign-out) with the landed bound: one file, synced, one rename.
    - Order: move the read copy, then write marker and bound together, then retire.
    - A death before that write leaves the save pending; after it, a marker. Reconcile finishes the retirement (`retireSettled`).
- The provider's next read checks the version with the server.
    - Without an answer it serves those bytes or fails, never the version before.
    - A read clears only the landing it refreshed for.
    - A read looks its file up again after reading the landing: a concurrent read may have cleared it.
- Every landing goes through `WriteBacks.recordLanding(slot, number, version)`: marker and bound in one write, then retirement.
    - The job's own landing goes through it.
    - So does a reservation settled as completed later (`Reservations.completed` → `recoveredLanding`), for a superseded save too.
    - The save still pending is left to its job, which knows the version.
    - Reconcile repeats it for a recording that was refused.
- A landing retires:
    - every row of the slot's saves but a still-pending one's;
    - every closed edit and staging row at or below it, found on disk;
    - the slot's obsolete failure rows and their unposted notices (`TransferNotices.retire`), the summary's failures before their rows.
- WorkManager's failed entries never make an obsolete row again.
- A landing's row bookkeeping (`TransferQueue.retireLanded`: rows numbered at or below the landed bound, and their unposted notices) can run again.
    - The landing's job, its next run with nothing to send, and every reconcile run it.

### Bounds

- The durable bounds live in `writeback-numbers/<slot>`: newest landed, and cancel.
- They are read in one place and honoured by every look at a slot (`current`), by `stage` and by `copyNewestTo`.
- A numbers file that is there but can't be read is unknown, never zero.
    - Nothing of its slot is pending, served, taken, tidied or retired.
    - Reads refresh or fail.
    - A guarded path (a save, a landing, a cancel, a take, every reconcile) rebuilds it.
- A rebuild in the same process restores the last bounds read or written (`lastKnown`, cleared with the account).
- Otherwise a rebuild sets both bounds to the highest number anything on disk of the file carries, with a landing for reads to refresh for.
    - That covers generations, closed edits, staging rows, sending copies and edits set aside.
    - Every one is kept aside (quarantined), never read and never sent unless its Retry is pressed.
    - The newest complete generation leaves the slot as an edit of its own (`rescued-<id>`, never read as contents), keeping its own number, with a staging row.
    - An edit never closed is kept aside as `<id>.q<number>`.
    - A staging row keeps its own number and the ceiling (`quarantined`).
    - A landing above the ceiling retires the rest.
- A rescued generation stays behind any newer retained save.

### Failed saves and Retry

- A failure keeps the slot for the row's Retry (`FailedTransfer.slot`, its `file` the failed generation). Retry queues the slot's job again.
- A failed slot save's Retry is offered while the slot holds a save to send (`WriteBacks.hasPending`), never judged by its record alone.
    - `hasPending` reads without the slot's lock, and the transfers panel asks it off the main thread.
- A save that can't be kept in its slot (a full disk) keeps its edit and makes a failed row (`FailedTransfer.stage`, the target as JSON).
    - Its Retry keeps it, then sends it. Dismissing that row deletes the edit.
    - A family save of this kind: see [Families in the Files app](#families-in-the-files-app).
- A staging Retry keeps the save under its own number, never over a newer save pending or landed.
    - If superseded (`Superseded`), its row and edit go.
    - A Retry superseded by its own copy in the slot sends that.
- A landing retires staging rows numbered at or below it.
- `TransferQueue.retryOutcome` tells a Retry that still couldn't keep its save (`NOT_KEPT`: the edit and row stay, the row's reason is said) from one whose file is gone.
- A Retry of a save kept aside (quarantined) goes only into an empty slot (`intoEmptyAbove`, checked again as it is kept, under the slot's lock).
    - Empty means: nothing pending or being sent, nothing landed or cancelled since, no newer row or closed edit.
    - It is sent under a fresh number only if nothing newer of the file was kept aside or retained.
    - Otherwise it is moot, and its row stays to Dismiss.
    - It checks for anything newer and takes its number in one hold of the slot lock (`withSlot`), then checks again as it keeps, including rows and closed edits above its own number.

### Dismiss and cancel

- Dismissing a row drops only its own save (the slot with it, while that save is still the pending one).
- Dismiss deletes what a row holds before the row.
- Dismissing a failed save keeps its number as a cancel's bound before anything goes.
- Dismissing a slot row also removes that save's staging row and closed edit.
- Dismissing a staging row also deletes whatever generation of that save reached the slot.
- A cancel captures, as it is pressed, the slot's id (`slot-id`) and the save the slot holds (`publishedSave`).
    - When nothing holds the slot's lock it takes the save reads find (`tryLock`, then `current`). So a complete generation whose record was never written is cancelled, not queued again.
    - While a save is being kept, it takes the record's save.
- `cancelThrough` then runs under the slot's lock, off the caller's thread. It cancels that save and every older one, only while it is still that slot.
    - The bound is kept past the slot in `writeback-numbers`, whatever files a newer save replaced meanwhile.
    - A job already sending a save it took stops before landing it.
    - Later saves are numbered above it; a save at or below it is never pending again.
    - It retires staging rows and closed edits at or below it.
- Then the cancel cancels the job, then gives a save made after the press a job of its own.
- A cancel drops the slot under its lock.

### Sweeps and reconcile

- The whole sweep (edits, then slots) runs at every process start (`TransferQueue.startupSweep`), not only from the transfers panel.
- `TransferQueue.reconcileEdits` runs at every process start and queue sweep.
    - A closed edit no row names, whose number the slot hasn't kept, gets its staging row.
- At start, an edit never closed, over a day old and named by no row, is kept while its target is beside it.
    - It gets a staging row ("The save wasn't kept.", numbered then) to Retry or Dismiss.
    - Why: a close whose rename, save and row all failed leaves exactly that.
    - Only an edit without its target is deleted.
- The transfers panel's sweep (`TransferQueue.sweep(context, infos)`) gives a job to a slot no unfinished job owns.
- Every delete that reconcile and the queue sweep make runs under the wipe's lock for the account they began for. It stops the walk once the account moved.

### Account scoping and locks

- Every write a close, cancel, landing, Retry, dismiss or reconcile makes under filesDir is made under the wipe's lock for the account it began in (`Reservations.whileAccount`).
    - `reserve`'s counter and the close's rename too, so a close after sign-out writes nothing.
- A family's cleanup deletes a slot only while the account it began for is still here.
- A family's end settles every key a slot's saves reserved under (`slot#<save>`, `TransferQueue.dropSlot`).
- A removal judges a slot's outcome by the pending save's own reservation.
- Lock order, everywhere: the copies lock (`FamilyCopies.LOCK`), then the account's (`Reservations`), then the slot's.

### Atomic files and caches

- Every file a later step trusts by its existence alone is written beside its name and renamed into place.
    - A generation's `.bin`, a rescued edit, a cache copy, a landed read copy, the numbers, the record, a sidecar.
- A failed generation write deletes what it made.
- A start deletes stale `.staged` copies.
- A failed cache download deletes its `.part`.
- The Files app's cache copies of a version (`cache/files/<id>/<version>`) come down into `cache/incoming/<random>`, named by nothing of the account.
    - They are moved into place only under the wipe's lock for the opening account.
    - If the account went meanwhile, the download is deleted and the open fails.
    - A start deletes downloads a dead process left there (idle for ten minutes).

## Families

Plan: `docs/groups-mobile-plan.md` ("Android 1 to 6"). The Android code is the twin of the iOS families work (iOS 1, iOS 3 as #243 rewrote it, and #244's removal handling) and follows the web where iOS has no counterpart.

### Group routes

- `data/GroupsApi.kt` reads routes 2, 3, 5, 6, 14, 15, 23 and 25, and sends the managing routes (see [Managing members](#managing-members-invite-and-let-them-in)).
- `GroupsApiError`: status 0 is no answer. Only a 404 `not-member` wipes.
- `sendCall` answers a `CallAnswer` (status 0 is no answer) and never throws for a refusal.

### Sync and records

- `data/FamilySync.kt` (`Vault.families`, one per vault) is the web's `sync.ts` + `pins.ts` over the core's `AreaLedger` (`Vault.areaLedger`). A sync:
    1. hands settings to the ledger first (`useForFamilies`, `use_settings_envelope`);
    2. calls `accept_served` with the device record;
    3. stores the guard the acceptance hands back, before the record (`FamilyRecords`, `noBackupFilesDir/groups/<user>_<group>.json`, never over a later roster version);
    4. opens route 25's folders with `open_family_area` and lists them through the ledger;
    5. settles the settings pin by compare-and-set (`saveGroupPin`, with the `familyChecks` marker and `before` records in the same save, `FamilySettings.kt`).
- One family at a time (`exclusive`, a `ReentrantLock` per family).
- The core takes user ids lowercase (`Vault.familyUserId`). The web fixture's account id is uppercase, so tests depend on it.

### The family guard

- `data/FamilyGuard.kt`: `noBackupFilesDir/guard/<slot>.families.json`.
    - Sealed with `contact_guard_seal` kind `families` under the settings key, its envelope beside it.
    - Written under the contact guard's lock and generation.
    - Merged with `merge_pin` and never lowered.
    - Deleted with the contact guard on every wipe.
- Only a confirmed `NoSuchFileException` reads as absent (`GuardFile.read`, also used by the contact guard). Any other read error is `GuardUnreadable`.
- A not-member wipe goes through `forget_group` two-phase (`forgetInCore`) and keeps the guard.
- The write barrier (`familyGuardOwed`) goes up before `accept_served`/`accept_joining`. It comes down only once the guard is stored.
    - `refuseFamilyWrite` (every write's entry), `sendingIntoFamily` (before each send) and `requireGuardKept` check it.
- A guard is owed per acceptance (`GuardDebt` in the session's `guardDebts`).
    - Shared by every vault of the session, whose syncs and turns are separate.
    - An acceptance discharges only its own debt.
    - One whose guard couldn't be stored stays owed, holding the barrier, until a stored guard covers its pin (`mergePin` behind, or merged without moving ahead), or its own vault's core lets the family go.

### Family sessions

- A session's family state lives in `FamilySessions`: proven folders, holds, owed guards, invalidations, purges, and its end.
- It is shared by every Vault of the session in the process: the app's, the Files app provider's, and each job's `jobVault`.
- It is seeded from the device records' folders (`seedFamilyAreas`).
- Closing a vault ends it for all; the next vault starts a fresh one.

### Family workspaces and what shares left

- Nodes of a family workspace open only through `open_listed_node` (`Vault.open`), and are served only when the ledger opened them (`NodeCache.viaLedger`).
- A share into a proven, let-go-of or still-held family workspace is refused at mount.
- The last check before anything is kept is made under `FamilyCopies.LOCK`.
    - That covers a share's root, a row opened under other keys, and a write's answer.
    - Route 25's proof (`noteFamilyWorkspaces`) and every forget take the same lock.
- `familyNodes` keeps their workspace, so a folder whose family let go of it is listed there again and refused by the core.
- Proving a workspace (`noteFamilyWorkspaces`) empties it of what a share left of it:
    - kept files and folders (`Offline`);
    - the whole `opened/share/<workspace>` folder, where a received share's opened copies go (`Vault.openedCopyFolder`);
    - copies under `opened/`, `files/` and `edits/` by node id;
    - through `drainFamilyPurged`, On this phone's rows and thumbnails.
- The own drive's opened copies stay at `opened/<node>`. Flat ones the mirror doesn't hold are swept at start.

### Joining and checking

- Joining (`data/FamilyJoin.kt`): `join_first_use`, the v4 joins record, `accept_joining`, then guard, record, folders and pin.
    - A relaunch finishes from the joins record.
    - A join that lands schedules the family work at once (`FamiliesModel.joined`).
- `/join#invite=` parses as an `AppLink.Join`.
    - It reaches the app both as `hushos://join` and through the verified https filter's `/join` path.
    - `LinkFilterTest`: the manifest hands it to `LinkActivity`, and nothing the app can't do (such as `/join/other` or billing) leaves the browser.
- `data/FamilyCheck.kt`:
    - `memberStandings`: one guarded read (`guardedStandings`);
    - `checkCode`: the sync's outcome handed back;
    - `checkMatch`: `pair_match`, with the check record and a verified pin committed as any trust act.

### Writes in family folders

- Family folders allow a new folder, an upload, a rename, a move within the folder, a move to or from one's own files, Move to Trash and its Undo (back in place only), and a new version (an upload's Replace).
- A move between one's own files and a family folder, either way, is `Vault.moveAcross` (the web's `lib/move-across.ts`):
    - each file is downloaded at the version read and uploaded under the destination's keys with `moveOf` on begin (`MoveOf`, signed as a copy by `movePrior`);
    - the server deletes the source in the transaction that completes the upload. Nothing goes to the Trash; a source that changed fails `stale` and stays (`movedMeanwhile`);
    - a folder is made at the destination (`createFolder(moving = true)`), its files moved one by one, and the source folder goes to the Trash once the server lists only folders in it. Never purged.
- Each Vault write runs in `writing {}` (`writingSuspend` for the batches).
- It decides at its entry, per workspace, whether it writes as a family's (`familyTarget`). `WriteIntent` records it. A family write needs:
    - the folder proven by route 25;
    - held by this vault's ledger;
    - the guard kept;
    - the core's `require_writable`.
- Family writes take keys from the ledger only:
    - `new_node_key` (dropped with `forget_node_key` when the server refuses);
    - `writable_node_key` at the epoch opened (`writableKey`);
    - `rewrap_node` for a move.
- A record signed again (a rename's, a replacement's name) takes its form from `FamilySync.prior`.
    - That is the core's `copy_form` over the guard-filtered pins (`trustAndPins`, never the raw settings pins).
    - It is asked of the sync that registered itself as the vault's `familyJudge`.
- A write's answer is kept as the ledger's row (`viaLedger`).
- What family folders don't offer is refused by `refuseFamilyWrite` (`FamilyUnavailable`, iOS's words):
    - sharing, links, reports, keeping, versions;
    - copies in or out (a move in or out is `moveAcross`), a walk;
    - a restore under the account's top folder.

### The final write gate

- Every write's last word is `DriveApi.beforeWrite` → `Vault.finalWriteGate`, right before it is sent and under `FamilyCopies.LOCK`.
- It refuses:
    - a closed session;
    - a workspace held by a family whose guard is owed;
    - a family folder the write didn't decide at its entry to write as the family's (begun on a share's or this account's path);
    - a write whose folder was let go of since it began.
- A family write passes `familyTarget` again. Only reports and upload aborts skip it.

### Family uploads

- Uploads into family folders go on the transfer queue (`TransferQueue.upload` with its `Family`, tagged `family:<group>`) and finish after the app closes.
- The job's own vault accepts the family itself on every run (`FamilyUploads`).
    - Through `Vault.jobFamilies`: a `FamilySync` that never sweeps family copies.
    - It lists the folder through its ledger, then uploads through the same write path.
- A family route 2 no longer lists, with no not-member come back, is asked about directly (`FamilySync.notMember`, route 5).
    - So a process that died between the family's wipe and the end of its uploads, leaving no record, still ends them as a removal.
- Group routes that don't answer, and a 408, 429 or 5xx inside the family's sync (`FamilySync.Failed.transient`), make the run the network's.
- A completion refused because a key change reached the file or its folder while the parts went up is `KeyChangeConflict` in a family upload.
    - The server answers 409 `conflict` with `data.conflicted` (`packages/db/src/drive.ts` `finishCompleting`); `ApiError.data` keeps it.
    - It is waited out like `rotating`: aborted, the family opened again and the file sealed afresh.
    - For a new version it counts only while the server's `currentVersionId` is still the version replaced. Someone else's newer version stays an ordinary conflict.
- A key change not reached yet is waited out inside the run: the ledger's refusal, the server's 409 `rotating`, or `stale` once waited.
    - A look every 30 s (`FamilyUploads.waitingOutKeyChanges`), for half an hour.
    - Its row says "Finishing a key change…" (`KeyChangeWaits`, kept across runs).
    - The wait is the job's own (`runUpload`'s `waitKey`, the worker's id), never its ledger key's. A Retry starts its half hour afresh, and its row says so.

### Ending a family's uploads

- A removal ends every queued upload of the family (`TransferQueue.endFamily`), from the app's sync or a job's.
- Each job's reservations are settled first.
- A job whose upload landed after all ends as uploaded, never as a failure, and a failed row of it is removed.
    - Landed means settleJob's LANDED, a landed row, or a `LandedJobs` mark; `dropJob` says so.
    - Whichever settle hears it counts (the first, or dropJob's).
    - Its `LandedJobs` mark says so; it stays while WorkManager still lists the job.
    - The panel never rebuilds a row from its FAILED WorkManager entry (`TransferQueue.recordUnrecordedFailures`).
- Each other queued job's row is written before its job is cancelled; then its reservation is settled and its copy deleted.
- Failed jobs' copies go, and their rows say so.
- It ends by moving `FailedTransfers.changes`, which the panel's `watchQueue` combines in.
    - Why: WorkManager's own updates miss a family whose only uploads had failed already.
- It is tied to the session that found the removal, and ends only that account's jobs.
    - It writes each row under the lock a wipe moves the generation in.
    - It stops, before and after every step that can block, once that session isn't the one signed in or its caller stopped.
    - The app's cleanup is cancelled with its vault.
    - So an old account's removal never touches a new account's uploads.

### Family screens

- `ui/FamiliesModel.kt` (`DriveViewModel.families`):
    - route 2 with `listReconciling`;
    - each family's state and marks;
    - the removal bookkeeping in `FamilyFolders`;
    - the invitation and member-check sheets `Main` draws, so they outlive their screen.
- `ui/Families.kt`:
    - Account's section;
    - the family page, with members and Verified/Not verified, and the hard warning;
    - `FamilyRoute` in Account's one saved value;
    - the folder through `BrowseScreen` with family gates: no add, select, paste or folder menu. A removed folder says so, with no search.
- `ui/FamilyJoin.kt` (`InvitationSheet`, `JoinContent`) and `ui/FamilyCheck.kt` (`MemberCheckSheet`).
- A family item is `Owner.EDIT` while `FamiliesModel.writable`: accepted, openable, `AreaWrite.WRITABLE`.
    - Its menu is Send a copy, Rename, Move, Info and Move to Trash.
    - Move starts at the family's top folder. All places lists Files and every writable family folder (`FamiliesModel.writableTops`); a share is offered only to items already in it, and items in a share never leave it.
    - No paste, Copy or Save a copy there.
- Test: `FamilyWritesTest`.

### Leaving a family

Follows the web's `family-leave.ts`.

- Leave family (route 20, `GroupsApi.leave`) sits under Leaving on the family page.
- It is disabled with `FamilySync.leaveBlocker`'s reason (the web's `leaveBlocker`):
    - "Make someone else the organizer first."
    - "Let someone else manage the family first."
- A refusal says the web's words (`leaveWords`; the payer's in the server's own).
- `ends-lapsed` names the plans (`FamilyLapsedPlan.endsWhenYouLeave`, the web's `lapsedEndsWords`), and the next press confirms them by id.
- A leave that lands runs the not-member wipe (`removedNow`):
    - keys, device record, rows, opened/family copies;
    - the sealed thumbnails `forgetWorkspaces` drops from the mirror;
    - the settings pin and the family guard stay.
- The dialog's state is the model's (`LeaveAsk`: family, request under way, named plans, words; `askLeave`/`confirmLeave`/`dismissLeave`), drawn by `FamilyPage`.
    - So a rotation or a fold redraws it as it was.
    - A second press while a request is under way sends nothing.
- A landed leave sets `leftFamily` and the page moves on.
    - It reads the account's storage and plan again (`FamilyHost.accountChanged`), so Account stops showing the family's pool and plan.
- Test: `FamilyLeaveTest`.

### Walks (key rotation of family folders)

Follows the web's `walks.ts` and runRotation's family case. Code: `data/FamilyWalks.kt`.

- Route 25's `rotation` is parsed (`SpaceRotation`, carried on `FamilyArea.rotation`).
- `ownReasonToWalk`: the top folder listed at the run's target under the latest key.
- `FamilySync.walk`: one walk per folder in the process (`FamilyWalkLocks`). A run route 25 no longer names was ended elsewhere.
- `Vault.walkFamilyFolder` runs in `writing {}` with `familyTarget` at entry, and `rotate_node` per node.
- Never send a node beside its parent in one batch (`deferChildren`).
    - Why: the server judges each node on its own, so another device can win the parent while this one wins the child, sealed under a key nobody kept.
    - Children go once the parent's key is confirmed.
- Parents not open at the target are opened by listing them (`openWalkParent`).
    - In or under a trashed folder, they come from the folder's change feed from cursor 0 instead. The children route refuses those, and the trash listing names only folders trashed themselves.
    - The feed is followed to its end with no page bound, and stopped once every row above them, up to one the ledger holds, is in.
- Every send goes through `DriveApi.beforeWrite`'s final gate, after `requireWriteStands`.
- `rotate_commit` only for what the server applied, and `rotate_drop` for the rest.
- The batch holds `FamilyKeyLocks` for the folder from its first fresh key to the last committed or dropped.
    - `Vault.newNodeKey` and a move's re-wrap derive keys only outside it.
    - Why: the core's `wrap_key_for` prefers a pending key, so a write meanwhile could be sealed under a key another device's win makes the server refuse.
- Sent rows are forgotten, to be opened again through the ledger.
- `FamiliesModel.startWalks` walks what an accepted sync finds, with the web's backoff (`walkWait`).
- The family page shows the web's KeyChangeNotice words (`KeyChanges`).
- Test: `FamilyWalksTest`. FakeDrive keeps previous keys, `prevKeyEnvelope` and re-keyed origins; `FamilyFixture.replaceKeys` is Sam's member list re-keying the folder (option A).

### Background family work

- `data/FamilyWalkWork.kt`: a periodic WorkManager job (hourly, network) while the account is in a family.
    - Plus a one-time job whenever the app finds a walk due or one stops.
- It uses the app's vault when one serves the session (`LiveVaults`: one ledger and one family turn in the process); else a vault of its own.
- Every wipe of a family is queued in `FamilySync.takeRemovals` (`publishRemovals`), whoever runs it, the background work through the app's vault included.
    - Wipes come from a sync's not-member, route 2's reconciliation, a member check, a join or a leave.
    - So is a wipe that couldn't finish (`FamilyState.Failed.removal`).
    - So is any refusal a sync met (a fork, an unchecked chain, a rollback: everything but accepted and no answer).
- The model shows them as its own sync's would be (`applyRemovals` → `show`), and is told (`onRemovals`), so the screens let go of them too.
- An unfinished wipe on a listed family makes the background pass RETRY.
- A WorkManager stop (its window, the network lost) cancels the worker's coroutine but not the blocking pass.
    - So the pass takes `checkStop` (JobStopped, as the transfer workers' `stoppable`).
    - It checks it between families, walks, batches and feed pages, never with a batch's keys pending.
    - A stopped pass sends nothing more, leaves no folder locked, and answers STOPPED (retried).
- A pass answers RETRY for no answer, 408, 429 and 5xx, from route 2 or a family's sync (`FamilySync.transient`, `FamilyState.Failed.transient`).
- Jobs are per session: a tag, unique names, and input carrying `FamilyWalkWork.sessionKey` (a digest of account and token).
    - A pass works and stops only while its vault is open and still the session signed in (`current`).
    - Stops cancel only its own session's jobs; a job of an ended session does nothing.
- The jobs are cancelled on sign-out, account wipe, and once route 2 lists no family and this phone keeps none (`FamilySync.unsettled`).
    - A family it still keeps whose not-member never came (no answer, a wipe that couldn't finish) keeps the check scheduled, and the pass answers RETRY.
- To prove it live, advance the clock past the period.
    - WorkManager re-checks a periodic job's own period, so `cmd jobscheduler run -f -n androidx.work.systemjobscheduler com.hushos.app <id>` alone runs nothing.

### Managing members: invite and Let them in

- Routes used to manage a family:

| Route  | Use                                              | Where                 |
| ------ | ------------------------------------------------ | --------------------- |
| 7      | Mark the departed left                           | `markDepartedLeft`    |
| 8      | Key seal                                         | `GroupsApi`           |
| 11     | Invite, never with roles                         | `GroupsApi`           |
| 12, 13 | Open invitations, cancel                         | `GroupsApi`           |
| 16     | Pending, the served identity as `PublicIdentity` | `GroupsApi`           |
| 17     | Admit                                            | `GroupsApi`           |
| 18     | PATCH, for roles                                 | `GroupsApi`           |
| 19     | Remove a member                                  | `removeMember`        |
| 20     | Leave                                            | `GroupsApi.leave`     |
| 22     | Grants                                           | `GroupsApi`           |
| 24     | Key replacement                                  | `replaceKeys`         |
| 26     | Turn down                                        | `GroupsApi`           |
| 27     | Hold                                             | `removeMember`        |
| 28     | Previous root repair                             | `repairPreviousRoots` |
| 29     | A folder to gather for rotation                  | `gather`              |
| 30     | Delete a family folder                           | `deleteFolder`        |

- Let them in: `letIn` in `data/FamilyManage.kt`.
    - It pins the newcomer first-seen (`firstSeen: "family"`) from route 16's identity, or hands back `Changed` for the account-change notice (`FamilyHost.accountChangedFor`).
    - It sends that person's kept entry first (`sendKept(only =)`). Another person's is `Other` and untouched.
    - It returns `Pending` while the entry stays unanswered. It signs anew only after a definite `stale` or a superseded roster.
    - Then it stages the core's `admit_body` as the web's `stageLocked` does, and sends it, at most three rounds.
- Staging an admission:
    - the family synced first, in the same turn;
    - route 3's head checked against the chain that sync accepted, and synced again if another manager's change landed in between;
    - the person's keys read afresh from route 16, so a row drawn before their account changed, and this phone's Continue, never stage the old ones;
    - the group key opened when the core asks.
- The core does not check `expectedRevision` against its chain, so the head check is the only guard.
- The core lets in over a first-seen pin (see `crates/hushos-core/AGENTS.md`).
- Route 16 rows whose served identity doesn't read whole fail the list. Route 3 without a head refuses staging.
- A kept admission for keys the account has since replaced is `OtherKeys`: held, never sent. Let them in offers to drop it (`dropKeptAdmission`).
- Let them in that meets `stale` and finds the person off route 16 is a landing only when the synced member list has them active (`admittedNow`).
    - A list read without them says they aren't waiting any more (another manager turned them down).
    - A sync that didn't read says "Couldn't check {family}. Try again."
- Not now deletes every kept admission of the person first, in the family's turn, and only then sends the decline.
    - A lost answer or a failed delete never leaves one to replay.
- Not-member, from the admit route or any read Let them in or the resume makes, goes through `removedNow` (two-phase, published to the screens).

#### Seats and refusal words

- A phone never buys a family place.
    - The server refuses an admission that would need one as 402 `seats`/`full`, decided from `HushOS-Client`, which every resend carries.
    - `callWords` says the web's seats words, `full` as "Every place in {family} is taken.", with no billing link.
- `callWords` says the web's `refusalCopy` for every code route 17 answers (`pool-full`, `in-family` and the rest of `chainAnswer`, the route's 426/429/413).
    - "Reload and try again" is said as "Try again".
    - Only a code-less answer is the generic retry.
    - `pool-full` drops the web's "or move to a bigger plan": billing is read only on phones.

#### Manager screens

- The family page shows Invite someone and Waiting to join to a manager (`FamiliesModel.manages`: own entry with `members`), and Invitations under the members.
- The invite, turn-down and cancel dialogs are the model's (`InviteAsk`, `turningDown`, `cancelling`).
- The invite address lives in the model's `InviteAsk`.
    - Never `rememberSaveable`, which would keep it in the saved-state bundle outside the account wipe.
- A 401 from invite, Not now or Cancel invitation goes to `lostSession`.
- A manager's lists that fail to load keep the rows last read and say why above them, with Try again (`managedErrors`). A 401 goes to `lostSession`.
- Pull to refresh on the family page is `refreshPage`: the families checked, then a manager's lists read again.
    - An accepted invitation changes who waits, not the member list.
- A kept Let them in says "Saved on this device." and its reason in the existing words (no answer, a rate limit, grants still owed), never a promise.
- Not built yet:
    - the invite's Let them manage the family;
    - Check it's {first} first on a waiting row;
    - the automatic Let them in after Continue (the manager presses it again);
    - seats and the join code.

#### Notices

- One notice is on screen at a time (`DriveState.notice`), kept by `ui/NoticeQueue.kt`.
- Until-read notices wait their turn and come back after a passing one.
    - So the refusals a resume meets (shown until read, one each) are never replaced unread.
- Cleared on every sign-out.
- Tests: `NoticeQueueTest`; `FamilyManageModelTest`'s host shows notices through the same queue.

### Roles and the organizer handover

Follows the web's MemberList.

- A manager's member-row menu adds Let them manage the family / Stop them managing the family.
- For the organizer it adds Make them the organizer.
- Each is confirmed with the web's RoleConfirm words (`RoleAsk`, `RoleKind`, `FamiliesModel.askRole`/`confirmRole`, `RoleConfirmDialog`).
- Let them manage the family and Make them the organizer, for someone this phone hasn't verified, ask Check it's {first} first (`CheckFirstDialog`; the web's `needsCheckFor`).
    - It opens the same check as the row (`personalCheck`: their own words when their account changed).
- Before staging either promotion, `callFor(check =)` reads their standing again from the settings and this device's guard, over the member list just synced (`memberStandings`).
    - Anything but Verified is `RoleEnd.CheckFirst`.
    - A guard that can't be read throws, and nothing is signed.
- The core's `roles_body` refuses an unchecked `members` grant too.
    - Billing is the app's check alone, as on the web: the worker's rule covers `members` only.
- `changeRole` (route 18, PATCH, `roles_body`):
    - Grant seals the key to them.
    - Take carries the succession and seals the new key to every manager who stays.
- `handOver`: billing `To` them, then `StepDown`.

#### How a role call runs

- `changeRole` and `handOver` go through `callFor`, which sends that person's kept call first (`sendKept(only = ChainRoute.Member)`).
- Kept calls on that route are told apart by what they do (`RoleOperation`: grant, take, billing to them, step down).
    - The operation is kept in the entry's own file with it (`FamilyOutbox.Kept.operation`), since all four share the route.
- Only the same operation is this call's own. An unanswered one stays the only one.
- Another operation's end is never said as this one's: it goes to `keptEnds`, and this one goes on.
    - Landed or overtaken, a request the member list then already satisfies is done.
- While another operation is unresolved, this one is Waiting.
    - Except the handover's billing step (`waitsKept`): it stays Pending, with its record kept unstaged, so the next open goes on with it.
- A settings read that doesn't answer is Pending only for the caller's own call (its person read from the entry).
- `stale` signs again over the winner. A change that no longer changes anything after a landing or a win is done.
- A sync that got no answer while staging throws (nothing signed, a handover waits) instead of reading as a refusal.
- An ended session's answer to a role change touches nothing of the next session's.
- A role change that doesn't land or fails part way, and a resume that met any handover outcome or failed, read the family again at once.

#### The handover record

- The handover is kept on the device before its first call (`FamilyOutbox.markHandover`, `<user>_<group>.handover`).
    - Marked `staged` once billing's call is kept.
    - Left as it is when the same handover is confirmed again, so a second press never unstages it.
    - So a refused or overtaken billing call is never signed afresh.
- One this attempt made and never staged goes when a read before staging throws.
    - So the next open never hands over a handover the screen said failed.
    - Unless billing's call to them is already kept (`billingKept`: an entry tagged billing-to, about them), which is staged in fact.
- Whatever the marker says, billing's call ending marks the handover staged before its entry goes.
- Its step down refused for good retires the handover.
    - Both stay organizers; Finish handing over to {first} is the person's to press.
- A handover stopped between its two calls is finished by the next resume (`finishHandover`).
    - `handed` is told whatever it came to, pending included, before the record goes or is kept.
    - The family page reads the family again on any outcome.
- One that couldn't be staged yet (a change for them still waiting) goes on from its start once that change ends.
- `deleteGroup` takes the record with the family.

#### Never two organizers

- A new handover while one to someone else is unfinished settles that one first (its kept calls sent, its last step taken). It is refused while that one still waits.
- While this account and another both hold billing on the synced member list (record or not):
    - the page offers Finish handing over to {first} (`handoverToFinish`, `finishHandingOver`: the last step alone);
    - it hides Make them the organizer;
    - billing to anyone else is refused ("Finish handing over to {first} first").
- That is checked in the staging callback on every freshly synced member list (`callFor(before =)`): a first attempt, a re-sign after `stale`, a resumed handover.
    - The handover's record is then dropped.
    - So is a handover by an account that no longer holds billing there ("{first} is the organizer now").
- The step down is for the person it was handed to only (`stepDown(to)`).
    - On every freshly synced list, a recipient who no longer holds billing (moved to someone else by another device) stops it.
    - This account stays the organizer, and the words say "{first} is the organizer now" (naming who holds it), or "Make someone else the organizer first".

#### Testing PATCH

- Unit tests send PATCH through the JVM's HttpURLConnection, which lacks it.
- `FamilyFixture.allowPatch` adds it in the test JVM (`build.gradle.kts` opens java.net for tests only).
- Tests: `FamilyRolesTest`, `FamilyManageModelTest` (the role flow; an overtaken admission said when a later call throws).

### Removing members and deleting family folders

Follows the web's `removal.ts`, `rotations.ts`, `outbox.ts`'s rebuild and `spaces.ts`'s deleteFamilyFolder, over the core's 5b builders. Code: `data/FamilyRemoval.kt`.

#### `removeMember` (route 19)

1. The removal preview (`remove-preview`) first. `ends-lapsed` plans are confirmed by id.
2. `demoteFirst` takes `members` from them first (the way out of their hold).
3. The hold (route 27) before anything is read, and again before each walk and each gather.
4. Any walk running in a folder is finished (`walk`).
5. Then `removal_body`.

- A kept removal of them goes first; a second press signs nothing new.
- `left-due` marks the departed left (`markDepartedLeft`, route 7) and removes again.
- `stale` is built over.
- `members-changed` is said as changed.
- Steps (`RemovalStep`) and outcomes (`RemovalEnd`) are the web's.

#### Other calls and due work

- `deleteFolder` (route 30, `area_delete_body`).
- `replaceKeys` (route 24) and `markDepartedLeft`, for route 3's due. Route 3's `due` is `GroupDetail.Due`.
- `runDue` runs on a manager's open, after `resumeOutbox`:
    1. `due.markLeft`;
    2. `due.rotations`;
    3. `repairPreviousRoots` (route 28, `previous_root_repair`, from route 25's root).
- Nothing of due work is staged while the outbox still holds an entry (`DueDone.deferred`).
    - Why: a new roster would overtake a kept removal, which the next resume would drop as superseded.
- A removal meeting `left-due` likewise waits (Pending) while another change is kept.

#### Gathering

- `gather` puts route 29's top folder, as a walk maps it (`rotating`), under the next key version. No shares or links are handed on.
- The epoch is drawn after it was read (`Vault.drawFamilyEpoch`, a family write decided at its entry).
- Document kinds come from `folderKinds`, the one answer for staging, rebuilds and rechecks:
    - `tags`;
    - every kind the call's rotation of that folder already carries;
    - any kind a 409 names. A kind once named is never dropped by a later rebuild or recheck.
- Live folders are the committed chain's (`FamilySync.liveAreas`), never route 25's list.
- The rotating builders get `Vault.accountKeyVersion()`, never the identity's.

#### Removal screens

- A manager's member menu ends with Remove from family.
    - Disabled, with the web's removeBlocker words, for the only billing holder.
- `RemoveDialog` is one dialog through confirm, the plan's confirm, the steps and the outcome (held, with Stop managing, then remove; changed; pending; failed).
- A family folder row's menu has Delete family folder (`DeleteFolderDialog`, snackbar `“<name>” is deleted`).
- The left-due notice (`due.markLeft`, names from route 3's members whatever their state) says the phone is finishing it (`dueRunning`), or will at the next check.

### The family outbox

Code: `data/FamilyManage.kt`.

#### Files

- `FamilyOutbox`: `noBackupFilesDir/groups/outbox/<user>_<group>_<outboxId>.call`, under `FamilyCopies.LOCK`, wiped with `FamilyRecords.deleteAll`.
- An entry is one file, `<user>_<group>_<outboxId>.call`: a JSON envelope of the core's sealed entry, its recheck marker and its notes.
    - Written beside and moved over in one rename.
    - So no crash leaves a marker or notes describing another version of the call than the one on disk.
    - An older file holding the sealed entry alone reads as that entry, settled, with no notes.
- `<user>_<group>.handover`: the handover record.
- `<user>_<group>.removals`: removal intents.
- `<user>_<group>.unsaid`: words to say about a landed call.
- A wipe takes the family's outbox entries with it (`FamilyOutbox.deleteGroup`, the web's `forgetGroup`).

#### No failure reads as absence

- An outbox folder or entry that can't be read throws `OutboxUnreadable`.
    - Never an empty or partial list, so nothing is signed again or skipped.
- A write or delete that doesn't hold throws `OutboxUnsaved`. Both words live in `GuardWords`.
- Only an entry read whole that the core then can't open (Sealed) is lost, with a notice.
    - That is an entry sealed before a master-key change. It is deleted and said lost in the web's `changes-lost` words.

#### Sending kept entries (`sendKept`)

- Before every attempt, the settings pin is read again (`familyPin`) and the entry opened with `outbox_open`.
- The same bytes are sent each time. `outbox_step` decides:

| Answer                   | What happens                                                      |
| ------------------------ | ----------------------------------------------------------------- |
| No answer, 5xx, 408/429  | Resend up to three times, then kept as `Pending`                  |
| `send-grants`            | Post `grants_body`, then the same bytes                           |
| `grants-due`             | Post every owed grant or none (`sendGrants`), then the same bytes |
| `stale`                  | Drop and sync                                                     |
| Landed, moved or refused | Drop                                                              |
| `wiped`                  | Run the not-member wipe                                           |

- A member whose ML-KEM key route 6 doesn't serve makes `sendGrants` post nothing.
- Route 22's not-member is a removal.
- A settings read that fails sends nothing.
    - Why: the ledger would judge against the pin it read last, which another device may have replaced.
    - No answer or a server error keeps the entry `Pending`. Anything else is thrown, with the entry kept.
- Syncs inside the outbox are `syncRevised`, so whatever they let go of is published too.
- `sendKept` finishes any recheck marker before it sends.
- The resume is lossless: `sendKept` hands every outcome that drops an entry to `told` before deleting it.
    - The model turns a refusal into an until-read notice there.
    - `told` has the route, so the resume says an overtaken call before its entry goes: an admission in the web's `admission-dropped` words, a role change in the web's `stale` words.
    - A kept removal or deletion another change overtook (`Stale` on resume) is said as a role change's is.

#### Resuming

- `resumeOutbox` sends what a kill or a lock left.
    - The family page runs it before it loads.
    - `FamiliesModel.loadManaged` says each refusal, and re-reads the family after a landing.
- `loadManaged` runs in `familyScope`, never the page's effect. So leaving the page, or a later entry that throws, loses nothing.

#### One kept call per family

- `stageCall` is the one staging entry point of every roster call: admit, roles, the handover, remove, mark-left, key replacement, deletion.
    - `stageAdmit` is `stageCall` with route 16's identity.
    - It syncs first, checks route 3's head, reads ML-KEM keys, and opens the group key when asked.
- It first sends every kept entry of the family. What they come to is queued in `FamilySync.keptEnds` and said by the model.
- It stages nothing while any entry is still unresolved (`Staged.Waiting`).
    - A removal is Pending with its intent kept; anything else is refused with `earlierWaiting`.
    - So a family holds at most one kept call, and `finishHandover` waits too.
- An admission held for other keys (`OtherKeys`) whose person no longer waits on route 16 (per reads that answered) is retired (`retireOrphan`).
    - One in the synced member list retires as landed (quiet).
    - Otherwise as `Stale`, said in the approved "An earlier admission of {first} wasn’t sent; let them in again."
    - One still waiting stays held, dropped from its row (Drop it and let them in).
    - So a held entry nobody can drop never blocks the family.
- Definite answers are never swallowed by a catch:
    - route 16's not-member there is thrown to `notMemberLetsGo` (wiped and published);
    - a sync that let go of the family is `Wiped`;
    - so is not-member in `whoHolds` and in a hold's `members-changed` re-sync;
    - invite, invitations, cancel, pending and Not now let go of the family on not-member (`notMemberWipes`) before throwing it.

#### Paired writes across files

Ordered so a crash between them is safe:

- the intent's link before the entry (an intent with no entry is staged anew);
- the intent's retirement before the entry's deletion (the entry left replays to the same end);
- the unsaid words before the entry's deletion (said once: `takeUnsaid` drops repeats).

#### Rebuilds and rechecks

- `REBUILD` gathers again and calls `outbox_rebuild` (same roster, keys and self-grants), keeps the new entry under the same id, then sends.
    - `rotating` walks the named run first, only in a folder the call rotates.
    - `epoch-stale`/`root-moved` gather every rotated folder.
    - `document-stale` gathers the named folders and kinds.
    - A removal's hold is placed again first.
- Documents the core carried on empty are read again once, at staging and in every rebuild (the web's refetchReplaced, `finishRecheck`).
- A staged entry carrying emptied documents, and every rebuilt entry, is written with its marker (`FamilyOutbox.put(recheck =)`, `FamilyOutbox.Recheck`: the folders rebuilt and the documents carried on empty).
- `finishRecheck` reads those documents again once, then `FamilyOutbox.settle`s it in one write:
    - the call marked as rebuilt;
    - the rebuilt folders' notes rewritten to what it now carries on empty, per folder (a document a later rebuild read fine loses its note);
    - no marker.
- What still doesn't open is noted in the entry's own file by folder, deleted with it.
- Those words are said once the call lands, whichever open or process sends it (`FamilySync.takeCleared(groupId)`, the model's `sayCleared`).
    - They are kept in `<user>_<group>.unsaid` from the landing until the screens take them.
    - Due work says them before handling a failure.
- `CallEnd.Refused` keeps the server's code and data.

#### Removal intents

- A confirmed removal is kept as an intent in `<user>_<group>.removals`, written by `removeKept` before any read or call. It is kept until a definite end: landed, a server's refusal, the person gone, plans changed and asked, the account removed. It holds:
    - whom;
    - the confirmed plan ids;
    - demote first;
    - the membership confirmed, by content and version (`FamilyOutbox.Membership`: the entry's version, roles and keys' commitment).
- The membership is bound two ways:
    - `confirmed`: the entry on the row pressed (`FamilyMember`);
    - `demoted`: the entry its own demotion leaves, written before that demotion is staged.
    - `demoted` has the same keys, the roles without `members`, at the member list version it takes: the version of the list it is staged over, plus one.
    - Never the chain's revision, which a standalone succession moves past it.
- Every entry a removal stages (its demotion, a mark-left, the removal) is linked to its intent before it is written (`stageCall`'s `beforeKept`, `Removal.outboxId`).
- `sendKept`'s `finish` retires the intent with the entry's end when that end is the removal's own:
    - its removal call landed, refused or overtaken;
    - any of its entries refused or lost unopened.
- A step that landed or was overtaken keeps the intent: the removal goes on, bound.
- So does a refusal that only means "not yet" (`removalGoesOn`: `left-due`, `busy`).
    - It ends the call and leaves the continuation to mark the departed left (or wait the moment out) and remove again.
- Plans confirmed after `ends-lapsed` go on with the same removal.
    - `RemovalEnd.EndsLapsed.carried` hands its bindings to the plan's confirmation (`ConfirmPlan.carried`, `removeMember(carried =)`).
    - Only the plan ids are new, so a demotion already made stays its own.
- A pending end of the removal's turn writes the turn's intent again (`RemovalTurn`), since an entry it went on from may have retired it.
- Every read the removal acts on, and the builds over the list they sign, check the binding (`Removal.bound`: an exact match of one of the two).
    - Any other entry ends it as `Moved` while they are still in the family: a role or key change, leaving and being let in again, another manager's account-change continuation at the version the demotion would have taken.
    - `Moved` is said in the web's members-changed words: "{family} changed while you were working on it. Try again."
    - It is `Changed` ("isn’t in {family} any more") only once they are not in the family.
    - The server's `members-changed` is told apart the same way (`membersChanged`).
    - Nothing is staged then.
- An intent without a binding (kept before bindings existed) is never acted on.
- Every failure that may pass is Pending and keeps the intent:
    - a sync or hold with no answer, or the server's "for now";
    - a fork, or a family that couldn't be checked;
    - `Staged.Refused(retry)`, a demotion's `RoleEnd.Refused(retry)` or `RoleEnd.Waiting`;
    - a stale mark-left, or kept changing;
    - a thrown failure that is `FamilySync.transient`.
- Any other thrown failure is said as it is and keeps the intent too: the call may be kept already, and the next open tries again.
- `resumeOutbox` continues it once nothing is kept (`continueRemovals`, `continued`). The model reads the family again after any continued end.

#### Removal tests

- `FamilyRemovalTest` (each case mutation-checked):
    - every live folder rotated and granted only to those who stay, the folder opening at its new key;
    - the hold before any read and again before the gather;
    - a held manager sends nothing and names only route 3's holder;
    - a lapsed plan asked first;
    - an unanswered removal kept and resent, never re-signed, across a relaunch too;
    - `epoch-stale` and `document-stale` rebuilt under the same roster and keys;
    - `left-due` finished on the phone, then the removal;
    - `due.markLeft` and `due.rotations` done at the next open;
    - a deletion is one tombstone;
    - due work waits while a removal is kept, and a removal's mark-left while another change is;
    - a document that stops opening in a rebuild is read again and said when the call lands after a relaunch;
    - a kept removal holds every new call back and goes first after a relaunch;
    - an entry with emptied documents is never sent before its recheck, after a relaunch;
    - a removal stopped by a departure goes on after a relaunch;
    - a first removal whose sync gets no answer is kept before anything is asked, and removed after a relaunch;
    - a demotion that keeps changing keeps the removal;
    - a note goes when a later rebuild reads the document, after a relaunch.
- `FamilyRemovalModelTest`: a session reset drops the removal and deletion dialogs.
- `FamilyManageTest.aHeldAdmissionWhosePersonWasTurnedDownNoLongerBlocks`.
- The admission tests follow the one-kept-call gate: `anUnresolvedKeptAdmissionHoldsNewCallsBack`, `anotherPersonsKeptRoleChangeGoesFirst`.
    - The two model tests of two kept calls set one aside to build an earlier version's outbox.
- `FamilyFixture` applies 5b calls as the server does: rotation checks, the root re-keyed with its previous key, Maya's grant and self-grant, documents.
- Not tested:
    - the `rotating` rebuild (needs a walk served mid-call);
    - the repair (needs an own previous key from a Drive rotation's commit);
    - shares or links on a family root.
- Managing tests: `FamilyManageTest` (FakeDrive's admit route applies the body over `FamilyFixture`'s chain, or answers as scripted; `FakeDrive.failSettingsReads`; `FakeDrive.another` for a second newcomer) and `ui/FamilyManageModelTest` (refresh, resume notices).

### Families in the Files app

Code: `files/ProviderFamilies.kt`.

#### Roots and document ids

- One root per family, `family:<groupId>`, titled the family's name.
- Document ids: `family:<group>` (its folders) and `family:<group>:<workspace>:<node>`.
- Recent stays personal: no `FLAG_SUPPORTS_RECENTS` on family roots, as the web.
- The provider's vault fills its own ledger with its own `FamilySync(sweeps = false, tellsFiles = false)`, made with the vault under `vaultLock`.
- A root is a family that sync accepted. It holds only the folders route 25 proved and the ledger opened (`FamilyArea.openable`).
- These keep the root they had, read only, until a sync accepts the family again (`FamilyRoot.readOnly`: no create flag, direct writes refused):
    - a sync that got no answer;
    - a family route 2 leaves out without a confirmed not-member;
    - a failed family list.
- Anything else drops the root.
- Each root's folders carry the revocation count read before the sync accepted them (`FamilyRoot.Folder.epoch`).
    - A load that gets no answer keeps a cached root only while that count holds.
    - Every family request refuses a folder whose count moved, until a load accepts it again.
- Files is told when a root's title or its create capability changes.

#### Loading the roots

- Loads run off the binder thread (`familyLoads`).
- A load is due when none was made, after 5 min (30 s after a failure), or when `FamilyRootsSignal` moved.
- Any other vault's sync moves `FamilyRootsSignal`, and notifies the roots URI, when it accepts a family for the first time or publishes a removal (join, leave, removal, fork, refusal).
    - The provider's own sync never moves it, so there is no loop.
- A load tells Files of changed roots, and of each family whose folders changed (`family:<group>` children).
- Every family request first `require`s the root, loading again whenever the roots are due (the signal moved, or past their expiry).
    - So a family left in the app is refused before anything is read or written.
    - And a document Files reopens directly sees a read-only root turn writable once the family answers.
- Refreshing a family's own listing (`family:<group>`) loads the families again (`ProviderFamilies.reload`).
    - A family-root refresh loads in the background with a bounded wait.
- The provider's own load runs `endFamily` when it confirms a removal, so no save's plaintext outlives the family.

#### Rows, listings and trees

- Rows come only through `Vault.item(ws, id)` (the ledger's).
- A node this process doesn't hold (a restart, a tree URI Files kept) is found by listing, through the ledger, the folder that the parents index, or else the workspace's change feed, puts it in (`held`).
- Tree membership (`isChild`) walks up, confirming each place with the server now (`fresh`).
    - The folder last seen is listed again, and kept only if it still holds the node; else where the feed puts it. No answer refuses.
    - So a persisted tree reopens its children and refuses anything outside it, a file another device moved out included.
- A reopen whose file another device moved is found where the feed puts it before it is called missing (`relistUnlessGone`, in reads, edits and tree checks).
    - Also when the folder it was last seen in is gone or in the trash.
- Every family listing (`relist`) forgets the rows the folder no longer holds.
- Listings always come from the server: `refresh` answers false, so Files reloads.
- Notification URIs use the plain node id, so `Vault.foldersChanged` reaches them.
- Family folders have no feed. Each poll lists again the folders Files listed within the poll window, and tells those whose children changed (`refreshShown`).
    - The poll's signature includes pending saves.
- A family poll that hears a folder is gone or in the trash (not a failure to answer) forgets its rows and tells Files: the folder's listing and the one above it.
- Family listings show a pending save's size and date.

#### Reads and edits

- Reads go to `opened/family/<ws>/files/<node>/<version>`.
    - Each download goes into its own `incoming/<random>` in the folder's copies, and is kept under the copies lock.
- Edits go to `edits/family/<ws>/<node>/<random>` (`FamilyCopies.edits`).
    - Every forget deletes them with the copies, but no allowlist sweep does: an app vault's first sweep once deleted an edit under way.
- Writes (create, rename, move within the folder, Move to Trash) are the vault's family write path.
- A read or an edit that keeps the contents lists the file's folder again first (`current`).
    - So a version the queue landed from another vault is the one read and built on.
    - An edit refuses when that can't be checked.
- A family read after a landing never falls back to the row held.
- Every open of the file, `r` included, reads the pending save while there is one (`pendingRead`, a copy under the family's copies).
    - The pending read writes only under the wipe's lock for the vault's account, after the copies lock.

#### Revocation counts

- Every family plaintext the provider writes reads the folder's invalidation count before its access check, and checks it again with the session under `FamilyCopies.LOCK` before writing.
    - That covers a read's download, a pending read's copy, an edit, and a save into the queue.
    - `afterAccessChecked` is the tests' hook between the two.
- An open carries its count to its save (`epochOf`), so a family let go of between open and close keeps nothing.
- That count is the revocation count: removal, refusal, fork, a family no longer accepted, the session's end.
- The allowlist sweep of read copies moves only the copies count (`FamilySessionState.copyEpochs`).
    - It stops a download into a swept folder, and nothing else.

#### Family saves

- A closed edit becomes the file's pending save in the close callback itself (`ProviderFamilies.save`).
    - It uses `WriteBacks`, shared with the personal path: one slot per file holding only the newest save, one job per slot with its `Family`.
- The close asks nothing of the network.
    - Whatever blocks a write only for now (no answer, a guard owed, keys being checked) is the job's to wait out.
    - A family that let go of the file first deleted its edits, leaving nothing to save.
- A family save copies and syncs its generation outside the copies lock, as `.bin.staged`/`.json.staged`.
    - No look publishes or removes those.
    - It then rechecks the folder and publishes under the lock. If revoked meanwhile, the copy goes.
- A family save tells the folder's plain node id (what its listing watches).
- The job opens the family in its own vault and finds the file by workspace and node where it is now (`FamilyUploads`).
    - Listed afresh on every look of a key-change wait.
    - The folder this vault last saw it in, else the folder it was queued from, else where the feed puts it.
    - A folder gone or in the trash holds nothing, never a failure to answer.
- It keeps the reservation on the ledger, waits out key changes, and is retried until it lands.
- A removal ends it and its slot (`endFamily`).
- A family save that can't be kept in its slot keeps its edit with a retry row (`ProviderFamilies.EditKept`), which records the folder's revocation count.
    - Its Retry keeps the edit only under `FamilyCopies.LOCK`, while the folder's count is no higher than the row's and the edit is still there.
    - Otherwise it deletes the edit, and the row says not in family.

#### Proving it live

- Live-proved with a small SAF client (`ACTION_OPEN_DOCUMENT`, read or write `wt`): the release Play image has no root and no editor.
- Tests: `ProviderFamiliesTest`: the real provider under Robolectric; a slot's job run through `UploadWorker` with its slot request, under the waiting job's id.

### Plan on the family page

- `ui/FamilyPlan.kt`, `data/FamilyPlan.kt`, `GET /api/billing/groups/:id`.
- It shows the plan's tier and the pool's size, Used, Paid by (only as the server names the payer), and "Billing is managed on the web."
- Nothing while billing is off.
- Test: `FamilyPlanTest`, including a source scan: no family or account screen links to billing.

### Save to HushOS into a family folder

Code: `data/SaveTargets.kt`, `ui/SaveToHushOS.kt` (iOS's SaveTargets). Test: `SaveTargetsTest`.

- The picker lists Files' own folders, then each family this account is an accepted member of, under its name.
    - Only the folders this phone may write in: `openable` and `WRITABLE`, never the trash.
    - A family folder walks within its family's workspace.
- Every family call is the sheet's own sync (`Vault.jobFamilies`, no sweep of the app's copies).
- It runs only while the session it began in is still the one signed in (`SaveTargets.stands`, `SessionEnded`).
    - An account switched or signed out mid-sheet lists and queues nothing, in either drive.
- Before anything is queued into a family folder, the family is checked again (`SaveTargets.open`):
    - listed, synced accepted, the area writable;
    - its workspace the family's;
    - the folder there out of the trash.
- A removal, refusal or folder gone stops it in the family's words, with nothing queued. A removed family isn't offered again.
- The upload is TransferQueue's family upload (`TransferQueue.upload(family =)`); the job opens the family again before it seals.
    - So quota and pool errors are the queue's own lines.
- The last folder keeps its family (`Places.Folder.groupId`/`workspaceId`: both or neither; half is none).
    - It is checked again before it is offered.
- The launcher shortcuts keep to your own drive.
- A family folder isn't saved into offline: it can't be checked.

### Family tests

- `FamilySyncTest`, `FamilyGuardTest`, `FamilyJoinTest`, `FamilyCheckTest` run against `FakeDrive` with `FamilyFixture`.
    - `FamilyFixture` has rosters the core signs, and the group routes as `extraRoutes`.
- Also `FamilyFoldersTest`, `AppLinksTest`, `FamilyWritesTest`, `FamilyLeaveTest`, `FamilyWalksTest`, `FamilyManageTest`, `FamilyRolesTest`, `FamilyRemovalTest`, `ProviderFamiliesTest`, `FamilyPlanTest`, `SaveTargetsTest`.

## Testing

- `Vault` is tested whole against `FakeDrive` under Robolectric.
    - `FakeDrive` (app/src/test) is a JDK `HttpServer` on loopback serving the Drive, auth, link and object-store routes the vault calls.
    - Robolectric gives it a real `Context` for its files, SQLite mirror and preferences.
    - The real `DriveApi`, `Auth` and `PublicApi` do the HTTP.
- `Shared`'s Keystore-backed preferences have no JVM provider, so the test swaps plain ones into `Shared.opened`.
- `FakeDrive.record` opens what the server holds under keys unwrapped from its envelopes, as another device would.
- It keeps the settings key (stored once) and the settings document (compare-and-set) as the server does.
    - Why: the vault's sealed rollback marks need a settings key before anything opens.
- `VaultAttributesTest` uses it for every re-save path.
- Anything thrown off the test's thread while a `FakeDrive` runs is rethrown by its `close` in the test's @After.
    - That covers a route, a hook a test set, an assertion in one, and any thread's uncaught exception.
    - So a handler assertion never passes silently.
    - A hook drops a connection unanswered by throwing an `IOException`, which is not counted.
- Run the unit tests on JDK 21 (see [Build and run](#build-and-run)).
- Upload worker tests: see [Testing uploads](#testing-uploads).

## Gotchas

- `adb shell content` cannot query the provider (it needs `MANAGE_DOCUMENTS`). Verify through the system Files app or a picker.
- Every folder handed to another app through `FileProvider` must be listed in `res/xml/shared_paths.xml`.
    - Today: `opened/` and `links/` under cache, `offline/` under files.
    - A missing entry crashes with "Failed to find configured root".
- Compose, emulator and provider gotchas sit with their topics: [Design rules](#design-rules), [Emulators](#emulators), [Provider rules](#provider-rules).
