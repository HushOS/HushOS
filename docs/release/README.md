# Releasing the HushOS apps

How HushOS, Inc. gets the iPhone and Android apps onto the App Store and Google Play: the order, what can run at the same time, and how long each wait is. Written 2026-10-05; store rules were checked that day on Apple's and Google's own pages.

| Document                                  | What it's for                                                                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| [checklist.md](checklist.md)              | The single list to finish before submitting. **Start here**: it lists the decisions only you can make and the app changes that block submission. |
| [apple.md](apple.md)                      | Apple, click by click: enrollment, signing, App Store Connect, TestFlight, review.                                                               |
| [google.md](google.md)                    | Google Play, click by click: developer account, app content, internal testing, production.                                                       |
| [signing.md](signing.md)                  | Certificates, bundle IDs, the app group, the Android upload key, and where the Team ID and fingerprints go.                                      |
| [store-listing.md](store-listing.md)      | Ready-to-paste copy, the screenshot plan, and what the apps may say about plans.                                                                 |
| [privacy-answers.md](privacy-answers.md)  | Apple App Privacy and Google Data safety answers, each with its reason from the code; the iOS privacy manifest.                                  |
| `scripts/release-wizard.sh`               | Walks you through the steps only you can do, one at a time, and checks what a Mac can check. Run it again any time.                              |
| `scripts/store-screenshots.sh`            | Takes the store screenshots from the simulator and emulator, guided.                                                                             |
| `bun run ios:archive <version> <build>`   | Archives and uploads the iPhone app (`apps/ios/scripts/archive.sh`).                                                                             |
| `bun run android:bundle <version> <code>` | Builds the signed Android App Bundle (`apps/android/scripts/bundle-release.sh`).                                                                 |
| `bun run --cwd apps/web store:graphics`   | Remakes the Play icon and feature graphic in `assets/`.                                                                                          |

## The order

The D-U-N-S number gates both stores, because both enroll HushOS, Inc. as an organization. **It has been applied for and is waiting to be issued.**

```text
                        ┌─ D-U-N-S issued (waiting: Apple says ≤5 business days, Google ≤30 days)
                        │
 NOW, in parallel ──────┤
 • Apple Account, 2FA   │   Apple                                  Google
 • Google account,      ├─► check it in Apple's lookup (≤2 days)   check it on dnb.com, then
   Search Console       │   enroll as organization                 Play Console org account
 • upload keystore      │   (Apple publishes no time; days)        + identity documents (days)
 • app changes          │   Team ID ─► APPLE_APP_IDS on prod       create app, App content
   (checklist.md)       │   App Store Connect record               upload key ─► first bundle
 • support page,        │   archive ─► TestFlight internal         internal testing (minutes)
   address/phone        │   real-phone checks                      Play signing SHA ─► assetlinks
 • demo accounts        │   external TestFlight (Beta review ~1d)  real-phone checks
 • screenshots, copy,   │   submit (most reviews <24 h)            (closed test 12×14 days only
   privacy answers      │                                           if Play asks for it)
 • counsel: export,     │                                          production review (≤7 days+)
   privacy labels       │
```

### Now, while the D-U-N-S number is pending

None of these needs the number. Do them in any order:

1. **Apple Account** with two-factor authentication, on a hushos.com address (apple.md, section 2).
2. **Google account** on a hushos.com address, and hushos.com verified in Search Console (google.md, section 1, steps 1 and 2).
3. **Android upload key** (`scripts/release-wizard.sh`, stage 7). It is made locally and doesn't depend on Google.
4. **Owner decisions** in checklist.md: the public address and phone, iPhone-only or universal, the version number, the App Store name.
5. **Counsel:** the encryption export answer (apple.md, section 8) and the two judgement calls in privacy-answers.md.
6. **The app changes** in checklist.md: privacy policy link, no purchase links, iOS privacy manifest. These are code; hand them to whoever works on the apps.
7. **Web:** the support page, the account-deletion page, the privacy policy paragraph on the apps (checklist.md, "Web and accounts").
8. **Review demo accounts** on hushos.com (apple.md, section 9).
9. **Screenshots** (`scripts/store-screenshots.sh`) after the app changes, **store copy** (store-listing.md, ready), **privacy answers** (privacy-answers.md, ready), **Play graphics** (`assets/`, ready).

### When the number arrives

1. Check it: Apple's D-U-N-S lookup must find **HushOS, Inc.** at the right address (apple.md, section 1). For Google, check the D&B record on dnb.com, and the Play sign-up checks it again (google.md, section 1). If either can't find it, wait 2 business days before chasing D&B.
2. Then Apple and Google run **in parallel**. Neither waits for the other.

### Apple, in order

1. Enroll as an organization (apple.md, section 3). Apple publishes no time for verifying an organization; allow a few days, and answer any call from Apple.
2. Team ID: `APPLE_APP_IDS` on production (wizard stage 5).
3. Agreements, EU trader status, Xcode sign-in (apple.md, sections 4 and 5).
4. App record, first archive and upload, TestFlight internal (apple.md, sections 6, 7 and 13).
5. Real-phone checks (checklist.md).
6. Optional: external TestFlight. The first build needs a Beta App Review, typically about a day.
7. Version page, App Privacy, age rating, submit (apple.md, sections 10 to 15). Apple reviews 90% of submissions within 24 hours.

### Google, in order

1. Play Console organization account and identity verification (google.md, section 1). No published timeline.
2. Create the app, App content, store listing (google.md, sections 2 to 4).
3. First bundle to internal testing (google.md, section 5). Testers get it within minutes, though a first test link can take a few hours.
4. Play app signing fingerprint: `ANDROID_APP_CERT_SHA256` on production (wizard stage 10). Real-phone checks.
5. Only if Play asks for it: a closed test with 12 testers for 14 days, then a production-access review of up to 7 days.
6. Production release and review: "up to seven days or longer" for some accounts (google.md, section 8).

## Rough calendar, from the day the number is issued

| Day  | Apple                                 | Google                                     |
| ---- | ------------------------------------- | ------------------------------------------ |
| 0–2  | Apple receives the D&B record; enroll | Play Console sign-up, documents            |
| 2–7  | Organization verified, pay, Team ID   | Account verified; app created; App content |
| 5–10 | First TestFlight build, phone checks  | Internal test, phone checks                |
| 7–14 | Submit; review usually within a day   | Production review, up to a week            |

These are estimates, not promises. Neither store commits to enrollment times. If Play turns out to apply the 12-tester rule, add about three weeks to the Google column.
