# Group crypto: security invariants

The properties the group core (milestone 1) must hold, each with the code that enforces it in both twins, the tests and shared fixture cases that prove it, and the residuals that bound it. `docs/groups-design.md` is the specification; `docs/groups-threat-model.md` names the adversaries. This list is what a change to `packages/crypto/src/group-trust.ts`, `groups.ts`, `succession-path.ts` or their Rust twins (`crates/hushos-core/src/group_trust.rs`, `groups.rs`, `succession_path.rs`) must keep true.

Conventions:

- **TS** and **Rust** name the enforcing functions (file:function). Private helpers are named when they hold the check.
- **Tests** name unit tests (TS title, Rust function) and shared fixture cases (`cases`, `sealCases`, `sealerCases`, `chainCases`, `foldIns` in `crates/hushos-core/fixtures/web-groups.json` and `packages/crypto/src/__fixtures__/core-groups.json`). Each twin judges the other's cases (`group-fixtures.test.ts`, `tests/web_group_fixtures.rs`).
- **Flag** marks an invariant whose enforcement or proof is incomplete. The flags are collected at the end.

Not in milestone 1: guardian seals and child accounts (design 2.9, 3.6). They have no code, so they have no invariants here.

## I1. A record reads `verified` (or via the group) only under a key the writer's verified chain gives them

A writer's signature in one of the group's areas is checked under, and only under: their roster entry's Ed25519 key; or their served identity's key when a verified succession path leads from the entry's keys to it (a succession no roster has folded in yet). Earlier keys read `retired-key`, never `verified`, and only when they lie on a verified path:

- for a reader relying on the roster, from the entry's keys, and from the member's first key set on the chain (the words-checked one) up to the entry's keys, never past them;
- for a reader with a personal pin, from the pin, and, when the pin is at a later identity, along the entry or first-set path up to the pin.

A key a holder wrote into an entry later never starts a path. Links count only if they verify, under the proof the walk asks (`succession-path.ts`): from the member's first keys up to their entry's keys, successor consent (`hushos/identity/succession-consent`, the old keys' half as "old" and the new keys' as "new": `identity.ts:verifySuccessionConsent`, `identity.rs:succession_consent_verify`), so keys planted as a member's first entry cannot bridge to the member's real identity (the planter can sign the old half, never the new one); everywhere else (after the entry on that walk, the roster lag, a personal pin's walk) the version 2 signature under the old keys the link names, except that a pin trusted through a group (`trustedVia`, which `trustAsGroupDoes` writes, carried on the `WriterPin` group verdicts take, keys and origin together, round 12; an empty origin reads unchecked, and a verdict such a pin agrees with names its group as `via`) asks consent up to the entry, as the first keys' walk does, wherever its keys sit in the member's history (round 11; round 10 keyed this on the history position, which raised false conflicts for honest members and missed planted first entries), so a planter's one-sided link from pinned planted keys bridges nothing once the entry is put right, and a pin from the reader's own words check never asks it. Junk, links out of order and duplicates change nothing. A fork, rollback or overflow on the walk from the first keys voids only that walk's retirement. On the lag or pin walk a fork or rollback makes the record `unchecked`; an overflow (`too-many`) reads as links that did not load (round 11): the entry's key stays current, nothing is retired, an unknown key reads `unchecked`, because the member's keys are public and anyone can serve 65 links from them. Only links that could join the member's chain count toward the cap of 64 (old keys equal to the walk's start, to a key set the chain lists for the member, or to the new keys of a link already followed); more than 64 of them are checked no further, and links from any other keys are never verified and never counted. The verification cache is keyed by the SHA-256 of the member, the proof and the link's fields named one by one (a snapshot of plain values, so no `toJSON` or field order can alias two links), keeps at most 4,096 results (least recently used dropped first), is locked in Rust only to look up or store, never across a verification, and a caller may pass one per session. The served identity's key version is unsigned and decides nothing (neither the walk nor the `key-conflict` decision reads it). A verified link leaving the served keys (the server serves an identity the member already replaced) makes the walk `stale`, and the record reads `unchecked`; it fires only when the walk passes through the served identity, its start included.

- **TS:** `group-trust.ts:groupWriterTrust` (`pinWritten`, `memberKeys`, the `verified` option), `retiredAlong`, `retiredBefore`, `upTo`, `groupIntegrityOf`; `succession-path.ts:successionPath` (`snapshot`, `holds`, `consentUntil`, `memberKeys`, the counted cap, `MAX_SUCCESSION_LINKS`); `identity.ts:verifySuccessionConsent`, `verifySuccessionLink`.
- **Rust:** `group_trust.rs:group_writer_trust` (`pin_written`, `member_keys`, `SuccessionCache`), `retired_along`, `retired_before`, `up_to`, `group_integrity`; `succession_path.rs:succession_path` (`holds`, `consent_until`, `member_keys`, the counted cap, `MAX_SUCCESSION_LINKS`, the typed `Verified` key); `identity.rs:succession_consent_verify`, `succession_verify`.
- **Tests:**
    - TS: "roster trust gives `verified` inside the group's areas…", "probes 2a, 2b…", "P1, F3: an earlier key reads retired only along the member's own chain…", "p1: only the links the succession chain verified retire keys…", "p2: a planted key never reads retired…", "r7: two successions the member signed from one key…", "r7: the group walk keeps the strict verifier's version and served-key rules…", "round 8 › Opus 3: a served identity the member has already replaced reads unchecked…", "round 8 › Opus 4: an unsigned served key version never turns a followed succession into a key conflict", "round 9 › Opus 2…", "round 9 › Fable C…", "round 9 › Opus 5…", "round 9 › Opus 3…", "round 9 › Opus 8…", "round 10 › Fable 6 / Opus 7: only links from the member's own key sets count toward the cap", "round 10 › Fable 6: links leaving keys the walk reaches count too…", "round 10 › Codex 3a: the cache knows a link by its fields…", "scoped verdicts › r10 (Fable 6): a session's verification cache carries across verdicts…", "round 11 › Opus 5: the session cache keeps at most 4,096 results…", "round 11 › Opus 4 = Fable 3: too many links on a pinned reader's walk read as links that did not load".
    - Rust: the twins of each (`probes_2a_2b_…`, `p1_f3_…`, `p1_only_the_links_…`, `p2_a_planted_key_…`, `r7_two_successions_…`, `r7_the_group_walk_…`, `r8_opus_3_…`, `r8_opus_4_…`, `r9_opus_2_…`, `r9_fable_c_…`, `r9_opus_5_…`, `r9_opus_3_…`, `r9_opus_8_…`, `r9_codex_2_…`, `r10_fable_6_only_links_from_the_member_s_own_key_sets_…`, `r10_fable_6_links_leaving_keys_the_walk_reaches_count_too`, `r10_fable_6_a_session_s_verification_cache_…`, `r11_opus_5_the_session_cache_keeps_at_most_4096_…`, `r11_too_many_links_on_a_pinned_reader_s_walk_…`).
    - Cases: `record-roster-lag`, `record-roster-lag-pinned`, `record-two-link-lag`, `record-retired-key`, `fake-link-first`, `fake-link-first-pinned`, `planted-forged-link`, `planted-forged-link-pinned`, `pin-newer-than-key`, `pinned-newer-identity`, `pin-older-than-first-keys`, `served-kem-substituted`, `served-version-below-path`, `link-version-falls`, `unsigned-continuing-link-first`, `served-rolled-back`, `served-rolled-back-newer-record`, `unsigned-version-no-conflict`, `planted-first-one-sided-link`, `planted-first-planter-consent` (the planted keys' valid half beside junk: bad-signature, not retired-key), `planted-first-new-half-only`, `planted-first-consented` (the control: retired-key), `one-sided-link-on-the-lag` (verified on the version 2 signature), `one-sided-link-consented`, `planted-first-self-consented` (bad-signature: retirement stops at the entry), `planted-first-fork-verified`, `planted-first-fork-forgery` (a fork at the first keys voids only that walk), `served-rolled-back-to-entry` (unchecked), `too-many-links` (64 junk links from the entry's keys: a record under the entry's key still verified), `too-many-links-new-key` (the new key: unchecked), `junk-links-ignored` (65 links from keys the member never held: verified), `planted-pin-one-sided-link` (a pin trusted through the group of later planted keys, the entry put right: key-conflict), `planted-first-pin-one-sided-link` (the same of a planted first entry: key-conflict), `pin-at-folded-identity-one-sided` (a words-check pin of an honest member's earlier identity, a one-sided rotation folded in: the roster's verdict), `cache-key-collision`, `one-sided-first-link-pinned` (one cache, two proofs), `chain-start-ml-dsa-substituted`, `record-forged`, `record-tampered`, `record-lag-unloaded` and `record-tampered-unloaded` (`unchecked`, not bad, when the writer's chain did not load).
- **Residuals:** while a planted entry is the latest, its keys vouch as the member's for readers without a personal pin (the member's own client warns; threat model 3.2). Until consent is uploaded and served (flag F8), a member's pre-entry keys are not retired. A member who restarted without a succession link has no path from their first keys, so their older records read bad (design 2.8). A succession list the server cuts short (served S1 with links up to S1, the member at S2) is undetectable without a per-member high-water mark (design 2.4). Withholding links (`links: []`) turns a pinned reader's verdict into `key-conflict` on genuine data (threat model 3.2).

## I2. The hard warning fires only when the person's own marks conflict

`RosterChain::Fork` / `{ status: 'fork' }` is returned only when the person's marks (their pins and their device's cache) disagree with each other, or when a chain that verified in full does not pass through a mark. A side names a signer only for a statement that verified. A server alone gets refusals, never the warning:

- statements nobody signed are refused;
- the marks are compared with each other before anything served is parsed, so served junk refuses but never hides the warning;
- served version 1 keys other than the marks' are refused before anything is verified;
- the join mark (a newcomer's twelve-word join code, 132 bits of SHA-256 over `hushos/group/join-code/v1`, the admitting roster's digest, its group key's `groupKeyDigest` and key version, from the join words check; a malformed mark is refused, not ignored) is one of the marks: a chain whose roster at that version has another code is the warning (`of: 'roster'`); the core refuses an admission on the roster that drops a key holder (I10), so the code's group key is one no holder removed before the admission ever held;
- a rival succession is the warning only if a roster needing its key holds under it, signed by an active `members` holder.

- **TS:** `group-trust.ts:accept` (steps 1 and 4: `conflict`, `firstKeysMark`, the join mark; served statements parsed after step 1), `checkJoinMark`, `joinCode`, `rosterRules` (rival-key roster), `nextSuccession` (`waiting`).
- **Rust:** `group_trust.rs:accept`, `accept_rosters_joining`, `check_join_mark`, `join_code`, `conflict`, `first_keys_mark`, `State::roster_rules`, `State::next_succession`.
- **Tests:**
    - TS: "a pin is a mark the chain must reach and pass through…", "two pins disagreeing on a group key…", "group key marks…(F6)", "the cache is the person's mark…", "p3: a removed holder's rival succession tied early…", "round 8 › Opus 1: the person's own marks disagreeing are the warning even beside malformed or foreign served statements", "round 8 › Fable F3, r10: the join mark holds the chain to the roster that admitted the newcomer, by a twelve-word code".
    - Rust: their twins (`r8_opus_1_…`, `r10_fable_f3_…`).
    - Cases: `mark-mismatch`, `pins-disagree`, `pins-disagree-junk-served`, `pins-disagree-malformed-served`, `pins-disagree-other-group-served`, `join-mark-holds`, `join-mark-other-roster`, `join-mark-other-group-key`, `join-mark-other-group-key-version`, `join-mark-beyond-chain`, `join-mark-short-code`, `join-mark-after-succession`, `join-mark-after-succession-first-key`, `join-mark-at-succession-tie` (the roster a succession is tied to is the last under the old key), `pin-key-digest`, `cache-pin-disagrees`, `cache-branch`, `pins-other-group-key`, `pins-other-first-keys`, `server-made-first-keys`, `first-keys-elsewhere`, `rival-succession-waits`, `rival-succession-mark-unmet` (refused), `rival-succession-real-withheld` (refused), `rival-key-signed-roster` (warning), `rival-key-roster-by-removed-holder` (refused), `p3-self-listed-rival`, `f1-former-holder-rival`, `f1-with-cache`, `f1-orphan`, `cache-as-marks`, `cache-ignores-other-succession`, `unsigned-chain-vs-pin`.
- **Residuals:** fork consistency only. The server can keep different people on different holder-signed branches for good; only a person's own devices, through their marks, tell they were shown two (threat model 3.2). Concurrent uploads give the server a second holder-signed history with nobody's collusion (the loser of two holders signing one version, or a re-signed retry): it can serve the loser to devices without a mark at that version, and showing it to one with a mark raises the warning; client rule for 1c: a retry resends exactly the signed bytes it uploaded, and on 409 `stale` the admin's client discards the unsent admitting roster and redoes the code step, while the newcomer takes the mark only after admit succeeds (design 2.4, 3.2). The join code does not cover a newcomer whom a holder admitted before that holder's removal; it covers a concurrent upload's loser only when the admitting roster is the stored one; and a divergence right after the join is covered by the newcomer's marks only once they hold one past the admitting roster (before that, the withheld-removal residual).

## I3. No seal or grant opens unless its maker holds the right on the verified chain and signed under a key their verified chain gives them

- A key seal opens only if its sealer is an active `members` holder on the accepted roster (or the creator, for key version 1, while active).
- A grant opens only if its granter is an active member.
- In both cases the signature must hold under the entry's keys (the served ML-DSA key only when its digest is the entry's), or under a key on the maker's verified path from their first key set up to and including the entry's keys. Never past the entry, and never from a planted set. An identity fork lends nothing beyond the entry's own keys.
- A key seal opens only for the holder and key version it names.
- Its seed must derive the group key the verified key chain has at that version.
- The roster the seal names (its sealer's latest accepted roster, by version and digest) must be on the opener's accepted chain: a seal made on a branch, or at a roster the opener has not reached, opens nothing.
- A context naming another group is refused as such before anything is opened.
- A grant opens only for a version of the area the opener's accepted chain lists, and only to the key whose commitment the chain listed for that area and version (`AcceptedRosters.areaKeys`, folded from the rosters' delta rows; the commitment is HKDF of the key alone under `hushos/group/area-key/v2`, round 12, so the binding to area and version is where the roster lists it); there is no high-water floor, so an earlier version's grant opens after a later one has: a granter kept behind (no branch roster needed), or one signing under a retired key, cannot introduce a key the real chain never listed. A granter seals only such a key.
- In a seal's history the links before the entry's keys need successor consent; after them, the version 2 signature.

- **TS:** `groups.ts:openGroupKey`, `openAreaGrant`, `sealAreaGrant`, `listedArea`, `areaKeyCommitment`, `signersThrough` (the walk, consent until the entry), `sealedOnChain`, `sameGroup`.
- **Rust:** `groups.rs:group_key_open`, `area_grant_open`, `area_grant_seal`, `listed_area`, `area_key_commitment`, `signers_through`, `sealed_on_chain`, `same_group`.
- **Tests:**
    - TS: "the group key opens for its holder, from an active `members` holder, to the published key", "a seal from before the sealer's identity was folded in still opens…", "r6: a planted key never grants as the member…", "r7: only an active holder seals…", "a grant from a left granter…", "round 8 › Fable F2 and the sameGroup check…", "round 9 › Opus 1 / Fable A: an honest member kept behind cannot pass on a key the real chain does not list", "round 9 › Opus 3: in a seal's history, links after the entry's keys…", "a grant sealed under another seal kind's info…" (another key under a listed version), "r10 (decision 4): after the area rotates, its earlier grants still open, in either order".
    - Rust: their twins (`r8_fable_f2_…`, `r9_opus_1_an_honest_member_kept_behind_…`, `r9_opus_3_in_a_seal_s_history_…`, `a_seal_under_another_kind_s_info_…`, `r10_decision_4_after_the_area_rotates_…`).
    - Seal cases: `grant-sealed-on-a-branch`, `grant-sealed-on-the-chain`, `seal-from-a-newer-roster`, `sealer-past-entry-refused`, `planted-entry-lends-no-history`, `key-opens`, `grant-opens`, `key-other-reader-version`, `key-seed-not-published`, `key-sealer-not-holder`, `grant-from-left-granter`, `folded-sealer-opens`, `folded-sealer-needs-history`, `folded-sealer-junk-link`, `folded-sealer-forked`, `entry-sealer-moved-on`, `lagging-sealer-refused`, `replaced-sealer-not-folded-in`, `planted-key-grant`, `planted-first-key-grant`, `planted-first-key-grant-planter-consent`, `planted-first-key-grant-consented` (the control: opens), `grant-earlier-version-after-rotation`, `grant-rotated-version`, `folded-sealer-one-sided-after-entry`, `key-other-reader`, `junk-link-names-planted-key`, `creator-left-key-seal`.
- **Residuals:** while a planted entry is the latest, grants to that member go to the planted keys, and seals signed with them open (threat model 3.2). A seal made under a member's earlier keys before their entry opens through history only along consented links (flag F8). A lagging holder can still re-grant keys the real chain listed before the removal: in a family the removed holder had those already; in a company it can hand the removed holder the pre-removal key of an area they never opened (threat model 3.4). A former holder keeps everything they opened before leaving (threat model 3.5).

## I4. A member seals or grants only as an active holder, with the keys their current entry names

The seal functions refuse:

- a sealer who is not an active `members` holder (the creator, key 1, while active);
- a granter who is not active;
- any signing key whose Ed25519 key, or whose ML-DSA key (both derived from the seeds), is not the entry's; on the web a libsodium secret key whose public half is not its seed's is refused too;
- a context naming any roster but the sealer's latest accepted one;
- a grant of a key its latest roster does not list for that area and version (by commitment; an earlier version by the chain's): a new area or a rotation is a roster first, signed by a `members` holder (a product rule: other members no longer rotate areas).

There is no history parameter: after an identity change a member seals nothing until a roster folds the new identity in. Seals go only to an active `members` holder (grants: an active member) at the exact key version, under the ML-KEM key the entry names by digest.

- **TS:** `groups.ts:sealGroupKey`, `sealAreaGrant`, `sealerHolds`, `sealedAtLatest`, `memberRecipient`.
- **Rust:** `groups.rs:group_key_seal`, `area_grant_seal`, `sealer_holds`, `sealed_at_latest`, `member_recipient`.
- **Tests:**
    - TS: "r6: … a replaced identity seals only once a roster folds it in", "r7: only an active holder seals, under both keys its entry names…", "round 8 › Opus 6: the sealer's Ed25519 key comes from its seed…", "round 8 › Fable F2…".
    - Rust: their twins (`r8_opus_6_…`, `r8_fable_f2_…`).
    - Sealer cases: `sealer-own-keys`, `sealer-replaced-not-folded-in`, `sealer-not-themselves`, `sealer-not-holder`, `sealer-left`, `sealer-half-other-key`, `granter-active`, `granter-left`, `sealer-names-an-older-roster`, `granter-names-an-older-roster`, `granter-key-not-listed`, `granter-version-not-listed`.
- **Residuals:** the liveness cost above, by choice (threat model 3.4).

## I5. Rollback: a chain short of a mark is refused

A served chain whose latest roster is below a roster mark, or whose key chain ends below a group key mark, or below the join mark's roster, is refused, never accepted as older. A mark a valid succession never meets is a rollback at the end of the chain.

- **TS:** `group-trust.ts:accept` (step 4: `OLDER`).
- **Rust:** `group_trust.rs:accept`.
- **Tests:**
    - TS: "a pin is a mark the chain must reach…", "a chain taking back a group key the cache verified is a rollback".
    - Rust: their twins.
    - Cases: `rollback`, `group-key-rollback`, `rival-succession-mark-unmet`, `p2b-caught-by-pin`, `join-mark-beyond-chain`; `p2b-missed-removal` is the residual, accepted on a device with no later mark.
- **Residuals:** a device with no mark above a withheld roster cannot tell it was withheld (threat model 3.2, withheld removal).

## I6. Version 1 anchoring

With no pin and no cache, nothing is accepted unless `firstKeysChecked` is true, the flag the join flow's words check over the served version 1 keys sets. With marks, served version 1 keys other than the marks' are refused before anything is verified, and pins and the cache must agree on the version 1 keys.

- **TS:** `group-trust.ts:accept` (step 1), `firstKeysMark`.
- **Rust:** `group_trust.rs:accept`, `first_keys_mark`.
- **Tests:**
    - TS: "a newcomer accepts the chain from version 1…", "group key marks…".
    - Rust: their twins.
    - Cases: `unchecked-first-keys`, `first-keys-half`, `server-made-first-keys`, `pins-other-first-keys`, `cache-other-first-keys`, `first-keys-elsewhere`.
- **Residuals:** the anchor is only as good as the words check.
- **Flag F1:** no join flow exists yet. Nothing outside tests sets `firstKeysChecked` or passes a join mark, so the rule that only the join flow may set them has no enforcing caller and no test. The core enforces the join mark as soon as a caller passes one (cases `join-mark-*`; anything but twelve lowercase words is refused, `join-mark-short-code`).

## I7. The chain's shape

- The chain is the one ending at the single latest roster served, linked by `previousRosterDigest` to version 1 or to the device's cache.
- Two latest rosters, a link that does not reach, or an extension that does not continue the cache are refused.
- Every other roster is a dead branch: ignored and listed, never a warning.
- A cache outside its form, of another group, or not bound to its last roster is refused.

- **TS:** `group-trust.ts:accept` (step 2), `checkCache`, `byDigest`.
- **Rust:** `group_trust.rs:accept`, `check_cache`, `by_digest`.
- **Tests:**
    - TS: "rosters served beside the chain are dead branches…", "the chain is the latest roster linked back to version 1…", "continuing from the cache…", "probes 3a-3c…".
    - Rust: their twins.
    - Cases: `dead-branch`, `two-latest`, `broken-link`, `cache-extends`, `cache-garbage`, `cache-bound`, `cache-junk-extension`, `cache-other-statement`, `same-statement-twice`, `bad-copy-beside-good`, `only-bad-copy`.
- **Residuals:** none beyond I2's fork consistency.

## I8. Every roster on the chain is signed by the right key and the right person

A roster on the chain needs one copy carrying both of the following:

- a group signature, both halves, under the group key current at its version;
- the signer's hybrid identity signature, with the ML-DSA key the authority entry names by digest.

The signer must be active with `members` on the roster before (version 1: on itself), and active on the roster they sign (a holder's own departure is another holder's to sign, with its rotations); every roster keeps at least one active `members` holder (round 11). The group's kind never changes.

- **TS:** `group-trust.ts:rosterRules`, `signedByMember`; `groups.ts:verifyGroup`.
- **Rust:** `group_trust.rs:State::roster_rules`, `signed_by_member`; `groups.rs:group_verify`.
- **Tests:**
    - TS: "refuses a roster or succession on the chain whose Ed25519 half is valid and ML-DSA half is not…", "refuses a roster whose signer was not an active `members` holder…", "refuses a missing or wrong signer identity signature…", "one statement served with other signatures…".
    - Rust: their twins.
    - Cases: `forged-latest`, `signer-ml-dsa-substituted`, `signer-ml-dsa-substituted-sole`, `kind-changes`, `signer-left-on-own-roster`, `last-holder-leaves`, `rival-key-roster-signer-leaves` (a rival-key roster breaking the departure rules is refused, never the warning, round 12).
- **Residuals:** a compromised `members` holder signs whatever they like while they hold the role (threat model 3.3), but cannot sign their own departure, and the group always keeps a holder. A sole holder (a family's organizer, usually) cannot be removed by anyone (threat model 3.3).

## I9. Group key succession

- A succession is taken only if it names the chain's current key, is signed by that key and by an active `members` holder of the roster it is tied to (held, by digest), and is tied no earlier than the succession into its key.
- Its new key must be new: not the old key, nor any earlier one (k1 → k2 → k1 is refused).
- The roster that drops a holder is the last under its key: a succession must follow, and no roster after that succession may be signed by the old key.
- Two successions from one key that are both valid at the same roster, with no mark to choose, are refused. Two tied to different rosters are never both valid at once: the earlier-tied one is taken when its roster is reached, and if it was not the real one the chain then stalls (the real one's rosters are refused as under a replaced key). A denial, never a forgery.
- `checkNextSuccession` refuses a succession tied before the latest roster under its old key.

- **TS:** `group-trust.ts:admissibleSuccession`, `nextSuccession`, `establishNext`, `rosterRules`, `checkNextSuccession`.
- **Rust:** `group_trust.rs:State::admissible_succession`, `State::next_succession`, `State::establish_next`, `State::roster_rules`, `group_succession_check_next`.
- **Tests:**
    - TS: "two successions from one key that both hold…", "a succession that does not hold is ignored…", "P4: a former holder of an old key gets nothing…", "a roster signed by a key after its succession is refused", "a roster after a `members` holder's removal without a succession is refused", "successions are tied in order…", "F4: checkNextSuccession refuses…", "round 8 › Opus 5: a succession back to any earlier group key is refused…".
    - Rust: their twins (`r8_opus_5_…`).
    - Cases: `succession-back-to-an-earlier-key`, `key-window`, `succession-due`, `two-successions`, `two-successions-marked`, `succession-out-of-order`, `succession-tie-digest`, `succession-tied-before-its-key`, `succession-names-other-old-key`, `succession-for-other-group`, `succession-to-the-old-key`, `p4-far-succession`, `p4b-in-order-rival`, `next-succession`, `next-succession-tied-early`.
- **Residuals:** the server can stall a group by serving two valid successions, or a holder's second signed succession tied earlier (threat model 3.2).

## I10. The entry rules

- From one roster to the next, entries never disappear.
- An entry's `sinceVersion` is the version it last changed at.
- An entry's keys and key version are a holder's claim, nothing more; chains are followed from an entry's keys with no version floor.
- A member signature checked through a roster uses the served ML-DSA key only when its digest is the entry's.
- The area rules (round 10, delta rows): a roster carries a row only for each area it creates or rotates, sorted, at most 1,024 (round 11); a new area (every row on roster 1) is at version 1, a rotation one above the chain's latest version for that area. So the chain lists every version of every area once, and the accepted chain (and its cache) keeps them all (`areaKeys`). The cache's last roster's rows must be their areas' latest commitments, and at roster 1 they must be every area; earlier commitments are trusted as stored.
- A removal carries its rotations: in a family, a roster that marks anyone `left` who was `active` rotates every area the chain has, in the same statement (a company's is not held to it).
- No roster that drops a `members` holder admits anyone (an entry new or turned `active`).
- A family's chain lists at most 1,024 areas (`MAX_FAMILY_AREAS`): the row that would make a 1,025th is refused, so a removal's rotation of every area always fits one roster (round 11).
- No key twice: a commitment depends on the key alone (round 12), so acceptance refuses any row whose commitment the chain listed before, in any area at any version, or twice in one roster (`checkAreas`, a set of every commitment on the chain): no-op rotations, another area's key and one key for two areas are refused from any client, at one HKDF per key.
- Rows come from keys: `nextRoster` takes new area keys and computes the rows (`areaRows`), refusing what acceptance refuses before a holder signs. A hand-built hollow row (a fresh commitment while the removed member gets the old key out of band) is the signer's betrayal, not a checkable fault.
- Each reader's own entries naming keys that are not theirs, or an identity older than the roster before named, are reported (`ownEntryWrongAt`); an entry changed at a roster to one of their own identities older than their newest is a soft note (`ownEntryBehindAt`, reported by the acceptance that adds the roster).

- **TS:** `group-trust.ts:checkEntries`, `checkAreas` (versions, the family area cap, the removal's rotations, no admission on a holder's removal), `foldAreas`, `rosterRules`, `accept` (key history, area keys, own entries), `checkCache` (area keys against the last roster); `groups.ts:rosterStatement` (`MAX_ROSTER_AREA_ROWS`), `areasToRotate`, `areaRows`, `nextAreaKey` (refuse any earlier key of any area), `areaCommitments` (own properties of canonical ids only), `MAX_FAMILY_AREAS`, `signerOnRoster`, `memberSigner`.
- **Rust:** `group_trust.rs:check_entries`, `check_areas`, `fold_areas`, `roster_rules`, `accept`, `check_cache`; `groups.rs:roster_statement` (`MAX_ROSTER_AREA_ROWS`), `areas_to_rotate`, `area_rows`, `next_area_key`, `MAX_FAMILY_AREAS`, `member_signer`, `roster_member_signer`.
- **Tests:**
    - TS: "an entry never disappears…", "key versions are a holder's claim…", "a member signature checked through the roster needs the ML-DSA key the entry names", "every roster whose entry for the reader names keys that are not theirs is reported…", "round 8 › Opus 3…", "r10: a roster carries the areas it creates or rotates, one row each, sorted, at most 256", "r10, r11: nextRoster turns new area keys into rows…", "r11 (Opus 1 = Fable 2): a family at 1,024 areas can still remove someone, and makes no 1,025th", "r11 (Opus 7): an inherited name is no area", "round 9 › Opus 1 / Fable A: a cache whose area keys do not match its last roster is refused".
    - Rust: their twins (`r8_opus_3_…`, `r9_opus_1_a_roster_lists_each_area_once_…`, `r10_r11_roster_next_turns_new_area_keys_into_rows_…`, `r11_a_family_at_1024_areas_can_still_remove_someone_…`, `r9_opus_1_a_cache_whose_area_keys_…`).
    - Cases: `own-entry-behind`, `entry-dropped`, `since-version-wrong`, `wrong-own-entry`, `own-entry-rolled-back`, `entry-several-versions-ahead`, `wrong-entry-restored-back`, `f2-inflated-version`, `f3-planted-key`, `areas-added`, `areas-row-repeated`, `areas-version-skipped`, `areas-new-above-one`, `areas-first-roster-above-one`, `removal-rotates-every-area`, `removal-without-rotation`, `removal-rotates-some-areas`, `org-removal-without-rotation` (accepted), `admission-on-holder-removal`, `cache-area-keys-tampered`, `cache-area-keys-extra`, `cache-area-keys-malformed` (a cached commitment that is not a digest: refused by each core's own cache check), `areas-noop-rotation`, `areas-key-from-another-area`, `areas-same-key-twice`.
- **Residuals:** planted keys (I1, I3). An inflated key version locks the member out of new seals and grants until put right. A company's removal still leaves its rotations to the client (F9). A cache edited consistently on a compromised device can rewrite earlier area commitments.

## I11. Area scoping

- Outside the group pin's areas, the roster says nothing: the verdict is `outside` and the personal verdicts apply.
- A grant names an area whose id is derived under the group (`workspace` id kind, scoped to the group id). A grant for a workspace not derived under the group opens nothing.
- No floor on the grant's key version (round 10 removed the high-water option in both twins): rollback of an area is caught by the chain (`areaKeys`, `areaWriteVersion`), and readers need earlier keys for older files.

- **TS:** `group-trust.ts:groupWriterTrust` (areas); `groups.ts:areaOf`, `openAreaGrant`, `sealAreaGrant`; `ids.ts:checkId`.
- **Rust:** `group_trust.rs:group_writer_trust`; `groups.rs:area_of`, `area_grant_open`, `area_grant_seal`; `ids.rs:check_id`.
- **Tests:**
    - TS: "roster trust gives `verified` inside the group's areas and nothing outside them", "a grant naming this group for a workspace not derived under it opens nothing", "an area grant opens for its grantee".
    - Rust: their twins.
    - Cases: `record-outside-areas`.
- **Residuals:** a malicious member can make a real area and invite people into it (threat model 3.4).
- **Flag F2:** the areas list comes from the caller (the group pin). No app code reads or writes it yet, so nothing enforces that callers pass it. The pin keeps a version per area for its form only.

## I12. `checkNext*` is acceptance itself, and `nextRoster` never builds what acceptance refuses

`checkNextRoster` and `checkNextSuccession` extend a chain's cache by one statement under the very rules of acceptance. In TypeScript they take an accepted or a stored chain and return the extended chain as a `StoredChain` (frozen, in its own registry), whose cache the server stores next; in Rust they return nothing. `acceptStoredChain` (TypeScript only, in the server entry `@hushos/crypto/group-trust/server`) is the server's acceptance of what it stores, anchored on the version 1 keys it stored, with no reader and no pins: never a reader's acceptance (I14). `foldInEntry` follows an identity change only through the group walk from the entry's keys, on each link's version 2 signature (consent buys nothing there), never the personal verifier. With the members' identities, `checkNextRoster` also refuses an entry naming keys its member never had. `nextRoster` applies the same rules (signatures aside) before a holder signs.

- **TS:** `group-trust.ts:checkNextRoster`, `checkNextSuccession`, `acceptStored`, `extend`, `nextRoster` (rows computed from keys, the removal's rotations), `newRosterEntry`, `foldInEntry`; `group-trust-server.ts:acceptStoredChain`.
- **Rust:** `group_trust.rs:roster_check_next`, `group_succession_check_next`, `extend`, `roster_next`, `roster_entry_new`, `roster_entry_fold_in`.
- **Tests:**
    - TS: "a roster nextRoster builds is always one acceptRosters takes", "nextRoster refuses what no device would accept…", "checkNextRoster is acceptance itself…", "a new member's entry comes only from the keys their words check confirmed", "an identity change is followed only through its succession chain…" (a one-sided link folds in), "r10 (Opus 1): the server's acceptance makes a StoredChain, which checkNext continues and nothing else takes" (TS only).
    - Rust: their twins (`r10_r11_roster_next_turns_new_area_keys_into_rows_…`).
    - Cases: `next-roster`, `next-roster-not-holder`, `next-roster-drops-entry`, `next-roster-planted`, `next-roster-planted-unchecked`, `next-succession`, `next-succession-tied-early`.
    - Fold-ins: `two-ahead`, `forged-link`, `one-sided-link`, `inflated-version` (each generator also checks which change the entry); case `identity-change`.
- **Residuals:** a server that skips the checks can stall the group until the bad statement is removed.
- **Flag F3:** the server must run both checks before storing. There is no group API in the server yet, so nothing on the server side enforces or tests this.

## I13. Canonical encoding

Every statement (roster, succession, seal, grant) is the canonical array:

- lowercase UUIDs;
- base64url digests;
- integers 1..2^53−1;
- strictly ascending lists;
- version 1 rosters with an empty previous digest.

Every parser re-encodes and refuses a document that differs. Both twins produce identical bytes. Beneath the fields, the encoder and the parser in both twins keep one grammar: at most 4 MiB, no byte-order mark, arrays at most four deep of plain printable-ASCII strings (no `"`, no `\`) and integers 0..2^53−1, the bytes exactly their compact encoding. A roster has at most 10,000 entries and at most 1,024 area rows (`MAX_ROSTER_AREA_ROWS`), one per area it creates or rotates, sorted by workspace id. Empty byte strings are never canonical. Identity key versions in keys statements and succession links are bounded to 1..2^53−1 in both twins. Record statements (Codex round 3) refuse empty ids and metadata versions above 2^53−1 in Rust, and content suites above 2^32−1 on the web; identity envelopes need a key version in 1..2^53−1 and a non-empty keys signature in Rust, and the web wraps identities only under a 32-byte account root. Pins' check times are the canonical ISO form.

- **TS:** `canonical.ts:requireCanonical`, `uuid`, `integer`, `ascending`, `bytesOf`, `encodeStatement`, `parseStatement` (`grammatical`, `MAX_STATEMENT_BYTES`); `groups.ts:parseRoster`, `rosterStatement` (`MAX_ROSTER_MEMBERS`), `parseGroupSuccession`; `signatures.ts:successionStatement`, `keysStatement`; `pins.ts:checkTime`; `keys.ts:encode` (no argument spread).
- **Rust:** `canonical.rs` (same names, `grammatical`, `MAX_STATEMENT_BYTES`); `groups.rs:roster_parse`, `roster_statement` (`MAX_ROSTER_MEMBERS`), `group_succession_parse`; `signatures.rs:succession_statement`, `keys_statement` (`key_version`); `group_trust.rs:check_time`, `version_index`.
- **Tests:**
    - TS: the "encoding" block in `groups.test.ts`; "round 8 › Codex 3 and 6…", "round 8 › Codex 1 and 5…" (`groups.test.ts`); "the pin written after acceptance…" (check times).
    - Rust: `a_roster_is_the_web_s_canonical_array…`, `lists_ascend_without_repeats…`, `a_succession_names_the_next_version_only`, the `canonical.rs` tests (`statements_keep_one_grammar_and_a_size_cap`), `r8_codex_3_…`, `identity_key_versions_stop_where_the_web_s_safe_integers_do`, `the_pin_written_after_acceptance_…` (check times, `version_index`), `codex_r3_record_statement_fields_are_bounded_…`, `codex_r3_the_envelope_guard_is_the_web_s_…`; TS "a content suite is one the core can hold…" (`signatures.test.ts`), "the account root an identity is wrapped under…" (`security.test.ts`).
    - Fixtures: every roster and succession rebuilds to the other twin's bytes, and each seal's associated data is its statement without its digest; `statementCases` (18 raw byte strings each twin parses or refuses alike); chain case `chain-version-beyond-safe`; cases `pin-check-time-not-canonical`, `pin-check-time-month-13`.
- **Residuals:** none.

## I14. Only `acceptRosters` makes an accepted chain

- Seal, open, signer, write-version, pin and trust functions take only a chain a reader's acceptance produced.
- The web freezes it and keeps a registry; a copy vouches for nothing.
- The server's acceptance (`acceptStoredChain`) and `checkNext*` make a distinct branded `StoredChain` with its own registry. Only `checkNextRoster`, `checkNextSuccession` and `acceptStoredChain` take it; every other function refuses it, by type and at run time. `acceptStoredChain` lives only in the server entry `@hushos/crypto/group-trust/server`, which refuses to load in a browser or worker, and the module-level `acceptStored` needs a capability symbol that entry alone holds. The web app's client build never imports that entry (`apps/web/src/lib/server-imports.test.ts`). A stored chain carries no cache: its record is a `StoredChainCache` (`origin: 'server'`) that only the server entry's `storedRecord` hands out, and a reader's acceptance refuses it as a cache (and the server's refuses a device's), by type and at run time, so the server's acceptance cannot be laundered into a reader's through its data (round 11, Opus 3). `areaRows` and `nextAreaKey` also require an accepted chain.
- Rust's `AcceptedRosters` is a UniFFI object with no constructor; Rust has no server role and no stored chain.

- **TS:** `accepted.ts:markAccepted`, `requireAccepted`, `markStored`, `requireStoredOrAccepted`, `STORED_ACCEPTANCE`, `deepFreeze`; `group-trust.ts:asAccepted`, `asStored`, `acceptStored`, `storedCacheOf`, `checkCache` (the origin rule); `group-trust-server.ts` (`storedRecord`).
- **Rust:** `group_trust.rs:AcceptedRosters` (no public constructor).
- **Tests:**
    - TS: "an accepted chain is frozen, and a copy of it opens and vouches for nothing", "an accepted chain cannot be written out by hand (a type error)", "r10 (Opus 1): the server's acceptance makes a StoredChain, which checkNext continues and nothing else takes"; "round 10 › the server entry refuses to load in a browser build"; web: "server-only imports › no browser module imports a server-only package" (`server-imports.test.ts`).
    - Rust: `the_seals_and_signer_take_the_chain_accept_rosters_made`.
- **Residuals:** none in the core.

## I15. An identity fork lends no history

Two verified links leaving one of a member's key sets, to different keys, form an identity fork. On the walk from the entry's keys or from a personal pin, records read `unchecked` whatever the order served, pinned or not; on the walk from the first keys a fork voids only that walk's retirement (whoever holds the first keys can mint two consented links from them, and would otherwise suppress every verdict of the member, forgeries included). Seals open only under the entry's own keys.

- **TS:** `succession-path.ts:successionPath` (`fork`, counted among links that hold under the walk's proof); `group-trust.ts:groupWriterTrust` (`fromFirstKeys` never sets `forked`); `groups.ts:signersThrough`.
- **Rust:** `succession_path.rs:succession_path` (`Fork`); `group_trust.rs:group_writer_trust`; `groups.rs:signers_through`.
- **Tests:**
    - TS: "r7: two successions the member signed from one key are an identity fork…", "r7: only an active holder seals… a forked identity lends no history".
    - Rust: their twins.
    - TS also "round 9 › Fable C: two links leaving the first keys void only that walk…"; Rust `r9_fable_c_…`.
    - Cases: `identity-fork`, `identity-fork-pinned`, `folded-sealer-forked`, `planted-first-fork-verified`, `planted-first-fork-forgery`.
- **Residuals:** a server holding a succession it refused (a race between two devices) can fork a member on purpose: a denial, never a forgery (design 2.8, threat model 3.2). Retry-safe `createSuccessor` is out of scope.

## I16. The personal-pin verifier is unchanged

`verifySuccessionChain` / `succession_chain_verify` keep their shipped semantics: the chain is every link from the first one at the pin to the end of the list, in the order served. Junk before it is skipped; junk after it, links out of order, or another ML-DSA key at the start refuse. It checks the version 2 signature and ignores `consent`, so the one-sided links every shipped client signed keep holding for personal pins. The group core never calls it (fold-in uses the group walk since round 8). `SuccessionLink.consent` is optional in both twins (uniffi default `None`), so the iOS and Android callers are unchanged.

- **TS:** `identity.ts:verifySuccessionChain`.
- **Rust:** `identity.rs:succession_chain_verify`.
- **Tests:**
    - TS: `succession.test.ts` "a chain holds from the pinned keys to the served ones, and nothing else does", "a chain never verifies a half under an ML-DSA key the pin did not name", "the successor co-signs its link, and only both keys, each in its role, make consent" (the chain follows the link with and without consent).
    - Rust: `a_chain_holds_from_the_pinned_keys_…`, `a_successor_co_signs_its_link_and_only_both_keys_each_in_its_role_make_consent`.
    - Chain cases: `chain-holds`, `chain-junk-before`, `chain-junk-after`, `chain-one-sided`, `chain-out-of-order`, `chain-start-other-ml-dsa`, `chain-version-beyond-safe`.
- **Residuals:** a server can append junk to make a real succession read as a changed key: a refusal, never an acceptance (identity-pq design 2). The group walk never checks a consented link's version 2 signature, so the two can disagree on one link; the personal verifier never reads the group walk's verification cache.

## Flags

- **F1 (I6):** `firstKeysChecked` has no production caller; the join flow that alone may set it is not built.
- **F2 (I11):** the areas list comes from the group pin; no app reads or writes group pins yet.
- **F3 (I12):** the server's duty to run `checkNextRoster`/`checkNextSuccession` before storing has no server code and no test.
- **F4 (I2, I5):** marks only protect a person whose pins sync across their devices; the settings sync of group pins is not built, so cross-device marks are untested outside the core.
- **F5 (I5, threat model 3.2):** a withheld removal on a device with no later mark has no enforcing check, by design (a residual, not a bug); the planned 1c mitigation for newcomers is the join code (twelve words, 132 bits over the admitting roster's digest, its group key and key version), which the core already enforces when given, with the rule that no admission rides on a holder's removal. The flow (sign locally, show the code, check, upload the same bytes; on 409 redo the code step; the newcomer takes the mark only after admit) is 1c's.
- **F6 (I1):** a succession list the server cuts short is undetectable without a per-member high-water mark of link-verified key versions (design 2.4); none is kept in milestone 1.
- **F7 (I2):** the client rule that a retry resends exactly the bytes it uploaded is milestone 1c work; until then concurrent uploads hand the server a second holder-signed history (design 2.4).
- **F8 (I1, I3):** clients make successor consent (`createSuccessor`, `identity_succeed`), but the succession route, `account_identity_history` and the identity lookups carry only the version 2 signature, and no client uploads `consent`. Consent is asked only on the walk from a member's first keys to their entry's, so until 1c builds it (and backfills earlier links from each account's identity history), only that walk is affected: a member whose entry moved on from their first keys has none of those keys retired, and seals made under them do not open through history. The lag, personal pins and fold-ins take the version 2 signature and are unaffected.
- **F9 (I3, I10):** the client rule that a member writes an area only under its latest version on the accepted chain (`areaWriteVersion`), and writes nothing there without a grant for it, is milestone 1c work; the core gives the version. In a family the core now refuses a removal without every area's rotation, so the removal route must carry the roster, the rotations and the new grants in one call (design 3.3, 4); a company's rotations stay a client duty. The rotation and area routes must take the roster that lists the new version, and the server must refuse a new area row whose workspace is not a group workspace it has (1b); no server code exists yet.
- **F11 (I10):** areas are never retired. A deleted area keeps counting toward the family cap and keeps being rotated by every removal; a retirement (tombstone) row must come before area deletion ships.
- **F12 (I1):** `trustedVia` has no production writer yet: "Trust as Acme does" is 1c's UI, so only the core and tests set it. The iOS and Android pin types carry it from round 12, keep it when a pin follows a succession and clear it on a words check, as the web does; already-shipped builds keep it on every rewrite, words checks included (conservative: consent asked where none was needed).
- **F10 (I12, I14):** `acceptStoredChain` is TypeScript only (no app accepts as the server), in the server entry; the server code that calls it is 1b's.

No invariant above lacks an enforcing check in the core or a test in both twins (except `acceptStoredChain` and the stored record, TypeScript only, F10); F1–F5, F7–F10 and F12 are the places where enforcement depends on code outside the core that does not exist yet, F6 is a residual by design, and F11 is a rule that must exist before area deletion.
