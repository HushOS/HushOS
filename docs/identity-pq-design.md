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

- `@noble/post-quantum` `ml_dsa65` on the web and the server, which already supplies ML-KEM on the web, pinned at exactly 0.7.1;
- the RustCrypto `ml-dsa` crate in the core, the one the group key uses, pinned at an exact version (`ml-dsa = "=0.1.1"`, the current release) when it is added to `crates/hushos-core/Cargo.toml`.

Neither is upgraded without the shared fixtures passing again. The fixtures include the FIPS 204 ACVP vectors for ML-DSA-65: key generation from ξ, signing with a context string, and verification that refuses malformed hints. Both implementations must pass all three.

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
SHA-256("hushos/identity/fingerprint/v3" || x25519 (32) || ed25519 (32) || SHA-256(mlDsaPublicKey) (32) || SHA-256(mlKemPublicKey) (32))
```

The twelve words are made as today (`fingerprintWords`: the first 132 bits of the digest). Version 3 covers the ML-KEM key directly, so comparing words pins all four keys. The two lattice keys enter by their SHA-256 digests, which is what a pin keeps of them, so a pin can check its own fingerprint without holding 3 KB of keys; SHA-256's collision resistance makes that as binding as the keys themselves. Vector: the fingerprint of 32×0x01, 32×0x02 and digests 32×0x03, 32×0x04 is `8b16 2a14 2a5b cb5b 1070 8017 ae93 b2e6 b496 7640`. A second preimage against 132 bits costs about 2^66 for a quantum adversary using Grover's algorithm, a serial run no one expects to be practical.

**Why the words have to change.** A key that only Ed25519 vouches for (the way ML-KEM was added, `POST /api/auth/identity/kem`) falls together with Ed25519. Post-quantum authenticity has to rest on something a quantum adversary cannot forge, and that is the words.

## 2. The upgrade

On the first unlock after the release, a client whose account has a version 1 identity:

1. makes an ML-DSA seed and wraps it under the account root;
2. opens the wrapped seed again, re-derives the public key and refuses to go on if it differs, so a seed that does not open is never uploaded;
3. signs the keys statement with the new hybrid signature;
4. calls `POST /api/auth/identity/upgrade` with the version 2 envelope.

The X25519, Ed25519 and ML-KEM keys and the `keyVersion` stay as they are; the identity is replaced in place, with no history row and no succession link. The server checks that the three existing keys are unchanged and the keys statement verifies. Several devices upgrading at once: the server takes the first and answers the others 409 `stale` with the new identity, which they open and adopt.

An account whose unusable seed got through anyway can never sign again: version 1 successions are refused, and a version 2 succession needs the old hybrid signature. Start over with new keys recovers it, writing a new identity without a succession on the recovery phrase's authority (`docs/devices-design.md` 3; section 10).

### The device's own marks

Because the upgrade keeps `keyVersion`, a mark of `keyVersion` alone does not see it. Each device marks its own identity as `(keyVersion, identityVersion)` and refuses a version 1 identity for its account once it has seen version 2. Otherwise a server could serve a new device the version 1 form, and that device would make a second ML-DSA key and try to upload it.

A device computes its own words only from public keys it re-derived from all four seeds, never from the served ones.

Keeping the existing keys means file signatures keep verifying under the same Ed25519 key and nothing has to be re-signed or sealed to new keys. Shares to the person still have to be re-sealed in suite 4, which waits on a words check (section 3).

### Contacts compare words again

A pin made before the release holds X25519 and Ed25519 and a version 2 fingerprint. It is **not** carried forward by any signature. A carry-over signed with Ed25519 and verified now would be as trustworthy as Ed25519 is now; it becomes forgeable only later, and a cutoff could handle that, as section 7 argues for file signatures. Pins are not carried forward because production holds mostly test accounts, and a words check is simpler than a carry-over format with its own cutoff.

After the release, **a version 2 pin trusts nothing, whatever the server serves**: a version 2 identity, or the version 1 form with the same X25519 and Ed25519 keys and no ML-DSA key.

- When the served X25519 and Ed25519 keys equal the pin's, People shows the contact with a **Check again** badge and the menu item **Check their words again**; an Unverified mark's "Check again" says "Maya’s keys were upgraded. Compare words with them again in People you share with." Until then the contact reads as someone not yet checked, for records, shares and verdicts alike.
- When the keys differ, it is the changed-key warning, as today.
- `pinVerified` requires the version 3 fingerprint. The KEM binding (`identityVerifyKem`) is no longer a path to trust: a KEM key is trusted only through a version 3 pin or a verified keys statement under one.

**Version 3 pins** hold digests of the two large keys, not the keys. The keys themselves would take 4268 base64url characters per contact, and the settings document, which the sharing ledger and group pins share, is capped at 64 KiB:

```
ContactPin v3 = { userId, email, name, keyVersion, pinnedAt,
                  encryptionPublicKey (X25519), signingPublicKey (Ed25519),
                  mlDsaPublicKeyHash = hex(SHA-256(mlDsaPublicKey)),
                  kemPublicKeyHash   = hex(SHA-256(mlKemPublicKey)),   // hex, as kemPublicKeyHash always was
                  fingerprint        = the version 3 fingerprint }
```

A pin is version 3 exactly when it carries `mlDsaPublicKeyHash`; `kemPublicKeyHash` is the existing field, now required.

- Comparing words writes a version 3 pin from the served keys, after the client has computed the words from them.
- The client compares every served ML-DSA and ML-KEM key with the pin's digests.
- A version 3 pin refuses any identity for that contact without an ML-DSA key, and any served ML-DSA key whose digest differs, even beside the same X25519 and Ed25519 keys. Both are shown as the changed-key warning.

### Succession version 2

Every succession from here on is hybrid:

```
["hushos/identity/succession",2,userId,oldKeyVersion,newKeyVersion,
 oldX25519,oldEd25519,oldMlDsa,newX25519,newEd25519,newMlDsa,sha256(newKemPublicKey)]
```

It is signed with the old identity's hybrid signature (3373 bytes); the new identity's keys statement, uploaded with it, proves the new keys are held. `verifySuccessionChain` follows only version 2 links, under these rules:

- The chain starts only at a link whose `oldX25519`, `oldEd25519` and `oldMlDsa` equal the version 3 pin's (the ML-DSA key by its digest).
- Each link's old keys equal the previous link's new keys, ML-DSA included, and versions only rise.
- Each half of each signature verifies under the pinned key or the previous link's new key, never under a key that only the link itself names.
- The chain ends at the served X25519, Ed25519, ML-DSA and ML-KEM keys; the last link's `sha256(newKemPublicKey)` equals the served ML-KEM key's digest.
- The chain is every link from the first one at the pin to the end of the list, in the order the server serves them. Links before it are skipped; a link after the chain's end, or the links out of order, and the chain does not hold. A server that appends a junk link can therefore make a real succession read as a changed key (a refusal, never an acceptance). An honest server serves the links oldest first, by key version (`successionChain` in `packages/db`).

The group core (`docs/groups-design.md` 2.8) does not use this verifier. It verifies each link once under the keys the link names, follows the verified links as a graph from a start key set, and treats two verified links leaving one key set as an identity fork (`succession-path.ts`, `succession_path.rs`). Personal pins, Drive and the mobile apps keep the strict verifier above, unchanged.

### Successor consent

The group walk starts at the first keys a member's entry named, and those keys are whatever an admin wrote: a holder can plant keys they hold as a member's first entry. With version 2 links alone, the planted keys could sign a link to the member's real keys and the walk would cross it, so a record or grant made under the planted keys would read as the member's (as a retired key, or as a grant that opens). Version 2 is signed only by the old keys, and the planter holds them.

Every succession made from this release on is therefore co-signed by the new identity too, over a statement of its own domain, with a role tag in each half:

```
["hushos/identity/succession-consent",1,role,userId,oldKeyVersion,newKeyVersion,
 oldX25519,oldEd25519,oldMlDsa,newX25519,newEd25519,newMlDsa,sha256(newKemPublicKey)]
role = "old" | "new"
```

The fields are version 2's; the domain keeps either signature from standing for the other (and leaves `hushos/identity/succession` version 3 to the restart link the groups docs plan), and the role keeps one identity's half from standing for the other's. The link carries `consent`: the old identity's hybrid signature over role `"old"` followed by the new identity's over role `"new"` (2 × 3373 = 6746 bytes, base64url). `createSuccessor` (web) and `identity_succeed` (Rust core) open the new identity's keys, sign both, and return `consent` beside the version 2 `signature`; `verifySuccessionConsent` and `succession_consent_verify` check each half under the keys the link itself names. That is enough on its own: the old half is the old keys' authority, and the new half is a key the planter does not hold agreeing to the link. The group walk never checks a consented link's version 2 signature, so a link with valid consent and a junk `signature` is followed in a group and refused for a personal pin.

- **Where the group asks for it: only where it buys something.** Consent stops keys planted as a member's first entry from bridging to the real identity, so the group walk asks it of links from the member's first keys up to their entry's keys: in writer verdicts (the first keys' retirement) and in the keys that open seals and grants (`signersThrough`). The personal-pin walk starts at the reader's own anchor, the roster-lag walk and `foldInEntry` at the entry's current keys, where a planter already vouches and could consent to his own successor anyway: there the version 2 signature holds, as it did before (`docs/groups-design.md` 2.8).
- **Personal pins are unchanged.** `verifySuccessionChain` and `succession_chain_verify` check the version 2 signature as above and ignore `consent`, so every link a shipped client signed keeps holding for contacts, Drive and the mobile apps. They never read the group walk's verification cache: the two accept links on different proofs. `SuccessionLink.consent` is optional in both twins (a uniffi default of `None`), so the Swift and Kotlin callers build unchanged.
- **Not built yet, and what it costs:** the server stores and serves only the version 2 `signature`, and the clients upload only that. Until the succession route and `account_identity_history` carry `consent`, a link the server serves has none, which matters only for a member whose entry has moved on from their first keys: their pre-entry keys do not read as retired, and seals they made under them do not open through history. Identity changes on the lag, personal pins and fold-ins are unaffected.
- **Earlier links can gain consent (1c backfill).** A member's client keeps every earlier identity sealed under the root (`identityHistory`), so it can open both ends of each of its own past links and sign their consent after the fact; 1c uploads those with the rest. Only an account whose earlier identities are gone (a restart without a succession) cannot, and its entry needs a words check, as before.

`PinnedKeys` gains the ML-DSA digest in both twins. A version 1 link no longer carries a pin anywhere: an account that replaced its keys before this release is a words check, like everyone else.

## 3. What is signed, and how

A signature's statement version says whether it is hybrid. That makes the ML-DSA half impossible to strip: an Ed25519 signature alone never verifies over a hybrid statement.

The verifier takes the version from context: the statement kind and the route or record it came from, never the signature's length. History rows hold both 64-byte and 3373-byte signatures, and a verifier that chose the form by length would make stripping possible again. Version 1 of the statements in the table below is refused.

| Statement                                                        | Before               | Now                              |
| ---------------------------------------------------------------- | -------------------- | -------------------------------- |
| KEM binding → `hushos/identity/keys`                             | KEM binding, Ed25519 | keys statement version 1, hybrid |
| `hushos/identity/succession`                                     | version 1, Ed25519   | version 2, hybrid                |
| Successor consent → `hushos/identity/succession-consent`         | none                 | hybrid by old and new keys       |
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

Everything else is as in suite 3: the grantee checks the signature against the granter's pinned keys before it decapsulates, and the server tells suites apart by length. Suite 3 is no longer written or opened. The group seals in `docs/groups-design.md` (key seal, area grant, guardian seal) use this construction under their own `info` and associated data.

**Existing shares need both sides to compare words.** The upgrade pass re-seals each account's ledger in suite 4 (`upgradeShares({ all: true })`), but re-sealing goes through `trustGrantee`, which needs a version 3 pin of the grantee, and the grantee checks suite 4 against a version 3 pin of the granter. Every pin is version 2 at the release, so a share stays shut until the granter and the grantee have each compared words with the other and the granter's device has signed in since. That is acceptable while production holds mostly test accounts. The recheck dialog says so: "shares between you open again once you’ve both done it."

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
- **Master-key rotation** (`/auth/security/finish`) rewraps the ML-DSA seed in the identity and in every history row that has one; the server checks each public key is unchanged, and refuses a changed `keyVersion` for a version 2 identity, since the keys statement binds it and the identity would stop verifying.
- **Shares** take 4565-byte envelopes only.

## 7. Later: file and folder signatures

File and folder signatures stay Ed25519 (decision 3). They are what stops someone who holds a folder's key (a viewer, a link visitor, a former member) from planting or renaming files unnoticed; once Ed25519 can be broken, such a key holder could forge them. Making them hybrid now would cost about 6.7 KB more per file in Postgres (some 6.7 GB per million files, plus every rename and version), in every listing and in phone CPU, years before the threat exists.

Because every account will already hold an ML-DSA key and every pin will already cover it, the later upgrade needs no words check. It is:

1. **Format:** the drive statements at version 2 with the 3373-byte hybrid signature, so a stripped signature fails; listings carry SHA-256 digests of signatures, and each device fetches and checks a signature once, caching the fact that it verified (keyed by the statement bytes it computes itself, the signature digest and the verifying public keys), never the verdict. Without the public keys in the key, a cached "verified" would survive the server changing who it says signed.
2. **Re-signing, never as the owner** (amended 2026-10-17, docs/integrity-design.md "Re-keyed records", decision D11): signing a member's record as the owner is the re-attribution rotation used to make. Each record keeps its writer's classical signature as its origin, in the origin columns re-keyed records already use, and the owner's device adds a hybrid signature over a version 2 binding statement that names the origin (its digest, signer and signature digest) the way the rekeyed statement does. The binding is the owner's word that the origin verified as its writer's before the cutoff: after the cutoff a record reads as its writer's only through it, and the reader shows the owner in Info, as the re-keyer is shown. A writer who is still a member can instead re-sign their own records with their hybrid key, which needs no one's word. The same rules decide which origins are kept: an unsigned or unverified record gets no binding and stays as it is.
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
    - TS and Rust verify each other's signatures over every fixture statement;
    - both implementations pass the FIPS 204 ACVP vectors for ML-DSA-65 key generation from ξ, signing with a context, and refusing malformed hints.
- **Stripping and old forms:**
    - a suite 4 share cut down to 1256 bytes does not open, and a suite 3 share does not open;
    - a version 2 succession with only an Ed25519 signature is refused;
    - a hybrid statement presented with a 64-byte signature is refused, and the verifier never picks the version from the signature's length.
- **Upgrade:**
    - an upgrade whose X25519, Ed25519, ML-KEM key or `keyVersion` differs from the current identity is refused;
    - a device whose wrapped ML-DSA seed does not open again to the same public key does not call the upgrade;
    - two devices upgrading at once end with one identity, and the loser adopts it;
    - their earlier file signatures still verify, and shares to them open again in suite 4 once both sides have compared words and the granter has signed in, and not before;
    - a master-key rotation after the upgrade keeps the ML-DSA seed openable, and a rotation that changes a version 2 identity's `keyVersion` is refused;
    - a device that has seen its version 2 identity refuses the version 1 form served for its account, and does not make a second ML-DSA key.
- **Pins:**
    - a version 2 pin of an upgraded contact trusts nothing until words are compared, and that contact's records read `unknown-signer`;
    - a version 2 pin trusts nothing when the server serves the version 1 form with the pinned X25519 and Ed25519 keys, and a KEM key vouched for only by the Ed25519 KEM binding is not trusted;
    - a version 3 pin refuses a served identity without an ML-DSA key, and one whose ML-DSA key's digest differs beside the same X25519 and Ed25519 keys;
    - a version 1 succession link is not followed;
    - a settings document holding 50 contacts' version 3 pins saves under the 64 KiB cap.
- **Succession chain:**
    - a link whose ML-DSA half is valid under any key other than the pinned one, or the previous link's new key, is refused;
    - a chain that starts at the pinned X25519 and Ed25519 keys with a different `oldMlDsa` is refused;
    - a chain that ends at keys other than the served four is refused.
- **Successor consent:**
    - a new succession's consent verifies, and fails with no consent, another account, a byte flipped in either half, the halves swapped, or moved onto a link to another identity;
    - the version 2 signature, alone, doubled or beside the new half, is no consent; nor are the old keys' signatures in both roles, nor the new keys' signature over the "old" role;
    - the personal chain follows the same link with and without consent (shared case `chain-one-sided`);
    - the group walk refuses a planted first entry's link without consent, and takes a one-sided link on the lag, a personal pin's walk and a fold-in (`docs/groups-design.md` 2.8).
- **Signature cache** (with section 7): a cached "verified" is not reused when the server serves a different signing key for the same statement and signature.
- **Fingerprint:** version 3 words change when any of the four keys changes, ML-KEM included.
- **Server:** a suite 3 share, a version 1 succession, and any signed write from a version 1 identity are refused.

## 10. Decisions (agreed 2026-10-15)

1. **One release, no transition:** production is mostly test accounts.
2. **ML-DSA-65 everywhere,** matching ML-KEM-768 and the group key.
3. **File and folder signatures stay Ed25519 for now,** with the upgrade in section 7.
4. **The upgrade keeps the existing keys** and replaces the identity in place, so file signatures keep verifying and no one seals to new keys.
5. **An unusable ML-DSA seed** is recovered by Start over with new keys (`docs/devices-design.md` 3), which writes a new identity without a succession, authorised by the recovery phrase; contacts compare words again.
