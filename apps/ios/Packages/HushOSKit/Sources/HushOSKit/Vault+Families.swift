import Foundation
import HushOSCore

/*
 * The vault's side of families (docs/groups-mobile-plan.md, iOS 1 and 2): the area ledger opened
 * for this account, the settings' family pins handed to it, family folder nodes opened through
 * it, and the writes a family folder takes (new folders, uploads, renames, moves within it,
 * copies within it, trash) made only with keys the ledger hands out under its write rules.
 * Sharing, links, reports, keeping and versions stay refused there.
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
    /* Something family folders don't offer: sharing, links, reports, keeping, earlier versions. */
    case unavailable
    /* Named a family folder this session, but its family isn't open in the ledger now. */
    case notOpen
    public var errorDescription: String? {
        switch self {
        case .unavailable: FamilyWords.unavailable
        case .notOpen: FamilyWords.openAgain
        }
    }
}

/* An upload the server completed whose row doesn't open in this process (a background launch): landed, not failed. */
public struct UploadLanded: Error {}

/*
 * What a family folder's write needs from the family's sync (FamilySync, which holds the members
 * route 6 served): the form a record is signed again with, as the member list judges it (the
 * core's `copy_form`), and the family checked again while an upload waits out a key change.
 */
public protocol FamilyJudge: AnyObject, Sendable {
    func prior(of record: ServedRecord, in workspaceId: String) async throws -> Integrity
    func recheck(_ workspaceId: String) async
}

/*
 * An upload into a family folder that met a key change not finished yet (docs/groups-design.md
 * 2.10): the ledger's KEY_CHANGE_PENDING (the folder or the file is reached only through a key the
 * change replaces), the server's 409 `rotating`, or its 409 `stale` once the upload has waited (a
 * walk that reached the folder between the look and the begin). The same wait in every case, as
 * the web's upload queue waits (packages/drive/src/transfers.ts): looked up again every few
 * seconds and sealed afresh, never failed, until half an hour has passed.
 */
public enum KeyChangeWait {
    /* What a waiting upload's row says (the web's FINISHING_KEY_CHANGE). */
    public static let finishing = "Finishing a key change…"
    public static let gaveUp = "The family folder’s key change hasn’t finished, so this file wasn’t uploaded. Retry later."
    public static let versionMoved = "This file changed while the upload waited for a key change. Upload it again to replace the newer version."
    public static let pause: TimeInterval = 5
    public static let giveUp: TimeInterval = 30 * 60

    /* The pause before look `attempt` (from 1): 5 s, doubling to a minute, so a long walk isn't asked about every few seconds by every upload. */
    public static func delay(_ attempt: Int) -> TimeInterval { min(60, pause * pow(2, Double(max(0, attempt - 1)))) }

    /*
     * Whether `error` is the wait rather than a failure. The ledger's "older workspace key" is the folder's top served under
     * a key version this device hasn't accepted the member list for yet (a removal re-keys it with the roster): checked
     * again and looked up again within the same deadline, as the web's first begin meets `rotating` and syncs in its pause.
     */
    public static func meets(_ error: Error, waited: Bool) -> Bool {
        if let core = error as? CoreError { return [FamilyWords.keyChangePending, FamilyWords.olderWorkspaceKey].contains(FamilyWords.message(of: core)) }
        if case DriveAPIError.rotating = error { return true }
        if case DriveAPIError.stale = error { return waited }
        return false
    }

    /* How an upload waits: when it began waiting (the queue keeps it across launches), the pause between looks, and who is told. */
    public struct Policy: Sendable {
        public var since: Date?
        public var pause: @Sendable (Int) async throws -> Void
        public var waiting: @Sendable (Date) -> Void
        public var now: @Sendable () -> Date
        public init(since: Date? = nil, pause: @escaping @Sendable (Int) async throws -> Void = { try await Task.sleep(for: .seconds(KeyChangeWait.delay($0))) },
                    waiting: @escaping @Sendable (Date) -> Void = { _ in }, now: @escaping @Sendable () -> Date = { Date() }) {
            self.since = since
            self.pause = pause
            self.waiting = waiting
            self.now = now
        }
    }
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

    /* What family folders don't offer (sharing, links, reports, keeping, versions): refused before anything is sent. */
    func refuseFamilyWrite(_ workspaceId: String) throws {
        if isFamilyWorkspace(workspaceId) { throw FamilyWriteError.unavailable }
    }

    /*
     * Whether a write lands in a family folder, and if so whether it may be written now: the
     * ledger's `require_writable` (not checked against a committed chain, keys changed, no root
     * seen at the write version: refused with the core's sentence). A folder route 25 named this
     * session that the ledger doesn't hold (its family forgotten since) takes nothing until the
     * family is opened again; it never falls back to the personal key path.
     */
    func familyTarget(_ workspaceId: String) throws -> Bool {
        guard isFamilyWorkspace(workspaceId) else { return false }
        guard areaLedger.isArea(workspaceId: workspaceId) else { throw FamilyWriteError.notOpen }
        try areaLedger.requireWritable(workspaceId: workspaceId)
        return true
    }

    /* The key of a family folder node a write puts something under (its metadata, a version), at the epoch it was opened at. */
    func writableKey(of item: Opened) throws -> Data {
        guard let held = try areaLedger.writableNodeKey(workspaceId: item.node.workspaceId, nodeId: item.id) else {
            throw DriveAPIError.server(500, "Open the containing folder first.")
        }
        guard held.epoch == item.node.keyEpoch else { throw DriveAPIError.stale("This item changed since it was opened. Refresh and retry.") }
        return held.key
    }

    /* FamilySync, for the forms family records are signed again with. */
    func useFamilyJudge(_ judge: any FamilyJudge) { familyJudge = judge }

    /*
     * The form a family folder record is signed again with (a rename's, a copy's): as the family's
     * member list judges it, never the personal trust set. Without the family's members nothing is
     * signed, as a personal rename or copy stops without whom to trust.
     */
    func familyPrior(_ record: ServedRecord, in workspaceId: String, copying: Bool) async throws -> Integrity {
        // A refusal (no family judgement, a record the member list can't vouch for) is final, not a busy server to retry;
        // only no answer at all is the network's.
        let refused = DriveAPIError.server(409, "HushOS couldn’t check who wrote this, so it wasn’t \(copying ? "copied" : "changed"). Try again later.")
        guard let judge = familyJudge else { throw refused }
        do { return try await judge.prior(of: record, in: workspaceId) } catch {
            if FamilySync.unanswered(error) { throw DriveAPIError.transport(error.localizedDescription) }
            throw refused
        }
    }

    /* A family folder listed afresh, so the ledger sees the envelopes the server serves now (a walk may have re-keyed it). */
    func lookAgain(_ folderId: String) async throws {
        _ = try await listChildren(of: folderId)
    }
}
