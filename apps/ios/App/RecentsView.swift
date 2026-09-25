import HushOSKit
import QuickLook
import SwiftUI
import UniformTypeIdentifiers

/* What a row can be filtered to, as the drives do it: a type, not a folder. */
enum HomeFilter: String, CaseIterable, Identifiable {
    case all = "All", folders = "Folders", images = "Images", videos = "Videos", documents = "Documents"
    var id: String { rawValue }

    func matches(_ item: Opened) -> Bool {
        switch self {
        case .all: return true
        case .folders: return item.isFolder
        case .images: return !item.isFolder && NodeRow.type(for: item).conforms(to: .image)
        case .videos: return !item.isFolder && NodeRow.type(for: item).conforms(to: .movie)
        case .documents:
            let type = NodeRow.type(for: item)
            return !item.isFolder && (type.conforms(to: .pdf) || type.conforms(to: .text) || type.conforms(to: .presentation) || type.conforms(to: .spreadsheet))
        }
    }
}

/*
 * Home: the search pill first, then type chips, then what changed most
 * recently across every folder. The layout of a cloud drive, not of Files.
 */
struct HomeView: View {
    @Environment(DriveStore.self) private var store
    @State private var loaded = false
    @State private var query = ""
    @State private var filter: HomeFilter = .all
    @State private var tagFilter: String?
    @State private var tagged: [Opened] = []
    @State private var managingTags = false
    @State private var action: NodeAction?
    @State private var preview: URL?
    /* The opened items behind the Offline rows, so each gets the full menu. */
    @State private var offlineItems: [String: Opened] = [:]
    @FocusState private var searching: Bool

    private var rows: [Opened] {
        let needle = query.trimmingCharacters(in: .whitespaces)
        let base: [Opened]
        if tagFilter != nil { base = tagged.filter { needle.isEmpty || $0.name.localizedCaseInsensitiveContains(needle) } }
        else if needle.isEmpty { base = store.recents }
        else { base = store.everything.filter { $0.name.localizedCaseInsensitiveContains(needle) }.sorted(by: Opened.byName) }
        return base.filter(filter.matches)
    }

    private var heading: String {
        if let tagFilter, let tag = store.tags.tags.first(where: { $0.id == tagFilter }) { return tag.name }
        return query.isEmpty ? "Recent" : "Results"
    }

    var body: some View {
        NavigationStack {
            List {
                if showOffline {
                    // Kept files first, the way Dropbox lists Offline on Home: they open without the network.
                    Section {
                        ForEach(offline) { entry in
                            // The same menu as any other row: a kept file is still a file. One the tree has not opened
                            // on this device can at least drop its download.
                            if let item = offlineItems[entry.id] {
                                offlineRow(entry).nodeActions(item, action: $action, store: store)
                            } else {
                                offlineRow(entry).contextMenu {
                                    Button("Remove Download", systemImage: "icloud.slash", role: .destructive) { Offline.forget(entry.id); store.offlineVersion += 1 }
                                }
                            }
                        }
                    } header: {
                        VStack(alignment: .leading, spacing: 12) {
                            homeHeader
                            sectionTitle("Offline")
                        }
                        .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 8, trailing: 0))
                    }
                }
                Section {
                    ForEach(rows) { item in row(item) }
                } header: {
                    VStack(alignment: .leading, spacing: 12) {
                        if !showOffline { homeHeader }
                        sectionTitle(heading)
                    }
                    .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 8, trailing: 0))
                }
                if loaded && rows.isEmpty {
                    ContentUnavailableView(
                        query.isEmpty ? "Nothing here yet" : "No results",
                        systemImage: query.isEmpty ? "clock" : "magnifyingglass",
                        description: Text(query.isEmpty ? "Files you add or change show up here." : "Search covers the folders you have opened.")
                    )
                    .listRowBackground(Color.clear)
                }
            }
            .listStyle(.insetGrouped)
            // The heading is drawn in the list like Files' own, so the two tabs start at the same height.
            .toolbar(.hidden, for: .navigationBar)
            .refreshable { await store.refreshRecents() }
            .nodeActionSheets(action: $action, store: store)
            .quickLookPreview($preview)
            .sheet(isPresented: $managingTags) { TagManagerSheet().environment(store) }
            .task(id: "\(store.offlineVersion)-\(store.catalogueVersion)") {
                var found: [String: Opened] = [:]
                for entry in offline { if let item = await store.vault.openedItem(entry.id) { found[entry.id] = item } }
                offlineItems = found
            }
            .task {
                _ = await store.loadRoot()
                await store.refreshRecents()
                await store.refreshTags()
                loaded = true
            }
        }
    }

    private func offlineRow(_ entry: Offline.Entry) -> some View {
        Button {
            if let item = offlineItems[entry.id] ?? store.everything.first(where: { $0.id == entry.id }) { open(item) }
            else { preview = Offline.file(for: entry) }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "arrow.down.circle.fill").font(.title2).foregroundStyle(Color.accentColor).frame(width: 40, height: 40)
                VStack(alignment: .leading, spacing: 2) {
                    Text(entry.name).lineLimit(1)
                    Text(entry.size.map { formatBytes(Int64($0)) } ?? "Kept downloaded")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
        }
        .buttonStyle(.plain)
        .swipeActions { Button("Remove", role: .destructive) { Offline.forget(entry.id); store.offlineVersion += 1 } }
    }

    private var offline: [Offline.Entry] {
        _ = store.offlineVersion
        return Offline.entries()
    }

    private var showOffline: Bool { query.isEmpty && tagFilter == nil && !offline.isEmpty }

    private func sectionTitle(_ text: String) -> some View {
        Text(text).font(.title3.weight(.semibold)).foregroundStyle(Color(.label)).textCase(nil).padding(.top, 4)
    }

    private var homeHeader: some View {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Home").font(.title.weight(.bold)).foregroundStyle(Color(.label)).textCase(nil)
                        HStack(spacing: 8) {
                            Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                            TextField("Search in HushOS", text: $query)
                                .textInputAutocapitalization(.never).autocorrectionDisabled().focused($searching)
                            if !query.isEmpty {
                                Button { query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
                                    .buttonStyle(.plain)
                            }
                        }
                        .padding(.horizontal, 14).padding(.vertical, 11)
                        .glassEffect(.regular, in: .capsule)
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) {
                                ForEach(HomeFilter.allCases) { option in
                                    Button(option.rawValue) { filter = option }
                                        .buttonStyle(.bordered)
                                        .tint(filter == option ? Color.accentColor : Color.secondary)
                                        .controlSize(.small)
                                }
                            }
                        }
                        HStack(spacing: 8) {
                            Text("Tags").font(.subheadline.weight(.semibold))
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 6) {
                                    ForEach(store.tags.tags) { tag in
                                        Button {
                                            tagFilter = tagFilter == tag.id ? nil : tag.id
                                            Task { tagged = tagFilter == nil ? [] : await store.items(tagged: tag.id) }
                                        } label: {
                                            TagPill(tag: tag, selected: tagFilter == tag.id)
                                        }
                                        .buttonStyle(.plain)
                                    }
                                    if store.tags.tags.isEmpty {
                                        Text("None yet").font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                            }
                            Button("Manage") { managingTags = true }.font(.footnote)
                        }
                    }
    }

    private func open(_ item: Opened) {
        if !item.isFolder { Task { preview = await store.download(item) } }
    }

    private func row(_ item: Opened) -> some View {
        Button {
            if !item.isFolder { Task { preview = await store.download(item) } }
        } label: { NodeRow(item: item) }
        .buttonStyle(.plain)
        .nodeActions(item, action: $action, store: store)
    }
}

/* Shared: what other people gave this account, each opened with the identity keys and browsable like a folder. */
struct SharedView: View {
    @Environment(DriveStore.self) private var store
    @State private var mounts: [ShareMount] = []
    @State private var loaded = false
    @State private var failure: String?
    @State private var linkText = ""
    @State private var openingLink: String?
    @State private var reporting: Opened?
    @State private var showingContacts = false
    @State private var byMe = false
    @State private var mine: [SharedByMe] = []
    @State private var managing: Opened?

    var body: some View {
        NavigationStack {
            List {
                if byMe {
                    Section {
                    if loaded && mine.isEmpty { Text("You have not shared anything yet. Long-press an item and choose Share.").foregroundStyle(.secondary).listRowInsets(EdgeInsets(top: 11, leading: 20, bottom: 11, trailing: 20)) }
                    ForEach(mine) { row in
                        Button {
                            if let item = row.item { managing = item }
                        } label: {
                            HStack(spacing: 12) {
                                Image(systemName: row.link != nil ? "link" : "person.crop.circle")
                                    .font(.title3).foregroundStyle(Color.accentColor).frame(width: 40, height: 40)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(row.item?.name ?? "Item outside this workspace").lineLimit(1)
                                    Text(describe(row)).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                        .listRowInsets(EdgeInsets(top: 11, leading: 20, bottom: 11, trailing: 20))
                    }
                    } header: { sharedHeader }
                    .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 8, trailing: 0))
                } else {
                Section {
                    HStack {
                        TextField("Paste a HushOS link", text: $linkText).textInputAutocapitalization(.never).autocorrectionDisabled()
                        Button("Open") { openingLink = linkText.trimmingCharacters(in: .whitespacesAndNewlines) }
                            .disabled(!linkText.contains("/s/"))
                    }
                    .listRowInsets(EdgeInsets(top: 11, leading: 20, bottom: 11, trailing: 20))
                } header: {
                    sharedHeader
                }
                .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 8, trailing: 0))
                if loaded && mounts.isEmpty && failure == nil {
                    ContentUnavailableView("Nothing shared with you", systemImage: "person.2", description: Text("Folders and files others share with you appear here."))
                        .listRowBackground(Color.clear)
                }
                if let failure { Text(failure).foregroundStyle(.secondary) }
                if !byMe { ForEach(mounts) { mount in
                    if let root = mount.root {
                        NavigationLink(value: root) {
                            HStack(spacing: 12) {
                                Image(systemName: root.isFolder ? "folder.fill.badge.person.crop" : "doc")
                                    .font(.title2).foregroundStyle(Color.accentColor).frame(width: 40, height: 40)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(root.name).lineLimit(1)
                                    Text("From \(mount.share.granter.name.isEmpty ? mount.share.granter.email : mount.share.granter.name) · \(mount.share.role.capitalized)")
                                        .font(.footnote).foregroundStyle(.secondary).lineLimit(1)
                                }
                            }
                        }
                        .contextMenu {
                            Button("Report…", systemImage: "flag") { reporting = root }
                        }
                    } else {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("From \(mount.share.granter.name.isEmpty ? mount.share.granter.email : mount.share.granter.name)")
                            Text(mount.error ?? "This share could not be opened.").font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                } }
                }
            }
            .listStyle(.insetGrouped)
            .contentMargins(.top, 0, for: .scrollContent)
            .navigationTitle("Shared")
            .toolbar(.hidden, for: .navigationBar)
            .sheet(isPresented: $showingContacts) { ContactsView().environment(store) }
            .sheet(item: $managing, onDismiss: { Task { await load() } }) { item in ShareItemSheet(item: item).environment(store) }
            .onChange(of: byMe) { _, _ in Task { await load() } }
            .navigationDestination(for: Opened.self) { folder in
                FolderView(folderId: folder.id, title: folder.name)
            }
            .navigationDestination(item: $openingLink) { url in
                LinkBrowserView(url: url)
            }
            .sheet(item: $reporting) { item in
                ReportSheet(item: item) { category, reason, email in
                    try await store.vault.report(item, category: category, reason: reason, email: email)
                }
            }
            .refreshable { await load() }
            .task { await load() }
        }
    }

    private var sharedHeader: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Shared").font(.title.weight(.bold)).foregroundStyle(Color(.label)).textCase(nil)
                Spacer()
                Button { showingContacts = true } label: { Image(systemName: "person.crop.circle.badge.checkmark").font(.title3) }
            }
            Picker("Which", selection: $byMe) {
                Text("With me").tag(false)
                Text("By me").tag(true)
            }
            .pickerStyle(.segmented)
        }
        .padding(.bottom, 4)
    }

    private func describe(_ row: SharedByMe) -> String {
        if let share = row.share {
            return "With \(share.grantee.name.isEmpty ? share.grantee.email : share.grantee.name) · \(share.role == "editor" ? "can edit" : "can view")"
        }
        if let link = row.link {
            return "Link · " + (link.useCount == 1 ? "opened once" : "opened \(link.useCount) times") + (link.hasPassword ? " · password" : "")
        }
        return ""
    }

    private func load() async {
        do {
            if byMe { mine = try await store.vault.sharedByMe() } else { mounts = try await store.vault.mountShares() }
            failure = nil
        } catch {
            failure = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
        loaded = true
    }
}

struct TrashView: View {
    @Environment(DriveStore.self) private var store
    @State private var loaded = false
    @State private var confirmEmpty = false

    var body: some View {
        List {
            if loaded && store.trash.isEmpty {
                ContentUnavailableView("Trash is empty", systemImage: "trash", description: Text("Items you delete stay here until you remove them."))
                    .listRowBackground(Color.clear)
            }
            ForEach(store.trash, id: \.item.id) { entry in
                // Mid-way through a restore or delete, or while the whole trash empties, a row takes no second action.
                let working = store.emptyingTrash || store.trashWorking.contains(entry.item.id)
                NodeRow(item: entry.item, note: parseDate(entry.item.node.trashedAt).map { "Trashed \($0.formatted(date: .abbreviated, time: .omitted))" }, working: working)
                    .disabled(working)
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) { Task { await store.purge(entry.item) } } label: { Label("Delete", systemImage: "trash.slash") }
                        Button { Task { await store.restore(entry.item, parentTrashed: entry.parentTrashed) } } label: { Label("Restore", systemImage: "arrow.uturn.backward") }.tint(.green)
                    }
                    .contextMenu {
                        Button("Restore", systemImage: "arrow.uturn.backward") { Task { await store.restore(entry.item, parentTrashed: entry.parentTrashed) } }
                        Button("Delete Now", systemImage: "trash.slash", role: .destructive) { Task { await store.purge(entry.item) } }
                    }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Trash")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable {
            // A pull asks the server: the catalogue alone may not know yet.
            await store.sync()
            await store.refreshTrash()
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                if store.emptyingTrash {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Emptying…").font(.subheadline)
                    }
                } else {
                    Button("Empty", role: .destructive) { confirmEmpty = true }.disabled(store.trash.isEmpty)
                }
            }
        }
        .confirmationDialog("Empty the trash?", isPresented: $confirmEmpty, titleVisibility: .visible) {
            Button("Delete \(store.trash.count) items forever", role: .destructive) { Task { await store.emptyTrash() } }
        } message: {
            Text("This cannot be undone.")
        }
        .task {
            await store.refreshTrash()
            loaded = true
        }
    }
}

/* Every tag in the workspace: rename, recolour, delete, and how many items each names. */
struct TagManagerSheet: View {
    @Environment(DriveStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var newName = ""
    @State private var renaming: Tag?
    @State private var renameDraft = ""
    @State private var picking: Tag?
    @State private var custom: Color = .blue

    var body: some View {
        NavigationStack {
            List {
                if let tag = picking {
                    Section {
                        ColorPicker("Colour for \(tag.name)", selection: $custom, supportsOpacity: false)
                        Button("Apply") {
                            let hex = TagColour.hex(custom)
                            picking = nil
                            Task { await store.editTags { registry in registry.recolour(tag.id, to: hex) } }
                        }
                    }
                }
                Section {
                    HStack {
                        TextField("New tag", text: $newName).submitLabel(.done).onSubmit(create)
                        Button("Add", action: create).disabled(newName.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
                Section {
                    if store.tags.tags.isEmpty { Text("No tags yet. Tags group items across folders.").foregroundStyle(.secondary) }
                    ForEach(store.tags.tags) { tag in
                        HStack(spacing: 12) {
                            Menu {
                                ForEach(TagRegistry.presets, id: \.self) { preset in
                                    Button(preset.capitalized) { Task { await store.editTags { registry in registry.recolour(tag.id, to: preset) } } }
                                }
                                Divider()
                                Button("Custom colour…", systemImage: "paintpalette") { picking = tag; custom = TagColour.swiftUI(tag.colour) }
                            } label: {
                                Circle().fill(TagColour.swiftUI(tag.colour)).frame(width: 18, height: 18)
                            }
                            Text(tag.name)
                            Spacer()
                            Text("\(store.tags.nodes(with: tag.id).count)").foregroundStyle(.secondary).font(.footnote)
                        }
                        .contentShape(Rectangle())
                        .onTapGesture { renameDraft = tag.name; renaming = tag }
                        .swipeActions {
                            Button(role: .destructive) { Task { await store.editTags { registry in registry.remove(tag.id) } } } label: { Label("Delete", systemImage: "trash") }
                            Button { renameDraft = tag.name; renaming = tag } label: { Label("Rename", systemImage: "pencil") }.tint(.orange)
                        }
                    }
                } footer: {
                    Text("Tap a colour for the presets or a custom colour, a name to rename it. Tags live in a sealed workspace document, so people you share with never see them.")
                }
            }
            .navigationTitle("Tags")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            .alert("Rename tag", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
                TextField("Name", text: $renameDraft)
                Button("Cancel", role: .cancel) { renaming = nil }
                Button("Save") {
                    guard let tag = renaming else { return }
                    let name = renameDraft
                    renaming = nil
                    Task { await store.editTags { registry in try registry.rename(tag.id, to: name) } }
                }
            }
        }
        .task { await store.refreshTags() }
    }

    private func create() {
        let name = newName
        guard !name.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        newName = ""
        Task { await store.editTags { registry in _ = try registry.add(name: name) } }
    }
}
