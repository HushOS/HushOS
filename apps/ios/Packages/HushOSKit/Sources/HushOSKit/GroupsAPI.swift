import Foundation
import HushOSCore

/*
 * The group routes a member reads (docs/groups-server.md 4): the account's families (2), one
 * family with its members (3), the member list a page at a time (5), every member's identity
 * and succession links (6), and every space the account can open (25). The same paths and
 * shapes as the web's `apps/web/src/lib/groups/api.ts`; nothing here is trusted until the core
 * has accepted it (FamilySync).
 */

/*
 * A refusal with what decides it: the status, the server's code and its words. Status 0 is no
 * answer at all (an unknown outcome, never a refusal). Only 404 `not-member` lets a client wipe
 * a family (groups-server 0.9).
 */
public struct GroupsAPIError: Error, LocalizedError, Equatable, Sendable {
    public let status: Int
    public let code: String?
    public let message: String

    public var isNotMember: Bool { status == 404 && code == "not-member" }

    /* What the families screens say, as the web's errorCopy words it for a read. */
    public var errorDescription: String? {
        if status == 0 { return GroupsAPIError.noAnswer }
        switch code {
        case "not-member": return "You’re not in this family any more."
        case "rate-limited": return "That’s been tried too often. Wait a little, then try again."
        case "unsupported": return "Update HushOS to do this."
        default: break
        }
        if status == 501 { return "Families aren’t available on this server." }
        return "HushOS couldn’t do that just now. Try again in a moment."
    }

    public static let noAnswer = "Couldn’t reach HushOS. Check your connection, then retry."
}

/* Route 2's row: one family this account accepted an invitation to or is in. */
public struct GroupSummary: Codable, Sendable, Equatable, Identifiable, Hashable {
    public let id: String
    public let kind: String
    public let name: String
    public let roles: [String]
    /* `accepted` (waiting to be let in) or `active`. */
    public let state: String
    public let rosterVersion: Int
    public let groupKeyVersion: Int
}

/* Route 3: the family's members as the server names them (rosters carry no names), with seats. */
public struct GroupDetail: Codable, Sendable, Equatable {
    public struct Member: Codable, Sendable, Equatable, Identifiable, Hashable {
        public let userId: String
        public let name: String
        public let email: String?
        public let state: String
        public let roles: [String]
        public var id: String { userId }
    }
    public struct Seats: Codable, Sendable, Equatable {
        public let used: Int
        public let limit: Int
    }
    public let members: [Member]
    public let seats: Seats?
}

/* A signed roster or succession as route 5 serves it, base64url throughout. */
public struct SignedStatementWire: Codable, Sendable, Equatable {
    public struct Signature: Codable, Sendable, Equatable {
        public let ed25519: String
        public let mlDsa: String
    }
    public let statement: String
    public let signature: Signature
    public let signerSignature: String

    func signed() throws -> SignedGroupStatement {
        SignedGroupStatement(
            statement: try base64urlDecode(value: statement),
            signature: GroupSignature(ed25519: try base64urlDecode(value: signature.ed25519), mlDsa: try base64urlDecode(value: signature.mlDsa)),
            signerSignature: try base64urlDecode(value: signerSignature)
        )
    }
}

/* Route 5's page. */
public struct RosterPage: Codable, Sendable {
    public struct FirstKeys: Codable, Sendable, Equatable {
        public let ed25519PublicKey: String
        public let mlDsaPublicKey: String
    }
    public struct Head: Codable, Sendable, Equatable {
        public let version: Int
        public let digest: String
    }
    public let rosters: [SignedStatementWire]
    public let successions: [SignedStatementWire]
    public let firstKeys: FirstKeys
    public let signerKeys: [String: String]
    public let head: Head?
    public let next: Int?
}

/* Route 6's row: a member's current identity (none for an account that is gone) and links. */
public struct MemberIdentity: Codable, Sendable {
    public struct Identity: Codable, Sendable, Equatable {
        public let keyVersion: UInt64
        public let encryptionPublicKey: String
        public let signingPublicKey: String
        public let mlDsaPublicKey: String
        public let kemPublicKey: String

        var served: ServedKeys {
            ServedKeys(keyVersion: keyVersion, encryptionPublicKey: encryptionPublicKey, signingPublicKey: signingPublicKey,
                       mlDsaPublicKey: mlDsaPublicKey, kemPublicKey: kemPublicKey)
        }
    }
    public struct Link: Codable, Sendable, Equatable {
        public let oldKeyVersion: UInt64
        public let newKeyVersion: UInt64
        public let oldEncryptionPublicKey: String
        public let oldSigningPublicKey: String
        public let oldMlDsaPublicKey: String
        public let newEncryptionPublicKey: String
        public let newSigningPublicKey: String
        public let newMlDsaPublicKey: String
        public let newKemPublicKey: String
        public let signature: String
        public let consent: String?

        var link: SuccessionLink {
            SuccessionLink(
                oldKeyVersion: oldKeyVersion, newKeyVersion: newKeyVersion, oldEncryptionPublicKey: oldEncryptionPublicKey,
                oldSigningPublicKey: oldSigningPublicKey, oldMlDsaPublicKey: oldMlDsaPublicKey, newEncryptionPublicKey: newEncryptionPublicKey,
                newSigningPublicKey: newSigningPublicKey, newMlDsaPublicKey: newMlDsaPublicKey, newKemPublicKey: newKemPublicKey,
                signature: signature, consent: consent
            )
        }
    }
    public let userId: String
    public let identity: Identity?
    public let links: [Link]
}

struct IdentitiesPage: Codable, Sendable {
    let identities: [MemberIdentity]
    let next: String?
}

/* Route 25: every space this account can open, its own first, then each family's areas. */
public struct SpaceList: Codable, Sendable {
    public struct Space: Codable, Sendable, Equatable {
        public let kind: String
        public let groupId: String?
        public let name: String?
    }
    public struct AreaGrant: Codable, Sendable, Equatable {
        public let workspaceKeyVersion: UInt64
        public let granteeKeyVersion: UInt64
        public let granterUserId: String
        public let rosterVersion: UInt64
        public let rosterDigest: String
        public let envelope: String
    }
    public struct Rotation: Codable, Sendable, Equatable {
        public let id: String?
        public let nodeId: String
        public let targetEpoch: UInt64
    }
    public struct Area: Codable, Sendable {
        public let workspaceId: String
        /* A family folder's: the seed its id is derived from under the family. The personal space has none. */
        public let idSeed: String?
        public let workspaceKeyVersion: UInt64
        public let changeSeq: Int?
        public let root: NodeView?
        public let rotation: Rotation?
        public let grant: AreaGrant?
    }
    public struct Entry: Codable, Sendable {
        public let space: Space
        public let areas: [Area]
    }
    public let spaces: [Entry]
}

public final class GroupsAPI: Sendable {
    let drive: DriveAPI

    public init(drive: DriveAPI) { self.drive = drive }

    /* A family id goes into a path only as a lowercase UUID. */
    private func id(_ groupId: String) throws -> String {
        guard FamilyRecords.valid(groupId) else { throw GroupsAPIError(status: 400, code: "invalid", message: "Please try again.") }
        return groupId
    }

    private func get<T: Decodable>(_ path: String, query: [URLQueryItem] = [], as type: T.Type) async throws -> T {
        let status: Int
        let data: Data
        do {
            (status, data) = try await drive.send(try drive.apiRequest(path, query: query))
        } catch DriveAPIError.transport {
            throw GroupsAPIError(status: 0, code: nil, message: GroupsAPIError.noAnswer)
        }
        if status == 401 { throw DriveAPIError.notAuthenticated }
        guard (200 ..< 300).contains(status) else {
            let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            throw GroupsAPIError(status: status, code: body?["code"] as? String, message: body?["message"] as? String ?? "Please try again.")
        }
        return try JSONDecoder().decode(type, from: data)
    }

    /* 2 */
    public func listGroups() async throws -> [GroupSummary] {
        struct Reply: Decodable { let groups: [GroupSummary] }
        return try await get("/groups", as: Reply.self).groups
    }

    /* 3 */
    public func group(_ groupId: String) async throws -> GroupDetail {
        try await get("/groups/\(try id(groupId))", as: GroupDetail.self)
    }

    /* 5: the rosters after `after` (none: from version 1). */
    public func rosters(_ groupId: String, after: Int) async throws -> RosterPage {
        try await get("/groups/\(try id(groupId))/rosters", query: after > 0 ? [URLQueryItem(name: "after", value: String(after))] : [], as: RosterPage.self)
    }

    /* 6 */
    func identities(_ groupId: String, after: String?) async throws -> IdentitiesPage {
        try await get("/groups/\(try id(groupId))/identities", query: after.map { [URLQueryItem(name: "after", value: $0)] } ?? [], as: IdentitiesPage.self)
    }

    /* 25 */
    public func spaces() async throws -> [SpaceList.Entry] {
        try await get("/drive/spaces", as: SpaceList.self).spaces
    }
}
