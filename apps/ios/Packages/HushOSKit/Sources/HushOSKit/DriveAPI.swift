import Foundation

public enum DriveAPIError: Error, LocalizedError, Sendable {
    case notAuthenticated
    case server(Int, String)
    case transport(String)
    case notFound(String)
    /* The item, or a folder above it, is in the trash: the server's `trashed` code. */
    case trashed(String)
    /* A row or document sealed in an envelope suite newer than this app reads. */
    case newerEnvelope
    /* A Drive key change has not reached the folder or the file yet: the server's 409 `rotating`, a wait (uploads wait it out). */
    case rotating(String)
    /* Envelopes under a key epoch or a version that is no longer the item's: the server's 409 `stale`. */
    case stale(String)
    /* A completion whose node moved while its parts were in flight (a key change re-keyed it or its folder, or a newer version): 409 `conflict` with `conflicted`. */
    case conflicted(String)

    public var errorDescription: String? {
        switch self {
        case .newerEnvelope: return "This item was made by a newer version of HushOS. Update the app to open it."
        case .notAuthenticated: return "Sign in to HushOS to see your files."
        // Out of room, in the app's own words: the server's mention plans, which the app never points to
        // (App Review 3.1.3(f)). Android says the same.
        case .server(402, _), .server(413, _), .server(507, _): return Self.noRoom
        case .server(_, let message), .notFound(let message), .trashed(let message), .rotating(let message), .stale(let message), .conflicted(let message): return message
        case .transport: return "We couldn’t reach HushOS. Check your connection, then try again."
        }
    }

    public static let noRoom = "This doesn’t fit in your storage. Free up space to upload it."
}

/*
 * The Drive API over URLSession with the session cookie the app or the
 * sign-in sheet left in the keychain. Every method is one route; the vault
 * turns their envelopes into keys and names.
 */
public final class DriveAPI: Sendable {
    /*
     * `HushOS-Client` on every request: the HushOS version of this build (CFBundleShortVersionString,
     * MARKETING_VERSION in project.yml), which the server compares with its minimum for `ios`
     * (packages/drive's checkClient). The app and its extensions carry the same version. A bundle
     * without one (a unit-test host) says 0.0.0, older than any minimum. Builds before 1.0.0 sent
     * the Drive protocol number here ("ios/3").
     */
    public static let clientHeader: String = {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
        let valid = version.wholeMatch(of: #/[0-9]+\.[0-9]+\.[0-9]+/#) != nil
        return "ios/" + (valid ? version : "0.0.0")
    }()

    public let session: SharedKeychain.Session
    private let http: URLSession

    /* `configuration` is for tests, which answer with a stub URLProtocol instead of a server. */
    public init(session: SharedKeychain.Session, configuration: URLSessionConfiguration = .ephemeral) {
        self.session = session
        self.http = URLSession(configuration: configuration)
    }

    private var cookieName: String {
        session.origin.hasPrefix("https:") ? "__Host-hushos-session" : "hushos-session"
    }

    private func request(_ path: String, query: [URLQueryItem] = [], base: String = "/api/drive") throws -> URLRequest {
        guard var components = URLComponents(string: session.origin + base + path) else {
            throw DriveAPIError.server(500, "Bad API path")
        }
        if !query.isEmpty { components.queryItems = query }
        guard let url = components.url else { throw DriveAPIError.server(500, "Bad API path") }
        var request = URLRequest(url: url)
        request.httpShouldHandleCookies = false
        request.setValue("\(cookieName)=\(session.token)", forHTTPHeaderField: "Cookie")
        request.setValue(DriveAPI.clientHeader, forHTTPHeaderField: "HushOS-Client")
        request.setValue(session.origin, forHTTPHeaderField: "Origin")
        request.timeoutInterval = 30
        return request
    }

    private func mutation(_ path: String, method: String = "POST", body: [String: Any]) throws -> URLRequest {
        var request = try request(path)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        return request
    }

    private func perform<T: Decodable>(_ request: URLRequest, as type: T.Type) async throws -> T {
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await http.data(for: request)
        } catch {
            throw DriveAPIError.transport(error.localizedDescription)
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 401 { throw DriveAPIError.notAuthenticated }
        guard (200 ..< 300).contains(status) else {
            let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            let message = body?["message"] as? String
            if status == 404 { throw DriveAPIError.notFound(message ?? "This item no longer exists.") }
            if status == 409, body?["code"] as? String == "trashed" { throw DriveAPIError.trashed(message ?? "This item is in the trash.") }
            if status == 409, body?["code"] as? String == "rotating" { throw DriveAPIError.rotating(message ?? "Keys are being rotated for this folder. Try again in a moment.") }
            if status == 409, body?["code"] as? String == "conflict", (body?["data"] as? [String: Any])?["conflicted"] as? Bool == true {
                throw DriveAPIError.conflicted(message ?? "This file changed while it was uploading.")
            }
            if status == 409, body?["code"] as? String == "stale" { throw DriveAPIError.stale(message ?? "This item changed since you last saw it. Refresh and try again.") }
            throw DriveAPIError.server(status, message ?? "Request failed")
        }
        return try JSONDecoder().decode(type, from: data)
    }

    private func query(_ workspaceId: String, _ more: [URLQueryItem] = []) -> [URLQueryItem] {
        [URLQueryItem(name: "workspaceId", value: workspaceId)] + more
    }

    /* Routes added by other files of this package. */
    func requestPublic(_ path: String, query: [URLQueryItem] = []) throws -> URLRequest { try request(path, query: query) }
    func mutationPublic(_ path: String, method: String = "POST", body: [String: Any]) throws -> URLRequest { try mutation(path, method: method, body: body) }
    func performPublic<T: Decodable>(_ request: URLRequest, as type: T.Type) async throws -> T { try await perform(request, as: type) }

    /* A route outside `/api/drive` (the group routes), with the same cookie and headers. */
    func apiRequest(_ path: String, query: [URLQueryItem] = []) throws -> URLRequest { try request(path, query: query, base: "/api") }

    /* The status and body as they came, for callers that read the refusal's code themselves; no answer at all throws `transport`. */
    func send(_ request: URLRequest) async throws -> (status: Int, data: Data) {
        do {
            let (data, response) = try await http.data(for: request)
            return ((response as? HTTPURLResponse)?.statusCode ?? 0, data)
        } catch {
            throw DriveAPIError.transport(error.localizedDescription)
        }
    }

    // MARK: Reads

    public func workspace() async throws -> WorkspaceView {
        try await perform(try request("/workspace"), as: WorkspaceView.self)
    }

    public func children(of nodeId: String, workspaceId: String, after: String?) async throws -> Listing {
        var query = query(workspaceId)
        if let after { query.append(URLQueryItem(name: "after", value: after)) }
        return try await perform(try request("/nodes/\(nodeId)/children", query: query), as: Listing.self)
    }

    public func versionURL(_ versionId: String, workspaceId: String) async throws -> VersionURL {
        try await perform(try request("/versions/\(versionId)/url", query: query(workspaceId)), as: VersionURL.self)
    }

    public func versions(of nodeId: String, workspaceId: String) async throws -> [VersionListView] {
        try await perform(try request("/nodes/\(nodeId)/versions", query: query(workspaceId)), as: VersionsResponse.self).versions
    }

    public func trashListing(workspaceId: String, after: String?) async throws -> TrashListing {
        let query = after.map { [URLQueryItem(name: "after", value: $0)] } ?? []
        return try await perform(try request("/workspaces/\(workspaceId)/trash", query: query), as: TrashListing.self)
    }

    public func storage(workspaceId: String) async throws -> StorageBreakdown {
        try await perform(try request("/workspaces/\(workspaceId)/storage"), as: StorageBreakdown.self)
    }

    public func changes(workspaceId: String, since: Int, limit: Int = 500) async throws -> ChangeFeed {
        try await perform(try request("/workspaces/\(workspaceId)/changes", query: [
            URLQueryItem(name: "since", value: String(since)),
            URLQueryItem(name: "limit", value: String(limit)),
        ]), as: ChangeFeed.self)
    }

    public func thumbnails(workspaceId: String, versionIds: [String]) async throws -> ThumbnailUrls {
        try await perform(try request("/thumbnails", query: query(workspaceId, [
            URLQueryItem(name: "versions", value: versionIds.joined(separator: ",")),
        ])), as: ThumbnailUrls.self)
    }

    public func sharedWithMe() async throws -> [SharedWithMeView] {
        try await perform(try request("/shares"), as: SharesResponse.self).shares
    }

    /* One byte range of a stored object, from its presigned URL. */
    public func range(_ url: URL, _ range: ByteRange) async throws -> Data {
        var request = URLRequest(url: url)
        request.setValue("bytes=\(range.start)-\(range.end)", forHTTPHeaderField: "Range")
        request.timeoutInterval = 120
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await http.data(for: request)
        } catch {
            throw DriveAPIError.transport(error.localizedDescription)
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 206 || status == 200 else { throw DriveAPIError.server(status, "Range request failed") }
        return data
    }

    // MARK: Writes

    public func allocateEpochs(workspaceId: String, count: Int) async throws -> EpochRange {
        try await perform(try mutation("/workspaces/\(workspaceId)/epochs", body: ["count": count]), as: EpochRange.self)
    }

    /* The drive's top folder, made once; when two devices race, the server keeps one and returns it to both. */
    public func createRoot(workspaceId: String, root: [String: Any]) async throws -> (created: Bool, root: NodeView) {
        struct Reply: Decodable { let created: Bool; let root: NodeView }
        let reply = try await perform(try mutation("/workspaces/\(workspaceId)/root", body: root), as: Reply.self)
        return (reply.created, reply.root)
    }

    public func createFolders(workspaceId: String, folders: [[String: Any]]) async throws -> [NodeView] {
        try await perform(try mutation("/folders", body: ["workspaceId": workspaceId, "folders": folders]), as: FoldersResponse.self).nodes
    }

    /* `metadataSignature` is over `metadataVersion + 1`, the version the server stores. */
    public func rename(nodeId: String, workspaceId: String, metadataVersion: UInt64, keyEpoch: UInt64, metadataEnvelope: String, metadataSignature: String) async throws -> NodeView {
        try await perform(try mutation("/nodes/\(nodeId)/metadata", body: [
            "workspaceId": workspaceId, "metadataVersion": metadataVersion, "keyEpoch": keyEpoch, "metadataEnvelope": metadataEnvelope,
            "metadataSignature": metadataSignature,
        ]), as: NodeResponse.self).node
    }

    public func move(nodeId: String, workspaceId: String, parentId: String, parentKeyEpoch: UInt64, keyEnvelope: String) async throws -> NodeView {
        try await perform(try mutation("/nodes/\(nodeId)/parent", body: [
            "workspaceId": workspaceId, "parentId": parentId, "parentKeyEpoch": parentKeyEpoch, "keyEnvelope": keyEnvelope,
        ]), as: NodeResponse.self).node
    }

    public func copy(sourceNodeId: String, workspaceId: String, body: [String: Any]) async throws -> NodeView {
        var full = body
        full["workspaceId"] = workspaceId
        return try await perform(try mutation("/nodes/\(sourceNodeId)/copy", body: full), as: NodeResponse.self).node
    }

    public func trash(nodeId: String, workspaceId: String) async throws -> NodeView {
        try await perform(try mutation("/nodes/\(nodeId)/trash", body: ["workspaceId": workspaceId]), as: NodeResponse.self).node
    }

    /* Back in place, or under the root with a fresh envelope when the old parent is gone. */
    public func restore(nodeId: String, workspaceId: String, toRoot: (parentKeyEpoch: UInt64, keyEnvelope: String)?) async throws -> NodeView {
        var body: [String: Any] = ["workspaceId": workspaceId]
        if let toRoot { body["toRoot"] = ["parentKeyEpoch": toRoot.parentKeyEpoch, "keyEnvelope": toRoot.keyEnvelope] }
        return try await perform(try mutation("/nodes/\(nodeId)/restore", body: body), as: NodeResponse.self).node
    }

    public func purge(nodeId: String, workspaceId: String) async throws {
        struct Purged: Decodable { let purged: Bool }
        _ = try await perform(try mutation("/nodes/\(nodeId)", method: "DELETE", body: ["workspaceId": workspaceId]), as: Purged.self)
    }

    /* Removes every file's earlier version now, a batch at a time; the same shape as emptying the trash. */
    public func discardSuperseded(workspaceId: String) async throws -> EmptyTrashResult {
        try await perform(try mutation("/workspaces/\(workspaceId)/versions/discard-superseded", body: [:]), as: EmptyTrashResult.self)
    }

    public func emptyTrash(workspaceId: String) async throws -> EmptyTrashResult {
        try await perform(try mutation("/workspaces/\(workspaceId)/trash/empty", body: [:]), as: EmptyTrashResult.self)
    }

    /* Deletes an earlier version now rather than after its 30 days; the current one is never touched. */
    public func discardVersion(_ versionId: String, workspaceId: String) async throws {
        struct Done: Decodable {}
        _ = try await perform(try mutation("/versions/\(versionId)", method: "DELETE", body: ["workspaceId": workspaceId]), as: Done.self)
    }

    public func restoreVersion(_ versionId: String, workspaceId: String) async throws -> NodeView {
        try await perform(try mutation("/versions/\(versionId)/restore", body: ["workspaceId": workspaceId]), as: NodeResponse.self).node
    }

    public func beginUpload(workspaceId: String, body: [String: Any]) async throws -> UploadBegun {
        var full = body
        full["workspaceId"] = workspaceId
        return try await perform(try mutation("/uploads", body: full), as: UploadBegun.self)
    }

    public func partUrls(uploadId: String, workspaceId: String, from: Int, count: Int) async throws -> PartUrls {
        try await perform(try request("/uploads/\(uploadId)/parts", query: query(workspaceId, [
            URLQueryItem(name: "from", value: String(from)),
            URLQueryItem(name: "count", value: String(count)),
        ])), as: PartUrls.self)
    }

    public func completeUpload(uploadId: String, workspaceId: String, parts: [[String: Any]]) async throws -> UploadCompleted {
        try await perform(try mutation("/uploads/\(uploadId)/complete", body: ["workspaceId": workspaceId, "parts": parts]), as: UploadCompleted.self)
    }

    public func abortUpload(uploadId: String, workspaceId: String) async {
        _ = try? await perform(try mutation("/uploads/\(uploadId)/abort", body: ["workspaceId": workspaceId]), as: UploadCompleted.self)
    }

    /* PUTs one encrypted part to its presigned URL; the ETag is what completion needs. */
    public func putPart(_ url: URL, data: Data) async throws -> String {
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.setValue(String(data.count), forHTTPHeaderField: "Content-Length")
        request.timeoutInterval = 300
        let response: URLResponse
        do {
            (_, response) = try await http.upload(for: request, from: data)
        } catch {
            throw DriveAPIError.transport(error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse, (200 ..< 300).contains(http.statusCode) else {
            throw DriveAPIError.server((response as? HTTPURLResponse)?.statusCode ?? 0, "Part upload failed")
        }
        guard let etag = http.value(forHTTPHeaderField: "ETag") else {
            throw DriveAPIError.server(500, "The store returned no ETag")
        }
        return etag
    }
}
