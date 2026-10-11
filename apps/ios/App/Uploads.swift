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
 * gets the same question (keep both takes the name the question offers).
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
    @State private var pending: [StagedFile] = []
    @State private var clashes: [String] = []
    @State private var decisions: [String: DriveStore.Conflict] = [:]
    @State private var asking: String?
    @State private var naming = false
    @State private var noCamera = false
    /* Whether the open document picker is choosing a folder (its answer comes after the flags are reset). */
    @State private var importingFolder = false
    /*
     * A picked folder's questions, in an object: they are set after the folder is placed, and the
     * sheet's content, built from an earlier body, read empty copies of them as plain state.
     */
    @State private var folderQuestions = FolderQuestions()

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
            .sheet(item: Binding(get: { asking.map(Asked.init) }, set: { if $0 == nil { asking = nil } })) { asked in
                ClashSheet(
                    name: asked.name, folderName: folderName, others: clashes.filter { $0 != asked.name && decisions[$0] == nil },
                    free: DriveStore.freeName(asked.name, among: takenNames + pending.map(\.name)),
                    cancel: cancel
                ) { choice, same in decide(asked.name, choice, same: same) }
                .environment(store)
                .interactiveDismissDisabled()
            }
            .sheet(item: Binding(get: { folderQuestions.asking }, set: { folderQuestions.asking = $0 })) { asked in
                let folderClashes = folderQuestions.clashes
                let folderAnswers = folderQuestions.answers
                ClashSheet(
                    name: asked.file.name, folderName: asked.folderName,
                    others: folderClashes.filter { $0.id != asked.id && folderAnswers[$0.id] == nil }.map(\.file.name),
                    free: DriveStore.freeName(asked.file.name, among: folderQuestions.claimed[asked.folderId] ?? []),
                    cancel: cancelFolder
                ) { choice, same in decide(asked, choice, same: same) }
                // Each file starts from the defaults, not from the answer given for the one before.
                .id(asked.id)
                .environment(store)
                .interactiveDismissDisabled()
            }
            .sheet(isPresented: $naming) {
                if let folderId {
                    let keep = clashes.filter { decisions[$0] == .keepBoth }
                    KeepBothSheet(files: pending.filter { keep.contains($0.name) }, taken: takenNames) { renames in
                        upload(into: folderId, renames: renames)
                    } cancel: { cancel() }
                }
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

    private struct Asked: Identifiable { let name: String; var id: String { name } }

    private var takenNames: [String] { (folderId.flatMap { store.folders[$0] } ?? []).map(\.name) }

    /* Ask about each name already here, as the web does; upload straight away when nothing clashes. */
    private func queue(_ files: [StagedFile]) {
        guard !files.isEmpty, let folderId else { return }
        let names = store.conflicts(files, in: folderId).map(\.name)
        pending = files
        decisions = [:]
        clashes = files.map(\.name).filter { name in names.contains { $0.caseInsensitiveCompare(name) == .orderedSame } }
        if clashes.isEmpty { upload(into: folderId, renames: [:]) } else { asking = clashes.first }
    }

    private func decide(_ name: String, _ choice: DriveStore.Conflict, same: Bool) {
        decisions[name] = choice
        if same { for other in clashes where decisions[other] == nil { decisions[other] = choice } }
        asking = nil
        if let next = clashes.first(where: { decisions[$0] == nil }) {
            // The next file's question, once this sheet has gone.
            Task { try? await Task.sleep(for: .milliseconds(350)); asking = next }
        } else if decisions.values.contains(.keepBoth) {
            Task { try? await Task.sleep(for: .milliseconds(350)); naming = true }
        } else if let folderId {
            upload(into: folderId, renames: [:])
        }
    }

    private func upload(into folderId: String, renames: [String: String]) {
        let files = pending
        let chosen = decisions
        pending = []
        clashes = []
        Task { await store.upload(files, to: folderId, onConflict: .keepBoth, decisions: chosen, renames: renames) }
    }

    private func cancel() {
        for file in pending { try? FileManager.default.removeItem(at: file.url) }
        pending = []
        clashes = []
        decisions = [:]
        asking = nil
        naming = false
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
        var order: [String] = []
        var free: [String: [StagedFile]] = [:]
        var clashing: [FolderClash] = []
        var taken: [String: [String]] = [:]
        for entry in picked.files {
            guard let place = places[entry.path], let children = await listing(place.id) else {
                try? FileManager.default.removeItem(at: entry.file.url)
                continue
            }
            if taken[place.id] == nil { taken[place.id] = children.map(\.name) }
            if !order.contains(place.id) { order.append(place.id) }
            if children.contains(where: { !$0.isFolder && $0.name.caseInsensitiveCompare(entry.file.name) == .orderedSame }) {
                clashing.append(FolderClash(file: entry.file, folderId: place.id, folderName: place.name))
            } else {
                free[place.id, default: []].append(entry.file)
                taken[place.id, default: []].append(entry.file.name)
            }
        }
        let ready = order.compactMap { id in free[id].map { (id, $0) } }
        Task { for (id, files) in ready { await store.upload(files, to: id) } }
        guard !clashing.isEmpty else { return }
        folderQuestions.clashes = clashing
        folderQuestions.answers = [:]
        folderQuestions.claimed = taken
        folderQuestions.asking = clashing.first
    }

    /* One answer, or one for every file still unasked; keep both takes the next free name in that folder. */
    private func decide(_ asked: FolderClash, _ choice: DriveStore.Conflict, same: Bool) {
        let questions = folderQuestions
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
            Task { try? await Task.sleep(for: .milliseconds(350)); questions.asking = next }
            return
        }
        let answered = questions.clashes
        let answers = questions.answers
        questions.reset()
        Task {
            var seen: Set<String> = []
            for id in answered.map(\.folderId) where seen.insert(id).inserted {
                let group = answered.filter { $0.folderId == id }
                var decisions: [String: DriveStore.Conflict] = [:]
                var renames: [String: String] = [:]
                for clash in group {
                    decisions[clash.file.name] = answers[clash.id]?.choice ?? .skip
                    renames[clash.file.name] = answers[clash.id]?.name
                }
                await store.upload(group.map(\.file), to: id, onConflict: .skip, decisions: decisions, renames: renames)
            }
        }
    }

    /* Cancel adds none of the files that were asked about; the ones with free names have gone already. */
    private func cancelFolder() {
        for clash in folderQuestions.clashes { try? FileManager.default.removeItem(at: clash.file.url) }
        folderQuestions.reset()
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

/* What a picked folder still asks about: the files whose names are taken where they are going, and the answers so far. */
@MainActor @Observable
private final class FolderQuestions {
    var clashes: [FolderClash] = []
    var answers: [UUID: (choice: DriveStore.Conflict, name: String)] = [:]
    /* Names in use per destination folder, the kept-both names given so far included. */
    var claimed: [String: [String]] = [:]
    var asking: FolderClash?

    func reset() {
        clashes = []
        answers = [:]
        claimed = [:]
        asking = nil
    }
}

/* One file of a picked folder whose name its destination folder already has. */
private struct FolderClash: Identifiable {
    let id = UUID()
    let file: StagedFile
    let folderId: String
    let folderName: String
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

/* Keeping both: each clashing file gets the name it will carry, suggested free and editable. */
struct KeepBothSheet: View {
    @Environment(\.dismiss) private var dismiss
    let files: [StagedFile]
    let taken: [String]
    let done: ([String: String]) -> Void
    var cancel: () -> Void = {}
    @State private var names: [String: String] = [:]

    private var invalid: Bool {
        files.contains { file in
            let name = (names[file.name] ?? "").trimmingCharacters(in: .whitespaces)
            return name.isEmpty || taken.contains { $0.caseInsensitiveCompare(name) == .orderedSame }
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ForEach(files, id: \.name) { file in
                        VStack(alignment: .leading, spacing: 2) {
                            TextField("Name", text: Binding(get: { names[file.name] ?? "" }, set: { names[file.name] = $0 }))
                                .textInputAutocapitalization(.never).autocorrectionDisabled().foregroundStyle(Alpine.ink)
                            Text("Already here: \(file.name)").font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted)
                        }
                        .alpineRow()
                    }
                } header: {
                    Text("New names")
                } footer: {
                    Text("Each file is added under its new name. The ones already here don’t change.")
                }
            }
            .alpineGrouped()
            .navigationTitle("Keep both")
            .navigationSubtitle(Text(files.count == 1 ? "1 file" : "\(files.count) files"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss(); cancel() } }
                ToolbarItem(placement: .confirmationAction) { Button("Upload") { dismiss(); done(names) }.disabled(invalid) }
            }
        }
        .onAppear {
            var used = taken
            for file in files {
                let name = DriveStore.freeName(file.name, among: used)
                names[file.name] = name
                used.append(name)
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
