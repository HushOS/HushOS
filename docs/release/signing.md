# Signing

How both apps get signed for the stores, and where the resulting identifiers go. Facts are from the code on branch `redesign/alpine` (2026-10-05).

## Apple

### What the project declares

From `apps/ios/project.yml` (XcodeGen; the `.xcodeproj` is generated, not committed) and the entitlements files:

| Target          | Bundle ID                | Kind                                                                        | Entitlements                                                                                                                                                         |
| --------------- | ------------------------ | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HushOS`        | `com.hushos.app`         | App                                                                         | App group `group.com.hushos.app`; keychain group `$(AppIdentifierPrefix)group.com.hushos.app`; associated domains `applinks:hushos.com`, `webcredentials:hushos.com` |
| `HushOSFiles`   | `com.hushos.app.files`   | File Provider (`fileprovider-nonui`)                                        | App group; keychain group                                                                                                                                            |
| `HushOSFilesUI` | `com.hushos.app.filesui` | File Provider UI (sign-in inside Files)                                     | App group; keychain group                                                                                                                                            |
| `HushOSShare`   | `com.hushos.app.share`   | Share extension ("Save to HushOS")                                          | App group; keychain group                                                                                                                                            |
| `HushOSWidgets` | `com.hushos.app.widgets` | WidgetKit extension: the transfer Live Activity only, no Home Screen widget | None                                                                                                                                                                 |

- **No push.** There is no `aps-environment` entitlement; notifications are local. Live Activities are started and updated by the app, so they need no capability.
- **Background:** `UIBackgroundModes` `processing`, `fetch` and `BGTaskSchedulerPermittedIdentifiers` are Info.plist keys, not App ID capabilities.
- **The File Provider testing mode** (`com.apple.developer.fileprovider.testing-mode`) is in `App/HushOS-Simulator.entitlements` only. `App/HushOS.xcconfig` picks that file for simulator builds and `App/HushOS.entitlements` for devices, so a store archive never carries it; `apps/ios/scripts/archive.sh` checks this and stops if it does.
- **`HUSHOS_LINK_HOST`** is set in `App/HushOS.xcconfig` to `hushos.com` and expands into both associated-domain entries. A self-hosted build sets its own host in `App/Local.xcconfig` (included if present, not committed). The store build must keep `hushos.com`.
- **Device family:** `TARGETED_DEVICE_FAMILY: '1,2'`, so the app is universal and **iPad screenshots are mandatory** (13-inch, 2064×2752 or 2048×2732). Nothing in the app is designed for iPad. Apple refuses an update that drops a device family the store version supports (QA1623, archived but still enforced), so this has to be decided **before the first App Store release**: change it to `'1'` for an iPhone-only launch (recommended). A build that only went to TestFlight probably does not lock it in, but Apple doesn't document that either way.
- **Versions:** `CFBundleShortVersionString: '0.1.0'` and `CFBundleVersion: '1'` in all five targets. They must match across targets, and every upload needs a higher build number. `archive.sh <version> <build>` rewrites all ten values at once.
- **Deployment target:** iOS 26.0, built with Xcode 27 here. Apple has required the iOS 26 SDK for uploads since 28 April 2026, so this is fine.

### Certificates, identifiers and profiles: let Xcode do it

Use **automatic signing** (the project already sets `CODE_SIGN_STYLE: Automatic`). When the Account Holder or an Admin of the HushOS, Inc. team is signed in to Xcode, the first archive with `-allowProvisioningUpdates`:

- creates an **Apple Distribution** certificate in your login keychain (once per Mac);
- registers the five bundle IDs above under the team;
- enables **App Groups** with `group.com.hushos.app` on the four IDs that use it, and **Associated Domains** on `com.hushos.app`;
- makes an App Store provisioning profile for each target.

Keychain sharing needs no App ID capability: an access group prefixed with your Team ID is always allowed.

**If you'd rather register them by hand** (or automatic signing fails), go to https://developer.apple.com/account/resources:

1. **Identifiers > + > App Groups > Continue.** Description `HushOS shared`, identifier `group.com.hushos.app`. Register.
2. **Identifiers > + > App IDs > App > Continue.** Description `HushOS`, Bundle ID **Explicit** `com.hushos.app`. Under Capabilities tick **App Groups** and **Associated Domains**. Continue, Register. Open it again, click **Configure** next to App Groups, tick `group.com.hushos.app`, Save.
3. Repeat for `com.hushos.app.files` (`HushOS Files`), `com.hushos.app.filesui` (`HushOS Files UI`) and `com.hushos.app.share` (`HushOS Share`), each with **App Groups** configured to `group.com.hushos.app`.
4. Register `com.hushos.app.widgets` (`HushOS Widgets`) with no capabilities.
5. **Certificates > + > Apple Distribution**, upload a certificate signing request from Keychain Access (Certificate Assistant > Request a Certificate From a Certificate Authority > Saved to disk), download and double-click the certificate.
6. **Profiles > + > App Store Connect**, one per bundle ID, each with that certificate. Download and double-click them.

Back up the distribution certificate with its private key (Keychain Access > My Certificates > Apple Distribution: HushOS, Inc. > Export as .p12, with a password, into your password manager). Losing it is not a disaster: revoke and create a new one; the app is unaffected.

### Where the Team ID goes

The Team ID is 10 capital letters and digits, on https://developer.apple.com/account under Membership details. It is not secret: it appears in every signed app and in the association file.

1. **The production server:** `APPLE_APP_IDS=<TEAMID>.com.hushos.app` (`packages/env/src/app.ts` checks the format). The web then serves `https://hushos.com/.well-known/apple-app-site-association` with `applinks` (share links `/s/*`, `/recover/complete`, `/app`, `/app/drive*`, `/app/shared*`, `/app/trash*`; `/app/billing*` and `/app/admin*` excluded) and `webcredentials`. Unset, it answers 404, which is what it does today.
2. **The associated-domains entitlement** needs nothing more: `applinks:hushos.com` and `webcredentials:hushos.com` are already in `App/HushOS.entitlements`; the Team ID binds them through the signature.
3. **Builds:** `DEVELOPMENT_TEAM=<TEAMID> bun run ios:archive <version> <build>` (and `bun run ios:device` for a phone). To archive from Xcode's own menu instead, add `DEVELOPMENT_TEAM: <TEAMID>` under `settings: base:` in `apps/ios/project.yml` and commit it: otherwise every `xcodegen generate` drops the team from all five targets.

Apple's CDN fetches the association file within 24 hours of the app's first install, and devices refresh about weekly (https://developer.apple.com/documentation/xcode/supporting-associated-domains, checked 2026-10-05). Check what Apple has cached at `https://app-site-association.cdn-apple.com/a/v1/hushos.com`.

### Export compliance key

`App/Info.plist` sets `ITSAppUsesNonExemptEncryption: false`, which tells App Store Connect, upload after upload, that the app needs no export documentation. Read the encryption section of apple.md before the first upload: Apple's own table puts HushOS's case (standard algorithms implemented in the app, not the operating system's) in the "French declaration if sold in France" row, and counsel should confirm the `false`.

## Android

### What the project declares

From `apps/android/app/build.gradle.kts` and `app/src/main/AndroidManifest.xml`:

- `applicationId` and `namespace` `com.hushos.app`; `minSdk 29`, `targetSdk 36` (Play has required 36 for new apps and updates since 31 August 2026), `compileSdk 37`.
- `versionCode = 1`, `versionName = "0.1.0"`.
- Release: R8 minify and resource shrinking on, `DEFAULT_ORIGIN` `https://hushos.com`; `-PdefaultOrigin=` changes it for a self-hosted build. The same origin sets the app-link intent filter's scheme and host and `appLinkVerify` (`true` only for https), so the store build verifies `hushos.com`.
- Permissions: `INTERNET`, `ACCESS_NETWORK_STATE`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_DATA_SYNC` (queued transfers through WorkManager), `POST_NOTIFICATIONS`, `CAMERA` (the recovery-kit scan; `camera.any` not required); WorkManager adds `WAKE_LOCK` and `RECEIVE_BOOT_COMPLETED` in the merged manifest. No media, storage or advertising-ID permissions (checked in the merged release manifest).
- `allowBackup="false"`; cleartext only in the debug build (`src/debug/res/xml/network_security_config.xml`, for the dev server); release allows https only.
- **Signing, before this change:** the release build type was signed with the debug key. Now it uses the upload key when one is configured (below) and falls back to the debug key otherwise, so `bun run android:device` still installs a shrunk build on a phone. Google Play refuses debug-signed bundles, and `bundle-release.sh` refuses to produce one.

### The upload key

Google holds the key that signs what people install (**Play App Signing**, mandatory for new apps). You keep an **upload key** that proves a bundle came from you. If you lose it, Google can reset it (Play Console: Protected with Play > Play Store protection > Manage Play app signing > Request upload key reset). That's an inconvenience, not the end of the app, but don't count on it.

**Create it with the wizard** (`scripts/release-wizard.sh`, stage 7). It saves the password in your login keychain, so the password never sits in a file, then runs `keytool`. Or by hand:

```sh
mkdir -p ~/.hushos && chmod 700 ~/.hushos
/opt/homebrew/opt/openjdk@21/bin/keytool -genkeypair -v \
    -keystore ~/.hushos/hushos-upload.jks -storetype PKCS12 \
    -alias upload -keyalg RSA -keysize 4096 -validity 10000 \
    -dname "CN=HushOS, O=HushOS Inc., C=US"
chmod 600 ~/.hushos/hushos-upload.jks
security add-generic-password -s hushos-android-upload -a upload -l "HushOS Android upload key" -w
```

`keytool` asks for the keystore password twice; the last command asks for the same password twice and keeps it in the keychain. With PKCS12 the key's password is the keystore's.

**Keep it safe:**

- The `.jks` file lives outside the repository. `.gitignore` now ignores `*.jks`, `*.keystore` and `apps/android/keystore.properties` anywhere, as a backstop.
- Copy the `.jks` file and its password into your password manager (an attachment plus the password field), and a second copy on an encrypted drive kept elsewhere.
- Never email it, put it in a chat, or upload it anywhere but your password manager.

### Wiring it into Gradle without committing secrets

`app/build.gradle.kts` reads, in this order:

1. `apps/android/keystore.properties` (git-ignored), with any of `storeFile`, `storePassword`, `keyAlias`, `keyPassword`;
2. the environment variables `HUSHOS_UPLOAD_STORE_FILE`, `HUSHOS_UPLOAD_STORE_PASSWORD`, `HUSHOS_UPLOAD_KEY_ALIAS` (default `upload`), `HUSHOS_UPLOAD_KEY_PASSWORD` (default: the store password).

The wizard writes a `keystore.properties` with only the path and the alias:

```properties
storeFile=/Users/<you>/.hushos/hushos-upload.jks
keyAlias=upload
```

`apps/android/scripts/bundle-release.sh` (`bun run android:bundle`) takes the password from `HUSHOS_UPLOAD_STORE_PASSWORD` or, failing that, from the keychain item `hushos-android-upload`. It builds `app/build/outputs/bundle/release/app-release.aab`, refuses a debug-signed result, and prints the signing certificate's SHA-256. In CI you would set the four environment variables from the CI's secret store instead.

Check which key a build would use without building: `cd apps/android && ./gradlew :app:signingReport` (the `release` variant shows `Config: upload` when the key is wired, `debug` otherwise).

### The two SHA-256 fingerprints, and which one app links need

- **Upload key:** `keytool -list -v -keystore ~/.hushos/hushos-upload.jks -alias upload | grep SHA256` (or `bundle-release.sh`'s last line, or `.env.release` after the wizard).
- **App signing key (Google's):** only after the first upload. Play Console > HushOS > **Protected with Play > Play Store distribution > Go to Play app signing** > "App signing key certificate" > SHA-256. Older help pages call it Release > Setup > App signing (https://support.google.com/googleplay/android-developer/answer/9842756, checked 2026-10-05).

Phones install builds signed with **Google's** key, so `assetlinks.json` must list the app signing key's fingerprint, or the share links on hushos.com won't open in the app. Add the upload key's too, so a release APK you sideload for testing also verifies:

```sh
ANDROID_APP_CERT_SHA256=<app signing SHA-256>,<upload SHA-256>
```

on the production server (`ANDROID_APP_PACKAGE` defaults to `com.hushos.app`). The web then serves `https://hushos.com/.well-known/assetlinks.json` with both `handle_all_urls` and `get_login_creds`. Play Console's **Grow users > Deep links** page shows whether verification passes.

### versionCode

Every bundle needs a `versionCode` higher than any Play has seen for the app, on any track (maximum 2,100,000,000). `versionName` is what people see. `bundle-release.sh <versionName> <versionCode>` rewrites both in `build.gradle.kts`; commit that change after a successful upload. Use the same numbers as iOS (version `1.0.0`, build `1` then `2`...) so a report of "build 7" means the same on both.
