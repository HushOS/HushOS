# Groups: threat model

This document attacks the group core in `docs/groups-design.md` and the company extensions in the build plan ("HushOS for Companies — Build Plan"). For each adversary it says what they want, what stops them, and what stays possible. It is part of Phase A's design gate: building starts when its open decisions (section 7) are settled and the design is changed where it says so.

The standard is the one the rest of HushOS holds itself to: a server that turns hostile must not learn file contents, names or keys, and must not be able to make a member trust something false without a warning.

## 1. What is protected

| Asset                                            | Who may have it                                                              |
| ------------------------------------------------ | ---------------------------------------------------------------------------- |
| File contents, names and metadata in group areas | Members granted the area; for companies, data admins through the custody key |
| Area keys and node keys                          | The same                                                                     |
| The group signing key                            | Members holding `members` (the organizer in a family)                        |
| Account root and identity keys                   | Only the person's devices                                                    |
| Personal spaces                                  | Only their owner, whatever groups they belong to                             |
| The truth of who wrote what                      | Readers, through signatures, pins and the roster                             |
| The truth of who is in a group                   | Readers, through the signed roster                                           |
| Availability of files and storage                | Members, within the plan                                                     |

## 2. Adversaries

| Adversary                                                         | Can                                                                                                 | Wants                                                                                        |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **Hostile server** (a breach, a rogue operator, a compelled host) | Read and change everything stored and sent; serve different data to different people; withhold data | Contents, keys, or a false trust: an attacker's key treated as a member's                    |
| **Network attacker**                                              | See and change traffic outside TLS, or with a mis-issued certificate                                | The same as the server, from outside                                                         |
| **Malicious member**                                              | Everything their grants allow; social engineering inside the group                                  | Files they were not granted, planting files that look like a colleague's, exhausting storage |
| **Former member**                                                 | Their old keys, caches and anything they downloaded                                                 | Continued access, or writes that look current                                                |
| **Compromised device**                                            | Everything its owner can do while unlocked                                                          | The owner's keys and files, and through them the owner's groups                              |
| **Abusive organizer or payer** (families)                         | Remove members, dissolve the family, see the bill                                                   | Control over members, or their private files                                                 |
| **Compromised admin** (companies)                                 | Custody key, admin browse, admissions                                                               | Every company file, or admitting an attacker                                                 |
| **Outside parties** (companies, later)                            | A customer's own bucket, a custom domain's DNS, an identity provider                                | Tampering, interception, sign-ins                                                            |

## 3. The group core

### 3.1 Joining

| Threat                                                                       | Stopped by                                                                                              | What remains                                                                                                                     |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| The server gives a newcomer a fake group key, then fake rosters signed by it | The newcomer checks the group key's words with the admitting admin before pinning it                    | A newcomer who skips or rushes the check; the check is mandatory in the flow, and the UI must make "they match" a deliberate act |
| The server swaps the newcomer's keys so the admin admits an attacker key     | The admin checks the newcomer's words, read from the newcomer's own screen                              | The same human risk; checking over a call the server cannot alter (in person, or a call on another service) is the guidance      |
| An invitation link is stolen (forwarded email, shoulder-surfing)             | Acceptance binds to the signed-in account, and nothing opens until an admin admits after the word check | A thief can file an acceptance under their own account; the admin sees an unexpected name and an unchecked person                |
| An invitation is sent to a wrong or hostile address                          | The same admission gate                                                                                 | Social engineering of the admin during the check                                                                                 |
| Join-request spam from a verified company domain                             | Requests take no seat and open nothing; rate limits per domain and address                              | Admin queue noise                                                                                                                |

### 3.2 The roster

| Threat                                                                                                 | Stopped by                                                                                                                                        | What remains                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The server forges a roster or edits an entry                                                           | Every roster is signed by the group key, which the server never holds                                                                             | None without a holder's key                                                                                                                                                                                                                                                                                                                                                                 |
| The server replays an older roster (a removed member back in)                                          | Each device keeps the highest roster version it has seen, synced across the person's devices through settings                                     | A member or device that never saw the newer roster, see the next row                                                                                                                                                                                                                                                                                                                        |
| The server shows different members different rosters, or withholds the newest from some (equivocation) | Signatures stop invented rosters; high-water marks stop going back                                                                                | **Residual:** colluding with a former member, the server can delay some members learning of a removal, during which that member's planted writes still read as verified to them. Area keys rotate on removal and the server refuses the former member's writes, so this needs the server's active help. Rosters are chained (section 7), so a fork a member ever sees raises a hard warning |
| A roster names keys the member never had                                                               | The admin's client signs entries from the served identity it checked, and the server refuses entries that differ from a member's current identity | None beyond the join check                                                                                                                                                                                                                                                                                                                                                                  |

### 3.3 The group key

| Threat                                          | Stopped by                                                                                                                        | What remains                                                                                                                                    |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| A holder's device is compromised                | Every roster the attacker signs is visible to all members; removing the holder forces a key succession                            | Until noticed, the attacker can sign rosters that add their own key. Companies should keep `members` to few people; families have one organizer |
| A removed holder keeps the old key              | Removal requires a succession signed by a remaining holder; clients accept rosters only under the newest key they can reach       | The old key still verifies old rosters, which is correct                                                                                        |
| The server hides a succession from some members | They keep verifying under the old key until they see it; the old holder cannot get new rosters accepted by members who did see it | The same equivocation window as 3.2                                                                                                             |

### 3.4 Area grants and keys

| Threat                                                                                       | Stopped by                                                                                                                 | What remains                                                                                       |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| The server grants an area key to an attacker key                                             | A grant is sealed by a member's client, signed by them, and bound to the grantee's key version; the server cannot seal one | None without a member's key                                                                        |
| The server hands a member a grant to a fake area under an attacker's key, to collect uploads | The grantee opens a grant only from a granter it trusts (personally checked, or on a verified roster)                      | A malicious member can make a real area and invite people into it, which is what membership allows |
| An old grant is replayed after a rotation                                                    | Grants bind the workspace key version; clients use the newest version they have seen                                       | None                                                                                               |

### 3.5 Leaving and removal

| Threat                                                           | Stopped by                                                                              | What remains                                                                                                                                                   |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A former member keeps reading                                    | The server stops serving them at once; the next opener rotates the area keys            | **Residual:** everything they downloaded or cached before leaving stays with them; nothing can claw that back                                                  |
| A former member reads files added after they left, with old keys | New files sit under rotated keys                                                        | A rotation not yet run: download URLs are short-lived (15 minutes for shares; companies cut members to 15 minutes too), and the server refuses them regardless |
| A former member's earlier work is used to impersonate them later | Their entry stays as `left`; their signatures read as "who has left", never as verified | A signature carries no trustworthy date, so old and planted work look alike; the label says exactly that                                                       |

### 3.6 Families: the organizer and the pool

| Threat                                                                | Stopped by                                                                                                       | What remains                                                                                    |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| The organizer reads an adult member's personal space                  | The organizer holds no key to any personal space; personal spaces are never in the group's key graph             | None                                                                                            |
| The organizer reads family folders                                    | They are a member like any other                                                                                 | By design                                                                                       |
| The organizer removes a member or dissolves the family to coerce them | A removed member keeps their personal space and files; dissolving gives 30 days' notice before family folders go | Loss of family folders and pooled storage. Members are told what they would lose before joining |
| The organizer watches a member's activity through storage numbers     | The organizer sees the pool's total and who is at their cap, never each member's usage                           | None                                                                                            |
| One member fills the pool                                             | Optional per-member caps; uploads stop, nothing is deleted                                                       | Annoyance until the organizer acts                                                              |

### 3.7 Child accounts

| Threat                                                    | Stopped by                                                                                                                                                                    | What remains                                                                                                                             |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| The server becomes a "guardian" to collect a child's root | The child's device seals only to guardians on a roster it verified after checking the family's words at sign-up                                                               | A rushed check, as for any join                                                                                                          |
| A guardian reads quietly                                  | A permanent notice on the child's account and a record of every guardian session, taken from the seal fetches the server observes                                             | A guardian keeps what they read                                                                                                          |
| An abuser makes an adult a "child" to read them           | Only new accounts can be child accounts, `adult_from` must fall within five years, the notice never goes away, and conversion is the account holder's alone from `adult_from` | **Residual:** an adult deceived into signing up as a child is readable until `adult_from`, under the notice. The five-year limit caps it |
| A young adult stays readable after 18 without meaning to  | They are prompted on `adult_from`, and the notice says how to convert                                                                                                         | **Residual:** access continues until they convert, by the owner's choice. Converting cannot be blocked                                   |
| A guardian keeps access after conversion or release       | Conversion replaces the account root in the same transaction that deletes the seals; after an early release the child's device replaces it on next sign-in                    | Anything the guardian read or copied before                                                                                              |
| A child shares family files publicly                      | No public links and no outside shares by default, enforced by the server                                                                                                      | What a reader can always copy                                                                                                            |

### 3.8 Spaces on each device

| Threat                                                                         | Stopped by                                                                                                                          | What remains                                                                |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Files from one space leak into another (the iOS Files bug class of 13 October) | Each space has its own owner-tied Files location and provider root, its own local state, and its own ids derived from its workspace | A client bug; the owner checks and wipe-on-leave rules are tested per space |
| A left space's data stays on a device                                          | Leaving wipes its local state on every device the next time each comes online                                                       | A device that never comes back online keeps what it had                     |

### 3.9 What the server learns

Who is in which group and with what capabilities, who invited and admitted whom and when, invitation addresses until used, area counts and padded sizes, group names, and when rosters change. It does not learn names of files or folders, contents, keys, or which members opened what beyond the fetches it serves. This is the price of authorising anything; the security page states it.

## 4. Company extensions

| Area          | Threat                                                            | Stopped by                                                                                                        | What remains                                                                                               |
| ------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Custody key   | Its private half is stolen from an admin                          | Two-person rules for adding admins and recovery (48-hour delay with one admin); rotation when an admin is removed | A stolen custody key opens every company area until rotated. Few data admins, devices with a second factor |
| Admin browse  | An admin reads quietly                                            | Disclosed on every company area; recorded from fetches the server observes, not from the admin's client           | An admin can keep what they read                                                                           |
| Recovery kit  | The offline kit is stolen                                         | It is a custody secret: stored offline, used only under two-person rules                                          | Physical security of the kit is the company's                                                              |
| Policies      | Someone shares out against policy                                 | The server refuses shares and links that break policy                                                             | Anyone who can open a file can copy it; no policy prevents that                                            |
| Own bucket    | The bucket owner tampers with objects                             | Every object is authenticated; tampering fails to open                                                            | Deleting or withholding objects is an availability loss HushOS cannot prevent                              |
| Custom domain | The domain's DNS owner points it elsewhere and gets a certificate | Named plainly at setup: the DNS owner can intercept                                                               | Inherent to custom domains; subdomains of hushos.com avoid it                                              |
| SSO           | The identity provider is compromised                              | It can sign someone in but cannot unlock keys; no admin approval of devices                                       | An attacker signed in as a member still needs that member's passkey or another device to open anything     |
| SCIM          | Provisioning adds an attacker                                     | Additions file join requests only; admission still needs the word check                                           | Admin queue noise                                                                                          |

## 5. Assumptions

- Members check words honestly and over a channel the server cannot alter; the flows make the check unavoidable but cannot make it careful.
- Devices are not compromised while in use; a compromised device is its owner, with everything that implies.
- TLS and the web origin deliver the real HushOS code. Like any end-to-end encrypted web app, a server that serves altered code can read what is typed into it; the native apps and self-hosting are the answers for anyone who cannot accept that.
- X25519, ML-KEM-768, Ed25519, XChaCha20-Poly1305, SHA-256 and Argon2id hold.

## 6. Out of scope

Copying out by anyone who can read a file; traffic analysis of when people are active; denial of service by the host; a member's legal obligations to their family or employer.

## 7. Decisions this threat model raised

All four agreed on 14 October; the first three are written into `docs/groups-design.md`, the fourth belongs to the company release.

1. **Chain the roster.** Add the previous roster's digest to each roster statement (`["hushos/group/roster",1,groupId,kind,rosterVersion,previousRosterDigest,groupKeyVersion,members]`). A client that ever sees two rosters with the same version and different contents, or a gap it cannot verify, raises a hard warning. It does not close the withholding window in 3.2 but makes a fork evidence instead of silence. Agreed: in the spec's roster statement.
2. **What the organizer sees of members' storage.** Agreed: the pool's total, and which members are at their cap, but not each member's usage, which would show how active they are.
3. **Word-check guidance.** Agreed: the join screen says to compare words in person or on a call through another service, never in a message sent through HushOS, and the admit button stays disabled until both sides confirm.
4. **`members` holders in companies.** Agreed: warn when more than three people hold `members`, since each can sign rosters.
