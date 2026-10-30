import Foundation
import HushOSCore

/*
 * The contact guard (docs/optional-verification.md 2.8; the web's lib/contact-guard.ts): what
 * this phone keeps, per account and per person, of the keys it last acted on, apart from the
 * settings document. A newer copy of the settings that drops or swaps a pin (an older copy saved
 * over at a higher sequence, or an empty one) is met here as a change, never as first use, since
 * nothing in the settings can stand in for what this phone saw. Never written to the settings and
 * never cleared by anything the server answers.
 *
 * One record per account (`AccountOwner`: the same user id on another server is another
 * account) in `local/guard/<slot>.json`, the slot the core's `contact_guard_slot` (a digest of
 * the server and the user id, found without a key), so the file name says neither whose it is
 * nor whom it is about. Sealed by the core (`contact_guard_seal`) under a key from the settings
 * key, as the web's guard and the rollback marks are, with the settings key's envelope as the
 * server keeps it beside the record, so the app and both extensions open it without asking the
 * server (`MarksKey`, the marks' own path). A record that is there and does not open (no account
 * key, another settings key, damaged or swapped bytes) is unreadable, never "nothing recorded".
 * Out of backups (`Unbacked`), deleted on every wipe with the rest of the account
 * (`AccountStore`), so a phone signed back in trusts the settings as a new device does.
 *
 * The app, the Files extension and the share extension share it, so every write is one
 * read-change-write under an exclusive `flock` on `local/guard.lock` (FileLock), only while the
 * session it was read for is still stored and no sign-out came since; sign-out deletes the
 * records under the same lock. A commit lands only over the revision it read (`raced`
 * otherwise), so a delayed write never puts an older entry back. A record that is there and
 * doesn't read is `unreadable`, never "nothing recorded"; a write that can't be kept is `unsaved`.
 */
public enum GuardWords {
    public static let unreadable = "HushOS couldn’t check this right now."
    public static let unsaved = "HushOS couldn’t save this on this device. Free up some space, then try again."
    /* Another process moved an entry between an act's read and its write (the web's TrustMovedError words). */
    public static let moved = "Your contacts changed on another device. Try again."
}

public enum GuardError: Error, LocalizedError, Equatable, WordedError {
    case unreadable, unsaved, raced
    public var errorDescription: String? {
        switch self {
        case .unreadable: GuardWords.unreadable
        case .unsaved: GuardWords.unsaved
        case .raced: GuardWords.moved
        }
    }
}

/*
 * A trust-changing act on its way: the key commitment it moves to, from `revision`, and `base`,
 * the stored settings sequence its save was sent over (the server's compare-and-set lands it
 * only while that is still stored).
 */
struct PendingAct: Codable, Equatable, Sendable {
    var target: String
    var revision: UInt64
    var at: String
    var base: UInt64?
}

/* A guard entry as stored: the core's `GuardEntry`, which isn't Codable. */
struct StoredGuardEntry: Codable, Equatable {
    let revision: UInt64
    let keyVersion: UInt64?
    let encryptionPublicKey: String
    let signingPublicKey: String
    let mlDsaPublicKeyHash: String
    let kemPublicKeyHash: String
    let previousSigningKeys: [String]
    let verified: Bool

    init(_ entry: GuardEntry) {
        revision = entry.revision
        keyVersion = entry.keyVersion
        encryptionPublicKey = entry.encryptionPublicKey
        signingPublicKey = entry.signingPublicKey
        mlDsaPublicKeyHash = entry.mlDsaPublicKeyHash
        kemPublicKeyHash = entry.kemPublicKeyHash
        previousSigningKeys = entry.previousSigningKeys
        verified = entry.verified
    }

    /* The entry, or nil when it is not one the guard could have written: read as unreadable. */
    var entry: GuardEntry? {
        guard revision >= 1, !encryptionPublicKey.isEmpty, !signingPublicKey.isEmpty, !mlDsaPublicKeyHash.isEmpty,
              !kemPublicKeyHash.isEmpty, !previousSigningKeys.contains(where: \.isEmpty) else { return nil }
        let entry = GuardEntry(revision: revision, keyVersion: keyVersion, encryptionPublicKey: encryptionPublicKey, signingPublicKey: signingPublicKey,
                               mlDsaPublicKeyHash: mlDsaPublicKeyHash, kemPublicKeyHash: kemPublicKeyHash, previousSigningKeys: previousSigningKeys,
                               verified: verified)
        // Keys that make no commitment would match nothing: a damaged entry, never one to judge by.
        return keyCommitment(pin: entry.keys) == nil ? nil : entry
    }
}

extension GuardEntry {
    /* The entry's keys as a pin's: what its key commitment is worked out over. */
    var keys: PinKeys {
        PinKeys(keyVersion: keyVersion, encryptionPublicKey: encryptionPublicKey, signingPublicKey: signingPublicKey,
                mlDsaPublicKeyHash: mlDsaPublicKeyHash, kemPublicKeyHash: kemPublicKeyHash, fingerprint: "")
    }
}

/*
 * Moved by every sign-out in this process: a write begun before one keeps nothing. Shared by
 * every store in the process (and a test's own instance), as the rollback marks' `MarkFloor` is.
 */
final class GuardGeneration: @unchecked Sendable {
    static let process = GuardGeneration()
    private let lock = NSLock()
    private var current: UInt64 = 0
    var value: UInt64 { lock.withLock { current } }
    func bump() { lock.withLock { current &+= 1 } }
}

struct ContactGuardStore: Sendable {
    let folder: URL
    let owner: AccountOwner
    var activity: FileLock.Activity = .system
    var generation: GuardGeneration = .process
    /* Whether the session this guard is kept for is still the one stored (see RollbackMarkStore.signedIn). */
    var signedIn: @Sendable () -> Bool = { true }
    /* The settings key the record is sealed under, and its envelope: nil when it could not be had (unreadable, unsaved). */
    var key: MarksKey?

    /* The record on disk: the sealed guard and the settings key's envelope it opens under. */
    struct Sealed: Codable {
        struct Kept: Codable, Equatable {
            let nonce: String
            let ciphertext: String
        }

        var v = 2
        let key: Kept
        let record: String
    }

    private static let kind = "record"

    /* The app group's guard for the vault signed in with `session`. */
    static func shared(session: SharedKeychain.Session) -> ContactGuardStore {
        let token = session.token
        return ContactGuardStore(folder: Unbacked.local.appendingPathComponent("guard", isDirectory: true), owner: AccountOwner(session)) {
            (Auth.testSession ?? SharedKeychain.session)?.token == token
        }
    }

    /* One account's guard: its entries and acts left pending, by lowercased contact id. */
    struct Record: Codable, Equatable {
        var v = 1
        var entries: [String: StoredGuardEntry] = [:]
        var pending: [String: PendingAct] = [:]
    }

    /* Beside the folder and never deleted, as the marks' lock: a deleted lock lets two writers lock two files. */
    private var lockPath: String { folder.path + ".lock" }

    var slot: String { (try? contactGuardSlot(origin: owner.origin, userId: owner.userId)) ?? "-" }

    var file: URL { folder.appendingPathComponent("\(slot).json") }

    /* What is on disk: nil when nothing is; `unreadable` when something is that isn't a sealed guard. */
    private func sealed() throws -> Sealed? {
        let data: Data
        do {
            data = try Data(contentsOf: file)
        } catch {
            if !FileManager.default.fileExists(atPath: file.path) { return nil }
            throw GuardError.unreadable
        }
        guard let sealed = try? JSONDecoder().decode(Sealed.self, from: data), sealed.v == 2 else { throw GuardError.unreadable }
        return sealed
    }

    /* The settings key's envelope the record was sealed under, to open that key with; nil for no record. */
    func keptKey() -> SettingsKeyEnvelope? {
        (try? sealed())?.map { SettingsKeyEnvelope(nonce: $0.key.nonce, ciphertext: $0.key.ciphertext) }
    }

    /*
     * The record: empty when there is none; `unreadable` when one is there and doesn't open under
     * this store's key (or there is none), or holds an entry that isn't one.
     */
    func record() throws -> Record {
        guard let sealed = try sealed() else { return Record() }
        guard let key, let json = try? contactGuardOpen(settingsKey: key.key, userId: owner.userId, slot: slot, kind: Self.kind, envelope: sealed.record),
              let record = try? JSONDecoder().decode(Record.self, from: Data(json.utf8)), record.v == 1,
              record.entries.values.allSatisfy({ $0.entry != nil }) else { throw GuardError.unreadable }
        return record
    }

    func entry(_ contactId: String) throws -> GuardEntry? { try record().entries[contactId.lowercased()]?.entry }

    func pending(_ contactId: String) throws -> PendingAct? { try record().pending[contactId.lowercased()] }

    func entries() throws -> [String: GuardEntry] { try record().entries.compactMapValues(\.entry) }

    func pendingAll() throws -> [String: PendingAct] { try record().pending }

    /* Writes `act` for the person, durably, before the settings save it names. */
    func putPending(_ contactId: String, _ act: PendingAct) throws {
        try change { $0.pending[contactId.lowercased()] = act }
    }

    /*
     * Writes `entry` and deletes the pending record in one write, only over `revision` (0 for none
     * stored): a write that read an earlier revision than is stored throws `raced` and changes
     * nothing. `keep`, an act whose save may still land: kept instead, moved to the new revision.
     */
    func commit(_ contactId: String, _ entry: GuardEntry, over revision: UInt64, keep: PendingAct? = nil) throws {
        let id = contactId.lowercased()
        try change { record in
            guard (record.entries[id]?.revision ?? 0) == revision else { throw GuardError.raced }
            record.entries[id] = StoredGuardEntry(entry)
            if var kept = keep {
                kept.revision = entry.revision
                record.pending[id] = kept
            } else {
                record.pending[id] = nil
            }
        }
    }

    func dropPending(_ contactId: String) throws {
        try change { $0.pending[contactId.lowercased()] = nil }
    }

    /*
     * One read-change-write under the lock. A record that doesn't read is never written over; a
     * sign-out since the write began, or a session no longer stored, writes nothing.
     */
    private func change(_ body: (inout Record) throws -> Void) throws {
        let began = generation.value
        guard signedIn() else { throw GuardError.unsaved }
        // Not had (another process holds it past the wait): someone else is writing, so decide again (`raced`).
        var outcome: Result<Void, Error> = .failure(GuardError.raced)
        try? FileManager.default.createDirectory(at: folder.deletingLastPathComponent(), withIntermediateDirectories: true)
        FileLock.withLock(lockPath, activity: activity) {
            outcome = Result {
                guard signedIn(), generation.value == began else { throw GuardError.unsaved }
                var record = try self.record()
                try body(&record)
                guard let key else { throw GuardError.unsaved }
                Unbacked.folder(folder)
                do {
                    let json = String(decoding: try JSONEncoder().encode(record), as: UTF8.self)
                    let envelope = try contactGuardSeal(settingsKey: key.key, userId: owner.userId, slot: slot, kind: Self.kind, record: json)
                    let kept = Sealed.Kept(nonce: key.envelope.nonce, ciphertext: key.envelope.ciphertext)
                    try JSONEncoder().encode(Sealed(key: kept, record: envelope)).write(to: file, options: .atomic)
                } catch {
                    throw GuardError.unsaved
                }
                // Signed out while this wrote: what it wrote goes too.
                guard signedIn(), generation.value == began else {
                    try? FileManager.default.removeItem(at: file)
                    throw GuardError.unsaved
                }
            }
        }
        try outcome.get()
    }

    /* Sign-out: every account's guard on this phone, under the lock, so a write holding it finishes first and is deleted. */
    func deleteAll() {
        generation.bump()
        let delete = { _ = try? FileManager.default.removeItem(at: folder) }
        if !FileLock.withLock(lockPath, activity: activity, delete) {
            delete()
            FileLock.withLock(lockPath, activity: activity, delete)
        }
    }
}
