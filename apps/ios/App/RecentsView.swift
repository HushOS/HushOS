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
 * Home: the title with Add (into the top folder), what is on this phone, then
 * Recent with its type chips and, once a tag exists, the tags row. A folder in
 * Recent opens on top of Home. Search and Account have their own tabs.
 */
struct HomeView: View {
    @Environment(DriveStore.self) private var store
    @State private var loaded = false
    @State private var filter: HomeFilter = .all
    @State private var tagFilter: String?
    @State private var tagged: [Opened] = []
    @State private var managingTags = false
    @State private var action: NodeAction?
    @State private var viewing: Opened?
    @State private var showingImporter = false
    @State private var showingPhone = false
    @State private var showingPhotos = false
    @State private var showingCamera = false

    private var rows: [Opened] {
        (tagFilter != nil ? tagged : store.recents).filter(filter.matches)
    }

    private var heading: String {
        if let tagFilter, let tag = store.tags.tags.first(where: { $0.id == tagFilter }) { return tag.name }
        return filter == .all ? "Recent" : "Recent \(filter.rawValue.lowercased())"
    }

    private var kept: [Offline.Entry] {
        _ = store.offlineVersion
        return Offline.entries()
    }

    /* A brand-new account: nothing recent, nothing in the top folder, no tags, nothing kept. */
    private var firstRun: Bool {
        guard loaded, store.recents.isEmpty, store.tags.tags.isEmpty, kept.isEmpty, Offline.keptFolders().isEmpty, let root = store.rootId else { return false }
        return store.folders[root]?.isEmpty == true
    }

    var body: some View {
        NavigationStack {
            List {
                if firstRun {
                    Section {
                        EmptyStateView(symbol: "doc.badge.plus", title: "Nothing here yet", message: "Files you add or change show up here.") {
                            VStack(spacing: Alpine.Space.s2) {
                                Button { showingImporter = true } label: { Label("Upload files", systemImage: "doc.badge.plus").frame(maxWidth: .infinity) }
                                    .buttonStyle(PrimaryCapsuleStyle())
                                Button { showingPhotos = true } label: { Label("Upload photos", systemImage: "photo").frame(maxWidth: .infinity) }
                                    .buttonStyle(SecondaryCapsuleStyle())
                            }
                            .frame(maxWidth: 280)
                        }
                        .bareRow(top: Alpine.Space.s8)
                    } header: {
                        top
                    }
                } else {
                    Section {
                        NavigationLink { OnThisPhoneView() } label: { onThisPhone }.itemRow()
                    } header: {
                        top
                    }
                    Section {
                        ForEach(rows) { item in row(item) }
                        if loaded && rows.isEmpty { emptyRecent.bareRow(top: Alpine.Space.s4) }
                    } header: {
                        recentHeader
                    }
                }
            }
            .listStyle(.insetGrouped)
            .alpineGrouped()
            .environment(\.defaultMinListRowHeight, 1) // Item rows set their own 56pt; furniture rows keep their own height.
            .listSectionSpacing(Alpine.Space.s4)
            .screenChrome(title: "Home") { addMenu }
            .navigationDestination(for: Opened.self) { folder in
                FolderView(folderId: folder.id, title: folder.name)
            }
            // A tap on "“Lisbon” is on this phone".
            .navigationDestination(isPresented: $showingPhone) { OnThisPhoneView() }
            .onChange(of: TransferNotices.shared.opening, initial: true) { _, target in
                guard target == .phone else { return }
                TransferNotices.shared.opening = nil
                showingPhone = true
            }
            .refreshable {
                await store.refreshRecents()
                await store.refreshSharing()
                if let tagFilter { tagged = await store.items(tagged: tagFilter) }
            }
            .nodeActionSheets(action: $action, store: store)
            .fileViewer($viewing, among: rows, store: store)
            .uploadFlow(into: store.rootId, importer: $showingImporter, photos: $showingPhotos, camera: $showingCamera)
            .sheet(isPresented: $managingTags) { TagManagerSheet().environment(store) }
            .task {
                if let root = await store.loadRoot(), store.folders[root] == nil { await store.refresh(folder: root) }
                await store.refreshRecents()
                await store.refreshTags()
                loaded = true
            }
        }
    }

    /* The title with Add, then the offline line: the furniture above On this phone. */
    private var top: some View {
        VStack(alignment: .leading, spacing: Alpine.Space.s3) {
            ScreenHeader(title: "Home") { addMenu }
            if store.offline { OfflineCapsule() }
        }
        .textCase(nil)
        .listRowInsets(EdgeInsets(top: Alpine.Space.s2, leading: 0, bottom: Alpine.Space.s3, trailing: 0))
    }

    /* Files' + menu, adding into the top folder; what is added leads Recent once the list catches up. */
    @ViewBuilder private var addMenu: some View {
        if let root = store.rootId {
            Menu {
                AddItems(importer: $showingImporter, photos: $showingPhotos, camera: $showingCamera) {
                    Rename.newFolder(in: root, named: "Files", store: store)
                }
            } label: { HeaderIcon(symbol: "plus") }
            .accessibilityLabel("Add")
        }
    }

    /* "Recent" (or "Recent images", or the tag) as a section title, with its own filters under it. */
    private var recentHeader: some View {
        VStack(alignment: .leading, spacing: Alpine.Space.s3) {
            Text(heading).font(Theme.Text.title).foregroundStyle(Alpine.ink)
                .padding(.horizontal, Alpine.Space.s1)
                .accessibilityAddTraits(.isHeader)
            TypeChips(value: $filter)
            if !store.tags.tags.isEmpty { tagsRow }
        }
        .textCase(nil)
        .listRowInsets(EdgeInsets(top: Alpine.Space.s2, leading: 0, bottom: Alpine.Space.s3, trailing: 0))
    }

    private var tagsRow: some View {
        HStack(spacing: Alpine.Space.s2) {
            Text("Tags").font(Theme.Text.callout.weight(.semibold)).foregroundStyle(Alpine.inkMuted)
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
                }
                .padding(.vertical, 1)
            }
            .scrollClipDisabled()
            Button("Manage") { managingTags = true }.font(Theme.Text.callout.weight(.semibold)).foregroundStyle(Alpine.primary)
                .buttonStyle(.borderless)
        }
        .padding(.horizontal, Alpine.Space.s1)
    }

    /* Always there: how many files are on this phone, how much room they take, and why that matters. */
    private var onThisPhone: some View {
        HStack(spacing: Alpine.Space.s3) {
            Image(systemName: "iphone").font(.body.weight(.medium)).foregroundStyle(Alpine.onTint)
                .frame(width: Theme.mark, height: Theme.mark).background(Alpine.tint, in: Circle())
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text("On this phone").font(Theme.Text.body).foregroundStyle(Alpine.ink)
                Text(OnThisPhoneView.summary(kept, folders: Offline.keptFolders().count)).font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted).lineLimit(1)
            }
        }
        .frame(minHeight: Theme.row)
    }

    @ViewBuilder private var emptyRecent: some View {
        if let tagFilter, let tag = store.tags.tags.first(where: { $0.id == tagFilter }) {
            EmptyStateView(title: "Nothing tagged \(tag.name)", message: filter == .all ? "Nothing carries this tag yet." : "No \(filter.rawValue.lowercased()) carry this tag.")
        } else if filter == .all {
            EmptyStateView(title: "No recent files yet", message: "Files you add or change show up here.")
        } else {
            EmptyStateView(title: "No \(filter.rawValue.lowercased()) yet", message: "\(filter.rawValue) you add or change show up here.")
        }
    }

    @ViewBuilder private func row(_ item: Opened) -> some View {
        // Offline, a file that isn't on this phone won't open: it dims and says so.
        let away = store.offline && !item.isFolder && !kept.contains { $0.id == item.id }
        if item.isFolder {
            NavigationLink(value: item) { NodeRow(item: item, recent: true) }
                .nodeActions(item, action: $action, store: store)
                .itemRow()
        } else {
            Button { Opener.open(item, store: store) { viewing = $0 } } label: {
                NodeRow(item: item, note: away ? "Not on this phone" : nil, recent: true).opacity(away ? 0.5 : 1)
            }
            .buttonStyle(.plain)
            .nodeActions(item, action: $action, store: store)
            .itemRow()
        }
    }
}

/* All, Folders, Images, Videos, Documents. The chosen one fills with ink and carries a check. */
struct TypeChips: View {
    @Binding var value: HomeFilter
    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Alpine.Space.s2) {
                ForEach(HomeFilter.allCases) { option in
                    let on = value == option
                    Button { value = option } label: {
                        HStack(spacing: 6) {
                            if on && option != .all { Image(systemName: "checkmark").font(.caption.weight(.bold)) }
                            Text(option.rawValue)
                        }
                        .font(Theme.Text.callout.weight(.semibold))
                        .foregroundStyle(on ? Alpine.surface : Alpine.ink)
                        .padding(.horizontal, Alpine.Space.s4).frame(height: 36)
                        .background(on ? Alpine.ink : Alpine.surface, in: Capsule())
                        .overlay { if contrast == .increased && !on { Capsule().strokeBorder(Alpine.rule, lineWidth: 1) } }
                        .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(on ? .isSelected : [])
                }
            }
        }
        .scrollClipDisabled()
    }
}


struct TrashView: View {
    @Environment(DriveStore.self) private var store
    @State private var loaded = false
    @State private var confirmEmpty = false
    /* Picking rows to restore or delete together, as Files picks them. */
    @State private var selecting = false
    @State private var selection: Set<String> = []
    @State private var confirmDelete = false
    /* One row's Delete forever, asked first (swipe and menu alike). */
    @State private var deleting: Opened?
    /* The row tapped: its sheet with Restore and Delete forever. */
    @State private var opened: TrashEntry?
    /* Rows a batch restore couldn't bring back, marked until the banner goes. */
    private var failedIds: Set<String> { Set(store.restoreProblem?.failed.map(\.entry.item.id) ?? []) }
    @Environment(\.dismiss) private var dismissView

    /* Select all and Done while selecting; otherwise Select and Empty, or how emptying is going. */
    @ViewBuilder private var trashActions: some View {
        if selecting {
            let all = !store.trash.isEmpty && selection.count == store.trash.count
            Button { selection = all ? [] : Set(store.trash.map(\.item.id)) } label: { HeaderWord(text: all ? "Deselect all" : "Select all") }
                .buttonStyle(.plain)
            Button { selecting = false; selection = [] } label: { HeaderWord(text: "Done") }
                .buttonStyle(.plain)
        } else if store.emptyingTrash {
            EmptyView()
        } else if !store.trash.isEmpty {
            Button { selecting = true } label: { HeaderWord(text: "Select") }
                .buttonStyle(.plain)
            Button(role: .destructive) { confirmEmpty = true } label: { HeaderWord(text: "Empty Trash").foregroundStyle(Alpine.danger) }
                .buttonStyle(.plain)
        }
    }
    private var picked: [(item: Opened, parentTrashed: Bool)] { store.trash.filter { selection.contains($0.item.id) } }

    /* "Back to Work", or why it goes to Files instead: Android's words, the board's. */
    private func restoreDetail(_ item: Opened, parentTrashed: Bool) -> String? {
        if parentTrashed { return "Its folder “\(store.wasIn(item) ?? "its folder")” is in the Trash too." }
        return store.wasIn(item).map { "Back to \($0)" }
    }

    var body: some View {
        List { Section { Group {
            if loaded && store.trash.isEmpty {
                EmptyStateView(symbol: "trash", title: "Trash is empty", message: "Items you move to the Trash stay here for 30 days.")
                    .bareRow(top: Alpine.Space.s12)
            }
            ForEach(store.trash, id: \.item.id) { entry in
                // Mid-way through a restore or delete, or while the whole trash empties, a row takes no second action;
                // only the row being deleted or restored spins.
                let spinning = store.trashWorking.contains(entry.item.id)
                let working = store.emptyingTrash || spinning
                let failed = failedIds.contains(entry.item.id)
                let note = spinning && store.emptyingTrash ? "Deleting forever…" : failed ? "Couldn’t be restored" : store.trashLine(entry.item)
                if selecting {
                    Button {
                        if selection.contains(entry.item.id) { selection.remove(entry.item.id) } else { selection.insert(entry.item.id) }
                    } label: {
                        NodeRow(item: entry.item, note: note, working: spinning, selected: selection.contains(entry.item.id), access: false, noteIsProblem: failed)
                    }
                    .buttonStyle(.plain)
                    .disabled(working)
                    .itemRow(selected: selection.contains(entry.item.id))
                } else {
                Button { opened = TrashEntry(item: entry.item, parentTrashed: entry.parentTrashed) } label: {
                    NodeRow(item: entry.item, note: note, working: spinning, access: false, noteIsProblem: failed)
                }
                    .buttonStyle(.plain)
                    .disabled(working)
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        // Token colours, and no full swipe: deleting for good is asked first.
                        Button { deleting = entry.item } label: { Label("Delete forever", systemImage: "trash.slash") }.tint(Alpine.danger)
                        Button { Task { await store.restore(entry.item, parentTrashed: entry.parentTrashed) } } label: { Label("Restore", systemImage: "arrow.uturn.backward") }.tint(Alpine.primary)
                    }
                    .contextMenu {
                        // Where it goes, under the action, as the board's menu says it.
                        Button { Task { await store.restore(entry.item, parentTrashed: entry.parentTrashed) } } label: {
                            Label {
                                Text(entry.parentTrashed ? "Restore to Files" : "Restore")
                                Text(restoreDetail(entry.item, parentTrashed: entry.parentTrashed) ?? "")
                            } icon: { Image(systemName: "arrow.uturn.backward") }
                        }
                        Button("Delete forever", systemImage: "trash.slash", role: .destructive) { deleting = entry.item }.tint(Alpine.danger)
                    }
                    .itemRow()
                }
            }
        }
        .alpineRow() } header: {
            VStack(alignment: .leading, spacing: Alpine.Space.s3) {
                ScreenHeader(title: "Trash", back: selecting ? nil : { dismissView() }) { trashActions }
                if store.offline { OfflineCapsule() }
                if let emptying = store.emptying {
                    // The count and a bar while the rows go one by one.
                    VStack(alignment: .leading, spacing: Alpine.Space.s2) {
                        HStack {
                            Text("Emptying the Trash…").font(Theme.Text.callout.weight(.semibold)).foregroundStyle(Alpine.ink)
                            Spacer()
                            Text("\(emptying.done) of \(emptying.total)").font(Theme.Text.callout.monospacedDigit()).foregroundStyle(Alpine.inkMuted)
                        }
                        ProgressView(value: emptying.total == 0 ? 1 : Double(emptying.done) / Double(emptying.total)).tint(Alpine.primary)
                    }
                    .padding(.horizontal, Alpine.Space.s1)
                    .accessibilityElement(children: .combine)
                } else if !store.trash.isEmpty {
                    Text("Items stay here for 30 days, then they’re deleted for good.").font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted)
                        .padding(.horizontal, Alpine.Space.s1)
                }
                if let problem = store.restoreProblem {
                    RestoreProblemBanner(problem: problem) {
                        let entries = problem.failed.map(\.entry)
                        Task { await store.restoreMany(entries) }
                    } dismiss: {
                        store.restoreProblem = nil
                    }
                }
            }
            .textCase(nil)
            .listRowInsets(EdgeInsets(top: Alpine.Space.s2, leading: 0, bottom: Alpine.Space.s3, trailing: 0))
        } }
        .alpineGrouped()
        .listStyle(.insetGrouped)
        .navigationTitle("Trash")
        .screenChrome(title: "Trash", back: selecting ? nil : { dismissView() }) { trashActions }
        .refreshable {
            // A pull asks the server: the catalogue alone may not know yet.
            await store.sync()
            await store.refreshTrash()
        }
        .onChange(of: store.trash.map(\.item.id)) { _, ids in
            // Rows restored or deleted, here or elsewhere, leave the selection.
            selection.formIntersection(ids)
            if ids.isEmpty { selecting = false }
        }
        .overlay(alignment: .bottom) {
            if selecting {
                // The same bar Files shows while selecting: what is picked, and what can be done with it.
                HStack(spacing: 18) {
                    Text("\(selection.count) selected").font(.footnote).foregroundStyle(Alpine.inkMuted)
                    Spacer()
                    // Once acted on, select mode ends, as in Files, and the notice says how it went.
                    Button { let entries = picked; selecting = false; selection = []; Task { await store.restoreMany(entries) } } label: { Label("Restore", systemImage: "arrow.uturn.backward") }
                    Button(role: .destructive) { confirmDelete = true } label: { Label("Delete", systemImage: "trash.slash") }
                }
                .labelStyle(.titleAndIcon)
                .font(.subheadline.weight(.medium))
                .disabled(selection.isEmpty || !store.trashWorking.isEmpty)
                .padding(.horizontal, 20).padding(.vertical, 12)
                .glassEffect(.regular, in: .capsule)
                .padding(.horizontal, 16).padding(.bottom, 16)
            }
        }
        .confirmationDialog(
            selection.count == 1 ? "Delete this item forever?" : "Delete \(selection.count) items forever?",
            isPresented: $confirmDelete, titleVisibility: .visible
        ) {
            Button("Delete forever", role: .destructive) {
                let entries = picked
                selecting = false
                selection = []
                Task { await store.purgeMany(entries) }
            }
        } message: {
            Text(selection.count == 1 ? "It can’t be restored after this." : "They can’t be restored after this.")
        }
        .confirmationDialog("Empty the Trash?", isPresented: $confirmEmpty, titleVisibility: .visible) {
            Button("Empty Trash", role: .destructive) { Task { await store.emptyTrash() } }
        } message: {
            Text(store.trash.count == 1 ? "It’s deleted for good. This can’t be undone." : "All \(store.trash.count) items are deleted for good. This can’t be undone.")
        }
        .alert(deleting.map { "Delete “\($0.name)” forever?" } ?? "", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })) {
            Button("Cancel", role: .cancel) { deleting = nil }
            Button("Delete forever", role: .destructive) {
                if let item = deleting { Task { await store.purge(item) } }
                deleting = nil
            }
        } message: {
            Text(deleting?.isFolder == true ? "Everything inside goes too. It can’t be restored after this." : "It can’t be restored after this.")
        }
        .sheet(item: $opened) { entry in
            TrashItemSheet(entry: entry, detail: restoreDetail(entry.item, parentTrashed: entry.parentTrashed)) {
                opened = nil
                Task { await store.restore(entry.item, parentTrashed: entry.parentTrashed) }
            } delete: {
                opened = nil
                deleting = entry.item
            }
            .environment(store)
        }
        .onDisappear { store.restoreProblem = nil }
        .task {
            await store.refreshTrash()
            loaded = true
        }
    }
}

/* Every tag in the workspace: rename, recolour, delete, and how many items each names. */
/*
 * Manage tags: every tag in the list. Tap a dot for the five presets or a custom colour,
 * tap a name or swipe to rename, swipe to remove. Removing says how many items lose the
 * tag and asks once; the items themselves are never touched.
 */
struct TagManagerSheet: View {
    @Environment(DriveStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var newName = ""
    @State private var picking: Tag?
    @State private var removing: Tag?
    @State private var custom: Color = Alpine.primary

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack {
                        TextField("New tag", text: $newName).submitLabel(.done).onSubmit(create).foregroundStyle(Alpine.ink)
                        Button("Add", action: create).fontWeight(.semibold).disabled(newName.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                    .alpineRow()
                }
                Section {
                    if store.tags.tags.isEmpty { Text("No tags yet. Tags group items across folders.").foregroundStyle(Alpine.inkMuted).alpineRow() }
                    ForEach(store.tags.tags) { tag in
                        HStack(spacing: Alpine.Space.s3) {
                            Menu {
                                Section("Colour for \(tag.name)") {
                                    ForEach(TagRegistry.presets, id: \.self) { preset in
                                        Button { Task { await store.editTags { registry in registry.recolour(tag.id, to: preset) } } } label: {
                                            if tag.colour == preset { Label(TagColour.label(preset), systemImage: "checkmark") } else { Text(TagColour.label(preset)) }
                                        }
                                    }
                                }
                                Button("Custom colour", systemImage: "paintpalette") { custom = TagColour.swiftUI(tag.colour); picking = tag }
                            } label: {
                                TagDot(tag: tag, size: 18).frame(width: 32, height: 32).contentShape(Circle())
                            }
                            .accessibilityLabel("Colour for \(tag.name): \(TagColour.label(tag.colour))")
                            Button { rename(tag) } label: {
                                HStack {
                                    Text(tag.name).foregroundStyle(Alpine.ink)
                                    Spacer()
                                    let count = store.tags.nodes(with: tag.id).count
                                    Text(count == 1 ? "1 item" : "\(count) items").font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted)
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                        .swipeActions {
                            Button { removing = tag } label: { Label("Remove", systemImage: "trash") }.tint(Alpine.danger)
                            Button { rename(tag) } label: { Label("Rename", systemImage: "pencil") }.tint(Alpine.primary)
                        }
                        .alpineRow()
                    }
                } footer: {
                    Text("Tags are only for you: people you share with never see them. Tap a dot for its colour. Swipe a tag to rename or remove it.")
                }
            }
            .listStyle(.insetGrouped)
            .alpineGrouped()
            .navigationTitle("Tags")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .sheet(item: $picking) { tag in
                NavigationStack {
                    Form {
                        Section {
                            ColorPicker("Custom colour", selection: $custom, supportsOpacity: false).alpineRow()
                        } footer: {
                            Text("Shown on the tag everywhere, only to you.")
                        }
                    }
                    .alpineGrouped()
                    .navigationTitle("Custom colour")
                    .navigationSubtitle(Text(tag.name))
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { picking = nil } }
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Apply") {
                                let hex = TagColour.hex(custom)
                                picking = nil
                                Task { await store.editTags { registry in registry.recolour(tag.id, to: hex) } }
                            }
                        }
                    }
                }
                .presentationDetents([.medium])
            }
            .alert(removing.map { "Remove “\($0.name)”?" } ?? "", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })) {
                Button("Cancel", role: .cancel) { removing = nil }
                Button("Remove tag", role: .destructive) {
                    guard let tag = removing else { return }
                    removing = nil
                    Task {
                        await store.editTags { registry in registry.remove(tag.id) }
                        store.notify("“\(tag.name)” removed")
                    }
                }
            } message: {
                if let tag = removing {
                    let count = store.tags.nodes(with: tag.id).count
                    Text("It comes off \(count) \(count == 1 ? "item" : "items") and leaves your list. The items themselves aren’t touched.")
                }
            }
        }
        .task { await store.refreshTags() }
    }

    private func rename(_ tag: Tag) {
        let others = store.tags.tags.filter { $0.id != tag.id }.map(\.name)
        TextPrompt.present(title: "Rename tag", message: "The new name shows everywhere at once.", text: tag.name, placeholder: "Name", action: "Rename", selectStem: false,
                           validate: { name in
                               let clean = name.trimmingCharacters(in: .whitespaces)
                               if clean.isEmpty { return "Enter a name." }
                               return others.contains { $0.caseInsensitiveCompare(clean) == .orderedSame } ? "You already have a tag called “\(clean)”." : nil
                           }) { name in
            Task { await store.editTags { registry in try registry.rename(tag.id, to: name) } }
        }
    }

    private func create() {
        let name = newName
        guard !name.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        newName = ""
        Task { await store.editTags { registry in _ = try registry.add(name: name) } }
    }
}

/*
 * What is on this phone: the files kept here so they open without a connection.
 * Touch and hold for Send a copy, Show in folder, or Remove from this phone,
 * which leaves the file in HushOS.
 */
struct OnThisPhoneView: View {
    @Environment(DriveStore.self) private var store
    @State private var action: NodeAction?
    @State private var preview: URL?
    @State private var viewing: Opened?
    @State private var showing: Opened?
    /* The opened items behind the rows, for a full row and Send a copy. */
    @State private var items: [String: Opened] = [:]
    @Environment(\.dismiss) private var dismissView

    /* "1 folder · 3 files · 1.2 GB · open without a connection", the size left out when an entry never recorded one. */
    static func summary(_ entries: [Offline.Entry], folders: Int = 0) -> String {
        guard !entries.isEmpty || folders > 0 else { return "Nothing yet · files kept here open without a connection" }
        var parts: [String] = []
        if folders > 0 { parts.append(folders == 1 ? "1 folder" : "\(folders) folders") }
        // Every kept file, those kept with a folder too: "1 folder · 2 files · 28.8 MB" (Android's words).
        if !entries.isEmpty || folders == 0 { parts.append(entries.count == 1 ? "1 file" : "\(entries.count) files") }
        let sizes = entries.compactMap(\.size)
        if sizes.count == entries.count, !entries.isEmpty { parts.append(formatBytes(Int64(sizes.reduce(0, +)))) }
        return (parts + ["open without a connection"]).joined(separator: " · ")
    }

    /* Files kept on their own; those kept with a folder are counted on the folder's row. */
    private var entries: [Offline.Entry] {
        _ = store.offlineVersion
        let folders = Set(Offline.keptFolders().map(\.id))
        return Offline.entries().filter { $0.folderId.map { !folders.contains($0) } ?? true }
    }

    private var keptFolders: [Offline.KeptFolder] {
        _ = store.offlineVersion
        return Offline.keptFolders()
    }

    /* "12 files · 340 MB", or what is happening while the folder's files come down. */
    private func folderLine(_ folder: Offline.KeptFolder) -> String {
        let files = Offline.entries(keptWith: folder.id)
        if case .fetching = store.keptState(folder.id) { return files.isEmpty ? "Keeping on this phone…" : "\(files.count) kept so far…" }
        let count = files.count == 1 ? "1 file" : "\(files.count) files"
        let size = files.compactMap(\.size).reduce(0, +)
        let failed = Offline.keepFailures(in: folder.id).count
        let base = files.isEmpty ? "No files yet" : "\(count) · \(formatBytes(Int64(size)))"
        // Android's words, so both apps say the same.
        guard failed > 0 else { return base }
        return base + " · " + (failed == 1 ? "1 file couldn’t be kept" : "\(failed) files couldn’t be kept")
    }

    var body: some View {
        List {
            Section {} header: {
                ScreenHeader(title: "On this phone", back: { dismissView() })
                    .listRowInsets(EdgeInsets(top: Alpine.Space.s2, leading: 0, bottom: 0, trailing: 0))
            }
            if entries.isEmpty && keptFolders.isEmpty {
                EmptyStateView(symbol: "iphone", title: "Nothing on this phone yet",
                               message: "Choose Keep on this phone on any file or folder to open it without a connection.")
                    .bareRow(top: Alpine.Space.s20)
            } else {
                if !keptFolders.isEmpty {
                    Section {
                        ForEach(keptFolders) { folder in
                            Button {
                                Task { if let opened = await store.vault.openedItem(folder.id) ?? store.known(folder.id) { showing = opened } }
                            } label: {
                                HStack(spacing: Alpine.Space.s3) {
                                    FolderGlyph().frame(width: Theme.mark * 0.9, height: Theme.mark * 0.9 * 46 / 56).frame(width: Theme.mark, height: Theme.mark)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(folder.name).font(Theme.Text.body).foregroundStyle(Alpine.ink).lineLimit(1)
                                        Text("\(KeptMark.text) \(Text(folderLine(folder)).foregroundStyle(Alpine.inkMuted))")
                                            .font(Theme.Text.footnote).lineLimit(1)
                                    }
                                    Spacer(minLength: 0)
                                    if case .fetching = store.keptState(folder.id) { ProgressView().controlSize(.small) }
                                    Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Alpine.inkMuted)
                                }
                                .frame(minHeight: Theme.row).contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .contextMenu {
                                Button("Remove from this phone", systemImage: "iphone.slash", role: .destructive) { removeFolder(folder) }.tint(Alpine.danger)
                            }
                            .swipeActions { Button("Remove", role: .destructive) { removeFolder(folder) } }
                            .itemRow()
                        }
                    } header: {
                        Text("Folders").font(Theme.Text.label).foregroundStyle(Alpine.inkMuted).textCase(nil)
                    }
                }
                if !entries.isEmpty {
                Section {
                    ForEach(entries) { entry in
                        row(entry)
                            .contextMenu {
                                // A kept file is still a file: the whole item menu, plus the way to its folder.
                                if let item = items[entry.id] {
                                    if let parent = item.node.parentId, let folder = store.known(parent) {
                                        Button("Show in folder", systemImage: "folder") { showing = folder }
                                        Divider()
                                    }
                                    NodeMenu(item: item, action: $action)
                                } else {
                                    // Kept from a share this session hasn't opened: dropping the copy is all it can do.
                                    Button("Remove from this phone", systemImage: "iphone.slash", role: .destructive) { remove(entry) }.tint(Alpine.danger)
                                }
                            }
                            .swipeActions { Button("Remove", role: .destructive) { remove(entry) } }
                            .itemRow()
                    }
                } header: {
                    if !keptFolders.isEmpty { Text("Files").font(Theme.Text.label).foregroundStyle(Alpine.inkMuted).textCase(nil) }
                } footer: {
                    Text("These open without a connection. When one changes somewhere else, the copy here updates. Touch and hold to remove one.")
                        .font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted)
                }
                }
            }
        }
        .listStyle(.insetGrouped)
        .alpineGrouped()
        .environment(\.defaultMinListRowHeight, 1) // Item rows set their own 56pt; furniture rows keep their own height.
        .listSectionSpacing(Alpine.Space.s3)
        .navigationTitle("On this phone")
        .screenChrome(title: "On this phone", back: { dismissView() })
        .navigationDestination(item: $showing) { folder in
            FolderView(folderId: folder.id, title: folder.id == store.rootId ? "Files" : folder.name, isRoot: folder.id == store.rootId)
        }
        .nodeActionSheets(action: $action, store: store)
        .quickLookPreview($preview)
        .fileViewer($viewing, among: entries.compactMap { items[$0.id] }, store: store)
        .task(id: "\(store.offlineVersion)-\(store.catalogueVersion)") {
            var found: [String: Opened] = [:]
            for entry in entries { if let item = await store.vault.openedItem(entry.id) { found[entry.id] = item } }
            items = found
        }
    }

    @ViewBuilder private func row(_ entry: Offline.Entry) -> some View {
        Button {
            if let item = items[entry.id] ?? store.everything.first(where: { $0.id == entry.id }) { Opener.open(item, store: store) { viewing = $0 } }
            // Kept from a share this session hasn't opened: the copy on the phone is all there is.
            else { preview = Offline.file(for: entry) }
        } label: {
            if let item = items[entry.id] {
                NodeRow(item: item, note: entry.size.map { formatBytes(Int64($0)) })
            } else {
                // Kept from a share this session hasn't opened: the name and size are all the phone knows.
                HStack(spacing: Alpine.Space.s3) {
                    PageGlyph(label: (entry.name as NSString).pathExtension.uppercased().nilIfEmpty)
                        .frame(width: Theme.mark * 0.66, height: Theme.mark * 0.66 * 54 / 44).frame(width: Theme.mark, height: Theme.mark)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(entry.name).font(Theme.Text.body).foregroundStyle(Alpine.ink).lineLimit(1)
                        if let size = entry.size { Text(formatBytes(Int64(size))).font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted) }
                    }
                    Spacer(minLength: 0)
                }
                .frame(minHeight: Theme.row)
                .contentShape(Rectangle())
            }
        }
        .buttonStyle(.plain)
    }

    private func removeFolder(_ folder: Offline.KeptFolder) {
        store.removeKeptFolder(folder.id)
        store.notify("Removed “\(folder.name)” from this phone. It’s still in HushOS.")
    }

    private func remove(_ entry: Offline.Entry) {
        Offline.forget(entry.id)
        store.offlineVersion += 1
        store.notify("Removed from this phone. It’s still in HushOS.")
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty || count > 4 ? nil : self }
}

/* A trash row, identifiable for its sheet. */
struct TrashEntry: Identifiable {
    let item: Opened
    let parentTrashed: Bool
    var id: String { item.id }
}

/* Tapping a trashed row: what it is and where it was, Restore (or Restore to Files, with why), and Delete forever, which asks. */
private struct TrashItemSheet: View {
    @Environment(DriveStore.self) private var store
    let entry: TrashEntry
    let detail: String?
    let restore: () -> Void
    let delete: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: Alpine.Space.s3) {
                FileMark(item: entry.item, box: 48)
                VStack(alignment: .leading, spacing: 2) {
                    Text(entry.item.name).font(Theme.Text.headline).foregroundStyle(Alpine.ink).lineLimit(1)
                    Text(store.trashLine(entry.item)).font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted).lineLimit(1)
                }
            }
            .padding(.horizontal, Alpine.Space.s6).padding(.top, Alpine.Space.s6).padding(.bottom, Alpine.Space.s3)
            Theme.divider.frame(height: 1).padding(.horizontal, Alpine.Space.s4)
            row(entry.parentTrashed ? "Restore to Files" : "Restore", detail: detail, symbol: "arrow.uturn.backward", danger: false, action: restore)
            row("Delete forever", detail: nil, symbol: "trash.slash", danger: true, action: delete)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Alpine.ground)
        .presentationDetents([.height(250)])
        .presentationDragIndicator(.visible)
    }

    private func row(_ title: String, detail: String?, symbol: String, danger: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: Alpine.Space.s4) {
                Image(systemName: symbol).font(.body.weight(.semibold)).frame(width: 24)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(Theme.Text.body)
                    if let detail { Text(detail).font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted) }
                }
                Spacer(minLength: 0)
            }
            .foregroundStyle(danger ? Alpine.danger : Alpine.ink)
            .padding(.horizontal, Alpine.Space.s6).frame(minHeight: Theme.row).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/*
 * A batch restore that partly failed, as the board draws it: it stays until dismissed,
 * saying what came back, what didn't and why, what to do, and where an orphan went.
 */
private struct RestoreProblemBanner: View {
    let problem: DriveStore.RestoreProblem
    let retry: () -> Void
    let dismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Restored \(problem.restored) of \(problem.total)").font(.body.weight(.semibold)).foregroundStyle(Alpine.danger)
            Text(failedLine).font(Theme.Text.callout).foregroundStyle(Alpine.ink)
            if let movedLine { Text(movedLine).font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted) }
            HStack(spacing: Alpine.Space.s2) {
                Button("Try again", action: retry).buttonStyle(PrimaryCapsuleStyle())
                Button("Dismiss", action: dismiss).buttonStyle(SecondaryCapsuleStyle())
            }
            .padding(.top, Alpine.Space.s1)
        }
        .padding(Alpine.Space.s4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Alpine.dangerSoft, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .highContrastEdge(RoundedRectangle(cornerRadius: 22, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isStaticText)
    }

    /* "“Old lease.pdf” couldn’t be restored because the connection dropped. Try again once you’re back online." */
    private var failedLine: String {
        let offline = problem.failed.contains { $0.reason == TransferWords.network }
        let why = offline ? " because the connection dropped. Try again once you’re back online." : ". " + (problem.failed.first?.reason ?? "Try again.")
        if problem.failed.count == 1 { return "“\(problem.failed[0].entry.item.name)” couldn’t be restored" + why }
        return "\(problem.failed.count) items couldn’t be restored" + why
    }

    /* "“Budget 2025.xlsx” went back to Files, because its folder “Drafts” is still in the Trash." */
    private var movedLine: String? {
        guard let first = problem.moved.first else { return nil }
        if problem.moved.count == 1 {
            return "“\(first.item.name)” went back to Files, because its folder" + (first.folder.map { " “\($0)”" } ?? "") + " is still in the Trash."
        }
        return "\(problem.moved.count) items went back to Files, because their folders are still in the Trash."
    }
}
