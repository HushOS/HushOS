import QuickLook
import HushOSKit
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/* The tree: the root folder, each folder pushing the next, with the actions a cloud drive offers. */
struct BrowseView: View {
    @Environment(DriveStore.self) private var store
    @State private var rootId: String?

    var body: some View {
        NavigationStack {
            Group {
                if let rootId {
                    FolderView(folderId: rootId, title: "Files", isRoot: true)
                } else {
                    ProgressView()
                }
            }
        }
        .task { rootId = await store.loadRoot() }
    }
}

struct FolderView: View {
    @Environment(DriveStore.self) private var store
    let folderId: String
    let title: String
    var isRoot = false
    @State private var loaded = false
    @State private var newFolderName = ""
    @State private var showingNewFolder = false
    @State private var showingImporter = false
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var showingPhotos = false
    @State private var action: NodeAction?
    @State private var preview: URL?
    // How this drive's lists are ordered, kept across launches; folders always come first.
    @AppStorage("files.sortKey") private var sortKey = SortKey.name
    @AppStorage("files.sortAscending") private var sortAscending = true
    @State private var query = ""
    @State private var tagFilter: String?
    @State private var pendingUploads: [(url: URL, name: String, type: UTType?)] = []
    @State private var askingConflict = false
    @State private var renamingKeptBoth = false
    @State private var selecting = false
    @State private var selection: Set<String> = []
    @State private var movingMany = false

    private var selectedItems: [Opened] { children.filter { selection.contains($0.id) } }

    /* The active tag when it is what empties the list: the folder has items, none carry it. */
    private var filteredOutTag: Tag? {
        guard let tagFilter, let items = store.folders[folderId], !items.isEmpty else { return nil }
        return store.tags.tags.first { $0.id == tagFilter }
    }

    private var children: [Opened] {
        let needle = query.trimmingCharacters(in: .whitespaces)
        var items: [Opened]
        if !needle.isEmpty {
            items = store.everything.filter { $0.name.localizedCaseInsensitiveContains(needle) }.sorted(by: Opened.byName)
        } else {
            items = sortKey.sort(store.folders[folderId] ?? [], ascending: sortAscending)
        }
        if let tagFilter { items = items.filter { store.tags.nodes(with: tagFilter).contains($0.id) } }
        return items
    }

    /* What can be added here: new folder, files, photos, and a paste while the clipboard holds items. */
    @ViewBuilder private var addItems: some View {
        if let clip = store.clipboard, let first = clip.items.first, store.canPaste(into: folderId) {
            Button(clip.items.count > 1 ? "Paste \(clip.items.count) items" : "Paste \(first.name)", systemImage: clip.cut ? "scissors" : "doc.on.clipboard") { Task { await store.paste(into: folderId) } }
            Divider()
        }
        Button("New Folder", systemImage: "folder.badge.plus") { newFolderName = ""; showingNewFolder = true }
        Button("Upload Files", systemImage: "doc.badge.plus") { showingImporter = true }
        // A picker inside a menu never presents; a button and a modifier do.
        Button("Upload Photos", systemImage: "photo.badge.plus") { showingPhotos = true }
    }

    var body: some View {
        List {
            if !loaded && store.folders[folderId] == nil {
                HStack { Spacer(); ProgressView(); Spacer() }.listRowBackground(Color.clear)
            }
            if loaded && children.isEmpty {
                // A filter that hides everything says so, rather than calling a full folder empty.
                Group {
                    if let tag = filteredOutTag {
                        ContentUnavailableView("Nothing tagged \(tag.name)", systemImage: "line.3.horizontal.decrease", description: Text("Nothing in this folder carries this tag."))
                    } else {
                        ContentUnavailableView("Nothing here yet", systemImage: "folder", description: Text("Add files from the button above, or from the Files app."))
                    }
                }
                .listRowBackground(Color.clear)
            }
            Section {
                ForEach(children) { item in
                    if selecting {
                        // Our own selection rows: List's edit-mode selection never took taps here.
                        Button {
                            if selection.contains(item.id) { selection.remove(item.id) } else { selection.insert(item.id) }
                        } label: {
                            HStack(spacing: 12) {
                                Image(systemName: selection.contains(item.id) ? "checkmark.circle.fill" : "circle")
                                    .font(.title3)
                                    .foregroundStyle(selection.contains(item.id) ? Color.accentColor : Color.secondary)
                                NodeRow(item: item)
                            }
                        }
                        .buttonStyle(.plain)
                    } else if item.isFolder {
                        NavigationLink(value: item) { NodeRow(item: item) }
                            .nodeActions(item, action: $action, store: store)
                    } else {
                        Button { open(item) } label: { NodeRow(item: item) }
                            .buttonStyle(.plain)
                            .nodeActions(item, action: $action, store: store)
                    }
                }
            } header: {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 16) {
                        if isRoot { Text("Files").font(.title.weight(.bold)).foregroundStyle(Color(.label)).textCase(nil) }
                        Spacer()
                        if selecting {
                            Button("Done") { selecting = false; selection = [] }
                                .font(.subheadline.weight(.semibold)).textCase(nil)
                        } else {
                            // Two round buttons, as Files has them: add, and everything about how the list is shown.
                            HStack(spacing: 0) {
                                Menu { addItems } label: { Image(systemName: "plus").frame(width: 44, height: 44) }
                                    .accessibilityLabel("Add")
                                Menu {
                                    Button("Select", systemImage: "checkmark.circle") { selecting = true }
                                    Section("Sort by") {
                                        ForEach(SortKey.allCases, id: \.self) { key in
                                            Button {
                                                if sortKey == key { sortAscending.toggle() } else { sortKey = key; sortAscending = key == .name }
                                            } label: {
                                                if sortKey == key { Label(key.label, systemImage: sortAscending ? "arrow.up" : "arrow.down") } else { Text(key.label) }
                                            }
                                        }
                                    }
                                    Section("Tag") {
                                        // Only the tags this folder's items carry.
                                        let here = Set((store.folders[folderId] ?? []).map(\.id))
                                        let folderTags = store.tags.tags.filter { tag in !here.isDisjoint(with: store.tags.nodes(with: tag.id)) }
                                        if folderTags.isEmpty { Text("No tags in this folder") }
                                        ForEach(folderTags) { tag in
                                            Button {
                                                tagFilter = tagFilter == tag.id ? nil : tag.id
                                            } label: {
                                                if tagFilter == tag.id { Label(tag.name, systemImage: "checkmark") } else { Text(tag.name) }
                                            }
                                        }
                                    }
                                } label: {
                                    // A filter in force shows here too, besides the line above the rows.
                                    Image(systemName: tagFilter == nil ? "ellipsis" : "line.3.horizontal.decrease").frame(width: 44, height: 44)
                                }
                                .accessibilityLabel("More")
                            }
                            .font(.body.weight(.semibold)).textCase(nil)
                            .glassEffect(.regular.interactive(), in: .capsule)
                        }
                    }
                    HStack(spacing: 8) {
                        Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                        TextField(isRoot ? "Search in HushOS" : "Search in \(title)", text: $query)
                            .textInputAutocapitalization(.never).autocorrectionDisabled().textCase(nil)
                        if !query.isEmpty {
                            Button { query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }.buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, 14).padding(.vertical, 11)
                    .glassEffect(.regular, in: .capsule)
                    if let tag = store.tags.tags.first(where: { $0.id == tagFilter }) {
                        // The filter says so where the rows are, so a shorter list never looks like missing files.
                        HStack(spacing: 8) {
                            Text("Filtered by").font(.subheadline).foregroundStyle(.secondary).textCase(nil)
                            TagPill(tag: tag, selected: true)
                            Spacer()
                            Button("Clear") { tagFilter = nil }.font(.subheadline).textCase(nil)
                        }
                    }
                }
                .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 8, trailing: 0))
            }
        }
        .listStyle(.insetGrouped)
        .contentMargins(.top, isRoot ? 0 : 12, for: .scrollContent)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(isRoot ? .hidden : .visible, for: .navigationBar)
        .navigationDestination(for: Opened.self) { folder in
            FolderView(folderId: folder.id, title: folder.name)
        }
        .refreshable { await store.refresh(folder: folderId) }
        .overlay(alignment: .bottomLeading) {
            // Something on the clipboard: say so where it can be pasted, not only inside the add menu.
            if !selecting, let clip = store.clipboard, let first = clip.items.first {
                HStack(spacing: 12) {
                    Button {
                        Task { await store.paste(into: folderId) }
                    } label: {
                        Label(store.pasteProblem(into: folderId)
                              ?? (clip.items.count > 1 ? "Paste \(clip.items.count) items here" : "Paste \(first.name) here"),
                              systemImage: clip.cut ? "scissors" : "doc.on.clipboard")
                            .lineLimit(1)
                    }
                    .disabled(!store.canPaste(into: folderId))
                    Button { store.clipboard = nil } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
                        .buttonStyle(.plain)
                }
                .font(.subheadline.weight(.medium))
                .padding(.horizontal, 16).padding(.vertical, 12)
                .glassEffect(.regular, in: .capsule)
                .padding(.horizontal, 16).padding(.bottom, 24)
            }
        }
        .overlay(alignment: .bottom) {
            if selecting {
                // Everything selected at once: the bar the drives show while selecting.
                HStack(spacing: 18) {
                    Text("\(selection.count) selected").font(.footnote).foregroundStyle(.secondary)
                    Spacer()
                    Button { store.copy(selectedItems); selecting = false; selection = [] } label: { Image(systemName: "doc.on.doc") }
                    Button { store.cut(selectedItems); selecting = false; selection = [] } label: { Image(systemName: "scissors") }
                    Button { movingMany = true } label: { Image(systemName: "folder") }
                    Button(role: .destructive) {
                        let items = selectedItems
                        selecting = false
                        selection = []
                        Task { await store.trash(items) }
                    } label: { Image(systemName: "trash") }
                }
                .font(.title3)
                .disabled(selection.isEmpty)
                .padding(.horizontal, 20).padding(.vertical, 12)
                .glassEffect(.regular, in: .capsule)
                .padding(.horizontal, 16).padding(.bottom, 16)
            }
        }
        .sheet(isPresented: $movingMany) {
            MoveSheet(items: selectedItems).environment(store)
                .onDisappear { selecting = false; selection = [] }
        }
        .alert("New Folder", isPresented: $showingNewFolder) {
            TextField("Name", text: $newFolderName)
            Button("Cancel", role: .cancel) {}
            Button("Create") {
                let name = newFolderName.trimmingCharacters(in: .whitespaces)
                guard !name.isEmpty else { return }
                Task { await store.createFolder(named: name, in: folderId) }
            }
        }
        .photosPicker(isPresented: $showingPhotos, selection: $photoItems, matching: .any(of: [.images, .videos]))
        .fileImporter(isPresented: $showingImporter, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result else { return }
            queue(urls.compactMap(Self.stage))
        }
        .confirmationDialog(conflictTitle, isPresented: $askingConflict, titleVisibility: .visible) {
            Button("Replace (keep as new version)") { Task { await store.upload(pendingUploads, to: folderId, onConflict: .replace) } }
            Button("Keep both…") { renamingKeptBoth = true }
            Button("Skip those") { Task { await store.upload(pendingUploads, to: folderId, onConflict: .skip) } }
            Button("Cancel", role: .cancel) { for file in pendingUploads { try? FileManager.default.removeItem(at: file.url) }; pendingUploads = [] }
        } message: {
            Text("Replacing keeps the earlier version under Versions.")
        }
        .sheet(isPresented: $renamingKeptBoth) {
            KeepBothSheet(files: pendingUploads, taken: (store.folders[folderId] ?? []).map(\.name)) { renames in
                Task { await store.upload(pendingUploads, to: folderId, onConflict: .keepBoth, renames: renames) }
            }
        }
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            photoItems = []
            Task {
                var staged: [(url: URL, name: String, type: UTType?)] = []
                for item in items {
                    guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
                    let type = item.supportedContentTypes.first
                    let name = "\(Date().formatted(.iso8601.year().month().day().dateSeparator(.dash)))-\(UUID().uuidString.prefix(6)).\(type?.preferredFilenameExtension ?? "bin")"
                    let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathComponent(name)
                    try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                    guard (try? data.write(to: url)) != nil else { continue }
                    staged.append((url, name, type))
                }
                queue(staged)
            }
        }
        .nodeActionSheets(action: $action, store: store)
        .quickLookPreview($preview)
        .task {
            if store.folders[folderId] == nil { await store.refresh(folder: folderId) }
            if store.tags.tags.isEmpty { await store.refreshTags() }
            loaded = true
        }
    }

    private var conflictTitle: String {
        let clashes = store.conflicts(pendingUploads, in: folderId)
        return clashes.count == 1 ? "“\(clashes[0].name)” already exists here" : "\(clashes.count) of these already exist here"
    }

    /* Ask about name clashes first, as the web does; otherwise upload straight away. */
    private func queue(_ files: [(url: URL, name: String, type: UTType?)]) {
        guard !files.isEmpty else { return }
        if store.conflicts(files, in: folderId).isEmpty {
            Task { await store.upload(files, to: folderId) }
        } else {
            pendingUploads = files
            askingConflict = true
        }
    }

    private func open(_ item: Opened) {
        Task { preview = await store.download(item) }
    }

    /* A security-scoped file copied into our temp directory so the upload can read it at leisure. */
    static func stage(_ url: URL) -> (url: URL, name: String, type: UTType?)? {
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
}

/* Keeping both: each clashing file gets the name it will carry, suggested free and editable. */
struct KeepBothSheet: View {
    @Environment(\.dismiss) private var dismiss
    let files: [(url: URL, name: String, type: UTType?)]
    let taken: [String]
    let done: ([String: String]) -> Void
    @State private var names: [String: String] = [:]

    private var clashing: [String] {
        let lower = Set(taken.map { $0.lowercased() })
        return files.map(\.name).filter { lower.contains($0.lowercased()) }
    }

    var body: some View {
        NavigationStack {
            Form {
                ForEach(clashing, id: \.self) { original in
                    Section {
                        TextField("Name", text: Binding(get: { names[original] ?? "" }, set: { names[original] = $0 }))
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                    } header: {
                        Text(original)
                    }
                }
            }
            .navigationTitle("Keep both")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Upload") { dismiss(); done(names) }
                        .disabled(clashing.contains { original in
                            let name = (names[original] ?? "").trimmingCharacters(in: .whitespaces)
                            return name.isEmpty || taken.contains { $0.caseInsensitiveCompare(name) == .orderedSame }
                        })
                }
            }
        }
        .onAppear { for name in clashing { names[name] = DriveStore.freeName(name, among: taken) } }
    }
}

/* What a folder list is ordered by. Folders come first whichever key is chosen, as every drive does it. */
enum SortKey: String, CaseIterable {
    case name, modified, size

    var label: String {
        switch self {
        case .name: return "Name"
        case .modified: return "Modified"
        case .size: return "Size"
        }
    }

    func sort(_ items: [Opened], ascending: Bool) -> [Opened] {
        items.sorted { a, b in
            if a.isFolder != b.isFolder { return a.isFolder }
            let before: Bool
            switch self {
            case .name:
                let order = a.name.localizedStandardCompare(b.name)
                if order == .orderedSame { return a.id < b.id }
                before = order == .orderedAscending
            case .modified:
                let x = a.modified ?? .distantPast, y = b.modified ?? .distantPast
                if x == y { return Opened.byName(a, b) }
                before = x < y
            case .size:
                let x = a.size ?? 0, y = b.size ?? 0
                if x == y { return Opened.byName(a, b) }
                before = x < y
            }
            return ascending ? before : !before
        }
    }
}
