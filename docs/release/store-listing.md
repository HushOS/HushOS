# Store listing copy

Ready to paste. Every claim here was checked against the apps on branch `redesign/alpine` on 2026-10-05; the list of what was deliberately left out is at the end. Limits are the stores' own (Apple: https://developer.apple.com/help/app-store-connect/reference/app-information/platform-version-information; Google: https://support.google.com/googleplay/android-developer/answer/9859152; both checked 2026-10-05). Counts below are characters (Apple's keyword limit is bytes; the keywords are ASCII, so the same).

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

**App name** (30 max), 23:

```text
HushOS: Encrypted Drive
```

**Short description** (80 max), 78:

```text
Private cloud storage. Your files are locked on your phone before they upload.
```

**Full description** (4000 max), 1869:

```text
HushOS is a private drive for your files. Everything you add is locked on your phone before it is uploaded, with a key made on your device that stays with you. We store your files and hand them back, but we can't open them.

IT WORKS LIKE THE DRIVE YOU ALREADY USE
• Browse, search and tag your files and folders. Search runs on your phone, so nothing you type is sent anywhere.
• Upload files and photos, or take a photo straight into a folder.
• Rename, move, copy, and move to Trash. Trash keeps things for 30 days.
• Keep a file or a whole folder on your phone, to open without a connection.
• Uploads keep going when you leave the app.
• Save to HushOS from the share menu in other apps.
• HushOS appears in Android's Files app and in every file picker, so other apps can open and save your files.

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

**Release notes** for the first internal, closed and production release (500 max per language):

```text
<en-US>
The first release of HushOS for Android.
</en-US>
```

**Graphics:** `docs/release/assets/google-play-icon.png` (512×512, 32-bit PNG) and `docs/release/assets/google-feature-graphic.png` (1024×500, 24-bit PNG, no alpha), both made by `bun run --cwd apps/web store:graphics` from `apps/web/src/lib/brand.ts` and the home page's heading.

## Screenshots

`scripts/store-screenshots.sh` captures these from the debug apps signed in to the local demo account (Maya Lindqvist; made-up names and generated photos, no real data), light mode, clean status bar. The spec that makes the account (`e2e/screenshots.spec.ts`) also makes Jonas Berg, shares Family with him and leaves Family with one link; the trip photos are CC0 from Wikimedia Commons (`e2e/fixtures/photos/README.md`). Times on screen are in a timezone where it is mid-morning when the shots are taken. Taken 2026-10-06. Output: `docs/release/screenshots/{ios,android}/`.

| #   | File                       | iOS screen                                         | Android screen                                                                                     | Caption, if you add captions later                                     |
| --- | -------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1   | `01-home`                  | Home, after the keeps in shot 5                    | Same                                                                                               | Nobody else can look inside.                                           |
| 2   | `02-folder`                | Files > Family > Lisbon 2026 as a grid of photos   | Same                                                                                               | Locked on your phone before it uploads.                                |
| 3   | `03-share`                 | Share sheet for Family: Jonas Berg and one link    | Same                                                                                               | Share with the people you choose, or with a link.                      |
| 4   | `04-preview` / `04-shared` | A photo open in the HushOS viewer (QuickLook)      | Shared > By me (Android opens files in other apps, so a viewer shot would show someone else's app) | Open files right in the app. / See everything you share, in one place. |
| 5   | `05-phone`                 | On this phone: Lisbon 2026, Finances, Q3 report.md | Same                                                                                               | Keep folders on your phone for when you're offline.                    |
| 6   | `06-account`               | Account, top                                       | Same                                                                                               | Your password never leaves your phone.                                 |

Sizes: iOS 1320×2868 (the 6.9-inch set; Apple scales it down for smaller iPhones). Android 1080×1920 (9:16; meets Play's 2:1 limit and the 1080-pixel minimum for promotion). If the app stays universal, iPad screenshots are also required (2064×2752); the script does not make them, because nothing is designed for iPad (see signing.md).

Take shot 6 from a build after 2026-10-05: an older screenshot showing "Manage on the web" is itself metadata pointing at an outside purchase.

## What the apps and the listings must and must not say about plans

The apps are free and sell nothing. Plans are bought at hushos.com through Polar. Both stores allow this, but each limits what the app may say or link to. Checked 2026-10-05:

- **Apple, guideline 3.1.3(f), Free Stand-alone Apps:** a free companion to a paid web tool such as cloud storage needn't use in-app purchase, "provided there is no purchasing inside the app, or calls to action for purchase outside of the app" (https://developer.apple.com/app-store/review/guidelines/). Since May 2025 the **US** storefront may carry buttons and links to outside purchases without an entitlement (3.1.1(a)); 3.1.3(f) itself still says no calls to action, and Apple hasn't reconciled the two. Outside the US, no links or buttons to buy.
- **Google, Payments policy:** an app may be consumption-only, and "may choose to provide additional information about purchasing options without direct links". A link to an account page is fine only "as long as the webpage does not eventually lead to an alternate payment method" (https://support.google.com/googleplay/android-developer/answer/10281818). Links to web purchases are allowed only after enrolling in Google's US external-links program or the EEA/UK/Australia/Japan billing-choice program, with their APIs and a 10% fee on subscriptions (https://support.google.com/googleplay/android-developer/answer/16470497, https://support.google.com/googleplay/android-developer/answer/17161464).

What the apps did, and the change each needed. All of them were made on 2026-10-05; Account > Plan and storage now shows the plan's name, renewal date and storage only:

| Where                                                                       | Today                                                                                                      | iOS                                                                                 | Android                                                                  |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Account > Plans and storage, "Manage on the web" / "Update card on the web" | Opens `/app/billing`, which sells plans (`AccountView.swift` ~line 306; `AccountScreen.kt` ~line 309)      | **Remove the button.**                                                              | **Remove the button** (the page leads to payment).                       |
| Same screen, footer "Plans are chosen and paid for on the web."             | Shown on both                                                                                              | **Remove.** Show the plan's name and storage only ("Free · 1 GB", "Plus · 200 GB"). | May stay, as plain text with no link.                                    |
| Storage full sheet, "Get more room / Plans are on the web"                  | Opens `/app/billing` (`StorageFullSheet` in `AccountView.swift`; `RoomOption` in `HushOSApp.kt` ~line 515) | **Remove the option**; keep Empty trash and Remove earlier versions.                | Keep the words if you like, but **no link**: make it text, not a button. |
| Plan name and renewal date ("Renews 12 Oct")                                | Shown                                                                                                      | Fine: it is account information, not a call to action.                              | Fine.                                                                    |

**Store text:** say "free" and "free to start" only. Never mention prices, plan names, "upgrade", or that plans are bought on the web, in any listing field or screenshot. The description's last line ("You can make one for free at hushos.com") points to a free account, not a purchase; if Apple objects, drop the "at hushos.com".

**Review notes:** say plainly that the app sells nothing and plans are bought on the web (apple.md has the text). Reviewers ask; telling them up front avoids a round trip.

## Deliberately not claimed

- **Sign-up in the app.** Not built; accounts are made at hushos.com.
- **Photos backup or automatic camera upload.** Not built and not planned.
- **Home Screen widgets.** The widget extension holds only the transfer Live Activity, and that was never checked on a real phone.
- **Team plans, invites by email, desktop apps.** Not built.
- **"Military-grade", "bank-grade", "unhackable".** DESIGN.md forbids assurance blurbs, and they aren't true claims.
- **Offline editing, version restore, passkeys, Face ID lock.** Not verified in the apps.
- **The Live Activity, quick actions, transfer notifications.** Built, but too minor to sell and only checked in the simulator and emulator.
