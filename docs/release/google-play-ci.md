# Google Play from GitHub Actions

`.github/workflows/android-release.yml` builds the Android app of every release at its tag and puts it on Google Play's internal testing track, then attaches the APK to the GitHub release. Production stays a deliberate step: one command, run after the internal build has been checked on a phone. Until the setup below is done, the workflow logs a notice naming what is missing and succeeds without doing anything; the manual flow (google.md, section 10) keeps working either way.

## What runs, and when

When release-please publishes `vX.Y.Z` (release.yml), the workflow starts on its own:

1. **Build and check the bundle.** At the tag, with full history: `apps/android/scripts/bundle-release.sh`, the same script as `bun run android:bundle`, with the upload key from the `play` environment's secrets. Then `check-bundle.sh`: the bundle must be signed with the upload key alone, carry `com.hushos.app` at the tag's version and versionCode, and reach the same phones as the previous release (minSdk, ABIs, required and implied hardware features, screen requirements, compared with the previous release's APK). Play Console shows a review when the number of supported devices changes; the API does not, so this is where a change stops.
2. **Google Play internal testing.** `play-publish.sh upload`: one Play edit that uploads the bundle, checks Play read the same versionCode and SHA-256, sets the internal track to it as a completed release named `X.Y.Z (versionCode)`, and commits. Testers get it within minutes. No release notes are sent: the manual flow writes them in Play Console from store-listing.md, and there is no per-version source to send. Add them on the internal release in Play Console if you want them; promoting copies them to production.
3. **The APK.** `release-apk.sh vX.Y.Z`, as by hand: it attaches `HushOS-X.Y.Z.apk` and its `.sha256` to the GitHub release and writes the notes' Android section. It is its own job, so if it fails, **Re-run failed jobs** repeats it without a second Play upload.

Then, by hand, once the internal build has been checked on a phone:

```sh
gh workflow run android-release.yml --ref vX.Y.Z -f action=promote
```

It opens an edit, requires the internal track to hold this tag's versionCode (the commit count at the tag, as the build computed it) as a completed release, sets production to exactly that release at 100%, with its name and any notes written in Play Console, and commits. Production then goes through Google's review as it would from Play Console. The log prints what production held before.

Every run by hand names the tag with `--ref`: the workflow takes the release from the ref it runs on, and the `play` environment only lets `v*` tags in, so a run from `main` or a branch stops before it can sign or publish. The workflow file must exist at that tag, so it works for releases cut after it landed.

| Command                                                                         | What it does                                                                                |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `gh workflow run android-release.yml --ref vX.Y.Z -f action=dry-run`            | Builds and checks, uploads into an edit, has Play validate it, deletes the edit. No change. |
| `gh workflow run android-release.yml --ref vX.Y.Z`                              | What the release does on its own: internal testing, then the APK.                           |
| `gh workflow run android-release.yml --ref vX.Y.Z -f accept-device-change=true` | The same, after `check-bundle.sh` stopped on an intended change in supported phones.        |
| `gh workflow run android-release.yml --ref vX.Y.Z -f action=promote`            | Internal testing's release of the tag to production, 100%.                                  |

**A change in supported phones stops the upload.** Any release that changes minSdk, the ABIs, or the required hardware features fails at the check until it is run again with `-f accept-device-change=true`, after you have decided the change is intended. One is known to be coming: today the `CAMERA` permission makes Play treat a rear camera as required (`uses-implied-feature: android.hardware.camera`; only `android.hardware.camera.any` is declared not required), so devices without one don't see HushOS. The release that fixes that in the manifest needs the flag once, and the releases after it compare against its APK.

The previous release's APK is looked up on GitHub newest first; only a release or asset GitHub confirms is missing moves the search to an older one. Any other error (a 5xx, a refused token, a failed download) fails the job rather than compare with a staler release or skip the check: re-run it.

Jobs that change Google Play (the upload, the dry run, promote) wait for each other across all tags: Play allows one open edit per user, and a second edit by the same service account would invalidate the first.

A second upload of a versionCode Play already has (a re-run after the commit went through) uploads nothing and sets the internal track to the bundle Play holds.

## One-time setup

Google is reached through Workload Identity Federation: GitHub's OIDC token for a job in this repository, on a `v*` tag, is exchanged for a short-lived token of a service account. No key is created (the organization policy forbids it anyway), so none can leak. `<<…>>` marks a value only you know.

### 1. Google Cloud: the service account and the federation

In a Google Cloud project you own (any; it only hosts the account and the pool):

```sh
PROJECT=<<project id>>
gcloud config set project "$PROJECT"
gcloud services enable androidpublisher.googleapis.com iamcredentials.googleapis.com sts.googleapis.com

gcloud iam service-accounts create play-release \
    --display-name="HushOS Google Play releases (GitHub Actions)"

gcloud iam workload-identity-pools create github \
    --location=global --display-name="GitHub Actions"
gcloud iam workload-identity-pools providers create-oidc hushos \
    --location=global --workload-identity-pool=github \
    --display-name="HushOS/HushOS" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition="assertion.repository=='HushOS/HushOS' && assertion.ref.startsWith('refs/tags/v')"

NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
gcloud iam service-accounts add-iam-policy-binding "play-release@$PROJECT.iam.gserviceaccount.com" \
    --role=roles/iam.workloadIdentityUser \
    --member="principalSet://iam.googleapis.com/projects/$NUMBER/locations/global/workloadIdentityPools/github/attribute.repository/HushOS/HushOS"

echo "PLAY_WIF_PROVIDER=projects/$NUMBER/locations/global/workloadIdentityPools/github/providers/hushos"
echo "PLAY_SERVICE_ACCOUNT=play-release@$PROJECT.iam.gserviceaccount.com"
```

The last two lines are the values for step 3; neither is secret.

### 2. Play Console: let the account release HushOS

Play Console > **Users and permissions** > **Invite new users** > the service account's email (`play-release@<<project id>>.iam.gserviceaccount.com`). No account permissions. **App permissions** > **Add app** > HushOS > under Releases, **Release to production, exclude devices, and use Play App Signing** and **Release apps to testing tracks** > **Apply** > **Invite user**. Nothing else; in particular not Admin. Play Console no longer needs the Cloud project linked under API access.

The API can only add releases to an app that exists and already has a bundle uploaded by hand. HushOS has (0.9.0 onwards).

Google says new permissions can take up to a day to reach the API; until then requests fail with "The caller does not have permission".

### 3. GitHub: the `play` environment

The environment holds the upload key and the Google variables, and only `v*` tags may use it:

```sh
gh api -X PUT repos/HushOS/HushOS/environments/play --input - <<< \
    '{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}'
gh api -X POST repos/HushOS/HushOS/environments/play/deployment-branch-policies -f name='v*' -f type=tag

gh variable set PLAY_WIF_PROVIDER --env play --body "projects/<<number>>/locations/global/workloadIdentityPools/github/providers/hushos"
gh variable set PLAY_SERVICE_ACCOUNT --env play --body "play-release@<<project id>>.iam.gserviceaccount.com"

base64 -i ~/.hushos/hushos-upload.jks | gh secret set ANDROID_UPLOAD_KEYSTORE_BASE64 --env play
printf '%s' "$(security find-generic-password -s hushos-android-upload -a upload -w)" | gh secret set ANDROID_UPLOAD_STORE_PASSWORD --env play
gh secret set ANDROID_UPLOAD_KEY_ALIAS --env play --body upload
```

(Or in the browser: Settings > Environments > New environment `play` > Deployment branches and tags > Selected branches and tags > Add rule, type Tag, `v*`.) The key's own password is the keystore's (PKCS12), so there is no `ANDROID_UPLOAD_KEY_PASSWORD`; the alias defaults to `upload` when its secret is missing. Nothing is printed by these commands, and the keystore never touches the disk on the way.

### 4. The first run: a dry run

The first release cut after the workflow landed would upload straight away. To see it work first, leave `PLAY_SERVICE_ACCOUNT` unset until that release is tagged (its run then skips with a notice), set it, and run:

```sh
gh workflow run android-release.yml --ref vX.Y.Z -f action=dry-run
gh run watch "$(gh run list --workflow android-release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

It builds, checks, uploads into an edit, has Play validate the internal release and deletes the edit: Play is unchanged and keeps nothing from the edit, so the versionCode stays free for the real upload. Then the real run, from the same tag:

```sh
gh workflow run android-release.yml --ref vX.Y.Z
```

From then on every release does it on its own.

## By hand, as before

`bun run android:bundle` at the tag and the upload in Play Console (google.md, sections 5 and 10), then `bun run android:release-apk vX.Y.Z`, still work and are the fallback. The scripts the workflow runs work on a laptop too; `play-publish.sh --print-plan upload <aab> X.Y.Z <versionCode>` shows the requests it would make without a token, and with an account that may impersonate the service account (`roles/iam.serviceAccountTokenCreator`):

```sh
PLAY_ACCESS_TOKEN=$(gcloud auth print-access-token \
    --impersonate-service-account="play-release@<<project id>>.iam.gserviceaccount.com" \
    --scopes=https://www.googleapis.com/auth/androidpublisher) \
    apps/android/scripts/play-publish.sh promote X.Y.Z <versionCode>
```
