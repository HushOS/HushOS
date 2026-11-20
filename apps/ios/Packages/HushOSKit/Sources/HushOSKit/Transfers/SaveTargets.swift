import Foundation

/*
 * Where Save to HushOS may put what was shared: your own drive, and the folders of each family you are an accepted member
 * of (Android's SaveTargets). Every family answer comes from the sheet's own sync of the family, and only while the
 * session it began in still stands (the vault's session open and still the one in the keychain): an account switched or
 * signed out mid-sheet lists, opens and seals nothing. A family is offered only once its sync accepts it, and only its
 * folders this phone may write in (keys checked at their latest version, top folder opened), never the trash. Before
 * anything is sealed into a family folder the family is checked again; a removal, a refusal or a folder that no longer
 * opens stops it in the family's own words, nothing sealed. Sealing itself is the queue's family upload (FamilyUploads).
 */
public struct SaveTargets: Sendable {
    /* A family as the picker lists it: its name, then its folders by name. */
    public struct Family: Sendable, Equatable, Identifiable {
        public let groupId: String
        public let name: String
        public let folders: [Places.Folder]
        public var id: String { groupId }
    }

    /* The sheet's session ended or another account signed in: nothing more is listed, opened or sealed. */
    public struct SessionEnded: WordedError, Equatable {
        public init() {}
        public var errorDescription: String? { "Sign in to HushOS in the app first." }
    }

    let vault: Vault
    let families: FamilySync
    let signedIn: @Sendable () -> SharedKeychain.Session?

    public init(vault: Vault, families: FamilySync, signedIn: @escaping @Sendable () -> SharedKeychain.Session? = { SharedKeychain.session }) {
        self.vault = vault
        self.families = families
        self.signedIn = signedIn
    }

    /* Whether the session this sheet began in is still the one signed in. */
    public func stands() -> Bool {
        guard vault.copySession.stands, let now = signedIn() else { return false }
        return now == vault.session
    }

    public func requireStands() throws { if !stands() { throw SessionEnded() } }

    /*
     * Every family this account is an accepted member of, with the folders it may save into; a family that doesn't sync
     * (no answer, a refusal, a fork, not let in yet) or has no such folder isn't offered. The list itself failing throws.
     */
    public func listFamilies() async throws -> [Family] {
        try requireStands()
        var found: [Family] = []
        for summary in try await families.list() {
            guard case let .accepted(view) = await families.sync(summary) else { continue }
            let folders = view.areas.compactMap { Self.folder(summary.id, $0) }
                .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
            if !folders.isEmpty { found.append(Family(groupId: summary.id, name: summary.name, folders: folders)) }
        }
        try requireStands()
        return found.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    static func folder(_ groupId: String, _ area: FamilyArea) -> Places.Folder? {
        guard area.openable, area.write == .writable, let root = area.root, let name = area.name else { return nil }
        return Places.Folder(id: root.id, name: name, groupId: groupId, workspaceId: area.workspaceId.lowercased())
    }

    /* `target`'s folders, for the picker: none in the trash, by name; a family folder's once its family is checked again. */
    public func folders(in target: Places.Folder) async throws -> [Opened] {
        try await open(target).filter { $0.isFolder && $0.node.trashedAt == nil }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    /*
     * `target` opened to save into, and what it holds: your own drive's folder as it is; a family folder only once its
     * family syncs accepted here, the folder is one of that family's that this phone may write in (and its workspace the
     * family's), and the folder is still there out of the trash. Anything else throws, in the family's words.
     */
    public func open(_ target: Places.Folder) async throws -> [Opened] {
        try requireStands()
        guard let family = target.family else {
            let children = try await vault.children(of: target.id)
            try requireStands()
            return children
        }
        let listed: [GroupSummary]
        do { listed = try await families.list() } catch where FamilySync.unanswered(error) { throw DriveAPI.noAnswer(error) }
        guard let summary = listed.first(where: { $0.id.lowercased() == family.groupId.lowercased() }) else { throw FamilyFailure.notInFamily }
        let view: FamilyView
        switch await families.sync(summary) {
        case let .accepted(accepted): view = accepted
        case let .failed(words) where words == FamilyWords.noAnswer: throw DriveAPIError.transport(words)
        case let .failed(words): throw FamilyFailure(message: words)
        case .wiped: throw FamilyFailure.notInFamily
        default: throw FamilyFailure(message: FamilyWords.openAgain)
        }
        guard let area = view.areas.first(where: { $0.workspaceId.lowercased() == family.workspaceId.lowercased() }) else {
            throw DriveAPIError.notFound("This folder no longer exists.")
        }
        guard area.openable, area.write == .writable else { throw FamilyFailure(message: area.line) }
        let owner = await families.familyAreas().first { $0.key.lowercased() == family.workspaceId.lowercased() }?.value
        guard owner?.lowercased() == family.groupId.lowercased() else {
            throw FamilyFailure(message: FamilyWords.couldntCheckKeys)
        }
        await vault.hint(workspace: family.workspaceId, for: target.id)
        let children = try await vault.children(of: target.id, in: family.workspaceId)
        // The listing opened the folder's own row too: one that isn't a folder, or is in the trash, isn't saved into.
        guard let folder = await vault.item(target.id), folder.isFolder, folder.node.trashedAt == nil else {
            throw DriveAPIError.notFound("This folder no longer exists.")
        }
        try requireStands()
        return children
    }

    /*
     * The family upload a shared copy goes in as, sealed through the queue's FamilyUploads (the family opened in this
     * process, the key-change wait), into `directory` holding the copy as `content`. `target` must be a family folder.
     */
    public func sealFamily(_ upload: inout FamilyUpload, in directory: URL, thumbnail: Data?) async throws {
        try requireStands()
        switch await FamilyUploads(vault: vault, families: families).seal(&upload, in: directory, thumbnail: thumbnail) {
        case .send: try requireStands()
        case let .retry(error), let .failed(error): throw error
        case .landed, .reseal: throw DriveAPIError.server(409, StagedSave.failed)
        }
    }

    /*
     * A family upload finished in the sheet once every part landed (`upload.etags`): the family opened as the queue's
     * finish opens it, then completed; true when it landed (its folder, plaintext included, then gone). Anything else
     * changes nothing here: no abort, no discard, no parts dropped, so the released note goes to the app's queue whole,
     * and FamilyUploads decides there (sealed again after a key change, ended once the family is gone).
     */
    public func finishFamily(_ upload: FamilyUpload, in directory: URL) async -> Bool {
        guard stands(), let sealed = upload.sealed, upload.etags.count == sealed.partCount else { return false }
        do {
            try await FamilyUploads(vault: vault, families: families).open(upload)
            _ = try await vault.finishUpload(sealed, etags: upload.etags)
        } catch is UploadLanded {
            // Live on the server even though its row doesn't open here (never a replacement here, so nothing to repair).
        } catch {
            return false
        }
        try? FileManager.default.removeItem(at: directory)
        return true
    }

    /* Whether `error` says this person isn't in the family any more. */
    public static func notInFamily(_ error: Error) -> Bool { FamilyUploads.notInFamily(error) }
}
