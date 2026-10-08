import HushOSKit
import QuickLook
import SwiftUI
import UniformTypeIdentifiers

/*
 * The sheets the item menu opens (DESIGN.md): the Move picker,
 * Send a copy, Versions, Info and an item's Tags. Each says what happens in plain
 * words; none talks about keys or encryption.
 */

extension DriveStore {
    /* "Sam and anyone with the link": who besides you opens a shared item, in Android's words. */
    func whoCanOpen(_ sharedId: String) -> String? {
        guard let entry = sharing[sharedId], !entry.people.isEmpty || entry.links > 0 else { return nil }
        let who = Self.names(entry.people.map(Self.firstName) + (entry.links > 0 ? ["anyone with the link"] : []))
        return who.prefix(1).uppercased() + who.dropFirst()
    }
}

/* MARK: Move */

/*
 * One folder browser, starting where the item is. Crumbs go back; the top level lists
 * Files and the folders others shared with this account that it can edit, so a move into
 * someone's folder (copied across, the original to the Trash) needs no Cut and Paste.
 */
struct MovePicker: View {
    @Environment(DriveStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let items: [Opened]
    /* The folder shown; nil until the start is known. */
    @State private var at: String?

    private var moving: Set<String> { Set(items.map(\.id)) }

    private var folders: [Opened] {
        guard let at else { return [] }
        return (store.folders[at] ?? []).filter { $0.isFolder && !moving.contains($0.id) }.sorted(by: Opened.byName)
    }

    /* Shared folders this account may write into, at the top level beside Files. */
    private var sharedFolders: [ShareMount] {
        store.mounts.filter { $0.share.role == "editor" && $0.root?.isFolder == true }
    }

    /* From the top down to `at`: the folders a crumb can go back to. */
    private var trail: [(id: String, name: String)] {
        guard let at else { return [] }
        var chain: [(String, String)] = []
        var cursor: String? = at
        while let id = cursor, chain.count < 64 {
            if id == store.rootId { chain.append((id, "Files")); break }
            if let mount = store.mounts.first(where: { $0.root?.id == id }), let root = mount.root {
                // A shared folder is reached from the top level, beside Files: going back lands there.
                chain.append((id, root.name))
                if let top = store.rootId { chain.append((top, "Files")) }
                break
            }
            guard let node = store.known(id) else { break }
            chain.append((id, node.name))
            cursor = node.node.parentId
        }
        return chain.reversed()
    }

    private var here: String { trail.last?.name ?? "Files" }
    private var alreadyHere: Bool { items.allSatisfy { $0.node.parentId == at } }

    /* Who will be able to open what is moved, when the place is shared. */
    private var audience: String? {
        guard let at else { return nil }
        if let mount = store.mounts.first(where: { mount in trail.contains { $0.id == mount.root?.id } }), let root = mount.root {
            return "Everyone who can open “\(root.name)” will be able to open it there."
        }
        guard let shared = store.sharedAncestor(from: at), let who = store.whoCanOpen(shared) else { return nil }
        // Already shared the same way: nothing new to say.
        if items.allSatisfy({ item in item.node.parentId.flatMap { store.sharedAncestor(from: $0) } == shared }) { return nil }
        return "\(who) will be able to open \(items.count == 1 ? "it" : "them") there."
    }

    var body: some View {
        NavigationStack {
            List {
                if !trail.isEmpty { crumbs.bareRow(top: 0, bottom: Alpine.Space.s1) }
                Section {
                    if let at, store.folders[at] == nil {
                        ProgressView().frame(maxWidth: .infinity).listRowBackground(Alpine.surface)
                    } else if folders.isEmpty {
                        Text("No folders in here.").font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted)
                            .frame(maxWidth: .infinity).padding(.vertical, Alpine.Space.s6).alpineRow()
                    }
                    ForEach(folders) { folder in
                        Button { at = folder.id } label: {
                            pickerRow(folder, detail: store.whoCanOpen(folder.id), link: (store.sharing[folder.id]?.links ?? 0) > 0)
                        }
                            .buttonStyle(.plain).itemRow()
                    }
                }
                if at == store.rootId, !sharedFolders.isEmpty {
                    Section {
                        ForEach(sharedFolders) { mount in
                            if let root = mount.root {
                                Button { at = root.id } label: {
                                    pickerRow(root, detail: "From \(mount.share.granter.name.isEmpty ? mount.share.granter.email : mount.share.granter.name)")
                                }
                                .buttonStyle(.plain).itemRow()
                            }
                        }
                    } header: {
                        Text("Shared with you").font(Theme.Text.label).foregroundStyle(Alpine.inkMuted)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .alpineGrouped()
            .environment(\.defaultMinListRowHeight, 1)
            .navigationTitle("Move to")
            .navigationSubtitle(Text(items.count == 1 ? items[0].name : "\(items.count) items"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: Alpine.Space.s2) {
                    if let audience, !alreadyHere {
                        Text(audience).font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted).multilineTextAlignment(.center)
                    }
                    Button {
                        guard let at else { return }
                        let picked = items
                        let name = here
                        dismiss()
                        Task { await store.move(picked, to: at, named: name) }
                    } label: {
                        Text(alreadyHere ? "Already here" : "Move here").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(PrimaryCapsuleStyle())
                    .disabled(alreadyHere || at == nil)
                    .opacity(alreadyHere ? 0.45 : 1)
                }
                .padding(.horizontal, Alpine.Space.s4).padding(.top, Alpine.Space.s3).padding(.bottom, Alpine.Space.s2)
                .background(Alpine.ground)
            }
            .task(id: at) {
                if at == nil { at = items.first?.node.parentId ?? store.rootId }
                if !store.mountsLoaded { await store.refreshMounts() }
                if let at, store.folders[at] == nil { await store.refresh(folder: at) }
            }
        }
        .presentationDetents([.large])
    }

    private var crumbs: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Alpine.Space.s1) {
                if trail.count > 1 {
                    Button { at = trail.dropLast().last?.id } label: {
                        Image(systemName: "chevron.left").font(.body.weight(.semibold)).frame(width: 32, height: 32)
                    }
                    .accessibilityLabel("Up one folder")
                }
                ForEach(Array(trail.enumerated()), id: \.offset) { index, crumb in
                    if index > 0 { Image(systemName: "chevron.right").font(.caption).foregroundStyle(Alpine.inkMuted) }
                    if index == trail.count - 1 {
                        Text(crumb.name).font(Theme.Text.callout.weight(.semibold)).foregroundStyle(Alpine.ink)
                    } else {
                        Button(crumb.name) { at = crumb.id }.font(Theme.Text.callout).foregroundStyle(Alpine.primary)
                    }
                }
            }
            .padding(.horizontal, Alpine.Space.s1)
            .buttonStyle(.plain)
            .foregroundStyle(Alpine.primary)
        }
    }

    private func pickerRow(_ folder: Opened, detail: String?, link: Bool = false) -> some View {
        HStack(spacing: Alpine.Space.s3) {
            FolderGlyph().frame(width: Theme.mark * 0.9, height: Theme.mark * 0.9 * 46 / 56).frame(width: Theme.mark, height: Theme.mark)
            VStack(alignment: .leading, spacing: 2) {
                Text(folder.name).font(Theme.Text.body).foregroundStyle(Alpine.ink).lineLimit(1)
                if let detail { AccessText.line(detail, link: link).font(Theme.Text.footnote).lineLimit(1) }
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Alpine.inkMuted)
        }
        .frame(minHeight: Theme.row)
        .contentShape(Rectangle())
    }
}

/* MARK: Send a copy */

/*
 * A short wait while the plain copy is prepared, saying once that whoever gets it can
 * open it without HushOS, then the system share sheet. A failure says what to do.
 */
struct SendCopySheet: View {
    @Environment(DriveStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let item: Opened
    var version: VersionListView? = nil
    @State private var url: URL?
    @State private var failed = false
    @State private var attempt = 0

    var body: some View {
        Group {
            if failed {
                VStack(spacing: Alpine.Space.s3) {
                    EmptyStateView(symbol: "exclamationmark.triangle", danger: true, title: "Couldn’t prepare “\(item.name)”", message: "Check your connection and try again.")
                    HStack(spacing: Alpine.Space.s2) {
                        Button("Cancel") { dismiss() }.buttonStyle(SecondaryCapsuleStyle())
                        Button("Try again") { failed = false; attempt += 1 }.buttonStyle(PrimaryCapsuleStyle())
                    }
                }
                .padding(Alpine.Space.s4)
            } else {
                VStack(spacing: Alpine.Space.s3) {
                    FileMark(item: item, box: 52)
                    Text("Preparing a copy…").font(Theme.Text.headline).foregroundStyle(Alpine.ink)
                    Text("Whoever you send it to can open it without HushOS.").font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted)
                        .multilineTextAlignment(.center)
                    ProgressView(value: store.opening[item.id] ?? 0).tint(Alpine.primary)
                    Button { dismiss() } label: { Text("Cancel").frame(maxWidth: .infinity) }.buttonStyle(SecondaryCapsuleStyle())
                }
                .padding(.horizontal, Alpine.Space.s6).padding(.vertical, Alpine.Space.s4)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Alpine.ground)
        .presentationDetents([.height(300)])
        .task(id: attempt) {
            do {
                let ready = try await store.fetch(item, version: version)
                url = ready
                // The system share sheet on its own, once this one has gone, rather than a sheet inside a sheet.
                dismiss()
                Task { @MainActor in
                    // Wait for this sheet to finish going, then present from whatever is on top.
                    for _ in 0 ..< 30 {
                        try? await Task.sleep(for: .milliseconds(100))
                        if let top = TextPrompt.topController(), !top.isBeingDismissed, !top.isBeingPresented, !(top.presentingViewController != nil && top.view.window == nil) { break }
                    }
                    TextPrompt.topController()?.present(UIActivityViewController(activityItems: [ready], applicationActivities: nil), animated: true)
                }
            } catch {
                failed = true
            }
        }
    }
}

/* MARK: Versions */

/*
 * The current version and the earlier one, with the retention in one plain line. The
 * earlier version's menu: Preview, Restore, Send a copy, and Delete earlier version,
 * which asks first. Restoring holds the row in "Restoring…" until it is done.
 */
struct VersionsSheet: View {
    @Environment(DriveStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let item: Opened
    @State private var versions: [VersionListView] = []
    @State private var sizes: [String: UInt64] = [:]
    @State private var loaded = false
    @State private var failure: String?
    @State private var restoring: String?
    @State private var deleting: VersionListView?
    @State private var previewing: VersionListView?
    @State private var sending: VersionListView?
    @State private var shown: Opened

    init(item: Opened) {
        self.item = item
        _shown = State(initialValue: item)
    }

    static let retention = "When you replace a file, the version it replaced stays here for 30 days."

    private var current: VersionListView? { versions.first(where: \.current) }
    private var earlier: [VersionListView] { versions.filter { !$0.current && $0.status == "ready" } }

    var body: some View {
        NavigationStack {
            List {
                if let failure {
                    Text(failure).foregroundStyle(Alpine.danger).alpineRow()
                }
                if let current {
                    Section {
                        versionRow(current, note: size(current))
                    } header: {
                        Text("Current version").font(Theme.Text.label).foregroundStyle(Alpine.inkMuted)
                    }
                }
                if loaded {
                    Section {
                        if earlier.isEmpty {
                            Text("No earlier version. When you replace this file, the old one waits here for 30 days.")
                                .font(Theme.Text.callout).foregroundStyle(Alpine.inkMuted).padding(.vertical, Alpine.Space.s2).alpineRow()
                        }
                        ForEach(earlier) { version in
                            Menu {
                                Button("Preview", systemImage: "eye") { previewing = version }
                                Button("Restore", systemImage: "arrow.uturn.backward") { restore(version) }
                                Button("Send a copy", systemImage: "square.and.arrow.up") { sending = version }
                                Divider()
                                Button("Delete earlier version", systemImage: "trash", role: .destructive) { deleting = version }.tint(Alpine.danger)
                            } label: {
                                versionRow(version, note: restoring == version.id ? "Restoring…" : earlierNote(version), menu: restoring == nil)
                            }
                            .disabled(restoring != nil)
                            .itemRow()
                        }
                    } header: {
                        Text(earlier.count > 1 ? "Earlier versions" : "Earlier version").font(Theme.Text.label).foregroundStyle(Alpine.inkMuted)
                    } footer: {
                        if !earlier.isEmpty { Text(Self.retention).font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted) }
                    }
                } else {
                    ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
                }
            }
            .listStyle(.insetGrouped)
            .alpineGrouped()
            .environment(\.defaultMinListRowHeight, 1)
            .navigationTitle("Versions")
            .navigationSubtitle(Text(item.name))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .alert("Delete the earlier version?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })) {
                Button("Cancel", role: .cancel) { deleting = nil }
                Button("Delete version", role: .destructive) {
                    guard let version = deleting else { return }
                    deleting = nil
                    Task {
                        if await store.discardVersion(version, of: shown) {
                            store.notify("Earlier version of “\(item.name)” deleted")
                            await load()
                        }
                    }
                }
            } message: {
                if let deleting { Text("It’s deleted for good and its \(size(deleting) ?? "space") is freed. The current version isn’t touched.") }
            }
            .sheet(item: $sending) { version in SendCopySheet(item: shown, version: version).environment(store) }
            .fullScreenCover(item: $previewing) { version in
                FileViewer(items: [shown], start: shown, version: version, versionNote: earlierBanner(version)) {
                    previewing = nil
                    restore(version)
                }
                .environment(store)
            }
            .task { await load() }
        }
    }

    private func versionRow(_ version: VersionListView, note: String?, menu: Bool = false) -> some View {
        HStack(spacing: Alpine.Space.s3) {
            FileMark(item: shown).opacity(version.current ? 1 : 0.7)
            VStack(alignment: .leading, spacing: 2) {
                Text(changedLabel(parseDate(version.createdAt)) ?? version.createdAt).font(Theme.Text.body).foregroundStyle(Alpine.ink)
                if let note { Text(note).font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted).lineLimit(1) }
            }
            Spacer(minLength: 0)
            if restoring == version.id {
                ProgressView().controlSize(.small)
            } else if menu {
                Image(systemName: "ellipsis").font(.body.weight(.semibold)).foregroundStyle(Alpine.primary)
                    .frame(width: 36, height: 36).background(Alpine.ink.opacity(0.06), in: Circle())
            }
        }
        .frame(minHeight: Theme.row)
        .contentShape(Rectangle())
    }

    private func size(_ version: VersionListView) -> String? {
        sizes[version.id].map { formatBytes(Int64($0)) } ?? version.plaintextSize.flatMap(Int64.init).map(formatBytes)
    }

    /* Days left: 30 from when it was replaced (its supersededAt), as the server counts them. */
    private func daysLeft(_ version: VersionListView) -> Int? {
        guard let replaced = parseDate(version.supersededAt) else { return nil }
        let gone = Calendar.current.date(byAdding: .day, value: 30, to: replaced) ?? replaced
        return max(0, Calendar.current.dateComponents([.day], from: .now, to: gone).day ?? 0)
    }

    private func earlierNote(_ version: VersionListView) -> String {
        let days = daysLeft(version).map { " · deleted in \($0) \($0 == 1 ? "day" : "days")" } ?? ""
        return (size(version) ?? "") + days
    }

    private func earlierBanner(_ version: VersionListView) -> String {
        let replaced = parseDate(version.supersededAt).flatMap(changedLabel).map { "Replaced \($0)" } ?? "Replaced"
        let days = daysLeft(version).map { "; it stays \($0) more \($0 == 1 ? "day" : "days")." } ?? "."
        return replaced + days
    }

    private func restore(_ version: VersionListView) {
        restoring = version.id
        Task {
            let ok = await store.restoreVersion(version, of: shown)
            if ok {
                if let fresh = try? await store.reload(shown) { shown = fresh }
                store.notify("Earlier version restored. The one it replaced is now the earlier version.")
            }
            await load()
            restoring = nil
        }
    }

    private func load() async {
        do {
            versions = try await store.vault.versions(of: item.id)
            failure = nil
        } catch {
            failure = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
        loaded = true
        // Sizes are sealed in each version's envelope, so they are opened here rather than read off the list.
        for version in versions where sizes[version.id] == nil {
            if let opened = try? await store.vault.openVersion(shown, version: version) { sizes[version.id] = opened.content.plaintextSize }
        }
    }
}

/* MARK: Info */

/* Plain facts in the same order on every client, then who can open and tags, each a way in. */
struct InfoSheet: View {
    @Environment(DriveStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let item: Opened
    var open: (NodeAction) -> Void = { _ in }

    var body: some View {
        NavigationStack {
            List {
                Section {} header: {
                    VStack(spacing: Alpine.Space.s2) {
                        FileMark(item: item, box: store.thumbnails[item.id] != nil ? 120 : 88)
                        Text(item.name).font(.title3.weight(.bold)).foregroundStyle(Alpine.ink).multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity)
                    .textCase(nil)
                    .listRowInsets(EdgeInsets(top: Alpine.Space.s2, leading: 0, bottom: 0, trailing: 0))
                }
                Section {
                    fact("Kind", kind)
                    if let size = item.size { fact("Size", formatBytes(Int64(size))) }
                    if item.isFolder, let count = store.folders[item.id]?.count { fact("Size", count == 1 ? "1 item" : "\(count) items") }
                    // Said as the rows and the web's details say it: "Today, 11:17 AM", "Yesterday", "6 Oct".
                    if let changed = changedLabel(item.modified) { fact("Changed", changed) }
                    if let created = changedLabel(parseDate(item.node.createdAt)) { fact("Created", created) }
                    if let folder = folderName, let parent = item.node.parentId {
                        // Where it is, one tap away: Files opens at that folder.
                        Button {
                            dismiss()
                            store.route = parent == store.rootId ? .files(folder: nil, preview: nil) : .node(id: parent)
                        } label: { link("Folder", value: Text(folder).foregroundStyle(Alpine.inkMuted)) }
                        .alpineRow()
                        .accessibilityHint("Opens “\(folder)” in Files")
                    }
                }
                Section {
                    if store.isOwn(item) {
                        Button { dismiss(); open(.share(item)) } label: { sentence("Who can open", value: whoCanOpen, chevron: true) }
                            .alpineRow()
                        Button { dismiss(); open(.tags(item)) } label: {
                            let tags = store.tags.tags(of: item.id)
                            link("Tags", value: Text(tags.isEmpty ? "None" : tags.map(\.name).joined(separator: ", ")).foregroundStyle(Alpine.inkMuted))
                        }
                        .alpineRow()
                    } else {
                        sentence("Who can open", value: whoCanOpen, chevron: false).alpineRow()
                    }
                }
            }
            .listStyle(.insetGrouped)
            .alpineGrouped()
            .navigationTitle("Info")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task { store.thumbnail(for: item) }
        }
    }

    private var kind: String {
        if item.isFolder { return "Folder" }
        let type = NodeRow.type(for: item)
        let ext = (item.name as NSString).pathExtension.uppercased()
        // The system has no name for unknown types ("data"); say what the name says instead.
        if type == .data || type.localizedDescription == nil { return ext.isEmpty ? "File" : "\(ext) file" }
        return type.localizedDescription ?? "File"
    }

    private var folderName: String? {
        guard let parent = item.node.parentId else { return nil }
        if parent == store.rootId { return "Files" }
        return store.known(parent)?.name ?? store.names[parent]
    }

    private var whoCanOpen: String {
        guard store.isOwn(item) else {
            let mount = store.mounts.first { $0.share.workspaceId == item.node.workspaceId }
            return mount.map { "Shared by \($0.share.granter.name.isEmpty ? $0.share.granter.email : $0.share.granter.name)" } ?? "Shared with you"
        }
        // Everyone it opens to, you first: its own people and links, or the folder's it sits in.
        if let who = store.whoCanOpenWithYou(item.id) { return who }
        if let parent = item.node.parentId, let shared = store.sharedAncestor(from: parent), let who = store.whoCanOpenWithYou(shared) { return who }
        return "Only you"
    }

    /*
     * A value that is a sentence ("You, Sam and anyone with the link"): beside its label when
     * short, on its own line under it when long, always whole. No link icon here; that is for
     * list rows, where space is short.
     */
    @ViewBuilder private func sentence(_ label: String, value: String, chevron: Bool) -> some View {
        let chevronMark = Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Alpine.inkMuted)
        if value.count <= 18 {
            HStack {
                Text(label).foregroundStyle(Alpine.ink)
                Spacer()
                Text(value).foregroundStyle(Alpine.inkMuted)
                if chevron { chevronMark }
            }
            .contentShape(Rectangle())
        } else {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(label).foregroundStyle(Alpine.ink)
                    Text(value).foregroundStyle(Alpine.inkMuted).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                if chevron { chevronMark }
            }
            .padding(.vertical, Alpine.Space.s1)
            .contentShape(Rectangle())
        }
    }

    private func fact(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).foregroundStyle(Alpine.ink)
            Spacer()
            Text(value).foregroundStyle(Alpine.inkMuted).multilineTextAlignment(.trailing)
        }
        .alpineRow()
    }

    private func link(_ label: String, value: Text) -> some View {
        HStack {
            Text(label).foregroundStyle(Alpine.ink)
            Spacer()
            value.lineLimit(1)
            Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Alpine.inkMuted)
        }
        .contentShape(Rectangle())
    }
}

/* MARK: An item's tags */

/*
 * Tick tags on and off, or type to find or add one. Removing a tag from the whole
 * list happens only in Manage tags, which asks first.
 */
struct ItemTagsSheet: View {
    @Environment(DriveStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let item: Opened
    @State private var selected: Set<String> = []
    @State private var query = ""
    @State private var loaded = false
    @State private var managing = false

    private var shown: [Tag] {
        let needle = query.trimmingCharacters(in: .whitespaces)
        return store.tags.tags.filter { needle.isEmpty || $0.name.localizedCaseInsensitiveContains(needle) }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {} header: {
                    HStack(spacing: Alpine.Space.s2) {
                        HStack(spacing: Alpine.Space.s2) {
                            Image(systemName: "magnifyingglass").foregroundStyle(Alpine.inkMuted)
                            TextField("Find or add a tag", text: $query).submitLabel(.done).onSubmit(create).foregroundStyle(Alpine.ink)
                        }
                        .padding(.horizontal, 14).frame(height: Theme.control)
                        .background(Alpine.surface, in: Capsule())
                        .highContrastEdge(Capsule())
                        Button("Add", action: create).buttonStyle(PrimaryCapsuleStyle())
                            .disabled(query.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                    .textCase(nil)
                    .listRowInsets(EdgeInsets(top: Alpine.Space.s2, leading: 0, bottom: Alpine.Space.s2, trailing: 0))
                }
                Section {
                    if loaded && shown.isEmpty {
                        if query.trimmingCharacters(in: .whitespaces).isEmpty {
                            Text("No tags yet. Tags group items across folders.").foregroundStyle(Alpine.inkMuted).alpineRow()
                        } else {
                            Button { create() } label: {
                                Label("Add “\(query.trimmingCharacters(in: .whitespaces))”", systemImage: "plus").foregroundStyle(Alpine.primary)
                            }
                            .alpineRow()
                        }
                    }
                    ForEach(shown) { tag in
                        let on = selected.contains(tag.id)
                        Button {
                            if on { selected.remove(tag.id) } else { selected.insert(tag.id) }
                        } label: {
                            HStack(spacing: Alpine.Space.s3) {
                                TagDot(tag: tag, size: 14)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(tag.name).font(.body.weight(on ? .semibold : .regular)).foregroundStyle(Alpine.ink)
                                    let count = store.tags.nodes(with: tag.id).count
                                    Text(count == 1 ? "1 item" : "\(count) items").font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted)
                                }
                                Spacer()
                                SelectCheck(on: on)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(on ? .isSelected : [])
                        .alpineRow()
                    }
                } footer: {
                    Text("Only you see your tags. People you share with don’t.").font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted)
                }
                Section {
                    Button { managing = true } label: {
                        HStack { Text("Manage tags").foregroundStyle(Alpine.primary); Spacer(); Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Alpine.inkMuted) }
                    }
                    .alpineRow()
                } footer: {
                    Text("Rename, recolour or remove a tag from your whole list.").font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted)
                }
            }
            .listStyle(.insetGrouped)
            .alpineGrouped()
            .navigationTitle("Tags")
            .navigationSubtitle(Text(item.name))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        let ids = Array(selected)
                        let nodeId = item.id
                        dismiss()
                        Task { await store.editTags { registry in try registry.assign(nodeId, tagIds: ids) } }
                    }
                }
            }
            .sheet(isPresented: $managing) { TagManagerSheet().environment(store) }
        }
        .task {
            await store.refreshTags()
            selected = Set(store.tags.tags(of: item.id).map(\.id))
            loaded = true
        }
    }

    private func create() {
        let name = query.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return }
        query = ""
        if let existing = store.tags.tags.first(where: { $0.name.caseInsensitiveCompare(name) == .orderedSame }) {
            selected.insert(existing.id)
            return
        }
        Task {
            await store.editTags { registry in _ = try registry.add(name: name) }
            if let created = store.tags.tags.first(where: { $0.name.caseInsensitiveCompare(name) == .orderedSame }) { selected.insert(created.id) }
        }
    }
}
