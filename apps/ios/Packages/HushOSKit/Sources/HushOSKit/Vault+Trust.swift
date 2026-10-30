import Foundation
import HushOSCore

/*
 * First use (docs/optional-verification.md 2; the web's lib/contacts.ts): someone added, or met
 * through something they shared, is remembered with the keys the server serves then (a
 * first-seen pin) and shared with at once. Comparing twelve words, any time, makes the pin
 * verified. A later change is followed only along a succession chain signed by keys this phone
 * holds; any other change pauses that one person (new shares, re-sealing, opening what they
 * shared) until the person continues or checks, and nothing is ever sealed to keys nobody
 * pinned, followed or accepted.
 *
 * The settings pin is used only if it agrees with the guard this phone keeps (ContactGuard.swift,
 * 2.8): settings replaced by a newer copy that drops or swaps a pin are met as a change, never as
 * first use. Every rule is the core's (`pin_trust`, `key_commitment`, `compare_pin`,
 * `pin_of_served`, `pin_first_seen_of_legacy`, `guard_agrees`, `guard_entry_next`); this file
 * only orders the reads and writes.
 */

/* Someone whose keys changed with no chain from the keys this phone holds: paused until Continue or a check (2.4). */
public struct AccountChange: Sendable, Hashable, Identifiable {
    public let contactId: String
    public let name: String
    public let email: String
    public var id: String { contactId.lowercased() }
    public var firstName: String { (name.isEmpty ? email : name).split(separator: " ").first.map(String.init) ?? email }

    public init(contactId: String, name: String, email: String) {
        self.contactId = contactId
        self.name = name
        self.email = email
    }
}

/* What a share, a re-seal or an open met: said as the one calm notice, "Maya’s account changed". */
public struct AccountChangedError: Error, LocalizedError, Equatable, WordedError {
    public let change: AccountChange
    public var errorDescription: String? { "\(change.firstName)’s account changed." }
}

/* What Add someone came to (6.2). */
public enum Added: Sendable, Equatable {
    case added(ContactPin), already(ContactPin), changed(AccountChange)
}

/* Where this phone stands with one person, given the keys the server serves for them now. */
enum Standing {
    /* The settings pin agrees with the guard (or there is none here yet) and holds the served keys, or followed them. */
    case ok(pin: ContactPin, entry: GuardEntry?, followed: Bool)
    /* Nobody pinned: first use, or someone removed whose guard entry holds the served keys. */
    case new(entry: GuardEntry?, removed: Bool)
    /* A signed succession not looked up (no act of the person's asked for it). */
    case succession(pin: ContactPin)
    /* Anything else, a pin missing from the settings while the guard holds them included. */
    case changed(pin: ContactPin?, entry: GuardEntry?, wasVerified: Bool)
    /* A legacy pin whose person has not signed in since post-quantum keys. */
    case notUpgraded(pin: ContactPin)
}

extension Contact {
    /* The person as a received share's granter names them. */
    init(granter: SharedWithMeView.Granter) {
        let served = granter.served
        self.init(userId: granter.id, name: granter.name, email: granter.email, keyVersion: granter.keyVersion,
                  identityVersion: granter.identityVersion ?? 1, encryptionPublicKey: served.encryptionPublicKey,
                  signingPublicKey: served.signingPublicKey, mlDsaPublicKey: granter.mlDsaPublicKey, kemPublicKey: granter.kemPublicKey,
                  keysSignature: granter.keysSignature,
                  upgraded: keysHold(userId: granter.id, served, identityVersion: granter.identityVersion, keysSignature: granter.keysSignature),
                  fingerprint: nil)
    }

    /* A grantee as a rotation or the share list serves them, named from the pin. */
    init(userId: String, served identity: ServedIdentity, name: String, email: String) {
        let served = identity.served
        self.init(userId: userId, name: name, email: email, keyVersion: identity.keyVersion, identityVersion: identity.identityVersion ?? 1,
                  encryptionPublicKey: identity.encryptionPublicKey, signingPublicKey: identity.signingPublicKey,
                  mlDsaPublicKey: identity.mlDsaPublicKey, kemPublicKey: identity.kemPublicKey, keysSignature: identity.keysSignature,
                  upgraded: keysHold(userId: userId, served, identityVersion: identity.identityVersion, keysSignature: identity.keysSignature),
                  fingerprint: nil)
    }

    var displayName: String { name.isEmpty ? email : name }
    var firstName: String { displayName.split(separator: " ").first.map(String.init) ?? displayName }

    /* The key commitment of the served keys, or nil for an identity that can't be pinned. */
    var commitment: String? {
        guard let full = served.full, let keys = try? pinOfServed(served: full, verified: false) else { return nil }
        return keyCommitment(pin: keys)
    }

    /* A pin of the served keys (`verified` only after They match): only for an upgraded identity whose keys statement held. */
    func pin(verified: Bool, firstSeen: String?, at: Date = Date()) throws -> ContactPin {
        guard upgraded, let full = served.full else { throw ContactError.notUpgraded(displayName) }
        return ContactPin(userId: userId, email: email, name: name, keys: try pinOfServed(served: full, verified: verified),
                          pinnedAt: ISO8601DateFormatter().string(from: at), firstSeen: firstSeen)
    }
}

extension ContactPin {
    /* A pin of `keys` for a person, with nothing else carried over. */
    init(userId: String, email: String, name: String, keys: PinKeys, pinnedAt: String, firstSeen: String?) {
        self.init(userId: userId, email: email, name: name, encryptionPublicKey: keys.encryptionPublicKey, signingPublicKey: keys.signingPublicKey,
                  fingerprint: keys.fingerprint, pinnedAt: pinnedAt, kemPublicKeyHash: keys.kemPublicKeyHash)
        mlDsaPublicKeyHash = keys.mlDsaPublicKeyHash
        keyVersion = keys.keyVersion
        self.firstSeen = firstSeen
    }

    /* This pin over other keys: every other field kept. */
    func replacing(_ keys: PinKeys, pinnedAt: String? = nil, name: String? = nil, email: String? = nil) -> ContactPin {
        var next = ContactPin(userId: userId, email: email ?? self.email, name: name ?? self.name, keys: keys, pinnedAt: pinnedAt ?? self.pinnedAt,
                              firstSeen: firstSeen)
        next.previousSigningKeys = previousSigningKeys
        next.keysReplacedAt = keysReplacedAt
        next.resealShares = resealShares
        next.trustedVia = trustedVia
        return next
    }

    /* Verified or first-seen: a pin the guard remembers and a share may be sealed to. */
    var held: Bool { trust == .verified || trust == .seen }
}

/* A verdict on whether the settings pin agrees with the guard: the core's `guard_agrees`, without a chain. */
private func agreement(_ userId: String, _ entry: GuardEntry?, _ pin: ContactPin?) -> GuardVerdict {
    guardAgrees(userId: userId, guard: entry.map { .held(entry: $0) } ?? .absent, pin: pin?.keys, served: nil, links: [])
}

extension Vault {
    /*
     * The guard, with the settings key it is sealed under: the one resolved for this turn
     * (`resolveGuardKey`), else the one this process opened for a settings save.
     */
    var contactGuard: ContactGuardStore {
        var store = guardStore ?? ContactGuardStore.shared(session: session)
        if let guardKey { store.key = guardKey } else if let settingsKey, let settingsKeyEnvelope {
            store.key = MarksKey(key: settingsKey, envelope: settingsKeyEnvelope)
        }
        return store
    }

    /*
     * The key the guard opens under, as the rollback marks find theirs: the envelope kept beside
     * the record when it opens under the account key, else this process's, else the server's.
     * None to be had (no account key, nothing served) leaves the guard unreadable, never empty.
     */
    func resolveGuardKey() async {
        let kept = (guardStore ?? ContactGuardStore.shared(session: session)).keptKey()
        guardKey = (try? await marksKey(kept: kept, create: false)) ?? nil
    }

    /* Tests: this vault's guard, in a folder of the test's own. */
    func adopt(guard store: ContactGuardStore) { guardStore = store }

    /* Tests: what runs right after each guard commit (a stop there, as a crash would). */
    func adopt(afterGuardCommit hook: (@Sendable () throws -> Void)?) { afterGuardCommit = hook }

    /*
     * The account's trust-changing acts and the reads that judge from the guard, one at a time in
     * this process (the web's Web Lock): a Continue never interleaves with an add for one person.
     */
    func withGuardTurn<T>(_ body: () async throws -> T) async throws -> T {
        if guardBusy { await withCheckedContinuation { guardWaiting.append($0) } } else { guardBusy = true }
        defer { if guardWaiting.isEmpty { guardBusy = false } else { guardWaiting.removeFirst().resume() } }
        await resolveGuardKey()
        return try await body()
    }

    /* The people this phone found changed this session, so every screen that shows them says so until Continue or a check. */
    public func accountChanges() -> [String: AccountChange] { noticedChanges }

    @discardableResult
    func note(_ change: AccountChange) -> AccountChange {
        noticedChanges[change.id] = change
        return change
    }

    func clearChange(_ contactId: String) { noticedChanges[contactId.lowercased()] = nil }

    /* This phone's entry and pending act for a person; a read that fails is never first use. */
    private func readGuard(_ contactId: String) throws -> (GuardEntry?, PendingAct?) {
        do {
            let store = contactGuard
            return (try store.entry(contactId), try store.pending(contactId))
        } catch {
            throw GuardError.unreadable
        }
    }

    private func commitGuard(_ contactId: String, _ entry: GuardEntry, over revision: UInt64, keep: PendingAct? = nil) throws -> GuardEntry {
        do {
            try contactGuard.commit(contactId, entry, over: revision, keep: keep)
        } catch GuardError.raced {
            throw GuardError.raced
        } catch {
            throw GuardError.unsaved
        }
        forgetSigners()
        try afterGuardCommit?()
        return entry
    }

    /*
     * The guard entry for a person, with an act left pending settled first (2.8), given the
     * settings pin and the stored sequence (`at`): one whose target the pin reached, over the
     * entry's revision, is finished silently; one whose save could still land (the settings are
     * still at its base) is kept (`kept`) and the entry judged as it is; any other is dropped.
     */
    func guardFor(_ contactId: String, pin: ContactPin?, at: UInt64) throws -> (entry: GuardEntry?, kept: PendingAct?) {
        let (entry, pending) = try readGuard(contactId)
        guard let pending else { return (entry, nil) }
        let revision = entry?.revision ?? 0
        if pending.revision == revision {
            if let pin, pin.commitment == pending.target, let next = try? guardEntryNext(previous: entry, pin: pin.keys) {
                // An act whose save landed but whose app stopped before it went on (a Continue, They match over new keys):
                // what was shared with them still holds the old keys. Queued before the commit that drops the pending
                // record, so no stop between the two loses it; queued twice is only a re-seal done again.
                if pin.resealShares == true { ResealTo.add(contactId) }
                return (try commitGuard(contactId, next, over: revision), nil)
            }
            if let base = pending.base, at <= base { return (entry, pending) }
        }
        do {
            try contactGuard.dropPending(contactId)
        } catch {
            throw GuardError.unsaved
        }
        return (entry, nil)
    }

    /* A guard entry for keys this phone acts on with nothing in the settings to change: a pin met here first, or now seen verified. */
    private func rememberKeys(_ contactId: String, _ entry: GuardEntry?, _ pin: ContactPin, keep: PendingAct? = nil) throws -> GuardEntry {
        try commitGuard(contactId, try guardEntryNext(previous: entry, pin: pin.keys), over: entry?.revision ?? 0, keep: keep)
    }

    /*
     * One act that changes whom this phone trusts (2.8, "Committing an act"): a pending record
     * naming the exact keys it moves to (written again before every attempt, with the sequence that
     * attempt lands over), the settings saved, then the guard entry at the next revision with the
     * pending record deleted. Only then is the act done; a lost answer, a crash or a failed write
     * between leaves the pending record for the next read to settle. `change` must write a pin of
     * `target`'s keys, or the act stops (`moved`).
     */
    func commitTrust(_ contactId: String, entry: GuardEntry?, target: ContactPin, change: (inout Settings) throws -> Void) async throws
        -> (pin: ContactPin, entry: GuardEntry) {
        guard let keys = target.commitment else { throw ContactError.message("These keys can’t be remembered.") }
        let revision = entry?.revision ?? 0
        // An act that leaves what was shared with them on older keys (Continue, a check over new keys, a followed
        // succession) queues the re-seal before anything is saved: a stop after the save or the guard's commit
        // never leaves it owed and unqueued. One that never lands only re-seals to the keys the pin still holds.
        if target.resealShares == true { ResealTo.add(contactId) }
        let saved = try await updateSettings(change) { base in
            do {
                // The store as of now: the save just made (or opened) the settings key the guard is sealed under.
                try self.contactGuard.putPending(contactId, PendingAct(target: keys, revision: revision, at: ISO8601DateFormatter().string(from: Date()), base: base))
            } catch {
                throw GuardError.unsaved
            }
        }
        guard let pin = saved.pin(of: contactId), pin.commitment == keys else { throw ContactError.moved }
        return (pin, try commitGuard(contactId, try guardEntryNext(previous: entry, pin: pin.keys), over: revision))
    }

    /*
     * Where this phone stands with one person (2.3, 2.4, 2.8). `act` writes what the person's act
     * needs (a first guard entry, a legacy pin made first-seen, a followed succession); `follow`
     * looks a succession up, only on the person's act, so the server cannot learn whom this phone
     * pins by watching it look people up. In the guard's turn.
     */
    func stand(_ contact: Contact, act: Bool, follow: Bool, pass: MountPass? = nil) async throws -> Standing {
        // A mounting pass reads the settings once for all its shares, and again only after something saved them.
        let settings: Settings
        if let read = pass?.settings { settings = read } else {
            settings = try await loadSettings()
            pass?.settings = settings
        }
        let id = contact.userId
        var pin = settings.pin(of: id)
        var (entry, kept) = try guardFor(id, pin: pin, at: settings.version)
        var trust = pin?.trust
        func changed() -> Standing {
            .changed(pin: pin, entry: entry, wasVerified: entry?.verified == true || (trust == .verified && agreement(id, entry, pin) != .changed))
        }
        guard var current = pin else {
            let removed = settings.removed(id)
            guard let entry else { return .new(entry: nil, removed: removed) }
            // Removed (here or on an older app) over the keys this phone holds: new again, over others a change.
            let served = contact.commitment
            return served != nil && served == keyCommitment(pin: entry.keys) ? .new(entry: entry, removed: removed) : changed()
        }
        if trust == .legacy || trust == .invalid {
            // A legacy pin over a guard is settings older than this phone has acted on.
            if entry != nil { return changed() }
            guard let upgraded = firstSeenOfLegacy(current, contact) else {
                let sameClassical = current.encryptionPublicKey == contact.encryptionPublicKey && current.signingPublicKey == contact.signingPublicKey
                return sameClassical ? .notUpgraded(pin: current) : changed()
            }
            if !act { return .ok(pin: upgraded, entry: entry, followed: false) }
            let before = current
            (current, entry) = try await commitTrust(id, entry: entry, target: upgraded) { try $0.setPin(upgraded, ifOver: before) }
            pass?.settings = nil
            pin = current
            trust = .seen
        }
        if agreement(id, entry, current) == .changed {
            // The settings moved away from what this phone holds: taken only along a chain this phone verifies
            // from the guard's keys to the served ones, which must be the pin's.
            guard follow, let held = entry, let served = contact.served.full else { return changed() }
            guard let links = try? await Auth.succession(of: id, as: session),
                  guardAgrees(userId: id, guard: .held(entry: held), pin: current.keys, served: served, links: links) == .follows
            else { return changed() }
            if act { entry = try rememberKeys(id, held, current, keep: kept) }
        }
        switch current.compare(contact.served) {
        case .same:
            if act, entry == nil || (trust == .verified && entry?.verified != true) { entry = try rememberKeys(id, entry, current, keep: kept) }
            return .ok(pin: current, entry: entry, followed: false)
        case .succession:
            break
        case .recheck, .changed:
            return changed()
        }
        if !follow { return .succession(pin: current) }
        guard let links = try? await Auth.succession(of: id, as: session), case .followed(let next) = current.follow(contact.served, links: links)
        else { return changed() }
        if !act { return .ok(pin: next, entry: entry, followed: true) }
        let from = current
        (current, entry) = try await commitTrust(id, entry: entry, target: next) { settings in
            let stored = settings.pin(of: id)
            // Another device followed it first: its pin is kept as it is, a check included.
            if ContactPin.sameKeys(stored, next) { settings.forgetRemoval(id); return }
            // Only from the keys the chain was checked from, and carrying that pin's standing as it is now.
            guard let stored, ContactPin.sameKeys(stored, from), case .followed(let again) = stored.follow(contact.served, links: links) else {
                throw ContactError.moved
            }
            try settings.setPinOnce(again)
        }
        pass?.settings = nil
        return .ok(pin: current, entry: entry, followed: true)
    }

    /* A legacy (or malformed) pin as a first-seen pin of the served keys (2.5, `pin_first_seen_of_legacy`); nil when the rule doesn't apply. */
    private func firstSeenOfLegacy(_ pin: ContactPin, _ contact: Contact) -> ContactPin? {
        guard let version = contact.keyVersion, let mlDsa = contact.mlDsaPublicKey, let kem = contact.kemPublicKey,
              let statement = contact.keysSignature else { return nil }
        let served = PublicIdentity(keyVersion: version, encryptionPublicKey: contact.encryptionPublicKey, signingPublicKey: contact.signingPublicKey,
                                    mlDsaPublicKey: mlDsa, kemPublicKey: kem, keysSignature: statement)
        return pinFirstSeenOfLegacy(userId: contact.userId, pin: pin.keys, served: served).map { pin.replacing($0) }
    }

    /* An act decided over what the settings held, run again once when another device moved the person's pin before it saved. */
    func decidedAgain<T>(_ act: () async throws -> T) async throws -> T {
        do { return try await act() } catch ContactError.moved { return try await act() } catch GuardError.raced { return try await act() }
    }

    // MARK: - Acts

    /*
     * Add someone (6.2): looked up by email and, when the keys statement holds, remembered at once
     * as a first-seen pin of the keys served now. No words. Someone already added is said so; a
     * change from the keys this phone holds for them (a contact removed and added again over other
     * keys included) is the notice instead.
     */
    public func addContact(email: String, writer: String? = nil, firstSeen: String = "added") async throws -> Added {
        let contact = try await Auth.lookupContact(email: email, as: session)
        // From a mark: the account that wrote the item, which the address must be.
        if let writer, contact.userId.lowercased() != writer.lowercased() {
            throw ContactError.message("This isn’t the account that wrote it. Check the address, then try again.")
        }
        guard contact.upgraded else { throw ContactError.notUpgraded(contact.displayName) }
        return try await withGuardTurn { try await decidedAgain { try await addDecided(contact, firstSeen: firstSeen) } }
    }

    private func addDecided(_ contact: Contact, firstSeen: String) async throws -> Added {
        switch try await stand(contact, act: true, follow: true) {
        case .ok(let pin, _, _):
            clearChange(contact.userId)
            return .already(pin)
        case .notUpgraded:
            throw ContactError.notUpgraded(contact.displayName)
        case .succession(let pin), .changed(.some(let pin), _, _):
            return .changed(note(AccountChange(contactId: contact.userId, name: pin.name, email: contact.email)))
        case .changed(nil, _, _):
            return .changed(note(AccountChange(contactId: contact.userId, name: contact.name, email: contact.email)))
        case .new(let entry, _):
            let fresh = try contact.pin(verified: false, firstSeen: firstSeen)
            // Over nobody: a pin another device saved meanwhile is kept, or stops the add.
            let (pin, _) = try await commitTrust(contact.userId, entry: entry, target: fresh) { try $0.setPin(fresh, ifOver: nil) }
            return .added(pin)
        }
    }

    /*
     * Looks a person up and says where this phone stands with them: for Check it's Maya and the
     * changed-account notice. A followed succession is saved; nobody is added here.
     */
    public func lookup(email: String) async throws -> Lookup {
        let contact = try await Auth.lookupContact(email: email, as: session)
        let standing = try await withGuardTurn { try await stand(contact, act: true, follow: true) }
        var lookup = Lookup(contact: contact, pinned: nil, changed: false)
        switch standing {
        case .ok(let pin, _, let followed):
            lookup.pinned = pin
            lookup.followed = followed
        case .new:
            break
        case .succession(let pin), .notUpgraded(let pin):
            lookup.pinned = pin
        case .changed(let pin, let entry, let wasVerified):
            lookup.pinned = pin
            lookup.changed = true
            lookup.wasVerified = wasVerified
            lookup.heldFingerprint = entry.flatMap { keyCommitment(pin: $0.keys) } ?? pin?.commitment
        }
        if lookup.changed {
            note(AccountChange(contactId: contact.userId, name: lookup.pinned?.name ?? contact.name, email: contact.email))
        } else {
            clearChange(contact.userId)
        }
        lookup.verified = !lookup.changed && lookup.pinned?.trust == .verified
        return lookup
    }

    /*
     * The pin a person moves to when they accept keys this phone did not follow there (Continue, or
     * They match over new keys): the served keys, the signing keys this phone held kept as earlier
     * ones (what they signed reads as theirs with earlier keys), and what was shared with them
     * waiting to be sealed to the new keys. A family's word goes: the pin is this person's own now.
     */
    private func acceptedPin(_ before: ContactPin?, base: (signing: String, previous: [String])?, contact: Contact, keys: PinKeys) -> ContactPin {
        var pin = ContactPin(userId: contact.userId, email: contact.email, name: contact.name, keys: keys,
                             pinnedAt: ISO8601DateFormatter().string(from: Date()), firstSeen: before?.firstSeen ?? "added")
        var previous: [String] = []
        for key in (base?.previous ?? []) + [base?.signing].compactMap({ $0 }) where key != keys.signingPublicKey && !previous.contains(key) {
            previous.append(key)
        }
        pin.previousSigningKeys = previous.isEmpty ? nil : previous
        pin.resealShares = true
        return pin
    }

    /* What this phone trusted for a person: the settings pin where it agrees with the guard, else the guard's keys. */
    private func base(_ before: ContactPin?, _ entry: GuardEntry?, _ id: String) -> (signing: String, previous: [String])? {
        if let before, agreement(id, entry, before) != .changed { return (before.signingPublicKey, before.previousSigningKeys ?? []) }
        return entry.map { ($0.signingPublicKey, $0.previousSigningKeys) }
    }

    /*
     * Continue on "Maya's account changed" (6.7): the keys served now, looked up afresh, become a
     * first-seen pin, and what waited runs: what was shared with them is sealed again, to these
     * keys only. A verified pin loses its verified state; Check it's Maya restores it.
     */
    public func continueWith(_ change: AccountChange) async throws -> ContactPin {
        let contact = try await Auth.lookupContact(email: change.email, as: session)
        guard contact.userId.lowercased() == change.contactId.lowercased() else {
            throw ContactError.message("That address now belongs to a different account.")
        }
        guard contact.upgraded else { throw ContactError.notUpgraded(contact.displayName) }
        let pin = try await withGuardTurn {
            let settings = try await loadSettings()
            let before = settings.pin(of: contact.userId)
            let (entry, _) = try guardFor(contact.userId, pin: before, at: settings.version)
            let keys = try contact.pin(verified: false, firstSeen: nil).keys
            let target = acceptedPin(before, base: base(before, entry, contact.userId), contact: contact, keys: keys)
            return try await commitTrust(contact.userId, entry: entry, target: target) { try $0.setPin(target, ifOver: before) }.pin
        }
        clearChange(contact.userId)
        forgetLookups(of: contact.userId)
        return pin
    }

    /*
     * They match (6.6): a verified pin of the keys whose words were just compared. Over the keys
     * this phone held it stays as it was in every other way; over others it is a Continue that is
     * also a check. Only for an upgraded identity whose keys statement held.
     */
    public func theyMatch(_ found: Lookup) async throws -> ContactPin {
        let contact = found.contact
        let keys = try contact.pin(verified: true, firstSeen: nil).keys
        let pin = try await withGuardTurn {
            let settings = try await loadSettings()
            let before = settings.pin(of: contact.userId)
            let (entry, _) = try guardFor(contact.userId, pin: before, at: settings.version)
            let held = base(before, entry, contact.userId)
            let moved = held.map { $0.signing != contact.signingPublicKey } == true
                || (before.map { $0.encryptionPublicKey != contact.encryptionPublicKey } ?? false)
            var target: ContactPin
            if moved {
                target = acceptedPin(before, base: held, contact: contact, keys: keys)
            } else {
                target = (before ?? ContactPin(userId: contact.userId, email: contact.email, name: contact.name, keys: keys, pinnedAt: "", firstSeen: "added"))
                    .replacing(keys, pinnedAt: ISO8601DateFormatter().string(from: Date()), name: contact.name, email: contact.email)
                // The pin is the reader's own check now, not a family's word.
                target.trustedVia = nil
            }
            let wanted = target
            return try await commitTrust(contact.userId, entry: entry, target: wanted) { try $0.setPin(wanted, ifOver: before, verify: true) }.pin
        }
        clearChange(contact.userId)
        forgetLookups(of: contact.userId)
        // Shares to them still in an older suite (or waiting for new keys) are sealed again to the keys the pin holds.
        Task { _ = try? await self.upgradeShares() }
        return pin
    }

    /*
     * Removing forgets the pin and records the removal in the settings (2.8), so no device adds
     * them back on its own when they share something: it waits until the person opens it. This
     * phone's guard keeps what it saw.
     */
    public func remove(_ contactId: String) async throws {
        try await updateSettings { $0.removeContact(contactId, at: ISO8601DateFormatter().string(from: Date())) }
        clearChange(contactId)
        forgetLookups(of: contactId)
        forgetSigners()
    }

    // MARK: - Sharing and opening

    /*
     * The keys a share to a pinned contact is sealed to: behind the share sheet (`follow`, the
     * person's act), and when the server names the grantee (rotation, the upgrade pass). The
     * served keys must be the pinned ones, the pin must agree with this phone's guard, and a legacy
     * pin becomes first-seen first. Anything else shares nothing.
     */
    func trustGrantee(_ contact: Contact, follow: Bool) async throws -> (publicKey: Data, kem: Data) {
        try await withGuardTurn {
            let standing = try await stand(contact, act: true, follow: follow)
            switch standing {
            case .new, .changed(nil, _, _):
                throw ContactError.unpinned
            case .notUpgraded(let pin):
                throw ContactError.notUpgraded(pin.displayName)
            case .succession(let pin):
                throw ContactError.message("\(pin.firstName) updated their account. Share with them again to follow it.")
            case .changed(.some(let pin), _, _):
                throw AccountChangedError(change: note(AccountChange(contactId: pin.userId, name: pin.name, email: pin.email)))
            case .ok(let pin, _, _):
                // Same (or followed to them): the served ML-KEM key is the one the pin's digest names.
                guard let kem = contact.kemPublicKey, let bytes = try? base64urlDecode(value: kem) else { throw ContactError.notUpgraded(pin.displayName) }
                return (try base64urlDecode(value: pin.encryptionPublicKey), bytes)
            }
        }
    }

    /* The changed-account check behind a share sheet's row: looks them up; nothing is written. */
    public func shareeChanged(_ pin: ContactPin) async throws -> Bool {
        let contact = try await cachedLookup(pin.email)
        guard contact.userId.lowercased() == pin.userId.lowercased() else { return true }
        let standing = try await withGuardTurn { try await stand(contact, act: false, follow: false) }
        guard case .changed = standing else { return false }
        note(AccountChange(contactId: pin.userId, name: pin.name, email: pin.email))
        return true
    }

    /*
     * A contact looked up for display (the share sheet's rows), kept for a minute: the server allows
     * an account sixty lookups a minute, and Add and Share need theirs. Never what anything is sealed
     * to or opened with (those look up afresh); forgotten for a person on Continue, They match and
     * removal, and with the vault at sign-out.
     */
    func cachedLookup(_ email: String) async throws -> Contact {
        let key = email.lowercased()
        if let held = lookedUp[key], Date().timeIntervalSince(held.at) < Self.lookupKept { return held.contact }
        let contact = try await Auth.lookupContact(email: email, as: session)
        lookedUp[key] = (contact, Date())
        return contact
    }

    static let lookupKept: TimeInterval = 60

    func forgetLookups(of contactId: String) {
        let id = contactId.lowercased()
        lookedUp = lookedUp.filter { $0.value.contact.userId.lowercased() != id }
    }

    /*
     * Which keys to open a share with (6.4). From someone pinned, the pinned keys, only when the
     * served keys are those or a signed succession leads to them, and the pin agrees with this
     * phone's guard. From someone this account never had as a contact, the keys the share came with
     * are pinned first-seen and it opens. Two things wait for the person's own Open (`explicit`):
     * following a signed succession, and adding back someone this account removed or this phone
     * acted on before (its guard holds them, their pin gone), so a removal sticks.
     */
    func trustGranter(_ granter: SharedWithMeView.Granter, explicit: Bool, pass: MountPass? = nil) async throws -> PinnedGranter {
        // One verdict per granter and keys within a pass: the same person's other shares under the same keys
        // are judged alike, and other keys (a change mid-list) never take a verdict made over these.
        let key = MountPass.key(granter, explicit: explicit)
        if let held = pass?.verdicts[key] { return try held.get() }
        let verdict: Result<PinnedGranter, Error>
        do { verdict = .success(try await judgeGranter(granter, explicit: explicit, pass: pass)) } catch { verdict = .failure(error) }
        pass?.verdicts[key] = verdict
        return try verdict.get()
    }

    private func judgeGranter(_ granter: SharedWithMeView.Granter, explicit: Bool, pass: MountPass?) async throws -> PinnedGranter {
        let contact = Contact(granter: granter)
        let first = contact.firstName
        let removedWords = "You removed \(first) from your contacts. Open this to add them again."
        return try await withGuardTurn {
            try await decidedAgain {
                var standing: Standing
                do {
                    standing = try await stand(contact, act: true, follow: explicit, pass: pass)
                } catch {
                    pass?.settings = nil
                    throw error
                }
                if case .new(let entry, let removed) = standing, !explicit, removed || entry != nil {
                    throw GranterTrust.waiting(removed ? removedWords : "Open this to add \(first) to your contacts.")
                }
                if case .succession = standing { throw GranterTrust.waiting("\(first) updated their account. Open this to carry on.") }
                if case .new(let entry, _) = standing {
                    guard contact.upgraded else { throw GranterTrust.unverified("\(first) needs to sign in to HushOS once more before this opens.") }
                    let fresh = try contact.pin(verified: false, firstSeen: "shared-with-me")
                    do {
                        // Listing never undoes a removal: one recorded on any attempt of this save stops the add.
                        // Saved (or refused against settings newer than the pass read): the next share reads them again.
                        defer { pass?.settings = nil }
                        let (pin, entry) = try await commitTrust(contact.userId, entry: entry, target: fresh) { settings in
                            if !explicit, settings.removed(contact.userId) { throw GranterTrust.waiting(removedWords) }
                            try settings.setPin(fresh, ifOver: nil)
                        }
                        standing = .ok(pin: pin, entry: entry, followed: false)
                    } catch ContactError.message(let words) where words == Settings.contactsFull {
                        throw GranterTrust.unverified(Settings.contactsFull)
                    }
                }
                switch standing {
                case .notUpgraded(let pin):
                    throw GranterTrust.unverified("\(pin.firstName) needs to sign in to HushOS once more before this opens.")
                case .ok(let pin, _, _):
                    guard let keys = pin.granterKeys(contact.served) else {
                        throw GranterTrust.changed(note(AccountChange(contactId: contact.userId, name: pin.name, email: pin.email)))
                    }
                    return keys
                case .changed(let pin, _, _):
                    throw GranterTrust.changed(note(AccountChange(contactId: contact.userId, name: pin?.name ?? contact.name, email: pin?.email ?? contact.email)))
                case .new, .succession:
                    throw GranterTrust.changed(note(AccountChange(contactId: contact.userId, name: contact.name, email: contact.email)))
                }
            }
        }
    }

    /*
     * The settings pins and this phone's guard entries as one view, read in the guard's turn, for
     * the readers that judge from them (who wrote what, and Verified on Contacts). Every act left
     * pending is settled first, and a pin that came with the settings with nothing for it in the
     * guard yet (a new phone, one signed back into) is written to the guard before it is used, so a
     * later change made on another device is met here as a change, never as first use.
     */
    func guardedView() async throws -> (pins: [String: ContactPin], entries: [String: GuardEntry]) {
        try await withGuardTurn {
            let settings = try await loadSettings()
            let store = contactGuard
            func read() throws -> ([String: GuardEntry], [String: PendingAct]) {
                do { return (try store.entries(), try store.pendingAll()) } catch { throw GuardError.unreadable }
            }
            var (entries, pending) = try read()
            var due = Set(pending.keys)
            for pin in settings.contacts.values where entries[pin.userId.lowercased()] == nil && pin.held { due.insert(pin.userId.lowercased()) }
            if !due.isEmpty {
                for id in due {
                    let pin = settings.pin(of: id)
                    let (entry, kept) = try guardFor(id, pin: pin, at: settings.version)
                    guard entry == nil, let pin, pin.held else { continue }
                    _ = try rememberKeys(id, nil, pin, keep: kept)
                }
                (entries, _) = try read()
            }
            return (settings.contacts, entries)
        }
    }

    /*
     * Where each contact stands on this phone, from the settings and the guard alone (no lookup):
     * Verified only for a verified pin that agrees with the guard; a pin that disagrees with it is
     * an account changed. A guard that can't be read fails the whole list: nobody is shown verified.
     */
    public func contactStandings() async throws -> [String: (verified: Bool, changed: Bool)] {
        let (pins, entries) = try await guardedView()
        var out: [String: (verified: Bool, changed: Bool)] = [:]
        for pin in pins.values {
            let held = agreement(pin.userId, entries[pin.userId.lowercased()], pin)
            out[pin.userId.lowercased()] = (held != .changed && pin.trust == .verified, held == .changed)
        }
        return out
    }

    /*
     * Who may have written what Drive lists, beside this account: every pin, verified or
     * first-seen, as the guard allows. A pin that disagrees with the guard vouches for nothing, and
     * the guard's keys stand in for it, never verified.
     */
    func effectivePins() async throws -> [ContactPin] {
        let (pins, entries) = try await guardedView()
        var out: [ContactPin] = []
        for pin in pins.values {
            let entry = entries[pin.userId.lowercased()]
            if agreement(pin.userId, entry, pin) != .changed {
                if pin.held { out.append(pin) }
            } else if let entry {
                var held = ContactPin(userId: pin.userId, email: pin.email, name: pin.name, keys: entry.keys, pinnedAt: pin.pinnedAt, firstSeen: nil)
                held.previousSigningKeys = entry.previousSigningKeys
                out.append(held)
            }
        }
        return out
    }
}

extension ContactPin {
    /*
     * The granter's keys to open a share with (`granterKeysOf` in trust.ts): the pinned Ed25519
     * key, and the served ML-DSA key only if its digest is the pin's. Nil otherwise.
     */
    func granterKeys(_ served: ServedContactKeys) -> PinnedGranter? {
        guard let mlDsa = served.mlDsaPublicKey, let hash = mlDsaPublicKeyHash, digestOf(mlDsa) == hash,
              let signing = try? base64urlDecode(value: signingPublicKey), let ml = try? base64urlDecode(value: mlDsa) else { return nil }
        return PinnedGranter(signingPublicKey: signing, mlDsaPublicKey: ml, replacedKeys: !(previousSigningKeys ?? []).isEmpty, name: displayName)
    }
}

extension Settings {
    /*
     * The save of an act that writes `target`, decided again on every attempt of the compare-and-set:
     * a pin of the target's own keys already there is kept as it is (unless `verify` asks for this
     * person's own check over first-seen keys or a family's word); the target is written only over
     * the pin the act was decided from (`expected`, nil for nobody); anything else stops the act.
     */
    mutating func setPin(_ target: ContactPin, ifOver expected: ContactPin?, verify: Bool = false) throws {
        let current = pin(of: target.userId)
        if let current, ContactPin.sameKeys(current, target), !verify || (current.trust == .verified && current.trustedVia == nil) {
            forgetRemoval(target.userId)
            return
        }
        guard ContactPin.sameKeys(current, expected) else { throw ContactError.moved }
        try setPinOnce(target)
    }
}

/*
 * One pass over what was shared with this account (`mountShares`): the settings read once and
 * reused until something this pass did saved them, and one verdict per granter and the keys their
 * share came with.
 */
// Only ever read and written on the vault's actor (a test hands one in and reads nothing back).
final class MountPass: @unchecked Sendable {
    var settings: Settings?
    var verdicts: [String: Result<PinnedGranter, Error>] = [:]

    static func key(_ granter: SharedWithMeView.Granter, explicit: Bool) -> String {
        [granter.id.lowercased(), granter.keyVersion.map(String.init) ?? "-", granter.encryptionPublicKey, granter.signingPublicKey ?? "-",
         granter.mlDsaPublicKey ?? "-", granter.kemPublicKey ?? "-", granter.keysSignature ?? "-", explicit ? "open" : "list"].joined(separator: "|")
    }
}
