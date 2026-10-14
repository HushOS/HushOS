# Post-quantum identity signatures

This document makes the signatures that anchor trust post-quantum. Every account gains an ML-DSA-65 signing key beside its Ed25519 key, and every statement that decides whose keys to trust or seals a key to someone carries both signatures: the binding of an identity's keys, identity successions, shares, and the group seals, rosters and successions in `docs/groups-design.md`. File and folder signatures stay Ed25519 for now, with their upgrade planned (section 7). Each layout below is the exact bytes the web (`packages/crypto`), the server (`packages/db`) and the Rust core (`crates/hushos-core`) produce and accept, pinned by shared fixtures.

Production holds mostly test accounts (owner, 2026-10-15), so this ships as one release with no transition period: accounts upgrade on their next unlock, the old forms of these statements stop counting the same day, and contacts compare words again. Round 3 retired share suites 1 and 2 and settings version 1 the same way. The decisions in section 10 were settled with the owner on 2026-10-15.

## Why, and what it fixes

Confidentiality is already post-quantum: contents, names and keys are sealed with 256-bit symmetric keys, and shares, group seals and reports with X25519 and ML-KEM-768. Authenticity is not. One Ed25519 key, which is public, decides whose keys a person's contacts trust. Someone who could break Ed25519 could, without touching a device:

- **forge an identity succession**, moving a contact's pin to their own keys, so new shares are sealed to them;
- **forge the KEM binding.** The ML-KEM key is vouched for only by an Ed25519 signature, and the words cover only X25519 and Ed25519; swapping it while breaking X25519 defeats hybrid sealing for new shares;
- **seal a share** that opens as if it came from someone else, since a share's only authenticity is the granter's signature;
- **plant or alter files** that pass as someone's work. This last one is deferred (section 7).

Forgery needs the break to exist when the attack is made, but trust anchored today must still hold afterwards. The first three are where a forgery moves keys or plants access, and where moving later would mean everyone comparing words again with real users; they go hybrid now.

## 1. The identity, version 2

### Keys

A version 2 identity is a version 1 identity plus an ML-DSA-65 key (FIPS 204, the pure form, not HashML-DSA):

- `@noble/post-quantum` `ml_dsa65` on the web and the server, which already supplies ML-KEM on the web;
- the RustCrypto `ml-dsa` crate in the core, the one the group key uses.

The private side is the 32-byte FIPS 204 key generation seed ξ, wrapped under the account root exactly as the Ed25519 seed is, with its own label in the associated data. On open, the client re-derives the public key from the seed and refuses a mismatch, as it does for the ML-KEM seed.

```
IdentityEnvelope v2 = v1 fields, kem required, plus
    mlDsa: { publicKey (1952 bytes), seedNonce (24), encryptedSeed (48) }
    keysSignature (3373 bytes, see "The keys statement")
```

### A hybrid identity signature

```
sig = Ed25519(signingKey, message) (64) || ML-DSA-65.Sign(mlDsaKey, message, ctx = "hushos/identity/v1") (3309)   // 3373 bytes
```

It is valid only if both halves verify: Ed25519 with strict checks as today, and ML-DSA-65 with the same context string. The context keeps a person's signatures apart from the group key's (`hushos/group/v1`), so neither key's signature can stand in for the other's.

Signing is hedged, the FIPS 204 default with fresh randomness. Fixtures pin the bytes of statements and check verification against fixed signatures; they never assume a signature can be reproduced.

### The keys statement

One statement binds all four public keys. It replaces the KEM binding, which version 2 identities do not carry.

```
["hushos/identity/keys",1,userId,keyVersion,x25519,ed25519,mlDsaPublicKey,sha256(kemPublicKey)]
```

The identity signs it with its own hybrid signature, which proves it holds both private keys. The server checks it on every upload of an identity, and clients check it whenever they read one.

### Fingerprint version 3

```
SHA-256("hushos/identity/fingerprint/v3" || x25519 (32) || ed25519 (32) || mlDsaPublicKey (1952) || mlKemPublicKey (1184))
```

The twelve words are made as today (`fingerprintWords`: the first 132 bits of the digest). Version 3 covers the ML-KEM key directly, so comparing words pins all four keys. A second preimage against 132 bits costs about 2^66 for a quantum adversary using Grover's algorithm, a serial run no one expects to be practical.

**Why the words have to change.** A key that only Ed25519 vouches for (the way ML-KEM was added, `POST /api/auth/identity/kem`) falls together with Ed25519. Post-quantum authenticity has to rest on something a quantum adversary cannot forge, and that is the words.

## 2. The upgrade

On the first unlock after the release, a client whose account has a version 1 identity:

1. makes an ML-DSA seed and wraps it under the account root;
2. signs the keys statement with the new hybrid signature;
3. calls `POST /api/auth/identity/upgrade` with the version 2 envelope.

The X25519, Ed25519 and ML-KEM keys and the `keyVersion` stay as they are; the identity is replaced in place, with no history row and no succession link. The server checks that the three existing keys are unchanged and the keys statement verifies. Several devices upgrading at once: the server takes the first and answers the others 409 `stale` with the new identity, which they open and adopt.

Keeping the existing keys means shares sealed to the person keep opening and file signatures keep verifying under the same Ed25519 key; nothing has to be re-sealed to them or re-signed.

### Contacts compare words again

A pin made before the release holds X25519 and Ed25519 and a version 2 fingerprint. It is **not** carried forward by any signature, because only Ed25519 could sign that carry-over, and that is exactly the key this change stops trusting alone.

- When the served identity is version 2 and its X25519 and Ed25519 keys equal the pin's, the contact shows as **Check words again** ("Maya's keys were upgraded. Compare words to keep trusting them"). Until then the pin trusts nothing: the contact reads as someone not yet checked, for records, shares and verdicts alike.
- When the keys differ, it is the changed-key warning, as today.
- Comparing words writes a version 3 pin: all four public keys and the version 3 fingerprint.
- A version 3 pin refuses any identity for that contact without an ML-DSA key: that is a downgrade, shown as the changed-key warning.

### Succession version 2

Every succession from here on is hybrid:

```
["hushos/identity/succession",2,userId,oldKeyVersion,newKeyVersion,
 oldX25519,oldEd25519,oldMlDsa,newX25519,newEd25519,newMlDsa,sha256(newKemPublicKey)]
```

It is signed with the old identity's hybrid signature (3373 bytes); the new identity's keys statement, uploaded with it, proves the new keys are held. `verifySuccessionChain` keeps its continuity rules (by keys, versions only rising, the last link's keys equal to the served ones) and follows only version 2 links. A version 1 link no longer carries a pin anywhere: an account that replaced its keys before this release is a words check, like everyone else.

## 3. What is signed, and how

A signature's statement version says whether it is hybrid. That makes the ML-DSA half impossible to strip: an Ed25519 signature alone never verifies over a hybrid statement.

| Statement                                                        | Before               | Now                              |
| ---------------------------------------------------------------- | -------------------- | -------------------------------- |
| KEM binding → `hushos/identity/keys`                             | KEM binding, Ed25519 | keys statement version 1, hybrid |
| `hushos/identity/succession`                                     | version 1, Ed25519   | version 2, hybrid                |
| `hushos/drive/sig/share`                                         | suite 3, Ed25519     | suite 4, hybrid (below)          |
| Group key seal, roster, succession, area grant, guardian seal    | not yet built        | hybrid from their version 1      |
| `hushos/drive/sig/metadata`, `/version`, `…-resealed`, `…-saved` | version 1, Ed25519   | unchanged (section 7)            |

### Share suite 4

Suite 3 with the hybrid signature. The suite number appears in the key derivation, the associated data and the statement, so a suite 4 envelope cut down to suite 3's length opens as nothing:

```
key      = HKDF-SHA256(salt, ikm = dh || kemSs, info = "hushos/drive/share-key/v4", 32)
body     = XChaCha20-Poly1305(nodeKey, key, nonce, ad = shareContext(ctx, 4))
signed   = ["hushos/drive/sig/share", 4, workspaceId, nodeId, keyEpoch, granteeUserId, granterUserId, sha256(eph.public || kemCt || nonce || body)]
envelope = eph.public (32) || kemCt (1088) || nonce (24) || body (48) || sig (3373)   // 4565 bytes
```

Everything else is as in suite 3: the grantee checks the signature against the granter's pinned keys before it decapsulates, and the server tells suites apart by length. Suite 3 is no longer written or opened; the upgrade pass re-seals each account's ledger in suite 4 (`upgradeShares({ all: true })`), so a share opens again once its granter has signed in. The group seals in `docs/groups-design.md` (key seal, area grant, guardian seal) use this construction under their own `info` and associated data.

### Verdicts

Unchanged. File and folder signatures are checked as today. A contact whose pin awaits a words check is an unchecked signer, so their records read `unknown-signer` until the words are compared.

## 4. Sizes and cost

| What                                          | Before   | Now      |
| --------------------------------------------- | -------- | -------- |
| A share envelope                              | 1256 B   | 4565 B   |
| An identity (public keys, signature included) | ~1.3 KB  | ~6.6 KB  |
| A succession signature                        | 64 B     | 3373 B   |
| A file or folder                              | as today | as today |

Measured with `@noble/post-quantum` 0.7.1 under Bun on an Apple-silicon Mac, ML-DSA-65 takes about 16 ms to sign and 2.2 ms to verify. Signing happens once per share and per seal; verifying, once per share opened and per roster or succession checked. Neither is on the per-file path.

## 5. Server and storage

- **`account_identities` and `account_identity_history`** gain `ml_dsa_public_key` (1952 bytes), `ml_dsa_seed_nonce` (24), `encrypted_ml_dsa_seed` (48) and `keys_signature` (3373), null together only on version 1 identities in the history. The history's `succession_signature` is 64 bytes on old rows and 3373 on new ones.
- **Shares.** `drive_shares` accepts only suite 4 (4565 bytes) on create and re-seal and stores `suite = 4`; suite 3 rows are no longer served to grantees, as suites 1 and 2 were not after Round 3.
- **Verification.** `packages/db/src/signatures.ts` verifies hybrid signatures with `@noble/post-quantum`, since Bun's WebCrypto has no ML-DSA.
- **Old forms are refused.** A suite 3 share, a version 1 succession, an identity upload without a valid keys statement, and any signed write from an account whose identity is still version 1 get 409 `unsupported`, "Update HushOS to save changes". Like the existing format gates, this catches bugs and old builds; clients never rely on it.

## 6. API contract

Base64url without padding; ids lowercase UUIDs.

- **`POST /api/auth/identity/upgrade`** takes `{ identity }`, a version 2 envelope whose X25519, Ed25519 and ML-KEM keys and `keyVersion` equal the current identity's and whose keys statement verifies. 409 `stale` with the current identity when it is already version 2.
- **`POST /api/auth/identity/succession`** takes version 2 statements with a 3373-byte signature only.
- **`GET /api/auth/identity`** and contact lookups serve `mlDsaPublicKey`, `keysSignature` and `identityVersion` beside the existing fields.
- **Master-key rotation** (`/auth/security/finish`) rewraps the ML-DSA seed in the identity and in every history row that has one; the server checks each public key is unchanged.
- **Shares** take 4565-byte envelopes only.

## 7. Later: file and folder signatures

File and folder signatures stay Ed25519 (decision 3). They are what stops someone who holds a folder's key (a viewer, a link visitor, a former member) from planting or renaming files unnoticed; once Ed25519 can be broken, such a key holder could forge them. Making them hybrid now would cost about 6.7 KB more per file in Postgres (some 6.7 GB per million files, plus every rename and version), in every listing and in phone CPU, years before the threat exists.

Because every account will already hold an ML-DSA key and every pin will already cover it, the later upgrade needs no words check. It is:

1. **Format:** the drive statements at version 2 with the 3373-byte hybrid signature, so a stripped signature fails; listings carry SHA-256 digests of signatures, and each device fetches and checks a signature once, caching the fact that it verified (keyed by the statement bytes it computes itself and the signature digest), never the verdict.
2. **Re-signing:** each owner's device re-signs its workspaces' classical records under Round 3's rules (verified becomes ordinary, saved stays saved, anything else re-sealed), with the owner as signer, as rotation does.
3. **Cutoff:** a release after which a classical record reads `classical` (Unverified). It must land well before anyone can break Ed25519: after that, a forged "old" record cannot be told from a real one.

## 8. Out of scope

- **The recovery reset signature** (`signRecoveryReset`) uses a classical key derived from the recovery phrase. It authenticates a reset request to the server, which already controls access, and forging it gives no keys: the root stays wrapped under the phrase. It moves to ML-DSA with the next recovery format.
- **OPAQUE, TLS and the device unlock bundle** are authentication or symmetric wrapping, not signatures people rely on.
- **Links and reports** carry no identity signatures.

## 9. Tests that must exist

Each fails on a defect a person or an attacker would notice (see AGENTS.md):

- **Hybrid signatures:**
    - a valid Ed25519 half with a broken ML-DSA half, and the reverse, are refused, for the keys statement, successions and shares;
    - an ML-DSA signature made with the group context does not verify as an identity signature, and the reverse;
    - TS and Rust verify each other's signatures over every fixture statement.
- **Stripping and old forms:**
    - a suite 4 share cut down to 1256 bytes does not open, and a suite 3 share does not open;
    - a version 2 succession with only an Ed25519 signature is refused.
- **Upgrade:**
    - an upgrade whose X25519, Ed25519, ML-KEM key or `keyVersion` differs from the current identity is refused;
    - two devices upgrading at once end with one identity, and the loser adopts it;
    - shares sealed to the person before the upgrade still open, and their earlier file signatures still verify;
    - a master-key rotation after the upgrade keeps the ML-DSA seed openable.
- **Pins:**
    - a version 2 pin of an upgraded contact trusts nothing until words are compared, and that contact's records read `unknown-signer`;
    - a version 3 pin refuses a served identity without an ML-DSA key;
    - a version 1 succession link is not followed.
- **Fingerprint:** version 3 words change when any of the four keys changes, ML-KEM included.
- **Server:** a suite 3 share, a version 1 succession, and any signed write from a version 1 identity are refused.

## 10. Decisions (agreed 2026-10-15)

1. **One release, no transition:** production is mostly test accounts.
2. **ML-DSA-65 everywhere,** matching ML-KEM-768 and the group key.
3. **File and folder signatures stay Ed25519 for now,** with the upgrade in section 7.
4. **The upgrade keeps the existing keys** and replaces the identity in place, so shares keep opening and file signatures keep verifying.
