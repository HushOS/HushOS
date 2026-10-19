import Foundation
import HushOSCore

/*
 * An upload into a family folder as the background queue keeps it (docs/groups-mobile-plan.md,
 * iOS 2), and every decision about it, so the app keeps only the URLSession wiring: seal it (the
 * family opened in this process first, the key-change wait while sealing), finish it from the
 * stored record after a background relaunch, and decide what a completion's answer means:
 *
 * - landed: the server completed it (also when its row doesn't open here, `UploadLanded`: never
 *   sent again, never aborted, so never a duplicate);
 * - re-seal: a key change reached the folder or the file while the parts were in flight, so the
 *   server refused the completion (409 `conflict` with `conflicted`, `rotating`, a late `stale`)
 *   or the ledger refused the replacement's name (KEY_CHANGE_PENDING): the upload is aborted, its
 *   parts and their addresses dropped, and it is sealed again from the kept plaintext under the
 *   keys it finds, waiting as before. The web re-attaches the bytes with the content key its
 *   worker still holds; the phone keeps no key between sealing and finishing, so it uploads again;
 * - retry: no answer, or a busy server: nothing changes, the queue looks again;
 * - failed: anything else, said in the person's words by the app.
 *
 * The record's folder (`directory`) holds the plaintext (`content`) until the upload lands and
 * the sealed parts (`part-N`) while they are sent: it is removed when the upload lands or is
 * discarded, and with the account's data on sign-out and on another account's sign-in
 * (`AccountStore.accountFiles` holds `transfers`). It lives in the queue's folder, made by
 * `Unbacked.folder`: out of backups, under `Unbacked.protection`.
 */
public struct FamilyUpload: Codable, Sendable, Equatable {
    public struct Family: Codable, Sendable, Equatable {
        public let groupId: String
        public let workspaceId: String
        public init(groupId: String, workspaceId: String) {
            self.groupId = groupId
            self.workspaceId = workspaceId
        }
    }

    public let family: Family
    public let folderId: String
    public let name: String
    public let mime: String?
    public let replacingId: String?
    /* The version a replacement set out to replace, as queued: someone else's newer one is never overwritten. */
    public let replacingVersionId: String?
    /* Once sealed: the server's upload and its part addresses; the parts sent so far. */
    public var sealed: Vault.SealedUpload?
    public var etags: [Int: String] = [:]
    /* Since when it has waited out a key change (kept across launches, for the half hour). */
    public var keyChangeSince: Date?

    public init(family: Family, folderId: String, name: String, mime: String?, replacingId: String?, replacingVersionId: String?,
                sealed: Vault.SealedUpload? = nil, etags: [Int: String] = [:], keyChangeSince: Date? = nil) {
        self.family = family
        self.folderId = folderId
        self.name = name
        self.mime = mime
        self.replacingId = replacingId
        self.replacingVersionId = replacingVersionId
        self.sealed = sealed
        self.etags = etags
        self.keyChangeSince = keyChangeSince
    }

    public static func content(in directory: URL) -> URL { directory.appendingPathComponent("content") }
}

public enum FamilyUploadStep: Sendable {
    /* Sealed: the parts in `sealed` are to be sent. */
    case send
    case landed
    /* Aborted after a key change reached it in flight: to be sealed again (its `sealed` and `etags` are cleared). */
    case reseal
    /* No answer or a busy server: nothing changed. */
    case retry(Error)
    case failed(Error)
}

public struct FamilyUploads: Sendable {
    let vault: Vault
    let families: FamilySync
    /* Between looks while waiting out a key change; the app sleeps, tests don't. */
    let pause: @Sendable (Int) async throws -> Void
    let now: @Sendable () -> Date

    public init(vault: Vault, families: FamilySync,
                pause: @escaping @Sendable (Int) async throws -> Void = { try await Task.sleep(for: .seconds(KeyChangeWait.delay($0))) },
                now: @escaping @Sendable () -> Date = { Date() }) {
        self.vault = vault
        self.families = families
        self.pause = pause
        self.now = now
    }

    /*
     * The family open in this process's ledger and the folder listed in its own workspace: what
     * sealing and finishing need after a background launch, when nothing of the family is open.
     */
    func open(_ upload: FamilyUpload, recheck: Bool = false) async throws {
        try await families.ensureOpen(upload.family.groupId)
        if recheck { await families.recheck(upload.family.workspaceId) }
        await vault.hint(workspace: upload.family.workspaceId, for: upload.folderId)
        _ = try await vault.listChildren(of: upload.folderId)
    }

    /*
     * Seals the upload from `directory`'s plaintext, waiting out a key change the folder hasn't
     * reached (KeyChangeWait); `waiting` hears when the wait begins, for the row. An upload sealed
     * again after a refused completion checks its family first: the key change that refused it
     * came with a member list this process hasn't accepted yet.
     */
    public func seal(_ upload: inout FamilyUpload, in directory: URL, thumbnail: Data?,
                     waiting: @escaping @Sendable (Date) -> Void = { _ in }) async -> FamilyUploadStep {
        let began = Began(upload.keyChangeSince)
        do {
            // The folder looked up under the keys the family's member list gives now; a key change this process hasn't
            // followed yet (a folder served under a key it doesn't hold) is the same wait as sealing's.
            var attempt = 0
            while true {
                do {
                    try await open(upload, recheck: upload.keyChangeSince != nil || attempt > 0)
                    break
                } catch where KeyChangeWait.meets(error, waited: true) {
                    let start = began.value ?? now()
                    began.set(start)
                    waiting(start)
                    upload.keyChangeSince = start
                    if now().timeIntervalSince(start) >= KeyChangeWait.giveUp { throw DriveAPIError.server(409, KeyChangeWait.gaveUp) }
                    attempt += 1
                    try await pause(attempt)
                }
            }
            var replacing: Opened?
            if let replacingId = upload.replacingId {
                replacing = try await vault.resolve(replacingId)
                if let expected = upload.replacingVersionId, replacing?.node.currentVersion?.id != expected {
                    throw DriveAPIError.server(409, KeyChangeWait.versionMoved)
                }
            }
            let policy = KeyChangeWait.Policy(since: upload.keyChangeSince, pause: pause, waiting: { date in
                began.set(date)
                waiting(date)
            }, now: now)
            let sealed = try await vault.sealUpload(fileURL: FamilyUpload.content(in: directory), name: upload.name, mime: upload.mime,
                                                    in: upload.folderId, replacing: replacing, thumbnail: thumbnail, into: directory, waiting: policy)
            upload.sealed = sealed
            upload.etags = [:]
            upload.keyChangeSince = nil
            return .send
        } catch {
            if Resumable.retryable(error) {
                // A wait for a connection isn't a key change: the half hour starts again with the next one.
                upload.keyChangeSince = nil
                return .retry(error)
            }
            upload.keyChangeSince = began.value
            return .failed(error)
        }
    }

    /* Finishes the upload once every part landed (`upload.etags`), from the stored record in any process. */
    public func finish(_ upload: inout FamilyUpload, in directory: URL) async -> FamilyUploadStep {
        guard let sealed = upload.sealed else { return .reseal }
        do {
            // Opened first so the row can be shown and a replacement's name written; when it can't be (a key change reached
            // the folder meanwhile), the server decides: it completes, or refuses a node the change moved (conflicted).
            do { try await open(upload) } catch where Resumable.retryable(error) { throw error } catch {}
            _ = try await vault.finishUpload(sealed, etags: upload.etags)
            remove(directory)
            return .landed
        } catch is UploadLanded {
            remove(directory)
            return .landed
        } catch {
            if Self.refusedInFlight(error), FileManager.default.fileExists(atPath: FamilyUpload.content(in: directory).path) {
                await vault.abortUpload(sealed)
                // The parts were sealed under the keys the change replaced: none of them is sent again.
                for item in (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
                where item.lastPathComponent != "content" {
                    try? FileManager.default.removeItem(at: item)
                }
                upload.sealed = nil
                upload.etags = [:]
                upload.keyChangeSince = upload.keyChangeSince ?? now()
                return .reseal
            }
            if Resumable.retryable(error) { return .retry(error) }
            return .failed(error)
        }
    }

    /* Stops the upload: the server's half is aborted (only the session's own account may name it) and its folder goes. */
    public func discard(_ upload: FamilyUpload, in directory: URL) async {
        if let sealed = upload.sealed { await vault.abortUpload(sealed) }
        remove(directory)
    }

    /* A completion a key change refused while the parts were in flight. */
    static func refusedInFlight(_ error: Error) -> Bool {
        if case DriveAPIError.conflicted = error { return true }
        return KeyChangeWait.meets(error, waited: true)
    }

    private func remove(_ directory: URL) { try? FileManager.default.removeItem(at: directory) }

    private final class Began: @unchecked Sendable {
        private let lock = NSLock()
        private var date: Date?
        init(_ date: Date?) { self.date = date }
        func set(_ value: Date) { lock.withLock { if date == nil { date = value } } }
        var value: Date? { lock.withLock { date } }
    }
}
