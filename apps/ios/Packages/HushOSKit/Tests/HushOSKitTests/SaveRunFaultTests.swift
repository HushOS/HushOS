import Foundation
import HushOSCore
import Testing
@testable import HushOSKit

/*
 * The save path's one rule, checked by breaking it everywhere (the web's save-runs.faults.test.ts): a run is driven
 * against a drive that records everything it publishes and every reservation, and each of the run's waits (a listing,
 * a folder's creation, a begin, a part, a completion, a journal write, an abort, a trash, a purge) is made to fail in
 * turn: no network, an answer lost after the server acted, a refusal, a full disk, or the process dying there. After
 * each:
 *
 * - everything the drive published is named by a row that survived (itself or a folder above it), or counted in what
 *   the run said it kept, or said to be what may remain;
 * - nothing the journal offers at the next launch is a save that finished;
 * - the next launch, from the journal alone, removes everything of a run that did not finish, and aborts every
 *   reservation the journal knew of.
 *
 * A new wait is covered by adding it to `Point`. Process death is everything failing from that point: nothing more
 * reaches the drive or the disk.
 */

enum Point: String, CaseIterable, Sendable {
    case listing, folder, begin, part, complete, journal, abort, trash, purge
}

/*
 * `crash`: the drive (or the disk) acts, then the process dies before hearing. `outage`: the network goes for good while
 * the process lives on. `cancel`, `signout`, `lock`: the person cancels, signs out (the journal goes with the account),
 * or the device locks (every later call refused) just as that wait is reached.
 */
enum Fault: String, Sendable {
    case network, lost, refused, full, death, crash, outage, cancel, signout, lock
}

extension Point {
    var faults: [Fault] {
        let people: [Fault] = [.cancel, .signout, .lock]
        switch self {
        case .listing: return [.network, .refused, .death, .outage] + people
        case .part: return [.network, .death, .outage] + people
        case .journal: return [.refused, .full, .death, .crash] + people
        default: return [.network, .lost, .refused, .death, .crash, .outage] + people
        }
    }
}

/* The device locked: the vault's keys are gone, and every later call is refused. */
struct VaultLocked: Error {}

struct Plan: Sendable {
    let point: Point
    let k: Int
    let fault: Fault
}

/* What the drive holds and what the process may do, under one lock: the journal's hook reaches it synchronously. */
final class FaultWorld: @unchecked Sendable {
    private let lock = NSLock()
    let plan: Plan?
    private var counts: [Point: Int] = [:]
    private(set) var dead = false
    private var full = false
    private(set) var outage = false
    private(set) var locked = false
    private(set) var signedOut = false
    private var interrupt: (@Sendable (Fault) -> Void)?
    func onInterrupt(_ hook: @escaping @Sendable (Fault) -> Void) { lock.withLock { interrupt = hook } }
    func signOut() { lock.withLock { signedOut = true } }

    struct Node { var state: String; let parent: String; let name: String }
    struct Upload { var status: String; let nodeId: String; let version: Bool; let parent: String }
    private var nodes: [String: Node] = [:]
    private var uploads: [String: Upload] = [:]
    private(set) var lostBegins = Set<String>()
    private(set) var recorded = Set<String>()
    private var next = 0

    init(plan: Plan?) { self.plan = plan }

    /* The fault planned for this call at `point`, counting it. */
    func fault(at point: Point) -> Fault? {
        lock.withLock {
            let k = (counts[point] ?? 0) + 1
            counts[point] = k
            guard let plan, plan.point == point, plan.k == k else { return nil }
            if plan.fault == .death { dead = true }
            if plan.fault == .full { full = true }
            if plan.fault == .outage { outage = true }
            if plan.fault == .lock { locked = true }
            return plan.fault
        }
    }
    /* After a fault is counted, outside the lock: the person's own act. */
    func act(_ fault: Fault?) {
        guard let fault, [.cancel, .signout, .lock].contains(fault) else { return }
        let hook = lock.withLock { interrupt }
        hook?(fault)
    }
    func die() { lock.withLock { dead = true } }
    var reached: [Point: Int] { lock.withLock { counts } }

    /* The journal's hook: a write the disk refuses, or one a dead process never makes. */
    func journalWrite(_ rows: [SaveRunRow]) throws {
        let fault = fault(at: .journal)
        act(fault)
        try lock.withLock {
            if dead || full || fault == .refused { throw CocoaError(.fileWriteOutOfSpace) }
            for row in rows { recorded.formUnion(row.uploadIds) }
            // This write lands; the process is gone before it hears so.
            if fault == .crash { dead = true }
        }
    }

    func begin(_ nodeId: String, version: Bool, parent: String) -> String {
        lock.withLock {
            next += 1
            let id = "up-\(next)"
            uploads[id] = Upload(status: "open", nodeId: nodeId, version: version, parent: parent)
            return id
        }
    }
    func lostBegin(_ id: String) { lock.withLock { _ = lostBegins.insert(id) } }
    func complete(_ uploadId: String) throws -> String {
        try lock.withLock {
            guard var upload = uploads[uploadId], upload.status == "open" else { throw DriveAPIError.notFound("gone") }
            upload.status = "completed"
            uploads[uploadId] = upload
            if !upload.version { nodes[upload.nodeId] = Node(state: "live", parent: upload.parent, name: upload.nodeId) }
            return upload.nodeId
        }
    }
    func abort(_ uploadId: String) -> DriveAPI.AbortFate {
        lock.withLock {
            guard var upload = uploads[uploadId] else { return .gone }
            if upload.status == "completed" { return .finished }
            upload.status = "aborted"
            uploads[uploadId] = upload
            return .aborted
        }
    }
    func create(_ id: String, parent: String, name: String) { lock.withLock { nodes[id] = Node(state: "live", parent: parent, name: name) } }
    func names(in parent: String) -> [String] {
        lock.withLock { nodes.values.filter { $0.parent == parent && $0.state == "live" }.map(\.name) }
    }
    func trash(_ ids: [String]) -> [String: SaveItemFate] {
        lock.withLock {
            var fates: [String: SaveItemFate] = [:]
            for id in ids {
                if var node = nodes[id], node.state != "purged" {
                    node.state = "trash"
                    nodes[id] = node
                    fates[id] = .done
                } else { fates[id] = .gone }
            }
            return fates
        }
    }
    func purge(_ ids: [String]) -> [String: SaveItemFate] {
        lock.withLock {
            var fates: [String: SaveItemFate] = [:]
            for id in ids {
                if var node = nodes[id], node.state == "trash" {
                    node.state = "purged"
                    nodes[id] = node
                    fates[id] = .done
                } else { fates[id] = .gone }
            }
            return fates
        }
    }
    /* A folder deleted forever takes everything inside it. */
    private func gone(_ id: String) -> Bool {
        guard let node = nodes[id] else { return true }
        if node.state == "purged" { return true }
        return nodes[node.parent] != nil ? gone(node.parent) : false
    }
    var published: [String] { lock.withLock { nodes.keys.filter { !gone($0) }.sorted() } }
    /* How many items folder `id` holds, or nil when it isn't there. */
    func holds(_ id: String) -> Int? { lock.withLock { gone(id) ? nil : nodes.values.filter { $0.parent == id }.count } }
    func lineage(_ id: String) -> [String] {
        lock.withLock {
            var out: [String] = []
            var at: String? = id
            while let current = at { out.append(current); at = nodes[current]?.parent }
            return out
        }
    }
    var versions: Int { lock.withLock { uploads.values.filter { $0.version && $0.status == "completed" }.count } }
    var openReservations: [String] { lock.withLock { uploads.filter { $0.value.status == "open" }.map(\.key) } }
}

/* The drive one process sees: its calls fail as planned; `world` nil-plans it for the next launch. */
struct FaultyDrive: SaveRunWriter {
    let world: FaultWorld
    let healthy: Bool

    private func call<T: Sendable>(_ point: Point, _ effect: () throws -> T, refused: () throws -> T) async throws -> T {
        await Task.yield()
        let fault = healthy ? nil : world.fault(at: point)
        if !healthy { world.act(fault) }
        if !healthy, world.dead || world.outage || fault == .network { throw DriveAPIError.transport("The network connection was lost.") }
        if !healthy, world.locked { throw VaultLocked() }
        if fault == .refused { return try refused() }
        let result = try effect()
        if fault == .lost || fault == .crash {
            if fault == .crash { world.die() }
            if point == .begin, let id = result as? String { world.lostBegin(id) }
            throw DriveAPIError.transport("The network connection was lost.")
        }
        return result
    }
    private func refuse<T>() throws -> T { throw DriveAPIError.server(400, "Refused.") }

    func gate(_ target: Opened) async -> SaveGate { .writable }
    func room(_ workspaceId: String) async throws -> SaveRoom { .own(1 << 40) }
    func names(in folder: Opened) async throws -> [String] {
        try await call(.listing, { world.names(in: folder.id) }, refused: refuse)
    }
    func makeFolder(in folder: Opened, name: String, signing: Signing, minted: @escaping @Sendable (String) throws -> Void) async throws -> Opened {
        let id = "folder-\(UUID().uuidString.prefix(8))"
        try minted(id)
        try await call(.folder, { world.create(id, parent: folder.id, name: name) }, refused: refuse)
        return opened(id, parent: folder.id)
    }
    func uploadResult(_ bytes: Data, name: String, mime: String?, in folder: Opened, replacing: Opened?, startedFrom: String?, thumbnail: Data?,
                      signing: (metadata: Signing, version: Signing), onBegun: @escaping @Sendable (Vault.BegunIds) throws -> Void,
                      onCompleting: @escaping @Sendable (String) throws -> Void) async throws -> Opened {
        let nodeId = replacing?.id ?? "node-\(UUID().uuidString.prefix(8))"
        let version = replacing != nil
        let uploadId = try await call(.begin, { world.begin(nodeId, version: version, parent: folder.id) }, refused: refuse)
        // As the vault does: a begin its run can't record, a part that fails, a completion its run refuses, abort.
        do {
            try onBegun(Vault.BegunIds(workspaceId: "ws", uploadId: uploadId, nodeId: nodeId))
            for _ in 1 ... 2 { try await call(.part, {}, refused: refuse) }
            try onCompleting(uploadId)
        } catch {
            _ = await abortUpload(uploadId, in: "ws")
            throw error
        }
        let landed = try await call(.complete, { try world.complete(uploadId) }, refused: refuse)
        return opened(landed, parent: folder.id, version: version ? "v2" : "v1")
    }
    func fresh(_ file: Opened, in folder: Opened) async throws -> Opened? { file }
    func listed(_ id: String, in folder: Opened) async throws -> Opened? { nil }
    func lookFolder(_ id: String, in workspaceId: String) async throws -> Int? { try await call(.listing, { world.holds(id) }, refused: refuse) }
    func refreshFolder(_ folder: Opened) async throws -> Opened { folder }
    func keyChangePause(_ workspaceId: String, attempt: Int) async throws {}
    func abortUpload(_ uploadId: String, in workspaceId: String) async -> DriveAPI.AbortFate {
        (try? await call(.abort, { world.abort(uploadId) }, refused: { .denied })) ?? .unknown
    }
    func trash(_ ids: [String], in workspaceId: String) async throws -> [String: SaveItemFate] {
        try await call(.trash, { world.trash(ids) }, refused: { Dictionary(uniqueKeysWithValues: ids.map { ($0, .refused) }) })
    }
    func purge(_ ids: [String], in workspaceId: String) async throws -> [String: SaveItemFate] {
        try await call(.purge, { world.purge(ids) }, refused: { Dictionary(uniqueKeysWithValues: ids.map { ($0, .refused) }) })
    }
    func mayPurge(_ workspaceId: String) async -> Bool { true }
}

/* The run a fault's act reaches (a cancel), set once it starts. */
final class RunBox: @unchecked Sendable {
    private let lock = NSLock()
    private var held: SaveRun?
    var run: SaveRun? {
        get { lock.withLock { held } }
        set { lock.withLock { held = newValue } }
    }
}

@Suite(.serialized) struct SaveRunFaultTests {
    static let doc = opened("doc", parent: "f", version: "v1")
    static let f = opened("f")

    /* Representative runs: several new files, a folder tree, a new version, and a mix. */
    /* What a run was given: its new files and folders, and how many new versions were saved. */
    struct Made: Sendable { var nodes: [String] = []; var versions = 0 }

    /* Representative runs. Results go up together (a task group): the race found in round 5 came from that. */
    static let scenarios: [(String, @Sendable (SaveRun) async throws -> Made)] = [
        ("several new files", { run in
            try await withThrowingTaskGroup(of: String.self) { group in
                for name in ["a", "b", "c"] { group.addTask { try await run.file(Data([1]), name: name, mime: nil, sources: own).id } }
                var made = Made()
                for try await id in group { made.nodes.append(id) }
                return made
            }
        }),
        ("a folder tree", { run in
            let out = try await run.folder("Out", sources: own)
            let inner = try await run.folder("Inner", in: out, sources: own)
            let a = try await run.file(Data([1]), name: "a", mime: nil, sources: own, in: inner)
            let b = try await run.file(Data([1]), name: "b", mime: nil, sources: own, in: out)
            return Made(nodes: [out.id, inner.id, a.id, b.id])
        }),
        ("a new version", { run in
            let saved = try await run.version(Data([1]), of: doc, in: f, startedFrom: "v1", sources: own)
            if case .saved = saved { return Made(versions: 1) }
            return Made()
        }),
        ("a mix", { run in
            let out = try await run.folder("Out", sources: own)
            return try await withThrowingTaskGroup(of: Made.self) { group in
                group.addTask {
                    if case .saved = try await run.version(Data([1]), of: doc, in: f, startedFrom: "v1", sources: own) { return Made(versions: 1) }
                    return Made()
                }
                group.addTask { Made(nodes: [try await run.file(Data([1]), name: "a", mime: nil, sources: own).id]) }
                group.addTask { Made(nodes: [try await run.file(Data([1]), name: "b", mime: nil, sources: own, in: out).id]) }
                var made = Made(nodes: [out.id])
                for try await part in group { made.nodes += part.nodes; made.versions += part.versions }
                return made
            }
        }),
    ]

    enum Outcome { case finished(Made), notStarted, stopped(SaveRunStopped), unrecorded }

    struct Played {
        let world: FaultWorld
        let url: URL
        let session: SaveRunJournal.Epoch
        let outcome: Outcome
        let escaped: [String]
    }

    static func play(_ scenario: @Sendable (SaveRun) async throws -> Made, plan: Plan?) async -> Played {
        let world = FaultWorld(plan: plan)
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("save-faults-\(UUID().uuidString).json")
        let session = SaveRunJournal.Epoch()
        let rows = SaveRunJournal(url: url, epoch: session)
        rows.fault = { written in try world.journalWrite(written) }
        let drive = FaultyDrive(world: world, healthy: false)
        var escaped: [String] = []
        let outcome: Outcome
        let held = RunBox()
        world.onInterrupt { fault in
            switch fault {
            case .cancel: if let run = held.run { Task { _ = await run.cancel() } }
            case .signout:
                // As AccountStore.wipe does, on this journal's own session: runs abandoned, the journal gone. From
                // another thread, as a sign-out is (the run's lock may be held where this wait was reached).
                world.signOut()
                DispatchQueue.global().async {
                    session.end()
                    SaveRuns.abandonAll(session)
                    try? FileManager.default.removeItem(at: url)
                }
            default: break
            }
        }
        do {
            let run = try await SaveRun.start(writer: drive, targets: [f, doc], results: [], journal: rows)
            held.run = run
            do {
                let made = try await scenario(run)
                try await run.finish()
                outcome = .finished(made)
            } catch let stopped as SaveRunStopped {
                outcome = .stopped(stopped)
            } catch is SaveRecordNotUpdated {
                outcome = .unrecorded
            } catch {
                // A failure that never went through the run's stop: the rule broken.
                escaped.append("\(error)")
                outcome = .stopped(await run.cancel())
            }
        } catch {
            outcome = .notStarted
        }
        return Played(world: world, url: url, session: session, outcome: outcome, escaped: escaped)
    }

    /* The invariant, as violations (empty when it holds). */
    static func violations(_ scenario: @escaping @Sendable (SaveRun) async throws -> Made, plan: Plan?) async -> [String] {
        let played = await play(scenario, plan: plan)
        let world = played.world
        var found = played.escaped.map { "a failure escaped the run's stop: \($0)" }
        // The next launch: the same file, a new journal on it, a working drive.
        // A sign-out's wipe (on another thread) is done before anything is read: its journal is gone.
        if world.signedOut { try? FileManager.default.removeItem(at: played.url) }
        let disk = SaveRunJournal(url: played.url, epoch: played.session)
        let rows = disk.list()
        let named = Set(rows.flatMap(\.nodeIds))
        let dead = world.dead
        let signedOut = world.signedOut
        var excused = false
        if case .stopped(let stopped) = played.outcome, !dead {
            let message = stopped.message
            // "You'll be asked about it next time" promises a row; only "can no longer remove it", and a sign-out's
            // "may still be there", excuse an unnamed node.
            excused = message.contains("can no longer remove it") || (signedOut && message.contains("may still be there"))
            let said = stopped.keptVersions + stopped.uncertainVersions
            if world.versions > said { found.append("\(world.versions) versions published, \(said) said") }
            // Never claiming more than is so.
            if message.contains("Nothing was saved"), !world.published.isEmpty || world.versions > 0 {
                found.append("says nothing was saved: \(world.published.count) there, \(world.versions) versions")
            }
            if message.contains("Nothing else was saved"), !world.published.isEmpty { found.append("says nothing else was saved: \(world.published) there") }
            if stopped.keptVersions > world.versions { found.append("says \(stopped.keptVersions) versions kept, \(world.versions) exist") }
        }
        let offered = rows.filter { $0.done != true }
        if case .finished(let made) = played.outcome, offered.isEmpty {
            for id in made.nodes where !world.published.contains(id) { found.append("a saved result \(id) isn't there") }
            if world.versions < made.versions { found.append("a saved version isn't there") }
        } else if signedOut {
            // The journal went with the account: only what it said may remain may be there.
            if !dead, !excused { for id in world.published { found.append("\(id) is there after a sign-out that didn't say so") } }
        } else {
            for id in world.published where !world.lineage(id).contains(where: named.contains) && !excused {
                found.append("\(id) is published, named by no row")
            }
            let healthy = FaultyDrive(world: world, healthy: true)
            for row in offered { _ = await SaveRuns.cleanUp(row, writer: healthy, journal: disk) }
            if !excused { for id in world.published { found.append("\(id) is still there after the next launch's clean-up") } }
            // Only a folder whose creation may still land keeps its row past that launch; once the creation window
            // has passed, the launch after settles it.
            for row in disk.list() where row.done != true && (!row.uploadIds.isEmpty || !row.nodeIds.allSatisfy({ row.uncertain?[$0] != nil })) {
                found.append("a row survived the next launch's clean-up")
            }
            for row in disk.list() where row.done != true {
                _ = await SaveRuns.cleanUp(row, writer: healthy, journal: disk, now: Date().addingTimeInterval(SaveRuns.creationSettle))
            }
            if disk.list().contains(where: { $0.done != true }) { found.append("a row survived past the creation window") }
            // A reservation no row ever named is the server's expiry's: nothing is completed before its row is on disk.
            let known = world.openReservations.filter { world.recorded.contains($0) && !world.lostBegins.contains($0) }
            if !known.isEmpty { found.append("reservations left open: \(known.sorted())") }
        }
        return found
    }

    @Test(arguments: 0 ..< 4)
    func whateverFailsNothingPublishedIsUnaccountedForAndNothingSavedIsOffered(_ index: Int) async throws {
        let (name, scenario) = Self.scenarios[index]
        // A clean run first: how often it reaches each wait, so each one is failed in turn.
        let clean = await Self.play(scenario, plan: nil)
        guard case .finished = clean.outcome else { Issue.record("\(name): a clean run didn't finish"); return }
        var counts = clean.world.reached
        // The clean-up's waits are only reached once something fails: tried a few times each.
        for point in [Point.abort, .trash, .purge] { counts[point] = max(counts[point] ?? 0, 3) }
        counts[.journal] = (counts[.journal] ?? 0) + 2
        var failures: [String] = []
        var tried = 0
        for point in Point.allCases {
            for k in 1 ... max(1, counts[point] ?? 0) {
                for fault in point.faults {
                    tried += 1
                    for found in await Self.violations(scenario, plan: Plan(point: point, k: k, fault: fault)) {
                        failures.append("\(name): \(point.rawValue) #\(k) \(fault.rawValue): \(found)")
                    }
                }
            }
        }
        #expect(tried > 20)
        #expect(failures == [])
    }
}
