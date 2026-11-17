import Foundation
import HushOSCore
import Testing
@testable import HushOSKit

/*
 * The save path's rule one level down (SaveRunFaultTests drives a stand-in drive): the real SaveRun over the real Vault
 * (its uploads from memory, folder creations, listings, aborts, trash and purge) against FakeDrive, the fake server the
 * vault's tests use, which answers as packages/db does where it matters here: a completion that finds the file moved,
 * or re-keyed, is `conflicted` naming the version current now. Trash and delete forever are served here per item.
 *
 * Each wait (a listing, the epoch allocation, a folder's creation, a begin, a part, a completion, an abort, a trash, a
 * purge, a journal write) is failed in turn at its first reach and at one more drawn with a fixed seed: no network, a
 * lost answer, a refusal, an outage, a cancel, a crash just after the server acted, or the process dying. After each:
 * everything the run published is named by a surviving row or said to remain, a finished save's results are all
 * there and none of it is offered for deletion, and `stale` means a real race. (The room check reads the account's
 * storage outside FakeDrive, so it is not one of these waits here; the web's harness fails it.)
 */
enum EnginePoint: String, CaseIterable, Sendable { case listing, allocate, folder, begin, part, complete, abort, trash, purge, journal }
enum EngineFault: String, CaseIterable, Sendable { case network, lost, refused, outage, cancel, crash, death }

extension EnginePoint {
    var faults: [EngineFault] {
        switch self {
        case .listing, .allocate: [.network, .refused, .outage, .cancel, .death]
        case .part: [.network, .refused, .outage, .cancel, .death]
        case .journal: [.refused, .crash, .cancel, .death]
        default: EngineFault.allCases
        }
    }

    static func of(_ method: String, _ parts: [String]) -> EnginePoint? {
        if parts.first == "store" { return .part }
        let p = Array(parts.dropFirst(2))
        switch (method, p.count, p.first, p.last) {
        case ("GET", 3, "nodes", "children"): return .listing
        case ("POST", 3, "workspaces", "epochs"): return .allocate
        case ("POST", 1, "folders", _): return .folder
        case ("POST", 1, "uploads", _): return .begin
        case ("POST", 3, "uploads", "complete"): return .complete
        case ("POST", 3, "uploads", "abort"): return .abort
        case ("POST", 3, "workspaces", "trash-batch"): return .trash
        case ("DELETE", 2, "nodes", _): return .purge
        default: return nil
        }
    }
}

struct EnginePlan: Sendable { let point: EnginePoint; let k: Int; let fault: EngineFault }

/* The faults as the process meets them; `live` false for the next launch (a working network). */
final class EngineWorld: @unchecked Sendable {
    private let lock = NSLock()
    let plan: EnginePlan?
    private var counts: [EnginePoint: Int] = [:]
    private var dropping = Set<ObjectIdentifier>()
    private(set) var dead = false
    private(set) var outage = false
    var live = true
    var cancel: (@Sendable () -> Void)?
    var trashed = Set<String>()

    init(plan: EnginePlan?) { self.plan = plan }
    var reached: [EnginePoint: Int] { lock.withLock { counts } }
    func die() { lock.withLock { dead = true } }

    func fault(_ point: EnginePoint) -> EngineFault? {
        let fault: EngineFault? = lock.withLock {
            guard live else { return nil }
            let k = (counts[point] ?? 0) + 1
            counts[point] = k
            guard let plan, plan.point == point, plan.k == k else { return nil }
            if plan.fault == .death { dead = true }
            if plan.fault == .outage { outage = true }
            return plan.fault
        }
        if fault == .cancel { cancel?() }
        return fault
    }
    func drop() { lock.withLock { _ = dropping.insert(ObjectIdentifier(Thread.current)) } }
    func dropped() -> Bool { lock.withLock { dropping.remove(ObjectIdentifier(Thread.current)) != nil } }
    var reachable: Bool { lock.withLock { !live || !(dead || outage) } }
}

extension OnFakeDrive {
    @Suite(.serialized) struct SaveRunEngineTests {
        struct Made: Sendable { var nodes: [String] = []; var saved = 0; var stale: [String?] = [] }

        struct Setup {
            let server: FakeDrive
            let vault: Vault
            let world: EngineWorld
            let into: Opened
            let doc: Opened
            let original: Set<String>
            let docVersion: String
        }

        static func setUp(_ plan: EnginePlan?) async throws -> Setup {
            let server = try FakeDrive()
            FakeDrive.current = server
            let vault = Vault(api: DriveAPI(session: server.session, configuration: FakeDrive.configuration), session: server.session)
            await vault.adopt(workspace: WorkspaceView(workspaceId: server.workspace, changeSeq: nil, grant: nil, root: server.nodes[server.root]),
                              key: server.workspaceKey)
            await vault.adopt(identity: server.identity)
            await vault.adopt(signers: try server.ownerTrusts())
            let into = try await vault.children(of: server.root).first { $0.id == server.b }!
            let doc = try await vault.children(of: server.b).first { $0.id == server.g }!
            let world = EngineWorld(plan: plan)
            let network = URLError(.networkConnectionLost)
            server.intercept = { method, parts, body in
                guard let point = EnginePoint.of(method, parts) else { return nil }
                if !world.reachable { throw network }
                let fault = world.fault(point)
                if fault == .network { throw network }
                if fault == .refused { return (403, ["code": "forbidden", "message": "Refused."]) }
                if fault == .lost || fault == .crash { world.drop() }
                if fault == .crash { world.die() }
                // Trash and delete forever, per item, as the batch routes answer.
                if point == .trash {
                    let ids = body["nodeIds"] as? [String] ?? []
                    return (200, ["results": server.locked {
                        ids.map { id -> [String: Any] in
                            guard server.nodes[id] != nil else { return ["id": id, "status": "refused", "reason": "not-found"] }
                            world.trashed.insert(id)
                            return ["id": id, "status": "trashed"]
                        }
                    }])
                }
                if point == .purge {
                    let id = parts.last ?? ""
                    return server.locked {
                        guard server.nodes[id] != nil else { return (404, ["code": "not-found", "message": "This item no longer exists."]) }
                        // A folder goes with everything inside it.
                        var gone: [String] = []
                        var queue = [id]
                        while let next = queue.popLast() {
                            gone.append(next)
                            queue += server.nodes.values.filter { $0.parentId == next }.map(\.id)
                        }
                        for each in gone { server.nodes[each] = nil }
                        return (200, ["purged": true])
                    }
                }
                return nil
            }
            server.afterAnswer = { _, _ in if world.dropped() { throw network } }
            let original = Set(server.nodes.keys)
            return Setup(server: server, vault: vault, world: world, into: into, doc: doc, original: original, docVersion: doc.node.currentVersion!.id)
        }

        static func versionOf(_ run: SaveRun, _ s: Setup) async throws -> Made {
            switch try await run.version(Data("new".utf8), of: s.doc, in: s.into, startedFrom: s.docVersion, sources: own) {
            case .saved: return Made(saved: 1)
            case .stale(let current): return Made(stale: [current])
            }
        }

        struct Scenario: Sendable {
            var before: @Sendable (Setup) -> Void = { _ in }
            let run: @Sendable (SaveRun, Setup) async throws -> Made
        }

        static let scenarios: [(String, Scenario)] = [
            ("new files", Scenario { run, s in
                let a = try await run.file(Data("a".utf8), name: "a.txt", mime: "text/plain", sources: own, in: s.into)
                let b = try await run.file(Data("b".utf8), name: "b.txt", mime: "text/plain", sources: own, in: s.into)
                return Made(nodes: [a.id, b.id])
            }),
            ("a folder tree", Scenario { run, s in
                let out = try await run.folder("Out", in: s.into, sources: own)
                let a = try await run.file(Data("a".utf8), name: "a.txt", mime: "text/plain", sources: own, in: out)
                return Made(nodes: [out.id, a.id])
            }),
            ("a new version", Scenario { run, s in try await versionOf(run, s) }),
            // A key change re-keyed the file while the version went up (its version the same): sealed afresh, never stale.
            ("a key change, the version the same", Scenario(before: { s in s.server.rekeyAtComplete = true }) { run, s in try await versionOf(run, s) }),
        ]

        enum Outcome { case finished(Made), notStarted, unrecorded, stopped(SaveRunStopped) }

        static func play(_ scenario: Scenario, plan: EnginePlan?) async throws -> (EngineWorld, [String]) {
            let s = try await setUp(plan)
            scenario.before(s)
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("save-engine-\(UUID().uuidString).json")
            let session = SaveRunJournal.Epoch()
            let rows = SaveRunJournal(url: url, epoch: session)
            let world = s.world
            rows.fault = { _ in
                let fault = world.fault(.journal)
                if world.dead || fault == .refused { throw CocoaError(.fileWriteOutOfSpace) }
                if fault == .crash { world.die() }
            }
            var found: [String] = []
            let held = RunBox()
            world.cancel = { if let run = held.run { Task { _ = await run.cancel() } } }
            let outcome: Outcome
            do {
                let run = try await SaveRun.start(writer: s.vault, targets: [s.into, s.doc], results: [], journal: rows, pause: { _ in })
                held.run = run
                do {
                    let made = try await scenario.run(run, s)
                    try await run.finish()
                    outcome = .finished(made)
                } catch let stopped as SaveRunStopped {
                    outcome = .stopped(stopped)
                } catch is SaveRecordNotUpdated {
                    outcome = .unrecorded
                } catch {
                    found.append("a failure escaped the run's stop: \(error)")
                    outcome = .stopped(await run.cancel())
                }
            } catch {
                outcome = .notStarted
            }
            try await Task.sleep(for: .milliseconds(20))
            found += await judge(s, url: url, session: session, outcome: outcome)
            return (world, found)
        }

        /* New files and folders the run made that are still there (live or in the Trash). */
        static func published(_ s: Setup) -> [String] {
            s.server.locked {
                s.server.nodes.keys.filter { id in
                    guard !s.original.contains(id) else { return false }
                    var at: String? = id
                    while let current = at, current != s.server.root { guard let node = s.server.nodes[current] else { return false }; at = node.parentId }
                    return true
                }
            }
        }
        static func versions(_ s: Setup) -> Int { s.server.locked { s.server.nodes[s.doc.id]?.currentVersion?.id != s.docVersion ? 1 : 0 } }
        static func lineage(_ s: Setup, _ id: String) -> [String] {
            s.server.locked {
                var out: [String] = []
                var at: String? = id
                while let current = at { out.append(current); at = s.server.nodes[current]?.parentId }
                return out
            }
        }

        static func judge(_ s: Setup, url: URL, session: SaveRunJournal.Epoch, outcome: Outcome) async -> [String] {
            var found: [String] = []
            let dead = s.world.dead
            s.world.live = false
            let disk = SaveRunJournal(url: url, epoch: session)
            let rows = disk.list()
            let named = Set(rows.flatMap(\.nodeIds))
            let out = published(s)
            var excused = false
            if case .stopped(let stopped) = outcome, !dead {
                excused = stopped.message.contains("can no longer remove it")
                if stopped.message.contains("Nothing was saved"), !out.isEmpty || versions(s) > 0 {
                    found.append("says nothing was saved: \(out.count) there, \(versions(s)) versions")
                }
                if stopped.keptVersions > versions(s) { found.append("says \(stopped.keptVersions) versions kept, \(versions(s)) exist") }
                if versions(s) > stopped.keptVersions + stopped.uncertainVersions {
                    found.append("\(versions(s)) versions published, \(stopped.keptVersions + stopped.uncertainVersions) said")
                }
            }
            let offered = rows.filter { $0.done != true }
            if case .finished(let made) = outcome, offered.isEmpty {
                for id in made.nodes where !out.contains(id) { found.append("a saved result \(id) isn't there") }
                if versions(s) < made.saved { found.append("a saved version isn't there") }
                for current in made.stale where versions(s) == 0 { found.append("said stale (naming \(current ?? "none")), but nobody else saved") }
            } else {
                for id in out where !lineage(s, id).contains(where: named.contains) && !excused { found.append("\(id) is published, named by no row") }
                // The next launch, from the journal alone, on a working network.
                for row in offered { _ = await SaveRuns.cleanUp(row, writer: s.vault, journal: disk) }
                if !excused { for id in published(s) { found.append("\(id) is still there after the next launch's clean-up") } }
                if disk.list().contains(where: { $0.done != true }) { found.append("a row survived the next launch's clean-up") }
            }
            return found
        }

        /* Plays per scenario, drawn from every wait and fault: SAVE_ENGINE_SAMPLE runs more (or all). */
        static let sample = Int(ProcessInfo.processInfo.environment["SAVE_ENGINE_SAMPLE"] ?? "") ?? 40

        @Test func theRuleHoldsOverTheRealVaultWhateverFails() async throws {
            var failures: [String] = []
            var tried = 0
            var random = SeededRandom(seed: 7)
            for (name, scenario) in Self.scenarios {
                let (clean, found) = try await Self.play(scenario, plan: nil)
                #expect(found == [], "\(name): a clean run")
                let counts = clean.reached
                // Every wait and fault at its first reach and one more, then a fixed-seed sample of them: a play here
                // sets up a whole FakeDrive and vault, so the full product would take many minutes.
                var plans: [EnginePlan] = []
                for point in EnginePoint.allCases {
                    let reached = max(1, counts[point] ?? 0, [.abort, .trash, .purge].contains(point) ? 3 : 0)
                    let ks = Array(Set([1] + (reached > 1 ? [2 + Int(random.next() % UInt64(reached - 1))] : []))).sorted()
                    for k in ks { for fault in point.faults { plans.append(EnginePlan(point: point, k: k, fault: fault)) } }
                }
                for index in plans.indices.reversed() { plans.swapAt(index, Int(random.next() % UInt64(index + 1))) }
                for plan in plans.prefix(Self.sample) {
                    tried += 1
                    for violation in try await Self.play(scenario, plan: plan).1 {
                        failures.append("\(name): \(plan.point.rawValue) #\(plan.k) \(plan.fault.rawValue): \(violation)")
                    }
                }
            }
            #expect(tried >= 4 * Self.sample)
            #expect(failures == [])
        }
    }
}

/* A fixed-seed generator: the same waits drawn every run, so a failure replays. */
struct SeededRandom {
    private var state: UInt64
    init(seed: UInt64) { state = seed }
    mutating func next() -> UInt64 {
        state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
        return state >> 33
    }
}
