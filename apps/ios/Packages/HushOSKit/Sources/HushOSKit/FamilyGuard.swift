import Foundation
import HushOSCore

/*
 * The family guard (docs/optional-verification.md 2.8, "per family"; the web's
 * createIndexedDbFamilyGuard in lib/contact-guard.ts): the latest group pin this phone accepted for
 * each family, kept apart from the settings and the device record. Acceptance takes it as a mark
 * like any pin, so a family that once was here is never taken on first use again, and a chain
 * short of what this phone accepted is a rollback, whatever the server answers meanwhile: a
 * `not-member` answer never clears it, and neither does anything else the server says.
 *
 * Beside the contact guard (`local/guard/<slot>.families.json`, the same slot, found without a
 * key), sealed by the core in the same way (`contact_guard_seal`, kind `families`, under a key from
 * the settings key, its envelope kept beside the record), out of backups, and deleted with the
 * contact guard on every wipe (`AccountStore`), so a phone signed back in holds no guard, as a new
 * device. The app and both extensions share it: every write is one read-merge-write under the
 * contact guard's `flock` (`local/guard.lock`), only while the session it was read for is still
 * stored and no sign-out came since. It only ever moves up: each write is the core's `merge_pin`
 * against what is stored, so a late write of an older pin changes nothing, and a pin of another
 * history is refused (`FamilyGuardConflict`), never written over it. A record that is there and
 * doesn't open is `unreadable`, never "nothing held"; a write that can't be kept is `unsaved`.
 */

/* A family guard of another history than the one stored: nothing was written (the web's GuardConflictError). */
public struct FamilyGuardConflict: Error, LocalizedError, Equatable, WordedError {
    public var errorDescription: String? { "This family looks different on this device. Nothing was saved." }
}

/* A group pin as the store keeps it: the core's `GroupPin`, which isn't Codable. */
struct StoredGroupPin: Codable, Equatable {
    let firstEd25519PublicKey: String
    let firstMlDsaPublicKeyDigest: String
    let checkedAt: String
    let keyVersion: UInt64
    let groupKeyDigest: String
    let rosterVersion: UInt64
    let rosterDigest: String
    let areas: [String: UInt64]

    init(_ pin: GroupPin) {
        firstEd25519PublicKey = pin.firstEd25519PublicKey
        firstMlDsaPublicKeyDigest = pin.firstMlDsaPublicKeyDigest
        checkedAt = pin.checkedAt
        keyVersion = pin.keyVersion
        groupKeyDigest = pin.groupKeyDigest
        rosterVersion = pin.rosterVersion
        rosterDigest = pin.rosterDigest
        areas = pin.areas
    }

    /* The pin, checked as the core checks a settings pin; nil when it isn't one (read as unreadable). */
    func pin(_ groupId: String) -> GroupPin? {
        try? groupPinCheck(groupId: groupId, pin: GroupPin(
            firstEd25519PublicKey: firstEd25519PublicKey, firstMlDsaPublicKeyDigest: firstMlDsaPublicKeyDigest, checkedAt: checkedAt,
            keyVersion: keyVersion, groupKeyDigest: groupKeyDigest, rosterVersion: rosterVersion, rosterDigest: rosterDigest, areas: areas
        ))
    }
}

struct FamilyGuardStore: Sendable {
    /* `local/guard`, the contact guard's folder: one lock, one wipe. */
    let folder: URL
    let owner: AccountOwner
    var activity: FileLock.Activity = .system
    var generation: GuardGeneration = .process
    /* Whether the session this guard is kept for is still the one stored (as the contact guard's). */
    var signedIn: @Sendable () -> Bool = { true }
    /* The settings key the record is sealed under, and its envelope: nil when it could not be had. */
    var key: MarksKey?

    struct Sealed: Codable {
        var v = 1
        let key: ContactGuardStore.Sealed.Kept
        let record: String
    }

    /* One account's family guards, by lowercase family id. */
    struct Record: Codable, Equatable {
        var v = 1
        var families: [String: StoredGroupPin] = [:]
    }

    private static let kind = "families"

    static func shared(session: SharedKeychain.Session) -> FamilyGuardStore {
        let token = session.token
        return FamilyGuardStore(folder: Unbacked.local.appendingPathComponent("guard", isDirectory: true), owner: AccountOwner(session)) {
            (Auth.testSession ?? SharedKeychain.session)?.token == token
        }
    }

    /* The contact guard's lock, beside the folder and never deleted. */
    private var lockPath: String { folder.path + ".lock" }

    var slot: String { (try? contactGuardSlot(origin: owner.origin, userId: owner.userId)) ?? "-" }

    var file: URL { folder.appendingPathComponent("\(slot).families.json") }

    private func sealed() throws -> Sealed? {
        let data: Data
        do {
            data = try Data(contentsOf: file)
        } catch {
            // Only a file confirmed missing is "nothing stored": a folder that can't be searched or read also makes
            // `fileExists` say no, and read as none it would be first use for everyone.
            if GuardFile.missing(error) { return nil }
            throw GuardError.unreadable
        }
        guard let sealed = try? JSONDecoder().decode(Sealed.self, from: data), sealed.v == 1 else { throw GuardError.unreadable }
        return sealed
    }

    /* The settings key's envelope the record was sealed under; nil for no record. */
    func keptKey() -> SettingsKeyEnvelope? {
        (try? sealed())?.map { SettingsKeyEnvelope(nonce: $0.key.nonce, ciphertext: $0.key.ciphertext) }
    }

    /* Empty when there is none; `unreadable` when one is there and doesn't open under this key, or holds a pin that isn't one. */
    func record() throws -> Record {
        guard let sealed = try sealed() else { return Record() }
        guard let key, let json = try? contactGuardOpen(settingsKey: key.key, userId: owner.userId, slot: slot, kind: Self.kind, envelope: sealed.record),
              let record = try? JSONDecoder().decode(Record.self, from: Data(json.utf8)), record.v == 1,
              record.families.allSatisfy({ $0.value.pin($0.key) != nil }) else { throw GuardError.unreadable }
        return record
    }

    /* The guard this phone holds for a family: nil for none; throws `unreadable` when it could not be read. */
    func family(_ groupId: String) throws -> GroupPin? {
        let id = groupId.lowercased()
        return try record().families[id].flatMap { $0.pin(id) }
    }

    /*
     * `pin` merged into what is stored for the family (never lower), and what is stored after.
     * Behind what is stored, or adding nothing to it: nothing written. Another history:
     * `FamilyGuardConflict`, nothing written.
     */
    @discardableResult
    func keep(_ groupId: String, _ pin: GroupPin) throws -> GroupPin {
        let id = groupId.lowercased()
        var after: GroupPin?
        try change { record in
            let held = record.families[id].flatMap { $0.pin(id) }
            switch try mergePin(groupId: id, current: held, next: pin, opened: []) {
            case .conflict:
                throw FamilyGuardConflict()
            case .behind:
                after = held
                return false
            case .merged(let merged):
                guard pinAhead(current: held, next: merged) else {
                    after = held
                    return false
                }
                record.families[id] = StoredGroupPin(merged)
                after = merged
                return true
            }
        }
        guard let after else { throw GuardError.unsaved }
        return after
    }

    /*
     * One read-merge-write under the lock; `body` says whether there is anything to write. A
     * record that doesn't read is never written over; a sign-out since the write began, or a
     * session no longer stored, writes nothing. Not had within the wait (another process is
     * writing): `raced`, said as the contact guard says it, never as a full disk.
     */
    private func change(_ body: (inout Record) throws -> Bool) throws {
        let began = generation.value
        guard signedIn() else { throw GuardError.unsaved }
        var outcome: Result<Void, Error> = .failure(GuardError.raced)
        try? FileManager.default.createDirectory(at: folder.deletingLastPathComponent(), withIntermediateDirectories: true)
        FileLock.withLock(lockPath, activity: activity) {
            outcome = Result {
                guard signedIn(), generation.value == began else { throw GuardError.unsaved }
                var record = try self.record()
                guard try body(&record) else { return }
                guard let key else { throw GuardError.unsaved }
                Unbacked.folder(folder)
                do {
                    let json = String(decoding: try JSONEncoder().encode(record), as: UTF8.self)
                    let envelope = try contactGuardSeal(settingsKey: key.key, userId: owner.userId, slot: slot, kind: Self.kind, record: json)
                    let kept = ContactGuardStore.Sealed.Kept(nonce: key.envelope.nonce, ciphertext: key.envelope.ciphertext)
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
}

extension Vault {
    /* The family guard, with the settings key it opens under (as the contact guard finds its own). */
    func familyGuardStore(create: Bool) async -> FamilyGuardStore {
        var store = familyGuardOverride ?? FamilyGuardStore.shared(session: session)
        store.key = (try? await marksKey(kept: store.keptKey(), create: create)) ?? nil
        return store
    }

    /* Tests: this vault's family guard, in a folder of the test's own. */
    func adopt(familyGuard store: FamilyGuardStore) { familyGuardOverride = store }

    /* Tests: what runs right after each family guard write (a stop there, as a crash would). */
    func adopt(afterFamilyGuard hook: (@Sendable () throws -> Void)?) { afterFamilyGuard = hook }

    /*
     * The family guard for the core: what this phone holds, or `unreadable` when its store could
     * not be read, which the core refuses (never first use, and nothing taken on it). Read afresh
     * for every call, so a guard another process stored meanwhile is a mark here too.
     */
    func heldFamilyGuard(_ groupId: String) async -> FamilyGuard {
        do {
            guard let pin = try await familyGuardStore(create: false).family(groupId) else { return .absent }
            return .held(pin: pin)
        } catch {
            return .unreadable
        }
    }

    /*
     * A guard an acceptance (or a wipe) handed back, stored (merged, never lower) before anything
     * else of it is. Throws `unsaved` when it isn't on disk, `raced` when another process held the
     * lock past the wait, `FamilyGuardConflict` for another history.
     */
    @discardableResult
    func keepFamilyGuard(_ groupId: String, _ pin: GroupPin) async throws -> GroupPin {
        let kept: GroupPin
        do {
            kept = try await familyGuardStore(create: true).keep(groupId, pin)
        } catch let error as FamilyGuardConflict {
            throw error
        } catch GuardError.raced {
            // The lock was busy (another process writing the guard): try again, never "free up some space".
            throw GuardError.raced
        } catch {
            throw GuardError.unsaved
        }
        try afterFamilyGuard?()
        return kept
    }
}
