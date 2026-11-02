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

/*
 * An upload the server completed: landed, never failed, aborted or sent again, whatever went
 * wrong after the completion. Either its row doesn't open in this process (a background launch),
 * or, for a new version, the name record re-signed with the new size was refused after the
 * version went live (`published`, what to repair it against: `Vault.repairLanded`).
 */
public struct UploadLanded: Error, LocalizedError {
    public let published: Vault.Published?
    public init(published: Vault.Published? = nil) { self.published = published }
    public var errorDescription: String? { "Uploaded. Its size and date in the list may not match the new version." }
}

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
        if let core = error as? CoreError { return [FamilyWords.keyChangePending, FamilyWords.olderWorkspaceKey, FamilyWords.olderFolderKey].contains(FamilyWords.message(of: core)) }
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
     * False when it changed meanwhile, and nothing was saved. The first-use marker and the
     * `before` records go in the same save, derived again from what each attempt read, with a
     * record of what vouched for this acceptance (`checked`) (docs/optional-verification.md 7.2).
     */
    func saveGroupPin(_ groupId: String, over expected: GroupPin?, _ pin: GroupPin, checked: FamilyChecked?, now: String) async throws -> Bool {
        struct Moved: Error {}
        do {
            try await updateSettings { settings in
                guard try settings.groupPin(groupId) == expected else { throw Moved() }
                settings.markFamilyChecks(now: now, acceptance: (groupId, checked))
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
        if let earlier = try await Auth.identityHistory(as: session).first(where: { $0.keyVersion == version }) { return earlier }
        throw DriveAPIError.server(400, "This family folder was shared with keys this account no longer has.")
    }

    /* The account key's version, as the personal workspace's grant names it: what a self-grant names. */
    func accountKeyVersion() async throws -> UInt64 {
        guard let version = try await loadWorkspace().grant?.keyVersion else { throw DriveAPIError.server(404, "No workspace grant") }
        return version
    }

    /*
     * Held for the write barrier on a roster's word alone (an acceptance whose guard may not store):
     * writes into them wait for the guard (sendingIntoFamily). Never this account's own drive, never
     * over a folder already known as another family's, and never a family folder for how a node
     * opens or writes, nor this family's to clear: only route 25 and the id check prove that
     * (noteFamilyWorkspaces). A received share a member list names stays a share.
     */
    func holdAsFamilyWorkspaces(_ ids: [String], of groupId: String) async {
        _ = try? await loadWorkspace()
        let own = workspace?.workspaceId.lowercased()
        // Held for every family that named it: a first member list's word never keeps another family's barrier off it.
        for id in ids.map({ $0.lowercased() }) where id != own { heldAreaGroups[id, default: []].insert(groupId.lowercased()) }
    }

    /* Held by a family whose guard is still owed: the barrier is up over it. Never past the guard's store, never ownership. */
    func heldUnderOwedGuard(_ workspaceId: String) -> Bool {
        heldAreaGroups[workspaceId.lowercased()]?.contains { familyGuardOwed.contains($0) } == true
    }

    /* Whether a folder may be let go of with `groupId`: never this account's own drive, never one known as another family's. */
    func mayForget(_ workspaceId: String, with groupId: String) async -> Bool {
        _ = try? await loadWorkspace()
        let id = workspaceId.lowercased()
        guard id != workspace?.workspaceId.lowercased() else { return false }
        return familyAreaGroup[id].map { $0 == groupId.lowercased() } ?? true
    }

    /* Route 25 named these as family folders of `groupId`: never opened under a key from the personal path. */
    func noteFamilyWorkspaces(_ ids: [String], of groupId: String) {
        let own = workspace?.workspaceId.lowercased()
        let family = ids.map { $0.lowercased() }.filter { $0 != own }
        // Newly proven a family folder: whatever this phone held of it came some other way (a share mount), never through
        // the family's ledger, and goes with its keys and its place in the parent index.
        let newly = family.filter { !familyWorkspaces.contains($0) }
        if !newly.isEmpty { forgetWorkspaces(newly, lettingGo: false) }
        familyWorkspaces.formUnion(family)
        for id in family { familyAreaGroup[id] = groupId.lowercased() }
    }

    /*
     * A family folder's top level, listed through the ledger afresh (not from what this process
     * opened before): the ledger decides from it whether the folder's root is the committed one.
     */
    func openListed(_ node: NodeView) throws -> Opened {
        // Through the ledger only: a node of any workspace not known as a family folder is refused before any cache is touched.
        guard isFamilyWorkspace(node.workspaceId) else { throw FamilyFailure(message: "Couldn’t check this folder’s keys") }
        // A newer row of it already held stays: an older listing never replaces it (open keeps the newer one too).
        if let held = opened[node.ref], node.isOlder(than: held.node) { return held }
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
    func forgetWorkspaces(_ ids: [String], lettingGo: Bool = true) -> Set<String> {
        var gone: Set<String> = []
        // Every folder the family names (the device record's too, not only those this session opened), never this
        // account's own drive, whatever a member list names. On this actor nothing runs between the clearing and an
        // open, which asks the core for the key as it runs: one that resumes after a fork or removal is refused there.
        let own = workspace?.workspaceId.lowercased()
        var workspaces: Set<String> = []
        for id in ids.map({ $0.lowercased() }) where id != own {
            // Let go of by this session (its family refused, forked or wiped): no share refills it (admitShare).
            if lettingGo { letGoWorkspaces.insert(id) }
            workspaces.insert(id)
            for nodeId in nodeKeys.values(in: id).keys { nodeKeys[NodeRef(workspaceId: id, nodeId: nodeId)] = nil; gone.insert(nodeId) }
            for nodeId in opened.values(in: id).keys { opened[NodeRef(workspaceId: id, nodeId: nodeId)] = nil; gone.insert(nodeId) }
            ledgerOpened = ledgerOpened.filter { $0.workspaceId != id }
        }
        // Their plaintext elsewhere too: what was kept on this phone from them (Offline), and the copies opened from their
        // items outside a family's folder (a share's, before its folder was proven a family's). The screens drop the rows.
        // Only while this vault's session stands: what is there once it ended may be the next session's.
        let kept = copySession.whileOpen { Offline.forgetWorkspaces(workspaces, ids: Set(gone.map { $0.lowercased() })) } ?? []
        TemporaryCopies.forgetShareWorkspaces(workspaces, session: copySession)
        evictedRows.formUnion(gone.union(kept))
        forgetParents(gone)
        return gone
    }

    /* Whether a workspace is a family folder (as far as this session knows). */
    public func isFamilyWorkspace(_ workspaceId: String) -> Bool {
        // Proven only (route 25 and the folder id derived under the family, noteFamilyWorkspaces): the ledger also names
        // as areas the workspaces a committed member list merely lists, a received share's among them, which stay shares.
        familyWorkspaces.contains(workspaceId.lowercased())
    }

    /* What family folders don't offer (sharing, links, reports, keeping, versions): refused before anything is sent. */
    func refuseFamilyWrite(_ workspaceId: String) throws {
        if isFamilyWorkspace(workspaceId) { throw FamilyWriteError.unavailable }
        WriteIntent.record(workspaceId, family: false)
    }

    /*
     * Whether a write lands in a family folder, and if so whether it may be written now: the
     * ledger's `require_writable` (not checked against a committed chain, keys changed, no root
     * seen at the write version: refused with the core's sentence). A folder route 25 named this
     * session that the ledger doesn't hold (its family forgotten since) takes nothing until the
     * family is opened again; it never falls back to the personal key path.
     */
    func familyTarget(_ workspaceId: String) throws -> Bool {
        guard isFamilyWorkspace(workspaceId) else {
            WriteIntent.record(workspaceId, family: false)
            return false
        }
        guard areaLedger.isArea(workspaceId: workspaceId) else { throw FamilyWriteError.notOpen }
        try requireGuardKept(workspaceId)
        try areaLedger.requireWritable(workspaceId: workspaceId)
        WriteIntent.record(workspaceId, family: true)
        return true
    }

    /*
     * The last check every write passes, right before it is sent (DriveAPI.perform): never into a
     * workspace a family whose guard is owed holds, and into a family folder only a write that decided
     * at its entry to write as the family's (familyTarget, under the ledger's keys), still writable
     * now. A write begun on a share's or this account's path (sealed under their keys) into a folder
     * proven a family's since is refused, as is any write that declared nothing.
     */
    func finalGate(_ workspaceId: String) async throws {
        #if DEBUG
        if let beforeGate { await beforeGate(workspaceId) }
        #endif
        // Nothing awaited from here to the send's start: a proof or a guard landing now is seen.
        let id = workspaceId.lowercased()
        if heldUnderOwedGuard(id) { throw GuardError.unsaved }
        guard isFamilyWorkspace(id) else { return }
        guard WriteIntent.decision(id) == true else { throw FamilyFailure(message: FamilyWords.couldntCheckKeys) }
        _ = try familyTarget(id)
    }

    /* A write's body, with its own record of what it decided at entry (WriteIntent), for the final gate. */
    func writing<T>(_ body: () async throws -> T) async rethrows -> T {
        try await WriteIntent.$entry.withValue(WriteEntry(), operation: body)
    }

    /*
     * The web worker's requireGuardKept: nothing is written into a family while the guard its last
     * acceptance handed back isn't stored (docs/optional-verification.md 2.8); reading goes on. A
     * family folder whose family isn't known here is refused while any family's guard is owed.
     */
    func requireGuardKept(_ workspaceId: String) throws {
        guard !familyGuardOwed.isEmpty else { return }
        let id = workspaceId.lowercased()
        // Any family that named it and still owes its guard holds it, the proven family's or not.
        if heldUnderOwedGuard(id) { throw GuardError.unsaved }
        if let groupId = familyAreaGroup[id] {
            if familyGuardOwed.contains(groupId) { throw GuardError.unsaved }
            return
        }
        // Named only by families whose guards are stored: written as what it is. Known to none: held while any guard is owed.
        if heldAreaGroups[id] != nil { return }
        throw GuardError.unsaved
    }

    /*
     * Right before a write leaves for the server, after every await of its own (a key from the server,
     * a signature, a lookup): a sync may have committed and failed to store its guard meanwhile.
     */
    func sendingIntoFamily(_ workspaceId: String) throws {
        // A folder a member list named but not proven a family's (a share, maybe) waits for the guard too, as a family folder.
        if isFamilyWorkspace(workspaceId) || heldAreaGroups[workspaceId.lowercased()] != nil { try requireGuardKept(workspaceId) }
    }

    /* Raised before an acceptance of `groupId` commits; whether it was raised already (an earlier guard still owed). */
    @discardableResult
    func oweFamilyGuard(_ groupId: String) -> Bool { !familyGuardOwed.insert(groupId.lowercased()).inserted }

    /* The guard an acceptance handed back is stored (or there was none): writes into the family go on. */
    func familyGuardKept(_ groupId: String) { familyGuardOwed.remove(groupId.lowercased()) }

    /* The key of a family folder node a write puts something under (its metadata, a version), at the epoch it was opened at. */
    func writableKey(of item: Opened) throws -> Data {
        try requireGuardKept(item.node.workspaceId)
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
            if FamilySync.unanswered(error) { throw DriveAPI.noAnswer(error) }
            throw refused
        }
    }

    /* A family folder listed afresh, so the ledger sees the envelopes the server serves now (a walk may have re-keyed it). */
    func lookAgain(_ folderId: String) async throws {
        _ = try await listChildren(of: folderId)
    }
}

/*
 * What a write decided at its entry for each workspace it writes into: the first decision stands
 * (a check run again later never changes it). Carried to the final gate in a task-local.
 */
final class WriteEntry: @unchecked Sendable {
    private let lock = NSLock()
    private var decided: [String: Bool] = [:]

    func record(_ workspaceId: String, family: Bool) {
        lock.withLock { if decided[workspaceId.lowercased()] == nil { decided[workspaceId.lowercased()] = family } }
    }

    func decision(_ workspaceId: String) -> Bool? { lock.withLock { decided[workspaceId.lowercased()] } }
}

enum WriteIntent {
    @TaskLocal static var entry: WriteEntry?
    static func record(_ workspaceId: String, family: Bool) { entry?.record(workspaceId, family: family) }
    static func decision(_ workspaceId: String) -> Bool? { entry?.decision(workspaceId) }
}
