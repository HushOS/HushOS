import HushOSKit
import QuickLook
import SwiftUI

/*
 * Opening a file (DESIGN.md): Apple's QuickLook in the middle, which
 * previews more kinds than we could, with HushOS around it. The header has Done, the
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

    init(items: [Opened], start: Opened, version: VersionListView? = nil, versionNote: String? = nil, onRestore: (() -> Void)? = nil) {
        self.items = items.isEmpty ? [start] : items
        self.version = version
        self.versionNote = versionNote
        self.onRestore = onRestore
        _current = State(initialValue: start)
    }

    private var index: Int { items.firstIndex { $0.id == current.id } ?? 0 }

    var body: some View {
        VStack(spacing: 0) {
            header
            ZStack {
                if let url {
                    QuickLookView(url: url).ignoresSafeArea(edges: .horizontal)
                } else if failed {
                    EmptyStateView(symbol: "exclamationmark.triangle", danger: true, title: "“\(current.name)” couldn’t be opened",
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
                if version == nil, items.count > 1 { edges }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            foot
        }
        .background(Alpine.ground)
        .nodeActionSheets(action: $action, store: store)
        // Somewhere else was asked for (a link, Info's Folder row): get out of its way.
        .onChange(of: store.route) { _, link in if link != nil { dismiss() } }
        .task(id: "\(current.id)-\(attempt)") {
            url = nil
            do { url = try await store.fetch(current, version: version) } catch { failed = true }
        }
        .onChange(of: store.folders[current.node.parentId ?? ""]?.contains { $0.id == current.id }) { _, here in
            // Moved to the Trash or elsewhere from the menu: the viewer has nothing left to show.
            if here == false, version == nil { dismiss() }
        }
    }

    private var header: some View {
        HStack(spacing: Alpine.Space.s2) {
            Button { dismiss() } label: { HeaderWord(text: "Done") }
                .buttonStyle(.plain).foregroundStyle(Alpine.primary)
                .glassEffect(.regular.interactive(), in: .capsule).highContrastEdge(Capsule())
            Spacer(minLength: 0)
            VStack(spacing: 1) {
                Text(current.name).font(Theme.Text.callout.weight(.semibold)).foregroundStyle(Alpine.ink).lineLimit(1)
                Text(subtitle).font(.caption).foregroundStyle(Alpine.inkMuted).lineLimit(1)
            }
            Spacer(minLength: 0)
            if version == nil {
                HeaderActions {
                    if store.role(of: current) == .owner {
                        Button { action = .share(current) } label: { HeaderIcon(symbol: "person.badge.plus") }
                            .buttonStyle(.plain).accessibilityLabel("Share")
                    }
                    Menu { NodeMenu(item: current, action: $action) } label: { HeaderIcon(symbol: "ellipsis") }
                        .accessibilityLabel("More")
                }
            } else {
                Color.clear.frame(width: 72, height: Theme.control)
            }
        }
        .padding(.horizontal, Alpine.Space.s4).padding(.vertical, Alpine.Space.s2)
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

    @ViewBuilder private var foot: some View {
        if version != nil {
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
        } else {
            HStack(spacing: Alpine.Space.s2) {
                access.font(Theme.Text.footnote).lineLimit(1)
                Spacer(minLength: 0)
                Text([current.size.map { formatBytes(Int64($0)) }, changedLabel(current.modified)].compactMap { $0 }.joined(separator: " · "))
                    .font(Theme.Text.footnote).foregroundStyle(Alpine.inkMuted).lineLimit(1)
                Button { action = .sendCopy(current) } label: { HeaderIcon(symbol: "square.and.arrow.up") }
                    .buttonStyle(.plain).foregroundStyle(Alpine.primary).accessibilityLabel("Send a copy")
            }
            .padding(.leading, Alpine.Space.s4).padding(.trailing, Alpine.Space.s1)
            .frame(height: 62)
            .glassEffect(.regular, in: .capsule)
            .highContrastEdge(Capsule())
            .padding(.horizontal, Alpine.Space.s4).padding(.bottom, Alpine.Space.s2)
        }
    }

    /* Who can open it, on the foot's one line in ink; an open link adds the small link icon, as rows do. */
    private var access: Text {
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
        Task {
            do {
                _ = try await store.fetch(item)
                show(item)
            } catch {
                if store.offline {
                    store.notify("You’re offline. Files you keep on this phone open without a connection.")
                } else if case DriveAPIError.notAuthenticated = error {
                    // The session alert says it.
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
