import HushOSCore
import HushOSKit
import ImageIO
import PDFKit
import SwiftUI
import UniformTypeIdentifiers

/*
 * A zip in the viewer (docs/file-tools-design.md, section 1 (a)): the list of what is inside it, a
 * breadcrumb over its folders, each file with its size and date, opening in place from memory.
 * Only the archive's directory and the entries asked for are read (HushOSKit's OpenArchive, the
 * core's ZipArchiveSession). An entry is never written to a file to be shown: QuickLook only reads
 * files, so entries open in HushOS's own views (images, PDFs through PDFKit, Markdown, text);
 * anything else says it has no preview and offers Download, which writes it only where the person
 * picks, streamed. Words are the web's (ArchiveWords).
 */
struct ArchiveScreen: View {
    @Environment(DriveStore.self) private var store
    /* The zip in Drive, or (`kept`) the copy of one this phone keeps with only its offline record. */
    let item: Opened?
    let kept: URL?
    let name: String
    /*
     * Hears of the row the archive opened when it is newer than `item` (a family's file another
     * member replaced): the viewer adopts it, as `DriveStore.fetch(adopted:)` has it do, so its
     * header and Send a copy judge the version shown, not the one tapped.
     */
    var adopted: ((Opened) -> Void)?
    @State private var archive: OpenArchive?
    /* The key adopting a row makes: the task it starts finds that row open already. */
    @State private var adoptedKey: String?
    @State private var tree: ArchiveTree?
    @State private var failure: String?
    @State private var attempt = 0
    /* The folders from the top to the one shown, by their numbers in the tree. */
    @State private var path: [UInt32] = []
    @State private var opened: ArchiveEntry?
    @State private var unlocked = false
    /* The password held, which only its quick check had passed, was let go of: the cards say it may be wrong. */
    @State private var doubted = false
    /* The entry waiting for a folder to be picked, and whether the picker shows: apart, because
     * SwiftUI clears the picker's flag before its completion runs, which once lost the entry. */
    @State private var saving: ArchiveEntry?
    @State private var picking = false
    @State private var asking: ArchiveEntry?
    /* An entry whose Download waits on its password: asked for in its pane, then the download goes on. */
    @State private var passwordFor: UInt32?
    /* Every download running or failed, a row each: a second never hides the first. */
    @State private var downloads: [ArchiveDownload] = []

    init(item: Opened, adopted: ((Opened) -> Void)? = nil) {
        self.item = item
        kept = nil
        name = item.name
        self.adopted = adopted
    }

    init(kept url: URL, name: String) {
        item = nil
        kept = url
        self.name = name
    }

    private var title: String { archive?.row?.name ?? name }
    private var key: String {
        if let item { return key(of: item) }
        return "kept-\(kept?.path ?? "")-\(attempt)"
    }

    private func key(of row: Opened) -> String {
        "\(row.id)-\(row.node.currentVersion?.id ?? "")-\(attempt)-\(ObjectIdentifier(store.vault).hashValue)"
    }

    var body: some View {
        VStack(spacing: 0) {
            if let failure {
                EmptyStateView(title: ArchiveWords.broken, message: failure) {
                    Button("Try again") { self.failure = nil; attempt += 1 }.buttonStyle(PrimaryCapsuleStyle())
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let archive, let tree {
                // At the top the header names the archive: the trail shows only inside it.
                if !path.isEmpty || opened != nil {
                    crumbs
                    Divider().overlay(Alpine.rule)
                }
                if let opened {
                    ArchiveEntryPane(entry: opened, archive: archive, unlocked: $unlocked, doubted: $doubted, askPassword: passwordFor == opened.index,
                                     onDownload: { start(opened) })
                        .id(opened.index)
                } else {
                    list(tree.rows(in: path.last ?? 0), hidden: archive.hidden)
                }
                ForEach(downloads) { downloadBar($0) }
            } else {
                VStack(spacing: Alpine.Space.s3) {
                    if let item { FileMark(item: item, box: 72) } else {
                        PageGlyph(label: "ZIP", name: name).frame(width: 48, height: 48 * 54 / 44)
                    }
                    Text(name).font(Theme.Text.headline).foregroundStyle(Alpine.ink).multilineTextAlignment(.center)
                    ProgressView().tint(Alpine.primary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Alpine.ground.ignoresSafeArea())
        .task(id: key) {
            // The row this archive opened, adopted by the viewer: open already, nothing to do again.
            if key == adoptedKey, archive != nil {
                adoptedKey = nil
                return
            }
            adoptedKey = nil
            archive?.close()
            archive = nil
            tree = nil
            path = []
            opened = nil
            unlocked = false
            passwordFor = nil
            let open: OpenArchive
            do {
                if let item { open = try await OpenArchive.open(item, vault: store.vault) } else if let kept {
                    open = try await OpenArchive.openKept(kept)
                } else { return }
            } catch {
                if !Task.isCancelled { failure = failureWords(error, store: store) }
                return
            }
            // The tree off the main thread (a 50,000-entry list takes a moment), and the archive closed if the viewer is left
            // meanwhile: until it is shown, nothing else would close it.
            let entries = open.entries
            let folders = open.takeFolders()
            let built = await Task.detached(priority: .userInitiated) { ArchiveTree(entries, folders: folders) }.value
            guard !Task.isCancelled else { open.close(); return }
            tree = built
            archive = open
            if let item, let row = open.row, row.node != item.node {
                adoptedKey = key(of: row)
                adopted?(row)
            }
        }
        // Its family let go of (a removal, a fork): the core closed the archive already, and what it showed goes too.
        .onReceive(NotificationCenter.default.publisher(for: ArchiveSessions.familyClosed)) { note in
            guard let archive, note.userInfo?["archive"] as? UUID == archive.identity else { return }
            for download in downloads { download.task?.cancel() }
            self.archive = nil
            tree = nil
            opened = nil
            path = []
            failure = FamilyWords.openAgain
        }
        // Leaving the viewer stops its downloads and closes the archive (its calls cancelled, the password wiped).
        .onDisappear {
            for download in downloads { download.task?.cancel() }
            archive?.close()
        }
        .fileImporter(isPresented: $picking, allowedContentTypes: [.folder]) { result in
            let entry = saving
            saving = nil
            if let entry, case .success(let folder) = result { save(entry, into: folder) }
        }
        .alert(asking.map { ArchiveWords.asksFirst(size: formatBytes(Int64($0.size)), packed: formatBytes(Int64($0.packed))) } ?? "",
               isPresented: Binding(get: { asking != nil }, set: { if !$0 { asking = nil } })) {
            Button(ArchiveWords.cancel, role: .cancel) { asking = nil }
            Button(ArchiveWords.download) {
                saving = asking
                asking = nil
                picking = true
            }
        }
    }

    /* Archive name › folders › the entry open, each but the last a way back. */
    private var crumbs: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Alpine.Space.s1) {
                crumb(title, current: path.isEmpty && opened == nil) { go([]) }
                ForEach(Array(path.enumerated()), id: \.offset) { index, folder in
                    Image(systemName: "chevron.right").font(.caption).foregroundStyle(Alpine.inkMuted).accessibilityHidden(true)
                    crumb(tree?.name(of: folder) ?? "", current: index == path.count - 1 && opened == nil) { go(Array(path.prefix(index + 1))) }
                }
                if let opened {
                    Image(systemName: "chevron.right").font(.caption).foregroundStyle(Alpine.inkMuted).accessibilityHidden(true)
                    crumb(opened.name, current: true) {}
                }
            }
            .padding(.horizontal, Alpine.Space.s4)
        }
        .frame(minHeight: 44)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(ArchiveWords.folders)
    }

    private func crumb(_ label: String, current: Bool, go: @escaping () -> Void) -> some View {
        Button(action: go) {
            Text(label).font(Theme.Text.callout.weight(current ? .semibold : .regular))
                .foregroundStyle(current ? Alpine.ink : Alpine.inkMuted).lineLimit(1)
                .frame(minHeight: 44)
        }
        .buttonStyle(.plain)
        .disabled(current)
        .accessibilityAddTraits(current ? .isSelected : [])
    }

    private func go(_ to: [UInt32]) {
        opened = nil
        path = to
    }

    private func list(_ rows: [ArchiveRow], hidden: Int) -> some View {
        List {
            if rows.isEmpty {
                Text(ArchiveWords.empty).font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted)
                    .frame(maxWidth: .infinity).listRowBackground(Color.clear).listRowSeparator(.hidden)
            }
            ForEach(rows, id: \.key) { row in
                ArchiveRowView(row: row, unlocked: unlocked)
                    .contentShape(Rectangle())
                    .onTapGesture { open(row) }
                    .accessibilityAddTraits(.isButton)
                    // As a drive row: long-press for the menu, swipe from the leading edge for a copy out.
                    .contextMenu {
                        if case .file(let entry) = row, entry.support == "ok", !entry.link {
                            Button(ArchiveWords.download, systemImage: "arrow.down.circle") { start(entry) }
                        }
                    }
                    .swipeActions(edge: .leading) {
                        if case .file(let entry) = row, entry.support == "ok", !entry.link {
                            Button(ArchiveWords.download, systemImage: "arrow.down.circle") { start(entry) }.tint(Alpine.primary)
                        }
                    }
                    .listRowBackground(Alpine.ground)
            }
            if hidden > 0 {
                Text(ArchiveWords.hidden(hidden)).font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted)
                    .frame(maxWidth: .infinity).listRowBackground(Color.clear).listRowSeparator(.hidden)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
    }

    private func open(_ row: ArchiveRow) {
        switch row {
        case .folder(let id, _, _): path.append(id)
        // Opened to look at it: a download waiting on another entry's password is let go of.
        case .file(let entry): if !entry.link { opened = entry; passwordFor = nil }
        }
    }

    /* Download: a locked entry asks for its password first; a large one past 200:1 asks first; then a place to save it. */
    private func start(_ entry: ArchiveEntry) {
        // Locked: its pane asks for the password, and the download goes on once it opens.
        if entry.lock != "none" && !unlocked {
            opened = entry
            passwordFor = entry.index
            return
        }
        passwordFor = nil
        if zipEntryAsksFirst(size: entry.size, packed: entry.packed) {
            asking = entry
            return
        }
        saving = entry
        picking = true
    }

    /*
     * The entry streamed into the folder the person picked, a MiB at a time, under its own name
     * (the next free one if taken). Nothing is written anywhere else; a failed or stopped download
     * deletes what it wrote.
     */
    private func save(_ entry: ArchiveEntry, into folder: URL) {
        guard let archive else { return }
        let progress = ArchiveDownload(entry: entry)
        downloads.append(progress)
        progress.task = Task {
            let scoped = folder.startAccessingSecurityScopedResource()
            defer { if scoped { folder.stopAccessingSecurityScopedResource() } }
            var target: URL?
            do {
                // The name the core made safe: no bidi override, no NUL, no separator, at most 255 bytes.
                let file = ArchiveFiles.freeURL(in: folder, name: entry.saveName)
                target = file
                guard FileManager.default.createFile(atPath: file.path, contents: nil) else { throw CocoaError(.fileWriteNoPermission) }
                let handle = try FileHandle(forWritingTo: file)
                defer { try? handle.close() }
                try await archive.download(entry, into: ArchiveSink { chunk in
                    try handle.write(contentsOf: chunk)
                    Task { @MainActor in progress.written += UInt64(chunk.count) }
                })
                await MainActor.run { downloads.removeAll { $0 === progress } }
            } catch {
                if let target { try? FileManager.default.removeItem(at: target) }
                await MainActor.run {
                    if Task.isCancelled { downloads.removeAll { $0 === progress } } else if (error as? ArchiveFailure)?.code == "wrong-password" {
                        // The entry has a password of its own: asked for in its pane, tried on it first, then it downloads.
                        downloads.removeAll { $0 === progress }
                        opened = entry
                        passwordFor = entry.index
                    } else if let code = (error as? ArchiveFailure)?.code, code == "password-unproven" || code == "password" {
                        // No password held for it any more (the held one, maybe wrong, let go of): asked for again.
                        downloads.removeAll { $0 === progress }
                        unlocked = false
                        doubted = code == "password-unproven"
                        opened = entry
                        passwordFor = entry.index
                    } else {
                        progress.error = failureWords(error, store: store)
                    }
                }
            }
        }
    }

    private func downloadBar(_ download: ArchiveDownload) -> some View {
        HStack(spacing: Alpine.Space.s3) {
            Text(download.error ?? ArchiveWords.downloading(download.entry.name))
                .font(Theme.Text.footnote).foregroundStyle(download.error == nil ? Alpine.ink : Alpine.danger).lineLimit(2)
            Spacer(minLength: 0)
            if download.error == nil, download.entry.size > 0 {
                Text("\(Int(Double(download.written) / Double(download.entry.size) * 100))%")
                    .font(Theme.Text.footnote.monospacedDigit()).foregroundStyle(Alpine.inkMuted)
            }
            Button {
                download.task?.cancel()
                downloads.removeAll { $0 === download }
            } label: {
                Image(systemName: "xmark").frame(width: 44, height: 44)
            }
            .buttonStyle(.plain).foregroundStyle(Alpine.inkMuted)
            .accessibilityLabel(download.error == nil ? ArchiveWords.stop : "Dismiss")
        }
        .padding(.leading, Alpine.Space.s4)
        .background(Alpine.surface)
    }
}

/*
 * What a failed archive call says. A 401 under the store's reads goes to the store first, which
 * ends the session only if it is the one in use (a late one from a session gone is stale), as
 * DriveStore.fetch does.
 */
@MainActor private func failureWords(_ error: Error, store: DriveStore) -> String {
    if endsSession(error) { store.report(error) }
    return (error as? ArchiveFailure)?.message ?? (ErrorWords.say(error) ?? ErrorWords.generic)
}

/* An entry downloading into a folder the person picked. */
@Observable @MainActor
final class ArchiveDownload: Identifiable {
    let entry: ArchiveEntry
    var written: UInt64 = 0
    var error: String?
    var task: Task<Void, Never>?
    init(entry: ArchiveEntry) { self.entry = entry }
}

enum ArchiveFiles {
    /* `name` in `folder`, or "name (2).ext" and on when taken, each within a file name's 255 bytes. */
    static func freeURL(in folder: URL, name: String) -> URL {
        var candidate = folder.appendingPathComponent(name)
        var n = 2
        while FileManager.default.fileExists(atPath: candidate.path) {
            candidate = folder.appendingPathComponent(ArchiveSaveName.numbered(name, n))
            n += 1
        }
        return candidate
    }
}

extension ArchiveRow {
    var key: String {
        switch self {
        case .folder(let id, _, _): "d:\(id)"
        case .file(let entry): "f:\(entry.index)"
        }
    }
}

/* A row as the drive's rows are: 56pt, a 36pt mark, the name, and its size and date or why it doesn't open. */
private struct ArchiveRowView: View {
    let row: ArchiveRow
    let unlocked: Bool

    var body: some View {
        HStack(spacing: Alpine.Space.s3) {
            mark.frame(width: Theme.mark, height: Theme.mark)
            VStack(alignment: .leading, spacing: 2) {
                Text(row.name).font(Theme.Text.body).foregroundStyle(Alpine.ink).lineLimit(1)
                HStack(spacing: 4) {
                    if case .file(let entry) = row, entry.lock != "none", !unlocked {
                        Image(systemName: "lock.fill").imageScale(.small)
                    }
                    Text(subtitle).lineLimit(1)
                }
                .font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted)
            }
            Spacer(minLength: 0)
            if case .folder = row {
                Image(systemName: "chevron.right").font(.footnote).foregroundStyle(Alpine.inkMuted).accessibilityHidden(true)
            }
        }
        .frame(minHeight: Theme.row)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private var mark: some View {
        switch row {
        case .folder: FolderGlyph().frame(width: Theme.mark * 0.9, height: Theme.mark * 0.9 * 46 / 56)
        case .file(let entry):
            let ext = (entry.name as NSString).pathExtension.uppercased()
            PageGlyph(label: (1 ... 4).contains(ext.count) ? ext : nil, name: entry.name)
                .frame(width: Theme.mark * 0.66, height: Theme.mark * 0.66 * 54 / 44)
        }
    }

    private var subtitle: String {
        switch row {
        case .folder(_, _, let count): return ArchiveWords.items(count)
        case .file(let entry):
            if entry.link { return ArchiveWords.link }
            if entry.lock != "none" && !unlocked { return ArchiveWords.needsPassword }
            return [formatBytes(Int64(entry.size)), changedLabel(ArchiveEntries.date(entry))].compactMap { $0 }.joined(separator: " · ")
        }
    }
}

/* One entry open: its size and date with Download, then its password, its refusal, the large-file card, or the entry itself. */
private struct ArchiveEntryPane: View {
    @Environment(DriveStore.self) private var store
    let entry: ArchiveEntry
    let archive: OpenArchive
    @Binding var unlocked: Bool
    /* The password held was let go of, maybe wrong: the card says so. */
    @Binding var doubted: Bool
    /* A Download is waiting on this entry's password (one held didn't open it, or none is held yet). */
    let askPassword: Bool
    let onDownload: () -> Void
    @State private var bytes: Data?
    @State private var failure: String?
    @State private var continued = false
    /* The entry has a password of its own (the one held didn't open it): asked for again, for this entry. */
    @State private var reprompt = false
    /* Download pressed on an entry that only downloads (an archive inside the archive) and is locked. */
    @State private var passwordToDownload = false
    @State private var attempt = 0

    private var name: String { entry.name }
    private var kind: ArchiveEntries.Kind { ArchiveEntries.kind(of: name) }
    private var limits: PreviewLimits { ArchiveEntries.limits(kind) }
    private var locked: Bool { entry.lock != "none" && !unlocked }
    private var note: String? { doubted ? ArchiveWords.passwordUnproven : nil }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: Alpine.Space.s3) {
                Text([formatBytes(Int64(entry.size)), changedLabel(ArchiveEntries.date(entry))].compactMap { $0 }.joined(separator: " · "))
                    .font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted)
                Spacer(minLength: 0)
                if entry.support == "ok", !locked {
                    Button(ArchiveWords.download, systemImage: "arrow.down.circle", action: onDownload)
                        .buttonStyle(SecondaryCapsuleStyle())
                }
            }
            .padding(.horizontal, Alpine.Space.s4).frame(minHeight: 52)
            Divider().overlay(Alpine.rule)
            content.frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    @ViewBuilder private var content: some View {
        let stage = ArchiveEntries.stage(size: entry.size, limits: limits)
        // What can't be read at all says so first: a password would change nothing.
        if entry.support != "ok" {
            card(title: name, message: entry.support == "method" ? ArchiveWords.method : ArchiveWords.encryption)
        } else if askPassword || passwordToDownload {
            // A download waits on the password: asked for, tried on this entry first, then the download goes on.
            ArchivePasswordCard(name: name, archive: archive, entry: entry, note: note) {
                unlocked = true
                doubted = false
                passwordToDownload = false
                onDownload()
            }
        } else if entry.nested {
            // Never opened in place; Download still works, asking for the password first when it is locked.
            card(title: name, message: ArchiveWords.nested, download: true) {
                if locked { passwordToDownload = true } else { onDownload() }
            }
        } else if locked || reprompt {
            ArchivePasswordCard(name: name, archive: archive, entry: entry, note: note) {
                unlocked = true
                doubted = false
                reprompt = false
                failure = nil
                bytes = nil
                attempt += 1
            }
        } else if kind == .none {
            card(title: ArchiveWords.noPreview, message: "\(name) · \(formatBytes(Int64(entry.size)))", download: true)
        } else if stage == .ceiling {
            card(title: ArchiveWords.tooLarge(formatBytes(Int64(entry.size))), message: ArchiveWords.elsewhere, download: true)
        } else if stage == .offer && !continued {
            VStack(spacing: Alpine.Space.s3) {
                Text(ArchiveWords.large(formatBytes(Int64(entry.size)))).font(.title3.weight(.bold)).foregroundStyle(Alpine.ink)
                Text(ArchiveWords.largeRisk).font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted).multilineTextAlignment(.center)
                HStack(spacing: Alpine.Space.s2) {
                    Button(ArchiveWords.openAnyway) { continued = true }.buttonStyle(SecondaryCapsuleStyle())
                    Button(ArchiveWords.download, action: onDownload).buttonStyle(PrimaryCapsuleStyle())
                }
            }
            .padding(Alpine.Space.s6).frame(maxWidth: 360)
        } else if let failure {
            card(title: ArchiveWords.broken, message: failure, download: true)
        } else if let bytes {
            ArchiveEntryView(kind: kind, name: name, bytes: bytes)
        } else {
            ProgressView().tint(Alpine.primary)
                .task(id: attempt) {
                    do { bytes = try await archive.preview(entry, limit: limits.ceiling) } catch {
                        guard !Task.isCancelled else { return }
                        let code = (error as? ArchiveFailure)?.code
                        if code == "wrong-password" { reprompt = true } else if code == "password-unproven" || code == "password" {
                            // No password held any more (the held one, maybe wrong, let go of): this entry asks again.
                            unlocked = false
                            doubted = code == "password-unproven"
                        } else {
                            failure = failureWords(error, store: store)
                        }
                    }
                }
        }
    }

    private func card(title: String, message: String, download: Bool = false, action: (() -> Void)? = nil) -> some View {
        EmptyStateView(title: title, message: message) {
            if download { Button(ArchiveWords.download, action: action ?? onDownload).buttonStyle(PrimaryCapsuleStyle()) }
        }
        .padding(Alpine.Space.s6)
    }
}

/*
 * The entry from memory: a picture, a PDF through PDFKit, Markdown drawn, or text. A picture is
 * decoded and text cut into pieces in a task, off the view's body: a body runs on every redraw,
 * and decoding a 100 MB image there held the main thread each time.
 */
private struct ArchiveEntryView: View {
    let kind: ArchiveEntries.Kind
    let name: String
    let bytes: Data
    @State private var image: UIImage?
    @State private var pieces: [String]?
    @State private var broken = false

    var body: some View {
        switch kind {
        case .image:
            Group {
                if let image {
                    // Fitted to the space, as QuickLook shows a picture; a picture smaller than the screen is enlarged, never smoothed.
                    Image(uiImage: image).resizable().interpolation(image.size.width < 64 ? .none : .high).scaledToFit()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .padding(Alpine.Space.s4)
                        .accessibilityLabel(name)
                } else if broken {
                    EmptyStateView(title: ArchiveWords.broken, message: nil) { EmptyView() }
                } else {
                    ProgressView().tint(Alpine.primary)
                }
            }
            .task(id: bytes.count) {
                let data = bytes
                let decoded = await Task.detached(priority: .userInitiated) { ArchiveImages.decode(data) }.value
                if let decoded { image = decoded } else { broken = true }
            }
        case .pdf:
            InMemoryPDF(data: bytes)
        case .markdown where bytes.count <= MarkdownDocument.limit:
            MarkdownView(data: bytes)
        default:
            Group {
                if let pieces {
                    // In pieces of at most 200 lines and 16 KB each, laid out as they scroll in: never one view of 8 MB of text.
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(Array(pieces.enumerated()), id: \.offset) { _, piece in
                                Text(piece)
                                    .font(.system(.footnote, design: .monospaced)).foregroundStyle(Alpine.ink)
                                    .textSelection(.enabled)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                        .padding(Alpine.Space.s4)
                    }
                } else {
                    ProgressView().tint(Alpine.primary)
                }
            }
            .task(id: bytes.count) {
                let data = bytes
                pieces = await Task.detached(priority: .userInitiated) { ArchiveText.pieces(data) }.value
            }
        }
    }
}

/* A picture from memory, decoded at no more than 4,096 pixels a side, turned upright: a 100 MB image never becomes a full-size bitmap. */
enum ArchiveImages {
    static let maxPixels = 4096

    static func decode(_ bytes: Data) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(bytes as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixels,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return UIImage(cgImage: image)
    }
}

/* PDFKit over the bytes in memory: PDFDocument(data:), no file. */
private struct InMemoryPDF: UIViewRepresentable {
    let data: Data

    func makeUIView(context: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true
        view.document = PDFDocument(data: data)
        return view
    }

    func updateUIView(_ view: PDFView, context: Context) {}
}

/* The password, typed here and held only by the open archive in the core. */
private struct ArchivePasswordCard: View {
    @Environment(DriveStore.self) private var store
    let name: String
    let archive: OpenArchive
    /* The entry the password is asked for: tried on it first, so a password that opens only some of the archive's entries opens the one picked. */
    let entry: ArchiveEntry
    /* Said before anything is typed: why the password is asked for again. */
    var note: String?
    let onUnlocked: () -> Void
    @State private var password = ""
    @State private var busy = false
    @State private var wrong = false
    @State private var error: String?

    var body: some View {
        VStack(spacing: Alpine.Space.s3) {
            Image(systemName: "lock").font(.system(size: 28)).foregroundStyle(Alpine.inkMuted).accessibilityHidden(true)
            Text(ArchiveWords.passwordTitle(name)).font(.title3.weight(.bold)).foregroundStyle(Alpine.ink).multilineTextAlignment(.center)
            VStack(alignment: .leading, spacing: Alpine.Space.s1) {
                Text(ArchiveWords.passwordLabel).font(Theme.Text.callout.weight(.medium)).foregroundStyle(Alpine.ink)
                RevealingSecureField(placeholder: ArchiveWords.passwordLabel, text: $password, content: nil, submit: submit)
                    .padding(.horizontal, Alpine.Space.s3).frame(minHeight: 44)
                    .background(Alpine.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(wrong ? Alpine.danger : Alpine.rule))
                    .accessibilityLabel(ArchiveWords.passwordLabel)
                if wrong || error != nil || note != nil {
                    Text(wrong ? ArchiveWords.wrongPassword : error ?? note ?? "").font(Theme.Text.footnote).foregroundStyle(Alpine.danger)
                }
            }
            Button(action: submit) {
                if busy { ProgressView().tint(.white) } else { Text(ArchiveWords.open).frame(maxWidth: .infinity) }
            }
            .buttonStyle(PrimaryCapsuleStyle())
            .disabled(password.isEmpty || busy)
        }
        .padding(Alpine.Space.s6)
        .frame(maxWidth: 400)
    }

    private func submit() {
        guard !password.isEmpty, !busy else { return }
        busy = true
        wrong = false
        error = nil
        let typed = password
        Task {
            do {
                if try await archive.unlock(typed, entry: entry) { onUnlocked() } else { wrong = true }
            } catch {
                self.error = failureWords(error, store: store)
            }
            busy = false
        }
    }
}
