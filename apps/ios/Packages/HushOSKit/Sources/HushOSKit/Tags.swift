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

public struct TagRegistry: Codable, Sendable, Equatable {
    public var version: Int
    public var tags: [Tag]
    /* Tag id -> the ids of the nodes carrying it. */
    public var items: [String: [String]]

    public static let empty = TagRegistry(version: 2, tags: [], items: [:])
    public static let presets = ["blue", "ink", "yellow", "teal", "coral"]
    public static let maxTags = 200
    public static let maxPerNode = 16

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
        for tag in tags {
            var nodes = items[tag.id] ?? []
            nodes.removeAll { $0 == nodeId }
            if tagIds.contains(tag.id) { nodes.append(nodeId) }
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
        guard let document = try await api.document(workspaceId: workspace.workspaceId, kind: Self.tagsKind) else {
            return (.empty, 0)
        }
        let json = try documentOpen(
            ctx: DocumentContext(workspaceId: workspace.workspaceId, kind: Self.tagsKind, version: UInt64(document.version)),
            workspaceKey: key, envelope: try base64urlDecode(value: document.envelope)
        )
        let registry = try JSONDecoder().decode(TagRegistry.self, from: Data(json.utf8))
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
            let json = String(decoding: try JSONEncoder().encode(registry), as: UTF8.self)
            let envelope = try documentSeal(
                ctx: DocumentContext(workspaceId: workspace.workspaceId, kind: Self.tagsKind, version: UInt64(version + 1)),
                workspaceKey: key, json: json
            )
            do {
                _ = try await api.putDocument(workspaceId: workspace.workspaceId, kind: Self.tagsKind, version: version, envelope: base64urlEncode(bytes: envelope))
                return registry
            } catch DriveAPIError.server(409, _) where attempt == 0 {
                attempt += 1
            }
        }
    }
}
