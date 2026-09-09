# Authentication, account keys, and recovery

Status: implemented account foundation. Email enrollment, OPAQUE login, remembered browser unlock, recovery-key password reset, authenticated password changes, master/recovery-key rotation, stable account identity keys, the personal workspace key and its grant, initial quota provisioning, and permanent account deletion are implemented. Drive encryption, file transfers, sharing, chat, billing checkout, and cryptographic suite migrations remain future work.

## Key hierarchy

The **account key** is the user's independent, random 32-byte encryption root. It is not derived from the password. OPAQUE provides a client-only export key used to derive a wrapping key; an independent recovery secret provides another way to wrap the same root. Replacing the password preserves the root and permanent account identity.

```mermaid
flowchart TD
    O[OPAQUE client export key] --> P[HKDF password wrapping key]
    P --> A[Random account key]
    R[Random recovery secret / 24 words] --> W[HKDF recovery wrapping key]
    W --> A
    A --> X[Wrapped X25519 private key]
    A --> S[Wrapped Ed25519 signing seed]
    A --> B[Wrapped recovery-secret backup]
    A --> G[Workspace grant: wrapped workspace key]
    G --> K[Independent random workspace key]
    K -. Future Drive .-> F[Folder and file keys]
```

Every workspace key is independent of the owner's account key, including personal workspaces. A member holds a **grant**: the workspace key wrapped under a key derived from that member's account root. Grant a member access to that workspace, never to another person's account root. Workspace keys can outlive their creator's membership because they are random, not derived. Folder and file keys will hang off the workspace key, so rotating an account root rewraps one grant per workspace and nothing beneath it.

The stable X25519 and Ed25519 identities prepare for recipient key exchange and signatures. They do not constitute a sharing protocol. Sharing still needs authenticated recipient-key verification, membership and key epochs. Chat additionally needs device identities, prekeys/session establishment, replay protection, and forward-secret session keys. Never use one static account encryption key directly for all chat messages. Removed recipients cannot be made to forget keys or plaintext already obtained.

## Version and encoding rules

`@hushos/crypto` owns the byte-level protocol. HTTP uses canonical unpadded Base64url; PostgreSQL uses `bytea` for our binary fields. Serenity's registration and handshake messages remain the library's opaque text strings. Unknown suites fail closed.

- OPAQUE profile 1: Serenity's Ristretto implementation, explicit Argon2id with 65,536 KiB memory, three iterations, parallelism four, and server identifier `hushos/opaque/profile/1`.
- Envelope suite 1: HKDF-SHA-256 and libsodium XChaCha20-Poly1305-IETF, combined ciphertext followed by its 16-byte tag.
- Account-key revisions begin at 1 and increment on master-key rotation; each root is 32 random bytes. Credential revisions increment on password change, password recovery, and either key rotation, independently of root revisions.
- Identity suite 1: independently generated `crypto_box_keypair` (X25519) and `crypto_sign_seed_keypair` (Ed25519 from a random 32-byte seed).
- Recovery suite 1: a random 32-byte secret encoded as 24 English BIP39 words. Recovery revisions increment when that secret is replaced.
- Device suite 1: browser Web Crypto AES-256-GCM with a non-exportable device key, 12-byte nonce, and 16-byte tag.

UUIDs in authenticated contexts are lowercase. Contexts use UTF-8 encoding of the exact JSON arrays below, without additional whitespace. Versions are positive JSON integers. The root, recovery secret, nonces, salts, and signing seed come from a cryptographically secure random generator. Libsodium implements asymmetric key-pair generation and AEAD; Web Crypto implements HKDF and the browser device envelope. Argon2id stays inside Serenity's OPAQUE implementation, so the standard `libsodium-wrappers` package suffices.

## Password envelope

```text
accountKey = random(32)
salt = random(32)
nonce = random(24)
wrappingKey = HKDF-SHA-256(
    base64urlDecode(opaqueExportKey), salt,
    UTF8("hushos/account-key/password-wrap/v1"), 32
)
aad = UTF8(JSON.stringify([
    "hushos/account-key/password-wrap", 1,
    lowercase(userId), keyVersion, credentialVersion
]))
encryptedKey = XChaCha20-Poly1305-IETF(accountKey, wrappingKey, nonce, aad)
```

Use the full decoded export key, not its Base64 text or a truncated prefix. The password envelope stores its suite, root version, credential revision, salt (32 bytes), nonce (24 bytes), and ciphertext (48 bytes). Generate new salt and nonce on replacement.

OPAQUE's export key is client-only; its separate session key is shared with the server and must never encrypt the account root or content. Export-key stability applies to repeated logins of the same registration, not fresh registration or a password change. [Serenity interface](https://opaque-auth.com/docs), [HKDF specification](https://datatracker.ietf.org/doc/html/rfc5869#section-3), [XChaCha20-Poly1305](https://doc.libsodium.org/secret-key_cryptography/aead/chacha20-poly1305/xchacha20-poly1305_construction).

## Workspace key and grant

The client generates the personal workspace's UUID and a random 32-byte workspace key at registration, because the grant is bound to the workspace id. The server inserts the workspace under that id and refuses a collision.

```text
workspaceKey = random(32)
salt = random(32)
nonce = random(24)
wrappingKey = HKDF-SHA-256(accountKey, salt, UTF8("hushos/workspace/grant-wrap/v1"), 32)
aad = UTF8(JSON.stringify([
    "hushos/workspace/grant", 1,
    lowercase(userId), lowercase(workspaceId), keyVersion, workspaceKeyVersion
]))
encryptedKey = XChaCha20-Poly1305-IETF(workspaceKey, wrappingKey, nonce, aad)
```

`workspace_keys` holds one row per member per workspace: suite, the member's root revision (`key_version`), the workspace key epoch (`workspace_key_version`, starting at 1), salt, nonce, and 48-byte ciphertext. Password change and password recovery leave grants untouched because the root is unchanged. Master-key rotation opens every grant with the old root and rewraps it under the new root with fresh salt and nonce and the new root revision; the workspace key epoch stays the same, and the server requires every existing grant to be replaced with a matching epoch in the rotation transaction. Changing a workspace key (a future member removal) increments its epoch and rewraps that workspace's root folder key and the remaining members' grants, never the account roots.

## Stable account identity

At signup, create independent X25519 encryption and Ed25519 signing key pairs. Encrypt the X25519 private key (32 bytes) and Ed25519 seed (32 bytes), each producing 48-byte ciphertext. Only public keys and encrypted private material reach the server.

A single fresh identity wrapping salt is 32 bytes; each envelope uses its own random 24-byte nonce. HKDF input is the account root, with distinct `info` strings:

```text
hushos/identity/encryption-private-wrap/v1
hushos/identity/signing-seed-wrap/v1
```

Associated data is:

```text
["hushos/identity", 1, lowercase(userId), keyVersion, purpose, publicKeyBase64url]
```

`purpose` is respectively `encryption-private-wrap` or `signing-seed-wrap`. Public-key binding detects substitution when the client opens the envelope. The encrypted Ed25519 seed reconstructs its full signing key using libsodium. Identity records are unchanged during password recovery; authenticated master-key rotation rewraps their private material while preserving the public keys. [Libsodium signatures](https://doc.libsodium.org/public-key_cryptography/public-key_signatures).

## Recovery envelopes and authorization

Generate an independent 32-byte recovery secret, convert it to a 24-word English BIP39 phrase, and generate a fresh 32-byte recovery salt. Three HKDF derivations use different purposes:

| Purpose                 | HKDF input      | `info`                              |
| ----------------------- | --------------- | ----------------------------------- |
| Wrap account root       | Recovery secret | `hushos/recovery/account-wrap/v1`   |
| Back up recovery secret | Account root    | `hushos/recovery/secret-backup/v1`  |
| Authorize recovery      | Recovery secret | `hushos/recovery/authentication/v1` |

All use HKDF-SHA-256, the recovery salt, and 32-byte output. The authorization output is an Ed25519 signing seed. Only its public key is stored. It is a dedicated recovery identity and is separate from the stable account signing key.

Both encrypted envelopes use distinct random 24-byte nonces and this associated-data shape:

```text
["hushos/recovery", 1, purpose, lowercase(userId), keyVersion, recoveryVersion]
```

Purpose is `account-wrap` or `secret-backup`. Each ciphertext is 48 bytes. A user who has unlocked the root can decrypt the recovery-secret backup locally to redisplay the phrase. The recovery screen temporarily receives that phrase for display, QR encoding, and a local text download. It never puts the phrase in a URL, API request, persistent app store, or analytics event. The downloadable kit intentionally contains the secret phrase and encrypted recovery envelope and must be kept private.

Password recovery:

1. Request `/recover` email verification. Enrollment purpose is `recover`, distinct from signup. The link alone cannot reset credentials.
2. With a verified enrollment cookie, start fresh OPAQUE registration for the account's existing UUID. The server issues a five-minute, single-use random attempt bound to the enrollment, user, and current credential revision.
3. In the crypto worker, decode the 24-word phrase, derive its recovery signing key, verify its public key matches the stored recovery identity, and decrypt the original root.
4. Finish the new OPAQUE registration and rewrap that same root with the new export key and incremented credential revision. Generate a replacement recovery secret, envelope, and verification key.
5. Sign the canonical reset message below with the **old** recovery signing key. Send the new OPAQUE record, encrypted envelopes, and signature. The new password and recovery phrase never leave the client.
6. The server consumes the attempt before proof verification. It checks the signature and all bindings, then locks the user, rechecks the credential revision and verified enrollment, replaces credentials and envelopes atomically, revokes every session/login/recovery attempt, and consumes recovery enrollments.
7. Complete a fresh OPAQUE login using the new password. Save the replacement recovery phrase.

Canonical signed message:

```text
[
  "hushos/recovery/reset", 1, lowercase(userId), attemptToken, currentCredentialVersion,
  registrationRecord,
  [envelopeVersion, keyVersion, newCredentialVersion, wrappingSalt, wrappingNonce, encryptedKey],
  [recoverySuite, keyVersion, newRecoveryVersion, wrappingSalt, wrappingNonce, encryptedKey,
   backupNonce, encryptedRecoveryKey, recoveryPublicKey]
]
```

The server's signature check binds every replacement field; it does not establish that an arbitrary client constructed its ciphertext correctly. An honest client must verify local recovery and preserve the root. Serenity documents reset as new OPAQUE registration replacing the old record; preserving encrypted content requires this additional envelope/proof protocol. [Password reset guide](https://opaque-auth.com/docs/guides/password-reset).

Replacing a recovery phrase revokes its future server recovery authorization. It **cannot** invalidate an old phrase paired with an old encrypted root envelope: that offline kit still opens the root it contains. Password recovery and recovery-key rotation preserve that root. Master-key rotation replaces the root separately and also replaces the recovery phrase. It does not erase an old root or private identity keys already extracted from an old kit; content-key migration remains future work. Email alone cannot restore a lost root; loss of password, remembered access, and recovery kit means losing access to the encryption keys.

## Enrollment and session state

Signup progresses through `/register`, `/register/check-email`, `/register/complete`, and `/setup/recovery-key`, where saving the phrase and choosing Continue to HushOS opens `/app`. The phrase remains viewable at `/app/recovery-key`. Plain `/register` renders the email form during SSR; verified fragment processing happens only on the completion page. TanStack Form and local Zod schemas validate form values. The backend independently validates nonsecret fields and wire payloads. It cannot validate a plaintext password it never receives.

Email addresses must be a single bare mailbox, without display names, comments, or address lists. They are trimmed and lowercased consistently for lookup, rate limiting, and delivery, without provider-specific alias rules. Recovery email delivery and verified recovery attempts have separate rate-limit budgets. Display names use NFC and 1–100 Unicode code points. These are server-readable metadata, not encryption identifiers. The immutable account UUID is the OPAQUE identifier.

Email enrollment lasts 30 minutes. A random 32-byte verification token is stored only as SHA-256 and sent in a URL fragment; it never enters an HTTP path. Verification atomically consumes it and issues a different random hashed enrollment token in an HttpOnly cookie. Registration inserts the user, credential, password/recovery/identity bundles, personal workspace, its workspace grant, and base quota in one transaction, then consumes enrollment. Existing users cannot be reinitialized by signup.

Login attempts last five minutes, use random 32-byte handles stored as hashes, and are consumed even for a bad finish. Unknown emails use OPAQUE decoy records. After OPAQUE verification, the server locks the user, checks the credential revision and matching envelope, and creates a session with a fresh independent 32-byte token. Sessions slide: the idle deadline moves to seven days from the last request (updated at most every five minutes), and no session lives more than thirty days from sign-in; the cookie carries the thirty-day bound and the server enforces both. Only its SHA-256 hash is stored in PostgreSQL. Reauthentication replaces the current browser session. Requests join the session to the current credential revision; revocation takes effect on subsequent requests.

Cookies use HttpOnly, SameSite=Lax, Path=/, no Domain, and Secure plus the `__Host-` prefix under HTTPS. Auth mutations require the exact configured Origin and JSON content type, enforce a streaming 16 KiB body limit before parsing, and are rate-limited per client address (120 per minute, from `TRUSTED_PROXY_HEADER` behind a proxy) with an instance-wide circuit breaker; verification emails are additionally limited to 20 per address and 600 per instance per hour. Responses use private/no-store and no-referrer. Expired rows are removed by the background worker in bounded batches every five minutes and at worker start, never inside a request.

## Remembered browser unlock and portability

The crypto worker owns the plaintext root. Zustand's persisted state contains only a versioned encrypted device bundle and lock revision. A non-exportable AES-GCM device key is stored as a `CryptoKey` in IndexedDB. The root is wrapped inside the worker, never exported to UI state. If localStorage is blocked or a write fails, the client continues in memory and warns that device access could not be saved. Persistence failures cannot prevent sign-out from attempting device-key cleanup and server-session revocation.

Device associated data:

```text
["hushos/device-unlock", 1, lowercase(userId), keyVersion, credentialVersion, deviceKeyId]
```

A reload/new tab reads the encrypted bundle, validates a live server session and matching user/credential revision, loads the device key, then unwraps in its worker. Explicit lock/sign-out clears the encrypted bundle and device keys, terminates the worker, and propagates lock state through storage events and BroadcastChannel. `removeItem` and `clear` storage events count as locks. `pagehide` clears only memory so a later valid session can restore access. Epoch checks prevent a pending restore from reopening a deliberately locked worker. Protected pages also recheck sessions on focus and periodically.

Non-exportability prevents ordinary raw-key export; it does not stop malicious same-origin code from using the key. XSS, a compromised client build, browser profile compromise, and hostile device software remain distinct threats. JavaScript cannot guarantee zeroization of strings or garbage-collector copies.

`createCryptoSession` has no React, fetch, IndexedDB, or Worker dependency. It serializes operations; resetting invalidates queued and active work and rejects its callers immediately. Cancelled work cannot publish a result or restore unlocked state. Operations own temporary root copies and wipe them when they finish. `CryptoTransport` is the coordinator boundary, with a browser Worker implementation. `DeviceKeyStore` contains the browser Web Crypto persistence adapter. Electron can use this secure renderer arrangement with its normal isolation/CSP requirements. React Native needs a JSI/native crypto and secure-storage adapter; Rust/Swift implementations must reproduce the exact suites, OPAQUE profile, Base64url encoding, and associated-data bytes. They should keep private material in their native vault and use OS-protected device wrapping. Those native integrations are not implemented by this web scaffold.

## Quota and permanent deletion

New accounts receive a personal workspace and a configurable base allowance (default 1 GiB). `workspace_storage` uses bigint for base quota, used bytes, and reserved bytes. `storage_entitlements` holds separate positive grants with unique source references and optional expiry/revocation. APIs return byte counts as decimal strings. There is no public quota mutation, checkout, or billing webhook.

Future uploads must reserve ciphertext bytes transactionally before presigning, reconcile actual object sizes, and count retained versions/trash. Quota records alone do not enforce a file-transfer protocol.

Deletion requires a current session plus a fresh OPAQUE password exchange explicitly tagged `delete` and bound to that session hash. Ordinary login attempts cannot authorize deletion. The delete transaction rechecks session/revision and removes the personal workspace, storage records, account, all key bundles, and all sessions. Client cookies and remembered access are cleared. There are no Drive objects yet; object cleanup and billing cancellation must join the deletion workflow when those features exist. Backups and provider email retention remain operator policies.

## Logs and trust limits

Nitro/evlog owns request completion events. Auth code adds only allowlisted action/outcome fields. Runtime redaction excludes arbitrary auth context and raw errors before console output and drains; development uses the same policy as production. No passwords, recovery phrases, raw/private keys, OPAQUE messages, session/verification tokens, request bodies, or cookies belong in logs. Correlation IDs are server-generated. Client crypto code has no logger.

The operator can see email, name, account/workspace IDs, quotas, timestamps, public keys, encrypted bundles, and access patterns. This is not an anonymous-account design. E2EE cannot protect against a malicious server that delivers hostile client code. Associated-data binding detects cross-context substitutions; it does not prevent rollback of an entire consistent server database snapshot. Version fields identify suites and revisions; safe migrations and independent cryptographic review remain separate work.

## Packages and migrations

- `@hushos/crypto`: OPAQUE profile, key derivation/envelopes, identity/recovery, device envelope, portable crypto session.
- `@hushos/auth`: HTTP-independent server services, cookies, auth coordination, worker transport and browser device storage.
- `@hushos/db`: typed schema/relations and transactional repositories; migrations are generated with Drizzle Kit.
- `@hushos/env`: T3 Env/Zod server-only configuration validation.
- `@hushos/emails`: React Email templates and SMTP/Resend/SES adapters.
- `@hushos/logging`: evlog integration and redaction policy.

`OPAQUE_SERVER_SETUP` must persist and be backed up with the database. Never regenerate it at startup. Suite/profile migrations require explicit client support, authentication, local rewrapping, revision checks, and transactional replacement; never relabel old ciphertext or records. Development accounts made before recovery/identity/quota provisioning finish that setup after their next unlock. The worker creates only missing private-key bundles under the existing account key. The authenticated setup transaction rechecks the live session and credential revision, locks the user, and inserts missing records without overwriting established keys. Database migrations never fabricate private keys.

## Authenticated password changes and key rotation

Account settings expose three operations, each authorized by a fresh OPAQUE exchange with the current password. `/api/auth/security/start` binds the one-use attempt to its action (`password`, `master-key`, or `recovery-key`), current session hash, user, credential revision, and five-minute expiry. The client starts a separate OPAQUE registration for the replacement credential. The worker opens the existing root with the old login export key and wraps the resulting root with the new registration export key, using fresh salt and nonce. Neither password nor export key is sent to the server.

- **Password change:** use the new password for registration, preserve the root, recovery envelopes, and identity envelopes, and increment the credential revision.
- **Recovery-key rotation:** register again with the same password, preserve the root and identity envelopes, generate a new recovery secret and authorization key, and increment both recovery and credential revisions.
- **Master-key rotation:** register again with the same password, generate a new random 32-byte root, increment the root and credential revisions, rewrap both existing identity private keys and every workspace grant under the new root, and generate a new recovery secret with an incremented recovery revision. The worker verifies that decrypted identity private keys reconstruct the stored public keys. The server also requires unchanged identity public keys and a replacement for every grant the member holds, with unchanged workspace key epochs.

`keyVersion` is the root revision, beginning at 1; it is not the envelope suite. Recovery and identity associated data now use that revision in the position previously fixed at 1, retaining byte-for-byte compatibility for existing accounts. Password recovery after rotation preserves the current root revision. Remembered-device bundles also bind that revision.

`/api/auth/security/finish` consumes the attempt before OPAQUE verification. The database transaction locks the user and rechecks the live session, credential revision, root revision, recovery revision, and operation-specific replacement fields. It replaces all affected records together, revokes every session and outstanding login/recovery attempt, and invalidates pending email-recovery enrollments. A stale concurrent operation cannot overwrite the winning transaction. The browser clears remembered access across tabs and signs in again to establish a fresh session and device envelope. If automatic sign-in fails after the change commits, the UI takes the user to sign-in. Both rotation actions then lead to `/setup/recovery-key` to save and confirm the new phrase.

Master-key rotation covers the password envelope, recovery envelopes, identity envelopes, and workspace grants. Because folder and file keys will hang off workspace keys rather than the root, future Drive envelopes do not need to join this transaction. Rotation cannot erase previously copied ciphertext or revoke identity private keys already extracted from an older root and bundle.
