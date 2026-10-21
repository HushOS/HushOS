# HushOS for Android

Jetpack Compose app with Material 3 Expressive, minSdk 29, and the DocumentsProvider that puts HushOS in the system file picker (Storage Access Framework) and in Files by Google; Samsung's My Files never lists third-party providers. `:core` holds the UniFFI Kotlin bindings of `crates/hushos-core` and its shared libraries; `:app` is the app. The repository's root `AGENTS.md` applies here too.

## Building

```sh
bun run core:android    # Rust -> core/src/main/jniLibs and the generated Kotlin (needed once, and after any core change)
bun run android:build   # debug APK
bun run android:run     # boots the Pixel_9_API_36 emulator if needed, installs, forwards ports, launches
```

Toolchain on this Mac: SDK at `~/Library/Android/sdk` (platform 37, build-tools 37), NDK 27, JDK 21 at `/opt/homebrew/opt/openjdk@21`, Gradle 9.6 through the wrapper, AGP 9.4 (built-in Kotlin: do not apply `kotlin.android`). `adb reverse tcp:5173` and `tcp:9000` let the emulator reach the web dev server and Garage on the host as localhost; the run script does it.

## How it fits together

- The session, the remembered device and the origin live in `EncryptedSharedPreferences` under an Android Keystore master key. The provider runs in the app's process and reads the same file; a missing session becomes `AuthenticationRequiredException`, which the system shows as a sign-in affordance that opens the app.
- `Vault` mirrors the iOS one: keys opened on demand, a node-to-parent index in `filesDir`, downloads and uploads chunk by chunk through the core, thumbnails as JPEG at upload.
- `HushOSDocumentsProvider`: roots, children, recents (from the change feed), open (download to cache), write-back on close (a new version), thumbnails, create, rename, move, delete (to the trash).
- The UI keeps Material's own shapes and colours (dynamic colour when the device offers it, Paper's blue on the desk otherwise). Material 3 Expressive APIs need the 1.5.0 alpha line; the stable 1.4.0 hides them.

## What the app does

The same four tabs as iOS: Home (search, type chips, tags row and manager with presets plus any hex colour), Files (search, tag filters, floating add menu, long-press selection with a contextual bar for copy, cut, move and trash, a paste bar while the clipboard holds items, the replace, keep both or skip prompt for same-name uploads), Shared, Account (name, plan and storage, read only with no way to buy; while `/api/auth/storage` names a `pool` the card is the family's plan, "Shared with <family>", and the pool's figures (no Files row: the total is counted in whole GB), and "Not enough room" reads `availableBytes`, never quota less used, decided by `PlanDisplay` in `data/Auth.kt`, which falls back to the personal plan when `pool` is absent or unreadable, and names that plan only while it is live (`PlanStanding`, the web's `planStanding`: not ended and active, trialing or past_due); unpaid, incomplete or paused reads Free with the lapsed plan's words (`LapsedPlan`), said and never linked, and anything ended reads Free; change password, delete account, People you share with and Your twelve words, trash, sign out). People (`PeopleSheet` in `ui/LinksUi.kt`, from Account and the Shared header) has the add-by-email field, then a Your twelve words row, then the list sorted by name with Find someone from eight contacts; Your twelve words is one `OwnWordsSheet` drawn by `Main` while `DriveViewModel.showingOwnWords`, which checks the served identity first (`Vault.currentOwnFingerprint`). Nested screens pass `contentWindowInsets = WindowInsets(0)` because the outer Scaffold already pays the navigation bar inset.

## Things learned the hard way

- `adb shell content` cannot query the provider (it needs `MANAGE_DOCUMENTS`); verify through the system Files app or a picker.
- `adb shell input text` into a focused field then tapping the next field mixes the two; move between fields with keyevent 61 (Tab) and submit with 66 (Enter).

## Sharing, links, reports, rotation (added 2026-09-22 evening)

- `data/Links.kt` (owner link views, `PublicApi` without a cookie, `LinkVault` for a visitor, `Reports`), `data/Contacts.kt` (pins, owned shares, shared-by-me rows) and the matching `Vault` functions; `Auth.rotateKeys` and `Auth.recoveryKey`. The UI lives in `ui/LinksUi.kt` (share sheet with People and Links, link browser, report dialog, contacts sheet, phrase grid).
- Long press opens the item sheet, whose first row is Select; the FAB also offers "Select items".
- Writes use `workspaceOf(parentId)` so an editor can add to a shared folder; the paste bar refuses a cross-drive paste.
- `SegmentedButton` must be called inside `SingleChoiceSegmentedButtonRow` unqualified: it is a member of the row scope.
- Revoking a share rotates the subtree (`data/Rotation.kt`, same protocol as the web). Shared folders open through `BrowseScreen(start = root)`, so they get search, select, the paste bar and the add button in the granter's workspace; pasting across drives re-uploads (`copyAcross`).
- Keep downloaded lives in `data/Offline.kt` (private storage, one folder per version) with an Offline section on Home; the item sheet scrolls, and the action sits right under Rename so it is reachable without scrolling.
- Every folder handed to another app through `FileProvider` must be listed in `res/xml/shared_paths.xml` (`opened/` and `links/` under cache, `offline/` under files); a missing entry crashes with "Failed to find configured root".
- Compose dialogs shift up when the keyboard opens: read positions again after typing, and hide the keyboard with Back (not Escape, which dismisses the dialog) before tapping a dialog button.

## Running on a real phone (added 2026-09-22 evening)

- Enable Developer options and USB debugging on the phone, plug it in, accept the debugging prompt, then `bun run android:device` (builds the shrunk release APK, 6.6 MB against 77 MB for debug, and `adb install -r`s it). The release build type is signed with the debug key until a release key exists; `bun run android:release` just builds it, to sideload from `apps/android/app/build/outputs/apk/release/app-release.apk`. R8 needs the keep rules in `app/proguard-rules.pro` (JNA and the generated `com.hushos.core` bindings are reached by name).
- A real phone defaults to `https://hushos.com` (`defaultOrigin()` in `DriveViewModel.kt` checks the build fingerprint); the emulator keeps `http://localhost:5173` through `adb reverse`.

## The mirror and the catalogue (added 2026-09-22 night)

- `data/Mirror.kt` (SQLiteOpenHelper: nodes, cursors, thumbnails) and `data/Catalogue.kt` mirror the web: pull the whole feed once, open rows parents first, then `sync()` pulls only changes. `listChildren`, `recents`, `trash` and `thumbnail` answer from the catalogue first. `NodeView.rawJson` keeps the row as served for the mirror.
- The view model builds the catalogue after `loadRoot()` and syncs before every refresh. A `Surface` in `HushOSTheme` paints the background, and `values-night/themes.xml` gives the window a dark theme; without both, dark mode showed grey text on white.
- If the emulator window ignores keys and buttons, it was started from a background shell: quit it and start it from Android Studio or your own terminal (`emulator -avd Pixel_9_API_36`).

## Post-quantum identities (added 2026-10-15, docs/identity-pq-design.md)

- `data/OwnIdentity.kt`: `openOwnIdentity` opens the identity and upgrades a version 1 one (`identity_upgrade`, `POST /api/auth/identity/upgrade`, a 409 adopts the identity another device stored) before anything is signed; `Vault.identityKeys()` goes through it and `loadRoot` calls it first. `SettingsMark` keeps `(keyVersion, identityVersion)` and refuses the version 1 form once version 2 was seen. Own words are `identity_fingerprint_of_keys` over the four opened keys.
- `OpenedIdentities` (in `OwnIdentity.kt`) keeps the opened identity and the history for `Vault`: opened under its lock, `forget` waits for an open under way, and a history read is kept only while the identity it was read beside is still the one in use (`OpenedIdentitiesTest` holds the fake server's reply to prove both). Trust loads overlap: the view model's `refreshTrust` (each call follows a change) keeps only the latest one begun (`TrustLoads`), while the provider's `trustFor` (asked from many threads per listing) shares one load (`SharedLoad`: `reset` names the current vault under the provider's `vaultLock`, one Vault per session; a request still holding a dropped vault loads for itself, never shared or kept); both in `Integrity.kt`, tested by `TrustLoadsTest` and `SharedLoadTest`. A followed pin always keeps its own signing key among the previous ones (`previousKeysAfter`).
- `data/Contacts.kt` mirrors `packages/drive/src/trust.ts`: `ServedIdentity` is the served shape everywhere (lookups, granters, grantees, rotation work, operators); `ContactPin` is version 3 only when it has `mlDsaPublicKeyHash` (`verified` is `pin_verified`); `comparePin` gives same, recheck, succession or changed; `granterKey` opens suite 4 with the pinned Ed25519 key and the served ML-DSA key whose digest the pin holds; `granteeKem` seals only to the ML-KEM key the pin's digest names. Words are compared (and a pin written) only over a contact whose keys statement holds (`Contact.upgraded`).
- Shares are suite 4 (`SHARE_SUITE`); the re-seal pass seals anything older and runs after this device's upgrade and after every words check. The web test fixtures (`crates/hushos-core/fixtures/web.json`) are parsed with `Auth.identityEnvelope`, as the app parses served ones.
- The dev tools need `ANDROID_HOME=$HOME/Library/Android/sdk` in a fresh worktree (no `local.properties`).
