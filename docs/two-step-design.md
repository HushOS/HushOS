# Two-step sign-in and security keys

This document adds an optional second step to signing in to HushOS: a code from an authenticator app (TOTP), a security key (WebAuthn), or a backup code, asked for after the password and before the server hands over anything. It says what that step protects in an end-to-end encrypted system and what it does not, where it sits in each flow, how a person gets back in without it, and how it ships on the web and the apps. It sits beside `docs/devices-design.md` (Approve new devices, Keys need a device) and changes nothing there; section 1 says how the three fit together.

Written on 21 October 2026, and revised the same day after an independent review: the apps' browser path for security keys, code budgets for known devices, where the two-step key comes from, the phrase's salt and justification, the counter rule, policies, guardians, the security log and the phones' sign-in. Section 11 lists the decisions the owner had to make, each with a recommendation; all nine are answered below it. Steps 1 to 3 of the implementation plan (section 10) are built, behind `TWO_STEP_ENABLED`, which is off: the server and the web app. The same section lists what the flag still waits for.

The recommendations, in short:

- **The second step is a server rule.** It stops someone who has the password from signing in to an honest server. It does nothing against a server that is breached or hostile, and the design never says otherwise.
- **Offer security keys and authenticator apps**, recommend security keys, and never SMS or email codes.
- **Ask for the step whenever a device gets a new session**, not at every unlock and not only on new devices: at most once in 30 days on a device that keeps its session.
- **Ten backup codes**, single use, stored under a keyed, slow hash.
- **The recovery phrase satisfies the step,** at once, with a security notice. Email never does, and nobody at HushOS can turn the step off.
- **Build it before Approve new devices.** With both on, the step comes first, so a stolen password can no longer raise approval prompts.

## 1. What a second step protects

### The account model

The OPAQUE password does two jobs (`docs/opaque-auth-design.md`). It authenticates the account to the server, and its export key unwraps the **password envelope**, which holds the account key. `finishLogin` returns that envelope with the new session. The recovery phrase is the other way to the account key, through the recovery envelope.

A second step can only decide whether the server **releases** the envelope and opens a session. It adds nothing to the cryptography: the account key is wrapped under the password's export key and the phrase, and under nothing the second step holds. So:

- **It protects against a stolen password used against an honest server.** Someone who phished, guessed or reused the password signs in, OPAQUE succeeds, and the server asks for the step. Without it they get no session and no envelope, so no key and no ciphertext.
- **It does not protect against a breached server.** A server that is breached, or an operator who turns hostile, holds the OPAQUE record and the password envelope. With the OPAQUE server setup (in the database, or in the environment of a breached host) it can test password guesses offline against the record, and a guessed password opens the envelope. The step is a row in the same database: whoever controls the server skips it.
- **It does not protect a person whose device is stolen while unlocked,** or whose session cookie is stolen: the session already passed the step.
- **On the web, a hostile server serves the code** that reads the password as it is typed (`docs/groups-threat-model.md` 5). The step changes nothing there.

Other end-to-end encrypted services draw the same line, if less plainly. Bitwarden says its two-step login "is required to log in but not to unlock". 1Password's security white paper lists MFA secrets among the server data a breach would expose. Neither says outright that a second factor does nothing against a breached server; HushOS should.

The settings screen says this in one sentence: "A second step stops someone who has your password from signing in. It doesn't change how your files are encrypted."

### How it relates to device approval

`docs/devices-design.md` 2 has two levels:

- **Approve new devices,** a server rule: the server holds back the password envelope until another device, the phrase or the 72-hour email wait approves.
- **Keys need a device,** a cryptographic rule: the password envelope is deleted, and only another device or the phrase can hand over the account key.

The second step sits beside the first level, not the second. Both are server rules that hold back the same envelope, and both stop a stolen password at an honest server. They differ in what proves the person:

| Threat                                                       | Second step: TOTP    | Second step: security key | Approve new devices                                                         | Keys need a device                           |
| ------------------------------------------------------------ | -------------------- | ------------------------- | --------------------------------------------------------------------------- | -------------------------------------------- |
| Stolen password, honest server                               | Stops it             | Stops it                  | Stops it                                                                    | Stops it                                     |
| Phishing page that relays the password and code in real time | Does not stop it     | Stops it                  | Mostly: the prompt names the new device's rough location, which is the tell | Mostly, the same                             |
| Stolen password, with the person's email too                 | Stops it             | Stops it                  | Does not: the 72-hour email wait lets them in if nobody cancels             | Stops it                                     |
| Person with one device, who loses it                         | Backup codes, phrase | Backup codes, phrase      | Phrase or the 72-hour wait                                                  | Phrase only                                  |
| Copy of the database taken later, with a guessed password    | No                   | No                        | No                                                                          | Yes, after the switch (devices-design 3)     |
| Breached or hostile live server                              | No                   | No                        | No                                                                          | On the apps only, while approvals are honest |
| Device stolen while unlocked, or session cookie stolen       | No                   | No                        | No                                                                          | No                                           |

**Recommendation.**

- **Offer the second step to everyone,** on its own. It is the familiar control, it works for a person with one device, and a security key is the only thing in the table that stops a relayed phishing page.
- **Offer Approve new devices** to people with two or more devices, as `docs/devices-design.md` has it.
- **Offer Keys need a device** to people who accept its costs.
- **Allow every combination.** With the step and an approval level both on, a sign-in passes the step first and then asks for approval (section 4). That closes the residual devices-design 2 records: someone with the password alone can no longer spend the account's five approval requests a day, or put a prompt on the person's devices at all.
- **Build the step first.** It is server-side only, standard, and smaller than device approval. Approve new devices then builds on the same pending sign-in.

## 2. Authenticator apps (TOTP)

### Enrolment

1. The person opens Settings › Security › Two-step sign-in and confirms their password. This is a one-use OPAQUE exchange bound to the session and tagged `two-step`, as removing a device is (`docs/devices-design.md` 12). Once a step is on, adding another method also needs the step (section 4). An account that has no recovery key yet is told to finish setting up first (section 4).
2. The server makes a 20-byte secret (160 bits, the length RFC 4226 recommends) with a secure random generator. It stores the secret sealed (below) in a **pending** factor that lasts ten minutes, and returns it once.
3. The page shows a QR code, drawn on the device with `uqr`, which the web app already uses for the recovery kit. It never goes to an outside QR service. The secret is also shown as text, in groups of four, for manual entry. The code encodes the key URI:

    ```
    otpauth://totp/HushOS:<email>?secret=<base32>&issuer=HushOS&algorithm=SHA1&digits=6&period=30
    ```

    - **Self-hosted servers** use `issuer=HushOS (<host>)`, so two servers' entries can be told apart in the app.
    - **The label carries the email,** as every service's does. Authenticator apps that sync to a cloud then hold the fact that this email has a HushOS account; the screen does not hide that.

4. The person types the current code. Only a correct code **confirms** the factor; that time step becomes the factor's last used step, so the same code cannot sign in afterwards.
5. If this is the account's first factor, the step is now on and the backup codes are shown (below).

**SHA-1, six digits and 30 seconds** are the defaults of RFC 6238 and of Google's key URI format. Google Authenticator ignores `algorithm` and `period`, and on Android `digits` too, so anything else shows codes the server would refuse. OWASP suggests eight digits where usability allows; the apps people already have decide against it. SHA-1's collision weakness does not touch HMAC-SHA-1 as a TOTP function.

An account has **at most one authenticator app**. Replacing it enrols the new one and removes the old one in the same transaction, once the new one is confirmed. Several apps could hold the same secret if the person scans the code twice; that is their choice.

### The secret on the server

TOTP is a shared secret: the server checks a code by computing `HMAC-SHA-1(secret, time step)` itself. So it must be able to read the secret.

- **It cannot be hashed:** the code changes every 30 seconds, and nothing short of the secret predicts it.
- **It cannot be checked on the device:** a check on the device is a check by whoever holds the device, which is the attacker this step is for.

So the secret is **not** end-to-end encrypted, and the design never says it is. It is sealed at rest:

```
key    = the two-step key (section 8), 32 bytes, with its key id
nonce  = random(24)
sealed = XChaCha20-Poly1305(secret, key, nonce, ad = ["hushos/two-step/totp",1,userId,factorId,keyId])
```

The seal protects against a copy of the database without the two-step key: a backup, a dump, a stolen replica. That copy can then make no codes, so with a guessed password it still cannot pass the step at the honest server. It does nothing against a server that has both, which needs no codes anyway.

### Checking a code

- **Window:** the codes for time steps T−1, T and T+1 are accepted, 90 seconds in all. RFC 6238 5.2 recommends at most one step either way for network delay. No drift is learnt: phones keep network time.
- **No replay:** a factor keeps `totp_last_step`, and a code is accepted only for a step later than it. The update is conditional (`SET totp_last_step = $step WHERE id = $id AND totp_last_step < $step`), so two requests with the same code race to one success. A code used at sign-in cannot be used again for a password change a minute later, as RFC 6238 5.2 requires.
- **A used code is a wrong answer,** wherever it is sent next, and is counted once like any other. It is refused where codes are checked, before anything the action does first: a deletion stops what is billed before the account goes, and a replayed code must not get that far. The honest case costs little: a person who reuses the code that just signed them in sees "That code didn't work", has one failure counted, and waits up to 30 seconds for the next code.
- **Codes are compared in constant time,** and the check runs the same way whatever the result.

### Rate limits and lockout

A six-digit code with three steps accepted is a 3 in 10⁶ guess. The password is the first factor, so every guess at the step comes from someone who already has it; the limits make guessing hopeless and make sure the person hears about it.

- **Per sign-in:** each step token (section 4) allows five wrong answers, then it is gone, and the next try needs the password and a new OPAQUE run. Those runs are limited already: ten in 15 minutes per email and address (`limitPasswordAttempts`).
- **Per known device:** a sign-in whose `login/finish` carried a valid device proof (`docs/devices-design.md` 12) comes from one of the account's own devices, and gets its own budget: ten wrong codes in 15 minutes for that device. This is how `limitBoundAttempts` gives each session its own count. Only a device holding its device key can spend it, so someone with the password alone, from any number of addresses, cannot touch it.
- **Per account, for every other sign-in:** ten wrong codes in 15 minutes across all tokens and addresses, from new devices and from devices without a proof. After that, codes from such sign-ins are refused with 429 for the rest of the window. This bucket bounds guessing, since every guess an attacker can make comes through it.
- **Only codes count:** both budgets cover only what can be guessed, authenticator and backup codes. A security key and the phrase are never refused for a spent budget.
- **A consecutive count,** kept for the account's sign-ins without a device proof and for each known device, and reset by a success in the same pool:
    - at **5**, the account gets a security notice. A correct password followed by a failed step is the clearest signal that the password is known, so this notice matters more than any other here. It has two forms, each sent at most once an hour:
        - **at sign-in:** "Someone signed in with your password but did not pass the second step." Nobody got in, and it says so;
        - **at a change** (section 4): "Someone signed in to your account tried to change it and did not pass the second step." Whoever failed there holds a live session, so this one never says nobody got in. It says to check the devices and change the password.
    - at **100** without a device proof, the authenticator app is **frozen for new devices**: TOTP codes from sign-ins without a device proof are refused, with a notice. That is every device HushOS does not recognise, which includes one of the owner's that has no device key. The account's known devices still take codes. Backup codes are not frozen, though they share the budget above. Security keys and the phrase work everywhere. A success with any method other than the frozen app, from any device, unfreezes it. NIST SP 800-63B caps consecutive failures at 100 for this reason. The chance of a lucky guess before the freeze is about 3 × 10⁻⁴.
- **What someone with the password can still do,** from as many addresses as they like:
    - **New devices:** they can keep the account's shared budget spent and freeze the authenticator app for new devices, indefinitely. A new device of the owner's then needs a security key or the phrase while it lasts. Backup codes share that budget, so they are refused with the codes.
    - **Known devices:** none of it reaches them. A known device whose session ended signs in with its device proof and its own budget, and the authenticator app still works there.
    - **Notices:** the owner hears at the fifth failure that the password is known, and should change it, which ends the attack.

    Every lockout scheme gives an attacker who has the first factor some lever. This one is bounded to new devices and two of the methods, and the owner is told.

### Backup codes

- **Ten codes,** made when the first factor is confirmed and shown once, with Copy, Download (a text file made on the device) and Print. They are never shown again; the person can make a new set, which replaces the old one.
- **Each code is 10 characters** of Crockford base32 (no I, L, O or U), shown as `7KQ2M-9XD4P`: 50 bits. Input ignores case, spaces and hyphens, and reads I and L as 1 and O as 0.
- **Stored keyed and slow,** never in plain text: `Argon2id(HMAC-SHA-256(twoStepKey, code), accountSalt)`, with a 16-byte salt per account and the OWASP minimum parameters (19 MiB, two passes). NIST SP 800-63B asks for a salted password-hashing scheme for any look-up secret under 112 bits. A plain hash of a 50-bit code can be reversed with enough GPU time. Keyed, a copy of the database without the key gives nothing; with the key, each guess still costs one Argon2id run. A check hashes the input once and compares it with each unused code, so a wrong code costs the server one hash, inside the step's rate limits.
- **Single use:** the code is marked used inside the transaction that creates the session or authorises the change, so two requests with one code give one success.
- **The count is shown:** Settings says how many are left. Each use sends a notice with the number left, and at two or fewer the sign-in screen suggests a new set.
- **No other recovery:** a backup code is a second step, not a password. It never opens a key, and it never turns the step off by itself (section 5).

## 3. Security keys (WebAuthn)

A security key is a WebAuthn credential used after the password: a USB, NFC or Bluetooth key, or a passkey on a phone or computer acting as one.

### Registration

`POST /api/auth/two-step/keys/options` returns `PublicKeyCredentialCreationOptions`, after the password (and the step, if one is on):

| Option                                    | Value                                             | Why                                                                                                           |
| ----------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `rp.id`                                   | The host of `APP_ORIGIN`                          | A key is bound to the domain; the origin is checked against `APP_ORIGIN` exactly                              |
| `user.id`                                 | A random 32-byte handle per account, made once    | Not the account id, so a key does not carry an id the server uses elsewhere                                   |
| `user.name`, `user.displayName`           | The email                                         | What the key's own list shows                                                                                 |
| `challenge`                               | 32 random bytes, kept with the registration token | One use, five minutes                                                                                         |
| `pubKeyCredParams`                        | Ed25519 (−8), ES256 (−7), RS256 (−257)            | What keys in use offer                                                                                        |
| `attestation`                             | `none`                                            | The server does not choose keys by maker, so it asks for nothing that identifies the key's model              |
| `authenticatorSelection.residentKey`      | `discouraged`                                     | A second step does not need a discoverable credential; the server lists the account's keys after the password |
| `authenticatorSelection.userVerification` | `discouraged`                                     | The password is the knowledge factor; touching the key is the second. A key with a PIN may still ask for it   |
| `excludeCredentials`                      | The account's keys                                | The same key is not added twice                                                                               |
| `timeout`                                 | 300 000 ms                                        |                                                                                                               |

The server checks the response:

- the type is `webauthn.create`;
- the challenge is the one it issued, and the origin is `APP_ORIGIN`;
- the RP ID hash is `SHA-256(rp.id)`;
- user presence is set;
- the algorithm is one it offered.

It stores the credential id, the COSE public key, the signature counter, the transports, and the backup-eligible and backed-up flags. It keeps no attestation statement and no AAGUID.

Verification uses `@simplewebauthn/server`, which parses COSE keys and checks responses to the specification. The browser side uses `@simplewebauthn/browser`'s JSON helpers, or the native `PublicKeyCredential.parseCreationOptionsFromJSON` where present. Both stay in a lazy chunk off the sign-in page's first load.

### Assertion

After the password, the step token carries `PublicKeyCredentialRequestOptions`:

- `allowCredentials`: the account's keys, with their transports;
- `userVerification: 'discouraged'`;
- a fresh 32-byte challenge, one use, bound to the step token.

The server checks:

- the type is `webauthn.get`;
- the challenge is the token's, and the origin is `APP_ORIGIN`;
- the RP ID hash matches, and user presence is set;
- the credential is one of the account's confirmed keys;
- the signature verifies.

The key list is served only to someone who has just proved the password, so it tells a stranger nothing.

**The counter.** The rule is the specification's (6.1.1), which `@simplewebauthn/server` applies: when either the stored counter or the new one is non-zero, the new one must be greater. Otherwise the assertion is refused and the account gets a security notice, since that pattern can mean a cloned key. A key reporting 0 after reporting 5 is refused. Synced passkeys report 0 every time, so a stored 0 and a new 0 pass, and give no signal either way. The person signs in with another method and removes the key.

### Several keys, names and removal

- **Up to ten keys** per account. Settings encourages a second key, kept somewhere else.
- **Names** follow the device-name rules (`docs/devices-design.md` 12): 1 to 40 letters, marks, numbers, spaces and `'’()._·-`. The default is "Security key", or "Passkey" when the response says it is synced. Any session can rename a key. Names are not encrypted, and the rename field says so, as the device rename does.
- **The list** shows each key's name, when it was added, and when it was last used, rounded to the day. It also says whether the key is synced ("Saved in a password manager") or bound to one key.
- **Removing a key** needs the password and the step, by any method, the key itself included. Removing the last method turns the step off and deletes the backup codes (section 4).

**A synced passkey kept in the same password manager as the password** is one factor, not two: whoever opens the manager has both. Settings says so beside a synced key, without refusing it.

### A security key now, a passkey later

The roadmap's Later item, "Sign in with a passkey", is a different thing, and this design keeps them apart:

|                                | Security key as a second step (this design) | Passkey sign-in (later)                                                                 |
| ------------------------------ | ------------------------------------------- | --------------------------------------------------------------------------------------- |
| Password                       | Still needed; still opens the envelope      | None                                                                                    |
| What the key does              | Proves presence to the server               | Signs in and unlocks: its PRF output wraps the account key in a passkey envelope        |
| Credential                     | Non-discoverable is fine; UV discouraged    | Discoverable; UV required; the `prf` extension required                                 |
| Against a copy of the database | No better than the password                 | Better: a PRF output cannot be guessed offline, unlike a password                       |
| Where the key lives            | Any key                                     | A key or browser with PRF; synced passkeys carry the wrap secret in the provider's sync |

- **Separate registrations.** A key registered as a second step was made without user verification or PRF, so it cannot later unlock the account. The same physical key can be registered for both.
- **Separate tables.** The later design gets its own (`account_passkeys`), so neither feature's rules leak into the other.
- **The PRF wrap that `docs/devices-design.md` 3 uses** for a web device under Keys need a device is a third registration with a third purpose. It stays there.

## 4. Where the step sits

### At sign-in

Today `login/finish` checks OPAQUE, creates the session and returns the password envelope in one call. With the step on:

1. `login/start` and the OPAQUE exchange are unchanged.
2. `login/finish` checks OPAQUE and consumes the attempt, as today. It also checks the device proof (`docs/devices-design.md` 12) and records which device the session would attach to. Then, if the account has the step on and the sign-in is not exempt (below), it creates **no session and no cookie, and returns no envelope.** It returns:

    ```
    { twoStep: { token, methods: ['webauthn','totp','backup','phrase'], expiresAt, webauthn?: { challenge, allowCredentials }, phrase?: { userId, recoveryVersion, wrappingSalt } } }
    ```

    `methods` lists only what can answer this token: the app is left out while it is frozen for this sign-in (section 2), `backup` is there while a code is left, and `phrase` while the account has a recovery key.

    `phrase` carries what the device needs to derive the recovery signing key and build its statement (section 5): the account's id is in it because a sign-in has not been told it yet. The token is 32 random bytes and lasts five minutes. The server keeps only its hash, in `two_step_attempts`, with the user, the credential version, the device the session will attach to and the WebAuthn challenge.

3. `POST /api/auth/login/two-step { token, proof }`, where `proof` is one of `{ kind: 'totp', code }`, `{ kind: 'backup', code }`, `{ kind: 'webauthn', response }`, or `{ kind: 'phrase', signature }` (section 5). The apps' browser path for security keys (section 6) sends the same `webauthn` proof; no token is ever marked passed by anything but this request. On success the server deletes the token and checks again, under the user's lock, that the credential version has not changed. It then creates the session (with `two_step_at` set) and returns exactly what `login/finish` returns today: `{ user, envelope, device }` and the cookie.
4. A wrong answer counts against the token and the account (section 2). Five wrong answers end the token.

**Refusals carry a code,** so a client acts on the code and not on the words. At sign-in they are 401; from a signed-in session (below) they are 403, which no client reads as "signed out".

| Code               | Means                                                                                                                              | The client                                             |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `step-wrong`       | The answer was wrong, and the token has answers left                                                                               | Asks again, on the same token                          |
| `step-expired`     | The token is over: five answers, five minutes, or already used                                                                     | Starts again: the password at sign-in, a new challenge |
| `step-frozen`      | The authenticator app is paused for this sign-in (403)                                                                             | Offers a backup code or the phrase                     |
| `step-limited`     | The 15-minute code budget is spent (429)                                                                                           | Offers the phrase, or waiting                          |
| `step-unavailable` | The server cannot check this method right now: a row under a key it no longer has (503, section 8). Nothing was counted or changed | Offers the phrase                                      |
| `two-step`         | The action needs the step and came without it, or the step was turned on meanwhile (403)                                           | Asks for a challenge and the step                      |
| `setup-required`   | The account has no recovery key yet, so the step cannot be turned on (409)                                                         | Sends the person to finish account setup               |
| `update-required`  | The account asks for a step and this client cannot answer one (409, below)                                                         | Says to update                                         |

A 5xx without a code (a bare 500, a gateway's 502, 503 or 504) is not the server's answer to the step. It says nothing about the step or the change, so a client treats it as a reply that never came: at sign-in the step stays and the same answer can be sent again, which a token that was used or ran out answers with `step-expired`; after a change the client checks its session before saying what happened.

**The step comes after OPAQUE, never before.**

- **It cannot be guessed without the password.** Asked first, a code guess would need only an email address.
- **It reveals nothing to a stranger.** "This account has a second step", and which methods, are told only to someone who has just proved the password. A wrong password fails exactly as today, so the step adds no enumeration.

**Old clients.** `login/finish` gains `twoStep: 1` in its body, sent by every client that can answer a step. When the account has the step on and the client did not send it, the server answers 409 `update-required` ("Update HushOS to sign in. This account asks for a second step.") and creates nothing. A client that cannot ask for the step never gets an envelope it should not have, and the person is told why instead of seeing a broken sign-in.

**With an approval level on** (`docs/devices-design.md` 2), a successful step creates the pending session there, not a full one. The order is always password, then step, then approval. Under Approve new devices the envelope is released when the approval completes; under Keys need a device there is none. Device approval never stands in for the step, and the step never stands in for approval: they answer different questions.

### New devices, or every sign-in

| Option                              | Asks for the step                                                                                                                                  | Cost                                                                                                                                              |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every unlock                        | Every time the password is typed, including after a lock on a device that kept its session                                                         | On the web a lock drops the account key (`lock()` in `packages/auth/src/client.ts`), so every unlock is a sign-in. People would turn the step off |
| New devices only                    | Only when the sign-in makes a new device; a device proving its key comes back without it                                                           | A stolen laptop keeps its device key in IndexedDB, so a thief with the password comes back as a known device and skips the step                   |
| **Every new session (recommended)** | Whenever a device gets a session it did not have: a new device, or a known device whose session ended (7 days idle, 30 at most, sign-out, removal) | At most once in 30 days on a device that keeps its session                                                                                        |

**Recommended: every new session.** A sign-in is **exempt** only when all of these hold:

- it presents the cookie of a live session of the same account;
- that session is on the same device;
- that session passed the step (`sessions.two_step_at`) less than 30 days ago.

That is the web's unlock after a lock. The new session inherits `two_step_at` and does not extend it. So a device keeps the step for 30 days from when it last passed it, whatever its unlocks in between, as Bitwarden's "remember me" does. A stolen laptop whose session has ended needs the step.

**On the phones** there is no exemption, and none is needed. The iPhone and Android apps send no cookie to `login/finish` (`Auth.swift`, `Auth.kt`). They keep their session token and the device's sealed copy of the account key between launches, and unlock from that copy (`unlockAccount` in each app's `Vault`) without signing in again. So a phone runs `login/finish` only when it has no session: the first sign-in, after sign-out or removal, or when the session ended after 7 idle days or 30 in all. Each of those asks for the step. The effect is the same as on the web: at most once in 30 days on a phone that keeps its session.

1Password asks for its second factor only on a new device, and again after sign-out or a password change. Its Secret Key on the device is a factor the server never had, so a known device there already proves something. A HushOS device key proves only that the device was signed in once, which a thief holding the laptop also has.

### At security changes

`startSecurityChange` already returns the password envelope to any live session, before the password is checked, and `finishSecurityChange` commits the change after a bound OPAQUE attempt. The step is checked where the change commits:

- **Which actions:**
    - a password change, recovery-key rotation and master-key rotation (`/auth/security/finish`);
    - account deletion (`/auth/delete/finish`);
    - adding or removing a step method, and making new backup codes;
    - changing a device-approval level (`PUT /api/auth/security/device-approval`, when built);
    - a guardian's reset of a child's password, or removal of the child's methods (below).
- **How:**
    1. The client asks `POST /api/auth/two-step/challenge { purpose }` for a step token bound to the session and the purpose (with a WebAuthn challenge).
    2. The action's finish request carries `twoStep: { token, proof }`.
    3. The server checks the password proof first, then the step, then commits. A step token made for one purpose or one session is refused for another.
- **Not removing a device.** Removal already needs the password. Its worst case, signing devices out, is something the owner fixes by signing in again. Adding the step there would make the owner's response to an intrusion slower than the intruder's.

- **The device that made the change stays signed in.** A password change or a rotation ends every session, and the device that made it signs in again at once. With the step on it would then be asked for the step a second time, with a code it has to wait for, having passed it seconds earlier. So a client may send `keepSession: 1` with `/auth/security/finish`:
    - the server then writes a session for that device in the transaction that makes the change, only when the change passed the step, with `two_step_at` set, and for ten minutes at most. Using it never extends it: its deadline does not slide as an ordinary session's does;
    - its token goes out as the cookie and nowhere else. The sign-in that follows replaces it and inherits its step, as any sign-in from a device that keeps its session does;
    - a client that does not ask gets none: the phone apps and older web bundles keep today's behaviour, and are asked for the step when they sign in again. An account without the step gets none either;
    - if the reply is lost, the cookie never arrives and the device is asked for the step like any other.

What this protects is narrow but real: someone with a live session and the password, such as a shared computer where the owner stayed signed in and the password was watched. They cannot change the password, rotate the phrase, delete the account or remove the step.

**A phrase reset** (`/auth/recover/finish`: the email link and the phrase) is not a session flow and asks for no step. It changes the password and signs every device out, and the next sign-in asks for the step as usual. The phrase can answer it (section 5).

A reset also **replaces the phrase**, so the phrase that answers is the new one, which the person has not seen yet. Someone whose only second step is their phrase would otherwise be locked out for good: the old words refused, the new ones behind a sign-in they cannot finish. So a client that makes a reset:

- answers the step of the sign-in that follows with the new phrase. The reset was authorised by the old phrase's signature, and the phrase answers any step, so nothing is skipped;
- shows the new words as soon as the server has accepted the reset, whether or not that sign-in works;
- **never throws the new words away unless the server answered a refusal.** Once the request has left, only a refusal in the server's own words (a 4xx whose body is the server's) says the change was not made, and only then does the client say so: "Your password was not changed. Nothing changed, and your recovery phrase is still the one you have. Please try again." Anything else (no reply, a 5xx, a proxy's page, even a proxy's 4xx) leaves it open, and the client keeps the new words and signs in with the new password to learn more:
    - **applied** only when the server serves back what this change made: the session's account-key envelope has the `wrappingSalt` this change sealed, or the step's `phrase.wrappingSalt` is the one of the recovery key this change sent. A version number is not that: another device's change moves the account to the same number;
    - **unknown** in every other case: the account as it was, the new password refused, the server out of reach. None of these proves the change failed, since the server can commit a moment after a probe looked. The client shows the new words and says to keep both phrases until a sign-in has settled it;
    - a step that does not name this change's recovery key is left unanswered: the new words would only be a wrong answer there, and counted.

**A rotation from a signed-in session does the same.** A new recovery phrase and a new account key (`recovery-key` and `master-key` at `/auth/security/finish`) replace the phrase too, and end every session. If the reply is lost, the session it carried is lost with it, and the person is signed out with a phrase they were never shown. So the client keeps the new words before it sends the change, and:

- whenever the change went through, or may have, and the device is not signed in again, it shows the new words at once, over whatever screen the person lands on, until they say they have saved them. Only that closes it: it is a modal that refuses Escape (`closedby="none"`, and `cancel` refused for a browser without it), and since a browser honours a page's refusal only so often before it closes a modal anyway, it opens again whenever it is closed with the words still held. Not only on the sign-in screen: with a session that is still good the person is sent to a screen that asks them to unlock, and that can need the step, and so the words, too. The words are held in memory only, and forgotten the moment they are acknowledged or the device is locked or signed out, so nobody who comes to the screen later sees them. They go when the page itself is left, too (`pagehide`: another site, a closed tab, the back-forward cache), so the Back button cannot bring them back; a tab that is only hidden or frozen keeps them, since the person is saving them somewhere else and comes back to the same screen. The recovery page showing a phrase ends the showing only when it is the same phrase: after a change that may not have landed, the server can still serve the one from before;
- the sign-in after the change answers its step with the new phrase, as a reset's does;
- whether it went through is read the same way: by what this change made coming back, never by the password signing in (a rotation does not change it) and never by a version number. Only the server's own refusal says nothing changed ("Your account key was not rotated. Nothing changed, and your recovery phrase is still the one you have. Please try again."); with no such answer and no such evidence, the words are shown with "Keep both until you know which one your account uses", even when the device is signed in again on the account as it was. Not "until you have signed in", as a reset says: someone a rotation left signed in would read that as already done.

### Turning the step on and off

- **On:**
    - the first method needs the password;
    - and a recovery key. The phrase passes the step (section 5), so an account that has none yet is refused (409 `setup-required`, "Finish setting up your account first.") when it starts or confirms its first method. For the same reason account setup stores no recovery key while the step is on: added from a session alone, it would be a second step nobody was asked for. An account with the step always has a phrase, and the only way to a new one from a session is a recovery-key rotation, which needs the step;
    - confirming it sets `two_step_at` on the session that enrolled;
    - the screen offers to sign out the account's other devices, ticked by default, since their sessions never passed the step.
- **Off,** which is removing the last method, needs the password and the step, so a stolen session cannot remove it. A policy (below) can stop it being turned off.
- **Notices:** every change sends a security notice (section 7).

### When a policy requires the step

A group can require the step for its members, as `docs/devices-design.md` 4 lets it require an approval level (section 11, question 5). For a member who has no method yet:

- **Their live sessions keep working** until they end (at most 30 days), with a banner on every screen: "Acme requires two-step sign-in. Set it up now, or you'll be asked at your next sign-in."
- **At their next sign-in,** `login/finish` checks the password and returns `{ twoStep: { token, enrol: true } }` instead of a challenge. The token has purpose `enrol`. It takes the enrolment routes in place of a session and the password proof: the person has just proved the password. Confirming the first method (the TOTP code, or the key's registration) is the step. The server then creates the session, releases the envelope and shows the backup codes, all in that request.
- **The phrase cannot stand in for enrolment,** and neither can anything else: a policy that could be answered without a method would require nothing.
- **While the policy stands,** the member cannot remove their last method. The settings screen says "Required by Acme".
- **The guard** (section 10) does not cover a policy: a member with no factor has none for it to check. An older container in a rolling update signs such a member in with the password alone until it is gone.

### Guardians and child accounts

A guardian can reset a child's password before `adult_from` (`POST /api/children/:userId/reset`, `docs/groups-design.md` 4): the guardian's device re-wraps the child's root under the new password, and the child's password sessions end.

- **The guardian passes their own step** for a reset, when theirs is on: it is a security change, authorised by the guardian's session, purpose `child-reset`.
- **A reset changes the password, not the child's step.** The child signs in with the new password and their own method, as after any password change.
- **A guardian may also remove the child's methods** before `adult_from`. This is for a child who has lost their phone, their codes and their phrase. The removal is an `account_guardian_events` entry, a security notice to the child's email and devices, and a line in the child's security log (section 7). The guardian already holds the child's root through the guardian seal and can reset the password, so the child's step never protected them from the guardian. Refusing would only strand the child. From `adult_from` the server refuses it, as it refuses resets (section 11, question 4).
- **A guardian cannot pass the child's step for them** or sign in as the child. The step is still the child's own, against everyone else.

### With saved unlock

- **Saved unlock does not change.** The remembered key is restored only under a live session (`restore()`), and a live session passed the step or was exempt.
- **Under Keys need a device** the copy stays across ended sessions (`docs/devices-design.md` 3). Signing in again then needs the step before the copy opens under the new session. The step does not seal the copy, and the copy does not skip the step.

## 5. When the second step is lost

| Lost                                   | Way back                                                                    |
| -------------------------------------- | --------------------------------------------------------------------------- |
| The authenticator app                  | A security key, a backup code or the phrase; then enrol the app again       |
| A security key                         | Another key, the app, a backup code or the phrase; then remove the lost key |
| Every method and the backup codes      | The phrase                                                                  |
| Every method, the codes and the phrase | Nothing. The account cannot be reached by anyone                            |

### Backup codes

The first way back: section 2. A backup code passes one step; it does not remove a method or turn the step off.

### The recovery phrase

**Recommendation: the phrase satisfies the step, at once, with a security notice.**

- **How it works.** The step screen offers "Use your recovery phrase". The step token's response carries the account's id and the recovery envelope's `wrappingSalt` and `recoveryVersion` (section 4). The id is there because the statement names it and a sign-in has not been told it yet; the salt because the signing key depends on it: `seed = derive(secret, wrappingSalt, 'authentication')`, as a phrase reset derives it (`packages/crypto/src/recovery.ts`). The device derives that key and signs:

    ```
    ["hushos/two-step/phrase",1,userId,sha256(stepToken)]
    ```

    The server checks the signature against the account's stored recovery public key for that `recoveryVersion`, so the phrase never leaves the device. The salt is not secret: the server already serves it with the recovery envelope at `/auth/recover/start`, and here only to someone who has just proved the password. The statement is built identically in `packages/crypto` and `crates/hushos-core`, held together by shared fixtures as the device statements are.

- **Why the phrase counts as a second step:**
    - **It is a separate secret, kept offline.** A second step works because the attacker who has the password does not have it. The phrase was written down or printed once, is never typed at sign-in, and is never stored where the password is: the password manager, the browser, the phishing page. So someone who has stolen the password does not have the phrase. That is the same reason an authenticator app counts.
    - **It is the stronger secret:** 256 bits, against a 20-bit code, and nothing can guess it online or offline.
    - **It matches devices-design.** The phrase approves a device at once at both levels (`docs/devices-design.md` 2). A step that refused the phrase would make the step stricter than Keys need a device.
    - **No dead end.** A person with the phrase is never locked out of an account whose keys they hold.
- **The cost, stated plainly:** a person who keeps the phrase beside the password, in the same password manager or the same drawer, has one factor, not two. The recovery kit screen already says to keep the phrase apart. The two-step screen repeats it.
- **The alternative** is a seven-day wait after the phrase, cancellable from any device or the email, as child conversion waits (`docs/devices-design.md` 6). It stops someone who has both the password and the phrase from getting in at once. It also costs the honest person a week, at the moment they have just lost their other methods. And someone with both can already reset the password through the email and the phrase, and open the account key from the recovery envelope. Section 11 leaves this to the owner.

After the phrase passes the step, the session's settings page opens on Two-step sign-in. It suggests removing the lost methods and making new backup codes.

### Email

**Never alone, and never for the step.**

- Email reaches the account's inbox, which is the weakest thing the person has: shared, forwarded, or taken over through its own weak recovery.
- A step that email could remove would be exactly as strong as the inbox.
- So no link, code or wait sent by email turns the step off, passes it, or removes a method. Email carries notices only.
- **The 72-hour wait** in `docs/devices-design.md` 2 is an approval path, not a step path. With the step on, a device reaches approval only after the step, so the email wait cannot be used to get past it.

### Support

**None that can bypass the step.**

- HushOS's management area gets no "turn off two-step" button, and support answers every request with the paths above.
- An operator with database access can always delete a person's factors, because the step is a server rule. The self-hosting guide says so.
- On hushos.com, doing it by hand is outside policy, and would be pointless as an attack: a hostile operator has the envelope already.
- **What others do** (sources):
    - **Bitwarden** forbids its support from turning two-step login off, and has built no tool for it. Its one recovery code turns every method off.
    - **Proton** lets the password plus a recovery email or phone turn 2FA off: the email path this design rejects.
    - **1Password** keeps 2FA on after a recovery-code recovery, and lets business admins require it or turn it off for the whole organisation.
    - HushOS groups get no power over a member's step in this design (section 11, question 4).

### The trade-off

- **The strict end (no phrase, no support):** a person who loses their methods, their codes and their phrase loses the account. That is already true of the keys today.
- **The lax end (email resets):** the step is only as good as the inbox.
- **The recommendation sits at the strict end, with one exception for the phrase,** because the phrase is the one thing that already proves ownership of the keys.

## 6. iPhone and Android

### Entering a code

- **The step screen is native:** a code field, a backup-code field and "Use your recovery phrase", after the existing OPAQUE sign-in.
- **Autofill:** the code field uses `textContentType = .oneTimeCode` on iOS and the one-time-code autofill hint on Android, so password managers that hold TOTP secrets can fill it.
- **Errors** match the web's ("That code didn't work. Codes change every 30 seconds.").
- **The core:** TOTP is checked only on the server, so `crates/hushos-core` gains no TOTP code. It gains the phrase statement, and the request and response types (`two_step.rs`): the step a reply carries, the answer the routes take, and what a reply is, read from the reply alone as `packages/auth/src/login-reply.ts` reads it. A 200 that is neither a session nor a step, or a refusal without the server's words, is a lost reply on the phones too: the step screen says so and offers the same answer again or a new start, and nothing reads it as a sign-in.
- **Refusals** are acted on by their code (section 4), in the server's words: a wrong answer asks again on the same step; an ended step goes back to the password with why; a paused app leaves the backup code and the phrase; a spent budget (`step-limited`) withdraws the app's codes and the backup codes together, since the budget is one for both; a method the server cannot check (503 `step-unavailable`, nothing changed) is withdrawn alone, the one that was tried, and the others stay offered, since the app's secret and the backup codes can sit under different server keys. A server error without that code is no answer at all: it is a lost reply, and the same answer is offered again. The address's own 429, which carries no code, takes no method away.

- **A step left unanswered is dropped six minutes after it arrived** (the server's five and one more, as the web allows), with what the password opened. The phones count on the clock since boot, never against the step's `expiresAt`: a phone whose date is set a few minutes fast would otherwise find every step over before it was shown.

### Settings on the phones

**Enrolment and management are in the apps, at parity with the web.** An earlier revision kept them on the web for the first release; the owner's rule is now that each client does what the others do, so Account on the iPhone and on Android has Two-step sign-in:

- **Turn it on:** the password again, then the key to add to an authenticator app. The phone is usually where that app is, so there is no QR code to point a camera at: **Open in authenticator app** opens the `otpauth://` address (only that scheme is ever opened), and the key is shown in groups of four to type or copy. A code from the app confirms it.
- **Remove my other devices** is offered whenever the step is being turned on, ticked. The count of other devices is only for the words under it: when the list is unknown or empty the box is still there. Ticked, the devices are removed whatever the list said (`DELETE /auth/devices/others`, with the password just typed; the server removes none when there are none). The backup codes are shown first and the removal runs behind them: Done closes the codes while it is still running, and a removal that fails later is a notice.
- **Backup codes** are shown once, to copy or to hand to the share sheet as the note the web downloads. A copied key or set of codes is cleared from the clipboard two minutes later, as a copied recovery phrase is (the pasteboard's expiry on the iPhone, `SensitiveClipboard` on Android).
- **Replies are believed only in the server's own shape,** as the web's readers take them (`packages/auth/src/login-reply.ts`): `{ success: true }` for a change or a deletion, the id, key and address of a pending app, `{ backupCodes }` or `{ replaced: true }` for a confirmed one (and only the codes when turning the step on), `{ removed: true, on }` for a removal, `{ codes }` for a new set. Anything else with a 200 is a lost reply: the screen says what it cannot tell, and the settings are read again.
- **Manage:** the app with when it was added and last used, Replace, Turn off (removing the last method), New codes, and whether the app is paused for new devices.
- **Recent security activity:** the same list, in the same words.
- **Nothing shows** on a server that has two-step off (501).

### Changes on the phones

- **Change password, Rotate account key and Delete account** ask for the step in the same form, when the account has it: the challenge is asked for as the form opens, and the change carries the answer. The phones have no separate "new recovery phrase": Rotate account key is how a phone gets one, and it asks for the step.
- **No replacement session.** The phones do not send `keepSession` (section 4). After its own password change a phone signs in again, as before, and is asked for the step at that sign-in, on the sign-in screen. After a rotation the new phrase answers it (below).
- **A phrase reset on a phone** (`/auth/recover/finish`) signs in with the new password itself, and the account's phrase is now the one just made there, which the person has not seen yet. That sign-in's step is answered with it: the person proved the old phrase a moment before, and a step they could only answer with a method they may have lost would strand them. The server records it like any other use of the phrase, with its notice.
- **A rotation on a phone does the same.** The sign-in after Rotate account key is the rotation's own, and its step is answered with the phrase the rotation just made. Someone who passed the rotation's step with the old phrase has nothing else left: the old phrase stopped working, and nobody has seen the new one yet. So no one is sent to a sign-in that needs words they were never shown. Signed in, the phone shows the new words from the account, and the check is recorded as usual.
- **Once the server may have taken a new phrase, nothing that fails costs it.** The old phrase is dead the moment a rotation or a reset commits, and the new one exists only in the phone's memory. For someone whose only second step is the phrase, losing it is losing the account. The phone keeps the phrase from before the last request goes out, and shows it whatever comes back.
    - _The server's own reply confirmed the change:_ that stands. If the sign-in after it gives no session (no network, a limit, a step that does not pass), the words are shown from memory, and the sign-in follows them. It is tried twice first.
    - _Only a refusal the server answered withholds the words_ (a 4xx in the server's own words): nothing changed, and the phone says so after the server's reason: "Your password was not changed. Nothing changed, and your recovery phrase is still the one you have. Please try again.", or the same of the account key after a rotation. Nothing else is said to be "not changed".
    - _The request left and no refusal came back_ (a lost reply, a gateway's error, a 4xx with nothing of the server's in it): the words are always shown. A look that finds the account as it was is not proof, because the commit can land a second later, and words that were dropped cannot be shown again. Whether they are shown as the account's, or with the caveat, is judged as on the web (section 4):
        - by what the change itself made, never by whether the new password signs in (someone who reset to the password they already had signs in against the unchanged account) and never by version numbers ("one more than before" is also what another device's change makes). The sign-in with the new password carries the wrapping salt this change generated, on its session envelope or on the recovery key its step names, only if the change was made;
        - that salt seen: made. The words are the account's, and the step is answered with them;
        - another salt, or the new password refused: a session the look opened is ended and never stored on the phone, and the step is not answered, so no wrong answer is counted. The look is made twice. The words are shown with the web's caveat: if the change was made these are the phrase now, if it wasn't the old one still is, keep both: until you have signed in after a reset, until you know which one your account uses after a rotation. Their check is not recorded;
        - nothing carries a salt: the same caveat;
        - a rotation keeps the password, so its look can sign in on the account as it was. That session is kept: the person was signed in a moment ago and still is, so they stay in the app, and the words are shown from memory with the same caveat. (After a reset such a session is ended instead.)
    - _Nothing after the last request may cost the words._ What the phone writes then (the key it remembers) is best effort.
    - _Words held in memory_ are shown in the web's panel and its words (section 4, `new-phrase.tsx`): "Save your new recovery phrase", what the change did, "They are shown here once. If your account asks for a second step when you sign in, these words answer it.", and "I’ve saved these words". The phones keep their own Save the kit and three-word check on it. They take the whole screen (on Android the app's shell draws them in place of the tabs), with no way out but saving and checking them. Nothing signs the app out from under them: the phone treats the end of its session as its own doing from before the change's request goes out until the sign-in after the words has answered. The check is recorded at that sign-in for the phrase's own `recoveryVersion`, and only if the sign-in is that account's on that server. That sign-in answers a step that names the held words' recovery key (by its salt) with them; any other step is the person's. After a reset the sign-in is the person's to do: the phone leaves whatever session it still showed (the recovered account's own was ended by the reset; another account's is signed out properly), and opens sign-in with the recovered address filled in. It says "Your password was changed. Sign in with your new password." only when the reset is known to have been made; otherwise "Sign in with your new password. If it doesn’t work, your old one still does." While a reset is under way or its words are held, an incoming sign-up or reset link waits and opens afterwards.
    - **Residual, chosen: words that arrive after a lock are still shown.** A lock or sign-out (here or in another tab) clears new words already on screen. But if it happens while a reset or rotation is still out, the words that come back afterwards are shown over the locked or sign-in screen. Dropping them instead could lock out for good someone whose only second step was the old phrase, and the lock in that window is almost always the same person in another tab. The words go at the next lock, on acknowledgement, or when the page is left.
    - **Residual: stopping the app while words are held in memory loses them.** They are in memory only, on purpose: a phrase written to the phone's storage before the person has it elsewhere is a second copy to protect. This is now the rare case (no session came of the change's own sign-in). After a reset the phone remembers that words are waiting and shows them first at the next sign-in, read from the account; but an account with the step needs a method to get that far, and someone who had only the old phrase has none. After a rotation nothing is remembered. The way back is then a method that still works, and Rotate account key again.
    - **Why not `keepSession` here.** A replacement session from `security/finish` would stand in for the sign-in after a rotation. It does not remove the hard case: a lost reply to `security/finish` loses the replacement session with it, so the phone must still judge by versions and may still hold words with no session, and it would then carry both paths. It would also have the phones send a session cookie to `login/finish`, which they never do (section 4). The reset has no session to keep at all. Answering the step with the new phrase gives the phone its session without asking the person twice, which is what `keepSession` is for.
- **A password exchange that waits a minute for its turn gives up,** with nothing sent: "This took too long. Please try again." (the web's words for its own timeout). Each request has its own network timeout, so an exchange cannot stall for ever, but one behind a slow one could otherwise wait several of them.
- **One password re-check at a time.** Each change proves the password again in an exchange bound to the session. Turning the step on leaves one running behind the backup codes (the removal of the other devices) while the person can start another; the phones take them in turn, so the second starts only when the first has finished.
- **Where there is no step screen** (the iPhone's sign-in sheet inside Files), an account with the step is told "This account asks for a second step. Open HushOS and sign in there."

### Security keys

- **iOS, on hushos.com:** `ASAuthorizationSecurityKeyPublicKeyCredentialProvider` for USB, NFC and Lightning keys, beside `ASAuthorizationPlatformPublicKeyCredentialProvider` for passkeys. Both require the RP ID in the app's associated domains, and the app already has `webcredentials:$(HUSHOS_LINK_HOST)` (`apps/ios/App/HushOS.entitlements`).
- **Android, on hushos.com:** Credential Manager's `GetPublicKeyCredentialOption` covers passkeys and security keys over USB and NFC. It requires hushos.com's `assetlinks.json` to name the app with the `get_login_creds` relation; the file already exists for app links. The server accepts the app's `android:apk-key-hash:` origin, from an allowlist in configuration, beside `APP_ORIGIN`.
- **Self-hosted servers:** the iOS app's associated domains are fixed when it is built, and Apple's security-key and passkey providers refuse an RP ID the app is not associated with. So the app cannot use a self-hosted server's RP ID. Apple's own advice for a domain the app does not own is `ASWebAuthenticationSession`, so the apps run the security-key ceremony in the system browser. The browser only produces the assertion and hands it back; the app submits it:
    1. The app holds the step token from `login/finish` and never gives it to the browser. It makes a random 32-byte `state`. It opens `ASWebAuthenticationSession` (iOS) or a Custom Tab (Android) at:

        ```
        <server>/two-step/key#<base64url(JSON { challenge, allowCredentials, state })>
        ```

        That is the WebAuthn options from the step response, and the app's `state`. The fragment never reaches the server in a request line or a log.

    2. The page is static. It makes no request to the API, and it renders nothing from the fragment. It says what is about to happen: "Use your security key to finish signing in to HushOS in the app on this phone. If you didn't just start that, close this page." It then runs `navigator.credentials.get` with that challenge, for the server's RP ID.
    3. The page returns the result only to a callback fixed in its own code, never one named by the fragment. The callback is an `https` link on hushos.com, which the app is associated with whatever server it signs in to:

        ```
        https://hushos.com/two-step/return#<base64url(JSON { state, response })>
        ```

        - **Android 12 and later:** the link is a verified App Link. hushos.com's `assetlinks.json` already names the app, so the system opens it in HushOS and in no other app.
        - **iOS:** the link is a Universal Link (`applinks:` in the entitlements). The app passes it to `ASWebAuthenticationSession` as its `https` callback, so the session hands the URL to the completion handler of the app that opened it.
        - **A tapped button, not a redirect.** After the key is touched, the page shows **Return to HushOS** and navigates only when it is tapped. Chrome opens an app for a link only on a navigation the person started, and Safari treats Universal Links the same way.
        - **The path joins the app-link paths** in hushos.com's `apple-app-site-association` and the app's App Link intent filter, beside the paths the app already opens.
        - **The page on hushos.com that the link names is static.** If the link opens in a browser after all (HushOS not installed, or the link not verified), it says "Open this in the HushOS app". It never sends the fragment anywhere, and renders nothing from it.
        - **The custom scheme is only a fallback:** `hushos://two-step-key#…`, for Android before 12 and for installs where verification failed. The page offers it as a second, smaller link only when the first did not open the app.

    4. The app accepts the result only if its `state` is the one it made for the step it has pending. Anything else it drops.
    5. The app calls `login/two-step { token, proof: { kind: 'webauthn', response } }`. That is the same request and the same checks as on the web: the challenge in `clientDataJSON` must be the one stored with this token, and the origin must be `APP_ORIGIN`.

    **The binding.** A step token passes only with an assertion over its own challenge, and only in a request that carries the token. The token never leaves the app that ran OPAQUE. The assertion leaves the browser only through the fixed callback, to the app on the phone where the key was touched. Nothing ever marks a token passed on the server's say-so, or the page's.

    **The attack this stops.** Someone with only the password runs OPAQUE, gets a step token and its challenge, and sends the victim a link to the real page with that challenge. If the victim touches their key, the assertion goes to the victim's own app, which has no matching `state` and drops it. Nothing reaches the attacker, so the attacker's token cannot pass.

    **What is left:**
    - **Wherever the custom-scheme fallback is used, any app can claim the callback.** A custom scheme is not exclusive, so another app on the phone that registers `hushos://` could receive the assertion. That happens on Android without a verified App Link, and on iOS when the page is opened in plain Safari, as an attacker's link would be, rather than in the app's own session. The other app would also have to forward the assertion to the attacker, and the victim would have to touch their key on a page they did not start. That is malware on the phone working with someone who has the password, and section 9 counts a compromised device as its owner. The verified link on hushos.com closes it on every install where it works.
    - **The callback is on hushos.com, not the server's own domain,** because an `https` callback must be on one of the app's associated domains, and a self-hosted server's domain is not one. hushos.com sees no request for it: the system opens the app before any load, and the fragment never leaves the device.
    - The page is served by the server, which the apps otherwise do not trust with code. Here that loses nothing: the step is the server's own check, and the page never sees the password, a key or the step token.

    Android could use the operator's own `assetlinks.json` instead, naming the HushOS app. Nothing in Google's documentation rules that out, and nothing confirms it. The browser path is one path for both platforms.

    **To check before release C:** Apple documents `ASWebAuthenticationSession` for third-party sign-in pages, and an Apple engineer recommends it for this case. No Apple document says a WebAuthn ceremony inside it works for any domain. A spike on a real iPhone, with a USB-C and an NFC key, settles it. If it fails, self-hosted servers on iOS offer codes and the phrase, and say why.

- **Which Android versions** read USB and NFC keys through Credential Manager is not documented by API level; Yubico reports NFC keys through Play services from Android 9, below the app's minimum of 10 (API 29). Real devices decide it in release C.

### What ships when

| Release | Web and server                                                                                                                               | iPhone and Android                                                                    |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| A       | Server enforcement and `update-required`; TOTP, backup codes, the phrase; settings and notices. Behind `TWO_STEP_ENABLED`, off on hushos.com | TOTP, backup code and phrase entry; settings and the security log; `update-required`  |
| B       | `TWO_STEP_ENABLED` on at hushos.com, once release A's apps are live in both stores                                                           | Nothing new                                                                           |
| C       | Security keys: registration and assertion                                                                                                    | Security keys on hushos.com natively, and through the browser for self-hosted servers |

**The order matters.** If the step could be turned on before the store apps can answer it, an Android or iPhone user who turns it on on the web is locked out on the phone until an update arrives. So release B waits for the apps. Review demo accounts (`docs/release/apple.md` 9) keep the step off.

## 7. Notices

Every change to the step is a security notice to the account's email, and to its devices by push (`docs/devices-design.md` 5). Push for these notices is not built yet (section 10): until it is, they go by email only. None of these can be turned off:

| Event                                                                                                                 | Says                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The step turned on                                                                                                    | "Two-step sign-in is on." The method's kind                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| The step turned off                                                                                                   | "Two-step sign-in is off." Sign in and turn it on again if this wasn't you                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| A method added                                                                                                        | "An authenticator app was added", or "A security key was added"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| A method removed                                                                                                      | The same, for removal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| New backup codes made                                                                                                 | The old codes no longer work                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| A backup code used                                                                                                    | How many are left                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| The phrase used for the step                                                                                          | That the phrase was used, and to keep it apart from the password. Not sent when the recovery key that answered was itself made by a reset or a rotation in the last 15 minutes: that change sent its own notice, the person was handed those words a moment ago, and the sign-in after the change answers with them on the person's behalf. It is the key that answered that is looked at, as it was before the answer's own change ran: a rotation authorised with the old phrase is told of, since the key it leaves behind is not the one that was used. The security log has the line either way |
| The recovery phrase replaced, or the account key rotated (`recovery-key` and `master-key` at `/auth/security/finish`) | "Your recovery phrase was replaced", or "Your account key was rotated": the phrase from before no longer works, and the other devices were signed out. Sent once by the change itself, whether or not the step is on. A password change sends neither                                                                                                                                                                                                                                                                                                                                                |
| The password reset with the recovery phrase (`/auth/recover/finish`)                                                  | "Your password was reset with your recovery phrase": a new password and a new phrase were made, the old phrase and its kits no longer work, and every device was signed out. Sent once when the reset succeeds, whether or not the step is on. If it was not the owner, whoever did it had the phrase and the mailbox, and the owner's password and phrase no longer sign in: the notice says so, and that the mailbox comes first                                                                                                                                                                   |
| A correct password, then a failed step at sign-in (section 2)                                                         | "Someone signed in with your password but did not pass the second step." Nobody got in. If this wasn't you, change your password                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| A failed step at a change, from a signed-in session (section 2)                                                       | "Someone signed in to your account tried to change it and did not pass the second step." Nothing was changed. If this wasn't you, check your devices and change your password                                                                                                                                                                                                                                                                                                                                                                                                                        |
| The authenticator app frozen for new devices after 100 failures                                                       | That it is paused on devices HushOS doesn't recognise, and that a backup code or the phrase works there and lifts the pause                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| A key's counter did not go up                                                                                         | The key may have been copied; remove it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

**What a notice never contains:**

- the name of a key or device. A name is chosen by whoever added it, so an intruder would choose the words in the owner's inbox (`docs/devices-design.md` 12);
- an address or browser.

They name only the **kind** of method and the time.

**The new-device notice** that exists today says "Signed in with: Your password". With the step on it names both: "Your password and a security key", "Your password and an authenticator code", "Your password and a backup code", or "Your password and your recovery phrase".

### The security log

Settings › Security gets a list, **Recent security activity**, so a person can see in the app what the emails told them. A notice that went unread, or an inbox someone else controls, still leaves a trace there.

- **What it lists:**
    - each sign-in, with the method that passed the step ("Password and security key", "Password only" when the step was off);
    - each failed step after a correct password, up to ten lines an hour for an account. The phrase has no budget (section 2), so without the cap someone with the password could bury every other line under wrong answers. Only the lines are capped: every failure is still counted;
    - each change to the step, a backup code or the phrase used, the authenticator app frozen, and a key's counter going backwards;
    - password changes, rotations, device removals and guardian actions.
- **What each line shows:** the kind of event, the time to the minute (the emails already carry the minute), and the device kind (web, iPhone, Android). A device still on the account links to its row in the device list.
- **What it never shows:** names (the device list shows those, with its own caveat), addresses or browsers.
- **Where it lives:** in `account_security_events`, kept for 90 days. It is separate from `notification_events`, which `docs/devices-design.md` 5 keeps for only 7 days.
- **Who sees it:** every session of the account, as with the device list, and no session can clear it.
- **What it cannot do:** the server writes it, so it is the honest server's record. A breached server can leave lines out, and no log it serves can prove otherwise.

**Budgets.** Today every device notice shares one budget of ten an hour per account, and notices past it are dropped. A person with the password could fail the step ten times, spend that budget on failure notices, and then a "step turned off" would be dropped. So:

- **failed-step notices** have their own buckets, one an hour for each of the two forms (section 2);
- **changes to the step** are never dropped. They need the password and the step, so an attacker cannot flood them.

## 8. Self-hosting

| Setting                                 | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TWO_STEP_ENABLED`                      | `true` to let accounts turn the step on. Off, the settings screen and routes answer 501, and existing factors are **still enforced** at sign-in. Default `false` in release A, `true` from release B                                                                                                                                                                                                                                                                                                                                                                                      |
| `TWO_STEP_KEY` (or `TWO_STEP_KEY_FILE`) | Optional, 32 bytes, base64url. Seals TOTP secrets and keys the backup-code hash. Unset, the key is derived from the OPAQUE server setup wherever it lives (`serverSetup()` in `packages/auth/src/server.ts`): `HKDF-SHA-256(setup, salt = empty, info = "hushos/two-step/key/v1", 32)`. The `info` differs from the server hash key's (`"hushos/server/hash-key/v1"`), so the two keys are independent. The setup is the same value in the environment or in `server_secrets`, so moving it from the database to the environment, as the self-hosting guide advises, changes nothing here |
| `TWO_STEP_PREVIOUS_KEY` (or `_FILE`)    | During a rotation of an explicit `TWO_STEP_KEY`: the old key. Each row records its key id (the first 8 bytes of `SHA-256(key)`), and the worker reseals TOTP secrets under the current key. The derived key needs no entry here: it is always available, so setting `TWO_STEP_KEY` for the first time is a rotation like any other. Backup codes cannot be re-keyed (the server never holds them in plain text), so each set keeps verifying under its own key id until the person makes a new one; an old explicit key has to stay until then                                            |
| `WEBAUTHN_ANDROID_ORIGINS`              | The `android:apk-key-hash:` origins accepted beside `APP_ORIGIN`. hushos.com sets the HushOS app's; self-hosted servers leave it empty and use the browser path (section 6)                                                                                                                                                                                                                                                                                                                                                                                                               |

**Not built yet** (section 10): the `_FILE` forms of both keys, and the worker that re-seals. Until then the keys are read from the environment only, and nothing moves a row to a newer key. The server reads under three keys at most (the current one, the previous one and the derived one), so only one rotation of an explicit key is safe; a second one drops the key before the previous one, with every secret and code set still under it.

**A row under a key the server no longer has** is the server's fault, never a wrong answer:

- the request is answered 503 `step-unavailable` ("Two-step sign-in is unavailable on this server right now. Use your recovery phrase, or try again later."), nothing is counted, and the answer's slot and budget go back;
- the operator's log names the kind of row and the id of the key it wants;
- the recovery phrase needs no key of the server's, so it still passes the step, and is the way in until the operator puts the key back;
- a backup-code set is unavailable only when none of its unused codes can be compared. If some can, the answer is compared with those, and matching none of them is a wrong answer.

**What an operator must keep secret:**

- `OPAQUE_SERVER_SETUP`, as today, and with it the derived two-step key. Kept in the environment, the key is outside the database and its backups. Kept in `server_secrets`, the key sits beside the secrets it seals and protects nothing against a copy of the database; the guide says so, as it already does for offline password guessing;
- `TWO_STEP_KEY`, if set, outside the database for the same reason.

WebAuthn public keys are not secret.

**What an operator must know:**

- **The domain is part of every security key.** The RP ID is the host of `APP_ORIGIN`. Moving an instance to another domain makes every registered key useless there, and people sign in with the app, a code or the phrase and add their keys again.
- **The operator can turn anyone's step off.** Anyone with write access to the database can delete a person's factors, because the step is a server rule. Self-hosting is the answer to "who runs the server", not a reason to trust it more.
- **Rolling back past release A,** or rolling from a release before A straight to B or later, would drop the step silently on the older containers, since their code does not know it. The migration therefore adds a guard in the database (section 10) that makes an older release fail to sign such accounts in rather than skip the step. The guard covers sign-in only: section 10 says what it leaves.

## 9. Threats and residuals

| Threat                                      | What happens                                                                                                                                                                                                                                                                                                                     | Residual                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Phishing, with TOTP**                     | A page on another domain runs the HushOS client, takes the password and the code, and relays both to the real server within the 90-second window. It gets a session. Because the page itself ran OPAQUE with the typed password, it also has the export key, so it opens the envelope and has the account key                    | TOTP is phishable. The step makes the phisher work in real time; it does not stop them                                                                                                                                                                                                                                                        |
| **Phishing, with a security key**           | The browser binds every assertion to the page's origin and RP ID. A page on another domain cannot get one for HushOS's RP ID, so the relay fails at the step, and the phished password alone opens nothing at the honest server                                                                                                  | The password is still phished; the person should change it. A synced passkey in the same manager as the password is one factor (section 3)                                                                                                                                                                                                    |
| **A hostile server serving the web client** | It can read the password and code as they are typed, and skip its own step                                                                                                                                                                                                                                                       | None that a second step can address. The step is the server's rule, and a hostile server is not bound by it (`docs/groups-threat-model.md` 5)                                                                                                                                                                                                 |
| **A copy of the database**                  | Without the two-step key: no TOTP secrets, no backup codes. With the OPAQUE setup (and so the derived key), it can guess passwords offline, and a guessed password opens a copied envelope without any step                                                                                                                      | The step protects the live server, not copies. Keys need a device is the answer for copies (`docs/devices-design.md` 3)                                                                                                                                                                                                                       |
| **A stolen session cookie**                 | The session already passed the step                                                                                                                                                                                                                                                                                              | Removing the device ends it (`docs/devices-design.md` 1)                                                                                                                                                                                                                                                                                      |
| **A stolen, unlocked device**               | It is the person                                                                                                                                                                                                                                                                                                                 | Out of scope, as everywhere (`docs/groups-threat-model.md` 5)                                                                                                                                                                                                                                                                                 |
| **A cloned security key**                   | A counter that does not go up, when either counter is non-zero, refuses the assertion, with a notice                                                                                                                                                                                                                             | Keys that always report 0, which includes every synced passkey, give no such signal                                                                                                                                                                                                                                                           |
| **Locking the owner out**                   | With the password, from any number of addresses, the account's budget for codes from new devices can be kept spent and the authenticator app frozen for new devices                                                                                                                                                              | The owner's known devices keep their own budget and their codes; keys and the phrase work everywhere; the owner is told their password is known (section 2)                                                                                                                                                                                   |
| **Guessing codes at a step-up**             | Someone with a live session and the password (section 4's narrow case) guesses authenticator or backup codes at a security change, from that session. Each wrong answer counts against the session's device, as a known device's does at sign-in: five answers a token, ten wrong codes in 15 minutes, and a notice at the fifth | A known device's count freezes nothing (section 2): known devices keep taking codes, so the device's 15-minute budget is the only bound on guessing from it. The server sees the device's count on every step token (`poolFailures`), and the owner is told at the fifth wrong answer. Removing the device, or changing the password, ends it |
| **SIM swap**                                | Not applicable: there are no SMS codes, now or later                                                                                                                                                                                                                                                                             | None                                                                                                                                                                                                                                                                                                                                          |
| **Push fatigue**                            | Not applicable: the step never takes a tap on a prompt. Device approval asks the person to type or scan a code from the new screen, not tap Approve (`docs/devices-design.md` 2), and comes after the step, so a stranger cannot raise prompts                                                                                   | None                                                                                                                                                                                                                                                                                                                                          |

**SMS and email codes are left out on purpose.** An SMS code adds a phone number to an account that has none, is open to SIM swap and number recycling, and is as phishable as TOTP. An email code is the inbox again (section 5).

### What the server learns

- whether an account has the step, and which kinds of method, with when each was added and last used (rounded);
- each key's credential id, public key, counter, transports and whether it is synced. With `attestation: 'none'` it learns no maker or model;
- each key's name, which is not encrypted;
- each TOTP secret, sealed at rest, and readable by the server while it runs;
- which method passed each sign-in, through the notice it sends and the security log it keeps for 90 days.

## 10. Schema, API, migrations and tests

### Tables

| Table                     | Holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `two_step_factors`        | `id`, `user_id`, `kind` (`totp`, `webauthn`), `name`, `created_at`, `confirmed_at` (null while enrolling; unconfirmed rows are deleted after ten minutes), `last_used_at` (to the hour). TOTP: `totp_key_id`, `totp_nonce` (24), `totp_secret` (sealed, 36 bytes), `totp_last_step`. WebAuthn: `credential_id` (1 to 1023 bytes), `public_key` (COSE), `sign_count`, `transports`, `backup_eligible`, `backup_state`. Checks tie each kind to its columns. Indexes: `unique (user_id, credential_id)`, and one confirmed TOTP per account (a partial unique index)                                    |
| `two_step_backup_codes`   | `user_id`, `code_hash` (the Argon2id output of section 2, 32 bytes), `key_id`, `created_at`, `used_at`; primary key `(user_id, code_hash)`. A new set deletes the old one in the same transaction                                                                                                                                                                                                                                                                                                                                                                                                     |
| `two_step_attempts`       | `token_hash` (primary key), `user_id`, `purpose` (`login`, `password`, `master-key`, `recovery-key`, `delete`, `two-step`, `device-approval`, `child-reset`, `enrol`), `session_token_hash` (null exactly when `purpose` is `login` or `enrol`), `credential_version`, `device_id` and `previous_token_hash` (`login` and `enrol` only: the two that end by opening a session), `webauthn_challenge` (32), `answers` and `failures` (a token allows five answers; a slot is taken before each is checked), `created_at`, `expires_at` (five minutes). The worker deletes expired rows with the others |
| `two_step_state`          | `user_id` (primary key), `webauthn_user_handle` (32, unique), `backup_code_salt` (16), `consecutive_failures` and `totp_frozen_at` (sign-ins without a device proof)                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `account_devices`         | gains `two_step_failures`: the consecutive count for sign-ins that proved this device (section 2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `account_security_events` | `id`, `user_id`, `kind`, `method` (the step's kind, or null), `device_id` (null once the device is gone), `device_kind`, `created_at`. Deleted after 90 days (section 7)                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `sessions`                | gains `two_step_at`: when the session, or the session it replaced at an unlock, passed the step                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

**An account has the step on** exactly when it has a confirmed factor. No separate flag can disagree with the factors.

### Routes

Base64url without padding; ids lowercase UUIDs, as elsewhere.

| Route                                                   | Body → response                                                                                          | Notes                                                                                                                                                                             |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/auth/login/finish`                           | adds `twoStep: 1` → `{ twoStep: { token, methods, expiresAt, phrase?, webauthn? } }` or today's response | 409 `update-required` for a client without `twoStep: 1` on an account with the step on                                                                                            |
| `POST /api/auth/login/two-step`                         | `{ token, proof }` → `{ user, envelope, device }` and the cookie                                         | 401 `step-wrong` for a wrong answer; `step-expired` once the token is over, after five answers (section 4)                                                                        |
| `GET /api/auth/two-step`                                | → `{ on, methods: [{ id, kind, name, createdAt, lastUsedAt, synced }], backupCodesLeft, totpFrozen }`    | Any session of the account                                                                                                                                                        |
| `POST /api/auth/two-step/reauth`                        | `{ startLoginRequest }` → `{ attemptToken, loginResponse }`                                              | A bound OPAQUE attempt tagged `two-step`, limited like the others (`limitBoundAttempts`)                                                                                          |
| `POST /api/auth/two-step/challenge`                     | `{ purpose }` → `{ token, methods, expiresAt, phrase?, webauthn? }`                                      | A step token bound to the session and the purpose                                                                                                                                 |
| `POST /api/auth/two-step/totp`                          | `{ attemptToken, finishLoginRequest, twoStep? }` → `{ id, secret, uri }`                                 | A pending factor for ten minutes; `twoStep` once the step is on; 409 `setup-required` without a recovery key                                                                      |
| `POST /api/auth/two-step/totp/:id/confirm`              | `{ code }` → `{ backupCodes }` or `{ replaced: true }`                                                   | Codes only when this turns the step on                                                                                                                                            |
| `POST /api/auth/two-step/keys/options`                  | `{ attemptToken, finishLoginRequest, twoStep? }` → `{ registrationToken, options }`                      |                                                                                                                                                                                   |
| `POST /api/auth/two-step/keys`                          | `{ registrationToken, name?, response }` → `{ method, backupCodes? }`                                    | 409 `limit` past ten keys                                                                                                                                                         |
| `PUT /api/auth/two-step/methods/:id`                    | `{ name }`                                                                                               | PUT, as the device rename is                                                                                                                                                      |
| `DELETE /api/auth/two-step/methods/:id`                 | `{ attemptToken, finishLoginRequest, twoStep }`                                                          | The last one turns the step off and deletes the codes                                                                                                                             |
| `POST /api/auth/two-step/backup-codes`                  | `{ attemptToken, finishLoginRequest, twoStep }` → `{ codes }`                                            | Replaces every code                                                                                                                                                               |
| `GET /two-step/key`                                     | A static page, no API call                                                                               | The apps' browser path for security keys (section 6): runs the assertion from the fragment and returns it to `https://hushos.com/two-step/return` (the custom scheme as fallback) |
| `GET /two-step/return` (hushos.com)                     | A static page, no API call                                                                               | The verified callback the apps open; in a browser it says to open the HushOS app, and never sends its fragment                                                                    |
| `GET /api/auth/security-events`                         | → `[{ id, kind, method, deviceId, deviceKind, createdAt }]`                                              | The last 90 days, newest first                                                                                                                                                    |
| `POST /api/children/:userId/reset`                      | adds `twoStep?: { token, proof }` (the guardian's own)                                                   | `DELETE /api/children/:userId/two-step` removes the child's methods, before `adultFrom` only                                                                                      |
| `POST /api/auth/security/finish`, `/auth/delete/finish` | add `twoStep?: { token, proof }`; `security/finish` also takes `keepSession?: 1` (section 4)             | 403 `two-step` when the step is on and the proof is missing; 403 `step-wrong` or `step-expired` when it is wrong or over                                                          |

### Migrations

1. **The tables and `sessions.two_step_at`,** in one generated migration, with `lock_timeout` as the devices migration has it (`docs/devices-design.md` 12). The new column is nullable with no default, so adding it does not rewrite `sessions`.
2. **`opaque_login_attempts_purpose_binding`** gains `two-step` (and later `device-approval`).
3. **A guard on `sessions`:** a custom SQL migration (`drizzle-kit generate --custom`; Drizzle does not model triggers). It adds a `BEFORE INSERT` trigger that refuses a session with `two_step_at` null for a user who has a confirmed factor. Older code never sets the column, so a rolling update or a rollback past release A fails to sign those accounts in, rather than handing their envelope to the password alone. It is the repository's first trigger. The reason belongs in the migration's comment and in `docs/self-hosting.md`.

    **What it does not cover:** step-ups. An older container also skips the step at a password change, a rotation and account deletion, since its `/auth/security/finish` and `/auth/delete/finish` know nothing of it. Only a session that already exists can get there, and it still needs the password. So the narrow case of section 4 (a live session and a watched password) is open again on older containers for as long as they run. Closing it would need a guard on every table those changes write (`opaque_credentials`, `account_keys`, the deletion of `users`), each checking a step grant consumed in the same transaction. That is more machinery than a rollback window is worth. The self-hosting guide says to finish a rollout before people turn the step on, and not to roll back past release A.

4. **No existing data changes:** nobody has a factor until release B lets them make one.

### Tests that must exist

This is authentication, so AGENTS.md's rule for keys applies: repository tests in `packages/db` against Postgres, and server and crypto tests in `packages/auth`, `packages/crypto` and `crates/hushos-core`. Each fails on a defect a person or an attacker would notice:

- **The gate:**
    - with the step on, `login/finish` with a correct password returns no envelope, sets no cookie and creates no session row;
    - `login/two-step` with a correct proof returns the envelope and a session;
    - a client without `twoStep: 1` gets `update-required` and nothing else;
    - a sign-in exempted by a live, stepped session on the same device inherits `two_step_at` and does not extend it. One on another device, or with a session older than 30 days, is asked.
- **The guard:** inserting a session with `two_step_at` null for an account with a confirmed factor fails in the database, whatever the code above it does.
- **Step tokens:**
    - a token is single use, and dies after five wrong answers or five minutes;
    - a token from before a password change is refused after it;
    - a token bound to one purpose or session is refused for another;
    - a login token cannot authorise a security change.
- **TOTP:**
    - RFC 6238's SHA-1 test vectors pass;
    - T−1, T and T+1 are accepted and T±2 refused;
    - the same code is refused the second time, including two concurrent requests, of which exactly one succeeds;
    - a code used at sign-in is refused for a security change in the same step;
    - a pending factor never satisfies the step, and expires;
    - a frozen authenticator app is refused for sign-ins without a device proof, while a key, a backup code and the phrase still pass, and a known device's code still passes.
- **The sealed secret:**
    - a secret sealed for one user or factor does not open as another's (associated data);
    - a row sealed under a previous key opens with `TWO_STEP_PREVIOUS_KEY` and is resealed by the worker;
    - the derived key is the same whether the OPAQUE setup comes from the environment or from `server_secrets`, so a secret sealed before the setup moves still opens after, and it differs from the server hash key.
- **Backup codes:**
    - each works once, including under two concurrent requests;
    - a new set invalidates the old;
    - input normalisation accepts `7kq2m 9xd4p` and refuses a code from another account;
    - the stored value is neither the code nor its plain SHA-256, and does not verify under another account's salt or another two-step key.
- **WebAuthn:**
    - each of these is refused: a wrong origin, a wrong RP ID hash, a wrong or reused challenge, missing user presence, another account's credential, a removed key, a new counter not greater than the stored one when either is non-zero (5 then 5, 5 then 0);
    - a stored 0 and a new 0 pass;
    - registration refuses a credential already on the account.
- **The phrase:**
    - a phrase signature over another token, or by another account's recovery key, is refused;
    - after a recovery-key rotation the old phrase no longer passes;
    - the statement's bytes match across `packages/crypto` and `crates/hushos-core` (shared fixtures);
    - the step response carries the recovery envelope's salt, and the key derived with it verifies; a key derived with another salt is refused.
- **Changes:**
    - removing a method or making codes without the step is refused;
    - removing the last method turns the step off and deletes the codes;
    - a password change, a rotation or a deletion without the step is refused when it is on.
- **Limits:**
    - the eleventh wrong code in 15 minutes from sign-ins without a device proof is refused across tokens and addresses;
    - with that budget spent and the app frozen for new devices, a sign-in with a valid device proof still takes a code, within its own budget;
    - a sign-in with a forged or another account's device proof falls into the shared budget;
    - the fifth consecutive failure sends one notice an hour;
    - the hundredth freezes the authenticator app for new devices only.
- **The apps' browser path:**
    - the key page makes no API request and returns only to `https://hushos.com/two-step/return`, or the `hushos://two-step-key` fallback, whatever the fragment says, and only on a tap;
    - the hushos.com return page sends nothing and renders nothing from its fragment;
    - an assertion over one token's challenge does not pass another token;
    - the app drops a callback whose `state` is not the one it made.
- **Policies and guardians:**
    - a member under a policy with no method gets an `enrol` token and no envelope until a method is confirmed, and cannot remove their last method;
    - a guardian's reset needs the guardian's step, and leaves the child's methods in place;
    - a guardian's removal of the child's methods is refused from `adult_from`, and appears in the child's security log.
- **Notices:**
    - no notice carries a method's or device's name;
    - failed-step notices cannot exhaust the budget that would drop a "step turned off".
- **End to end (Playwright):**
    - turn the step on with the QR secret read from the page, and sign in with a computed code;
    - sign in with a backup code, and with the phrase;
    - add and use a security key through Chromium's virtual authenticator;
    - an old client is told to update.

### Implementation plan

One change per pull request, as AGENTS.md asks:

1. **`feat(db)`:** the tables, `sessions.two_step_at`, the session guard trigger and the repository functions (factors, codes, attempts, the conditional `totp_last_step` update, failure counters), with their Postgres tests.
2. **`feat(auth)`:** the step at `login/finish` and `login/two-step`, `update-required`, step-up for security changes and deletion, TOTP and backup codes, the phrase statement in `packages/crypto`, rate limits and notices. Everything is behind `TWO_STEP_ENABLED`, off.
3. **`feat(web)`:** settings (enrol, list, rename, remove, codes) and the sign-in step screen, with Playwright tests.
4. **`feat(ios)` and `feat(android)`:** the step screen for codes, backup codes and the phrase, and `update-required`; the phrase statement in `crates/hushos-core` with the shared fixtures.
5. **`docs`:** `docs/self-hosting.md` (the settings, the key, the trigger, rollback) and `docs/opaque-auth-design.md`.
6. **`feat(auth)`:** what steps 1 and 2 left out, all of it needed before the flag goes on:
    - **re-sealing on rotation:** the worker moves TOTP secrets to the current key (section 8). Until it does, only one rotation of an explicit key is safe;
    - **`TWO_STEP_KEY_FILE` and `TWO_STEP_PREVIOUS_KEY_FILE`:** until then both keys are read from the environment only;
    - **push for the step's notices** (section 7): until then they go by email only.
7. **`chore(web)`:** turn `TWO_STEP_ENABLED` on at hushos.com once the apps from 4 are live in both stores and step 6 is in. The roadmap item moves to Shipped in the same PR.
8. **`feat(auth)` and `feat(web)`:** security keys, registration and assertion, with the virtual-authenticator tests.
9. **`feat(ios)` and `feat(android)`:** security keys natively on hushos.com, and the browser path for self-hosted servers (the static `/two-step/key` page; the verified `https://hushos.com/two-step/return` link, with `hushos://two-step-key` as the fallback).

Section 12 (13 November) replaces that order: passkeys and a default method next, then approving on another device as a method of the step, not a check after it.

## 11. Open questions

1. **Does the recovery phrase pass the step at once, or after a seven-day wait?** _Recommendation: at once, with a security notice._ The phrase is a separate secret kept offline, never typed at sign-in and never stored with the password, so someone who has stolen the password does not have it. That is what makes it a second step. A wait would cost the honest person a week just after losing their other methods. It also keeps the phrase's place in `docs/devices-design.md`, where it approves at once.
2. **When is the step asked: every new session, new devices only, or every unlock?** _Recommendation: every new session, good for 30 days on a device that keeps its session._ New devices only lets a stolen laptop skip it; every unlock is so frequent on the web that people would turn it off (section 4).
3. **Offer TOTP at all, or security keys only?** _Recommendation: offer both, and recommend keys._ Many people have no key, and TOTP still stops a stolen password, which is the common case. Settings says plainly that only a key stops phishing.
4. **Can a group turn a member's step off?** That is, a family organiser, a company admin, or a guardian for a child. 1Password lets business admins turn 2FA off across the whole organisation. _Recommendation: no, except a guardian on a child account before `adult_from`,_ recorded in `account_guardian_events`, notified, and shown in the child's security log. A guardian already holds the child's root and can reset the password, so the step never protected the child from the guardian; refusing would only strand a child who lost their phone. For everyone else, power over a member's sign-in would be a way around the member's own choice, and companies get SSO and policies instead. Revisit with the company release if admins need it to run support.
5. **Can a group require the step by policy, and what happens to a member without a method?** _Recommendation: yes, as `docs/devices-design.md` 4 does for approval levels. The member enrols at their next sign-in, before the envelope; their live sessions keep working until then, with a banner (section 4)._ It is a server rule shown to the member ("Required by Acme"). Companies get it with their release; families only for child accounts, decided by a guardian.
6. **Does turning the step on sign the other devices out?** _Recommendation: offer it, ticked by default._ Their sessions never passed the step, and a person turning it on may be reacting to an intrusion.
7. **Where does the two-step key come from when the operator sets none?** _Recommendation: derived from the OPAQUE server setup wherever it lives, with its own HKDF `info`._ Moving the setup from the database to the environment, as the guide advises, then leaves the key unchanged. The cost: an instance that keeps the setup in the database keeps the key beside the secrets it seals, where it protects nothing against a copy of the database.
8. **A key whose counter does not go up: refuse it, or accept it with a notice?** _Recommendation: refuse, by the specification's rule (either counter non-zero and the new one not greater), and notify._ The person has other methods, and a cloned key is worth a sign-in's friction. Synced passkeys, always at 0, are unaffected.
9. **Is the database trigger acceptable as the repository's first?** _Recommendation: yes._ hushos.com does not need it: it deploys each release in order, and only switches the step on (release B) once no container of an earlier release runs. Self-hosters do. One who skips releases, rolling from before release A straight to B or later, runs old and new containers side by side while people can turn the step on, and one who rolls back runs old code against accounts that have it. Without the guard, either silently signs those accounts in with the password alone. It covers sign-in only, not step-ups (section 10).

## 12. One way to confirm a sign-in (revision of 13 November 2026)

The owner asked for passkeys, authenticator codes and device approval to be **alternatives**, with one of them chosen as the default and the others a tap away ("set passkeys, 2fa and device approvals, then it should use the default one i set as default but still let me change it"). Asked whether the default should choose only between second steps, with approval asked after them as section 1 had it, the owner chose one way to confirm (2026-11-13). Synced passkeys count (2026-11-13), as section 3 already allows. This section overrides the earlier sections where they disagree.

### The methods

| Method                        | What it is                                                                                                                                       | Can be the default                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| **Passkey or security key**   | Section 3, unchanged: WebAuthn, synced passkeys allowed, up to ten                                                                               | Yes                                       |
| **Authenticator app**         | Section 2, unchanged                                                                                                                             | Yes                                       |
| **Approve on another device** | `docs/devices-design.md` 2's request, run as the step: one of the account's devices types the code shown on the new screen, or scans its QR code | Yes, while the account has another device |
| **Backup code**               | Section 2, unchanged                                                                                                                             | No: a way back                            |
| **Recovery phrase**           | Section 5, unchanged                                                                                                                             | No: a way back                            |

- **The step is on** when the account has at least one of the first three. Turning on any of them for the first time turns the step on, makes the backup codes (section 2) and offers to sign out the other devices (section 4), as the authenticator app does today.
- **Approve on another device** is turned on in settings like the others. It needs at least one other device on the account (`account_devices`, not revoked), and settings says so when there is none. Removing the last other device leaves it on but unusable until a device is added again; the step screen then offers the remaining methods, and settings says why it can't be used.
- **No email path.** `docs/devices-design.md` 2's 72-hour email wait is not a way to confirm: section 5 refuses email for the step, and this revision keeps that. With no other device, the person uses another method, a backup code or the phrase.

### The default

- **One per account,** stored on the server (`users.two_step_default`: `webauthn`, `totp` or `device`), so every device opens the same way. The first method turned on becomes the default. Settings shows **Default** beside it and **Make default** on the others.
- **Removing the default** makes the next one the default, in the order passkey, app, device.
- **The step screen opens on the default** and offers **Use another way**, which lists every method this sign-in can use, backup codes and the phrase last. The choice is for this sign-in only; it does not change the default.
- **When the default can't be used** for this sign-in (the app frozen for new devices, no other device to approve, a phone that can't use a passkey for this server), the screen opens on the next usable method in the order above and says why in one line.
- **Passkey as the default** shows **Use your passkey** as a button; the browser's or phone's passkey sheet opens on the press, never on page load (Safari requires a gesture, and a sheet that opens by itself reads as an attack).

### Approve on another device, as the step

`docs/devices-design.md` 2's request, with these changes:

1. It starts from the step token (section 4) instead of a pending session: `login/finish` returns `methods` including `device` and the step token; the new device calls `POST /api/auth/approvals` with the step token and its commitment. Nothing else in the request protocol changes: commitment, open, reveal, the code of two digits and a word, typed or scanned, signed by the approving device's key.
2. **When it is approved,** the server marks the step token passed by `device` and answers the new device's next `POST /api/auth/login/two-step { token, proof: { kind: 'device', requestId } }` with the session and envelope, under the same checks as any other proof (credential version unchanged, under the user's lock).
3. **The approving device** is any approved device of the account with a live session that passed the step. Its prompt says what is asked: "Sign-in on Chrome on Windows, near Lyon, France".
4. **Limits** are `docs/devices-design.md` 2's: one open request per account, ten minutes, five a day; a denied or wrong code ends the request and counts as a failed step (section 2's counters and notices). **This wasn't me** ends it and sends the failed-step notice.
5. **At security changes** (section 4), `device` is also a method: the request names the change ("Change your password on Chrome on Windows?") and is bound to the step-up token and its purpose.
6. **What it protects:** like the authenticator app, it stops a stolen password at an honest server, and it is phishable in real time (a fake page can show the real code). Passkeys remain the one method a fake page can't relay; settings says so.
7. **Keys need a device** (`docs/devices-design.md` 3) is unchanged and stays separate: it is a cryptographic level, not a way to confirm, and is not part of this revision.

### Older apps

`login/finish`'s `twoStep` field becomes a version: `1` answers `totp`, `backup` and `phrase`; `2` adds `webauthn` and `device`. The server lists only the methods the client can answer. A client at `1` whose account has only methods it can't answer still gets `backup` and `phrase`, and the response carries `update: true`, so the app says "Update HushOS to use your passkey or another device. You can use a backup code or your recovery phrase now." Every account with the step has backup codes and a phrase, so no older client is locked out.

### On the phones

Section 6's plan for security keys stands: native passkeys on hushos.com (Associated Domains `webcredentials:hushos.com` on iOS, Digital Asset Links and Credential Manager on Android, `WEBAUTHN_ANDROID_ORIGINS`), and the browser path for self-hosted servers. Approving on a phone adds a prompt (from push, and in the app's Account → Your devices) that scans or types the new device's code.

### Build order

1. **Passkeys and the default** (sections 3 and 12), on the web, iPhone and Android together, with the default stored and honoured.
2. **Approve on another device** as a method, on all three, with its push prompt.

Both are behind no new flag: `TWO_STEP_ENABLED` already decides whether accounts can turn the step on.

## Owner decisions (2026-10-21)

All nine open questions are answered as recommended:

1. The recovery phrase passes the step at once, with a security notice; there is no wait.
2. The step is asked for on every new session, and is good for 30 days on a device that keeps its session.
3. Both authenticator apps and security keys are offered, and security keys are recommended.
4. No group can turn a member's step off, except a guardian on a child account before `adult_from`, recorded, notified and logged.
5. A group can require the step; a member without a method enrols at their next sign-in, before the envelope.
6. Turning the step on offers to sign out the other devices, ticked by default.
7. The two-step key is derived from the OPAQUE server setup wherever it lives, with its own HKDF `info`, unless `TWO_STEP_KEY` is set.
8. A key whose counter does not go up, when either counter is non-zero, is refused, with a notice.
9. The `sessions` guard trigger goes in, as the repository's first, covering sign-in only.

## Sources

Specifications and guidance:

- RFC 6238, TOTP: Time-Based One-Time Password Algorithm. The 30-second step, at most one step of network delay, and no second acceptance of a code (5.1, 5.2, 6). https://www.rfc-editor.org/rfc/rfc6238
- RFC 4226, HOTP. The 160-bit shared secret (section 4, R6), and throttling across sessions (7.2, 7.3). https://www.rfc-editor.org/rfc/rfc4226
- Google Authenticator, Key Uri Format. `otpauth://` parameters, and which ones Google Authenticator ignores. https://github.com/google/google-authenticator/wiki/Key-Uri-Format
- W3C, Web Authentication Level 3. Attestation `none` (5.4.7), `userVerification` (5.8.6), `residentKey` (5.4.6), `excludeCredentials` and `allowCredentials` (5.4, 5.5), the signature counter (6.1.1, 7.2), the PRF extension (10.1.4), RP ID rules (5.1.3). https://www.w3.org/TR/webauthn-3/
- OWASP, Multifactor Authentication Cheat Sheet. Reauthentication with an existing factor before changes, single-use recovery codes, notifying on a failed second factor, and TOTP being phishable. https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html
- NIST SP 800-63B, revision 4. At most 100 consecutive failures (3.2.2); look-up secrets, their hashing and single use (3.1.2); OTPs and look-up secrets not phishing-resistant, WebAuthn's verifier name binding (3.1.4, 3.2.5). https://pages.nist.gov/800-63-4/sp800-63b.html

Platforms:

- Apple, Supporting security key authentication using physical keys: a `webcredentials` associated domain is required. https://developer.apple.com/documentation/authenticationservices/supporting-security-key-authentication-using-physical-keys
- Apple, Supporting passkeys: only for the app's associated domains. https://developer.apple.com/documentation/authenticationservices/supporting-passkeys
- Apple, `ASWebAuthenticationSession`, and its `https` callback rule. https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession
- Apple Developer Forums, an Apple engineer on authenticating to a domain the app does not own. https://developer.apple.com/forums/thread/726943
- Android, Credential Manager prerequisites: Digital Asset Links with `delegate_permission/common.get_login_creds`. https://developer.android.com/identity/credential-manager/prerequisites
- Yubico, on NFC FIDO2 keys through Google Play services from Android 9 (a vendor source). https://www.yubico.com/blog/google-play-services-adds-support-for-nfc-enabled-fido2-security-keys-how-yubico-makes-android-passkey-authentication-seamless/

How others handle a second factor with end-to-end encryption:

- Proton: authenticator apps, FIDO2 keys and one-time recovery codes. https://proton.me/support/two-factor-authentication-2fa and https://proton.me/support/2fa-security-key
- Proton: a recovery method and the password turn 2FA off. https://proton.me/support/lost-two-factor-authentication-2fa
- Proton: two-password mode, where a second password decrypts the data. https://proton.me/support/single-password
- 1Password: two-factor authentication, asked on new devices. https://support.1password.com/two-factor-authentication/
- 1Password: 2FA stays on after recovery with a recovery code. https://support.1password.com/recovery-codes/
- 1Password: admins require or turn off 2FA for a business. https://support.1password.com/manage-two-factor-authentication/
- 1Password Security Design white paper, 15.1: MFA secrets among the server data a breach exposes. https://1passwordstatic.com/files/security/1password-white-paper.pdf
- Bitwarden: two-step login methods. https://bitwarden.com/help/setup-two-step-login/
- Bitwarden: the recovery code turns every method off. https://bitwarden.com/help/two-step-recovery-code/
- Bitwarden: "remember me" for 30 days, and two-step login needed to log in, not to unlock. https://bitwarden.com/help/twostep-faqs/
- Bitwarden: no account or data recovery without a recovery path. https://bitwarden.com/help/lost-two-step-device/
- Bitwarden Security White Paper: support may not turn two-step login off. https://bitwarden.com/help/bitwarden-security-white-paper/

Not confirmed from any of these: how many recovery codes Proton issues; whether Proton's or 1Password's support can turn off one person's second factor; whether a WebAuthn ceremony inside `ASWebAuthenticationSession` works for any domain (section 6).
