# HushOS for iOS

SwiftUI app, iOS 26 and later, with the File Provider extension (`Files/`) and the sign-in action extension (`FilesUI/`). Everything the three targets share is the Swift package `Packages/HushOSKit` (keychain, Drive API, the vault that opens keys, OPAQUE sign-in) over `Packages/HushOSCore`, the UniFFI bindings of `crates/hushos-core`. The repository's root `AGENTS.md` applies here too.

## Building

```sh
bun run core:apple      # Rust -> Packages/HushOSCore (needed once, and after any core change)
bun run ios:project     # XcodeGen: project.yml -> HushOS.xcodeproj (not committed)
bun run ios:build       # simulator build into apps/ios/DerivedData
bun run ios:run         # install and launch on the iPhone 18 Pro simulator (SIMULATOR=<udid> to pick another)
```

The API is the web dev server on http://localhost:5173 (`bun dev` at the root); the simulator shares the host's network. The sign-in sheet has a field for another origin.

## How it fits together

- The session cookie, the remembered device (account key sealed under a device key) and the origin live in the shared keychain (access group `group.com.hushos.app`, service `com.hushos.files`), so the extensions read the same session the app signed in with. Signing out deletes the session and removes the Files domain; the device memory stays for the next sign-in.
- `Vault` (an actor) opens the account key from the device memory, the workspace key from the grant, node keys under their parents, and keeps a node-to-parent index in the app group container so a cold extension process can find an item by listing its folder.
- Files: `FileProviderExtension` is replicated (`NSFileProviderReplicatedExtension`), with writes (folders, renames, moves, trash, uploads with thumbnails), thumbnails and the change feed as sync anchor. `FileProviderUIController` shows the OPAQUE sign-in inside Files when the session is gone.
- The app re-registers the domain (remove all, then add) on every signed-in launch. A new domain on iOS starts disabled until the person turns it on in Files (Browse, the ... menu, Edit, the HushOS switch). Simulator debug builds skip that through `NSFileProviderDomain.testingModes = .alwaysEnabled`, which needs the `com.apple.developer.fileprovider.testing-mode` entitlement the app carries; a device build without that capability in its profile must drop the entitlement.
- Design: native structure and controls, Liquid Glass from the system, Paper only as the accent colour and the words. No custom cards or buttons.

## What the app does

Home (search pill, type chips, tags row with a manager, recent files), Files (the tree with search, tag filters, a floating add button, select mode with copy, cut, move and trash for many, a paste bar while the clipboard holds items, and the same replace, keep both or skip prompt the web shows for same-name uploads), Shared (what others gave you; opening needs the identity keys, not in the core yet), Account (name, plan and storage with a link to the web's billing page, change password and delete account through OPAQUE in the core, trash, sign out). Uploads and downloads run a Live Activity (`Widgets/`, Dynamic Island and Lock Screen). Copies reseal the version envelope in the core (`version_reseal`); the server keeps the object.

## Things learned the hard way

- Never map an unknown error to `noSuchItem`: Files deletes the item locally. Only the server's "This item no longer exists." and its `trashed` code (`DriveAPIError.trashed`: the item or a folder above it is in the trash, which this location doesn't show) are that. Reporting `trashed` as a read error kept folders trashed on another device in Files indefinitely, retrying every few seconds, and a new folder of the same name showed up as "… 2".
- In `enumerateChanges`, report deletions before updates: a folder replaced by a new one of the same name arrives in one batch. The change feed marks a node deleted only on a verdict (gone, trashed, unopenable); a network or server failure fails the batch instead.
- The app signals Files after every live sync that changed something, so changes from other devices reach the Files location without a local write.
- Items advertise write capabilities even for read-only paths; the simulator's volume refuses the read-only flags.
- `documentStorageURL` asserts in a replicated extension; decrypt into the temp directory and let Files move the file.
- The two extension targets build in Swift 5 mode: the File Provider API is callback based and Swift 6's sending-closure checks reject it.
- Simulator builds embed entitlements in the binary's `__entitlements` section; `codesign -d --entitlements` shows an empty dictionary and that is fine.
- Extension logs: `xcrun simctl spawn <udid> log show --last 2m --predicate 'subsystem == "com.hushos.app.files"'`; fileproviderd's own view: predicate `process == "fileproviderd" AND eventMessage CONTAINS "hushos"`.

## Sharing, links, reports, rotation (added 2026-09-22 evening)

- `HushOSKit/Shares.swift` mounts what others shared (identity opened once, `shareOpen`, the previous envelope during a rotation); `Links.swift` holds the owner's link routes, `PublicAPI` (no cookie) and `LinkVault` for a visitor; `Reports.swift` seals the node key to every operator; `Contacts.swift` keeps the pins in the account settings document with compare-and-set and seals shares to a pinned contact; `Account.swift` rotates the master key and reads the recovery key.
- A password change or key rotation ends every session on the server, so the sheets sign in again with the new password themselves.
- Writes land in the parent folder's workspace (a shared folder is the granter's); the server copies within one workspace only, so the paste bar refuses a cross-drive paste.
- The Shared tab hides the navigation bar and draws its own header (title, contacts button, With me / By me) like Files; give any header-carrying section `listRowInsets` of zero and its rows explicit insets of 20, or the rows lose their margin.
- Revoking a share rotates the subtree (`Vault+Rotation.swift`, the web's protocol: work in depth order, parents first, previous keys kept for children wrapped under them, shares re-sealed only to keys the pins vouch for, password links without a kept password key reported unsealable). Pasting into another drive re-uploads (`copyAcross`); a link made against a stale epoch reloads the item and retries once.
- Keep downloaded is the app's own feature (`Offline.swift`, app group container, one folder per version, an Offline section on Home): iOS Files never offers "Keep Downloaded" to third-party providers, even with `NSExtensionFileProviderSupportsPinning` and `allowsEvicting`, and `contentPolicy`'s keep-downloaded case is macOS-only. Files' "Download Now" does work through `fetchContents`.
- The File Provider domain is kept across launches (removing it dropped Files' cache); a fresh install still registers it anew. A Photos picker inside a Menu never presents; use a button and `.photosPicker`. Transfers hold a UIKit background task so a lock or Home press does not suspend them at once.
- Live Activity: requested, updated and ended correctly (ActivityKit log, SpringBoard aperture assertions), but the compact island content was not legible in simulator captures; check on a device.

## Running on a real iPhone (added 2026-09-22 evening)

- `DEVELOPMENT_TEAM=<team id> bun run ios:device` builds for the plugged-in iPhone with automatic signing and installs it through `devicectl`. Xcode must be signed in to an Apple Developer Program account: the app group and keychain sharing are not available to free accounts.
- Entitlements come from `App/HushOS.xcconfig`, not from the XcodeGen `entitlements:` block (a target-level setting would shadow the per-SDK choice): the simulator gets `App/HushOS-Simulator.entitlements` (adds the File Provider testing mode), a device gets `App/HushOS.entitlements`. Check what a simulator build embeds by reading the binary's `__TEXT,__entitlements` section; `codesign -d --entitlements` shows nothing there.
- On a device the Files location starts disabled: Files > Browse > the ... menu > Edit > turn HushOS on.
- A real phone defaults to `https://hushos.com` (`AppModel.defaultOrigin` under `#if !targetEnvironment(simulator)`); the simulator keeps `http://localhost:5173`. The origin can be changed on the sign-in screen either way.

## The mirror and the catalogue (added 2026-09-22 night)

- `Mirror.swift` is the web's IndexedDB tree mirror in SQLite (raw SQLite3, no dependency) in the app group: `nodes` (id, workspace, the row as served), `cursors` (feed cursor per workspace), `thumbnails` (sealed trailers by version id). `Vault+Catalogue.swift` builds the catalogue the way `packages/drive/src/client.ts` does: pull the whole feed once (a feed is state, not a log), open rows parents first, then `sync()` pulls only what changed since the cursor. `children(of:)`, `recents()`, `trash()` and thumbnails answer from it first; shared folders (other workspaces) still go to the network.
- The store builds the catalogue after `loadRoot()` and calls `sync()` before every refresh; `catalogueVersion` bumps when lists change. Inspect the mirror on the simulator with `sqlite3 <app group>/mirror.sqlite`.
- Design: colours are Paper's own in both appearances; tag pills lighten their ink in the dark. Icons: light = mark on sheet, dark = mark on transparent (iOS backs it), tinted = white mark on black (iOS's tinted and clear styles derive from it). Splash: black mark on white, white mark on black; the simulator caches launch screens, so reboot it after changing them.

## Out of backups (added 2026-10-11)

- `HushOSKit/Unbacked.swift` keeps the account's data on this phone and out of iCloud and computer backups: decrypted files (`offline`, the queue's `transfers`, Save to HushOS's `share-staging`) and anything naming what is in the drive (`state/` with the kept-file lists, the last folder, recent searches and the last email; `local/` with `files-parents.json`, `account-owner`, `mirror.sqlite*` and the settings marks). Lists the app and its extensions share go in `state/` as JSON through `Unbacked.read`/`write`, never in the app group's `UserDefaults` or the app's own, which are plists a backup takes.
- Only folders carry the mark: an atomic write replaces a file and drops its mark, and SQLite makes its side files when it likes. So no loose file at the top of the group; put it in `local/` (an older version's loose files are moved there once by `apply()`). A folder sign-out removes is made again with `Unbacked.folder(_:)` before each write (the queue does), never with a bare `createDirectory`.
- Make any new top folder for such data with `Unbacked.folder(_:)` and add its name to `Unbacked.names` and, if it belongs to the account, `AccountStore.accountFiles`. A restore can drop `isExcludedFromBackup`, so `Unbacked.apply()` marks everything again at every launch of the app, the Files extension and the share extension. The temporary folder is never backed up and needs no mark.
- A received share opens only when its granter is pinned, the pin is `verified` (a signing key and the current fingerprint over both keys) and the served X25519 key is the pinned one (`ContactPin.granterKey`); anything else shows "Add <name>…" or "Check <name>’s words again…" on the row. Pins are made only after the words check, and only the pinned signing key may vouch for a KEM key.

## Keys, settings and the sharing ledger (added 2026-10-12)

- Node keys and opened nodes are kept by workspace and node (`NodeTable`): the server picks a share's ids, and keyed by id alone a share could replace one of the account's own folder keys. Look up a parent by `NodeRef(node.workspaceId, parentId)`; id-only lookups prefer the own workspace. A share into the own workspace, or whose node names another workspace, is refused before anything opens (`Vault.checkReceived`); a write's reply is adopted only for the workspace written into.
- The settings document is kept as JSON (`Settings` in `Settings.swift`) so fields other clients write survive every save; edit it only through `updateSettings`, which retries a 409. It holds the pins and the sharing ledger (`sharing.shares` node to grantees, `sharing.links` link to node): a share or link joins after the server takes it and leaves before it is stopped, and rotation re-seals only what the ledger holds.
- `SettingsMarks` (in `local/`, kept across sign-outs) refuses settings older than this device has seen.
- Shares are sealed only hybrid, to a verified pin, with a KEM key the pin vouches for (`ContactPin.sealKeys`); rotation leaves out anyone who fails that and says who (`RotationOutcome.skipped`).
- Nothing names a file on the Lock Screen: the Live Activity and transfer notifications carry counts. The app covers itself in the app switcher (`PrivacyCover`, a window above sheets) and `PhraseGrid` hides the words while the screen is captured.

## Integrity: padded objects, signatures, successions (added 2026-10-13)

- The client speaks Drive protocol 3 (`DriveAPI.clientHeader`, `ios/3`). Uploads write content suite 3: `chunkEncrypt` pads, `chunkDecrypt` returns only the file's bytes, and every chunk (padding included) is fetched on a full read; ranges and layouts take the version's suite (`OpenedVersion.layout`/`range`). Progress counts the file's own bytes (`FileProgress`), never chunks of padding.
- Every write that sets a metadata or content-key envelope is signed (`Vault.signMetadata`/`signVersion`, Vault+Identity): root, folders, upload begin, the replacement's metadata, rename (over `metadataVersion + 1`), copy, rotation. The signing identity is re-checked against the served one at most every five minutes, so a succession on another device does not leave writes failing.
- Reading: `TrustedSigners` (Integrity.swift) holds the account's own signing keys (current and history) and every verified pin's, with `previousSigningKeys`. `DriveStore.provenance(of:)` caches a verdict per record; `UnverifiedMark` draws it on rows, the viewer header and Info, never on link views. No mark is drawn until the signers have loaded.
- Pins carry `keyVersion`, `previousSigningKeys` (oldest first) and `keysReplacedAt` (agreed with web and Android). `Vault.follow` moves a pin along a verified succession chain wherever a pin is checked (lookup, received shares, sharing, rotation, the upgrade pass). The People notice is dismissed per device (`ReplacedKeysSeen`, in `state/`).
- Shares are sealed in suite 3 only and opened with `ShareOpener` (pinned signing keys, then every identity the account holds). `Vault.upgradeShares` runs on Drive open: shares in older suites, a re-seal a succession left unfinished (`ResealPending`), and grantees with newer keys are sealed again.
- Settings are sealed as version 2 under the settings key (made and stored on first save); version 1 still opens with the current or an earlier identity. Master-key rotation rewraps the identity history and the settings key.
