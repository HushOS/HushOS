import Foundation
import HushOSCore

/*
 * The catalogue, as the web builds one from its mirror: the whole workspace
 * opened in memory, parents first, so folders, recents, trash and search
 * answer without a request. The first build pulls the entire change feed
 * (a feed is state, not a log: every node appears once, as it is now); after
 * that a sync pulls only what changed since the cursor. Shared folders live in
 * other workspaces and keep going to the network.
 */
public enum CatalogueState: Equatable, Sendable {
    case idle, building, ready
    case failed(String)
}

extension Vault {
    private static let feedPage = 500

    /* Pulls the feed from the mirror's cursor to the head, committing each page; returns what arrived. */
    private func pullFeed(_ workspaceId: String) async throws -> [NodeChange] {
        guard let mirror else { return [] }
        var arrived: [NodeChange] = []
        var cursor = mirror.cursor(workspaceId)
        while true {
            let page = try await api.changes(workspaceId: workspaceId, since: cursor, limit: Self.feedPage)
            if page.resync {
                // The cursor predates what the server still remembers: start over from nothing.
                mirror.clear(workspaceId)
                cursor = 0
                continue
            }
            mirror.apply(workspaceId, changes: page.changes, nextCursor: page.nextCursor)
            arrived += page.changes
            cursor = page.nextCursor
            if !page.hasMore { break }
        }
        return arrived
    }

    /* Rows in an order every parent precedes its children; rows whose parent is missing come back separately. */
    private func parentsFirst(_ rows: [NodeView], known: (String) -> Bool = { _ in false }) -> (ordered: [NodeView], orphans: [NodeView]) {
        let byId = Dictionary(rows.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        var children: [String: [NodeView]] = [:]
        var roots: [NodeView] = []
        var orphans: [NodeView] = []
        for row in rows {
            if let parent = row.parentId {
                if byId[parent] != nil { children[parent, default: []].append(row) }
                // A parent already open (a sync's batch sits under the catalogue) starts a chain like a root.
                else if known(parent) { roots.append(row) }
                else { orphans.append(row) }
            } else {
                roots.append(row)
            }
        }
        var ordered: [NodeView] = []
        var queue = roots
        while !queue.isEmpty {
            let node = queue.removeFirst()
            ordered.append(node)
            queue += children[node.id] ?? []
        }
        return (ordered, orphans)
    }

    /* Opens rows into the catalogue (parents first) and files them under their parents. */
    private func file(_ rows: [NodeView]) {
        for row in rows {
            forget(row.id)
            guard let done = try? open(row) else { continue }
            if let parent = row.parentId {
                rememberParent(row.id, parent: parent)
                catalogueChildren[parent, default: []].insert(row.id)
            }
            _ = done
        }
    }

    /*
     * Builds the catalogue for this account's workspace; a second call while
     * ready is free. Returns whether the feed was pulled: false when the tree
     * opened from the phone alone, or nothing was built.
     */
    @discardableResult
    public func buildCatalogue() async -> Bool {
        if catalogueState == .ready { return false }
        if let running = catalogueBuilding {
            // Someone else started it: wait until it is done, so callers can rely on the state after this returns.
            _ = await running.value
            return false
        }
        let build = Task { await self.performBuild() }
        catalogueBuilding = build
        let pulled = await build.value
        catalogueBuilding = nil
        return pulled
    }

    private func performBuild() async -> Bool {
        guard let mirror else { return false }
        catalogueState = .building
        let workspaceId: String
        do { workspaceId = try await loadWorkspace().workspaceId } catch {
            catalogueState = .failed((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
            return false
        }
        do {
            // One workspace per device: another account's tree is not kept beside this one.
            for other in mirror.workspaces() where other != workspaceId { mirror.clear(other) }
            var pulled = true
            do { _ = try await pullFeed(workspaceId) } catch DriveAPIError.transport(let message) {
                // No network: the tree already on this phone opens as it was; the next sync catches up.
                if mirror.cursor(workspaceId) == 0 { throw DriveAPIError.transport(message) }
                pulled = false
            }
            var (ordered, orphans) = parentsFirst(mirror.rows(workspaceId))
            if !orphans.isEmpty && pulled {
                // A row without its parent is a page this device missed: start over once.
                mirror.clear(workspaceId)
                _ = try await pullFeed(workspaceId)
                (ordered, orphans) = parentsFirst(mirror.rows(workspaceId))
            }
            catalogueChildren = [:]
            file(ordered)
            catalogueState = .ready
            return pulled
        } catch {
            catalogueState = .failed((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
            return false
        }
    }

    /*
     * Pulls what changed since the cursor and files it; returns the ids that
     * changed, or nil when the server was not asked because the catalogue was
     * still being built or had to open from the phone alone.
     */
    @discardableResult
    public func sync() async throws -> Set<String>? {
        guard catalogueState == .ready, let mirror else {
            return await buildCatalogue() ? [] : nil
        }
        let workspaceId = try await loadWorkspace().workspaceId
        let changes = try await pullFeed(workspaceId)
        if changes.isEmpty { return [] }
        var touched: Set<String> = []
        var rows: [NodeView] = []
        for change in changes {
            switch change.kind {
            case "node":
                guard let node = change.node else { continue }
                if let old = opened[node.id]?.node.parentId, old != node.parentId { catalogueChildren[old]?.remove(node.id) }
                rows.append(node)
                touched.insert(node.id)
                if let parent = node.parentId { touched.insert(parent) }
            case "tombstone":
                guard let id = change.nodeId else { continue }
                if let parent = opened[id]?.node.parentId ?? parents[id] { catalogueChildren[parent]?.remove(id); touched.insert(parent) }
                forget(id)
                touched.insert(id)
            default: continue
            }
        }
        // Changed rows may include a folder whose key rotated: its children are re-opened after it.
        let batchRows = rows + descendants(of: rows.map(\.id), except: Set(rows.map(\.id)))
        let batch = Set(batchRows.map(\.id))
        let (ordered, orphans) = parentsFirst(batchRows) { id in !batch.contains(id) && opened[id] != nil }
        file(ordered)
        // A row under a folder this device never saw: the next build fills the gap.
        if !orphans.isEmpty || !mirror.hasRows(workspaceId) { catalogueState = .idle }
        return touched
    }

    private func descendants(of ids: [String], except: Set<String>) -> [NodeView] {
        var out: [NodeView] = []
        var queue = ids
        while !queue.isEmpty {
            let id = queue.removeFirst()
            for child in catalogueChildren[id] ?? [] where !except.contains(child) {
                if let node = opened[child]?.node { out.append(node) }
                queue.append(child)
            }
        }
        return out
    }

    /* This folder's children from the catalogue, or nil when the catalogue cannot answer for it. */
    public func catalogueChildren(of folderId: String) -> [Opened]? {
        guard catalogueState == .ready, let folder = opened[folderId], folder.node.workspaceId == workspace?.workspaceId else { return nil }
        return (catalogueChildren[folderId] ?? []).compactMap { opened[$0] }.filter { $0.node.trashedAt == nil }.sorted(by: Opened.byName)
    }

    /* One opened item by id, when this device knows it (the catalogue opens the whole drive). */
    public func openedItem(_ id: String) -> Opened? { opened[id] }

    /* Everything opened in this workspace, for search. */
    public func catalogueAll() -> [Opened] {
        guard catalogueState == .ready, let ws = workspace?.workspaceId else { return [] }
        return opened.values.filter { $0.node.workspaceId == ws && $0.node.trashedAt == nil }
    }

    /* The most recently changed files, from the catalogue. */
    public func catalogueRecents(limit: Int = 60) -> [Opened]? {
        guard catalogueState == .ready else { return nil }
        return catalogueAll().filter { !$0.isFolder && $0.node.currentVersion != nil }
            .sorted { ($0.modified ?? .distantPast) > ($1.modified ?? .distantPast) }.prefix(limit).map { $0 }
    }

    /* Trashed rows, with whether their parent is trashed too; newest first, as the server lists them. */
    public func catalogueTrash() -> [(item: Opened, parentTrashed: Bool)]? {
        guard catalogueState == .ready, let ws = workspace?.workspaceId else { return nil }
        return opened.values.filter { $0.node.workspaceId == ws && $0.node.trashedAt != nil }.sorted(by: Opened.byTrashed).map { item in
            (item, item.node.parentId.flatMap { opened[$0]?.node.trashedAt } != nil)
        }
    }

    /* A sealed thumbnail trailer from the mirror, or from the server and then kept. */
    func sealedThumbnail(for item: Opened, opened version: OpenedVersion) async throws -> Data? {
        guard let current = item.node.currentVersion else { return nil }
        if let kept = mirror?.thumbnail(current.id) { return kept }
        let urls = try await api.thumbnails(workspaceId: item.node.workspaceId, versionIds: [current.id])
        guard let entry = urls.urls.first, let url = URL(string: entry.url) else { return nil }
        let ciphertext = try await api.range(url, thumbnailRange(plaintextSize: version.content.plaintextSize, thumbnailBytes: version.content.thumbnailBytes))
        mirror?.putThumbnail(current.id, ciphertext)
        return ciphertext
    }
}
