import Foundation

/*
 * Tags: flat sets an item belongs to across folders. The workspace keeps one
 * registry as a sealed document under the workspace key (tags, and which
 * items carry each), so a share's recipient learns nothing of them and
 * tagging never touches a node's envelope.
 */
public struct Tag: Codable, Sendable, Identifiable, Hashable {
    public var id: String
    public var name: String
    public var colour: String
    public init(id: String, name: String, colour: String) {
        self.id = id
        self.name = name
        self.colour = colour
    }
}

/*
 * The registry as edited here, over the document as read: `raw` is the opened JSON, kept whole, so a
 * field a newer client writes (beside `tags`, inside a tag, or in `items` under a key that is no tag)
 * survives a save from this one. `tags` and `items` are the parts this version reads and edits; `json()`
 * writes them over `raw` and leaves the rest as it was.
 */
public struct TagRegistry: Sendable, Equatable {
    public var version: Int
    public var tags: [Tag]
    /* Tag id -> the ids of the nodes carrying it. */
    public var items: [String: [String]]
    /* The document as read, serialised; empty for a registry that has none yet. */
    private var raw: Data = Data()
    /* The ids `items` speaks for: the tags as read and any made since. A key in raw `items` outside these is not ours to drop. */
    private var known: Set<String> = []

    public static let empty = TagRegistry(version: 2, tags: [], items: [:])
    public static let presets = ["blue", "ink", "yellow", "teal", "coral"]
    public static let maxTags = 200
    public static let maxPerNode = 16

    public init(version: Int, tags: [Tag], items: [String: [String]]) {
        self.version = version
        self.tags = tags
        self.items = items
        known = Set(tags.map(\.id))
    }

    /* Reads an opened document; a version this app doesn't know is a format it can't write back, as on the web. */
    public init(json: Data) throws {
        guard let document = try JSONSerialization.jsonObject(with: json) as? [String: Any] else { throw AuthError.message("The tag list could not be read.") }
        guard let version = document["version"] as? Int, version == 1 || version == 2 else { throw AuthError.message("The tag list was made by a newer app.") }
        struct Known: Decodable { let tags: [Tag] }
        let tags = try JSONDecoder().decode(Known.self, from: json).tags
        let rawItems = document["items"] as? [String: Any] ?? [:]
        var items: [String: [String]] = [:]
        for tag in tags { if let nodes = rawItems[tag.id] as? [String] { items[tag.id] = nodes } }
        self.init(version: 2, tags: tags, items: items)
        raw = json
    }

    /* The document to seal: what was read, with the tags and memberships as they are now. */
    public func json() throws -> String {
        var document = raw.isEmpty ? [:] : (try JSONSerialization.jsonObject(with: raw) as? [String: Any] ?? [:])
        var rawTags: [String: [String: Any]] = [:]
        for entry in document["tags"] as? [Any] ?? [] {
            if let entry = entry as? [String: Any], let id = entry["id"] as? String { rawTags[id] = entry }
        }
        document["tags"] = tags.map { tag -> [String: Any] in
            var entry = rawTags[tag.id] ?? [:]
            entry["id"] = tag.id
            entry["name"] = tag.name
            entry["colour"] = tag.colour
            return entry
        }
        var rawItems = document["items"] as? [String: Any] ?? [:]
        for id in known { rawItems[id] = nil }
        for (id, nodes) in items where !nodes.isEmpty { rawItems[id] = nodes }
        document["items"] = rawItems
        document["version"] = 2
        let data = try JSONSerialization.data(withJSONObject: document, options: [.sortedKeys, .withoutEscapingSlashes])
        return String(decoding: data, as: UTF8.self)
    }

    public func tags(of nodeId: String) -> [Tag] {
        tags.filter { items[$0.id]?.contains(nodeId) ?? false }
    }

    public func nodes(with tagId: String) -> [String] { items[tagId] ?? [] }

    public mutating func add(name: String) throws -> Tag {
        let clean = try TagRegistry.checkName(name)
        if let existing = tags.first(where: { $0.name.caseInsensitiveCompare(clean) == .orderedSame }) { return existing }
        guard tags.count < TagRegistry.maxTags else { throw AuthError.message("A workspace can have at most 200 tags.") }
        let tag = Tag(id: UUID().uuidString.lowercased(), name: clean, colour: TagRegistry.presets[tags.count % TagRegistry.presets.count])
        tags.append(tag)
        known.insert(tag.id)
        return tag
    }

    public mutating func rename(_ id: String, to name: String) throws {
        let clean = try TagRegistry.checkName(name)
        guard let index = tags.firstIndex(where: { $0.id == id }) else { return }
        tags[index].name = clean
    }

    public mutating func recolour(_ id: String, to colour: String) {
        guard let index = tags.firstIndex(where: { $0.id == id }) else { return }
        tags[index].colour = colour
    }

    public mutating func remove(_ id: String) {
        tags.removeAll { $0.id == id }
        items[id] = nil
    }

    public mutating func assign(_ nodeId: String, tagIds: [String]) throws {
        guard tagIds.count <= TagRegistry.maxPerNode else { throw AuthError.message("An item can carry at most 16 tags.") }
        // A tag the node keeps keeps its place in the list, as on the web; only what changed moves.
        for tag in tags {
            var nodes = items[tag.id] ?? []
            if tagIds.contains(tag.id) { if !nodes.contains(nodeId) { nodes.append(nodeId) } } else { nodes.removeAll { $0 == nodeId } }
            if nodes.isEmpty { items[tag.id] = nil } else { items[tag.id] = nodes }
        }
    }

    static func checkName(_ name: String) throws -> String {
        let clean = name.trimmingCharacters(in: .whitespaces).split(separator: " ").joined(separator: " ")
        let points = clean.unicodeScalars.count
        guard points >= 1 else { throw AuthError.message("Enter a tag name.") }
        guard points <= 40 else { throw AuthError.message("Use a tag name of at most 40 characters.") }
        return clean
    }
}

public struct DocumentView: Codable, Sendable {
    public let kind: String
    public let version: Int
    public let envelope: String
    public let updatedAt: String
    /* As on node rows: absent means 1, anything else is a newer client's. */
    public var envelopeSuite: Int? = nil
}

extension DriveAPI {
    public func document(workspaceId: String, kind: String) async throws -> DocumentView? {
        struct Body: Decodable { let document: DocumentView? }
        return try await performPublic(try requestPublic("/workspaces/\(workspaceId)/documents/\(kind)"), as: Body.self).document
    }

    /* `version` is the one this write is based on; the server refuses a stale base with `stale`. */
    public func putDocument(workspaceId: String, kind: String, version: Int, envelope: String) async throws -> DocumentView {
        struct Body: Decodable { let document: DocumentView }
        return try await performPublic(try mutationPublic("/workspaces/\(workspaceId)/documents/\(kind)", method: "PUT", body: ["version": version, "envelope": envelope]), as: Body.self).document
    }
}

extension Vault {
    private static let tagsKind = "tags"

    /* The registry as the workspace holds it, and the version to base the next write on. */
    public func tags() async throws -> (registry: TagRegistry, version: Int) {
        let workspace = try await loadWorkspace()
        guard let key = workspaceKeyData() else { throw DriveAPIError.server(500, "Workspace not opened") }
        // Kept sealed in the mirror, so the registry reads without network too.
        struct Cached: Codable { let envelope: String?; let version: Int; var envelopeSuite: Int? = nil }
        let cacheKey = "tags:\(workspace.workspaceId)"
        let document: DocumentView?
        do {
            document = try await api.document(workspaceId: workspace.workspaceId, kind: Self.tagsKind)
            if let data = try? JSONEncoder().encode(Cached(envelope: document?.envelope, version: document?.version ?? 0, envelopeSuite: document?.envelopeSuite)) { mirror?.putDocument(cacheKey, data) }
        } catch DriveAPIError.transport(let message) {
            guard let data = mirror?.document(cacheKey), let cached = try? JSONDecoder().decode(Cached.self, from: data) else { throw DriveAPIError.transport(message) }
            document = cached.envelope.map { DocumentView(kind: Self.tagsKind, version: cached.version, envelope: $0, updatedAt: "", envelopeSuite: cached.envelopeSuite) }
        }
        guard let document else { return (.empty, 0) }
        if let suite = document.envelopeSuite, suite != NodeView.readableEnvelopeSuite { throw DriveAPIError.newerEnvelope }
        let json = try documentOpen(
            ctx: DocumentContext(workspaceId: workspace.workspaceId, kind: Self.tagsKind, version: UInt64(document.version)),
            workspaceKey: key, envelope: try base64urlDecode(value: document.envelope)
        )
        let registry = try TagRegistry(json: Data(json.utf8))
        return (registry, document.version)
    }

    /* Seals and writes the registry one version up; a stale base is reloaded and the change reapplied once. */
    public func saveTags(_ change: @Sendable (inout TagRegistry) throws -> Void) async throws -> TagRegistry {
        let workspace = try await loadWorkspace()
        guard let key = workspaceKeyData() else { throw DriveAPIError.server(500, "Workspace not opened") }
        var attempt = 0
        while true {
            var (registry, version) = try await tags()
            try change(&registry)
            let json = try registry.json()
            let envelope = try documentSeal(
                ctx: DocumentContext(workspaceId: workspace.workspaceId, kind: Self.tagsKind, version: UInt64(version + 1)),
                workspaceKey: key, json: json
            )
            do {
                _ = try await api.putDocument(workspaceId: workspace.workspaceId, kind: Self.tagsKind, version: version, envelope: base64urlEncode(bytes: envelope))
                return registry
            } catch DriveAPIError.server(409, _) where attempt == 0 {
                attempt += 1
            } catch DriveAPIError.stale where attempt == 0 {
                attempt += 1
            }
        }
    }
}
