# Devices: approval and notifications

This document adds devices to HushOS accounts: a list of the devices signed in to an account, an optional rule that a new device must be approved by one of them, and push notifications for approvals, security notices, shares and family events. Device approval is what child accounts rely on at conversion (`docs/envelope-migrations.md` 7), and what company sign-in assumes for key unlock (the build plan's SSO layer).

Decisions settled with the owner (2026-10-15):

- **Approval is off by default**, at two levels anyone can turn on: **Approve new devices**, which the server checks, and **Keys need a device**, which the cryptography enforces.
- **Guardians and organisations can require either level** by policy. On child accounts, a guardian decides; there is no level forced on children.
- **With no other device:** the recovery phrase approves at once. Without it, an emailed link starts a 72-hour wait that any device or the email can cancel. With Keys need a device, only the phrase works.
- **Approval prompts** show a code to match and the rough location of the new device.
- **Push** goes through a HushOS relay for the apps, including from self-hosted servers, and through Web Push for browsers.
- **Shared-with-you notifications** are written on the device from names it decrypts itself.
- **Security notices** always notify; everything else is a toggle, on by default.

## 1. Devices

A device is one app installation or one browser profile. Today the server knows only sessions, and a browser's remembered unlock lives entirely on the device (`packages/crypto/src/device.ts`).

| Table                   | Holds                                                                                                                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `account_devices`       | `id`, `user_id`, `kind` (`web`, `ios`, `android`), `name` (the client's own description, such as "Safari on macOS"; editable), `signing_public_key` (Ed25519, 32 bytes), `approved_by` (below), `created_at`, `last_seen_at`, `revoked_at` |
| `sessions`              | gains `device_id`; a session belongs to one device, and revoking the device ends its sessions                                                                                                                                              |
| `device_approvals`      | One row per sign-in waiting for approval (section 2): the new device's keys, the approver's key, the rough location, the state and its deadline                                                                                            |
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

A device keeps its value; it is shown in the device list ("Approved by your iPhone", "Signed in with your password"), and conversion reads it (section 6).

**The device key** is an Ed25519 key the device makes when it registers, kept in the Keychain or Keystore on the apps, and as a non-exportable Web Crypto key in IndexedDB on the web. It signs approvals and, for child accounts, conversion. It authenticates actions to the server, as the recovery reset signature does, so it is classical; a forged device signature lets nobody read anything.

**Existing sessions** become devices on their next request: the client makes a device key and registers it under its session, with `approved_by = existing`.

**The device list** in Settings shows each device's name, kind, how it was approved, and when it was last seen. Removing a device ends its sessions, deletes its push registration, and, under Keys need a device, means it must be approved again.

## 2. Approving a new device

### Levels

| Level                   | A new device gets in with                                                    | The password alone           |
| ----------------------- | ---------------------------------------------------------------------------- | ---------------------------- |
| Off (default)           | the password, as today                                                       | opens the account            |
| **Approve new devices** | the password, then approval: another device, the phrase, or the 72-hour wait | opens nothing until approved |
| **Keys need a device**  | the password, then the account key from another device, or the phrase        | can never open the keys      |

At the first level, the server holds back the password envelope (the account key wrapped under the password) until the device is approved. A server that is honest stops a stolen password; a breached server, together with the password, can still open everything, because the envelope is there.

At the second level, the password envelope does not exist (section 3). Only another device, or the phrase, can hand a new device the account key.

### The request

1. The new device signs in with OPAQUE as today. With a level on, the server makes a **pending session**: it can do nothing but the approval routes.
2. The new device makes its device key and a transfer key (X25519 and ML-KEM-768), and calls `POST /api/auth/approvals`. The server looks up the rough location of its IP address in a local database (city and country; no outside service), stores it on the request, and notifies every approved device.
3. The first approved device to open the request posts an ephemeral X25519 key. Both devices then compute the code:

    ```
    code = SHA-256("hushos/device/approval/v1" || requestId || newDeviceSigningKey || newTransferX25519 || sha256(newTransferKem) || approverEphemeralKey)
    ```

    The code is shown as two digits and a word, such as "47 river": a number from 0 to 99 from the first bits, and a word from the BIP-39 list from the next 11 bits, about 17.6 bits in all.

4. The new device shows its code. The approving device shows the request ("Chrome on Windows, near Lyon, France, just now") and three codes: its own and two random ones. The person taps the one on the new screen.
    - A wrong tap or a tap on Deny ends the request.
    - A tap on the right one approves.
5. The approving device signs the approval with its device key:

    ```
    ["hushos/device/approval",1,userId,requestId,newDeviceSigningKey,sha256(sealed) | ""]
    ```

    Under Keys need a device, it also seals the account key to the new device's transfer key (`sealed`, below).

6. The server checks the signature against an approved device, marks the new device approved, and turns the pending session into a full one.

**What the code stops.** A person approving by reflex must match what is on the new screen, so a stranger's sign-in attempt is not approved by a tap ("push fatigue"). The code covers both devices' keys as each device saw them. If the server swaps a key between them, the two devices compute different codes, none of the three choices matches, and nothing is approved. That is what makes the key transfer at the second level safe from the server.

**Requests** last ten minutes, one at a time per account, and at most five a day; each new request ends any open one. The location is deleted when the request ends.

### With no other device

- **The recovery phrase** approves at once, at either level. The new device opens the recovery envelope with it and signs the approval with the recovery signing key that phrase resets already use, under `approved_by = phrase`.
- **The 72-hour wait** is only for Approve new devices. The new device asks for it; the server emails a link and notifies every device. Clicking the link starts a 72-hour wait, and the email and every device show a notice with a cancel button. When the wait is over, the device is approved under `email-wait`. Under Keys need a device there is no wait: without the phrase, no device and no server can produce the account key.

### Turning levels on and off

- **On** needs a signed-in, approved device; Keys need a device also asks for the password once (section 3).
- **Off**, or down a level, needs the password and a fresh approval from another device or the phrase, so a stolen session cannot remove the rule. A level required by a policy cannot be turned off.
- **Notices.** Every change is a security notice to every device.

## 3. Keys need a device

Turning it on:

1. The device asks for the password once (an OPAQUE re-authentication) to prove it is the person.
2. The server deletes the password envelope. The account key stays wrapped under the recovery phrase (the recovery envelope) and inside each device's own storage, and nowhere else.

### Moving the key to a new device

The approving device seals the account key to the new device with the share suite 4 construction (`docs/identity-pq-design.md` 3), under its own `info` and associated data:

```
dh      = X25519(approverEphemeral.private, newTransferX25519)
(ct,ss) = ML-KEM-768.Encaps(newTransferKem)
key     = HKDF-SHA256(salt = SHA-256(ct || approverEphemeral.public || newTransferX25519), ikm = dh || ss, info = "hushos/device/key-transfer/v1", 32)
sealed  = ct || nonce || XChaCha20-Poly1305(accountKey, key, nonce, ad = ["hushos/device/key-transfer",1,userId,requestId,keyVersion])
```

The approver's ephemeral key is the one the code covered. The new device:

- opens the account key;
- checks it against the account, refusing a key that does not open the account's identity envelope and its workspace grant;
- keeps it as remembered unlock does today.

### Lock and sign-out

- **Locking** wipes the key from memory but keeps the device's sealed copy. Unlocking asks for the password, which re-authenticates the session, as remembered unlock does today.
- **Signing out** deletes the sealed copy and removes the device, so signing back in needs approval.

On a device that is already approved, the key is protected by the device's own storage and the session check, as remembered unlock is today. What this level adds is that no new device, and no server, can get the key without an existing device or the phrase.

### Password changes and recovery

- **Password changes** under this level register the new password with OPAQUE and write no envelope.
- **Master-key rotation** rewraps the recovery envelope as today; each approved device receives the new key on its next unlock through the same transfer, approved automatically by the rotating device's signature. Any device that misses it must be approved again.
- **A phrase reset** under this level replaces the password and approves the resetting device. Other devices keep working.

## 4. Policies

A group can require a level for its members:

- **Families:** a guardian can require a level on a child account; other members choose for themselves.
- **Companies:** admins can require a level for every member.

A required level is turned on at the member's next unlock and cannot be turned off while the policy stands. A person may always choose a stricter level than the policy asks for, and nobody but the person can turn off a level they chose themselves.

A policy is a server rule, shown to the member: the device list says "Required by Acme". It changes nothing about who can read what.

## 5. Notifications

### Events

| Event                                                           | Notifies                   | Can be turned off   |
| --------------------------------------------------------------- | -------------------------- | ------------------- |
| An approval request                                             | Approved devices           | No                  |
| A device added, a level changed, the 72-hour wait started       | Every device and the email | No                  |
| A conversion pending (child accounts)                           | Every device and the email | No                  |
| Shared with you                                                 | The grantee's devices      | Yes (on by default) |
| A family invitation, or someone waiting to be admitted          | Invitee; `members` holders | Yes (on by default) |
| A guardian opened a child's account (`account_guardian_events`) | The child's devices        | Yes (on by default) |

There is no marketing, ever.

### What travels where

A push carries nothing about what happened. Each event is a row in `notification_events`. The push is a ping naming that row by a random id, and the device fetches the row over its own session (`GET /api/notifications/:id`) and writes the notification itself.

- **iOS:** an alert with `mutable-content`, whose fallback text is "New activity in HushOS". The Notification Service Extension fetches the event and replaces the text.
- **Android:** a high-priority FCM data message. The app's messaging service fetches the event and posts the notification.
- **Web:** Web Push. The payload, encrypted to the browser's key (RFC 8291), is the event id only. The service worker fetches the event and shows it.

**Shared with you** is written from names the device decrypts: "Maya shared Taxes 2025.pdf with you".

- **The sender** is named from the device's own pins: a checked contact by name, anyone else as "Someone you haven't checked".
- **The file name** is opened with the share's keys, which needs the account key. Where the device cannot reach it (the app is locked, or iOS has not been unlocked since restart), the text is "Something was shared with you".
- **Nothing is decrypted on the server**, and nothing readable reaches Apple, Google or a browser vendor.

Approval requests name the device kind and the rough location, both of which the server already knows.

### The relay

Apple and Google deliver pushes only for apps signed with HushOS's own credentials, so self-hosted servers cannot push to the apps by themselves. `push.hushos.com` relays:

1. **Registration.** The app registers its APNs or FCM token with the relay and gets back a **handle**, 32 random bytes. It gives only the handle to its server (`PUT /api/notifications/registration`).
2. **Ping.** The server pings `POST https://push.hushos.com/v1/ping { handle, id }` and the relay sends the push.
3. **Limits.** The relay keeps handle → token, rate-limits per handle (60 an hour) and per sending address, and drops a handle whose token Apple or Google report as dead.

The relay learns that a handle got a ping from some server address at some time. It never learns who the person is or what happened. hushos.com uses the same relay, so there is one path to test.

**The relay is its own service:** `crates/hushos-push`, a Rust binary on axum, in the existing Cargo workspace. It shares no code, database or deploy with the app.

- **Why Rust.** APNs speaks only HTTP/2, which hyper does natively; FCM HTTP v1 needs a Google service-account token, refreshed in the process. The relay holds HushOS's Apple and Google push credentials, so it should be small and memory-safe. It is one static binary.
- **Its own database:** handle → token, platform, and a dead-token flag, in a `hushos_push` database on the Postgres server HushOS already runs, with its own role and no grants on the app's database (or the app's role on it). It is backed up and monitored with everything else, and more than one relay instance can run against it. Migrations ship in the binary (`sqlx`) and run at start.
- **Configuration** comes from the environment: the APNs key (`.p8`, key id, team id), the FCM service account, `DATABASE_URL` and the listen address. Secrets are read from files (`*_FILE`), as the app's are.
- **Docker:** `crates/hushos-push/Dockerfile` is multi-stage. It builds `cargo build --release -p hushos-push` in the Rust image and runs on `gcr.io/distroless/cc-debian12:nonroot`, with no shell. It is published as `ghcr.io/hushos/hushos-push` beside the other images. HushOS runs it; self-hosters never need to.
- **Release profile.** The workspace's profile is tuned for the mobile core: `opt-level = "s"` and `panic = "abort"`, so a panic ends the process and the container restarts. The relay overrides `opt-level` to 3 with a per-package profile.
- **Routes:** `POST /v1/register` (from the apps: `{ platform, token }` → `{ handle }`), `POST /v1/ping` (from servers: `{ handle, id }`), `DELETE /v1/register/:handle` and `GET /healthz`. It keeps no request logs beyond counts.

**Web Push needs no relay:** browsers' push services accept pushes from any server holding VAPID keys. Each server makes its VAPID key pair at first start (`server_secrets`).

**Self-hosting:** `PUSH_RELAY_URL` (default `https://push.hushos.com`; empty turns app pushes off, leaving notifications for when the app is open). `docs/self-hosting.md` says what the relay sees.

### Settings

Notification settings list the toggles above per account; security events are shown greyed out as always on. The apps and browsers ask the system for permission the first time the person turns on approvals or opens Shared, never at sign-up.

## 6. Child accounts

How this meets the conversion rules agreed in `docs/envelope-migrations.md` 7:

- **Sign-up** runs only on the child's own device, which is registered with `approved_by = enrolment`.
- **A guardian decides** whether the child account requires Approve new devices or Keys need a device. The child may turn either on themselves, and a guardian cannot turn off a level the child chose.
- **With a level on**, a new device needs approval from one of the child's devices or the phrase. If the child has lost every device and the phrase, a guardian may approve a device (`approved_by = guardian`), which the child's record shows.
- **Conversion** is authorised by a device key:
    - From a device approved by another of the child's devices, by the phrase or at enrolment, it goes through at once.
    - From any other device (`guardian`, `password`, `email-wait`, `existing`), it waits 7 days, with a notice to the account's email and every device, any of which can cancel it.
    - With approval off, every device is `password`, so every conversion waits. A guardian who left approval off cannot convert the account quietly.

## 7. What the server learns

- **Devices:** each account's devices, their self-reported names and kinds, how and when each was approved, and when each was last seen.
- **Approval requests:** the rough location of each new device while its request is open.
- **Notifications:** that an event happened, and which kind (it already knows when something is shared, invited or approved); push registrations; and when it sent each ping.
- **Apple and Google:** that a device received a ping at a time.
- **The relay:** the same, plus the sending server's address.
- **Browser push services:** that a browser received an encrypted push at a time.

## 8. API contract

Base64url without padding; ids lowercase UUIDs.

| Route                                           | Body → response                                                                                        | Notes                                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `POST /api/auth/devices`                        | `{ kind, name, signingPublicKey }` → `{ device }`                                                      | Registers the current session's device; once per session                         |
| `GET /api/auth/devices`                         | → `[{ id, kind, name, approvedBy, createdAt, lastSeenAt, current }]`                                   |                                                                                  |
| `PATCH /api/auth/devices/:id`                   | `{ name }`                                                                                             |                                                                                  |
| `DELETE /api/auth/devices/:id`                  |                                                                                                        | Ends its sessions and push registration; a security notice                       |
| `POST /api/auth/approvals` (pending session)    | `{ transferX25519, transferKem }` → `{ requestId, expiresAt }`                                         | Ends any open request; 429 after five a day                                      |
| `GET /api/auth/approvals/:id` (pending session) | → `{ state, approverEphemeralKey?, sealed? }`                                                          | The new device polls, or listens on its open connection                          |
| `GET /api/auth/approvals` (approved device)     | → `[{ requestId, kind, name, location, createdAt, newDeviceSigningKey, transferX25519, transferKem }]` |                                                                                  |
| `POST /api/auth/approvals/:id/open`             | `{ ephemeralKey }`                                                                                     | First approving device only; 409 for the others                                  |
| `POST /api/auth/approvals/:id/approve`          | `{ deviceId, signature, sealed? }`                                                                     | `sealed` required under Keys need a device                                       |
| `POST /api/auth/approvals/:id/deny`             |                                                                                                        | Also what a wrong code tap sends                                                 |
| `POST /api/auth/approvals/:id/phrase`           | `{ signature }` (recovery signing key)                                                                 |                                                                                  |
| `POST /api/auth/approvals/:id/wait`             |                                                                                                        | Emails the link; Approve new devices only                                        |
| `POST /api/auth/approvals/wait/cancel`          | `{ token }` or a device session                                                                        |                                                                                  |
| `PUT /api/auth/security/device-approval`        | `{ level, reauth, approval }`                                                                          | `level`: `off`, `approve`, `keys`; 409 `policy` below a required level           |
| `PUT /api/notifications/registration`           | `{ kind: 'relay', handle }` or `{ kind: 'webpush', subscription }`                                     | Per device                                                                       |
| `GET /api/notifications/:id`                    | → `{ kind, createdAt, refs }`                                                                          | Only to devices of the account it is for; `refs` are ids (share, group, request) |
| `GET`/`PUT /api/notifications/settings`         | `{ shares, family, guardianActivity }`                                                                 | Security events are not settings                                                 |
| `PATCH /api/groups/:id/policies`                | `{ deviceApproval: { level } }`                                                                        | Guardians for child accounts; company admins later                               |

## 9. Tests that must exist

Each fails on a defect a person or an attacker would notice (see AGENTS.md):

- **Pending sessions:** with a level on, a correctly signed-in but unapproved device gets 403 from everything but the approval routes, and is never served the password envelope.
- **Code:**
    - a swapped transfer key or ephemeral key gives the two devices different codes, so no approval;
    - a wrong tap ends the request;
    - an approval signed by a revoked or unapproved device is refused.
- **Keys need a device:**
    - after turning it on, no route serves a password envelope and none exists;
    - a new device gets the key only through a transfer sealed to the key the code covered;
    - a transfer that opens to a key that does not open the account is refused;
    - signing out deletes the device's copy.
- **The 72-hour wait:**
    - it approves only after 72 hours;
    - a cancel from the email or any device ends it;
    - it is refused under Keys need a device.
- **Levels:**
    - turning a level off without the password and a fresh approval is refused;
    - a level required by policy cannot be turned off;
    - a level the child chose cannot be turned off by a guardian.
- **Child conversion:** from a device approved by the child's own device or phrase it completes at once; from a `guardian`, `password`, `email-wait` or `existing` device it completes only after 7 days and is cancelled by the email or another device.
- **Notifications:**
    - a push payload carries no name, sender or file;
    - `GET /api/notifications/:id` refuses another account's device;
    - a locked device shows the generic text;
    - turned-off kinds send nothing, and security kinds cannot be turned off.
- **Relay:** a ping for an unknown or dead handle is dropped; the per-handle limit holds.

## 10. Milestones

1. **Devices:** the registry, sessions bound to devices, the device list and removal; existing sessions become devices.
2. **Approve new devices,** in the app only (polling): the code and location, the phrase, the 72-hour wait.
3. **Push:** the relay (`crates/hushos-push`, its Dockerfile and published image) and the app's registration, Web Push with a service worker (and its CSP), security notices.
4. **Keys need a device:** the key transfer, removing the password envelope, and lock and sign-out under it.
5. **Shares and family notifications,** written on the device.
6. **Policies,** with group milestone 1 for families and the company release for organisations; child conversion's rules with child accounts.
