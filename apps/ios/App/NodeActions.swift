import QuickLook
import HushOSKit
import SwiftUI

/* What a context menu or swipe offers on a node; the sheets that carry them out. */
enum NodeAction: Identifiable {
    case rename(Opened)
    case move(Opened)
    case share(Opened)
    case link(Opened)
    case versions(Opened)
    case tags(Opened)
    case info(Opened)

    var id: String {
        switch self {
        case .rename(let item): return "rename-\(item.id)"
        case .move(let item): return "move-\(item.id)"
        case .share(let item): return "share-\(item.id)"
        case .link(let item): return "link-\(item.id)"
        case .versions(let item): return "versions-\(item.id)"
        case .tags(let item): return "tags-\(item.id)"
        case .info(let item): return "info-\(item.id)"
        }
    }
}

extension View {
    func nodeActions(_ item: Opened, action: Binding<NodeAction?>, store: DriveStore) -> some View {
        self
            .contextMenu {
                NodeMenu(item: item, action: action)
            }
            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                Button(role: .destructive) { Task { await store.trash(item) } } label: { Label("Trash", systemImage: "trash") }
                Button { action.wrappedValue = .rename(item) } label: { Label("Rename", systemImage: "pencil") }.tint(.orange)
                Button { action.wrappedValue = .move(item) } label: { Label("Move", systemImage: "folder") }.tint(.indigo)
            }
    }

    func nodeActionSheets(action: Binding<NodeAction?>, store: DriveStore) -> some View {
        self.sheet(item: action) { action in
            switch action {
            case .rename(let item): RenameSheet(item: item).environment(store)
            case .move(let item): MoveSheet(item: item).environment(store)
            case .share(let item): SendCopySheet(item: item).environment(store)
            case .link(let item): ShareItemSheet(item: item).environment(store)
            case .versions(let item): VersionsSheet(item: item).environment(store)
            case .tags(let item): TagsSheet(item: item).environment(store)
            case .info(let item): InfoSheet(item: item).environment(store)
            }
        }
    }
}

struct NodeMenu: View {
    @Environment(DriveStore.self) private var store
    let item: Opened
    @Binding var action: NodeAction?

    var body: some View {
        Button("Rename", systemImage: "pencil") { action = .rename(item) }
        Button("Copy", systemImage: "doc.on.doc") { store.copy([item]) }
        Button("Cut", systemImage: "scissors") { store.cut([item]) }
        Button("Move to…", systemImage: "folder") { action = .move(item) }
        Button("Share…", systemImage: "link") { action = .link(item) }
        if !item.isFolder {
            Button("Send a copy", systemImage: "square.and.arrow.up") { action = .share(item) }
            Button("Versions", systemImage: "clock.arrow.circlepath") { action = .versions(item) }
        }
        if !item.isFolder {
            let kept = Offline.isKept(item.id)
            Button(kept ? "Remove Download" : "Keep Downloaded", systemImage: kept ? "icloud.slash" : "arrow.down.circle") {
                Task { await store.setKeptDownloaded(item, !kept) }
            }
        }
        Button("Tags", systemImage: "tag") { action = .tags(item) }
        Button("Get Info", systemImage: "info.circle") { action = .info(item) }
        Divider()
        Button("Move to Trash", systemImage: "trash", role: .destructive) { Task { await store.trash(item) } }
    }
}

struct RenameSheet: View {
    @Environment(DriveStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let item: Opened
    @State private var name = ""

    var body: some View {
        NavigationStack {
            Form {
                TextField("Name", text: $name).submitLabel(.done).onSubmit(save)
            }
            .navigationTitle("Rename")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save", action: save).disabled(name.trimmingCharacters(in: .whitespaces).isEmpty) }
            }
        }
        .presentationDetents([.medium])
        .onAppear { name = item.name }
    }

    private func save() {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, trimmed != item.name else { dismiss(); return }
        dismiss()
        Task { await store.rename(item, to: trimmed) }
    }
}

/* Pick a destination folder by walking the tree from the root. */
struct MoveSheet: View {
    @Environment(DriveStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let items: [Opened]

    init(item: Opened) { items = [item] }
    init(items: [Opened]) { self.items = items }

    var body: some View {
        NavigationStack {
            Group {
                if let rootId = store.rootId, let first = items.first {
                    MoveFolderList(folderId: rootId, title: "HushOS", moving: first, excluded: Set(items.map(\.id))) { destination in
                        dismiss()
                        Task { await store.move(items, to: destination) }
                    }
                } else {
                    ProgressView()
                }
            }
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }
}

struct MoveFolderList: View {
    @Environment(DriveStore.self) private var store
    let folderId: String
    let title: String
    let moving: Opened
    var excluded: Set<String> = []
    let choose: (String) -> Void

    var body: some View {
        List {
            Section {
                Button { choose(folderId) } label: {
                    Label(folderId == moving.node.parentId ? "Already here" : "Move here", systemImage: "arrow.down.to.line")
                }
                .disabled(folderId == moving.node.parentId || folderId == moving.id)
            }
            Section {
                ForEach((store.folders[folderId] ?? []).filter { $0.isFolder && $0.id != moving.id && !excluded.contains($0.id) }) { folder in
                    NavigationLink(value: folder) { Label(folder.name, systemImage: "folder.fill") }
                }
            }
        }
        .navigationTitle(title)
        .navigationDestination(for: Opened.self) { folder in
            MoveFolderList(folderId: folder.id, title: folder.name, moving: moving, excluded: excluded, choose: choose)
        }
        .task { if store.folders[folderId] == nil { await store.refresh(folder: folderId) } }
    }
}

/* Decrypts the file, then hands it to the system share sheet. */
struct SendCopySheet: View {
    @Environment(DriveStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let item: Opened
    @State private var url: URL?

    var body: some View {
        Group {
            if let url {
                ActivityView(url: url) { dismiss() }
            } else {
                ProgressView("Decrypting…").padding()
            }
        }
        .presentationDetents([.medium, .large])
        .task {
            url = await store.download(item)
            if url == nil { dismiss() }
        }
    }
}

struct ActivityView: UIViewControllerRepresentable {
    let url: URL
    let done: () -> Void

    func makeUIViewController(context: Context) -> UIActivityViewController {
        let controller = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        controller.completionWithItemsHandler = { _, _, _, _ in done() }
        return controller
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}

struct VersionsSheet: View {
    @Environment(DriveStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let item: Opened
    @State private var versions: [VersionListView] = []
    @State private var loaded = false
    @State private var preview: URL?

    var body: some View {
        NavigationStack {
            List {
                if loaded && versions.isEmpty { Text("No versions yet.").foregroundStyle(.secondary) }
                ForEach(versions) { version in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(parseDate(version.createdAt)?.formatted(date: .abbreviated, time: .shortened) ?? version.createdAt)
                            Text(version.current ? "Current version" : (version.status == "ready" ? "Earlier version" : version.status.capitalized))
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if version.current {
                            Image(systemName: "checkmark").foregroundStyle(Color.accentColor)
                        } else if version.status == "ready" {
                            Menu {
                                Button("Preview", systemImage: "eye") { Task { preview = await store.download(item, version: version) } }
                                Button("Restore", systemImage: "arrow.uturn.backward") {
                                    dismiss()
                                    Task { await store.restoreVersion(version, of: item) }
                                }
                            } label: { Image(systemName: "ellipsis.circle") }
                        }
                    }
                }
            }
            .navigationTitle("Versions")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            .quickLookPreview($preview)
        }
        .task {
            versions = (try? await store.vault.versions(of: item.id)) ?? []
            loaded = true
        }
    }
}

struct InfoSheet: View {
    @Environment(\.dismiss) private var dismiss
    let item: Opened

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("Name", value: item.name)
                    LabeledContent("Kind", value: item.isFolder ? "Folder" : (NodeRow.type(for: item).localizedDescription ?? "File"))
                    if let size = item.size { LabeledContent("Size", value: formatBytes(Int64(size))) }
                    if let modified = item.modified { LabeledContent("Modified", value: modified.formatted(date: .long, time: .shortened)) }
                    if let created = parseDate(item.node.createdAt) { LabeledContent("Created", value: created.formatted(date: .long, time: .shortened)) }
                }
            }
            .navigationTitle("Info")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
        }
    }
}

/* Which tags an item carries: toggle the existing ones, or make a new one and apply it. */
struct TagsSheet: View {
    @Environment(DriveStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let item: Opened
    @State private var selected: Set<String> = []
    @State private var newName = ""
    @State private var loaded = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack {
                        TextField("New tag", text: $newName).submitLabel(.done).onSubmit(create)
                        Button("Add", action: create).disabled(newName.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
                Section {
                    if loaded && store.tags.tags.isEmpty {
                        Text("No tags yet. Tags group items across folders.").foregroundStyle(.secondary)
                    }
                    ForEach(store.tags.tags) { tag in
                        Button {
                            if selected.contains(tag.id) { selected.remove(tag.id) } else { selected.insert(tag.id) }
                        } label: {
                            HStack {
                                TagPill(tag: tag, selected: selected.contains(tag.id))
                                Spacer()
                                if selected.contains(tag.id) { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
                            }
                        }
                    }
                    .onDelete { offsets in
                        let ids = offsets.map { store.tags.tags[$0].id }
                        Task { await store.editTags { registry in for id in ids { registry.remove(id) } } }
                    }
                }
            }
            .navigationTitle(item.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        let ids = Array(selected)
                        let nodeId = item.id
                        dismiss()
                        Task { await store.editTags { registry in try registry.assign(nodeId, tagIds: ids) } }
                    }
                }
            }
        }
        .task {
            await store.refreshTags()
            selected = Set(store.tags.tags(of: item.id).map(\.id))
            loaded = true
        }
    }

    private func create() {
        let name = newName
        guard !name.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        newName = ""
        Task {
            await store.editTags { registry in _ = try registry.add(name: name) }
            if let created = store.tags.tags.first(where: { $0.name.caseInsensitiveCompare(name.trimmingCharacters(in: .whitespaces)) == .orderedSame }) {
                selected.insert(created.id)
            }
        }
    }
}

/* Paper's tag colours: the presets, or the hex a person picked here or on the web. */
enum TagColour {
    static func hex(_ color: Color) -> String {
        let components = UIColor(color).cgColor.components ?? [0, 0, 0]
        let r = components.count > 0 ? components[0] : 0
        let g = components.count > 1 ? components[1] : r
        let b = components.count > 2 ? components[2] : r
        return String(format: "#%02x%02x%02x", Int(round(r * 255)), Int(round(g * 255)), Int(round(b * 255)))
    }

    static func swiftUI(_ value: String) -> Color {
        switch value {
        case "blue": return Color(red: 0.173, green: 0.259, blue: 0.557)
        case "ink": return Color(red: 0.110, green: 0.157, blue: 0.282)
        case "yellow": return Color(red: 0.788, green: 0.635, blue: 0.153)
        case "teal": return Color(red: 0.165, green: 0.498, blue: 0.498)
        case "coral": return Color(red: 0.851, green: 0.388, blue: 0.290)
        default:
            let hex = value.dropFirst()
            guard hex.count == 6, let number = UInt32(hex, radix: 16) else { return .secondary }
            return Color(red: Double((number >> 16) & 0xff) / 255, green: Double((number >> 8) & 0xff) / 255, blue: Double(number & 0xff) / 255)
        }
    }
}
