# Optional verification: contacts and families

Design only. Nothing here is built. It changes `docs/identity-pq-design.md` 2 (contacts compare words before anything is trusted) and `docs/groups-design.md` 2.4, 2.7, 2.8, 3.2 and 3.6 (the join flow and the version 1 anchor), and the claims built on them. Where this document and those disagree, this one is the plan and they are updated in the PRs of section 8.

## Why

The owner's decision, 2026-10-26, in their words:

- "i dont like the matching thing, they should be able to match later like whatsapp/signal, just not in front, this product we are designing for layman but with features that advanced users can leverage if they need it"
- "adding contacts as well should have an optional verify step not a forced verify"
- "invite/join flow in family is really complicated"
- On copy: "dont say scary things", "or technical stuff unless they are looking for that".

Today nobody can share with a person until the two of them have read twelve words to each other, and nobody joins a family without three steps of comparing (the newcomer's words, then a join code with two hidden words typed back). That stops a dishonest server from swapping keys at first contact, and it is also why most people would never get as far as sharing. This design moves to trust on first use, as Signal and WhatsApp do: the first keys a device sees for a person or a family are remembered, any later change is noticed, and comparing words is something anyone can do at any time to upgrade "first seen" to "verified".

The cost is real and named in section 4: whoever runs the server can, for people who never compare words, put its own keys in front of the real ones at first contact.

## 0. Decisions in short

| Question                                 | Decision                                                                                                                                                                                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adding someone                           | Email, Add. They are a contact at once, remembered with the keys the server serves now (a first-seen pin). No words.                                                                                                                                                            |
| Sharing with someone not verified        | Works at once, sealed to the first-seen keys.                                                                                                                                                                                                                                   |
| Opening something from someone not added | Opens, and remembers the sharer with a first-seen pin.                                                                                                                                                                                                                          |
| "Not verified"                           | Quiet muted text on the Contacts list, the family's member list and the Info "Added by" line. No row mark on files, nothing in the share sheet.                                                                                                                                 |
| Verify                                   | "Check it's Maya", one tap from the contact, the member, or Info. Twelve words, They match. Writes a verified pin, as today. Existing verified pins stay verified.                                                                                                              |
| A signed key replacement                 | Followed, as today. A first-seen pin stays first-seen; a verified one stays verified.                                                                                                                                                                                           |
| An unsigned key change                   | New shares to them, re-sealing to them and opening new things from them pause until the person sees one calm notice and taps Continue (or checks). Nothing is ever sealed to new keys before that. Links are unaffected.                                                        |
| Family join                              | Invite, accept, Let them in. No words on either side. The admin's device builds the newcomer's entry from the keys the server serves (a first-seen pin); the newcomer's device accepts the family on first use and pins it.                                                     |
| Checking a family later                  | One comparison between any two members ("Check it's Sam"): twelve words, the same on both screens, worked out from the member list that let the later of the two in and both people's account ids. It verifies each one's keys for the other and each one's view of the family. |
| Who needs a check first                  | Managers (the `members` role): a twelve-word check before the role is given. Guardians and child accounts, when they exist. Decided 2026-10-26 (section 9).                                                                                                                     |
| `firstKeysChecked`                       | Becomes an anchor: `created`, `join` (a code compared), or `first-use`. First use is allowed only on the join path, with no marks.                                                                                                                                              |
| A member's unsigned change               | One calm Continue by a manager puts them back in the family folders, rotating every folder; no forced check. A manager's role waits for a check.                                                                                                                                |
| "Trust as family does"                   | Retired from the UI. Existing pins it wrote keep working.                                                                                                                                                                                                                       |
| Server                                   | No new route, column or migration. Family-changing routes gain a client floor of their own, built in for the web, so tabs from before this release can't change families; everything else keeps serving them (7.3).                                                             |
| Settings replaced by a newer copy        | Each device keeps a local guard of the people and families it has acted on, and uses a settings pin only if it agrees; anything else is the calm changed-account notice (2.8).                                                                                                  |
| Versions                                 | Settings stay document version 2; group pins and rosters unchanged; the device's joins record becomes version 4.                                                                                                                                                                |

## 1. Terms

- **Verified pin**: a version 3 contact pin whose `fingerprint` is the version 3 fingerprint over its four keys (`pinVerified`, Rust `pin_verified`, unchanged). Only a words check, or a family check (3.4), writes one.
- **First-seen pin**: a version 3 contact pin with the same key fields and `fingerprint: ""`. It records the keys this person's devices first saw for the contact, so a later change is noticed. It never passes `pinVerified`, on any client, old or new.
- **Legacy pin**: a pin without `mlDsaPublicKeyHash` (made before post-quantum identities). Today "Check again"; under this design it becomes first-seen on its own (2.5).
- **Checked family**: a family this person's devices accepted with an anchor the person vouched for: they created it, or compared a code with another member (at join, or later). Recorded in the synced settings (`familyChecks`, 3.4).
- **First-use family**: a family this device accepted over the version 1 keys the server served, with no mark at all, on the join path only. Pinned at once, so everything after first use is checked against it exactly as for a checked family.
- **Key commitment**: the version 3 fingerprint formula (`fingerprint` / `identity_fingerprint`) computed over a pin's four keys, whether the pin is verified or not. It is how two pins, or a pin and a staged admission, are compared. The pin's `fingerprint` field is never the identity of its keys: on a first-seen pin it is `""`, so two different first-seen pins would compare equal by it.
- **Check**: the user-facing word for both kinds of comparison. Screens say "Check it's Maya", never verify, fingerprint, key, code, pin, chain, roster or version (section 6).

## 2. Contacts

### 2.1 Today

`trustGrantee` (web `lib/contacts.ts`; iOS `Contacts.swift` `share`; Android `Vault.kt`) refuses to seal to anyone without a verified pin. `trustGranter` refuses to open a share from anyone without one ("Add Maya in Contacts and check their words to open what they shared"). `signersFromPins` gives Drive verdicts only from verified pins, so everything else reads `unknown-signer` with the amber Unverified mark. `comparePin` follows a succession only from a verified pin. Adding someone is Look up, then the twelve words, then They match; nothing is saved before They match.

### 2.2 The first-seen pin

```
ContactPin (first seen) = { userId, email, name, keyVersion, pinnedAt,
                            encryptionPublicKey, signingPublicKey,
                            mlDsaPublicKeyHash, kemPublicKeyHash,
                            fingerprint: "",
                            firstSeen: "added" | "shared-with-me" | "family" }
```

- Written from a served identity only when its keys statement holds (`identityVerifyKeys`, as `lookupContact` checks today): the ML-DSA and ML-KEM keys are then signed by the Ed25519 key being pinned. An identity that is not version 2 is not pinned ("Maya needs to sign in to HushOS once more before you can share with her", as today).
- `fingerprint` is the empty string, not absent: iOS 0.10.0 decodes each pin with `JSONDecoder` and a required `fingerprint: String`, and skips any pin that fails; Android reads it with `optString`. An empty string decodes everywhere and fails `pinVerified` everywhere.
- `firstSeen` is informational (Technical details, support). No rule reads it. Old clients keep it, as they keep every field they do not know (the web spreads the old pin, iOS edits the raw dictionary, Android edits the JSON in place).
- One trust rule, in both twins, replaces the ad hoc checks: `pinTrust(pin) -> 'verified' | 'seen' | 'legacy' | 'invalid'` (TS `packages/crypto/src/pins.ts`, Rust `contacts.rs` `pin_trust`). `verified` is `pinVerified`; `seen` is an empty fingerprint with every key field well formed (canonical base64url keys, 64 lowercase hex digests); `legacy` is no ML-DSA digest; anything else is `invalid`, which is treated as `legacy` (it can become first-seen again, never verified).
- **Keys are compared by their commitment, never by `fingerprint`.** Every place that asks "are these the same keys" computes the key commitment of each side. Today three places compare `fingerprint` strings to tie a staged admission to the admin's pin of the newcomer: `packages/crypto/src/outbox.ts` (`admits.fingerprint === pin.fingerprint`, about line 185), `crates/hushos-core/src/roster_calls.rs` (`admits` written at about line 397 and read at about 500 and 1391) and `apps/web/src/lib/groups/outbox.ts` (`admits`, about lines 91, 477 and 854). With first-seen pins, a newcomer's pin moving from first-seen keys K1 to K2 (a Continue between staging an admission and sending it) would still compare `"" === ""`, and the outbox would send grants sealed to K1, keys the pin no longer holds. PR 1 replaces `admits.fingerprint` with `admits.keys` (the commitment); an outbox entry written before, carrying only `fingerprint`, matches by commitment equality alone (the pin's key commitment equals that fingerprint exactly when the pin holds the keys it was taken over, verified or first-seen; sending then seals to the keys the admin had when the entry was staged, which this design allows either way, and `""` never matches). When an entry carries both, `keys` wins and `fingerprint` is ignored. Every other comparison of `.fingerprint` in the three clients and the core is audited in the same PR.
- **Why this is safe with old clients:** the definition of a verified pin does not change. An old client meeting a first-seen pin sees an unverified version 3 pin over the served keys: `comparePin` says `recheck`, it shows Check again, shares nothing and opens nothing through it, which is what it does for an unchecked contact today. Its own words check writes the fingerprint (and keeps `firstSeen`), which every client then reads as verified. Nothing an old client does can make a first-seen pin read as verified without a words check.

### 2.3 What each action does

| Action                                  | With a first-seen pin                                                                                                | With a verified pin                                       |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Add someone (Contacts, the share sheet) | Writes one, after the keys statement holds                                                                           | Already added; nothing changes                            |
| Share                                   | Sealed to the pinned keys (suite 4)                                                                                  | As today                                                  |
| Open something they shared              | Opens under the pinned Ed25519 key and the served ML-DSA key whose digest the pin holds (`granterKeysOf`, unchanged) | As today                                                  |
| Open something from someone not added   | Writes a first-seen pin from the keys the share came with, then opens                                                | n/a                                                       |
| Their records in my Drive               | Verdict `seen` (2.6): no row mark; Info "Added by Maya" and "Not verified"                                           | `verified`                                                |
| A succession signed by the pinned keys  | Followed (`comparePin` allows `succession` from `seen` too); stays first-seen; no notice                             | Followed; stays verified; a quiet line in Check it's Maya |
| A change with no signed chain           | Paused until Continue (2.4)                                                                                          | Paused until Continue or a check (2.4)                    |
| They match                              | Becomes verified                                                                                                     | Stays verified (pinned again over the served keys)        |

Following stays on the person's action, as now (adding, sharing, opening something of theirs, Check it's Maya), never in the background, so the server still cannot learn whom a device has pinned by watching what it looks up. Opening a share already carries the sharer's served identity, so pinning on first open asks the server nothing new.

### 2.4 When someone's keys change without a signed chain

This is Signal's "safety number changed", for HushOS. In practice it is rare: a signed replacement is followed on its own, so an unsigned change comes from "Start over with new keys" when the old identity could not sign (`docs/devices-design.md` 3), or from the server.

- **Detected** where the served identity is already in hand: adding or looking someone up, the share sheet, opening something of theirs, Check it's Maya. `comparePin` says `changed`.
- **Paused, for that person only:** new shares to them, re-sealing what was shared with them (rotation, upgrade passes), and opening anything signed by keys the pin does not hold. Everything else keeps working, including what they shared before, which still verifies under the pinned keys. Links are not tied to anyone's keys and never pause.
- **One notice**, the same wherever it is met (6.7). Continue replaces the pin with a first-seen pin of the new keys, keeps the old signing key in `previousSigningKeys` (so what they signed before reads as theirs with earlier keys, `retired-key`, as after a followed succession), sets `resealShares`, and lets the paused work run. That re-seals everything already shared with them to the new keys, not only what is shared from then on. A verified pin loses its verified state on Continue; Check it's Maya restores it over the new keys.
- **Never silent:** no client seals to keys the person has not either pinned, followed along a chain signed by pinned keys, or accepted with Continue. This is the rule that makes first use worth anything.
- For a contact who was verified, the notice leads with Check it's Maya (the blue button); for one who was not, with Continue (decided 2026-10-26).

### 2.5 Legacy pins become first-seen

A legacy pin whose X25519 and Ed25519 keys are the served ones, under an identity whose keys statement holds, is rewritten as a first-seen pin of the served keys the next time the person adds, shares with, opens from or checks that contact. The keys statement is signed by the Ed25519 key the person pinned before, so this carries real continuity; it is not made verified, because `docs/identity-pq-design.md` 2 decided against carrying trust forward on Ed25519 alone, and that reasoning stands. The "Check again" badge and its copy go. Shares stuck shut since the post-quantum release ("shares between you open again once you've both done it") reopen without a words check: the upgrade pass re-seals them in suite 4 to the first-seen pin.

### 2.6 Verdicts

A new value, `seen`, beside `verified` in `Integrity` / `GroupIntegrity` (TS `packages/crypto`, `packages/drive/src/trust.ts`; Rust `group_verdicts.rs`, `drive.rs`): the signature holds under keys this person's devices first saw for the writer and nobody checked. `DriveSigners` gains a level per signer, so `driveVerify` can say which. Every exhaustive switch over verdicts must then handle it; old code paths that do not know it are not affected, since verdicts are computed on the reading device.

- "Verified" anywhere (Contacts, the member list, Info) means the settings pin is verified and its keys are the ones this device's guard holds (2.8), so a check made on another device over the same keys counts, and a verified pin over other keys is a change (2.4).
- Drawn: no row mark. Info and the viewer: "Added by Maya" with "Not verified · Check it's Maya". The amber Unverified mark stays for what is actually wrong or unknown (`unknown-signer`, `bad-signature`, `key-conflict`, `unchecked`), with its copy made calm (section 5).
- `signatureFormFor('seen')` is `ordinary`: a copy, rename or move of a first-seen person's file is re-signed as the copier's own, as uploading a file they downloaded would be (decided 2026-10-26).
- Inside a family's folders: a writer active on the member list reads `verified` (`via: groupId`) when this person's family is checked, and `seen` (`via: groupId`) when it is first-use. A verified personal pin that agrees with the entry reads `verified` either way. A personal pin, first-seen or verified, that disagrees with the entry with no chain joining them is `key-conflict`, as today, with calm copy.

### 2.7 Room in the settings

Pins live in the settings document, capped at 64 KiB with the sharing ledger and family pins. A first-seen pin is about 500 bytes of JSON, so a document has room for roughly 100 people. Pinning everyone who shares with you raises the odds of reaching it. At the cap, adding someone or opening something from someone new says "Your contacts are full. Remove someone you no longer share with." and pins nothing. That is a limit, not a design: moving pins to their own sealed document is follow-up work; the cap is accepted for now (decided 2026-10-26). Dropping old first-seen pins automatically is not proposed, since a dropped pin lets the server start that person over.

### 2.8 Settings replaced by a newer copy

**Today**, a device takes any settings document at a higher sequence than it has seen (`settingsRolledBack`, `packages/crypto/src/pins.ts`; `settings-marks.ts`): the sequence and the document version are checked, not that the new document descends from the one the device held. The server cannot write a pin into a document (it is sealed under the person's settings key), but it can replay or fork copies their devices wrote: an older copy saved over at a higher sequence, or an empty one a fresh device saved. Today that fails safe: a verified pin that vanishes stops sharing until words are compared again. Under first use it would fail open: the next share or open would re-pin the server's keys as first-seen, with no notice. Sequence numbers alone never detect such a replacement.

**The guard.** Each device keeps a local record, never written to the settings and never cleared by anything the server answers (web: an IndexedDB store of its own, apart from the chain cache; the phones: a store of their own):

- **per contact:** the key commitment (1), the signing key, the `previousSigningKeys` it knows, and whether this device has seen these keys verified;
- **per family:** an anchor of the group id, the pinned roster version and digest, and the first keys.

It is written only when this device acts: adding, sharing, opening, Continue, a check, joining. Evicting the least recently used entries is allowed: losing one only returns that person or family to first use on this device.

**The rule.** Whenever the device would act on a person (share, re-seal, open, judge a record), it uses the settings pin only if it agrees with the guard:

- its keys are the guard's keys; or
- its `previousSigningKeys` include the guard's signing key (a handover followed or a Continue made on another of the person's devices: both keep the old key there, 2.3, 2.4; only the person's devices write the settings, and a stale or sideways copy never lists the guard's key); or
- the served identity has a signed handover from the guard's keys to its own, followed as today (2.3).

Anything else, a pin missing from the settings while the guard holds the person included, is handled exactly as an unsigned change (2.4): paused for that person, the calm "Maya's account changed" notice, then Continue or a check, either of which updates the guard and saves the settings as today. A person with no guard entry on this device is first use, as before.

**Removing** a contact deletes the pin from the settings only, so every device's Contacts list follows. The guard keeps the entry, unseen: adding them again over the same keys is silent, over other keys it is the notice. No tombstones, no new settings fields.

**Families:** the anchor is one more of the person's marks at acceptance (3.3), so first use is refused while one exists for that group, and a `not-member` answer never clears it (3.3).

**Residuals:** a device with no guard (a brand-new device, a private window, cleared site data) is 4.1's withheld-settings case. After a malicious replacement, contacts can vanish from the Contacts list with nothing said; nothing is shared to other keys without the notice. A contact removed and added again with other keys on another device shows the notice once here.

## 3. Families

### 3.1 Today

`docs/groups-design.md` 3.2: the newcomer reads their twelve words, the admin compares them and saves a verified pin, "Let them in" stays disabled until then; after admission both screens show the join code of the roster that admitted the newcomer, the newcomer compares ten words and types the two their screen hides, and only then does their device accept the chain from version 1 with the code as its join mark (`firstKeysChecked` with no other mark). The worker refuses `joining` without a mark, so with no pin and no cache nothing is accepted without a compared code. `roster_entry_new` builds an entry only from a verified pin. Child accounts (3.6, not built) depend on the join code.

### 3.2 The new join

1. **Invite.** A manager invites an email address, as today.
2. **Accept.** The invitee signs in or signs up and accepts, as today. The invitation page says who invited them to which family; nothing else.
3. **Let them in.** The manager's device looks up the newcomer's served identity (route 16's `identity`), checks its keys statement, and, if it holds no pin of them, writes a first-seen pin (`firstSeen: "family"`). `roster_entry_new` builds the entry from that pin. One click: sign, seal the areas' keys to the entry, admit, as today (retries resend the same bytes; 409 `stale` signs again over the new head). A manager who wants to check first can still do it before letting them in ("Check it's Sam first", the words check of today, which writes a verified pin the entry is then built from).
4. **The newcomer's device joins on first use.** On its next sync it finds its entry active, writes a version 4 joins record (3.3), accepts the chain from version 1 over the served version 1 keys with anchor `first-use`, writes its cache and the settings pin, then deletes the joins record. From that moment the pin and cache are marks: every later sync must pass through them, so a fork, a rollback, another group key at a pinned version or a removal withheld past the pin are caught exactly as for any member.
5. **Later, either side can check** (3.4). A newcomer on iOS 0.10.0 instead waits for the old join code; the manager gets it from a one-way path that writes nothing on the manager's side (3.4, "Older apps").

Roles asked for at invitation that need a check (3.6) are applied once the check is done; until then the newcomer joins as a member.

### 3.3 The core: from `firstKeysChecked` to an anchor

`AcceptInput.firstKeysChecked: boolean` becomes `AcceptInput.anchor`:

| Anchor      | Who may pass it                                                                                                                                                                                                                                                                   | What it vouches for                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `created`   | The worker, while it holds the seed of this creation, for served first keys equal to that seed's public key (unchanged)                                                                                                                                                           | The version 1 keys                                                            |
| `join`      | Any acceptance carrying a join mark (a code the person compared). With no other mark, it vouches for the version 1 keys through the code, as today                                                                                                                                | The version 1 keys and the chain through the code's roster                    |
| `first-use` | Only the join path, only with no mark at all (no pin, no cache, no session floor, no family check, no device-local anchor, 2.8), only for an account whose own entry is active on the served chain, and only with settings that opened on this device (`readSettingsForFamilies`) | Nothing. The served version 1 keys are taken because nothing contradicts them |
| none        | Everything else                                                                                                                                                                                                                                                                   | Nothing; with no mark, refused as today                                       |

- `AcceptedRosters` gains `checked: { how: 'created' | 'join' | 'compared'; rosterVersion: number } | null`: whether this person vouched for the anchor and through which roster. It is computed by acceptance from the anchor and the marks, never passed in. A first-use chain is `checked: null`; a later family check (3.4), passed as a pair mark, sets it.
- **A `not-member` answer never clears the anchor.** It still wipes the chain, the pending join and the session state (`apps/web/src/lib/groups/sync.ts`, `store.ts`; the phones' twins), but the device-local anchor (2.8) is kept apart and excluded from that wipe, so a server that answers `not-member`, serves settings without the group pin and sends a fresh invitation meets a refused first use, not an empty device. A genuine rejoin passes, being the same chain from version 1; a dissolved family's id is never reused, so keeping anchors costs nothing.
- With any mark, `first-use` vouches for nothing and the marks decide the version 1 keys, exactly as `joining` with marks does today (I6). Served version 1 keys other than the marks' are still refused before anything is verified.
- **The worker's refusal** changes from "no `joining` without a join mark" to "no `joining` without a join mark or the first-use conditions above". `creating` is unchanged. Flag F1's scan (`apps/web/src/lib/groups/join-only.test.ts`) keeps its allowlist by name and count, with the first-use site added and its reason; any other setter still fails it.
- **The sealed joins record**, version 4: `{ v: 4, groupId, firstUse: { rosterVersion, rosterDigest }, at }` or `{ v: 4, groupId, joinMark, checkedAt }`. It exists only between the first acceptance and the first pin write, so a reload in that window finishes the join against the same roster rather than taking first use again over whatever is served then. Version 3 records (a join in flight on an older release) are read as today. Version 2 stays refused.
- **`groupJoinPreview`** is no longer on the default path. It stays, unchanged, for "Check it's Sam first" before admission and for a newcomer on an older app (7.3); the check after joining works over the committed chain (`groupJoinCode`, 3.4).
- **`roster_entry_new` / `newRosterEntry`** accept a pin whose `pinTrust` is `verified` or `seen`, still only with a served identity whose four keys are the pinned ones and whose keys statement holds, and still never from a `trustedVia` pin. The server's own rule (an entry's keys must be an identity the member has had, `checkNextRoster` with identities) is unchanged.
- **Folding in changes** (`foldInEntry`): a member's signed succession is folded in as today. An unsigned change is folded in after one manager's Continue (3.6): the manager's device pins the new keys as first-seen and signs a roster that writes them into the entry and rotates every family folder in the same statement, as a removal does, since the keys the member left behind may be in someone else's hands.

### 3.4 Checking later: one comparison for both directions

**The code.** For two members A and B, the pair code is the first 132 bits, as twelve words read as the join code is, of

```
SHA-256("hushos/group/pair-code/v1" ‖ rosterDigest ‖ groupKeyDigest ‖ u64be(groupKeyVersion) ‖ lowerId ‖ higherId)
```

where the roster is the one at which the later-admitted of the two last became active (the creator's admission is roster 1), `groupKeyDigest` and `groupKeyVersion` are those of the group key that roster is under (as for `joinCode`), and `lowerId`, `higherId` are the two lowercase account ids, sorted, 36 ASCII bytes each. `pairCode` (Rust `pair_code`) works it out over a chain this device accepted, for this account and one other member, and refuses unless this account's own entry at that roster names one of its identities (not `ownEntryWrongAt` there). Both devices hold that roster, so both work it out without asking anyone, and it does not change when the family changes later.

**Why both ids.** Names and emails are labels the server serves; the account id is what each device knows for certain about itself. With the roster alone, every pair that A is the later member of would share A's admission code, so a server that labelled a planted entry C as "Sam" would let A compare with the real Sam, match, and vouch for C's keys. With both ids in the hash, A's device works it out with C's id and Sam's with Sam's, and the words differ. The join code (`joinCode`, `hushos/group/join-code/v1`) stays as it is for iOS 0.10.0 and child accounts; the pair code has its own domain, so neither can stand for the other.

**What a match proves, and only that.** Equal codes mean the two devices hold the same roster at that version (hence, through the hash chain, the same history from version 1 to it, under the same group key) and agree on which two accounts are comparing. Each device's own-entry check ties its own account id to keys it holds at that roster (`ownEntryWrongAt`, which `pairCode` refuses on). The code proves no more than those two own-entry checks prove: a modified client that skips its check defeats it (4.5). So after a match:

- A's device knows that the entry it holds under B's account id at that roster names keys B's device holds (B's own-entry check passed there), and the reverse. It writes a verified pin of the other member (X25519 and Ed25519, the ML-DSA and ML-KEM digests, the version 3 fingerprint over them, no `trustedVia`) only when the other member's entry at the head of its accepted chain has the compared entry's keys, and, if this device already pins them, the pinned keys too. Otherwise it writes nothing and offers Check it's Sam's own twelve words (6.6). So a member whose keys changed after they joined, by a handover or a Continue, is checked with personal words, and the pair check never moves a pin. A device whose own entry at the compared roster fails its check (its identity history lost after starting over) cannot make the pair check with that member either; personal words work there too.
- Each device knows its view of the family up to that roster is the other's. Each writes a family check for itself (below), which acceptance then holds as a pair mark.

A match with the person who created the family anchors the family to the creator's own keys. A match with someone who never checked shows that the two of you see one history, not that it is the real one (4.5).

**The check record**, synced in the settings document: `familyChecks: { [groupId]: { rosterVersion, with, code, checkedAt } }` (`with` is the other member's account id). A new top-level field, which every shipped client keeps when it saves. Acceptance holds it as a **pair mark** (`AcceptInput.pairMarks`, Rust twin): the verified chain must hold a roster at `rosterVersion` over which `pairCode(me, with)` is `code`, else the hard warning, and a chain short of it is a rollback. A pair mark is never a join mark and the core refuses one passed as the other. The record says only that the family was checked; it is not what the manager rule (3.6) or the Verified label (3.8) reads, since it survives a member's later account change and Continue.

**The flow**: both people open the family, each picks the other in the member list, Check it's Sam / Check it's Maya; both screens show the same twelve words; They match on each side writes that side's records. No hidden words to type: the two hidden words made sure a newcomer could not finish the join alone; a check nobody requires does not need that (decided 2026-10-26: dropped). Before showing the words a device syncs, so both are at the server's head; the code itself does not depend on the head.

**When they don't match**, nothing is written, on either side. The screen says to reload and compare again, and if they still don't match, to ask the organizer for help (6.10). A real mismatch means one of the two is being shown a different family; nothing resolves that automatically (design D5).

**Checking at join time** is the same flow on the newcomer's side: once in, the family page offers Check it's Maya beside the person who let them in.

**Older apps (iOS 0.10.0), strictly one way.** 0.10.0's join screen compares the old join code, and its core returns that code before any own-entry check (`crates/hushos-core/src/join.rs`, `admitted_at` at about line 331 checks only that the account id is active; the code is returned at about line 572). So a 0.10.0 phone matches the code over keys the server planted in its entry, and its match proves nothing about those keys to the manager. The manager's side of this path therefore writes nothing: no pin, no check record, no Verified label. It only lets the old phone anchor its own view of the family. Making that member a manager needs their personal twelve words (6.6; 0.10.0 has Your twelve words), like any other check of keys. The pair code cannot be produced by 0.10.0, which enforces the split.

### 3.5 What happens to each part of today's design

| Part                                                                                                                           | After                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `firstKeysChecked`                                                                                                             | Replaced by `anchor` (3.3) in both twins                                                                                                                                 |
| The join mark                                                                                                                  | Kept for iOS 0.10.0 newcomers and child accounts. A family check writes a pair mark instead (3.4)                                                                        |
| `groupJoinPreview`                                                                                                             | Kept for the check before admission and older apps; off the default path                                                                                                 |
| The sealed joins record                                                                                                        | Version 4, holding the first-use roster or a join mark until the first pin write                                                                                         |
| The worker's refusal                                                                                                           | Refuses `joining` unless it has a join mark or meets every first-use condition                                                                                           |
| "Let them in" disabled until words match                                                                                       | Removed; "Check it's Sam first" is offered beside it                                                                                                                     |
| Two hidden words typed back                                                                                                    | Removed from new clients; iOS 0.10.0 still asks for them, over the one-way path (3.4)                                                                                    |
| `roster_entry_new` from a verified pin                                                                                         | From a verified or first-seen pin                                                                                                                                        |
| `checkedAt` on the group pin                                                                                                   | Unchanged in form (old clients refuse a pin without it); it now means when this person's devices first accepted the family. Whether they checked it is in `familyChecks` |
| Hard warning, rollback, fork detection, successions, consent, removal rotation, area rules, staged chains, the server's checks | Unchanged                                                                                                                                                                |

### 3.6 Who needs a check first

Some roles hand over more than family folders, so they wait for a check of that person by whoever grants them. **The rule:** the granting device holds a verified pin of the candidate, without `trustedVia`, whose key commitment is the candidate's current entry's keys, or reaches them along a succession the pin followed, and which agrees with this device's guard (2.8). A family check (3.4) satisfies it only through the verified pin it wrote, which a Continue on a later account change demotes to first-seen; the check record itself never does. A pin from "Trust as family does" never does, as admission already refuses one (`group-trust.ts` `newRosterEntry`).

- **Managing the family** (`members`): a manager holds the family's signing key, so can let anyone in, put keys of their choosing in anyone's entry, and remove people. A newcomer invited as a manager joins as a member and becomes a manager once checked ("Sam can manage the family once you've checked it's Sam"). Making someone a manager or the organizer later asks for the check first. This is enforced in the clients that sign the roster (`nextRoster` callers), not the server, which cannot tell. A browser tab from before this release has no such rule, which is why 7.3 puts a client floor on family-changing routes.
- **Guardians and child accounts** (3.6 of the groups design, not built): a guardian's device opens the child's whole account. The child's sign-up keeps today's order with the check required: the guardian checks the child's words before admitting them, and the child's device compares the join code (ten compared, two typed) before it seals its root to the guardians. Nothing in this design relaxes that (decided 2026-10-26; children are not built yet).
- **A member whose keys changed without a signed chain** does not need a check (decided 2026-10-26): one calm Continue by a manager puts them back into the family folders (6.9), with every folder rotated in the same roster (3.3). What it costs is in 4.2. A manager whose account changed this way gets the folders back on Continue, but not the manager role: the family's signing key is sealed to their new keys only after a check, as for a new manager.
- **Billing** carries no keys and needs no check.

### 3.7 "Trust as family does"

Retired from the UI. It wrote a personal pin on the family's word so a family member's personal shares would open; with first-seen pins they open anyway, and on a first-use family it would only copy the server's word into a pin. Pins it already wrote keep `trustedVia` and their meaning (`docs/groups-design.md` 2.8); `trustAsGroupDoes` and `groupTrustAs` stay in the core for them and are no longer called by the apps. A family check (3.4) is now the way to vouch for a member through the family (decided 2026-10-26).

### 3.8 Who is shown as checked

Per viewer, never shared: the member list shows "Verified" beside each member whose settings pin is verified, meets 3.6's rule and has the keys this device's guard holds for them (2.8), "Not verified" beside the rest. The person's own row shows nothing. Check records and pins are sealed in the settings and never sent. With clients that follow 3.6, though, making someone a manager tells the server that whoever did it checked that person.

## 4. The cost

Written for people who look for it. None of this goes in default screens.

### 4.1 Contacts nobody checked

- **Swapping keys at first contact.** When you add Maya, or first open something she shared, the server can serve keys of its own as hers. Your device pins them. From then on the server can open everything you share with Maya and make shares and file changes that read as hers. If it does the same to Maya with your keys, it can pass things along between you so that neither notices.
- **Shares and changes "from" anyone.** A share from someone you have not added opens and pins whatever keys it came with. The server can therefore make a share appear to come from any account, and that account's first-seen pin is then the server's.
- **One tap through a change.** A change with no signed chain asks once and continues on one tap. A person who taps Continue on a change the server made gives it everything they share with that contact: Continue re-seals what was already shared to the new keys, and what they share from then on goes to them too, as on Signal.
- **A new device with withheld settings.** A server that shows a brand-new device "no settings stored" leaves it with no pins. One share made to look as if a contact sent it then pins the server's keys for that contact on that device, with no invitation and no Continue, even for someone the person verified on their other devices. Today that device would have needed a words check before trusting anyone. Any other device of the person that holds a guard for that contact meets the settings that device saves as a disagreeing pin, pauses and shows the calm notice (2.8), instead of re-pinning; only devices with no guard (new, private, cleared) are open to it.

### 4.2 Families nobody checked

- **Planted keys at admission.** When a manager lets Sam in without a check, the server can serve keys of its own as Sam's. The manager's device writes them into Sam's entry and seals every family folder's current keys to them: the server can then open the family folders. If the real Sam's device is shown that history, it sees its entry is not its own, shows the hard warning and cannot open the folders, so this is noticed, after the keys were handed over. A server that shows Sam a made-up family instead (next) keeps it from being noticed.
- **A made-up family for the newcomer.** With no marks, a newcomer's device takes the version 1 keys the server serves. The server can show a newcomer a family it made up, with its own family key and members, and read whatever the newcomer puts in its folders. Combined with the planted entry above, it can sit between the newcomer and the real family, passing folder contents both ways.
- **Becoming a manager.** If the newcomer were a manager, planted keys would hold the family's signing key, so the server could let people in, change entries and remove people. Section 3.6 closes this for clients that follow it, by requiring a twelve-word check before the role is given, including to a manager whose account changed; without that rule, this would be the largest cost. Web users also rely on the server delivering honest code (`docs/groups-threat-model.md`: a server serving altered web code reads everything), so against a dishonest server the rule binds only the phones and honest deployments.
- **One tap through a member's change.** A manager's Continue on an account change the server made writes the server's keys into that member's entry and seals every family folder's new keys to them. The rotation in the same roster keeps the member's old keys out, not the server's. If the real member's device is shown that roster, it sees its entry is not its own and shows the hard warning, so it is noticed, after the keys were handed over.
- **A new device with no settings.** First use runs only on the join path and only with settings that opened. A server that hides the settings from a brand-new device of an existing member, answers that they are not in the family, and sends them a fresh invitation they accept, can start that device on a made-up family. It needs a device with no anchor for that family (new, private, cleared): a device that has the anchor refuses first use however the server answers (3.3). This is wider than today, where that device would have needed a compared code.

### 4.3 What still holds, checked or not

- The server never sees a file, name or folder in plain text unless a person's device sealed a key to keys the server holds, as above. Your own files, and links, are untouched by any of this.
- After first use, every protection that does not need the first comparison holds: a later key change is noticed and never sealed to silently; signed replacements are followed only along chains the pinned keys signed; a family's pin and cache are marks, so another member list at a version you hold, a rollback, another family key, or a withheld removal past your pin are caught; removals rotate every family folder; successions, successor consent, planted-first-entry protection, the entry and area rules, staged chains, and the server's own checks are unchanged.
- The server cannot raise the hard warning with statements nobody signed, and cannot forge a member list or a succession under keys it does not hold. For a family it made up for a first-use newcomer, it holds those keys: after first use, the pin and cache give continuity (the same history from then on), not that the membership is genuine. Only a check gives that.
- Check records are never sent. Making someone a manager shows the server that whoever did it checked them (3.8).

### 4.4 What checking later restores, and what it does not

- A contact check that matches makes the pin verified from then on; one that doesn't match tells you, before anything else is shared. A family check that matches pins your view of the family to the other person's and verifies each of you for the other; one that doesn't tells you.
- It does not undo anything. What was shared with substituted keys, or put in a made-up family's folders, before the check was readable by the server. A mismatch found later is remedied, for a family, by removing the person (which rotates every family folder) and inviting them again; for a contact, by Stop sharing with them (which revokes each share and rotates what it covered, `packages/drive` `rotation.ts`, so nothing added later opens with the keys the server held), then sharing again after a check. Removing a contact only forgets the pin: what was shared stays shared (6.5), so it is not a remedy.

### 4.5 Residuals added or widened

- Checking a family with someone who never checked (and is not the creator) proves the two of you share one history, not that it is the family's: a server that isolated two newcomers onto one made-up family would pass it. Best checked with the person who made the family; the docs say so, the screens do not.
- The family check proves only what the two own-entry checks prove: a modified client that shows a pair code over an entry it does not hold defeats it, as it would defeat any comparison. iOS 0.10.0's join code proves less (it has no own-entry check before the code), which is why its path is one way (3.4).
- A replaced settings document is met by the guard (2.8) on every device that has acted on those people or that family: it pauses with the calm notice or refuses first use. Sequence numbers alone never detect it, and a device with no guard (new, private, cleared) is not protected.
- Detection that rests on two histories meeting (a newcomer seeing a planted entry) needs both histories to reach one device; a server that keeps each person on their own history is caught only by a check.
- After a malicious replacement, contacts can disappear from the Contacts list with nothing said (2.8).
- The settings cap (2.7) bounds how many people a person can have pinned.
- The withheld-settings new device, for contacts (4.1) and families (4.2).

## 5. Claims that must change

Every one lands in the PR that makes it false (section 8), so hushos.com never says something the code does not do.

| Where                                                                                                        | Says now                                                                                                                       | Must say                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/content/security.mdx`, "We hand out the keys…" (sharing section)                               | Keys are remembered "after you both compare twelve words"                                                                      | Keys are remembered the first time your device sees them; comparing twelve words, any time, confirms they are the person's; a later change is shown and used only after you continue                                  |
| `security.mdx`, "Because the server serves public keys…"                                                     | "Nothing is pinned without that check: something shared with you by a person you have not added stays shut until you add them" | What first use means, what the server could do to people who never compared words (4.1), what a check adds, and that a change is never used silently                                                                  |
| `security.mdx`, Terms rows on pins and successions                                                           | "A contact you pinned… with twelve words you can compare"                                                                      | Verified and first-seen pins, and when each is written                                                                                                                                                                |
| `security.mdx`, Unverified paragraph ("people whose words you compared")                                     | Only checked people's work verifies                                                                                            | First-seen people's work is shown as theirs, not verified; the mark is for what can't be confirmed                                                                                                                    |
| `security.mdx`, known limits list                                                                            | "Shares made before post-quantum identities stay shut until you… compare words again"                                          | Removed (2.5); add the first-use cost in one line                                                                                                                                                                     |
| `security.mdx`, families paragraph                                                                           | What the server knows                                                                                                          | Add: how a newcomer's device trusts the family on first use, what a check adds, and that managers are checked first                                                                                                   |
| `apps/web/src/content/blog/drafts/family-plans.mdx`                                                          | The join code section: the newcomer reads words, the join code, two hidden words, "don't use the family"                       | Rewritten: invite, accept, let in; checking later, and what it adds; the cost in plain words                                                                                                                          |
| `apps/web/src/content/roadmap.ts` (families item, and `updated`)                                             | "with each newcomer checked with their twelve words before they join"                                                          | "with anyone in the family able to check the others with twelve words"                                                                                                                                                |
| `apps/web/src/content/blog/post-quantum-sharing.mdx`                                                         | Pins catch a swapped key, with words two people compare                                                                        | An "Updated" note: pins are now made on first use and words confirm them                                                                                                                                              |
| `apps/web/src/content/blog/hushos-1-0.mdx`, `how-hushos-1-0-was-built.mdx`, `about.mdx`, `legal/privacy.mdx` | Checked: no claim about comparing words                                                                                        | No change                                                                                                                                                                                                             |
| `apps/web/src/components/access-demo.tsx`                                                                    | "Once you've checked it's Maya (twelve words, compared when you add them)…"                                                    | "Once you've added Maya, your device locks a copy of the folder's key for her…"                                                                                                                                       |
| `apps/web/src/components/families/no-family.tsx`                                                             | "everyone in it is checked before they join"                                                                                   | "A family shares folders. You can be in one family." (and the pool variant)                                                                                                                                           |
| `DESIGN.md` Components, Contacts                                                                             | Look up, then Check it's them                                                                                                  | Add someone, then optionally Check it's them; the changed-account notice (6.7)                                                                                                                                        |
| `DESIGN.md` Content, Families words                                                                          | They match / They don't match / Compare again / Join code on the join path                                                     | The words of 6.8 to 6.10; Join code removed from the default path                                                                                                                                                     |
| `DESIGN.md` Do's and Don'ts                                                                                  | —                                                                                                                              | Add: never name keys, codes, fingerprints, lists or versions outside Technical details; no alarm colour for routine events                                                                                            |
| `docs/identity-pq-design.md` 2 and 3                                                                         | Contacts compare words again; shares need both sides to compare                                                                | Points here for first-seen pins and the legacy upgrade                                                                                                                                                                |
| `docs/groups-design.md` 2.4, 2.7, 2.8, 3.2, 3.6, 5, 7, 9                                                     | The join flow, `firstKeysChecked`, the join mark as the only newcomer path, Trust as Acme does                                 | The anchor, first use, the family check, the manager rule; tests of 7 updated                                                                                                                                         |
| `docs/groups-invariants.md` I6, F1, F5, F12                                                                  | Two setters; newcomer mitigation is the join code                                                                              | Three anchors; the first-use conditions; F5's mitigation is the check, optional; F12 retired from the UI                                                                                                              |
| `docs/groups-threat-model.md` rows on newcomers, creation, "Word-check guidance" (decision 3)                | Join code required                                                                                                             | First use with its cost; the check optional; managers and children checked                                                                                                                                            |
| `docs/groups-mobile-plan.md`, `docs/integrity-design.md`, `docs/drive-design.md`, `docs/proposed.md`         | The word checks as required                                                                                                    | Updated where they describe them; `proposed.md`'s "Check it's them as a quiet later step" is now this design                                                                                                          |
| `docs/release/store-listing.md` (iOS and Android copy, screenshot captions)                                  | "Check it's really them first: you each read the same twelve words"                                                            | "Share with anyone on HushOS by email. If you'd like, check it's them with twelve words." Caption for `07-words`: "Check it's them, if you'd like"; the Android shot's path is Account › Contacts › Your twelve words |
| `docs/self-hosting.md`, client minimums                                                                      | Describes `DRIVE_CLIENT_MINIMUMS`                                                                                              | Adds `GROUP_WRITE_CLIENT_MINIMUMS` and the built-in web floor on family-changing routes (7.3)                                                                                                                         |
| `docs/release/privacy-answers.md`                                                                            | Contact lookups                                                                                                                | No change: nothing new leaves the phone, and pinning on first open asks the server nothing                                                                                                                            |
| In-app copy, all three clients                                                                               | Section 6                                                                                                                      | Section 6                                                                                                                                                                                                             |

## 6. Screens and copy

### 6.1 Rules

- Default screens say what happened and what the person can do, in one or two calm sentences. No threat language (attack, malicious, compromised, someone pretending, "may be reading your files", "don't use this family", "don't trust this item"), no red for routine events, no exclamation marks, no eyebrow labels.
- No technical words outside a door the person opens (Check it's Maya, a Technical details disclosure, the security page): never keys, fingerprint, security code, code, member list as a thing, version, digest, chain, pin, roster.
- Tokens only; one blue (primary) button per screen; `outline` for the second choice; 36px buttons, 44px on touch; dialogs on the web, sheets on iOS, bottom sheets or dialogs on Android, the same words on all three (DESIGN.md, app styling rules).
- "Not verified" and "Verified" are muted 13px text (Verified with a small check icon beside the word); never a badge, never amber.

### 6.2 Add someone

Web: Contacts, Add someone (dialog). iOS: Account › Contacts › Add someone (sheet). Android: Account › Contacts › Add someone (bottom sheet).

- Title: **Add someone**
- Field: **Email**, hint "The email they use for HushOS."
- Buttons: **Add** (primary), Cancel.
- Done: closes, toast "Maya added".
- Already added: hint line "Maya is already in your contacts."
- Not signed in since the upgrade: "Maya needs to sign in to HushOS once more before you can share with her."
- Nobody with that email: the lookup's existing message.

No words, no second step.

### 6.3 Share sheet

- People field: a name from Contacts, or a full email. An email not in Contacts shows one suggestion row, "Share with maya@example.com"; choosing it adds them (6.2's rules) and shares, in one step. Toast "Shared with Maya".
- Person rows: avatar, name, email, role select, as now. No verification text.
- A person whose account changed (2.4): their row's second line reads "Maya's account changed" with **Review** (link style), which opens 6.7. Their role select and any new share wait until then.
- Row menu: **Check it's Maya** sits beside Stop sharing (above it; Stop sharing stays last).
- iOS and Android: the same; the email suggestion is the list's first row while typing.

### 6.4 Opening something shared

- From someone not in Contacts: it opens. They are added (first-seen). Nothing is shown about it.
- Info and the viewer's details: "Shared by Maya", and below it "Not verified · Check it's Maya".
- From someone whose account changed: the item shows "Maya's account changed. Review to open this." with **Review**, opening 6.7.

### 6.5 Contacts

- Header: **Contacts**. Description: "People you share with. Add someone by the email they use for HushOS."
- Actions: **Add someone** (primary), Your twelve words (outline).
- Row: avatar, name, email; at the right "Verified" or "Not verified" (muted).
- A changed account: the row's second line "Account changed", with **Review**.
- Row menu: **Check it's Maya** (for a verified contact: **Check again**), then Remove.
- Remove: "Remove Maya?" / "Maya keeps access to anything you've already shared." / Cancel, **Remove** (destructive).
- Empty: "Nobody here yet" / "Add someone by their email, or add them while you share."
- Gone: the Check again badge, the "replaced their sharing keys" banner (a followed replacement is a quiet line inside Check it's Maya: "Maya updated her account on 3 November."), "Checking it's really them… is worth doing before you share".

### 6.6 Check it's Maya (a contact)

The advanced door. The same on all three clients.

- Title: **Check it's Maya**
- Body: "Ask Maya to open Contacts in HushOS and choose Your twelve words. If hers match these, it's really her. Do it in person or on a call."
- The twelve words, numbered, in two columns.
- Buttons: **They match** (primary), They don't match (outline).
- They match: closes; toast "Maya verified".
- They don't match: the body becomes "These don't match. Check Maya's email address with her. If it's right and they still don't match, you can stop sharing with Maya for now and share again once they do." Buttons: **Done** (primary), Stop sharing with Maya (outline). Nothing is saved.
- Stop sharing with Maya asks once: "Stop sharing with Maya?" / "Maya can't open anything you've shared with her any more, including what you add to those folders later. You can share again once your words match." / Cancel, **Stop sharing** (destructive). It revokes every share the sharing ledger lists for Maya and rotates what each covered (4.4); toast "Stopped sharing with Maya". This bulk action is new in PR 3.
- Technical details (disclosure, closed): "These words are worked out from Maya's four public keys. Comparing them confirms the keys HushOS gave your device are hers." and the version 3 fingerprint in mono.
- Your twelve words (Contacts, Account): title **Your twelve words**, "When someone checks it's you, read these to them. They're the same on all your devices."

### 6.7 Maya's account changed

A dialog on the web, a sheet on the phones.

- Title: **Maya's account changed**
- Body: "This happens when someone starts their HushOS account over, for example after losing their phone."
- For someone not verified, add: "You can keep sharing with Maya as before." Buttons: **Continue** (primary), Check it's Maya (outline).
- For someone verified, instead: "You'd checked it was Maya before. You may want to check again." Buttons: **Check it's Maya** (primary), Continue (outline).
- Continue: closes; toast "You're sharing with Maya again". What waited (new shares, re-sealing, opening) runs.
- Technical details: "Maya's keys are different from the ones your device remembered, and her previous keys didn't sign the change." and both fingerprints.

### 6.8 Family: invite, accept, let in

Web: the family page. iOS: the family page (iOS has join today; invite and let in come with 1d's manager screens). Android: built this way when families reach Android (1d).

- **Invite someone** (dialog): Email; "Let them manage the family" (checkbox). Hint: "We'll email them a link. Once they accept, you let them in." With the box ticked, a second hint: "They can manage the family once you've checked it's them." Button **Send invitation** (primary).
- **The invitation** (newcomer, `/join`): title "Join Lindqvist family", body "Maya invited you. Family folders are shared with everyone in the family." Buttons **Join** (primary), Not now.
- **Waiting** (newcomer, after Join): title "Waiting for Maya", body "Maya lets you in from the family's page. This page updates when you're in." No words.
- **Waiting to join** (manager, family page section): each row "Sam · sam@example.com", with **Let them in** (primary, the screen's one blue button) and Not now (outline). Row menu: Check it's Sam first. One click lets them in; toast "Sam is in Lindqvist family". Billing and seat refusals keep their copy.
- **In** (newcomer): the family page, as for any member. No nudge.

### 6.9 Members

- Row: avatar, name, role ("Organizer", "Manages the family", or nothing), and at the right "Verified" or "Not verified" (muted). Own row: "You", no label.
- Row menu: **Check it's Sam** (or Check again), then the manager actions. "Let them manage the family" and "Make them the organizer" on someone not checked open: title "Check it's Sam first", body "Managers can let people in and change the family, so check it's Sam before they manage it. It takes a minute on a call or in person.", buttons **Check it's Sam** (primary), Cancel. Once checked, the role change goes ahead.
- Invited as a manager, not checked yet: role line "Will manage the family once checked".
- An account that changed without a signed chain: second line "Account changed". For a manager, a notice on the page: "Sam's account changed. This happens when someone starts their HushOS account over. Continue to give Sam the family folders again." with **Continue** (primary) and Check it's Sam (outline). Continue: toast "Sam has the family folders again". If Sam managed the family, the role line reads "Will manage the family once checked" until a check.

### 6.10 Check it's Sam (in a family)

- Title: **Check it's Sam**
- Body: "Ask Sam to open Lindqvist family and choose Check it's Maya beside your name. If the twelve words on both screens match, you've checked each other."
- The twelve words, numbered.
- Buttons: **They match** (primary), They don't match (outline).
- Syncing first: "Getting the latest" (muted, a spinner) until the device is at the head.
- They match: toast "You and Sam checked each other"; Sam's row reads Verified.
- They don't match: "These don't match. Make sure you're both in Lindqvist family, reload, and compare again. If they still don't match, ask Maya to help." (Maya is the organizer; for the organizer themselves, "contact support"). Button **Done**. Nothing is saved.
- Technical details: "These words are worked out from the family's member list as it was when Sam joined, and from your two accounts. When they match, your devices see the same family, and each confirms the other's keys." and the roster version and digest.
- A device whose own entry was wrong at that list shows no words: "This device can't check the family with Sam. You can check Sam's own twelve words instead." with **Check Sam's words** (opens 6.6).
- A match where Sam's keys have changed since Sam joined: toast "You and Sam see the same family", and Sam's row stays Not verified, with Check it's Sam opening 6.6.
- Sam on an older app (iOS 0.10.0, whose screen asks for two hidden words): below the words, a text button "Sam's screen asks for two missing words". It switches to the old join code (3.4, one way): title **Help Sam finish joining**, body "Sam is using an older version of HushOS. Read these twelve words to Sam so their phone can finish joining. This doesn't check Sam on your side; to do that, ask Sam to update HushOS, or compare Sam's own twelve words in Contacts." Button **Done** (primary). Nothing is saved on this device, and Sam's row stays Not verified.

### 6.11 The family looks different (the hard warning)

Rewritten copy for `ForkAlert` (web) and its phone twins. An inline alert in the `warning` role, not `destructive`.

- Title: **Lindqvist family looks different on this device**
- Body: "HushOS has paused changes to the family here. Let Maya know, and check each other from the family page."
- Technical details: unchanged (both sides, where each came from, digests).

### 6.12 Marks on files

The amber mark stays only for what can't be confirmed, with calm words:

- `unknown-signer`: "HushOS can't tell who wrote this." with Check who wrote this (the old Check their words dialog, now 6.2 then 6.6).
- `bad-signature`: "HushOS couldn't confirm this was written by Maya." (was "Don't trust this item").
- `key-conflict`: "Maya's account looks different here than in your contacts." with Check it's Maya; `warning`, not `destructive`.
- `unchecked`: "HushOS couldn't check this right now." with Try again.

## 7. Migration and rollout

### 7.1 Existing contact pins

- Verified pins stay verified, unchanged, on every client.
- Legacy pins become first-seen on the person's next action with that contact (2.5).
- Shares stuck since the post-quantum release reopen once the granter's device runs the upgrade pass over the first-seen pin.

### 7.2 Existing families

Every family accepted before this release was anchored by creation or a compared join code. Any client able to take a family on first use (the web from PR 4, iOS from PR 5, Android when it has families) writes, in one compare-and-set save, a `familyChecks` record for each group pin the settings hold, at that pin's roster (`how: 'before'`), and `familyChecksSince: <ISO time>`. **The invariant:** no client writes a first-use group pin into settings that lack `familyChecksSince`; it writes the marker and the `before` records in the same save as, or a save before, its first first-use pin. A group pin without a check record is first-use only if `familyChecksSince` is set; before it, pins are treated as checked. Because the marker always precedes any first-use pin, a pin labelled `before` was never a first-use one, whichever client joins first (a phone-first join included) and however saves race (compare-and-set re-reads and re-derives, as `saveSettings` does). Saves from older clients keep both fields. An iOS 0.10.0 client that joins with a compared join code after the marker leaves no check record, so new clients show that family as not checked: an under-claim, put right by one check.

### 7.3 Older clients during rollout

- **The web** deploys as one, but a tab opened before the release keeps running the old code until the person reloads: `release-notice.tsx` offers a reload and never forces one. An old tab would still ask for words, and nothing in it knows the manager rule (3.6) or that a first-seen pin is not grounds to promote. So the routes that let people in, change roles or seal family keys get a client floor of their own, and every other route, Drive included, keeps serving open tabs as before. This is a control for honest deployments: it closes stale tabs on a server that runs the code it says; a dishonest server can serve altered web code anyway (4.2).
    - **Which routes** (`docs/groups-server.md` 4): every roster route (7 rosters, 17 admit, 18 member roles, 19 remove, 21 new area, 24 rotation, 30 delete a family folder), 9 key seals, 10 key successions, 22 area grants and 28 the previous root. Reads, invitations, accept, leave, decline, hold and the self-grant (23) are not floored, so iOS 0.10.0 newcomers keep joining.
    - **The change** (`apps/web/src/lib/api.server.ts`): `checkClient` (`packages/drive/src/protocol.ts`) already takes the minimums as an argument, so `requireClient(request, minimums = clientMinimums)` gains the parameter, and a `groupWriter(request, sessionToken)` helper, used by those routes in place of `groupUser`, checks against `groupWriteMinimums`: per client name, the higher of `DRIVE_CLIENT_MINIMUMS`, a new optional `GROUP_WRITE_CLIENT_MINIMUMS` (same format) and a built-in `web/<the release that ships PR 4>`. The built-in floor means a self-hosted server gets it on upgrade with nothing to set; the variable only raises it. Only a `web/` entry is built in: no shipped phone can change roles or let people in, and a phone floor would lock out 0.10.0 joins. The edge (`group-requests.ts`) keeps checking the global minimums first; the route check is the stricter one.
    - **What a stale tab sees**: 426 `unsupported` on those routes, which the web already words as "Update HushOS to do this. Reload the page to get the latest version." (`lib/groups/copy.ts`). Opening files, sharing and everything else keep working until they reload.
    - **`docs/self-hosting.md`** gets `GROUP_WRITE_CLIENT_MINIMUMS` in the variables table and one line: servers that run families refuse family changes from web tabs older than this release; raise the variable if a later release needs it.
- **iOS 0.10.0** has the join flow with the code and two typed words, and Contacts with words required. On it: first-seen contacts show Check again and nothing is shared with or opened from them (as for an unchecked contact today); a family a new client joined on first use opens normally, since the settings pin is a mark; a newcomer joining on 0.10.0 waits for the old join code, which the manager reads from the one-way path in Check it's Sam (3.4, 6.10); the phone asks for its two hidden ones. That anchors the phone's view and writes nothing on the manager's side; making that member a manager needs their personal twelve words. Support copy says so until the iOS update is out.
- **Android 0.10.0** (in Google Play review) has Contacts and no families. First-seen contacts show Check again there; what new clients share with someone on 0.10.0 opens only after that person checks the sharer or updates. Nothing breaks; the Android TOFU PR should follow the web contacts PR closely.
- **What old clients get wrong** (rollout residuals, until they update): iOS 0.10.0 skips pins that are not verified when it looks for conflicts (`FamilySync.swift`, about line 663), so a first-seen pin that disagrees with a member's entry raises no `key-conflict` there; and since the settings pin is a mark to it, it shows a first-use family's writers as "Verified by" the family, a label this design no longer gives. Both are wrong labels on an old phone; neither seals anything to new keys. A first-seen pin still fails `pinVerified` everywhere, so no old client shares with or opens from it. Both are reasons to ship PR 5 before the families launch.

### 7.4 Server

No code change. The server never knew whether anyone compared words (`docs/groups-server.md` 6); it already serves the identities, rosters and first keys first use needs. No route, column, migration or error code is added. The one server change is the client floor on family-changing routes (7.3), built in for the web.

### 7.5 Versions

No format bump: the settings document stays version 2 (first-seen pins and `familyChecks` fit it, and old clients keep unknown fields); contact pins stay version 3 by their fields; group pins, rosters (formats 1 and 2), successions, seals and grants are unchanged. The device-local joins record goes to version 4 (3.3). Releases are numbered by release-please as usual.

## 8. Build plan

Each PR is one change, squash-merged, signed off, reviewed independently and run live with verify-hushos before merge. Tests are Vitest beside the code and Rust unit tests, each failing on a defect a person would notice; shared fixtures pin both twins.

**PR 1. `feat(crypto): keep a first-seen pin for people nobody has checked`** (`packages/crypto`, `packages/drive`, `crates/hushos-core`, `apps/web/src/lib/groups/outbox.ts`)

- `pinTrust` / `pin_trust`; `pinOfServed` with a `seen` form; `comparePin` and the Rust twin allow `succession` from `seen`; `signersFromPins` with levels; the `seen` verdict; the legacy-to-first-seen rule; `keyCommitment` / `key_commitment` and `admits.keys` at the three outbox sites of 2.2, with every other `.fingerprint` comparison audited; shared fixture cases for pins.
- Tests: a first-seen pin never passes `pinVerified` in either twin, including one whose empty fingerprint is replaced by a fingerprint over other keys; a first-seen pin with a served ML-DSA or ML-KEM key whose digest differs is `changed`; a succession signed by the first-seen keys is followed and the result is still not verified, and one signed by any other key is not followed; a legacy pin becomes first-seen only when its classical keys are the served ones and the keys statement holds (a statement signed by another Ed25519 key leaves it legacy); a record signed under a first-seen key reads `seen`, under a verified pin's `verified`, under neither `unknown-signer`; the iOS 0.10.0 and Android 0.10.0 pin readers (as fixtures of their JSON shapes) decode a first-seen pin and read it unverified; a settings document at the cap refuses one more pin and saves nothing; a staged admission whose newcomer's pin moved between first-seen keys K1 and K2 before it was sent is dropped, never sent with grants to K1, for a change of the classical keys, a change of only the lattice keys, and a relaunch between staging and sending (web outbox and the core's `roster_calls`); an outbox entry from before, carrying only `admits.fingerprint`, sends exactly when the pin's key commitment equals it, and an entry carrying both fields is judged by `keys`; `guardAgrees` / `guard_agrees` (the rule of 2.8): a newer copy carrying a stale verified pin of K1 while the guard holds K2 pauses with the notice; a copy that drops a pin pauses at the next share, and the Contacts list follows it; a pin another device moved by a Continue (its `previousSigningKeys` hold the guard's key) is used silently; a sideways pin of K3 whose `previousSigningKeys` hold only K0 pauses; re-adding with the same keys is silent and with other keys shows the notice. Each fails against today's code or against a rule that trusts a verified pin by itself.

**PR 2. `feat(crypto): accept a family on first use and check it later`** (`packages/crypto`, `crates/hushos-core`, `docs/groups-*.md`)

- `anchor` in `acceptRosters` / `accept`; `checked` on the accepted chain; the worker's first-use path and its conditions; joins record version 4; `pairCode` / `pair_code` under `hushos/group/pair-code/v1`, refusing when the device's own entry was wrong at the roster; pair marks (`pairMarks`) in acceptance; `roster_entry_new` from a first-seen pin; the F1 allowlist; `docs/groups-design.md`, `groups-invariants.md`, `groups-threat-model.md` updated with the cost of section 4.
- Tests: with no marks, `first-use` accepts the served chain and reports `checked: null`, and creation and a join mark report checked; `first-use` with any mark (pin, cache, session floor, check record) vouches for nothing, and served version 1 keys other than the marks' are refused; `first-use` is refused when the account's own entry is not active, when settings did not open, and outside the join path; after a first-use acceptance, the pin raises the hard warning for another roster at its version and refuses a shorter chain (the existing cases run again from a first-use start); a reload between acceptance and the pin write finishes against the joins record's roster, and a server serving another roster at that version then gets the warning; a pair mark over a matching code sets `checked`, one over another roster's code is the warning, one at a roster the chain has not reached is refused, and a pair mark passed as a join mark (or the reverse) is refused; both twins give the same pair code for every pair in the fixture family, at the later admission; A↔B and A↔C over one roster give different codes in both twins, so a server relabelling C as B gets other words; a device whose own entry was wrong at that roster returns no pair code; after a pair match, a verified pin is written only when the head entry's keys are the compared entry's (and the existing pin's): a head entry moved by a handover or by a Continue gets no pin written and the existing pin is untouched; with the anchor present, a `not-member` answer followed by settings without the group pin and a fresh invitation is refused as first use, and the anchor survives the wipe; **a real iOS 0.10.0 join preview over a planted entry**: a fixture made by running the v0.10.0 core's `group_join_preview` (from the tag) over a chain in which the server planted keys as the newcomer's entry, committed with the code it returned, against which the new core's `pairCode` for the newcomer's device refuses and the pair code for (manager, newcomer) is not the 0.10.0 code; `roster_entry_new` builds from a first-seen pin, and refuses one whose keys are not the served identity's and a `trustedVia` pin; the scan fails on any new setter of an anchor.

**PR 3. `feat(web): share with someone as soon as they're added`** (`apps/web`)

- `lib/contacts.ts` (add without words, `trustGrantee`/`trustGranter` over first-seen pins, pinning on first open, the change pause and Continue, the legacy upgrade, the settings cap), `lib/drive.ts`, Add someone, the share sheet, Contacts, Check it's Maya, the changed-account notice, marks and Info lines (6.2 to 6.7, 6.12), and the contact claims of section 5 (security page, access demo, DESIGN.md Contacts).
- Also Stop sharing with Maya (6.6), the bulk revoke and rotation over the sharing ledger; and the guard of 2.8 (its IndexedDB store, written on add, share, open, Continue and check, read before every share, re-seal, open and verdict).
- Tests (Vitest): sharing after Add seals to the pinned keys and to nothing else; Stop sharing with Maya revokes every share the ledger lists for her and rotates what each covered, so a node key she was sent opens nothing added afterwards; a served key change with no chain shares nothing, re-seals nothing and opens nothing new until Continue, and Continue re-seals what was shared to the new keys and only to them; a verified contact's change needs Continue or a check and loses verified on Continue; opening a share from someone new pins the keys it came with, and a second share under other keys pauses; Check it's Maya's They match writes a verified pin and They don't match writes nothing. Playwright e2e: two accounts, add and share without words, the other opens it; then the server's served keys for one changed in the test database, the notice, Continue, the share re-sealed.

**PR 4. `feat(web): let people into a family without comparing words`** (`apps/web`)

- Let them in without words, Check it's Sam first, the newcomer's join without words, Check it's Sam in a family, the manager rule, member list labels, the changed-member notice, Trust as family removed, the rewritten ForkAlert, the `familyChecks` migration (6.8 to 6.11), and the family claims of section 5 (security page families paragraph, the family-plans draft, roadmap item and `updated`, no-family copy, DESIGN.md Families words).
- Also: the one-way older-app path (6.10), the client floor on family-changing routes with its tests (a group write from a web client below the built-in floor is refused with 426 and stores nothing; the same client is still served rosters and Drive; `GROUP_WRITE_CLIENT_MINIMUMS` raises the floor and never lowers it; `ios/0.10.0` is served the join's routes) and the `docs/self-hosting.md` line (7.3), and the migration invariant of 7.2 in the web's settings layer.
- Tests (Vitest): letting someone in builds the entry from a first-seen pin and seals only to its keys; making someone a manager without a check is refused before anything is signed, and goes ahead after one; a family check, then a Continue on that member's account change, then a promotion is refused; a promotion over a `trustedVia` pin is refused; the older-app path over the 0.10.0 planted-entry fixture writes no pin, no check record and no Verified label on the manager's device; a family check writes a verified pin of the other member from the entry and a check record, and a mismatch writes neither; the migration writes check records for every existing pin in one save and never for a pin made after `familyChecksSince`; the first first-use pin is never saved without the marker in the same or an earlier save; a migration racing a join on another device (compare-and-set conflict) never labels the first-use pin `before`; settings in which a phone joined first, carrying the marker and a first-use pin, read as not checked; a member's unsigned change is folded in only after Continue, never on its own, and that roster rotates every family folder and seals the new keys to the new entry only; a manager folded in that way gets no seal of the family's signing key until a check. Playwright e2e: invite, accept, let in, the newcomer's folder opens, no words anywhere; then the two check each other and both rows read Verified; an admission meeting a stale answer still signs again over the new head (the existing F7 case, without words).

**PR 5. `feat(ios): share and join a family without comparing words`** (`apps/ios`)

- HushOSKit over PR 1 and 2's core (contacts, share sheet, Received, Unverified, FamilyJoin without words, Check it's Sam in a family, conflicts looked for over first-seen pins too), the migration invariant of 7.2 and the guard of 2.8 (its own store, kept through a `not-member` wipe), store listing copy.
- Tests: Swift unit tests on the HushOSKit seams (a first-seen pin decodes and reads unverified; a share to a changed contact waits for Continue; FamilySync joins on first use only with no marks; a phone-first join writes `familyChecksSince` and the `before` records in the same save as, or before, its first first-use pin; a first-seen pin that disagrees with a member's entry is a conflict), plus simulator proof with verify-hushos.

**PR 6. `feat(android): share without comparing words`** (`apps/android`)

- Contacts, sharing and opening over first-seen pins; the guard of 2.8 in its own store; Account's Contacts row loses "Check it's them before you share anything sensitive"; store listing copy. Families on Android (1d) are then built on the new join directly.
- Tests: Kotlin unit tests twinning PR 5's, emulator proof.

**Before the families launch** (families are off on hushos.com): PRs 1, 2, 3 and 4, merged, reviewed and run live, with the group-write floor in place, since the join, the claims and the security page must agree. PR 5 is strongly recommended first: on 0.10.0 a newcomer needs the manager to find the older-app path, and the old phone shows a first-use family's writers as verified by the family and misses conflicts over first-seen pins (7.3); if it is not out, support copy says so. PR 6 is not a launch blocker (Android has no families), but should follow PR 3 within one Android release.

## 9. Decided

The owner's answers, 2026-10-26:

1. **Child accounts keep the up-front check** (3.6). Not built yet.
2. **Managers need a twelve-word check before they get the role** (3.6), including a manager whose account changed without a signed handover.
3. **A member whose account changed without a signed handover** goes back into the family folders after one calm Continue by a manager, with no forced check (3.3, 3.6, 6.9). The cost is in 4.2.
4. **"Trust as family does" is removed** from the UI (3.7).
5. **"Not verified" shows only** on Contacts, the member list and file Info; never on file rows or in the share sheet (2.6, 6.1).
6. **A verified contact whose account changed:** the blue button is Check it's Maya (2.4, 6.7).
7. **About 100 contacts fit** in the settings; the cap is accepted for now (2.7).
8. **A copy of a not-verified person's file** is signed as the copier's own (2.6).
9. **"Check it's Sam first"** stays as an option before letting someone in (3.2, 6.8).
10. **No typed hidden words** in the later family check (3.4).
11. **A QR code** for checking in person comes later.
12. **Opening something from someone new adds them** (2.3).

No open questions remain from this design; an independent review is pending.
