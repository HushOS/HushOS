# Devices: approval and notifications

This document adds devices to HushOS accounts: a list of the devices signed in to an account, an optional rule that a new device must be approved by one of them, and push notifications for approvals, security notices, shares and family events. Device approval is what child accounts rely on at conversion (`docs/envelope-migrations.md` 7), and what company sign-in assumes for key unlock (the build plan's SSO layer).

Revised on 15 October after the independent review in `docs/pq-devices-crypto-review.md`.

Decisions settled with the owner (2026-10-15):

- **Approval is off by default**, at two levels anyone can turn on: **Approve new devices**, which the server checks, and **Keys need a device**, which the cryptography enforces.
- **Guardians and organisations can require either level** by policy. On child accounts, a guardian decides; there is no level forced on children.
- **With no other device:** the recovery phrase approves at once. Without it, an emailed link starts a 72-hour wait that any device or the email can cancel. With Keys need a device, only the phrase works.
- **Approval prompts** show the rough location of the new device, and the person types the code shown on the new device, or scans its QR code.
- **Push** goes through a HushOS relay for the apps, including from self-hosted servers, and through Web Push for browsers.
- **Shared-with-you notifications** are written on the device from names it decrypts itself.
- **Security notices** always notify; everything else is a toggle, on by default.
- **Child conversion** always waits 7 days, with notices to the account's email and devices; there is no instant path (section 6).
- **Master-key rotation under Keys need a device** makes every other device approve again; there is no automatic transfer (section 3).
- **Start over with new keys** is offered to adults (section 3); when the old identity cannot sign, it replaces it without a succession, authorised by the recovery phrase.

## 1. Devices

A device is one app installation or one browser profile. Today the server knows only sessions, and a browser's remembered unlock lives entirely on the device (`packages/crypto/src/device.ts`).

| Table                   | Holds                                                                                                                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `account_devices`       | `id`, `user_id`, `kind` (`web`, `ios`, `android`), `name` (the client's own description, such as "Safari on macOS"; editable), `signing_public_key` (Ed25519, 32 bytes), `approved_by` (below), `created_at`, `last_seen_at`, `revoked_at` |
| `sessions`              | gains `device_id`; a session belongs to one device, and revoking the device ends its sessions                                                                                                                                              |
| `device_approvals`      | One row per sign-in waiting for approval (section 2): the new device's commitment, then its revealed keys, the approver's key, the rough location, the state and its deadline                                                              |
| `push_registrations`    | Per device: `kind` (`relay`, `webpush`), the relay handle or the Web Push subscription, sealed at rest under a server secret                                                                                                               |
| `notification_events`   | What happened, for the device to fetch (section 5); deleted after 7 days                                                                                                                                                                   |
| `notification_settings` | Per account: the toggles in section 5                                                                                                                                                                                                      |

`approved_by` is one of:

- `enrolment`: the device the account was created on;
- `password`: signed in while approval was off;
- a device id;
- `phrase`;
- `email-wait`;
- `guardian`;
- `existing`: a session from before this change.

A device keeps its value; it is shown in the device list ("Approved by your iPhone", "Signed in with your password") and on the conversion screen (section 6).

**The device key** is an Ed25519 key the device makes when it registers, kept in the Keychain or Keystore on the apps, and as a non-exportable Web Crypto key in IndexedDB on the web. It signs approvals and, for child accounts, conversion. It authenticates actions to the server, as the recovery reset signature does, so it is classical. The server checks device signatures, so a server that forges one gains only what it could already decide: at Approve new devices, a forged approval releases the password envelope to whoever holds the password; under Keys need a device, it releases no key, because the key travels only in a transfer sealed by a device that holds it, to keys the code covered.

**Existing sessions** become devices on their next request: the client makes a device key and registers it under its session, with `approved_by = existing`.

**The device list** in Settings shows each device's name, kind, how it was approved, and when it was last seen. Removing a device ends its sessions, deletes its push registration, and, under Keys need a device, means it must be approved again. Removing a device revokes nothing cryptographically: a device that held the account key keeps it (section 3).

## 2. Approving a new device

### Levels

| Level                   | A new device gets in with                                                    | The password alone           |
| ----------------------- | ---------------------------------------------------------------------------- | ---------------------------- |
| Off (default)           | the password, as today                                                       | opens the account            |
| **Approve new devices** | the password, then approval: another device, the phrase, or the 72-hour wait | opens nothing until approved |
| **Keys need a device**  | the password, then the account key from another device, or the phrase        | can never open the keys      |

At the first level, the server holds back the password envelope (the account key wrapped under the password) until the device is approved. `finishLogin` returns the envelope today, so the level holds it back there and in `startSecurityChange`. A server that is honest stops a stolen password. A breached server, together with the password, can still open everything, because the envelope is there; and it can test password guesses offline against the OPAQUE record, so "the password" includes a guessed one.

At the second level, the password envelope does not exist (section 3). Only another device, or the phrase, can hand a new device the account key. Section 3 says exactly what that gives, and what it does not.

### The request

The new device commits to its keys before it sees the approver's key, and reveals them only after. The server must therefore fix what each side sees before it learns the other side's fresh value, so it cannot search for keys that give both devices the same code.

1. The new device signs in with OPAQUE as today. With a level on, the server makes a **pending session**: it can do nothing but the approval routes.
2. The new device makes its device key, a transfer key (X25519 and ML-KEM-768) and a 32-byte random `nonce`, and calls `POST /api/auth/approvals` with its kind, name and only a commitment:

    ```
    commitment = SHA-256("hushos/device/approval/commit/v1" || newDeviceSigningKey || newTransferX25519 || sha256(newTransferKem) || nonce)
    ```

    The server looks up the rough location of its IP address in a local database (city and country; no outside service), stores it on the request, and notifies every approved device.

3. The first approved device to open the request reads the commitment and posts an ephemeral X25519 key (`POST /api/auth/approvals/:id/open`).
4. Only once it has received that key, the new device reveals its keys and `nonce` (`POST /api/auth/approvals/:id/reveal`). It reveals once per request and never before step 3. The approver recomputes the commitment from the revealed values and ends the request if it differs.
5. Both devices compute the code:

    ```
    code = SHA-256("hushos/device/approval/v2" || userId || requestId || newDeviceSigningKey || newTransferX25519 || sha256(newTransferKem) || approverEphemeralKey || nonce)
    ```

    The code is shown as two digits and a word, such as "47 river": the number is the first 4 bytes as a big-endian integer, mod 100 (bias below 2^-25), and the word is from the BIP-39 list, indexed by the next 11 bits. About 17.6 bits in all. A server that substitutes keys on both sides gets matching codes with probability 2^-17.6 per request, and has nothing to search over.

6. The new device shows its code. The approving device shows the request ("Chrome on Windows, near Lyon, France, just now") and asks the person to **type** the code shown on the new screen: the two digits and the word, with completion from the word list.
    - Only an exact match approves.
    - A wrong code, or a tap on Deny, ends the request.
    - **This wasn't me** ends the request and sends a security notice to every device and the email.
7. The approving device signs the approval with its device key:

    ```
    ["hushos/device/approval",1,userId,requestId,newDeviceSigningKey,sha256(sealed)]
    ```

    With it, it seals its marks, and under Keys need a device the account key, to the new device's transfer key (`sealed`, section 3).

8. The server checks the signature against an approved device, marks the new device approved, and turns the pending session into a full one.

**Scanning instead of typing.** Where the approving device has a camera, it scans a QR code on the new device's screen instead: `hushos-approve:` followed by the `requestId` and the `commitment`, base64url. The approver checks the revealed keys against the scanned commitment, which binds 256 bits and needs no comparison by the person; it then asks only "Approve Chrome on Windows, near Lyon?". This is the preferred path wherever the approver has a camera, as Signal and WhatsApp link devices; typing is the fallback. The scan authenticates only the new device's keys to the approver. In the other direction the new device relies on the account key opening the account's identity envelope and workspace grant; a server that fakes those as well gives it an account without the person's files, not access to them.

**What the code stops.** A person approving by reflex has to type what is on the new screen, so a stranger's sign-in attempt, or a prompt a hostile server invents, is not approved by a tap ("push fatigue"). The code covers both devices' keys as each device saw them, and neither side's keys could be chosen after the other side's were known. If the server swaps a key between them, the two codes differ except by chance, and nothing is approved. That is what makes the key transfer at the second level safe from the server, on the apps; on the web the server serves the code that does the check (`docs/groups-threat-model.md` 5).

**Requests** last ten minutes, one at a time per account, and at most five a day.

- A new request replaces an open one only while no device has opened it. Once a device has opened a request, a new one is refused (409 `busy`) until it ends. A device whose request was replaced says so: "Another sign-in replaced this request."
- Each approving device keeps its own count, and shows at most five prompts a day for its account, whatever the server sends.
- The location is deleted when the request ends.
- **Residual:** someone with the password can still spend the account's five requests and stop the person adding a device for a day.

### With no other device

- **The recovery phrase** approves at once, at either level. The new device opens the recovery envelope with it and signs the approval with the recovery signing key that phrase resets already use, under `approved_by = phrase`:

    ```
    ["hushos/device/phrase-approval",1,userId,requestId,newDeviceSigningKey,sha256(recoveryEnvelope)]
    ```

- **The 72-hour wait** is only for Approve new devices. The new device asks for it; the server emails a link and notifies every device. Clicking the link starts a 72-hour wait, and the email and every device show a notice with a cancel button. When the wait is over, the device is approved under `email-wait`. Under Keys need a device there is no wait: without the phrase, no device and no server can produce the account key.

### Turning levels on and off

- **On** needs a signed-in, approved device; Keys need a device also asks for the password once (section 3).
- **Off**, or down a level, needs the password and a fresh approval from another device or the phrase, so a stolen session cannot remove the rule. A level required by a policy cannot be turned off.
- **Notices.** Every change is a security notice to every device.

## 3. Keys need a device

Turning it on:

1. The device asks for the password once (an OPAQUE re-authentication) to prove it is the person.
2. The server deletes the password envelope. The account key stays wrapped under the recovery phrase (the recovery envelope) and inside each device's own storage, and nowhere else.
3. From then on, the server refuses every write of a password envelope for the account, from any route: a password change, a phrase reset, a master-key rotation or a conversion.
4. Each device adds the second seal below, the turning-on device at once and the others at their next unlock.

**Turning it on changes no key.** Copies of the password envelope made before, in the server's backups or anywhere else, still open the account with the password, or with a guess that a breached server tests offline against the OPAQUE record. The screen says so: "Copies of your key made before today still open your account with your password. Start over with new keys to retire them."

### What this level gives

- **It holds** against a copy of the server's database taken after the switch, and against a server that only reads: neither can open the account, even with the password.
- **Against an active server, on the apps,** it holds as long as the person approves only devices they meant to add: the code (section 2) stops the server from placing its own keys in a transfer, and rotation hands the key to no device automatically (below).
- **It does not hold on the web,** where the server serves the code that does all of this (`docs/groups-threat-model.md` 5).
- **It does not evict anyone.** Removing a device revokes nothing cryptographically: the device kept the account key, and that key still opens the identity, settings and workspace keys, because master-key rotation wraps the same keys again instead of replacing them. Only Start over with new keys (below) evicts someone who once held the account key.

### Moving the key to a new device

The approving device seals to the new device with the share suite 4 construction (`docs/identity-pq-design.md` 3), under its own `info` and associated data:

```
dh      = X25519(approverEphemeral.private, newTransferX25519)
(ct,ss) = ML-KEM-768.Encaps(newTransferKem)
key     = HKDF-SHA256(salt = SHA-256(ct || approverEphemeral.public || newTransferX25519), ikm = dh || ss, info = "hushos/device/key-transfer/v1", 32)
payload = accountKey (32, Keys need a device only) || marks
sealed  = ct || nonce || XChaCha20-Poly1305(payload, key, nonce, ad = ["hushos/device/key-transfer",1,userId,requestId,keyVersion])
```

`marks` is the approving device's canonical JSON of its rollback marks: its own identity's `(keyVersion, identityVersion)`, the settings sequence, and each group's roster version and digest and each area's highest key version. A new device starts with them instead of trusting whatever the server serves first. At Approve new devices the payload is the marks alone.

The approver's ephemeral key is the one the code covered. The new device:

- opens the payload;
- checks the account key against the account, refusing a key that does not open the account's identity envelope and its workspace grant;
- takes the marks as its own;
- keeps the account key as remembered unlock does, under the second seal below.

### Lock and sign-out

Today an explicit lock on the web deletes the device's copy (`lock()` in `packages/auth/src/client.ts`), and unlocking opens the password envelope again. Under this level there is no password envelope, so the copy has to stay, and on its own it would sit on disk with no password factor. Under this level it is therefore sealed a second time, under something a thief of the device lacks:

- **On the apps:** a Keychain or Keystore key that requires user presence (`.userPresence` on iOS, `setUserAuthenticationRequired(true)` on Android), so opening the copy needs the device's passcode or biometrics.
- **On the web, where the browser offers the WebAuthn PRF extension:** `HKDF-SHA256(prfOutput, deviceSalt, "hushos/device/prf-wrap/v1", 32)`, from a passkey the device registers when it is approved.
- **On the web otherwise:** `HKDF-SHA256(exportKey, deviceSalt, "hushos/device/password-wrap/v1", 32)`, from OPAQUE's export key, so every guess at the password needs the password and one OPAQUE run with the server.

Then:

- **Locking** wipes the key from memory and keeps the doubly sealed copy. Unlocking asks for presence, the passkey or the password, opens the second seal, then the copy.
- **A session ending** does not delete the copy. Today `restore()` deletes it when the session has gone or its credential version differs; under this level that would destroy the device's only copy, and an account with one device and no phrase would be lost after 30 days. The copy's associated data does not carry `credentialVersion`; signing in again gives a new session, and the copy opens as before.
- **Signing out** deletes the sealed copy and removes the device, so signing back in needs approval.

What each flow does to the other devices under this level:

| Flow                         | Apps, and web with a passkey                | Web with the password wrap                     |
| ---------------------------- | ------------------------------------------- | ---------------------------------------------- |
| A session ends               | Sign in again; the copy opens               | Sign in again; the copy opens                  |
| A password change            | Sign in again with the new password         | Approve again: the wrap was the old password's |
| A phrase reset               | Sign in again with the new password         | Approve again                                  |
| A master-key rotation        | Approve again                               | Approve again                                  |
| Removed from the device list | Approve again; it keeps the old key it held | The same                                       |
| Start over with new keys     | Approve again                               | Approve again                                  |

### Password changes and recovery

- **Password changes** register the new password with OPAQUE and write no envelope. Other web devices on the password wrap approve again, and the change notice says so.
- **Master-key rotation** opens the old root from the rotating device's own copy, since no password envelope exists, makes the new root, rewraps the recovery envelope and everything rotation already rewraps, and writes no password envelope. There is no automatic transfer: every other device approves again with the code. Rotation keeps the identity keys, the settings key and the workspace keys, wrapped again under the new root, so a device that held the old root still opens them; rotation does not evict a thief, and a transfer to every device would have handed the new root to whatever device list the server served. To evict, use Start over with new keys.
- **A phrase reset** under this level registers the new password with OPAQUE and writes no password envelope: its signed reset message carries an empty `envelope`. The root does not change; the reset approves the resetting device, and the other devices are as in the table above.

### Start over with new keys

For an adult who has lost a device, or thinks someone else held the account key, Settings offers **Start over with new keys**. It is the conversion re-key (`docs/envelope-migrations.md` 7) run on the person's own account, at once and with no hold:

- a new root, a new identity with a succession signed by the old one, a new settings key, every workspace grant rewrapped, the personal tree rotated and outgoing shares re-sealed;
- a new password and recovery phrase, with every other device signed out and approved again.

It needs an approved device and the password, and it is a security notice. It is also offered on the device list after a device is removed, and when Keys need a device is turned on. It does not stop what conversion does not stop (`docs/envelope-migrations.md` 7): someone who held the old identity's keys and works with the server can serve contacts a succession of their own; links keep their secrets; and files written into a folder before the rotation reaches it sit under that folder's old key. The screen lists the account's links and suggests creating them again.

**When the old identity cannot sign.** If the identity's ML-DSA seed cannot be opened (a bug past the upgrade's check, `docs/identity-pq-design.md` 2), no succession can be signed. Start over then writes the new identity with no succession, authorised by the recovery phrase's reset signature instead of the old keys; contacts see the changed-key warning and compare words again. This is the only path that writes an identity without a succession, and it needs the phrase.

## 4. Policies

A group can require a level for its members:

- **Families:** a guardian can require a level on a child account; other members choose for themselves.
- **Companies:** admins can require a level for every member.

A required level is turned on at the member's next unlock and cannot be turned off while the policy stands. A person may always choose a stricter level than the policy asks for, and nobody but the person can turn off a level they chose themselves.

A policy is a server rule, shown to the member: the device list says "Required by Acme". It changes nothing about who can read what.

## 5. Notifications

### Events

| Event                                                                                                                                       | Notifies                   | Can be turned off           |
| ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | --------------------------- |
| An approval request                                                                                                                         | Approved devices           | No                          |
| A device added or removed, a level changed, the 72-hour wait started, "This wasn't me"                                                      | Every device and the email | No                          |
| A password change, a phrase reset, a recovery-key or master-key rotation, an identity succession, a policy change, Start over with new keys | Every device and the email | No                          |
| A conversion requested or cancelled (child accounts)                                                                                        | Every device and the email | No                          |
| Shared with you                                                                                                                             | The grantee's devices      | Yes (on by default)         |
| A family invitation, or someone waiting to be admitted                                                                                      | Invitee; `members` holders | Yes (on by default)         |
| A guardian opened a child's account (`account_guardian_events`)                                                                             | The child's devices        | No: fixed on child accounts |

There is no marketing, ever.

### What travels where

A push carries nothing about what happened. Each event is a row in `notification_events`. The push is a ping naming that row by a random id, and the device fetches the row over its own session (`GET /api/notifications/:id`) and writes the notification itself.

**Every ping the app wakes for shows a notification**, including pings for an unknown id or one that fails to fetch ("New activity in HushOS"). Silent probing by a server (section 7) is then visible.

- **iOS:** an alert with `mutable-content`, whose fallback text is "New activity in HushOS". The Notification Service Extension fetches the event and replaces the text. On every failure, the extension overwrites the text with that fixed string, so the text in the relay's payload is never what is shown.
- **Android:** a high-priority FCM data message. The app's messaging service fetches the event and posts the notification, with `VISIBILITY_PRIVATE` and a public version that carries only "New activity in HushOS".
- **Web:** Web Push. The payload, encrypted to the browser's key (RFC 8291), is the event id only. The service worker never opens the account key: when an unlocked HushOS tab is open, the tab writes the notification; otherwise the service worker shows the generic text.

**Shared with you** is written from names the device decrypts: "Maya shared Taxes 2025.pdf with you".

- **The sender** is named from the device's own pins: a checked contact by name, anyone else as "Someone you haven't checked".
- **The file name** is shown only for checked senders by default; from an unchecked sender the text is "Someone you haven't checked shared something with you", so a stranger cannot put words of their choosing on the lock screen.
- **The file name** is opened with the share's keys, which needs the account key. Whenever the device cannot reach it, the text is "Something was shared with you": the app is locked, iOS has not been unlocked since restart, or Keys need a device is on, since the copy needs user presence (section 3), which the extension cannot ask for.
- **Decrypted names leave the app** once shown: they go into the operating system's notification store, and on Android to every app the person has given notification access. iOS sets `hiddenPreviewsBodyPlaceholder` to the generic text, so hidden previews show nothing more.
- **Nothing is decrypted on the server**, and nothing readable reaches Apple, Google or a browser vendor.

Approval requests name the device kind and the rough location, both of which the server already knows.

### The relay

Apple and Google deliver pushes only for apps signed with HushOS's own credentials, so self-hosted servers cannot push to the apps by themselves. `push.hushos.com` relays:

1. **Registration.** The app registers its APNs or FCM token with the relay and gets back a **handle**, 32 random bytes, and a **deletion secret**, 32 random bytes, which only the app keeps. It gives only the handle to its server (`PUT /api/notifications/registration`). An app registers one handle per installation and server account, so servers cannot use handles to link a person across them.
2. **Ping.** The server pings `POST https://push.hushos.com/v1/ping { handle, id, class }` and the relay sends the push. `class` is `security` for approval requests and security notices, `other` for the rest.
3. **Limits.** The relay keeps handle → token and rate-limits per handle and per sending address, with a separate budget for each class: 60 an hour for `other`, and 20 an hour for `security` that `other` pings cannot spend. It drops a handle whose token Apple or Google report as dead. The server coalesces `other` pings: while a device has an unfetched ping from the last minute, it sends no other, and the device fetches every pending event when it wakes (`GET /api/notifications`).

The relay learns that a handle got a ping from some server address at some time, and holds the APNs or FCM token, which identifies the device to Apple or Google. It never learns the account or what happened. hushos.com uses the same relay, so there is one path to test.

**The relay is its own service:** `crates/hushos-push`, a Rust binary on axum, in the existing Cargo workspace. It shares no code, database or deploy with the app.

- **Why Rust.** APNs speaks only HTTP/2, which hyper does natively; FCM HTTP v1 needs a Google service-account token, refreshed in the process. The relay holds HushOS's Apple and Google push credentials, so it should be small and memory-safe. It is one static binary.
- **Its own database:** handle → token, platform, the deletion secret's hash, and a dead-token flag, in a `hushos_push` database on the Postgres server HushOS already runs, with its own role and no grants on the app's database (or the app's role on it). It is backed up and monitored with everything else, and more than one relay instance can run against it. Migrations ship in the binary (`sqlx`) and run at start.
- **Configuration** comes from the environment: the APNs key (`.p8`, key id, team id), the FCM service account, `DATABASE_URL` and the listen address. Secrets are read from files (`*_FILE`), as the app's are.
- **Docker:** `crates/hushos-push/Dockerfile` is multi-stage. It builds `cargo build --release -p hushos-push` in the Rust image and runs on `gcr.io/distroless/cc-debian12:nonroot`, with no shell. It is published as `ghcr.io/hushos/hushos-push` beside the other images. HushOS runs it; self-hosters never need to.
- **Release profile.** The workspace's profile is tuned for the mobile core: `opt-level = "s"` and `panic = "abort"`, so a panic ends the process and the container restarts. The relay overrides `opt-level` to 3 with a per-package profile.
- **Routes:** `POST /v1/register` (from the apps: `{ platform, token }` → `{ handle, deleteSecret }`), `POST /v1/ping` (from servers: `{ handle, id, class }`), `DELETE /v1/register/:handle` (from the apps: `{ deleteSecret }`; refused without it, so a handle alone cannot silence a device) and `GET /healthz`. It keeps no request logs beyond counts.

**Web Push needs no relay:** browsers' push services accept pushes from any server holding VAPID keys. Each server makes its VAPID key pair at first start (`server_secrets`).

**Self-hosting:** `PUSH_RELAY_URL` (default `https://push.hushos.com`; empty turns app pushes off, leaving notifications for when the app is open). `docs/self-hosting.md` says what the relay sees, and that a server can locate a device by pinging it (section 7).

### Settings

Notification settings list the toggles above per account; security events, and guardian activity on child accounts, are shown greyed out as always on. The apps and browsers ask the system for permission the first time the person turns on approvals or opens Shared, never at sign-up.

## 6. Child accounts

How this meets the conversion rules in `docs/envelope-migrations.md` 7:

- **Sign-up** is meant to run on the child's own device, which is registered with `approved_by = enrolment`. Nothing enforces it: the sign-up link is returned to the guardian (`docs/groups-design.md` 4), and whoever opens it registers the enrolment device and sees the recovery phrase.
- **A guardian decides** whether the child account requires Approve new devices or Keys need a device. The child may turn either on themselves, and a guardian cannot turn off a level the child chose.
- **With a level on**, a new device needs approval from one of the child's devices or the phrase. If the child has lost every device and the phrase, a guardian may approve a device (`approved_by = guardian`), which the child's record shows. Under Keys need a device, the guardian's device, which holds the child's root through the guardian seal, hands it over by the same committed transfer as any approval (section 2), with the code typed or scanned on the guardian's device.
- **Conversion** is authorised by a device key of the account. Every conversion waits 7 days, with a notice to the account's email and every device, any of which can cancel it. There is no instant path: the server cannot tell who holds the phrase, the enrolment device or a device either of them approved, so nothing it checks tells the young adult from a guardian. The conversion screen shows each device and how it was approved.
- **After conversion**, a level a guardian required lapses with the guardian. A level the young adult chose stays, and their devices, all signed out by the switch, enrol again under it.
- **Guardian activity** notices are fixed on child accounts; no session on the account, the guardian's included, can turn them off.

What conversion does not protect against is in `docs/envelope-migrations.md` 7 and `docs/groups-threat-model.md` 3.7.

## 7. What the server learns

- **Devices:** each account's devices, their self-reported names and kinds, how and when each was approved, and when each was last seen.
- **Approval requests:** the rough location of each new device while its request is open.
- **Where a device is, on demand.** Every ping makes the device fetch the event from its server, so the server, or anyone who learns a handle, can wake a phone up to the relay's limits and log its current IP address and network: an approximate location. The visible notification for every ping (section 5) makes this seen; it does not prevent it.
- **Notifications:** that an event happened, and which kind (it already knows when something is shared, invited or approved); push registrations; and when it sent each ping.
- **Apple and Google:** that a device received a ping at a time.
- **The relay:** the same, plus the sending server's address and the device's push token.
- **Browser push services:** that a browser received an encrypted push at a time.

## 8. API contract

Base64url without padding; ids lowercase UUIDs.

| Route                                           | Body → response                                                                   | Notes                                                                              |
| ----------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `POST /api/auth/devices`                        | `{ kind, name, signingPublicKey }` → `{ device }`                                 | Registers the current session's device; once per session                           |
| `GET /api/auth/devices`                         | → `[{ id, kind, name, approvedBy, createdAt, lastSeenAt, current }]`              |                                                                                    |
| `PATCH /api/auth/devices/:id`                   | `{ name }`                                                                        |                                                                                    |
| `DELETE /api/auth/devices/:id`                  |                                                                                   | Ends its sessions and push registration; a security notice                         |
| `POST /api/auth/approvals` (pending session)    | `{ kind, name, commitment }` → `{ requestId, expiresAt }`                         | Replaces an unopened request; 409 `busy` while one is opened; 429 after five a day |
| `GET /api/auth/approvals/:id` (pending session) | → `{ state, approverEphemeralKey?, sealed? }`                                     | The new device polls, or listens on its open connection                            |
| `POST /api/auth/approvals/:id/reveal` (pending) | `{ newDeviceSigningKey, transferX25519, transferKem, nonce }`                     | Only after `open`, once per request; 409 otherwise                                 |
| `GET /api/auth/approvals` (approved device)     | → `[{ requestId, kind, name, location, createdAt, commitment, opened, reveal? }]` | `reveal` once the new device has revealed, to the opening device only              |
| `POST /api/auth/approvals/:id/open`             | `{ deviceId, ephemeralKey }`                                                      | First approving device only; 409 for the others                                    |
| `POST /api/auth/approvals/:id/approve`          | `{ deviceId, signature, sealed }`                                                 | `sealed` carries the marks, and the account key under Keys need a device           |
| `POST /api/auth/approvals/:id/deny`             | `{ notMe }`                                                                       | Also what a wrong code sends; `notMe` ("This wasn't me") sends a security notice   |
| `POST /api/auth/approvals/:id/phrase`           | `{ signature }` (recovery signing key, over the phrase approval statement)        |                                                                                    |
| `POST /api/auth/approvals/:id/wait`             |                                                                                   | Emails the link; Approve new devices only                                          |
| `POST /api/auth/approvals/wait/cancel`          | `{ token }` or a device session                                                   |                                                                                    |
| `PUT /api/auth/security/device-approval`        | `{ level, reauth, approval }`                                                     | `level`: `off`, `approve`, `keys`; 409 `policy` below a required level             |
| `PUT /api/notifications/registration`           | `{ kind: 'relay', handle }` or `{ kind: 'webpush', subscription }`                | Per device                                                                         |
| `GET /api/notifications`                        | → `[{ id, kind, createdAt, refs }]`                                               | Every unfetched event for this device, after a coalesced ping                      |
| `GET /api/notifications/:id`                    | → `{ kind, createdAt, refs }`                                                     | Only to devices of the account it is for; `refs` are ids (share, group, request)   |
| `GET`/`PUT /api/notifications/settings`         | `{ shares, family }`                                                              | Security events and guardian activity are not settings                             |
| `PATCH /api/groups/:id/policies`                | `{ deviceApproval: { level } }`                                                   | Guardians for child accounts; company admins later                                 |

Under Keys need a device, every route that writes a password envelope (password change, phrase reset, `/auth/security/finish`, conversion) is refused with 409 `keys-need-a-device` if it carries one. Start over with new keys uses the conversion's switch and rotation routes (`docs/groups-design.md` 4) with a full session on an approved device and the password, and no hold.

## 9. Tests that must exist

Each fails on a defect a person or an attacker would notice (see AGENTS.md):

- **Pending sessions:** with a level on, a correctly signed-in but unapproved device gets 403 from everything but the approval routes, and is never served the password envelope, by `finishLogin` or `startSecurityChange`.
- **Code:**
    - a server that substitutes keys on both sides and chooses the approver's key last gets matching codes no more often than chance;
    - the new device does not reveal before it has an approver key, and never reveals twice for one request;
    - the approver ends a request whose revealed keys do not match the commitment, or the scanned QR code;
    - the code changes with `userId`, and the digits are drawn as specified, from 4 bytes mod 100;
    - only an exact typed code approves; a wrong code ends the request;
    - an approval signed by a revoked or unapproved device is refused.
- **Requests:**
    - a new request does not replace one that a device has opened, and the replaced device says so;
    - an approving device shows no more than five prompts a day, whatever the server sends;
    - "This wasn't me" ends the request and sends a security notice.
- **Keys need a device:**
    - after turning it on, no route serves a password envelope and none exists, and a password change, phrase reset, master-key rotation or conversion that carries one is refused;
    - a new device gets the key only through a transfer sealed to the key the code covered;
    - a transfer that opens to a key that does not open the account is refused;
    - a new device starts with the approver's marks, and refuses a settings document or roster older than them;
    - a locked device's stored copy does not open without user presence, the passkey's PRF or the password;
    - an ended session or a changed credential version leaves the copy in place, and signing in again opens it;
    - after a master-key rotation, every other device must approve again, and none receives the new key without a code;
    - signing out deletes the device's copy.
- **The 72-hour wait:**
    - it approves only after 72 hours;
    - a cancel from the email or any device ends it;
    - it is refused under Keys need a device.
- **Levels:**
    - turning a level off without the password and a fresh approval is refused;
    - a level required by policy cannot be turned off;
    - a level the child chose cannot be turned off by a guardian;
    - after conversion, a level a guardian required is off and a level the young adult chose stays.
- **Child conversion:** from any device, the enrolment device and phrase-approved devices included, it completes only after 7 days and is cancelled by the email or any device.
- **Notifications:**
    - a push payload carries no name, sender or file;
    - `GET /api/notifications/:id` refuses another account's device;
    - a locked device, and a device under Keys need a device, show the generic text;
    - a ping for an unknown id shows a notification;
    - a share from an unchecked sender shows no file name;
    - turned-off kinds send nothing, and security kinds and guardian activity on a child account cannot be turned off.
- **Relay:**
    - a ping for an unknown or dead handle is dropped; the per-handle limit holds;
    - `other` pings cannot spend the `security` budget;
    - deleting a handle without its deletion secret is refused.

## 10. Milestones

1. **Devices:** the registry, sessions bound to devices, the device list and removal; existing sessions become devices.
2. **Approve new devices,** in the app only (polling): the committed code, typed or scanned, and the location, the phrase, the 72-hour wait.
3. **Push:** the relay (`crates/hushos-push`, its Dockerfile and published image) and the app's registration, Web Push with a service worker (and its CSP), security notices.
4. **Keys need a device:** the key transfer, removing the password envelope, the second seal, and lock and sign-out under it.
5. **Shares and family notifications,** written on the device.
6. **Policies,** with group milestone 1 for families and the company release for organisations; child conversion's rules with child accounts.

## 11. Open question

- **Can an account's email change?** There is no route for it today. The 72-hour wait, its cancel link and every security notice go to that address, so a person who loses it, or shares it with someone they no longer trust, cannot move them.
