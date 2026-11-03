import Foundation
import HushOSCore

/*
 * The routes a family's managers use (docs/groups-mobile-plan.md iOS 5a, Android's #265): who
 * waits to join (16), Not now (26), invitations (11, 12, 13), the group key's seal (8), and a
 * roster call (17, the member route) and owed grants (22), sent as the core signed them, byte for
 * byte. Every request carries HushOS-Client (`DriveAPI.request`), resends included, so the server
 * never buys a place from this app (`mayBuySeatFrom`). Lists read whole or not at all.
 */

/* Route 3's head: the chain's version and the revision a call is staged over. Nil parts: the server didn't say. */
public struct GroupHead: Codable, Sendable, Equatable {
    public let version: UInt64?
    public let revision: UInt64?
}

/* Route 16: someone who accepted and waits to be let in, with the keys the server serves for them (none: not readable yet). */
public struct PendingPerson: Sendable, Equatable, Identifiable {
    public let userId: String
    public let name: String
    public let email: String
    public let identity: PublicIdentity?
    /* In another family now: they can't be let in until they leave it. */
    public let inFamily: Bool
    public var id: String { userId }

    public init(userId: String, name: String, email: String, identity: PublicIdentity?, inFamily: Bool) {
        self.userId = userId
        self.name = name
        self.email = email
        self.identity = identity
        self.inFamily = inFamily
    }
}

/* Route 12: an invitation still open. */
public struct FamilyInvitation: Sendable, Equatable, Identifiable, Decodable {
    public let id: String
    public let email: String
    /* The inviting manager's user id (null once their account is gone); named from the family's members, as the web does. */
    public let invitedBy: String?
    public let expiresAt: String
}

/* Route 8: the group key sealed to this manager by another (what a first change after a key change opens it from). */
struct KeySealView: Decodable {
    let groupKeyVersion: UInt64
    let holderKeyVersion: UInt64
    let sealerUserId: String
    let rosterVersion: UInt64
    let rosterDigest: String
    let envelope: String
}

/* A roster call's or grants post's answer as it came: no answer is status 0. Thrown only for a 401. */
public struct CallAnswer: Sendable, Equatable {
    public let status: Int
    public let code: String?
    /* The refusal's `data`, as JSON. */
    let data: Data?

    init(status: Int, code: String?, data: Data? = nil) {
        self.status = status
        self.code = code
        self.data = data
    }

    var detail: [String: Any] { data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:] }
}

extension GroupsAPI {
    /* A request with a JSON body, its status and body as they came; a 401 throws, no answer is status 0. */
    private func exchange(_ method: String, _ path: String, body: Data?) async throws -> (status: Int, data: Data) {
        var request = try drive.apiRequest(path)
        request.httpMethod = method
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }
        let answer: (status: Int, data: Data)
        do {
            answer = try await drive.send(request)
        } catch DriveAPIError.transport {
            return (0, Data())
        }
        if answer.status == 401 { throw DriveAPIError.notAuthenticated(session: drive.session.tag) }
        return answer
    }

    /* As `exchange`, a refusal thrown in the server's words. */
    private func call<T: Decodable>(_ method: String, _ path: String, body: [String: Any]?, as type: T.Type) async throws -> T {
        let (status, data) = try await exchange(method, path, body: try body.map { try JSONSerialization.data(withJSONObject: $0) })
        if status == 0 { throw GroupsAPIError(status: 0, code: nil, message: GroupsAPIError.noAnswer) }
        guard (200 ..< 300).contains(status) else { throw GroupsAPIError.refusal(status: status, body: data) }
        return try JSONDecoder().decode(type, from: data)
    }

    private func groupPath(_ groupId: String) throws -> String {
        guard FamilyRecords.valid(groupId) else { throw GroupsAPIError(status: 400, code: "invalid", message: "Please try again.") }
        return "/groups/\(groupId)"
    }

    /* 3: the head a call is staged over. */
    func head(_ groupId: String) async throws -> GroupHead {
        struct Reply: Decodable { let head: GroupHead? }
        guard let head = try await call("GET", try groupPath(groupId), body: nil, as: Reply.self).head else {
            throw GroupsAPIError(status: 502, code: nil, message: "HushOS couldn’t do that just now. Try again in a moment.")
        }
        return head
    }

    /*
     * 16: who waits to join. A row whose user id isn't one is left out; a row whose keys are there
     * but don't read fails the whole list (never read as someone without keys).
     */
    func pending(_ groupId: String) async throws -> [PendingPerson] {
        struct Row: Decodable {
            struct Identity: Decodable {
                let keyVersion: UInt64
                let encryptionPublicKey: String
                let signingPublicKey: String
                let mlDsaPublicKey: String
                let kemPublicKey: String
                let keysSignature: String
            }
            let userId: String
            let name: String
            let email: String
            let identity: Identity?
            var inFamily: Bool? = nil
        }
        struct Reply: Decodable { let pending: [Row] }
        return try await call("GET", try groupPath(groupId) + "/pending", body: nil, as: Reply.self).pending
            .filter { FamilyRecords.valid($0.userId.lowercased()) }
            .map { row in
                PendingPerson(userId: row.userId.lowercased(), name: row.name, email: row.email,
                              identity: row.identity.map {
                                  PublicIdentity(keyVersion: $0.keyVersion, encryptionPublicKey: $0.encryptionPublicKey, signingPublicKey: $0.signingPublicKey,
                                                 mlDsaPublicKey: $0.mlDsaPublicKey, kemPublicKey: $0.kemPublicKey, keysSignature: $0.keysSignature)
                              },
                              inFamily: row.inFamily == true)
            }
    }

    /* 12: the invitations still open, every row read whole. */
    func invitations(_ groupId: String) async throws -> [FamilyInvitation] {
        struct Reply: Decodable { let invitations: [FamilyInvitation] }
        return try await call("GET", try groupPath(groupId) + "/invitations", body: nil, as: Reply.self).invitations
    }

    /* 11: invites `email` (no roles: managing is given once they're in). */
    func invite(_ groupId: String, email: String) async throws {
        struct Reply: Decodable { let id: String }
        _ = try await call("POST", try groupPath(groupId) + "/invitations", body: ["email": email, "roles": [String]()], as: Reply.self)
    }

    /* 13: cancels an open invitation. An id that isn't one names none: gone, as the server says. */
    func cancelInvitation(_ groupId: String, _ invitationId: String) async throws {
        guard FamilyRecords.valid(invitationId.lowercased()) else {
            throw GroupsAPIError(status: 410, code: "gone", message: "This invitation is no longer open.")
        }
        struct Reply: Decodable { let revoked: Bool }
        _ = try await call("DELETE", try groupPath(groupId) + "/invitations/\(invitationId.lowercased())", body: [:], as: Reply.self)
    }

    /* 26: Not now: turns someone who waits down. */
    func decline(_ groupId: String, userId: String) async throws {
        guard FamilyRecords.valid(userId.lowercased()) else { throw GroupsAPIError(status: 409, code: "not-pending", message: "") }
        struct Reply: Decodable { let declined: Bool }
        _ = try await call("POST", try groupPath(groupId) + "/members/\(userId.lowercased())/decline", body: [:], as: Reply.self)
    }

    /* 8: the group key sealed to this account. */
    func keySeal(_ groupId: String) async throws -> KeySealView {
        try await call("GET", try groupPath(groupId) + "/key-seal", body: nil, as: KeySealView.self)
    }

    /*
     * A roster call as the core signed it: its body sent as it is, never serialized again, so a
     * resend is the same bytes. Only the admit (17) and member routes; anything else is refused here.
     */
    func sendCall(_ groupId: String, route: ChainRoute, body: String) async throws -> CallAnswer {
        let path: String
        let method: String
        switch route {
        case .admit(let userId):
            guard FamilyRecords.valid(userId.lowercased()) else { return CallAnswer(status: 400, code: "unsupported") }
            (path, method) = (try groupPath(groupId) + "/members/\(userId.lowercased())/admit", "POST")
        case .member(let userId):
            guard FamilyRecords.valid(userId.lowercased()) else { return CallAnswer(status: 400, code: "unsupported") }
            (path, method) = (try groupPath(groupId) + "/members/\(userId.lowercased())", "PATCH")
        default:
            return CallAnswer(status: 400, code: "unsupported")
        }
        return try await answer(method, path, body: Data(body.utf8))
    }

    /* 22: a folder's owed grants, as the core made them. */
    func postGrants(_ groupId: String, workspaceId: String, body: String) async throws -> CallAnswer {
        guard FamilyRecords.valid(workspaceId.lowercased()) else { return CallAnswer(status: 400, code: "invalid") }
        return try await answer("POST", try groupPath(groupId) + "/areas/\(workspaceId.lowercased())/grants", body: Data(body.utf8))
    }

    private func answer(_ method: String, _ path: String, body: Data) async throws -> CallAnswer {
        let (status, data) = try await exchange(method, path, body: body)
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        let detail = (json?["data"]).flatMap { try? JSONSerialization.data(withJSONObject: $0) }
        return CallAnswer(status: status, code: json?["code"] as? String, data: detail)
    }
}

/*
 * The outbox: each roster call this manager signed and hasn't seen land, kept on the device as
 * the core sealed it (`entry`) beside the family's device record, so an unknown outcome is sent
 * again as the same bytes, after a kill too, and never signed twice. One file per entry, written
 * under the records' lock and only while the session stands. A folder or entry that can't be read
 * is never read as none: it throws, and nothing is signed or sent.
 */
extension FamilyRecords {
    private var outboxFolder: URL { folder.appendingPathComponent("outbox", isDirectory: true) }

    private func outboxFile(_ userId: String, _ groupId: String, _ outboxId: String) -> URL? {
        guard Self.valid(userId.lowercased()), Self.valid(groupId), Self.valid(outboxId.lowercased()) else { return nil }
        return outboxFolder.appendingPathComponent("\(userId.lowercased())_\(groupId)_\(outboxId.lowercased()).call")
    }

    /* `body` under the records' lock while the session stands; throws `unsaved` when either can't be had. */
    private func underLock(_ body: () throws -> Void) throws {
        var outcome: Result<Void, Error> = .failure(GuardError.unsaved)
        let ran: Bool? = try {
            guard let session else { return FileLock.withLock(lockPathForOutbox, activity: activity) { outcome = Result { try body() } } }
            return try session.whileOpen { FileLock.withLock(lockPathForOutbox, activity: activity) { outcome = Result { try body() } } }
        }()
        guard ran == true else { throw GuardError.unsaved }
        try outcome.get()
    }

    private var lockPathForOutbox: String { folder.appendingPathComponent(".lock").path }

    /* Keeps a staged call before it is sent. */
    func outboxPut(userId: String, groupId: String, outboxId: String, entry: String) throws {
        guard let url = outboxFile(userId, groupId, outboxId) else { throw GuardError.unsaved }
        Unbacked.folder(folder)
        try underLock {
            try FileManager.default.createDirectory(at: outboxFolder, withIntermediateDirectories: true)
            do { try Data(entry.utf8).write(to: url, options: .atomic) } catch { throw GuardError.unsaved }
        }
    }

    /* Lets go of an entry that landed, was superseded or refused; one that stays is an error. */
    func outboxDelete(userId: String, groupId: String, outboxId: String) throws {
        guard let url = outboxFile(userId, groupId, outboxId) else { return }
        try underLock {
            try? FileManager.default.removeItem(at: url)
            if FileManager.default.fileExists(atPath: url.path) { throw GuardError.unsaved }
        }
    }

    /* Every entry of the family kept for this account, oldest first. A folder or entry that can't be read throws. */
    func outboxList(userId: String, groupId: String) throws -> [(outboxId: String, entry: String)] {
        guard Self.valid(userId.lowercased()), Self.valid(groupId) else { return [] }
        let prefix = "\(userId.lowercased())_\(groupId)_"
        guard let names = try outboxNames([.contentModificationDateKey]) else { return [] }
        var out: [(Date, String, String)] = []
        for url in names where url.lastPathComponent.hasPrefix(prefix) && url.pathExtension == "call" {
            let outboxId = String(url.deletingPathExtension().lastPathComponent.dropFirst(prefix.count))
            guard Self.valid(outboxId), let data = try? Data(contentsOf: url), let entry = String(data: data, encoding: .utf8) else {
                throw GuardError.unreadable
            }
            let date = (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            out.append((date, outboxId, entry))
        }
        return out.sorted { ($0.0, $0.1) < ($1.0, $1.1) }.map { ($0.1, $0.2) }
    }

    /*
     * The outbox folder's entries; nil only when it plainly doesn't exist (nothing was ever kept).
     * A folder that can't be reached (an ancestor that can't be searched, a permission) throws, never
     * read as no calls: `fileExists` can't tell those apart.
     */
    private func outboxNames(_ keys: [URLResourceKey]) throws -> [URL]? {
        do {
            return try FileManager.default.contentsOfDirectory(at: outboxFolder, includingPropertiesForKeys: keys)
        } catch let error as CocoaError where error.code == .fileReadNoSuchFile || error.code == .fileNoSuchFile {
            return nil
        } catch {
            throw GuardError.unreadable
        }
    }

    /*
     * The organizer handover under way, by whom it goes to (Android's FamilyOutbox.markHandover): kept before its first
     * call is signed, so a handover the app was stopped in the middle of (billing given, not yet let go of) is finished at
     * the next open; `staged` once billing's call is kept. One that can't be read throws, never read as none.
     */
    struct KeptHandover: Sendable, Equatable {
        let to: String
        let staged: Bool
    }

    private func handoverFile(_ userId: String, _ groupId: String) -> URL? {
        guard Self.valid(userId.lowercased()), Self.valid(groupId) else { return nil }
        return outboxFolder.appendingPathComponent("\(userId.lowercased())_\(groupId).handover")
    }

    func markHandover(userId: String, groupId: String, to: String, staged: Bool = false) throws {
        guard let url = handoverFile(userId, groupId), Self.valid(to.lowercased()) else { throw GuardError.unsaved }
        Unbacked.folder(folder)
        try underLock {
            try FileManager.default.createDirectory(at: outboxFolder, withIntermediateDirectories: true)
            do { try Data((to.lowercased() + (staged ? "\nstaged" : "")).utf8).write(to: url, options: .atomic) } catch { throw GuardError.unsaved }
        }
    }

    func handover(userId: String, groupId: String) throws -> KeptHandover? {
        guard let url = handoverFile(userId, groupId) else { return nil }
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        guard let data = try? Data(contentsOf: url), let text = String(data: data, encoding: .utf8) else { throw GuardError.unreadable }
        let lines = text.split(separator: "\n").map(String.init)
        guard let to = lines.first, Self.valid(to) else { throw GuardError.unreadable }
        return KeptHandover(to: to, staged: lines.dropFirst().first == "staged")
    }

    func clearHandover(userId: String, groupId: String) throws {
        guard let url = handoverFile(userId, groupId) else { return }
        try underLock {
            try? FileManager.default.removeItem(at: url)
            if FileManager.default.fileExists(atPath: url.path) { throw GuardError.unsaved }
        }
    }

    /*
     * What a kept call that was let go of came to, while it is still to be said (Codex #285): kept from before its entry
     * is deleted until a screen of the same account has said it, so a relaunch, a reset or a page that stopped waiting
     * loses none. Only the ends that have words (`ManageWords.resumed`): a refusal, or an admission or role change that
     * another change overtook. One per outbox id, so an entry that comes back after a crash is said once.
     */
    struct UnsaidEnd: Codable, Sendable, Equatable {
        let outboxId: String
        /* "refused", "admit" (an overtaken admission) or "member" (an overtaken role change). */
        let kind: String
        let words: String?
        let userId: String?

        init?(outboxId: String, end: CallEnd, route: ChainRoute?) {
            self.outboxId = outboxId.lowercased()
            switch (end, route) {
            case (.refused(let words), _): (kind, self.words, userId) = ("refused", words, nil)
            case (.stale, .admit(let userId)?): (kind, words, self.userId) = ("admit", nil, userId.lowercased())
            case (.stale, .member(let userId)?): (kind, words, self.userId) = ("member", nil, userId.lowercased())
            default: return nil
            }
        }

        /* The end and route it was kept from, or nil for one this build can't read. */
        var said: (end: CallEnd, route: ChainRoute?)? {
            switch kind {
            case "refused": return words.map { (.refused($0), nil) }
            case "admit": return userId.map { (.stale, .admit(userId: $0)) }
            case "member": return userId.map { (.stale, .member(userId: $0)) }
            default: return nil
            }
        }
    }

    private func unsaidFile(_ userId: String, _ groupId: String) -> URL? {
        guard Self.valid(userId.lowercased()), Self.valid(groupId) else { return nil }
        return outboxFolder.appendingPathComponent("\(userId.lowercased())_\(groupId).unsaid")
    }

    private func unsaid(_ url: URL) throws -> [UnsaidEnd] {
        guard FileManager.default.fileExists(atPath: url.path) else { return [] }
        guard let data = try? Data(contentsOf: url), let ends = try? JSONDecoder().decode([UnsaidEnd].self, from: data) else { throw GuardError.unreadable }
        return ends
    }

    private func writeUnsaid(_ ends: [UnsaidEnd], to url: URL) throws {
        if ends.isEmpty {
            try? FileManager.default.removeItem(at: url)
            if FileManager.default.fileExists(atPath: url.path) { throw GuardError.unsaved }
            return
        }
        do { try JSONEncoder().encode(ends).write(to: url, options: .atomic) } catch { throw GuardError.unsaved }
    }

    /* Kept to be said, before the entry it is about is deleted; once per outbox id. */
    func keepUnsaid(userId: String, groupId: String, _ end: UnsaidEnd) throws {
        guard let url = unsaidFile(userId, groupId), Self.valid(end.outboxId) else { throw GuardError.unsaved }
        Unbacked.folder(folder)
        try underLock {
            try FileManager.default.createDirectory(at: outboxFolder, withIntermediateDirectories: true)
            let ends = try unsaid(url)
            guard !ends.contains(where: { $0.outboxId == end.outboxId }) else { return }
            try writeUnsaid(ends + [end], to: url)
        }
    }

    /* Every end still to be said for this account, by family, oldest first; read only (said, then `dropUnsaid`). */
    func unsaidList(userId: String) throws -> [(groupId: String, end: UnsaidEnd)] {
        guard Self.valid(userId.lowercased()), let names = try outboxNames([]) else { return [] }
        let prefix = "\(userId.lowercased())_"
        var out: [(groupId: String, end: UnsaidEnd)] = []
        for url in names.sorted(by: { $0.lastPathComponent < $1.lastPathComponent })
        where url.lastPathComponent.hasPrefix(prefix) && url.pathExtension == "unsaid" {
            let groupId = String(url.deletingPathExtension().lastPathComponent.dropFirst(prefix.count))
            guard Self.valid(groupId) else { continue }
            for end in try unsaid(url) { out.append((groupId, end)) }
        }
        return out
    }

    /* Lets go of the ends a screen said, and only those: one kept since the list stays. */
    func dropUnsaid(userId: String, groupId: String, outboxIds: Set<String>) throws {
        guard let url = unsaidFile(userId, groupId) else { return }
        try underLock { try writeUnsaid(try unsaid(url).filter { !outboxIds.contains($0.outboxId) }, to: url) }
    }

    /* A wipe of the family: every call kept for it goes, before the record that ties them to it. */
    func outboxDeleteAll(userId: String, groupId: String) throws {
        // Nothing ever kept: nothing to take (and no lock needed). One that can't be reached throws.
        guard Self.valid(userId.lowercased()), Self.valid(groupId), try outboxNames([]) != nil else { return }
        let prefix = "\(userId.lowercased())_\(groupId)_"
        try underLock {
            // A folder that can't be listed fails the wipe: signed calls are never left behind as if there were none.
            guard let names = try outboxNames([]) else { return }
            for url in names where url.lastPathComponent.hasPrefix(prefix) { try? FileManager.default.removeItem(at: url) }
            if names.contains(where: { $0.lastPathComponent.hasPrefix(prefix) && FileManager.default.fileExists(atPath: $0.path) }) {
                throw GuardError.unsaved
            }
            // The handover under way, and what is still to be said about its calls, go with the family too.
            for url in [handoverFile(userId, groupId), unsaidFile(userId, groupId)].compactMap({ $0 }) {
                try? FileManager.default.removeItem(at: url)
                if FileManager.default.fileExists(atPath: url.path) { throw GuardError.unsaved }
            }
        }
    }
}
