import Foundation

public enum DriveAPIError: Error, LocalizedError, Sendable {
    case notAuthenticated
    case server(Int, String)
    case transport(String)
    case notFound(String)

    public var errorDescription: String? {
        switch self {
        case .notAuthenticated: return "Sign in to HushOS to see your files."
        case .server(_, let message), .notFound(let message): return message
        case .transport: return "Could not reach HushOS. Check your connection."
        }
    }
}

/*
 * The Drive API over URLSession with the session cookie the app or the
 * sign-in sheet left in the keychain. Every method is one route; the vault
 * turns their envelopes into keys and names.
 */
public final class DriveAPI: Sendable {
    public let session: SharedKeychain.Session
    private let http = URLSession(configuration: .ephemeral)

    public init(session: SharedKeychain.Session) {
        self.session = session
    }

    private var cookieName: String {
        session.origin.hasPrefix("https:") ? "__Host-hushos-session" : "hushos-session"
    }

    private func request(_ path: String, query: [URLQueryItem] = []) throws -> URLRequest {
        guard var components = URLComponents(string: session.origin + "/api/drive" + path) else {
            throw DriveAPIError.server(500, "Bad API path")
        }
        if !query.isEmpty { components.queryItems = query }
        guard let url = components.url else { throw DriveAPIError.server(500, "Bad API path") }
        var request = URLRequest(url: url)
        request.httpShouldHandleCookies = false
        request.setValue("\(cookieName)=\(session.token)", forHTTPHeaderField: "Cookie")
        request.setValue("ios/2", forHTTPHeaderField: "HushOS-Client")
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
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["message"] as? String
            if status == 404 { throw DriveAPIError.notFound(message ?? "This item no longer exists.") }
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

    public func createFolders(workspaceId: String, folders: [[String: Any]]) async throws -> [NodeView] {
        try await perform(try mutation("/folders", body: ["workspaceId": workspaceId, "folders": folders]), as: FoldersResponse.self).nodes
    }

    public func rename(nodeId: String, workspaceId: String, metadataVersion: UInt64, keyEpoch: UInt64, metadataEnvelope: String) async throws -> NodeView {
        try await perform(try mutation("/nodes/\(nodeId)/metadata", body: [
            "workspaceId": workspaceId, "metadataVersion": metadataVersion, "keyEpoch": keyEpoch, "metadataEnvelope": metadataEnvelope,
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

    public func emptyTrash(workspaceId: String) async throws -> EmptyTrashResult {
        try await perform(try mutation("/workspaces/\(workspaceId)/trash/empty", body: [:]), as: EmptyTrashResult.self)
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
