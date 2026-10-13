# Integrity: padded objects, writer signatures, signed shares and key succession

This document fixes four changes to the Drive and account protocols. Together they close what the October 2026 design review left open: the server learned nearly exact file sizes, nothing said who wrote a record, a share rested on long-lived static keys, and identity keys could never be replaced without everyone comparing words again. Each section gives the byte layout every client (web TypeScript, the Rust core behind iOS and Android) must produce and accept, and what the server stores and checks.

Breaking compatibility with data written before is acceptable: the instance has no users yet. Readers keep opening the older suites where noted; writers produce only the new ones.

## 1. Content suite 3: padded objects

### What it hides

Under suite 2 the server could compute a file's exact size: `ciphertextSize - 16 * chunkCount` is the plaintext size plus the thumbnail trailer. Suite 3 pads every object so that number is a Padmé bucket: the server learns the size of the file and its trailer together to within the bucket, at most 6.25% above it up to 64 KiB, 3.125% up to 4 GiB and 1.5625% beyond, and from the size alone nothing about whether there is a thumbnail. Padding is stored and counted against quota like any other byte.

One residue: `chunkCount` is the padded content's chunk count, and content is the bucket less the trailer, so for a bucket that lands within a trailer's length past a multiple of 8 MiB, a file with a thumbnail has one chunk fewer than one without. The window is at most 64 KiB in every 8 MiB, and it says only that a thumbnail exists.

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

Integer arithmetic only (BigInt in TypeScript, u64 in Rust). `paddedLength` never shrinks a length, is idempotent and monotonic, and the padding it adds is under `L / 2^S`. Known values: 0 → 256, 257 → 272, 1000 → 1024, 2^20 + 1 → 1081344, 10^10 → 10066329600.

### Layout

Given the plaintext size `P` and the thumbnail length `T` (0 when none), with `trailer = T > 0 ? T + 16 : 0`:

```
total       = paddedLength(P + trailer)
content     = total - trailer            // >= P: the file, then zero bytes
chunkCount  = max(1, ceil(content / CHUNK_SIZE))
object      = chunk_0 || ... || chunk_(chunkCount-1) || trailer?
ciphertextSize = content + 16 * chunkCount + trailer
```

Chunk `i` encrypts bytes `[i * CHUNK_SIZE, min(content, (i + 1) * CHUNK_SIZE))` of the file followed by zeros up to `content`. Associated data is suite 2's with the suite number 3 in place of 2: `["hushos/drive/content", 3, workspaceId, objectId, index, chunkCount, plaintextSize]`, where `plaintextSize` is `P`, the real size, and `chunkCount` the padded count above. The thumbnail trailer is as in suite 2 (same derived key) with 3 in its associated data too, `["hushos/drive/thumbnail", 3, workspaceId, objectId, T]`, and its nonce index the padded `chunkCount`. The version envelope is suite 2's 84-byte record (`contentKey || u64be(P) || u32be(T)`) sealed under the version context with suite 3, `["hushos/drive/content-key", 3, ...]`. A reader can trust nothing about the padding but its length: it is under the content key like the file, and the reader drops it unread.

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
- Restoring an earlier version, trash and restore, and moves set neither and are not signed. Nor is a node a rotation only rewraps (its key already at the target epoch): its metadata envelope and signature stay as they were.

### Storage and the server's check

`drive_nodes.metadata_signer` (uuid) and `metadata_signature` (bytea, 64); `file_versions.signer` (uuid) and `signature` (bytea, 64). The signer is the authenticated account making the request, never a field the client chooses. The server verifies each signature against that account's current signing key before storing it and refuses a write whose signature does not verify, so a bug fails loudly; clients verify again on read and never rely on that check.

Node and version views carry `metadataSigner` / `signer` as `{ id, name, email }` (what the server knows of the account, for display only) and the signature, base64url, or null for records written before signatures.

### Reading

For each node (and its current version) the client resolves the signer's signing public keys from what it trusts: its own (proven against its own seed, and its earlier ones from its own history), or a pinned contact whose pin is verified (see pins in `drive-design.md`), with the earlier keys a verified succession chain vouches for, since a record signed before a succession stays signed by the key that made it. The worker checks the signature against any of them and returns one of:

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

`dh` is the raw X25519 output (libsodium `crypto_scalarmult`, not `crypto_box_beforenm`), refused when it is all zeros; `granteeX25519Public` in the salt is the grantee's identity key the share was sealed to, which the grantee recomputes from its own private key. The statement's ids are lowercase, as in section 2.

The grantee checks the signature against the granter's pinned signing key before decapsulating; a share whose signature does not verify does not open. Suite 3 is the only suite written; suites 1 and 2 still open (with the granter's pinned X25519 key, as before). The server tells suites apart by length and stores `suite = 3`.

A share row does not record which of the grantee's identities it was sealed to. After a succession (section 4) a grantee's device tries its current identity and then its earlier ones; the signature is checked once, before any of them.

Reports keep their own suite (an ephemeral X25519 key and ML-KEM, sealed to operators without a reporter key).

## 4. Identity succession

### Replacing sharing keys

An account can replace its identity (X25519, Ed25519, ML-KEM) without the people it shares with comparing words again from scratch. The new identity is minted at `keyVersion + 1` and vouched for by the old signing key:

```
succession = ["hushos/identity/succession", 1, userId, oldKeyVersion, newKeyVersion,
              oldX25519, oldEd25519, newX25519, newEd25519, sha256(newKemPublicKey)]
signature  = Ed25519(oldSigningKey, utf8(succession))
```

The keys in the statement are base64url as the server serves them; the last element is SHA-256 of the new ML-KEM public key's bytes, base64url. A succession mints `newKeyVersion = oldKeyVersion + 1`; a reader asks only that it is higher, since a rotation may have raised the version between two links (below).

The server stores the new identity as current and keeps every earlier identity envelope (still sealed under the account root) in `account_identity_history`, with its succession record.

### What an identity's key version counts

An identity envelope's `keyVersion` (bound into the associated data of its wrapped private keys) has until now equalled the root revision, because both started at 1 and a master-key rotation set it to the new root's revision. That cannot survive succession: a rotation would renumber an identity without a link, so a contact's pinned version would name nothing in the chain, and the earlier identities in the history would all be renumbered to the same value. From this change on it numbers the identity's generations only:

- a new account's identity is minted at 1 (an older account's keeps the version it has); a succession adds one;
- a master-key rotation rewraps the current identity **and every identity in the history** under the new root, each keeping its own `keyVersion`, salt and nonces fresh; the rotation request carries the rewrapped history beside the identity, and the server requires a replacement for every history row, with the same key version and public keys; the current identity's `keyVersion` is kept (the server also accepts it raised to the new root revision when that is higher, never lowered), so versions along a chain can skip;
- the root revision stays in the password, recovery and grant envelopes, as before. The account's devices keep the earlier private keys openable, because shares sealed to them still open only with them, and re-seal what they own:

- **What they shared:** every share in the sharing ledger is sealed again in suite 3 with the new signing key.
- **What was shared with them:** stays sealed to the old keys until the granter's client next re-seals it (it notices the grantee's new keys on its next upgrade pass and seals to them, in suite 3).

### What contacts see

A pin records the contact's `keyVersion` when it is made. When the keys served for a pinned contact differ from the pin, the client asks the server for that account's succession chain from the pinned key version to the current one and checks every link: continuity is by keys, not by consecutive version numbers: the chain starts at the link whose old keys are the pinned ones (signed by the pinned signing key), each link's old keys are the previous link's new keys and its statement is signed by the signing key it replaces, versions only rise, and the last link's new X25519, Ed25519 and ML-KEM keys are the served ones (the served version at or above its new version). A pin made before successions has no key version; the client asks from 1. A chain that holds updates the pin to the new keys and fingerprint and is shown as a notice ("Maya replaced her sharing keys; the change is signed by her previous keys"), with the option to compare words again. A chain that does not hold, or no chain, is the changed-key warning as today. A succession can be undone by nobody but the holder of the previous signing key; one made with a stolen key is still a change the person did not make, which is why the notice suggests comparing words.

### The settings key, apart from the identity

Settings (pins and the sharing ledger) were sealed under a key derived from the identity's X25519 private key, so replacing the identity would strand them and a stolen identity key opened them. Settings envelope version 2 seals under a random 32-byte settings key wrapped under the account root (`HKDF-SHA256(ikm = root, salt = 32 zero bytes, info = "hushos/settings-key-wrap/v1")`, XChaCha20-Poly1305 with a random 24-byte nonce and the UTF-8 of the lowercase user id as associated data; the server keeps the nonce and the 48-byte ciphertext) beside the settings. The envelope itself is version 1's with 2 in its context, `["hushos/settings", 2, userId, settingsVersion]`, padded the same way to 1 KiB steps. A version 1 envelope is opened once with the old derivation and saved again as version 2.

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
- Master-key rotation (`/api/auth/security/finish`, action `master-key`) carries `identityHistory`: every history envelope rewrapped under the new root, in the same order, each with its own `keyVersion` and public keys unchanged, and `settingsKey` re-wrapped when the account has one; the server refuses a rotation that omits either. The current identity keeps its `keyVersion` (or takes the new root revision when higher), no longer necessarily equal to it (see "What an identity's key version counts").
- `GET /api/auth/contacts/:userId/succession?from=<keyVersion>` returns `{ links: [{ oldKeyVersion, newKeyVersion, oldEncryptionPublicKey, oldSigningPublicKey, newEncryptionPublicKey, newSigningPublicKey, newKemPublicKey, signature }] }` from `from` to current, for any signed-in account (rate-limited like lookup).
- Contact lookup and every served identity (`ServedIdentity`) gain `keyVersion`.

### Settings key

- `GET /api/auth/settings` returns `{ settings, settingsKey }`, where `settingsKey` is `{ nonce, ciphertext }` (a 24-byte nonce and the 32-byte settings key sealed under the account-root wrap key, 48 bytes with its tag) or null.
- `PUT /api/auth/settings-key` stores it once (409 if one exists); `PUT /api/auth/settings` accepts envelope `version: 2` (sealed under the settings key) and, until every client has moved, `version: 1`.
- A master-key rotation re-wraps the settings key under the new root alongside the other account envelopes (it is in the rotation request).

## Round 3: closing what a malicious server could still do

The third leak audit (2026-10-13) found that the integrity layer above held against a passive server but not an active one. These changes ship together, on every client, with the server.

### Checking fails closed

A client that cannot load what it trusts (its own identity history, the settings with the pins, or because the settings are refused as rolled back) or whose check throws, shows every record as **Couldn't check** rather than as clean. It is a fifth result, `unchecked`, drawn like Unverified, with its own explanation ("HushOS couldn't check who wrote this. Try again later.") and a retry. No record is ever shown without a mark because a request failed.

`unsigned` no longer gets a softer explanation: a stripped signature and a record written before signatures read the same ("HushOS can't confirm who wrote this"), so a server cannot pick the milder warning by stripping one.

### Re-sealing never launders

Rotation and copy re-seal records under a new key and must sign the new envelope. Before signing, the client checks the record as it was (the same check as reading). A `verified` record is re-signed with the ordinary statement. Anything else (including a copy saved from a link, whose signatures a visitor never sees) is signed with a **re-sealed** statement:

```
metadata: ["hushos/drive/sig/metadata-resealed", 1, workspaceId, nodeId, kind, metadataVersion, sha256(metadataEnvelope)]
version:  ["hushos/drive/sig/version-resealed", 1, workspaceId, nodeId, versionId, objectId, contentSuite, sha256(contentKeyEnvelope)]
```

It says "I re-locked this; I don't vouch for who wrote it". Readers verify against the ordinary statement first, then the re-sealed one; a valid re-sealed signature yields `resealed`, shown as Unverified ("Re-locked by you; HushOS couldn't confirm who wrote it before"). A rotation needs the trust set loaded: if it can't load, the rotation stops and retries rather than marking everything re-sealed. The server accepts either statement on every signed write.

### Retired keys

A record signed with a signing key its writer has since replaced (one of the earlier keys a succession chain vouches for, or the reader's own earlier key) yields `retired-key`, shown as Unverified ("Signed with keys Maya has since replaced"). Replacing keys is what an account does when its keys may be exposed, so those keys stop vouching for anything. A suite 3 share opens only against the granter's current signing key; one sealed under an earlier key waits for the granter's re-seal ("Ask Maya to share it again" until then).

### Rollback marks

- The settings high-water mark is kept per user (not per identity key), survives a succession, and is never lowered.
- Each device also keeps the highest own identity `keyVersion` it has opened and refuses an identity served as current with a lower one.
- A new device has no marks; that is inherent.

### Legacy readers removed

Share suites 1 and 2 and settings envelope version 1 no longer open anywhere (TS and Rust). Production had no suite 1/2 shares left; the three accounts still on settings version 1 start afresh at version 2 (their pins and ledger are lost and contacts are checked again). Content suites 1 and 2 still open: those objects exist.

### Who sees whom

- Node and version views carry `metadataSigner` / `signer` as `{ id }` only. A client names a signer from its own pins ("you", a checked contact's name) or says "someone you haven't checked".
- Link visitors get no signatures and no signer: a visitor has nothing to check them against, and a signature can be tested against keys from contact lookup to identify the writer. `workspaceId` stays: it is bound into every envelope.
- A grantee's change feed carries only changes inside the share, tombstones included, and an opaque cursor, so it shows neither deletions elsewhere in the owner's drive nor how busy the drive is.
- An upload or copy refused for space tells only workspace members the bytes left.
- Contact lookup and succession reads are limited per address as well as per account.
- Clients follow a pinned contact's served keys only when the person asks ("Check again"), and fetch a succession chain whole, so lookups do not reveal which contacts are pinned or at which version.

### Smaller fixes

- Link API routes take the token in an `x-link-token` header, not the path, so proxy access logs do not keep it. `/s/<token>` stays the page address; docs/self-hosting.md says to keep it out of access logs.
- `/s/*` pages do not fetch the session until the visitor asks to sign in or save a copy. The page request itself still carries the session cookie (a top-level navigation), which the docs say plainly.
- A ranged read that touches a file's last real chunk also fetches the padding chunks after it, so where a file ends is not revealed by reads.
- The web loads every viewer, grammar and thumbnailer chunk after unlock, at idle, so which ones are fetched does not depend on what is opened.
- Releasing a report also clears its reporter, the free-text reason and the snapshot's envelopes, keeping only the object ids the evidence purge needs.
- An id that already exists is refused with the same answer whichever workspace holds it.
- Log redaction covers every `*Signature*`, `*Envelope*` and `settingsKey` field.
- The reports dialog and code say what is true: operator keys come from the server, so whoever runs it can open what is reported.
- Native: iOS refuses third-party keyboards and keeps the recovery phrase out of plain text fields; Android hides file names from lock-screen notifications, protects link and QR screens from capture, labels unverified items in the system file picker, and turns off keyboard learning on the link field; both sweep every plaintext temp directory; the Rust core wipes private keys on drop.

### Sizes, stated plainly

Padmé rounds the padded content up to a bucket that grows with the file: below 256 bytes everything is 256; otherwise at most 6.25% is added (the bucket is at most a sixteenth of the size, and smaller still above 64 KiB), so the server learns a file's size to within roughly 2 KiB around 50 KB, 32 KiB around 1 MB, 2 MiB around 100 MB and 32 MiB around 1 GB. The security page, privacy policy and llms.txt say this instead of "the size of each encrypted object".

### API contract (round 3)

- **Signer views:** `NodeView.metadataSigner` and `VersionView.signer` are `{ id } | null`.
- **Link routes:** `GET /api/drive/links/open`, `/links/children`, `/links/nodes/:nodeId/...`, `/links/versions/:versionId/url` and the rest of today's `/api/drive/links/:token/...` family move the token to `x-link-token` (same paths without the token segment). Responses omit `metadataSigner`, `metadataSignature`, `signer` and `signature` (absent, not null). The old path form answers 410 "Update HushOS to open links".
- **Share feed:** `GET /api/drive/shares/:id/changes?cursor=<opaque>` returns `{ changes, cursor, hasMore }`. Changes carry no `changeSeq`; they are in order. `cursor` is an opaque string (sealed server-side); no cursor means from the start. Tombstones are kept only for nodes that were inside the share when purged (the purge records the purged node's ancestor ids). A cursor the server did not seal for that share (tampered, or another share's) is a 400. Shared-with-me carries each share's starting `feedCursor`, and grantee node views carry no `changeSeq`.
- **Quota refusal:** 402 bodies carry `freeBytes` only for workspace members.
- **Signatures:** every signed write accepts either statement form; the server verifies the ordinary one, then the re-sealed one.
- **Settings:** `GET /api/auth/settings` returns `{ settings, settingsKey, settingsVersion }`: `settingsVersion` is always the stored sequence number (0 when there is no row), and `settings` is null when there is no row or the row is envelope version 1. `PUT /api/auth/settings` accepts `version: 2` only (409 otherwise); `expectedVersion` must equal the stored sequence whether the row is version 1 or 2, and the document is stored at `expectedVersion + 1`, the version the client sealed it at (it is bound into the seal). A conflict reports the stored sequence. A client that reads `settings: null` at sequence N builds fresh settings, seals them at N + 1 and saves with `expectedVersion: N`; that save replaces a version 1 row. The rollback check compares the device's per-account mark with N whether or not a document came with it: a mark above N is a rollback; `settings: null` with N > 0 and a mark at or below N is a version 1 row, read as empty.
- **Shares:** `shareEnvelope` must be 1256 bytes; anything else is refused on create and re-seal (409 `unsupported` for a suite 1 or 2 length, 400 otherwise), and stored suite 1/2 rows are not served to grantees: not in shared-with-me, the feed or authorization, and a previous envelope of an older suite is served as null. Only the granter still lists such a row (with its `suite`), to re-seal or revoke it.
- **Ids:** a client-generated id (node, version, object, link, report) that already exists is 409 `conflict` whichever workspace holds it, and nothing of the refused write is kept.
- **Reports:** after release, `ReportView.reason` and `reporter.userId` are null.
- **Lookups:** `POST /api/auth/contacts/lookup` and `GET /api/auth/contacts/:userId/succession` are limited per account and per address.

## Ids derived from a seed and a scope

Clients choose the ids of what they create (nodes, versions, objects, links, reports) because the id is sealed into the envelope's associated data before the row exists. Ids are unique across the whole database, so until now a create naming an id that existed anywhere was refused, and that refusal told anyone (a former grantee or link visitor holding old ids) whether an item still existed in someone else's workspace.

Now a client never names an id directly. It draws a random 16-byte seed and derives the id:

```
id = uuidv8(SHA-256(["hushos/id", 1, kind, scopeId, seed])[0..16])
```

The statement uses the same canonical JSON as associated data (lowercase ids, the seed as base64url without padding). `kind` is `"node"`, `"version"`, `"object"`, `"link"` or `"report"`; `scopeId` is the workspace the item is created in (for a report, the workspace of the reported item). The first 16 bytes of the digest become the UUID, with the version nibble set to 8 and the variant bits to `10`.

Every create sends each id with its seed. The server recomputes the id from the seed, the kind and the workspace of the request and refuses a mismatch with one answer for every cause ("This id was not made for this workspace", 400). Nobody can find a seed that derives an id that already exists, so asking about someone else's id gets the same refusal as any malformed id, whether or not it exists. A conflict (409) can only come from a client replaying one of its own seeds in its own workspace. Ids stored before this change stay as they are; only new creates are checked.

### API contract (scoped ids)

- Each create body that carries a client-chosen id carries its seed beside it: `idSeed` for a node id (root, folders, upload begin, copy), `versionIdSeed` and `objectIdSeed` (upload begin, copy file), `linkIdSeed` (create link), `reportIdSeed` (create report). Base64url, 16 bytes.
- The server derives and compares before any other check that could depend on whether the id exists; a missing or wrong seed answers 400 `invalid` "This id was not made for this workspace".
- TS (`@hushos/crypto`) and Rust (`hushos-core`, exported to iOS and Android) expose `deriveId(kind, scopeId, seed)` and `newId(kind, scopeId) -> { id, seed }`, pinned by shared fixtures.
