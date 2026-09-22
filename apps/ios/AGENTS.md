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

- Never map an unknown error to `noSuchItem`: Files deletes the item locally. Only the server's "This item no longer exists." is that.
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
