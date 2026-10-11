import HushOSKit
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/*
 * Adding files to a folder: the document picker, the photo library, the camera, and
 * the name-clash question (DESIGN.md): asked per file, Replace, Keep
 * both or Skip, each saying what it does, with "Do the same for N others". Keep both
 * names the new copies in a sheet. Home's first-run buttons and every folder share it.
 * A picked folder comes in whole, as on the web: its folders merge with any of the same
 * name already there, at every depth, and each file whose name is taken in its folder
 * gets the same question. Files with free names go at once, picked files and folders alike.
 */
typealias StagedFile = (url: URL, name: String, type: UTType?)

extension View {
    func uploadFlow(into folderId: String?, named folderName: String = "Files", importer: Binding<Bool>, folder: Binding<Bool> = .constant(false), photos: Binding<Bool>, camera: Binding<Bool> = .constant(false)) -> some View {
        modifier(UploadFlow(folderId: folderId, folderName: folderName, showingImporter: importer, showingFolder: folder, showingPhotos: photos, showingCamera: camera))
    }
}

private struct UploadFlow: ViewModifier {
    @Environment(DriveStore.self) private var store
    let folderId: String?
    let folderName: String
    @Binding var showingImporter: Bool
    @Binding var showingFolder: Bool
    @Binding var showingPhotos: Bool
    @Binding var showingCamera: Bool
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var noCamera = false
    /* Whether the open document picker is choosing a folder (its answer comes after the flags are reset). */
    @State private var importingFolder = false
    /*
     * The same-name questions, in an object: they are often set after an await (a folder placed,
     * photos copied out), and a sheet's content built from an earlier body read empty copies of
     * them when they were plain state.
     */
    @State private var questions = UploadQuestions()

    func body(content: Self.Content) -> some View {
        content
            .photosPicker(isPresented: $showingPhotos, selection: $photoItems, matching: .any(of: [.images, .videos]))
            // One picker for files and folders: a second .fileImporter on the same view never presents.
            .fileImporter(
                isPresented: Binding(get: { showingImporter || showingFolder }, set: { if !$0 { showingImporter = false; showingFolder = false } }),
                allowedContentTypes: showingFolder ? [.folder] : [.item], allowsMultipleSelection: !showingFolder
            ) { result in
                guard case .success(let urls) = result else { return }
                if importingFolder {
                    if let url = urls.first { queueFolder(url) }
                } else {
                    queue(urls.compactMap(Self.stage))
                }
            }
            .onChange(of: showingFolder) { _, on in if on { importingFolder = true } }
            .onChange(of: showingImporter) { _, on in if on { importingFolder = false } }
            .onChange(of: showingCamera) { _, on in
                // The simulator and some iPads have no camera: say so rather than open nothing.
                if on, !UIImagePickerController.isSourceTypeAvailable(.camera) {
                    showingCamera = false
                    noCamera = true
                }
            }
            .fullScreenCover(isPresented: $showingCamera) {
                CameraPicker { file in queue([file]) }.ignoresSafeArea()
            }
            .alert("There’s no camera on this device", isPresented: $noCamera) {
                Button("OK", role: .cancel) {}
            } message: {
                Text("Choose Upload photos to add pictures you already have.")
            }
            .sheet(item: Binding(get: { questions.asking }, set: { questions.asking = $0 })) { asked in
                ClashSheet(
                    name: asked.file.name, folderName: asked.folderName,
                    others: questions.clashes.filter { $0.id != asked.id && questions.answers[$0.id] == nil }.map(\.file.name),
                    free: DriveStore.freeName(asked.file.name, among: questions.claimed[asked.folderId] ?? []),
                    cancel: cancelQuestions
                ) { choice, same in decide(asked, choice, same: same) }
                // Each file starts from the defaults, not from the answer given for the one before.
                .id(asked.id)
                .environment(store)
                .interactiveDismissDisabled()
            }
            .sheet(isPresented: Binding(get: { questions.naming }, set: { questions.naming = $0 })) {
                KeepBothSheet(entries: questions.keeping, taken: questions.taken) { names in
                    send(renamed: names)
                } cancel: { cancelQuestions() }
            }
            .onChange(of: photoItems) { _, items in
                guard !items.isEmpty else { return }
                photoItems = []
                // Copying a long video out of Photos takes a while: a row (and the Live Activity, which can
                // only start while HushOS is on screen) says so from the moment the picker closes.
                let ticket = store.begin(.upload, items.count == 1 ? "1 file from Photos" : "\(items.count) files from Photos")
                store.markWaiting(ticket)
                Task {
                    var staged: [StagedFile] = []
                    for item in items {
                        let type = item.supportedContentTypes.first
                        let name = "\(Date().formatted(.iso8601.year().month().day().dateSeparator(.dash)))-\(UUID().uuidString.prefix(6)).\(type?.preferredFilenameExtension ?? "bin")"
                        // Videos come as a file, not into memory: a long one is hundreds of megabytes.
                        if type?.conforms(to: .movie) == true, let movie = try? await item.loadTransferable(type: PickedMovie.self) {
                            if let file = Self.move(movie.url, named: name, type: type) { staged.append(file) }
                            continue
                        }
                        guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
                        if let file = Self.write(data, named: name, type: type) { staged.append(file) }
                    }
                    store.dismiss(ticket)
                    queue(staged)
                }
            }
    }

    /* Picked files for this folder: the free names go at once, each taken one is asked about. */
    private func queue(_ files: [StagedFile]) {
        guard !files.isEmpty, let folderId else { return }
        var taken = (store.folders[folderId] ?? []).map(\.name)
        let (free, clashing) = Self.sort(files, into: folderId, named: folderName, holding: store.folders[folderId] ?? [], taken: &taken)
        if !free.isEmpty { Task { await store.upload(free, to: folderId) } }
        questions.start(clashing, taken: [folderId: taken])
    }

    /*
     * Picked files for one folder, each on its own: the ones whose name a file there has are
     * asked about (each its own question, even two picks of one name), and the rest go under
     * their own name, or the next free one when an earlier pick took it.
     */
    private static func sort(_ files: [StagedFile], into folderId: String, named folderName: String, holding children: [Opened], taken: inout [String]) -> (free: [DriveStore.Outgoing], clashing: [UploadClash]) {
        let existing = children.filter { !$0.isFolder }
        let placements = UploadNames.place(files.map(\.name), existingFiles: existing.map(\.name), taken: &taken)
        var free: [DriveStore.Outgoing] = []
        var clashing: [UploadClash] = []
        for (file, placement) in zip(files, placements) {
            switch placement {
            case .free(let name):
                free.append(DriveStore.Outgoing(file: file, name: name))
            case .clash:
                let replaces = existing.first { $0.name.caseInsensitiveCompare(file.name) == .orderedSame }
                clashing.append(UploadClash(file: file, folderId: folderId, folderName: folderName, replaces: replaces))
            }
        }
        return (free, clashing)
    }

    /* A picked folder copied into our temp directory, each file with the folders above it. */
    private struct PickedFolder: Sendable {
        let files: [(file: StagedFile, path: [String])]
        let folders: [[String]]
        let unread: Int
    }

    /* A picked folder: copied out while a row says it is getting ready, then placed and uploaded. */
    private func queueFolder(_ url: URL) {
        guard let folderId else { return }
        // Hidden files and folders stay behind, as they do inside a pick: say so rather than add nothing silently.
        if FolderPick.hidden(url.lastPathComponent) {
            store.notify("“\(url.lastPathComponent)” is a hidden folder, and hidden folders aren’t uploaded.")
            return
        }
        let ticket = store.begin(.upload, url.lastPathComponent)
        store.markWaiting(ticket)
        Task {
            let picked = await Task.detached { Self.stageFolder(url) }.value
            if let picked {
                await place(picked, into: folderId)
                if picked.unread > 0 {
                    store.notify(picked.unread == 1 ? "1 file in “\(url.lastPathComponent)” couldn’t be read, so it wasn’t added." : "\(picked.unread) files in “\(url.lastPathComponent)” couldn’t be read, so they weren’t added.")
                }
            } else {
                store.notify("Couldn’t open “\(url.lastPathComponent)”. Try choosing it again.")
            }
            store.dismiss(ticket)
        }
    }

    /*
     * The web's order: every folder the pick needs, parents first, reusing one of the same name
     * that is already there; then the files with free names go at once, and each taken name is
     * asked about in turn. The listings read here are the ones the upload checks names against.
     */
    private func place(_ picked: PickedFolder, into folderId: String) async {
        await store.sync()
        var listings: [String: [Opened]] = [:]
        var made: Set<String> = []
        func listing(_ id: String) async -> [Opened]? {
            if made.contains(id) { return [] }
            if let known = listings[id] { return known }
            do {
                let children = try await store.vault.children(of: id)
                listings[id] = children
                store.folders[id] = children
                return children
            } catch {
                store.report(error)
                return nil
            }
        }
        let discard = { for entry in picked.files { try? FileManager.default.removeItem(at: entry.file.url) } }
        var places: [[String]: (id: String, name: String)] = [[]: (folderId, folderName)]
        for path in FolderPick.plan(files: picked.files.map(\.path), folders: picked.folders) {
            guard let name = path.last, let parent = places[Array(path.dropLast())] else { continue }
            guard let children = await listing(parent.id) else { return discard() }
            if let same = children.first(where: { $0.isFolder && $0.name == name }) {
                places[path] = (same.id, same.name)
                continue
            }
            guard let created = await store.createFolder(named: name, in: parent.id) else { return discard() }
            made.insert(created.id)
            places[path] = (created.id, created.name)
        }
        // Grouped by destination in pick order; each group is sorted as picked files are.
        var order: [String] = []
        var groups: [String: (name: String, children: [Opened], files: [StagedFile])] = [:]
        for entry in picked.files {
            guard let place = places[entry.path], let children = await listing(place.id) else {
                try? FileManager.default.removeItem(at: entry.file.url)
                continue
            }
            if groups[place.id] == nil {
                order.append(place.id)
                groups[place.id] = (place.name, children, [])
            }
            groups[place.id]?.files.append(entry.file)
        }
        var ready: [(String, [DriveStore.Outgoing])] = []
        var clashing: [UploadClash] = []
        var taken: [String: [String]] = [:]
        for id in order {
            guard let group = groups[id] else { continue }
            var names = group.children.map(\.name)
            let sorted = Self.sort(group.files, into: id, named: group.name, holding: group.children, taken: &names)
            taken[id] = names
            if !sorted.free.isEmpty { ready.append((id, sorted.free)) }
            clashing += sorted.clashing
        }
        Task { for (id, items) in ready { await store.upload(items, to: id) } }
        questions.start(clashing, taken: taken)
    }

    /*
     * One answer, or one for every file still unasked; keep both suggests the next free name in
     * that folder. Once all are answered, the kept-both names can be changed before anything goes.
     */
    private func decide(_ asked: UploadClash, _ choice: DriveStore.Conflict, same: Bool) {
        let questions = self.questions
        let answering = same ? questions.clashes.filter { $0.id == asked.id || questions.answers[$0.id] == nil } : [asked]
        for clash in answering {
            var name = clash.file.name
            if choice == .keepBoth {
                name = DriveStore.freeName(clash.file.name, among: questions.claimed[clash.folderId] ?? [])
                questions.claimed[clash.folderId, default: []].append(name)
            }
            questions.answers[clash.id] = (choice, name)
        }
        questions.asking = nil
        if let next = questions.clashes.first(where: { questions.answers[$0.id] == nil }) {
            // The next file's question, once this sheet has gone.
            Task { try? await Task.sleep(for: .milliseconds(350)); questions.asking = next }
        } else if !questions.keeping.isEmpty {
            Task { try? await Task.sleep(for: .milliseconds(350)); questions.naming = true }
        } else {
            send(renamed: [:])
        }
    }

    /* Each destination folder gets its replacements and its kept-both copies under their chosen names. */
    private func send(renamed: [UUID: String]) {
        let answered = questions.clashes
        let answers = questions.answers
        questions.reset()
        // Each file by its own answer, never by its name: two picks of one name can be answered differently.
        var order: [String] = []
        var outgoing: [String: [DriveStore.Outgoing]] = [:]
        for clash in answered {
            if outgoing[clash.folderId] == nil { order.append(clash.folderId); outgoing[clash.folderId] = [] }
            switch answers[clash.id]?.choice ?? .skip {
            case .skip:
                try? FileManager.default.removeItem(at: clash.file.url)
            case .replace:
                outgoing[clash.folderId]?.append(DriveStore.Outgoing(file: clash.file, name: clash.file.name, replacing: clash.replaces))
            case .keepBoth:
                outgoing[clash.folderId]?.append(DriveStore.Outgoing(file: clash.file, name: renamed[clash.id] ?? answers[clash.id]?.name ?? clash.file.name))
            }
        }
        Task { for id in order where !(outgoing[id] ?? []).isEmpty { await store.upload(outgoing[id] ?? [], to: id) } }
    }

    /* Cancel adds none of the files that were asked about; the ones with free names have gone already. */
    private func cancelQuestions() {
        for clash in questions.clashes { try? FileManager.default.removeItem(at: clash.file.url) }
        questions.reset()
    }

    /* Reads the picked folder through a file coordinator, so a provider brings its files down first. */
    nonisolated private static func stageFolder(_ url: URL) -> PickedFolder? {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        var picked: PickedFolder?
        var problem: NSError?
        NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &problem) { url in
            let found = FolderPick.read(url)
            var files: [(file: StagedFile, path: [String])] = []
            for file in found.files {
                if let staged = stage(file.url) { files.append((staged, file.path)) }
            }
            picked = PickedFolder(files: files, folders: found.folders, unread: found.files.count - files.count)
        }
        return picked
    }

    /* A security-scoped file copied into our temp directory so the upload can read it at leisure. */
    nonisolated static func stage(_ url: URL) -> StagedFile? {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let name = url.lastPathComponent
        let target = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathComponent(name)
        do {
            try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            try FileManager.default.copyItem(at: url, to: target)
        } catch {
            return nil
        }
        return (target, name, UTType(filenameExtension: url.pathExtension))
    }

    static func move(_ file: URL, named name: String, type: UTType?) -> StagedFile? {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathComponent(name)
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard (try? FileManager.default.moveItem(at: file, to: url)) != nil else { return nil }
        return (url, name, type)
    }

    static func write(_ data: Data, named name: String, type: UTType?) -> StagedFile? {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathComponent(name)
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard (try? data.write(to: url)) != nil else { return nil }
        return (url, name, type)
    }
}

/* What an upload still asks about: the files whose names are taken where they are going, and the answers so far. */
@MainActor @Observable
private final class UploadQuestions {
    var clashes: [UploadClash] = []
    var answers: [UUID: (choice: DriveStore.Conflict, name: String)] = [:]
    /* Names in each destination folder before any answer: what is there, and the files with free names going in. */
    var taken: [String: [String]] = [:]
    /* The same, with the kept-both names suggested so far. */
    var claimed: [String: [String]] = [:]
    var asking: UploadClash?
    /* All answered, and some are kept both: their names are being chosen. */
    var naming = false

    func start(_ clashes: [UploadClash], taken: [String: [String]]) {
        guard !clashes.isEmpty else { return }
        self.clashes = clashes
        answers = [:]
        self.taken = taken
        claimed = taken
        naming = false
        asking = clashes.first
    }

    /* The files to keep both of, each with the name suggested when it was answered. */
    var keeping: [KeepBothSheet.Entry] {
        clashes.compactMap { clash in
            guard let answer = answers[clash.id], answer.choice == .keepBoth else { return nil }
            return KeepBothSheet.Entry(id: clash.id, original: clash.file.name, folderId: clash.folderId, folderName: clash.folderName, suggested: answer.name)
        }
    }

    func reset() {
        clashes = []
        answers = [:]
        taken = [:]
        claimed = [:]
        asking = nil
        naming = false
    }
}

/* One added file whose name its destination folder already has. */
private struct UploadClash: Identifiable {
    let id = UUID()
    let file: StagedFile
    let folderId: String
    let folderName: String
    /* The file there whose name it has: Replace makes a new version of this one. */
    let replaces: Opened?
}

/* One clashing file: what should happen to the one being added, and whether the rest follow. */
private struct ClashSheet: View {
    let name: String
    let folderName: String
    let others: [String]
    let free: String
    let cancel: () -> Void
    let decide: (DriveStore.Conflict, Bool) -> Void
    @State private var choice: DriveStore.Conflict = .replace
    @State private var same = true

    var body: some View {
        NavigationStack {
            List {
                Section {} header: {
                    Text("A file with this name is already here. What should happen to the one you’re adding?")
                        .font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted).multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity).textCase(nil)
                }
                Section {
                    option(.replace, "Replace", "Keeps the old one as an earlier version")
                    option(.keepBoth, "Keep both", "Adds this one as “\(free)”")
                    option(.skip, "Skip", "Leaves the one here as it is")
                }
                if !others.isEmpty {
                    Section {
                        Toggle("Do the same for \(others.count == 1 ? "1 other" : "\(others.count) others")", isOn: $same).tint(Alpine.primary).alpineRow()
                    } footer: {
                        Text("\(DriveStore.names(others)) \(others.count == 1 ? "is" : "are") already here too.")
                    }
                }
            }
            .listStyle(.insetGrouped)
            .alpineGrouped()
            .navigationTitle(name)
            .navigationSubtitle(Text("Already in “\(folderName)”"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: cancel) }
                ToolbarItem(placement: .confirmationAction) { Button("Continue") { decide(choice, same && !others.isEmpty) } }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func option(_ value: DriveStore.Conflict, _ label: String, _ detail: String) -> some View {
        Button { choice = value } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(label).fontWeight(choice == value ? .semibold : .regular).foregroundStyle(Alpine.ink)
                    Text(detail).font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted)
                }
                Spacer()
                if choice == value { Image(systemName: "checkmark").fontWeight(.semibold).foregroundStyle(Alpine.primary) }
            }
            .contentShape(Rectangle())
        }
        .accessibilityAddTraits(choice == value ? .isSelected : [])
        .alpineRow(selected: choice == value)
    }
}

/*
 * Keeping both: each clashing file gets the name it will carry, suggested free and editable,
 * grouped by the folder it is going to when a picked folder sends them to more than one.
 */
struct KeepBothSheet: View {
    struct Entry: Identifiable {
        let id: UUID
        let original: String
        let folderId: String
        let folderName: String
        let suggested: String
    }

    @Environment(\.dismiss) private var dismiss
    let entries: [Entry]
    /* Names already in each destination folder, the files with free names going in included. */
    let taken: [String: [String]]
    let done: ([UUID: String]) -> Void
    var cancel: () -> Void = {}
    @State private var names: [UUID: String] = [:]

    private var folders: [String] {
        var seen: Set<String> = []
        return entries.map(\.folderId).filter { seen.insert($0).inserted }
    }

    private func name(_ entry: Entry) -> String { (names[entry.id] ?? entry.suggested).trimmingCharacters(in: .whitespaces) }

    /* Why a name can't be used: empty, already in that folder, or given to another file going there. */
    private func problem(_ entry: Entry) -> String? {
        let name = name(entry)
        if name.isEmpty { return "Enter a name." }
        if (taken[entry.folderId] ?? []).contains(where: { $0.caseInsensitiveCompare(name) == .orderedSame }) { return "“\(name)” is already here too. Try another name." }
        let twice = entries.contains { $0.id != entry.id && $0.folderId == entry.folderId && self.name($0).caseInsensitiveCompare(name) == .orderedSame }
        return twice ? "Another file going here has this name." : nil
    }

    var body: some View {
        NavigationStack {
            Form {
                ForEach(folders, id: \.self) { folder in
                    let here = entries.filter { $0.folderId == folder }
                    Section {
                        ForEach(here) { entry in
                            VStack(alignment: .leading, spacing: 2) {
                                TextField("Name", text: Binding(get: { names[entry.id] ?? entry.suggested }, set: { names[entry.id] = $0 }))
                                    .textInputAutocapitalization(.never).autocorrectionDisabled().foregroundStyle(Alpine.ink)
                                Text(problem(entry) ?? "Already here: \(entry.original)").font(Theme.Text.footnote)
                                    .foregroundStyle(problem(entry) == nil ? Alpine.inkMuted : Alpine.danger)
                            }
                            .alpineRow()
                        }
                    } header: {
                        Text(folders.count == 1 ? "New names" : "In “\(here.first?.folderName ?? "")”")
                    } footer: {
                        if folder == folders.last { Text("Each file is added under its new name. The ones already here don’t change.") }
                    }
                }
            }
            .alpineGrouped()
            .navigationTitle("Keep both")
            .navigationSubtitle(Text(entries.count == 1 ? "1 file" : "\(entries.count) files"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss(); cancel() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Upload") { dismiss(); done(Dictionary(uniqueKeysWithValues: entries.map { ($0.id, name($0)) })) }
                        .disabled(entries.contains { problem($0) != nil })
                }
            }
        }
    }
}

/* Take photo: the system camera, the picture saved as a JPEG named like the photo-library uploads. */
private struct CameraPicker: UIViewControllerRepresentable {
    let taken: (StagedFile) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker
        init(_ parent: CameraPicker) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage, let data = image.jpegData(compressionQuality: 0.9) {
                let name = "\(Date().formatted(.iso8601.year().month().day().dateSeparator(.dash)))-\(UUID().uuidString.prefix(6)).jpg"
                let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathComponent(name)
                try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                if (try? data.write(to: url)) != nil { parent.taken((url, name, .jpeg)) }
            }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.dismiss() }
    }
}

/* A video from Photos as a file on disk, copied out of the picker's temporary one before it goes. */
struct PickedMovie: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(contentType: .movie) { movie in SentTransferredFile(movie.url) } importing: { received in
            let copy = FileManager.default.temporaryDirectory.appendingPathComponent("picked-" + UUID().uuidString, isDirectory: true)
                .appendingPathComponent(received.file.lastPathComponent)
            try FileManager.default.createDirectory(at: copy.deletingLastPathComponent(), withIntermediateDirectories: true)
            try FileManager.default.copyItem(at: received.file, to: copy)
            return PickedMovie(url: copy)
        }
    }
}
