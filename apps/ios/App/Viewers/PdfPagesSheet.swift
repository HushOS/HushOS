import HushOSCore
import HushOSKit
import PDFKit
import SwiftUI

/*
 * Edit pages (docs/file-tools-design.md, feature (c)): every page of the PDFs chosen, in a list to
 * put in order (drag a row's handle, or its Move earlier and Move later actions for VoiceOver and
 * Switch Control), each page's menu to turn it, split after it or remove it; then Save as a new
 * version, a new file (one PDF edited, several merged), one file a range when split, or images in a
 * new folder. The core reads and writes every PDF (PdfPages, lopdf); PDFKit draws the pages. Saving
 * keeps the sheet open with its progress and Stop, which asks first; a stop, a refusal or a failure
 * leaves nothing in the folder (PdfPages.save cleans up).
 */
struct PdfPagesSheet: View {
    @Environment(DriveStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    struct Item: Identifiable, Equatable {
        let id: String
        let source: Int
        let page: Int
        var rotate: UInt32
        let info: PdfPage
    }

    enum Mode: Hashable { case version, file, images }

    enum Phase: Equatable {
        case asking
        case reading
        case choosing
        case saving(done: Int, total: Int)
        case failed(String)
    }

    private let files: [Opened]
    @State private var phase = Phase.reading
    @State private var read: PdfPages.Read?
    @State private var documents: [PDFDocument?] = []
    @State private var items: [Item] = []
    @State private var original: [Item] = []
    @State private var cuts: Set<String> = []
    @State private var mode = Mode.version
    @State private var typed: String?
    @State private var png = true
    @State private var dpi: UInt32 = 150
    @State private var work: Task<Void, Never>?
    @State private var askingStop = false
    /* Where results go, worked out once from the selection as it came: the PDFs' own folder. */
    @State private var folder: Opened?
    /* The one PDF as its folder lists it now, for a new version. */
    @State private var current: Opened?
    @State private var problem: String?

    init(files: [Opened]) {
        self.files = files
    }

    private var one: Bool { files.count == 1 }
    private var total: UInt64 { files.reduce(0) { $0 + ($1.size ?? 0) } }
    private var stage: PdfPages.Stage { PdfPages.stage(count: files.count, bytes: total) }
    private var ranges: [ClosedRange<Int>] {
        PdfPages.ranges(count: items.count, cuts: Set(items.indices.filter { cuts.contains(items[$0].id) }))
    }
    private var split: Bool { ranges.count > 1 }
    private var effective: Mode { mode == .version && (!one || split) ? .file : mode }
    private var name: String { typed ?? (one ? files[0].name : PdfPages.mergedName(files[0].name)) }
    private var busy: Bool {
        if case .saving = phase { return true }
        return phase == .reading
    }
    private var flags: (signed: Bool, form: Bool) {
        let inspections = read?.inspections ?? []
        return (inspections.contains { $0.signed }, inspections.contains { $0.outline || $0.form })
    }
    private var canSave: Bool {
        guard phase == .choosing, folder != nil, !items.isEmpty else { return false }
        switch effective {
        case .version: return items != original && current != nil
        case .file:
            let trimmed = name.trimmingCharacters(in: .whitespaces)
            return split || (!trimmed.isEmpty && !trimmed.contains("/"))
        case .images: return PdfPages.imagesStage(pages: items.count) != .ceiling
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                if stage == .ceiling {
                    Section {
                        Text("These PDFs are too many or too large to edit on this phone: at most \(PdfPages.limits.maxFiles) files and \(ByteCountFormatter.string(fromByteCount: Int64(PdfPages.limits.maxInputBytes), countStyle: .file)).")
                            .foregroundStyle(Alpine.danger)
                    }
                } else if phase == .asking {
                    Section {
                        Text("\(one ? "This PDF is" : "These PDFs are") \(ByteCountFormatter.string(fromByteCount: Int64(total), countStyle: .file)). Editing \(one ? "it" : "them") uses a lot of memory and may be slow on this phone.")
                    }
                } else if phase == .reading {
                    Section { ProgressView { Text("Reading the pages") } }
                }
                if !items.isEmpty { pages }
                if read != nil { options }
                switch phase {
                case let .saving(done, total):
                    Section {
                        ProgressView(value: Double(done), total: Double(max(total, 1))) { Text("Saving") }
                    }
                case let .failed(message):
                    Section { Text(message).foregroundStyle(Alpine.danger) }
                default:
                    if let problem { Section { Text(problem).foregroundStyle(Alpine.danger) } }
                }
            }
            // The handles are the drag; the list's order is the PDF's.
            .environment(\.editMode, .constant(phase == .choosing ? .active : .inactive))
            .navigationTitle("Edit pages")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if case .saving = phase {
                        Button("Stop") { askingStop = true }
                    } else {
                        Button("Cancel") { work?.cancel(); dismiss() }
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if phase == .asking {
                        Button("Continue") { start() }
                    } else {
                        Button("Save") { save() }.disabled(!canSave)
                    }
                }
            }
            .confirmationDialog("Stop saving?", isPresented: $askingStop, titleVisibility: .visible) {
                Button("Stop", role: .destructive) { work?.cancel() }
                Button("Keep going", role: .cancel) {}
            } message: {
                Text("What was made so far is deleted.")
            }
        }
        .interactiveDismissDisabled(busy)
        .task {
            // One folder for all of them, or nothing is edited (search results can mix folders).
            guard PdfPages.oneFolder(files) else { problem = PdfPages.mixedFolders; phase = .failed(PdfPages.mixedFolders); return }
            do {
                let target = try await store.vault.editTarget(files[0])
                folder = target.folder
                current = one ? target.file : nil
            } catch {
                if sessionRefused(error) { dismiss(); return }
                phase = .failed(ErrorWords.say(error) ?? toolFailedMessage())
                return
            }
            guard stage != .ceiling else { phase = .failed(""); return }
            if stage == .offer { phase = .asking } else { start() }
        }
        .onDisappear { work?.cancel() }
    }

    private var pages: some View {
        Section("\(items.count) \(items.count == 1 ? "page" : "pages")") {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                HStack(spacing: Alpine.Space.s3) {
                    PageThumbnail(document: documents.indices.contains(item.source) ? documents[item.source] : nil,
                                  page: item.page, rotate: item.rotate, info: item.info)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Page \(index + 1)")
                        if !one {
                            Text(files[item.source].name).font(.caption).foregroundStyle(Alpine.inkMuted).lineLimit(1).truncationMode(.middle)
                        }
                        if cuts.contains(item.id), index < items.count - 1 {
                            Label("Split after", systemImage: "scissors").font(.caption).foregroundStyle(Alpine.primary)
                        }
                    }
                    Spacer(minLength: 0)
                    Menu {
                        Button("Rotate", systemImage: "rotate.right") { rotate(index) }
                        if index < items.count - 1 {
                            Button(cuts.contains(item.id) ? "Don’t split here" : "Split after this page", systemImage: "scissors") { toggleCut(index) }
                        }
                        if items.count > 1 {
                            Button("Remove", systemImage: "trash", role: .destructive) { remove(index) }
                        }
                    } label: {
                        Image(systemName: "ellipsis").frame(width: 44, height: 44)
                    }
                    .accessibilityLabel("Page \(index + 1) actions")
                }
                .accessibilityElement(children: .combine)
                .accessibilityValue("\(index + 1) of \(items.count)")
                .accessibilityAction(named: "Move earlier") { move(index, to: index - 1) }
                .accessibilityAction(named: "Move later") { move(index, to: index + 1) }
                .accessibilityAction(named: "Rotate") { rotate(index) }
                .accessibilityAction(named: "Split after this page") { toggleCut(index) }
                .accessibilityAction(named: "Remove") { remove(index) }
            }
            .onMove { from, to in items.move(fromOffsets: from, toOffset: to) }
        }
        .disabled(phase != .choosing)
    }

    @ViewBuilder private var options: some View {
        Section {
            Picker("Save as", selection: Binding(get: { effective }, set: { mode = $0 })) {
                if one && !split { Text("New version").tag(Mode.version) }
                Text(split ? "\(ranges.count) files" : one ? "New file" : "One file").tag(Mode.file)
                Text("Images").tag(Mode.images)
            }
            .pickerStyle(.segmented)
            switch effective {
            case .file where !split:
                TextField("Name", text: Binding(get: { name }, set: { typed = $0 }))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            case .file:
                ForEach(Array(ranges.prefix(5).enumerated()), id: \.offset) { _, range in
                    Text(PdfPages.splitName(files[0].name, first: range.lowerBound + 1, last: range.upperBound + 1)).lineLimit(1)
                }
                if ranges.count > 5 { Text("and \(ranges.count - 5) more").foregroundStyle(Alpine.inkMuted) }
            case .images:
                Picker("Format", selection: $png) {
                    Text("PNG").tag(true)
                    Text("JPEG").tag(false)
                }
                Picker("Resolution", selection: $dpi) {
                    Text("150 dpi").tag(UInt32(150))
                    Text("300 dpi").tag(UInt32(300))
                }
            case .version:
                EmptyView()
            }
        } footer: {
            VStack(alignment: .leading, spacing: 4) {
                if effective != .images && flags.signed { Text(PdfPages.signedWarning) }
                if effective != .images && flags.form { Text(PdfPages.formWarning) }
                if effective == .images, PdfPages.imagesStage(pages: items.count) == .offer {
                    Text("Saving \(items.count) pages as images takes a while and uses a lot of memory.")
                }
                if effective == .images, PdfPages.imagesStage(pages: items.count) == .ceiling {
                    Text("Save at most \(PdfPages.limits.imagesMaxPages) pages as images at a time.").foregroundStyle(Alpine.danger)
                }
            }
        }
        .disabled(phase != .choosing)
    }

    /* A 401 under the work: the app's session check, never a line in the sheet. */
    private func sessionRefused(_ error: Error) -> Bool {
        let refusal: Error? = endsSession(error) ? error : (error as? SaveRunStopped)?.sessionRefusal
        guard let refusal else { return false }
        store.report(refusal)
        return true
    }

    private func move(_ from: Int, to: Int) {
        guard items.indices.contains(to) else { return }
        items.move(fromOffsets: IndexSet(integer: from), toOffset: to > from ? to + 1 : to)
    }

    private func rotate(_ index: Int) { items[index].rotate = (items[index].rotate + 90) % 360 }

    private func toggleCut(_ index: Int) {
        let id = items[index].id
        if cuts.contains(id) { cuts.remove(id) } else { cuts.insert(id) }
    }

    private func remove(_ index: Int) {
        guard items.count > 1 else { return }
        cuts.remove(items[index].id)
        items.remove(at: index)
    }

    private func start() {
        let vault = store.vault, files = files
        phase = .reading
        work = Task {
            do {
                let read = try await PdfPages.read(vault: vault, files: files)
                let list = read.inspections.enumerated().flatMap { source, inspection in
                    inspection.pages.enumerated().map { page, info in
                        Item(id: "\(source):\(page)", source: source, page: page, rotate: info.rotate, info: info)
                    }
                }
                if list.count > Int(PdfPages.limits.maxPages) {
                    phase = .failed("These PDFs have more than 2,000 pages together, too many to edit here.")
                    return
                }
                self.read = read
                documents = read.data.map { PDFDocument(data: $0) }
                items = list
                original = list
                mode = one ? .version : .file
                phase = .choosing
            } catch {
                if sessionRefused(error) { dismiss(); return }
                if error is ToolCancelled || error is CancellationError { return }
                phase = .failed((error as? ImagesPdfRefused)?.message ?? (error as? ToolFailed)?.message ?? ErrorWords.say(error) ?? toolFailedMessage())
            }
            work = nil
        }
    }

    private func save() {
        guard let folder, let read else { return }
        let plan = items.map { PdfPagePlan(source: UInt32($0.source), page: UInt32($0.page), rotate: $0.rotate) }
        let choice: PdfPages.Choice
        switch effective {
        case .version:
            guard let current else { return }
            choice = .version(pages: plan, file: current, startedFrom: files[0].node.currentVersion?.id)
        case .file:
            let first = files[0].name
            choice = .files(split
                ? ranges.map { (PdfPages.splitName(first, first: $0.lowerBound + 1, last: $0.upperBound + 1), Array(plan[$0])) }
                : [(name.trimmingCharacters(in: .whitespaces), plan)])
        case .images:
            choice = .images(pages: plan, png: png, dpi: dpi, folderName: PdfPages.imagesFolderName(files[0].name))
        }
        let vault = store.vault, files = files
        phase = .saving(done: 0, total: max(1, plan.count))
        work = Task {
            do {
                let said = try await PdfPages.save(vault: vault, files: files, read: read, folder: folder, choice: choice) { done, total in
                    Task { @MainActor in phase = .saving(done: done, total: total) }
                }
                await store.refresh(folder: folder.id)
                store.notify(said)
                dismiss()
            } catch {
                if sessionRefused(error) { work = nil; dismiss(); return }
                phase = .failed((error as? ImagesPdfRefused)?.message ?? (error as? ToolFailed)?.message ?? ErrorWords.say(error) ?? toolFailedMessage())
            }
            work = nil
        }
    }
}

/* One page drawn small by PDFKit, turned as the list has it. */
private struct PageThumbnail: View {
    let document: PDFDocument?
    let page: Int
    let rotate: UInt32
    let info: PdfPage
    @State private var image: CGImage?

    var body: some View {
        Group {
            if let image {
                Image(decorative: image, scale: 2).resizable().scaledToFit()
            } else {
                Rectangle().fill(Alpine.surface)
            }
        }
        .frame(width: 56, height: 56)
        .background(Color.white)
        .task(id: rotate) {
            guard let document else { return }
            let turned = rotate == 90 || rotate == 270
            let (w, h) = turned ? (info.height, info.width) : (info.width, info.height)
            let scale = 112 / max(w, h, 1)
            image = PdfPages.draw(document, page: page, rotate: rotate, width: max(1, Int(w * scale)), height: max(1, Int(h * scale)))
        }
    }
}
