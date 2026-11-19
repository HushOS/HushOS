import HushOSKit
import QuickLook
import SwiftUI

/*
 * Opening a file (DESIGN.md): Apple's QuickLook in the middle, which
 * previews more kinds than we could, with HushOS around it; Markdown is drawn by MarkdownView,
 * since QuickLook shows it as raw text. The header has Done, the
 * name and where you are in the folder, Share and More (the same item menu as a
 * long-press); the foot says who can open it, its size and when it changed, with Send
 * a copy. Tap the left or right edge for the previous or next file. An earlier version
 * opens in the same viewer with a banner saying which it is, and Restore.
 */
struct FileViewer: View {
    @Environment(DriveStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let items: [Opened]
    var version: VersionListView? = nil
    var versionNote: String? = nil
    var onRestore: (() -> Void)? = nil
    @State private var current: Opened
    @State private var url: URL?
    @State private var failed = false
    @State private var attempt = 0
    @State private var action: NodeAction?
    /* The text editor over the file on screen (TextEditorScreen). */
    @State private var editing: Opened?
    /* Moved on when something asks the viewer to go (a link): the editor asks about its changes, then closes. */
    @State private var leaveAsked = 0
    /* The file on screen (id and version) read as text although its name says nothing: offered Edit too. */
    @State private var readAsText: String?
    /* The file on screen, once a loaded listing of its folder showed it: only then can that listing say it's gone. */
    @State private var seenListed: String?

    init(items: [Opened], start: Opened, version: VersionListView? = nil, versionNote: String? = nil, onRestore: (() -> Void)? = nil) {
        self.items = items.isEmpty ? [start] : items
        self.version = version
        self.versionNote = versionNote
        self.onRestore = onRestore
        _current = State(initialValue: start)
    }

    private var index: Int { items.firstIndex { $0.id == current.id } ?? 0 }

    /* A zip's current version opens as its list (ArchiveScreen); an earlier version still comes down to QuickLook. */
    private var isArchive: Bool { version == nil && ArchiveEntries.handles(name: current.name, mime: current.metadata.mime) }

    var body: some View {
        NavigationStack {
            page
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { toolbar }
        }
        // A mark's check started in the viewer is the viewer's to show (the mark leaves once the writer is added).
        .contactHost(.viewer, store: store)
    }

    /* The system's bars: Done, the name and where you are, Share and More above; who can open it and Send a copy below. */
    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button { dismiss() } label: { HeaderWord(text: "Done") }
        }
        ToolbarItem(placement: .principal) { title }
        if version == nil {
            ToolbarItemGroup(placement: .topBarTrailing) {
                // Text and code, for whoever may change the file: an owner, an editor of the share, a
                // family folder this phone may write. Never an earlier version.
                if editable {
                    Button {
                        // From here a link waits for the editor (DriveStore.route) instead of replacing the screens under it.
                        store.editorOpen = true
                        editing = current
                    } label: { HeaderIcon(symbol: "pencil") }
                        .accessibilityLabel(EditorWords.edit)
                }
                if store.role(of: current) == .owner {
                    Button { action = .share(current) } label: { HeaderIcon(symbol: "person.badge.plus") }
                        .accessibilityLabel("Share")
                }
                Menu { NodeMenu(item: current, action: $action) } label: { HeaderIcon(symbol: "ellipsis") }
                    .accessibilityLabel("More")
            }
            ToolbarItem(placement: .bottomBar) {
                HStack(spacing: Alpine.Space.s2) {
                    access.font(Theme.Text.footnote).lineLimit(1)
                    Spacer(minLength: 0)
                    Text([current.size.map { formatBytes(Int64($0)) }, changedLabel(current.modified)].compactMap { $0 }.joined(separator: " · "))
                        .font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted).lineLimit(1)
                }
                .padding(.horizontal, Alpine.Space.s2)
            }
            // A zip's list runs to the edges, so the side strips are off over it: the previous and next file are here
            // instead, or paging onto a zip would leave no way on but Done.
            if isArchive, items.count > 1 {
                ToolbarItem(placement: .bottomBar) {
                    Button { step(-1) } label: { HeaderIcon(symbol: "chevron.left") }
                        .accessibilityLabel("Previous file")
                }
                ToolbarItem(placement: .bottomBar) {
                    Button { step(1) } label: { HeaderIcon(symbol: "chevron.right") }
                        .accessibilityLabel("Next file")
                }
            }
            ToolbarItem(placement: .bottomBar) {
                Button { action = .sendCopy(current) } label: { HeaderIcon(symbol: "square.and.arrow.up") }
                    .accessibilityLabel("Send a copy")
            }
        }
    }

    private var page: some View {
        VStack(spacing: 0) {
            ZStack {
                if isArchive {
                    // A zip opens as the list of what is inside it, read by range; it is never fetched whole to a file.
                    ArchiveScreen(item: current, adopted: { current = $0 })
                        // A view of its own per file: paging from one zip to another never carries its failure,
                        // listing or download rows over (a newer row of the same file keeps its id, and its view).
                        .id(current.id)
                } else if let url {
                    // Markdown as a document (MarkdownView); QuickLook shows it as raw text. Past the limit, QuickLook.
                    // The limit is the opened file's own size: an earlier version's isn't the current one's.
                    if MarkdownDocument.handles(name: current.name, mime: current.metadata.mime),
                       let bytes = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, bytes <= MarkdownDocument.limit {
                        MarkdownView(url: url)
                    } else {
                        QuickLookView(url: url).ignoresSafeArea(edges: .horizontal)
                    }
                } else if failed {
                    EmptyStateView(title: "“\(current.name)” couldn’t be opened",
                                   message: store.offline ? "You’re offline. Files you keep on this phone open without a connection." : "Check your connection and try again.") {
                        Button("Try again") { failed = false; attempt += 1 }.buttonStyle(PrimaryCapsuleStyle())
                    }
                } else {
                    VStack(spacing: Alpine.Space.s3) {
                        FileMark(item: current, box: 72)
                        Text(current.name).font(Theme.Text.headline).foregroundStyle(Alpine.ink).multilineTextAlignment(.center)
                        ProgressView(value: store.opening[current.id] ?? 0).tint(Alpine.primary).frame(maxWidth: 200)
                    }
                    .padding(Alpine.Space.s8)
                }
                // Not over an archive's list: its rows and crumbs run to the edges, and a tap there must open them.
                if version == nil, items.count > 1, !isArchive { edges }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            if version != nil { versionFoot }
        }
        // Under the keyboard too: an archive's password field shrinks the page while the keyboard is up, and as it goes
        // the space it leaves showed the cover's own white until the page grew back (the band under the password card).
        .background(Alpine.ground.ignoresSafeArea())
        .nodeActionSheets(action: $action, store: store, beside: false)
        .fullScreenCover(item: $editing) { file in
            TextEditorScreen(item: file, leaveAsked: leaveAsked, onStay: { store.dropRoute() }, onSaved: { landed in
                // Saved over the file on screen: the viewer shows that version, read again.
                guard landed.id == current.id, landed.ref == current.ref else { return }
                current = landed
                attempt += 1
            }).environment(store)
        }
        // Somewhere else was asked for (a link, a notification, Info's Folder row): get out of its way.
        .onChange(of: store.route) { _, link in
            if link != nil, editing == nil { dismiss() }
        }
        // While the editor is open a link is held at the store (DriveStore.route) and the editor asked first (with
        // changes, Discard or Keep editing); the viewer goes once it has closed, the link released then.
        .onChange(of: store.editorLeaveAsked) { _, _ in
            if editing != nil { leaveAsked += 1 }
        }
        // Keyed on the session's vault too: a new session (the same account signed in again from Files) cancels a copy
        // under way, and the copy starts again under the new one rather than waiting on a cancelled one.
        .task(id: "\(current.id)-\(attempt)-\(ObjectIdentifier(store.vault).hashValue)") {
            url = nil
            if isArchive { return }
            // Paged past before it came down: the next page's task is the one that counts. A newer version the vault learned
            // comes down instead, and the viewer shows that row.
            do { url = try await store.fetch(current, version: version, adopted: { current = $0 }) } catch where !ErrorWords.isCancellation(error) { failed = true } catch {}
            // A file of no kind it knows whose bytes read as text (an extensionless README): offered Edit, as the web's
            // viewer does after its sniff. The editor reads and checks it again for itself.
            if let url, version == nil, !TextEditing.opens(current), ItemKind.of(current) == nil, (current.size ?? 0) <= TextEditing.limit {
                let key = sniffKey(current)
                // Read no further than the editor would take, whatever size the row says (or doesn't).
                let text = await Task.detached { TextEditing.readsAsText(fileAt: url) }.value
                if text, sniffKey(current) == key { readAsText = key }
            }
        }
        // A family's file that failed while its family wasn't open yet (a new session's vault, before the family is checked
        // again): asked again once the family has been shown anew. The fetch lists the file's folder itself when the vault
        // doesn't hold its row (Vault.holdForCopy), so the retry doesn't wait on the screens' listings.
        .onChange(of: familyShown) { _, _ in
            if failed { failed = false; attempt += 1 }
        }
        .onChange(of: listedHere, initial: true) { _, id in
            if let id { seenListed = id }
        }
        // Moved or deleted elsewhere: an editor with the person's text stays over it (Save as a copy keeps it).
        .onChange(of: movedAway) { _, gone in
            if gone, editing == nil { dismiss() }
        }
        // A family's removal takes everything with it, an open editor and its text included, whatever moved before.
        .onChange(of: familyGone) { _, gone in
            guard gone else { return }
            editing = nil
            dismiss()
        }
        // What the editor held goes on when its own screen has gone (TextEditorScreen's onDisappear), never when
        // this viewer is covered by it: a link released then reaches .onChange(of: store.route) above.
        .onChange(of: editing == nil) { _, closed in
            if closed, removed || store.route != nil { dismiss() }
        }
    }

    private func sniffKey(_ item: Opened) -> String { "\(item.id)-\(item.node.currentVersion?.id ?? "")" }

    /* Whether the file on screen offers Edit: text by its name and type, small enough, and this person may change it. */
    private var editable: Bool {
        version == nil && (TextEditing.opens(current) || readAsText == sniffKey(current)) && (current.size ?? 0) <= TextEditing.limit
            && store.mayEdit(current)
    }

    /* How many times the file's family was shown (FamilySync's checks): nil for a file in no family. */
    private var familyShown: Int? {
        guard store.isFamily(current), let groupId = store.familyAreaGroups[current.node.workspaceId.lowercased()] else { return nil }
        return store.familyRefreshed[groupId] ?? 0
    }

    /* The file on screen's id while its folder's loaded listing shows it. */
    private var listedHere: String? {
        guard let listed = store.folders[current.node.parentId ?? ""], listed.contains(where: { $0.id == current.id }) else { return nil }
        return current.id
    }

    /*
     * Whether the file on screen is confirmed gone: its folder's loaded listing showed it and a
     * loaded listing no longer does (moved to the Trash or elsewhere from the menu), or its family was
     * removed, forked or refused. A listing that never showed it (a folder not listed, a cached
     * listing older than the file, paged to) says nothing, nor does a folder whose listing was merely
     * let go of (a rotation's failure clears them), nor a family whose state isn't known yet.
     */
    private var removed: Bool { movedAway || familyGone }

    /* Moved or deleted by someone (its folder's listing no longer shows it): the editor, if open, keeps its text. */
    private var movedAway: Bool {
        guard version == nil else { return false }
        return seenListed == current.id && store.folders[current.node.parentId ?? ""] != nil && listedHere == nil
    }

    /* Its family removed, forked or refused: nothing of it stays on screen, an editor's text included. */
    private var familyGone: Bool {
        guard version == nil else { return false }
        guard store.isFamily(current), let groupId = store.familyAreaGroups[current.node.workspaceId.lowercased()],
              let state = store.familyStates[groupId] else { return false }
        switch state {
        case .accepted: return false
        case .failed(let words): return words != FamilyWords.noAnswer
        default: return true
        }
    }

    /* The name, and under it where you are in the folder, its size and date, or who wrote it when that can't be checked. */
    private var title: some View {
        VStack(spacing: 1) {
            Text(current.name).font(Theme.Text.callout.weight(.semibold)).foregroundStyle(Alpine.ink).lineLimit(1)
            if let provenance = version.map({ store.provenance(of: $0, in: current) }) ?? store.provenance(of: current) {
                // In place of the position or size: who wrote it comes first when it can't be checked, an earlier version too.
                UnverifiedMark(provenance: provenance).frame(minHeight: 16)
            } else if let saved = version.map({ store.savedCopy(of: $0, in: current) }) ?? store.savedCopy(of: current) {
                // Saved from a link: where it came from, in the subtitle's place and colour.
                Text(saved.line).font(.caption).foregroundStyle(Alpine.inkMuted).multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            } else if version == nil, let seen = store.seenBy(of: current) {
                // Written by someone first seen and not checked: no mark, said in the subtitle's place (Info has the way to check).
                // Cut in the middle, so a long address never pushes "Not verified" off the line.
                Text("Added by \(seen.shown) · Not verified").font(.caption).foregroundStyle(Alpine.inkMuted).lineLimit(1).truncationMode(.middle)
            } else {
                Text(subtitle).font(.caption).foregroundStyle(Alpine.inkMuted).lineLimit(1)
            }
        }
        .padding(.horizontal, Alpine.Space.s2)
    }

    private var subtitle: String {
        if let version { return "Earlier version · " + (changedLabel(parseDate(version.createdAt)) ?? "") }
        return items.count > 1 ? "\(index + 1) of \(items.count)" : [current.size.map { formatBytes(Int64($0)) }, changedLabel(current.modified)].compactMap { $0 }.joined(separator: " · ")
    }

    /* Narrow strips at the sides: the previous and next file in the folder. Drawn above QuickLook, which keeps its own taps. */
    private var edges: some View {
        HStack {
            strip("Previous file") { step(-1) }
            Spacer()
            strip("Next file") { step(1) }
        }
    }

    private func strip(_ label: String, _ run: @escaping () -> Void) -> some View {
        Rectangle().fill(Color.white.opacity(0.001)).frame(width: 32).frame(maxHeight: .infinity)
            .contentShape(Rectangle())
            .highPriorityGesture(TapGesture().onEnded(run))
            .accessibilityElement().accessibilityLabel(label).accessibilityAddTraits(.isButton)
            .accessibilityAction { run() }
    }

    private func step(_ by: Int) {
        let next = ((index + by) % items.count + items.count) % items.count
        failed = false
        current = items[next]
    }

    /* An earlier version: which it is, and Restore. */
    private var versionFoot: some View {
        HStack(spacing: Alpine.Space.s3) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Earlier version").font(Theme.Text.callout.weight(.semibold)).foregroundStyle(Alpine.ink)
                if let versionNote { Text(versionNote).font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted) }
            }
            Spacer(minLength: 0)
            if let onRestore { Button("Restore", action: onRestore).buttonStyle(PrimaryCapsuleStyle()) }
        }
        .padding(Alpine.Space.s3).padding(.leading, Alpine.Space.s1)
        .background(Alpine.surface, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
        .alpineRaised(RoundedRectangle(cornerRadius: 26, style: .continuous))
        .padding(.horizontal, Alpine.Space.s4).padding(.bottom, Alpine.Space.s2)
    }

    /* Who can open it, on the foot's one line in ink; an open link adds the small link icon, as rows do. */
    private var access: Text {
        if let family = store.family(of: current) { return Text("Everyone in \(family.name) can open it.").foregroundStyle(Alpine.inkMuted) }
        guard store.isOwn(current) else {
            let mount = store.mounts.first { $0.share.workspaceId == current.node.workspaceId }
            return Text(mount.map { "From \($0.share.granter.name.isEmpty ? $0.share.granter.email : $0.share.granter.name)" } ?? "Shared with you").foregroundStyle(Alpine.inkMuted)
        }
        if let line = store.accessLine(for: current) {
            return AccessText.line(line.link ?? line.text, link: line.link != nil, colour: Alpine.ink)
        }
        if let parent = current.node.parentId, let shared = store.sharedAncestor(from: parent), let who = store.whoCanOpenWithYou(shared) {
            return AccessText.line(who, link: (store.sharing[shared]?.links ?? 0) > 0, colour: Alpine.ink)
        }
        return Text("Only you").foregroundStyle(Alpine.inkMuted)
    }
}

/* QuickLook as a view, not a modal: our header and foot stay around it. */
struct QuickLookView: UIViewControllerRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator { Coordinator(url: url) }

    func makeUIViewController(context: Context) -> QLPreviewController {
        let controller = QLPreviewController()
        controller.dataSource = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: QLPreviewController, context: Context) {
        if context.coordinator.url != url {
            context.coordinator.url = url
            controller.reloadData()
        }
    }

    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        var url: URL
        init(url: URL) { self.url = url }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { url as NSURL }
    }
}

/*
 * Opening a file from a list: a small ring sits on its row while it comes down (it isn't
 * a transfer), then the viewer opens with the folder's other files a tap away. A file that
 * can't come down says why in a notice, in the same words as Android.
 */
@MainActor
enum Opener {
    static func open(_ item: Opened, store: DriveStore, show: @escaping (Opened) -> Void) {
        guard store.opening[item.id] == nil else { return }
        // A zip is never fetched whole: the viewer reads its list and the entries asked for by range.
        if ArchiveEntries.handles(name: item.name, mime: item.metadata.mime) {
            show(item)
            return
        }
        Task {
            do {
                _ = try await store.fetch(item)
                show(item)
            } catch {
                if store.offline {
                    store.notify("You’re offline. Files you keep on this phone open without a connection.")
                } else if store.endsThisSession(error) {
                    // The session alert says it. (A late 401 of a session no longer in use says nothing of the one in use.)
                } else {
                    store.notify("Couldn’t open “\(item.name)”. Check your connection and try again.")
                }
            }
        }
    }
}

extension View {
    /* The viewer over a list: `item` is the file opened, `among` the files it pages through. */
    func fileViewer(_ item: Binding<Opened?>, among: [Opened], store: DriveStore) -> some View {
        fullScreenCover(item: item) { start in
            FileViewer(items: among.filter { !$0.isFolder }, start: start).environment(store)
        }
    }
}
