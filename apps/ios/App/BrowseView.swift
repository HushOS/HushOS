import QuickLook
import HushOSKit
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/* The tree: the top folder, each folder pushing the next, with the actions a cloud drive offers. */
struct BrowseView: View {
    @Environment(DriveStore.self) private var store
    @State private var rootId: String?
    @State private var path: [Opened] = []

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if let rootId {
                    FolderView(folderId: rootId, title: "Files", isRoot: true)
                } else {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity).background(Alpine.ground)
                }
            }
        }
        .task { rootId = await store.loadRoot() }
        .onChange(of: store.route, initial: true) { _, link in
            guard let link else { return }
            switch link {
            case .files(let folder, let preview):
                store.route = nil
                Task { await open(folder: folder, preview: preview) }
            case .node(let id):
                store.route = nil
                Task {
                    guard let item = await store.lookUp(id) else { return gone() }
                    if item.isFolder { await open(folder: item.id, preview: nil) } else { await open(folder: item.node.parentId, preview: item.id) }
                }
            default:
                break
            }
        }
    }

    /* A folder from a link, pushed with the folders above it so Back walks up; a file opens in the viewer over it. */
    private func open(folder: String?, preview: String?) async {
        _ = await store.loadRoot()
        var target: Opened?
        if let folder, folder != store.rootId {
            guard let found = await store.lookUp(folder), found.isFolder else { return gone() }
            target = found
        }
        path = target.map { _ in [] } ?? []
        if let target { path = await store.trail(to: target) + [target] }
        guard let preview else { return }
        guard let file = await store.lookUp(preview), !file.isFolder else { return gone() }
        let parent = file.node.parentId ?? store.rootId ?? ""
        if store.folders[parent] == nil { await store.refresh(folder: parent) }
        store.deepSiblings = (store.folders[parent] ?? [file]).filter { !$0.isFolder }
        Opener.open(file, store: store) { store.deepFile = $0 }
    }

    private func gone() { store.notify("This isn’t available any more. It may have been moved to the Trash, or it isn’t shared with you.") }
}

/*
 * A folder as the board draws it: a large title with Add and More in the bar, the
 * access banner when it is shared, then one card of 56pt rows that say who can open
 * each thing. Selecting swaps the tab bar for a labelled toolbar. Trash lives in
 * Account (the user's call over the board, which put it here).
 */
struct FolderView: View {
    @Environment(DriveStore.self) private var store
    let folderId: String
    let title: String
    var isRoot = false
    @State private var loaded = false
    @State private var showingImporter = false
    @State private var showingPhotos = false
    @State private var showingCamera = false
    @State private var action: NodeAction?
    @State private var viewing: Opened?
    // How this drive's lists are ordered, kept across launches; folders always come first.
    @AppStorage("files.sortKey") private var sortKey = SortKey.name
    @AppStorage("files.sortAscending") private var sortAscending = true
    // List or grid, kept on this phone for every folder.
    @AppStorage("files.view") private var layout = FolderLayout.list
    @State private var query = ""
    @FocusState private var searchFocused: Bool
    @State private var tagFilter: String?
    @State private var selecting = false
    @State private var selection: Set<String> = []
    @State private var movingMany = false

    private var selectedItems: [Opened] { children.filter { selection.contains($0.id) } }

    /* The active tag when it is what empties the list: the folder has items, none carry it. */
    private var filteredOutTag: Tag? {
        guard let tagFilter, let items = store.folders[folderId], !items.isEmpty else { return nil }
        return store.tags.tags.first { $0.id == tagFilter }
    }

    private var searching: Bool { !query.trimmingCharacters(in: .whitespaces).isEmpty }

    /* Tiles, unless a search is showing: each result needs its location line, which only a row has. */
    private var gridShown: Bool { layout == .grid && !searching }

    private static let tileGap = Alpine.Space.s3

    /* As many 150pt tiles as fit across: two on a phone held upright, more on its side or on an iPad. */
    private static let tileColumns = [GridItem(.adaptive(minimum: 150), spacing: tileGap, alignment: .top)]

    private var children: [Opened] {
        let needle = query.trimmingCharacters(in: .whitespaces)
        var items: [Opened]
        if !needle.isEmpty {
            items = store.items(under: folderId).filter { $0.name.localizedCaseInsensitiveContains(needle) }.sorted(by: Opened.byName)
        } else {
            items = sortKey.sort(store.folders[folderId] ?? [], ascending: sortAscending)
        }
        if let tagFilter { items = items.filter { store.tags.nodes(with: tagFilter).contains($0.id) } }
        return items
    }

    /* The nearest shared folder from here up, and what the banner says about it. */
    private var banner: (folder: String, text: String, link: Bool)? {
        guard let shared = store.sharedAncestor(from: folderId),
              let text = store.accessSentence(for: shared, here: shared == folderId) else { return nil }
        return (shared, text, (store.sharing[shared]?.links ?? 0) > 0)
    }

    @Environment(\.dismiss) private var dismiss

    private var headerTitle: String {
        guard selecting else { return title }
        return selection.isEmpty ? "Select items" : "\(selection.count) selected"
    }

    /* Back in front of the title in a pushed folder; none at the top, or while selecting (Done ends it). */
    private var back: (() -> Void)? { isRoot || selecting ? nil : { dismiss() } }

    var body: some View {
        Group {
            if gridShown {
                // Tiles scroll on their own: in a list row, every tile in the row would get the first one's long-press menu.
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        // A list's section header sets the headline font on what has none (the search field); so does this.
                        header.font(Theme.Text.headline).padding(.top, Alpine.Space.s2).padding(.bottom, Alpine.Space.s3)
                        grid
                    }
                    .padding(.horizontal, Alpine.Space.s4)
                }
            } else {
                List {
                    Section {
                        content
                    } header: {
                        header.listRowInsets(EdgeInsets(top: Alpine.Space.s2, leading: 0, bottom: Alpine.Space.s3, trailing: 0))
                    }
                }
                .listStyle(.insetGrouped)
                .environment(\.defaultMinListRowHeight, 1) // Item rows set their own 56pt; furniture rows keep their own height.
                .listSectionSpacing(Alpine.Space.s4)
            }
        }
        .alpineGrouped()
        .screenChrome(title: headerTitle, back: back) { headerActions }
        .toolbar(selecting ? .hidden : .automatic, for: .tabBar)
        .navigationDestination(for: Opened.self) { folder in
            FolderView(folderId: folder.id, title: folder.name)
        }
        .refreshable {
            await store.refresh(folder: folderId)
            await store.refreshSharing()
            // Kept folders catch up on a pull too, a share's included.
            await store.syncKeptNow()
        }
        .safeAreaInset(edge: .bottom) {
            if selecting {
                SelectBar(items: selectedItems, action: $action, moving: $movingMany) { endSelecting() }
            } else if let clip = store.clipboard, let first = clip.items.first {
                PasteBar(
                    text: clip.items.count > 1 ? "Paste \(clip.items.count) items here" : "Paste “\(first.name)” here",
                    reason: store.pasteProblem(into: folderId),
                    paste: { Task { await store.paste(into: folderId) } },
                    clear: { store.clipboard = nil }
                )
            }
        }
        // Notices never cover the paste or selection bar: they are lifted by its height.
        .onChange(of: selecting || store.clipboard != nil, initial: true) { _, shown in
            NoticeCenter.shared.bars[folderId] = shown ? (selecting ? 64 : 72) : nil
        }
        .onDisappear { NoticeCenter.shared.bars[folderId] = nil }
        .onAppear { if selecting || store.clipboard != nil { NoticeCenter.shared.bars[folderId] = selecting ? 64 : 72 } }
        .sheet(isPresented: $movingMany) {
            MovePicker(items: selectedItems).environment(store)
                .onDisappear { endSelecting() }
        }
        .uploadFlow(into: folderId, named: title, importer: $showingImporter, photos: $showingPhotos, camera: $showingCamera)
        // A quick action for this folder: the + menu's action, once the push has settled (a sheet
        // asked for mid-push is dropped).
        .onChange(of: store.pendingAdd, initial: true) { _, pending in
            guard let pending, pending.folder == folderId else { return }
            store.pendingAdd = nil
            Task {
                try? await Task.sleep(for: .milliseconds(600))
                switch pending.action {
                case .uploadFiles: showingImporter = true
                case .uploadPhotos: showingPhotos = true
                case .newFolder: Rename.newFolder(in: folderId, named: title, store: store)
                case .search: break
                }
            }
        }
        .nodeActionSheets(action: $action, store: store)
        .fileViewer($viewing, among: children, store: store)
        .onChange(of: children.map(\.id)) { _, ids in selection.formIntersection(ids) }
        // Typing into a grid's search swaps the tiles for rows, and the field moves with them; the keyboard stays.
        .onChange(of: gridShown) {
            guard searchFocused else { return }
            Task { searchFocused = true }
        }
        .task {
            if store.folders[folderId] == nil { await store.refresh(folder: folderId) }
            if store.tags.tags.isEmpty { await store.refreshTags() }
            loaded = true
        }
        // Rows dropped from under an open folder (a sign-in, a failed change) load again rather than leave a skeleton.
        .onChange(of: store.folders[folderId] == nil) { _, gone in
            guard gone, loaded, store.folderProblems[folderId] == nil, !store.loading.contains(folderId) else { return }
            Task { await store.refresh(folder: folderId) }
        }
    }

    /* The title and its actions, then search, offline, who can open it and the tag filter: the same over rows and tiles. */
    private var header: some View {
        VStack(alignment: .leading, spacing: Alpine.Space.s3) {
            ScreenHeader(title: headerTitle, back: back) { headerActions }
            if store.offline { OfflineCapsule() }
            if !isRoot, !selecting, store.folders[folderId] != nil { searchField }
            if let banner, !searching {
                AccessBanner(text: banner.text, link: banner.link) {
                    if let folder = store.known(banner.folder) { action = .share(folder) }
                }
            } else if let received = store.receivedSentence(for: folderId), !searching {
                // Someone else's folder: who shared it and what you can do, with nothing to manage.
                AccessBanner(text: received, manage: nil)
            }
            if let tag = store.tags.tags.first(where: { $0.id == tagFilter }) {
                // The filter says so where the rows are, so a shorter list never looks like missing files.
                HStack(spacing: Alpine.Space.s2) {
                    Text("Showing only").font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted)
                    TagPill(tag: tag, selected: true)
                    Spacer()
                    Button("Show all") { tagFilter = nil }.font(Theme.Text.callout.weight(.semibold)).foregroundStyle(Alpine.primary)
                }
                .padding(.horizontal, Alpine.Space.s1)
            }
        }
        .textCase(nil)
    }

    /* Rows, or what stands in for them: loading, a failure, offline, empty, filtered out, no match. */
    @ViewBuilder private var content: some View {
        if store.folders[folderId] == nil, store.folderProblems[folderId] != nil {
            problemState.bareRow(top: Alpine.Space.s12)
        } else if store.folders[folderId] == nil {
            ForEach(0 ..< 6, id: \.self) { index in SkeletonRow(index: index).itemRow() }
        } else if children.isEmpty {
            emptyState.bareRow(top: Alpine.Space.s12)
        } else {
            ForEach(children) { item in row(item) }
        }
    }

    /* Tiles, or the same stand-ins: skeleton tiles while loading, the list's states otherwise. */
    @ViewBuilder private var grid: some View {
        if store.folders[folderId] == nil, store.folderProblems[folderId] != nil {
            problemState.padding(.top, Alpine.Space.s12)
        } else if store.folders[folderId] == nil {
            LazyVGrid(columns: Self.tileColumns, spacing: Self.tileGap) {
                ForEach(0 ..< 6, id: \.self) { index in SkeletonTile(index: index) }
            }
        } else if children.isEmpty {
            emptyState.padding(.top, Alpine.Space.s12)
        } else {
            LazyVGrid(columns: Self.tileColumns, spacing: Self.tileGap) {
                ForEach(children) { item in tile(item) }
            }
            .padding(.bottom, Alpine.Space.s4)
        }
    }

    @ViewBuilder private var problemState: some View {
        switch store.folderProblems[folderId] {
        case .failed:
            EmptyStateView(symbol: "exclamationmark.triangle", danger: true, title: "This folder couldn’t be opened",
                           message: "Something went wrong while it was loading. Nothing in it has changed.") {
                Button("Try again") { Task { await store.refresh(folder: folderId) } }.buttonStyle(PrimaryCapsuleStyle())
            }
        case .notOnPhone:
            EmptyStateView(symbol: "icloud.slash", title: "Not opened on this phone yet",
                           message: "“\(title)” hasn’t been opened here before, so there’s nothing to show offline. It opens when you’re back online.")
        case nil:
            EmptyView()
        }
    }

    @ViewBuilder private var emptyState: some View {
        if searching {
            EmptyStateView(symbol: "magnifyingglass", title: "No results for “\(query)”",
                           message: "Search looks in “\(title)” and the folders inside it. Check the spelling, or try fewer words.")
        } else if let tag = filteredOutTag {
            EmptyStateView(title: "Nothing tagged \(tag.name)", message: "Nothing in this folder carries this tag.")
        } else {
            EmptyStateView(symbol: "folder.badge.plus", title: "Nothing here yet",
                           message: "Use + to add files, or save to HushOS from the Files app.") {
                Button("Add files") { showingImporter = true }.buttonStyle(PrimaryCapsuleStyle())
            }
        }
    }

    /* A tile does what its row does: open, toggle while selecting, and the row's menu on a long press. */
    @ViewBuilder private func tile(_ item: Opened) -> some View {
        if selecting {
            let picked = selection.contains(item.id)
            Button {
                if picked { selection.remove(item.id) } else { selection.insert(item.id) }
            } label: {
                NodeTile(item: item, selected: picked)
                    .background {
                        // The row's selected tint, just outside the tile.
                        if picked { NodeTile.halo.fill(Alpine.tint).padding(-Alpine.Space.s1) }
                    }
            }
            .buttonStyle(.plain)
        } else if item.isFolder {
            NavigationLink(value: item) { NodeTile(item: item) }
                .buttonStyle(.plain)
                .tilePreview()
                .nodeActions(item, action: $action, store: store, select: { startSelecting(item) })
        } else {
            // Offline, a file that isn't on this phone won't open: it dims.
            let away = store.offline && !Offline.isKept(item.id)
            Button { open(item) } label: { NodeTile(item: item).opacity(away ? 0.5 : 1) }
                .buttonStyle(.plain)
                .tilePreview()
                .nodeActions(item, action: $action, store: store, select: { startSelecting(item) })
        }
    }

    @ViewBuilder private func row(_ item: Opened) -> some View {
        if selecting {
            // Our own selection rows: List's edit-mode selection never took taps here.
            let picked = selection.contains(item.id)
            Button {
                if picked { selection.remove(item.id) } else { selection.insert(item.id) }
            } label: {
                NodeRow(item: item, selected: picked, location: searching ? store.location(of: item) : nil)
            }
            .buttonStyle(.plain)
            .itemRow(selected: picked)
        } else if item.isFolder {
            NavigationLink(value: item) { NodeRow(item: item, location: searching ? store.location(of: item) : nil) }
                .nodeActions(item, action: $action, store: store, select: { startSelecting(item) })
                .itemRow()
        } else {
            // Offline, a file that isn't on this phone won't open: it dims.
            let away = store.offline && !Offline.isKept(item.id)
            Button { open(item) } label: { NodeRow(item: item, location: searching ? store.location(of: item) : nil).opacity(away ? 0.5 : 1) }
                .buttonStyle(.plain)
                .nodeActions(item, action: $action, store: store, select: { startSelecting(item) })
                .itemRow()
        }
    }

    /* "Search in Lisbon 2026": this folder and the ones inside it. The top level searches from the search tab. */
    private var searchField: some View {
        HStack(spacing: Alpine.Space.s2) {
            Image(systemName: "magnifyingglass").foregroundStyle(Alpine.inkMuted)
            TextField("Search in \(title)", text: $query)
                .focused($searchFocused)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .foregroundStyle(Alpine.ink)
            if !query.isEmpty {
                Button { query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Alpine.inkMuted) }
                    .buttonStyle(.plain).accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, 14).frame(height: Theme.control)
        .background(Alpine.ink.opacity(0.06), in: Capsule())
        .highContrastEdge(Capsule())
    }

    /* Select all and Done while selecting; otherwise Add and More. */
    @ViewBuilder private var headerActions: some View {
        if selecting {
            let all = !children.isEmpty && selection.count == children.count
            Button { selection = all ? [] : Set(children.map(\.id)) } label: { HeaderWord(text: all ? "Deselect all" : "Select all") }
                .buttonStyle(.plain)
            Button { endSelecting() } label: { HeaderWord(text: "Done") }
                .buttonStyle(.plain)
        } else {
            // A folder you can only view takes nothing new.
            if store.known(folderId).map({ store.role(of: $0) != .viewer }) ?? true {
                Menu { addItems } label: { HeaderIcon(symbol: "plus") }
                    .accessibilityLabel("Add")
            }
            Menu { moreItems } label: {
                // A filter in force shows here too, besides the line above the rows.
                HeaderIcon(symbol: tagFilter == nil ? "ellipsis" : "line.3.horizontal.decrease")
            }
            .accessibilityLabel("View, sort, filter and select")
        }
    }

    /* What can be added here, most used first: files, photos, a photo taken now, a folder, then a paste while the clipboard holds items. */
    @ViewBuilder private var addItems: some View {
        Button("Upload files", systemImage: "doc.badge.plus") { showingImporter = true }
        // A picker inside a menu never presents; a button and a modifier do.
        Button("Upload photos", systemImage: "photo.badge.plus") { showingPhotos = true }
        Button("Take photo", systemImage: "camera") { showingCamera = true }
        Button("New folder", systemImage: "folder.badge.plus") { Rename.newFolder(in: folderId, named: title, store: store) }
        if let clip = store.clipboard, let first = clip.items.first, store.canPaste(into: folderId) {
            Section {
                Button(clip.items.count > 1 ? "Paste \(clip.items.count) items" : "Paste “\(first.name)”", systemImage: "doc.on.clipboard") {
                    Task { await store.paste(into: folderId) }
                }
            }
        }
    }

    /* Select, then list or grid, then the order with its direction spelled out, then the tags used here. */
    @ViewBuilder private var moreItems: some View {
        Section {
            Button("Select", systemImage: "checkmark.circle") { selecting = true }
                .disabled(children.isEmpty)
        }
        Section("View") {
            ForEach(FolderLayout.allCases, id: \.self) { choice in
                Toggle(choice.label, isOn: Binding(get: { layout == choice }, set: { _ in layout = choice }))
            }
        }
        Section("Sort by") {
            ForEach(SortKey.allCases, id: \.self) { key in
                Toggle(isOn: Binding(get: { sortKey == key }, set: { _ in
                    // The active key again reverses it; a new key starts the way people expect it.
                    if sortKey == key { sortAscending.toggle() } else { sortKey = key; sortAscending = key == .name }
                })) {
                    Text(key.label)
                    if sortKey == key { Text(key.direction(ascending: sortAscending)) }
                }
            }
        }
        Section("Show only") {
            // Only the tags this folder's items carry.
            let here = Set((store.folders[folderId] ?? []).map(\.id))
            let folderTags = store.tags.tags.filter { tag in !here.isDisjoint(with: store.tags.nodes(with: tag.id)) }
            if folderTags.isEmpty { Text("No tags in this folder") }
            ForEach(folderTags) { tag in
                Toggle(tag.name, isOn: Binding(get: { tagFilter == tag.id }, set: { _ in tagFilter = tagFilter == tag.id ? nil : tag.id }))
            }
        }
    }

    private func endSelecting() {
        selecting = false
        selection = []
    }

    private func startSelecting(_ item: Opened) {
        selecting = true
        selection = [item.id]
    }

    private func open(_ item: Opened) {
        Opener.open(item, store: store) { viewing = $0 }
    }
}

/* Placeholder rows while a folder loads, the shape of the real ones. */
private struct SkeletonRow: View {
    let index: Int

    var body: some View {
        HStack(spacing: Alpine.Space.s3) {
            RoundedRectangle(cornerRadius: 8).fill(Alpine.ink.opacity(0.07)).frame(width: Theme.mark, height: Theme.mark)
            VStack(alignment: .leading, spacing: 6) {
                Capsule().fill(Alpine.ink.opacity(0.07)).frame(width: CGFloat(170 - (index * 37) % 70), height: 11)
                Capsule().fill(Alpine.ink.opacity(0.05)).frame(width: 90, height: 9)
            }
            Spacer()
        }
        .frame(minHeight: Theme.row)
        .accessibilityHidden(true)
    }
}

/* "You, Sam and Priya can open everything in this folder." Manage opens the share sheet. */
struct AccessBanner: View {
    let text: String
    var link = false
    let manage: (() -> Void)?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Alpine.Space.s3) {
            // A folder anyone with its link can open shows the link icon; people only, the people icon.
            Image(systemName: link ? "link" : "person.2").foregroundStyle(Alpine.primary).accessibilityHidden(true)
            Text(text).font(Theme.Text.callout).foregroundStyle(Alpine.ink).frame(maxWidth: .infinity, alignment: .leading)
            if let manage {
                Button("Manage", action: manage).font(Theme.Text.callout.weight(.semibold)).foregroundStyle(Alpine.primary)
                    .buttonStyle(.borderless)
            }
        }
        .padding(.horizontal, Alpine.Space.s4).padding(.vertical, Alpine.Space.s3)
        .background(Alpine.surface, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .alpineCardEdge(RoundedRectangle(cornerRadius: 22, style: .continuous))
    }
}

/*
 * The toolbar while selecting, in the tab bar's place. Every button has a visible
 * label that is also its accessible name: Share, Move, Copy, More, Move to Trash.
 */
private struct SelectBar: View {
    @Environment(DriveStore.self) private var store
    let items: [Opened]
    @Binding var action: NodeAction?
    @Binding var moving: Bool
    let done: () -> Void

    var body: some View {
        HStack(spacing: 0) {
            slot("Share", "person.badge.plus", disabled: items.count != 1) {
                if let item = items.first { action = .share(item) }
                done()
            }
            slot("Move", "folder", disabled: items.isEmpty) { moving = true }
            slot("Copy", "doc.on.doc", disabled: items.isEmpty) {
                // The paste bar that appears is the confirmation; a notice would only cover it.
                store.copy(items)
                done()
            }
            Menu {
                let one = items.count == 1 ? items.first : nil
                Button("Send a copy", systemImage: "square.and.arrow.up") { if let one { action = .sendCopy(one) }; done() }
                    .disabled(one == nil || one?.isFolder == true)
                Button("Rename", systemImage: "pencil") { if let one { Rename.ask(one, store: store) }; done() }
                    .disabled(one == nil)
                Button("Tags", systemImage: "tag") { if let one { action = .tags(one) }; done() }
                    .disabled(one == nil)
            } label: {
                label("More", "ellipsis")
            }
            .disabled(items.isEmpty)
            .foregroundStyle(items.isEmpty ? Alpine.primary.opacity(0.35) : Alpine.primary)
            slot("Move to Trash", "trash", disabled: items.isEmpty, danger: true) {
                let picked = items
                done()
                Task { await store.trash(picked) }
            }
        }
        .padding(4)
        .frame(height: 62)
        .glassEffect(.regular, in: .capsule)
        .highContrastEdge(Capsule())
        .padding(.horizontal, Alpine.Space.s4).padding(.bottom, Alpine.Space.s2)
    }

    private func slot(_ title: String, _ symbol: String, disabled: Bool, danger: Bool = false, run: @escaping () -> Void) -> some View {
        Button(action: run) { label(title, symbol) }
            .buttonStyle(.plain)
            .foregroundStyle((danger ? Alpine.danger : Alpine.primary).opacity(disabled ? 0.35 : 1))
            .disabled(disabled)
    }

    private func label(_ title: String, _ symbol: String) -> some View {
        VStack(spacing: 3) {
            Image(systemName: symbol).font(.system(size: 19, weight: .medium)).frame(height: 22)
            Text(title).font(.system(size: 10, weight: .semibold)).lineLimit(1).minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity, minHeight: 54)
        .contentShape(Rectangle())
    }
}

/* What is on the clipboard, and Paste, or the reason it can't go here. One bar on both phones. */
private struct PasteBar: View {
    let text: String
    let reason: String?
    let paste: () -> Void
    let clear: () -> Void

    var body: some View {
        HStack(spacing: Alpine.Space.s3) {
            Image(systemName: "doc.on.clipboard").foregroundStyle(Alpine.inkMuted).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                Text(text).font(Theme.Text.callout.weight(.semibold)).foregroundStyle(reason == nil ? Alpine.ink : Alpine.inkMuted).lineLimit(1)
                if let reason { Text(reason).font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted).lineLimit(1) }
            }
            Spacer(minLength: 0)
            if reason == nil {
                Button("Paste", action: paste).buttonStyle(PrimaryCapsuleStyle()).controlSize(.small)
            }
            Button(action: clear) { Image(systemName: "xmark").font(.body.weight(.semibold)).foregroundStyle(Alpine.inkMuted).frame(width: 40, height: 40) }
                .buttonStyle(.plain).accessibilityLabel("Clear clipboard")
        }
        .padding(.leading, Alpine.Space.s4).padding(.trailing, 6).padding(.vertical, 6)
        .glassEffect(.regular, in: .capsule)
        .highContrastEdge(Capsule())
        .padding(.horizontal, Alpine.Space.s4).padding(.bottom, Alpine.Space.s2)
    }
}

/* How a folder shows its items: rows, or tiles with bigger pictures. The raw values are what AppStorage keeps. */
enum FolderLayout: String, CaseIterable {
    case list, grid

    var label: String { self == .list ? "List" : "Grid" }
}

private extension View {
    /* The long-press preview: the tile on the screen's ground with a little room around it, the selected tint's shape. */
    func tilePreview() -> some View {
        self.padding(Alpine.Space.s1)
            .background(Alpine.ground)
            .contentShape(.contextMenuPreview, NodeTile.halo)
            .padding(-Alpine.Space.s1)
    }
}

/* What a folder list is ordered by. Folders come first whichever key is chosen, as every drive does it. */
enum SortKey: String, CaseIterable {
    // The raw values are what AppStorage kept before "Modified" became "Changed".
    case name, modified, size

    var label: String {
        switch self {
        case .name: return "Name"
        case .modified: return "Changed"
        case .size: return "Size"
        }
    }

    /* The direction in words, as the board spells it. */
    func direction(ascending: Bool) -> String {
        switch self {
        case .name: return ascending ? "A to Z" : "Z to A"
        case .modified: return ascending ? "Oldest first" : "Newest first"
        case .size: return ascending ? "Smallest first" : "Largest first"
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
