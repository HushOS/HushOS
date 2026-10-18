import Foundation
import HushOSCore

/*
 * The vault's side of families (docs/groups-mobile-plan.md, iOS 1): the area ledger opened for
 * this account, the settings' family pins handed to it, family folder nodes opened through it,
 * and every write into a family folder refused, since this version reads them only.
 */

extension NodeView {
    /* The node's key envelopes as the area ledger takes them: a root's parent is its workspace. */
    func servedKey() throws -> ServedNodeKey {
        ServedNodeKey(
            nodeId: id, parentId: parentId ?? workspaceId, parentKeyEpoch: parentKeyEpoch, keyEpoch: keyEpoch,
            keyEnvelope: try base64urlDecode(value: keyEnvelope),
            prevKeyEnvelope: try prevKeyEnvelope.map { try base64urlDecode(value: $0) },
            prevKeyEpoch: prevKeyEpoch, prevParentKeyEpoch: prevParentKeyEpoch
        )
    }
}

public enum FamilyWriteError: Error, LocalizedError, Equatable {
    case readOnly
    public var errorDescription: String? { FamilyWords.readOnly }
}

extension Vault {
    /*
     * The ledger opened for this account: its user id and current signing key, and the root the
     * device store's key comes from; then the account's own workspace, so a family whose member
     * list names it can never lock the drive. Called before every family sync: the same account
     * keeps what the ledger holds, another clears it.
     */
    func prepareLedger() async throws {
        let keys = try await identityKeys()
        try areaLedger.openAccount(userId: session.userId, signingPublicKey: try base64urlDecode(value: keys.signingPublicKey), accountKey: try unlockAccount())
        let view = try await loadWorkspace()
        if let key = workspaceKeyData() {
            try areaLedger.openPersonalWorkspace(workspaceId: view.workspaceId, version: view.grant?.workspaceKeyVersion ?? 1, workspaceKey: key)
        }
    }

    /*
     * The settings document handed to the ledger as the server served it: the ledger opens the
     * settings key under the account root it holds and the document under that key, and takes the
     * family pins (its marks) and contact pins (the only ones a roster call or join code reads)
     * from what it opened itself, as the web worker does (Core 6). None stored is "no settings";
     * a version 1 row (served as none at a later sequence) is legacy settings, which open nowhere.
     * The ledger refuses none or legacy after settings that opened.
     */
    func useForFamilies(_ settings: Settings) throws {
        if settings.version == 0 {
            try areaLedger.useSettingsEnvelope(userId: session.userId, keyEnvelope: nil, settingsEnvelope: nil)
        } else if let served = settings.served {
            try areaLedger.useSettingsEnvelope(userId: session.userId, keyEnvelope: settings.keyEnvelope, settingsEnvelope: served)
        } else {
            try areaLedger.legacySettings(userId: session.userId)
        }
    }

    /*
     * The settings read afresh, their family pins handed to the ledger as marks (refused here, not
     * ignored, when they roll back), and this family's pin: nil when there is none, refused when
     * one is there and doesn't read.
     */
    func familyPin(_ groupId: String) async throws -> GroupPin? {
        let settings = try await loadSettings()
        try useForFamilies(settings)
        return try settings.groupPin(groupId)
    }

    /*
     * Compare and set: `pin` saved as the family's mark only while the stored one is still
     * `expected` (read again inside the save, which another device's write makes read again).
     * False when it changed meanwhile, and nothing was saved.
     */
    func saveGroupPin(_ groupId: String, over expected: GroupPin?, _ pin: GroupPin) async throws -> Bool {
        struct Moved: Error {}
        do {
            try await updateSettings { settings in
                guard try settings.groupPin(groupId) == expected else { throw Moved() }
                settings.setGroupPin(groupId, pin)
            }
            return true
        } catch is Moved {
            return false
        }
    }

    /* This account's identities as acceptance checks its own entries: those with post-quantum keys. */
    func ownIdentities() async throws -> OwnIdentities {
        let all = try await allIdentities()
        return OwnIdentities(userId: session.userId, identities: all.compactMap { keys in
            guard let mlDsa = keys.mlDsaPublicKey, let kem = keys.kemPublicKey else { return nil }
            return ServedKeys(keyVersion: keys.keyVersion, encryptionPublicKey: keys.encryptionPublicKey,
                              signingPublicKey: keys.signingPublicKey, mlDsaPublicKey: mlDsa, kemPublicKey: kem)
        })
    }

    /*
     * This account's identity envelope at `version`, for the ledger to open under the account
     * root (a grant is opened there, never here): the one in use, or an earlier one as the server
     * serves the history (the ledger's open proves it is this account's own).
     */
    func identityEnvelope(atKeyVersion version: UInt64) async throws -> IdentityEnvelope {
        _ = try await identityKeys()
        if let current = identityEnvelope, current.keyVersion == version { return current }
        if let earlier = try await Auth.identityHistory().first(where: { $0.keyVersion == version }) { return earlier }
        throw DriveAPIError.server(400, "This family folder was shared with keys this account no longer has.")
    }

    /* The account key's version, as the personal workspace's grant names it: what a self-grant names. */
    func accountKeyVersion() async throws -> UInt64 {
        guard let version = try await loadWorkspace().grant?.keyVersion else { throw DriveAPIError.server(404, "No workspace grant") }
        return version
    }

    /* Route 25 named these as family folders: never opened under a key from the personal path. */
    func noteFamilyWorkspaces(_ ids: [String]) {
        let own = workspace?.workspaceId.lowercased()
        familyWorkspaces.formUnion(ids.map { $0.lowercased() }.filter { $0 != own })
    }

    /*
     * A family folder's top level, listed through the ledger afresh (not from what this process
     * opened before): the ledger decides from it whether the folder's root is the committed one.
     */
    func openListed(_ node: NodeView) throws -> Opened {
        opened[node.ref] = nil
        nodeKeys[node.ref] = nil
        let item = try open(node)
        if let parent = node.parentId { rememberParent(node.id, parent: parent) }
        return item
    }

    /* Everything opened in these family folders, forgotten: a family wiped or shown differently. */
    /*
     * Everything opened in these family folders, forgotten (the web's deleteMirrors): keys,
     * opened rows, and their ids in the node-to-parent index on disk. Returns the node ids, for
     * the screens to drop what they drew and decrypted.
     */
    @discardableResult
    func forgetWorkspaces(_ ids: [String]) -> Set<String> {
        var gone: Set<String> = []
        // Only family folders: a member list naming the personal drive (or anything else) never clears it here.
        for id in ids where familyWorkspaces.contains(id.lowercased()) {
            for nodeId in nodeKeys.values(in: id).keys { nodeKeys[NodeRef(workspaceId: id, nodeId: nodeId)] = nil; gone.insert(nodeId) }
            for nodeId in opened.values(in: id).keys { opened[NodeRef(workspaceId: id, nodeId: nodeId)] = nil; gone.insert(nodeId) }
        }
        forgetParents(gone)
        return gone
    }

    /* Whether a workspace is a family folder (as far as this session knows). */
    public func isFamilyWorkspace(_ workspaceId: String) -> Bool {
        familyWorkspaces.contains(workspaceId.lowercased()) || areaLedger.isArea(workspaceId: workspaceId)
    }

    /* Every write's first check: nothing is written into a family folder by this version of the app. */
    func refuseFamilyWrite(_ workspaceId: String) throws {
        if isFamilyWorkspace(workspaceId) { throw FamilyWriteError.readOnly }
    }
}
