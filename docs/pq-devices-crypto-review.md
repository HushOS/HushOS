# Post-quantum identities, devices and migrations: cryptography review

**Status (15 October):** applied on 2026-10-15 in the revised `docs/identity-pq-design.md`, `docs/devices-design.md`, `docs/envelope-migrations.md`, `docs/groups-design.md` and `docs/groups-threat-model.md`, except for the guardian findings, which the owner scoped out and which are recorded as residuals in envelope-migrations 7 and the threat model's 3.7. Every child conversion now waits 7 days, with no instant path. Not applied: C2's fixes 1 and 2, H5's link revocation, H6's fixes, H7's cancelling rule, sign-up link and mandatory child approval, M9's write frontier, and the young adult's escape-path prompt. H1 takes the first option. M2's "Start over with new keys" and L4's recovery are still to confirm.

Independent review of `docs/identity-pq-design.md`, `docs/devices-design.md` and `docs/envelope-migrations.md`, read against `docs/groups-design.md`, `docs/groups-threat-model.md`, `docs/groups-crypto-review.md`, `docs/integrity-design.md`, `docs/opaque-auth-design.md` and the code at `13b315a`. 15 October 2026.

## Verdict

Do not build device approval or child conversion as written. The post-quantum identity design is close.

- **Post-quantum identities.** The constructions are sound: the hybrid AND-signature selected by statement version, share suite 4, the keys statement and fingerprint v3. But two verification paths check the ML-DSA half under a key the attacker can name: the succession chain (H4) and every member signature checked through a roster (H3). The v3 pin format does not fit in the settings document (M4).
- **"Keys need a device" does not do what it claims.**
    - The short code has no commitment. The server relays the approver's key last, grinds a matching code in under a second, and receives the account key every time a device is added (C1).
    - Master-key rotation hands the new root to whatever device list the server serves (H1).
    - Locking leaves the key on disk with no password factor, which is worse than locking today (H2).
- **Child conversion fails its purpose.**
    - A guardian holds the child's root, and the root decrypts the recovery-phrase backup, so the guardian can make a phrase-approved device that converts at once (C2).
    - Device classes launder through approvals (C2).
    - Links survive the re-key (H5).
    - A guardian who also controls the server keeps what contacts send the young adult (H6).

Two decisions are unsafe as agreed. The instant conversion path in envelope-migrations decision 5 is one (C2). Devices-design's "no level forced on children" is the other (H7), and it also contradicts decision 5. Everything else has a cheap fix, except the contest between a guardian and a young adult at `adult_from`. No credential the account held before that date can tell them apart, and the documents must say so.

## Critical

### C1. The approval code has no commitment, so the server picks the last key and grinds a matching code

**What.** In devices-design §2 (lines 63–85; API, lines 237–241), the new device posts its keys. The approver reads them and posts its ephemeral key, and the new device then reads that ephemeral key back from the server. Each device computes `code` over what it saw. Nothing commits either side before the other side's value is known, and the value the new device receives last is entirely the server's choice. The code is about 17.6 bits.

**Attack (Keys need a device).** Maya signs in on a new laptop N.

1. The server shows Maya's phone A a request that carries the server's own transfer keys. A posts `eA` and computes `codeA`.
2. The server tries random 32-byte values `eS` until `SHA-256("hushos/device/approval/v1" || requestId || sN || xN || sha256(kN) || eS)` truncates to `codeA`. Any 32 bytes is an X25519 public key, so this takes about 2^17.6 ≈ 200,000 hashes, well under a second. If the server wants N to keep working, it uses real key pairs instead, which takes seconds.
3. N shows `codeA`, Maya taps it on A, and A seals the account key to the server's keys.
4. The server opens the account key and seals it again to N under `eS`, so nothing looks wrong.

The doc's sentence "That is what makes the key transfer at the second level safe from the server" (line 85) is therefore false: at level 2, a hostile server gets the root every time a device is added. The new device's own check ("refusing a key that does not open the account's identity envelope and its workspace grant", §3) adds nothing against the server. The server serves those envelopes, and once it holds the root it can make them consistent with any key. The test in §9 ("a swapped transfer key or ephemeral key gives the two devices different codes") passes while this attack works, because it swaps naively instead of grinding.

**Fix.** Commit before revealing, which is the standard SAS-MA construction:

```
1. New device:  POST /approvals            { commitment = SHA-256("hushos/device/approval/commit/v1" || newDeviceSigningKey || newTransferX25519 || sha256(newTransferKem) || nonce) }
2. Approver:    POST /approvals/:id/open   { approverEphemeralKey }
3. New device:  POST /approvals/:id/reveal { newDeviceSigningKey, newTransferX25519, newTransferKem, nonce }   // only once step 2 has reached it
4. The approver checks the commitment; both compute
   code = SHA-256("hushos/device/approval/v2" || userId || requestId || newDeviceSigningKey || newTransferX25519 || sha256(newTransferKem) || approverEphemeralKey || nonce)
```

The server must fix what each side sees before it learns the other side's fresh value. A forged match then succeeds with probability 2^-17.6 per attempt, and there is nothing to grind. The code also gains `userId`.

Where the approver has a camera, prefer a QR code: the approver scans the new device's screen, which carries `requestId` and a digest of its keys. This is how Signal and WhatsApp link devices. It binds 256 bits and removes the human comparison altogether.

Replace the §9 test with this one: a server that substitutes keys on both sides and chooses the approver's key last gets matching codes no more often than chance.

### C2. A guardian can always learn the child's recovery phrase, and a phrase-approved device converts at once

**What.** Envelope-migrations §7 (lines 145–151) and devices-design §6 (line 214) let a conversion go through at once from "a device approved ... by the phrase or at enrolment". But a guardian holds the child's root, through the guardian seal (groups-design 2.9), and the root opens the phrase:

- The recovery envelope's `encryptedRecoveryKey` is the recovery secret sealed under `HKDF(root, salt, "hushos/recovery/secret-backup/v1")` (`packages/crypto/src/recovery.ts:146-166`).
- That backup is how `/app/recovery-key` shows the phrase again (`packages/crypto/src/session.ts:1421-1434`).

Separately, "approved by another of the child's devices" is conferred by any device. A device of the `guardian` or `password` class can approve a second device, and that second device then counts as the child's.

**Attack.**

1. Before `adult_from`, the guardian resets the child's password, which groups-design 3.6.4 allows.
2. The guardian signs in as the child on their own laptop. The pending session is served the recovery envelope so that it can approve with the phrase.
3. The guardian decrypts the phrase backup with the root from the guardian seal and approves the laptop with the phrase: `approved_by = phrase`. The child's record now shows a device "approved by your recovery phrase", which is exactly what the child's own new phone would show.
4. At `adult_from`, the laptop converts at once: new password, new phrase, every other device signed out.

The young adult is locked out at the moment the account was meant to become theirs, which is the attack §7 was written to stop. The doc also says that a guardian reset "does not put the account on the guardian's device" (line 148); through the phrase, it does.

There are two variants:

- The guardian takes a `guardian`-class device through the "both lost" path, then uses it to approve a second device, which has the instant class.
- After `adult_from`, a guardian who knows the phrase and can read the child's mailbox runs a phrase reset through `/recover`. The server refuses only the guardian's own reset route.

**Fix.** Envelope-migrations decision 5 is unsafe as agreed. Change it:

1. Child accounts keep no phrase backup under the root. The phrase is shown once, on the device that made it, and `backup` and `/app/recovery-key` stay off until conversion.
2. A device's class is the weakest along its approval chain. The `guardian`, `password`, `email-wait` and `existing` classes taint every device they approve.
3. The server cannot tell who holds a phrase, an enrolment device or a device either of them approved, so drop the instant path on child accounts: every conversion waits 7 days. H7 covers who may cancel.
4. State in §7 and in the threat model that a guardian who knows the password at `adult_from` cannot be told apart from the young adult by any credential the account held before that date.

## High

### H1. Master-key rotation under Keys need a device seals the new root to keys the server picks

**What.** Devices-design §3 (line 134) says "each approved device receives the new key on its next unlock through the same transfer, approved automatically by the rotating device's signature". That transfer has no code comparison. `account_devices` stores no transfer key, and the list of approved devices is a server table. The server can invent its entries: `existing` and `password` devices, and device signatures that only the server checks.

**Attack.** Maya removes a stolen phone and rotates her master key. The server adds a device of its own, or swaps the transfer key of a real one, and the auto-approval seals the new root to it. The rotation that was meant to cut off a compromise hands the root to the server. As specified, this is as bad as C1. Rotation does not help against the thief either: master-key rotation keeps the identity keys, the settings key and the workspace keys (groups-crypto-review C1), so the old root the thief holds still opens everything.

**Fix.** Choose one:

- After a rotation, every other device approves again with the code. This is simple and honest.
- When a device passes a code-checked approval, record its long-term transfer public keys in a device list. The account's hybrid identity key signs that list, and each device keeps the list's version as a local mark so it cannot be rolled back. A rotation then seals only to keys in the latest list the rotating device has verified, and removed devices leave the list before the rotation.

Either way, specify the `requestId` and the associated data for this transfer.

### H2. Locking under Keys need a device leaves the account key on disk with no password factor

**What.** Devices-design §3 (lines 126 and 129) says that locking keeps "the device's sealed copy" and that unlocking "asks for the password ... as remembered unlock does today". That is not what happens today. On the web, an explicit lock deletes the copy: `lock()` in `packages/auth/src/client.ts:327-336` clears `device` and calls `deviceKeys.clear()`, so unlocking again needs the password to open the password envelope.

Under level 2 the copy stays. On the web it is wrapped only by a non-exportable AES key in IndexedDB, whose key material the browser keeps in the profile on disk. On iOS it sits in a keychain item at `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` (`apps/ios/Packages/HushOSKit/Sources/HushOSKit/Keychain.swift:73`). The password only gates a server session, which a local attacker does not need.

**Attack.** A locked laptop is stolen, or malware copies its disk. At level 0 or 1, after a lock, the disk holds nothing that opens the account. At level 2, the browser profile holds both the AES key and the bundle, and so the root, without the password. The setting presented as the strictest makes device theft worse.

**Fix.** Under level 2, seal the device's copy a second time under something a thief lacks:

- On the apps, use a Keychain or Keystore key that requires user presence (`.userPresence`, `setUserAuthenticationRequired`).
- On the web, use a WebAuthn PRF output where one is available. Otherwise use a key derived from the OPAQUE export key, `HKDF(exportKey, deviceSalt, "hushos/device/password-wrap/v1")`, so that every guess needs the password and one OPAQUE run with the server.

Accept that a password change then makes the other devices approve again, and say so.

### H3. Group signatures are hybrid, but the roster does not carry members' ML-DSA keys

**What.** In groups-design 2.4 (line 78), a member entry is `[userId,keyVersion,encryptionPublicKey,signingPublicKey,kemPublicKeyDigest,status,roles,sinceVersion]`. Members sign with the hybrid identity signature (identity-pq §3, groups-design 2.2) as the sealer of a key seal, the granter of an area grant, the child sealing a guardian seal, and the signer of a roster. Readers check those signatures against the roster. The roster holds no ML-DSA key, so the ML-DSA half can only be checked against the key the server serves.

**Attack.** A quantum forger, for example the server at some later date, forges the Ed25519 half against the roster's `signingPublicKey` and signs the ML-DSA half with its own key, which it serves as the member's. Every member signature that a reader verifies through the roster is in effect Ed25519-only, and that covers everyone without a personal v3 pin of that member. This breaks the claim in groups-design line 52 that "no roster, seal or succession is ever signed by Ed25519 alone".

"Trust as Acme does" (groups-design 2.8) has a related problem. It writes a personal pin from the roster's keys, which has no ML-DSA key, and after the post-quantum release such a pin trusts nothing.

**Fix.**

- Add `mlDsaPublicKeyDigest` (SHA-256, base64url) to the member entry.
- Check it when folding a member in: against the word-checked keys at admission, or along the v2 succession chain.
- Verify every member's ML-DSA half against the roster or a v3 pin, never against a served key.
- Groups-design 2.1 (line 41) still has the signer check "the identity's KEM binding". Version 2 identities have no KEM binding; make it the keys statement.

### H4. The v2 succession chain is specified "by keys", but the code compares only X25519 and Ed25519

**What.** Identity-pq §2 (line 95) says `verifySuccessionChain` "keeps its continuity rules (by keys ...)". In both twins, the chain starts and continues on X25519 and Ed25519 alone, and each link is verified under the key the link itself names (`packages/crypto/src/identity.ts:585-619`, `crates/hushos-core/src/identity.rs:563-592`). `PinnedKeys` has no ML-DSA field.

**Attack.** Suppose the code is extended the obvious way: `oldMlDsa` and `newMlDsa` are added to the statement, and the hybrid signature is verified under the link's own keys. A quantum forger can then start a chain at the pinned X25519 and Ed25519 keys with an `oldMlDsa` of their own. The Ed25519 half verifies under the pinned key, the ML-DSA half verifies under the forger's key, and the pin moves to the forger. This is the forged succession that the post-quantum design exists to stop.

**Fix.** Write the rules down:

- The chain starts only at a link whose `oldX25519`, `oldEd25519` and `oldMlDsa` equal the v3 pin's.
- Each link's old keys equal the previous link's new keys, ML-DSA included.
- Each half of each signature verifies under the pinned key or the previous link's new key, never under a key that only the link names.
- The chain ends at the served X25519, Ed25519, ML-DSA and ML-KEM keys.

Add this test: a link whose ML-DSA half is valid under any key other than the pinned one is refused.

### H5. Links survive conversion, and the guardian already has every link's URL

**What.** Envelope-migrations §7, step 3 (line 131), says that "links are re-sealed by the rotation as today". The owner's sealed copy of each link (`secretEnvelope`, holding the fragment secret, the path token and the password's stretched key) is sealed under the node key (`packages/crypto/src/links.ts:163-200`). Rotation seals the link again with the same secret (`packages/drive/src/client.ts:1455-1465`).

**Attack.** Before `adult_from`, the guardian browses the child's space, which is allowed. Using node keys under the old workspace key, they open every `secretEnvelope` and collect each full URL. After conversion the links still work with the same secrets. As an anonymous visitor, the guardian opens every linked file and folder, including anything added to a linked folder later. No help from the server is needed. The claim that "they hold nothing that opens what comes next" (line 128) is false for every linked subtree.

**Fix.** Conversion, early release and guardian removal revoke every link, since links are bearer secrets the guardian could read. The young adult gets a list of them to create again with fresh secrets, and the conversion screen says so.

### H6. After conversion, a guardian working with the server can capture what contacts send the young adult

**What.** The identity succession in the conversion (envelope-migrations §7, step 1) is signed by the identity from before conversion, whose private keys every guardian holds. Contacts follow a succession only when they ask to ("Check again", integrity Round 3). Until they do, they keep sealing new shares to the old identity. Family holders fold in whichever succession the server serves them.

**Attack.** Take a parent who runs the family's self-hosted server, or a guardian working with a hostile server. They can serve contacts a succession of their own, signed with the old key, and receive every new share. Or they can simply keep the share envelopes that are sealed to the old identity, which the guardian opens.

"Nothing that opens what comes next" holds for the young adult's own drive, not for what other people send them. Every rule in §7 that the server checks (device classes, the 7-day hold, refusing guardian resets after `adult_from`) is void on a server the guardian runs.

**Fix.**

- Mark the conversion in the signed statement, either with a `reason` field or a distinct domain such as `hushos/identity/succession-conversion`. Clients never follow it on the chain alone: contacts and roster signers compare words with the young adult.
- After the switch, the young adult's devices refuse shares sealed to an identity from before conversion, with "Ask them to share it again".
- Say in the threat model that, beyond the re-key itself, conversion cannot protect against a guardian who runs the server. On the web, such a server can also serve altered code.

### H7. Conversion can still be blocked or captured, and two documents disagree on whether children need approval at all

**What.**

- **Enrolment.** The sign-up link is returned to the guardian (`POST /api/groups/:id/children` → `{ link }`, groups-design line 270). Groups-design 3.6.1 still says "on their own device (or the guardian's)" (line 205). "Signing up on a guardian's device is not offered" (envelope-migrations line 147) is a promise in the interface, with nothing to enforce it: whoever opens the link gets the `enrolment` device and sees the phrase.
- **Cancelling and removing.** Any device, or the email, can cancel a held conversion (line 150), and any device can remove any other (`DELETE /api/auth/devices/:id`). A guardian with a device on the account, or with the child's mailbox, can cancel every held conversion forever. They can also remove the child's device that would convert at once before it is used.
- **Approval levels.** Devices-design (lines 8, 211 and 216) lets a guardian leave approval off for a child ("there is no level forced on children"). Every later device the child adds is then of the `password` class, so every conversion waits and can be cancelled. Envelope-migrations line 148 says new devices on child accounts always need approval. The devices-design decision is unsafe.
- **Delay.** Groups-design 3.6.7 (line 211) says a guardian "cannot block, delay or undo" conversion. A 7-day hold is a delay.

**Attack.** A guardian who controls a teenager's mailbox and keeps one `password` device cancels every conversion the young adult starts from a replacement phone, indefinitely.

**Fix.**

- Send the sign-up link to the child's address, never back to the guardian.
- Make approval mandatory on child accounts: keep envelope-migrations' rule and correct devices-design §6.
- Allow a held conversion to be cancelled only from a device whose approval chain is untainted (C2's rule) and that predates the conversion request. Allow cancelling by email only if the account holder re-verified the account's email after `adult_from`.
- Remove "delay" from groups-design 3.6.7, or remove the hold from §7.
- Write the young adult's escape path into the prompt: remove devices you don't recognise, change the password, replace the phrase, change the email, then convert.

### H8. "Pick one of three codes" approves a reflexive tap a third of the time

**What.** In devices-design §2, step 4 (line 72), the approver shows its own code and two random ones, and a tap on the right one approves. A new request replaces any open one (line 87), and the device's name is whatever the new device reports.

**Attack.** With no new device screen to compare against, a person who taps something approves with probability 1/3. That is the situation for a stranger's sign-in, or for a prompt that a hostile server invents at level 2.

A password holder can also time a request to replace the person's own sign-in. The code on the person's laptop then matches none of the three codes, and a confused tap again approves with probability 1/3. Because an account gets at most five requests a day, the same attacker can also stop the person adding a device for a day.

Microsoft's number matching makes the person type the number for this reason.

**Fix.**

- Make the person type the code on the approver (the two digits and the word, with word completion), and accept only an exact match.
- Have each approver keep its own cap on prompts per day, since a hostile server ignores the server's.
- Refuse a request that would replace one already opened, and have the replaced device say so.
- Offer "This wasn't me", which ends the request and sends a security notice.

## Medium

### M1. Level 2 does not forbid password envelopes, and turning it on rotates nothing

Three flows write a password envelope today, and none of them is excluded under Keys need a device:

- **The phrase reset.** The reset message even signs over `envelope` (`packages/crypto/src/recovery.ts:52-84`). Devices-design line 135 says only that the reset "replaces the password".
- **Master-key rotation** (`packages/crypto/src/security.ts:149-191`). It also opens the root from the password envelope that level 2 has deleted.
- **The conversion switch**, which writes "the new root's password envelope" (envelope-migrations line 121).

Any of these silently returns the account to level 1, cryptographically.

Separately, turning level 2 on deletes only the current envelope. Backups, and anything else that copied the envelope, still open a root that never changed, given the password or a guess of it. OPAQUE lets a breached server test guesses offline at Argon2id cost.

**Fix.**

- The server refuses every write of a password envelope while level 2 is on.
- Specify how rotation, the phrase reset and conversion work under level 2.
- Tell the person that earlier copies keep opening the account until the account is re-keyed (M2).

### M2. Level 2's claims go further than what it delivers

Devices-design line 129 says that "no new device, and no server, can get the key without an existing device or the phrase". That holds only against a passive database breach after the switch, on an account used only from the apps.

- It does not hold on the web, where the server serves the code (threat model §5).
- It does not hold against an active server until C1, H1 and M1 are fixed.
- Removing a device revokes nothing cryptographically. The device keeps the root, which still opens the identity, settings and workspace keys, because master-key rotation wraps the same keys again instead of replacing them.

**Fix.** Say exactly this in §2 and §3. Offer adults the conversion re-key as "Start over with new keys" after losing a device. It now exists, and it is the only operation that evicts someone who once held the root.

### M3. Under level 2, today's restore logic destroys a device's only copy of the key

`restore()` in `packages/auth/src/client.ts:278-285` deletes the bundle (`device: null`) whenever the session has gone or its credential version differs. Sessions end after 30 days at most, and every password change or phrase reset bumps the credential version and ends every session. Under level 2 that bundle is the device's only copy, so a person with one device and no phrase loses the account when the session expires.

Devices-design says remembered unlock works "as today", and that "other devices keep working" after a phrase reset (line 135). Neither is true of the code.

**Fix.** Under level 2:

- Keep the bundle when the session ends.
- Drop `credentialVersion` from the bundle's associated data, or bind it again after re-authentication.
- Spell out what each flow does to the other devices.

This makes H2's fix mandatory.

### M4. Version 3 pins do not fit in the settings document

Identity-pq §2 says that "Comparing words writes a version 3 pin: all four public keys". In base64url that is 43 + 43 + 2603 + 1579 = 4268 characters per contact, before names and the other fields. Settings are capped at 64 KiB in both twins (`packages/crypto/src/contacts.ts:20`, `crates/hushos-core/src/contacts.rs:17`), and the sharing ledger and group pins share that space. After about a dozen contacts, saving fails with "Settings are too large.", and no new pin or ledger entry can be saved.

**Fix.** Pins keep SHA-256 digests of the ML-DSA and ML-KEM keys, as `kemPublicKeyHash` already does, and compare the served keys against them. Do the same for group pins (`firstMlDsaPublicKey`) and for any ML-DSA key added to roster entries.

### M5. The server can wipe the settings document, including the v3 pins and group marks the v2 gate protects

When the server serves a settings row as `settings: null` at the current sequence, the client reads it as an empty document, and its next save replaces everything (`apps/web/src/lib/contacts.ts:223-230`). That path existed for the three version 1 rows that Round 3 retired. None are left, so the path now serves only to let a hostile server erase:

- pins;
- the sharing ledger, after which rotations no longer seal shares again;
- group pins;
- area marks on a new device.

The rollback mark does not catch this, because the sequence number does not go down.

**Fix.** Treat a missing document at a sequence above 0 as Couldn't check, never as empty.

### M6. The rules don't say what a version 2 pin does with a version 1 identity, and the code would trust it

Identity-pq §2 (line 81) says that a pin from before the release trusts nothing "when the served identity is version 2". It does not say what happens when the server serves the stripped version 1 form: the same X25519 and Ed25519 keys, with no ML-DSA key.

Today `pinVerified` (`packages/crypto/src/pins.ts:14-29`) checks only the v2 fingerprint. `trustGrantee` accepts a KEM key on the strength of an Ed25519 binding by the pinned key (`apps/web/src/lib/contacts.ts:536-558`). So the server can keep every reader who hasn't compared words again on pre-release trust by serving version 1. That includes KEM keys vouched for only by Ed25519, which is the second attack in identity-pq's "Why, and what it fixes".

**Fix.**

- After the release, a version 2 pin trusts nothing, whatever is served.
- `pinVerified` requires the v3 fingerprint.
- `identityVerifyKem` stops being a path to trust.
- A v3 pin refuses a different ML-DSA key served beside the same X25519 and Ed25519 keys. The doc names only a missing one.

### M7. "A share opens again once its granter has signed in" is false

Identity-pq §3 (line 120) and envelope-migrations §4 (line 76) make this claim. Sealing a share again goes through `trustGrantee` (`packages/drive/src/client.ts:1039-1115`), which needs a verified pin of the grantee. The grantee then checks suite 4 against a v3 pin of the granter. Both pins are v2 at the release, so every existing share stays shut until granter and grantee have each compared words with the other.

**Fix.** That is acceptable while production holds mostly test accounts, but say it. In People, show "Shares from Maya open once you've both compared words."

### M8. Area self-grants skip the high-water check, and the conversion switch strands them

Envelope-migrations §5 checks an area grant once. After that, the self-grant opens like the personal grant, with no comparison against the area's high-water `workspaceKeyVersion` (groups-design 2.7).

**Attack.** A server can serve an older self-grant row from before a rotation. Together with the old root node envelope, the member then writes under a key that a removed member holds. That reopens M3 from the previous review.

**Fix.** Check the self-grant's `workspaceKeyVersion` against the mark every time it is opened, and use the area grant when the served version is higher.

There is a second gap. The conversion switch (envelope-migrations lines 120–126) wraps only the personal grant under the new root. Area self-grants stay wrapped under the old root, where the young adult cannot open them and the guardian can. So "Until then the child's self-grants keep the areas open" (line 132) is wrong. Wrap every `workspace_keys` row in the switch, as master-key rotation already must (`packages/db/src/auth.ts:918-942`).

### M9. Files written during the conversion's rotation depend on folder keys the guardian holds

Envelope-migrations line 130 says that "Uploads made meanwhile are written under the new key version". The threat model says new files don't open with the old keys (groups-threat-model line 100). But a file created in a folder the rotation has not reached yet is wrapped under that folder's old key, and later "rewrapped, keys unchanged" (drive-design, "What a rotation must visit"). A guardian who holds the old keys, and can get the server's copy of the envelope, reads that file.

**Fix.**

- During a conversion rotation, rotate a folder's ancestor chain before writing into it, or refuse writes below the rotation's frontier.
- Correct the threat model.

### M10. Pushes let any server locate a device, and the relay's budget can silence security notices

**Locating a device.** Every ping makes the device fetch `GET /api/notifications/:id` from its server. A server, or anyone who learns a handle, can wake a phone up to 60 times an hour and log its current IP address and network: an approximate location on demand. §7 "What the server learns" (line 218) leaves this out.

**Silencing notices.** Every kind of push shares the same per-handle budget, and anyone can trigger pings, because any user can share with any address. An attacker with the password and the mailbox can start the 72-hour wait and keep the budget spent, about 4,300 pings over the wait. The only push the owner would get, "72-hour wait started", is then dropped. The owner sees the notice only in the app, or in the email the attacker controls.

**Fix.**

- List device locating in §7 and in `docs/self-hosting.md`.
- Have the app show a visible notification for every ping it wakes for, unknown ids included, so silent probing becomes visible.
- Give security events their own relay budget, and coalesce the other pings on the server.

### M11. The five documents disagree in ways that matter

- **Approval on child accounts:** optional in devices-design (lines 8, 211 and 216), mandatory in envelope-migrations (line 148). See H7.
- **Child sign-up on the guardian's device:** allowed in groups-design (line 205), "not offered" in envelope-migrations (line 147).
- **Delay:** groups-design says a guardian "cannot block, delay or undo" conversion (line 211), but §7 adds a 7-day hold.
- **The device route:** `POST /api/auth/devices` takes `{ deviceKey, signature }` in groups-design (line 272) but `{ kind, name, signingPublicKey }` in devices-design §8. The approvals `POST` carries no signing key at all, though the code and the approver's list both need one.
- **The `groups` field:** groups-design 2.7 (line 130) says older clients keep `groups` as an unknown field. Envelope-migrations §2 makes them refuse the whole document.
- **Password changes:** envelope-migrations line 69 says "password changes rewrap the ML-DSA seed". A password change wraps nothing again, because the root does not change.
- **A wrong reference:** envelope-migrations line 17 cites "identity-pq-design.md 8" for the one-release decision. That section is "Out of scope"; the decision is §10.1.
- **Stale residual:** the groups threat model (line 56) still lists identity signatures as Ed25519-only.
- **Contradiction in 2.2:** groups-design 2.2 says that identity signatures that "sign writer statements" are hybrid, then that file and folder signatures stay Ed25519.

## Low

- **L1. The stated reason for not carrying pins forward contradicts identity-pq §7.** A carry-over signed with Ed25519 and verified now is as trustworthy as Ed25519 is now. It becomes forgeable only later, and a cutoff handles that, exactly as §7 argues for file signatures. Not carrying pins forward is a fair decision while production holds test accounts, but replace the reason given ("only Ed25519 could sign that carry-over") with this one.
- **L2. Identity marks don't see the upgrade.**
    - The mark for the person's own identity is a `keyVersion` (`apps/web/src/lib/contacts.ts:113-115`), and the upgrade keeps it. A server can serve a device the version 1 form, and a new device will then mint a second ML-DSA key that the server may accept. That splits the account between two keys: denial of service and confusion.
    - Fix: mark `(keyVersion, identityVersion)` and refuse version 1 once version 2 has been seen. Have an approving device pass its marks (identity, settings, rosters and areas) inside the sealed transfer, so new devices start with marks.
    - The device must compute its own words only from keys it re-derived from all four seeds.
- **L3. Rotation may still raise the identity's `keyVersion`** (`packages/db/src/auth.ts:878-892`). The keys statement binds `keyVersion`, so the identity would stop verifying. Refuse a changed `keyVersion` for version 2 identities.
- **L4. There is no escape from an unusable ML-DSA seed.** If an upgrade uploads a seed that doesn't open again (a bug, or the wrong associated data), the account can never sign again: version 1 successions are refused, and a version 2 succession needs the old hybrid signature. Before calling `/identity/upgrade`, the upgrading device should open the wrapped seed again and compare the public key. Also decide what recovers an account whose bad seed got through anyway.
- **L5. Never choose a statement version from a signature's length.** History rows hold both 64-byte and 3373-byte signatures, and a verifier that dispatches on length makes stripping possible again. Say that the version comes from context and that version 1 is refused.
- **L6. Approval details are missing.**
    - The phrase approval and the conversion request have no specified signed statement. Both should bind `userId`, the `requestId` or attempt, the new device's key and the envelopes' digests.
    - The number from 0 to 99 must be drawn without bias: 16 bits mod 100, or rejection sampling.
    - The guardian path under level 2 needs a code-checked transfer from the guardian's device.
- **L7. "A forged device signature lets nobody read anything"** (devices-design line 40) is false twice: at level 1, an approval releases the password envelope to whoever holds the password, and H1's automatic transfer hands over the root.
- **L8. Decrypted file names leave the app.**
    - Notification text goes into the operating system's notification stores and, on Android, to every app with notification access.
    - Unchecked senders get a free-text line on the lock screen.
    - Fix: by default, show no file name for unchecked senders. Use `VISIBILITY_PRIVATE` with a public version on Android, and `hiddenPreviewsBodyPlaceholder` on iOS.
    - Specify whether the web service worker ever opens the root. It should not.
- **L9. The relay.**
    - `DELETE /v1/register/:handle` is unauthenticated, so anyone with a handle can silence a device. Return a deletion secret with the handle.
    - The iOS fallback text is in the payload the relay builds. A compromised relay can put any words on every HushOS iPhone whose Notification Service Extension fails. On every failure, the extension should overwrite the text with a fixed string.
    - Use one handle per installation and server account, so servers cannot use handles to link a person across them.
    - "It never learns who the person is" goes too far: APNs and FCM tokens identify a device to Apple and Google.
- **L10. Moves between spaces.**
    - Decide each version's signature separately. An earlier version may be unverified when the current one is verified.
    - A record verified only through a group's roster becomes an ordinary personal signature by the mover, outside the group's scope. That is acceptable if the doc says so.
    - A move keeps content keys, so anyone who could open those versions before still can.
- **L11. Notices.**
    - Anyone with a session on a child account, including the guardian, can turn off notices of guardian activity. Make them fixed on child accounts.
    - These should also be security notices: password changes, phrase resets, recovery-key and master-key rotations, identity successions and policy changes.
- **L12. The signature cache in identity-pq §7** must also be keyed on the verifying public key. Otherwise a cached "verified" survives the server changing who it says signed.

## Checked and sound

- **Hybrid signatures.** Ed25519 || ML-DSA-65, with both halves required, is the standard AND combiner.
    - Neither half verifies alone under any other statement, because the domains differ.
    - The separate FIPS 204 contexts (`hushos/identity/v1`, `hushos/group/v1`) stop a group-key signature from standing in for an identity signature.
    - Letting the statement version select the hybrid form is sound wherever the verifier takes the version from context (with L5).
    - Hedged signing is right, and so are fixtures that check verification instead of bytes.
- **Share suite 4.** It is suite 3 with the hybrid signature.
    - The suite number sits in `info`, the associated data and the statement, so a truncated or relabelled envelope opens as nothing. Suite 3 is not opened at all.
    - Resistance to key-compromise impersonation, the salt over the ciphertext, the ephemeral key and the recipient's key, and checking the signature before decapsulating all carry over.
- **The keys statement.** It proves possession of both signing keys and binds them to `userId` and `keyVersion`. It is the only thing that ties keys to an account, since the words do not.
- **Fingerprint v3.**
    - Fixed-length fields follow a distinct prefix, so no two key sets share an encoding.
    - Classically, a second preimage on 132 bits costs 2^132, and 2^102 multi-target against 2^30 accounts.
    - Grover needs 2^66 sequential iterations of a circuit that must run ML-KEM and ML-DSA key generation, far past any depth limit. The multi-target quantum speed-up needs QRAM.
    - A classical collision at 2^66 buys nothing, because pins hold the keys, not the words.
- **The in-place upgrade.** Keeping the X25519, Ed25519 and ML-KEM keys and `keyVersion` means:
    - nothing sealed to the person needs sealing again;
    - file signatures keep verifying under the same Ed25519 key;
    - the retired-key logic and the history's primary key are untouched;
    - a race is settled by the first upload.

    Not carrying v2 pins forward is sufficient once M6 is closed.

- **Settings document v2.** The document version sits inside the AEAD, so only the person's own devices can write either form. Old web and Rust clients refuse a v2 document (`packages/crypto/src/contacts.ts:233`, `crates/hushos-core/src/contacts.rs:263`), so the gate fails closed as claimed, apart from M5.
- **Confidentiality of the device key transfer.** It uses X25519 plus ML-KEM-768 with suite 3's salt. The associated data binds `userId`, `requestId` and the root's `keyVersion`, so nothing replays across requests. Once C1 is fixed, authentication by short code depends only on the hash, so it is already post-quantum.
- **Level 1.** The description is accurate: a gate on the server that stops a password thief when the server is honest, and nothing when it is breached. One thing is missing: a breached server can also test password guesses offline against the OPAQUE record, so "together with the password" includes a guessed one. `finishLogin` returns the envelope today (`packages/auth/src/server.ts:432-444`), so level 1 has to hold it back there and in `startSecurityChange`.
- **Push payloads.** Only random event ids reach APNs, FCM and Web Push (RFC 8291). The text is written on the device.
- **Migrations.**
    - The `workspaces` backfill fails rather than guesses.
    - Moves copy before they trash, so a move never loses data.
    - Group versions change the statement, `info` and the associated data together.
    - Switching before rotating never leaves data under a root the server does not know, and the pending state is sealed on the converting device.

## Open questions

1. How does the iOS Notification Service Extension get the account key to write "Maya shared …"? Can it reach that key while the app is locked under level 2?
2. Under level 2, how does a device that a guardian approved for a child receive the root? A transfer from the guardian's device, checked by which code?
3. What approval level and policy does an account have after conversion? Does a level a guardian required lapse, and how do the signed-out devices enrol again under it?
4. Should adults get the conversion re-key as "Start over with new keys"? It is the only operation that evicts someone who once held the root, and level 2's wording implies such an operation exists.
5. Can an account's email be changed? H7's fix and the young adult's escape path depend on it.
6. Which ML-DSA implementations are pinned? The web and the server use `@noble/post-quantum` 0.7.1, and no RustCrypto `ml-dsa` version is in `crates/hushos-core/Cargo.toml` yet. Do the fixtures include FIPS 204 ACVP vectors for key generation from ξ, signing with a context, and refusing malformed hints?
