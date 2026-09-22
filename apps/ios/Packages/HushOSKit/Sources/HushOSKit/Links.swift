import Foundation
import HushOSCore

/* A link as the owner sees it: what `GET /api/drive/nodes/:id/links` lists. */
public struct LinkView: Codable, Sendable, Identifiable, Hashable {
    public let id: String
    public let keyEpoch: UInt64
    public let secretEnvelope: String?
    public let hasPassword: Bool
    public let expiresAt: String?
    public let useCount: Int
    public let lastUsedAt: String?
    public let createdAt: String
}

struct LinksResponse: Codable, Sendable { let links: [LinkView] }
struct LinkResponse: Codable, Sendable { let link: LinkView }

/* What the server hands a visitor for a token: enough to open the root with the fragment secret. */
public struct OpenedLink: Codable, Sendable {
    public struct Link: Codable, Sendable {
        public let id: String
        public let workspaceId: String
        public let keyEpoch: UInt64
        public let hasPassword: Bool
        public let linkSalt: String
        public let linkEnvelope: String
        public let expiresAt: String?
    }
    public let link: Link
    public let node: NodeView
}

extension DriveAPI {
    public func links(of nodeId: String, workspaceId: String) async throws -> [LinkView] {
        try await performPublic(try requestPublic("/nodes/\(nodeId)/links", query: [URLQueryItem(name: "workspaceId", value: workspaceId)]), as: LinksResponse.self).links
    }

    public func createLink(nodeId: String, body: [String: Any]) async throws -> LinkView {
        try await performPublic(try mutationPublic("/nodes/\(nodeId)/links", body: body), as: LinkResponse.self).link
    }

    public func revokeLink(_ linkId: String, workspaceId: String) async throws {
        struct Revoked: Decodable { let revoked: Bool }
        _ = try await performPublic(try mutationPublic("/links/\(linkId)", method: "DELETE", body: ["workspaceId": workspaceId]), as: Revoked.self)
    }
}

/*
 * The routes that need no session: what a visitor with a link, or anyone
 * filing a report, talks to. Same client header, no cookie.
 */
public final class PublicAPI: Sendable {
    public let origin: String
    private let http = URLSession(configuration: .ephemeral)

    public init(origin: String) { self.origin = origin }

    private func request(_ path: String, query: [URLQueryItem] = []) throws -> URLRequest {
        guard var components = URLComponents(string: origin + "/api/drive" + path) else { throw DriveAPIError.server(500, "Bad API path") }
        if !query.isEmpty { components.queryItems = query }
        guard let url = components.url else { throw DriveAPIError.server(500, "Bad API path") }
        var request = URLRequest(url: url)
        request.httpShouldHandleCookies = false
        request.setValue("ios/2", forHTTPHeaderField: "HushOS-Client")
        request.setValue(origin, forHTTPHeaderField: "Origin")
        request.timeoutInterval = 30
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
        guard (200 ..< 300).contains(status) else {
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["message"] as? String
            if status == 404 { throw DriveAPIError.notFound(message ?? "This link no longer works.") }
            throw DriveAPIError.server(status, message ?? "Request failed")
        }
        return try JSONDecoder().decode(type, from: data)
    }

    func post<T: Decodable>(_ path: String, body: [String: Any], as type: T.Type) async throws -> T {
        var request = try request(path)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        return try await perform(request, as: type)
    }

    public func openLink(token: String) async throws -> OpenedLink {
        try await perform(try request("/links/\(token)/open"), as: OpenedLink.self)
    }

    public func linkChildren(token: String, nodeId: String, after: String?) async throws -> Listing {
        let query = after.map { [URLQueryItem(name: "after", value: $0)] } ?? []
        return try await perform(try request("/links/\(token)/nodes/\(nodeId)/children", query: query), as: Listing.self)
    }

    public func linkVersionURL(token: String, versionId: String) async throws -> VersionURL {
        try await perform(try request("/links/\(token)/versions/\(versionId)/url"), as: VersionURL.self)
    }

    public func linkThumbnails(token: String, versionIds: [String]) async throws -> ThumbnailUrls {
        try await perform(try request("/links/\(token)/thumbnails", query: [URLQueryItem(name: "versions", value: versionIds.joined(separator: ","))]), as: ThumbnailUrls.self)
    }

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
}

extension Vault {
    /* The links the owner made for this item. */
    public func links(for item: Opened) async throws -> [LinkView] {
        try await api.links(of: item.id, workspaceId: item.node.workspaceId)
    }

    /* Mints a link for an item this account holds the key of, and returns the URL to hand out. */
    public func createLink(for item: Opened, password: String?, expiresAt: Date?) async throws -> (link: LinkView, url: URL) {
        guard let nodeKey = nodeKeys[item.id] else { throw DriveAPIError.server(500, "Node not opened") }
        let ctx = LinkContext(workspaceId: item.node.workspaceId, nodeId: item.id, keyEpoch: item.node.keyEpoch, linkId: UUID().uuidString.lowercased())
        let created = try linkCreate(ctx: ctx, nodeKey: nodeKey, password: password)
        var body: [String: Any] = [
            "workspaceId": item.node.workspaceId, "linkId": ctx.linkId, "token": created.token, "keyEpoch": item.node.keyEpoch,
            "linkEnvelope": created.linkEnvelope, "linkSalt": created.linkSalt, "secretEnvelope": created.secretEnvelope,
            "hasPassword": created.hasPassword, "expiresAt": NSNull(),
        ]
        if let expiresAt { body["expiresAt"] = ISO8601DateFormatter().string(from: expiresAt) }
        let link = try await api.createLink(nodeId: item.id, body: body)
        guard let url = URL(string: try linkUrl(origin: session.origin, token: created.token, secret: created.secret)) else {
            throw DriveAPIError.server(500, "Bad link URL")
        }
        return (link, url)
    }

    /* The URL of an existing link, from the owner's sealed copy of its secret. */
    public func linkURL(_ link: LinkView, for item: Opened) throws -> URL? {
        guard let nodeKey = nodeKeys[item.id], let sealed = link.secretEnvelope else { return nil }
        let ctx = LinkContext(workspaceId: item.node.workspaceId, nodeId: item.id, keyEpoch: link.keyEpoch, linkId: link.id)
        let owned = try linkSecretOpen(ctx: ctx, nodeKey: nodeKey, envelope: try base64urlDecode(value: sealed))
        return URL(string: try linkUrl(origin: session.origin, token: base64urlEncode(bytes: owned.token), secret: base64urlEncode(bytes: owned.secret)))
    }

    public func revokeLink(_ link: LinkView, for item: Opened) async throws {
        try await api.revokeLink(link.id, workspaceId: item.node.workspaceId)
    }
}

/*
 * A visitor's view through one link: the root opened with the fragment secret
 * (and the password when the link has one), every node below it under the
 * usual node keys, and content by the link's own download routes.
 */
public actor LinkVault {
    public let api: PublicAPI
    public let token: String
    private let secret: String
    private var link: OpenedLink?
    private var nodeKeys: [String: Data] = [:]
    private var opened: [String: Opened] = [:]

    public init(origin: String, url: String) throws {
        let parts = try linkParse(url: url)
        api = PublicAPI(origin: origin)
        token = parts.token
        secret = parts.secret
    }

    /* Whether the link wants a password; fetches the link once. */
    public func needsPassword() async throws -> Bool {
        try await load().link.hasPassword
    }

    private func load() async throws -> OpenedLink {
        if let link { return link }
        let fetched = try await api.openLink(token: token)
        link = fetched
        return fetched
    }

    public func rootId() async throws -> String { try await load().node.id }

    /* Opens the root: the node key from the secret and password, then its name. */
    public func open(password: String?) async throws -> Opened {
        let fetched = try await load()
        let ctx = LinkContext(workspaceId: fetched.link.workspaceId, nodeId: fetched.node.id, keyEpoch: fetched.link.keyEpoch, linkId: fetched.link.id)
        let key = try linkOpen(
            ctx: ctx, envelope: try base64urlDecode(value: fetched.link.linkEnvelope), secret: try base64urlDecode(value: secret),
            password: password, salt: try base64urlDecode(value: fetched.link.linkSalt)
        )
        let node = fetched.node
        let metadata = try metadataOpen(
            ctx: MetadataContext(workspaceId: node.workspaceId, nodeId: node.id, metadataVersion: node.metadataVersion),
            nodeKey: key, envelope: try base64urlDecode(value: node.metadataEnvelope)
        )
        nodeKeys[node.id] = key
        let root = Opened(node: node, metadata: metadata)
        opened[node.id] = root
        return root
    }

    private func open(_ node: NodeView) throws -> Opened {
        if let done = opened[node.id] { return done }
        guard let parentId = node.parentId, let parentKey = nodeKeys[parentId] else {
            throw DriveAPIError.server(500, "This item is outside the link.")
        }
        let ctx = NodeKeyContext(workspaceId: node.workspaceId, nodeId: node.id, parentId: parentId, parentKeyEpoch: node.parentKeyEpoch, keyEpoch: node.keyEpoch)
        let key = try nodeOpen(ctx: ctx, parentKey: parentKey, keyEnvelope: try base64urlDecode(value: node.keyEnvelope))
        let metadata = try metadataOpen(
            ctx: MetadataContext(workspaceId: node.workspaceId, nodeId: node.id, metadataVersion: node.metadataVersion),
            nodeKey: key, envelope: try base64urlDecode(value: node.metadataEnvelope)
        )
        nodeKeys[node.id] = key
        let result = Opened(node: node, metadata: metadata)
        opened[node.id] = result
        return result
    }

    /* A folder's children, opened and sorted folders first. */
    public func children(of folderId: String) async throws -> [Opened] {
        var after: String? = nil
        var all: [Opened] = []
        repeat {
            let page = try await api.linkChildren(token: token, nodeId: folderId, after: after)
            for child in page.children { all.append(try open(child)) }
            after = page.nextCursor
        } while after != nil
        return all.sorted(by: Opened.byName)
    }

    private func openVersion(_ item: Opened) throws -> OpenedVersion {
        guard let nodeKey = nodeKeys[item.id] else { throw DriveAPIError.server(500, "Node not opened") }
        guard let current = item.node.currentVersion else { throw DriveAPIError.notFound("This file has no content yet.") }
        let opened = try HushOSCore.versionOpen(
            ctx: VersionContext(workspaceId: item.node.workspaceId, nodeId: item.id, versionId: current.id, objectId: current.objectId),
            suite: current.contentSuite, nodeKey: nodeKey, envelope: try base64urlDecode(value: current.contentKeyEnvelope),
            rowSize: current.plaintextSize.flatMap { UInt64($0) }
        )
        let content = Content(
            workspaceId: item.node.workspaceId, objectId: current.objectId, suite: current.contentSuite, key: opened.key,
            nonce: try base64urlDecode(value: current.contentNonce), plaintextSize: opened.plaintextSize, thumbnailBytes: opened.thumbnailBytes
        )
        return OpenedVersion(content: content, versionId: current.id)
    }

    public func download(_ item: Opened, to destination: URL, progress: @Sendable (Double) -> Void = { _ in }) async throws {
        let opened = try openVersion(item)
        let url = try await api.linkVersionURL(token: token, versionId: opened.versionId)
        guard var objectURL = URL(string: url.url) else { throw DriveAPIError.server(500, "Bad object URL") }
        // Resumable: a dropped chunk is fetched again, an expired address renewed, and a `.part`
        // an earlier try left is continued from its last whole chunk; it moves into place whole.
        try await Resumable.download(
            to: destination, count: opened.layout.chunkCount, chunkBytes: opened.layout.chunkBytes,
            onExpired: { if let fresh = URL(string: (try await api.linkVersionURL(token: token, versionId: opened.versionId)).url) { objectURL = fresh } },
            progress: progress
        ) { index in
            let ciphertext = try await api.range(objectURL, chunkRange(plaintextSize: opened.content.plaintextSize, index: index))
            return try chunkDecrypt(content: opened.content, index: index, ciphertext: ciphertext)
        }
    }

    public func thumbnail(_ item: Opened) async throws -> Data? {
        guard item.hasThumbnail, let version = item.node.currentVersion else { return nil }
        let opened = try openVersion(item)
        guard opened.content.thumbnailBytes > 0 else { return nil }
        let urls = try await api.linkThumbnails(token: token, versionIds: [version.id])
        guard let entry = urls.urls.first, let url = URL(string: entry.url) else { return nil }
        let ciphertext = try await api.range(url, thumbnailRange(plaintextSize: opened.content.plaintextSize, thumbnailBytes: opened.content.thumbnailBytes))
        return try thumbnailDecrypt(content: opened.content, ciphertext: ciphertext)
    }

    /* Files a report on the linked item, sealing its key to every operator; anonymous. */
    public func report(_ item: Opened, category: String, reason: String, email: String?) async throws -> Bool {
        guard let nodeKey = nodeKeys[item.id] else { throw DriveAPIError.server(500, "Node not opened") }
        let body = try await Reports.body(api: api, item: item, nodeKey: nodeKey, category: category, reason: reason, email: email, via: ["link": token])
        return try await api.post("/reports", body: body, as: ReportFiled.self).duplicate
    }
}
