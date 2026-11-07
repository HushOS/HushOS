# Releasing the HushOS apps

Both apps are live: the Android app on Google Play since October 2026, and the iPhone app on the App Store since 1.0 (November 2026).

- **Each release** follows the steps below.
- **The first submission** (enrolment, the app records, review) is done. apple.md, google.md and checklist.md keep it as a reference, for a new app or a second account.

## Each release

1. **Merge the release pull request** (`chore(main): release X.Y.Z`). release-please tags `vX.Y.Z` and publishes the GitHub release. CONTRIBUTING.md, "Releasing", has the details.
2. **Android, by workflow.** `android-release.yml` builds the bundle, puts it on internal testing, and attaches the APK. Check it on a phone, then promote:

    ```sh
    gh workflow run android-release.yml --ref vX.Y.Z -f action=promote
    ```

3. **iPhone, on a Mac.** GitHub's runners don't have Xcode 27 yet, so from the tag:

    ```sh
    git checkout vX.Y.Z
    DEVELOPMENT_TEAM=9T67GJ663Z bun run ios:archive   # uploads to App Store Connect
    bun run ios:release-ipa vX.Y.Z     # the unsigned IPA on the GitHub release
    ```

4. **Submit the iPhone build for review** in App Store Connect once it has processed: a new version, What's New, the build, then Add for Review.

## Documents and scripts

| Document                                 | What it's for                                                                                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [checklist.md](checklist.md)             | The list for the first submission, done; kept as a reference.                                                                                                 |
| [apple.md](apple.md)                     | Apple, click by click: enrollment, signing, App Store Connect, TestFlight, review.                                                                            |
| [google.md](google.md)                   | Google Play, click by click: developer account, app content, internal testing, production.                                                                    |
| [signing.md](signing.md)                 | Certificates, bundle IDs, the app group, the Android upload key, and where the Team ID and fingerprints go.                                                   |
| [store-listing.md](store-listing.md)     | Ready-to-paste copy, the screenshot plan, and what the apps may say about plans.                                                                              |
| [privacy-answers.md](privacy-answers.md) | Apple App Privacy and Google Data safety answers, each with its reason from the code; the iOS privacy manifest.                                               |
| [google-play-ci.md](google-play-ci.md)   | The Android release workflow: each release's bundle to Google Play internal testing, promotion to production, and its one-time setup.                         |
| `scripts/release-wizard.sh`              | Walks you through the steps only you can do, one at a time, and checks what a Mac can check. Run it again any time.                                           |
| `scripts/store-screenshots.sh`           | Takes the store screenshots from the simulator and emulator, guided.                                                                                          |
| `bun run ios:archive`                    | Archives and uploads the iPhone app (`apps/ios/scripts/archive.sh`), at package.json's version and the commit's build number.                                 |
| `bun run android:bundle`                 | Builds the signed Android App Bundle (`apps/android/scripts/bundle-release.sh`), versioned the same way.                                                      |
| `bun run android:release-apk vX.Y.Z`     | After the bundle: builds the tag's APK with the same key and version code and attaches it to the GitHub release (`apps/android/scripts/release-apk.sh`).      |
| `bun run ios:release-ipa vX.Y.Z`         | Builds the tag's unsigned IPA for sideloading tools (AltStore, SideStore, iloader) and attaches it to the GitHub release (`apps/ios/scripts/release-ipa.sh`). |
| `bun run --cwd apps/web store:graphics`  | Remakes the Play icon and feature graphic in `assets/`.                                                                                                       |
