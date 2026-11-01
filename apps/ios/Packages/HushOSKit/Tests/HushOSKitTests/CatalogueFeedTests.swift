import Foundation
import HushOSCore
import Testing
@testable import HushOSKit

/*
 * The catalogue's pull of the change feed against a server that drops old tombstones. The server
 * answers `resync` for any cursor below what it dropped, the later pages of a refill included:
 * heeding it there started the refill over for ever. A refill names no deletion, so what it left
 * out must leave the catalogue; what a rebuild finds different must reach the next sync's answer,
 * a failure in between or not; and no pull may move the mirror past a refill another left halfway.
 */
extension OnFakeDrive {
@Suite struct CatalogueFeedTests {
    /* A vault on the feed server with a mirror of its own, pulling `page` rows at a time. */
    func vault(_ feed: FeedServer, page: Int = 2) async throws -> Vault {
        FakeDrive.current = feed.drive
        FeedServer.current = feed
        let server = feed.drive
        let vault = Vault(api: DriveAPI(session: server.session, configuration: FeedServer.configuration), session: server.session)
        await vault.adopt(workspace: WorkspaceView(workspaceId: server.workspace, changeSeq: nil, grant: nil, root: server.nodes[server.root]), key: server.workspaceKey)
        await vault.adopt(identity: server.identity)
        await vault.adopt(signers: try server.ownerTrusts())
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("mirror-\(UUID().uuidString).sqlite")
        await vault.useMirror(try #require(Mirror(url: file)), page: page)
        return vault
    }

    func listed(_ vault: Vault) async -> Set<String> { Set(await vault.catalogueAll().map(\.id)) }

    @Test func aRefillLongerThanAPageEndsAndListsEverything() async throws {
        let feed = try FeedServer()
        // Tombstones were dropped through 4: every cursor from 1 to 3 is below them, a refill's second page included.
        feed.dropped = 4
        let vault = try await vault(feed)

        #expect(await vault.buildCatalogue())
        #expect(await vault.catalogueState == .ready)
        #expect(await listed(vault) == feed.all)
        #expect(feed.asked == [0, 2, 5])
    }

    @Test func aStaleCursorStartsOverOnceAndTheRefillEnds() async throws {
        let feed = try FeedServer()
        let vault = try await vault(feed)
        #expect(await vault.buildCatalogue())
        feed.asked = []

        // The device fell behind tombstones the server has dropped since: the first page says so.
        feed.dropped = 10
        _ = try await vault.sync()
        #expect(feed.asked == [6, 0, 2, 5])
        #expect(await vault.catalogueState == .ready)
        #expect(await listed(vault) == feed.all)
    }

    @Test func aRowPurgedWhileBehindLeavesTheCatalogueAndIsTold() async throws {
        let feed = try FeedServer()
        let server = feed.drive
        let vault = try await vault(feed)
        #expect(await vault.buildCatalogue())
        #expect(await vault.catalogueChildren(of: server.a)?.map(\.id) == [server.f])

        // F is deleted for good and its tombstone dropped before this device asked again.
        feed.purge(server.f, tombstone: 7)
        let touched = try #require(try await vault.sync())

        #expect(await vault.item(server.f) == nil)
        #expect(await vault.catalogueChildren(of: server.a)?.map(\.id) == [])
        #expect(await listed(vault) == feed.all)
        #expect(touched.isSuperset(of: [server.f, server.a]))
        // A row nothing changed is not told.
        #expect(!touched.contains(server.g))
    }

    @Test func aRefillThatFailedStillTellsWhatLeftOnTheNextSync() async throws {
        let feed = try FeedServer()
        let server = feed.drive
        let vault = try await vault(feed)
        #expect(await vault.buildCatalogue())

        feed.purge(server.f, tombstone: 7)
        // The refill's first page never comes back: the mirror is cleared, its cursor at nothing.
        feed.failing = [feed.asked.count + 2]
        await #expect(throws: DriveAPIError.self) { try await vault.sync() }
        #expect(await vault.item(server.f) != nil)

        // The next pull starts from nothing, which names no deletion either: F still leaves, and is told.
        let touched = try #require(try await vault.sync())
        #expect(await vault.item(server.f) == nil)
        #expect(await vault.catalogueChildren(of: server.a)?.map(\.id) == [])
        #expect(touched.isSuperset(of: [server.f, server.a]))
    }

    @Test func aFolderFoundByARebuildIsToldEvenAfterTheRebuildFailedOnce() async throws {
        let feed = try FeedServer()
        let server = feed.drive
        // B and G are made later.
        feed.hide([server.b, server.g])
        let vault = try await vault(feed)
        #expect(await vault.buildCatalogue())
        #expect(await listed(vault) == [server.root, server.a, server.f])

        // They are made, and this device misses the page with B: G arrives under a folder it never saw.
        feed.show(server.b, at: 7)
        feed.show(server.g, at: 8)
        feed.hideOnce = [server.b]
        let first = try #require(try await vault.sync())
        #expect(first.contains(server.g))
        #expect(await vault.catalogueState == .idle)

        // The build that fills the gap starts over from nothing, and that pull fails.
        feed.failing = [feed.asked.count + 2]
        #expect(try await vault.sync() == nil)
        #expect(await vault.catalogueChildren(of: server.root) == nil)

        // The next one succeeds, and says B came into the top folder: nothing else would.
        let touched = try #require(try await vault.sync())
        #expect(touched.isSuperset(of: [server.b, server.g, server.root]))
        #expect(Set(await vault.catalogueChildren(of: server.root)?.map(\.id) ?? []) == [server.a, server.b])
        #expect(await vault.catalogueChildren(of: server.b)?.map(\.id) == [server.g])
    }

    @Test func aBuildAnotherCallerRanIsToldByTheNextSync() async throws {
        let feed = try FeedServer()
        let server = feed.drive
        feed.hide([server.b, server.g])
        let vault = try await vault(feed)
        #expect(await vault.buildCatalogue())
        feed.show(server.b, at: 7)
        feed.show(server.g, at: 8)
        feed.hideOnce = [server.b]
        _ = try await vault.sync()

        // The background queue builds the catalogue before the app's next sync does.
        #expect(await vault.buildCatalogue())
        #expect(await vault.catalogueState == .ready)
        let touched = try #require(try await vault.sync())
        #expect(touched.isSuperset(of: [server.b, server.root]))
        // Told once: the sync after has nothing to say.
        #expect(try await vault.sync() == [])
    }

    @Test func aPullNeverMovesTheMirrorPastARefillAnotherLeftHalfway() async throws {
        let feed = try FeedServer()
        let server = feed.drive
        let vault = try await vault(feed)
        #expect(await vault.buildCatalogue())

        // G changes. A sync asks from 6 and gets it, its answer held on the way back.
        feed.show(server.g, at: 9)
        let held = feed.hold(request: feed.asked.count + 1)
        let behind = Task { try await vault.sync() }
        await held.arrived()

        // Meanwhile the server drops tombstones through 8, and a second sync asks too: from 6, below them,
        // so it starts over, and its refill fails on the second page.
        feed.dropped = 8
        feed.failing = [feed.asked.count + 3]
        let second = Task { try await vault.sync() }
        try await Task.sleep(for: .milliseconds(300))
        held.release()
        _ = try? await behind.value
        _ = try? await second.value

        // Whatever happened to either, the mirror's cursor never claims rows it lacks: one more sync, and a
        // build from it on another vault, hold every node.
        _ = try? await vault.sync()
        #expect(await vault.mirroredIds(server.workspace) == feed.all)
        #expect(await listed(vault) == feed.all)
    }
}
}

extension Vault {
    func useMirror(_ mirror: Mirror, page: Int) {
        self.mirror = mirror
        feedPage = page
    }

    func mirroredIds(_ workspaceId: String) -> Set<String> { Set(mirror?.rows(workspaceId).map(\.id) ?? []) }
}

/*
 * The change feed of FakeDrive's five nodes (root ─ A ─ F, root ─ B ─ G), as the server pages it:
 * every live node once, at the sequence it last changed, and `resync` for any cursor above zero
 * below the tombstones it dropped. Everything else goes to FakeDrive.
 */
final class FeedServer: @unchecked Sendable {
    nonisolated(unsafe) static var current: FeedServer?
    static var configuration: URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [FeedServerProtocol.self]
        return configuration
    }

    let drive: FakeDrive
    private let lock = NSLock()
    private var seqs: [String: Int]
    var dropped = 0
    /* The `since` of every feed request, in order. */
    var asked: [Int] = []
    /* Feed requests (counted from 1) that fail as a dropped connection would. */
    var failing: Set<Int> = []
    /* Nodes not in the feed yet; and nodes the next request leaves out, as a page this device missed. */
    private var hidden: Set<String> = []
    var hideOnce: Set<String> = []
    private var holding: (number: Int, gate: Held)?
    /* After this many requests every one fails: a pull that loops ends in an error, not a hung suite. */
    private let cap = 40

    init() throws {
        drive = try FakeDrive()
        seqs = [drive.root: 1, drive.a: 2, drive.b: 3, drive.f: 5, drive.g: 6]
    }

    /* Every live node the feed serves. */
    var all: Set<String> { lock.withLock { Set(seqs.keys).subtracting(hidden) } }

    func purge(_ id: String, tombstone: Int) { lock.withLock { seqs[id] = nil; dropped = tombstone } }
    func hide(_ ids: Set<String>) { lock.withLock { hidden.formUnion(ids) } }
    func show(_ id: String, at seq: Int) { lock.withLock { hidden.remove(id); seqs[id] = seq } }

    final class Held: @unchecked Sendable {
        private let came = DispatchSemaphore(value: 0)
        private let gate = DispatchSemaphore(value: 0)
        /* The answer goes back once released, off the loading thread, so the session's other requests go on meanwhile. */
        func arrive(then deliver: @escaping @Sendable () -> Void) {
            came.signal()
            DispatchQueue.global().async { self.gate.wait(); deliver() }
        }
        func arrived() async { await withCheckedContinuation { done in DispatchQueue.global().async { self.came.wait(); done.resume() } } }
        func release() { gate.signal() }
    }

    func hold(request number: Int) -> Held {
        let held = Held()
        lock.withLock { holding = (number, held) }
        return held
    }

    /* The page for `since`, and the hold it waits on before going back, if any; nil fails the request. */
    func page(_ url: URL) throws -> (Any, Held?)? {
        lock.lock()
        defer { lock.unlock() }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let since = Int(items.first { $0.name == "since" }?.value ?? "0") ?? 0
        let limit = Int(items.first { $0.name == "limit" }?.value ?? "500") ?? 500
        asked.append(since)
        let number = asked.count
        if failing.contains(number) || number > cap { return nil }
        let left = hidden.union(hideOnce)
        hideOnce = []
        let after = seqs.filter { !left.contains($0.key) && $0.value > since }.sorted { $0.value < $1.value }
        let served = after.prefix(limit)
        var changes: [[String: Any]] = []
        for (id, seq) in served {
            var node = try JSONSerialization.jsonObject(with: JSONEncoder().encode(drive.nodes[id]!)) as! [String: Any]
            node["changeSeq"] = seq
            changes.append(["kind": "node", "changeSeq": seq, "node": node])
        }
        let reply: [String: Any] = [
            "changes": changes,
            "nextCursor": served.last?.value ?? since,
            "hasMore": after.count > limit,
            "resync": since > 0 && since < dropped,
        ]
        let held = holding?.number == number ? holding?.gate : nil
        return (reply, held)
    }
}

final class FeedServerProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let parts = (request.url?.path ?? "").split(separator: "/").map(String.init)
        do {
            if parts.count == 5, parts[2] == "workspaces", parts[4] == "changes", let feed = FeedServer.current {
                guard let (page, held) = try feed.page(request.url!) else { throw URLError(.networkConnectionLost) }
                let data = try JSONSerialization.data(withJSONObject: page)
                if let held {
                    nonisolated(unsafe) let me = self
                    held.arrive { me.deliver(200, data) }
                } else {
                    deliver(200, data)
                }
            } else {
                guard let server = FakeDrive.current else { throw URLError(.cannotConnectToHost) }
                let (status, reply) = try server.answer(request, body: request.httpBody)
                deliver(status, try JSONSerialization.data(withJSONObject: reply))
            }
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    private func deliver(_ status: Int, _ data: Data) {
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
