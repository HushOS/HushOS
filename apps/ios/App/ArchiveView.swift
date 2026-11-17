import HushOSCore
import HushOSKit
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
    let item: Opened
    @State private var archive: OpenArchive?
    @State private var tree: ArchiveTree?
    @State private var failure: String?
    @State private var attempt = 0
    @State private var path: [String] = []
    @State private var opened: ArchiveEntry?
    @State private var unlocked = false
    @State private var saving: ArchiveEntry?
    @State private var asking: ArchiveEntry?
    @State private var download: ArchiveDownload?

    var body: some View {
        VStack(spacing: 0) {
            if let failure {
                EmptyStateView(title: ArchiveWords.broken, message: failure) {
                    Button("Try again") { self.failure = nil; attempt += 1 }.buttonStyle(PrimaryCapsuleStyle())
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let archive, let tree {
                crumbs
                Divider().overlay(Alpine.rule)
                if let opened {
                    ArchiveEntryPane(entry: opened, archive: archive, unlocked: $unlocked, onDownload: { start(opened) })
                        .id(opened.index)
                } else {
                    list(tree.rows(at: path), hidden: archive.hidden)
                }
                if let download { downloadBar(download) }
            } else {
                VStack(spacing: Alpine.Space.s3) {
                    FileMark(item: item, box: 72)
                    Text(item.name).font(Theme.Text.headline).foregroundStyle(Alpine.ink).multilineTextAlignment(.center)
                    ProgressView().tint(Alpine.primary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Alpine.ground)
        .task(id: "\(item.id)-\(item.node.currentVersion?.id ?? "")-\(attempt)-\(ObjectIdentifier(store.vault).hashValue)") {
            archive?.close()
            archive = nil
            tree = nil
            path = []
            opened = nil
            unlocked = false
            do {
                let open = try await OpenArchive.open(item, vault: store.vault)
                guard !Task.isCancelled else { open.close(); return }
                tree = ArchiveTree(open.entries)
                archive = open
            } catch {
                if !Task.isCancelled { failure = (error as? ArchiveFailure)?.message ?? (ErrorWords.say(error) ?? ErrorWords.generic) }
            }
        }
        // Leaving the viewer wipes the password, whatever else holds the archive.
        .onDisappear { archive?.close() }
        .fileImporter(isPresented: Binding(get: { saving != nil }, set: { if !$0 { saving = nil } }), allowedContentTypes: [.folder]) { result in
            guard let entry = saving else { return }
            saving = nil
            if case .success(let folder) = result { save(entry, into: folder) }
        }
        .alert(asking.map { ArchiveWords.asksFirst(size: formatBytes(Int64($0.size)), packed: formatBytes(Int64($0.packed))) } ?? "",
               isPresented: Binding(get: { asking != nil }, set: { if !$0 { asking = nil } })) {
            Button(ArchiveWords.cancel, role: .cancel) { asking = nil }
            Button(ArchiveWords.download) {
                saving = asking
                asking = nil
            }
        }
    }

    /* Archive name › folders › the entry open, each but the last a way back. */
    private var crumbs: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Alpine.Space.s1) {
                crumb(item.name, current: path.isEmpty && opened == nil) { go([]) }
                ForEach(Array(path.enumerated()), id: \.offset) { index, part in
                    Image(systemName: "chevron.right").font(.caption).foregroundStyle(Alpine.inkMuted).accessibilityHidden(true)
                    crumb(part, current: index == path.count - 1 && opened == nil) { go(Array(path.prefix(index + 1))) }
                }
                if let opened {
                    Image(systemName: "chevron.right").font(.caption).foregroundStyle(Alpine.inkMuted).accessibilityHidden(true)
                    crumb(opened.parts.last ?? opened.path, current: true) {}
                }
            }
            .padding(.horizontal, Alpine.Space.s4)
        }
        .frame(minHeight: 44)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Folders in the archive")
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

    private func go(_ to: [String]) {
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
                    .swipeActions {
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
        case .folder(let name, _): path.append(name)
        case .file(let entry): if !entry.link { opened = entry }
        }
    }

    /* Download: a locked entry asks for its password first; a large one past 200:1 asks first; then a place to save it. */
    private func start(_ entry: ArchiveEntry) {
        if entry.lock != "none" && !unlocked {
            opened = entry
            return
        }
        if zipEntryAsksFirst(size: entry.size, packed: entry.packed) {
            asking = entry
            return
        }
        saving = entry
    }

    /*
     * The entry streamed into the folder the person picked, a MiB at a time, under its own name
     * (the next free one if taken). Nothing is written anywhere else; a failed or stopped download
     * deletes what it wrote.
     */
    private func save(_ entry: ArchiveEntry, into folder: URL) {
        guard let archive else { return }
        let name = ArchiveFiles.safeName(entry.parts.last ?? entry.path)
        let progress = ArchiveDownload(entry: entry)
        download = progress
        progress.task = Task {
            let scoped = folder.startAccessingSecurityScopedResource()
            defer { if scoped { folder.stopAccessingSecurityScopedResource() } }
            var target: URL?
            do {
                let file = ArchiveFiles.freeURL(in: folder, name: name)
                target = file
                guard FileManager.default.createFile(atPath: file.path, contents: nil) else { throw CocoaError(.fileWriteNoPermission) }
                let handle = try FileHandle(forWritingTo: file)
                defer { try? handle.close() }
                try await archive.download(entry, into: ArchiveSink { chunk in
                    try handle.write(contentsOf: chunk)
                    Task { @MainActor in progress.written += UInt64(chunk.count) }
                })
                await MainActor.run { if download === progress { download = nil } }
            } catch {
                if let target { try? FileManager.default.removeItem(at: target) }
                await MainActor.run {
                    guard download === progress else { return }
                    if Task.isCancelled { download = nil } else { progress.error = (error as? ArchiveFailure)?.message ?? (ErrorWords.say(error) ?? ErrorWords.generic) }
                }
            }
        }
    }

    private func downloadBar(_ download: ArchiveDownload) -> some View {
        HStack(spacing: Alpine.Space.s3) {
            Text(download.error ?? ArchiveWords.downloading(download.entry.parts.last ?? download.entry.path))
                .font(Theme.Text.footnote).foregroundStyle(download.error == nil ? Alpine.ink : Alpine.danger).lineLimit(2)
            Spacer(minLength: 0)
            if download.error == nil, download.entry.size > 0 {
                Text("\(Int(Double(download.written) / Double(download.entry.size) * 100))%")
                    .font(Theme.Text.footnote.monospacedDigit()).foregroundStyle(Alpine.inkMuted)
            }
            Button {
                download.task?.cancel()
                self.download = nil
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

/* An entry downloading into a folder the person picked. */
@Observable @MainActor
final class ArchiveDownload {
    let entry: ArchiveEntry
    var written: UInt64 = 0
    var error: String?
    var task: Task<Void, Never>?
    init(entry: ArchiveEntry) { self.entry = entry }
}

enum ArchiveFiles {
    /* A name that can be a file's in the picked folder: no separators, never empty or a dot. */
    static func safeName(_ name: String) -> String {
        let cleaned = name.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: ":", with: "_")
            .trimmingCharacters(in: .whitespaces)
        return cleaned.isEmpty || cleaned == "." || cleaned == ".." ? "Item" : cleaned
    }

    /* `name` in `folder`, or "name (2).ext" and on when taken. */
    static func freeURL(in folder: URL, name: String) -> URL {
        let base = (name as NSString).deletingPathExtension, ext = (name as NSString).pathExtension
        var candidate = folder.appendingPathComponent(name)
        var n = 2
        while FileManager.default.fileExists(atPath: candidate.path) {
            candidate = folder.appendingPathComponent(ext.isEmpty ? "\(base) (\(n))" : "\(base) (\(n)).\(ext)")
            n += 1
        }
        return candidate
    }
}

extension ArchiveRow {
    var key: String {
        switch self {
        case .folder(let name, _): "d:\(name)"
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
            let ext = ((entry.parts.last ?? entry.path) as NSString).pathExtension.uppercased()
            PageGlyph(label: (1 ... 4).contains(ext.count) ? ext : nil, name: entry.parts.last ?? entry.path)
                .frame(width: Theme.mark * 0.66, height: Theme.mark * 0.66 * 54 / 44)
        }
    }

    private var subtitle: String {
        switch row {
        case .folder(_, let count): return ArchiveWords.items(count)
        case .file(let entry):
            if entry.link { return ArchiveWords.link }
            if entry.lock != "none" && !unlocked { return ArchiveWords.needsPassword }
            return [formatBytes(Int64(entry.size)), changedLabel(ArchiveEntries.date(entry))].compactMap { $0 }.joined(separator: " · ")
        }
    }
}

/* One entry open: its size and date with Download, then its password, its refusal, the large-file card, or the entry itself. */
private struct ArchiveEntryPane: View {
    let entry: ArchiveEntry
    let archive: OpenArchive
    @Binding var unlocked: Bool
    let onDownload: () -> Void
    @State private var bytes: Data?
    @State private var failure: String?
    @State private var continued = false

    private var name: String { entry.parts.last ?? entry.path }
    private var kind: ArchiveEntries.Kind { ArchiveEntries.kind(of: name) }
    private var limits: PreviewLimits { ArchiveEntries.limits(kind) }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: Alpine.Space.s3) {
                Text([formatBytes(Int64(entry.size)), changedLabel(ArchiveEntries.date(entry))].compactMap { $0 }.joined(separator: " · "))
                    .font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted)
                Spacer(minLength: 0)
                if entry.support == "ok", entry.lock == "none" || unlocked {
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
        if entry.lock != "none" && !unlocked {
            ArchivePasswordCard(name: name, archive: archive) { unlocked = true }
        } else if entry.support != "ok" {
            card(title: name, message: entry.support == "method" ? ArchiveWords.method : ArchiveWords.encryption)
        } else if entry.nested {
            card(title: name, message: ArchiveWords.nested, download: true)
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
                .task {
                    do { bytes = try await archive.preview(entry, limit: limits.ceiling) } catch {
                        if !Task.isCancelled { failure = (error as? ArchiveFailure)?.message ?? (ErrorWords.say(error) ?? ErrorWords.generic) }
                    }
                }
        }
    }

    private func card(title: String, message: String, download: Bool = false) -> some View {
        EmptyStateView(title: title, message: message) {
            if download { Button(ArchiveWords.download, action: onDownload).buttonStyle(PrimaryCapsuleStyle()) }
        }
        .padding(Alpine.Space.s6)
    }
}

/* The entry from memory: a picture, a PDF through PDFKit, Markdown drawn, or text. */
private struct ArchiveEntryView: View {
    let kind: ArchiveEntries.Kind
    let name: String
    let bytes: Data

    var body: some View {
        switch kind {
        case .image:
            if let image = UIImage(data: bytes) {
                // Fitted to the space, as QuickLook shows a picture; a picture smaller than the screen is enlarged, never smoothed.
                Image(uiImage: image).resizable().interpolation(image.size.width < 64 ? .none : .high).scaledToFit()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .padding(Alpine.Space.s4)
                    .accessibilityLabel(name)
            } else {
                EmptyStateView(title: ArchiveWords.broken, message: nil) { EmptyView() }
            }
        case .pdf:
            InMemoryPDF(data: bytes)
        case .markdown where bytes.count <= MarkdownDocument.limit:
            MarkdownView(data: bytes)
        default:
            ScrollView {
                Text(String(decoding: bytes, as: UTF8.self))
                    .font(.system(.footnote, design: .monospaced)).foregroundStyle(Alpine.ink)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(Alpine.Space.s4)
            }
        }
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
    let name: String
    let archive: OpenArchive
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
                if wrong || error != nil {
                    Text(wrong ? ArchiveWords.wrongPassword : error ?? "").font(Theme.Text.footnote).foregroundStyle(Alpine.danger)
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
                if try await archive.unlock(typed) { onUnlocked() } else { wrong = true }
            } catch {
                self.error = (error as? ArchiveFailure)?.message ?? (ErrorWords.say(error) ?? ErrorWords.generic)
            }
            busy = false
        }
    }
}
