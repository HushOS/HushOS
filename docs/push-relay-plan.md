# Push notifications: build plan

How the push design in `docs/devices-design.md` 5 and 7 gets built, in four pull requests. This file covers the order, how the relay deploys, and what only the owner can do. The design itself stays in `docs/devices-design.md`.

## Pull requests

1. **The relay** (`crates/hushos-push`). A Rust service on axum, in the existing Cargo workspace, with its own database. It registers APNs and FCM tokens, sends content-free pushes, rate-limits, and drops dead tokens. It is tested with a fake Apple and Google, and CI tests it and builds its image. Nothing calls it yet.
2. **The server side**, behind `NOTIFICATIONS_ENABLED` (off by default, and off on hushos.com until 4 ships). Events exist for what the server does today (a new sign-in, a device removed or several, repeated password attempts, Shared with you, a family invitation, someone waiting to join); approvals and the other security events arrive with the features that make them:
    - the `notification_events` table;
    - `GET /api/notifications/:id` and `GET /api/notifications`;
    - `PUT /api/notifications/registration`;
    - pings for the events in 5, with `other` pings coalesced (no new ping while the device has an unfetched one from the last minute);
    - `PUSH_RELAY_URL` (default `https://push.hushos.com`; empty turns app pushes off), written up in `docs/self-hosting.md` with what the relay sees and that a server can locate a device by pinging it (section 7).
3. **Web Push** (RFC 8291). The payload is the event id only. The server makes its VAPID key pair at first use (`server_secrets`), and pushes only to the four browsers' push services. The service worker (`public/push-sw.js`, scope `/hushos-push/`) asks an open tab for the words and shows "New activity in HushOS" otherwise; Account → Notifications turns it on for a browser. For Shared with you the sender is named from the person's checked contacts; naming the item from the share's keys is still to come. The CSP needs nothing new: the worker is a same-origin script.
4. **The apps.** The iOS Notification Service Extension, and the Android FCM data message with `VISIBILITY_PRIVATE`. Both register with the relay and hand only the handle to their server. The roadmap item `phone-notifications` stays "now" until this reaches hushos.com and is switched on. As built:
    - **The server** names its relay in `GET`/`PUT /api/notifications/settings` (`relay`, `PUSH_RELAY_URL`, null when empty).
    - **The core** (`crates/hushos-core/src/notifications.rs`) holds what both apps share: the tag, which relay an app may use (`push_relay_usable`: push.hushos.com only, or a relay on the developer's computer in a debug build, so a server never chooses where a phone's push token goes), reading `GET /api/notifications/:id` (refused unless it is the event the push named), and the words, the web's `noticeFor`. A sharer is named only from a pin this person verified by words, not one trusted through a family. The fetching stays in each app's own networking, as every other API call does.
    - **iOS.** `HushOSKit/PushNotifications.swift` registers (`apns`, or `apns-sandbox` when the provisioning profile's `aps-environment` is development, and on the simulator) and keeps the registration, with its `deleteSecret`, in the shared keychain. `App/PhonePush.swift` asks for the token and permission (from the switch, and once per account by itself after a sign-in: `HushOSKit/PushAsk.swift`, `PhonePush.askOnce`) and renews the registration at every signed-in start. The extension `HushOSNotifications` (`com.hushos.app.notifications`, `Notifications/`) overwrites the relay's text with the fallback first, checks the tag against the kept handle and the signed-in account, fetches the event and writes the notice. The `push` category's hidden-preview placeholder is the fallback text. Written notices sound; the fallback stays quiet.
    - **Android.** `data/PushTokens.kt` sets Firebase up from `BuildConfig.FIREBASE_*` (Gradle properties `hushos.firebase.projectId`, `appId`, `apiKey`, `senderId`; none means no notifications and no Firebase), with `FirebaseInitProvider` removed, FCM auto-init off until the switch, and the `cct` backend already removed. `PushService` posts within a 9-second deadline on channels Security (high), Shared with you, Families and Other activity (low, the fallback), `VISIBILITY_PRIVATE`, with a public version reading "New activity in HushOS". The registration is in the encrypted preferences beside the session. `POST_NOTIFICATIONS` is asked from the switch, and once per account by the app itself after a sign-in (`data/PushAsk.kt`).
    - **Both.** Account → Notifications: On this phone, Shared with you, Families and the security line, hidden on a server answering 501 `off` or naming no usable relay. Every wipe (sign-out, deletion, removal, another account in) forgets the registration and deletes it at the relay with its secret, best effort. A tap opens Devices, Shared (with me) or Account's families.
    - **One at a time.** Registering, turning off and a wipe's forgetting never interleave (`PushRegistrar` on both phones). A wipe is synchronous and moves a generation; a registration is written, or put back after the server refused it, only while its session is still signed in and nothing forgot registrations since, so none comes back after a sign-out. On Android, token steps (the FCM token, its deletion) run on one serial executor, so a quick off-then-on never registers a token about to be deleted.
    - **Deletions keep trying.** A forgotten or replaced handle goes into a pending-deletion record with its secret (the shared keychain on iOS, the encrypted preferences on Android), outside the account's data, and is tried again at every start until its relay answers 204 or 404.
    - **A relay that changes.** A server that later names no relay, or another one, has the kept registration let go of (the server told, the handle deleted).
    - **Catch-up.** When the app opens or comes back, signed in with notifications on here, it lists `GET /api/notifications`: that answers the device's open `other` ping, so later events are not coalesced away, and anything no push showed becomes a notice in the same words (at most ten). Shown event ids are kept per account (`state/push-seen.json` on iOS, `push-seen.json` in Android's files), so nothing shows twice.
    - **Names in the iOS extension.** The extension never opens the settings document (about 24 MB of memory). The app keeps the verified, not family-trusted contacts' names, user id to name, in a `ThisDeviceOnly` keychain item (`PushContactNames`) whenever it reads the settings, while notifications are on; it goes on every wipe. Missing or out of date, a notice says "Someone". Android's service runs in the app's process and reads the settings itself. Both name a sharer by the pin's name only, never the address.
    - **Lock screens.** iOS hides previews until unlock by default, with the fallback as the placeholder. On Android every notice and channel is `VISIBILITY_PRIVATE` with the fallback as the public version, but whether a locked phone shows the private version is the person's lock-screen setting ("Show sensitive content"), which many phones have on by default; an app can't force it short of `VISIBILITY_SECRET`, which would hide the ping.
    - **Builds.** A sideloaded iOS build (its profile grants no `aps-environment`) hides the section. An Android release build without the four Firebase options fails, and `check-bundle.sh` refuses a bundle without them; debug builds stay push-less. `10.0.2.2` counts as a local relay only on the Android emulator.
    - **Not yet:** naming the shared item (needs the share's keys in the extension).

## The relay as built (PR 1)

- **Layout.** `crates/hushos-push`, as the design names it. It is a binary with a library beside it, so the tests reach the handlers without a network. The workspace already builds `crates/*`, so the core's `cargo` commands, its CI cache and the lockfile cover it with no new tooling. It shares no code with `hushos-core`. Its release profile overrides `opt-level` to 3. `panic = "abort"` stays, so a panic ends the process and the container restarts.
- **Routes.**
    - `POST /v1/register`: `{ platform, token }` → `{ handle, deleteSecret }`. `platform` is `apns`, `apns-sandbox` (Xcode builds) or `fcm`.
    - `DELETE /v1/register/:handle`: `{ deleteSecret }` → 204. A wrong secret and an unknown handle both get the same 404.
    - `POST /v1/ping`: `{ handle, id, class }` → 202. `id` must be a lowercase UUID, so a server cannot put words of its own in the payload.
    - `GET /healthz`.
    - `GET /`: a plain page saying what the relay is, what it keeps and how a self-hosted server turns it off.

    Bytes are base64url without padding.

- **What a push carries.** The event id and a tag, which is `base64url(SHA-256("hushos-push tag" ‖ 0x00 ‖ handle)[0..16])`. The tag tells an app signed in to several accounts which server to fetch from, without giving Apple or Google the handle itself. On APNs the push is an alert with `mutable-content` and the text "New activity in HushOS", with no sound. On FCM it is a high-priority data message with no `notification` block.
- **Storage.** One table, `registrations`, with four columns:
    - `SHA-256(handle)`;
    - the platform;
    - the token;
    - `SHA-256(deleteSecret)`.

    There are no timestamps and no addresses. A leaked database gives no working handles. A token Apple or Google report dead is deleted, along with every handle that uses it.

- **A ping reveals nothing.** The relay answers before it looks the handle up, and the push goes out in the background. A known handle, an unknown one and a dead one get the same answer at the same speed. A spent budget refuses all three alike.
- **Limits.** These are token buckets, so a burst of the full budget is allowed, then one ping per `3600 / budget` seconds.
    - Per handle: `security` 20 an hour and `other` 60 an hour, in separate buckets.
    - Per sending address, for each class: `PUSH_ADDRESS_SECURITY_PER_HOUR` (default 1000) and `PUSH_ADDRESS_OTHER_PER_HOUR` (default 3000). An IPv6 address counts by its /64.
    - Per block (an IPv4 /24 or an IPv6 /48), for each class: four times the per-address budget, so one customer cannot spread a flood over the 65,536 /64s of a /48.
    - Registrations: 30 an hour per address, 120 per block. An FCM token is at most 512 characters.
    - Deletes: 60 an hour per address, 240 per block.
    - Addresses listed in `PUSH_TRUSTED_SENDERS` (hushos.com's own) skip the per-address and per-block limits, but never the per-handle ones. An IPv4 address matches whether it arrives plain or mapped into IPv6.
    - The sending address comes from `PUSH_TRUSTED_PROXY_HEADER` only on connections from `PUSH_TRUSTED_PROXIES`; from anyone else the header is ignored, so a client cannot claim a trusted sender's address or spend another server's budget. The header is read right to left, past every hop that is a listed proxy, so nothing a client wrote further left is reached. The relay refuses to start with the header and no proxies.
    - When the limit table is full, new keys are refused until a sweep frees room; a sweep runs at most once a second.
    - Every minute a sweep forgets each record that has refilled, so an address or handle is held at most about an hour after its last use however quiet the relay is. The public page (`GET /`) promises this; keep the two together.
    - Limits are kept in memory, so run one instance. A restart refills them.
- **Logs.** No requests or payloads. One line an hour of counts.

## Where it lives and how it deploys

- **Image.** CI builds `crates/hushos-push/Dockerfile` on pull requests that touch the relay. Every push to `main` publishes `ghcr.io/hushos/hushos-push:sha-<commit>` beside the other images.
- **Host.** A separate Coolify application on the same host as the app, pulling `ghcr.io/hushos/hushos-push:latest`:
    - domain `push.hushos.com`;
    - port 8080, health check `/healthz`;
    - one replica, since limits are in memory;
    - a stop grace of 15 seconds.

    It gets its own resource and its own webhook, not a place in the web/worker webhook. A relay deploy never waits on the app's suites, and an app deploy never restarts the relay.

- **Database.** `hushos_push` on the existing Postgres host, owned by its own role `hushos_push`, with no grants on `hushos` and no `hushos_*` role on it. It connects directly on 5432, not through pgbouncer, and keeps a small pool. Migrations run at start. It is in the same backups.
- **Deploying (a follow-up CI change, once the resource exists).** On a push to `main` that changes `crates/hushos-push/**` or `Cargo.lock`:
    1. a `push-deploy` job, after the relay's tests and image, moves `hushos-push:latest` forward only (the same rule as the app's `latest`);
    2. it calls `PUSH_DEPLOY_WEBHOOK_URL` with `PUSH_DEPLOY_WEBHOOK_TOKEN`;
    3. it waits for `https://push.hushos.com/healthz`.

    It is gated on the repository variable `PUSH_DEPLOY_ENABLED`. Until then, the owner deploys a `sha-` tag by hand in Coolify.

- **Self-hosters** never run it. Their servers ping `push.hushos.com`.

## Owner checklist

Nothing here is done by an agent. Credentials go straight from the console into Coolify or GitHub and are never pasted into a chat or committed.

**Apple**

- [ ] In Certificates, Identifiers & Profiles, turn on **Push Notifications** for the App ID `com.hushos.app`.
- [ ] Under **Keys**, create a key with **Apple Push Notifications service (APNs)** enabled. Download the `.p8` (it downloads only once) and note its **Key ID** and the **Team ID**. One key serves both sandbox and production.
- [ ] For PR 4: register an App ID `com.hushos.app.notifications` for the Notification Service Extension, with the App Groups capability on the app's existing group (`group.com.hushos.app`), and regenerate the provisioning profiles for the app (now with Push Notifications) and the extension. Automatic signing in `scripts/archive.sh` does this when Xcode is signed in to the team.

**Google**

- [ ] Create a Firebase project, or add Firebase to an existing Google Cloud project, and add the Android app `com.hushos.app`. From its `google-services.json` (configuration, not a secret), give the release build four Gradle properties: `hushos.firebase.projectId` (`project_info.project_id`), `hushos.firebase.appId` (`client[0].client_info.mobilesdk_app_id`), `hushos.firebase.apiKey` (`client[0].api_key[0].current_key`) and `hushos.firebase.senderId` (`project_info.project_number`), in `~/.gradle/gradle.properties` or as `HUSHOS_FIREBASE_*` variables. In Google Cloud, restrict the API key to the Firebase Installations and FCM Registration APIs and to the Android app `com.hushos.app` with both SHA-1 certificate fingerprints: the **Play App Signing key** (Play Console → Test and release → App integrity), which signs what Play installs, and the **upload key** (`keytool -list -v -keystore upload.jks`), which signs the APK attached to each GitHub release. With only one, the other build can't get a token. Add the four values as repository variables `HUSHOS_FIREBASE_PROJECT_ID`, `HUSHOS_FIREBASE_APP_ID`, `HUSHOS_FIREBASE_API_KEY` and `HUSHOS_FIREBASE_SENDER_ID` for `android-release.yml`: a release build without them fails.
- [ ] Make sure **Firebase Cloud Messaging API (V1)** is enabled.
- [ ] Create a service account with the **Firebase Cloud Messaging API Admin** role only, and create a JSON key for it. If an organisation policy blocks key creation, lift it for this project.

**DNS and hosting**

- [ ] Point `push.hushos.com` at the Coolify host, DNS-only (not through Cloudflare's proxy), with no proxy access log on the way: the relay then sees each server's own address, and the public page's "the proxy in front of it keeps none" stays true. A deletion carries the raw handle in its URL, so an access log would tie a handle to a phone's address and time. Set `PUSH_TRUSTED_PROXY_HEADER=x-forwarded-for` (what Coolify's proxy appends) and `PUSH_TRUSTED_PROXIES` to that proxy's range on the container network.
    - If it ever has to go through Cloudflare's proxy, change the public page first, then add Cloudflare's published ranges (cloudflare.com/ips) to `PUSH_TRUSTED_PROXIES` too. The relay reads the header right to left past every listed proxy; without Cloudflare listed, every server through one Cloudflare location would share one budget, and `PUSH_TRUSTED_SENDERS` would never match.
- [ ] Make the GHCR package `hushos-push` public after its first publish, as the other images are, or give Coolify a pull token.
- [ ] Create the Coolify application as above. Add these settings:
    - `DATABASE_URL_FILE`;
    - `APNS_KEY_FILE` (the `.p8`, mounted as a file), `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_TOPIC=com.hushos.app`;
    - `FCM_SERVICE_ACCOUNT_FILE` (the JSON, mounted as a file);
    - `PUSH_TRUSTED_PROXY_HEADER` and `PUSH_TRUSTED_PROXIES`;
    - `PUSH_TRUSTED_SENDERS` (the address hushos.com's web and worker reach `push.hushos.com` from).
- [ ] Add an uptime check on `https://push.hushos.com/healthz`.
- [ ] When the deploy job lands: add the GitHub secrets `PUSH_DEPLOY_WEBHOOK_URL` and `PUSH_DEPLOY_WEBHOOK_TOKEN`, and the variable `PUSH_DEPLOY_ENABLED=true`.

**Database (`ssh db`, as the Postgres superuser)**

- [ ] `create role hushos_push login password '…'; create database hushos_push owner hushos_push;`
- [ ] Add a `pg_hba.conf` line that lets `hushos_push` connect to the `hushos_push` database only, from the app host, with TLS, as the other roles have. A `revoke connect … from hushos_push` would do nothing while `PUBLIC` holds `CONNECT` on `hushos`, so the restriction belongs in `pg_hba.conf`. The role has no table grants in `hushos` either way.
- [ ] Add `hushos_push` to the backup job.

## What PR 1 leaves open

- Limits are per process, so a second instance doubles them. Shared limits would mean keeping sending addresses in the database, which the relay avoids.
- Many blocks at once (a botnet, or dozens of /48s) can still fill the limit table, so new handles are refused until it frees room. One block cannot.
- A ping the full delivery queue drops still gets 202, like every other ping; the device fetches what it missed when it next wakes.
- A failed push is not retried. The device fetches every pending event the next time it wakes, and every security event also goes by email.
- Registrations never expire on their own. One is removed when the app deletes it, or when Apple or Google report its token dead on a ping.
- Anyone who learns a handle can spend its budgets, and so hold back that device's security pings for up to an hour. Only the device's own server is given the handle, and the app can register again for a new one.
