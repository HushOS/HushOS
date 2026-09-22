import Foundation

/* The Drive API's views, as the server returns them (packages/drive/src/api.ts). */
public struct VersionView: Codable, Sendable, Equatable, Hashable {
    public let id: String
    public let objectId: String
    public let contentKeyEnvelope: String
    public let status: String
    public let contentSuite: UInt32
    public let chunkCount: Int
    public let contentNonce: String
    public let plaintextSize: String?
    public let ciphertextSize: String?
    public let readyAt: String?
}

public struct NodeView: Codable, Sendable, Equatable, Hashable {
    public let id: String
    public let workspaceId: String
    /* Null on the root; for key wrapping the root's parent is the workspace id. */
    public let parentId: String?
    public let kind: String
    public let keyEpoch: UInt64
    public let parentKeyEpoch: UInt64
    public let keyEnvelope: String
    public let metadataVersion: UInt64
    public let metadataEnvelope: String
    public let currentVersion: VersionView?
    public let trashedAt: String?
    public let changeSeq: Int?
    public let createdAt: String?
    public let updatedAt: String?

    public var isFolder: Bool { kind == "folder" }
}

public struct GrantView: Codable, Sendable, Equatable {
    public let version: UInt32
    public let workspaceId: String
    public let keyVersion: UInt64
    public let workspaceKeyVersion: UInt64
    public let wrappingSalt: String
    public let wrappingNonce: String
    public let encryptedKey: String

    var grant: WorkspaceGrant {
        WorkspaceGrant(
            version: version, workspaceId: workspaceId, keyVersion: keyVersion,
            workspaceKeyVersion: workspaceKeyVersion, wrappingSalt: wrappingSalt,
            wrappingNonce: wrappingNonce, encryptedKey: encryptedKey
        )
    }
}

public struct WorkspaceView: Codable, Sendable, Equatable {
    public let workspaceId: String
    public let changeSeq: Int?
    public let grant: GrantView?
    public let root: NodeView?
}

public struct Listing: Codable, Sendable {
    public let folder: NodeView
    public let ancestors: [NodeView]
    public let children: [NodeView]
    public let nextCursor: String?
}

public struct TrashListing: Codable, Sendable {
    public struct Item: Codable, Sendable {
        public let node: NodeView
        public let ancestors: [NodeView]
        public let parentTrashed: Bool
    }
    public let items: [Item]
    public let nextCursor: String?
}

public struct VersionURL: Codable, Sendable {
    public let url: String
    public let urlExpiresAt: String?
}

public struct EpochRange: Codable, Sendable {
    public let from: UInt64
    public let to: UInt64
}

public struct NodeResponse: Codable, Sendable { public let node: NodeView }
public struct FoldersResponse: Codable, Sendable { public let nodes: [NodeView] }

public struct PartUrl: Codable, Sendable {
    public let partNumber: Int
    public let length: Int
    public let url: String
}

public struct UploadView: Codable, Sendable {
    public let id: String
    public let nodeId: String
    public let versionId: String
    public let status: String
    public let chunkCount: Int
}

public struct UploadBegun: Codable, Sendable {
    public let upload: UploadView
    public let parts: [PartUrl]
    public let urlExpiresAt: String
}

public struct PartUrls: Codable, Sendable {
    public let parts: [PartUrl]
    public let urlExpiresAt: String
}

public struct UploadCompleted: Codable, Sendable {
    public let status: String
    public let node: NodeView?
}

public struct NodeChange: Codable, Sendable {
    public let kind: String
    public let changeSeq: Int
    public let node: NodeView?
    public let nodeId: String?
    public let parentId: String?
}

public struct ChangeFeed: Codable, Sendable {
    public let changes: [NodeChange]
    public let resync: Bool
    public let nextCursor: Int
    public let hasMore: Bool
}

public struct ThumbnailUrls: Codable, Sendable {
    public struct Entry: Codable, Sendable {
        public let versionId: String
        public let url: String
    }
    public let urls: [Entry]
}

public struct VersionListView: Codable, Sendable, Identifiable, Hashable {
    public let id: String
    public let objectId: String
    public let contentKeyEnvelope: String
    public let status: String
    public let contentSuite: UInt32
    public let contentNonce: String
    public let plaintextSize: String?
    public let ciphertextSize: String?
    public let current: Bool
    public let supersededAt: String?
    public let createdAt: String
}

public struct VersionsResponse: Codable, Sendable { public let versions: [VersionListView] }

public struct StorageBreakdown: Codable, Sendable {
    public let trashBytes: String
    public let trashItems: Int
    public let supersededBytes: String
    public let supersededVersions: Int
}

public struct EmptyTrashResult: Codable, Sendable {
    public let purged: Int
    public let remaining: Int
}

public struct SharedWithMeView: Codable, Sendable, Identifiable {
    public struct Granter: Codable, Sendable {
        public let id: String
        public let name: String
        public let email: String
        public let encryptionPublicKey: String
    }
    public let id: String
    public let workspaceId: String
    public let role: String
    public let keyEpoch: Int
    public let shareEnvelope: String
    public let prevShareEnvelope: String?
    public let prevKeyEpoch: Int?
    public let createdAt: String
    public let granter: Granter
    public let node: NodeView
}

public struct SharesResponse: Codable, Sendable { public let shares: [SharedWithMeView] }

/* The server writes ISO 8601 with fractional seconds; metadata dates may omit them. */
public func parseDate(_ value: String?) -> Date? {
    guard let value else { return nil }
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value)
}
