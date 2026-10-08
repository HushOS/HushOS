# Google Play: from the developer account to production review

Click by click, for HushOS, Inc. Requirements were checked on Google's own pages on 2026-10-05 (each cited inline). Play Console's menus move often. Where a label here doesn't match the screen, use the console's search box (top) with the name of the page.

`<<…>>` marks a value only you know.

## 0. Where things stand

- **D-U-N-S: applied, waiting for D&B to issue it.** Google says obtaining one "can take up to 30 days" (https://support.google.com/googleplay/android-developer/answer/13628312). Apple's figure is 5 business days; plan for the longer one.
- **While you wait, do these** (none needs the number):
    1. **The Google account** that will own the developer account (section 1, step 1).
    2. **Website ownership in Search Console** (section 1, step 2). It only needs that Google account and hushos.com's DNS.
    3. **The upload key** (`scripts/release-wizard.sh`, stage 7, or signing.md).
    4. **The demo accounts**, made once for both stores (apple.md, section 9).
    5. **The app changes** in checklist.md (privacy policy link, plan buttons, cleartext traffic) are done; check them on the release build.
    6. **Screenshots** (`scripts/store-screenshots.sh android`), copy (store-listing.md), Data safety answers (privacy-answers.md), the graphics (`docs/release/assets/`).
- **Only after the number is issued:** section 1 from step 3 onwards, and everything after.

## 1. The developer account, as an organization

Facts (https://support.google.com/googleplay/android-developer/answer/13634885, /answer/13628312, /answer/10788890):

- a one-time 25 USD fee;
- D-U-N-S is mandatory for organizations, and the account's details must stay consistent with the D&B profile;
- organization name, address, phone and website, plus a private contact (name, email, phone) and a **public** developer email and phone, each verified with a one-time code;
- an official identity document and an official organization document;
- website ownership through Search Console, for organizations.

Steps:

1. **The Google account.** Create one on a hushos.com address you'll keep, e.g. `<<you>>@hushos.com` (Create account > For work or my business, "use my current email address"). Turn on 2-Step Verification (Google Account > Security). It can be your existing Google account, but the developer account can't be moved to another Google account easily, so pick deliberately.
2. **Search Console.** Signed in as that account, open https://search.google.com/search-console > **Add property** > **Domain** > `hushos.com`. Google shows a TXT record. In Cloudflare: hushos.com > DNS > Records > Add record, type TXT, name `@`, content as shown. Back in Search Console: **Verify**. Play approves the website automatically when the same Google account owns it in Search Console (https://support.google.com/googleplay/android-developer/answer/13205715).
3. **Check the D-U-N-S number** once it arrives. Google checks it during account creation (step 5). Before that, open D&B's own lookup (dnb.com, "D-U-N-S Number lookup") and make sure the legal name reads exactly `HushOS, Inc.` and the address is the one you'll type in step 5. A mismatch here is the usual cause of a failed verification.
4. Open https://play.google.com/console/signup, signed in as the account from step 1.
5. Choose **An organization or business**, then fill in:

    | Field                                | Type                                                                            |
    | ------------------------------------ | ------------------------------------------------------------------------------- |
    | Developer name (public, on Play)     | `HushOS, Inc.`                                                                  |
    | Organization type / size             | Company; `<<size>>`                                                             |
    | Organization name                    | `HushOS, Inc.` (exactly as D&B)                                                 |
    | D-U-N-S number                       | `<<9 digits>>`. Google pulls the address from D&B; it must match.               |
    | Organization address and phone       | As on the D&B record: `<<address>>`, `<<phone>>`                                |
    | Website                              | `https://hushos.com` (verified through Search Console in step 2)                |
    | Contact name, email, phone (private) | You: `<<name>>`, your hushos.com address, `<<mobile>>`                          |
    | Developer email (public)             | `hello@hushos.com`, or a support address you'll answer                          |
    | Developer phone (public)             | `<<a number you're willing to publish>>`. Organization accounts must show one.  |
    | Expected number of apps; earning     | 1 to 5; "No, my apps don't earn money on Google Play" (nothing is sold on Play) |

6. Verify each email and phone with the codes sent.
7. **Pay** the 25 USD.
8. **Identity verification:** upload your government ID, and the organization document when asked (the Delaware certificate of incorporation, or a recent good-standing certificate). Google publishes no total timeline for verification. Watch the inbox of the account from step 1.
9. **Android developer verification.** Since 30 September 2026 every Play package must be registered (https://support.google.com/googleplay/android-developer/answer/16984799). Apps using Play App Signing are registered automatically. After section 5, check **Android developer verification** in the console's left menu: `com.hushos.app` should show as registered.

### The 12-tester, 14-day rule

Personal accounts created after 13 November 2023 must run a closed test with at least 12 testers, opted in for 14 days, before they can apply for production (https://support.google.com/googleplay/android-developer/answer/14151465). Google's article covers **personal accounts only**. Organization accounts being exempt rests on a Play Product Expert guide (https://support.google.com/googleplay/android-developer/community-guide/255621488), not on a Google policy page. Expect no such gate. **If** the Dashboard of your new app shows "Apply for production access" with a testing requirement, the rule applies to you after all: run a closed test (section 7) with 12 testers for 14 days, then apply. The production-access review usually takes 7 days or less.

## 2. Create the app

https://support.google.com/googleplay/android-developer/answer/9859152, checked 2026-10-05.

1. Play Console > **Home** > **Create app**.
2. Fill in:
    - **App name:** `HushOS: Encrypted Drive`
    - **Default language:** English (United States), en-US
    - **App or game:** App
    - **Free or paid:** Free. Google's page doesn't say whether this can change later; assume a free app stays free (plans are sold on the web anyway).
    - **Declarations:** tick Developer Program Policies, US export laws, and the Play App Signing terms.
3. **Create app.** The app's **Dashboard** opens with a "Set up your app" checklist; sections 3 and 4 are that list.

## 3. App content (Policy > App content)

Every item is required before any release, even internal (https://support.google.com/googleplay/android-developer/answer/9859455):

| Declaration                                  | Answer                                                                                                                                                                                                                                                                       |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Privacy policy**                           | `https://hushos.com/privacy`. Google also wants a link or the text inside the app (https://support.google.com/googleplay/android-developer/answer/10144311); it is in Account and on the sign-in screen.                                                                     |
| **App access**                               | "All or some functionality is restricted." Add instructions: name `App Review`, user name `appreview@hushos.com`, password `<<…>>`, other info: `No one-time codes. If the sign-in screen shows a server address, it must be hushos.com.` (Up to five sets of instructions.) |
| **Ads**                                      | No, my app does not contain ads.                                                                                                                                                                                                                                             |
| **Content rating**                           | Section 3.1.                                                                                                                                                                                                                                                                 |
| **Target audience and content**              | Age groups: **18 and over** only. The terms require being old enough to make the agreement where you live, and choosing younger groups brings in the Families policy. "Could your store listing unintentionally appeal to children?" No.                                     |
| **News apps**                                | No.                                                                                                                                                                                                                                                                          |
| **COVID-19 contact tracing and status apps** | My app is not a publicly available COVID-19 contact tracing or status app.                                                                                                                                                                                                   |
| **Data safety**                              | privacy-answers.md, Google section, item by item.                                                                                                                                                                                                                            |
| **Government apps**                          | No.                                                                                                                                                                                                                                                                          |
| **Financial features**                       | "My app doesn't provide any financial features." Every app must complete it (https://support.google.com/googleplay/android-developer/answer/13849271).                                                                                                                       |
| **Health apps**                              | None of the health features. Every app must complete it (https://support.google.com/googleplay/android-developer/answer/14738291).                                                                                                                                           |
| **Foreground service permissions**           | Section 3.2.                                                                                                                                                                                                                                                                 |
| **Photo and video permissions**              | Not shown, or "no": the app requests no `READ_MEDIA_*` permission (photos come through the system picker).                                                                                                                                                                   |
| **Advertising ID**                           | If asked: No, the app doesn't use an advertising ID. The merged release manifest has no `AD_ID` permission (checked 2026-10-05; WorkManager adds only `WAKE_LOCK` and `RECEIVE_BOOT_COMPLETED`).                                                                             |

### 3.1 Content rating (IARC questionnaire)

**Content rating** > **Start questionnaire**. Email: `hello@hushos.com`. Category: **All other app types** (the "Utility, productivity, communication, or other" kind).

| Question (in substance)                                              | Answer                                                                   |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Violence, fear, sexuality, language, controlled substances, gambling | No                                                                       |
| Can users interact or exchange content with each other?              | **Yes**: people share files and folders with other accounts and by link. |
| Does the app share the user's current physical location?             | No                                                                       |
| Does the app allow purchases of digital goods?                       | No (nothing is sold in the app)                                          |
| Is it a web browser or search engine?                                | No                                                                       |

Expect a low rating (Everyone / PEGI 3 or similar) with a "Users Interact" note. Re-do it whenever an answer would change.

### 3.2 Foreground service: dataSync (needs a video)

The manifest declares `FOREGROUND_SERVICE_DATA_SYNC`: WorkManager runs queued uploads and "keep on this phone" downloads as a data-sync foreground job, with a notification. Apps targeting Android 14+ must declare each type and attach a video link (https://support.google.com/googleplay/android-developer/answer/13392821):

1. **Foreground service permissions** > tick **Data sync**.
2. **Description:** `Uploads the person's files to their HushOS drive, and downloads files they chose to keep on the phone, after they start it. The transfer shows a notification with progress and continues if they leave the app, so large uploads finish.`
3. **Impact if deferred:** `A large upload or a folder kept for offline use would stop when the person leaves the app and leave partial files.`
4. **Video:** record the emulator or a phone: start an upload of a large file, go Home, pull down the notification showing progress, return when it finishes. Upload it unlisted to YouTube (or a shareable Drive link) and paste the URL.

Google recommends the "user-initiated data transfer" job API over data sync for transfers the user starts. Review may push back; moving to it is an app change (checklist.md).

## 4. Store listing (Grow users > Store presence > Main store listing)

Everything from store-listing.md:

- **App name, short description, full description.**
- **App icon:** `docs/release/assets/google-play-icon.png` (512×512, 32-bit PNG).
- **Feature graphic:** `docs/release/assets/google-feature-graphic.png` (1024×500, no alpha).
- **Phone screenshots:** `docs/release/screenshots/android/01-home.png` … `06-account.png` (2 to 8; JPEG or 24-bit PNG; 320 to 3840 px; the long side at most twice the short; 1080×1920 makes them eligible for promotion). Source: https://support.google.com/googleplay/android-developer/answer/9866151.
- **Tablet screenshots:** leave empty (needed only for large-screen promotion).
- **Video:** none.

**Store settings** (Grow users > Store presence > Store settings):

- **App category:** Productivity. **Tags:** pick up to five that fit, e.g. Cloud storage, File management, Privacy.
- **Contact details:** email `hello@hushos.com`, website `https://hushos.com`, phone optional.

## 5. The first build: internal testing

Facts: new apps must ship as App Bundles with Play App Signing (https://developer.android.com/guide/app-bundle, https://support.google.com/googleplay/android-developer/answer/9842756). Internal tests take up to 100 testers, reach them within minutes, and "might not be subject to standard Play policy or security reviews" (https://support.google.com/googleplay/android-developer/answer/9845334). Since 31 August 2026 new apps must target API 36; the app does.

1. Build the bundle:

    ```sh
    bun run android:bundle 1.0.0 1     # or: apps/android/scripts/bundle-release.sh 1.0.0 1
    ```

    It writes `apps/android/app/build/outputs/bundle/release/app-release.aab`, signed with the upload key, and prints the key's SHA-256. Commit the `build.gradle.kts` version change afterwards.

2. Play Console > **Test and release > Testing > Internal testing** > **Testers** tab > **Create email list**: `HushOS team`, add the Gmail or Google Workspace addresses of your testers (yours first) > Save. Tick the list.
3. **Releases** tab > **Create new release**.
4. **App integrity / Play App Signing:** on the first release Play asks how the app is signed. Choose **Use Google-generated key** (the default). Your upload key is whatever signed this first bundle. Google now also enrolls new apps in "quantum-ready, hybrid signing".
5. **App bundles:** **Upload** the `.aab`.
6. **Release name:** `1.0.0 (1)`. **Release notes:** from store-listing.md.
7. **Next** > review the warnings (a warning about deobfuscation files is fine, errors are not) > **Save and publish** (or **Start rollout to Internal testing**).
8. **Testers** tab > **Copy link** under "How testers join your test". Each tester opens it on their phone signed in to that Google account, accepts, then installs from Play. Google says a first test link can take a few hours to start working.

## 6. App links, then the device checks

1. **The app signing key's fingerprint.** Play Console > HushOS > **Protected with Play > Play Store distribution > Go to Play app signing** (older help: Release > Setup > App signing) > "App signing key certificate" > **SHA-256 certificate fingerprint**. Copy it.
2. Run `scripts/release-wizard.sh`, stage 10. It prints the production setting `ANDROID_APP_CERT_SHA256=<app signing>,<upload>` and checks that `https://hushos.com/.well-known/assetlinks.json` serves it after you deploy. signing.md explains why both.
3. Play Console > **Grow users > Deep links** should then show `hushos.com` as verified for the `/s/`, `/app` and `/recover/complete` paths.
4. Install the internal-test build on a real phone and run checklist.md's device checks. Force verification with `adb shell pm verify-app-links --re-verify com.hushos.app`, then `adb shell pm get-app-links com.hushos.app`; it should say `hushos.com: verified`.

## 7. Closed testing (only if you want outside testers, or the 12-tester rule applies)

**Test and release > Testing > Closed testing** > **Create track** (or use **Alpha**) > testers by email list or a Google Group (`<<name>>@googlegroups.com`) > **Create new release** > add the same bundle from the library (or a newer one) > **Save and publish**. Closed and open tracks go through review. Google's page doesn't say how long it takes.

## 8. Production

1. **Test and release > Production** > **Countries / regions** > **Add countries** > all. Unlike Apple, Google asks no encryption questions. Export compliance is your own obligation under US law (apple.md, section 8).
2. **Create new release** > add the bundle tested internally > release name `1.0.0 (1)` > notes > **Next** > **Save**.
3. **Publishing overview** (left menu) > **Send changes for review**. Review time isn't published: "up to seven days or longer in exceptional cases" for some accounts (https://support.google.com/googleplay/android-developer/answer/9859751). New accounts tend to wait longer.
4. **Managed publishing** (Publishing overview) can hold an approved release until you press Publish, but not for an app's first publish. Staged rollout is for updates only (https://support.google.com/googleplay/android-developer/answer/6346149).

## 9. Payments policy: what the app may link to

The Android app used to link to `/app/billing`, which sells plans; outside Google's link-out programs that breaks the Payments policy (https://support.google.com/googleplay/android-developer/answer/10281818). The links are gone; the app names the plan and storage only (store-listing.md). Enrolling in the US external-links program or the EEA/UK billing-choice program is an option for later; it needs Google's APIs in the app and pays Google 10% of subscriptions bought through the link.

## 10. After approval

1. Check the listing at `https://play.google.com/store/apps/details?id=com.hushos.app`.
2. Add the Google Play link to hushos.com (the home page FAQ still says to add the website to the home screen).
3. Every update: `bun run android:bundle <version> <next versionCode>`, upload to internal testing, check, then **Promote release** to production.
