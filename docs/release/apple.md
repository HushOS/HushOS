# Apple: from enrollment to App Store review

Click by click, for HushOS, Inc. Requirements were checked on Apple's own pages on 2026-10-05 (each cited inline). Apple renames buttons now and then; where a label here doesn't match the screen, look for the nearest equivalent, and don't guess at legal answers.

`<<…>>` marks a value only you know. `scripts/release-wizard.sh` runs the steps that can be checked from a Mac; this page is the full version.

## 0. Where things stand

- **D-U-N-S: applied, waiting for D&B to issue it.** Apple says D&B takes up to 5 business days (paying to expedite doesn't help), then up to 2 more business days for Apple to receive the record. If two weeks pass, email D&B (https://developer.apple.com/help/account/membership/D-U-N-S/).
- **While you wait, do these** (none needs the number):
    1. The Apple Account with two-factor authentication (section 2).
    2. A public support page and a business address and phone you're happy to publish (checklist.md, "Owner decisions"). Apple needs them for the Support URL and, in the EU, for trader status.
    3. The demo accounts for App Review on hushos.com (section 9).
    4. The app changes in checklist.md (privacy policy link, plan buttons, privacy manifest, iPad decision). Without them the first submission is rejected or the upload refused.
    5. Screenshots (`scripts/store-screenshots.sh ios`), store copy (store-listing.md), privacy answers (privacy-answers.md).
- **Only after the number is issued:** sections 1, 3 and everything after.

## 1. Check the D-U-N-S number is live and matched

1. Open https://developer.apple.com/enroll/duns-lookup/ and sign in with the Apple Account from section 2.
2. Fill in exactly what D&B has on file. Legal entity name `HushOS, Inc.`; the headquarters and mailing address you gave D&B; your work contact details.
3. Submit. Apple should show the same 9-digit number D&B sent you.
    - **Found, name and address match:** continue to section 3.
    - **Not found:** if D&B issued it less than 2 business days ago, wait. Otherwise the lookup offers to submit your details to D&B; or contact D&B through Apple's link, support.dnb.com/?CUST=APPLEDEV.
    - **Found, but the name or address differs:** correct the record with D&B first. Apple takes the seller name shown on the App Store from this record, and it can't be a trade name (https://developer.apple.com/programs/enroll/).

## 2. Apple Account with two-factor authentication

Apple requires two-factor authentication. It also wants a work email on the organization's domain: "Your work email address needs to associated with your organization's domain name" (Apple's typo; https://developer.apple.com/programs/enroll/).

1. Choose the address: a hushos.com mailbox you'll keep, e.g. `<<you>>@hushos.com`, not a personal Gmail. hushos.com receives mail through Cloudflare Email Routing (MX `route1-3.mx.cloudflare.net`), so a forwarding address works for receiving. Make sure it reaches you.
2. Go to https://account.apple.com and create the account with that address (or sign in, if you already have one on it). Use your legal name; Apple may verify your identity against it.
3. **Sign-In and Security > Two-Factor Authentication > Turn On.** Add a trusted phone number you will keep for years.
4. Install **Apple Developer** from the App Store on your iPhone and sign in. Enrollment can be finished there, and it is the quickest place to see enrollment messages.

## 3. Enroll HushOS, Inc. in the Apple Developer Program

Requirements (https://developer.apple.com/programs/enroll/ and https://developer.apple.com/help/account/membership/program-enrollment/, checked 2026-10-05):

- a D-U-N-S number registered to the legal entity;
- a website that is public, works, and is on the organization's domain;
- the person enrolling must have "the legal authority to bind your organization to legal agreements": an owner, founder or executive, or someone a senior employee authorizes;
- 99 USD a year.

Steps:

1. Open https://developer.apple.com/programs/enroll/ > **Start Your Enrollment**, and sign in.
2. **Entity type:** Company / Organization.
3. **Your information:** your legal first and last name, phone, work email (the hushos.com address), and your job title (`<<Founder / CEO / your title>>`).
4. **Organization information:**

    | Field                        | Type                                                     |
    | ---------------------------- | -------------------------------------------------------- |
    | Legal entity name            | `HushOS, Inc.`                                           |
    | D-U-N-S Number               | `<<9 digits>>`                                           |
    | Headquarters address / phone | Exactly as on the D&B record: `<<address>>`, `<<phone>>` |
    | Website                      | `https://hushos.com`                                     |
    | Work email                   | your hushos.com address                                  |

5. **Legal binding authority:** confirm you have it. If you're not an officer, name a senior person who can confirm it. Apple may phone either of you, or ask for business documents. Have the Delaware certificate of incorporation (file 3458990, 16 April 2024) ready.
6. Agree to the Apple Developer Agreement and submit.
7. Wait for Apple's email. Apple publishes no figure for how long verifying an organization takes; it can take days. When verified, the email says to pay.
8. **Pay** the 99 USD with a company card. Apple says to contact them if there's no confirmation within 24 hours of paying (https://developer.apple.com/support/enrollment/).

## 4. After the membership is active

1. **Team ID.** https://developer.apple.com/account > **Membership details** > Team ID (10 capital letters and digits). Run `scripts/release-wizard.sh` (stages 3 and 5), which saves it to `.env.release` and prints the server setting. Or set `APPLE_APP_IDS=<TEAMID>.com.hushos.app` on the production server yourself and check `https://hushos.com/.well-known/apple-app-site-association` (signing.md).
2. **Agreements.** https://appstoreconnect.apple.com > **Business**. Accept the latest **Apple Developer Program License Agreement** (only the Account Holder can). A free app with no in-app purchase does **not** need the Paid Applications Agreement, bank or tax forms.
3. **EU trader status** (Digital Services Act). Required since February 2025, or the app is removed from the EU storefronts (https://developer.apple.com/news/upcoming-requirements/). App Store Connect > **Business** (or **Agreements**) > Digital Services Act > **trader**. HushOS, Inc. is a trader: it runs the service commercially. Give the address, phone and email that will be **shown publicly to EU customers**, verify the email and phone, and upload a document showing the address. Decide first which address and phone to publish (checklist.md).
4. **Users** (optional). App Store Connect > **Users and Access** > **+**: add anyone who should test internally (role Developer or Marketing is enough for TestFlight internal testing; they need an Apple Account).

## 5. Xcode and signing

1. Install the current Xcode from the Mac App Store. Apple has required the iOS 26 SDK (Xcode 26 or later) for uploads since 28 April 2026; this Mac has Xcode 27.
2. **Xcode > Settings > Accounts > + > Apple Account**, sign in with the enrolled account. Select **HushOS, Inc.**: your role should read **Account Holder** or **Admin**.
3. Signing is automatic. The first archive registers the bundle IDs, the app group and the capabilities (signing.md has the list, and the manual route).

## 6. Create the app record

https://developer.apple.com/help/app-store-connect/create-an-app-record/add-a-new-app, checked 2026-10-05.

1. https://appstoreconnect.apple.com > **Apps** > **+** > **New App**.
2. Fill in:

    | Field            | Type                                                                                                                                                                                                                               |
    | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
    | Platforms        | iOS                                                                                                                                                                                                                                |
    | Name             | `HushOS: Encrypted Drive` (store-listing.md; 30 max; it has to be free on the store)                                                                                                                                               |
    | Primary Language | English (U.S.)                                                                                                                                                                                                                     |
    | Bundle ID        | `com.hushos.app`. It appears in the menu only once the ID is registered. If it's missing, run section 7 with `UPLOAD=0` first (that registers it), or register it by hand (signing.md). It can't change after a build is uploaded. |
    | SKU              | `hushos-ios` (internal, never shown, can't change)                                                                                                                                                                                 |
    | User Access      | Full Access                                                                                                                                                                                                                        |

3. **Create.** The app's page opens with **App Information** on the left. Fill in now:
    - **Subtitle:** `Private, end-to-end encrypted`.
    - **Category:** Primary Productivity, Secondary Utilities.
    - **Content Rights:** "Does your app contain, show, or access third-party content?" **No**. People see only their own files and files shared with them, and HushOS licenses no content. (If counsel reads shared files as "third-party content", answer Yes and confirm you have the rights; both answers are defensible.)
    - **Age Rating:** section 10.
    - **Privacy Policy URL** (App Privacy page): `https://hushos.com/privacy`.

## 7. Build and upload

**Version numbers.** Use `1.0.0` for the first store version and build numbers from `1` upward; every upload needs a new, higher build. Android uses the same pair.

From the repository root, on this Mac:

```sh
DEVELOPMENT_TEAM=<<TEAMID>> bun run ios:archive 1.0.0 1
```

`apps/ios/scripts/archive.sh`:

1. sets the version and build in all five targets of `apps/ios/project.yml`;
2. builds the Rust core if it's missing and regenerates the Xcode project;
3. archives a Release build for devices with automatic signing;
4. refuses an archive that carries the simulator-only File Provider entitlement;
5. exports it and uploads it to App Store Connect.

Commit the `project.yml` change afterwards.

From Xcode instead: `bun run ios:project`, `bun run ios:open`, set the team on all five targets (or put `DEVELOPMENT_TEAM` in `project.yml`, signing.md), choose **Any iOS Device (arm64)**, **Product > Archive**. Then in the Organizer: **Distribute App > App Store Connect > Upload**.

After the upload, App Store Connect > **TestFlight** shows the build as **Processing** (usually minutes, sometimes an hour), then asks about encryption, unless the Info.plist answers it (section 8).

## 8. Encryption and export compliance: decide before the first upload

HushOS encrypts files itself, with standard published algorithms (XChaCha20-Poly1305, X25519, ML-KEM-768, Ed25519, Argon2id, OPAQUE) implemented in the app's Rust core, not with the operating system's encryption. What Apple says (checked 2026-10-05):

- Every app distributed from the US store is subject to US export law, wherever the developer is (https://developer.apple.com/documentation/security/complying-with-encryption-export-regulations).
- Apple's table (https://developer.apple.com/help/app-store-connect/reference/app-information/export-compliance-documentation-for-encryption):

    | The app uses                                   | Apple needs                                                                        |
    | ---------------------------------------------- | ---------------------------------------------------------------------------------- |
    | Only the operating system's encryption         | Nothing                                                                            |
    | Standard algorithms **not provided by the OS** | A **French encryption declaration**, only if the app is on the App Store in France |
    | Proprietary or non-standard algorithms         | A US CCATS **and** the French declaration                                          |

    HushOS is the middle row. No CCATS. A French declaration if you sell in France.

- **The year-end self-classification report.** Apple's page still says you "might" need one. The regulation itself (15 CFR 740.17(e)(3), https://www.ecfr.gov/current/title-15/section-740.17) limits the annual report to mass-market components, executable software from hardware components, and non-mass-market items. A mass-market end-user app isn't among them since BIS's March 2021 rule ("Elimination of Reporting Requirements for Certain Encryption Items", 86 FR 16482). BIS's own explainer page still mentions the report, contradicting the regulation.
- **Open source** may take HushOS outside the EAR altogether: publicly available encryption source code using standard cryptography isn't subject to the EAR (15 CFR 742.15(b)), and the EAR treats object code compiled from such source the same way. HushOS is public under the AGPL. This is the strongest argument, and it's a legal one.

**The app currently sets `ITSAppUsesNonExemptEncryption = false`** (`apps/ios/project.yml`, `App/Info.plist`). That tells App Store Connect, upload after upload, that no documentation is needed, and App Store Connect never asks. It's a legal statement made in HushOS, Inc.'s name.

**Recommendation, to confirm with counsel:**

1. Before the first upload, ask counsel one question: "Is HushOS, an open-source app using only standard published algorithms, exempt from documentation for App Store Connect, and do we file a French declaration?"
2. Until they answer, **exclude France** from the first release (section 11). Apple then needs no document at all.
3. If counsel confirms the exemption, keep `false`. If counsel prefers the questionnaire, delete the key from `project.yml` (and so `Info.plist`), answer App Store Connect's questions on the first build: uses encryption, yes; standard algorithms instead of or in addition to the OS's; France per the decision. Then set the key the way Apple's result says, so later builds don't ask again.
4. For France, Apple's flow asks you to upload the declaration made to ANSSI (France's cybersecurity agency); Apple says it reviews documents in about two business days (https://developer.apple.com/help/app-store-connect/manage-app-information/overview-of-export-compliance).

## 9. Demo accounts for App Review and TestFlight review

Apple: "include demo account info (and turn on your back-end service!) if your app includes a login" (guideline 2.1(a), https://developer.apple.com/app-store/review/guidelines/), and the account "must not expire". Google needs the same, so make them once on **production**, hushos.com:

1. **The review account.** A hushos.com address that forwards to you, e.g. `appreview@hushos.com` (a Cloudflare Email Routing rule), so the verification email arrives. Register at https://hushos.com/register, name `App Review`, a long unique password. Save the recovery kit in your password manager (the account is useless to you if you lose it).
2. Fill it with **made-up, non-personal content**: a few folders (`Travel`, `Recipes`, `Work`), some photos you own the rights to, a PDF, a text file. Share one folder with the second account (below) as "Can view", and turn on a link for one file. Reviewers then see sharing work.
3. **A second account** for deleting: `appreview-delete@hushos.com`, for the reviewer who tests Delete account (guideline 5.1.1(v)). Recreate it after each review that deletes it.
4. Never change these passwords except in the review notes as well; a password change signs out every session.

## 10. Age rating

App Store Connect > HushOS > **App Information** > **Age Rating** > Edit. Apple's questionnaire changed in July 2025 (13+, 16+, 18+ added), with answers mandatory since 31 January 2026, and gained social-media questions from September 2026 (https://developer.apple.com/news/upcoming-requirements/, https://developer.apple.com/help/app-store-connect/reference/app-information/age-ratings-values-and-definitions). Answer:

| Question                                                                                 | Answer    | Why                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parental controls; age assurance                                                         | No        | Neither exists.                                                                                                                                                                                                                                                                                                                              |
| Unrestricted web access                                                                  | No        | No browser in the app; links open in Safari.                                                                                                                                                                                                                                                                                                 |
| User-generated content                                                                   | No        | Apple defines it as "the broad distribution of content created by users". HushOS has private sharing to chosen accounts and unlisted links, no feed or discovery. Judgement call: if a reviewer disagrees, guideline 1.2 then expects reporting (HushOS has Report), blocking abusive users (it has none) and published contact information. |
| Social media; messaging and chat                                                         | No        | None.                                                                                                                                                                                                                                                                                                                                        |
| Advertising                                                                              | No        | None.                                                                                                                                                                                                                                                                                                                                        |
| Every content question (violence, sexuality, mature themes, medical, gambling, contests) | None / No | The app ships no content of its own.                                                                                                                                                                                                                                                                                                         |

The expected result is 4+.

## 11. Pricing and availability

**Pricing and Availability**:

- **Price:** Free (USD 0).
- **Availability:** all countries and regions, **except France** until the export decision (section 8).
- **App distribution methods:** Public.
- **iPad and Mac:** if the app is still universal, App Store Connect shows iPad as supported and demands iPad screenshots. Decide iPhone-only before this (signing.md). Untick "Make this app available on Mac (Apple silicon)": the File Provider and share extensions weren't built or tested for the Mac.

## 12. App Privacy

**App Privacy** > Get Started: answer exactly as privacy-answers.md (Apple section), then **Publish**.

## 13. TestFlight: internal first

https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview: up to 100 internal testers (App Store Connect users), up to 10,000 external; builds expire after 90 days.

1. **TestFlight > Internal Testing > +** (create group): `HushOS team`. Add yourself and anyone from section 4. Turn on **Automatic distribution**.
2. Pick the build; if it shows **Missing Compliance**, answer section 8's questions.
3. Install **TestFlight** from the App Store on your iPhone, accept the email invitation, install HushOS.
4. On the real phone, run the device checks in checklist.md, the real-domain link test above all.

## 14. TestFlight: external testers (needs a Beta App Review)

Apple requires an internal group before an external one, and reviews the first build for each version (https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers).

1. **TestFlight > Test Information** (https://developer.apple.com/help/app-store-connect/test-a-beta-version/provide-test-information):
    - **Beta App Description:** `HushOS is an end-to-end encrypted drive. Sign in with your HushOS account (free at hushos.com). Please try uploading photos and files, sharing a folder, making a link, and keeping a folder on your phone.`
    - **Feedback Email:** `hello@hushos.com` (also the reply-to on invitations).
    - **Marketing URL:** `https://hushos.com`. **Privacy Policy URL:** `https://hushos.com/privacy`.
    - **Beta App Review Information:** contact `<<your name, phone, email>>`; **Sign-in required**: on; user name and password of the review account (section 9); notes: the review notes from section 15.
2. **External Testing > +** > group `Early testers` > add the build > **Submit for Review**. In practice this takes a day or two.
3. After approval, add testers by email, or turn on a **public link** and share it.

## 15. The App Store version page

App Store Connect > HushOS > **iOS App 1.0.0** (left column, under "iOS App"):

1. **Previews and Screenshots:** the iPhone 6.9" Display tab. Drag in `docs/release/screenshots/ios/01-home.png` … `06-account.png` in order (1 to 10 allowed, no transparency; https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications). If iPad is still supported, the 13" iPad tab is required too.
2. **Promotional Text, Description, Keywords:** from store-listing.md.
3. **Support URL:** `https://hushos.com/support`. It must show the legal address, email and phone: set `OPERATOR_ADDRESS` and `OPERATOR_PHONE` on production first (checklist.md).
4. **Marketing URL:** `https://hushos.com`.
5. **Version:** `1.0.0`. **Copyright:** `2026 HushOS, Inc.`
6. **Routing App Coverage File:** none.
7. **Build:** **+** > pick the TestFlight build you tested.
8. **App Review Information:**
    - **Sign-in required:** on. User name `appreview@hushos.com`, password `<<from your password manager>>`.
    - **Contact:** `<<first and last name, phone, email>>`. Apple calls this number if a reviewer is stuck.
    - **Notes** (4000 bytes max):

        ```text
        HushOS is an end-to-end encrypted cloud drive. The app is free and sign-in only: accounts are created for free on our website (hushos.com), where paid storage plans are also sold. The app sells nothing and has no buttons or links to buy (guideline 3.1.3(f), a free companion app to a cloud storage service).

        Demo account: the sign-in above. It holds sample folders and photos, a folder shared with a second account, and a link. A second account for testing Delete account: appreview-delete@hushos.com / <<password>>. Please use that one for deletion, so the demo account stays available.

        HushOS in the Files app: open Files > Browse > the ... menu (top right) > Edit, and turn on HushOS. "Save to HushOS" appears in the share sheet of other apps.

        Camera: used only for "Take photo" in the + menu, and to scan a recovery kit's code during password recovery.

        Encryption: files and their names are encrypted on the device with standard published algorithms (XChaCha20-Poly1305, X25519, ML-KEM-768, Argon2id; OPAQUE for sign-in). The source is public: https://github.com/HushOS/HushOS
        ```

9. **App Store Version Release:** **Manually release this version** for the first release, so you choose the moment after approval. Phased release applies only to updates (https://developer.apple.com/help/app-store-connect/update-your-app/release-a-version-update-in-phases).
10. **Save**, then **Add for Review** > **Submit to App Review**.

Apple says most submissions are reviewed within 24 hours (https://developer.apple.com/distribute/app-review/). Answer questions in **App Review** messages in App Store Connect. A rejection names a guideline. Reply there if you disagree, or fix it and resubmit.

## 16. After approval

1. **Release** (manual release: the **Release This Version** button). Apple says it can take up to 24 hours to appear on the store.
2. On a phone with the store build, tap a `https://hushos.com/s/…` link in Mail: it should open in HushOS. Apple's CDN fetches the association file within a day of first installs.
3. Add the App Store link to hushos.com. The home page FAQ "Does it work on my phone?" still tells people to add the website to the home screen.
4. Every later update: `DEVELOPMENT_TEAM=… bun run ios:archive <new version> <next build>`, TestFlight, then a new version page with **What's New**.
