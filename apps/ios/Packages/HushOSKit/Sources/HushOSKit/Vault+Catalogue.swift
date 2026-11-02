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

/* What a pull brought, and whether the catalogue is filed again from the mirror: the pull started from nothing, or cleared it (`resync`). */
struct PulledFeed: Sendable {
    var changes: [NodeChange]
    var reset: Bool
}

struct FiledRow: Equatable, Sendable {
    var parent: String?
    var seq: Int?
    var trashed: String?
}

extension Vault {
    /*
     * The mirror one pull (or read of it) at a time in this process. Pulls run on one actor but
     * interleave at every request: a page another pull applied after a `resync` cleared the mirror
     * would move its cursor past rows the refill had not brought back, and no later pull or build
     * would ever bring them.
     */
    func withFeedTurn<T>(_ body: () async throws -> T) async throws -> T {
        if feedBusy { await withCheckedContinuation { feedWaiting.append($0) } } else { feedBusy = true }
        defer { if feedWaiting.isEmpty { feedBusy = false } else { feedWaiting.removeFirst().resume() } }
        return try await body()
    }

    /*
     * Pulls the feed from the mirror's cursor (or from nothing) to the head, committing each page;
     * returns what arrived. `resync` speaks of the cursor a pull starts from (the web client's
     * rule): the later pages of a refill sit below the server's dropped tombstones by nature, and
     * heeding it there would start the refill over for ever.
     */
    private func pullFeed(_ workspaceId: String, fromNothing: Bool = false) async throws -> PulledFeed {
        guard let mirror else { return PulledFeed(changes: [], reset: false) }
        return try await withFeedTurn {
            if fromNothing { mirror.clear(workspaceId) }
            var arrived: [NodeChange] = []
            var cursor = mirror.cursor(workspaceId)
            // From nothing, a pull names no deletion: what a catalogue held is filed again from the rows.
            var reset = cursor == 0
            var first = true
            while true {
                let page = try await api.changes(workspaceId: workspaceId, since: cursor, limit: feedPage)
                if first && page.resync && cursor > 0 {
                    // The cursor predates what the server still remembers: start over from nothing.
                    mirror.clear(workspaceId)
                    arrived = []
                    cursor = 0
                    reset = true
                    continue
                }
                first = false
                mirror.apply(workspaceId, changes: page.changes, nextCursor: page.nextCursor)
                arrived += page.changes
                cursor = page.nextCursor
                if !page.hasMore { break }
            }
            cataloguePulled = true
            return PulledFeed(changes: arrived, reset: reset)
        }
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

    /* An item of this account's own workspace by id: the catalogue is that workspace and nothing else. */
    func own(_ id: String) -> Opened? {
        guard let ws = workspace?.workspaceId else { return nil }
        return opened[NodeRef(workspaceId: ws, nodeId: id)]
    }

    /* Opens rows into the catalogue (parents first) and files them under their parents; a row of another workspace is not the feed's. */
    private func file(_ rows: [NodeView]) {
        guard let ws = workspace?.workspaceId.lowercased() else { return }
        for row in rows where row.workspaceId.lowercased() == ws {
            opened[row.ref] = nil
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

    /*
     * `pulled`: the caller's pull just reached the head, so the build files from the mirror as it
     * stands rather than asking again (a second request failing would leave the catalogue on what
     * the refill dropped).
     */
    private func performBuild(pulled already: Bool = false) async -> Bool {
        guard let mirror else { return false }
        catalogueState = .building
        let workspaceId: String
        do { workspaceId = try await loadWorkspace().workspaceId } catch {
            catalogueState = .failed(ErrorWords.say(error) ?? ErrorWords.generic)
            return false
        }
        do {
            // One workspace per device: another account's tree is not kept beside this one.
            for other in mirror.workspaces() where other != workspaceId { mirror.clear(other) }
            var pulled = true
            if !already {
                do { _ = try await pullFeed(workspaceId) } catch DriveAPIError.transport(let message) {
                    // No network: the tree already on this phone opens as it was; the next sync catches up.
                    if mirror.cursor(workspaceId) == 0 { throw DriveAPIError.transport(message) }
                    pulled = false
                }
            }
            // The rows with the cursor they stand at, read in the mirror's turn so no refill is halfway through them.
            var (rows, cursor) = try await withFeedTurn { (mirror.rows(workspaceId), mirror.cursor(workspaceId)) }
            if !parentsFirst(rows).orphans.isEmpty && pulled {
                // A row without its parent is a page this device missed: start over once.
                _ = try await pullFeed(workspaceId, fromNothing: true)
                (rows, cursor) = try await withFeedTurn { (mirror.rows(workspaceId), mirror.cursor(workspaceId)) }
            }
            // Over a catalogue already filed, what differs is owed to the next sync (`takeOwed`): its cursor is at the head by then.
            let before = catalogueFiled ? filedRows() : nil
            letGo(of: rows, at: cursor, in: workspaceId)
            catalogueChildren = [:]
            file(parentsFirst(rows).ordered)
            if let before { catalogueOwed.formUnion(differing(before, filedRows())) }
            catalogueState = .ready
            catalogueFiled = true
            return pulled
        } catch {
            catalogueState = .failed(ErrorWords.say(error) ?? ErrorWords.generic)
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
            // Built again over one already filed (rows under a folder never seen, keys rotated, a build that failed):
            // what differs is told, or it would stay unsaid, the cursor being at the head by then.
            if catalogueFiled { return await rebuildCatalogue() }
            return await buildCatalogue() ? [] : nil
        }
        let workspaceId = try await loadWorkspace().workspaceId
        let pulled = try await pullFeed(workspaceId)
        // A refill names no deletion: the catalogue is filed again from the mirror, and what left it is told.
        if pulled.reset { return await rebuildCatalogue(pulled: true) }
        let changes = pulled.changes
        // What a build over the filed catalogue found and no sync returned yet goes with this one.
        var touched = takeOwed()
        if changes.isEmpty { return touched }
        var rows: [NodeView] = []
        for change in changes {
            switch change.kind {
            case "node":
                guard let node = change.node, node.workspaceId.lowercased() == workspaceId.lowercased() else { continue }
                if let old = own(node.id)?.node.parentId, old != node.parentId { catalogueChildren[old]?.remove(node.id) }
                rows.append(node)
                touched.insert(node.id)
                if let parent = node.parentId { touched.insert(parent) }
            case "tombstone":
                guard let id = change.nodeId else { continue }
                if let parent = own(id)?.node.parentId ?? parents[id] { catalogueChildren[parent]?.remove(id); touched.insert(parent) }
                remove(id, in: workspaceId)
                touched.insert(id)
            default: continue
            }
        }
        // Changed rows may include a folder whose key rotated: its children are re-opened after it.
        let batchRows = rows + descendants(of: rows.map(\.id), except: Set(rows.map(\.id)))
        let batch = Set(batchRows.map(\.id))
        let (ordered, orphans) = parentsFirst(batchRows) { id in !batch.contains(id) && own(id) != nil }
        file(ordered)
        // A row under a folder this device never saw: the next build fills the gap.
        if !orphans.isEmpty || !mirror.hasRows(workspaceId) { catalogueState = .idle }
        return touched
    }

    /*
     * The catalogue built again inside a sync, over the one filed: from the mirror as the sync's
     * pull left it (`pulled`), or with a pull of its own. Returns what differs (`catalogueOwed`),
     * or nil when the build did not reach the server; what it owes then waits for the next sync.
     */
    private func rebuildCatalogue(pulled already: Bool = false) async -> Set<String>? {
        catalogueState = .idle
        let pulled: Bool
        if already {
            // A build already running didn't see this refill: it finishes first, then the refill is filed.
            if let running = catalogueBuilding { _ = await running.value }
            let build = Task { await self.performBuild(pulled: true) }
            catalogueBuilding = build
            pulled = await build.value
            catalogueBuilding = nil
        } else {
            pulled = await buildCatalogue()
        }
        guard catalogueState == .ready, pulled else { return nil }
        return takeOwed()
    }

    /* What builds over a filed catalogue found different and no sync has returned yet; returned once. */
    private func takeOwed() -> Set<String> {
        defer { catalogueOwed = [] }
        return catalogueOwed
    }

    /* Each own row's place and sequence, as the catalogue holds them: what a build over it compares. */
    private func filedRows() -> [String: FiledRow] {
        guard let ws = workspace?.workspaceId else { return [:] }
        return opened.values(in: ws).mapValues { FiledRow(parent: $0.node.parentId, seq: $0.node.changeSeq, trashed: $0.node.trashedAt) }
    }

    /* The ids whose row came, went, moved or changed between two filings, with the folders they left and entered. */
    private func differing(_ before: [String: FiledRow], _ after: [String: FiledRow]) -> Set<String> {
        var touched: Set<String> = []
        for id in Set(before.keys).union(after.keys) where before[id] != after[id] {
            touched.insert(id)
            if let parent = before[id]?.parent { touched.insert(parent) }
            if let parent = after[id]?.parent { touched.insert(parent) }
        }
        return touched
    }

    /*
     * Rows of this workspace the mirror no longer holds, though the feed has passed where they last
     * changed, are gone: a refill names no deletion, so they leave as a tombstone would take them
     * (`remove`). A row changed after the cursor (a write landing meanwhile), or without a
     * sequence, stays. The mirror holds every live row up to its cursor: pages commit with it.
     */
    private func letGo(of rows: [NodeView], at cursor: Int, in workspaceId: String) {
        let held = Set(rows.map { $0.id.lowercased() })
        for (id, item) in opened.values(in: workspaceId) where !held.contains(id) {
            guard let seq = item.node.changeSeq, seq <= cursor else { continue }
            remove(id, in: workspaceId)
        }
    }

    private func descendants(of ids: [String], except: Set<String>) -> [NodeView] {
        var out: [NodeView] = []
        var queue = ids
        while !queue.isEmpty {
            let id = queue.removeFirst()
            for child in catalogueChildren[id] ?? [] where !except.contains(child) {
                if let node = own(child)?.node { out.append(node) }
                queue.append(child)
            }
        }
        return out
    }

    /* This folder's children from the catalogue, or nil when the catalogue cannot answer for it. */
    public func catalogueChildren(of folderId: String) -> [Opened]? {
        guard catalogueState == .ready, own(folderId) != nil else { return nil }
        // Only what still lives here: an id filed under a folder it has since left is not listed in it.
        return (catalogueChildren[folderId] ?? []).compactMap { own($0) }
            .filter { $0.node.trashedAt == nil && $0.node.parentId == folderId }.sorted(by: Opened.byName)
    }

    /* One opened item by id, when this device knows it (the catalogue opens the whole drive). */
    public func openedItem(_ id: String) -> Opened? { opened[id] }

    /*
     * Everything live in this workspace, for Recent, search and tags: not trashed, and no trashed
     * folder above it. Trashing a folder marks only the folder, so what is inside it is ruled out
     * by its ancestors (the web catalogue's rule). Answers are remembered for the one call.
     */
    public func catalogueAll() -> [Opened] {
        guard catalogueState == .ready, let ws = workspace?.workspaceId else { return [] }
        var live: [String: Bool] = [:]
        func isLive(_ item: Opened) -> Bool {
            if let known = live[item.id] { return known }
            let value = item.node.trashedAt == nil && (item.node.parentId.flatMap { own($0) }.map(isLive) ?? true)
            live[item.id] = value
            return value
        }
        return opened.values.filter { $0.node.workspaceId == ws && isLive($0) }
    }

    /* What changed most recently below the top folder, folders included (as the web's Recent), from the catalogue (`Recents`). */
    public func catalogueRecents(limit: Int = 60, keep: (Opened) -> Bool = { _ in true }) -> Recents? {
        guard catalogueState == .ready else { return nil }
        let found = catalogueAll().filter { $0.node.parentId != nil && ($0.isFolder || $0.node.currentVersion != nil) }
        return Recents(found, limit: limit, keep: keep) { own($0)?.node.parentId }
    }

    /* Trashed rows, with whether their parent is trashed too; newest first, as the server lists them. */
    public func catalogueTrash() -> [(item: Opened, parentTrashed: Bool)]? {
        guard catalogueState == .ready, let ws = workspace?.workspaceId else { return nil }
        return opened.values.filter { $0.node.workspaceId == ws && $0.node.trashedAt != nil }.sorted(by: Opened.byTrashed).map { item in
            (item, item.node.parentId.flatMap { own($0)?.node.trashedAt } != nil)
        }
    }

    /* A sealed thumbnail trailer from the mirror, or from the server and then kept. */
    func sealedThumbnail(for item: Opened, opened version: OpenedVersion) async throws -> Data? {
        guard let current = item.node.currentVersion else { return nil }
        if let kept = mirror?.thumbnail(current.id) { return kept }
        let urls = try await api.thumbnails(workspaceId: item.node.workspaceId, versionIds: [current.id])
        guard let entry = urls.urls.first, let url = URL(string: entry.url) else { return nil }
        // The range is a fixed tail window (so the store never learns the trailer's length); keep only the trailer at its end.
        let window = try await api.range(url, try thumbnailRange(suite: version.content.suite, plaintextSize: version.content.plaintextSize, thumbnailBytes: version.content.thumbnailBytes))
        let trailer = Data(window.suffix(Int(version.content.thumbnailBytes) + 16))
        mirror?.putThumbnail(current.id, trailer)
        return trailer
    }
}
