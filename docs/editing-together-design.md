# Editing together: live, end-to-end encrypted collaboration

This document fixes how several people edit one file at the same time in HushOS, seeing each other's changes and cursors as they type, without the server or the relay reading a keystroke. It builds on `docs/editing-design.md` (the single-person editors, sessions, drafts and the `versionOf`/`amends` save), `docs/drive-design.md` (node keys, versions, shares and rotation), `docs/integrity-design.md` and `docs/identity-pq-design.md` (who signed what, and how it is judged), `docs/groups-design.md` (family folders and removal) and `docs/devices-design.md` (devices and their keys). Implementation comes after editing milestone 1 and File tools (`docs/file-tools-design.md`, written in parallel); nothing here changes either.

Like the editors, everything happens on devices. The server issues tickets and stores the versions a session saves, as it stores any upload. The relay forwards ciphertext between the people in a document and stores nothing. Neither ever holds a key that opens an update, a cursor or a name.

## Decisions

Settled with the owner (2026-10-19):

- **CRDT:** Yjs on the web; yrs, its binary-compatible Rust port, in the native core for iOS and Android, so updates pass between clients unchanged. Merging happens only on devices.
- **Transport:** WebSocket now, with the frame format kept independent of the transport so WebTransport can come later. WebTransport support in Bun and behind Cloudflare is unclear, the native apps have none, Yjs providers are built for WebSocket, and for text the gain is small.
- **The relay** is a standalone Bun + Elysia WebSocket server (Bun's uWebSockets-backed sockets) in its own process and container: `relay.hushos.com` for the hosted service, and a Compose service for self-hosters. It reuses `@hushos/auth` for tickets and `@hushos/logging`, but runs outside the web app's Nitro server, so it scales and restarts on its own. It forwards only ciphertext per document room and stores nothing. Its wire format is language-neutral, so a Rust relay could replace it later.
- **Self-hosters run their own relay or use ours.** Either way the relay authenticates with short-lived tickets signed by the HushOS server, checked against that server's public key at a well-known HTTPS path. hushos.com uses the same mechanism, so there is one code path.
- **Live cursors are required:** Yjs awareness (presence, cursor and selection), encrypted the same way as updates.
- **Editors:** CodeMirror 6 with `y-codemirror.next` for text, Markdown and code files; Lexical with `@lexical/yjs` for notes and documents.
- **Notes and documents get a native format, `.hdoc`** (section 6): Lexical's serialized JSON in a versioned envelope, not Yjs updates.

Decided in this note, for the owner to confirm or overturn (the open questions in section 15 are the ones it could not decide):

- A **random session key per generation**, sealed to each participant device's ephemeral keys, never derived from the node key (section 2). A **lobby key** derived from the node key proves that a joiner holds the file's current key.
- **One host per session**, the editor with the lowest certificate hash present: it admits joiners, rekeys on every join and departure, and saves.
- **A session saves itself** while two or more editors are in it, as one version amended in place, with the amend rule widened to every account in the session (section 5). No Yjs update or state is stored anywhere in this milestone.
- **No editing together over links**, not even watching (section 9).
- **Rooms are named by an opaque id** the server derives with a secret, never the node id (section 7).

## Scope

In this milestone: text files the milestone 1 editor edits (section 1 of `docs/editing-design.md`: UTF-8 and UTF-16 with their BOMs, up to 8 MiB), including Markdown with its preview and CSV or TSV through the Text tab and the Table tab (section 5); `.hdoc` documents once Notes and documents ship; personal folders, shares to accounts and family folders.

Not in it: images (an image edit is a set of operations on pixels, and two people cropping at once is not a feature anyone needs); office documents (the ONLYOFFICE track); per-character authorship ("who wrote this line"); comments and suggestions; voice or video. Phones join after editing milestone 5 gives them editors at all.

## 1. Threat model

The standard is the one the rest of HushOS holds: a server or relay that turns hostile must not learn contents, names or keys, and must not be able to make anyone trust something false without a warning.

### Who is in the picture

| Party                    | Can                                                                                                                                                 | Wants                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| A malicious relay        | See every connection, its IP address and timing; read, drop, delay, reorder, replay, duplicate and inject frames; show each person a different room | Read edits, put words in someone's mouth, split people apart |
| A malicious server       | Everything the relay can if it runs the relay too; mint tickets for anyone; serve any identity, version, share or roster; serve the web app's code  | The same, plus a way into the room                           |
| A removed collaborator   | Keys they held while they had access (node keys, and on a device they kept, the account's); an old ticket                                           | Keep reading, or keep writing, after losing access           |
| A compromised device     | Everything its account can open, while it runs                                                                                                      | Read and write as that person                                |
| A malicious collaborator | Everything a participant can, honestly obtained                                                                                                     | Write as someone else, fork the document, shut others out    |

The relay and the server are separate parties. For a self-hoster using `relay.hushos.com`, the relay is HushOS (the company) and the server is the self-hoster; for hushos.com both are HushOS. The design never relies on the relay being honest, and relies on the server only where Drive already does (roles, revocation before a rotation, the web app's code).

### What is protected

- **Contents, cursors, selections and who is typing what** are readable only by devices holding the session key, which only a device holding the file's current node key can obtain (section 2). Neither the relay nor the server holds either.
- **Authorship of live changes.** Every frame is signed by a session key that the sender's identity certified, so a participant cannot send changes as another, and the relay or server cannot send any. A frame's Yjs items must carry the sender's own Yjs client id, so even a participant cannot insert text attributed to someone else's client.
- **Replay, reorder and injection.** A frame is accepted once, in order per sender, only for the session and generation it was sealed for (section 3). Dropped frames are detected and healed from other participants.
- **A removed person is cut off from future updates** by the host's rekey as soon as their departure is seen, by the server refusing their ticket within five minutes, and cryptographically once the Drive rotation that removal starts reaches the file (section 2).
- **Names** shown beside cursors come from the viewer's own trust (checked contacts, a family that vouches), never from anything a participant or the server says alone (section 4).
- **What a session saves** is a normal version: sealed, padded, signed by the account that saved it, checked by every reader as today.

### What is not protected

- **Metadata the relay sees:** who is connected to which opaque room, from which IP address, when they join and leave, when they type (in bursts, not keystrokes), how much they send (in padded buckets), and which server they come from (section 7).
- **A malicious server together with a removed collaborator** who still holds the file's current node key can let them back into the room until the rotation reaches the file. That is Drive's guarantee unchanged: revocation stops an honest server, rotation shuts the door.
- **A removed device** keeps the keys it held (`docs/devices-design.md` 1). Removing a device rotates nothing, so with a malicious server it can join rooms for files whose keys it held until each is rotated.
- **A compromised device** reads and writes as its account. Its writes are attributable to that account, which is all signatures can offer.
- **A malicious collaborator** can write anything under their own name, fork the document between participants (detected, not prevented), shut others out while hosting (a denial), and replace the session's saved version (section 5). These are an editor's powers in Drive already.
- **The web app's code** comes from the server. A server that serves hostile code reads everything a browser opens (`docs/groups-threat-model.md` 5). The phones do not have this residual.
- **A full partition.** A relay that never lets any frame cross between two groups of participants keeps each group unaware of the other until a save goes stale (section 3).

## 2. Sessions and keys

### Terms

- **Room:** one per file node, named by an opaque `roomId` (section 7). Every device editing or watching the file connects to it.
- **Session:** a shared Yjs document grown from one base version of the file. `sessionId` names it. A room holds at most one live session; two that meet resolve as in section 3.
- **Participant:** one device's join to a session, with its own ephemeral keys and certificate. The same person in two tabs is two participants.
- **Generation:** a numbered session key. The host makes a new one on every join and departure, so a key never covers anyone it was not sealed to.
- **Host:** the participant that admits joiners, makes generations and saves.

### The session certificate

When a device opens a file for editing together, its worker makes fresh keys for that join alone, kept in memory and never stored:

- an Ed25519 signing key, which signs every frame the participant sends;
- an X25519 key and an ML-KEM-768 key, to which the host seals session keys;
- a Yjs client id (random `u32`, not equal to the session's seed client id, section 5).

The account's identity certifies them with its hybrid signature (`docs/identity-pq-design.md` 1, Ed25519 plus ML-DSA-65, 3373 bytes):

```
["hushos/collab/cert",1,userId,identityKeyVersion,workspaceId,nodeId,roomId,deviceId,
 yjsClientId,ed25519SessionPublicKey,x25519SessionPublicKey,sha256(kemSessionPublicKey),notBefore,notAfter]

certHash = SHA-256(utf8(statement)), base64url
```

Canonical JSON as for associated data: lowercase ids, keys base64url without padding, times in whole seconds, `notAfter - notBefore` at most 24 hours. The certificate decides which keys speak for a person in the room, so by the rule in `docs/identity-pq-design.md` it is hybrid. Frames are Ed25519 under the certified session key: one ML-DSA signature per join (about 16 ms) and one ML-DSA verification per peer (about 2 ms), never one per keystroke. That is the per-session ephemeral key the brief asked for, and it keeps the post-quantum cost off the typing path. A session longer than 24 hours re-joins with a new certificate.

`deviceId` is the server's `account_devices` id, a label for display and diagnostics, never trusted. `identityKeyVersion` lets a reader find the right identity after a succession; a certificate under a retired key reads `retired-key` and gets no session key.

### Joining: the lobby key proves access

Joining is a message sealed under a key derived from the file's current node key:

```
lobbyKey = HKDF-SHA256(ikm = nodeKey, salt = 32 zero bytes, info = "hushos/collab/lobby/v1", 32)
aad      = ["hushos/collab/lobby",1,roomId,workspaceId,nodeId,keyEpoch,type]          // type "join" or "rekey"
sealed   = nonce (24, random) || XChaCha20-Poly1305(message, lobbyKey, nonce, aad)
join     = { cert, identitySignature, ticket, openedVersionId }
```

Opening it proves the joiner held the node key at `keyEpoch`: someone the owner, a share or a family gave the file to, or a device that kept such a key. The server and the relay hold no node key, so neither can join, read a join, or forge one. The join also hides who is joining from the relay. `ticket` is the server's ticket for this certificate (section 7), which peers check too, so the role the server granted reaches every participant without the relay seeing it.

### The session key, per generation

The host makes a random 32-byte session key for each generation and seals it to every participant in it, with the share suite 4 construction (`docs/identity-pq-design.md` 3) under its own labels and no long-term key:

```
eph            = random X25519 key pair
(kemCt, kemSs) = ML-KEM-768.Encaps(recipientKemSessionPublicKey)
dh             = X25519(eph.private, recipientX25519SessionPublicKey)        // refused when all zero
key            = HKDF-SHA256(salt = SHA-256(kemCt || eph.public || recipientX25519SessionPublicKey),
                             ikm = dh || kemSs, info = "hushos/collab/session-key/v1", 32)
aad            = ["hushos/collab/session-key",1,roomId,sessionId,generation,hostCertHash,recipientCertHash]
seal           = eph.public (32) || kemCt (1088) || nonce (24) || XChaCha20-Poly1305(sessionKey, key, nonce, aad) (48)
```

The host sends all seals in one **rekey** message, sealed under the lobby key (type `"rekey"`) so the relay does not see who is in the session:

```
rekey     = { sessionId, baseVersionId, savedVersionId, generation, keyEpoch, hostCertHash, members, seals, signature }
members   = the generation's participants: [{ certHash, role }] sorted by certHash
signature = Ed25519(hostSessionSigningKey, utf8(["hushos/collab/sig/rekey",1,roomId,sessionId,generation,keyEpoch,
                    hostCertHash,sha256(canonical members),sha256(concatenated seals in members order)]))
```

`members` is the end-to-end view of who is in the session. The presence list a person sees is drawn from it, never from the relay's notices of connections.

**Before sealing to a joiner, the host checks**: the join opened under the lobby key at the node's current epoch; the identity signature holds under the served identity at `identityKeyVersion` (a pin is not required, see section 4; a key conflict, a retired key or a signature that fails gets no seal); the certificate names this room, node and workspace, has not expired, and its Yjs client id is not already in use in the session; the ticket verifies under the server's key, names this room and this `certHash`, and has not expired (section 7).

**Why not derive the session key from the node key.** It would be simpler (no host, no seals), and a removed person would still be cut off by the rotation. But anyone who later holds the node key at the same epoch could open a recording of the room: a share granted next month, or a link made later, which carries the node key to anyone with the URL. The live stream holds what a saved version never does: text typed and deleted before a save, a password pasted by mistake. A random key per generation, sealed to ephemeral keys, keeps a recording unreadable to everyone who was not in that generation.

**Why not MLS (RFC 9420).** It does what this section does and more (tree-based rekeying, efficient for large groups). But it needs a delivery service that orders commits, which this relay deliberately is not; a post-quantum ciphersuite is not standardised; its TypeScript implementations are young; and membership here is already decided by Drive (who holds the node key) and the server (who gets a ticket), so MLS's own membership machinery would be a second source of truth. Sessions are small (section 7 caps them at 25), so sealing to each participant costs about 1.2 KB each. Revisit if sessions grow.

### The host

The host is the editor in the current generation's `members` with the lowest `certHash`. Viewers never host. Certificate hashes are random per join, so no one hosts by right.

- A device opening the file waits up to three seconds for a rekey that includes it. With none, it seeds a session from the version it opened (section 5) and hosts generation 1.
- When a join arrives, the host checks it and sends generation `g + 1` including the joiner. When a participant leaves, the host sends `g + 1` without them.
- When the host leaves, the next editor by `certHash` takes over: it waits five seconds for a rekey from anyone with a lower hash, then sends `g + 1` itself.
- Two rekeys at the same generation (a race, or a relay that showed each side something different): the one from the lower `hostCertHash` wins, every participant switches to it, and the loser sends nothing more under its own.
- A participant accepts a rekey only from an editor in its current generation's `members`, at a generation above its own, for the session it is in. A joiner accepts the first rekey that includes it.

### Rekeying and cutting someone off

A new generation is made on every join, every departure, every hour and after any sender's sequence passes 2^20. Departure is a `leave` frame, the relay's notice that the connection closed, or 60 seconds without a frame from the participant.

A person who loses access (a share revoked, a family removal, a device signed out) is cut off in three layers:

1. **The peers.** When the revoking device is in the session, it knows whom it revoked and its client sends, or asks the host for, a generation without every certificate of that account at once. Otherwise the relay closing their connection, or their silence, triggers the departure rekey. From the next generation on, the removed device opens nothing.
2. **The server.** Tickets last five minutes and are refreshed every four (section 7). The server refuses a ticket to someone the walk no longer authorises, and the relay closes a connection whose ticket expired. An honest server therefore removes them within five minutes, whatever their device does.
3. **The keys.** Revocation starts a Drive rotation (`docs/drive-design.md`, "Revocation stops the server; rotation shuts the door"); a family removal carries every area's rotation (`docs/groups-design.md` 3.3). When a participant sees the file's `keyEpoch` advance (in the feed or a refused write), it sends a fresh join sealed under the new epoch's lobby key. Sixty seconds later the host makes a generation of only those who did. Someone who never held the new node key cannot make that join, whatever the server does.

Against an honest server, layers 1 and 2 hold. Against a malicious server working with the removed person, only layer 3 does, and only from when the rotation reaches the file: Drive's guarantee, and the first residual.

## 3. Frames

### Two layers

Every WebSocket binary message is one **relay message**: a small header the relay reads, and an opaque body it forwards. The body is what participants seal and open. Section 7 gives the relay layer; this section gives the body.

```
body = version (u8 = 1) || type (u8) || ...
  type 1, lobby:   nonce (24) || ciphertext                     // a join or a rekey, under the lobby key
  type 2, frame:   generation (u32be) || senderTag (16) || seq (u64be) || ciphertext
```

`senderTag` is the first 16 bytes of the sender's `certHash`. The relay sees the generation, a per-join random tag and a counter: nothing it does not already learn from connections and timing.

### A sealed frame

```
frameKey  = HKDF-SHA256(ikm = sessionKey, salt = 32 zero bytes,
                        info = utf8(["hushos/collab/frame-key",1,generation,senderCertHash]), 32)
nonce     = 16 zero bytes || u64be(seq)
aad       = utf8(["hushos/collab/frame",1,roomId,sessionId,baseVersionId,generation,senderCertHash,seq])
plaintext = kind (u8) || fragmentIndex (u16be) || fragmentCount (u16be) || payloadLength (u32be)
            || signature (64) || payload || zero padding
signature = Ed25519(senderSessionSigningKey, utf8(["hushos/collab/sig/frame",1,roomId,sessionId,baseVersionId,
                    generation,senderCertHash,seq,kind,fragmentIndex,fragmentCount,sha256(payload)]))
ciphertext = XChaCha20-Poly1305(plaintext, frameKey, nonce, aad)
```

- **Nonces never repeat.** Each sender has its own key per generation, and its `seq` starts at 1 and only rises. Session keys live only in memory: a crashed or reloaded device joins again with new keys, so no counter is ever restored from storage, which is where counter nonces usually fail.
- **The associated data binds** the room, the session, the base version the session grew from, the generation, the sender and the sequence. A frame cannot be moved to another document, another session (another base), another generation or another sender's stream.
- **The signature is inside the ciphertext**, so the relay cannot even tell whose session key signed a frame. It is needed because every participant can derive every sender's frame key: the AEAD proves a frame came from someone in the generation, the signature says who.
- **Kinds:** `update` (a Yjs update), `awareness` (section 4), `sync-request` (a state vector), `sync-reply` (the update a state vector is missing), `snapshot` (the whole state, to a joiner), `heartbeat` (section 3, split views), `saved` (section 5), `leave`, and `noise` (section 3, timing).
- **Fragments.** A payload above 192 KiB is split into fragments of at most 192 KiB, each its own frame with consecutive `seq`, reassembled before it is applied. A whole payload is at most 12 MiB (an 8 MiB file's state with room for the Yjs encoding).
- Within a generation `seq` stays below 2^32; past 2^20 the host rekeys anyway.

### Who wrote what

A receiver accepts a frame only when, in order: its generation is one it holds; the AEAD opens; the signature verifies under the certified session key of the participant `senderCertHash` names, and that participant is in the generation's `members`; and the kind is allowed for the participant's role (a viewer sends `awareness`, `sync-request`, `heartbeat`, `leave` and `noise`, never `update`, `sync-reply`, `snapshot` or `saved`).

For an `update`, every item the update inserts must carry the sender's certified Yjs client id (deletions may name any item; that is what deleting another person's text is). The receiver decodes the update without applying it (`Y.decodeUpdate`; yrs `Update::decode_v1`) and refuses it otherwise. Without this a participant could write items under another person's client id, which misattributes text and, if the clock collides with that person's next real item, makes the copies diverge.

`sync-reply` and `snapshot` necessarily carry everyone's items: they are how a joiner and a participant who missed frames catch up. They are attributable only to the participant who sent them. So the protocol proves who sent each frame, not who typed each character; the saved version is signed by whoever saved it (section 5), and there is no per-character authorship in this milestone.

### Order, replay and loss

- **Replay:** per generation and sender, a frame whose `seq` is at or below the highest accepted is dropped. Yjs would ignore a replayed update anyway; the rule matters for awareness, where an old cursor must not come back.
- **Reorder:** a frame that arrives after a later one from the same sender is a frame at or below the highest, and is dropped. What it carried comes back through sync.
- **Loss:** a gap in `seq` means frames went missing. The receiver sends a `sync-request` with its state vector; any editor answers with a `sync-reply` of what is missing. Every heartbeat (below) does the same comparison, so a relay that drops silently is healed within one heartbeat, and one that drops persistently is shown ("Some changes aren't reaching you. Reconnecting.") and the connection is restarted.
- **Old generations:** frames of generation `g - 1` are accepted for 30 seconds after switching to `g`, for frames already in flight; then they are refused.

### Catching up

A joiner gets the session from the host: the rekey that includes it, then a `snapshot` (Yjs `encodeStateAsUpdate` of the host's document, garbage-collected, so deleted text is not in it), sent directly. It applies the snapshot, sends a `sync-request`, and is live. It never replays earlier frames: those are under generations it was never given, by design.

The snapshot comes from a participant, so it is that participant's word. A malicious host can hand a joiner a different document; the heartbeats below show it as a fork.

With no peers present, there is nothing to catch up with: the device seeds a session from the current version (section 5).

### Split views and forks

Every participant sends a `heartbeat` every 20 seconds: its state vector, SHA-256 of its document's content (the text for a text file, the canonical Lexical JSON for `.hdoc`), the digest of the `members` it holds, and the node's `keyEpoch` as it knows it.

- **Different `members` digests** for the same generation: someone was shown a different session. The rekey rule above settles which wins; until it does, the editor shows "Not everyone may be seeing the same changes".
- **Equal state vectors, different content:** the copies have forked, which a CRDT cannot do on its own; a participant forged items. The editor stops sending, shows "Copies of this file don't match. Save a copy, then reopen it.", and offers Save as a copy (milestone 1's action).
- **Different epochs:** the participant behind fetches the node and re-joins under the new lobby key.

**Two sessions in one room** (each side seeded alone because the relay hid the other, or two sides of a partition) meet when a rekey or heartbeat crosses. They never merge Yjs state: a text session seeded from a different base, or an `.hdoc` session seeded by another device, shares no history, and merging would duplicate the document. The session whose `savedVersionId` is the node's current version (asked of the server) wins; with neither current, the one with the lower host `certHash`. The other side's participants re-join the winner and bring their unsaved changes as a patch (section 5).

A relay that never lets any frame cross keeps a partition unseen until one side's save is refused as stale. That is the full-partition residual.

### Size and timing

- **Padding.** The plaintext is padded with zeros to 256 bytes, or above that to its Padmé length (`docs/integrity-design.md` 1), so the relay learns a frame's size within a bucket.
- **A fixed tick.** A participant sends at most one frame per 100 ms tick, coalescing everything that happened in it. While its person is typing (an edit in the last three seconds) it sends one every tick, a `noise` frame when nothing changed, so the relay sees that someone is typing but not the rhythm of their keys. Inter-keystroke timing is a known way to recover typed text; bursts, and how much was typed, remain visible.
- An idle participant sends only heartbeats.

## 4. Presence and live cursors

Awareness is a frame like any other (`kind = awareness`), sealed, signed, padded and ticked the same way. Its payload is a small JSON state, never Yjs's own awareness encoding with a free-form user object:

```
{ "cursor": { "anchor": relativePosition, "head": relativePosition } | null, "state": "active" | "idle" | "viewing" }
```

Positions are Yjs relative positions (base64url of `Y.encodeRelativePosition`; yrs `StickyIndex`), so a cursor stays on its character while others type. There is no name, no colour and no picture in it: what a participant says about itself is not shown.

### Names

Each device names a participant from the certificate's `userId` and its own trust, exactly as it names a record's writer (`docs/integrity-design.md`, round 3, "Who sees whom"; `docs/groups-design.md` 2.8):

- **You** for one's own other participants ("You, on another device").
- **A checked contact:** the name from their pin.
- **Inside a family folder, an active member the family vouches for:** their name, with "Verified by Lindqvist family" in the person's details.
- **Anyone else** (a co-grantee nobody has checked, a former member): the name the server supplies (`POST /api/collab/people`, section 11) with their email beside it, per DESIGN.md ("Maya Lindqvist, maya@example.com"), and the details say HushOS hasn't checked them. They can still edit: who may edit is the file's owner's decision, and a grantee cannot be expected to have checked every other grantee.

A participant whose certificate fails (a key conflict, a retired key, a signature that does not hold) is never admitted, so never shown.

### Colours

Eight presence colours join `packages/tokens` (`presence-1` to `presence-8`, each with its four schemes, at least 3:1 against `surface` for carets, selections drawn at 25% over the text). Hush blue is not one of them: it means "act here". A person's colour is chosen by every device alike, so everyone sees Maya in the same colour: participants' user ids are sorted by `SHA-256(sessionId || userId)` and given colours in that order, cycling after eight. The same person on two devices has one colour. Colour is never the only cue: a caret carries the person's short name in a label, shown while they type and on hover, and the header lists everyone by name.

### The header

Up to three overlapping avatars, then a count, as "Who can open" does (DESIGN.md, Components); the list behind it names each participant and what they are doing: Editing, Viewing, Idle.

### Idle and gone

- A participant sends a heartbeat every 20 seconds and awareness when its cursor moves.
- **Idle** after five minutes without an edit or a cursor move, or as soon as its tab is hidden: the caret is hidden and the avatar dimmed.
- **Gone** after 60 seconds without any frame: removed from the list, and the host rekeys without them. Browsers throttle hidden tabs' timers, so a background tab may drop out and come back; that is a reconnect, not an error.

### What presence tells the relay

That a connection is in a room, from which address and with which browser (`User-Agent`, `Origin`), when it joined and left, how often it sends and in what padded sizes, and which connection sends the larger rekey messages (the host). Not names, not cursors, not whether a frame is a cursor move or an edit.

## 5. Saving

A session's product is an ordinary version of the file, through the upload pipeline and the milestone 1 contract (`docs/editing-design.md` 3 and 6): sealed under the node key, padded, signed with the version statement by the account that saved it.

### The seed

Two devices that each turn the same text into a Yjs document get different documents (different client ids), and merging them duplicates every line. So a text session's starting state is not made by an editor transaction: it is a Yjs update built from a specification, the same bytes on every device for the same base version.

```
seedClientId = u32be(SHA-256(utf8(["hushos/collab/seed",1,workspaceId,nodeId,baseVersionId]))[0..4])
seed         = one Yjs update (v1 encoding): a single string item, client seedClientId, clock 0,
               in the root Y.Text named "content", holding the whole text; no update when the text is empty
sessionId    = uuidv8(SHA-256(utf8(["hushos/collab/session",1,workspaceId,nodeId,baseVersionId]))[0..16])
```

The text is the file decoded as milestone 1 decodes it, line endings turned to LF; the encoding, BOM, majority line ending and final newline are read from the base version's bytes by the same rules on every device and applied again on save, so the saved bytes keep the file's form (`docs/editing-design.md`, Principles). Lengths are UTF-16 code units, as Yjs counts them; yrs is configured with `OffsetKind::Utf16`. Both twins build the seed by hand and the fixtures pin its bytes and check that Yjs and yrs apply it to the same text. A participant's random client id that equals `seedClientId` is drawn again, so no one ever writes under the seed's id.

Because the seed and `sessionId` depend only on the base version, two devices that seed alone from the same version have the same session: when the relay lets them meet, their documents merge correctly.

An `.hdoc` session cannot be seeded this way (section 6): its seeding host imports the document into Lexical and the binding builds the Yjs state, and its `sessionId` adds a random 16-byte seed nonce the host announces in its rekey.

### Who saves, and how often

- **The host saves**, automatically, while the session has two or more editors: ten seconds after the last edit, or sixty seconds after the first unsaved one, whichever comes first, and when it hands over (it saves before sending a leave, when it can). The new host saves if the document has changed since the last `saved`.
- **Any editor may save at once** with Ctrl/Cmd+S or Save; that save is an amend like the host's.
- **Alone, milestone 1's rules hold**: explicit save, drafts, no upload while typing. A session that falls to one editor goes back to them after its last automatic save. Whether a person alone should autosave too is an open question.
- **After every save** the saver sends a `saved` frame: the new `versionId` and the state vector it saved. Every participant then names that version as the expected one in its own next save, and knows which state is on the server.
- **Every participant keeps its draft** (milestone 1's sealed local draft, keyed by account and file, with the base version), so a crash, a lock or a lost connection loses nothing that was on screen.
- Viewers never save.

The version is signed by the saver, with the ordinary statement: they vouch for those bytes, which include what others typed. That is how a version reads today when an editor saves over someone else's work; the session does not change what a version signature means.

### The server change: amends across a session

Milestone 1 lets a session amend only a version **the caller** created in the same `editSessionId`. A collaborative session changes savers (the host hands over, anyone presses Save), and each version created instead of amended pushes the file's earlier version out: a file keeps one superseded version (`docs/drive-design.md`, Versions), so the second fresh save in a session would purge the version from before the session, the one people need to undo it.

So `amends` is accepted when the named version is the node's current version, was created with the same `editSessionId` by **any account that may write the node now**, and within the last hour (sliding: each amend makes a new version row). A collaborative session's `editSessionId` is its `sessionId`. The pre-session version stays the superseded one for 30 days, and the session costs one version of quota.

What it costs: every editor in a session can replace the session's saved version, deleting the replaced object at once. An editor can already push versions out by uploading twice, and the pre-session version survives an amend, so this widens nothing that matters; it is a stated residual.

### A save refused as stale

- **The current version is one this session announced** (a `saved` frame crossed with this save): the saver takes it as expected and amends again if its state is newer.
- **Someone saved from outside the session** (an upload, a phone without collaboration, the other side of a partition): the saver fetches the current version and merges it into the live document as edits: a line diff from the session's last saved text (or its base) to theirs, applied to the Yjs text through context matching (`diff-match-patch`'s patch, which tolerates text that has moved). Everyone in the session sees the outside change arrive. The saver then saves on top of theirs (a new version, `expectedVersionId` theirs), and hunks that did not apply are named: "Some changes saved elsewhere couldn't be merged. They're in the previous version." Theirs is the superseded version, kept 30 days; the pre-session version is purged by that save, as milestone 1's Save on top would purge it.

### Offline edits

A person who edited alone (offline, with the relay unreachable, or before this feature) has a draft and the version it started from. When they join a session whose state has moved past that version, their changes are applied to the live document as a patch (diff from their base to their draft, context-matched), as above. What does not apply is left out, the draft is kept, and the editor offers "Save your version as a copy". An `.hdoc` draft cannot be patched this way and goes straight to milestone 1's choices (Save on top, Save as a copy, Open theirs).

### What is stored, and what would need storing

Nothing but versions. The relay stores no frames; the server stores no Yjs update, state or log; drafts stay on devices.

Correctness needs nothing more: a session lives in its participants' memory, every save is a whole version, and offline work comes back as a patch. Two things would need a stored Yjs state:

- **Exact offline merges.** A patch is approximate: an offline edit to a paragraph someone rewrote may not apply. A sealed Yjs state saved beside each version (a trailer in the object, under the content key) would let an offline device merge as a CRDT. It costs storage, about the size of the text again, and keeps the document's history in every version. Not in this milestone; an open question.
- **Resuming a session with nobody online.** Not needed: the last save is the state, and a session with nobody in it has nothing unsaved but drafts.

## 6. Native documents (.hdoc)

This belongs to the Notes and documents work, not to editing milestone 1 or to this milestone's text files; it is here because it decides how a Lexical session saves.

- **A Drive node** like any file, its body encrypted and versioned as every file is. The body is a JSON envelope: `{ "format": "hushos.document", "version": 1, "content": <Lexical's serialized editor state> }`.
- **Extension `.hdoc`, MIME `application/vnd.hushos.document+json`.**
- **Not Yjs updates.** A saved document is the Lexical JSON, readable without a CRDT library and without its history. Yjs exists only while people edit together.
- **An open, published schema** for the envelope and every node type HushOS writes, versioned with `version`; a reader refuses a version it does not know rather than guessing.
- **Downloading gives the `.hdoc`**, which imports back exactly: same JSON, same document.
- **Exports are always offered** (Markdown, HTML, DOCX, PDF), **and imports** (`.md`, `.docx`), so a document is never stuck in HushOS.

For editing together: the seeding host loads the `.hdoc` into Lexical and lets `@lexical/yjs` build the shared document; joiners take the host's snapshot and never seed while a host exists. The host saves by serialising Lexical's state into the envelope. The heartbeat's content digest is SHA-256 of the canonical JSON of that state. The phones have no Lexical: until a native editor exists, they show a saved `.hdoc` read-only and do not join its sessions.

## 7. The relay

### The process

`apps/relay`: a Bun application with Elysia's WebSocket routes on Bun's uWebSockets-backed server. It imports `@hushos/auth` for ticket verification (a new export shared with the server that issues them) and `@hushos/logging`, and nothing that reaches a database: no `@hushos/db`, no session lookup, no Postgres. Its own image (`ghcr.io/hushos/hushos-relay`, a Bun base and one bundled file, as the worker's) runs as an unprivileged user. It shares no deploy with the web app, so it restarts and scales on its own, and the web app's Nitro server never handles a WebSocket.

Routes: `GET /v1/rooms/:roomId` (the WebSocket upgrade), `GET /healthz`, `GET /metrics` (counts only, optional, bound to a private address).

### Relay messages

One binary WebSocket message is one relay message. The version is in the path (`/v1`), so a later format is a new path.

```
client → relay
  0x01 hello      u16be length || ticket                      // first message, within 5 s of the upgrade
  0x02 refresh    u16be length || ticket                      // a fresh ticket for the same room and certHash
  0x03 broadcast  body                                        // to every other connection in the room
  0x04 direct     u64be toHandle || body                      // to one connection (snapshots, sync replies)
  0x05 bye

relay → client
  0x81 welcome    u64be yourHandle || u16be count || count × u64be handle
  0x82 present    u64be handle                                // a connection joined
  0x83 gone       u64be handle                                // a connection left
  0x84 from       u64be fromHandle || body
  0x85 directFrom u64be fromHandle || body
  0x86 refused    u16be code || utf8 reason                   // then the relay closes
```

Handles are 64 random bits per connection, meaningless outside it. `body` is section 3's, opaque here. Nothing in this layer is specific to WebSocket or to Bun: the same messages could ride WebTransport streams, or be served by a Rust relay, unchanged.

### Tickets

The HushOS server issues a ticket when a signed-in device asks to edit or watch a file (`POST /api/collab/tickets`, section 11) and its walk authorises it:

```
["hushos/relay/ticket",1,iss,aud,kid,roomId,subject,certHash,role,issuedAt,expiresAt,ticketId]
ticket = base64url(utf8(statement)) || "." || base64url(Ed25519(ticketKey, utf8(statement)))
```

- `iss` is the server's `APP_ORIGIN`; `aud` the relay's origin as `RELAY_URL` names it; `kid` the signing key's id.
- `subject` is `HMAC-SHA256(subjectSecret, utf8(["hushos/relay/subject",1,userId,roomId]))[0..16]`, base64url: stable within a room, so the relay can limit one person's connections there, and different in every room, so the relay cannot follow a person between documents.
- `certHash` binds the ticket to one join. The server checks the certificate's identity signature and that its `userId` is the caller before it signs, so the role in the ticket is the role of the person the certificate names.
- `role` is `editor` or `viewer`, from the walk; `expiresAt` is five minutes after `issuedAt`; `ticketId` is 16 random bytes.
- Tickets are Ed25519, not hybrid: they authorise five minutes of forwarding, not trust in anyone's keys, and a forgery would have to happen within those minutes.

The relay accepts a ticket when `iss` is an origin it serves, `kid` is one of that origin's keys, the signature verifies, `aud` is itself, `roomId` is the path's, the time is within `[issuedAt - 60 s, expiresAt]`, and the ticket is not already in use on another connection. It closes a connection 30 seconds after its ticket expires unless a `refresh` arrived with a valid ticket for the same `roomId`, `subject` and `certHash`. Peers check the ticket inside each join too, against their own server's key, and require `iss` to be their own server: everyone in a room uses the same server.

### Server keys at a well-known path

Each HushOS server publishes its ticket keys:

```
GET <APP_ORIGIN>/.well-known/hushos-relay
{ "version": 1, "issuer": "<APP_ORIGIN>", "keys": [{ "kid": "...", "alg": "Ed25519", "publicKey": "<base64url>" }] }
Cache-Control: public, max-age=600
```

- The ticket key is made at first start and kept in `server_secrets`, beside the VAPID keys; so are the room and subject secrets.
- **The relay** fetches the document over HTTPS only (port 443, TLS verified against the origin), with a 3-second timeout and a 64 KiB cap, and refuses to connect to loopback, private, link-local and multicast addresses, so a ticket naming a hostile `iss` cannot point it into its own network. It caches the keys for the response's `max-age`, held between 5 and 60 minutes; fetches again early when it sees an unknown `kid`, at most once a minute per origin; and caches a failure for one minute.
- **Rotation:** `bun run relay:rotate-key` adds a new key to the document, and the server signs with it once one cache period has passed; the old key is dropped after a further period plus the ticket lifetime. **Revocation** is dropping the key: relays stop accepting it within their cache period (at most an hour, ten minutes by default). Whoever steals a server's ticket key can mint tickets to that server's rooms only, since rooms are kept per origin; tickets open no lobby, so that buys connections and noise, not content.
- **A self-hosted relay** in the same Compose network may fetch the document from an internal address instead (`RELAY_KEYS_URL`), the one exception to the address rules, set by its operator.

hushos.com issues and publishes exactly this way, so the hosted service and every self-hosted server run one code path.

### Rooms

`roomId = base64url(HMAC-SHA256(roomSecret, utf8(["hushos/relay/room",1,workspaceId,nodeId]))[0..16])`, 22 characters. The relay keys rooms by `(iss, roomId)`, so two servers' rooms never meet.

The node id is not used directly. For hushos.com the relay operator and the server operator are one, so it would hide little there; but for a self-hoster on the hosted relay, node ids would let HushOS link activity to anything else that carries those ids. The secret makes the room id meaningless outside the server. It stays the same for a node across rotations: changing it per epoch would hide only that a rotation happened, and would make every rotation a reconnect.

### Limits, caps and backpressure

| Limit                              | Default                                                  |
| ---------------------------------- | -------------------------------------------------------- |
| Relay message size                 | 256 KiB (Bun's `maxPayloadLength`); larger is closed     |
| Connections per room               | 25 (the participant cap; also the peers' rule)           |
| Connections per `subject` per room | 5                                                        |
| Frames per connection              | 30 a second sustained, bursts of 60                      |
| Bytes per connection               | 1 MiB a second sustained, bursts of 16 MiB (a snapshot)  |
| Connections per IP address         | 50                                                       |
| Per origin                         | From the policy (below): connections, rooms, bytes a day |

- **Backpressure:** messages are sent with Bun's per-socket buffering; a connection whose buffered amount passes 4 MiB is closed (`backpressureLimit` with close-on-limit), never fed by dropping frames one by one. Its device reconnects and catches up through sync, which keeps loss visible as a reconnect rather than looking like a relay that drops.
- Per-message compression is off: the bodies are ciphertext.
- An idle connection is closed after 120 seconds without a message; heartbeats keep live ones open.
- A refusal says why (`refused` with a code: ticket, limit, room full, origin unknown), and is counted.

**The policy hook.** Per-origin limits come from `policyFor(origin)`, read from a file (`RELAY_POLICY_FILE`), with a default entry for origins not listed. A self-hosted relay lists its one origin. For the hosted relay, what that default is (open to any server, limited, or only for registered or paying instances) is the owner's decision (section 15); the hook makes any of them configuration.

### Scaling and restarts

A Bun process holds tens of thousands of sockets, and rooms are small, so the hosted relay starts as one instance. A second instance comes with **sticky rooms**: the proxy in front routes by a consistent hash of the path (`/v1/rooms/:roomId`), so a room always lives on one instance and needs no shared state. Pub/sub between instances (Redis, NATS) is not needed while a room fits on one, which at 25 connections it always does.

A restart drops every connection. Devices reconnect with backoff and jitter (one to thirty seconds), re-join, and sync from each other; every participant holds the whole document, so nothing is lost unless every participant of a session is gone at once with unsaved changes, which their drafts cover.

### Logs

Counts only, through `@hushos/logging`: connections, rooms, frames and bytes per minute, refusals by reason, and per-origin totals. No room ids, no handles, no tickets, no subjects, no IP addresses (held in memory for the per-address limit and never written), no `User-Agent`. The log redaction already covers `*Signature*` and `*Envelope*` fields; tickets are added. A test reads the relay's log output under load and fails on any of these.

### Self-hosting: your own relay or ours

A self-hosted server sets `RELAY_URL`:

- **Its own relay (the default):** the Compose stack gains a `relay` service, published on `127.0.0.1:5174` beside the app's 5173, with `RELAY_URL=ws://localhost:5174` locally; a public deployment puts it behind the same reverse proxy at its own host (`wss://relay.drive.example.com`) or a path. It serves only that server's origin.
- **Ours:** `RELAY_URL=wss://relay.hushos.com`. Nothing else changes: the server already publishes its keys at the well-known path.
- **Empty:** editing together is off; the editors work alone, as in milestone 1.

### What the hosted relay learns about a self-hoster's people

The server's origin; every participant's IP address and browser or app (`User-Agent`); which opaque rooms are active, how many connections each has and when they come and go; the per-room subject of each connection (not linkable across rooms by itself, but by address); the timing and padded sizes of what they send. Not who they are (no user id, email or name), not which file a room is, not a word of any document.

The server's management area states this when `RELAY_URL` points at a relay outside its own origin's deployment, in these words or close to them: "Editing together goes through relay.hushos.com. HushOS, the company, can see the IP addresses of people editing on this server, when they edit, how many people are in each document and how much they send. It can't see who they are, which files they edit, or anything in them. Run the relay in your own Compose stack to keep this on your servers." `docs/self-hosting.md` says the same, and the instance's security page names the relay's host.

### Configuration, CSP and Compose

| Variable                   | Where | Purpose                                                                                                  |
| -------------------------- | ----- | -------------------------------------------------------------------------------------------------------- |
| `RELAY_URL`                | web   | The relay's `ws://` or `wss://` URL; empty turns editing together off. Served to clients in capabilities |
| `RELAY_PUBLIC_URL`         | relay | Its own origin, which tickets' `aud` must equal                                                          |
| `RELAY_PORT`               | relay | Listen port, default 5174                                                                                |
| `RELAY_ORIGINS`            | relay | Server origins it serves, space or comma separated; `*` on the hosted relay, with the policy deciding    |
| `RELAY_KEYS_URL`           | relay | `origin=url` pairs for fetching a server's keys inside a private network                                 |
| `RELAY_POLICY_FILE`        | relay | Per-origin limits and the default entry                                                                  |
| `RELAY_ALLOW_HTTP_ORIGINS` | relay | Development only: accept `http://localhost` issuers                                                      |

- **CSP:** `connect-src` gains `RELAY_URL`'s origin with its `ws:` or `wss:` scheme, derived as the object store's origin is (`apps/web/server/csp.ts` gains `relayOrigins`; `security-headers.ts` derives it from `RELAY_URL`). `'self'` does not cover another port or host, so the relay is always listed explicitly; `CSP_CONNECT_SRC` stays for operator additions.
- **Compose:** a `relay` service built from `apps/relay/Dockerfile`, with `RELAY_ORIGINS=${APP_ORIGIN}`, `RELAY_KEYS_URL=${APP_ORIGIN}=http://web:5173/.well-known/hushos-relay`, a health check on `/healthz`, and no volume (it stores nothing). The web service gains `RELAY_URL`. The published-images Compose file gains the relay image.

### Later, not now

- **A Rust relay**, for memory safety and very high connection counts, would speak the same relay messages and verify the same tickets; the push relay (`docs/devices-design.md` 5) is already planned in Rust for its own reasons. Not the plan while one Bun process carries the load.
- **WebTransport**, when Bun, Cloudflare and the phones support it: the relay messages ride a stream unchanged.
- **A push gateway for self-hosters using the official apps** (APNs and FCM, content-free or encrypted payloads, possibly authenticated with this ticket idea) is a separate design; `docs/devices-design.md` 5 already plans `push.hushos.com`. Not designed here.

## 8. Clients

### The web

- **The crypto worker** (`@hushos/auth/worker`, run by `apps/web/src/lib/auth.worker.ts`) gains a collab module and owns the WebSocket: it makes the join's keys and certificate, derives the lobby key from the node key it already holds, checks joins and rekeys, holds session keys and sequence windows, seals and opens every frame, and refreshes tickets. Session keys and certificate keys never leave it and are never written to IndexedDB.
- **The page** holds the Yjs document and the editor. A small provider class (`HushProvider`, the interface `y-websocket`'s provider has: status, synced, awareness) passes plaintext updates and awareness to and from the worker by `postMessage`. The page needs plaintext to show the text, so that crossing reveals nothing new.
- **CodeMirror:** `yCollab(ytext, awareness, { undoManager })` from `y-codemirror.next`. `Y.UndoManager` tracks only local changes, so undo undoes one's own typing, never someone else's.
- **Lexical:** `CollaborationPlugin` from `@lexical/yjs` with a `providerFactory` that returns `HushProvider`, `shouldBootstrap` only for the seeding host.
- **Tables:** the CSV Table tab writes each cell edit as a splice of that cell's raw text in the Yjs text, and the grid re-parses from the text, so milestone 1's byte-exact rule holds with several people editing.
- **Preload:** Yjs, `y-codemirror.next` and the provider join the post-unlock preload (`lib/preload.ts`), as every viewer and editor chunk does since round 3, so fetching them does not say that someone is about to edit together. `@lexical/yjs` joins it with Notes and documents.
- **Lock and sign-out** end every session: the worker sends `leave`, the host (if it was this device and editors remain) hands over, keys are dropped, and the draft stays sealed as milestone 1 keeps it.

### The phones

yrs goes into `crates/hushos-core` as a new `collab.rs`, with `yrs` pinned at an exact version and `OffsetKind::Utf16`. The core's rule holds: no I/O. The app owns the socket (`URLSessionWebSocketTask`, OkHttp), the clock, the ticket and well-known fetches and the editor; the core seals, opens, checks and merges. It exposes one stateful UniFFI object, as `join.rs` and `group_trust.rs` already do:

| Call                                                     | Does                                                                                                                                                     |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CollabSession::new(params)`                             | Node key, epoch and ids, the opened version's bytes, the account's identity for signing                                                                  |
| `cert_request()`                                         | The certificate statement and its hybrid signature, for the ticket call                                                                                  |
| `set_ticket(ticket)`, `set_server_keys(keys)`            | The ticket for this join, and the server's well-known keys for checking peers' tickets                                                                   |
| `on_message(bytes, now_ms) -> Vec<CollabEvent>`          | Feeds a relay message; events: remote text changes as UTF-16 index, delete length and insert; peers changed; saved; save due; diverged; waiting for keys |
| `poll(now_ms) -> Vec<Vec<u8>>`                           | The relay messages to send this tick, padded and coalesced                                                                                               |
| `local_edit(index, delete_len, insert)`                  | A local change, in UTF-16 units                                                                                                                          |
| `set_cursor(anchor, head)`, `peers() -> Vec<PeerCursor>` | Awareness out, and every peer's resolved cursor and colour index                                                                                         |
| `peer_identity(cert_hash, served, pins)`                 | The verdict for a peer's certificate under the app's pins, as record verdicts take them                                                                  |
| `text()`, `encode_for_save()`                            | The document, and the file's bytes in its original form for an upload                                                                                    |
| `epoch_changed(node_key, key_epoch)`, `close()`          | Re-join under a new epoch; leave                                                                                                                         |

Native text views (UITextView with TextKit 2, Compose `BasicTextField`) bind by diffing each change into `local_edit` and applying remote changes while keeping the local selection through relative positions. Whether yrs belongs behind a cargo feature, to keep it out of the File Provider extension and the DocumentsProvider, depends on its measured size (an open question).

### Twins and fixtures

`packages/crypto/src/collab.ts` and `crates/hushos-core/src/collab.rs` are twins, held together by fixtures in both directions (`bun run fixtures`):

- the certificate statement and its hash; the lobby seal (opened both ways); the session-key seal (sealed on one side, opened on the other, since it is randomised); a frame, byte for byte, given a key, sequence and padding (the nonce is deterministic, so the bytes are fixed); signatures verified against fixed values; the ticket statement and its verification;
- the seed update's bytes for given texts (ASCII, astral characters, CRLF input, empty), applied by Yjs and by yrs to the same text;
- **convergence traces:** recorded concurrent editing sessions (Yjs updates from several simulated clients, with deletions and fragments) replayed into yrs, and yrs-made traces replayed into Yjs, each ending with the same text and state vector. `yjs` and `yrs` are pinned exactly and upgraded only with the traces passing again.

## 9. Permissions

| Where              | Who joins                                                                                                          | Edits                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ | --------------------------- |
| One's own folders  | The owner's devices                                                                                                | Yes                         |
| Shares to accounts | Grantees, by the walk's nearest share                                                                              | Editors; viewers watch live |
| Family folders     | Active members holding a grant for the area's latest key version (`areaWriteVersion`, `docs/groups-design.md` 2.6) | Yes, as members write today |
| Links              | Nobody                                                                                                             | No                          |

- **Roles are the server's, as in Drive.** The ticket carries the walk's role and peers enforce it (a viewer's `update` is refused), but a malicious server can sign an editor ticket for a viewer, exactly as it can accept a viewer's upload today. Cryptography decides who holds the key; the server decides who may write.
- **Viewers watch live** and appear as Viewing. They send no cursor of their own beyond presence, never host and never save.
- **Family folders** have no outsiders (sharing inside them is hidden until share records signed at family level exist, `docs/groups-design.md` 3.4). A member removed or leaving is cut off as section 2 says; the removal's rotation is what layer 3 waits for.
- **No editing together over links, not even watching.** A link visitor has no identity, so nothing could certify their session key or name them; they would be anonymous watchers of unsaved work, and a link's secret is in its URL, so anyone the URL reached could join. Link visitors see saved versions, as today. The ticket route refuses link tokens.
- **A family member's or grantee's identity that nobody checked** still joins and edits; they are named with their email (section 4).

## 10. What the main server learns

- Ticket requests: which account asks to edit or watch which node, when, with which role, and the public parts of each certificate (session public keys, Yjs client id, device id). It already sees opens and downloads.
- That several accounts saved versions in one `editSessionId`: that they edited together.
- Versions, sizes and times, as for any save.

Participants learn about each other too: a grantee in a session sees the other participants' names and emails, which a share alone does not show them. Someone who opens a shared file while others edit it is told who is there by name; that is what editing together is, and the share dialog's copy should say that people editing at the same time see each other.

- Not the room's traffic: that goes to the relay, which for hushos.com HushOS also runs, and which keeps no logs of rooms.

## 11. API contract

Base64url without padding; ids lowercase UUIDs.

- **`POST /api/collab/tickets`** with `{ nodeId, cert: { statement fields, identitySignature } }`. Requires a session; walks the node (member, nearest share, or family area membership); refuses link-token callers (409 `unsupported`), files the caller cannot open (404), callers whose certificate does not verify under their current identity or names someone else (400 "This join was not signed by your keys"). Returns `{ roomId, ticket, relayUrl, role, expiresAt }`. The same call with the same certificate refreshes. Limited per session (60 a minute) and per account. 404 when `RELAY_URL` is empty.
- **`GET /.well-known/hushos-relay`**: the server's ticket keys (section 7), no session, cacheable. Served by the web app.
- **`POST /api/collab/people`** with `{ nodeId, userIds }` (at most 25): `{ people: [{ userId, name, email }] }` for those of the ids that hold a live ticket for that node's room, so a device can label participants it has not checked; any other id is left out, so the route cannot be used to look up accounts. Same walk and limits as the ticket route.
- **Capabilities** gain `relayUrl` (null when editing together is off), so the phones know whether to offer it.
- **`POST /api/drive/uploads`**, `versionOf.amends`: accepted for a version created with the same `editSessionId` by any account that may write the node now, if current and created within the last hour (section 5). Everything else in `docs/editing-design.md` 6 is unchanged.
- **`server_secrets`** gains `relay-ticket-keys` (the Ed25519 key list with ids), `relay-room-secret` and `relay-subject-secret`, made at first start.

## 12. Rollout, one pull request each

1. **This note.**
2. **Crypto twins:** `collab.ts` and `collab.rs` (certificate, lobby, session-key seals, frames, signatures), the ticket statement in `@hushos/auth`, fixtures both ways.
3. **Yjs and yrs:** the seed specification, pinned versions, the convergence traces and a property test of simulated peers through an adversarial in-memory relay.
4. **The relay:** `apps/relay`, tickets and well-known keys, limits, backpressure, the policy hook, the Dockerfile and image, the Compose service, `docs/self-hosting.md`.
5. **The server:** the ticket route, the well-known route, the secrets and the rotation command, `RELAY_URL`, the CSP addition, the widened amend, the management area's statement.
6. **Presence tokens:** `presence-1` to `presence-8` in `packages/tokens`, all four schemes.
7. **The web:** the worker's collab module, `HushProvider`, CodeMirror binding, presence UI, hosting and saving, the stale and offline merges, the Table tab's splices; on when `RELAY_URL` is set.
8. **End-to-end tests:** two and three browser contexts through the Compose relay, with an adversarial relay mode (section 13).
9. **The hosted relay:** `relay.hushos.com`, its policy for other origins, its monitoring; hushos.com's `RELAY_URL` set to it. The roadmap item moves when this reaches hushos.com.
10. **The phones:** the core's `CollabSession`, then iOS, then Android, after editing milestone 5.
11. **Lexical documents:** with Notes and documents and `.hdoc` (section 6).

## 13. Tests that must exist

Each fails on a defect a person, operator or attacker would notice (AGENTS.md). The adversarial relay is a test relay that can drop, delay, reorder, replay, duplicate, inject and partition by rule.

- **Replay:** a frame replayed with its own sequence changes nothing; an old awareness frame replayed does not move a cursor back.
- **Reorder:** two frames swapped: the later is applied, the earlier dropped, and sync brings every copy to the same text within one heartbeat.
- **Drops:** a run of dropped frames is detected from the gap and healed; a relay dropping one sender persistently produces the reconnect notice.
- **Injection and tampering:** a flipped byte, a frame moved to another room, session, base version, generation or sender, and a frame from generation `g - 1` after its 30 seconds, are all refused, and the document is unchanged.
- **Impersonation:** a participant's update carrying an item under another participant's client id is refused; a frame signed by one participant and labelled as another's is refused; a viewer's update is refused by every peer even when the relay forwards it.
- **A removed member:** the adversarial relay keeps a revoked grantee's socket open and forwards everything to it; after the departure rekey it opens no frame. After the file's rotation, a device without the new node key cannot re-join, and the host's next generation excludes it within 60 seconds. A join sealed under the previous epoch's lobby key is refused after the epoch changes.
- **Tickets:** expired, wrong `aud`, wrong room, another `certHash`, an unknown `kid`, a key from another origin's document, and a ticket already in use are refused by the relay; peers refuse a join whose ticket names another server.
- **Certificates:** one whose identity signature fails, one under a retired key, one past `notAfter` and one reusing a client id get no seal.
- **Split views:** two partitions with different `members` raise the notice when one heartbeat crosses; equal state vectors with different content stop sending and offer a copy; two sessions in one room resolve to the one whose save is current, and the other side's unsaved changes arrive as a patch.
- **Saving:** two hosts saving at once leave one version; an amend by a second account in the same `editSessionId` is accepted, from another `editSessionId` or an account that lost write is refused; the pre-session version is still the superseded one after a session of many saves; an outside save during a session appears in every participant's editor; an offline draft is patched in, and the hunk that cannot apply is named and kept.
- **Seed:** two devices seeding alone from the same version merge without duplicating a line, in TS and in Rust.
- **Relay:** frame cap, per-origin, per-subject and per-address limits; a slow consumer is closed at the backpressure limit; the well-known fetch refuses HTTP, private and loopback addresses; a rotated key is fetched on first sight of its `kid`, a dropped one refused after the cache period; the log output carries no room id, handle, ticket, subject or address.
- **Twins:** the fixtures and convergence traces in section 8.
- **End to end:** two browsers edit one file through the Compose relay and see each other's cursors with the right names; the saved version opens to the merged text with the saver's signature; revoking the share mid-session removes the grantee's cursor everywhere and turns their editor read-only ("You no longer have access to this file").

## 14. Residuals

- **A malicious server with a removed collaborator** who holds the current node key reads the live session until the rotation reaches the file. Revocation stops an honest server; the rotation is the only cryptographic cut.
- **Removing a device rotates nothing**, so a removed device that kept keys can, with a malicious server, join rooms of files whose keys it held until each is rotated.
- **The web app's code comes from the server**; on the web, a hostile server defeats all of this.
- **The relay sees metadata:** addresses, browsers, opaque rooms, participant counts, join and leave times, typing bursts and padded volumes, which connection hosts, and the server's origin. Keystroke rhythm is hidden within 100 ms ticks while typing; bursts and totals are not.
- **The lobby key derives from the node key**, so whoever holds the node key at that epoch later, with a recording of the room, can open its joins and rekeys: who joined, when, their session public keys and roles. Never content: session keys are sealed to ephemeral keys.
- **Insiders:** a participant can fork the document between peers (detected by heartbeats, not prevented), shut others out while hosting, hand a joiner a false snapshot, and replace the session's saved version. The pre-session version survives unless an outside save intervenes.
- **Authorship is per frame, not per character.** Snapshots and sync replies are the forwarder's word, and a saved version is signed by its saver alone.
- **A full partition** goes unseen until a heartbeat crosses or a save is refused as stale.
- **Roles are the server's:** a malicious server can let a viewer edit, as in Drive.
- **Classical signatures in the session:** frames and tickets are Ed25519; only the certificate is hybrid. Forging either needs a break within the session's or ticket's lifetime.
- **Offline merges are patches**, which may leave changes out (named, and kept as a copy), until a stored Yjs state makes them exact.
- **A save from outside the session purges the pre-session version** when the session saves on top of it, as milestone 1's Save on top does.
- **Seed client id collisions:** a participant's random id equal to the seed's is drawn again, but two sessions' seed ids, or two participants' ids, can still collide with probability about n²/2³³; a collision within a session is refused at the join check, so the cost is a re-join.
- **Phones do not join `.hdoc` sessions** until a native rich-text editor exists.

## 15. Open questions for the owner

1. **The hosted relay for other servers:** free and open to any HushOS server within default limits, free only for servers that register their origin, or offered to paying instances? The policy hook supports each; the default entry is the decision.
2. **Autosave when alone:** should a session with one editor also save itself, so behaviour does not change when the second person leaves, or keep milestone 1's explicit save?
3. **The participant cap:** 25 per room (each rekey seals to everyone, about 1.2 KB each)? Larger sessions would make MLS worth its cost.
4. **Viewers in live sessions:** shown to editors as Viewing (this note's choice), hidden, or kept out of live sessions entirely?
5. **A stored Yjs state per version** (a sealed trailer under the content key) for exact offline merges, at the cost of roughly doubling text files' stored size and keeping their history in every version?
6. **Cover traffic:** frames every tick only while typing (this note) hides keystroke rhythm but not bursts. Constant-rate frames while a document is focused would hide bursts too, at roughly ten padded frames a second per person fanned out to everyone in the room. Worth the relay cost?
7. **yrs on the phones:** inside `hushos-core` behind a cargo feature, so the Files extensions do not carry it, or always in? Decide after measuring its size.
8. **"Edited together with" in Info:** list the session's participants beside a saved version? Without their signatures over the version it would be the saver's word, or the server's.
