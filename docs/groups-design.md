# Groups: the core families and companies share

This document fixes the group core: groups, members, invitations, the signed roster that lets members trust each other, shared areas, spaces, pooled storage and the payer. Family plans ship on it alone; company plans add the custody key, admin browse, policies, audit, offboarding, storage control, domains and SSO on top (see the build plan, "HushOS for Companies — Build Plan", whose 25 decisions this follows). Each statement below is the exact byte layout the web (`packages/crypto`) and the Rust core (`crates/hushos-core`) must produce and accept, pinned by shared fixtures.

Nothing here changes what the server can read. It learns who is in which group, which it must know to authorise anything; every key it handles stays sealed.

## 1. Model

| Table                   | Holds                                                                                                                                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `groups`                | `id` (client-derived), `kind` (`family` or `org`), `name` (plaintext, see Privacy), `group_key_version`, `roster_version`, `created_by`, `created_at`                                           |
| `group_memberships`     | `(group_id, user_id)`, `state` (`invited` → `accepted` → `active`; `left`, `removed`), `capabilities` (`members`, `billing`; companies add `data_admin`, `recovery`), `admitted_by`, timestamps |
| `group_keys`            | One row per holder of the group signing key: `(group_id, group_key_version, user_id)`, the sealed seed (see 2.2), `sealed_by`                                                                   |
| `group_key_successions` | `(group_id, old_version, new_version)`, both public keys, the old key's signature                                                                                                               |
| `group_rosters`         | `(group_id, version)`, the roster document and its signature; the latest is served, earlier ones kept for clients catching up                                                                   |
| `group_invitations`     | `id`, `group_id`, `normalized_email`, `token_hash` (as `account_enrollments`), `capabilities`, `invited_by`, `expires_at`, `state`                                                              |
| `area_grants`           | `(workspace_id, workspace_key_version, user_id)`, the sealed area key (see 2.5), `granted_by`                                                                                                   |
| `group_storage`         | `group_id`, pooled `quota_bytes` from the plan and entitlements                                                                                                                                 |

`workspaces` gains `owner_kind` (`personal` or `group`), `group_id` and `area_kind` (`shared` now; `employee` for companies later). A group's shared area is a workspace like any other: tree, rotation, versions, trash, change feed and quota code run unchanged on it.

## 2. Cryptography

Statements are canonical JSON arrays, UTF-8, no spaces, lowercase ids, byte strings as base64url without padding, as in `docs/integrity-design.md`. Signatures are Ed25519 (`crypto_sign_detached`; `verify_strict` in Rust).

### 2.1 Ids

Two new id kinds for `deriveId`/`derive_id` (see "Ids derived from a seed and a scope"): `group`, scoped to the creating user's id, and `workspace`, scoped to the group id. Both are bound into statements before their rows exist, so the client derives them and the server checks the seed, as for nodes.

### 2.2 The group signing key

A 32-byte Ed25519 seed made on the creator's device. Its public key is the group's identity; its fingerprint, shown as twelve words exactly as a person's are, is:

```
SHA-256("hushos/group/fingerprint/v1" || groupId (UTF-8) || signingPublicKey)
```

The seed is sealed only to members holding `members` (in a family, the organizer), with the share suite 3 construction (ephemeral X25519 + ML-KEM-768 to the holder's identity, signed by the sealer) under its own statement:

```
["hushos/group/key-seal",1,groupId,groupKeyVersion,holderUserId,holderKeyVersion,sealerUserId,sha256(sealed)]
```

### 2.3 The roster

One signed document names every member and their keys:

```
["hushos/group/roster",1,groupId,kind,rosterVersion,previousRosterDigest,groupKeyVersion,members]
members = [[userId,keyVersion,encryptionPublicKey,signingPublicKey,kemPublicKeyDigest,status,sinceVersion], ...]
```

Sorted by `userId`. `status` is `active` or `left` (a member who left or was removed); `sinceVersion` is the roster version the entry last changed at. Entries for former members stay, so their earlier work can be labelled. `previousRosterDigest` is the SHA-256 of the previous roster's statement bytes (empty for version 1), so rosters form a chain. The signature is over the statement bytes, by the group key at `groupKeyVersion`.

A client accepts a roster only if: the group key is pinned and its words were checked (2.6); the signature holds under that key, or under a key reached from it by verified successions (2.4); `rosterVersion` is at least the highest version this person has seen for the group; and its `previousRosterDigest` matches the previous roster this device holds, when it holds it. Anything else leaves members' records at their personal-check verdict, never better. A client that sees two different rosters with the same version, or a chain that does not join, raises a hard warning ("Acme's member list was shown differently to you") and keeps the newest roster it can verify.

### 2.4 Group key succession

When a `members` holder is removed, or the key may be exposed, a holder makes a new key, signs the step with the old one, re-seals the new seed to the remaining holders and signs the next roster with the new key:

```
["hushos/group/key-succession",1,groupId,oldVersion,newVersion,oldSigningPublicKey,newSigningPublicKey]
```

Pins follow successions automatically, by key continuity like identity successions; the pinned words stay valid.

### 2.5 Area grants

An area's workspace key is granted to a member by the same suite 3 construction, under:

```
["hushos/group/area-grant",1,groupId,workspaceId,workspaceKeyVersion,granteeUserId,granteeKeyVersion,granterUserId,sha256(sealed)]
```

The grantee opens it only if the granter is someone they trust (personally checked, or on a verified roster) and the context matches. Rotating an area key bumps `workspace_key_version`, re-wraps the root node key under the new workspace key and seals new grants to the remaining members; node keys below rotate through the existing `drive_rotations` machinery.

### 2.6 Pins and rollback

The settings document gains `groups: { [groupId]: { signingPublicKey, keyVersion, checkedAt, rosterVersion } }`, preserved as unknown fields by older clients like every settings field. Each device also keeps a per-user, per-group roster high-water mark in local storage, as it does for settings; the mark in use is the higher of the two.

### 2.7 What readers show

Verdicts gain three values in TS and Rust:

| Verdict                        | When                                                                            | Shown                                        |
| ------------------------------ | ------------------------------------------------------------------------------- | -------------------------------------------- |
| `verified` with `via: groupId` | The writer's key is on a verified roster and the signature holds                | No mark; Info: "Verified by Acme"            |
| `key-conflict`                 | The person's own pin of the writer and the roster disagree on the writer's keys | A hard warning, worse than Unverified        |
| `former-member`                | The writer's entry has status `left`                                            | Neutral: "Written by Sam, who has left Acme" |

A personal check wins over the roster when they agree; the roster never overrides a disagreeing pin silently.

## 3. Flows

### 3.1 Creating a family

The organizer's client derives the group id, makes the group key, signs roster version 1 with only the organizer, seals the seed to itself, and calls `POST /api/groups`. The organizer gets `members` and `billing`. Creating the first shared area ("Family") is part of the same flow.

### 3.2 Joining (invitation, acceptance, admission)

1. A `members` holder invites an email address; the server mails a link with a one-time token in its fragment (`/join#invite=<token>`), hashed at rest as sign-up tokens are.
2. The invitee signs in or signs up, opens the invitation and accepts. Membership moves to `accepted`; nothing opens yet, and no seat is taken.
3. The admitting admin and the newcomer compare words once, in person or on a call through another service, never in a message sent through HushOS: the admin reads the newcomer's twelve words from its own screen and the newcomer reads the group key's. Both are required; there is no skip, and the admit button stays disabled until both sides have confirmed.
4. The admin's client signs the next roster with the newcomer added, seals the shared areas' keys to them (and the group key, if they get `members`), and calls admit. The server applies membership, roster, grants and the seat in one transaction.
5. The newcomer's client verifies the roster against the group key it just checked and pins the group.

### 3.3 Leaving and removal

- **Leaving:** the member calls leave. Their membership becomes `left` at once and the server stops serving them the group's areas and grants. The next `members` holder to open the group signs a roster marking them `left` (the server reports it as due) and rotates the areas they could open.
- **Removal:** a `members` holder removes someone with the next roster in the same call. Rotation of their areas is queued as above. Removing a `members` holder also requires a group key succession.
- **A family member who leaves keeps their files:** their personal space was always theirs. They lose the family folders, and their personal storage moves from the family pool back to their own plan; over its limit, uploads are refused until they make room or upgrade, and nothing is deleted.
- **The organizer** must hand `members` and `billing` to another adult member before leaving. Dissolving a family deletes its shared areas after the 30-day trash period, with notice to every member; personal spaces are untouched.

### 3.4 Spaces

`GET /api/drive/spaces` lists the account's personal space and every group it is active in, each with the areas it can open and their grants. Clients switch between spaces (web: a switcher at the top of the sidebar and the space in the URL, `/app/s/<space>/…`; iOS: one Files location per space, each tied to its owner as the 13 October Files fix does; Android: one provider root per space). Leaving a space wipes its local state on every device.

### 3.5 Storage and the payer

- A group plan's quota pools across the group's areas and, for families, the personal spaces of members who draw from it. `freeBytes` for any workspace in the pool reads the pool.
- **One storage source per person**, as iCloud+ and Dropbox Family do it: a member on the free tier draws from the family pool automatically once admitted; a member who pays for their own plan chooses at admission, and later in Account, to keep it (their personal space stays outside the pool) or to switch (their subscription is cancelled with a prorated refund through Polar). Never both.
- **No stacking of free allowances:** the pool is the plan's size; a member's own free allowance is not added to it, so the pool does not grow with headcount.
- **What the organizer sees:** the pool's total and which members are at their cap, never each member's usage, which would show how active they are.
- **Optional per-member limits:** the organizer may cap how much of the pool a member's personal space uses; off by default. A member at their cap or with a full pool can still read, download and delete; only uploads are refused.
- The payer is a billing customer keyed by owner kind and id. Polar products carry `hushos_plan`, `quota_bytes`, and new `hushos_group_kind` and `included_members` metadata; members beyond those included are billed per member with no upper limit, and companies have a minimum seat count.
- Seats are counted at admission, never at invitation; a seat cut blocks new admissions and never removes anyone.

## 4. API contract

Base64url without padding everywhere; ids lowercase UUIDs. All routes need a session; group routes need active membership, and those marked **members** need the `members` capability.

### Groups

| Route                                             | Body → response                                                                                                                                               | Notes                                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `POST /api/groups`                                | `{ id, idSeed, kind, name, groupKey: { signingPublicKey, seal }, roster: { document, signature }, area: { workspaceId, idSeed, root, grant } }` → `{ group }` | Family first; `kind: 'org'` refused until the company release (409 `unsupported`) |
| `GET /api/groups`                                 | → `[{ id, kind, name, capabilities, state }]`                                                                                                                 | The caller's groups                                                               |
| `GET /api/groups/:id`                             | → `{ group, members: [{ userId, name, state, capabilities }], rosterDue }`                                                                                    | `rosterDue` lists leaves and successions a `members` holder should fold in        |
| `PATCH /api/groups/:id` **members**               | `{ name }`                                                                                                                                                    |                                                                                   |
| `GET /api/groups/:id/roster?after=<version>`      | → `{ roster: { version, document, signature, groupKeyVersion }, successions: [...] }`                                                                         | Successions since `after`, oldest first                                           |
| `PUT /api/groups/:id/roster` **members**          | `{ expectedVersion, document, signature }`                                                                                                                    | Folds in leaves and identity successions; 409 `stale` with the current version    |
| `GET /api/groups/:id/key-seal` **members**        | → `{ groupKeyVersion, seal }`                                                                                                                                 |                                                                                   |
| `POST /api/groups/:id/key-succession` **members** | `{ newVersion, newSigningPublicKey, signature, seals: [...], roster }`                                                                                        | Re-seals to every remaining holder in one call                                    |

### Invitations and admission

| Route                                                          | Body → response                                                                                                       | Notes                                                                                |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `POST /api/groups/:id/invitations` **members**                 | `{ email, capabilities }` → `{ id, expiresAt }`                                                                       | Mails the link; 7-day expiry; rate-limited per group and address                     |
| `GET /api/groups/:id/invitations` **members**                  | → open invitations                                                                                                    |                                                                                      |
| `DELETE /api/groups/:id/invitations/:invitationId` **members** |                                                                                                                       |                                                                                      |
| `POST /api/invitations/open`                                   | `{ token }` → `{ groupId, kind, name, inviter: { id, name }, groupKey: { signingPublicKey, keyVersion }, expiresAt }` | The newcomer's side of the word check; 410 when used or expired                      |
| `POST /api/invitations/accept`                                 | `{ token }` → `{ membership }`                                                                                        | Binds to the signed-in account; state `accepted`                                     |
| `GET /api/groups/:id/pending` **members**                      | → `[{ userId, name, identity }]`                                                                                      | Accepted, not yet admitted; `identity` is the served identity to check words against |
| `POST /api/groups/:id/members/:userId/admit` **members**       | `{ roster, grants: [{ workspaceId, workspaceKeyVersion, envelope }], keySeal? }`                                      | One transaction; 402 `seats` when the plan is full; 409 `stale`                      |
| `PATCH /api/groups/:id/members/:userId` **members**            | `{ capabilities, keySeal?, succession? }`                                                                             | Granting `members` needs a seal; taking it away needs a succession                   |
| `DELETE /api/groups/:id/members/:userId` **members**           | `{ roster }`                                                                                                          | Queues rotation of the areas they could open                                         |
| `POST /api/groups/:id/leave`                                   |                                                                                                                       | The organizer must hand over first (409 `organizer`)                                 |

### Areas

| Route                                                        | Body → response                                                                                        | Notes                                                                  |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `POST /api/groups/:id/areas` **members**                     | `{ workspaceId, idSeed, root, grants }`                                                                | `root` as for a personal root (node id and seed, envelopes, signature) |
| `GET /api/drive/spaces`                                      | → `[{ space: { kind, groupId?, name? }, areas: [{ workspaceId, role, workspaceKeyVersion, grant }] }]` | `GET /api/drive/workspace` stays for shipped mobile builds             |
| `POST /api/groups/:id/areas/:workspaceId/grants` **members** | `{ grants }`                                                                                           |                                                                        |
| `POST /api/drive/workspaces/:id/key-rotations`               | `{ fromVersion, toVersion, rootKeyEnvelope, grants }`                                                  | Any member holding the area key may rotate it; 409 `stale`             |

Every grant, seal and roster is checked by the server for shape and signature before it is stored, and refused with one uniform 400 otherwise; clients verify again and never rely on that.

## 5. Clients

- **Crypto (TS and Rust, with fixtures):** group key create, seal and open; roster sign and verify with successions; group key succession; area grant seal and open; the group fingerprint; the three new verdicts; `group` and `workspace` id kinds.
- **Web:** space switcher and URLs; group pages (members, invitations, pending admissions with the word check); the newcomer's join page with the group's words; settings `groups` pins; signer verdicts reading verified rosters.
- **iOS and Android:** spaces in the API clients; a Files location (iOS) and provider root (Android) per space, each owner-tied; the join and admission word checks; roster verification through the Rust core.

## 6. What the server learns

Who is in which group, their capabilities, who invited and admitted whom and when, invitation addresses until accepted or expired, how many areas a group has and their padded sizes, and the group's name. The roster carries only public keys, which the server already serves.

The group name is plaintext because it appears in invitation emails and on bills. A group that does not want its name known can choose a neutral one.

## 7. Tests that must exist

Each fails on a defect a person would notice (see AGENTS.md):

- Roster: a forged signature, a lower version than the device has seen, a roster signed by a removed holder's old key after a succession, and an entry whose keys differ from the member's served identity are all refused; two different rosters with the same version, or a chain that does not join, raise the hard warning.
- Verdicts: a writer on a verified roster is `verified` via the group; the same writer with a disagreeing pin is `key-conflict`; a `left` entry is `former-member`; a roster whose group key was never checked raises nothing above Unverified.
- Admission: the transaction lands whole or not at all (membership, roster, grants, seat); a concurrent second admission on the last seat gets 402; admission with a stale roster version gets 409.
- Leaving and removal: the server stops serving grants at once; rotation produces new grants only for remaining members; a removed `members` holder forces a succession.
- Grants: a grant for another workspace, epoch or grantee, or from an untrusted granter, does not open.
- Storage: a free-tier member's personal uploads count against the pool; a member who kept their own plan uploads against it, never the pool; a per-member cap refuses uploads only; after leaving, uploads count against the member's own plan and, over it, are refused while nothing is deleted.
- Ids: a group or area id not derived from its seed and scope is refused.

## 8. Open questions

- **Polar mechanics** for per-member billing beyond the included members: a quantity on one subscription or a second per-member product. A short billing spike settles it before 3.5 is built; it also confirms the prorated refund when a member switches from their own plan to the pool.
