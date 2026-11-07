# Groups: the core families and companies share

This document fixes the group core:

- groups, members and invitations;
- the signed roster that lets members trust each other;
- shared areas and spaces;
- pooled storage and the payer;
- child accounts.

Family plans ship on it alone. Company plans add the custody key, admin browse, policies, audit, offboarding, storage control, domains and SSO on top. See the build plan, "HushOS for Companies — Build Plan", whose decisions this follows.

Each statement below is the exact byte layout that the web (`packages/crypto`) and the Rust core (`crates/hushos-core`) must produce and accept. Shared fixtures pin them.

Reviews applied:

- **14 October**, the independent review in `docs/archive/groups-crypto-review.md`. Every finding there is applied, and group signatures are post-quantum from the first version.
- **15 October**, `docs/archive/pq-devices-crypto-review.md`. Roster entries carry each member's ML-DSA key digest, and every conversion waits 7 days.

Nothing here changes what the server can read. It learns who is in which group, which it must know to authorise anything. Every key it handles stays sealed.

## 1. Model

| Table                     | Holds                                                                                                                                                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `groups`                  | `id` (client-derived), `kind` (`family` or `org`), `name` (plaintext, see 6), `group_key_version`, `roster_version`, `created_by`, `created_at`                                                                  |
| `group_memberships`       | `(group_id, user_id)`, `state` (`invited` → `accepted` → `active`; `left`, `removed`), `roles` (`members`, `billing`, `guardian`; companies add `data_admin`, `recovery`), `admitted_by`, timestamps             |
| `group_keys`              | One row per holder of the group key: `(group_id, group_key_version, user_id)`, the sealed seeds (2.3), `sealed_by`                                                                                               |
| `group_key_successions`   | `(group_id, old_version)` unique, the succession statement and its signatures (2.5)                                                                                                                              |
| `group_rosters`           | `(group_id, version)` unique, the roster statement, its signatures and the signer's identity signature (2.4); every version is kept                                                                              |
| `group_invitations`       | `id`, `group_id`, `normalized_email`, `token_hash` (as `account_enrollments`), `roles`, `invited_by`, `expires_at`, `state`                                                                                      |
| `area_grants`             | `(workspace_id, workspace_key_version, user_id)`, the sealed area key (2.6), `granted_by`                                                                                                                        |
| `group_storage`           | `group_id`, pooled `quota_bytes` from the plan and entitlements                                                                                                                                                  |
| `account_guardians`       | Not in milestone 1. `(child_user_id, guardian_user_id)`, the child's account root sealed to the guardian (2.9), `child_root_version`, `guardian_key_version`; deleted on conversion, release or guardian removal |
| `account_guardian_events` | Not in milestone 1. Each time a guardian's device fetches a guardian seal, recorded by the server and shown to the child                                                                                         |
| `account_devices`         | Every account's devices and their signing keys (`docs/devices-design.md` 1); a child account's device keys authorise conversion (3.6)                                                                            |

Changes to existing tables:

- `users` gains `account_kind` (`adult` or `child`) and `adult_from`, the date a child account may convert. HushOS stores that date, never a birth date.
- `workspaces` gains `owner_kind` (`personal` or `group`), `group_id` and `area_kind` (`shared` now; `employee` for companies later).

A group's shared area is a workspace like any other. Tree, rotation, versions, trash, change feed and quota code run unchanged on it.

## 2. Cryptography

### 2.1 Encoding

Statements are canonical JSON arrays as in `docs/integrity-design.md`. Every implementation follows these rules exactly:

- **Ids** are 36-character lowercase hyphenated UUIDs, validated on both sides. Anything else is refused.
- **Byte strings** are base64url without padding, including key digests (never hex).
- **Integers** (versions) run from 1 to 2^53−1. Rust refuses larger values, so TS and Rust agree.
- **The empty digest** (`previousRosterDigest` of version 1) is the JSON string `""`. Otherwise it is base64url of 32 bytes.
- **Lists** (roster members, roles) are sorted strictly ascending by the bytes of their sort key, with no duplicates.
- **Verifiers re-encode.** A verifier rebuilds the statement from the parsed fields and refuses any document whose bytes differ. So no two encodings of one statement exist.
- **One grammar beneath the fields** (`canonical.ts` / `canonical.rs`). Both the encoder and the parser enforce it, whatever the platform's JSON library allows:
    - at most 4 MiB (`MAX_STATEMENT_BYTES`), no byte-order mark;
    - a JSON array nested at most four deep, of strings and integers only: no objects, booleans, null, floats, exponents or `-0`;
    - strings of printable ASCII other than `"` and `\`, so there is never an escape, a lone surrogate or a non-ASCII byte;
    - integers from 0 to 2^53−1;
    - the bytes are exactly the compact encoding of what they hold.
- **Empty byte strings** are never canonical. Both twins' field helpers (`bytesOf`, `bytes_of`) refuse `""`.
    - The shipped general base64url decoders differ on `""`: the web refuses it, the core decodes it to nothing. They stay as they are.
    - No group field reaches them without the field helper and a non-zero length.
- **Identity key versions** (keys statements and succession links) run from 1 to 2^53−1 in both twins, like every statement integer.
- **Key digests**, both base64url:
    - **`kemPublicKeyDigest`** is SHA-256 of the 1184-byte ML-KEM-768 public key;
    - **`mlDsaPublicKeyDigest`** is SHA-256 of the 1952-byte ML-DSA-65 public key.
    - A signer checks the identity's keys statement (`docs/identity-pq-design.md` 1), which binds all four keys, before putting either digest in a statement.
    - Version 2 identities carry no KEM binding.

### 2.2 Group signatures are post-quantum

The group key is a pair: an Ed25519 key and an ML-DSA-65 key (FIPS 204). The libraries are `ml_dsa65` in `@noble/post-quantum` and the `ml-dsa` crate in Rust, beside the ML-KEM libraries already used.

Its seed is 64 bytes: 32 for Ed25519, 32 for ML-DSA-65 key generation.

Every group signature is both:

| Half      | Size       | Over                                                           |
| --------- | ---------- | -------------------------------------------------------------- |
| Ed25519   | 64 bytes   | the statement bytes                                            |
| ML-DSA-65 | 3309 bytes | the same bytes, with FIPS 204 context string `hushos/group/v1` |

- A group signature is valid only if both verify.
- A quantum adversary must break ML-DSA, a classical one Ed25519. Neither alone forges a roster or a succession.

People's own identity signatures are hybrid too. That covers signatures on seals (2.3, 2.6, 2.9), rosters' signer signatures and identity successions.

- `docs/identity-pq-design.md` adds an ML-DSA-65 identity key (context `hushos/identity/v1`). It ships before group milestone 1, so no roster, seal or succession is ever signed by Ed25519 alone.
- A reader checks a member's ML-DSA half only under a key whose digest is one of:
    - the member's roster entry's `mlDsaPublicKeyDigest` (2.4);
    - the reader's version 3 pin of them.
- Never under a key the server serves on its own.
- Writer statements (the file and folder signatures inside areas) are not hybrid. They stay Ed25519, as everywhere, until their planned upgrade (`docs/identity-pq-design.md` 7).
- A signer identity signature below is that hybrid signature (3373 bytes).

### 2.3 The group key and its seals

The group key is made on the creator's device.

**Fingerprint.** It is shown as twelve words exactly as a person's are (`fingerprintWords`: the first 132 bits of the digest):

```
SHA-256("hushos/group/fingerprint/v1" || groupId (36 ASCII bytes) || ed25519PublicKey (32) || mlDsaPublicKey (1952))
```

- **The words are always the version 1 key's.** Pins keep the version 1 keys.
- Joining does not use them:
    - a newcomer joins on first use, or compares the join code on an older app (2.4, 3.2);
    - any two members can check each other later with a pair code (2.4). It pins the version 1 keys through the chain it verifies, successions included (2.5).
- The core keeps `groupWords`. No 1c client shows them.

**Sealing the seed.** The 64-byte seed is sealed only to members whose roster entry has the `members` role.

- Construction: share suite 4 (ephemeral X25519 + ML-KEM-768 to the holder's identity, signed with the sealer's hybrid identity signature; `docs/identity-pq-design.md` 3).
- HKDF `info`: `hushos/group/key-seal/v1`.
- AEAD associated data: the statement without its final digest.

```
["hushos/group/key-seal",1,groupId,groupKeyVersion,holderUserId,holderKeyVersion,sealerUserId,rosterVersion,rosterDigest,sha256(sealed)]
```

**The roster a seal names.** `rosterVersion` and `rosterDigest` name the sealer's latest accepted roster when they sealed.

- A sealer refuses to name any other.
- An opener refuses a seal whose roster is not on its own accepted chain: a later roster than it has, or one from another history.
- So a seal made on a branch never opens on the real chain. An example is a seal by an honest holder whom a withheld removal kept on a removed holder's history.
- That alone does not stop a device kept at the branch point, whose latest roster is on everyone's chain. Area grants are therefore also bound to the area keys the roster lists (2.6). Such a device cannot hand on a key the real chain never listed.
- A key seal needs no more. Its opener derives the group key from the seed and compares it with the chain's.

**Opening.** A holder opens a key seal only if:

- the sealer is active with `members` on the latest verified roster (or is the creator, for version 1, while active);
- and the seed's derived public keys are the group key at `groupKeyVersion`. A holder refuses a seed whose keys are not.

### 2.4 The roster

One signed document names every member, their keys and their roles:

```
["hushos/group/roster",1,groupId,kind,rosterVersion,previousRosterDigest,groupKeyVersion,signerUserId,members,areas]
members = [[userId,keyVersion,encryptionPublicKey,signingPublicKey,mlDsaPublicKeyDigest,kemPublicKeyDigest,status,roles,sinceVersion], ...]
areas   = [[workspaceId,workspaceKeyVersion,commitment], ...]
```

**Members.**

- `members` is sorted by `userId`.
- `roles` is a sorted subset of `billing`, `guardian`, `members` (companies add `data_admin`, `recovery`).
- `status` is `active` or `left`.
- `sinceVersion` is the roster version the entry last changed at.
- Entries for former members stay.
- A roster has at most 10,000 entries (`MAX_ROSTER_MEMBERS`, both twins, built and parsed). That is well inside the 4 MiB statement cap (2.1). Departed members' entries count toward it.

**The chain.** `previousRosterDigest` is SHA-256 of the previous roster's statement bytes, so rosters form a chain. `rosterVersion` is always the previous one plus one.

**Areas.**

- `areas` carries a row only for each area the roster creates or rotates (round 10: delta rows), sorted by workspace id.
- Each row has the new key's version and commitment (2.6).
- At most 1,024 rows per roster (`MAX_ROSTER_AREA_ROWS`, both twins, built and parsed). That is as many as a family may have areas. So the roster that removes someone from a family, rotating every area, always fits (about 110 KB at the cap).
- A roster that touches no area carries `[]`.
- The accepted chain folds the rows into every commitment each area has had (`areaKeys`). So a roster's size no longer grows with the number of areas.

**Signatures and signer.**

- A roster carries a group signature (2.2) by the group key at `groupKeyVersion`.
- It also carries the signer's own identity signature over the same bytes, so every roster says who made it.
- The signer must be active with `members` on the previous roster (the creator, for version 1).
- The signer must also be active on the roster they sign. A holder's own departure, with the rotations it carries, is another holder's to sign.
- Every roster keeps at least one active `members` holder, so the group can always sign its next roster (round 11).
- The rules that need the signed roster (the signer active on it, and at least one active `members` holder) hold in `rosterRules` / `roster_rules`, so `nextRoster` and `checkNextRoster` inherit them.

#### Folding in changes

Before signing, the signer's client checks every changed entry:

- **A new member:** their keys are the ones the word check confirmed, the ML-DSA and ML-KEM keys by digest.
- **A member whose identity changed:** the group walk (2.8) follows them from the entry's keys, ML-DSA digest included, to the served ones. It goes on each link's version 2 signature (`foldInEntry`; consent buys nothing there, 2.8).
    - Once its keys statement holds, the entry moves straight to the served identity, however many links that takes.
    - An entry whose chain fails stays as it was. The member is shown as needing a check.

#### Checking a member's signature through the roster

- The reader takes the Ed25519 key from the entry and the ML-DSA key from the server.
- It uses the served key only if its SHA-256 equals the entry's `mlDsaPublicKeyDigest`. Otherwise the signature does not verify.
- This covers every member signature checked through a roster: key seals, area grants and rosters' signer signatures.

**Which keys a member signs with.**

- A member seals and grants only with the Ed25519 and ML-DSA keys their current entry names.
- After replacing their identity they seal nothing until a roster folds the new one in. Milestone 1 trades that liveness for one rule an opener can check.

**Seals made before a fold-in.** A seal or grant made before its signer's identity was folded in still opens.

- Given the signer's served identity and succession links, the opener also accepts the keys on the signer's own verified succession path:
    - from the first set of keys their entries named on the chain (the one a words check admitted);
    - up to and including the keys their entry names now;
    - and never past them.
- So a seal made under the entry's keys still opens after the member moves on.
- One made under keys no roster has folded in never opens.
- A key a holder wrote into an entry later never opens a seal, even with a link its planter signed from it.

**Who seals and grants.**

- Only an active `members` holder seals the group key (the creator, for key version 1, while active).
- Only an active member grants an area.
- The openers ask the same.
- A member whose identity forked (2.8) lends no history. Their seals open only under their entry's own keys, confirmed by the served ML-DSA key.
- A key seal opens only for the holder and key version it names.

**A member's own entry.** Each member's own client checks its own entry on every roster.

- It raises a hard warning if the entry names none of their identities, or one older than the roster before named (a rollback to a replaced identity).
- It is a soft note (`ownEntryBehindAt`) when an entry changed at a roster to one of their own identities older than their newest. The acceptance that adds the roster reports it; it is not kept in the cache. It means either:
    - a holder folded in an identity the member has since replaced; or
    - the member rotated just after a fold-in.
- Residual: a succession list the server cuts short cannot be told from an honest one. Example: served identity S1, links E→S1, while the member is at S2. Telling them apart needs a per-member high-water mark of link-verified key versions, which milestone 1 does not keep.

#### The area rules

`checkAreas`, Rust `check_areas`. Each row is an area's next version:

- 1 for an area the chain has not seen. Every row on roster 1 is one.
- Otherwise one above the latest version the chain lists for it.

Refused:

- a row at a version already listed;
- a skipped version;
- a new area above 1;
- a row whose commitment the chain listed before, in any area at any version;
- a commitment twice in one roster.

The commitment is of the key alone (2.6), so a repeat is a key used before. So a no-op rotation, a rotation to another area's key, or one key for two areas is refused from any client (a set lookup per row).

Every version of every area is therefore listed by exactly one commitment on exactly one roster, no key twice. The accepted chain keeps them all (`AcceptedRosters.areaKeys`, cached with the rest).

The rules that tie areas to membership:

- **A removal carries its rotations.**
    - In a family, a roster that marks anyone `left` who was `active` on the roster before must rotate every area the chain has, in the same statement.
    - One that leaves any area's key unchanged is refused (`A roster that removes a family member rotates every area.`).
    - Every family member can open every family area, so this is exactly the set the departing member could open.
    - `nextRoster` refuses to build it otherwise. `areasToRotate` (Rust `areas_to_rotate`) names the areas the client must rotate.
    - A company roster is not held to it. It does not say who opens which area, so a company's rotations stay a client duty (3.3).
- **A family has at most 1,024 live areas** (`MAX_FAMILY_AREAS`).
    - A row that would make the chain list a 1,025th area that is not retired is refused.
    - So the removal rule can always be met in one roster.
    - Format 2 (2.10) retires an area with a tombstone at its next version. It stops counting, is never rotated again, and its earlier grants still open.
- **Rows come from keys.**
    - `nextRoster` takes the new area keys (`areaKeys`) and computes the rows itself (`areaRows`).
    - Like acceptance, it refuses an area named twice and any key whose commitment repeats.
    - Cost: one HKDF per new key and a set lookup. A removal at the cap costs 1,024 HKDFs however long the chain (round 12).
    - Round 11 compared each new key with every commitment. A holder could grow that cost with rotation-only rosters until their own removal took minutes.
    - The commitment function is not in the package's exports (Rust: not exported to the apps), so a client cannot build a row by hand.
    - A signer who hand-builds a hollow row defeats the rotation, and no check can see it. Examples: a "new" commitment over a fresh key while handing the removed member the old one, or over a key the removed member was given out of band. That is the signer's betrayal, like leaking the key.
    - A rotation to any key the chain listed before, in any area, is refused by acceptance itself.
- **No admission on a holder's removal.**
    - A roster that drops a `members` holder (the one that makes a succession due, 2.5) admits no one: no entry new to it or turned `active` (`No one is admitted on the roster that removes a key holder.`).
    - The newcomer then comes in on a later roster, under the group key that succession made. The removed holder never held it (the join code, below, names it).

#### The entry rules

- From one roster to the next, entries never disappear. A former member stays, marked `left`.
- Each entry's `sinceVersion` is the version it last changed at.
- That is all. The keys an entry names, and its `keyVersion`, are a holder's claim and nothing more.
- Acceptance does not constrain key versions. They may go up, down or back to an earlier set of keys.
- Succession chains are followed from an entry's keys without its `keyVersion` as a floor. So a member's real keys written at an inflated version leave their later identities followable.
- Key versions do matter elsewhere:
    - a seal or grant names its recipient's key version, and the sealer and opener require it to equal the entry's exactly;
    - so an entry at an inflated version locks the member out of every new seal and grant to them until it is put right. Their own client flags the entry as not theirs.
- Planted keys are covered in 2.8.
- The server refuses an entry, new or changed in a roster, whose keys are not an identity the member has had with its keys statement holding (`checkNextRoster` with the members' identities, 4). Clients do not rely on that.

#### Accepting rosters

Every device verifies the roster chain from version 1, or continues from its own local cache (2.7). Never from synced state.

1. **Fetch.** The server serves every roster from version 1 (or every one after the cache), and every succession (4).
2. **The person's marks first.** They need nothing from the server:
    - their pins (2.7, the settings' and each device's);
    - this device's cache;
    - within one session (a worker, an app's ledger), the chain it already committed for the group (review of the 1d core step, 2026-10-18):
        - a served chain short of it is a lost race or a rollback and keeps nothing (`OLDER_CHAIN`, which the data layer reads again quietly);
        - one through another roster at its version is the hard warning, never committed (`SPLIT_CHAIN` is the ledger's backstop).

    What marks fix:
    - each fixes a roster digest at its version, and so, through the hash chain, every digest below it;
    - group key marks fix the group key at a key version;
    - each fixes the version 1 keys the person checked (through a join code, or at creation).

    Marks that disagree with each other are the hard warning (below), whatever the server serves, even junk. The served version 1 keys must then be the ones the marks agree on, or are refused as not the checked ones. With no mark at all, they are taken only as below.

3. **The chain** is the one ending at the latest roster served, linked back by `previousRosterDigest` to version 1 (or to the cache's last roster).
    - Two rosters at the latest version are refused (the server's to resolve).
    - A link that does not reach version 1 is refused.
    - Rosters after the cache that do not continue its last roster are refused. The device then fetches the chain again from version 1, where the cache is one more mark.
    - Any other roster served is a **dead branch**. It is ignored for acceptance and listed as a soft note with its version and claimed signer, unverified and never named as a culprit.
4. **Verify.** One pass along the chain. Each roster must:
    - hold under the group key current at its version (2.5);
    - be signed by a member active with `members` on the roster before it (version 1: on itself, the creator);
    - carry one copy with both a valid group signature and the signer's identity signature;
    - keep the entry rules;
    - come after the succession a dropped `members` holder made due.

    Each succession is taken as soon as the roster it is tied to is held, so the rosters after it are judged under the new key. Anything that fails is refused before the marks are compared with the chain. So a server cannot raise the warning with statements nobody signed, nor with version 1 keys it made up.

5. **The marks against the verified chain:**
    - a mark the chain does not pass through is the hard warning;
    - a chain short of a mark (a lower head, or fewer group keys) is a rollback, refused.
6. **Failure.** Anything that fails leaves member records at their personal-check verdicts, never better.

#### With no marks at all: anchors

A device with no pin and no cache accepts nothing on faith. Acceptance takes an **anchor** saying what vouches for the version 1 keys: `AcceptInput.anchor`, Rust `accept_rosters`' `anchor` (`docs/optional-verification.md` 3.3, which replaced the boolean `firstKeysChecked`).

Only the worker (or the core's ledger) passes one, in exactly these places:

| Anchor      | Where                             | What vouches                                                                  |
| ----------- | --------------------------------- | ----------------------------------------------------------------------------- |
| `created`   | creation (3.1)                    | the creating device made the group seed itself                                |
| `join`      | a join with a compared code (3.2) | the join code the person compared with the admitting admin's screen           |
| `first-use` | the default join (3.2)            | nothing; the served version 1 keys are taken because nothing contradicts them |

**`created`: creation** (3.1).

- It runs inside the crypto worker, over keys it just made. The creating device generated the group seed itself, so it knows the version 1 keys without asking anyone.
- It passes `created` only while it still holds the seed of this creation (in its staged secrets, or the sealed outbox entry of the creating call).
- It passes it only for served first keys equal to that seed's public key.
- It passes it:
    - once to accept its own unsent roster version 1 as a staged chain (below);
    - once more to accept what the server serves after the call succeeds. That acceptance writes the device's first cache and pin.
- After that the group needs the anchor no more on that device. The creator's other devices start from the synced pin.
- **The creating call's outbox entry, and the seed in it, are deleted only after that first committed acceptance has written the device's cache and pin** (and the settings pin is saved).
    - "Committed but not yet pinned" is a state the sealed outbox keeps across a reload.
    - The next open finishes it: re-sync from what the server serves, `created` against the held seed, write the cache and pins, then delete the entry.
    - The outbox tests of the web data layer (milestone 1c) must cover a reload in that state.
- Creation never passes it over keys it did not make. A device without the seed, and without a pin, is a newcomer and joins (below).
- A creator who loses the device between the server's answer and the first pin write has no mark anywhere. In a family with no other member nobody can compare a join code with them. That is a denial (the group cannot be verified), never a forgery.

**`join`: a join with a compared code** (3.2, iOS 0.10.0 newcomers and child accounts).

- Only together with a join mark (below).
- The person compared the join code their device worked out over the served chain with the one the admitting admin's screen shows.
- Acceptance carries that code as a mark, so the verified chain must pass through the admin's roster.
- Made-up version 1 keys then give a fork or a refusal (fixtures `join-mark-made-up-first-keys`, `join-mark-made-up-first-keys-succession`).
- The worker refuses `joining` without a mark.
- The code itself comes from a preview (`groupJoinPreview`):
    - the served chain is verified as acceptance would (against the marks if there are any, else over the served version 1 keys);
    - it returns the code of the roster at which this account's entry last became active;
    - nothing is committed, kept, marked or set as a fork, so a code nobody compared vouches for nothing.

**`first-use`: the default join** (3.2, `docs/optional-verification.md` 3.3).

- Nothing vouches. The served version 1 keys are taken because nothing contradicts them.
- It is allowed only:
    - on the join path: the worker's `groupJoinFirstUse`, then `groupAccept` with the joins record it sealed; the core's `join_first_use`, then `accept_joining`;
    - with no mark at all: no pin, no cache, no chain or fork this session holds, no family check, no family guard (2.7);
    - with settings that opened on this device;
    - for an account whose own entry is active at the head of the served chain. Acceptance itself refuses otherwise ("This account is not in this family yet."), which a preview reads as not admitted.
- Before anything is committed, the worker seals a version 4 joins record of the pin of the head it verified: `{v:4, groupId, firstUse: <pin>}`. The pin is `pinAfter`'s: its version 1 keys, roster version and digest, group key version and digest, areas and check time.
- The acceptance that commits holds that pin as one more mark, with no anchor:
    - another roster at its version, or another group key at its key version, is the hard warning;
    - other version 1 keys or a chain short of it are refused;
    - so a reload between the acceptance and the pin write finishes against the same history, rather than taking first use again over whatever is served then (scenarios `a-first-use-record-binds-its-first-keys`, `…-its-group-key`).
- A first-use chain, the reload's included, reports `checked: null`.
- What it costs is `docs/optional-verification.md` 4.2 and the threat model's first-use rows. Whoever runs the server can:
    - start a newcomer who never compares anything on a family it made up;
    - or plant keys in the newcomer's entry that the admitting manager seals the family folders to.

**With any mark**, an anchor vouches for nothing and the marks decide, exactly as a join with marks did before.

- A join mark comes with the anchor `join`, or with none beside the marks that decide (a rejoin). Never with another anchor.
- Acceptance reports what vouched in it (`AcceptedRosters.checked`, never passed in, not cached):

    | `checked`  | When                                                       |
    | ---------- | ---------------------------------------------------------- |
    | `created`  | at roster 1                                                |
    | `join`     | at the join mark's roster                                  |
    | `compared` | at a pair mark's roster (below; the lowest when several)   |
    | null       | for a first-use chain, and for one accepted on marks alone |

- The server's own acceptance of what it stores anchors on the version 1 keys it stored at creation (`stored`, inside `group-trust.ts` only; no device passes it).
- The web's F1 scan (`apps/web/src/lib/groups/join-only.test.ts`) lists every site that sets an anchor, by name and count.

Anything else is refused.

#### Identical statements served twice

- The same statement bytes may come with different signatures: a client that retried, or hedged signatures differing.
- Either copy that verifies will do.
- Only when no copy verifies is the statement refused.

#### Checking the next roster and succession

- `checkNextRoster` (Rust `roster_check_next`) and `checkNextSuccession` (Rust `group_succession_check_next`) are acceptance itself. They continue from a chain's cache with that one statement, so they refuse exactly what every device would.
- In TypeScript they take a reader's accepted chain or the server's stored one. They return the chain extended by it as a **stored chain** (`StoredChain`, frozen and registered in its own registry, not the accepted one).
- The Rust ones return nothing, since no app is the server.

**Stored chains.**

- A stored chain carries no cache. Its record to continue from is a `StoredChainCache` (`origin: 'server'`) that only the server entry hands out (`storedRecord`).
- A reader's acceptance refuses it as a cache, by type and at run time (`checkCache`), as the server's acceptance refuses a device's.
- The server's own acceptance of what it stores is `acceptStoredChain`, exported only from the server entry `@hushos/crypto/group-trust/server`:
    - the entry refuses to load where `document` or a worker scope exists;
    - the web app's test `server-imports.test.ts` fails if any non-server module in `apps/web/src` imports it. Workspace packages the web bundles are not scanned, so the load guard is the real control;
    - its anchor is the version 1 keys it stored at creation, with no reader, no pins and no words check. So it is never a reader's acceptance.
- A stored chain is taken only by `checkNextRoster`, `checkNextSuccession` and `acceptStoredChain`.
- Every seal, opening, write version, row, pin and trust function refuses it, as a type error and at run time (`This is not a member list this device accepted.`). So nothing the server accepted can vouch for a key on a reader's behalf.

**Who runs the checks.**

- `nextRoster` applies the same rules before a holder signs.
- Clients run `checkNextSuccession` before signing a succession.
- The server must run both before storing (4):
    - a stored roster that fails stops every device's sync, since every later roster chains to it;
    - a stored succession no device takes (one tied before the latest roster under its old key, for instance) stops the group at its next roster.

#### The hard warning

The hard warning ("Acme's member list was shown differently to you") appears only when the person's own marks conflict:

- two pins with different roster digests at one version, or different group key digests at one key version;
- a pin and the cache that disagree;
- two marks naming other version 1 keys (`of: 'group-key'` at version 1). Each side's digest is then the SHA-256 of the Ed25519 key and the ML-DSA key's digest, as a pin keeps them;
- the verified chain not passing through a mark: another roster at a marked version, or another group key at a marked key version.

**What is not the warning.**

- Served version 1 keys other than the marks' are a refusal, not the warning. A server can make up a group key and sign anything under it.
- A group key mark that the valid successions served do not meet waits as long as the key it names may still be tied to a roster not reached yet.
    - It is the warning only if a roster needing the next key holds under one of the others, signed by a `members` holder: a real other history the mark contradicts.
    - A roster under the marked (withheld) key while only the others are served is refused as a missing succession.
    - A mark still unmet once the chain is verified is a rollback, refused.
    - So a server withholding the real succession gets a refusal, never the warning.
- A succession whose new key is the key it replaces, or any earlier group key, is refused.

**How the warning reads.**

- It lists both sides, each with its digest and where it came from (pin, cache or served).
- It names a side's signer only when that side's statement was verified (in the pass, or by this device before, for the cache). A conflict among the marks alone names only the cache's.
- It never names one side as the culprit, since either may be the one the person was shown elsewhere.
- A fork is never resolved by taking the higher version.
- The marks are compared with each other before anything served is parsed. So junk the server adds (bytes that are not a roster, a roster of another group) can refuse acceptance but never hide the warning the person's own marks raise.

#### The join mark

Milestone 1c: `AcceptInput.joinMark`, `accept_rosters_joining`.

The join flow anchors a newcomer on a **join code** for the roster that admitted them: the roster at which their entry last became active. The code is that roster's version and twelve words, from:

```
SHA-256("hushos/group/join-code/v1" ‖ rosterDigest ‖ groupKeyDigest ‖ u64be(groupKeyVersion))
```

- The first 160 bits are read as the fingerprint words are: the top 132 bits, twelve 11-bit BIP-39 words (`joinCode`, Rust `join_code`).
- rosterDigest is the 32 bytes its base64url names.
- groupKeyDigest is exactly `groupKeyDigest` of the group key that roster is under: SHA-256 of its Ed25519 key followed by its whole ML-DSA key.
- It is never a pin's first-keys digest. An admin client using that form at key version 1 would raise false forks.

Acceptance holds it as one of the person's marks:

- the verified chain must pass through a roster at that version whose code it is, or it is the hard warning (`of: 'roster'` at that version, a side `from: ['join']`);
- a chain short of it is a rollback, refused;
- a mark that is not twelve lowercase words is refused outright (`Invalid join mark.`), not ignored.

Acceptance works the code out again from the chain it verified, never from a pin: the roster digest at that version, the group key that roster is under, and its key version. So the code alone pins the version 1 keys:

- under key 1, a made-up key is the code's key and gives the warning;
- after a succession, a made-up key reaches the code's key only through a succession a holder signed (the residual below).

The family's version 1 words add nothing once the code is checked, and the flow no longer compares them.

**What it covers, honestly.**

- A newcomer admitted on the real chain whom the server would start on any other history, such as a removed holder's branch.
- Also a newcomer the server would start on a concurrent upload's losing roster, when the admitting roster is the one it stored.
- Residual: if the server lies to the admin about a 409 and keeps the admitting roster as the loser, the code binds the newcomer to that branch. Admin and newcomer sit on it together: the fork-consistency residual.
- Matching the code with another roster is a second preimage on 132 bits, out of reach, so the digest alone holds.
- The group key is defence in depth. It adds something only because of the flow rule above (no admission on a holder's removal): the admitting roster is then under a group key no holder removed before it ever held.

**What it does not cover.**

- A newcomer whom a holder admitted before that holder's removal. That roster is real on both histories.
- An admitting admin whose device is compromised.
- A divergence after the join, until the newcomer holds a mark of their own past the admitting roster. A removal right after the join (admit at r_k, remove the admitting holder at r_k+1) that the server withholds from the newcomer before then is the withheld-removal residual, for the newcomer as for everyone.

**The flow** (3.2).

1. Once the admin has checked the newcomer's words, the admin's client signs the admitting roster and uploads it in one step. A retry resends the same signed bytes (the concurrent-uploads rule below).
2. If the upload meets 409 `stale` (another roster stored at that version), the client discards the unsent roster and signs a new one over the new head.
3. Only once admit has succeeded is a code shown:
    - the admin's from its committed chain after re-syncing (the stored roster, never the staged one);
    - the newcomer's over the chain route 5 serves.
4. The newcomer's client takes the code as its mark only when the person has checked ten words and typed the two its screen hid as the admin read them. And only while what is served still gives that code. Otherwise it keeps nothing.

**Residuals.**

- **Comparing after the upload.** A code that does not match leaves the newcomer admitted on the server: a seat taken, the areas' keys granted to the keys the admin checked. Their device trusts nothing of the family. Sorting it out may mean removing them.
- **Dropping the words.** A server working with a holder who signs a succession from a made-up key 1 can serve a made-up history below a join roster that comes after that succession and still meets the code. `join-mark-made-up-first-keys-succession` refuses it without the holder's signature.
    - The roster statements are the real ones. Only the version 1 keys and the successions before the join differ.
    - With the version 1 words no longer compared, nothing in the flow shows the newcomer that their pin names made-up first keys.
    - Such a holder can already sign any roster.

#### The pair mark

`docs/optional-verification.md` 3.4: `AcceptInput.pairMarks`, `accept_rosters_joining`'s `pair_marks`.

Any two members can check each other and their view of the family at any time with a **pair code**. It is twelve words, read as the join code is, from the first 160 bits of:

```
SHA-256("hushos/group/pair-code/v1" ‖ rosterDigest ‖ groupKeyDigest ‖ u64be(groupKeyVersion) ‖ lowerId ‖ higherId)
```

| Input                           | Is                                                                                                         |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| rosterDigest                    | the roster at which the later-admitted of the two last became active (the creator's admission is roster 1) |
| groupKeyDigest, groupKeyVersion | the group key that roster is under                                                                         |
| lowerId, higherId               | the two lowercase account ids, sorted, 36 ASCII bytes each                                                 |

The function is `pairCodeOf`, Rust `pair_code_of`.

**Why both ids.**

- With the roster alone, every pair a later member is part of would share their admission's code.
- A server labelling a planted entry C as "Sam" would then let A match with the real Sam and vouch for C.
- With both ids, A's device works out A↔C and Sam's works out A↔Sam (cases `pair-mark-of-another-pair-at-one-roster`, the roster-call fixtures' `pairCodes`).

**Its own domain.**

- A pair code never stands for a join code, nor the reverse (`pair-code-passed-as-a-join-mark`, `join-code-passed-as-a-pair-mark`).
- A join mark naming a member, or a pair mark naming none, is refused by its shape.

**Working it out.**

- `pairCode` (Rust `pair_code`, the worker's `groupPairCode`) works it out over a chain this device accepted, from both sides alike.
- It shows no words (`own-entry-wrong`) where this account's own entry at that roster names none of its own identities, or acceptance found it wrong there. What such a device would compare is keys it does not hold.

**A match** (`pairMatch`, Rust `AreaLedger::pair_match`, the worker's `groupPairMatch`) gives two things:

- The check record to save in the settings: `familyChecks[groupId] = { rosterVersion, with, code, checkedAt }`. Only when the code is this device's.
- Separately, a verified pin of the other member's keys, only when their entry at the head is active and names the very keys of their entry at the compared roster. Those keys must also match:
    - the ones this device's guard holds for them (2.8 of the optional-verification design; an unreadable guard writes none);
    - or, without a guard entry, the settings pin's.

    With neither a guard entry nor a settings pin, the pin is written.

- A member whose keys moved since (a handover, or a Continue) is checked with personal words instead.

**Acceptance holds the record as a pair mark.**

- The chain must hold a roster at its version over which the pair code of this account and `with` is its code. Else it is the hard warning (a side `from: ['pair']`).
- A chain short of it is a rollback.
- A record with no code (the migration's `before`, PR 4) is a mark but no pair mark.
- One that is neither refuses that family alone (`Invalid pair mark.`).
- The check record never stands for the manager rule (3.6 of the optional-verification design, PR 4). Only the verified pin it wrote does.

#### Older apps, one way

- iOS 0.10.0 works the join code out before any check of its own entry (`join.rs` at the tag `v0.10.0`).
- So a 0.10.0 phone matches it over keys the server planted in its entry (`crates/hushos-core/fixtures/v0.10.0/planted-join.json`, made by that core).
- The manager reads that phone the old join code (`groupJoinCode`, Rust `member_join_code`). Nothing is written on the manager's side.
- The old code is no pair code, so a match taken over it saves no check record and no pin (`tests/planted_join.rs`, `planted-join.test.ts`).
- The new core shows the planted newcomer no pair code at that roster. The manager's pair code with them is not the code 0.10.0 compared.

#### Staged chains

Milestone 1c.

- A seal or grant names the sealer's latest accepted roster (2.3, 2.6).
- A roster call carries the seals and grants that the roster makes due, naming that very roster. The server checks them against the roster in the same call.
- So a client building such a call first accepts its own signed, unsent roster on top of its **committed chain** (the one it accepted from what the server served). The result is a **staged chain**.
- The client uses it only to seal and grant for that call. For a removal's rotations it also uses it to judge writers, as the roster marking someone `left` does.
- Roster version 1 at creation is staged the same way (the `created` anchor, above).

A staged chain **never becomes a mark**:

- it is never written as the device's cache or pin;
- it is never synced;
- it is never passed to acceptance as a mark.

**Outcomes of the call.**

| Outcome   | Answer                                                   | What the client does                                                                                                                                                                       |
| --------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Confirmed | 201 or 200, or a resend answered as a replay             | Only then re-syncs from what the server serves. Only that committed acceptance writes the cache and the pin                                                                                |
| Refused   | 409 `stale`, or any other refusal: a 4xx carrying a code | Discards the staged chain with its roster and secrets. A refusal is a definite answer                                                                                                      |
| Unknown   | a 5xx, a timeout, a dropped connection: not a refusal    | Keeps the outbox entry, the staged chain's secrets and the signed bytes, and resends them unchanged. The server answers a resend of a call it already stored as a replay, which commits it |

Why: were a staged roster kept as a mark, a device that lost a `stale` race would hold a mark on a history the server never stored. Its next sync would raise the hard warning against itself.

The staged roster's signed bytes, and the keys its seals and grants carry, are what a retry resends unchanged (below).

**Residual.** A lost admit race leaves what was already uploaded for that admission on the server until the next rotation replaces those keys. That is the seeds and grants sealed to the newcomer, whose keys are the group's and the areas' current ones.

- The 1b server stores a roster call in one transaction, so nothing of the refused call itself.
- Seals and grants naming a roster no chain holds never open (`sealedOnChain`), so the newcomer reads nothing through them.
- But the keys they carry stay current until then.

#### Concurrent uploads make second histories

- Two holders signing roster `n` at once (or a client retrying after the member list changed) each produce a valid next roster.
- The server stores one and has seen the other.
- It can later serve the loser as the latest roster to newcomers and to devices with no mark at `n` or above, who accept it. A removed holder may still be active there, with no succession due.
- Showing it to a device with a mark from the stored one raises the warning with nobody's help but the server's.
- The same holds for two successions from one key.
- The client rule for milestone 1c: a retry resends exactly the signed bytes it already uploaded, never a re-signed statement. The join mark above covers newcomers.

#### What this does and does not stop

- **A removed holder** keeps the group key versions they held. They can still sign statements under them, on a branch of their own from the last roster they held `members` on.
    - Served beside the chain, that branch is a dead branch: ignored, a soft note at most, never a warning.
    - Served as the chain itself (the server colluding), it is accepted only by a device with no mark beyond the branch point, which takes it as the history.
    - A device with any mark above it raises the warning (the branch does not pass through the mark) or refuses it (shorter than the mark).
    - A device verifying the real chain never accepts a roster under a key a succession replaced.
- **The server can:**
    - withhold the latest rosters. A device then sees an older chain, refused once it has a mark above it;
    - serve two latest rosters or two valid successions from one key (refused: a stall);
    - serve a different chain to a device with no marks at all. That is why a newcomer's join code check is required;
    - where holders signed two histories (a removed holder's branch, say), split different people across them for good. This is fork consistency, not more. Only a person's own devices, through their marks, detect that they were shown two histories. Nothing tells two people apart.
- **The server cannot:**
    - make a device with a mark accept a chain off that mark without the warning;
    - raise the warning without statements a holder signed. Served version 1 keys it made up are refused against the person's marks before anything is verified;
    - forge a roster or succession.
- **A sole `members` holder** who starts over without a succession link can never sign again: no entry names keys they hold.
    - Another `members` holder can fold their new identity in from a words check.
    - A group with no other `members` holder cannot recover its roster.

### 2.5 Group key succession

A succession replaces the group key and is tied to a place in the roster chain:

```
["hushos/group/key-succession",1,groupId,oldVersion,newVersion,oldEd25519PublicKey,oldMlDsaPublicKey,newEd25519PublicKey,newMlDsaPublicKey,lastRosterVersion,lastRosterDigest,signerUserId]
```

**The statement.**

- `newVersion` is `oldVersion` + 1.
- It carries a group signature by the old key and the signer's identity signature.
- The signer is active with `members` on the roster at `lastRosterVersion`.

**Which rosters each key signs.**

- Rosters signed by key `v` must have versions after the `lastRosterVersion` of the succession into `v`, and up to the `lastRosterVersion` of the succession out of `v`.
- A roster under a key that a later succession has already left behind is refused.
- Successions are tied in order: each `lastRosterVersion` no lower than the one before.

**A holder leaving or removed** is the last roster under that key.

- The roster that marks a `members` holder `left` makes a succession due.
- No further roster is accepted until it exists.
- The new seed is sealed to every remaining holder.
- A succession that drops a holder who was not removed raises a warning.

**When a succession holds.** All of these:

- it names the chain's key at `oldVersion`;
- one copy carries the old key's group signature and the signer's identity signature;
- the signer is active with `members` on the roster it names by version and digest (a roster on the chain);
- it is tied no earlier than the succession into it.

One that does not hold is ignored.

- A succession is taken as soon as the roster it is tied to is reached. So one tied before the last roster already signed under the old key leaves that roster under a replaced key, and it is refused.
- A former holder who kept an old key cannot make one that holds: the signer must hold `members` on the roster the succession is tied to.

**Two successions from one `oldVersion`.**

- Two that both hold at the same roster are refused, unless one of the person's group key marks (2.7) names one of them. That one is then taken.
- A mark that none of them meets waits. It is the warning only if a holder-signed roster holds under another (2.4).
- Two tied to different rosters are not "both valid" at once. The earlier-tied one is taken when its roster is reached. If the other was the real one, the chain then stalls (a roster refused as under a replaced key).
- That is a denial the server can cause with a holder's second signed succession, never a forgery.

**New keys only.** A succession's new key must be new: not the key it replaces, nor any key the group had before (k1 → k2 → k1 is refused).

**Tied too early.**

- A succession tied too early (before the last roster already under the old key) is taken too early. So that roster is refused and the group stalls.
- Clients run `checkNextSuccession` before signing one.
- The server must run it against the stored chain before storing one (4).

**One per old version on the server.**

- The server stores one succession per `oldVersion` and refuses a second.
- It has still seen the refused one, signed, and can serve it later (see the second-history residual in 2.4).

### 2.6 Area grants

**Area keys are on the roster.** Every area's current key is listed on the roster with its commitment:

```
commitment = HKDF-SHA-256(ikm = workspaceKey, salt = 32 zero bytes, info = "hushos/group/area-key/v2", length = 32), base64url
```

- It depends on the key alone (round 12; round 9's v1 folded in the workspace id and version).
- It reveals nothing of the key but whether two keys are equal.
- Its area and version are where the roster lists it.
- A grant opens only to the key whose commitment the chain lists at the grant's area and version, as the group key's own publication binds key seals (2.3).
- Acceptance refuses any commitment the chain listed before (2.4).

So a new area, or a rotation, is a roster first, signed by an active `members` holder (`nextRoster` with the new key, which computes the row). Only then are its grants made.

**This is a product rule change.**

- Until now any member holding an area's key could rotate it.
- Now only `members` holders create or rotate areas.
- The rotation itself (the new node key on the area root, the version bump) is still the rotating client's work.

**Why.** Take a holder whose device the server keeps behind: a withheld removal, no branch roster needed.

- Without commitments, that holder would make a new area or a rotation on its own view, where the removed holder is still active.
- They would grant the new key to everyone there, naming their latest roster. That roster is on every real-chain device's chain too.
- Real-chain members would open it and upload under a key the removed holder holds.
- With commitments on the roster, that grant opens nothing on the real chain. The version is not listed there, or is listed with another key's commitment.

**Rows are deltas.**

- A roster carries a row only for an area it creates or rotates (at most 1,024, 2.4). Its size depends on what it changes, never on how many areas the group has.
- Every version is listed once, on the roster that introduced it. The area rules (2.4) make each area step 1, 2, … with one commitment per version.
- Every device verifies the chain from version 1 (or its cache, which keeps them). So the accepted chain holds every commitment (`AcceptedRosters.areaKeys`).
- A grant of an earlier version (a key a reader needs for older files) opens against the commitment the roster that introduced it listed.
- A grant of a version the chain does not list, or of a key no roster committed to, opens nothing.
- The server (milestone 1b) refuses a roster row creating an area whose workspace is not a group workspace it has for that group.

**Writing.**

- A member writes an area only under its latest version on the accepted chain (`areaWriteVersion`, Rust `area_write_version`: the number of commitments the chain has for it).
- A client holding no grant for that version writes nothing there until it has one.
- The server reporting the area at an older version is no protection against the server. The server could otherwise keep a member writing under a key a removed member holds (a withheld rotation).
- The client rule is milestone 1c's. The core gives the version now.

**The grant.** An area's workspace key is granted with the suite 4 construction:

- HKDF `info`: `hushos/group/area-grant/v1`.
- AEAD associated data: the statement without its digest.

```
["hushos/group/area-grant",1,groupId,workspaceId,workspaceKeyVersion,granteeUserId,granteeKeyVersion,granterUserId,rosterVersion,rosterDigest,sha256(sealed)]
```

- `rosterVersion` and `rosterDigest` are the granter's latest accepted roster, as for a key seal (2.3).
- A granter grants only a key its latest roster lists, for that area and version (an earlier version by the chain's commitment).

**Opening a grant.** A grantee opens a grant only if all of these hold:

- **The roster it names is on the grantee's own accepted chain.** So a lagging holder's grant of a removed holder's branch key never reaches the real chain.
- **The chain lists the area at that version, and the key opened has the commitment the chain listed for that version.**
    - So a granter kept behind cannot hand on a key the real chain never listed.
    - And a key made under a retired identity of the granter's opens only to the key the roster committed.
- **The granter is `active`** (not `left`) on this group's verified roster.
- **`groupId` is that roster's group and the area belongs to it.** That means its workspace id is derived under the group (the `workspace` id kind, scoped to the group id, checked from the area's id seed). Only such areas enter the pin's `areas`.
- **The grantee and key version are the reader's own.**

**No floor on `workspaceKeyVersion`.** Round 10 dropped the high-water check in both twins.

- An earlier version's grant opens after a later one has, since readers need earlier keys for older files.
- A key a removed member holds is kept from new writes by `areaWriteVersion` and the removal's rotation, not by refusing old grants.

**Rotating an area.**

1. A roster lists the next version's commitment, signed by a `members` holder.
2. Then the rotation bumps `workspace_key_version`.

- The area root is the root of a `drive_rotations` run. It gets a new node key in the same request that bumps the version, so a cached root key opens nothing new.
- In format 2 (2.10) the roster also commits to that new root key. Readers take the root as current only by that commitment.
- New grants go to active members only.

### 2.7 Pins and rollback

The settings document gains, per group:

```
groups: { [groupId]: { firstEd25519PublicKey, firstMlDsaPublicKeyDigest, checkedAt, keyVersion, groupKeyDigest, rosterVersion, rosterDigest, areas: { [workspaceId]: highestKeyVersion } } }
```

**The fields.**

- `checkedAt` is the 24 ASCII characters of an ISO 8601 UTC time to the millisecond (`YYYY-MM-DDTHH:MM:SS.sssZ`, as `toISOString` writes it).
    - Anything else is no pin.
    - So every client orders check times alike, byte by byte.
- `firstMlDsaPublicKeyDigest` is SHA-256 of the version 1 ML-DSA key. The client compares it with `firstKeys` as served. The settings document has no room for the key itself (`docs/envelope-migrations.md` 2).
- `rosterVersion` and `rosterDigest` are the latest roster this person's devices accepted.
- `keyVersion` and `groupKeyDigest` are the group key at that point. `groupKeyDigest` is SHA-256 of the group key there, Ed25519 then ML-DSA.
- The areas' keys scope roster trust (2.8). The version each carries is kept for the pin's form and is no longer a floor anywhere (2.6).

**What the pin does.** The pin is never a starting point. Its only jobs are:

- **Rollback.** A served chain shorter than the pinned roster, or without the pinned group key, is refused.
- **Split-view detection across devices.** It is one of the person's marks (2.4). So another roster at the pinned version, another group key at the pinned key version, or two pins that disagree raise the hard warning.

**How it is kept.**

- Each device also keeps its own pin. Both are passed to acceptance.
- The pin written afterwards is the chain's latest roster and group key, with the areas the group's grants tied and the earliest check (`checkedAt`).
- A lower pin needs no keeping once the chain has been seen to pass through it. So nothing like an earlier-marks list is stored.
- The `groups` field makes the document version 2, which older clients refuse rather than save over (`docs/envelope-migrations.md` 2).

#### Family checks and the family guard

`docs/optional-verification.md` 3.4, 2.8.

**The family check.** The settings document also keeps, per group, the family check this person made: `familyChecks: { [groupId]: { rosterVersion, with, code, checkedAt } }`.

- It is a new top-level field every shipped client keeps when it saves.
- Acceptance holds it as a pair mark (2.4).

**The family guard.** Each device also keeps a **family guard**: the latest pin this device accepted, advanced on every acceptance and never lowered.

- It is apart from the chain record.
- It is never synced.
- It is never cleared by a `not-member` wipe, nor by anything the server answers.

**Advancing the guard.**

- Acceptance returns the guard to keep (`groupAccept`'s `guard`, Rust `ServedAcceptance::Accepted`'s and `JoinAcceptance::Accepted`'s).
- That guard is the held one merged with the accepted pin and the folders opened on the device (`mergePin`).
- It is returned only when that records anything new (`pinAhead`). None is returned when it is behind or conflicts, so it never goes down.
- The app writes it before the device record, without waiting for the settings save. So a crash leaves it at or above the record and never below.

**Store before delete on a `not-member` wipe.** The core enforces it.

- `groupForget` / `forget_group` takes the held guard.
- While that does not cover the session's floor (the highest chain it accepted for the family), it drops nothing. It returns the guard to store: the held one moved on to the floor, with the folders opened here.
- The app stores it, merged into what it holds and never lower under the account's lock, and asks again.
- Only a held guard that covers the floor forgets. Covering means: it is the floor at the floor's own roster and group key versions (the same digests), with every folder at least as high. A guard keeps digests only at its own versions.
- A held guard that disagrees with the floor is refused (`GUARD_CONFLICT`). Disagreeing means other first keys, another roster or group key at one version, or crossed versions, which no one history holds. `mergePin` calls all of them a conflict.
- One past the floor is refused (`GUARD_AHEAD`) until acceptance brings the floor up to it, which checks the history between them.
- Either way nothing is dropped.

**Commits and wipes.**

- Every commit holds the whole floor again (its roster and its group key at their versions). So an acceptance verified against an earlier floor commits nothing beside a later one.
- A wipe ends every acceptance call of the family begun before it, from its very start (before a record is opened). It commits nothing after it (`FAMILY_FORGOTTEN`, never retried).
- The core holds that across a call's attempts. On the web each attempt is its own call, so a wipe between two attempts is not caught.

**When the guard can't be stored or read.**

- While it cannot be stored, the wipe waits and the family shows the ordinary couldn't-save state.
- An unreadable guard holds the wipe up only over a floor. Its guard comes back marked `unreadable`, to store once the entry reads or the person resets it.
- Until a returned guard is stored, nothing is written under that acceptance: no sealing, no upload under rotated folder keys, no admission. Reading goes on.
- A session that ends first drops the unstored guard, as if that chain had never been served (the withheld-removal residual).

**What the guard stops.**

- Acceptance takes the guard as one more pin. So a family that was once on the device is never taken on first use again.
- A chain short of the latest roster this device accepted is refused as a rollback, whatever settings the server serves (a replaced copy without the group pin included), a wipe in between included.
- So a member removed above it does not come back by a replay below it (scenario `the-guard-advances-and-a-replay-below-it-is-refused`).
- A genuine rejoin passes, being the same chain from version 1 through the guard's roster.
- A guard that could not be read is never first use. The acceptance is refused ("HushOS couldn’t check this right now.") and nothing is taken on it.

**Where it lives.**

- The core takes the guard as `groupAccept`'s and `groupJoinFirstUse`'s `guard` (Rust `FamilyGuard` on `accept_served`, `join_first_use` and `accept_joining`).
- Its store is the app's (the web's PR 3 and 4, iOS PR 5). Until then the apps pass none.

#### The local cache

A device may keep, locally and never synced, what it verified (`GroupChainCache`):

- every roster's digest;
- the last roster's statement and whether it dropped a holder;
- every group key, and every succession's tie, digest and signer;
- the creator;
- every set of keys each member's entries named (X25519, Ed25519 and the ML-DSA digest);
- every commitment each area has had (`areaKeys`);
- the versions where the reader's own entry was wrong.

**Checks on input.**

- The last roster's rows must be their areas' latest commitments. At roster 1 its rows must be every area there is.
- Earlier commitments are this device's own record and are trusted as stored (a compromised device is out of scope), as the rest of the cache is.
- It is bound to its group and to the roster it is through. The last digest is the statement's, whose version is the digest count.
- Every part is checked for form on input. One that fails is refused.

**Using it.**

- With it, the next sync asks for the rosters after it (`?after=`, 4). It continues from it exactly as verifying from version 1 would have.
- The cache is one of the person's marks. Every roster digest and group key it holds is fixed. So a served chain that does not pass through its last roster, or a pin it disagrees with, raises the hard warning.
- Successions served beside the ones it verified are ignored.

**A cache the worker refuses.**

- A record whose cache the worker refuses even over the chain from version 1 (one a newer release wrote, or a damaged one) would refuse the family on that device for good.
- So the data layer then accepts from version 1 with the record's cache left out, but its device pin kept as a mark (`groupAccept`'s `withoutCache`, `acceptServed`).
- The pin is what keeps this from being a rollback. The settings document a server serves can be an older one. A third attempt against the settings pin alone would let a server:
    - get the cache refused;
    - serve a chain cut before a removal, with the settings from before it;
    - and have the device take the removed member back.
- The server chooses when this path runs. Any chain it serves that the worker refuses twice, junk included, sends the device down it. So it is no evidence that the cache was at fault.
- What bounds it is the record's pin. The chain may never end below the record's version or leave its digest, whatever the server serves.
- The record is replaced only by that acceptance. A chain refused on its own merits leaves it in place.

#### Key history

- Every set of keys each member's entries named, in order, is part of what the device verified (and of its cache).
- It is not trusted on its own: an entry's keys are a holder's claim (2.4).
- Its first set per member, the one a words check admitted, is the only earlier set a reader relying on the roster (2.8) or a seal's opener (2.4) starts the member's succession chain from.

### 2.8 What readers show

Roster trust is scoped to its group: **a roster vouches only for records in that group's areas and for grants naming that group.**

#### Outside the group's areas

- Elsewhere, such as a colleague's personal share, a colleague who is not personally checked shows as Unverified with the hint "In Acme".
- "Trust as Acme does" is retired from the UI by `docs/optional-verification.md` 3.7, PR 4. First-seen pins open such shares anyway, and the family check is the way to vouch through the family. The core keeps `trustAsGroupDoes` for the pins it already wrote.

**"Trust as Acme does".** One click writes a version 3 personal pin, as an explicit act by the reader. It is built from the roster's entry (its X25519 and Ed25519 keys and its ML-DSA and ML-KEM digests) and the served keys that match them.

- The pin is only as good as the chain the reader accepted. Take a newcomer the server keeps on a removed holder's branch, where that holder planted their own keys as member X:
    - the newcomer writes a personal pin of the planted keys;
    - it outlives the branch, reaching X's personal shares to the reader;
    - the join code (2.4) covers a newcomer on such a branch once 1c ships it. Until then the button should not be offered to a member admitted in the last few rosters without a second words check.
- The pin records where it came from:
    - `trustAsGroupDoes` writes `trustedVia: groupId` on it (Rust `VerifiedPin.trusted_via`);
    - a new words check over the keys clears it;
    - `newRosterEntry` refuses such a pin (a member is admitted only from their own words check).
- Inside the group, links from a pin trusted through a group need the successor's consent up to the entry (below). So planted keys pinned that way give no bridge once the entry is put right.
- Every shipped client keeps pin fields it does not know when it rewrites a pin, so the field needs no pin version:
    - the web spreads the old pin;
    - iOS writes known fields over the raw dictionary;
    - Android edits the JSON in place;
    - none rejects an unknown field.
- An older client's own words check keeps it, which only asks consent where none was needed.

#### Inside the group's areas

In order:

| Case                                                                                                                                                                        | Verdict                                                                                                                                                                                                                        | Shown                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| The record carries no signature (checked before anything else: an unloaded roster never hides a stripped signature)                                                         | `unsigned`                                                                                                                                                                                                                     | Unverified                                                                                             |
| The roster cannot load or verify                                                                                                                                            | `unchecked`                                                                                                                                                                                                                    | Couldn't check (fails closed)                                                                          |
| The writer has a personal pin that matches the roster's keys (from a words check; one trusted through a group names that group as `via`, round 12)                          | `verified` (`via: trustedVia`, null for a words check)                                                                                                                                                                         | No mark                                                                                                |
| The writer is active on the roster, no personal pin                                                                                                                         | `verified`, `via: groupId`                                                                                                                                                                                                     | No mark; Info: "Verified by Acme"                                                                      |
| A personal pin differs from the roster, and the writer's succession chain leads from the pin to the roster's keys                                                           | `verified`, `via: groupId`                                                                                                                                                                                                     | No mark; the pin follows the chain                                                                     |
| The writer replaced their identity and no roster has folded it in yet: their succession chain leads from the entry's keys (ML-DSA digest included) to their served identity | `verified`, `via: groupId` (or no `via` when a personal pin agrees)                                                                                                                                                            | No mark; the served key is current, the entry's retired                                                |
| A personal pin differs and no chain joins them (keys compared, never the unsigned served key version)                                                                       | `key-conflict`                                                                                                                                                                                                                 | A hard warning, worse than Unverified                                                                  |
| The writer's entry is `left` (checked before any personal pin)                                                                                                              | `former-member`                                                                                                                                                                                                                | Drawn as Unverified: "Written by Sam, who has left Acme"                                               |
| A rotation re-keyed the record: it carries an origin (docs/integrity-design.md, "Re-keyed records")                                                                         | the origin's verdict, by the rows above for the origin's signer, when the origin is bound; `bad-signature` when it is not (bytes differ, or the re-keyer attested to a broken wrap); `unchecked` when it couldn't be confirmed | As that row (a removed member's file reads `former-member` by them); Info adds "Keys replaced by Maya" |
| The writer is not on the roster                                                                                                                                             | as without groups                                                                                                                                                                                                              | Unverified, or the existing verdicts                                                                   |

**Rotations never claim authorship here.**

- A rotation keeps each record's origin and the writer's signature, and signs only the binding (docs/integrity-design.md, "Re-keyed records").
- So a removal's rotation leaves the removed member's files reading `former-member` by them, never "re-locked by" the admin who rotated.
- Once the server stores origins, it accepts in a group's area only a rekeyed record or a legacy `resealed` one, never `ordinary` or `saved`.
- The re-keyer's own signature is judged with the group's trust too.
- A verified re-keyer appears in Info only.
- A missing or bad re-key signature, or a re-keyer in key conflict, is an Unverified mark (the re-key isn't attested), never a mismatch.
- The record is the re-keyer's fault (`bound: false`) only when the bytes differ, or when the wrap or origin fails under their verified signature. Anything a server alone could cause reads couldn't-confirm.

**Former members.** A former member still holds their keys, and a signature carries no trustworthy date. So their work is marked: it may be old and genuine, or planted. That holds even for a reader who pinned them personally. Inside the group's areas, leaving is what matters.

#### Retired keys and what did not load

A member's earlier keys read as retired only along a succession chain the reader verified to the member's served identity. Only the links the verifier itself followed count, never another link served beside them.

- **A reader with a personal pin** of the member:
    - retires keys along the chain from that pin;
    - when the pin is at a later identity of the member, also retires the keys before the pin on the member's verified chain from the entry's keys or their first keys up to the pinned keys. They were the member's before the identity the reader pinned;
    - never retires from a set a holder wrote into an entry later.
- **When that pin was trusted through a group** (`trustedVia`):
    - it is carried on the pin group verdicts take: `WriterPin`, its keys and origin together, so a caller cannot drop the origin. An empty one reads unchecked;
    - the walk from it asks the successor's consent up to the entry, as the walk from the first keys does, wherever its keys sit in the member's history (a planted first entry included);
    - a planter's one-sided link from his planted keys to the member's real ones then bridges nothing. The pinned reader sees `key-conflict`, never the planted keys retired.
- **When that pin came from the reader's own words check**, the walk takes the version 2 signature. So an honest member's later one-sided rotation, folded in, is no conflict for them.
    - Round 10 keyed this on the pin's place in the history instead. That raised false conflicts for honest members and missed planted first entries.
- **A reader relying on the roster** retires them:
    - along the chain from the entry's keys (when no roster has folded in the change yet);
    - and along the chain from the member's first set of keys on the chain, the one a words check admitted (2.7), up to the entry's keys and never past them. Past the entry, a chain is no evidence the first keys were the member's: a planter consents to his own successor;
    - never from a set a holder wrote into an entry later.

#### The group walk

- The group core does not use the personal-pin verifier (`verifySuccessionChain`, which takes the list in the order served).
- That verifier never reads the group walk's verification cache.
- The group walk verifies each served link once per proof. It follows the verified links as a graph from the start keys (`succession-path.ts`, `succession_path.rs`).

**The proof depends on where the walk starts.**

| The walk starts from                                                         | A link needs                                                                                                                              |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| the member's first keys                                                      | up to the entry's keys, the successor's consent (2.8 below, `docs/identity-pq-design.md` 2); after them, its version 2 signature suffices |
| the entry's keys (the roster lag), a reader's personal pin, or `foldInEntry` | the version 2 signature under the old keys the link names suffices, as for personal pins                                                  |

A consented link's version 2 signature is never checked.

**The cap.** Only links that could join the member's chain count toward the cap. Those are links whose old keys are the walk's start, a key set the chain lists for the member, or a link the walk already followed.

- More than 64 of them are checked no further (`too-many`).
- Links with any other old keys are never verified and never counted.
- The member's own keys are public, so a server can always serve 65 junk links from them. On the lag and pin walks `too-many` therefore reads as links that did not load, never as a fork:
    - the entry's key stays current;
    - nothing is retired;
    - a signature under an unknown key reads `unchecked`.
- So junk from keys the member never held suppresses nothing.
- Junk from their own keys costs retirement and the verdict on keys only their chain would vouch for. It never costs the verdict on records under the entry's key.

**The verification cache.**

- It is keyed by the SHA-256 of the member, the proof and the link's fields, named one by one. No serialization hook or field order can make two links share an entry.
- It holds at most 4,096 results, the least recently used dropped first.
- It is locked only to look up or store, never while a link is verified.
- Callers may pass one per session (`groupWriterTrust`'s `verified`, Rust `SuccessionCache`), so each record read does not verify the same links again.

**What changes no verdict:** junk served before, between or after the member's own links, links out of order, and duplicates.

**Otherwise the walk keeps the strict verifier's rules.**

- It starts only at a link naming the start's X25519 and Ed25519 keys and its ML-DSA key by digest.
- Versions only rise along it.
- It ends only at all four served keys.
- The served identity's key version is not signed. So the walk never reads it, and neither does the conflict decision below.

**Rollbacks (`stale`).**

- A verified link leaving the served keys means the server serves an identity the member has already replaced (a rollback).
- The walk says `stale`, and the record reads `unchecked`: neither verified under the stale key nor bad under the newer one.
- `stale` fires only when the walk passes through the served identity. Its start is included: the server serving the entry's keys while a link the member signed leaves them.
- A link leaving the served keys that the walk never reaches changes nothing.

**Also:**

- A personal pin older than the member's first keys on the chain retires keys from the pin on.
- The work is one verification per link and one step per link.

#### Identity forks

Two verified links leaving one of the member's key sets for different keys mean two successors the member signed from one identity. Nothing tells which is theirs now.

- On the walk from the entry's keys or from a personal pin:
    - their records in the group's areas then read `unchecked`, whatever order the links were served in and whether or not the reader pinned them;
    - their seals open only under their entry's own keys.
- How it happens: two of the member's devices succeed at once, or a device retries a succession with freshly made keys.
- The server stores one link per old key (the second gets `stale`). But it has seen the second, signed, and a server that serves both later forks the member on purpose.
- That costs verdicts (a denial), never a forgery.
- Making `createSuccessor` reuse a pending successor on retry is out of scope for milestone 1a.

**On the walk from the first keys**, a fork (or a rollback) voids only that walk's retirement, never the member's verdicts.

- Whoever holds the first keys can mint two consented links leaving them: a holder who planted them, or whoever provisioned the member's first device.
- Otherwise they could turn every record of the member, forgeries included, to `unchecked`.
- A genuine fork before the entry then costs only the retirement of the keys before it. Those read bad-signature, the conservative outcome.

#### Planted keys

- A malicious `members` holder who writes keys they hold into a member's entry vouches for them while that entry is the latest. That is the existing insider power to swap a member's keys.
- Once the entry is put right, the planted keys read as nothing:
    - a link the planter signs from them to the member's real keys starts no chain, since chains start only from the member's first keys;
    - so no record under them reads as retired;
    - and no seal signed with them opens (2.4).

#### Successor consent, only where it buys something

From a member's first keys up to their entry's, the walk follows a link only when the new keys it names co-signed it.

**Why there.**

- Without that, keys planted as a member's _first_ entry (where every chain starts) could bridge to the member's real identity.
- The planter would sign a link from the planted keys, the walk would cross it, and records and grants under the planted keys would read as the member's (retired-key, or a grant that opens).
- The planter holds the planted keys but not the member's. So the consent half under the new keys is the one thing they cannot make.
- A link without it (one-sided, or with only the planter's half) is refused there. A record under the planted keys reads bad-signature.
- A self-consented link from the planted keys to keys of the planter's own (both halves his) is a valid edge. But it never reaches the entry, and retirement from the first keys stops at the entry. So the planted keys still read bad-signature.

**Elsewhere consent buys nothing.**

- A personal pin from the reader's own words check is the reader's own anchor. One trusted through a group is not (above).
- The roster-lag walk and `foldInEntry` start at the entry's current keys. A planter already vouches for those (a stated residual), and from them he could consent to his own successor anyway.
- There the version 2 signature suffices. So every honest rotation a shipped client signed keeps its verdicts: verified on the lag, and no false key conflict for a pinned reader after a fold-in.

**What it costs.**

- The web uploads `consent` with every succession and backfills the account's earlier links (`docs/identity-pq-design.md` 2). iOS and Android do not send it yet.
- For a link without consent (one a native app made, or one from a version 1 identity, which cannot carry it):
    - a member whose entry has moved on from their first keys does not have those pre-entry keys retired;
    - and seals they made under them do not open through history.

#### Withholding links

- A server can serve a member's identity with their links withheld, or cut short. Their genuine records under keys it hides then read `bad-signature` in group areas. With no links served at all, they read `unchecked`.
- A pinned reader's verdict is then `key-conflict`.
- So `bad-signature` there can be server-triggered, which the readers' copy says ("couldn't verify this signature").
- A writer statement that names its signing key (the planned writer upgrade, `docs/identity-pq-design.md` 7) would let an unknown key read `unchecked` instead.

#### What that costs

- Only a member's first keys on the chain start a chain.
- A member who started over without a succession link (their entry rewritten from a new words check) leaves those first keys with no chain to their current identity.
- So records they signed and seals they made under any key but their current one (or a successor no roster has folded in yet) read as bad signatures or stop opening. That is:
    - everything from before the restart;
    - and, once a later identity of theirs is folded in, what they signed with the restarted keys too.
- What they sign with their current keys is unaffected.
- Re-sealing what is still needed is the remedy. A version 3 identity succession that binds its predecessor would make the restart itself a link (future work).
- A signature none of the member's known keys holds is:
    - a bad signature when their served identity and succession links loaded;
    - `unchecked` when either did not, since the key it needs may be one their chain retired.

### 2.9 Guardian seals (child accounts)

**Not in milestone 1.** This section is the plan for child accounts, a later milestone. The code, fixtures and tests for guardian seals were removed from milestone 1 (2026-10-16). Nothing below is built.

A child account's root is sealed to each guardian with the suite 4 construction:

- HKDF `info`: `hushos/account/guardian-seal/v1`.
- Associated data: the statement without its digest.

```
["hushos/account/guardian-seal",1,groupId,childUserId,childRootVersion,guardianUserId,guardianKeyVersion,sealerUserId,sha256(sealed)]
```

- `groupId` is the family whose roster named the guardian. A seal made through one family's roster does not open as another's.
- The sealer is the child's own device.
    - It seals only to entries with the `guardian` role, `active`, on a family roster it verified after the family was checked at sign-up (3.6).
    - So neither the server nor a roster without that role picks a guardian.
- A guardian opens a seal only while active with the `guardian` role on a verified family roster, and only if the sealer is the child.
    - The child's own status on the roster is not asked. A `members` holder marking the child left would otherwise lock the guardians out.
    - Release and conversion re-key the account instead.
- **Adding a guardian later** needs an explicit act on the child's device, which seals to the new guardian after verifying their roster entry.
- `childRootVersion` is the child account's root revision.
- **A guardian's identity succession** makes the child's device re-seal to the new key on its next sign-in, deleting the old seal.
- **A guardian removed** from the family, or from the `guardian` role, makes the child's device run a full re-key (3.6) on its next sign-in, since that guardian once held the root.
- **The record** shows each time a guardian's device fetches a seal. Guardian clients drop an opened child root when the session ends. A modified client could keep it, and the record cannot show that.

### 2.10 Roster format 2: area roots and retired areas

Roster format 2 does two things in one reviewed change (owner decision, 2026-10-17):

- every new area version also commits to the key of the area's **root** (closing F14);
- an area can be **retired** by a tombstone row (closing F11, so a family folder can be deleted).

Everything else in 2.4 to 2.6 holds as written. Only the `areas` rows and the statement's version change.

```
["hushos/group/roster",2,groupId,kind,rosterVersion,previousRosterDigest,groupKeyVersion,signerUserId,members,areas]
members = as format 1
areas   = [[workspaceId,workspaceKeyVersion,"key",commitment,rootCommitment] | [workspaceId,workspaceKeyVersion,"retired"], ...]

rootCommitment = HKDF-SHA-256(ikm = rootNodeKey, salt = 32 zero bytes, info = "hushos/group/area-root/v1", length = 32), base64url
```

- **The statement's version is the format.**
    - Format 1 is `["hushos/group/roster",1,…]` with three-field rows, exactly as shipped.
    - Format 2 is `["hushos/group/roster",2,…]` with tagged rows.
    - The signatures cover the version, so a statement of one format never verifies as the other.
    - Rows are still sorted by workspace id, one per area, at most 1,024 (`MAX_ROSTER_AREA_ROWS`, retirement rows included).
    - Every field keeps the canonical encoding (2.1). The tag is the literal `"key"` or `"retired"`. A key row has exactly five fields and a retirement row exactly three.
- **The root commitment has its own label.**
    - `hushos/group/area-root/v1` is not the area key's `hushos/group/area-key/v2`. So a root key and an area key never share a commitment even when their bytes are equal, and neither can be passed off as the other.
    - Like the area key's, it is of the key alone and reveals only whether two root keys are equal.
    - It is not in either twin's exports to apps. `nextRoster` and `firstRoster` compute it from the root key they are given, as they compute the area key's.
- **What it commits to.**
    - `rootNodeKey` is the 32-byte node key of the area's root folder at that area version. It is the key the root's own key envelope holds (context `hushos/drive/node-key`, `parentKeyEpoch` = the area version).
    - A new area's row carries its root's first key.
    - A rotation's row (route 24, or a family roster's rotations) carries the root's new key, the one sealed in the same call.
    - The root's previous envelope (option A, `hushos/drive/previous-root-key`) holds an earlier root key and is never compared with the commitment.

#### The format on a chain

- A chain may switch from format 1 to format 2 at any roster, version 1 included, and **never back**.
- A format 1 roster after a format 2 roster is refused by acceptance (`This member list is in an older format than the one before it.`), by `checkNextRoster`, and so by the server.
- `nextRoster` builds the chain's latest format unless asked for a higher one, and refuses a lower one.
- `firstRoster` builds the format it is asked for.
- Old format 1 chains verify unchanged in both twins. So a device that verified a format 1 chain and caches it continues from that cache into format 2.

#### Root commitments

- The server also refuses (`invalid` (`area-commitment`)) any area key or root commitment another group's stored roster listed (`group_area_commitments`). So no family folder's key or top-folder key is ever another group's.
- Acceptance refuses a format 2 key row whose root commitment the chain listed before, in any area at any version, or twice in one roster. That is as it refuses a repeated area key commitment (one set lookup per row, `rootCommitments` beside `commitments`).
- Why: a rotation that keeps the root's key would leave the removed member able to open the root. The commitment makes that hollow rotation visible to every device.
- The accepted chain keeps every version's root commitment (`AcceptedRosters.areaRoots`, cached). It is `null` for a version a format 1 roster listed.

#### Readers decide an area root is current from the commitment, not from "the envelope opens"

The crypto worker opens the root's own key envelope under the area key at the area's write version (`areaWriteVersion`), as before. It then asks `checkAreaRoot(chain, workspaceId, workspaceKeyVersion, rootKey)` (Rust `area_root_check`):

- **The chain lists a root commitment for that version:** the opened key must have it, or the root is not current.
    - The worker then refuses to write in the area and reads the root as couldn't-check.
    - A server that rolls the root back to an earlier key wrapped under the same area key version (one a revoked share recipient holds) is caught here, whatever the envelope opens to.
- **The version was listed by a format 1 roster (`null`):** the previous rule stands (the envelope opening under the write version). F14's residual remains for that area until its next rotation lists a root commitment.
- **The version is not listed, or the area is retired:** refused.

A root commitment binds only the root's key. The node id, area and area version are bound by where the roster lists it and by the root envelope's own context.

#### Writes need a path rooted at the committed root

**The threat.** Option A's previous-root envelope keeps the root's previous key openable after a rotation. So a server colluding with a removed member could:

- serve a folder's pre-rotation envelope;
- say no walk is running;
- and have devices write new children under a key the removed member holds.

**Rooted keys.** The worker therefore tracks, for every node key it holds in a group area, the area key version its path is rooted at.

- A path is rooted at a version when the root opened under that version, and each child under its parent's current key.
- A key reached through any previous key is rooted nowhere: the previous-root envelope, a parent's previous key, a walk's old key.

**Writes.**

- A write in a group area needs a key rooted at the area's write version. Writes are: a new node, an upload or new version, a rename, a share or link, a move's re-wrap.
- So keys rooted nowhere, and keys cached under a root a rotation replaced, read but write nothing.
- A folder takes writes again once the walk re-keys it under the new root.
- Reading old content through the previous root stays allowed.

**What the upload queue sees.**

- `KEY_CHANGE_PENDING`, the worker's refusal, is a wait to the upload queue, as the server's 409 `rotating` is. So an upload into such a folder waits for the walk even when the server says no key change is running.
- A write in a folder this device last opened under an earlier area version than the committed one waits this way, until the next listing roots it at the committed root.
- These answer "keys changed" (`KEYS_CHANGED`) instead:
    - a folder never opened;
    - a server whose area version is behind or ahead of the chain;
    - a top folder whose key doesn't match the root commitment.
- A server can flip a device between the two, serving a mismatching root and then the old one again. That only denies writes: no key a removed member holds becomes writable.

**A walk is held to the same rule.**

- Its fresh key is a write like any other. Its parent must be re-keyed earlier in the same walk or rooted at the write version.
- The fresh key is rooted where that parent is. So a server that leaves a folder out of the walk cannot have a device wrap a fresh key under the folder's old key (which the removed member may hold) and then write under it.
- A walk's pending key also takes nothing once the area's next roster has landed, since it is rooted at the version before.
- A walk's re-wrap of a node already at the target carries only a key already rooted at the write version, under a parent that is too.
    - A key reached through one the rotation replaces is refused (`NOT_CARRIED`).
    - Why: a removed member and the server can plant a node at the target under a folder's old key, with a key of the member's choosing. A re-wrap would carry it into the new tree, where every device then roots it by its envelope's path.
    - An honest walk never needs to carry such a key. The target is above every epoch a node carries (`startRotation`). While it runs, the server refuses nodes made or moved under a folder the walk has not reached (`underUnrotatedParent`). So a node at the target always sits under a parent already re-keyed.

Personal workspaces keep their previous rule.

#### The root's key changes only with a roster

- For the commitment to describe the root, the root's node key in a group area may change only together with an area version on the roster.
- So the server refuses a Drive rotation started at a group area's root on the Drive routes (403 `forbidden`: "Replace this family folder's keys from the family page instead.").
- It also refuses the root as an item of any Drive rotation batch (`forbidden`), even during the walk a roster rotation started there. The batch's re-wrap check compares a node epoch with an area version and could not tell.
- A rotation started at a folder below the root is unaffected.
- A roster rotation (route 24, or a family roster's) is the one way to re-key the root.
- Before format 2, a holder's Drive rotation of the root was allowed. It looked like a roster rotation to every device's walk (`docs/groups-server.md` 8, "Walks no longer claim authorship"). That case is gone.

#### Retired areas (tombstones)

A retirement row `[workspaceId, workspaceKeyVersion, "retired"]` stands at the area's next version (the latest version the chain lists, plus one) and carries no key. The rules (`checkAreas`, Rust `check_areas`):

- **Who writes one.**
    - A roster is signed only by an active `members` holder (2.4), so only managers retire areas.
    - The server adds that a retirement comes only through the delete route (4): exactly one row, for the area that route names.
    - That roster changes nothing else: no entry, succession, rotation, grant or seal (`invalid` (`area-delete`)).
- **It must retire something.** Refused: a retirement row for an area the chain has never listed, at a version other than latest + 1, or for an area already retired.
- **No revival.**
    - After the tombstone, any row for that area is refused, at any version: no rotation, no new key, no second tombstone.
    - Its workspace id stays spent for good.
- **No grants.**
    - `sealAreaGrant` refuses every version of a retired area, and the server refuses grants naming it.
    - Grants made before still open (`openAreaGrant` checks a key against the version the chain listed, which stays listed), since a reader may still hold files under it.
    - Nothing is ever served from it again (below).
- **No writes.** `areaWriteVersion` is `null` for a retired area, so no client writes there.
- **Removals skip it.**
    - In a family, a roster that marks someone `left` must rotate every area the chain has **that is not retired**. An area this very roster retires counts as handled.
    - `areasToRotate` lists only those.
    - Retiring and then removing leaks nothing new. The removed member already held the retired folder's keys (every member opens every family folder). From the tombstone on, nothing is written, granted or served under those keys by any honest device or the server. So skipping its rotation leaves them only what they had the moment it was deleted.
- **It does not count.**
    - `MAX_FAMILY_AREAS` counts live areas (listed and not retired) after the roster's own rows. So a family at the cap that retires one can create one, and a removal still always fits one roster.
    - The server's `GROUP_AREA_LIMIT` counts live areas the same way.

**The cache.**

- It keeps the retired areas (`retiredAreas`, sorted) beside `areaKeys` and `areaRoots`, and says its own format (`cacheVersion` 2, both twins).
- On input, the last roster's rows must agree with them as for key rows:
    - a key row's commitment and root commitment (or `null` for a format 1 row) are its area's last;
    - a retirement row's area is retired one version above its last key.
- A version 2 cache must list every area's roots. An emptied list is refused, never read as uncommitted.
- A cache with no version was written before format 2. It carries neither field, and reads as no root commitments and no retired areas, which is what it described.
- A reader asked about a version with no root entry at all refuses. Only an explicit `null` reads as uncommitted.

#### Deleting a family folder

3.3, 4.

1. A manager's client builds the next roster with the area's tombstone (`nextRoster(chain, members, { retireAreas: [workspaceId] })`), signs it and sends it on the delete route.
2. The server stores the roster and marks the area deleted in the same transaction (`workspaces.deleted_at`).

From then on the server serves it to nobody:

- it leaves `GET /api/drive/spaces`;
- every Drive route answers it as not found;
- the group routes refuse it (grants, self-grants, rotations, the root and its previous envelope);
- its grants and self-grants are no longer served;
- shares and links in it are revoked;
- it stops counting toward `GROUP_AREA_LIMIT`.

**Retention and purge.**

- Its files are kept 30 days, exactly as Drive keeps a trashed node (`TRASH_RETENTION_DAYS`).
- They are kept longer while any open or held report names the folder. The purge skips it, as the deletion outbox keeps a reported object.
- Then the worker's purge deletes its objects from storage and its rows (nodes, versions, grants, documents, rotations, the workspace row), releasing its storage.
- Until then its bytes still count toward the family's storage pool (`freeBytes`). They are still stored, and a folder deleted when full must not free room to fill another while they are.
- An upload still completing in it is released, not published, when the expiry job finishes it (`finishCompleting`).

**No restore.**

- Within those 30 days nothing restores it. The tombstone is final on the chain, so a restore would need a new area.
- What the 30 days buys is only Drive's usual retention before anything is destroyed. It also leaves room for a read-only Trash listing later, since earlier grants still open to the keys the chain listed.
- Nothing in this release reads a deleted folder within it. The server cannot, since it holds no key.

**What the dialog says:**

- the folder disappears for everyone now;
- its files are deleted from the server, normally after 30 days, and their space freed when they are;
- anyone who kept copies or keys keeps them, as after a removal. Deleting destroys no key: members' devices and earlier grants still hold the folder's keys;
- the folder cannot be restored (3.3).

It does not promise the files are gone at day 30. A report's hold keeps the folder past it (below), and a storage replica deletes its copy on its own later schedule.

The family's Trash page does not list a deleted folder. It lists what each live folder's own trash holds, and a deleted folder is no folder any more.

#### Compatibility

- When format 2 shipped, only the web verified family rosters (and the server, through the same TypeScript core).
- The iOS and Android apps then had no families, called no group route and never parsed a roster; they carried a contact pin's `trustedVia` and nothing else of groups. So no shipped phone app had to read format 2.
- The Rust core reads and builds both formats now, so the phone apps' families (1d) start on format 2.
- The web writes format 2 from a family's first roster and on an existing family's next roster.
    - Every client that reads family rosters is the web this same server serves.
    - So the release that writes format 2 is the release that reads it.
- A tab still running the previous release refuses a format 2 roster ("Invalid roster.") and treats the family as unchecked until it reloads. The release notice (`release.ts`) offers that.
    - Its device cache, if a newer tab already wrote one through a format 2 roster, is refused the same way. It is accepted again from version 1 after the reload.
- Families are on by default only since #46 (`GROUPS_ENABLED`), so few stored chains are format 1. They verify unchanged and switch to format 2 at their next roster.
- Format 1 stays verifiable for them, for development data and for caches written before this release.
- Area versions a format 1 roster listed keep the envelope rule (F14's residual) until their next rotation.

## 3. Flows

### 3.1 Creating a family

The organizer's client:

1. derives the group id;
2. makes the group key;
3. signs roster version 1 with only the organizer (roles `billing` and `members`). No `guardian` until child accounts exist (3.6); granting it then is a role change on a later roster;
4. seals the seed to itself;
5. calls `POST /api/groups`.

Creating the first shared area ("Family") is part of the same flow.

**The first roster** comes from `firstRoster` (Rust `roster_first`).

- It takes the creator's own entry (`ownRosterEntry`, Rust `roster_entry_own`). That entry comes from the account's own current identity as its device opened it, whose keys statement must hold.
- An entry naming keys the creator does not sign with fails acceptance's signer check.
- It takes the first area's key and computes the area's row.
- It refuses anything acceptance would refuse of a roster version 1. So a creator never signs one the group cannot take.

**Staged, then committed.**

- The client accepts that roster as a staged chain (2.4) to seal the seed and grant the area against.
- It does so with the `created` anchor over the keys it just made (2.4). That is the only place besides the join path that passes an anchor.
- It holds the group as committed only from what the server serves once the call succeeds.

**The own-entry check before sending.**

- Before it sends the call, `groupCreate` runs that staged acceptance with the account's own identities freshly fetched (`me.identities`).
- It refuses to POST unless that reports empty `ownEntryWrongAt` and `ownEntryBehindAt`.
- Why: `ownRosterEntry` proves only that the entry and roster version 1's signer are the same identity, not that it is the account's newest. A device that missed its own succession would otherwise found the group on a replaced identity.

### 3.2 Joining (invitation, acceptance, admission)

1. **Invite.** A `members` holder invites an email address. The server mails a link with a one-time token in its fragment (`/join#invite=<token>`), hashed at rest as sign-up tokens are.
2. **Accept.** The invitee signs in or signs up, opens the invitation and accepts. Membership moves to `accepted`. Nothing opens yet, and no seat is taken.
3. **Let them in** (`docs/optional-verification.md` 3.2; the web's screens are PR 4).
    - The manager's device looks up the newcomer's served identity and checks its keys statement.
    - Holding no pin of them, it writes a first-seen pin. The roster entry is built from that pin (`newRosterEntry`, Rust `roster_entry_new`, take a verified or a first-seen pin, never one trusted through a group).
    - One click signs the next roster with the newcomer added, seals the shared areas' keys to the newcomer (and the group seed, if they get `members`) and calls admit with them.
    - The admitting roster never removes a key holder (the core refuses it, 2.4). A removal goes first, with its succession.
    - A retry resends the same bytes, never a re-signed roster.
    - On 409 `stale` (another roster was stored at that version), the client discards the unsent roster and signs a new one over the new head.
    - The server applies membership, roster, grants and the seat in one transaction.
    - A manager who wants to check first can still compare the newcomer's twelve words before letting them in. That writes a verified pin the entry is built from.
    - **Until the manager rule ships** (3.6 of the optional-verification design, with PR 4's screens), the worker and the core's ledger still admit only over a verified pin (`stage`, `admit_body`). So no role is handed to keys nobody checked.
4. **The newcomer's device joins on first use** (2.4). On its next sync it finds its entry active at the head. Then it:
    1. verifies the chain from version 1 with the `first-use` anchor, in the acceptance `groupJoinFirstUse` / `join_first_use` makes, which commits nothing;
    2. seals that acceptance's pin into the version 4 joins record;
    3. commits through `groupAccept` / `accept_joining`, holding that pin as one more mark, with no anchor;
    4. writes the family guard;
    5. writes the device record (its cache and pin);
    6. writes the settings pin;
    7. deletes the joins record.

    From then on the pin, the cache and the guard are marks. A fork, a rollback, another group key at a pinned version or a removal withheld past the pin are caught as for any member.

5. **Either side can check later** with the pair code (2.4), from both screens alike. It saves a check record and (when the keys agree) a verified pin of the other.
6. **A newcomer on iOS 0.10.0** waits for the old join code instead.
    - The manager reads it from the one-way path (2.4, "Older apps").
    - The phone compares ten words and types the two its screen hides (the join code flow below).
    - Nothing is written on the manager's side.
    - Making that member a manager needs their personal twelve words.

    The join code flow stays in the core for them and for child accounts (3.6):
    - **Showing the code.** Once admit has succeeded, both screens show the join code of the roster at which the newcomer's entry last became active (2.4).
        - The admin's client works it out from its committed chain after re-syncing, so over the stored roster.
        - The newcomer's client works it out over the chain route 5 serves, verified from version 1, keeping nothing (`groupJoinPreview`). It verifies against their marks if they have any; else over the served version 1 keys on first use, for the code only.
    - **Comparing.** The admin reads all twelve words. The newcomer's screen hides two, at positions the newcomer's device picks at random for that showing and never sends anywhere. The newcomer checks the other ten and types the two.
        - Guessing them is 22 bits, at positions the server does not know.
        - The ten compared words are the defence against a server grinding a made-up family.
        - The positions are the ones the newcomer's device issued for that showing. After a wrong word they stay the same for that code until the page is left.
    - **"They match".**
        - The newcomer's client works the code out again over what route 5 serves now. Another code keeps nothing, and is the one to compare.
        - Then the two typed words must be the code's at the hidden positions, or nothing is kept.
        - Only then does it record the code in a sealed joins record (version 4 with `joinMark`, so a reload finishes the join; a version 3 record from an earlier release is read alike), and accept the chain:
        - It accepts the chain from version 1 with the code as the join mark (the `join` anchor when there is no other mark, 2.4).
        - Then it writes its cache and pins the group.

**What first use costs** (`docs/optional-verification.md` 4.2, in full there and in the threat model):

- A manager who lets someone in without a check seals every family folder's current keys to whatever keys the server served as theirs.
- A newcomer whose device has no mark takes whatever version 1 keys and members the server shows, and can be kept on a family the server made up.
- A brand-new device of an existing member with withheld settings and no guard can be started on a made-up family through a fresh invitation.

What limits it:

- The guard (2.7) refuses first use on any device that ever kept the family.
- A check (2.4) finds what nobody compared.
- Neither undoes what was sealed before.

### 3.3 Leaving and removal

- **Leaving.**
    - The member calls leave. Their membership becomes `left` at once, and the server stops serving them the group's areas and grants.
    - The next `members` holder to open the group signs a roster marking them `left` (the server reports it as due).
    - In a family that roster carries the rotation of every area in the same statement (2.4; the core refuses it otherwise).
    - The holder's client uploads it with the rotations and the new keys' grants to every remaining member in one call.
- **Removal.**
    - A `members` holder removes someone with the next roster in the same call. In a family it carries every area's rotation and the new grants, as above.
    - In a company the roster does not say who opens what. So the rotations of the areas the person could open stay queued, each listed on a roster first (2.6).
- **A `members` holder leaving or removed** also makes a group key succession due before the next roster (2.5).
    - The roster that marks a holder `left` is signed by another holder who stays. The core refuses a signer who leaves on their own roster.
    - No roster may leave the group without an active `members` holder. The last holder hands `members` on first.
- **A family member who leaves keeps their files.** Their personal space was always theirs.
    - They lose the family folders.
    - Their personal space moves from the family pool back to their own allowance (3.5).
    - Over it, uploads are refused until they make room or buy a plan. Nothing is deleted.
- **The organizer** must hand `members` and `billing` to another adult member before leaving.
- **Dissolving a family** deletes its shared areas 30 days later (below). Personal spaces are untouched. Only its last member is left to tell, and they and anyone still joining it are emailed (below).
- **Deleting a family folder** (2.10).
    - A `members` holder chooses "Delete family folder" in the folder's row menu and confirms.
    - Their client signs the next roster with the folder's tombstone and sends it on the delete route.
    - It is gone for everyone at once: no member's spaces list it, no Drive route serves it, shares and links in it are revoked, nothing more is granted or rotated there.
    - Its files are kept 30 days as the trash keeps things, then the worker purges them.
    - A member whose client still has the folder open gets "not found" on their next request.
    - A family folder cannot be deleted while someone who left is still to be marked left (409 `left-due`). That roster rotates every live folder, which the delete route does not carry.
    - Nor can it be deleted while a removal's succession is due.

#### Dissolving and the purge

As built, 20 October 2026.

**Dissolving.**

- The last active member leaving (or deleting their account) dissolves the family.
- `groups.dissolved_at` is set. In the same transaction, every family folder is retired as deleting one retires it (2.10: `deleted_at`, no rotation due, shares and links revoked).
- From that moment nothing reopens it:
    - every chain write, leave, invitation and acceptance refuses it (`lockGroup`, `createInvitation`, `openInvitation` and `acceptUnder` all read `dissolved_at`);
    - no space lists it;
    - Drive serves its folders to nobody.

**The folders' purge.** The folders then go the way any deleted family folder goes.

- 30 days later Drive's purge job (`purgeDeletedAreas`) queues their objects on the deletion outbox.
- It deletes each workspace row with its nodes, versions, origin drops, rotations, grants, self-grants, documents and storage row.
- It skips a folder an open or held report names, until the report lets go.

**The group's purge.** The worker's `groups.purge-dissolved` job does the rest.

- It retires the folders of a family dissolved without that (by a container of the previous release during a rollout), as of now, never as of its dissolve.
- It deletes the group row, with its memberships, rosters, successions, seals, invitations, departures, holds, chain cache and pool, once all of these hold:
    - it was dissolved more than `DISSOLVED_FAMILY_RETENTION_DAYS` ago (30, the trash's period, long enough to look into a dissolve made by mistake);
    - none of its folders is left (so a report on one holds the family's records too);
    - with billing on, none of its subscriptions can still become active: anything not ended, `canceled` or `incomplete_expired`. A plan set to cancel runs to its period's end, and its folders still go on time;
    - with billing off, it never had a billing customer. One that did waits for a run with billing on.
- That last check is a statement of its own after the group's row is locked, since billing writes a subscription holding that row.
- Families dissolved before the release get 30 days from the upgrade. Its migration retires their folders and sets `dissolved_at` to the upgrade time.

**A dissolved family's plan.**

- A plan of a dissolved family that can still charge is set to end at its period's end by the worker's `billing.cancel-dissolved` job (`cancelDissolvedPlan`). The leave route and every `reconcileGroup` queue it.
- It is never revoked or refunded. The payer keeps what they paid for, as when they cancel (3.5).
- The prorated refund of `docs/families-shared-pool.md` 5.1 is for a personal plan ended early, not this.
- Each plan is set under its change claim and read again first.
- One resumed in the portal is set to end again, every time. A resume is the payer's own click; nothing loops.
- Its payer is emailed the date once per plan per period, once the plan shows as ending. So a set whose answer was lost, or a mail that failed, is mailed by a later run.

**Errors.**

- Only 403 `InactiveSubscription` is a refusal.
    - It is recorded with the plan's state, logged at error level and listed for operators until the plan is set to end.
    - It is not asked again until the state changes.
- Every other error is retried: 409 `SubscriptionLocked` during a renewal, a token error, 402, 422, 429, 5xx, a timeout.
- The first failed run is recorded (`dissolve_failing_since`).
- A plan no reconcile has seen ending a day later (at once within two days of its renewal) is listed for operators as failing. So a failure Polar always repeats is not retried unseen while the plan renews.

**Plans that can still charge but aren't live.**

- `paused`, `unpaid` and `incomplete` count as able to charge.
- Billing's full reconcile records every subscription Polar answers for, with Polar's own status and `ended_at`.
- It ends only one Polar no longer has (404) or answers as `canceled` or `incomplete_expired` without an end.
- So the job and the purge see such a plan until Polar ends it (3.5, Polar's statuses).
- Polar sets only an active plan to end, so the job revokes such a plan (the family `revokeLapsed`): its ending first, a payment taken afterwards refunded whole. Nothing paid for it is in force.
- A revoke Polar refuses is recorded with the plan's state and listed for operators as `dissolved-inactive` until it has ended, since the purge waits for the end.
- A scheduled change given up on (`reissue_gave_up_at`) is listed only while its plan is live.

**What the purge keeps.**

- The family's billing records (`group_billing_customers`, `group_billing_subscriptions`, `personal_plan_endings` and refunds, by the group's id). Those tables no longer have a foreign key to `groups`.
- Reports and their snapshots.
- The deletion outbox's rows.
- `group_area_commitments`, so no key the family used is ever another group's.

**Reusing an id.**

- `createGroup` refuses (`taken`) an id that any area commitment or billing record still names. So a resent creation call cannot make the same family again.
- One whose first roster listed no folder key and that never had a billing record leaves nothing naming its id. Only its creator could make a new, empty family under it (every family the clients make lists one).
- Each family's row is deleted under an advisory lock keyed by it, so two runs never work on the same family at once.
- A plan of a purged family that Polar bills again (reinstated or resumed) is revoked by the next `reconcileGroup` that finds no group row for `group:<id>`. What it took after that plan had ended is refunded whole by the plan-ending job (docs/self-hosting.md, Dissolved families).

#### The emails

As built, 26 October 2026.

**In the dissolving transaction** (`depart`, so a refused, previewed or rolled-back leave writes nothing):

- every acceptance not let in becomes `removed`;
- every invitation still open and unexpired is revoked;
- then, only with `GROUPS_ENABLED`, a row in `group_dissolve_notices` is written for:
    - the last member (`dissolved`);
    - each of those acceptances (`accepted`);
    - each of those invitations (`invited`).
- At most one per address.
- A row names the account or the invitation, never an address, and goes with either. So a last member who deleted their account is owed nothing.

**Sending.** The worker's `groups.dissolve-notices` job runs every minute, only with `GROUPS_ENABLED`.

- It reads each row, then claims it by a conditional update before handing the mail over. So two runs never both send one.
- A send that fails gives the claim back and waits 15 minutes (`retry_after`).
- Each run takes emails never tried first, then those that failed, by `retry_after`. So addresses that keep failing fall behind newer ones.
- A send whose provider reply was lost may go out again.
- The run goes on and stops after three failures.
- A crash between claim and send loses that mail.
- A row unsent after 7 days is left for the purge.

**What they say.**

- The last member is told the earliest day the family's folders are deleted: the latest `deleted_at` among them plus the retention Drive's purge is given (`TRASH_RETENTION_DAYS`), in UTC. Their own files are untouched.
- The others are told the family no longer exists and nothing of theirs changed.
- Nobody else is emailed. The family has no other active member, and its payer has the plan-ending email.

### 3.4 Spaces

`GET /api/drive/spaces` lists the account's personal space and every group it is active in, each with the areas it can open and their grants.

Clients switch between spaces:

| Client  | Spaces                                                                                |
| ------- | ------------------------------------------------------------------------------------- |
| Web     | a switcher at the top of the sidebar, and the space in the URL, `/app/s/<space>/…`    |
| iOS     | one Files location per space, each tied to its owner as the 13 October Files fix does |
| Android | one provider root per space                                                           |

Leaving a space wipes its local state on every device.

#### Shares inside family folders (proposed, not in 1c)

**Today.** The web hides Share and links in family folders in milestone 1c, and the server refuses them there (409 `family-sharing`).

**Why.** A Drive walk re-seals a node's shares and links under its new key only when the walker can tell that each was made by someone entitled to make it, to keys that person vouched for.

- In one's own Drive, that is the owner's sealed sharing ledger.
- In a family folder the ledger is each member's own. So a manager's walk after a removal can re-seal only the shares the manager made, and every other member's share is closed silently.
- Re-sealing what the server lists instead would let the server add recipients.

**The proposal: share records signed at family level.**

- A member who shares a node in a family folder signs a share record, hybrid, under their identity, and stores it beside the share:

    ```
    ["hushos/group/share",1,groupId,workspaceId,nodeId,granteeUserId,granteeKeyDigest,role,granterUserId,granterKeyVersion]
    ```

- A walker re-seals a share only when its record verifies:
    - under a granter who is active on the member list the walk is judged by (the staged one for a removal's rotation);
    - to the grantee keys the record names (checked against the served identity).
- It drops the share otherwise.
- A link carries the same kind of record over its link id.
- Revoking deletes the record with the share, so a revoked share cannot come back through a walk.

Open:

- whether a member without `members` may see others' records (they name outsiders);
- records for shares made before the change (none exist: Share is hidden until this lands).

### 3.5 Storage and the payer

`docs/families-shared-pool.md` (decided 19 October) has the detail; this section was rewritten on 20 October 2026 to match it. The detail covers when someone is pooled, the lock order, admission, moves, and how a personal plan is ended and refunded. Where the two disagree, the addendum wins.

#### The pool

- **One pool per family.** A family plan's quota covers every member's own files (their personal space, My files) and every family folder.
    - `poolUsage` (`packages/db/src/pool.ts`) is the one count.
    - `freeBytes` for any workspace in the pool, `/api/auth/storage`, the family's billing summary and its downgrade and first-purchase guards all read it.
- **When a member's own files draw from it:** with Polar billing, while they are an active member of a family whose plan is live (until its period ends plus `BILLING_GRACE_DAYS`).
    - Without billing nothing is pooled. Members keep their own allowance and each family folder its own (addendum 8).
- **One family per account,** with billing or without, held by a unique index on active family memberships (addendum 4). Company memberships, later, are outside it.
- **One storage source per person.**
    - A member who pays for a personal plan stops paying for it when their files join the pool. The worker revokes it at Polar and refunds the unused days, prorated (addendum 5.1).
    - While pooled, buying or resuming a personal plan is refused (`409 in-family`).
- **No stacking:** the pool is the plan's size.
    - A member's free allowance, referral bonuses and operator grants are set aside while they are pooled.
    - They count again when the member leaves, is removed or the plan ends.
- **Leaving, removal, or the plan ending:** their own files go back to their own allowance.
    - Over it, they can read, download and delete. Uploads are refused until they make room or buy a plan.
    - Nothing is deleted, and there is no grace period, since nothing has a deadline.
- **Admission** refuses a newcomer whose own files don't fit in the pool's free space (`409 pool-full`), before any place is bought.
- **What managers see.**
    - The organizer and every `members` or `billing` holder see each member's own usage rounded up to the whole GiB ("Under 1 GB" below 1 GiB). Never names, counts or contents.
    - Every member sees their own exact usage, the family's total and the family folders' total.
    - Every figure about the pool, and every check against it, counts the pool in parts: the folders together, and each member's own files, each rounded up to a whole GiB. So no figure gives away one person's exact usage (addendum 3.6, 3.9).
- **Per-member limits** are deferred.
    - When they come they are one nullable column on `group_memberships`.
    - Until then one member's own files can fill the pool for everyone.

#### The payer and Polar

- **The payer** is a billing customer keyed by owner kind and id.
    - In Polar, that is a team customer per group (`external_id: "group:<groupId>"`) whose owner is the paying member (`docs/archive/polar-group-billing-spike.md` 5).
    - Polar products carry `hushos_plan`, `quota_bytes`, `hushos_group_kind`, `included_members` and, for a family tier, `hushos_tier` metadata.
    - Business products carry `quota_bytes_per_member`: a company's pool grows with each paid member.
    - Members beyond those included are a quantity on the group's one subscription: a unit-based price beside the fixed base, free up to the included members. There is no upper limit; companies have a minimum.
    - Polar never learns who the members are.
- **Polar's statuses** (decided 21 October 2026).
    - **Live:** a plan gives the pool and its places only while `active`, `trialing` or `past_due` with no `ended_at`. The pool lasts until its period ends plus `BILLING_GRACE_DAYS`.
    - `past_due` is Polar retrying a renewal, so it keeps them. The grace days cover a renewal that is late, not a payment that has lapsed.
    - **Not live:** these give no pool and no places from the reconcile that sees them, mid-period too. The family reads as having no plan.
        - `unpaid`: Polar's retries ran out, and its docs revoke benefits then;
        - `incomplete`: the first payment never went through, so nothing was paid;
        - `paused`.
    - They are still not ended. Polar may yet take a payment or a resume. So the mirror keeps each with Polar's status, the reconcile reads it again every time, and a dissolved family's job and purge wait for it (3.3).
    - **Ended:** a plan is recorded as ended only when Polar says so (`ended_at`, or `canceled`/`incomplete_expired`) or no longer has it (404).
    - A payer of a plan that isn't live can delete their account or dissolve the family, as one whose plan is set to cancel can.
    - **Revoking a plan that isn't live.** Its ending is recorded before Polar is asked, so a payment taken for it afterwards is refunded whole. It is revoked:
        - before a family checkout (once confirmed, after the payer takeover);
        - before its payer leaves, is removed or deletes their account;
        - by a dissolved family's job.
    - Kept instead: one whose current period Polar shows paid, and an `incomplete` one younger than a day (docs/self-hosting.md, Family plans).
    - **Personal plans** follow the same rule (docs/self-hosting.md, When a personal plan's payment fails). They are kept with Polar's status, giving nothing, and revoked by HushOS:
        - before a new checkout;
        - when their owner's files join a family's pool;
        - when the account is deleted.
- **A renewing plan whose payer is no longer in the family** (as built, 27 October 2026).
    - Beside the dissolved family's rule, the same job handles it (`billing.cancel-dissolved`, `cancelDissolvedPlan`). Every `reconcileGroup` queues it, and so the daily reconcile does too.
    - It sets to end at its period's end any live plan (`active`, `trialing`, `past_due`) that isn't set to end, of a family that isn't dissolved, whose payer on record (`group_billing_customers.payer_user_id`) is no longer an active member: they left or were removed.
    - Never revoked or refunded. The payer keeps what they paid for.
    - It is the backstop for every way such a plan comes to renew:
        - a resume Polar kept whose reconcile failed before the payer left on the stale reading;
        - a resume the payer made in Polar's portal after leaving.
    - Each plan is set under its change claim, read again first, and only while it still renews and its payer is still away.
    - The same retries, refusals and failing record as the dissolved family's apply.
    - The payer is emailed once per plan per period (the plan-ending mail, saying they're no longer in the family).
    - A family with no payer at all (their account deleted) goes through `revokeWithoutPayer`, as before.
- **One plan per family.**
    - One checkout open at a time (`group_checkouts`, held until Polar's checkout expires).
    - Two live plans anyway are cured by the reconcile. It keeps the plan the family already had (else the oldest), revokes every other and refunds what it took that bought nothing (docs/self-hosting.md, Family plans).
- **Billing handover** completes only once the new payer has added a card in Polar's portal. Until then the old payer stays the payer and is told so, since the card does not move with the subscription.
- **A payer's account cannot be deleted** while they pay for a group. They hand billing over or cancel the group plan first, and the deletion screen says how.
- **Seats** are counted at admission, never at invitation. A seat cut blocks new admissions and never removes anyone.

#### Family tiers

Owner, 2026-10-18. Pools are in 1024s, as the app counts.

| Tier        | Pool   | `hushos_tier` | A month, USD (EUR at parity) | A month, GBP | A month, INR | A year, USD or EUR | A year, GBP | A year, INR |
| ----------- | ------ | ------------- | ---------------------------- | ------------ | ------------ | ------------------ | ----------- | ----------- |
| Family Plus | 800 GB | `plus`        | 10                           | 8            | 399          | 96                 | 72          | 3,900       |
| Family Pro  | 2 TB   | `pro`         | 20                           | 16           | 799          | 192                | 144         | 7,800       |
| Family Max  | 4 TB   | `max`         | 30                           | 24           | 1,399        | 288                | 216         | 13,800      |

- **Members.** Four members are included on every tier, then 1.50 USD a member a month (15 a year), the same on each, up to 20 members.
- **Currencies.** EUR is at parity. GBP is at 0.8 (1.20 a member). INR is on the personal plans' ratio (59 a member).
- **A year** (owner, 2026-10-19; it was ten months before) is a round total that splits evenly into twelve. The member price stays at ten months a year.
- **Products.** Each tier is a monthly and a yearly product carrying `hushos_tier` (`plus`, `pro`, `max`) beside the metadata above. The catalogue orders them by pool.
- **The legacy plan.** The single Family plan before them (2 TB, six included, 15 USD) is archived once the tiers are on sale (`seed.ts --archive-legacy-family`), and still read for anyone on it.

#### Changing tiers

The payer changes tiers, between tiers billed the same way.

- **A bigger pool starts now.** The product is changed at Polar with `invoice` proration, so the difference for the rest of the period is charged at once, as a personal plan switch is.
- **A smaller pool starts at the renewal** (`next_period`).
    - Nothing is credited, since Polar's wallet credit cannot be paid out.
    - The family keeps what it paid for until then.
- A move to a smaller tier is refused while the family (its members' own files and its folders) stores more than its pool. The refusal says how much to free.
- A family that grows past it before the renewal pauses everyone's uploads then, deleting nothing.
- Places carry over: a product change keeps `units`, and every tier includes the same members.

**The tier paid for** comes from Polar's orders on every reconcile: the product of the newest paid, unrefunded checkout, renewal or change order.

- So an unpaid upgrade leaves the last paid tier in force.
- A paid renewal of the bigger tier gives it.
- A refund falls back.
- No places are bought while the product differs from it.
- A product bigger than the tier paid for for more than seven days is moved back at the period's end, as an unpaid raise is cut back.
- Portal unit changes stay off (spike E7).

**Re-issuing.**

- The move is recorded, like a cut. Polar keeps both side by side (spike 8, T1). An upgrade drops both, after which only the cut is asked for again.
- Re-issues are idempotent.
- A reconcile does not repeat the same one within 15 minutes but queues it for then (one pending retry per family). So webhook deliveries cannot loop and nothing needed is dropped.
- Failures are retried with backoff indefinitely.
- After five answers of 200 Polar did not keep, HushOS stops and lists the family on the management page.
- An upgrade paid only after its revert took effect is not credited back automatically. The operator refunds that order in Polar (see docs/self-hosting.md, Family plans).
- Monthly to yearly is not offered yet.

### 3.6 Child accounts

**Not in milestone 1** (2.9). Built after the family core. A child account is a separate account type. A family stays without any browse of its adult members.

1. **Created only as child accounts.**
    - A `guardian` starts "Add a child" in the family. The child signs up through a link, choosing a password.
    - The flow asks for the child's own device, but nothing enforces it. The link is returned to the guardian, and whoever opens it registers the enrolment device (`docs/devices-design.md` 6).
    - Each device the child signs in on registers a device signing key.
    - An existing account can never become a child account.
2. **Ages.**
    - Teens 13 to 17 first: `adult_from` must fall within five years of sign-up.
    - Accounts for children under 13 come later, once verifiable parental consent, the terms and the privacy policy are in place (COPPA in the US, GDPR in the EU).
3. **The family check comes before the root is sealed** (decided; nothing is built yet). The join code exists only once someone is admitted (3.2), so a child's sign-up runs in this order:
    - (a) the child's account is created but its registration is not finished, and it can store nothing;
    - (b) the guardian checks the child's twelve words, read from the child's screen, and admits them, as for any newcomer;
    - (c) the child's device and the guardian compare the join code of the admitting roster, the same ten compared and two typed (3.2), and the child's device accepts the chain with it as its join mark;
    - (d) only then does the child's device seal its root to the `guardian` entries on that accepted chain (2.9);
    - (e) registration finishes.

    The server refuses to finish a child registration without a seal for every `guardian` entry.

    A comparison that fails stops before (d): nothing of the root is sealed, the child is an admitted member whose registration never finishes, and the guardian turns the sign-up down.

    The family's version 1 words are not compared here either (2.4, the residual after a succession before the admission).

4. **What a guardian can do before `adult_from`:**
    - reset the child's password. The guardian's device re-wraps the child's root under the new password's key. The reset ends the child's password sessions and tells them;
    - open the child's personal space;
    - loosen the child's sharing defaults.

    **From `adult_from`, the server refuses guardian resets and policy changes.**

5. **Defaults:** no public links and no shares outside the family, enforced by the server, until a guardian allows them.
6. **Always disclosed.** The child sees a permanent notice: "Your parent can see your files." The record shows every time a guardian's device fetches a seal.
7. **Adulthood.** Access does not end on its own.
    - From `adult_from`, the account holder may convert at any time. A guardian has no control that blocks or undoes it.
    - Every conversion waits 7 days, with notices to the account's email and devices (`docs/envelope-migrations.md` 7).
    - A hostile guardian who holds a device of the account or its mailbox can still cancel each attempt. That is a stated residual (`docs/groups-threat-model.md`), not something this design prevents.
    - Conversion is authorised by a device key the child's devices registered. So it works even if a guardian reset the password earlier (the device still holds the root through its device memory).
    - The person is prompted on `adult_from`. The notice then also says how to make the account fully theirs, and they stay in the family plan as an adult member.
8. **Conversion is a full re-key**, because a guardian who opened the root holds everything it wraps. In one resumable run the child's device:
    1. makes a new account root;
    2. makes new identity keys and signs an identity succession with the old ones;
    3. makes a new settings key and re-seals the settings;
    4. bumps the personal workspace key version and runs a full `drive_rotations` of the personal tree;
    5. re-seals its outgoing shares (the sharing ledger) to their grantees.

    The run also registers a new password and a new recovery phrase, rewraps every workspace grant and self-grant, and signs out every other device in the switch, in that order (switch first, rotation after). See `docs/envelope-migrations.md` 7, which also sets the 7-day hold and lists what conversion does not stop against a hostile guardian.

    The server deletes every guardian seal in the transaction that switches the account to the new root. Family holders then fold the new identity into the next roster (its succession chain verifies) and re-grant the family areas to it.

9. **Early release and guardian removal** run the same full re-key, on the child's device at its next sign-in. The seals are deleted at once.

## 4. API contract

- Base64url without padding everywhere.
- Ids are lowercase UUIDs.
- All routes need a session unless marked.
- Group routes need active membership. Those marked **members** need the `members` role.
- A group signature is `{ ed25519, mlDsa }`.

### Groups

| Route                                              | Body → response                                                                                                                                                                                 | Notes                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/groups`                                 | `{ id, idSeed, kind, name, groupKey: { ed25519PublicKey, mlDsaPublicKey, seal }, roster: { statement, signature, signerSignature }, area: { workspaceId, idSeed, root, grant } }` → `{ group }` | Family first; `kind: 'org'` refused until the company release (409 `unsupported`)                                                                                                                                                                                                                                                                                                                           |
| `GET /api/groups`                                  | → `[{ id, kind, name, roles, state }]`                                                                                                                                                          | The caller's groups                                                                                                                                                                                                                                                                                                                                                                                         |
| `GET /api/groups/:id`                              | → `{ group, members: [{ userId, name, state, roles }], due: { rosters, succession } }`                                                                                                          | What a `members` holder should fold in or sign next                                                                                                                                                                                                                                                                                                                                                         |
| `PATCH /api/groups/:id` **members**                | `{ name }`                                                                                                                                                                                      |                                                                                                                                                                                                                                                                                                                                                                                                             |
| `GET /api/groups/:id/rosters?after=<version>`      | → `{ rosters: [{ version, statement, signature, signerSignature }], successions: [...], firstKeys, signerKeys }`                                                                                | Without `after`, every roster from version 1 (what a device without a cache, a new one included, verifies); with `after`, every roster after that version, for a device continuing from its cache. Every succession from key version 1 either way; `firstKeys` are the version 1 public keys; `signerKeys` maps the SHA-256 (base64url) of every ML-DSA key a signer's entry names in the range to that key |
| `POST /api/groups/:id/rosters` **members**         | `{ expectedVersion, statement, signature, signerSignature }`                                                                                                                                    | Next version only; 409 `stale` with the current version. The server must accept the stored chain and run `checkNextRoster` on the new roster, with every identity each member has had, before storing it, and refuse it (400) otherwise: a stored roster no device accepts would stop the whole group, and an entry naming keys its member never had is refused                                             |
| `GET /api/groups/:id/key-seal` **members**         | → `{ groupKeyVersion, seal }`                                                                                                                                                                   |                                                                                                                                                                                                                                                                                                                                                                                                             |
| `POST /api/groups/:id/key-successions` **members** | `{ statement, signature, signerSignature, seals: [...], roster }`                                                                                                                               | One per `oldVersion`; re-seals to every remaining holder in one call. The server must run `checkNextSuccession` against the stored chain first and refuse (400) one that fails                                                                                                                                                                                                                              |

### Invitations and admission

| Route                                                          | Body → response                                                                                            | Notes                                                                                                                                                                                                                            |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/groups/:id/invitations` **members**                 | `{ email, roles }` → `{ id, expiresAt }`                                                                   | Mails the link; 7-day expiry; rate-limited per group and address                                                                                                                                                                 |
| `GET /api/groups/:id/invitations` **members**                  | → open invitations                                                                                         |                                                                                                                                                                                                                                  |
| `DELETE /api/groups/:id/invitations/:invitationId` **members** |                                                                                                            |                                                                                                                                                                                                                                  |
| `POST /api/invitations/open`                                   | `{ token }` → `{ groupId, kind, name, inviter: { id, name }, firstKeys, successions, rosters, expiresAt }` | The newcomer's side of the word check, on the version 1 keys; 410 when used or expired                                                                                                                                           |
| `POST /api/invitations/accept`                                 | `{ token }` → `{ membership }`                                                                             | Binds to the signed-in account; state `accepted`                                                                                                                                                                                 |
| `GET /api/groups/:id/pending` **members**                      | → `[{ userId, name, identity }]`                                                                           | Accepted, not yet admitted; `identity` is the served identity to check words against                                                                                                                                             |
| `POST /api/groups/:id/members/:userId/admit` **members**       | `{ roster, grants: [{ workspaceId, workspaceKeyVersion, envelope }], keySeal? }`                           | One transaction; 402 `seats` when the plan is full; 409 `stale`                                                                                                                                                                  |
| `PATCH /api/groups/:id/members/:userId` **members**            | `{ roles, roster, keySeal?, succession? }`                                                                 | Granting `members` needs a seal; taking it away needs a succession                                                                                                                                                               |
| `DELETE /api/groups/:id/members/:userId` **members**           | `{ roster, rotations: [{ workspaceId, fromVersion, toVersion, rootNode }], grants }`                       | One transaction. In a family the roster rotates every area (2.4), and every rotation and the new keys' grants to the remaining members come with it; a company's are queued. A `members` holder's removal makes a succession due |
| `POST /api/groups/:id/leave`                                   |                                                                                                            | The organizer must hand over first (409 `organizer`)                                                                                                                                                                             |

### Areas

| Route                                                        | Body → response                                                                                        | Notes                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /api/groups/:id/areas` **members**                     | `{ workspaceId, idSeed, root, roster, grants }`                                                        | `root` as for a personal root (node id and seed, envelopes, signature); `roster` carries the area's version 1 row (2.6), stored with it. A roster row creating an area whose workspace is not a group workspace the server has for this group is refused (1b)      |
| `GET /api/drive/spaces`                                      | → `[{ space: { kind, groupId?, name? }, areas: [{ workspaceId, role, workspaceKeyVersion, grant }] }]` | `GET /api/drive/workspace` stays for shipped mobile builds                                                                                                                                                                                                         |
| `POST /api/groups/:id/areas/:workspaceId/grants` **members** | `{ grants }`                                                                                           | Grants only to active members                                                                                                                                                                                                                                      |
| `POST /api/drive/workspaces/:id/key-rotations` **members**   | `{ fromVersion, toVersion, roster, rootNode: { keyEnvelope, rotation }, grants }`                      | For a group area, an active `members` holder only, with the roster listing `toVersion`'s commitment (2.6), stored in the same transaction; the root's new node key lands with the version bump; 409 `stale`. Personal workspaces are unchanged                     |
| `POST /api/groups/:id/areas/:workspaceId/delete` **members** | `{ expectedRevision, roster }`                                                                         | Deleting a family folder (2.10): the roster's only area row is the folder's tombstone, and the call carries no rotation, grant, seal or succession; the area is marked deleted in the same transaction and purged after 30 days (`docs/groups-server.md` route 30) |

### Child accounts

Not in milestone 1 (2.9, 3.6).

| Route                                                    | Body → response                                                                                                                | Notes                                                                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `POST /api/groups/:id/children` (`guardian` role)        | `{ adultFrom }` → `{ link }`                                                                                                   | Starts a child sign-up; one-time token in the fragment                                                            |
| `POST /api/auth/register/child`                          | As adult registration, plus `{ token, groupId, deviceKey, guardianSeals: [{ guardianUserId, guardianKeyVersion, envelope }] }` | Refused without a seal for every `guardian` entry on the roster                                                   |
| `POST /api/auth/devices`                                 | `{ kind, name, signingPublicKey }`                                                                                             | Every account's devices register their key (`docs/devices-design.md` 8)                                           |
| `GET /api/children/:userId/guardian-seal` (guardians)    | → `{ childRootVersion, envelope }`                                                                                             | Each fetch is an `account_guardian_events` entry                                                                  |
| `GET /api/auth/guardian-events`                          | → the record of guardian seal fetches                                                                                          | The child's own view                                                                                              |
| `POST /api/children/:userId/reset` (guardians)           | As a password change, wrapped by the guardian                                                                                  | Refused from `adultFrom`; ends the child's password sessions                                                      |
| `PATCH /api/children/:userId/policies` (guardians)       | `{ publicLinks, sharesOutsideFamily }`                                                                                         | Refused from `adultFrom`                                                                                          |
| `POST /api/auth/convert` (device key, no session needed) | `{ deviceKey, attemptId, signature }` → `{ attemptId, completesAt }`                                                           | From `adultFrom`; starts the 7-day hold and notifies the email and every device                                   |
| `DELETE /api/auth/convert/:attemptId`                    | `{ token }` or a device session                                                                                                | Cancels a held conversion; a security notice                                                                      |
| `POST /api/auth/convert/:attemptId/switch` (device key)  | `{ signature, newRoot, identitySuccession, settingsKey, workspaceGrants, rotation }`                                           | The requesting device only, after the hold; deletes every guardian seal in the transaction that switches the root |
| `DELETE /api/children/:userId/guardians` (guardians)     |                                                                                                                                | Early release; the child's device re-keys at its next sign-in                                                     |

### What the server checks before storing

- Every grant, seal, roster and succession is checked by the server for shape and signatures before it is stored.
- Otherwise it is refused with one uniform 400.
- Clients verify again and never rely on that.
- Rosters (with the admit, member and leave routes that carry one) get the full `checkNextRoster` check against the stored chain, with the members' identities.
- Successions get `checkNextSuccession`.

## 5. Clients

- **Crypto (TS and Rust, with fixtures):**
    - the group key pair (Ed25519 + ML-DSA-65) and group signatures;
    - key seal and area grant seal-and-open, each with its own `info` and associated data (guardian seals come with child accounts, 2.9);
    - roster and succession sign and verify, with the chain rules, from version 1 every time (with an optional local cache);
    - `checkNextRoster` and `checkNextSuccession`, the rules `nextRoster` applies and clients run before signing, and the server runs before storing;
    - the group fingerprint over both keys;
    - the scoped verdicts (2.8);
    - the canonical encoding and re-encoding checks (2.1);
    - `group` and `workspace` id kinds.
- **Web:**
    - space switcher and URLs;
    - group pages: members, roles, invitations, and pending admissions with the word check;
    - the newcomer's join page: their own words, then the join code to compare;
    - the settings `groups` pins;
    - "Trust as Acme does";
    - child accounts: sign-up, the disclosure, the record, conversion.
- **iOS and Android:**
    - spaces in the API clients;
    - a Files location (iOS) and a provider root (Android) per space, each tied to its owner;
    - the word checks;
    - roster and succession verification through the Rust core;
    - child-account conversion.

## 6. What the server learns

- Who is in which group, and their roles.
- Which accounts are child accounts, with their `adult_from` dates and guardians.
- When guardians fetch a child's seal.
- Who invited and admitted whom, and when.
- Who signed each roster.
- Invitation addresses, until accepted or expired.
- How many areas a group has, and their padded sizes.
- The group's name.

Rosters and successions carry only public keys, which the server already serves.

The group name is plaintext because it appears in invitation emails (Polar is only told "HushOS family"). A group that does not want its name known can choose a neutral one.

## 7. Tests that must exist

Each fails on a defect a person would notice (see AGENTS.md).

- **Encoding:**
    - TS and Rust produce identical bytes for every statement in the fixtures;
    - a document that parses but re-encodes differently is refused;
    - a version above 2^53−1, an uppercase id and a hex digest are refused;
    - both twins' parsers and encoders keep one grammar (no byte-order mark, escapes, lone surrogates, floats, `-0`, objects; at most four deep; 4 MiB), pinned by shared raw-byte cases;
    - a roster of more than 10,000 entries is refused;
    - identity key versions beyond 2^53−1 are refused in both twins.
- **Group signatures:**
    - a roster or succession whose Ed25519 signature is valid but whose ML-DSA signature is not, or the reverse, is refused;
    - the fingerprint changes when either public key changes.
- **Roster:**
    - a member signature checked through the roster is refused when its ML-DSA half verifies only under a served key whose digest is not the entry's `mlDsaPublicKeyDigest`;
    - "Trust as Acme does" writes a version 3 pin with the roster's ML-DSA and ML-KEM digests;
    - refused: a forged signature, a version that is not previous + 1, a wrong previous digest, a signer who is not an active `members` holder on the previous roster, and a missing or wrong signer identity signature;
    - an entry whose identity changed without a verifiable succession chain stays unchanged;
    - rosters served beside the chain are dead branches, never a warning; two latest rosters or a chain that does not reach version 1 are refused;
    - the hard warning only when the person's marks (pins, cache, a join mark) disagree with each other or with the chain:
        - listing both sides and naming no culprit;
        - still shown when the server adds malformed or foreign statements (the marks are compared before anything served is parsed);
    - join codes:
        - a join code other than twelve lowercase words is refused;
        - one over another roster, group key or key version, or at a succession's tie under the wrong key, is the warning;
        - a chain short of it is refused;
    - a roster whose signer leaves on it, or that leaves no active `members` holder, is refused, and a rival-key roster breaking those rules is refused, never the warning;
    - an area key commitment is HKDF of the key alone (a known answer in both twins), and a row repeating any commitment on the chain is refused (a no-op rotation, another area's key, one key for two areas);
    - a pin trusted through a group that agrees with the entry names the group as `via`, and an empty origin reads unchecked and admits no one;
    - roster format 2 (2.10):
        - format 1 rosters parse and verify unchanged;
        - a chain switches up at a roster boundary, and a format 1 roster after a format 2 one is refused;
        - the root commitment has its own label (a known answer, never the area key's);
        - a root commitment the chain listed before is refused;
        - a reader's root key that does not match the commitment at its version is refused; one at a version a format 1 roster listed is uncommitted;
        - a tombstone stands only at an area's next version and only for an area the chain lists;
        - after it, any row for the area (a second tombstone, a new key) is refused, no grant is sealed for it, and its write version is none;
        - a family removal does not rotate it (one retired in the removal's own roster counts as handled), and it no longer counts toward the 1,024;
        - a cache that dropped a retirement or changed the last root commitment is refused, and one from before format 2 reads as no roots and no retired areas;
    - the area rules:
        - delta rows, sorted, at most 1,024;
        - a family past 1,024 areas is refused, and a family at the cap can still remove someone (`nextRoster` builds the 1,024-row removal);
        - a row at a version already listed, a version skipped, or a new area (or roster 1's) above version 1 is refused;
        - a rotation and a new area at 1 are accepted;
        - in a family a roster that marks anyone left rotates every area or is refused (a company's is not held to it);
        - a roster that drops a holder admits no one;
    - a cache whose last roster's rows are not its areas' latest commitments, or (at roster 1) that carries an area roster 1 did not create, is refused;
    - stored chains:
        - only the server entry makes a stored chain, and no seal, opening, write version, row, pin or verdict takes one;
        - its record is the server's (`origin: 'server'`), which a reader's acceptance refuses as a cache, and a device's cache is no server record;
        - the web's client modules never import the server entry, and the entry refuses to load in a browser;
    - with no pin and no cache, nothing is accepted without a join mark the person compared (or creation's own seed), and the preview that works the code out keeps nothing;
    - the entry rules: an entry dropped or a wrong `sinceVersion` is refused; key versions are free, and an inflated entry leaves the member followable;
    - a server alone (unsigned or unchained rosters, other first keys with the real chain, an extension that does not continue the cache) gets a refusal, never the warning; a side of the warning names a signer only for a verified statement;
    - a removed holder's rival succession tied early waits for the marked one, and is the warning only if a roster needing the next key holds under it, signed by a holder; with the marked one withheld it is a refusal (missing succession, or a rollback at the end);
    - an own entry naming a replaced identity of the reader is reported;
    - a roster `nextRoster` builds is always accepted, and `checkNextRoster` refuses exactly what acceptance refuses, plus (with the members' identities) an entry naming keys its member never had;
    - a served chain shorter than a pin is refused;
    - a local cache outside its form, of another group, or not through its own roster is refused.
- **Succession:**
    - two successions from one `oldVersion` that both hold are refused unless a group key mark chooses; a mark neither meets is refused unless a roster holds under one of them;
    - a succession whose new key is the old one, or an earlier one, is refused;
    - `checkNextSuccession` refuses a succession tied before the latest roster under its old key;
    - a roster signed by an old key after its succession is refused;
    - a roster after a `members` holder's removal without a succession is refused.
- **Seals and grants:**
    - refused, and never made:
        - a key seal whose seed does not derive the published keys;
        - a key seal whose sealer is not an active `members` holder (the creator's key 1 seal only while they are active);
        - a grant by a member who has left;
        - a seal under an Ed25519 key with another ML-DSA key than the entry's;
    - a grant from a `left` granter, for another group or workspace, or under another seal kind's `info`, does not open;
    - an earlier version's grant opens after a later one has (no floor);
    - a seal or grant made at a roster the opener's chain does not hold (another history, or a newer roster) does not open, and a sealer names only its latest accepted roster;
    - a grant only of a key the latest roster lists (by its commitment; an earlier version by the chain's):
        - a granter kept behind cannot seal a version its roster does not list;
        - a grant delivering another key under a listed version, or a version above the latest roster's, opens nothing on the real chain;
        - a grant of an earlier version's key still opens after a rotation.
- **Verdicts:**
    - roster trust gives `verified` inside the group's areas and nothing outside them;
    - a legitimate identity succession is followed, not reported as `key-conflict`, before and after a roster folds it in;
    - a forged or bit-flipped record reads as a bad signature on every device, a new one included, and `unchecked` when the writer's identity or links did not load;
    - retired keys:
        - an earlier key reads retired only along verified links (junk links before, between or after, out of order or repeated change nothing);
        - a pinned reader retires from their pin and, before a pin at a later identity, along the member's verified chain to it;
        - a planted key never reads retired, even with a link its planter signed;
    - two verified successions from one of the member's keys are an identity fork: `unchecked`, whatever the order, and their seals lend no history;
    - the personal-pin verifier is unchanged: junk after the chain, or links out of order, and it does not hold;
    - seals and grants through history:
        - a seal or grant made before the sealer's identity was folded in, or under their entry's keys after they moved on, still opens with their history;
        - one under keys no roster has folded in does not;
        - one signed by a planted key does not, link or no link;
        - a member seals only with their entry's keys;
        - a key seal opens only for the holder it names;
    - successor consent:
        - a planted first entry's link without the member's consent (one-sided, or with only the planted keys' valid half, or only the new keys' half) bridges nothing. So a record under the planted keys reads bad-signature, not retired-key, and the planted keys' grant opens nothing;
        - the same link with the member's consent bridges;
        - a self-consented link from the planted keys to the planter's own, served as the member's identity, still leaves the planted keys bad-signature (retirement stops at the entry);
        - two self-consented links leaving the first keys leave the member's records verified and a forgery bad-signature;
        - a genuine one-sided link holds on the lag, a personal pin's walk and a fold-in, and in a seal's history after the entry's keys;
    - the walk's limits:
        - a served identity equal to the walk's start with a verified link leaving it is a rollback (unchecked);
        - more than 64 links that could join the member's chain are checked no further and read as links that did not load (a record under the entry's key still verifies; one under a key only the chain vouches for reads unchecked), while links from keys the member never held are not counted;
        - the verification cache tells members apart, two links whose fields would join alike are remembered apart, and a link's serialization hook cannot borrow another's entry;
        - a per-session cache carries across verdicts without vouching for a forged copy, and it keeps at most 4,096 results;
    - a reader whose pin was trusted through the group (`trustedVia`) sees a one-sided link from planted keys, later or first in the history, as `key-conflict`, never the planted keys retired, once the entry is put right;
    - a reader who checked words over an honest member's earlier identity gets the roster's verdict after a one-sided rotation is folded in;
    - the person's own marks disagreeing are the warning even when what is served is junk; served version 1 keys other than the marks' are refused, never the warning;
    - a disagreeing pin with no chain is `key-conflict`;
    - a `left` writer is marked;
    - a roster that fails to load gives `unchecked`.
- **Admission:**
    - the transaction lands whole or not at all (membership, roster, grants, seat);
    - a concurrent second admission on the last seat gets 402;
    - admission with a stale roster version gets 409.
- **Leaving and removal:**
    - the server stops serving grants at once;
    - rotation gives the area root a new node key in the same request and grants only to remaining members;
    - in a family the removal's roster, rotations and grants land in one transaction, and a roster marking someone left without every area's rotation is refused.
- **Storage:**
    - a member's personal uploads count against the pool while the family's plan is live, whatever plan of their own they had, and against their own allowance otherwise;
    - a newcomer whose own files don't fit in the pool's free space is refused at admission;
    - a per-member cap, when caps exist, refuses uploads only;
    - after leaving, uploads count against the member's own allowance and, over it, are refused while nothing is deleted.
- **First use and the family check.** `docs/optional-verification.md` 8, PR 2; both twins. Cases: the shared group cases `anchor-*`, `pair-*`, `first-use-pin-*`, the join scenarios `a-first-use-*`, `the-guard-is-a-mark-a-wipe-keeps`, the roster-call fixtures' `pairCodes`.
    - with no marks, `first-use` accepts the served chain and reports `checked` null, while creation and a join mark report checked;
    - `first-use` with any mark (pin, cache, session floor, check record, guard) vouches for nothing, and served version 1 keys other than the marks' are refused;
    - `first-use` is refused when the account's own entry is not active at the head, when settings did not open, and outside the join path;
    - after a first-use acceptance the pin raises the hard warning for another roster at its version and refuses a shorter chain;
    - a reload between acceptance and the pin write finishes against the joins record's roster, and another roster there is the warning;
    - a pair mark over a matching code sets `checked`, one over another roster's or another pair's code is the warning, one beyond the chain is refused, and a pair code as a join mark (or the reverse) is not taken;
    - both twins give the same pair code for every pair, at the later admission; A↔B and A↔C over one roster differ;
    - a device whose own entry was wrong at the roster shows no pair code;
    - a pair match writes a verified pin only when the head entry's keys are the compared entry's and the guard's (else the settings pin's); a head entry moved by a handover or a Continue gets no pin;
    - the guard survives a `not-member` wipe and replaced settings, and refuses first use of a made-up family; an unreadable guard refuses;
    - a held guard that disagrees with the session's floor, crosses it or is past it (even from another history) refuses the wipe and drops nothing (`a-guard-that-disagrees-with-the-floor-holds-the-wipe-and-drops-nothing`, `a-guard-crossed-with-the-floor-is-two-histories-and-holds-the-wipe`, `a-guard-ahead-of-the-floor-holds-the-wipe-even-from-another-history`);
    - interleaved (each twin's own tests):
        - an acceptance verified over a floor moved meanwhile to another group key at the same roster commits nothing;
        - a wipe re-reads a floor moved while it awaited;
        - an acceptance begun before a wipe commits nothing after it;
    - a real iOS 0.10.0 join over a planted entry: the new core's pair code for the newcomer's device refuses, the manager's pair code is not the 0.10.0 code, and the one-way path writes nothing;
    - `roster_entry_new` builds from a first-seen pin and refuses one whose keys are not the served identity's, or a `trustedVia` pin; an admission still needs a verified pin until the manager rule ships;
    - the F1 scan fails on any new setter of an anchor.
- **Child accounts:**
    - registration without a seal for every `guardian` entry is refused;
    - no seal is made to an entry without the `guardian` role;
    - guardian resets and policy changes from `adult_from` are refused;
    - conversion authorised by a registered device key succeeds after a guardian reset;
    - every conversion completes only after 7 days, and the email link or any device cancels it;
    - after conversion the old identity, settings key and personal workspace key open nothing new;
    - every seal fetch appears in the child's record;
    - an existing adult account cannot become a child account.
- **Ids:** a group or area id not derived from its seed and scope is refused.

## 8. Open questions

- **Polar mechanics** are settled by `docs/archive/polar-group-billing-spike.md` (decisions agreed 2026-10-15).
    - Its sandbox results (section 8 there, 2026-10-17) are what 3.5 is built against.
    - Its open risks (section 7) still apply.
- **Post-quantum identity signatures** are designed in `docs/identity-pq-design.md`. The migrations this design and that one need are in `docs/envelope-migrations.md`.

## 9. Still open after the families release

**Families (milestone 1c) are released on the web:** create, invite, join with the join code, family folders, removal and leaving with every folder's keys replaced, and re-keyed records that keep each writer's signature.

**Family billing (1e, 3.5) is built:**

- the payer is charged for each place and the family folders draw on the plan's pool (PR #50);
- since the shared pool (`docs/families-shared-pool.md`), so do members' own files;
- the family's page chooses, changes, renews and cancels a plan and adds or removes places (PR #53);
- families choose Family Plus, Pro or Max (PR #65);
- the pricing page offers the Family plan (PR #57).

What is not done, and what it costs, follows. Server-side detail is in `docs/groups-server.md`, "Still open", and the core's open flags in `docs/groups-invariants.md`, "Flags".

- **Mobile families (1d) are shipped.** Both phone apps show families and open family folders (`docs/groups-mobile-plan.md`).
- **iOS and Android billing is read only.** The phones are to show the plan, the pool and who pays, with no purchase and no link out (`docs/groups-mobile-plan.md`, iOS 7). So a family chooses, changes and pays for its plan only on the web.
- **Polar's `PaymentActionRequired` path is unreproduced.** A bank that asks the payer to confirm an off-session charge sends them to the portal. But no sandbox card has produced that answer (`docs/archive/polar-group-billing-spike.md`, E3), so that path is built against Polar's documentation, not an observed response.
- **Billing handover of a live plan is not built.** While a plan is live its payer can't leave, be removed or delete their account, even when another member holds `billing`. They must cancel it first (`docs/self-hosting.md`, Family plans).
- **The shared pool is built and rolled out:** families are on at hushos.com (`docs/families-shared-pool.md`, step 9). What it leaves open:
    - no per-member limits, so one member can fill the pool for everyone;
    - moves between My files and the family folders go down and back up through the device, up to 256 MiB a file;
    - no personal plan's refund has yet gone through Polar for real, only against the fake (addendum 13).
- **Native clients don't read re-keyed records yet.** Re-keyed records stay in family folders only, since a shipped app would stall on one in a personal folder.
- **Personal folders still re-attribute on rotation.** After a personal rotation, an editor's verified record reads as the owner's.
- **Copies outside family folders judge the legacy columns.** A copy in a personal folder vouches for the rotation's re-signature rather than the writer, and copies or moves between spaces re-sign as the copier.
- **`drive_origin_drops` has no reader.** Dropped origins are kept as evidence, but nobody can view or settle a drop in an app.
- **A rotating member can drop writers' origins.** The record then reads as re-sealed by the dropper for good, with the drop shown in Info.
- **Successor consent is web only (flag F8).** For links a native app made, a member's pre-entry keys are not retired and seals made under them do not open through history.
- **Sharing in family folders is hidden** until share records signed at family level exist (3.4). Members cannot share family-folder files.
- **Areas cannot be deleted (flag F11).** There is no retirement row, so area deletion cannot ship yet.
- **Rosters do not commit to an area root's key (flag F14).** A server can roll an area root back to an earlier key at the same area key version without any check seeing it.
- **A master-key rotation loses unsent family changes on the rotating device.** Its sealed family records are dropped and accepted again, not re-sealed.
- **Hostile guardians are out of scope beyond the re-key and the 7-day hold.** Child accounts are not built (2.9, 3.6). When they are, a guardian holding a device or the mailbox can still cancel each conversion (threat model 3.7).
