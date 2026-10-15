import Foundation
import HushOSCore

/*
 * High-water marks this device keeps against a server handing back something older than
 * it has seen (docs/integrity-design.md, "Rollback marks"). Kept on this phone only, in
 * `local/` and across sign-outs, since a rollback is likeliest right after signing in
 * again; keys are digests, so the files name no account. Raised, never lowered. The app and
 * its extensions share the file, so every change is one read-modify-write under an exclusive
 * `flock` on a lock file beside it: two processes raising at once both keep their raise.
 * A raise counts in this process at once (`MarkFloor`), whether or not the file could be
 * written then; one not written yet goes into the next write. A new device has no marks;
 * that is inherent.
 */
struct HighWaterMarks: Sendable {
    let file: URL
    var floor: MarkFloor = .process
    var activity: Activity = .system

    /* Whether the system is asked for time to write: `expired` is a process it refuses (tests). */
    enum Activity: Sendable { case system, expired }

    /* The file alone. */
    func load() -> [String: UInt64] {
        guard let data = try? Data(contentsOf: file) else { return [:] }
        return (try? JSONDecoder().decode([String: UInt64].self, from: data)) ?? [:]
    }

    /* The mark as this process knows it: the file's, or a raise made here that hasn't reached it. */
    func value(_ key: String) -> UInt64 { max(load()[key] ?? 0, floor.value(file, key)) }

    func raise(_ key: String, to value: UInt64) {
        update { marks in
            guard value > marks[key] ?? 0 else { return }
            marks[key] = value
        }
    }

    /*
     * One change to the marks. What it raises counts in this process first (and is pending
     * until written), so a write the system doesn't allow now still refuses a rollback here
     * and lands with the next one. The write reads the file and adds what is pending while
     * this process holds the lock: what another process wrote meanwhile is kept. No mark ends
     * lower than it was, whatever `change` does, except the ones named in `retiring` (an old
     * key whose mark moved to a new one), which are removed.
     */
    func update(retiring: Set<String> = [], _ change: (inout [String: UInt64]) -> Void) {
        let base = floor.merged(file, into: load(), except: retiring)
        var intended = base
        change(&intended)
        floor.raise(file, from: base, to: intended, retiring: retiring)
        whileRunning { granted in locked(retiring: retiring, wait: granted, change) }
    }

    private func locked(retiring: Set<String>, wait: Bool, _ change: (inout [String: UInt64]) -> Void) {
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        let lock = open(file.path + ".lock", O_RDWR | O_CREAT | O_CLOEXEC, 0o600)
        guard lock >= 0 else { return }
        defer { close(lock) }
        guard Self.take(lock, wait: wait) else { return }
        defer { flock(lock, LOCK_UN) }
        let before = load()
        let pending = floor.pending(file)
        var marks = before
        for (key, value) in pending where !retiring.contains(key) && value > marks[key] ?? 0 { marks[key] = value }
        change(&marks)
        for (key, seen) in before where !retiring.contains(key) && (marks[key] ?? 0) < seen { marks[key] = seen }
        for key in retiring { marks[key] = nil }
        if marks != before {
            guard let data = try? JSONEncoder().encode(marks), (try? data.write(to: file, options: .atomic)) != nil else { return }
        }
        floor.written(file, marks)
    }

    /*
     * The lock, never waited on without end: a process parked behind another's lock is one
     * the system may suspend there. Tried for about a second when there is time, once when not.
     */
    private static func take(_ lock: Int32, wait: Bool) -> Bool {
        var tries = wait ? 100 : 1
        while true {
            if flock(lock, LOCK_EX | LOCK_NB) == 0 { return true }
            if errno == EINTR { continue }
            tries -= 1
            guard errno == EWOULDBLOCK, tries > 0 else { return false }
            usleep(10_000)
        }
    }

    /*
     * Runs `work` (which takes the lock) while the system has promised not to suspend this
     * process, and tells it so: the lock file is in the app group's container, and a process
     * suspended holding a lock there is killed (0xdead10cc). The app, the Files extension, the
     * sign-in sheet, the share extension and the widget all link this, so it is
     * `performExpiringActivity`, which extensions have too (UIApplication's background task is
     * the app's alone). Its block runs on another queue and holds the assertion until it
     * returns: it waits there while `work` runs here. When the system grants none (the block is
     * told `expired` first) or doesn't answer in two seconds, `work` tries the lock once, without
     * waiting; a raise not written then stays pending. Callers are on the vault's actor, never
     * the main thread.
     */
    private func whileRunning(_ work: (_ granted: Bool) -> Void) {
        if activity == .expired { return work(false) }
        #if os(iOS)
        let granted = DispatchSemaphore(value: 0)
        let finished = DispatchSemaphore(value: 0)
        let answer = ActivityAnswer()
        ProcessInfo.processInfo.performExpiringActivity(withReason: "Saving a rollback mark") { expired in
            // The second call (expiring while the write runs) changes nothing: the write takes milliseconds.
            guard answer.first(expired: expired) else { return }
            granted.signal()
            if !expired { finished.wait() }
        }
        defer { finished.signal() }
        work(granted.wait(timeout: .now() + 2) == .success && answer.mayRun)
        #else
        work(true)
        #endif
    }
}

/*
 * The raises this process made, per marks file: `values` for reading (the file may not have
 * them yet) and `pending` for the next write, dropped once a write has them.
 */
final class MarkFloor: @unchecked Sendable {
    static let process = MarkFloor()

    private let lock = NSLock()
    private var values: [String: [String: UInt64]] = [:]
    private var waiting: [String: [String: UInt64]] = [:]

    func value(_ file: URL, _ key: String) -> UInt64 { lock.withLock { values[file.path]?[key] ?? 0 } }

    func pending(_ file: URL) -> [String: UInt64] { lock.withLock { waiting[file.path] ?? [:] } }

    /* `marks` with this process's raises in, less the keys retiring. */
    func merged(_ file: URL, into marks: [String: UInt64], except retiring: Set<String>) -> [String: UInt64] {
        lock.withLock {
            var all = marks
            for (key, value) in values[file.path] ?? [:] where !retiring.contains(key) && value > all[key] ?? 0 { all[key] = value }
            return all
        }
    }

    /* What a change raised over `base`: kept, and pending. Retiring keys leave both. */
    func raise(_ file: URL, from base: [String: UInt64], to marks: [String: UInt64], retiring: Set<String>) {
        lock.withLock {
            for (key, value) in marks where !retiring.contains(key) && value > base[key] ?? 0 {
                values[file.path, default: [:]][key] = max(values[file.path]?[key] ?? 0, value)
                waiting[file.path, default: [:]][key] = max(waiting[file.path]?[key] ?? 0, value)
            }
            for key in retiring {
                values[file.path]?[key] = nil
                waiting[file.path]?[key] = nil
            }
        }
    }

    /* The file now holds `marks`: what is pending at or below them is done. */
    func written(_ file: URL, _ marks: [String: UInt64]) {
        lock.withLock {
            waiting[file.path] = (waiting[file.path] ?? [:]).filter { key, value in value > marks[key] ?? 0 }
        }
    }
}

#if os(iOS)
/* The expiring activity's first answer: whether the process may run until the block returns. */
private final class ActivityAnswer: @unchecked Sendable {
    private let lock = NSLock()
    private var answered = false
    private var expired = true

    /* True for the first call only, which records whether it came expired. */
    func first(expired: Bool) -> Bool {
        lock.withLock {
            guard !answered else { return false }
            answered = true
            self.expired = expired
            return true
        }
    }

    var mayRun: Bool { lock.withLock { answered && !expired } }
}
#endif

/*
 * The highest settings version this device has seen, per account. The server could otherwise
 * hand back an older document (a pin since replaced, a share since stopped in the ledger) and
 * every client would take it. Per user, not per identity key: a succession must not reset it.
 */
public struct SettingsMarks: Sendable {
    let marks: HighWaterMarks

    public static let rolledBack = "The server sent older settings than this device has seen. Nothing was changed."

    init(file: URL, activity: HighWaterMarks.Activity = .system) { marks = HighWaterMarks(file: file, activity: activity) }

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
        let key = Self.key(userId: userId)
        let legacy = encryptionPublicKeys.map { Self.legacyKey(userId: userId, encryptionPublicKey: $0) }
        // Read first without the lock: almost always there is nothing to carry over.
        let all = marks.load()
        guard legacy.contains(where: { all[$0] != nil }) else { return }
        // Each legacy mark moves into the account's, in the same locked change that removes it.
        marks.update(retiring: Set(legacy)) { all in
            for old in legacy {
                guard let seen = all[old] else { continue }
                if seen > all[key] ?? 0 { all[key] = seen }
            }
        }
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

    init(file: URL, activity: HighWaterMarks.Activity = .system) { marks = HighWaterMarks(file: file, activity: activity) }

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

    /* Both marks in one locked write. */
    func record(userId: String, keyVersion: UInt64, identityVersion: UInt32) {
        let key = Self.key(userId: userId)
        let versionKey = Self.versionKey(userId: userId)
        marks.update { marks in
            if keyVersion > marks[key] ?? 0 { marks[key] = keyVersion }
            if UInt64(identityVersion) > marks[versionKey] ?? 0 { marks[versionKey] = UInt64(identityVersion) }
        }
    }
}
