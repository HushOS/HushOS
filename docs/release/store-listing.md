# Store listing copy

Ready to paste. Every claim here was checked against the apps on branch `redesign/alpine` on 2026-10-05, and the Google Play section and Android screenshots again against `main` on 2026-10-19; the list of what was deliberately left out is at the end. Limits are the stores' own (Apple: https://developer.apple.com/help/app-store-connect/reference/app-information/platform-version-information; Google: https://support.google.com/googleplay/android-developer/answer/9859152; both checked 2026-10-05). Counts below are characters (Apple's keyword limit is bytes; the keywords are ASCII, so the same).

## Shared facts

| Field                                    | Value                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Seller / developer name                  | HushOS, Inc. (Apple takes it from D&B; it can't be a trade name)                                                                                                                                                                                                                                        |
| Privacy policy URL                       | `https://hushos.com/privacy`                                                                                                                                                                                                                                                                            |
| Marketing URL (Apple) / Website (Google) | `https://hushos.com`                                                                                                                                                                                                                                                                                    |
| Support URL                              | **Missing.** Apple requires a page with real contact information: legal address, email and phone. hushos.com has none (`/support` is a 404; the only address published is `hello@hushos.com`, inside the privacy policy). Make `https://hushos.com/support` first; until then nothing can be submitted. |
| Support email                            | `hello@hushos.com` (the operator contact on the live privacy page). Confirm it reaches a person; Google shows it publicly.                                                                                                                                                                              |
| Copyright (Apple)                        | `2026 HushOS, Inc.` (Apple adds the ©)                                                                                                                                                                                                                                                                  |
| Category                                 | Apple: Productivity (primary), Utilities (secondary). Google: Productivity.                                                                                                                                                                                                                             |
| Price                                    | Free on both. Plans are bought on the web; nothing is sold in the apps.                                                                                                                                                                                                                                 |

## Apple App Store

**Name** (30 max), 23:

```text
HushOS: Encrypted Drive
```

Fallback if the name is taken or you want the bare brand: `HushOS Drive` (12). The name under the icon stays `HushOS` (`CFBundleDisplayName`) either way.

**Subtitle** (30 max), 29:

```text
Private, end-to-end encrypted
```

Alternative in the site's voice: `Files nobody else can open` (26).

**Promotional text** (170 max), 146. It can change without a new build:

```text
Your files are locked on your phone before they upload, and only you hold the key. Open source, free to start, with servers in the European Union.
```

**Keywords** (100 bytes max), exactly 100. Comma-separated, no spaces after commas, no words already in the name:

```text
cloud storage,private,secure,files,folders,share,e2ee,end-to-end,privacy,open source,vault,documents
```

**Description** (4000 max), 1834:

```text
HushOS is a private drive for your files. Everything you add is locked on your iPhone before it is uploaded, with a key made on your device that stays with you. We store your files and hand them back, but we can't open them.

IT WORKS LIKE THE DRIVE YOU ALREADY USE
• Browse, search and tag your files and folders. Search runs on your phone, so nothing you type is sent anywhere.
• Upload files and photos, or take a photo straight into a folder.
• Rename, move, copy, and move to Trash. Trash keeps things for 30 days.
• Keep a file or a whole folder on your iPhone, to open without a connection.
• Uploads keep going when you leave the app.
• Save to HushOS from the share sheet in other apps.
• Find HushOS in the Files app, to open and save files from other apps.

SHARING THAT SAYS WHO CAN OPEN WHAT
• Share a file or folder with another HushOS account, as someone who can view or someone who can edit, and check it's really them.
• Or make a link anyone can open in a browser, with a password or an end date if you like. Turn it off whenever you want.
• Each item says who can open it when that's different from its folder.

WHAT WE CAN SEE
Your email, how much you store, the sizes of your files, when they changed, and how your folders nest. Not their names or contents. Not your password either: it never leaves your phone, even when you sign in.

If you forget your password, your recovery kit and a link we email you get you back in. Without the kit nobody can, including us.

OPEN SOURCE
All of HushOS is open source under the AGPL: the apps and the server. Anyone can read how it works, and anyone can run their own server. The app signs in to yours too.

The service at hushos.com keeps its servers and your files in the European Union.

You need a HushOS account to use the app. You can make one for free at hushos.com.
```

**What's New** (not asked for the first version; for 1.0.1 onwards, 4000 max):

```text
The first release of HushOS for iPhone.
```

## Google Play

Rewritten for the first release (0.9.0) on 2026-10-19, against `main` at that date: every line below is something the Android app does today. Families are not in the Android app yet (they are on the web only), so nothing here mentions them.

**How Play reads this** (Google's own pages, checked 2026-10-19): the title, short description and full description are all used in search, and Google asks for everyday language, not lists of keywords. Repeated or unrelated keywords can get an app suspended (https://support.google.com/googleplay/android-developer/answer/9898842). The title should say what the app does, without "Free", rankings or emoji, and the short description, which shows in search results, has no prices, promotions, "#1" or "Best". Google also says people may read only the first few sentences, so those carry the point (https://support.google.com/googleplay/android-developer/answer/13393723). Graphics and screenshots may not say "Free", "New", "Best", "#1", "Download now" and the like, and screenshots must show the real app (https://support.google.com/googleplay/android-developer/answer/9866151). Limits: https://support.google.com/googleplay/android-developer/answer/9859152.

**What the category says** (the listings of Proton Drive, Tresorit, Sync.com, pCloud, MEGA, Filen and Internxt, read 2026-10-19): "cloud storage" is the head term (five of seven titles, nearly every short description), then "encrypted cloud storage" or "end-to-end encrypted" (six of seven), "secure", "private", "share files securely" with password or expiring links, and "open source" (Proton, Internxt). Photo backup is everyone's second screenshot; HushOS has no automatic photo backup, so it doesn't claim one. Several of them say "free", "most secure" or "military-grade"; a new app should not copy that.

**App name** (30 max). Recommended, 29:

```text
HushOS: Encrypted Cloud Drive
```

The app was created as `HushOS: Encrypted Drive` (23). The name can change in the listing at any time without a new build. The longer one puts "encrypted" and "cloud" in the field Play weighs most, matches searches for "encrypted cloud", "cloud drive" and "encrypted drive", and no competitor's title says "encrypted". `HushOS: Private Cloud Storage` (29) holds the exact head term but "private" is softer than what the app can claim, and Proton and Internxt already own that wording. `HushOS: Encrypted Cloud Storage` is 31, one too many.

**Short description** (80 max), 77:

```text
End-to-end encrypted cloud storage. Your files are locked before they upload.
```

The two most searched phrases sit in the two most indexed fields, and it doesn't repeat the title word for word. The previous one ("Private cloud storage. Your files are locked on your phone before they upload.", 78) is still fine if the owner prefers it.

**Full description** (4000 max), 2226:

```text
HushOS is end-to-end encrypted cloud storage for your files, photos and documents. Everything you add is locked on your phone before it uploads, with a key made on your device. We store your files and hand them back, but we can't open them.

A PRIVATE DRIVE THAT WORKS LIKE THE ONE YOU USE
• Browse, search and tag your files and folders. Search runs on your phone, so nothing you type is sent to us.
• Upload files, photos and whole folders, or take a photo straight into a folder.
• Uploads keep going when you leave the app, with their progress in a notification.
• Rename, move, copy, and move to Trash. Trash keeps things for 30 days.
• Keep a file or a whole folder on your phone, to open without a connection.
• Save to HushOS from the share menu in other apps.
• HushOS appears in the system file picker and in Files by Google, so other apps can open and save your files.

SHARE FILES SECURELY
• Share a file or folder with another HushOS account, as someone who can view or someone who can edit.
• Check it's really them first: you each read the same twelve words, in person or on a call.
• Shares between accounts are sealed with post-quantum encryption (ML-KEM-768 alongside X25519).
• Or make a link anyone can open in a browser, with a password or an end date if you like. Turn it off whenever you want.
• Each item says who can open it when that's different from its folder.

YOUR ACCOUNT
• Your password never leaves your phone, not even when you sign in.
• See every device signed in to your account, and remove one you don't recognise.
• If you forget your password, your recovery kit and a link we email you get you back in. Without the kit nobody can, including us.

WHAT WE CAN SEE
Your email, your name, the devices you sign in on, how much you store, the sizes of your files, when they changed, and how your folders nest. Not their names or contents, and not your password.

OPEN SOURCE
All of HushOS is open source under the AGPL: the apps and the server. Anyone can read how it works, and anyone can run their own server. The app signs in to yours too.

The service at hushos.com keeps its servers and your files in the European Union.

You need a HushOS account to use the app. Make one at hushos.com.
```

"Encrypted", "cloud storage", "share files securely", "private" and "open source" each appear once or twice, in sentences. "Free" appears nowhere: Google's best-practice page puts price and promotional words out of every listing field, and the payments section below keeps plans out of the app. "For free" was dropped from the last line for that reason.

**Release notes** for 0.9.0, the first internal, closed and production release (500 max per language), 386:

```text
<en-US>
The first release of HushOS for Android.
• Your end-to-end encrypted drive: browse, search, tag, and upload files, photos and whole folders.
• Keep files and folders on your phone to open without a connection.
• Share with people you check with twelve words, or with a link.
• HushOS in the system file picker and Files by Google.
• See and remove the devices signed in to your account.
</en-US>
```

**Graphics:** `docs/release/assets/google-play-icon.png` (512×512, 32-bit PNG) and `docs/release/assets/google-feature-graphic.png` (1024×500, 24-bit PNG, no alpha), both made by `bun run --cwd apps/web store:graphics` from `apps/web/src/lib/brand.ts`. The feature graphic is the home page's social card cut to Play's size: the mark, "Nobody else can look inside.", "End-to-end encrypted cloud storage. Open source." and the dithered HUSH panel (redrawn 2026-10-19; the earlier one was the plain white card from before the site's Dither identity).

**Data-sync video** (google.md 3.2): `docs/release/assets/android-data-sync.mp4`, 56 s, 1080×1920, recorded on the store emulator on 2026-10-19. A 400 MB upload is started from Files › Work, the app goes Home, and the shade shows "Uploading 1 file" from about 30% to "1 file uploaded". Then the app reopens with the file in place. The notification never names the file. The emulator's own "Serial console enabled" notice shows under it; a take on a real phone would be cleaner.

## Screenshots

`scripts/store-screenshots.sh` captures these from the debug apps signed in to the local demo account (Maya Lindqvist; made-up names and generated photos, no real data), light mode, clean status bar. The spec that makes the account (`e2e/screenshots.spec.ts`) also makes Jonas Berg, shares Family with him and leaves Family with one link; the trip photos are CC0 from Wikimedia Commons (`e2e/fixtures/photos/README.md`). Times on screen are in a timezone where it is mid-morning when the shots are taken. Output: `docs/release/screenshots/{ios,android}/`. iOS taken 2026-10-06. Android retaken 2026-10-19 from `main`, against an isolated instance (`SCREENSHOTS_DOMAIN=example.org`, so addresses read `maya.lindqvist@example.org` in full), with the status-bar clock set to the time on the device so it is never earlier than the newest row.

| #   | File                        | iOS screen                                         | Android screen                                                                                     |
| --- | --------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1   | `01-home`                   | Home, after the keeps in shot 5                    | Same                                                                                               |
| 2   | `02-folder`                 | Files > Family > Lisbon 2026 as a grid of photos   | Same                                                                                               |
| 3   | `03-share`                  | Share sheet for Family: Jonas Berg and one link    | Same, opened from Family itself so the title matches the page behind it                            |
| 4   | `04-preview` / `04-shared`  | A photo open in the HushOS viewer (QuickLook)      | Shared > By me (Android opens files in other apps, so a viewer shot would show someone else's app) |
| 5   | `05-phone`                  | On this phone: Lisbon 2026, Finances, Q3 report.md | Same                                                                                               |
| 6   | `06-account` / `06-devices` | Account, top                                       | Account > Devices: this phone and one browser (no plan or storage figures)                         |
| 7   | `07-words`                  | Not taken                                          | Shared > People > Your twelve words (nothing about the plan behind it)                             |
| 8   | `08-files`                  | Not taken                                          | Android's Files app in HushOS > Family > Lisbon 2026, with the photos' thumbnails                  |

**Play's set, with captions.** `bun run --cwd apps/web store:graphics` draws each Android capture under one line of Geist on white, the capture rounded, ruled and cut off at the foot, into `docs/release/screenshots/android/play/`, numbered in the order Play shows them. Upload those, in that order. The first two carry the message; each line is something the app does today. Captions take about 8% of the image (Google's limit is 20%) and read at Play's thumbnail size.

| Play # | Capture      | Caption                                   |
| ------ | ------------ | ----------------------------------------- |
| 1      | `01-home`    | End-to-end encrypted cloud storage        |
| 2      | `02-folder`  | We store your files. We can't open them.  |
| 3      | `03-share`   | Share with the people you choose          |
| 4      | `07-words`   | Check it's really them, with twelve words |
| 5      | `04-shared`  | See everything you share                  |
| 6      | `05-phone`   | Keep folders on your phone for offline    |
| 7      | `08-files`   | Open and save from any app                |
| 8      | `06-devices` | See every device that's signed in         |

The iOS captions, if added later: 1 Nobody else can look inside. 2 Locked on your phone before it uploads. 3 Share with the people you choose, or with a link. 4 Open files right in the app. 5 Keep folders on your phone for when you're offline. 6 Your password never leaves your phone.

Sizes: iOS 1320×2868 (the 6.9-inch set; Apple scales it down for smaller iPhones). Android 1080×1920 (9:16; meets Play's 2:1 limit and the 1080-pixel minimum for promotion). If the app stays universal, iPad screenshots are also required (2064×2752); the script does not make them, because nothing is designed for iPad (see signing.md).

Take iOS shot 6 from a build after 2026-10-05: an older screenshot showing "Manage on the web" is itself metadata pointing at an outside purchase. No Android shot shows the plan's name or storage figures (the rule below): the Account tab is replaced by Devices, and the twelve words open from People rather than over Account. The iOS Account shot still shows them; retake it the same way before iOS goes up.

## What the apps and the listings must and must not say about plans

The apps are free and sell nothing. Plans are bought at hushos.com through Polar. Both stores allow this, but each limits what the app may say or link to. Checked 2026-10-05:

- **Apple, guideline 3.1.3(f), Free Stand-alone Apps:** a free companion to a paid web tool such as cloud storage needn't use in-app purchase, "provided there is no purchasing inside the app, or calls to action for purchase outside of the app" (https://developer.apple.com/app-store/review/guidelines/). Since May 2025 the **US** storefront may carry buttons and links to outside purchases without an entitlement (3.1.1(a)); 3.1.3(f) itself still says no calls to action, and Apple hasn't reconciled the two. Outside the US, no links or buttons to buy.
- **Google, Payments policy:** an app may be consumption-only, and "may choose to provide additional information about purchasing options without direct links". A link to an account page is fine only "as long as the webpage does not eventually lead to an alternate payment method" (https://support.google.com/googleplay/android-developer/answer/10281818). Links to web purchases are allowed only after enrolling in Google's US external-links program or the EEA/UK/Australia/Japan billing-choice program, with their APIs and a 10% fee on subscriptions (https://support.google.com/googleplay/android-developer/answer/16470497, https://support.google.com/googleplay/android-developer/answer/17161464).

What the apps did, and the change each needed. All of them were made on 2026-10-05; Account > Plan and storage now shows the plan's name, renewal date and storage only:

| Where                                                                       | Today                                                                                                      | iOS                                                                                 | Android                                                                  |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Account > Plans and storage, "Manage on the web" / "Update card on the web" | Opens `/app/billing`, which sells plans (`AccountView.swift` ~line 306; `AccountScreen.kt` ~line 309)      | **Remove the button.**                                                              | **Remove the button** (the page leads to payment).                       |
| Same screen, footer "Plans are chosen and paid for on the web."             | Shown on both                                                                                              | **Remove.** Show the plan's name and storage only ("Free · 2 GB", "Plus · 200 GB"). | May stay, as plain text with no link.                                    |
| Storage full sheet, "Get more room / Plans are on the web"                  | Opens `/app/billing` (`StorageFullSheet` in `AccountView.swift`; `RoomOption` in `HushOSApp.kt` ~line 515) | **Remove the option**; keep Empty trash and Remove earlier versions.                | Keep the words if you like, but **no link**: make it text, not a button. |
| Plan name and renewal date ("Renews 12 Oct")                                | Shown                                                                                                      | Fine: it is account information, not a call to action.                              | Fine.                                                                    |

**Store text:** say "free" and "free to start" only, and on Google Play not even that: its best-practice page keeps price and promotional words out of every field, so the Google text above never says "free". Never mention prices, plan names, "upgrade", or that plans are bought on the web, in any listing field or screenshot. The description's last line ("You can make one for free at hushos.com") points to a free account, not a purchase; if Apple objects, drop the "at hushos.com".

**Review notes:** say plainly that the app sells nothing and plans are bought on the web (apple.md has the text). Reviewers ask; telling them up front avoids a round trip.

## Deliberately not claimed

- **Sign-up in the app.** Not built; accounts are made at hushos.com.
- **Photos backup or automatic camera upload.** Not built and not planned.
- **Home Screen widgets.** The widget extension holds only the transfer Live Activity, and that was never checked on a real phone.
- **Team plans, invites by email, desktop apps.** Not built.
- **Families on Android.** Built on the web only; the Android app has no family folders yet. Nothing in the Google listing or its screenshots mentions them.
- **"Photo backup", "zero-knowledge", audits.** There is no automatic photo backup; "zero-knowledge" is a claim about a protocol nobody has reviewed independently, and no security audit has been done (privacy-answers.md says the same to Google).
- **"Military-grade", "bank-grade", "unhackable".** DESIGN.md forbids assurance blurbs, and they aren't true claims.
- **Offline editing, version restore, passkeys, Face ID lock.** Not verified in the apps.
- **The Live Activity, quick actions, transfer notifications.** Built, but too minor to sell and only checked in the simulator and emulator.
