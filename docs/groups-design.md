# Groups: the core families and companies share

This document fixes the group core: groups, members, invitations, the signed roster that lets members trust each other, shared areas, spaces, pooled storage, the payer and child accounts. Family plans ship on it alone; company plans add the custody key, admin browse, policies, audit, offboarding, storage control, domains and SSO on top (see the build plan, "HushOS for Companies — Build Plan", whose decisions this follows). Each statement below is the exact byte layout the web (`packages/crypto`) and the Rust core (`crates/hushos-core`) must produce and accept, pinned by shared fixtures.

Revised on 14 October after the independent review in `docs/groups-crypto-review.md`: every finding there is applied, and group signatures are post-quantum from the first version.

Nothing here changes what the server can read. It learns who is in which group, which it must know to authorise anything; every key it handles stays sealed.

## 1. Model

| Table                     | Holds                                                                                                                                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `groups`                  | `id` (client-derived), `kind` (`family` or `org`), `name` (plaintext, see 6), `group_key_version`, `roster_version`, `created_by`, `created_at`                                                      |
| `group_memberships`       | `(group_id, user_id)`, `state` (`invited` → `accepted` → `active`; `left`, `removed`), `roles` (`members`, `billing`, `guardian`; companies add `data_admin`, `recovery`), `admitted_by`, timestamps |
| `group_keys`              | One row per holder of the group key: `(group_id, group_key_version, user_id)`, the sealed seeds (2.3), `sealed_by`                                                                                   |
| `group_key_successions`   | `(group_id, old_version)` unique, the succession statement and its signatures (2.5)                                                                                                                  |
| `group_rosters`           | `(group_id, version)` unique, the roster statement, its signatures and the signer's identity signature (2.4); every version is kept                                                                  |
| `group_invitations`       | `id`, `group_id`, `normalized_email`, `token_hash` (as `account_enrollments`), `roles`, `invited_by`, `expires_at`, `state`                                                                          |
| `area_grants`             | `(workspace_id, workspace_key_version, user_id)`, the sealed area key (2.6), `granted_by`                                                                                                            |
| `group_storage`           | `group_id`, pooled `quota_bytes` from the plan and entitlements                                                                                                                                      |
| `account_guardians`       | `(child_user_id, guardian_user_id)`, the child's account root sealed to the guardian (2.9), `child_root_version`, `guardian_key_version`; deleted on conversion, release or guardian removal         |
| `account_guardian_events` | Each time a guardian's device fetches a guardian seal, recorded by the server and shown to the child                                                                                                 |
| `account_devices`         | Device signing keys a child account's devices register at sign-up, used to authorise conversion (3.6)                                                                                                |

`users` gains `account_kind` (`adult` or `child`) and `adult_from`, the date a child account may convert; HushOS stores that date, never a birth date.

`workspaces` gains `owner_kind` (`personal` or `group`), `group_id` and `area_kind` (`shared` now; `employee` for companies later). A group's shared area is a workspace like any other: tree, rotation, versions, trash, change feed and quota code run unchanged on it.

## 2. Cryptography

### 2.1 Encoding

Statements are canonical JSON arrays as in `docs/integrity-design.md`, with these rules every implementation follows exactly:

- **Ids** are 36-character lowercase hyphenated UUIDs, validated on both sides; anything else is refused.
- **Byte strings** are base64url without padding, including key digests (never hex).
- **Integers** (versions) run from 1 to 2^53−1; Rust refuses larger values, so TS and Rust agree.
- **The empty digest** (`previousRosterDigest` of version 1) is the JSON string `""`; otherwise it is base64url of 32 bytes.
- **Lists** (roster members, roles) are sorted strictly ascending by the bytes of their sort key, with no duplicates.
- **Verifiers re-encode.** A verifier rebuilds the statement from the parsed fields and refuses any document whose bytes differ, so no two encodings of one statement exist.
- **`kemPublicKeyDigest`** is SHA-256 of the 1184-byte ML-KEM-768 public key, base64url; a signer checks the identity's KEM binding before putting the digest in a statement.

### 2.2 Group signatures are post-quantum

The group key is a pair: an Ed25519 key and an ML-DSA-65 key (FIPS 204; `ml_dsa65` in `@noble/post-quantum`, the `ml-dsa` crate in Rust, beside the ML-KEM libraries already used). Its seed is 64 bytes: 32 for Ed25519, 32 for ML-DSA-65 key generation. Every group signature is both:

- an Ed25519 signature (64 bytes) over the statement bytes, and
- an ML-DSA-65 signature (3309 bytes) over the same bytes with FIPS 204 context string `hushos/group/v1`.

A group signature is valid only if both verify. A quantum adversary must break ML-DSA, a classical one Ed25519; neither alone forges a roster or a succession.

What stays classical: people's own identity signatures (Ed25519), which sign writer statements, seals (2.3, 2.6, 2.9) and identity successions. Their confidentiality is already hybrid (X25519 + ML-KEM-768), so nothing recorded today opens later; but a quantum adversary could one day forge a person's signature live. Making identity signatures hybrid is the next change (section 8).

### 2.3 The group key and its seals

The group key is made on the creator's device. Its fingerprint, shown as twelve words exactly as a person's are (`fingerprintWords`: the first 132 bits of the digest), is:

```
SHA-256("hushos/group/fingerprint/v1" || groupId (36 ASCII bytes) || ed25519PublicKey (32) || mlDsaPublicKey (1952))
```

**The words are always the version 1 key's.** After successions, a newcomer checks the version 1 words and verifies the succession chain from version 1 to the current key (2.5); pins keep the version 1 keys.

The 64-byte seed is sealed only to members whose roster entry has the `members` role, with the share suite 3 construction (ephemeral X25519 + ML-KEM-768 to the holder's identity, signed by the sealer's identity key), under HKDF `info` `hushos/group/key-seal/v1` and AEAD associated data equal to the statement without its final digest:

```
["hushos/group/key-seal",1,groupId,groupKeyVersion,holderUserId,holderKeyVersion,sealerUserId,sha256(sealed)]
```

A holder opens a key seal only if the sealer is active with `members` on the latest verified roster (or is the creator, for version 1), and refuses a seed whose derived public keys are not the group key at `groupKeyVersion`.

### 2.4 The roster

One signed document names every member, their keys and their roles:

```
["hushos/group/roster",1,groupId,kind,rosterVersion,previousRosterDigest,groupKeyVersion,signerUserId,members]
members = [[userId,keyVersion,encryptionPublicKey,signingPublicKey,kemPublicKeyDigest,status,roles,sinceVersion], ...]
```

- `members` is sorted by `userId`; `roles` is a sorted subset of `billing`, `guardian`, `members` (companies add `data_admin`, `recovery`); `status` is `active` or `left`; `sinceVersion` is the roster version the entry last changed at. Entries for former members stay.
- `previousRosterDigest` is SHA-256 of the previous roster's statement bytes, so rosters form a chain; `rosterVersion` is always the previous one plus one.
- It carries a group signature (2.2) by the group key at `groupKeyVersion`, and the signer's own identity signature over the same bytes, so every roster says who made it. The signer must be active with `members` on the previous roster (the creator, for version 1).

**Folding in changes.** Before signing, the signer's client checks every changed entry: a new member's keys are the ones the word check confirmed; a member whose identity changed is followed by verifying their succession chain from the entry's keys to the served ones (`verifySuccessionChain`); an entry whose chain fails stays as it was, and the member is shown as needing a check. The server checks a member's identity only on entries that are new or changed in that version. Each member's own client checks its own entry on every roster and raises a hard warning if it is wrong.

**Accepting a roster.** A client accepts rosters only as a chain joined to one it already holds:

1. Its pin (2.7) names the group's version 1 keys, whose words were checked, and the last roster version and digest it accepted.
2. The server serves every roster after that version, and every succession since (4).
3. Each roster in turn must have version previous + 1, the previous roster's digest, a valid group signature by the key current at that point (2.5), a signer active with `members` on the previous roster, and a valid signer identity signature.
4. Anything that fails leaves member records at their personal-check verdicts, never better.

**Forks.** Two different rosters with one version, or a chain that does not join the device's own, raise a hard warning ("Acme's member list was shown differently to you"). Roster verdicts then drop to personal checks until someone checks the group's words again. A fork is never resolved by taking the higher version.

### 2.5 Group key succession

A succession replaces the group key and is tied to a place in the roster chain:

```
["hushos/group/key-succession",1,groupId,oldVersion,newVersion,oldEd25519PublicKey,oldMlDsaPublicKey,newEd25519PublicKey,newMlDsaPublicKey,lastRosterVersion,lastRosterDigest,signerUserId]
```

- `newVersion` is `oldVersion` + 1, and the statement carries a group signature by the old key and the signer's identity signature; the signer is active with `members` on the roster at `lastRosterVersion`.
- Rosters signed by key `v` must have versions after the `lastRosterVersion` of the succession into `v`, and up to the `lastRosterVersion` of the succession out of `v`. A roster under a key that a later succession has already left behind is refused.
- **A holder leaving or removed** is the last roster under that key: the roster that marks a `members` holder `left` makes a succession due, and no further roster is accepted until it exists. The new seed is sealed to every remaining holder; a succession that drops a holder who was not removed raises a warning.
- **Two successions from one `oldVersion`** raise a hard warning and freeze roster trust for the group, as a fork does.
- The server stores one succession per `oldVersion` and refuses a second.

### 2.6 Area grants

An area's workspace key is granted with the suite 3 construction, under HKDF `info` `hushos/group/area-grant/v1` and AEAD associated data equal to the statement without its digest:

```
["hushos/group/area-grant",1,groupId,workspaceId,workspaceKeyVersion,granteeUserId,granteeKeyVersion,granterUserId,sha256(sealed)]
```

A grantee opens a grant only if: the granter is `active` (not `left`) on this group's verified roster; `groupId` is that roster's group and the area belongs to it; `workspaceKeyVersion` is at least the highest version of that area this person has seen (kept in the pin, 2.7); and the grantee and key version are the reader's own.

**Rotating an area** bumps `workspace_key_version`; the area root is the root of a `drive_rotations` run and gets a new node key in the same request that bumps the version, so a cached root key opens nothing new. New grants go to active members only.

### 2.7 Pins and rollback

The settings document gains, per group:

```
groups: { [groupId]: { firstEd25519PublicKey, firstMlDsaPublicKey, checkedAt, keyVersion, rosterVersion, rosterDigest, areas: { [workspaceId]: highestKeyVersion } } }
```

Older clients keep it as an unknown field. Each device also keeps the same marks locally; the marks in use are the higher of the two. A new device joins the chain at the settings pin's version and digest.

### 2.8 What readers show

Roster trust is scoped to its group: **a roster vouches only for records in that group's areas and for grants naming that group.** Elsewhere, such as a colleague's personal share, a colleague who is not personally checked shows as Unverified with the hint "In Acme". One click, "Trust as Acme does", writes a personal pin of the keys the roster names, as an explicit act by the reader.

Inside a group's areas, in order:

| Case                                                                                                              | Verdict                    | Shown                                                    |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------- | -------------------------------------------------------- |
| The roster cannot load or verify                                                                                  | `unchecked`                | Couldn't check (fails closed)                            |
| The writer has a personal pin that matches the roster's keys                                                      | `verified`                 | No mark                                                  |
| The writer is active on the roster, no personal pin                                                               | `verified`, `via: groupId` | No mark; Info: "Verified by Acme"                        |
| A personal pin differs from the roster, and the writer's succession chain leads from the pin to the roster's keys | `verified`, `via: groupId` | No mark; the pin follows the chain                       |
| A personal pin differs and no chain joins them                                                                    | `key-conflict`             | A hard warning, worse than Unverified                    |
| The writer's entry is `left`                                                                                      | `former-member`            | Drawn as Unverified: "Written by Sam, who has left Acme" |
| The writer is not on the roster                                                                                   | as without groups          | Unverified, or the existing verdicts                     |

A former member still holds their keys, and a signature carries no trustworthy date, so their work is marked: it may be old and genuine, or planted.

### 2.9 Guardian seals (child accounts)

A child account's root is sealed to each guardian with the suite 3 construction, under HKDF `info` `hushos/account/guardian-seal/v1` and associated data equal to the statement without its digest:

```
["hushos/account/guardian-seal",1,childUserId,childRootVersion,guardianUserId,guardianKeyVersion,sealerUserId,sha256(sealed)]
```

- The sealer is the child's own device. It seals only to entries with the `guardian` role, `active`, on a family roster it verified after the family's words were checked at sign-up (3.6), so neither the server nor a roster without that role picks a guardian.
- **Adding a guardian later** needs an explicit act on the child's device, which seals to the new guardian after verifying their roster entry.
- `childRootVersion` is the child account's root revision. **A guardian's identity succession** makes the child's device re-seal to the new key on its next sign-in, deleting the old seal.
- **A guardian removed** from the family, or from the `guardian` role, makes the child's device run a full re-key (3.6) on its next sign-in, since that guardian once held the root.
- **The record** shows each time a guardian's device fetches a seal. Guardian clients drop an opened child root when the session ends; a modified client could keep it, and the record cannot show that.

## 3. Flows

### 3.1 Creating a family

The organizer's client derives the group id, makes the group key, signs roster version 1 with only the organizer (roles `billing`, `guardian`, `members`), seals the seed to itself, and calls `POST /api/groups`. Creating the first shared area ("Family") is part of the same flow.

### 3.2 Joining (invitation, acceptance, admission)

1. A `members` holder invites an email address; the server mails a link with a one-time token in its fragment (`/join#invite=<token>`), hashed at rest as sign-up tokens are.
2. The invitee signs in or signs up, opens the invitation and accepts. Membership moves to `accepted`; nothing opens yet, and no seat is taken.
3. The admitting admin and the newcomer compare words once, in person or on a call through another service, never in a message sent through HushOS: the admin reads the newcomer's twelve words from the newcomer's screen, and the newcomer reads the group's version 1 words. Both are required; there is no skip, and the admit button stays disabled until both sides have confirmed.
4. The newcomer's client verifies the succession chain from the version 1 key to the current one, and the roster chain from version 1.
5. The admin's client signs the next roster with the newcomer added, seals the shared areas' keys to them (and the group seed, if they get `members`), and calls admit. The server applies membership, roster, grants and the seat in one transaction.
6. The newcomer's client verifies the new roster and pins the group.

### 3.3 Leaving and removal

- **Leaving:** the member calls leave. Their membership becomes `left` at once and the server stops serving them the group's areas and grants. The next `members` holder to open the group signs a roster marking them `left` (the server reports it as due) and rotates the areas they could open.
- **Removal:** a `members` holder removes someone with the next roster in the same call. Rotation of their areas is queued as above.
- **A `members` holder leaving or removed** also makes a group key succession due before the next roster (2.5).
- **A family member who leaves keeps their files:** their personal space was always theirs. They lose the family folders, and their personal storage moves from the family pool back to their own plan; over its limit, uploads are refused until they make room or upgrade, and nothing is deleted.
- **The organizer** must hand `members` and `billing` to another adult member before leaving. Dissolving a family deletes its shared areas after the 30-day trash period, with notice to every member; personal spaces are untouched.

### 3.4 Spaces

`GET /api/drive/spaces` lists the account's personal space and every group it is active in, each with the areas it can open and their grants. Clients switch between spaces (web: a switcher at the top of the sidebar and the space in the URL, `/app/s/<space>/…`; iOS: one Files location per space, each tied to its owner as the 13 October Files fix does; Android: one provider root per space). Leaving a space wipes its local state on every device.

### 3.5 Storage and the payer

- A group plan's quota pools across the group's areas and, for families, the personal spaces of members who draw from it. `freeBytes` for any workspace in the pool reads the pool.
- **One storage source per person**, as iCloud+ and Dropbox Family do it: a member on the free tier draws from the family pool automatically once admitted; a member who pays for their own plan chooses at admission, and later in Account, to keep it (their personal space stays outside the pool) or to switch (their subscription is cancelled with a prorated refund through Polar). Never both.
- **No stacking of free allowances:** the pool is the plan's size; a member's own free allowance is not added to it.
- **What the organizer sees:** the pool's total and which members are at their cap, never each member's usage.
- **Optional per-member limits:** the organizer may cap how much of the pool a member's personal space uses; off by default. A member at their cap or with a full pool can still read, download and delete; only uploads are refused.
- The payer is a billing customer keyed by owner kind and id. Polar products carry `hushos_plan`, `quota_bytes`, and new `hushos_group_kind` and `included_members` metadata; members beyond those included are billed per member with no upper limit, and companies have a minimum seat count.
- Seats are counted at admission, never at invitation; a seat cut blocks new admissions and never removes anyone.

### 3.6 Child accounts

Built after the family core. A child account is a separate account type; a family stays without any browse of its adult members.

1. **Created only as child accounts.** A `guardian` starts "Add a child" in the family; the child signs up on their own device (or the guardian's) through a link, choosing a password. Each device the child signs in on registers a device signing key. An existing account can never become a child account.
2. **Ages.** Teens 13 to 17 first: `adult_from` must fall within five years of sign-up. Accounts for children under 13 come later, once verifiable parental consent, the terms and the privacy policy are in place (COPPA in the US, GDPR in the EU).
3. **The family check comes first.** The child's sign-up compares the family's words with the guardian, as a newcomer's join does; only then does the child's device seal its root to the roster's `guardian` entries (2.9) and join the family. Registration of a child account without a seal for every `guardian` entry is refused.
4. **What a guardian can do before `adult_from`:** reset the child's password (the guardian's device re-wraps the child's root under the new password's key; the reset ends the child's password sessions and tells them), open the child's personal space, and loosen the child's sharing defaults. **From `adult_from`, the server refuses guardian resets and policy changes.**
5. **Defaults:** no public links and no shares outside the family, enforced by the server, until a guardian allows them.
6. **Always disclosed.** The child sees a permanent notice: "Your parent can see your files." The record shows every time a guardian's device fetches a seal.
7. **Adulthood.** Access does not end on its own. From `adult_from`, the account holder may convert at any time; a guardian cannot block, delay or undo it. Conversion is authorised by a device key the child's devices registered, so it works even if a guardian reset the password earlier (the device still holds the root through its device memory). The person is prompted on `adult_from`, the notice then also says how to make the account fully theirs, and they stay in the family plan as an adult member.
8. **Conversion is a full re-key**, because a guardian who opened the root holds everything it wraps. In one resumable run the child's device:
    1. makes a new account root;
    2. makes new identity keys and signs an identity succession with the old ones;
    3. makes a new settings key and re-seals the settings;
    4. bumps the personal workspace key version and runs a full `drive_rotations` of the personal tree;
    5. re-seals its outgoing shares (the sharing ledger) to their grantees.

    The server deletes every guardian seal in the transaction that switches the account to the new root; family holders then fold the new identity into the next roster (its succession chain verifies) and re-grant the family areas to it.

9. **Early release and guardian removal** run the same full re-key, on the child's device at its next sign-in; the seals are deleted at once.

## 4. API contract

Base64url without padding everywhere; ids lowercase UUIDs. All routes need a session unless marked; group routes need active membership, and those marked **members** need the `members` role. A group signature is `{ ed25519, mlDsa }`.

### Groups

| Route                                              | Body → response                                                                                                                                                                                 | Notes                                                                                                                                                                            |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/groups`                                 | `{ id, idSeed, kind, name, groupKey: { ed25519PublicKey, mlDsaPublicKey, seal }, roster: { statement, signature, signerSignature }, area: { workspaceId, idSeed, root, grant } }` → `{ group }` | Family first; `kind: 'org'` refused until the company release (409 `unsupported`)                                                                                                |
| `GET /api/groups`                                  | → `[{ id, kind, name, roles, state }]`                                                                                                                                                          | The caller's groups                                                                                                                                                              |
| `GET /api/groups/:id`                              | → `{ group, members: [{ userId, name, state, roles }], due: { rosters, succession } }`                                                                                                          | What a `members` holder should fold in or sign next                                                                                                                              |
| `PATCH /api/groups/:id` **members**                | `{ name }`                                                                                                                                                                                      |                                                                                                                                                                                  |
| `GET /api/groups/:id/rosters?after=<version>`      | → `{ rosters: [{ version, statement, signature, signerSignature }], successions: [...], firstKeys }`                                                                                            | Every roster after `after`, oldest first; every succession whose `oldVersion` is at or above the key version of the roster at `after`; `firstKeys` are the version 1 public keys |
| `POST /api/groups/:id/rosters` **members**         | `{ expectedVersion, statement, signature, signerSignature }`                                                                                                                                    | Next version only; 409 `stale` with the current version                                                                                                                          |
| `GET /api/groups/:id/key-seal` **members**         | → `{ groupKeyVersion, seal }`                                                                                                                                                                   |                                                                                                                                                                                  |
| `POST /api/groups/:id/key-successions` **members** | `{ statement, signature, signerSignature, seals: [...], roster }`                                                                                                                               | One per `oldVersion`; re-seals to every remaining holder in one call                                                                                                             |

### Invitations and admission

| Route                                                          | Body → response                                                                                            | Notes                                                                                  |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `POST /api/groups/:id/invitations` **members**                 | `{ email, roles }` → `{ id, expiresAt }`                                                                   | Mails the link; 7-day expiry; rate-limited per group and address                       |
| `GET /api/groups/:id/invitations` **members**                  | → open invitations                                                                                         |                                                                                        |
| `DELETE /api/groups/:id/invitations/:invitationId` **members** |                                                                                                            |                                                                                        |
| `POST /api/invitations/open`                                   | `{ token }` → `{ groupId, kind, name, inviter: { id, name }, firstKeys, successions, rosters, expiresAt }` | The newcomer's side of the word check, on the version 1 keys; 410 when used or expired |
| `POST /api/invitations/accept`                                 | `{ token }` → `{ membership }`                                                                             | Binds to the signed-in account; state `accepted`                                       |
| `GET /api/groups/:id/pending` **members**                      | → `[{ userId, name, identity }]`                                                                           | Accepted, not yet admitted; `identity` is the served identity to check words against   |
| `POST /api/groups/:id/members/:userId/admit` **members**       | `{ roster, grants: [{ workspaceId, workspaceKeyVersion, envelope }], keySeal? }`                           | One transaction; 402 `seats` when the plan is full; 409 `stale`                        |
| `PATCH /api/groups/:id/members/:userId` **members**            | `{ roles, roster, keySeal?, succession? }`                                                                 | Granting `members` needs a seal; taking it away needs a succession                     |
| `DELETE /api/groups/:id/members/:userId` **members**           | `{ roster }`                                                                                               | Queues rotation of their areas; a `members` holder's removal makes a succession due    |
| `POST /api/groups/:id/leave`                                   |                                                                                                            | The organizer must hand over first (409 `organizer`)                                   |

### Areas

| Route                                                        | Body → response                                                                                        | Notes                                                                                             |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `POST /api/groups/:id/areas` **members**                     | `{ workspaceId, idSeed, root, grants }`                                                                | `root` as for a personal root (node id and seed, envelopes, signature)                            |
| `GET /api/drive/spaces`                                      | → `[{ space: { kind, groupId?, name? }, areas: [{ workspaceId, role, workspaceKeyVersion, grant }] }]` | `GET /api/drive/workspace` stays for shipped mobile builds                                        |
| `POST /api/groups/:id/areas/:workspaceId/grants` **members** | `{ grants }`                                                                                           | Grants only to active members                                                                     |
| `POST /api/drive/workspaces/:id/key-rotations`               | `{ fromVersion, toVersion, rootNode: { keyEnvelope, rotation }, grants }`                              | Any member holding the area key; the root's new node key lands with the version bump; 409 `stale` |

### Child accounts

| Route                                                    | Body → response                                                                                                                | Notes                                                                                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/groups/:id/children` (`guardian` role)        | `{ adultFrom }` → `{ link }`                                                                                                   | Starts a child sign-up; one-time token in the fragment                                                                    |
| `POST /api/auth/register/child`                          | As adult registration, plus `{ token, groupId, deviceKey, guardianSeals: [{ guardianUserId, guardianKeyVersion, envelope }] }` | Refused without a seal for every `guardian` entry on the roster                                                           |
| `POST /api/auth/devices`                                 | `{ deviceKey, signature }`                                                                                                     | A child account's device registers its key                                                                                |
| `GET /api/children/:userId/guardian-seal` (guardians)    | → `{ childRootVersion, envelope }`                                                                                             | Each fetch is an `account_guardian_events` entry                                                                          |
| `GET /api/auth/guardian-events`                          | → the record of guardian seal fetches                                                                                          | The child's own view                                                                                                      |
| `POST /api/children/:userId/reset` (guardians)           | As a password change, wrapped by the guardian                                                                                  | Refused from `adultFrom`; ends the child's password sessions                                                              |
| `PATCH /api/children/:userId/policies` (guardians)       | `{ publicLinks, sharesOutsideFamily }`                                                                                         | Refused from `adultFrom`                                                                                                  |
| `POST /api/auth/convert` (device key, no session needed) | `{ deviceKey, signature, newRoot, identitySuccession, settingsKey, rotation }`                                                 | The account holder's device only, from `adultFrom`; deletes every guardian seal in the transaction that switches the root |
| `DELETE /api/children/:userId/guardians` (guardians)     |                                                                                                                                | Early release; the child's device re-keys at its next sign-in                                                             |

Every grant, seal, roster and succession is checked by the server for shape and signatures before it is stored, and refused with one uniform 400 otherwise; clients verify again and never rely on that.

## 5. Clients

- **Crypto (TS and Rust, with fixtures):**
    - the group key pair (Ed25519 + ML-DSA-65) and group signatures;
    - key seal, area grant and guardian seal seal-and-open, each with its own `info` and associated data;
    - roster and succession sign and verify, with the chain rules;
    - the group fingerprint over both keys;
    - the scoped verdicts (2.8);
    - the canonical encoding and re-encoding checks (2.1);
    - `group` and `workspace` id kinds.
- **Web:**
    - space switcher and URLs;
    - group pages: members, roles, invitations, and pending admissions with the word check;
    - the newcomer's join page with the version 1 words;
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

Who is in which group and their roles, which accounts are child accounts with their `adult_from` dates and guardians, when guardians fetch a child's seal, who invited and admitted whom and when, who signed each roster, invitation addresses until accepted or expired, how many areas a group has and their padded sizes, and the group's name. Rosters and successions carry only public keys, which the server already serves.

The group name is plaintext because it appears in invitation emails and on bills. A group that does not want its name known can choose a neutral one.

## 7. Tests that must exist

Each fails on a defect a person would notice (see AGENTS.md):

- **Encoding:**
    - TS and Rust produce identical bytes for every statement in the fixtures;
    - a document that parses but re-encodes differently is refused;
    - a version above 2^53−1, an uppercase id and a hex digest are refused.
- **Group signatures:**
    - a roster or succession whose Ed25519 signature is valid but whose ML-DSA signature is not, or the reverse, is refused;
    - the fingerprint changes when either public key changes.
- **Roster:**
    - refused: a forged signature, a version that is not previous + 1, a wrong previous digest, a signer who is not an active `members` holder on the previous roster, and a missing or wrong signer identity signature;
    - an entry whose identity changed without a verifiable succession chain stays unchanged;
    - two rosters with one version, or a chain that does not join, raise the hard warning and drop roster verdicts.
- **Succession:**
    - a second succession from one `oldVersion` freezes roster trust;
    - a roster signed by an old key after its succession is refused;
    - a roster after a `members` holder's removal without a succession is refused.
- **Seals and grants:**
    - a key seal whose seed does not derive the published keys, or whose sealer is not an active `members` holder, is refused;
    - a grant from a `left` granter, below the area's high-water version, for another group or workspace, or under another seal kind's `info`, does not open.
- **Verdicts:**
    - roster trust gives `verified` inside the group's areas and nothing outside them;
    - a legitimate identity succession is followed, not reported as `key-conflict`;
    - a disagreeing pin with no chain is `key-conflict`;
    - a `left` writer is marked;
    - a roster that fails to load gives `unchecked`.
- **Admission:**
    - the transaction lands whole or not at all (membership, roster, grants, seat);
    - a concurrent second admission on the last seat gets 402;
    - admission with a stale roster version gets 409.
- **Leaving and removal:**
    - the server stops serving grants at once;
    - rotation gives the area root a new node key in the same request and grants only to remaining members.
- **Storage:**
    - a free-tier member's personal uploads count against the pool;
    - a member who kept their own plan uploads against it, never the pool;
    - a per-member cap refuses uploads only;
    - after leaving, uploads count against the member's own plan and, over it, are refused while nothing is deleted.
- **Child accounts:**
    - registration without a seal for every `guardian` entry is refused;
    - no seal is made to an entry without the `guardian` role;
    - guardian resets and policy changes from `adult_from` are refused;
    - conversion authorised by a registered device key succeeds after a guardian reset;
    - after conversion the old identity, settings key and personal workspace key open nothing new;
    - every seal fetch appears in the child's record;
    - an existing adult account cannot become a child account.
- **Ids:** a group or area id not derived from its seed and scope is refused.

## 8. Open questions

- **Polar mechanics** for per-member billing beyond the included members: a quantity on one subscription or a second per-member product. A short billing spike settles it before 3.5 is built; it also confirms the prorated refund when a member switches from their own plan to the pool.
- **Post-quantum identity signatures.** People's identity keys sign with Ed25519 only, so writer signatures, seals and identity successions could one day be forged live by a quantum adversary. The fix is a hybrid ML-DSA-65 identity signing key, added through an identity succession, with every statement carrying both signatures. It touches every client and the integrity design, so it is its own design.
