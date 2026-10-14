import Foundation
import HushOSCore

/*
 * High-water marks this device keeps against a server handing back something older than
 * it has seen (docs/integrity-design.md, "Rollback marks"). Kept on this phone only, in
 * `local/` and across sign-outs, since a rollback is likeliest right after signing in
 * again; keys are digests, so the files name no account. Raised, never lowered: two
 * processes writing at once keep the higher. A new device has no marks; that is inherent.
 */
struct HighWaterMarks: Sendable {
    let file: URL

    func load() -> [String: UInt64] {
        guard let data = try? Data(contentsOf: file) else { return [:] }
        return (try? JSONDecoder().decode([String: UInt64].self, from: data)) ?? [:]
    }

    func value(_ key: String) -> UInt64 { load()[key] ?? 0 }

    func raise(_ key: String, to value: UInt64) {
        var marks = load()
        guard value > marks[key] ?? 0 else { return }
        marks[key] = value
        save(marks)
    }

    func save(_ marks: [String: UInt64]) {
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(marks) { try? data.write(to: file, options: .atomic) }
    }
}

/*
 * The highest settings version this device has seen, per account. The server could otherwise
 * hand back an older document (a pin since replaced, a share since stopped in the ledger) and
 * every client would take it. Per user, not per identity key: a succession must not reset it.
 */
public struct SettingsMarks: Sendable {
    let marks: HighWaterMarks

    public static let rolledBack = "The server sent older settings than this device has seen. Nothing was changed."

    init(file: URL) { marks = HighWaterMarks(file: file) }

    static var shared: SettingsMarks { SettingsMarks(file: Unbacked.local.appendingPathComponent("settings-marks.json")) }

    static func key(userId: String) -> String {
        keyDigest(publicKey: Data("hushos/settings-mark\n\(userId.lowercased())".utf8))
    }

    /* How an earlier version keyed the mark: by account and identity key, which a succession changed. */
    static func legacyKey(userId: String, encryptionPublicKey: String) -> String {
        keyDigest(publicKey: Data("\(userId.lowercased())\n\(encryptionPublicKey)".utf8))
    }

    func mark(userId: String) -> UInt64 { marks.value(Self.key(userId: userId)) }

    /*
     * The stored sequence the server reports, checked against the mark. It is reported with or
     * without a document (a version 1 row is served as none at its sequence), so none at all is
     * a rollback only when that sequence is below the mark.
     */
    func check(userId: String, served: UInt64) throws {
        guard served >= mark(userId: userId) else { throw ContactError.message(Self.rolledBack) }
    }

    func record(userId: String, version: UInt64) { marks.raise(Self.key(userId: userId), to: version) }

    /*
     * A mark an earlier version kept under one of this account's identity keys becomes the
     * account's own, so a device that had seen version 7 still refuses 6 after updating.
     */
    func adopt(userId: String, encryptionPublicKeys: [String]) {
        var all = marks.load()
        let key = Self.key(userId: userId)
        var changed = false
        for encryption in encryptionPublicKeys {
            let legacy = Self.legacyKey(userId: userId, encryptionPublicKey: encryption)
            guard let seen = all[legacy] else { continue }
            if seen > all[key] ?? 0 { all[key] = seen }
            all[legacy] = nil
            changed = true
        }
        if changed { marks.save(all) }
    }
}

/*
 * The highest key version of this account's own identity this device has opened, and the
 * highest identity version (1, or 2 once upgraded). A server serving an older identity as
 * current (keys the account replaced because they may have been exposed) is refused, rather
 * than signed with and shared to again. The post-quantum upgrade keeps the key version, so
 * the key version alone does not see it undone: once this device has opened a version 2
 * identity for the account, a version 1 one is refused too (docs/identity-pq-design.md 2),
 * or a server could have it upgraded again and a second ML-DSA key minted.
 */
public struct IdentityMarks: Sendable {
    let marks: HighWaterMarks

    public static let downgraded = "HushOS served older keys for your account than this device has used. Nothing was opened. Try again later."

    init(file: URL) { marks = HighWaterMarks(file: file) }

    static var shared: IdentityMarks { IdentityMarks(file: Unbacked.local.appendingPathComponent("identity-marks.json")) }

    static func key(userId: String) -> String {
        keyDigest(publicKey: Data("hushos/identity-mark\n\(userId.lowercased())".utf8))
    }

    static func versionKey(userId: String) -> String {
        keyDigest(publicKey: Data("hushos/identity-version-mark\n\(userId.lowercased())".utf8))
    }

    func mark(userId: String) -> UInt64 { marks.value(Self.key(userId: userId)) }

    func versionMark(userId: String) -> UInt64 { marks.value(Self.versionKey(userId: userId)) }

    /*
     * An identity served as current, refused when its key version is below the highest opened
     * here, or when it is version 1 and this device has opened version 2 for the account. Every
     * identity made since the release is version 2 (a succession or a fresh start included), so
     * no version 1 identity can legitimately follow one.
     */
    func check(userId: String, keyVersion: UInt64, identityVersion: UInt32) throws {
        guard keyVersion >= mark(userId: userId), UInt64(identityVersion) >= versionMark(userId: userId) else {
            throw AuthError.message(Self.downgraded)
        }
    }

    func record(userId: String, keyVersion: UInt64, identityVersion: UInt32) {
        marks.raise(Self.key(userId: userId), to: keyVersion)
        marks.raise(Self.versionKey(userId: userId), to: UInt64(identityVersion))
    }
}
