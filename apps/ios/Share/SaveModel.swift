import Foundation
import HushOSKit
import Observation
import UniformTypeIdentifiers

/*
 * Save to HushOS: what another app shared, copied into the app group as it arrives
 * (files are copied on disk, never held in memory, so a long video stays inside the
 * extension's memory limit), then sealed into the queue's folder and handed to a
 * background session on Save, as the app's own uploads are (ShareHandoff). Words and
 * behaviour follow Android's SaveToHushOS.
 */
@MainActor
@Observable
final class SaveModel {
    enum Phase: Equatable { case opening, signedOut, ready, saving, done }

    struct Item: Identifiable {
        let id = UUID()
        var name: String
        var size: Int64?
        var mime: String?
        /* The copy in the app group; nil until it is read, or when it couldn't be. */
        var copy: URL?
        var unreadable = false
    }

    var phase: Phase = .opening
    var items: [Item] = []
    /* "Saves the link as a file." for a page or a link; "Saves the text as a file." for text. */
    var note: String?
    var root: Places.Folder?
    var folder: Places.Folder?
    var problem: String?
    /* Called once the uploads are handed over, to close the sheet. */
    @ObservationIgnored var saved: (() -> Void)?

    private var vault: Vault?
    private let staging: URL

    init() {
        staging = ShareHandoff.transfers.deletingLastPathComponent()
            .appendingPathComponent("share-staging", isDirectory: true).appendingPathComponent(UUID().uuidString, isDirectory: true)
    }

    // MARK: - Opening

    func open(_ extensionItems: [NSExtensionItem]) async {
        guard let vault = Vault.fromKeychain() else { phase = .signedOut; return }
        self.vault = vault
        try? FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
        phase = .ready
        async let place: Void = findFolder(vault)
        await read(extensionItems)
        await place
    }

    /* The folder last added to, if it is still there and not in the Trash; else Files. */
    private func findFolder(_ vault: Vault) async {
        guard let rootId = try? await vault.rootId() else { problem = "Couldn’t reach HushOS. Check your connection, then try again."; return }
        let top = Places.Folder(id: rootId, name: "Files")
        root = top
        if let last = Places.last(), last.id != rootId, let found = try? await vault.resolve(last.id), found.isFolder, found.node.trashedAt == nil {
            folder = Places.Folder(id: found.id, name: found.name)
        } else {
            folder = top
        }
    }

    func folders(in id: String) async throws -> [Opened] {
        guard let vault else { return [] }
        return try await vault.children(of: id).filter { $0.isFolder && $0.node.trashedAt == nil }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    // MARK: - Reading what was shared

    private func read(_ extensionItems: [NSExtensionItem]) async {
        var files: [(NSItemProvider, UTType)] = []
        var link: (url: URL, title: String?)?
        var text: String?
        for item in extensionItems {
            let title = item.attributedContentText?.string ?? item.attributedTitle?.string
            for provider in item.attachments ?? [] {
                // A browser's page through the preprocessing script: its title and address.
                if provider.hasItemConformingToTypeIdentifier(UTType.propertyList.identifier),
                   let page = await Self.pageResults(provider), let url = page.url {
                    link = (url, page.title ?? title)
                } else if let type = Self.fileType(of: provider) {
                    files.append((provider, type))
                } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier), let url = await Self.url(provider) {
                    if link == nil { link = (url, title) }
                } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier), let shared = await Self.text(provider) {
                    text = shared
                }
            }
        }
        // A page's PDF or web archive (Safari's Options) is the file; its address is not saved twice.
        if !files.isEmpty {
            items = files.map { provider, type in Item(name: Self.name(provider.suggestedName, type: type), mime: type.preferredMIMEType) }
            await withTaskGroup(of: (Int, URL?, Int64?, String?).self) { group in
                for (index, entry) in files.enumerated() {
                    let target = staging.appendingPathComponent(UUID().uuidString)
                    group.addTask { await Self.copy(entry.0, type: entry.1, to: target).map { (index, $0.url, $0.size, $0.name) } ?? (index, nil, nil, nil) }
                }
                for await (index, url, size, name) in group {
                    items[index].copy = url
                    items[index].size = size
                    items[index].unreadable = url == nil
                    // A file shared from Files keeps its own name; a photo's suggested name gets its type's extension.
                    if let name, items[index].name.hasPrefix("Shared file") { items[index].name = name }
                }
            }
            return
        }
        let saved: SharedText.Saved?
        if let link {
            saved = SharedText.of(text: link.url.absoluteString, subject: link.title)
        } else {
            saved = SharedText.of(text: text, subject: nil)
        }
        guard let saved else { return }
        let target = staging.appendingPathComponent(UUID().uuidString)
        let written = (try? Data(saved.body.utf8).write(to: target)) != nil
        items = [Item(name: saved.name, size: Int64(saved.body.utf8.count), mime: "text/plain", copy: written ? target : nil, unreadable: !written)]
        note = saved.link ? "Saves the link as a file." : "Saves the text as a file."
    }

    /*
     * The richest file-like type a provider offers: not an address or the script's results.
     * Text counts as a file only when it comes with a file name (a .txt or .md from Files);
     * a few lines shared from a note are saved as text instead.
     */
    private static func fileType(of provider: NSItemProvider) -> UTType? {
        let named = !((provider.suggestedName ?? "") as NSString).pathExtension.isEmpty
        for identifier in provider.registeredTypeIdentifiers {
            guard let type = UTType(identifier) else { continue }
            if type.conforms(to: .url) || type.conforms(to: .propertyList) { continue }
            if type.conforms(to: .plainText), !named { continue }
            if type.conforms(to: .data) || type.conforms(to: .package) || type.conforms(to: .content) { return type }
        }
        return nil
    }

    /* A name with the type's extension, as the drive shows it. */
    static func name(_ suggested: String?, type: UTType) -> String {
        let base = suggested?.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "/", with: " ") ?? ""
        let stem = base.isEmpty ? "Shared file" : base
        guard (stem as NSString).pathExtension.isEmpty, let ext = type.preferredFilenameExtension else { return stem }
        return stem + "." + ext
    }

    /* Copies the provider's file into the staging folder, on disk; nil when it couldn't be read. */
    nonisolated private static func copy(_ provider: NSItemProvider, type: UTType, to target: URL) async -> (url: URL, size: Int64, name: String?)? {
        await withCheckedContinuation { continuation in
            _ = provider.loadFileRepresentation(for: type, openInPlace: false) { url, _, _ in
                guard let url, (try? FileManager.default.copyItem(at: url, to: target)) != nil else { return continuation.resume(returning: nil) }
                let size = (try? FileManager.default.attributesOfItem(atPath: target.path)[.size] as? Int64) ?? nil
                // The temporary file's name is the file's own when it came from Files.
                let own = url.lastPathComponent
                continuation.resume(returning: (target, size ?? 0, own.isEmpty ? nil : own))
            }
        }
    }

    nonisolated private static func pageResults(_ provider: NSItemProvider) async -> (url: URL?, title: String?)? {
        await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: UTType.propertyList.identifier) { item, _ in
                guard let dictionary = item as? NSDictionary,
                      let results = dictionary[NSExtensionJavaScriptPreprocessingResultsKey] as? [String: Any] else { return continuation.resume(returning: nil) }
                let title = (results["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
                continuation.resume(returning: ((results["url"] as? String).flatMap(URL.init(string:)), title?.isEmpty == false ? title : nil))
            }
        }
    }

    nonisolated private static func url(_ provider: NSItemProvider) async -> URL? {
        await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: UTType.url.identifier) { item, _ in
                continuation.resume(returning: item as? URL ?? (item as? String).flatMap(URL.init(string:)))
            }
        }
    }

    nonisolated private static func text(_ provider: NSItemProvider) async -> String? {
        await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) { item, _ in
                continuation.resume(returning: item as? String ?? (item as? Data).map { String(decoding: $0, as: UTF8.self) })
            }
        }
    }

    // MARK: - Saving

    /*
     * Seals each file into the queue's folder and hands its parts to the background session,
     * holding the note; waits a few seconds, finishing here what landed in that time (a photo
     * usually does; the app might never be woken for it otherwise); then releases the rest to
     * the app, which shows them in the transfers list and finishes them.
     */
    func save() async {
        guard let vault, let target = folder else { return }
        phase = .saving
        problem = nil
        var taken = Set(((try? await vault.children(of: target.id)) ?? []).filter { !$0.isFolder }.map { $0.name.lowercased() })
        var notes: [ShareHandoff] = []
        let uploads = ShareUploads.shared
        for item in items {
            guard let copy = item.copy else { continue }
            let name = Self.freeName(item.name, taken: taken)
            taken.insert(name.lowercased())
            let id = UUID()
            let directory = ShareHandoff.directory(id)
            do {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                let content = directory.appendingPathComponent("content")
                try FileManager.default.moveItem(at: copy, to: content)
                let sealed = try await vault.sealUpload(
                    fileURL: content, name: name, mime: item.mime, in: target.id, replacing: nil,
                    thumbnail: Thumbnails.make(for: content, mime: item.mime), into: directory
                )
                try? FileManager.default.removeItem(at: content)
                let note = ShareHandoff(id: id, name: name, folderId: target.id, mime: item.mime, size: item.size, sealed: sealed)
                try note.write()
                uploads.start(note)
                notes.append(note)
            } catch {
                try? FileManager.default.removeItem(at: directory)
                problem = (error as? LocalizedError)?.errorDescription ?? "Couldn’t save it. Try again."
            }
        }
        if notes.isEmpty, problem != nil { phase = .ready; return }
        Places.used(target.id, name: target.name)
        // Small files land in a moment: finish them here, then let the app have the rest.
        let deadline = Date().addingTimeInterval(6)
        var open = notes
        while !open.isEmpty, Date() < deadline {
            try? await Task.sleep(for: .milliseconds(300))
            for note in open where uploads.landed(note.id).count == note.sealed.partCount {
                if (try? await vault.finishUpload(note.sealed, etags: uploads.landed(note.id))) != nil {
                    try? FileManager.default.removeItem(at: ShareHandoff.directory(note.id))
                    open.removeAll { $0.id == note.id }
                }
            }
        }
        for var note in open {
            note.released = true
            try? note.write()
        }
        phase = .done
        saved?()
    }

    /* A name the folder already has gets " (2)", as an upload in the app does. */
    static func freeName(_ name: String, taken: Set<String>) -> String {
        guard taken.contains(name.lowercased()) else { return name }
        let ext = (name as NSString).pathExtension
        let stem = ext.isEmpty ? name : (name as NSString).deletingPathExtension
        for n in 2 ... 999 {
            let candidate = ext.isEmpty ? "\(stem) (\(n))" : "\(stem) (\(n)).\(ext)"
            if !taken.contains(candidate.lowercased()) { return candidate }
        }
        return name
    }

    /* Closed or saved: the staged copies go (saved ones were moved into the queue already). */
    func close() {
        try? FileManager.default.removeItem(at: staging)
    }
}
