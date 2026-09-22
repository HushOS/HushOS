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
    var transfer: Transfer? {
        didSet {
            guard let transfer else { return }
            activity.update(title: transfer.title, fraction: transfer.fraction)
        }
    }
    private let activity = TransferActivity()
    private var thumbnailTasks: Set<String> = []

    struct Transfer: Equatable {
        var title: String
        var fraction: Double
    }

    init(vault: Vault) {
        self.vault = vault
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
    }

    /* Pulls what changed since the cursor and redraws the lists it touched. */
    func sync() async {
        guard let touched = try? await vault.sync(), !touched.isEmpty else { return }
        for id in folders.keys where touched.contains(id) || folders[id]?.contains(where: { touched.contains($0.id) }) == true {
            if let children = try? await vault.children(of: id) { folders[id] = children }
        }
        recents = (try? await vault.recents()) ?? recents
        catalogueVersion += 1
    }

    func refresh(folder id: String) async {
        loading.insert(id)
        defer { loading.remove(id) }
        do {
            await sync()
            let children = try await vault.children(of: id)
            folders[id] = children
            offline = false
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
        defer { busy = false; transfer = nil }
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
                transfer = Transfer(title: items.count > 1 ? "Copying \(index + 1) of \(items.count)" : "Copying \(item.name)", fraction: 0)
                if targetWorkspace == item.node.workspaceId {
                    _ = await perform(in: folder) { _ = try await vault.copy(item.id, to: folder) }
                } else {
                    // Across drives (into a shared folder) the object is fetched and uploaded again; a cut then trashes the original.
                    let ok = await perform(in: folder) { _ = try await vault.copyAcross(item.id, to: folder) { fraction in Task { @MainActor in self.transfer?.fraction = fraction } } }
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
            transfer = Transfer(title: "Keeping \(item.name)", fraction: 0)
            defer { transfer = nil }
            _ = await perform(in: nil) { try await vault.keepDownloaded(item) { fraction in Task { @MainActor in self.transfer?.fraction = fraction } } }
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
        transfer = Transfer(title: "Rotating keys for \(item.name)", fraction: 0)
        holdBackground(); activity.start(kind: "rotate", title: "Rotating keys for \(item.name)")
        defer {
            transfer = nil
            releaseBackground(); activity.finish(title: "Keys rotated")
        }
        _ = try await vault.rotate(item) { count in Task { @MainActor in self.transfer = Transfer(title: "Rotating keys · \(count) sealed", fraction: 0) } }
        folders.removeAll()
        if let parent = item.node.parentId { await refresh(folder: parent) }
    }

    func trash(_ items: [Opened]) async {
        for item in items { await trash(item) }
    }

    func move(_ items: [Opened], to folder: String) async {
        for item in items { await move(item, to: folder) }
    }

    func trash(_ item: Opened) async {
        _ = await perform(in: item.node.parentId) { try await vault.trash(item.id) }
        recents.removeAll { $0.id == item.id }
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
            transfer = Transfer(title: files.count > 1 ? "Uploading \(index + 1) of \(files.count)" : "Uploading \(name)", fraction: 0)
            let ok = await perform(in: folder) {
                _ = try await vault.upload(
                    fileURL: file.url, name: name, mime: mime, in: folder, replacing: replacing,
                    thumbnail: Thumbnails.make(for: file.url, mime: mime)
                ) { fraction in Task { @MainActor in self.transfer?.fraction = fraction } }
            }
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
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("opened/\(item.id)/\(version?.id ?? "current")", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appendingPathComponent(item.name)
        if FileManager.default.fileExists(atPath: file.path) { return file }
        transfer = Transfer(title: "Downloading \(item.name)", fraction: 0)
        holdBackground(); activity.start(kind: "download", title: "Downloading \(item.name)")
        defer {
            transfer = nil
            releaseBackground(); activity.finish(title: "\(item.name) downloaded")
        }
        do {
            try await vault.download(item.id, version: version, to: file) { fraction in Task { @MainActor in self.transfer?.fraction = fraction } }
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
