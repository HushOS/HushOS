import Foundation
import HushOSCore

/*
 * Rollback marks (docs/integrity-design.md, "Rollback marks"; the web's lib/rollback-marks.ts):
 * the highest settings sequence and own identity key version this phone has seen for the
 * account, and the highest identity version it has opened. The server keeps the settings and
 * the identity and could hand back an older copy of either; a phone that has seen more refuses
 * it. Per account, never lowered, through a succession and a master-key rotation.
 *
 * Sealed, and the account's: one record per account in `local/marks/<slot>.json`, sealed by the
 * core under a key from the settings key (`rollback_marks_update`), so what the phone keeps says
 * neither whose marks they are nor what they count without the account's keys. The slot is a
 * digest of the user id, found without a key, so a record that is there and does not open
 * (damaged, swapped, or under another settings key) is refused (`MarksWords.unreadable`), never
 * read as none. Beside the marks sits the settings key's envelope as the server keeps it
 * (wrapped under the account key), so the marks open without asking the server. Signing out,
 * account deletion and a removal delete them with everything else of the account
 * (`AccountStore`): a phone signed back in trusts the server as a new device does.
 *
 * A mark that cannot be kept fails the step it guards (`MarksWords.unsaved`): an identity or
 * settings are never taken without their mark. What a raise asked for still counts in this
 * process at once (`MarkFloor`), so a raise the system gave no time to write still refuses a
 * rollback here (an upgraded identity served as version 1 again would mint a second ML-DSA key)
 * and goes into the next write. The app and its extensions share the records, so every write
 * is one read-open-raise-seal under an exclusive `flock` on `local/marks/.lock` (FileLock).
 *
 * Earlier versions kept the marks in the clear, by digest, in `local/settings-marks.json` and
 * `local/identity-marks.json`, across sign-outs. The account's entries are folded into the
 * sealed record the first time it is read or raised and then removed; sign-out deletes the files.
 */
public enum MarksWords {
    public static let unreadable = "HushOS couldn’t read what this phone last saw of your account, so nothing was opened. Sign out and sign in again to start this phone afresh."
    public static let unsaved = "HushOS couldn’t record what this phone has seen of your account, so nothing was opened. Try again."
}

/* The settings key the marks are sealed under, and its envelope as the server keeps it. */
struct MarksKey: Sendable {
    let key: Data
    let envelope: SettingsKeyEnvelope
}

/*
 * The settings key for the marks: the kept envelope's when it opens under the account key, else
 * the server's; made only with `create` (a raise with nothing kept). Nil when the account has none
 * and none may be made. Throws when it could not ask.
 */
typealias MarksKeys = @Sendable (_ kept: SettingsKeyEnvelope?, _ create: Bool) async throws -> MarksKey?

extension RollbackMarks {
    static let none = RollbackMarks(settings: 0, settingsDocument: false, identity: 0, identityVersion: 0)

    /* `self` raised to at least `other`, field by field. */
    func highest(_ other: RollbackMarks) -> RollbackMarks {
        RollbackMarks(
            settings: max(settings, other.settings),
            settingsDocument: settingsDocument || other.settingsDocument,
            identity: max(identity, other.identity),
            identityVersion: max(identityVersion, other.identityVersion)
        )
    }

    /* Whether `self` holds at least what `other` says. */
    func holds(_ other: RollbackMarks) -> Bool { highest(other) == self }
}

struct RollbackMarkStore: Sendable {
    let folder: URL
    var activity: FileLock.Activity = .system
    var floor: MarkFloor = .process

    static var shared: RollbackMarkStore { RollbackMarkStore(folder: Unbacked.local.appendingPathComponent("marks", isDirectory: true)) }

    /* What a slot's file holds: the sealed marks and the settings key's envelope they open under. */
    struct Record: Codable, Equatable {
        struct Kept: Codable, Equatable {
            let nonce: String
            let ciphertext: String
        }

        let marks: String
        let key: Kept?
    }

    private var lockPath: String { folder.appendingPathComponent(".lock").path }

    /* The plaintext files of earlier versions, beside the folder. */
    var legacyFiles: [URL] {
        let local = folder.deletingLastPathComponent()
        return ["settings-marks.json", "identity-marks.json"].map { local.appendingPathComponent($0) }
    }

    private func file(_ user: String) throws -> URL {
        // Base64url: letters, digits, '-' and '_' only, so a file name as it is.
        folder.appendingPathComponent("\(try rollbackMarksSlot(userId: user)).json")
    }

    /* The record at `url`: nil when there is none, unreadable when there is one that doesn't parse. */
    private func record(_ url: URL) throws -> Record? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        guard let record = try? JSONDecoder().decode(Record.self, from: data) else { throw AuthError.message(MarksWords.unreadable) }
        return record
    }

    /*
     * This phone's marks for the account, with this process's raises in. Nothing stored reads as
     * none (a new device, or one signed out of); a record that is there and does not open is
     * `MarksWords.unreadable`. Plaintext marks of earlier versions count, and are sealed.
     */
    func read(userId: String, keys: MarksKeys) async throws -> RollbackMarks {
        let user = userId.lowercased()
        let earlier = legacy(user, encryptionPublicKeys: [])
        if !earlier.keys.isEmpty {
            do {
                return try await raise(userId: user, to: .none, encryptionPublicKeys: [], keys: keys)
            } catch AuthError.message(let text) where text == MarksWords.unsaved {
                // Not sealed this time: the plaintext stays, and counts.
                return try await stored(user, keys: keys).highest(earlier.marks).highest(floor.value(user))
            }
        }
        return try await stored(user, keys: keys).highest(floor.value(user))
    }

    private func stored(_ user: String, keys: MarksKeys) async throws -> RollbackMarks {
        let url = try file(user)
        guard let record = try record(url) else { return .none }
        let key: MarksKey?
        do {
            key = try await keys(record.key.map { SettingsKeyEnvelope(nonce: $0.nonce, ciphertext: $0.ciphertext) }, false)
        } catch is CoreError {
            throw AuthError.message(MarksWords.unreadable)
        }
        // A record kept with no settings key served to open it: refused, never "none".
        guard let key else { throw AuthError.message(MarksWords.unreadable) }
        do {
            return try rollbackMarksUpdate(settingsKey: key.key, userId: user, envelope: record.marks, to: .none).marks
        } catch {
            throw AuthError.message(MarksWords.unreadable)
        }
    }

    /*
     * Raises the marks to at least `to` (and whatever this process raised before, and what an
     * earlier version kept in the clear, the per-identity settings marks under
     * `encryptionPublicKeys` included), never lowering any; returns what is stored. Throws
     * `MarksWords.unsaved` when they could not be stored and `MarksWords.unreadable` when the
     * record does not open: the caller then doesn't take what it was about to.
     */
    @discardableResult
    func raise(userId: String, to: RollbackMarks, encryptionPublicKeys: [String] = [], keys: MarksKeys) async throws -> RollbackMarks {
        let user = userId.lowercased()
        floor.raise(user, to)
        let earlier = legacy(user, encryptionPublicKeys: encryptionPublicKeys)
        let wanted = to.highest(floor.value(user)).highest(earlier.marks)
        let url = try file(user)
        let kept = try record(url)
        // Nothing to keep and nothing kept: no record, and no settings key made for one.
        if kept == nil, wanted == .none, earlier.keys.isEmpty { return .none }
        let key: MarksKey?
        do {
            key = try await keys(kept?.key.map { SettingsKeyEnvelope(nonce: $0.nonce, ciphertext: $0.ciphertext) }, kept == nil)
        } catch {
            throw AuthError.message(MarksWords.unsaved)
        }
        guard let key else { throw AuthError.message(kept == nil ? MarksWords.unsaved : MarksWords.unreadable) }
        // Already held, under the same envelope, with nothing to migrate: no write, so no lock.
        if let kept, earlier.keys.isEmpty, kept.key == Record.Kept(nonce: key.envelope.nonce, ciphertext: key.envelope.ciphertext),
           let held = try? rollbackMarksUpdate(settingsKey: key.key, userId: user, envelope: kept.marks, to: .none).marks, held.holds(wanted) {
            floor.written(user, held)
            return held
        }
        Unbacked.folder(folder)
        var outcome: Result<RollbackMarks, Error> = .failure(AuthError.message(MarksWords.unsaved))
        FileLock.withLock(lockPath, activity: activity) {
            outcome = Result { try locked(user, url: url, key: key, wanted: wanted, earlier: earlier.keys) }
        }
        let marks = try outcome.get()
        floor.written(user, marks)
        return marks
    }

    /* One read-open-raise-seal-write, holding the lock: what another process wrote meanwhile is opened and kept. */
    private func locked(_ user: String, url: URL, key: MarksKey, wanted: RollbackMarks, earlier: [URL: [String]]) throws -> RollbackMarks {
        let current = try record(url)
        let update: RollbackMarksUpdate
        do {
            update = try rollbackMarksUpdate(settingsKey: key.key, userId: user, envelope: current?.marks, to: wanted)
        } catch {
            throw AuthError.message(MarksWords.unreadable)
        }
        let next = Record(marks: update.envelope, key: Record.Kept(nonce: key.envelope.nonce, ciphertext: key.envelope.ciphertext))
        if current != next {
            do {
                try JSONEncoder().encode(next).write(to: url, options: .atomic)
            } catch {
                throw AuthError.message(MarksWords.unsaved)
            }
        }
        forgetLegacy(earlier, sealed: update.marks, user: user)
        return update.marks
    }

    /* Raises nothing new: folds in the per-identity settings marks an earlier version kept under these keys, if any. */
    func adopt(userId: String, encryptionPublicKeys: [String], keys: MarksKeys) async throws {
        let user = userId.lowercased()
        guard !legacy(user, encryptionPublicKeys: encryptionPublicKeys).keys.isEmpty else { return }
        try await raise(userId: user, to: .none, encryptionPublicKeys: encryptionPublicKeys, keys: keys)
    }

    /* Earlier versions' digests: per account, and the settings mark per identity key before that. */
    private static func digest(_ text: String) -> String { keyDigest(publicKey: Data(text.utf8)) }
    static func legacySettingsKey(_ user: String) -> String { digest("hushos/settings-mark\n\(user)") }
    static func legacySettingsKey(_ user: String, encryptionPublicKey: String) -> String { digest("\(user)\n\(encryptionPublicKey)") }
    static func legacyIdentityKey(_ user: String) -> String { digest("hushos/identity-mark\n\(user)") }
    static func legacyIdentityVersionKey(_ user: String) -> String { digest("hushos/identity-version-mark\n\(user)") }

    /* What the plaintext files hold for the account: the highest of each mark, and the entries it came from, by file. */
    private func legacy(_ user: String, encryptionPublicKeys: [String]) -> (marks: RollbackMarks, keys: [URL: [String]]) {
        let settings = [Self.legacySettingsKey(user)] + encryptionPublicKeys.map { Self.legacySettingsKey(user, encryptionPublicKey: $0) }
        var marks = RollbackMarks.none
        var keys: [URL: [String]] = [:]
        for url in legacyFiles {
            guard let data = try? Data(contentsOf: url), let all = try? JSONDecoder().decode([String: UInt64].self, from: data) else { continue }
            for (name, value) in all {
                var mark = RollbackMarks.none
                if settings.contains(name) { mark.settings = value }
                else if name == Self.legacyIdentityKey(user) { mark.identity = value }
                else if name == Self.legacyIdentityVersionKey(user) { mark.identityVersion = value }
                else { continue }
                marks = marks.highest(mark)
                keys[url, default: []].append(name)
            }
        }
        return (marks, keys)
    }

    /* Each plaintext entry the sealed record now holds goes; a file left empty goes whole, its old lock with it. */
    private func forgetLegacy(_ earlier: [URL: [String]], sealed: RollbackMarks, user: String) {
        for (url, names) in earlier {
            guard let data = try? Data(contentsOf: url), var all = try? JSONDecoder().decode([String: UInt64].self, from: data) else { continue }
            for name in names where all[name].map({ sealedHolds(name, $0, sealed, user) }) ?? false { all[name] = nil }
            if all.isEmpty {
                try? FileManager.default.removeItem(at: url)
                try? FileManager.default.removeItem(atPath: url.path + ".lock")
            } else if let data = try? JSONEncoder().encode(all) {
                try? data.write(to: url, options: .atomic)
            }
        }
    }

    private func sealedHolds(_ name: String, _ value: UInt64, _ sealed: RollbackMarks, _ user: String) -> Bool {
        if name == Self.legacyIdentityKey(user) { return value <= sealed.identity }
        if name == Self.legacyIdentityVersionKey(user) { return value <= sealed.identityVersion }
        return value <= sealed.settings
    }
}

/*
 * What this process raised, per account: counted by every read here at once, and put into every
 * write, so a raise the system gave no time to write still refuses a rollback in this process.
 * Forgotten at sign-out with the rest.
 */
final class MarkFloor: @unchecked Sendable {
    static let process = MarkFloor()

    private let lock = NSLock()
    private var values: [String: RollbackMarks] = [:]

    func value(_ user: String) -> RollbackMarks { lock.withLock { values[user] ?? .none } }

    func raise(_ user: String, _ marks: RollbackMarks) { lock.withLock { values[user] = (values[user] ?? .none).highest(marks) } }

    /* The file holds `marks` now: kept here too, so a later read in this process never sees less. */
    func written(_ user: String, _ marks: RollbackMarks) { raise(user, marks) }

    func forget() { lock.withLock { values = [:] } }
}

/*
 * The settings sequence the server reports, checked against the mark. It is reported with or
 * without a document (a version 1 row is served as none at its sequence), so none at all is a
 * rollback only when that sequence is below the mark. Per user, not per identity key: a
 * succession must not reset it.
 */
public enum SettingsMarks {
    public static let rolledBack = "The server sent older settings than this device has seen. Nothing was changed."

    static func check(_ seen: RollbackMarks, served: UInt64) throws {
        guard served >= seen.settings else { throw ContactError.message(rolledBack) }
    }
}

/*
 * An identity served as current, refused when its key version is below the highest opened here
 * (keys the account replaced because they may have been exposed), or when it is version 1 and
 * this phone has opened version 2 for the account: the post-quantum upgrade keeps the key
 * version, and opening the version 1 form again would mint a second ML-DSA key
 * (docs/identity-pq-design.md 2). Every identity made since the release is version 2.
 */
public enum IdentityMarks {
    public static let downgraded = "HushOS served older keys for your account than this device has used. Nothing was opened. Try again later."

    static func check(_ seen: RollbackMarks, keyVersion: UInt64, identityVersion: UInt32) throws {
        guard keyVersion >= seen.identity, UInt64(identityVersion) >= seen.identityVersion else {
            throw AuthError.message(downgraded)
        }
    }
}
