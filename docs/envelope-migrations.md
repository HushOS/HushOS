# Envelope migrations: groups and post-quantum identities

This is the last document of Phase A in the groups build plan. Revised on 15 October after the independent review in `docs/pq-devices-crypto-review.md`. It lists every envelope, signature and stored format that the group core (`docs/groups-design.md`) and post-quantum identities (`docs/identity-pq-design.md`) introduce or change. For each one it says how the format is versioned, who migrates existing data, in which release, and how the old form is retired.

Most of the group core needs no migration: groups, rosters, seals and area grants are new, and are written in their final form from the first byte. What does migrate is:

- the identity itself;
- the signatures that anchor trust (identity keys, successions, shares);
- shares;
- the settings document;
- one database column set;
- the full re-key a child account runs at conversion, which is a migration of one account's every envelope.

## Rules for every migration

1. **Every format names its version in bytes that are authenticated.** A version, a suite or an `info` label sits in the associated data, the statement or the key derivation, so that a downgraded envelope opens as nothing rather than as the older form. A version kept only in a database column or a JSON field is a label, not protection.
2. **Read before write.** A new format is readable on every client for one release before any client writes it. The API has no client-version header, so formats are gated by format: once an account has moved, the server refuses that account's old form ("Update HushOS to …", 409 `unsupported`), as it did for share suites 1 and 2. The post-quantum change is the exception: production holds mostly test accounts, so it reads and writes the new formats in one release and drops the old ones at once (`docs/identity-pq-design.md` 10, decision 1).
3. **The owner's devices migrate; the server never re-encrypts.** The server orders, counts and refuses. Every rewrite happens on a device that holds the keys, inside the upgrade pass (`upgradeShares` and its successors in `packages/drive/src/client.ts`), in the background after Drive opens.
4. **Resumable and idempotent.** Each item names the version it expects; a changed item is reported stale and retried later; batches are at most 200. Stopping halfway leaves every item in one form or the other, and each form reads.
5. **Never downgrade.** A device that has seen the newer form of something for an account refuses the older one: local marks for the identity as `(keyVersion, identityVersion)`, pins that refuse fewer keys, and the settings high-water mark.
6. **Retirement is its own release.** A reader is removed only by a release that says so, after the server's counts show what is left. If something is lost, the release says what, as Round 3 did for the three settings version 1 rows. Nothing is retired silently.

## Inventory

| Format                                                                | Now                                                    | Changes to                                                                                            | Who migrates                                                    | Retired                                                   |
| --------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------- |
| Identity envelope                                                     | v1 (X25519, Ed25519, optional ML-KEM with KEM binding) | v2: adds ML-DSA-65 and the keys statement, same `keyVersion`                                          | Each account's first device after the PQ release (section 3)    | v1 remains only in history rows of earlier successions    |
| Identity succession                                                   | statement v1, Ed25519                                  | v2, hybrid                                                                                            | Written new; existing links stay as history                     | v1 links no longer followed: a words check instead        |
| Writer signatures (all forms)                                         | statement v1, Ed25519                                  | Unchanged for now; the planned upgrade is `docs/identity-pq-design.md` 7                              | -                                                               | -                                                         |
| Share envelopes                                                       | suite 3, 1256 bytes                                    | suite 4, 4565 bytes                                                                                   | Granter's upgrade pass (ledger), once both sides compared words | At the PQ release: suite 3 stops opening until re-sealed  |
| Settings document                                                     | envelope v2; document v1 (`contacts`, `sharing`)       | document v2: version 3 pins, `groups`                                                                 | Any client that saves settings after the PQ release (section 2) | Document v1 read and saved as v2; v1 never written again  |
| Workspace grants (root-wrapped)                                       | v1 under `hushos/workspace/grant-wrap/v1`              | Unchanged; also used for area self-grants (section 5)                                                 | -                                                               | -                                                         |
| `workspaces`                                                          | id and counters; personal via `personal_workspaces`    | `owner_kind`, `group_id`, `area_kind`                                                                 | SQL migration with a backfill (section 1)                       | -                                                         |
| Node keys, metadata, content keys, objects                            | `DRIVE_ENVELOPE_SUITE` 1, content suites 1 to 3        | Unchanged; areas use the same tree                                                                    | -                                                               | Content suites 1 and 2 keep reading (those objects exist) |
| Group key seal, roster, succession, area grant, guardian seal         | -                                                      | New, hybrid from version 1, suite 4 construction                                                      | Written new                                                     | -                                                         |
| Links, reports, settings key, password, recovery and device envelopes | as today                                               | Unchanged by these designs; rewrapped by a conversion (section 7), links with their secrets unchanged | -                                                               | -                                                         |

## 1. Database: who owns a workspace

`workspaces` gains `owner_kind` (`personal` or `group`), `group_id` and `area_kind`:

- The migration adds them nullable, backfills `owner_kind = 'personal'` for every workspace with a `personal_workspaces` row, then sets `owner_kind` not null.
- Today every workspace has such a row; the migration checks that there are none without one before the not-null step, and fails rather than guess.
- **Constraints:** `personal` exactly when a `personal_workspaces` row exists; `group` exactly when `group_id` is set; `area_kind` set exactly for `group`.
- **Nothing inside an envelope changes.** `workspaceId` is already bound into every envelope and signature, and ids are already scoped to it.
- `GET /api/drive/workspace` keeps answering the personal workspace for shipped mobile builds; `GET /api/drive/spaces` is new.

## 2. The settings document, version 2

The document inside the settings envelope is version 1 today:

- `openSettings` refuses any other document version;
- clients claim to keep unknown fields when they save.

That claim is not enough for pins. A version 1 client that rebuilds a contact's pin (to follow a succession, or to compare words again) writes the fields it knows. It would drop `mlDsaPublicKeyHash` and quietly turn a version 3 pin back into a version 2 one. Old clients must therefore not be able to save the new document at all.

- **Document version 2** adds version 3 pins (`mlDsaPublicKeyHash`, a required `kemPublicKeyHash` and the version 3 fingerprint; `docs/identity-pq-design.md` 2) and the `groups` pins of groups-design 2.7. Pins hold SHA-256 digests of the ML-DSA and ML-KEM keys, never the keys, so the document stays far below its 64 KiB cap.
- **Who writes it.** A client writes version 2 the first time it saves a document that holds either. Clients from the PQ release on read both versions. Older clients refuse a version 2 document, which makes them fail closed (Couldn't check) and unable to save, instead of dropping fields.
- **The rollback mark is unchanged.** It covers the envelope's sequence number, whichever document version is inside.
- **A missing document is not an empty one.** A settings row served with no document at a sequence above 0 reads as Couldn't check, never as empty, and the client does not save over it. That path existed for the three version 1 rows Round 3 retired; none are left, and reading it as empty would let a server erase every pin, the sharing ledger, group pins and area marks with one save, which the rollback mark does not catch because the sequence does not go down.
- **Pins within a document.** A pin with an ML-DSA digest is never replaced by one without; a client that would do so refuses and shows the changed-key warning.

## 3. Identity version 2

This is the format in `docs/identity-pq-design.md`. The migration:

- **On unlock**, a client whose account's current identity is version 1 makes an ML-DSA seed, wraps it under the account root, opens the wrapped seed again and checks the public key, signs the keys statement and calls `POST /api/auth/identity/upgrade`, before it signs anything else.
- **In place.** The X25519, Ed25519 and ML-KEM keys and the `keyVersion` stay; no history row and no succession link are written. Nothing has to be sealed to new keys; shares are re-sealed in suite 4 for the format (section 4).
- **Several devices at once.** The server takes the first upgrade and answers the others 409 `stale` with the new identity, which they open and adopt. Their own seeds are discarded unsent.
- **Master-key rotation** rewraps the ML-DSA seed in the current identity and in every history row that has one. The rotation request already carries the whole history, and the server checks each row's public keys are unchanged and refuses a changed `keyVersion` on a version 2 identity. A password change rewraps nothing, because the root does not change.
- **Recovery.** A reset by recovery phrase unwraps the root, so the ML-DSA seed comes back with everything else.
- **New accounts** are created at version 2.
- **Contacts** compare words again: a pin made before the release is not carried forward by any signature (`docs/identity-pq-design.md` 2).

## 4. Shares

File and folder signatures do not change (they stay Ed25519, and keep verifying because the upgrade keeps the Ed25519 key). Shares are re-sealed: the upgrade pass runs `upgradeShares({ all: true })` after the identity upgrade. Re-sealing needs a version 3 pin of the grantee, and the grantee opens suite 4 only against a version 3 pin of the granter, so a share opens again once both sides have compared words with each other and the granter has signed in since (`docs/identity-pq-design.md` 3). Until then People shows "Shares from Maya open once you've both compared words."

## 5. Group areas: self-grants

An area grant (groups-design 2.6) is sealed to a member's identity: X25519 and ML-KEM decapsulation plus a signature check, every time it is opened. The first time a member's device opens one, it also writes the same workspace key as an ordinary **self-grant**: a `workspace_keys` row wrapped under the member's own root, as for the personal workspace (`createWorkspaceGrant` with the opened key, `workspaceKeyVersion` from the grant). From then on:

- **Unlock opens areas the way it opens the personal workspace:** one HKDF and one AEAD, with no decapsulation per area.
- **Root changes need no re-grant.** A master-key rotation rewraps the area's self-grant along with the rest, as it does for the personal workspace.
- **Identity changes need no urgent re-grant.** After the member's identity succession, the area keeps opening through the self-grant. Holders re-grant to the new keys at the next roster fold-in, as groups-design already requires.
- **The area grant's checks run once.** Only an area grant that passes groups-design's checks (an active granter, this group, at or above the high-water version) is turned into a self-grant. The server accepts a self-grant only for an area the caller is an active member of, at the area's current `workspace_key_version`.
- **The version check runs on every open.** Each time a device opens a self-grant, it compares the self-grant's `workspaceKeyVersion` with the area's high-water mark (groups-design 2.7) and with the area's served `workspaceKeyVersion`. When either is higher, the device ignores the self-grant, opens the area grant instead, and writes a new self-grant from it; with no area grant at that version, the area is Couldn't check. Otherwise a server could serve a self-grant from before a rotation, and the member would write under a key a removed member holds.
- **Leaving.** When a member leaves, the server deletes their self-grants with their area grants. They already held the key; rotation is what takes it away.

`workspace_keys` keeps one row per member per workspace (its primary key), holding the latest version. That is all an area needs, because a rotation gives the area root a new node key with the version bump (groups-design 2.6).

## 6. Moving files between spaces

`workspaceId` is bound into every node, version and share envelope and every signature, and ids are derived from it. A file therefore cannot move between workspaces in place. Moving something from a personal space into a family area, or back, is:

1. **A copy into the target workspace, with every version.** This is the cross-workspace copy that saving from a share already does, extended to each earlier version: new scoped ids, node keys wrapped under the target parent, every version's content-key envelope re-sealed in order, objects shared rather than re-uploaded where the server allows it, and quota charged to the target for every version.
2. **Signatures by where the copy came from**, as in "Saved copies, by where they came from":
    - a verified original gets ordinary statements by the mover;
    - anything else is re-sealed.
3. **The source moved to trash** in the same flow, once the copy has completed, so a failure leaves two copies rather than none.

**What the move dialog says:**

- The trashed original stays recoverable for 30 days in the source space.
- Shares and links on the original stay on the original; they do not follow the copy.
- Earlier versions move with the file. For the 30 days the original sits in trash, the file counts against both spaces; emptying the trash frees the source sooner.

**Signatures, version by version.** Each version's signature is judged on its own: an earlier version may be unverified when the current one is verified, and it is then re-sealed while the current one gets ordinary statements.

- A record verified only through a group's roster becomes an ordinary personal signature by the mover. Outside the group's areas it is the mover's word, not the group's.
- A move keeps every version's content key, so anyone who could open those versions before, such as a member or a link visitor of the source, still can if they kept the keys.

**What the server learns** from a move between spaces is what it learns from a copy and a trash, which it learns today.

## 7. Child accounts: conversion, release and guardian removal

Conversion, early release and guardian removal re-key the whole account (groups-design 3.6), because a guardian who opened the child's root holds everything that root wraps. Every envelope of the account is rewritten. Groups-design lists the root, identity, settings key, workspace key and shares. **It leaves out three things a guardian can also hold, and without them the re-key fails:**

- **The password.** After a guardian reset (3.6, step 4), the guardian chose the current password. A new root wrapped under that same password opens to the guardian at the next sign-in. Conversion must register a new password with OPAQUE in the same request, and end every session.
- **The recovery phrase.** It is shown on whichever device the child signed up on, which may have been the guardian's, and a guardian who holds the root can read it from the phrase backup that the root opens (`packages/crypto/src/recovery.ts`). The new root must be wrapped under a new recovery phrase, shown only on the converting device, and the old recovery envelope deleted.
- **Other devices.** A device unlock bundle wraps the root under a device key. Any registered device other than the converting one, including one on a guardian's computer, must be signed out, its bundle and device signing key deleted, and re-enrolled by password afterwards.

### Order

A conversion is requested, held for 7 days, then run. In the run, the switch comes first and the rotation after it. A run that dies halfway must never leave data wrapped under a root the server does not know. Early release and guardian removal skip the request and the hold: the child's device runs the switch at its next sign-in (groups-design 3.6, step 9).

1. **The request (`POST /api/auth/convert`),** signed by a registered device key:

    ```
    ["hushos/account/convert-request",1,userId,attemptId,deviceSigningKey]
    ```

    It starts the 7-day hold and notifies the account's email and every device, any of which can cancel it. Only the requesting device can run the switch, and only after the hold.

2. **The switch, in one transaction (`POST /api/auth/convert/:attemptId/switch`),** signed by the same device key:

    ```
    ["hushos/account/convert",1,userId,attemptId,deviceSigningKey,sha256(passwordEnvelope) | "",sha256(recoveryEnvelope),sha256(successionStatement),sha256(settingsEnvelope)]
    ```

    - the new root's password envelope (new OPAQUE registration), or none under Keys need a device, and its recovery envelope (new phrase);
    - the identity succession to new keys (version 2 identity, hybrid-signed by the old identity);
    - every history identity rewrapped under the new root;
    - a new settings key with the settings re-sealed;
    - every `workspace_keys` row of the account rewrapped under the new root: the personal workspace's grant and every area self-grant (section 5), as master-key rotation already must;
    - deletion of every guardian seal, every other device's bundle and key, and every other session.

    After this, a guardian who is not hostile holds keys to what existed before, and no password, phrase, device or session of the account. That is all the switch achieves; "What conversion does not stop" below lists what a hostile guardian keeps.

3. **The rotation.** The personal workspace key version is bumped and a full `drive_rotations` run re-keys the tree under the new workspace key, as master-key rotation's tree pass does. It is resumable through `drive_rotations`. Uploads made meanwhile get content keys under the new key version, but a file created in a folder the rotation has not reached yet is wrapped under that folder's old node key, and the rotation later rewraps it with its keys unchanged.
4. **Re-sealing.** The ledger's shares are re-sealed in suite 4 by the new identity. Links are re-sealed by the rotation as today (`unsealableLinks`), with the same secrets, so every link URL keeps working. The conversion screen lists the account's links and suggests creating them again.
5. **Family areas.** Holders fold the new identity into the next roster (its chain verifies through the hybrid succession) and re-grant the family areas. Until then the child's self-grants, rewrapped in the switch, keep the areas open.

**Pending on the device.** Until the switch lands, the new root, the new identity seeds and the new settings key are kept only on the converting device, sealed under its device key. A device lost before the switch loses nothing, because the old root still opens everything. After the switch, everything needed is on the server under the new password and phrase.

**After conversion,** a device approval level a guardian required lapses with the guardian. A level the young adult chose stays, and their devices, all signed out by the switch, enrol again under it (`docs/devices-design.md` 6).

### Who can start a conversion

Conversion is authorised by a registered device key, so that it works after a guardian reset. But a device key can be held by the guardian:

- the child may have signed up on the guardian's device (3.6, step 1);
- or the guardian may have reset the password and signed in as the child on their own device, which registers a key;
- or the guardian may have read the phrase from its backup under the root and approved a device of their own with it.

From `adult_from`, a guardian with such a key can request a conversion as easily as the young adult can.

**The rule (agreed 2026-10-15, revised by the owner the same day after the review):** device approval, which every account gets (`docs/devices-design.md`), and a 7-day hold on every conversion.

- **Child sign-up is meant to run on the child's own device**, from the link. Nothing enforces it: the link is returned to the guardian, and whoever opens it registers the enrolment device and sees the phrase.
- **A guardian decides** whether the child account requires a device approval level (`docs/devices-design.md` 6). With one on, a new device needs approval from a device already registered to the account, or the recovery phrase; with none, the password signs a new device in, as on any account.
- **Both lost.** If the child has lost every device and the recovery phrase, a guardian may approve a new device for them. That device is marked "approved by a guardian" in the child's record, and the child is asked to set a new recovery phrase on it.
- **Every conversion is held for 7 days**, with a notice to the account's email address and to every device, any of which can cancel it. There is no instant path. The server cannot tell who holds the phrase, the enrolment device or a device either of them approved, so no credential the account held before `adult_from` tells the young adult from a guardian who knows the password.
- **Devices are disclosed.** Every registered device appears in the child's record with its name, when it was registered and who approved it, and from `adult_from` the account holder can remove any of them.

### What conversion does not stop

Conversion re-keys the account against a guardian who is not hostile. A hostile guardian, especially one who runs the server or works with whoever does, can keep or regain access:

- **The phrase backup.** The root they hold opens the recovery-phrase backup, so they can learn the phrase, approve a device of their own with it, and use that device to request a conversion or cancel one.
- **Links.** They could open every link's sealed copy before conversion and collect its URL, and links keep their secrets through the rotation, so they can open every linked file and folder as a visitor, including what is added to a linked folder later.
- **Successions.** The conversion's identity succession is signed by keys they hold, so with the server's help they can serve contacts and family holders a succession to keys of their own, or keep the shares that contacts still seal to the old identity.
- **Cancelling and racing.** Any device of the account and the account's email can cancel a held conversion, and the first conversion to finish wins, so a guardian with a device or the mailbox can cancel each conversion the young adult requests, or convert first.
- **Folder keys during the rotation.** A file written into a folder the rotation has not yet reached is wrapped under that folder's old key, which they hold, and with the server's copy of its envelope they read it.

On the web, a server they run can also serve altered code. HushOS does not try to stop a hostile guardian beyond the re-key; the security page says what conversion does not protect against.

## 8. Group envelopes and future versions

The group statements are version 1 and hybrid from the start, and their seals use the suite 4 construction under their own `info`. When one of them changes, the next version changes, together:

- the statement's version number;
- the HKDF `info` (`…/v2`);
- the associated data.

That way a version 2 seal stripped or relabelled as version 1 opens as nothing.

**Identity successions inside groups** re-seal two things, each on its next sign-in:

- **Guardian seals:** the child's device re-seals to a guardian's new identity (groups-design 2.9).
- **Group key seals:** the next `members` holder to open the group re-seals the group seed to a holder's new identity once the roster has folded it in.

Old seals to the previous identity are deleted when the new one lands. Until then they still open with the holder's history keys, which is why history keeps every identity's private keys.

## 9. Release order

| Release           | Ships                                                                                                                                                                                                               | Gate                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| PQ                | Identity v2 with the upgrade on unlock, hybrid keys statements and successions, suite 4, settings document v2, version 3 fingerprints; suite 3 and version 1 successions retired; `workspaces` columns and backfill | -                                  |
| Group milestone 1 | Families on the group core, hybrid throughout; self-grants; moves between spaces                                                                                                                                    | PQ                                 |
| Child accounts    | Section 7, on device approval                                                                                                                                                                                       | Group milestone 1; device approval |

## 10. Tests that must exist

Each fails on a defect a person or an attacker would notice (see AGENTS.md):

- **Backfill:** the migration fails on a workspace without a `personal_workspaces` row rather than guessing; every existing workspace reads `personal` afterwards.
- **Settings:**
    - a version 1 client refuses a version 2 document (fails closed) and cannot save over it;
    - a version 2 client never writes a pin without the ML-DSA digest it held;
    - a settings row served with no document at a sequence above 0 reads as Couldn't check, and the client does not save over it.
- **Identity upgrade:**
    - two devices upgrading at once end with one identity, and the loser adopts it;
    - a master-key rotation after the upgrade keeps the ML-DSA seed openable in the identity and the history;
    - the upgrade leaves the X25519, Ed25519 and ML-KEM keys and `keyVersion` unchanged;
    - a device that has seen its account's version 2 identity refuses the version 1 form.
- **Shares:** after a granter's upgrade pass, every share in their ledger whose grantee they have compared words with opens in suite 4, and none opens in suite 3.
- **Self-grants:**
    - a self-grant is written only from an area grant that passed its checks;
    - the server refuses one for an area the caller is not active in, or at an old key version;
    - a served self-grant below the area's high-water mark or served key version is not used, and the device opens the area grant instead;
    - leaving deletes it.
- **Moves:** every version arrives in order in the target; a failed copy leaves the source untouched; a completed move leaves the source in trash with its shares; the copy's signatures follow the saved-copy rules, version by version, so an unverified earlier version is re-sealed beside a verified current one.
- **Conversion:**
    - after the switch, the old password, the old recovery phrase, another device's bundle and every guardian seal open or sign in to nothing;
    - after the switch, every `workspace_keys` row of the account, area self-grants included, opens under the new root and none under the old;
    - under Keys need a device, the switch carries no password envelope and one that does is refused;
    - a run interrupted before the switch leaves the account fully readable under the old root;
    - one interrupted after the switch resumes the rotation;
    - with a level the guardian required, a new device on a child account cannot sign in without approval from a registered device, the phrase, or (with both lost) a guardian;
    - every conversion, from the enrolment device and phrase-approved devices too, completes only after 7 days, and is cancelled by the email link or any device;
    - a switch from a device other than the one that made the request, or before the hold ends, is refused.
- **Group versions:** a group seal relabelled with another version or another kind's `info` does not open.

## 11. Decisions (agreed 2026-10-15)

1. **Settings document version 2** as the gate that stops old clients from saving over version 3 pins (section 2).
2. **Self-grants for areas** (section 5).
3. **Moves between spaces copy every version, then trash the original**; shares and links stay on the original (section 6).
4. **Conversion** registers a new password and a new recovery phrase and signs out every other device in the switch transaction, then rotates the drive (section 7).
5. **Device approval for child accounts** (section 7), including the guardian path when both device and phrase are lost. A guardian decides whether a child account requires an approval level (`docs/devices-design.md` 6). Device approval for every account, with push notifications, is its own design.
6. **Every conversion is held for 7 days** (owner, 2026-10-15, after the review), with notices to the account's email and every device; there is no instant path. This replaces the instant path for conversions from the child's own or phrase-approved devices.
7. **A hostile guardian is out of scope beyond the re-key** (owner, 2026-10-15). The routes they keep are listed in section 7 as residuals, not designed against.
