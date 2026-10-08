import Foundation
import UIKit
import HushOSKit
import Observation
import UniformTypeIdentifiers

/*
 * What the screens read: folder listings, recents and the trash, refreshed
 * after every write, plus thumbnails decrypted once and kept. All work goes
 * through the vault; errors surface as a banner the current screen shows.
 */
@Observable
@MainActor
final class DriveStore {
    private(set) var vault: Vault
    var folders: [String: [Opened]] = [:]
    /* Bumped whenever the offline list changes, so views showing it refresh. */
    var offlineVersion = 0
    /* Bumped when the catalogue changes what lists show. */
    var catalogueVersion = 0
    var names: [String: String] = [:]
    var recents: [Opened] = []
    var trash: [(item: Opened, parentTrashed: Bool)] = []
    /* Trash rows being restored or deleted, and the whole trash being emptied: each shows it is under way. */
    var trashWorking: Set<String> = []
    var emptyingTrash = false
    /* Empty Trash going row by row: "4 of 12". */
    var emptying: (done: Int, total: Int)?
    /* The folder each trashed item was in, by parent id, so its row and sheet can say "Was in Work". */
    var trashFolders: [String: String] = [:]
    /* A batch restore where some came back and some didn't: stays on screen until dismissed or retried. */
    var restoreProblem: RestoreProblem?

    struct RestoreProblem {
        let restored: Int
        let total: Int
        /* What didn't come back, and why in a few words. */
        let failed: [(entry: (item: Opened, parentTrashed: Bool), reason: String)]
        /* What came back to Files instead of its folder, and that folder's name. */
        let moved: [(item: Opened, folder: String?)]
    }
    var thumbnails: [String: Data] = [:]
    var rootId: String?
    var tags: TagRegistry = .empty
    /* What Copy or Cut picked up, until Paste places it. */
    var clipboard: (items: [Opened], cut: Bool)?
    var error: String?
    /* The last request could not reach the server; what is on this phone is shown. */
    var offline = false
    /* Folder ids being fetched right now. */
    var loading: Set<String> = []
    /* A key rotation in progress (after a link is turned off or someone is removed): listings wait for it. */
    private var rotation: Task<Void, Never>?
    /* Folders with nothing to show and a reason: the request failed, or the phone is offline and never listed them. */
    enum FolderProblem { case failed, notOnPhone }
    var folderProblems: [String: FolderProblem] = [:]
    /* Every node of this drive the catalogue opened, by id: search across folders and the way up to a shared folder. */
    var catalogue: [String: Opened] = [:]
    var catalogueReady = false
    /* This account's own workspace; items from elsewhere (shared with this account) say nothing about who can open them. */
    var myWorkspace: String?
    /* Who can open each of one's own shared items, from /shares/mine, as the web's access index. */
    var sharing: [String: SharingIndex.Entry] = [:]
    /* What the session-ended error says; the shell turns it into "You’ve been signed out". */
    static let sessionEnded = "Your session ended. Sign in again."
    /* A link the shell handed over, for the tab it opened to act on and clear. */
    var route: AppLink?
    /* A file a link asked to open in the viewer, and the files beside it. */
    var deepFile: Opened?
    var deepSiblings: [Opened] = []
    /* What others shared with this account, opened: the Shared tab and the folder picker read it. */
    var mounts: [ShareMount] = []
    var mountsError: String?
    var mountsLoaded = false
    var busy = false
    /* Transfers in flight and just finished, each with its own bar, as the web's panel shows them. */
    struct TransferItem: Identifiable, Equatable {
        enum Kind { case upload, download, copy, keep }
        let id = UUID()
        var kind: Kind
        var name: String
        var fraction: Double
        var done = false
        var failed = false
        /* Queued and waiting for a network (or to be sealed); shown without a bar. */
        var waiting = false
        /* A background transfer, which the panel can cancel, or dismiss once it failed. */
        var queuedId: UUID? = nil
        /* Why it failed, in the server's words where it refused. */
        var message: String? = nil
        /* A failed upload that kept its file, so it can go again. */
        var canRetry = false
        /* Bytes in all, for "3.7 of 6.0 MB" rather than a bare percentage; nil where unknown. */
        var size: Int64? = nil
        /* Refused for want of room: the row offers Make room. */
        var noRoom = false
        /* A kept folder: one row for all its files, named after the folder. */
        var folder = false
    }
    var transfers: [TransferItem] = [] {
        // The Live Activity follows every transfer, this session's and the background queue's.
        didSet { TransferLive.shared.foreground = transfers }
    }
    /* Files being fetched to open, by node id, with progress: a spinner on the row, not a banner. */
    var opening: [String: Double] = [:]
    private var thumbnailTasks: Set<String> = []

    @discardableResult
    func begin(_ kind: TransferItem.Kind, _ name: String) -> UUID {
        let item = TransferItem(kind: kind, name: name, fraction: 0)
        transfers.append(item)
        return item.id
    }

    func progress(_ id: UUID, _ fraction: Double, name: String? = nil) {
        guard let index = transfers.firstIndex(where: { $0.id == id }) else { return }
        transfers[index].fraction = fraction
        if let name { transfers[index].name = name }
    }

    func finish(_ id: UUID, failed: Bool = false, message: String? = nil) {
        guard let index = transfers.firstIndex(where: { $0.id == id }) else { return }
        transfers[index].done = true
        transfers[index].failed = failed
        if failed {
            transfers[index].message = message ?? TransferWords.repeated
            transfers[index].noRoom = message == TransferWords.noRoom
        } else {
            transfers[index].fraction = 1
        }
        // Finished rows linger so the result is seen, then go once everything is done; a failure stays with its reason.
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(4))
            if transfers.allSatisfy(\.done) { transfers.removeAll { !$0.failed } }
        }
    }

    /* Takes a row off the panel: a failure dismissed, or a kept copy that only failed for being offline. */
    func dismiss(_ id: UUID) { removeRows { $0.id == id } }

    /* A row that is getting ready (no bar yet): "Waiting". */
    func markWaiting(_ id: UUID) {
        guard let index = transfers.firstIndex(where: { $0.id == id }) else { return }
        transfers[index].waiting = true
    }

    /*
     * Clear finished: only what finished goes. A failure stays until it is retried, room is
     * made for it, or it is removed from its menu; starting another transfer never clears it.
     */
    func closeTransfers() {
        removeRows(where: { $0.done && !$0.failed })
        BackgroundTransfers.shared.clearFinished()
    }

    /* Rows off the panel, and the files failed uploads kept for their retry. */
    private func removeRows(where which: (TransferItem) -> Bool) {
        for item in transfers where which(item) {
            if let upload = pendingUploads.removeValue(forKey: item.id) { try? FileManager.default.removeItem(at: upload.url) }
        }
        transfers.removeAll(where: which)
    }

    /* A failed upload into a shared folder: what it needs to go again, kept until its row goes. */
    private struct PendingUpload {
        let url: URL
        let name: String
        let mime: String?
        let folder: String
        let replacing: Opened?
    }
    private var pendingUploads: [UUID: PendingUpload] = [:]

    /* Sends a failed upload again from the file it kept; the failed row makes way for the new one. */
    func retry(_ id: UUID) {
        guard let upload = pendingUploads.removeValue(forKey: id) else { return }
        transfers.removeAll { $0.id == id }
        Task { _ = await uploadNow(upload) }
    }

    /* Uploads a picked file here and now; a failure keeps the file, so its row can send it again. */
    private func uploadNow(_ upload: PendingUpload) async -> Bool {
        let ticket = begin(.upload, upload.name)
        if let index = transfers.firstIndex(where: { $0.id == ticket }) {
            transfers[index].size = (try? FileManager.default.attributesOfItem(atPath: upload.url.path)[.size] as? Int64) ?? nil
        }
        var why: String?
        let ok = await perform(in: upload.folder, failed: { why = $0 }) {
            _ = try await vault.upload(
                fileURL: upload.url, name: upload.name, mime: upload.mime, in: upload.folder, replacing: upload.replacing,
                thumbnail: Thumbnails.make(for: upload.url, mime: upload.mime)
            ) { fraction in Task { @MainActor in self.progress(ticket, fraction) } }
        }
        finish(ticket, failed: !ok, message: why)
        if ok {
            try? FileManager.default.removeItem(at: upload.url)
        } else if FileManager.default.fileExists(atPath: upload.url.path), let index = transfers.firstIndex(where: { $0.id == ticket }) {
            pendingUploads[ticket] = upload
            transfers[index].canRetry = true
        }
        return ok
    }

    /* What a failed transfer's row says: what happened and what to do. */
    private func reason(_ error: Error) -> String { TransferWords.reason(error) }

    private var networkToken: UUID?

    /*
     * The same account signed in again (Change password and Reset sharing keys end every
     * session): the new session's vault takes over in place, so screens and open sheets
     * stay as they are, and the lists catch up from the server under it.
     */
    func adopt(_ next: Vault) async {
        guard next !== vault else { return }
        vault = next
        BackgroundTransfers.shared.vault = next
        await sync()
        for id in folders.keys { await refresh(folder: id) }
        await refreshRecents()
    }

    init(vault: Vault) {
        self.vault = vault
        // The background queue shares this vault, and a landed transfer redraws the lists.
        BackgroundTransfers.shared.vault = vault
        BackgroundTransfers.shared.onLanded = { [weak self] in
            Task { @MainActor [weak self] in
                guard let self else { return }
                await self.sync()
                for id in self.folders.keys { await self.refresh(folder: id) }
                self.offlineVersion += 1
            }
        }
        // The offline line follows the network, not the next failed request: back online, the lists catch up at once.
        // The same process-wide watch the transfers wait on, so the line and the waits never disagree.
        if !NetworkWatch.shared.online { offline = true }
        networkToken = NetworkWatch.shared.observe { [weak self] reachable in
            Task { @MainActor [weak self] in
                guard let self else { return }
                if reachable, self.offline {
                    self.offline = false
                    await self.sync()
                } else if !reachable {
                    self.offline = true
                }
            }
        }
    }

    isolated deinit {
        if let networkToken { NetworkWatch.shared.stop(networkToken) }
    }

    func loadRoot() async -> String? {
        if let rootId { return rootId }
        do {
            let id = try await vault.rootId()
            rootId = id
            names[id] = "HushOS"
            myWorkspace = try? await vault.workspaceId()
            Task { await refreshSharing() }
            // The catalogue: the whole tree from the mirror on disk, then only the feed's changes.
            Task { await buildCatalogue() }
            return id
        } catch {
            report(error)
            return nil
        }
    }

    /* Builds the catalogue once, then redraws every list from it. */
    private func buildCatalogue() async {
        await vault.buildCatalogue()
        guard await vault.catalogueState == .ready else { return }
        for id in folders.keys { if let children = try? await vault.children(of: id) { folders[id] = children } }
        recents = (try? await vault.recents()) ?? recents
        await reloadCatalogue()
        catalogueVersion += 1
        // The build took in every change since the last run, so every kept file is checked against it.
        refreshKept(Set(Offline.entries().map(\.id)))
        refreshKeptFolders()
    }

    /* Pulls what changed since the cursor and redraws the lists it touched. */
    func sync() async {
        if let rotation { await rotation.value }
        // Nil: the server was not asked (no network, or the tree opened from the phone), so the offline line stays.
        guard let touched = try? await vault.sync() else { return }
        // The feed answered: whatever the last request said, the server is reachable now.
        offline = false
        if touched.isEmpty { return }
        for id in folders.keys where touched.contains(id) || folders[id]?.contains(where: { touched.contains($0.id) }) == true {
            if let children = try? await vault.children(of: id) { folders[id] = children }
        }
        recents = (try? await vault.recents()) ?? recents
        await reloadCatalogue()
        catalogueVersion += 1
        refreshKept(touched)
        refreshKeptFolders()
    }

    private func reloadCatalogue() async {
        let all = await vault.catalogueAll()
        guard !all.isEmpty else { return }
        catalogue = Dictionary(all.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        catalogueReady = true
    }

    /* Who can open what: asked on start, on a pull and after the share sheet closes; not on every live sync. */
    func refreshSharing() async {
        guard let index = try? await vault.sharingIndex() else { return }
        sharing = index.entries
    }

    /* One item by id, from the catalogue or anything listed this session. */
    func known(_ id: String) -> Opened? {
        if let item = catalogue[id] { return item }
        for list in folders.values { if let item = list.first(where: { $0.id == id }) { return item } }
        return recents.first { $0.id == id }
    }

    /* Everything inside a folder at any depth, as far as this phone knows it: "Search in Lisbon 2026". */
    func items(under folderId: String) -> [Opened] {
        let pool = catalogue[folderId] != nil ? Array(catalogue.values) : everything
        return pool.filter { item in
            var cursor = item.node.parentId
            var steps = 0
            while let id = cursor, steps < 256 {
                if id == folderId { return true }
                cursor = known(id)?.node.parentId
                steps += 1
            }
            return false
        }
    }

    /* Where an item lives, for search results: "In Files", "In Lisbon 2026". */
    func location(of item: Opened) -> String? {
        guard let parent = item.node.parentId else { return nil }
        if parent == rootId { return "In Files" }
        return (known(parent)?.name ?? names[parent]).map { "In \($0)" }
    }

    /* An item a link names: from what this phone knows, else opened from the server's listing. */
    func lookUp(_ id: String) async -> Opened? {
        if let item = known(id) { return item }
        if let item = await vault.openedItem(id) { return item }
        if let item = try? await vault.resolve(id) { return item }
        // A fresh catalogue may know it (a folder made elsewhere since the last sync).
        await sync()
        return known(id)
    }

    /* The folders from the top down to `item` (excluded), for a navigation path. */
    func trail(to item: Opened) async -> [Opened] {
        var chain: [Opened] = []
        var cursor = item.node.parentId
        while let id = cursor, id != rootId, chain.count < 64, let folder = await lookUp(id) {
            chain.insert(folder, at: 0)
            cursor = folder.node.parentId
        }
        return chain
    }

    func isOwn(_ item: Opened) -> Bool { myWorkspace == nil || item.node.workspaceId == myWorkspace }

    /* Whose an item is and what this account may do with it: its own, or someone else's it can edit or only view. */
    enum Role { case owner, editor, viewer }
    func role(of item: Opened) -> Role {
        if isOwn(item) { return .owner }
        // Shares are per workspace in practice; the widest one this account holds there decides.
        let roles = mounts.filter { $0.share.workspaceId == item.node.workspaceId }.map(\.share.role)
        return roles.contains("editor") ? .editor : .viewer
    }

    func refreshMounts() async {
        do {
            mounts = try await vault.mountShares()
            mountsError = nil
        } catch {
            mountsError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
        mountsLoaded = true
    }

    /* The nearest folder, from `folderId` up, that is shared: the one the access banner speaks for. */
    func sharedAncestor(from folderId: String) -> String? {
        var cursor: String? = folderId
        var steps = 0
        while let id = cursor, steps < 256 {
            if sharing[id] != nil { return id }
            cursor = known(id)?.node.parentId
            steps += 1
        }
        return nil
    }

    /* "Sam", "Sam and Priya", "Sam, Priya and Erik" (Android's `names`, so both apps say the same). */
    static func names(_ list: [String]) -> String {
        switch list.count {
        case 0: return ""
        case 1: return list[0]
        default: return list.dropLast().joined(separator: ", ") + " and " + list.last!
        }
    }

    static func firstName(_ grantee: ShareView.Grantee) -> String {
        (grantee.name.isEmpty ? grantee.email : grantee.name).split(separator: " ").first.map(String.init) ?? grantee.email
    }

    /*
     * A row's "who can open", only where the item's own access differs from its folder's;
     * nil otherwise, and for items in someone else's drive. The words are Android's:
     * "Anyone with the link" (the one warm signal, which wins), "Sam can edit", "Sam, Priya and Erik".
     */
    func accessLine(for item: Opened) -> (text: String, link: String?)? {
        guard isOwn(item), let entry = sharing[item.id], !entry.people.isEmpty || entry.links > 0 else { return nil }
        if entry.links > 0 { return ("", "Anyone with the link") }
        if entry.people.count == 1, let one = entry.people.first {
            return ("\(Self.firstName(one)) can \(entry.roles[one.id] == "editor" ? "edit" : "view")", nil)
        }
        return (Self.names(entry.people.map(Self.firstName)), nil)
    }

    /* The banner over a shared folder: "You, Sam and anyone with the link can open everything in this folder." */
    func accessSentence(for sharedId: String, here: Bool) -> String? {
        guard let who = whoCanOpenWithYou(sharedId) else { return nil }
        return "\(who) can open everything in this folder."
    }

    /*
     * The banner in a folder someone shared with this account (or one inside it): who
     * shared it and what this account can do there, as Shared's rows say it.
     */
    func receivedSentence(for folderId: String) -> String? {
        guard !mounts.isEmpty, known(folderId).map(isOwn) != true else { return nil }
        var cursor: String? = folderId
        var steps = 0
        while let id = cursor, steps < 256 {
            if let mount = mounts.first(where: { $0.share.node.id == id || $0.root?.id == id }) {
                let granter = mount.share.granter.name.isEmpty ? mount.share.granter.email : mount.share.granter.name
                let what = mount.share.role == "editor" ? "edit" : "view"
                return id == folderId
                    ? "\(granter) shared this folder with you. You can \(what) everything in it."
                    : "\(granter) shared “\(mount.root?.name ?? known(id)?.name ?? "a folder")” with you. You can \(what) everything in it."
            }
            cursor = known(id)?.node.parentId
            steps += 1
        }
        return nil
    }

    /* "You, Sam and anyone with the link": everyone a shared item opens to, you first. */
    func whoCanOpenWithYou(_ sharedId: String) -> String? {
        guard let entry = sharing[sharedId], !entry.people.isEmpty || entry.links > 0 else { return nil }
        return Self.names(["You"] + entry.people.map(Self.firstName) + (entry.links > 0 ? ["anyone with the link"] : []))
    }

    private var refreshingKept: Set<String> = []

    /*
     * A kept file changed elsewhere is brought up to date on its own, so a
     * refresh or an upload never waits for a large file to come down again.
     */
    private func refreshKept(_ touched: Set<String>) {
        // A file kept with its folder comes down with the folder's sync, never here too: both at once fetched it twice.
        let folders = Set(Offline.keptFolders().map(\.id))
        let kept = Offline.entries().filter { entry in
            touched.contains(entry.id) && !refreshingKept.contains(entry.id) && !(entry.folderId.map(folders.contains) ?? false)
        }
        guard !kept.isEmpty else { return }
        let ids = Set(kept.map(\.id))
        refreshingKept.formUnion(ids)
        Task {
            // Only files whose copy is missing get a row: a rename or a tag moves nothing, and a file this
            // session cannot open yet (gone, or in a share not browsed) has nothing to fetch.
            var tickets: [String: UUID] = [:]
            for entry in kept where await vault.keptVersionMissing(entry.id) { tickets[entry.id] = begin(.keep, entry.name) }
            let rows = tickets
            let failed = await vault.refreshOffline(ids) { id, fraction in Task { @MainActor in if let ticket = rows[id] { self.progress(ticket, fraction) } } }
            // Offline, the banner already says why; a row per kept file would only repeat it.
            for (id, ticket) in rows {
                let failure = failed[id].map { TransferWords.keepReason($0) }
                if failure != nil && offline { dismiss(ticket) } else { finish(ticket, failed: failure != nil, message: failure) }
            }
            refreshingKept.subtract(ids)
            offlineVersion += 1
        }
    }

    /*
     * After a sync: each kept folder fetches what was added or replaced in it and drops what
     * left. This drive's feed says when its folders change; a share's folders don't appear in
     * it, so they are listed again only when asked (`includingShares`).
     */
    private func refreshKeptFolders(includingShares: Bool = false) {
        for folder in Offline.keptFolders() where !keepingFolders.contains(folder.id) {
            let own = myWorkspace == nil || folder.workspaceId == myWorkspace
            guard own || includingShares else { continue }
            Task { await fetchKeptFolder(folder.id, name: folder.name) }
        }
    }

    func refresh(folder id: String) async {
        // Keys changing underneath: wait, then list with the new ones.
        if let rotation { await rotation.value }
        loading.insert(id)
        defer { loading.remove(id) }
        do {
            await sync()
            let children = try await vault.children(of: id)
            folders[id] = children
            folderProblems[id] = nil
            for child in children { names[child.id] = child.name }
        } catch {
            // A folder already on screen keeps its rows; one with nothing to show says why instead.
            if folders[id] == nil {
                if case DriveAPIError.transport = error { folderProblems[id] = .notOnPhone } else if !isSessionEnd(error) { folderProblems[id] = .failed }
            }
            if folders[id] == nil, folderProblems[id] == .failed { return }
            report(error)
        }
    }

    func refreshTags() async {
        do {
            tags = try await vault.tags().registry
        } catch {
            report(error)
        }
    }

    /* A change to the registry, saved a version up and reflected here. */
    func editTags(_ change: @escaping @Sendable (inout TagRegistry) throws -> Void) async {
        do {
            tags = try await vault.saveTags(change)
        } catch {
            report(error)
        }
    }

    /* The items a tag names, as far as this session can name them. */
    func items(tagged tagId: String) async -> [Opened] {
        var result: [Opened] = []
        for id in tags.nodes(with: tagId) {
            if let known = everything.first(where: { $0.id == id }) { result.append(known) }
            else if let opened = try? await vault.resolve(id) { result.append(opened) }
        }
        return result.sorted(by: Opened.byName)
    }

    func refreshRecents() async {
        do {
            await sync()
            recents = try await vault.recents()
        } catch {
            report(error)
        }
    }

    func refreshTrash() async {
        do {
            let list = try await vault.trash()
            var names: [String: String] = [:]
            for parent in Set(list.compactMap(\.item.node.parentId)) {
                if parent == rootId { names[parent] = "Files" } else if let folder = await vault.item(parent) { names[parent] = folder.name }
            }
            trashFolders = names
            trash = list
        } catch {
            report(error)
        }
    }

    /* "Work", or "Files" at the top; nil when the folder is not known here. */
    func wasIn(_ item: Opened) -> String? { item.node.parentId.flatMap { trashFolders[$0] } }

    /* "Was in Work · Trashed today": where it was and when it went, so Restore isn't a guess (Android's words). */
    func trashLine(_ item: Opened) -> String {
        let trashed = parseDate(item.node.trashedAt).map { date -> String in
            let calendar = Calendar.current
            if calendar.isDateInToday(date) { return "today" }
            if calendar.isDateInYesterday(date) { return "yesterday" }
            return changedLabel(date) ?? ""
        }
        return [wasIn(item).map { "Was in \($0)" }, trashed.map { "Trashed \($0)" }].compactMap { $0 }.joined(separator: " · ")
    }

    /* Every item this session has opened, for search across folders. */
    var everything: [Opened] {
        var seen: Set<String> = []
        return (folders.values.flatMap { $0 } + recents).filter { seen.insert($0.id).inserted }
    }

    func thumbnail(for item: Opened) {
        guard item.hasThumbnail, thumbnails[item.id] == nil, !thumbnailTasks.contains(item.id) else { return }
        thumbnailTasks.insert(item.id)
        Task {
            if let data = try? await vault.thumbnail(item.id) { thumbnails[item.id] = data }
            thumbnailTasks.remove(item.id)
        }
    }

    // MARK: Writes

    /* With `failed`, a transfer's reason goes to its row in the panel instead of the alert. */
    private func perform(_ title: String? = nil, in folder: String?, failed: ((String) -> Void)? = nil, _ work: () async throws -> Void) async -> Bool {
        busy = true
        defer { busy = false }
        do {
            try await work()
            if let folder { await refresh(folder: folder) }
            FilesDomain.signal(folderId: folder)
            return true
        } catch {
            if let failed, !isSessionEnd(error) {
                if case DriveAPIError.transport = error { offline = true }
                failed(reason(error))
            } else {
                report(error)
            }
            return false
        }
    }

    private func isSessionEnd(_ error: Error) -> Bool {
        if case DriveAPIError.notAuthenticated = error { return true }
        return false
    }

    func createFolder(named name: String, in folder: String) async {
        _ = await perform(in: folder) { _ = try await vault.createFolder(in: folder, name: name) }
    }

    func rename(_ item: Opened, to name: String) async {
        _ = await perform(in: item.node.parentId) { _ = try await vault.rename(item.id, to: name) }
    }

    func move(_ item: Opened, to folder: String) async {
        // Where it is now: an Undo hands back the item as it was before the move, whose parent is the destination.
        let from = await vault.item(item.id)?.node.parentId ?? item.node.parentId
        let ok = await perform(in: from) { _ = try await vault.move(item.id, to: folder) }
        if ok { await refresh(folder: folder); FilesDomain.signal(folderId: folder); await caughtUp() }
    }

    /*
     * After a move or copy the server accepted: the vault filed it at once, so Home's Recent,
     * search and locations follow now rather than at the next sync. A write that failed changed
     * nothing here, so there is nothing to roll back.
     */
    private func caughtUp() async {
        await reloadCatalogue()
        recents = (try? await vault.recents()) ?? recents
        catalogueVersion += 1
    }

    func copy(_ items: [Opened]) { clipboard = (items, false) }
    func cut(_ items: [Opened]) { clipboard = (items, true) }

    /* Cut items move; copied ones are duplicated, folder trees node by node. */
    func paste(into folder: String) async {
        guard let clip = clipboard, canPaste(into: folder) else { return }
        clipboard = nil
        let cut = clip.cut
        // What is already here stays as it is; only the rest comes over.
        let items = clip.items.filter { $0.node.parentId != folder }
        for (index, item) in items.enumerated() {
            let targetWorkspace = (try? await vault.workspaceId(of: folder)) ?? item.node.workspaceId
            if cut && targetWorkspace == item.node.workspaceId {
                await move(item, to: folder)
            } else {
                _ = index
                let ticket = begin(.copy, item.name)
                var why: String?
                if targetWorkspace == item.node.workspaceId {
                    let ok = await perform(in: folder, failed: { why = $0 }) { _ = try await vault.copy(item.id, to: folder) }
                    finish(ticket, failed: !ok, message: why)
                } else {
                    // Across drives (into a shared folder) the object is fetched and uploaded again; a cut then trashes the original.
                    let ok = await perform(in: folder, failed: { why = $0 }) { _ = try await vault.copyAcross(item.id, to: folder) { fraction in Task { @MainActor in self.progress(ticket, fraction) } } }
                    finish(ticket, failed: !ok, message: why)
                    if ok && cut { await trash(item) }
                }
            }
        }
        if !items.isEmpty { await caughtUp() }
    }

    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid

    /* A transfer keeps running for a while after the app leaves the screen; iOS grants the time when asked. */
    private func holdBackground() {
        guard backgroundTask == .invalid else { return }
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "transfer") { [weak self] in self?.releaseBackground() }
    }

    private func releaseBackground() {
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }

    /* Files being kept downloaded from a share, fetched in the foreground; the queue tracks its own. */
    private var keeping: Set<String> = []
    /* Folders whose files are coming down right now. */
    private var keepingFolders: Set<String> = []

    /* Whether this item is on the phone: a kept file, or a kept folder (its row carries the same mark). */
    func isOnPhone(_ item: Opened) -> Bool {
        _ = offlineVersion
        // A subfolder of a kept folder is kept with it, and says so.
        if item.isFolder { return Offline.isFolderKept(item.id) || keptFolderAbove(item) != nil }
        return Offline.isKept(item.id)
    }

    /* The kept folder a file comes with, which alone can take it off the phone. */
    func keptWith(_ item: Opened) -> Offline.KeptFolder? {
        _ = offlineVersion
        return item.isFolder ? nil : keptFolderAbove(item)
    }

    /*
     * Keep on this phone, for a folder: every file inside it and its subfolders comes down as
     * one keep in the transfers panel, and the folder stays kept, so what is added or replaced
     * later comes down on sync and what leaves it goes.
     */
    func keepFolder(_ folder: Opened) async {
        Offline.rememberFolder(folder)
        offlineVersion += 1
        await fetchKeptFolder(folder.id, name: folder.name)
        FilesDomain.signal(folderId: folder.id)
    }

    /* Remove from this phone, for a folder: every file kept with it goes; files kept on their own stay. */
    func removeKeptFolder(_ id: String) {
        BackgroundTransfers.shared.cancelFolder(id)
        Offline.forgetFolder(id)
        offlineVersion += 1
        FilesDomain.signal(folderId: id)
    }

    /* Brings a kept folder's files in line with the folder: what is missing or replaced comes down, what left it goes. */
    private func fetchKeptFolder(_ id: String, name: String) async {
        guard !keepingFolders.contains(id) else { return }
        guard let kept = Offline.keptFolders().first(where: { $0.id == id }) else { return }
        let own = myWorkspace == nil || kept.workspaceId == myWorkspace
        keepingFolders.insert(id)
        offlineVersion += 1
        defer { keepingFolders.remove(id); offlineVersion += 1 }
        if !own {
            // A share's folder lists through the share: its root must be open, and the folder found in that workspace.
            if !mountsLoaded { await refreshMounts() }
            await vault.hint(workspace: kept.workspaceId, for: id)
        }
        // In the Trash, or gone from the drive: nothing left to keep.
        if let folder = await vault.item(id), folder.node.trashedAt != nil { Offline.forgetFolder(id); return }
        let files: [Opened]
        do {
            files = try await vault.filesUnder(id)
        } catch DriveAPIError.notFound {
            Offline.forgetFolder(id)
            return
        } catch {
            // Offline: the copies already here stay; the next sync tries again.
            if case DriveAPIError.transport = error { offline = true } else { report(error) }
            return
        }
        let wanted = Set(files.map(\.id))
        for entry in Offline.entries(keptWith: id) where !wanted.contains(entry.id) { Offline.forget(entry.id) }
        for failure in Offline.keepFailures(in: id) where !wanted.contains(failure.fileId) { Offline.clearKeepFailure(failure.fileId) }
        var missing: [Opened] = []
        for file in files {
            // One that failed waits its turn (half a minute, doubling to an hour) instead of failing every sync.
            guard Offline.isKeepDue(file.id) else { continue }
            if !Offline.isKept(file.id) { missing.append(file); continue }
            if await vault.keptVersionMissing(file.id) { missing.append(file) }
        }
        guard !missing.isEmpty else { return }
        if own {
            // Fetched by iOS like a single keep: it finishes with the app in the background, or closed.
            BackgroundTransfers.shared.keep(missing, folder: id, named: name)
            return
        }
        // A share's files come down in the foreground, as a single file from a share does.
        let ticket = begin(.keep, name)
        let total = max(1, missing.compactMap(\.size).reduce(0, +))
        if let index = transfers.firstIndex(where: { $0.id == ticket }) {
            transfers[index].folder = true
            transfers[index].size = Int64(total)
        }
        var done: UInt64 = 0
        var failures = 0
        for file in missing {
            let size = file.size ?? 0
            let before = done
            var why = TransferWords.keep
            let ok = await perform(in: nil, failed: { why = $0 }) {
                try await vault.keepDownloaded(file, folder: id) { fraction in
                    Task { @MainActor in self.progress(ticket, (Double(before) + fraction * Double(size)) / Double(total)) }
                }
            }
            done += size
            if !ok {
                if offline { break }
                // The rest of the folder stays kept; this file waits and says why.
                Offline.recordKeepFailure(file.id, folder: id, reason: why)
                failures += 1
            }
        }
        finish(ticket, failed: failures > 0, message: failures == 0 ? nil : failures == 1 ? "1 file couldn’t be kept" : "\(failures) files couldn’t be kept")
    }

    /* Retry, from a file of a kept folder that couldn't be kept: it goes again now. */
    func retryKeep(_ item: Opened) async {
        Offline.clearKeepFailure(item.id)
        offlineVersion += 1
        if let folder = keptFolderAbove(item) { await fetchKeptFolder(folder.id, name: folder.name) }
    }

    /* Why a file of a kept folder couldn't be kept, while it waits to be tried again. */
    func keepFailure(_ item: Opened) -> Offline.KeepFailure? {
        _ = offlineVersion
        return Offline.keepFailures()[item.id]
    }

    /* The kept folder this item sits in, at any depth; nil when none above it is kept. */
    func keptFolderAbove(_ item: Opened) -> Offline.KeptFolder? {
        _ = offlineVersion
        let kept = Offline.keptFolders()
        guard !kept.isEmpty else { return nil }
        if let entry = Offline.keptBy(item.id) { return entry }
        var cursor = item.node.parentId
        var steps = 0
        while let id = cursor, steps < 256 {
            if let folder = kept.first(where: { $0.id == id }) { return folder }
            cursor = known(id)?.node.parentId
            steps += 1
        }
        return nil
    }

    /*
     * Kept folders now rather than at the next tick: when the app comes to the front, on pull
     * to refresh. Shares are asked again first, so a stopped one takes its copies with it.
     */
    func syncKeptNow() async {
        guard !Offline.keptFolders().isEmpty || Offline.entries().contains(where: { $0.workspaceId != nil && $0.workspaceId != myWorkspace }) else { return }
        await refreshMounts()
        dropUnshared()
        refreshKeptFolders(includingShares: true)
    }

    /* Copies kept from shares that are no longer shared with this account go, and the notice says so. */
    private func dropUnshared() {
        guard mountsLoaded, mountsError == nil, let own = myWorkspace else { return }
        let removed = Offline.forgetUnshared(own: own, shared: Set(mounts.map(\.share.workspaceId)))
        guard !removed.isEmpty else { return }
        offlineVersion += 1
        notify(removed.count == 1
            ? "“\(removed[0].name)” is no longer shared with you, so it was removed from this phone."
            : "\(removed.count) folders are no longer shared with you, so they were removed from this phone.",
            important: true)
    }

    /*
     * Where a file's local copy stands, for its menu. The list lives in defaults, which nothing
     * observes, so this reads `offlineVersion` to redraw a menu when the list changes.
     */
    enum KeptState { case none, fetching(queued: UUID?), kept }
    func keptState(_ id: String) -> KeptState {
        _ = offlineVersion
        if keepingFolders.contains(id) || BackgroundTransfers.shared.keepingFolder(id) { return .fetching(queued: nil) }
        if Offline.isFolderKept(id) { return .kept }
        if let record = BackgroundTransfers.shared.records.first(where: { $0.kind == .keep && $0.nodeId == id && $0.state != .done && $0.state != .failed }) {
            return .fetching(queued: record.id)
        }
        if keeping.contains(id) { return .fetching(queued: nil) }
        return Offline.isKept(id) ? .kept : .none
    }

    /* Keep downloaded on or off: the local copy comes or goes, and Files follows through the extension. */
    func setKeptDownloaded(_ item: Opened, _ keep: Bool) async {
        if keep, let parent = item.node.parentId, await ownDrive(parent) {
            // Queued like an upload: fetched by iOS, whether or not the app is open.
            BackgroundTransfers.shared.keep(item)
        } else if keep {
            guard !keeping.contains(item.id) else { return }
            keeping.insert(item.id)
            defer { keeping.remove(item.id) }
            let ticket = begin(.keep, item.name)
            var why: String?
            let ok = await perform(in: nil, failed: { why = $0 }) { try await vault.keepDownloaded(item) { fraction in Task { @MainActor in self.progress(ticket, fraction) } } }
            finish(ticket, failed: !ok, message: why)
        } else {
            Offline.forget(item.id)
        }
        offlineVersion += 1
        FilesDomain.signal(folderId: item.node.parentId)
    }

    /* The item as the server has it now: the folder listed again, the row picked out. */
    func reload(_ item: Opened) async throws -> Opened? {
        await vault.forget(item.id)
        guard let parent = item.node.parentId else { return nil }
        // Opened again from the server's listing: forgetting alone dropped it from the catalogue, so the
        // folder drew without it and a free-name check missed it until the next build.
        let fresh = try await vault.resolve(item.id)
        await refresh(folder: parent)
        return folders[parent]?.first { $0.id == item.id } ?? fresh
    }

    /* Revokes a share and, as the web does, rotates the subtree so the old key opens nothing new. */
    func revokeAndRotate(_ share: ShareView, for item: Opened) async throws {
        try await vault.revokeShare(share, for: item)
        try await rotateAfterRevoke(item)
    }

    /* Turns a link off and rotates the same way: whoever kept the link's key opens nothing changed after. */
    func turnOffLink(_ link: LinkView, for item: Opened) async throws {
        try await vault.revokeLink(link, for: item)
        try await rotateAfterRevoke(item)
    }

    /* Not a transfer any more (the board): the work runs quietly and a failure comes back to the caller. */
    /*
     * Lists keep their (stale) rows while the keys change underneath, and listings
     * wait for it to finish rather than open children with half-rotated keys. Then
     * every folder on hand inside the subtree, and the one holding it, loads again.
     * (It used to empty every folder and reload only the parent, which left any
     * other folder on screen, the shared one itself included, loading forever.)
     */
    private func rotateAfterRevoke(_ item: Opened) async throws {
        holdBackground()
        defer { releaseBackground() }
        let stale = Set(folders.keys.filter { $0 == item.id || isInside($0, item.id) } + [item.node.parentId].compactMap { $0 })
        let work = Task { @MainActor in _ = try await self.vault.rotate(item) { _ in } }
        rotation = Task { _ = try? await work.value }
        defer { rotation = nil }
        do {
            try await work.value
        } catch {
            rotation = nil
            // Half-rotated: what is on screen may not open any more, so those folders say so with Try again.
            for id in stale { folders[id] = nil; folderProblems[id] = .failed }
            throw error
        }
        rotation = nil
        // The vault rebuilds its catalogue from the feed; this side picks the fresh items up from it.
        _ = try? await vault.sync()
        await reloadCatalogue()
        for id in stale { await refresh(folder: id) }
        await refreshRecents()
    }

    /* Whether `id` sits somewhere under `ancestor`, as far as this device knows. */
    private func isInside(_ id: String, _ ancestor: String) -> Bool {
        var cursor = known(id)?.node.parentId
        var steps = 0
        while let current = cursor, steps < 256 {
            if current == ancestor { return true }
            cursor = known(current)?.node.parentId
            steps += 1
        }
        return false
    }

    func trash(_ items: [Opened]) async {
        var moved: [Opened] = []
        for item in items where await trashOne(item) { moved.append(item) }
        announceTrash(moved)
    }

    /* A short line after an action, with a way to take it back; shown above any sheet (NoticeCenter). */
    func notify(_ text: String, undo: (() -> Void)? = nil, actionLabel: String = "Undo", important: Bool = false) {
        NoticeCenter.shared.show(text, undo: undo, actionLabel: actionLabel, important: important)
    }

    /* Says what went to the trash and offers to bring it straight back. */
    private func announceTrash(_ items: [Opened]) {
        guard !items.isEmpty else { return }
        notify(items.count == 1 ? "Moved “\(items[0].name)” to Trash" : "Moved \(items.count) items to Trash") { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                for item in items { await self.restore(item, parentTrashed: false) }
                await self.refreshRecents()
            }
        }
    }

    /*
     * Keeps lists current while the app is on screen, as the web polls its
     * feed: changes from other devices appear without a pull. A failure here
     * raises nothing; sync() only keeps or sets the offline line.
     */
    func liveSync() async {
        // Coming to the front: kept folders are brought up to date at once, not at the next tick.
        await syncKeptNow()
        var tick = 0
        while !Task.isCancelled {
            await sync()
            // A share's kept folders aren't in this drive's feed: they are listed again every half minute.
            tick += 1
            if tick % 3 == 0 { await syncKeptNow() }
            try? await Task.sleep(for: .seconds(10))
        }
    }

    /*
     * Move, from the folder picker: within one drive the item is re-parented (one key rewrapped);
     * into or out of someone else's folder it is copied across and the original goes to the Trash,
     * which is what Cut and Paste did before Move replaced them. Says where things went, with Undo
     * when every move stayed inside one drive.
     */
    func move(_ items: [Opened], to folder: String, named folderName: String) async {
        let targetWorkspace = (try? await vault.workspaceId(of: folder)) ?? myWorkspace
        var moved: [Opened] = []
        var across = false
        for item in items where item.node.parentId != folder {
            if targetWorkspace == nil || targetWorkspace == item.node.workspaceId {
                let ok = await perform(in: item.node.parentId) { _ = try await vault.move(item.id, to: folder) }
                if ok { moved.append(item) }
            } else {
                across = true
                let ticket = begin(.copy, item.name)
                var why: String?
                let ok = await perform(in: folder, failed: { why = $0 }) { _ = try await vault.copyAcross(item.id, to: folder) { fraction in Task { @MainActor in self.progress(ticket, fraction) } } }
                finish(ticket, failed: !ok, message: why)
                if ok, await perform(in: item.node.parentId, { try await vault.trash(item.id) }) { moved.append(item) }
            }
        }
        await refresh(folder: folder)
        guard !moved.isEmpty else { return }
        // The Files app lists both folders too: the one they left was signalled with each move, this one now.
        FilesDomain.signal(folderId: folder)
        await caughtUp()
        let text = moved.count == 1 ? "Moved “\(moved[0].name)” to “\(folderName)”" : "Moved \(moved.count) items to “\(folderName)”"
        if across {
            notify(text)
        } else {
            notify(text) { [weak self] in
                Task { @MainActor in
                    guard let self else { return }
                    for item in moved { if let from = item.node.parentId { await self.move(item, to: from) } }
                }
            }
        }
    }

    /*
     * Save a copy to my files: something shared with this account, read through the share's key and
     * uploaded again into the top folder under this account's own keys, under a name free there.
     */
    func saveCopy(_ item: Opened) async {
        guard let root = await loadRoot() else { return }
        if folders[root] == nil { await refresh(folder: root) }
        let name = Self.freeName(item.name, among: (folders[root] ?? []).map(\.name))
        notify("Saving “\(item.name)” to your files")
        let ticket = begin(.copy, item.name)
        var why: String?
        let ok = await perform(in: root, failed: { why = $0 }) {
            _ = try await vault.copyAcross(item.id, to: root, name: name) { fraction in Task { @MainActor in self.progress(ticket, fraction) } }
        }
        finish(ticket, failed: !ok, message: why)
    }

    /* The same from a link someone opened: fetched through the link, uploaded into the top folder. */
    func saveCopy(_ item: Opened, from link: LinkVault) async {
        guard let root = await loadRoot() else { return }
        if folders[root] == nil { await refresh(folder: root) }
        notify("Saving “\(item.name)” to your files")
        let ticket = begin(.copy, item.name)
        var why: String?
        let ok = await perform(in: root, failed: { why = $0 }) {
            try await self.copy(from: link, item: item, into: root, ticket: ticket)
        }
        finish(ticket, failed: !ok, message: why)
    }

    private func copy(from link: LinkVault, item: Opened, into parent: String, ticket: UUID) async throws {
        let taken = (try? await vault.children(of: parent))?.map(\.name) ?? []
        let name = Self.freeName(item.name, among: taken)
        if item.isFolder {
            let made = try await vault.createFolder(in: parent, name: name)
            for child in try await link.children(of: item.id) { try await copy(from: link, item: child, into: made.id, ticket: ticket) }
            return
        }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("save-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent(item.name)
        try await link.download(item, to: file) { fraction in Task { @MainActor in self.progress(ticket, fraction / 2) } }
        let thumbnail = try? await link.thumbnail(item)
        _ = try await vault.upload(fileURL: file, name: name, mime: item.metadata.mime, in: parent, replacing: nil, thumbnail: thumbnail) { fraction in
            Task { @MainActor in self.progress(ticket, 0.5 + fraction / 2) }
        }
    }

    /* Deletes an earlier version now; the current one is never touched. */
    func discardVersion(_ version: VersionListView, of item: Opened) async -> Bool {
        await perform(in: nil) { try await vault.api.discardVersion(version.id, workspaceId: item.node.workspaceId) }
    }

    func trash(_ item: Opened) async {
        if await trashOne(item) { announceTrash([item]) }
    }

    private func trashOne(_ item: Opened) async -> Bool {
        let ok = await perform(in: item.node.parentId) { try await vault.trash(item.id) }
        recents.removeAll { $0.id == item.id }
        return ok
    }

    func restore(_ item: Opened, parentTrashed: Bool) async {
        let folder = wasIn(item)
        let ok = await onTrashRow(item) { _ = try await vault.restore(item, parentTrashed: parentTrashed) }
        if ok, let parent = item.node.parentId, folders[parent] != nil { await refresh(folder: parent) }
        if ok { notify(parentTrashed ? "Restored “\(item.name)” to Files" : "Restored “\(item.name)”" + (folder.map { " to \($0)" } ?? "")) }
    }

    func purge(_ item: Opened) async {
        _ = await onTrashRow(item) { try await vault.purge(item.id) }
    }

    /*
     * A trash row's action: a spinner on the row while it runs, the row gone the moment
     * the server agrees, then the feed pulled so the catalogue the trash reads from
     * knows it too; without the pull the list came back as it was.
     */
    private func onTrashRow(_ item: Opened, _ action: () async throws -> Void) async -> Bool {
        guard !trashWorking.contains(item.id) else { return false }
        trashWorking.insert(item.id)
        let ok = await perform(in: nil, action)
        trashWorking.remove(item.id)
        if ok {
            trash.removeAll { $0.item.id == item.id }
            await sync()
            await refreshTrash()
        }
        return ok
    }

    /* The folders above `item`, nearest first, as far as the catalogue knows them. */
    private func ancestors(of item: Opened) async -> [Opened] {
        var chain: [Opened] = []
        var cursor = item.node.parentId
        while let id = cursor, chain.count < 256, let parent = await vault.item(id) {
            chain.append(parent)
            cursor = parent.node.parentId
        }
        return chain
    }

    /*
     * Restores several trash rows. Shallowest first, so a folder comes back before
     * what was trashed inside it; a row whose trashed folders all came back in this
     * batch goes home, one whose folder is still in the trash goes to the top.
     */
    func restoreMany(_ entries: [(item: Opened, parentTrashed: Bool)]) async {
        var chains: [String: [Opened]] = [:]
        for entry in entries { chains[entry.item.id] = await ancestors(of: entry.item) }
        let ordered = entries.sorted { (chains[$0.item.id]?.count ?? 0) < (chains[$1.item.id]?.count ?? 0) }
        var back: Set<String> = []
        var failed: [(entry: (item: Opened, parentTrashed: Bool), reason: String)] = []
        var moved: [(item: Opened, folder: String?)] = []
        restoreProblem = nil
        trashWorking.formUnion(entries.map(\.item.id))
        for entry in ordered {
            let trashedAbove = (chains[entry.item.id] ?? []).filter { $0.node.trashedAt != nil }
            let home = trashedAbove.allSatisfy { back.contains($0.id) }
            var why = ""
            let ok = await perform(in: nil, failed: { why = $0 }) { _ = try await vault.restore(entry.item, parentTrashed: !home) }
            trashWorking.remove(entry.item.id)
            if ok {
                back.insert(entry.item.id)
                if !home { moved.append((entry.item, wasIn(entry.item))) }
                trash.removeAll { $0.item.id == entry.item.id }
            } else {
                failed.append((entry, why))
            }
        }
        await sync()
        await refreshTrash()
        folders.removeAll()
        let restored = entries.count - failed.count
        // Some didn't come back: a banner that stays, saying which, why and what to do (the board's), not a passing notice.
        if !failed.isEmpty {
            restoreProblem = RestoreProblem(restored: restored, total: entries.count, failed: failed, moved: moved)
            return
        }
        var text = restored == 1 ? "1 item restored" : "\(restored) items restored"
        if !moved.isEmpty { text += moved.count == 1 ? ". One went back to Files: its folder is still in the Trash." : ". \(moved.count) went back to Files: their folders are still in the Trash." }
        notify(text)
    }

    /* Deletes several trash rows forever; what sits inside a picked folder goes with it, so it is not asked for twice. */
    func purgeMany(_ entries: [(item: Opened, parentTrashed: Bool)]) async {
        let picked = Set(entries.map(\.item.id))
        var inside: Set<String> = []
        for entry in entries where await ancestors(of: entry.item).contains(where: { picked.contains($0.id) }) { inside.insert(entry.item.id) }
        let tops = entries.filter { !inside.contains($0.item.id) }
        var failed = 0
        trashWorking.formUnion(picked)
        for entry in tops {
            let ok = await perform(in: nil, failed: { _ in }) { try await vault.purge(entry.item.id) }
            trashWorking.remove(entry.item.id)
            if ok { trash.removeAll { $0.item.id == entry.item.id } } else { failed += 1 }
        }
        trashWorking.subtract(picked)
        await sync()
        await refreshTrash()
        notify(failed > 0 ? "\(failed) of \(tops.count) could not be deleted" : entries.count == 1 ? "1 item deleted forever" : "\(entries.count) items deleted forever")
    }

    /*
     * Empty Trash: the rows on screen go one at a time (what sits inside a trashed folder goes
     * with it), so the bar can say "4 of 12" and only the row going spins; then the server's
     * batches take whatever the list didn't show, until nothing is left or nothing moves.
     */
    func emptyTrash() async {
        guard !emptyingTrash else { return }
        emptyingTrash = true
        defer { emptyingTrash = false; emptying = nil }
        let rows = trash
        let ids = Set(rows.map(\.item.id))
        var inside: Set<String> = []
        for entry in rows where await ancestors(of: entry.item).contains(where: { ids.contains($0.id) }) { inside.insert(entry.item.id) }
        let tops = rows.filter { !inside.contains($0.item.id) }
        emptying = (0, tops.count)
        var failedRows = 0
        for (index, entry) in tops.enumerated() {
            trashWorking.insert(entry.item.id)
            let ok = await perform(in: nil, failed: { _ in }) { try await vault.purge(entry.item.id) }
            trashWorking.remove(entry.item.id)
            if ok {
                var gone: Set<String> = [entry.item.id]
                for row in trash where inside.contains(row.item.id) {
                    if await ancestors(of: row.item).contains(where: { $0.id == entry.item.id }) { gone.insert(row.item.id) }
                }
                trash.removeAll { gone.contains($0.item.id) }
            } else {
                failedRows += 1
                if offline { break }
            }
            emptying = (index + 1, tops.count)
        }
        var last: EmptyTrashResult?
        while failedRows == 0 {
            var step: EmptyTrashResult?
            guard await perform(in: nil, { step = try await vault.emptyTrash() }), let step else { break }
            last = step
            if step.remaining == 0 || step.purged == 0 { break }
        }
        if last?.remaining == 0 { trash = [] }
        await sync()
        await refreshTrash()
        // Android's words: done, or what is left and what to do; offline, the offline line already says why.
        if failedRows == 0 && last?.remaining == 0 {
            notify("Trash emptied")
        } else if !offline && !trash.isEmpty {
            notify("Some items are still in the Trash. Try Empty Trash again.")
        }
    }

    /* Every earlier version in this drive, in batches until none are left. Files keep their current version. */
    @discardableResult
    func discardEarlierVersions() async -> Bool {
        while true {
            var step: EmptyTrashResult?
            guard await perform(in: nil, { step = try await vault.discardEarlierVersions() }), let step else { return false }
            if step.remaining == 0 || step.purged == 0 { return true }
        }
    }

    @discardableResult
    func restoreVersion(_ version: VersionListView, of item: Opened) async -> Bool {
        await perform(in: item.node.parentId) { _ = try await vault.restoreVersion(version, of: item.id) }
    }

    /* What to do with a picked file whose name a file in the folder already has, as the web asks. */
    enum Conflict { case replace, keepBoth, skip }

    /* The picked files whose names already exist in `folder`. */
    func conflicts(_ files: [(url: URL, name: String, type: UTType?)], in folder: String) -> [Opened] {
        let existing = (folders[folder] ?? []).filter { !$0.isFolder }
        return files.compactMap { file in existing.first { $0.name.caseInsensitiveCompare(file.name) == .orderedSame } }
    }

    /* Pasting into the folder the items already sit in is a no-op the drives refuse; so do we. */
    func canPaste(into folder: String) -> Bool { pasteProblem(into: folder) == nil }

    /* Whether `folder` is `ancestor` itself or lies below it, as far as the listings loaded so far tell. */
    private func descends(_ folder: String, from ancestor: String) -> Bool {
        var cursor: String? = folder
        var steps = 0
        while let id = cursor, steps < 256 {
            if id == ancestor { return true }
            cursor = folders.values.lazy.compactMap { $0.first { $0.id == id } }.first?.node.parentId
            steps += 1
        }
        return false
    }

    /* Why the clipboard cannot go into this folder, or nil when it can. */
    func pasteProblem(into folder: String) -> String? {
        guard let clip = clipboard else { return "Nothing to paste" }
        if clip.items.contains(where: { $0.isFolder && descends(folder, from: $0.id) }) { return "Can’t paste a folder into itself" }
        return clip.items.contains { $0.node.parentId != folder } ? nil : clip.items.count == 1 ? "It’s already in this folder" : "They’re already in this folder"
    }

    /* Files picked from the document or photo picker, each uploaded in turn with its thumbnail. `renames` names the kept-both ones. */
    func upload(_ files: [(url: URL, name: String, type: UTType?)], to folder: String, onConflict: Conflict = .keepBoth, decisions: [String: Conflict] = [:], renames: [String: String] = [:]) async {
        let existing = (folders[folder] ?? []).filter { !$0.isFolder }
        holdBackground()
        defer { releaseBackground() }
        for (index, file) in files.enumerated() {
            let mime = file.type?.preferredMIMEType
            let clash = existing.first { $0.name.caseInsensitiveCompare(file.name) == .orderedSame }
            var name = file.name
            var replacing: Opened?
            if let clash {
                // Asked per file now, as the web asks; a batch answer covers whatever was not asked.
                switch decisions[file.name] ?? onConflict {
                case .skip: try? FileManager.default.removeItem(at: file.url); continue
                case .replace: replacing = clash
                case .keepBoth: name = renames[file.name] ?? Self.freeName(file.name, among: existing.map(\.name))
                }
            }
            _ = index
            if await ownDrive(folder) {
                // Where Save to HushOS and the quick actions add next.
                Places.used(folder, name: folder == rootId ? "Files" : known(folder)?.name ?? "Files")
                // Queued: sealed and handed to iOS, which sends it even if the app is closed; the panel shows it.
                BackgroundTransfers.shared.upload(fileURL: file.url, name: name, mime: mime, folderId: folder, replacingId: replacing?.id)
                continue
            }
            // A shared folder lives in someone else's drive: uploaded here and now, as before.
            if !(await uploadNow(PendingUpload(url: file.url, name: name, mime: mime, folder: folder, replacing: replacing))) { break }
        }
    }

    /* A quick action waiting for its folder's view to open: that view runs it, as its + menu would. */
    struct PendingAdd: Equatable {
        let folder: String
        let action: QuickAction
    }

    var pendingAdd: PendingAdd?

    /* Whether a folder is in this account's own drive, where the background queue can finish without the app. */
    func ownDrive(_ folderId: String) async -> Bool {
        guard let mine = try? await vault.workspaceId(), let theirs = try? await vault.workspaceId(of: folderId) else { return false }
        return mine == theirs
    }

    /* "report.pdf" becomes "report (2).pdf", then "(3)", until the name is free. */
    static func freeName(_ name: String, among taken: [String]) -> String {
        let lower = Set(taken.map { $0.lowercased() })
        guard lower.contains(name.lowercased()) else { return name }
        let ext = (name as NSString).pathExtension
        let stem = ext.isEmpty ? name : (name as NSString).deletingPathExtension
        for n in 2 ... 999 {
            let candidate = ext.isEmpty ? "\(stem) (\(n))" : "\(stem) (\(n)).\(ext)"
            if !lower.contains(candidate.lowercased()) { return candidate }
        }
        return "\(stem) \(UUID().uuidString.prefix(6))\(ext.isEmpty ? "" : ".\(ext)")"
    }

    /* As `download`, but the failure comes back to the caller (the viewer and Send a copy say it in place). */
    func fetch(_ item: Opened, version: VersionListView? = nil) async throws -> URL {
        if version == nil, let kept = Offline.localCopy(of: item) { return kept }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("opened/\(item.id)/\(version?.id ?? item.node.currentVersion?.id ?? "current")", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appendingPathComponent(item.name)
        if FileManager.default.fileExists(atPath: file.path) { return file }
        opening[item.id] = 0
        holdBackground()
        defer {
            opening[item.id] = nil
            releaseBackground()
        }
        do {
            try await vault.download(item.id, version: version, to: file) { fraction in Task { @MainActor in self.opening[item.id] = fraction } }
        } catch {
            if case DriveAPIError.transport = error { offline = true }
            if case DriveAPIError.notAuthenticated = error { self.error = Self.sessionEnded }
            throw error
        }
        return file
    }

    /* Decrypts to a temporary file named as the user sees it, for Quick Look and the share sheet. */
    func download(_ item: Opened, version: VersionListView? = nil) async -> URL? {
        if version == nil, let kept = Offline.localCopy(of: item) { return kept }
        // Keyed by the version itself, so a file replaced elsewhere is fetched again rather than served from an old copy.
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("opened/\(item.id)/\(version?.id ?? item.node.currentVersion?.id ?? "current")", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appendingPathComponent(item.name)
        if FileManager.default.fileExists(atPath: file.path) { return file }
        // Opening a file is not a transfer to announce: the row shows a small ring while it comes down.
        opening[item.id] = 0
        holdBackground()
        defer {
            opening[item.id] = nil
            releaseBackground()
        }
        do {
            try await vault.download(item.id, version: version, to: file) { fraction in Task { @MainActor in self.opening[item.id] = fraction } }
            return file
        } catch {
            report(error)
            return nil
        }
    }

    func report(_ error: Error) {
        error_: do {
            if case DriveAPIError.notAuthenticated = error { self.error = Self.sessionEnded; break error_ }
            // No network: say so at the top rather than interrupting; kept files still open.
            if case DriveAPIError.transport = error { offline = true; break error_ }
            let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            // The same failure from every list and every sync would put the alert back the moment
            // it is dismissed and lock the person out of the app (Account, Sign out): once a minute is enough.
            if let last = lastReported, last.message == message, Date().timeIntervalSince(last.at) < 60 { break error_ }
            lastReported = (message, Date())
            self.error = message
        }
    }

    private var lastReported: (message: String, at: Date)?
}
