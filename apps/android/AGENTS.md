# HushOS for Android

Jetpack Compose app with Material 3 Expressive, minSdk 29, and the DocumentsProvider that puts HushOS in the system Files app and every file picker. `:core` holds the UniFFI Kotlin bindings of `crates/hushos-core` and its shared libraries; `:app` is the app. The repository's root `AGENTS.md` applies here too.

## Building

```sh
bun run core:android    # Rust -> core/src/main/jniLibs and the generated Kotlin (needed once, and after any core change)
bun run android:build   # debug APK
bun run android:run     # boots the Pixel_9_API_36 emulator if needed, installs, forwards ports, launches
```

Toolchain on this Mac: SDK at `~/Library/Android/sdk` (platform 37, build-tools 37), NDK 27, JDK 21 at `/opt/homebrew/opt/openjdk@21`, Gradle 9.6 through the wrapper, AGP 9.4 (built-in Kotlin: do not apply `kotlin.android`). `adb reverse tcp:5173` and `tcp:9000` let the emulator reach the web dev server and MinIO on the host as localhost; the run script does it.

## How it fits together

- The session, the remembered device and the origin live in `EncryptedSharedPreferences` under an Android Keystore master key. The provider runs in the app's process and reads the same file; a missing session becomes `AuthenticationRequiredException`, which the system shows as a sign-in affordance that opens the app.
- `Vault` mirrors the iOS one: keys opened on demand, a node-to-parent index in `filesDir`, downloads and uploads chunk by chunk through the core, thumbnails as JPEG at upload.
- `HushOSDocumentsProvider`: roots, children, recents (from the change feed), open (download to cache), write-back on close (a new version), thumbnails, create, rename, move, delete (to the trash).
- The UI keeps Material's own shapes and colours (dynamic colour when the device offers it, Paper's blue on the desk otherwise). Material 3 Expressive APIs need the 1.5.0 alpha line; the stable 1.4.0 hides them.

## What the app does

The same four tabs as iOS: Home (search, type chips, tags row and manager with presets plus any hex colour), Files (search, tag filters, floating add menu, long-press selection with a contextual bar for copy, cut, move and trash, a paste bar while the clipboard holds items, the replace, keep both or skip prompt for same-name uploads), Shared, Account (name, plan and storage, change password, delete account, trash, sign out). Nested screens pass `contentWindowInsets = WindowInsets(0)` because the outer Scaffold already pays the navigation bar inset.

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

- Enable Developer options and USB debugging on the phone, plug it in, accept the debugging prompt, then `bun run android:device` (builds the debug APK and `adb install -r`s it). The debug APK also sideloads from `apps/android/app/build/outputs/apk/debug/app-debug.apk`.
- A real phone defaults to `https://hushos.com` (`defaultOrigin()` in `DriveViewModel.kt` checks the build fingerprint); the emulator keeps `http://localhost:5173` through `adb reverse`.
