# Two-step sign-in and security keys

This document adds an optional second step to signing in to HushOS: a code from an authenticator app (TOTP), a security key (WebAuthn), or a backup code, asked for after the password and before the server hands over anything. It says what that step protects in an end-to-end encrypted system and what it does not, where it sits in each flow, how a person gets back in without it, and how it ships on the web and the apps. It sits beside `docs/devices-design.md` (Approve new devices, Keys need a device) and changes nothing there; section 1 says how the three fit together.

Written on 21 October 2026. Nothing here is built. Section 11 lists the decisions the owner still has to make, each with a recommendation.

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

1. The person opens Settings › Security › Two-step sign-in and confirms their password. This is a one-use OPAQUE exchange bound to the session and tagged `two-step`, as removing a device is (`docs/devices-design.md` 12). Once a step is on, adding another method also needs the step (section 4).
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
- **Codes are compared in constant time,** and the check runs the same way whatever the result.

### Rate limits and lockout

A six-digit code with three steps accepted is a 3 in 10⁶ guess. The password is the first factor, so every guess at the step comes from someone who already has it; the limits make guessing hopeless and make sure the person hears about it.

- **Per sign-in:** each step token (section 4) allows five wrong answers, then it is gone, and the next try needs the password and a new OPAQUE run. Those runs are limited already: ten in 15 minutes per email and address (`limitPasswordAttempts`).
- **Per account:** ten wrong codes in 15 minutes across all tokens and addresses, then codes are refused with 429 for the rest of the window. The budget covers only what can be guessed, authenticator and backup codes. A security key and the phrase are never refused for it, so an attacker spending the budget cannot shut the owner out of those.
- **A consecutive count** per account, reset by any success:
    - at **5**, the account's email and devices get a security notice: "Someone signed in with your password but did not pass the second step." At most one an hour. A correct password followed by a failed step is the clearest signal that the password is known, so this notice matters more than any other here.
    - at **100**, the authenticator app is **frozen**: TOTP codes are refused for the account, with a notice. Security keys, backup codes and the phrase still work, and a success with any of them unfreezes it. NIST SP 800-63B caps consecutive failures at 100 for this reason. The chance of a lucky guess before the freeze is about 3 × 10⁻⁴.
- **Lockout cost:** someone with the password can keep the owner's codes refused, and freeze the authenticator app in a few hours (ten tries per 15 minutes). The owner then signs in with a key, a backup code or the phrase, and should change the password, which the notices have already told them is known. Every lockout scheme gives an attacker with the first factor this lever; this one bounds it to one method and tells the owner.

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

**The counter.** Synced passkeys always report 0, and the server ignores a counter that is 0. When the stored counter and the new one are both non-zero and the new one is not greater, the assertion is refused and the account gets a security notice. That pattern means a cloned key, as the specification warns. The person signs in with another method and removes the key.

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
    { twoStep: { token, methods: ['webauthn','totp','backup','phrase'], expiresAt, webauthn?: { challenge, allowCredentials } } }
    ```

    The token is 32 random bytes and lasts five minutes. The server keeps only its hash, in `two_step_attempts`, with the user, the credential version, the device the session will attach to and the WebAuthn challenge.

3. `POST /api/auth/login/two-step { token, proof }`, where `proof` is one of `{ kind: 'totp', code }`, `{ kind: 'backup', code }`, `{ kind: 'webauthn', response }`, `{ kind: 'phrase', signature }` (section 5), or `{ kind: 'passed' }` for a token a security-key page has already passed (section 6). On success the server deletes the token and checks again, under the user's lock, that the credential version has not changed. It then creates the session (with `two_step_at` set) and returns exactly what `login/finish` returns today: `{ user, envelope, device }` and the cookie.
4. A wrong answer counts against the token and the account (section 2). Five wrong answers end the token.

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

That is the web's unlock after a lock, and a phone's unlock after its app was locked. The new session inherits `two_step_at` and does not extend it. So a device keeps the step for 30 days from when it last passed it, whatever its unlocks in between, as Bitwarden's "remember me" does. A stolen laptop whose session has ended needs the step.

1Password asks for its second factor only on a new device, and again after sign-out or a password change. Its Secret Key on the device is a factor the server never had, so a known device there already proves something. A HushOS device key proves only that the device was signed in once, which a thief holding the laptop also has.

### At security changes

`startSecurityChange` already returns the password envelope to any live session, before the password is checked, and `finishSecurityChange` commits the change after a bound OPAQUE attempt. The step is checked where the change commits:

- **Which actions:**
    - a password change, recovery-key rotation and master-key rotation (`/auth/security/finish`);
    - account deletion (`/auth/delete/finish`);
    - adding or removing a step method, and making new backup codes;
    - changing a device-approval level (`PUT /api/auth/security/device-approval`, when built).
- **How:**
    1. The client asks `POST /api/auth/two-step/challenge { purpose }` for a step token bound to the session and the purpose (with a WebAuthn challenge).
    2. The action's finish request carries `twoStep: { token, proof }`.
    3. The server checks the password proof first, then the step, then commits. A step token made for one purpose or one session is refused for another.
- **Not removing a device.** Removal already needs the password. Its worst case, signing devices out, is something the owner fixes by signing in again. Adding the step there would make the owner's response to an intrusion slower than the intruder's.

What this protects is narrow but real: someone with a live session and the password, such as a shared computer where the owner stayed signed in and the password was watched. They cannot change the password, rotate the phrase, delete the account or remove the step.

**A phrase reset** (`/auth/recover/finish`: the email link and the phrase) is not a session flow and asks for no step. It changes the password and signs every device out, and the next sign-in asks for the step as usual. The phrase can answer it (section 5).

### Turning the step on and off

- **On:**
    - the first method needs the password;
    - confirming it sets `two_step_at` on the session that enrolled;
    - the screen offers to sign out the account's other devices, ticked by default, since their sessions never passed the step.
- **Off,** which is removing the last method, needs the password and the step, so a stolen session cannot remove it. A policy (section 11, question 5) can stop it being turned off.
- **Notices:** every change sends a security notice (section 7).

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

- **How it works.** The step screen offers "Use your recovery phrase". The device derives the recovery signing key from the phrase, as a phrase reset does (`docs/opaque-auth-design.md`), and signs:

    ```
    ["hushos/two-step/phrase",1,userId,sha256(stepToken)]
    ```

    The server checks the signature against the account's stored recovery public key, so the phrase never leaves the device. The statement is built identically in `packages/crypto` and `crates/hushos-core`, held together by shared fixtures as the device statements are.

- **Why the phrase, not a wait:**
    - **It is the stronger secret:** 256 bits that the person was told to keep offline, against a 20-bit code.
    - **Its holder already has the key.** The printed recovery kit holds the phrase and the recovery envelope, and the server serves the envelope to anyone who follows the email link. Whoever holds the phrase therefore opens the account key with the kit or the email, and with the email resets the password too. Making a phrase holder wait would deny them only the ciphertext of files they can already decrypt.
    - **It matches devices-design.** The phrase approves a device at once at both levels (`docs/devices-design.md` 2). A step that refused the phrase would make the step stricter than Keys need a device.
    - **No dead end.** A person with the phrase is never locked out of an account whose keys they hold.
- **The cost, stated plainly:** a person who keeps the phrase beside the password, in the same password manager or the same drawer, has one factor, not two. The recovery kit screen already says to keep the phrase apart. The two-step screen repeats it.
- **The alternative** is a seven-day wait after the phrase, cancellable from any device or the email, as child conversion waits (`docs/devices-design.md` 6). It stops someone who stole the printed kit and the password from getting in at once. It also costs the honest person a week, and the thief already holds the key. Section 11 leaves this to the owner.

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
- **The core:** TOTP is checked only on the server, so `crates/hushos-core` gains no TOTP code. It gains the phrase statement, and the request and response types.
- **Enrolment and management stay on the web** in the first release, as making an account does. The apps link to it ("Turn on two-step sign-in on the web").

### Security keys

- **iOS, on hushos.com:** `ASAuthorizationSecurityKeyPublicKeyCredentialProvider` for USB, NFC and Lightning keys, beside `ASAuthorizationPlatformPublicKeyCredentialProvider` for passkeys. Both require the RP ID in the app's associated domains, and the app already has `webcredentials:$(HUSHOS_LINK_HOST)` (`apps/ios/App/HushOS.entitlements`).
- **Android, on hushos.com:** Credential Manager's `GetPublicKeyCredentialOption` covers passkeys and security keys over USB and NFC. It requires hushos.com's `assetlinks.json` to name the app with the `get_login_creds` relation; the file already exists for app links. The server accepts the app's `android:apk-key-hash:` origin, from an allowlist in configuration, beside `APP_ORIGIN`.
- **Self-hosted servers:** the iOS app's associated domains are fixed when it is built, and Apple's security-key and passkey providers refuse an RP ID the app is not associated with. So the app cannot use a self-hosted server's RP ID. Apple's own advice for a domain the app does not own is `ASWebAuthenticationSession`, so the apps run the security-key step in the system browser:
    1. The app opens `ASWebAuthenticationSession` (iOS) or a Custom Tab (Android) at `<server>/two-step/key#<stepToken>`. The token is in the fragment, which never reaches the server in a request line or a log, as the verification links do.
    2. The page runs the WebAuthn assertion for the server's origin and posts it with the token.
    3. The server marks the token passed.
    4. The page returns to `hushos://two-step-done`, which carries nothing.
    5. The app then calls `login/two-step` with `{ kind: 'passed' }` and its token, and receives the session as usual.

    The page is served by the server, which the apps otherwise do not trust with code. Here that loses nothing: the step is the server's own check, and the page never sees the password or a key. The callback is a custom scheme because an `https` callback must be on one of the app's associated domains.

    Android could use the operator's own `assetlinks.json` instead, naming the HushOS app. Nothing in Google's documentation rules that out, and nothing confirms it. The browser path is one path for both platforms.

    **To check before release C:** Apple documents `ASWebAuthenticationSession` for third-party sign-in pages, and an Apple engineer recommends it for this case. No Apple document says a WebAuthn ceremony inside it works for any domain. A spike on a real iPhone, with a USB-C and an NFC key, settles it. If it fails, self-hosted servers on iOS offer codes and the phrase, and say why.

- **Which Android versions** read USB and NFC keys through Credential Manager is not documented by API level; Yubico reports NFC keys through Play services from Android 9, below the app's minimum of 10 (API 29). Real devices decide it in release C.

### What ships when

| Release | Web and server                                                                                                                               | iPhone and Android                                                                    |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| A       | Server enforcement and `update-required`; TOTP, backup codes, the phrase; settings and notices. Behind `TWO_STEP_ENABLED`, off on hushos.com | TOTP, backup code and phrase entry; `update-required` handled                         |
| B       | `TWO_STEP_ENABLED` on at hushos.com, once release A's apps are live in both stores                                                           | Nothing new                                                                           |
| C       | Security keys: registration and assertion                                                                                                    | Security keys on hushos.com natively, and through the browser for self-hosted servers |

**The order matters.** If the step could be turned on before the store apps can answer it, an Android or iPhone user who turns it on on the web is locked out on the phone until an update arrives. So release B waits for the apps. Review demo accounts (`docs/release/apple.md` 9) keep the step off.

## 7. Notices

Every change to the step is a security notice to the account's email, and to its devices once push exists (`docs/devices-design.md` 5). None of these can be turned off:

| Event                                              | Says                                                                                           |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| The step turned on                                 | "Two-step sign-in is on." The method's kind                                                    |
| The step turned off                                | "Two-step sign-in is off." Sign in and turn it on again if this wasn't you                     |
| A method added                                     | "An authenticator app was added", or "A security key was added"                                |
| A method removed                                   | The same, for removal                                                                          |
| New backup codes made                              | The old codes no longer work                                                                   |
| A backup code used                                 | How many are left                                                                              |
| The phrase used for the step                       | That the phrase was used, and to keep it apart from the password                               |
| A correct password, then a failed step (section 2) | "Someone signed in with your password but did not pass the second step. Change your password." |
| The authenticator app frozen after 100 failures    | How to sign in with another method                                                             |
| A key's counter went backwards                     | The key may have been copied; remove it                                                        |

**What a notice never contains:**

- the name of a key or device. A name is chosen by whoever added it, so an intruder would choose the words in the owner's inbox (`docs/devices-design.md` 12);
- an address or browser.

They name only the **kind** of method and the time.

**The new-device notice** that exists today says "Signed in with: Your password". With the step on it names both: "Your password and a security key", "Your password and an authenticator code", "Your password and a backup code", or "Your password and your recovery phrase".

**Budgets.** Today every device notice shares one budget of ten an hour per account, and notices past it are dropped. A person with the password could fail the step ten times, spend that budget on failure notices, and then a "step turned off" would be dropped. So:

- **failed-step notices** have their own bucket, one an hour;
- **changes to the step** are never dropped. They need the password and the step, so an attacker cannot flood them.

## 8. Self-hosting

| Setting                                 | Meaning                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TWO_STEP_ENABLED`                      | `true` to let accounts turn the step on. Off, the settings screen and routes answer 501, and existing factors are **still enforced** at sign-in. Default `false` in release A, `true` from release B                                                                                                                                                                                |
| `TWO_STEP_KEY` (or `TWO_STEP_KEY_FILE`) | 32 bytes, base64url. Seals TOTP secrets and keys the backup-code hash. Unset: derived from `OPAQUE_SERVER_SETUP` with HKDF-SHA-256 (`info = "hushos/two-step/key/v1"`) when that is in the environment, as the server hash key is (`packages/db/src/hash-key.ts`); otherwise made once and kept in `server_secrets`, with the production warning `OPAQUE_SERVER_SETUP` already gets |
| `TWO_STEP_PREVIOUS_KEY` (or `_FILE`)    | During a key rotation: the old key, by key id. The worker reseals TOTP secrets under the new key. Backup codes cannot be re-keyed (the server never holds them in plain text), so a rotation ends when the person makes new codes, or the old key is kept until then                                                                                                                |
| `WEBAUTHN_ANDROID_ORIGINS`              | The `android:apk-key-hash:` origins accepted beside `APP_ORIGIN`. hushos.com sets the HushOS app's; self-hosted servers leave it empty and use the browser path (section 6)                                                                                                                                                                                                         |

**What an operator must keep secret:**

- `TWO_STEP_KEY`, kept outside the database and its backups. A key kept in `server_secrets` beside the sealed secrets protects nothing, and the guide says so as it does for the OPAQUE setup;
- `OPAQUE_SERVER_SETUP`, as today.

WebAuthn public keys are not secret.

**What an operator must know:**

- **The domain is part of every security key.** The RP ID is the host of `APP_ORIGIN`. Moving an instance to another domain makes every registered key useless there, and people sign in with the app, a code or the phrase and add their keys again.
- **The operator can turn anyone's step off.** Anyone with write access to the database can delete a person's factors, because the step is a server rule. Self-hosting is the answer to "who runs the server", not a reason to trust it more.
- **Rolling back past release A** would drop the step silently, since the older code does not know it. The migration therefore adds a guard in the database (section 10) that makes an older release fail to sign such accounts in rather than skip the step.

## 9. Threats and residuals

| Threat                                      | What happens                                                                                                                                                                                                                                                                                                  | Residual                                                                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Phishing, with TOTP**                     | A page on another domain runs the HushOS client, takes the password and the code, and relays both to the real server within the 90-second window. It gets a session. Because the page itself ran OPAQUE with the typed password, it also has the export key, so it opens the envelope and has the account key | TOTP is phishable. The step makes the phisher work in real time; it does not stop them                                                        |
| **Phishing, with a security key**           | The browser binds every assertion to the page's origin and RP ID. A page on another domain cannot get one for HushOS's RP ID, so the relay fails at the step, and the phished password alone opens nothing at the honest server                                                                               | The password is still phished; the person should change it. A synced passkey in the same manager as the password is one factor (section 3)    |
| **A hostile server serving the web client** | It can read the password and code as they are typed, and skip its own step                                                                                                                                                                                                                                    | None that a second step can address. The step is the server's rule, and a hostile server is not bound by it (`docs/groups-threat-model.md` 5) |
| **A copy of the database**                  | Without `TWO_STEP_KEY`: no TOTP secrets, no backup codes. With the OPAQUE setup, it can guess passwords offline, and a guessed password opens a copied envelope without any step                                                                                                                              | The step protects the live server, not copies. Keys need a device is the answer for copies (`docs/devices-design.md` 3)                       |
| **A stolen session cookie**                 | The session already passed the step                                                                                                                                                                                                                                                                           | Removing the device ends it (`docs/devices-design.md` 1)                                                                                      |
| **A stolen, unlocked device**               | It is the person                                                                                                                                                                                                                                                                                              | Out of scope, as everywhere (`docs/groups-threat-model.md` 5)                                                                                 |
| **A cloned security key**                   | A counter going backwards refuses the assertion, with a notice                                                                                                                                                                                                                                                | Keys that report 0, which includes every synced passkey, give no such signal                                                                  |
| **Locking the owner out**                   | With the password, the account's budget for codes can be kept spent and the authenticator app frozen                                                                                                                                                                                                          | Keys and the phrase still work, backup codes once the window passes, and the owner is told their password is known (section 2)                |
| **SIM swap**                                | Not applicable: there are no SMS codes, now or later                                                                                                                                                                                                                                                          | None                                                                                                                                          |
| **Push fatigue**                            | Not applicable: the step never takes a tap on a prompt. Device approval asks the person to type or scan a code from the new screen, not tap Approve (`docs/devices-design.md` 2), and comes after the step, so a stranger cannot raise prompts                                                                | None                                                                                                                                          |

**SMS and email codes are left out on purpose.** An SMS code adds a phone number to an account that has none, is open to SIM swap and number recycling, and is as phishable as TOTP. An email code is the inbox again (section 5).

### What the server learns

- whether an account has the step, and which kinds of method, with when each was added and last used (rounded);
- each key's credential id, public key, counter, transports and whether it is synced. With `attestation: 'none'` it learns no maker or model;
- each key's name, which is not encrypted;
- each TOTP secret, sealed at rest, and readable by the server while it runs;
- which method passed each sign-in, through the notice it sends.

## 10. Schema, API, migrations and tests

### Tables

| Table                   | Holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `two_step_factors`      | `id`, `user_id`, `kind` (`totp`, `webauthn`), `name`, `created_at`, `confirmed_at` (null while enrolling; unconfirmed rows are deleted after ten minutes), `last_used_at` (to the hour). TOTP: `totp_key_id`, `totp_nonce` (24), `totp_secret` (sealed, 36 bytes), `totp_last_step`. WebAuthn: `credential_id` (1 to 1023 bytes), `public_key` (COSE), `sign_count`, `transports`, `backup_eligible`, `backup_state`. Checks tie each kind to its columns. Indexes: `unique (user_id, credential_id)`, and one confirmed TOTP per account (a partial unique index) |
| `two_step_backup_codes` | `user_id`, `code_hash` (the Argon2id output of section 2, 32 bytes), `key_id`, `created_at`, `used_at`; primary key `(user_id, code_hash)`. A new set deletes the old one in the same transaction                                                                                                                                                                                                                                                                                                                                                                  |
| `two_step_attempts`     | `token_hash` (primary key), `user_id`, `purpose` (`login`, `password`, `master-key`, `recovery-key`, `delete`, `two-step`, `device-approval`), `session_token_hash` (null exactly when `purpose = 'login'`), `credential_version`, `device_id` and `previous_token_hash` (login only), `webauthn_challenge` (32), `failures`, `passed_at` (the browser path, section 6), `created_at`, `expires_at` (five minutes). The worker deletes expired rows with the others                                                                                                |
| `two_step_state`        | `user_id` (primary key), `webauthn_user_handle` (32, unique), `backup_code_salt` (16), `consecutive_failures`, `totp_frozen_at`                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `sessions`              | gains `two_step_at`: when the session, or the session it replaced at an unlock, passed the step                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

**An account has the step on** exactly when it has a confirmed factor. No separate flag can disagree with the factors.

### Routes

Base64url without padding; ids lowercase UUIDs, as elsewhere.

| Route                                                   | Body → response                                                                                       | Notes                                                                                    |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `POST /api/auth/login/finish`                           | adds `twoStep: 1` → `{ twoStep: { token, methods, expiresAt, webauthn? } }` or today's response       | 409 `update-required` for a client without `twoStep: 1` on an account with the step on   |
| `POST /api/auth/login/two-step`                         | `{ token, proof }` → `{ user, envelope, device }` and the cookie                                      | 401 for a wrong answer; the token ends after five                                        |
| `GET /api/auth/two-step`                                | → `{ on, methods: [{ id, kind, name, createdAt, lastUsedAt, synced }], backupCodesLeft, totpFrozen }` | Any session of the account                                                               |
| `POST /api/auth/two-step/reauth`                        | `{ startLoginRequest }` → `{ attemptToken, loginResponse }`                                           | A bound OPAQUE attempt tagged `two-step`, limited like the others (`limitBoundAttempts`) |
| `POST /api/auth/two-step/challenge`                     | `{ purpose }` → `{ token, methods, webauthn? }`                                                       | A step token bound to the session and the purpose                                        |
| `POST /api/auth/two-step/totp`                          | `{ attemptToken, finishLoginRequest, twoStep? }` → `{ id, secret, uri }`                              | A pending factor for ten minutes; `twoStep` once the step is on                          |
| `POST /api/auth/two-step/totp/:id/confirm`              | `{ code }` → `{ backupCodes? }`                                                                       | Codes only when this turns the step on                                                   |
| `POST /api/auth/two-step/keys/options`                  | `{ attemptToken, finishLoginRequest, twoStep? }` → `{ registrationToken, options }`                   |                                                                                          |
| `POST /api/auth/two-step/keys`                          | `{ registrationToken, name?, response }` → `{ method, backupCodes? }`                                 | 409 `limit` past ten keys                                                                |
| `PUT /api/auth/two-step/methods/:id`                    | `{ name }`                                                                                            | PUT, as the device rename is                                                             |
| `DELETE /api/auth/two-step/methods/:id`                 | `{ attemptToken, finishLoginRequest, twoStep }`                                                       | The last one turns the step off and deletes the codes                                    |
| `POST /api/auth/two-step/backup-codes`                  | `{ attemptToken, finishLoginRequest, twoStep }` → `{ codes }`                                         | Replaces every code                                                                      |
| `POST /api/auth/two-step/key-page`                      | `{ token, response }`                                                                                 | The browser path for the apps (section 6); sets `passed_at`                              |
| `POST /api/auth/security/finish`, `/auth/delete/finish` | add `twoStep?: { token, proof }`                                                                      | 403 `two-step` when the step is on and the proof is missing or wrong                     |

### Migrations

1. **The tables and `sessions.two_step_at`,** in one generated migration, with `lock_timeout` as the devices migration has it (`docs/devices-design.md` 12). The new column is nullable with no default, so adding it does not rewrite `sessions`.
2. **`opaque_login_attempts_purpose_binding`** gains `two-step` (and later `device-approval`).
3. **A guard on `sessions`:** a custom SQL migration (`drizzle-kit generate --custom`; Drizzle does not model triggers). It adds a `BEFORE INSERT` trigger that refuses a session with `two_step_at` null for a user who has a confirmed factor. Older code never sets the column, so a rolling update or a rollback past release A fails to sign those accounts in, rather than handing their envelope to the password alone. It is the repository's first trigger. The reason belongs in the migration's comment and in `docs/self-hosting.md`.
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
    - a frozen authenticator app is refused while a key, a backup code and the phrase still pass.
- **The sealed secret:**
    - a secret sealed for one user or factor does not open as another's (associated data);
    - a row sealed under a previous key opens with `TWO_STEP_PREVIOUS_KEY` and is resealed by the worker.
- **Backup codes:**
    - each works once, including under two concurrent requests;
    - a new set invalidates the old;
    - input normalisation accepts `7kq2m 9xd4p` and refuses a code from another account;
    - the stored value is neither the code nor its plain SHA-256, and does not verify under another account's salt or another two-step key.
- **WebAuthn:**
    - each of these is refused: a wrong origin, a wrong RP ID hash, a wrong or reused challenge, missing user presence, another account's credential, a removed key, a counter that went backwards from a non-zero value;
    - a counter of 0 is accepted;
    - registration refuses a credential already on the account.
- **The phrase:**
    - a phrase signature over another token, or by another account's recovery key, is refused;
    - after a recovery-key rotation the old phrase no longer passes;
    - the statement's bytes match across `packages/crypto` and `crates/hushos-core` (shared fixtures).
- **Changes:**
    - removing a method or making codes without the step is refused;
    - removing the last method turns the step off and deletes the codes;
    - a password change, a rotation or a deletion without the step is refused when it is on.
- **Limits:**
    - the eleventh wrong answer in 15 minutes for an account is refused across tokens and addresses;
    - the fifth consecutive failure sends one notice an hour;
    - the hundredth freezes the authenticator app.
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
6. **`chore(web)`:** turn `TWO_STEP_ENABLED` on at hushos.com once the apps from 4 are live in both stores. The roadmap item moves to Shipped in the same PR.
7. **`feat(auth)` and `feat(web)`:** security keys, registration and assertion, with the virtual-authenticator tests.
8. **`feat(ios)` and `feat(android)`:** security keys natively on hushos.com, and the browser path for self-hosted servers, with `POST /api/auth/two-step/key-page`.

Approve new devices (`docs/devices-design.md` 10, milestone 2) then builds on the step's place in the sign-in: password, step, approval.

## 11. Open questions

1. **Does the recovery phrase pass the step at once, or after a seven-day wait?** _Recommendation: at once, with a security notice._ Its holder can already open the account key and reset the password with the email, so a wait mostly delays the honest person. It also keeps the phrase's place in `docs/devices-design.md`, where it approves at once.
2. **When is the step asked: every new session, new devices only, or every unlock?** _Recommendation: every new session, good for 30 days on a device that keeps its session._ New devices only lets a stolen laptop skip it; every unlock is so frequent on the web that people would turn it off (section 4).
3. **Offer TOTP at all, or security keys only?** _Recommendation: offer both, and recommend keys._ Many people have no key, and TOTP still stops a stolen password, which is the common case. Settings says plainly that only a key stops phishing.
4. **Can a group turn a member's step off?** That is, a family organiser or guardian for a child, or a company admin. 1Password lets business admins turn 2FA off across the whole organisation. _Recommendation: no, for everyone._ A group's power over a member's sign-in would be a way around the member's own choice, and companies get SSO and policies instead. Revisit with the company release if admins need it to run support.
5. **Can a group require the step by policy?** _Recommendation: yes, as `docs/devices-design.md` 4 does for approval levels._ It is a server rule shown to the member ("Required by Acme"). Companies get it with their release; families only for child accounts, decided by a guardian.
6. **Does turning the step on sign the other devices out?** _Recommendation: offer it, ticked by default._ Their sessions never passed the step, and a person turning it on may be reacting to an intrusion.
7. **Where does the two-step key come from when the operator sets none?** _Recommendation: derived from `OPAQUE_SERVER_SETUP` when that is in the environment, else kept in `server_secrets` with a warning._ This matches how the server hash key and the OPAQUE setup behave today. The cost is that most small self-hosted instances keep it beside the database, where it protects nothing.
8. **A key whose counter goes backwards: refuse it, or accept it with a notice?** _Recommendation: refuse, and notify._ The person has other methods, and a cloned key is worth a sign-in's friction.
9. **Is the database trigger acceptable as the repository's first?** _Recommendation: yes._ Without it, a rollback or a rolling update silently turns off a security feature people chose, and nothing in application code can prevent that.

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
