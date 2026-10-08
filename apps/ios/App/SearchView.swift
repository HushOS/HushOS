import HushOSKit
import QuickLook
import SwiftUI

/*
 * The search tab (the iOS 26 search role): the field sits at the bottom by the thumb.
 * Type chips narrow it; recent searches and tags fill the screen until something is
 * typed; results come grouped into folders and files, each saying where it is.
 * Names and tags are matched word by word, as the web's catalogue does.
 */
struct SearchView: View {
    @Environment(DriveStore.self) private var store
    /* Kept by the shell, so a search survives switching tabs. */
    @Binding var query: String
    @State private var filter: HomeFilter = .all
    @State private var action: NodeAction?
    @State private var viewing: Opened?
    @AppStorage("search.recent") private var recentRaw = ""

    private var recent: [String] { recentRaw.split(separator: "\n").map(String.init) }

    private var words: [String] {
        query.lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
    }

    /* The whole drive once the catalogue is built; until then, only what this phone has listed. */
    private var pool: [Opened] { store.catalogueReady ? Array(store.catalogue.values) : store.everything }

    private var hits: [Opened] {
        guard !words.isEmpty else { return [] }
        return pool.filter { item in
            guard filter.matches(item), item.id != store.rootId else { return false }
            let text = ([item.name] + store.tags.tags(of: item.id).map(\.name)).joined(separator: " ").lowercased()
            return words.allSatisfy { text.contains($0) }
        }
        .sorted(by: Opened.byName)
    }

    var body: some View {
        NavigationStack {
            List {
                Section {} header: {
                    VStack(alignment: .leading, spacing: Alpine.Space.s3) {
                        ScreenHeader(title: "Search")
                        if store.offline { OfflineCapsule() }
                        TypeChips(value: $filter)
                    }
                    .textCase(nil)
                    .listRowInsets(EdgeInsets(top: Alpine.Space.s2, leading: 0, bottom: 0, trailing: 0))
                }
                if words.isEmpty {
                    if !recent.isEmpty {
                        Section {
                            ForEach(recent, id: \.self) { term in
                                Button { query = term } label: {
                                    Label { Text(term).foregroundStyle(Alpine.ink) } icon: { Image(systemName: "clock").foregroundStyle(Alpine.inkMuted) }
                                }
                                .alpineRow()
                            }
                        } header: {
                            sectionTitle("Recent searches")
                        }
                    }
                    if !store.tags.tags.isEmpty {
                        // Tags as suggestions, in the header so the pills keep the screen margin and their whole border.
                        Section {} header: {
                            VStack(alignment: .leading, spacing: Alpine.Space.s2) {
                                sectionTitle("Tags")
                                FlowTags(tags: store.tags.tags) { query = $0.name }.padding(.horizontal, Alpine.Space.s1)
                            }
                            .textCase(nil)
                            .listRowInsets(EdgeInsets(top: Alpine.Space.s2, leading: 0, bottom: 0, trailing: 0))
                        }
                    }
                } else {
                    let folders = hits.filter(\.isFolder)
                    let files = hits.filter { !$0.isFolder }
                    if !folders.isEmpty {
                        Section { ForEach(folders) { row($0) } } header: { sectionTitle("Folders") }
                    }
                    if !files.isEmpty {
                        Section { ForEach(files) { row($0) } } header: { sectionTitle("Files") }
                    }
                    if hits.isEmpty { noResults.bareRow(top: Alpine.Space.s8) }
                }
            }
            .listStyle(.insetGrouped)
            .alpineGrouped()
            .environment(\.defaultMinListRowHeight, 1) // Item rows set their own 56pt; furniture rows keep their own height.
            .listSectionSpacing(Alpine.Space.s4)
            .navigationTitle("Search")
            .screenChrome(title: "Search")
            .navigationDestination(for: Opened.self) { folder in
                FolderView(folderId: folder.id, title: folder.name)
            }
            .nodeActionSheets(action: $action, store: store)
            .fileViewer($viewing, among: hits, store: store)
            .task {
                _ = await store.loadRoot()
                if store.tags.tags.isEmpty { await store.refreshTags() }
            }
        }
        // On the search tab's own stack, so the other tabs never carry the field.
        .searchable(text: $query, prompt: "Search your files")
        .onSubmit(of: .search) { remember(query) }
    }

    private func sectionTitle(_ text: String) -> some View {
        Text(text).font(Theme.Text.title).foregroundStyle(Alpine.ink).textCase(nil)
            .padding(.horizontal, Alpine.Space.s1)
            .listRowInsets(EdgeInsets(top: Alpine.Space.s2, leading: 0, bottom: Alpine.Space.s2, trailing: 0))
    }

    @ViewBuilder private func row(_ item: Opened) -> some View {
        let location = store.location(of: item)
        if item.isFolder {
            NavigationLink(value: item) { NodeRow(item: item, location: location) }
                .simultaneousGesture(TapGesture().onEnded { remember(query) })
                .nodeActions(item, action: $action, store: store)
                .itemRow()
        } else {
            Button {
                remember(query)
                Opener.open(item, store: store) { viewing = $0 }
            } label: { NodeRow(item: item, location: location) }
                .buttonStyle(.plain)
                .nodeActions(item, action: $action, store: store)
                .itemRow()
        }
    }

    /* What search covers, honestly: every folder once the catalogue is built, otherwise the ones opened here. */
    private var noResults: some View {
        EmptyStateView(
            symbol: "magnifyingglass",
            title: "No results for “\(query.trimmingCharacters(in: .whitespaces))”",
            message: store.catalogueReady
                ? "Search looks at names, tags and file types in every folder. Check the spelling, or try fewer words."
                : "Search looks at names and tags in folders you’ve opened on this phone. Check the spelling, or try fewer words."
        ) {
            if filter != .all {
                Button("Search all types") { filter = .all }.font(.body.weight(.semibold)).foregroundStyle(Alpine.primary)
            }
        }
    }

    /* The last few searches, newest first. */
    private func remember(_ term: String) {
        let clean = term.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return }
        recentRaw = ([clean] + recent.filter { $0.caseInsensitiveCompare(clean) != .orderedSame }).prefix(5).joined(separator: "\n")
    }
}

/* Tags as pills that wrap onto as many lines as they need. */
private struct FlowTags: View {
    let tags: [Tag]
    let pick: (Tag) -> Void

    var body: some View {
        WrapLayout(spacing: Alpine.Space.s2) {
            ForEach(tags) { tag in
                Button { pick(tag) } label: { TagPill(tag: tag) }.buttonStyle(.plain)
            }
        }
    }
}

private struct WrapLayout: Layout {
    var spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0, widest: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width { x = 0; y += line + spacing; line = 0 }
            x += size.width + spacing
            line = max(line, size.height)
            widest = max(widest, x - spacing)
        }
        return CGSize(width: min(widest, width), height: y + line)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, line: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX { x = bounds.minX; y += line + spacing; line = 0 }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            line = max(line, size.height)
        }
    }
}
