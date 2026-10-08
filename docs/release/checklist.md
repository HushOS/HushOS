# Pre-submission checklist

One list for both stores. Tick everything before pressing Submit (Apple) or Send changes for review (Google). Items marked **blocker** will get the upload refused or the review rejected; they were found in the code on 2026-10-05.

## Owner decisions (nobody else can make these)

- [ ] **Public business address and phone.** Apple's Support URL must show "legal address, email address, telephone number"; Apple's EU trader status and Google's organization profile publish an address and phone too. The support page reads them from `OPERATOR_ADDRESS` and `OPERATOR_PHONE` on the production server. Is it a real office, a virtual office, or the registered agent (Corporation Service Company, Wilmington)? A registered agent's address is usually not acceptable as a business address. Ask counsel.
- [ ] **iPhone only, or iPhone and iPad.** The project is universal (`TARGETED_DEVICE_FAMILY: '1,2'`). Universal means 13-inch iPad screenshots are mandatory and iPad can never be dropped after release. Nothing is designed for iPad. Recommended: `'1'` in `apps/ios/project.yml` before the first App Store release.
- [ ] **Export compliance.** Keep `ITSAppUsesNonExemptEncryption = false`, or answer App Store Connect's questionnaire; and whether to sell in France now (needs a French encryption declaration) or later. apple.md, section 8. **Confirm with counsel.**
- [ ] **Privacy answers.** Whether encrypted photos count as "collected" for Apple (privacy-answers.md). **Confirm with counsel.**
- [ ] **Version.** `1.0.0` (recommended, matching "HushOS 1.0" on the blog) or keep `0.1.0`; builds from `1`.
- [ ] **App Store name.** `HushOS: Encrypted Drive`, or `HushOS Drive`, if available.

## App changes before the first submission

The blockers were fixed on 2026-10-05; the boxes stay for a last look on the release build.

- [x] **Blocker, both stores: a privacy policy link inside the app.** Apple 5.1.1(i) and Google's privacy policy rule. "Privacy policy" and "Terms" are in Account and on the sign-in screen on both apps. They open the pages with `?app=1`, which shows only the logo: no menu, no "Start free", no footer, and links only between the privacy, terms, support and security pages, so pricing can't be reached from the app.
- [x] **Blocker, both stores: no purchase links.** Remove "Manage on the web" / "Update card on the web" and the "Get more room" option that open `/app/billing`. iOS: remove the "Plans are chosen and paid for on the web" footer too. Android: the sentence may stay as plain text. Exact places: store-listing.md, "What the apps and the listings must and must not say about plans".
- [x] **Blocker, Apple: `PrivacyInfo.xcprivacy` in the app and all four extensions.** UserDefaults and file-timestamp APIs are used and undeclared; Apple refuses such uploads. Contents and reasons: privacy-answers.md.
- [x] **Recommended, Android: no cleartext in release.** The release network security config allows no cleartext; only the debug build (`src/debug`) allows http, for the dev server.
- [ ] **Recommended, Android: data-sync foreground service.** Either record the declaration video (google.md, section 3.2) or move transfers to user-initiated data transfer jobs, which Google recommends for user-started transfers.
- [x] **Recommended: the sign-in screen tells newcomers where accounts come from.** Both say "New to HushOS? Create an account at hushos.com." Neither app says how to get an account. A line such as "New to HushOS? Make a free account at hushos.com" is not a purchase call to action, but keep it to a free account, never plans. (Google: pointing to sign-up outside the app brings in its account-deletion rule, which the apps already satisfy.)
- [ ] **Check on a device: saving a photo from "Send a copy".** iOS asks for `NSPhotoLibraryAddUsageDescription` when someone picks Save Image in the share sheet; the string is now set. Tap Save Image once on a phone to see the prompt.

## Web and accounts

- [ ] **Blocker, Apple: the support page shows the address and phone.** `https://hushos.com/support` exists; it shows `HELP_CONTACT` (or `OPERATOR_CONTACT`), `OPERATOR_NAME`, `OPERATOR_JURISDICTION`, `OPERATOR_ADDRESS` and `OPERATOR_PHONE`. Set the last two on production (the address takes `\n` between lines) and check the page's "Who runs HushOS" section shows them.
- [ ] **Support email is live.** `hello@hushos.com` (a Google Workspace alias). Send a test from an outside account; both stores show it.
- [ ] **Privacy and terms pages are live.** `https://hushos.com/privacy` and `/terms` answer 200 (they did on 2026-10-05).
- [x] **Recommended: the privacy policy covers the apps.** Section 4 describes only browser storage. Add the apps: the session and remembered device in the keychain or Android Keystore, the local file mirror and kept files, the camera used only on the phone for Take photo and the recovery-kit scan, local notifications only.
- [x] **Google: an account-deletion URL.** `https://hushos.com/support#delete-account` names HushOS, gives the web and app steps, says what is deleted, and gives the contact email for anyone who can't sign in.
- [ ] **Review demo accounts on production.** `appreview@hushos.com` with sample folders, photos, a shared folder and a link; `appreview-delete@hushos.com` for the deletion test. Signed in once on each app from a real phone. Passwords are in the review notes and in App access. apple.md, section 9.
- [ ] **`APPLE_APP_IDS=<TEAMID>.com.hushos.app` on production.** `https://hushos.com/.well-known/apple-app-site-association` returns JSON naming it (404 today).
- [ ] **`ANDROID_APP_CERT_SHA256=<Play app signing SHA-256>,<upload SHA-256>` on production.** `https://hushos.com/.well-known/assetlinks.json` returns JSON with both (404 today).

## Builds

- [ ] **Versions match on both platforms.** iOS: all five `CFBundleShortVersionString` and `CFBundleVersion` values in `apps/ios/project.yml` (archive.sh sets them). Android: `versionName` and `versionCode` in `apps/android/app/build.gradle.kts` (bundle-release.sh sets them). Each upload has a build number above the last.
- [ ] **iOS release build** made by `bun run ios:archive <version> <build>`, uploaded, processed, no "Missing Compliance".
- [ ] **The iOS archive has no `fileprovider.testing-mode` entitlement** (archive.sh checks) and keeps `applinks:hushos.com` / `webcredentials:hushos.com` (`HUSHOS_LINK_HOST`).
- [ ] **Android bundle** made by `bun run android:bundle <version> <code>`, signed with the upload key (the script refuses the debug key), `targetSdk 36`.
- [ ] **Android release talks to `https://hushos.com`.** Built without `-PdefaultOrigin`.

## On real phones (the TestFlight build and the internal-test build)

Deep links have only been tried on the simulator and emulator, with `hushos://` links. The https app links have never been tested.

- [ ] Fresh install, sign in to the review account: Home, Files, Shared and Account load; no "server address" capsule (it shows only for a non-default server).
- [ ] **Real-domain link, iOS.** In Notes or Mail (not Safari's address bar, which never opens apps), tap `https://hushos.com/s/<token>#<secret>` for a link made on the web: it opens HushOS, not Safari. Tap `https://hushos.com/app/billing`: it stays in Safari. If links open Safari, long-press one and check "Open in HushOS" is offered. Then check `https://app-site-association.cdn-apple.com/a/v1/hushos.com` shows the Team ID (the CDN may take up to 24 hours).
- [ ] **Real-domain link, Android.** `adb shell pm get-app-links com.hushos.app` says `hushos.com: verified`; tapping the same share link in Gmail or Messages opens HushOS; `/app/billing` stays in the browser.
- [ ] **The recovery email link** (`https://hushos.com/recover/complete#verify=…`) opens the app's recovery on both.
- [ ] **iOS Files:** Files > Browse > ... > Edit > HushOS on; browse a folder; open a file.
- [ ] **Android Files:** HushOS is listed as a location in Files and in a document picker.
- [ ] **Save to HushOS** from Photos (iOS) and Gallery or Files (Android).
- [ ] **A 100 MB upload** with the app sent to the background finishes. Notifications are asked for at a sensible moment, not at launch.
- [ ] **The Live Activity on iOS** is legible in the Dynamic Island and on the Lock Screen. It was only ever checked in the simulator, where it wasn't.
- [ ] **Plan screen and storage-full sheet** show no link to buy (after the app changes above).
- [ ] **Delete account** on the second review account, then sign out and in again with the first.
- [ ] **Sign out:** "Files kept on this phone are removed" appears when files are kept, and they are.

## Store pages

- [ ] **Screenshots:** iOS 6.9-inch 1320×2868 (and 13-inch iPad if universal); Android 1080×1920. Six each, light mode, clean status bar, the demo account only. The Account shot was taken after the plan buttons were removed.
- [ ] **Google graphics:** icon 512×512, feature graphic 1024×500 (`docs/release/assets/`).
- [ ] **Copy pasted from store-listing.md;** no price, plan or "upgrade" wording anywhere.
- [ ] **Apple:** App Privacy published; age rating answered; content rights answered; Pricing free; availability (France per the export decision); "available on Mac" unticked; review notes and both demo accounts filled in; manual release.
- [ ] **Google:** every App content item green; Data safety submitted; App access instructions; content rating; target audience 18+; store settings with email and website; countries chosen.
- [ ] **Encryption answer** recorded the same way everywhere: `ITSAppUsesNonExemptEncryption` in the build matches what counsel said.
