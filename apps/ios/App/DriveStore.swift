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
    let vault: Vault
    var folders: [String: [Opened]] = [:]
    /* Bumped whenever the offline list changes, so views showing it refresh. */
    var offlineVersion = 0
    /* Bumped when the catalogue changes what lists show. */
    var catalogueVersion = 0
    var names: [String: String] = [:]
    var recents: [Opened] = []
    var trash: [(item: Opened, parentTrashed: Bool)] = []
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
    var busy = false
    /* Transfers in flight and just finished, each with its own bar, as the web's panel shows them. */
    struct TransferItem: Identifiable, Equatable {
        enum Kind { case upload, download, copy, keep, rotate }
        let id = UUID()
        var kind: Kind
        var name: String
        var fraction: Double
        var done = false
        var failed = false
    }
    var transfers: [TransferItem] = []
    /* Files being fetched to open, by node id, with progress: a spinner on the row, not a banner. */
    var opening: [String: Double] = [:]
    private let activity = TransferActivity()
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
        let running = transfers.filter { !$0.done }
        let title = running.count > 1 ? "\(running.count) transfers" : (running.first?.name ?? "")
        activity.update(title: title, fraction: running.map(\.fraction).reduce(0, +) / Double(max(running.count, 1)))
    }

    func finish(_ id: UUID, failed: Bool = false) {
        guard let index = transfers.firstIndex(where: { $0.id == id }) else { return }
        transfers[index].done = true
        transfers[index].failed = failed
        if !failed { transfers[index].fraction = 1 }
        // Finished rows linger so the result is seen, then go once everything is done.
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(4))
            if transfers.allSatisfy(\.done) { transfers.removeAll() }
        }
    }

    private var networkToken: UUID?

    init(vault: Vault) {
        self.vault = vault
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
        catalogueVersion += 1
        // The build took in every change since the last run, so every kept file is checked against it.
        refreshKept(Set(Offline.entries().map(\.id)))
    }

    /* Pulls what changed since the cursor and redraws the lists it touched. */
    func sync() async {
        // Nil: the server was not asked (no network, or the tree opened from the phone), so the offline line stays.
        guard let touched = try? await vault.sync() else { return }
        // The feed answered: whatever the last request said, the server is reachable now.
        offline = false
        if touched.isEmpty { return }
        for id in folders.keys where touched.contains(id) || folders[id]?.contains(where: { touched.contains($0.id) }) == true {
            if let children = try? await vault.children(of: id) { folders[id] = children }
        }
        recents = (try? await vault.recents()) ?? recents
        catalogueVersion += 1
        refreshKept(touched)
    }

    private var refreshingKept: Set<String> = []

    /*
     * A kept file changed elsewhere is brought up to date on its own, so a
     * refresh or an upload never waits for a large file to come down again.
     */
    private func refreshKept(_ touched: Set<String>) {
        let kept = Offline.entries().filter { touched.contains($0.id) && !refreshingKept.contains($0.id) }
        guard !kept.isEmpty else { return }
        let ids = Set(kept.map(\.id))
        refreshingKept.formUnion(ids)
        Task {
            // Only files whose copy is missing get a row: a rename or a tag moves nothing.
            var tickets: [String: UUID] = [:]
            for entry in kept where await vault.keptVersionMissing(entry.id) { tickets[entry.id] = begin(.keep, entry.name) }
            let rows = tickets
            let failed = await vault.refreshOffline(ids) { id, fraction in Task { @MainActor in if let ticket = rows[id] { self.progress(ticket, fraction) } } }
            for (id, ticket) in rows { finish(ticket, failed: failed.contains(id)) }
            refreshingKept.subtract(ids)
            offlineVersion += 1
        }
    }

    func refresh(folder id: String) async {
        loading.insert(id)
        defer { loading.remove(id) }
        do {
            await sync()
            let children = try await vault.children(of: id)
            folders[id] = children
            for child in children { names[child.id] = child.name }
        } catch {
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
            trash = try await vault.trash()
        } catch {
            report(error)
        }
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

    private func perform(_ title: String? = nil, in folder: String?, _ work: () async throws -> Void) async -> Bool {
        busy = true
        defer { busy = false }
        do {
            try await work()
            if let folder { await refresh(folder: folder) }
            FilesDomain.signal(folderId: folder)
            return true
        } catch {
            report(error)
            return false
        }
    }

    func createFolder(named name: String, in folder: String) async {
        _ = await perform(in: folder) { _ = try await vault.createFolder(in: folder, name: name) }
    }

    func rename(_ item: Opened, to name: String) async {
        _ = await perform(in: item.node.parentId) { _ = try await vault.rename(item.id, to: name) }
    }

    func move(_ item: Opened, to folder: String) async {
        let ok = await perform(in: item.node.parentId) { _ = try await vault.move(item.id, to: folder) }
        if ok { await refresh(folder: folder) }
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
                if targetWorkspace == item.node.workspaceId {
                    let ok = await perform(in: folder) { _ = try await vault.copy(item.id, to: folder) }
                    finish(ticket, failed: !ok)
                } else {
                    // Across drives (into a shared folder) the object is fetched and uploaded again; a cut then trashes the original.
                    let ok = await perform(in: folder) { _ = try await vault.copyAcross(item.id, to: folder) { fraction in Task { @MainActor in self.progress(ticket, fraction) } } }
                    finish(ticket, failed: !ok)
                    if ok && cut { await trash(item) }
                }
            }
        }
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

    /* Keep downloaded on or off: the local copy comes or goes, and Files follows through the extension. */
    func setKeptDownloaded(_ item: Opened, _ keep: Bool) async {
        if keep {
            let ticket = begin(.keep, item.name)
            let ok = await perform(in: nil) { try await vault.keepDownloaded(item) { fraction in Task { @MainActor in self.progress(ticket, fraction) } } }
            finish(ticket, failed: !ok)
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
        await refresh(folder: parent)
        return folders[parent]?.first { $0.id == item.id }
    }

    /* Revokes a share and, as the web does, rotates the subtree so the old key opens nothing new. */
    func revokeAndRotate(_ share: ShareView, for item: Opened) async throws {
        try await vault.revokeShare(share, for: item)
        let ticket = begin(.rotate, "Rotating keys for \(item.name)")
        holdBackground(); activity.start(kind: "rotate", title: "Rotating keys for \(item.name)")
        defer {
            finish(ticket)
            releaseBackground(); activity.finish(title: "Keys rotated")
        }
        _ = try await vault.rotate(item) { count in Task { @MainActor in self.progress(ticket, 0, name: "Rotating keys · \(count) sealed") } }
        folders.removeAll()
        if let parent = item.node.parentId { await refresh(folder: parent) }
    }

    func trash(_ items: [Opened]) async {
        var moved: [Opened] = []
        for item in items where await trashOne(item) { moved.append(item) }
        announceTrash(moved)
    }

    /* A short line after an action, with a way to take it back: "Moved 2 items to trash · Undo". */
    struct Notice: Identifiable {
        let id = UUID()
        let text: String
        let undo: (() -> Void)?
    }
    var notice: Notice?

    func notify(_ text: String, undo: (() -> Void)? = nil) {
        let notice = Notice(text: text, undo: undo)
        self.notice = notice
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(6))
            if self.notice?.id == notice.id { self.notice = nil }
        }
    }

    /* Says what went to the trash and offers to bring it straight back. */
    private func announceTrash(_ items: [Opened]) {
        guard !items.isEmpty else { return }
        notify(items.count == 1 ? "Moved “\(items[0].name)” to trash" : "Moved \(items.count) items to trash") { [weak self] in
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
        while !Task.isCancelled {
            await sync()
            try? await Task.sleep(for: .seconds(10))
        }
    }

    func move(_ items: [Opened], to folder: String) async {
        for item in items { await move(item, to: folder) }
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
        let ok = await perform(in: nil) { _ = try await vault.restore(item, parentTrashed: parentTrashed) }
        if ok {
            await refreshTrash()
            if let parent = item.node.parentId, folders[parent] != nil { await refresh(folder: parent) }
        }
    }

    func purge(_ item: Opened) async {
        if await perform(in: nil, { try await vault.purge(item.id) }) { await refreshTrash() }
    }

    func emptyTrash() async {
        if await perform(in: nil, { _ = try await vault.emptyTrash() }) { await refreshTrash() }
    }

    func restoreVersion(_ version: VersionListView, of item: Opened) async {
        _ = await perform(in: item.node.parentId) { _ = try await vault.restoreVersion(version, of: item.id) }
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
        if clip.items.contains(where: { $0.isFolder && descends(folder, from: $0.id) }) { return "Can't paste a folder into itself" }
        return clip.items.contains { $0.node.parentId != folder } ? nil : "Already in this folder"
    }

    /* Files picked from the document or photo picker, each uploaded in turn with its thumbnail. `renames` names the kept-both ones. */
    func upload(_ files: [(url: URL, name: String, type: UTType?)], to folder: String, onConflict: Conflict = .keepBoth, renames: [String: String] = [:]) async {
        let existing = (folders[folder] ?? []).filter { !$0.isFolder }
        holdBackground(); activity.start(kind: "upload", title: files.count > 1 ? "Uploading \(files.count) files" : "Uploading \(files.first?.name ?? "")")
        defer { releaseBackground(); activity.finish(title: files.count > 1 ? "\(files.count) files uploaded" : "\(files.first?.name ?? "File") uploaded") }
        for (index, file) in files.enumerated() {
            let mime = file.type?.preferredMIMEType
            let clash = existing.first { $0.name.caseInsensitiveCompare(file.name) == .orderedSame }
            var name = file.name
            var replacing: Opened?
            if let clash {
                switch onConflict {
                case .skip: try? FileManager.default.removeItem(at: file.url); continue
                case .replace: replacing = clash
                case .keepBoth: name = renames[file.name] ?? Self.freeName(file.name, among: existing.map(\.name))
                }
            }
            _ = index
            let ticket = begin(.upload, name)
            let ok = await perform(in: folder) {
                _ = try await vault.upload(
                    fileURL: file.url, name: name, mime: mime, in: folder, replacing: replacing,
                    thumbnail: Thumbnails.make(for: file.url, mime: mime)
                ) { fraction in Task { @MainActor in self.progress(ticket, fraction) } }
            }
            finish(ticket, failed: !ok)
            try? FileManager.default.removeItem(at: file.url)
            if !ok { break }
        }
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
            if case DriveAPIError.notAuthenticated = error { self.error = "Your session ended. Sign in again."; break error_ }
            // No network: say so at the top rather than interrupting; kept files still open.
            if case DriveAPIError.transport = error { offline = true; break error_ }
            self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }
}
