# Integrity: padded objects, writer signatures, signed shares and key succession

This document fixes four changes to the Drive and account protocols. Together they close what the October 2026 design review left open: the server learned nearly exact file sizes, nothing said who wrote a record, a share rested on long-lived static keys, and identity keys could never be replaced without everyone comparing words again. Each section gives the byte layout every client (web TypeScript, the Rust core behind iOS and Android) must produce and accept, and what the server stores and checks.

Breaking compatibility with data written before is acceptable: the instance has no users yet. Readers keep opening the older suites where noted; writers produce only the new ones.

## 1. Content suite 3: padded objects

### What it hides

Under suite 2 the server could compute a file's exact size: `ciphertextSize - 16 * chunkCount` is the plaintext size plus the thumbnail trailer. Suite 3 pads every object so that number is a Padmé bucket: the server learns the size to within about 12% for small files and under 2% for large ones, and nothing about whether there is a thumbnail. Padding is stored and counted against quota like any other byte.

### Padmé

For a length `L` in bytes:

```
paddedLength(L) = 256                          when L <= 256
          = padme(L)                     otherwise

padme(L):
  E = floor(log2(L))                     // L >= 257, so E >= 8
  S = floor(log2(E)) + 1
  z = E - S                              // low bits to clear
  mask = (1 << z) - 1
  return (L + mask) & ~mask
```

Integer arithmetic only (BigInt in TypeScript, u64 in Rust). `padded` never shrinks a length and is idempotent.

### Layout

Given the plaintext size `P` and the thumbnail length `T` (0 when none), with `trailer = T > 0 ? T + 16 : 0`:

```
total       = paddedLength(P + trailer)
content     = total - trailer            // >= P: the file, then zero bytes
chunkCount  = max(1, ceil(content / CHUNK_SIZE))
object      = chunk_0 || ... || chunk_(chunkCount-1) || trailer?
ciphertextSize = content + 16 * chunkCount + trailer
```

Chunk `i` encrypts bytes `[i * CHUNK_SIZE, min(content, (i + 1) * CHUNK_SIZE))` of the file followed by zeros up to `content`. Associated data is suite 2's with the suite number 3 in place of 2: `["hushos/drive/content", 3, workspaceId, objectId, index, chunkCount, plaintextSize]`, where `plaintextSize` is `P`, the real size. The thumbnail trailer is as in suite 2, its nonce index `chunkCount`. The version envelope is suite 2's 84-byte record (`contentKey || u64be(P) || u32be(T)`) sealed under the version context with suite 3.

A reader decrypts chunks and keeps the first `P` bytes. A full download, a zip and a whole-file preview fetch every chunk, padding included, so the fetches do not tell the store where the file ends; a ranged read (seeking in a video) fetches only what it needs. The last chunk's range runs to the end of the object, trailer included, as in suite 2.

Writers produce suite 3 only. The server accepts suite 3 on new uploads and refuses suite 2 there; it serves suites 2 and 3 to readers, which open both.

## 2. Writer signatures

### What they prove

Every node's metadata and every file version carries the Ed25519 signature of the account that wrote it, made with the identity signing key. A key that opens a folder (a viewer's, a link's, a stale one) no longer suffices to plant a file or rename one unnoticed: a record the reader cannot tie to someone it trusts is shown as Unverified.

### Statements

Each statement is the UTF-8 JSON array below (the same canonical form as associated data: lowercase ids, no spaces), signed with Ed25519 (`crypto_sign_detached`; verification with strict checks, `verify_strict` in Rust). Digests are SHA-256, base64url without padding.

```
metadata: ["hushos/drive/sig/metadata", 1, workspaceId, nodeId, kind, metadataVersion, sha256(metadataEnvelope)]
version:  ["hushos/drive/sig/version", 1, workspaceId, nodeId, versionId, objectId, contentSuite, sha256(contentKeyEnvelope)]
```

`kind` is `"folder"` or `"file"`. The parent is deliberately not signed: a move changes no content and is the tree's business, which the server already orders.

### Who signs, and when

- Every write that sets a metadata envelope signs it: root and folder creation, a new file at upload begin, rename, copy (the copy's new metadata), and rotation (each re-sealed metadata envelope, signed by the account running the rotation).
- Every write that sets a content-key envelope signs the version: upload begin, a copy's re-sealed version, rotation.
- Restoring an earlier version, trash and restore, and moves set neither and are not signed.

### Storage and the server's check

`drive_nodes.metadata_signer` (uuid) and `metadata_signature` (bytea, 64); `file_versions.signer` (uuid) and `signature` (bytea, 64). The signer is the authenticated account making the request, never a field the client chooses. The server verifies each signature against that account's current signing key before storing it and refuses a write whose signature does not verify, so a bug fails loudly; clients verify again on read and never rely on that check.

Node and version views carry `metadataSigner` / `signer` as `{ id, name, email }` (what the server knows of the account, for display only) and the signature, base64url, or null for records written before signatures.

### Reading

For each node (and its current version) the client resolves the signer's signing public key from what it trusts: its own (proven against its own seed), or a pinned contact whose pin is verified (see pins in `drive-design.md`). The worker checks the signature and returns one of:

- `verified`: the signer is the person or a verified contact, and the signature holds;
- `unknown-signer`: the signature cannot be checked against anyone this person has verified;
- `bad-signature`: the signer is verified but the signature does not hold;
- `unsigned`: no signature (written before signatures).

Anything but `verified` shows an **Unverified** mark on the row, in the viewer header and in Info. Hover or click explains which case it is and who the server says wrote it ("Added by Maya Lindqvist, whom you haven't checked yet", "The signature doesn't match Maya's keys", "Made before HushOS signed changes"), with the way out where there is one ("Check their words" for an unknown signer). Unverified items still open: this is a warning, not a lock.

Workspace documents (tags) are not signed in this version.

## 3. Share suite 3: an ephemeral key and the granter's signature

Suites 1 and 2 derive the share key from a static Diffie-Hellman between the granter's and grantee's identity keys, so a stolen granter key opens every share they ever made, and either side's key can impersonate the other to that pair. Suite 3 uses a fresh X25519 key per share and the granter's signature for authenticity.

```
eph            = random X25519 key pair
(kemCt, kemSs) = ML-KEM-768.Encaps(granteeKemPublicKey)
dh             = X25519(eph.private, granteeX25519Public)
salt           = SHA-256(kemCt || eph.public || granteeX25519Public)
key            = HKDF-SHA256(salt, ikm = dh || kemSs, info = "hushos/drive/share-key/v3", 32)
nonce          = random 24 bytes
body           = XChaCha20-Poly1305(nodeKey, key, nonce, ad = shareContext(ctx, 3))
signed         = ["hushos/drive/sig/share", 3, workspaceId, nodeId, keyEpoch, granteeUserId, granterUserId, sha256(eph.public || kemCt || nonce || body)]
sig            = Ed25519(granterSigningKey, utf8(signed))
envelope       = eph.public (32) || kemCt (1088) || nonce (24) || body (48) || sig (64)   // 1256 bytes
```

The grantee checks the signature against the granter's pinned signing key before decapsulating; a share whose signature does not verify does not open. Suite 3 is the only suite written; suites 1 and 2 still open. The server tells suites apart by length and stores `suite = 3`.

Reports keep their own suite (an ephemeral X25519 key and ML-KEM, sealed to operators without a reporter key).

## 4. Identity succession

### Replacing sharing keys

An account can replace its identity (X25519, Ed25519, ML-KEM) without the people it shares with comparing words again from scratch. The new identity is minted at `keyVersion + 1` and vouched for by the old signing key:

```
succession = ["hushos/identity/succession", 1, userId, oldKeyVersion, newKeyVersion,
              oldX25519, oldEd25519, newX25519, newEd25519, sha256(newKemPublicKey)]
signature  = Ed25519(oldSigningKey, utf8(succession))
```

The server stores the new identity as current and keeps every earlier identity envelope (still sealed under the account root) in `account_identity_history`, with its succession record. The account's devices keep the earlier private keys openable, because shares sealed to them still open only with them, and re-seal what they own:

- **What they shared:** every share in the sharing ledger is sealed again in suite 3 with the new signing key.
- **What was shared with them:** stays sealed to the old keys until the granter's client next re-seals it (it notices the grantee's new keys on its next upgrade pass and seals to them, in suite 3).

### What contacts see

When the keys served for a pinned contact differ from the pin, the client asks the server for that account's succession chain from the pinned key version to the current one and checks every link: each statement signed by the previous signing key, the first by the pinned one, the last naming the served keys. A chain that holds updates the pin to the new keys and fingerprint and is shown as a notice ("Maya replaced her sharing keys; the change is signed by her previous keys"), with the option to compare words again. A chain that does not hold, or no chain, is the changed-key warning as today. A succession can be undone by nobody but the holder of the previous signing key; one made with a stolen key is still a change the person did not make, which is why the notice suggests comparing words.

### The settings key, apart from the identity

Settings (pins and the sharing ledger) were sealed under a key derived from the identity's X25519 private key, so replacing the identity would strand them and a stolen identity key opened them. Settings envelope version 2 seals under a random 32-byte settings key wrapped under the account root (`HKDF(root, "hushos/settings-key-wrap/v1")`, XChaCha20-Poly1305 with the user id as associated data) and kept on the server beside the settings. A version 1 envelope is opened once with the old derivation and saved again as version 2.

## Rollout

All four change formats on every client. They ship together in one deploy with the server: new writes use suite 3 contents, signatures, suite 3 shares and settings version 2; readers open the older suites as listed. Data written before stays readable but unsigned, so it shows as Unverified until written again.

## API contract

What the server stores and serves, and what clients send. Base64url without padding everywhere; ids lowercase UUIDs.

### Content suite 3

- `POST /api/drive/uploads` accepts `contentSuite: 3` and refuses 2 and 1 for new uploads (409, "Update HushOS to upload"). `ciphertextSize` and `chunkCount` are checked as today (`validObjectSize`); quota counts `ciphertextSize`, padding included.
- Readers get `contentSuite` on every version as today and open 1, 2 and 3.

### Signatures

- `NodeView` gains `metadataSigner: { id, name, email } | null` and `metadataSignature: string | null` (64 bytes). `VersionView` gains `signer: { id, name, email } | null` and `signature: string | null`.
- Every request body that carries a metadata envelope also carries `metadataSignature`: create root, create folders (each folder), upload begin (a new node), rename, copy (each new node), and rotation (each rotated node's `metadataSignature`, beside its re-sealed metadata).
- Every request body that carries a content-key envelope also carries `versionSignature`: upload begin, copy file, and rotation (each re-sealed version's `signature`).
- The server sets the signer to the authenticated account, verifies the signature (Ed25519, strict) over the statement in section 2 against that account's current signing key, and answers 400 ("This change was not signed by your keys") when it does not verify. It stores `metadata_signer`/`metadata_signature` on the node and `signer`/`signature` on the version.
- Rotation work rows carry each node's and version's current signer and signature so a client can tell what it is re-signing.

### Shares

- `shareEnvelope` may be 1256 bytes (suite 3); the server stores `suite = 3`. New shares and re-seals must be suite 3 (409 for anything else, "Update HushOS to share"); suites 1 and 2 already stored are served as they are.
- `SharedWithMeView.granter` gains `signingPublicKey` and `keyVersion` (the granter's current identity), so the grantee can find the pin and, after a succession, the chain.

### Identity succession

- `POST /api/auth/identity/succession` with `{ identity: IdentityEnvelope (keyVersion = current + 1, kem required), signature }`. The server checks the statement in section 4 against the account's current signing key and the new identity's KEM binding, moves the current identity row to `account_identity_history` (all of its columns, plus the succession signature that replaced it), and stores the new one. 409 when `keyVersion` is not current + 1.
- `GET /api/auth/identity/history` returns the account's own earlier identity envelopes, oldest first, so its devices can open shares sealed to earlier keys.
- `GET /api/auth/contacts/:userId/succession?from=<keyVersion>` returns `{ links: [{ oldKeyVersion, newKeyVersion, oldEncryptionPublicKey, oldSigningPublicKey, newEncryptionPublicKey, newSigningPublicKey, newKemPublicKey, signature }] }` from `from` to current, for any signed-in account (rate-limited like lookup).
- Contact lookup and every served identity (`ServedIdentity`) gain `keyVersion`.

### Settings key

- `GET /api/auth/settings` returns `{ settings, settingsKey }`, where `settingsKey` is `{ nonce, ciphertext }` (the 32-byte settings key sealed under the account-root wrap key, 72 bytes with tag) or null.
- `PUT /api/auth/settings-key` stores it once (409 if one exists); `PUT /api/auth/settings` accepts envelope `version: 2` (sealed under the settings key) and, until every client has moved, `version: 1`.
- A master-key rotation re-wraps the settings key under the new root alongside the other account envelopes (it is in the rotation request).
