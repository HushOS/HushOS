import Foundation
import HushOSCore
import Testing
@testable import HushOSKit

/*
 * A master-key rotation's grants, as the challenge serves them (`Auth.rewrapGrants`, the step of
 * `rotateKeys` after the OPAQUE exchange, which no stub can answer: the core carries no OPAQUE
 * server). The web's own grants (crates/hushos-core/fixtures/web.json): its personal grant and a
 * family folder's self-grant, both under one account key. The self-grant must be rewrapped as its
 * family's; read as a personal grant it does not open, and the rotation must be refused.
 */
struct MasterKeyRotationTests {
    let web: [String: Any]
    let area: [String: Any]
    let userId: String
    let groupId: String
    let oldRoot: Data

    init() throws {
        let here = URL(fileURLWithPath: #filePath)
        let file = here.deletingLastPathComponent().appendingPathComponent("../../../../../../crates/hushos-core/fixtures/web.json").standardized
        web = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [String: Any]
        area = web["areaSelfGrant"] as! [String: Any]
        userId = area["userId"] as! String
        groupId = area["groupId"] as! String
        oldRoot = try base64urlDecode(value: area["accountKey"] as! String)
    }

    /* The challenge's rows: the personal grant (no family) and the self-grant, its family under `key`. */
    func served(familyKey key: String = "groupId", family: Any? = nil) -> [[String: Any]] {
        var personal = (web["workspace"] as! [String: Any])["grant"] as! [String: Any]
        personal["groupId"] = NSNull()
        var own = area["grant"] as! [String: Any]
        own[key] = family ?? groupId
        return [personal, own]
    }

    @Test func aFamilyRowIsRewrappedUnderItsFamilyAndThePersonalOneAsPersonal() throws {
        let newRoot = try randomBytes(length: 32)
        let rewrapped = try Auth.rewrapGrants(served(), userId: userId, oldRoot: oldRoot, newRoot: newRoot, keyVersion: 3)
        #expect(rewrapped.map(\.keyVersion) == [3, 3])
        let workspace = web["workspace"] as! [String: Any]
        #expect(try workspaceOpen(userId: userId, accountKey: newRoot, grant: rewrapped[0]) == base64urlDecode(value: workspace["workspaceKey"] as! String))
        // Bound to the family under the new root: the personal opener refuses it, and only a
        // rewrap as the family's (which opens it first) takes it on.
        #expect(throws: (any Error).self) { try workspaceOpen(userId: userId, accountKey: newRoot, grant: rewrapped[1]) }
        let again = try areaSelfGrantRewrap(userId: userId, groupId: groupId, oldRoot: newRoot, newRoot: try randomBytes(length: 32), grant: rewrapped[1], keyVersion: 4)
        #expect(again.workspaceKeyVersion == rewrapped[1].workspaceKeyVersion)
        #expect(throws: (any Error).self) {
            try areaSelfGrantRewrap(userId: userId, groupId: groupId, oldRoot: oldRoot, newRoot: try randomBytes(length: 32), grant: rewrapped[1], keyVersion: 4)
        }
    }

    @Test func aSelfGrantServedWithoutItsFamilyOrWithAnotherIsRefused() throws {
        let newRoot = try randomBytes(length: 32)
        // A misspelled key reads as no family: the personal path, which cannot open it.
        #expect(throws: (any Error).self) { try Auth.rewrapGrants(served(familyKey: "groupID"), userId: userId, oldRoot: oldRoot, newRoot: newRoot, keyVersion: 3) }
        #expect(throws: (any Error).self) { try Auth.rewrapGrants(served(family: NSNull()), userId: userId, oldRoot: oldRoot, newRoot: newRoot, keyVersion: 3) }
        #expect(throws: (any Error).self) {
            try Auth.rewrapGrants(served(family: "44444444-4444-4444-8444-444444444444"), userId: userId, oldRoot: oldRoot, newRoot: newRoot, keyVersion: 3)
        }
    }
}
