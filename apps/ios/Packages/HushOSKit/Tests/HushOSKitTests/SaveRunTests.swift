import Foundation
import HushOSCore
import Testing
@testable import HushOSKit

/*
 * The save path on the phone (SaveRuns.swift). A run decides before anything is made whether it
 * may write and whether it fits, saves results from memory under the next free name, ends a
 * version race `stale`, and leaves no new file behind when it stops: each test fails on the defect
 * a person would see (a run that starts and fails halfway, a laundered mark, a half-made result
 * left behind, a file an editor may only trash deleted forever, a row the next open needs lost, a
 * row written after a sign-out).
 */

/* The drive as a run's clean-up meets it: nodes live, in the Trash or deleted; uploads open or finished. */
actor FakeWriter: SaveRunWriter {
    var refusal: String?
    var roomIs: SaveRoom
    var names: [String] = []
    var member = true
    var offline = false
    var denied = false
    /* A family manager paused this person's changes: every write refused `held`. */
    var held = false
    func set(held: Bool) { self.held = held }
    var refuse = Set<String>()
    var busy = Set<String>()
    var live = Set<String>()
    var trashed = Set<String>()
    var purged = Set<String>()
    var open = Set<String>()
    var finished = Set<String>()
    var aborted: [String] = []
    var uploads: [(name: String, folder: String, replacing: String?, keyEpoch: UInt64?, startedFrom: String?, signing: (metadata: Signing, version: Signing))] = []
    /* The destination's key epoch each upload and folder was sealed under, and each folder refresh. */
    var folderEpochs: [UInt64] = []
    var refreshes = 0
    var folderAnswers: [@Sendable () throws -> Void] = []
    var landing: (@Sendable () async -> Void)?
    var making: (@Sendable () async -> Void)?
    var freshFile: Opened??
    /* What each upload does once begun, in order (default: land). */
    var answers: [@Sendable (Int) throws -> Void] = []
    var listing: (@Sendable () async -> Void)?
    /* Runs before the begin's ids reach the run (a begin still on its way). */
    var beginning: (@Sendable () async -> Void)?
    /* What each folder refresh does, in order (default: the folder at the next key epoch). */
    var refreshAnswers: [@Sendable () throws -> Void] = []
    /* Uploads the server is still completing: an abort is answered `unknown` (Vault.abortUpload after its tries). */
    var completing = Set<String>()
    var roomHook: (@Sendable () async -> Void)?
    /* A folder created whose answer never comes back. */
    var loseAnswer = false
    /* The answer is cut while the server is still making the folder: it lands in `later`, made once the test says. */
    var createLater = false
    var later: [String] = []
    /* A creation the server refuses with its reason. */
    var refuseCreation: DriveAPIError?
    /* Parts each upload sends, a few milliseconds apart; one for an upload already aborted is refused, as the store does. */
    var parts = 1
    var stopStarted = false
    var partsAfterStop = 0
    var namesFail = false
    var uploading: (@Sendable () async -> Void)?
    /* Uploads whose parts went out after their begin was taken. */
    var partsSent = 0
    private var count = 0

    init(room: SaveRoom = .own(1 << 40)) { roomIs = room }

    func set(refusal: String?) { self.refusal = refusal }
    func set(member: Bool) { self.member = member }
    func set(offline: Bool) { self.offline = offline }
    func set(denied: Bool) { self.denied = denied }
    func set(names: [String]) { self.names = names }
    func set(fresh: Opened?) { freshFile = .some(fresh) }
    func set(listing: @escaping @Sendable () async -> Void) { self.listing = listing }
    func refuse(_ id: String) { refuse.insert(id) }
    func busy(_ id: String) { busy.insert(id) }
    func finish(_ uploadId: String) { open.remove(uploadId); finished.insert(uploadId) }
    func answer(_ next: @escaping @Sendable (Int) throws -> Void) { answers.append(next) }

    func gate(_ target: Opened) async -> SaveGate { refusal.map { .refused($0) } ?? .writable }
    func room(_ workspaceId: String) async throws -> SaveRoom {
        await roomHook?()
        return roomIs
    }
    func set(beginning: @escaping @Sendable () async -> Void) { self.beginning = beginning }
    func set(room: @escaping @Sendable () async -> Void) { roomHook = room }
    func refreshAnswer(_ next: @escaping @Sendable () throws -> Void) { refreshAnswers.append(next) }
    func completing(_ uploadId: String) { completing.insert(uploadId) }
    func names(in folder: Opened) async throws -> [String] {
        await listing?()
        if namesFail { throw DriveAPIError.transport("The network connection was lost.") }
        return names
    }
    func makeFolder(in folder: Opened, name: String, signing: Signing, minted: @escaping @Sendable (String) throws -> Void) async throws -> Opened {
        folderEpochs.append(folder.node.keyEpoch)
        if !folderAnswers.isEmpty { try folderAnswers.removeFirst()() }
        // Its id heard before the creation is sent, as the vault's createFolder does.
        try minted("made-\(name)")
        await making?()
        if let refuseCreation { throw refuseCreation }
        if createLater {
            later.append("made-\(name)")
            throw DriveAPIError.transport("The network connection was lost.")
        }
        live.insert("made-\(name)")
        if loseAnswer { throw DriveAPIError.transport("The network connection was lost.") }
        return opened("made-\(name)", parent: folder.id)
    }
    func set(loseAnswer: Bool) { self.loseAnswer = loseAnswer }
    func set(createLater: Bool) { self.createLater = createLater }
    func set(refuseCreation: DriveAPIError) { self.refuseCreation = refuseCreation }
    func set(parts: Int) { self.parts = parts }
    func startStop() { stopStarted = true }
    /* The folders whose creation lost its answer, made now. */
    func makeLater() { live.formUnion(later) }
    func makeLive(_ id: String) { live.insert(id) }
    func set(namesFail: Bool) { self.namesFail = namesFail }
    func set(uploading: @escaping @Sendable () async -> Void) { self.uploading = uploading }
    /* A completion whose reply names another item than the one written. */
    var landedAs: String?
    func set(landedAs: String?) { self.landedAs = landedAs }
    func uploadResult(_ bytes: Data, name: String, mime: String?, in folder: Opened, replacing: Opened?, startedFrom: String?, thumbnail: Data?,
                      signing: (metadata: Signing, version: Signing), onBegun: @escaping @Sendable (Vault.BegunIds) throws -> Void,
                      onCompleting: @escaping @Sendable (String) throws -> Void) async throws -> Opened {
        count += 1
        let n = count
        uploads.append((name, folder.id, replacing?.id, replacing?.node.keyEpoch, startedFrom, signing))
        folderEpochs.append(folder.node.keyEpoch)
        let nodeId = replacing?.id ?? "node-\(n)"
        open.insert("up-\(n)")
        await beginning?()
        do {
            try onBegun(Vault.BegunIds(workspaceId: "ws", uploadId: "up-\(n)", nodeId: nodeId))
        } catch {
            // As the vault does: nothing is sent, the reservation goes.
            open.remove("up-\(n)")
            aborted.append("up-\(n)")
            throw error
        }
        // Its parts on their way, the completion not yet sent.
        for _ in 0 ..< parts {
            guard open.contains("up-\(n)") else { throw DriveAPIError.notFound("There is no such upload.") }
            if stopStarted { partsAfterStop += 1 }
            if parts > 1 { try await Task.sleep(for: .milliseconds(10)) }
        }
        partsSent += 1
        await uploading?()
        if !answers.isEmpty { try answers.removeFirst()(n) }
        do {
            try onCompleting("up-\(n)")
        } catch {
            // As the vault does: a run that stopped refuses the completion, and the reservation goes.
            open.remove("up-\(n)")
            aborted.append("up-\(n)")
            throw error
        }
        await landing?()
        finish("up-\(n)")
        if replacing == nil { live.insert(nodeId) }
        return opened(landedAs ?? nodeId, parent: folder.id)
    }
    /* A re-listing that names another folder (a server answering a key change's look with some other one). */
    var refreshedAs: Opened?
    func set(refreshedAs: Opened?) { self.refreshedAs = refreshedAs }
    func refreshFolder(_ folder: Opened) async throws -> Opened {
        refreshes += 1
        if !refreshAnswers.isEmpty { try refreshAnswers.removeFirst()() }
        if let refreshedAs { return refreshedAs }
        return opened(folder.id, parent: folder.node.parentId, keyEpoch: folder.node.keyEpoch + 1)
    }
    func folderAnswer(_ next: @escaping @Sendable () throws -> Void) { folderAnswers.append(next) }
    func set(landing: @escaping @Sendable () async -> Void) { self.landing = landing }
    func set(making: @escaping @Sendable () async -> Void) { self.making = making }
    func fresh(_ file: Opened, in folder: Opened) async throws -> Opened? {
        if let freshFile { return freshFile }
        return file
    }
    /* The workspace a 409's look names its row in (another one: not the folder minted here). */
    var listedWorkspace = "ws"
    func set(listedWorkspace: String) { self.listedWorkspace = listedWorkspace }
    func listed(_ id: String, in folder: Opened) async throws -> Opened? {
        live.contains(id) ? opened(id, parent: folder.id, workspace: listedWorkspace) : nil
    }
    /* Items in a folder, for lookFolder; and a hook that runs before each look. */
    var items: [String: Int] = [:]
    var looking: (@Sendable () async -> Void)?
    func set(items count: Int, in id: String) { items[id] = count }
    func set(looking: @escaping @Sendable () async -> Void) { self.looking = looking }
    func makeGone(_ id: String) { live.remove(id) }
    func lookFolder(_ id: String, in workspaceId: String) async throws -> Int? {
        await looking?()
        if offline { throw DriveAPIError.transport("offline") }
        return live.contains(id) || trashed.contains(id) ? items[id] ?? 0 : nil
    }
    func keyChangePause(_ workspaceId: String, attempt: Int) async throws {}
    func abortUpload(_ uploadId: String, in workspaceId: String, while stillOn: @escaping @Sendable () -> Bool) async -> DriveAPI.AbortFate {
        // Asked before it is sent, as the vault does before every try.
        guard stillOn() else { return .unknown }
        if offline { return .unknown }
        if held { return .held }
        if denied { return .denied }
        if completing.contains(uploadId) { return .unknown }
        aborted.append(uploadId)
        if finished.contains(uploadId) { return .finished }
        return open.remove(uploadId) != nil ? .aborted : .gone
    }
    /* Every request a clean-up sends, in order; and a hook that runs once a trash has been answered. */
    var sent: [String] = []
    var afterTrash: (@Sendable () -> Void)?
    func set(afterTrash: @escaping @Sendable () -> Void) { self.afterTrash = afterTrash }
    /* Awaited once a trash is sent, before it is answered (a request on its way). */
    var trashing: (@Sendable () async -> Void)?
    func set(trashing: @escaping @Sendable () async -> Void) { self.trashing = trashing }
    func trash(_ ids: [String], in workspaceId: String, while stillOn: @escaping @Sendable () -> Bool) async throws -> [String: SaveItemFate] {
        guard stillOn() else { return Dictionary(uniqueKeysWithValues: ids.map { ($0, .refused) }) }
        sent.append("trash")
        await trashing?()
        if offline { throw DriveAPIError.transport("offline") }
        var fates: [String: SaveItemFate] = [:]
        for id in ids {
            if held { fates[id] = .held } else if denied { fates[id] = .denied } else if refuse.contains(id) { fates[id] = .refused } else if live.remove(id) != nil {
                trashed.insert(id)
                fates[id] = .done
            } else { fates[id] = trashed.contains(id) ? .done : .gone }
        }
        afterTrash?()
        return fates
    }
    func purge(_ ids: [String], in workspaceId: String, while stillOn: @escaping @Sendable () -> Bool) async throws -> [String: SaveItemFate] {
        guard stillOn() else { return Dictionary(uniqueKeysWithValues: ids.map { ($0, .refused) }) }
        sent.append("purge")
        var fates: [String: SaveItemFate] = [:]
        for id in ids {
            if busy.contains(id) { fates[id] = .refused } else if trashed.remove(id) != nil {
                purged.insert(id)
                fates[id] = .done
            } else { fates[id] = .gone }
        }
        return fates
    }
    func mayPurge(_ workspaceId: String) async -> Bool? {
        sent.append("may-purge")
        return member
    }
}

func opened(_ id: String, parent: String? = "root", version: String? = nil, keyEpoch: UInt64 = 1, name: String? = nil,
            workspace: String = "ws") -> Opened {
    let current = version.map {
        VersionView(id: $0, objectId: "o", contentKeyEnvelope: "", status: "ready", contentSuite: 3, chunkCount: 1, contentNonce: "",
                    plaintextSize: nil, ciphertextSize: nil, readyAt: nil)
    }
    let node = NodeView(id: id, workspaceId: workspace, parentId: parent, kind: version == nil ? "folder" : "file", keyEpoch: keyEpoch, parentKeyEpoch: 1,
                        keyEnvelope: "", metadataVersion: 1, metadataEnvelope: "", currentVersion: current, trashedAt: nil, changeSeq: 1,
                        createdAt: nil, updatedAt: nil)
    return Opened(node: node, metadata: NodeMetadata(name: name ?? id, mime: nil, size: nil, modified: nil, attributes: [:]), nodeKey: nil)
}

/* A journal of its own session: another suite's sign-out (AccountStoreTests wipes) never ends it. */
func journal(_ epoch: SaveRunJournal.Epoch = SaveRunJournal.Epoch()) -> SaveRunJournal {
    SaveRunJournal(url: FileManager.default.temporaryDirectory.appendingPathComponent("save-runs-\(UUID().uuidString).json"), epoch: epoch)
}

let own = SaveSources.ownWriting

@Suite(.serialized) struct SaveRunTests {
    @Test func aReadOnlyFamilyFolderRefusesTheRunBeforeAnythingIsMade() async throws {
        let writer = FakeWriter()
        await writer.set(refusal: "This family folder is read only on this phone.")
        let rows = journal()
        await #expect(throws: SaveRefused.self) {
            _ = try await SaveRun.start(writer: writer, targets: [opened("fam")], results: [.known(size: 1, thumbnail: true)], journal: rows)
        }
        #expect(rows.list().isEmpty)
        #expect(await writer.uploads.isEmpty)
    }

    @Test func aRunThatDoesNotFitIsRefusedByTheCoresEstimateAndOneThatFitsExactlyStarts() async throws {
        let results: [PlannedResult] = [.known(size: 5_000_000, thumbnail: true), .fromSources(sourcesSize: 2_000_000, thumbnail: false)]
        let needed = try runEstimate(results: results)
        do {
            _ = try await SaveRun.start(writer: FakeWriter(room: .own(Int64(needed) - 1)), targets: [opened("f")], results: results, journal: journal())
            Issue.record("started without room")
        } catch let refused as SaveRefused {
            #expect(refused.reason == .noRoom)
            #expect(refused.needed == needed)
            #expect(refused.free == Int64(needed) - 1)
        }
        let rows = journal()
        let run = try await SaveRun.start(writer: FakeWriter(room: .family(Int64(needed))), targets: [opened("f")], results: results, journal: rows)
        #expect(rows.list().map(\.id) == [run.id])
    }

    @Test func aResultPlannedWithoutAThumbnailMayNotCarryOne() async throws {
        let run = try await SaveRun.start(writer: FakeWriter(), targets: [opened("f")], results: [.known(size: 1, thumbnail: false)], journal: journal())
        // Refused before anything is sent: not a stop, nothing cleaned up, and the run goes on.
        await #expect(throws: SaveRunRefusal.self) {
            _ = try await run.file(Data([1]), name: "a.png", mime: "image/png", sources: own, thumbnail: Data([9]))
        }
        _ = try await run.file(Data([1]), name: "b.png", mime: "image/png", sources: own)
    }

    @Test func eachResultTakesTheNextFreeNameAndNeverReplaces() async throws {
        let writer = FakeWriter()
        await writer.set(names: ["report.pdf", "Report (2).pdf"])
        let run = try await SaveRun.start(writer: writer, targets: [opened("f")], results: [], journal: journal())
        _ = try await run.file(Data([1]), name: "report.pdf", mime: nil, sources: own)
        _ = try await run.file(Data([1]), name: "REPORT.pdf", mime: nil, sources: own)
        let uploads = await writer.uploads
        #expect(uploads.map(\.name) == ["report (3).pdf", "REPORT (4).pdf"])
        #expect(uploads.allSatisfy { $0.replacing == nil })
    }

    @Test func eachResultIsSignedByItsOwnSourcesTheWeakestOfThem() async throws {
        let writer = FakeWriter()
        let run = try await SaveRun.start(writer: writer, targets: [opened("f")], results: [], journal: journal())
        _ = try await run.file(Data([1]), name: "a", mime: nil, sources: .from([.file(metadata: .verified, version: .verified, fromLink: false)]))
        _ = try await run.file(Data([1]), name: "b", mime: nil, sources: .from([
            .file(metadata: .verified, version: .verified, fromLink: false),
            .folder(metadata: .verified, fromLink: false, within: [.file(metadata: .verified, version: .unknownSigner, fromLink: false)]),
        ]))
        _ = try await run.file(Data([1]), name: "c", mime: nil, sources: .from([.file(metadata: .verified, version: .verified, fromLink: true)]))
        _ = try await run.file(Data([1]), name: "d", mime: nil, sources: own)
        let signed = await writer.uploads.map(\.signing)
        #expect(signed[0].metadata == .copy(.verified) && signed[0].version == .copy(.verified))
        #expect(signed[1].version == .copy(.unknownSigner))
        #expect(signed[2].metadata == .copy(.savedFromLink) && signed[2].version == .copy(.savedFromLink))
        #expect(signed[3].metadata == .own && signed[3].version == .own)
        await #expect(throws: (any Error).self) { _ = try await run.file(Data([1]), name: "e", mime: nil, sources: .from([])) }
    }

    /* A stale version gives back its thumbnail's room: Save on top or Save as a copy may carry the same thumbnail. */
    @Test func aStaleVersionGivesBackItsThumbnailsRoom() async throws {
        let writer = FakeWriter()
        await writer.answer { _ in throw SaveStale(currentVersionId: "v-theirs") }
        let doc = opened("doc", parent: "f", version: "v1")
        let run = try await SaveRun.start(writer: writer, targets: [doc], results: [.known(size: 1, thumbnail: true)], journal: journal())
        let thumb = Data([9, 9])
        #expect(try await run.version(Data([1]), of: doc, in: opened("f"), startedFrom: "v1", sources: own, thumbnail: thumb) == .stale(currentVersionId: "v-theirs"))
        // Save on top, with the same thumbnail, within the one planned.
        _ = try await run.version(Data([1]), of: doc, in: opened("f"), startedFrom: "v-theirs", sources: own, thumbnail: thumb)
        #expect(await writer.uploads.count == 2)
    }

    @Test func aVersionSomeoneElseBeatIsStaleAndTheRunGoesOn() async throws {
        let writer = FakeWriter()
        await writer.answer { _ in throw SaveStale(currentVersionId: "v-theirs") }
        let rows = journal()
        let doc = opened("doc", parent: "f", version: "v1")
        let run = try await SaveRun.start(writer: writer, targets: [doc], results: [], journal: rows)
        let saved = try await run.version(Data([1]), of: doc, in: opened("f"), startedFrom: "v1", sources: own)
        #expect(saved == .stale(currentVersionId: "v-theirs"))
        #expect(rows.list().first?.nodeIds == [])
        _ = try await run.file(Data([2]), name: "after.txt", mime: nil, sources: own)
        try await run.finish()
        #expect(await writer.trashed.isEmpty)
        #expect(rows.list().isEmpty)
    }

    @Test func aVersionThatLandedBeforeACancelIsKeptAndSaidSo() async throws {
        let writer = FakeWriter()
        let doc = opened("doc", parent: "f", version: "v1")
        let run = try await SaveRun.start(writer: writer, targets: [doc, opened("f")], results: [], journal: journal())
        _ = try await run.version(Data([1]), of: doc, in: opened("f"), startedFrom: "v1", sources: own)
        let stopped = await run.cancel()
        #expect(stopped.keptVersions == 1)
        #expect(!stopped.message.contains("Nothing was saved"))
        #expect(stopped.message.contains("was kept"))
    }

    @Test func aKeyOnlyRefusalLooksTheFileUpAgainAndSealsAfreshKeepingTheVersionItStartedFrom() async throws {
        let writer = FakeWriter()
        await writer.answer { _ in throw SaveRekeyed() }
        await writer.set(fresh: opened("doc", parent: "f", version: "v1", keyEpoch: 7))
        let doc = opened("doc", parent: "f", version: "v1", keyEpoch: 1)
        let run = try await SaveRun.start(writer: writer, targets: [doc], results: [], journal: journal(), pause: { _ in })
        let saved = try await run.version(Data([1]), of: doc, in: opened("f"), startedFrom: "v1", sources: own)
        guard case .saved = saved else { Issue.record("not saved: \(saved)"); return }
        let uploads = await writer.uploads
        #expect(uploads.map(\.keyEpoch) == [1, 7])
        #expect(uploads.map(\.startedFrom) == ["v1", "v1"])
        // Its file gone from the folder by the next look: stale, never a new file there.
        let gone = FakeWriter()
        await gone.answer { _ in throw SaveRekeyed() }
        await gone.set(fresh: nil)
        let next = try await SaveRun.start(writer: gone, targets: [doc], results: [], journal: journal(), pause: { _ in })
        #expect(try await next.version(Data([1]), of: doc, in: opened("f"), startedFrom: "v1", sources: own) == .stale(currentVersionId: nil))
    }

    /* A journal file it can't read is never written over or removed: the other runs' rows in it stay, and writes are refused. */
    @Test func anUnreadableJournalIsNeverWrittenOver() async throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("save-runs-\(UUID().uuidString).json")
        let rows = SaveRunJournal(url: url, epoch: SaveRunJournal.Epoch())
        let other = SaveRunRow(id: "other", workspaceId: "ws", nodeIds: ["node-x"], uploadIds: [], at: Date(), launch: "an-earlier-launch")
        try rows.put(other)
        // Cut short (a write torn by something outside this app): not "no rows", and not another account's file.
        let torn = try Data(contentsOf: url).dropLast(5)
        try torn.write(to: url)
        #expect(throws: SaveUnrecorded.self) { try rows.put(SaveRunRow(id: "next", workspaceId: "ws", nodeIds: [], uploadIds: [], at: Date(), launch: "l")) }
        #expect(!rows.retire(other))
        #expect(!rows.swap(other, nil))
        rows.dropDone()
        #expect(rows.list().isEmpty)
        // A Delete or a Keep never takes an unreadable row for gone: left, or not recorded (asked again).
        let writer = FakeWriter()
        #expect(await SaveRuns.cleanUp(other, writer: writer, journal: rows) == .left)
        await #expect(throws: SaveRecordNotUpdated.self) { try await SaveRuns.keep(other, writer: writer, journal: rows) }
        #expect(await writer.sent.isEmpty)
        #expect(try Data(contentsOf: url) == torn)
        // A run refuses to start rather than publish what no row names.
        await #expect(throws: SaveRunStopped.self) { _ = try await SaveRun.start(writer: FakeWriter(), targets: [opened("f")], results: [], journal: rows) }
        #expect(try Data(contentsOf: url) == torn)
        // Another account's file, read whole, is still dropped.
        let theirs = SaveRunJournal(url: url, epoch: SaveRunJournal.Epoch(), owner: AccountOwner(userId: "someone-else", origin: "https://drive.test"))
        try FileManager.default.removeItem(at: url)
        try theirs.put(other)
        #expect(rows.list().isEmpty)
        #expect(!FileManager.default.fileExists(atPath: url.path))
    }

    /* An abort a family manager's pause refused keeps its upload's id: the quiet settle never drops it, and the hold lifting does. */
    @Test func anAbortAPauseRefusedKeepsItsIdUntilTheHoldLifts() async throws {
        let rows = journal()
        let left = SaveRunRow(id: "r", workspaceId: "ws", nodeIds: [], uploadIds: ["up-a"], at: Date(), launch: "an-earlier-launch")
        try rows.put(left)
        let writer = FakeWriter()
        await writer.set(held: true)
        #expect(await SaveRuns.interrupted(writer: writer, journal: rows).isEmpty)
        await SaveRuns.quietlySettled()
        #expect(rows.list().first?.uploadIds == ["up-a"])
        await writer.set(held: false)
        _ = await SaveRuns.interrupted(writer: writer, journal: rows)
        await SaveRuns.quietlySettled()
        #expect(rows.list().isEmpty)
        #expect(DriveAPI.AbortFate.held.unsettled)
        #expect(!DriveAPI.AbortFate.denied.unsettled)
    }

    /*
     * Signed out before the clean-up asks anything: a version whose completion was sent and whose abort answered "not found"
     * may have landed (a share that ended answers 404 too), so it is said to maybe be saved; one the abort released is not.
     */
    @Test func aSignOutCountsAVersionWhoseSentCompletionAbortedAsNotFoundAsMaybeSaved() async throws {
        let writer = FakeWriter()
        let row = SaveRunRow(id: "r", workspaceId: "ws", nodeIds: [], uploadIds: ["up-gone", "up-aborted"], at: Date(), launch: "l")
        let both: Set<String> = ["up-gone", "up-aborted"]
        let cleaned = await SaveRuns.clean(row, writer: writer, journal: journal(), versions: both, completing: both, published: [],
                                           asked: ["up-gone": .gone, "up-aborted": .aborted], stillOn: { false })
        #expect(cleaned.cleanup == .left)
        #expect(cleaned.uncertain == 1)
        #expect(await writer.sent.isEmpty)
    }

    /* A pause that kept only a version's reservation keeps the row but never says what was made is still there. */
    @Test func aPauseThatKeptOnlyAVersionsReservationSaysNothingRemains() async throws {
        let writer = FakeWriter()
        let gate = AsyncGate()
        await writer.set(uploading: { await gate.wait() })
        let rows = journal()
        let doc = opened("doc", parent: "f", version: "v1")
        let run = try await SaveRun.start(writer: writer, targets: [doc], results: [], journal: rows)
        let saving = Task { try await run.version(Data([1]), of: doc, in: opened("f"), startedFrom: "v1", sources: own) }
        try await Task.sleep(for: .milliseconds(50))
        await writer.set(held: true)
        let stopped = await run.cancel()
        #expect(stopped.cleanup == .left)
        #expect(!stopped.message.contains("still there"))
        #expect(rows.list().first?.uploadIds.isEmpty == false)
        await gate.open()
        _ = try? await saving.value
    }

    /* An upload begun in another workspace than the run's is never recorded, and the run stops. */
    @Test func anUploadBegunInAnotherWorkspaceIsNeverRecorded() async throws {
        let rows = journal()
        let run = try await SaveRun.start(writer: FakeWriter(), targets: [opened("f")], results: [], journal: rows)
        let state = run.state
        #expect(throws: SaveRunRefusal(message: SaveRuns.destinationChanged)) {
            try state.begun(Vault.BegunIds(workspaceId: "ws-elsewhere", uploadId: "up-x", nodeId: "node-x"), tracked: true, version: false)
        }
        #expect(rows.list().first?.nodeIds == [])
        #expect(rows.list().first?.uploadIds == [])
        _ = await run.cancel()
    }

    /* A key change's re-listing that names another folder than the run's never becomes where results are saved. */
    @Test func aReListingNamingAnotherFolderNeverBecomesTheDestination() async throws {
        let writer = FakeWriter()
        await writer.folderAnswer { throw DriveAPIError.rotating("Finishing a key change…") }
        await writer.set(refreshedAs: opened("elsewhere"))
        let rows = journal()
        let run = try await SaveRun.start(writer: writer, targets: [opened("f")], results: [], journal: rows, pause: { _ in })
        let stopped = await #expect(throws: SaveRunStopped.self) { _ = try await run.folder("Out", sources: own) }
        #expect(stopped?.message.contains(SaveRuns.destinationChanged) == true)
        #expect(await !writer.live.contains("made-Out"))
    }

    /* A result asked into another Drive than the run's is refused before anything is listed, minted or sent. */
    @Test func aResultIntoAnotherDriveThanTheRunsIsRefusedBeforeAnythingIsSent() async throws {
        let writer = FakeWriter()
        let rows = journal()
        let run = try await SaveRun.start(writer: writer, targets: [opened("f")], results: [], journal: rows)
        let elsewhere = opened("b", workspace: "ws-other")
        await #expect(throws: SaveRunRefusal(message: SaveRuns.outsideRun)) {
            _ = try await run.file(Data([1]), name: "a", mime: nil, sources: own, in: elsewhere)
        }
        await #expect(throws: SaveRunRefusal(message: SaveRuns.outsideRun)) { _ = try await run.folder("Out", in: elsewhere, sources: own) }
        await #expect(throws: SaveRunRefusal(message: SaveRuns.outsideRun)) {
            _ = try await run.version(Data([1]), of: opened("doc", parent: "b", version: "v1", workspace: "ws-other"), in: elsewhere,
                                      startedFrom: "v1", sources: own)
        }
        #expect(await writer.uploads.isEmpty)
        #expect(await !writer.live.contains("made-Out"))
        #expect(rows.list().first?.nodeIds ?? [] == [])
        // The run itself goes on.
        _ = try await run.file(Data([1]), name: "b", mime: nil, sources: own)
        #expect(await writer.uploads.count == 1)
        _ = await run.cancel()
    }

    /* A completion naming another node than the one written stops the run, and that node is never deleted. */
    @Test func aCompletionNamingAnotherNodeStopsTheRunAndNeverDeletesIt() async throws {
        let writer = FakeWriter()
        await writer.makeLive("node-theirs")
        await writer.set(landedAs: "node-theirs")
        let rows = journal()
        let run = try await SaveRun.start(writer: writer, targets: [opened("f")], results: [], journal: rows)
        let stopped = await #expect(throws: SaveRunStopped.self) { _ = try await run.file(Data([1]), name: "a", mime: nil, sources: own) }
        #expect(stopped?.reason == .failed)
        #expect(await !writer.purged.contains("node-theirs"))
        #expect(await !writer.trashed.contains("node-theirs"))
        // What this run minted is what its clean-up removed.
        #expect(await writer.purged.contains("node-1"))
    }

    @Test func aCancelDeletesForeverWhatWasPublishedAndTheRowGoes() async throws {
        let writer = FakeWriter()
        let rows = journal()
        let run = try await SaveRun.start(writer: writer, targets: [opened("f")], results: [], journal: rows)
        _ = try await run.file(Data([1]), name: "a", mime: nil, sources: own)
        #expect(rows.list().first?.nodeIds == ["node-1"])
        let stopped = await run.cancel()
        #expect(stopped.cleanup == .deleted)
        #expect(stopped.message == SaveRuns.cancelled)
        #expect(await writer.purged == ["node-1"])
        #expect(rows.list().isEmpty)
        await #expect(throws: SaveRunStopped.self) { _ = try await run.file(Data([1]), name: "b", mime: nil, sources: own) }
    }

    @Test func concurrentCancelsShareOneOutcomeNeverAPlaceholder() async throws {
        let writer = FakeWriter()
        let run = try await SaveRun.start(writer: writer, targets: [opened("f")], results: [], journal: journal())
        _ = try await run.file(Data([1]), name: "a", mime: nil, sources: own)
        async let first = run.cancel()
        async let second = run.cancel()
        let (a, b) = await (first, second)
        #expect(a.cleanup == .deleted)
        #expect(b.cleanup == .deleted)
    }

    @Test func aResultHandedInWhileTheFolderWasListedAndTheRunStoppedNeverUploads() async throws {
        let writer = FakeWriter()
        let gate = AsyncGate()
        await writer.set(listing: { await gate.wait() })
        let run = try await SaveRun.start(writer: writer, targets: [opened("f")], results: [], journal: journal())
        let late = Task { try await run.file(Data([1]), name: "late", mime: nil, sources: own) }
        try await Task.sleep(for: .milliseconds(50))
        _ = await run.cancel()
        await gate.open()
        await #expect(throws: SaveRunStopped.self) { _ = try await late.value }
        #expect(await writer.uploads.isEmpty)
    }

    @Test func aNoRoomInSomeoneElsesShareStopsTheRunUnfiguredAndOnlyTrashes() async throws {
        let writer = FakeWriter(room: .shared)
        await writer.set(member: false)
        await writer.answer { _ in }
        await writer.answer { _ in throw DriveAPIError.server(402, "There isn’t enough room. 12 MB free.") }
        let rows = journal()
        let run = try await SaveRun.start(writer: writer, targets: [opened("shared")], results: [.known(size: 1 << 50, thumbnail: true)], journal: rows)
        _ = try await run.file(Data([1]), name: "a", mime: nil, sources: own)
        do {
            _ = try await run.file(Data([1]), name: "b", mime: nil, sources: own)
            Issue.record("a 402 went unnoticed")
        } catch let stopped as SaveRunStopped {
            #expect(stopped.reason == .noRoom)
            #expect(stopped.message == SaveRuns.noRoomShared)
            #expect(!stopped.message.contains("12 MB"))
            #expect(stopped.cleanup == .trashed)
        }
        // node-2 never landed (the trash finds nothing there); node-1 did, and goes to the owner's Trash only.
        #expect(await writer.trashed == ["node-1"])
        #expect(await writer.purged.isEmpty)
        #expect(await writer.aborted.contains("up-2"))
        #expect(rows.list().isEmpty)
    }

    @Test func unknownFiguresInThePersonsOwnSpaceNeverSaySharedFolder() async throws {
        let writer = FakeWriter(room: .own(nil))
        await writer.answer { _ in throw DriveAPIError.server(402, "No room") }
        let run = try await SaveRun.start(writer: writer, targets: [opened("f")], results: [], journal: journal())
        do {
            _ = try await run.file(Data([1]), name: "a", mime: nil, sources: own)
        } catch let stopped as SaveRunStopped {
            #expect(stopped.message == SaveRuns.noRoom)
        }
    }

    @Test func aFolderTheRunMadeGoesAsOne() async throws {
        let writer = FakeWriter()
        let rows = journal()
        let run = try await SaveRun.start(writer: writer, targets: [opened("f")], results: [], journal: rows)
        let made = try await run.folder("Archive", sources: own)
        _ = try await run.file(Data([1]), name: "inside.txt", mime: nil, sources: own, in: made)
        #expect(rows.list().first?.nodeIds == [made.id])
        _ = await run.cancel()
        #expect(await writer.purged == [made.id])
    }

    @Test func aKeyChangeStillWalkingTheFolderIsWaitedOutNotFailed() async throws {
        let writer = FakeWriter()
        await writer.answer { _ in throw DriveAPIError.rotating("Finishing a key change…") }
        let run = try await SaveRun.start(writer: writer, targets: [opened("fam")], results: [], journal: journal(), pause: { _ in })
        let landed = try await run.file(Data([1]), name: "a", mime: nil, sources: own)
        #expect(landed.id == "node-2")
        #expect(await writer.uploads.count == 2)
    }

    @Test func perItemRefusalsABusyPurgeOrNoAnswerKeepTheRow() async throws {
        for breakIt in [{ (w: FakeWriter) async in await w.refuse("node-1") }, { w in await w.busy("node-1") }, { w in await w.set(offline: true) }] {
            let writer = FakeWriter()
            let rows = journal()
            let run = try await SaveRun.start(writer: writer, targets: [opened("f")], results: [], journal: rows)
            _ = try await run.file(Data([1]), name: "a", mime: nil, sources: own)
            await breakIt(writer)
            #expect(await run.cancel().cleanup == .left)
            #expect(rows.list().map(\.nodeIds) == [["node-1"]])
        }
    }

    /* A row another launch left with nothing made is never offered: its uploads are aborted and it goes. */
    @Test func aRowWithNothingMadeIsNeverOfferedAndGoes() async throws {
        let writer = FakeWriter()
        let rows = journal()
        try rows.put(SaveRunRow(id: "versions", workspaceId: "ws", nodeIds: [], uploadIds: ["up-x"], at: Date(), launch: "an-earlier-launch"))
        try rows.put(SaveRunRow(id: "empty", workspaceId: "ws", nodeIds: [], uploadIds: [], at: Date(), launch: "an-earlier-launch"))
        try rows.put(SaveRunRow(id: "made", workspaceId: "ws", nodeIds: ["node-x"], uploadIds: [], at: Date(), launch: "an-earlier-launch"))
        #expect(await SaveRuns.interrupted(writer: writer, journal: rows).map(\.id) == ["made"])
        await SaveRuns.quietlySettled()
        #expect(await writer.aborted == ["up-x"])
        #expect(rows.list().map(\.id) == ["made"])
    }

    @Test func theNextLaunchFindsAnInterruptedRunDeletesOrKeepsWhatItMadeAndDropsOneItCanNoLongerReach() async throws {
        let rows = journal()
        let writer = FakeWriter()
        let run = try await SaveRun.start(writer: writer, targets: [opened("f")], results: [], journal: rows)
        // This launch's own row is not interrupted; another launch's is.
        #expect(await SaveRuns.interrupted(writer: writer, journal: rows).isEmpty)
        let other = SaveRunRow(id: "other", workspaceId: "ws", nodeIds: ["node-x"], uploadIds: ["up-x"], at: Date(), launch: "an-earlier-launch")
        try rows.put(other)
        #expect(await SaveRuns.interrupted(writer: writer, journal: rows).map(\.id) == ["other"])
        await writer.set(offline: true)
        #expect(await SaveRuns.cleanUp(other, writer: writer, journal: rows) == .left)
        #expect(rows.list().contains { $0.id == "other" })
        // Keep with no answer (offline, an older server): kept all the same (a done mark, never offered); the server lets an
        // open upload expire.
        #expect(try await SaveRuns.keep(other, writer: writer, journal: rows) == .kept)
        #expect(!rows.list().contains { $0.id == "other" && $0.done != true })
        #expect(!(await SaveRuns.interrupted(writer: writer, journal: rows)).contains { $0.id == "other" })
        await writer.set(offline: false)
        try rows.put(other)
        await writer.set(denied: true)
        #expect(await SaveRuns.cleanUp(other, writer: writer, journal: rows) == .noAccess)
        #expect(!rows.list().contains { $0.id == "other" })
        await writer.set(denied: false)
        try rows.put(other)
        #expect(try await SaveRuns.keep(other, writer: writer, journal: rows) == .kept)
        #expect(await writer.aborted == ["up-x"])
        #expect(!rows.list().contains { $0.id == "other" && $0.done != true })
        _ = await run.cancel()
    }

    @Test func aSignOutEndsTheJournalNothingIsWrittenAfter() async throws {
        let session = SaveRunJournal.Epoch()
        let rows = journal(session)
        let writer = FakeWriter()
        let run = try await SaveRun.start(writer: writer, targets: [opened("f")], results: [], journal: rows)
        let file = rows.url
        // What AccountStore.wipe does through SaveRunJournal.endAccount(), on this journal's own session.
        session.end()
        try? FileManager.default.removeItem(at: file)
        // A result handed in after the account was wiped, the sign-out not having reached the run: refused,
        // nothing uploaded, no row written back.
        do {
            _ = try await run.file(Data([1]), name: "a", mime: nil, sources: own)
            Issue.record("a result went up after the account's session ended")
        } catch let stopped as SaveRunStopped {
            #expect(stopped.reason == .signedOut)
        }
        await #expect(throws: SaveRunStopped.self) { _ = try await run.folder("Out", sources: own) }
        #expect(await writer.uploads.isEmpty)
        #expect(!FileManager.default.fileExists(atPath: file.path))
        // The real sign-out ends every journal on the account's session.
        let accountJournal = journal(SaveRunJournal.account)
        SaveRunJournal.endAccount()
        #expect(!accountJournal.live)
    }

    @Test func aNewFileRefusedForAKeyChangeIsSealedAgainUnderTheFolderAsTheServerHoldsItNow() async throws {
        let writer = FakeWriter()
        await writer.answer { _ in throw SaveRekeyed() }
        let run = try await SaveRun.start(writer: writer, targets: [opened("f")], results: [], journal: journal(), pause: { _ in })
        _ = try await run.file(Data([1]), name: "a", mime: nil, sources: own)
        // Sealed first under the folder as held, then under the folder looked up again.
        #expect(await writer.folderEpochs == [1, 2])
        #expect(await writer.refreshes == 1)
    }

    @Test func aResultFolderWaitsOutAKeyChangeAsItsUploadsDo() async throws {
        let writer = FakeWriter()
        await writer.folderAnswer { throw DriveAPIError.rotating("Finishing a key change…") }
        let run = try await SaveRun.start(writer: writer, targets: [opened("fam")], results: [], journal: journal(), pause: { _ in })
        let made = try await run.folder("Archive", sources: own)
        #expect(made.id == "made-Archive")
        #expect(await writer.folderEpochs == [1, 2])
    }

    @Test func aLateFolderThatCannotBeRemovedIsAddedToTheRowAFailedCleanUpKept() async throws {
        let writer = FakeWriter()
        let rows = journal()
        let run = try await SaveRun.start(writer: writer, targets: [opened("f")], results: [], journal: rows)
        _ = try await run.file(Data([1]), name: "a", mime: nil, sources: own)
        let gate = AsyncGate()
        await writer.set(making: { await gate.wait() })
        let making = Task { try await run.folder("Archive", sources: own) }
        try await Task.sleep(for: .milliseconds(50))
        // The stop's clean-up fails for the file it made and for the folder, whose creation it waits for.
        await writer.refuse("node-1")
        await writer.refuse("made-Archive")
        let cancelling = Task { await run.cancel() }
        try await Task.sleep(for: .milliseconds(50))
        await gate.open()
        #expect(await cancelling.value.cleanup == .left)
        _ = try? await making.value
        #expect(rows.list().map(\.nodeIds) == [["node-1", "made-Archive"]])
    }

    @Test func aSignOutAbandonsLiveRunsAndOneThatLandsAfterDeletesNothing() async throws {
        let writer = FakeWriter()
        let gate = AsyncGate()
        await writer.set(landing: { await gate.wait() })
        let session = SaveRunJournal.Epoch()
        let run = try await SaveRun.start(writer: writer, targets: [opened("f")], results: [], journal: journal(session))
        let saving = Task { try await run.file(Data([1]), name: "a", mime: nil, sources: own) }
        try await Task.sleep(for: .milliseconds(50))
        // What AccountStore.wipe does through SaveRuns.abandonAll(), on this run's own session.
        SaveRuns.abandonAll(session)
        await gate.open()
        do {
            _ = try await saving.value
            Issue.record("a result went on after a sign-out")
        } catch let stopped as SaveRunStopped {
            #expect(stopped.reason == .signedOut)
        }
        #expect(await writer.trashed.isEmpty)
        #expect(await writer.aborted.isEmpty)
    }

    /* The server still completing a version when the abort's tries ran out: it may land, so nothing says it didn't. */
    @Test func aCompletionSlowerThanTheAbortsTriesKeepsTheRowAndSaysTheVersionMayHaveBeenSaved() async throws {
        let writer = FakeWriter()
        let gate = AsyncGate()
        await writer.set(landing: { await gate.wait() })
        await writer.completing("up-1")
        let rows = journal()
        let doc = opened("doc", parent: "f", version: "v1")
        let run = try await SaveRun.start(writer: writer, targets: [doc], results: [], journal: rows)
        let saving = Task { try await run.version(Data([1]), of: doc, in: opened("f"), startedFrom: "v1", sources: own) }
        try await Task.sleep(for: .milliseconds(50))
        let stopped = await run.cancel()
        #expect(stopped.cleanup == .left)
        #expect(stopped.keptVersions == 0)
        #expect(stopped.uncertainVersions == 1)
        #expect(stopped.message == "Cancelled. A new version may have been saved. Nothing else was saved.")
        #expect(rows.list().map(\.uploadIds) == [["up-1"]])
        await gate.open()
        _ = try? await saving.value
    }

    /* A disk that won't take the row: the run never starts, or stops before anything is sent; one refusal is written again. */
    @Test func aRowTheDiskRefusesStopsTheRunBeforeAnythingIsSentAndOneRefusalIsWrittenAgain() async throws {
        struct Full: Error {}
        let refusing = journal()
        refusing.fault = { _ in throw Full() }
        do {
            _ = try await SaveRun.start(writer: FakeWriter(), targets: [opened("f")], results: [], journal: refusing)
            Issue.record("started without a row")
        } catch let stopped as SaveRunStopped {
            #expect(stopped.message == SaveRuns.unrecorded)
        }

        let writer = FakeWriter()
        let rows = journal()
        let run = try await SaveRun.start(writer: writer, targets: [opened("f")], results: [], journal: rows)
        rows.fault = { _ in throw Full() }
        do {
            _ = try await run.file(Data([1]), name: "a", mime: nil, sources: own)
            Issue.record("a result went up that no row names")
        } catch let stopped as SaveRunStopped {
            #expect(stopped.reason == .failed)
            #expect(stopped.message.contains("couldn’t keep a record"))
        }
        // Begun, then refused before a part was sent: never landed, its reservation aborted.
        #expect(await writer.live.isEmpty)
        #expect(await writer.aborted.contains("up-1"))

        // One refused write (a moment's failure) is written once more: the run goes on.
        let once = journal()
        let flaky = try await SaveRun.start(writer: FakeWriter(), targets: [opened("f")], results: [], journal: once)
        let refusals = Locked(1)
        once.fault = { _ in
            if refusals.value > 0 {
                refusals.value -= 1
                throw Full()
            }
        }
        _ = try await flaky.file(Data([1]), name: "a", mime: nil, sources: own)
        #expect(once.list().first?.nodeIds == ["node-1"])
        try await flaky.finish()
    }

    /*
     * A begin still on its way at the cancel: when it answers, the stopped run refuses it, so nothing is sent and the
     * reservation is aborted (never a file completed that no row names). Fails if a sealed run lets a late begin go on.
     */
    @Test func aBeginAnsweredAfterTheRunStoppedIsAbortedNeverCompleted() async throws {
        let writer = FakeWriter()
        let gate = AsyncGate()
        await writer.set(beginning: { await gate.wait() })
        let rows = journal()
        let run = try await SaveRun.start(writer: writer, targets: [opened("f")], results: [], journal: rows)
        let saving = Task { try await run.file(Data([1]), name: "a", mime: nil, sources: own) }
        try await Task.sleep(for: .milliseconds(50))
        let stopped = await run.cancel()
        #expect(stopped.cleanup == .nothing)
        await gate.open()
        _ = try? await saving.value
        #expect(await writer.live.isEmpty)
        #expect(await writer.partsSent == 0)
        #expect(await writer.aborted == ["up-1"])
        #expect(rows.list().isEmpty)
    }

    /* A completion about to go out after the run stopped is refused: the upload is aborted, nothing lands. */
    @Test func aCompletionAfterTheRunStoppedIsNeverSent() async throws {
        let writer = FakeWriter()
        let gate = AsyncGate()
        await writer.set(uploading: { await gate.wait() })
        let rows = journal()
        let doc = opened("doc", parent: "f", version: "v1")
        let run = try await SaveRun.start(writer: writer, targets: [doc], results: [], journal: rows)
        let saving = Task { try await run.version(Data([1]), of: doc, in: opened("f"), startedFrom: "v1", sources: own) }
        try await Task.sleep(for: .milliseconds(50))
        let stopped = await run.cancel()
        #expect(stopped.message == SaveRuns.cancelled)
        await gate.open()
        _ = try? await saving.value
        // Aborted by the stop and again by the refused completion: never finished.
        #expect(await writer.finished.isEmpty)
    }

    /* A finish whose record the disk won't update says so, takes nothing more, and can be asked again; Keep the same. */
    @Test func aFinishWhoseRecordWontUpdateSaysSoAndCanBeAskedAgain() async throws {
        struct Full: Error {}
        let writer = FakeWriter()
        let rows = journal()
        let run = try await SaveRun.start(writer: writer, targets: [opened("f")], results: [], journal: rows)
        _ = try await run.file(Data([1]), name: "a", mime: nil, sources: own)
        rows.fault = { _ in throw Full() }
        await #expect(throws: SaveRecordNotUpdated.self) { try await run.finish() }
        await #expect(throws: SaveRunRefusal.self) { _ = try await run.file(Data([1]), name: "b", mime: nil, sources: own) }
        rows.fault = nil
        try await run.finish()
        #expect(rows.list().isEmpty)
        let other = SaveRunRow(id: "other", workspaceId: "ws", nodeIds: [], uploadIds: [], at: Date(), launch: "an-earlier-launch")
        try rows.put(other)
        rows.fault = { _ in throw Full() }
        await #expect(throws: SaveRecordNotUpdated.self) { try await SaveRuns.keep(other, writer: writer, journal: rows) }
        rows.fault = nil
        #expect(rows.list().map(\.id) == ["other"])
    }

    /* What a stop says comes from what was sent: a sign-out after a completion, a cancel after finish, a denied abort. */
    @Test func whatAStopSaysComesFromWhatWasSent() async throws {
        // Signed out with a file's completion on its way: it may still be there.
        let writer = FakeWriter()
        let gate = AsyncGate()
        let completing = AsyncGate()
        await writer.set(landing: { await completing.open(); await gate.wait() })
        let session = SaveRunJournal.Epoch()
        let run = try await SaveRun.start(writer: writer, targets: [opened("f")], results: [], journal: journal(session))
        let saving = Task { try await run.file(Data([1]), name: "a", mime: nil, sources: own) }
        // Once its completion was sent (the fake is landing it), not after a guessed pause.
        await completing.wait()
        SaveRuns.abandonAll(session)
        await gate.open()
        do {
            _ = try await saving.value
            Issue.record("went on after a sign-out")
        } catch let stopped as SaveRunStopped {
            #expect(stopped.message == "You signed out before this was saved. Some of what was made may still be there.")
        }
        // A cancel after finish: it was saved.
        let done = try await SaveRun.start(writer: FakeWriter(), targets: [opened("f")], results: [], journal: journal())
        _ = try await done.file(Data([1]), name: "a", mime: nil, sources: own)
        try await done.finish()
        #expect(await done.cancel().message == SaveRuns.alreadySaved)
        // A version's abort refused as no longer theirs, once its completion was sent: it may have landed.
        let denied = FakeWriter()
        let held = AsyncGate()
        await denied.set(landing: { await held.wait() })
        let doc = opened("doc", parent: "f", version: "v1")
        let versions = try await SaveRun.start(writer: denied, targets: [doc], results: [], journal: journal())
        let saved = Task { try await versions.version(Data([1]), of: doc, in: opened("f"), startedFrom: "v1", sources: own) }
        try await Task.sleep(for: .milliseconds(50))
        await denied.set(denied: true)
        let stopped = await versions.cancel()
        #expect(stopped.uncertainVersions == 1)
        await held.open()
        _ = try? await saved.value
        // A listing that fails says why.
        let listing = FakeWriter()
        await listing.set(namesFail: true)
        let failing = try await SaveRun.start(writer: listing, targets: [opened("f")], results: [], journal: journal())
        do {
            _ = try await failing.file(Data([1]), name: "a", mime: nil, sources: own)
        } catch let stopped as SaveRunStopped {
            #expect(stopped.message.hasPrefix(DriveAPIError.transport("The network connection was lost.").localizedDescription.trimmingCharacters(in: .whitespaces)))
        }
    }

    /* A raw failure's own text (a path, a framework's words) is never what a stopped run says; the app's words are. */
    @Test func aRawFailureIsNeverSaidInItsOwnWords() async throws {
        struct Raw: LocalizedError {
            var errorDescription: String? { "The file “/private/var/mobile/Containers/Data/x.json” couldn’t be opened." }
        }
        let writer = FakeWriter()
        await writer.folderAnswer { throw Raw() }
        let run = try await SaveRun.start(writer: writer, targets: [opened("f")], results: [], journal: journal())
        let stopped = await #expect(throws: SaveRunStopped.self) { _ = try await run.folder("Out", sources: own) }
        #expect(stopped?.message.contains("/private") == false)
        #expect(stopped?.message == SaveRuns.words(.failed, shared: false, failure: nil, kept: 0))
        // Its words are read as the app's own (WordedError), never lost to a generic line.
        #expect(ErrorWords.say(stopped!) == stopped!.message)
        #expect(ErrorWords.say(SaveRunRefusal(message: SaveRuns.outsideRun)) == SaveRuns.outsideRun)
    }

    /* A cancel that overtakes a folder's creation waits for its answer: a folder made after the clean-up looked is still removed. */
    @Test func aCancelThatOvertakesAFoldersCreationWaitsForIt() async throws {
        let writer = FakeWriter()
        let gate = AsyncGate()
        await writer.set(making: { await gate.wait() })
        await writer.set(loseAnswer: true)
        let rows = journal()
        let run = try await SaveRun.start(writer: writer, targets: [opened("f")], results: [], journal: rows)
        let folder = Task { try await run.folder("Out", sources: own) }
        try await Task.sleep(for: .milliseconds(50))
        let cancel = Task { await run.cancel() }
        try await Task.sleep(for: .milliseconds(50))
        await gate.open()
        #expect(await cancel.value.cleanup == .deleted)
        _ = try? await folder.value
        #expect(await writer.purged == ["made-Out"])
        #expect(rows.list().isEmpty)
    }

    /* A sign-out while a stop waits for a folder's creation: nothing more is asked of the server, and it says what may stay. */
    @Test func aSignOutWhileAStopWaitsSendsNothingMoreAndSaysWhatMayStay() async throws {
        let writer = FakeWriter()
        let session = SaveRunJournal.Epoch()
        let rows = journal(session)
        let run = try await SaveRun.start(writer: writer, targets: [opened("f")], results: [], journal: rows)
        _ = try await run.file(Data([1]), name: "a", mime: nil, sources: own)
        let gate = AsyncGate()
        await writer.set(making: { await gate.wait() })
        let folder = Task { try await run.folder("Out", sources: own) }
        try await Task.sleep(for: .milliseconds(50))
        let cancel = Task { await run.cancel() }
        try await Task.sleep(for: .milliseconds(50))
        // Signed out while the stop waits for the creation to settle.
        session.end()
        await gate.open()
        let stopped = await cancel.value
        _ = try? await folder.value
        #expect(await writer.sent.filter { $0 == "trash" || $0 == "purge" }.isEmpty)
        #expect(await writer.purged.isEmpty)
        #expect(stopped.cleanup == .left)
        #expect(stopped.message.contains("may still be there"))
    }

    /*
     * A folder whose creation got no answer, made by the server after the clean-up looked: the row stays and says so,
     * and the next open removes it. One the server refused with its reason was never made, and the row goes.
     */
    @Test func aFolderWhoseCreationGotNoAnswerKeepsItsRowUntilTheNextOpenFindsIt() async throws {
        let writer = FakeWriter()
        await writer.set(createLater: true)
        let rows = journal()
        let run = try await SaveRun.start(writer: writer, targets: [opened("f")], results: [], journal: rows)
        var stopped: SaveRunStopped?
        do { _ = try await run.folder("Out", sources: own) } catch let error as SaveRunStopped { stopped = error }
        await writer.makeLater()
        #expect(stopped?.cleanup == .left)
        #expect(stopped?.message.contains("Nothing was saved") == false)
        #expect(stopped?.message.contains("You’ll be asked about it next time.") == true)
        let row = try #require(rows.list().first)
        #expect(row.nodeIds == ["made-Out"])
        #expect(await SaveRuns.cleanUp(row, writer: writer, journal: rows) == .deleted)
        #expect(await writer.purged == ["made-Out"])
        #expect(rows.list().isEmpty)

        // Its own id already taken (an earlier send of the same request made it): it may exist.
        let twice = FakeWriter()
        await twice.set(refuseCreation: .server(409, "An item with this id already exists."))
        let twiceRows = journal()
        let made = try await SaveRun.start(writer: twice, targets: [opened("f")], results: [], journal: twiceRows)
        var kept: SaveRunStopped?
        do { _ = try await made.folder("Out", sources: own) } catch let error as SaveRunStopped { kept = error }
        #expect(kept?.cleanup == .left)
        #expect(twiceRows.list().first?.nodeIds == ["made-Out"])

        let refused = FakeWriter()
        await refused.set(refuseCreation: .forbidden("You can’t change this."))
        let other = journal()
        let second = try await SaveRun.start(writer: refused, targets: [opened("f")], results: [], journal: other)
        var said: SaveRunStopped?
        do { _ = try await second.folder("Out", sources: own) } catch let error as SaveRunStopped { said = error }
        #expect(said?.cleanup == .nothing)
        #expect(said?.message.hasSuffix("Nothing was saved.") == true)
        #expect(other.list().isEmpty)
    }

    /*
     * The gap between a folder's id going on disk and its creation going out: once recordFolder (or sending) returns,
     * the creation is already counted, so a stop that seals right then still waits for its answer before it looks.
     */
    @Test func aFolderRecordedBeforeTheStopSealedIsWaitedForThoughNotYetSent() async throws {
        for recorded in [true, false] {
            let state = RunState(row: SaveRunRow(id: "run", workspaceId: "ws", nodeIds: [], uploadIds: [], at: Date(), launch: "now"), journal: journal())
            if recorded { try state.recordFolder("made") } else { try state.sending("inner") }
            _ = state.seal()
            let settled = Task { await state.creationsSettled() }
            try await Task.sleep(for: .milliseconds(100))
            let waitedEarly = Locked(false)
            let early = Task { await settled.value; waitedEarly.value = true }
            try await Task.sleep(for: .milliseconds(50))
            #expect(!waitedEarly.value, "a stop looked before the creation it sealed against was answered")
            state.creationEnded(recorded ? "made" : "inner", mayExist: false)
            await early.value
            #expect(waitedEarly.value)
        }
    }

    /* A stop waiting for a folder's answer aborts the run's uploads first: none sends a part after the stop began. */
    @Test func aStopWaitingForAFolderAbortsTheRunsUploadsFirst() async throws {
        let writer = FakeWriter()
        let gate = AsyncGate()
        let begun = AsyncGate()
        await writer.set(making: { await gate.wait() })
        await writer.set(parts: 200)
        await writer.set(beginning: { await begun.open() })
        let rows = journal()
        let run = try await SaveRun.start(writer: writer, targets: [opened("f")], results: [], journal: rows)
        let folder = Task { try await run.folder("Out", sources: own) }
        try await Task.sleep(for: .milliseconds(50))
        let saving = Task { try await run.file(Data([1]), name: "a", mime: nil, sources: own) }
        await begun.wait()
        try await Task.sleep(for: .milliseconds(50))
        await writer.startStop()
        let cancel = Task { await run.cancel() }
        // The stop waits for the folder; meanwhile the upload would go on sending parts.
        try await Task.sleep(for: .milliseconds(300))
        await gate.open()
        _ = await cancel.value
        _ = try? await folder.value
        _ = try? await saving.value
        // At most the one part already on its way when the stop began.
        let after = await writer.partsAfterStop
        #expect(after <= 1, "\(after) parts after the stop began")
        #expect(rows.list().isEmpty)
    }

    /*
     * With nobody signed in, a journal reads nothing and deletes nothing (the same account may sign back in); signed in
     * again, its rows are there.
     */
    @Test func withNobodySignedInTheJournalReadsAndDeletesNothing() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("save-runs-\(UUID().uuidString).json")
        let a = AccountOwner(userId: "a", origin: "https://drive.test")
        let now = SignedInBox(a)
        let journal = SaveRunJournal(url: url, epoch: SaveRunJournal.Epoch(), owner: a, signedIn: { .account(now.value) })
        try journal.put(SaveRunRow(id: "run-a", workspaceId: "ws-a", nodeIds: ["node-a"], uploadIds: [], at: Date(), launch: "an-earlier-launch"))
        now.value = nil
        #expect(journal.list().isEmpty)
        #expect(FileManager.default.fileExists(atPath: url.path))
        let nobody = SaveRunJournal(url: url, epoch: SaveRunJournal.Epoch(), owner: nil, signedIn: { .account(nil) })
        #expect(nobody.list().isEmpty)
        #expect(FileManager.default.fileExists(atPath: url.path))
        now.value = a
        #expect(journal.list().map(\.id) == ["run-a"])
    }

    /*
     * Two accounts' journals in one process (A's run still open when B signs in): A's journal neither writes over nor
     * deletes B's rows, and its run is told its row couldn't be written.
     */
    @Test func aJournalWhoseAccountIsNoLongerSignedInNeverTouchesTheNextOnesRows() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("save-runs-\(UUID().uuidString).json")
        let a = AccountOwner(userId: "a", origin: "https://drive.test")
        let b = AccountOwner(userId: "b", origin: "https://drive.test")
        let now = SignedInBox(a)
        let journalA = SaveRunJournal(url: url, epoch: SaveRunJournal.Epoch(), owner: a, signedIn: { .account(now.value) })
        let rowA = SaveRunRow(id: "run-a", workspaceId: "ws-a", nodeIds: ["node-a"], uploadIds: [], at: Date(), launch: "an-earlier-launch")
        try journalA.put(rowA)
        now.value = b
        let journalB = SaveRunJournal(url: url, epoch: SaveRunJournal.Epoch(), owner: b, signedIn: { .account(now.value) })
        let rowB = SaveRunRow(id: "run-b", workspaceId: "ws-b", nodeIds: ["node-b"], uploadIds: [], at: Date(), launch: "an-earlier-launch")
        try journalB.put(rowB)
        #expect(throws: SaveUnrecorded.self) { try journalA.put(rowA) }
        #expect(!journalA.retire(rowA))
        journalA.dropDone()
        #expect(journalA.list().isEmpty)
        #expect(journalB.list().map(\.id) == ["run-b"])
    }

    /*
     * A folder whose creation was on its way when the app ended: the row says so, the next open doesn't find it and
     * keeps the row, the folder then appears and the open after removes it. Past the creation window, one still not
     * there was never made.
     */
    @Test func aFolderOnItsWayWhenTheAppEndedKeepsItsRowUntilItAppearsThenGoes() async throws {
        let writer = FakeWriter()
        let gate = AsyncGate()
        await writer.set(making: { await gate.wait() })
        await writer.set(createLater: true)
        let rows = journal()
        let start = Date(timeIntervalSince1970: 1_000)
        let run = try await SaveRun.start(writer: writer, targets: [opened("f")], results: [], journal: rows, now: { start })
        let making = Task { try await run.folder("Out", sources: own) }
        try await Task.sleep(for: .milliseconds(50))
        // The app ends here: the row on disk is all the next open has.
        let row = try #require(rows.list().first)
        #expect(row.uncertain == ["made-Out": start])
        // The next open: the person says delete; not found, the row stays with that answer.
        let later = journal()
        try later.put(row)
        #expect(await SaveRuns.interrupted(writer: writer, journal: later, now: start.addingTimeInterval(60), launch: "a-later-launch").map(\.id) == [row.id])
        #expect(await SaveRuns.cleanUp(row, writer: writer, journal: later, now: start.addingTimeInterval(60)) == .left)
        #expect(later.list().first?.chosen == "delete")
        // Later opens never ask again while the folder isn't there: they only look for it.
        #expect(await SaveRuns.interrupted(writer: writer, journal: later, now: start.addingTimeInterval(90), launch: "a-later-launch").isEmpty)
        await SaveRuns.quietlySettled()
        #expect(later.list().count == 1)
        // It lands, and someone fills it: the next open deletes nothing unasked. The answer goes, and the open after
        // offers the row again with what the folder holds now.
        await writer.makeLive("made-Out")
        await writer.set(items: 2, in: "made-Out")
        #expect(await SaveRuns.interrupted(writer: writer, journal: later, now: start.addingTimeInterval(120), launch: "a-later-launch").isEmpty)
        await SaveRuns.quietlySettled()
        #expect(await writer.purged.isEmpty)
        #expect(await writer.trashed.isEmpty)
        let again = try #require(await SaveRuns.interrupted(writer: writer, journal: later, now: start.addingTimeInterval(150), launch: "a-later-launch").first)
        #expect(again.nodeIds == ["made-Out"] && again.holds == 2 && again.chosen == nil)
        // Not found once creationSettle has passed: never made, and the row goes quietly.
        await writer.makeGone("made-Out")
        var answered = again
        answered.chosen = "delete"
        try later.put(answered)
        #expect(await SaveRuns.interrupted(writer: writer, journal: later, now: start.addingTimeInterval(SaveRuns.creationSettle), launch: "a-later-launch").isEmpty)
        await SaveRuns.quietlySettled()
        #expect(later.list().isEmpty)
        await gate.open()
        _ = try? await making.value
    }

    /*
     * A new version someone else beat whose reservation the abort didn't release: its id stays in the row, finish
     * asks again and keeps a row of its own with no nodes, never offered, that the next open settles.
     */
    @Test func aStaleVersionWhoseReservationWasNotReleasedIsSettledLater() async throws {
        let writer = FakeWriter()
        await writer.answer { n in throw SaveStale(currentVersionId: "v-theirs", unreleased: "up-\(n)") }
        let rows = journal()
        let doc = opened("doc", parent: "f", version: "v1")
        let run = try await SaveRun.start(writer: writer, targets: [doc], results: [], journal: rows)
        let saved = try await run.version(Data([1]), of: doc, in: opened("f"), startedFrom: "v1", sources: own)
        #expect(saved == .stale(currentVersionId: "v-theirs"))
        #expect(rows.list().first?.uploadIds == ["up-1"])
        await writer.set(offline: true)
        try await run.finish()
        let left = try #require(rows.list().first)
        #expect(left.nodeIds.isEmpty && left.uploadIds == ["up-1"])
        await writer.set(offline: false)
        #expect(await SaveRuns.interrupted(writer: writer, journal: rows, launch: "a-later-launch").isEmpty)
        await SaveRuns.quietlySettled()
        #expect(await writer.aborted.contains("up-1"))
        #expect(rows.list().isEmpty)
    }

    /* The rows to offer come back at once: the quiet looks run after, in the background. */
    @Test func theRowsToOfferComeBackBeforeAnyQuietLook() async throws {
        let writer = FakeWriter()
        let gate = AsyncGate()
        await writer.set(looking: { await gate.wait() })
        let rows = journal()
        try rows.put(SaveRunRow(id: "asked", workspaceId: "ws", nodeIds: ["n"], uploadIds: [], at: Date(), launch: "an-earlier-launch"))
        try rows.put(SaveRunRow(id: "answered", workspaceId: "ws", nodeIds: ["slow"], uploadIds: [], at: Date(), launch: "an-earlier-launch",
                                uncertain: ["slow": Date()], chosen: "delete"))
        // The look answers only two seconds from now: the listing is back long before.
        let opener = Task {
            try? await Task.sleep(for: .seconds(2))
            await gate.open()
        }
        let began = Date()
        #expect(await SaveRuns.interrupted(writer: writer, journal: rows).map(\.id) == ["asked"])
        #expect(Date().timeIntervalSince(began) < 1, "interrupted waited for a look")
        await opener.value
        await SaveRuns.quietlySettled()
    }

    /*
     * finish is refused while a result is still being prepared (its folder being listed), never a success; once finished,
     * a stop removes nothing and new work is refused.
     */
    @Test func finishIsRefusedWhileAResultIsBeingPreparedAndOnceFinishedNothingIsRemoved() async throws {
        let writer = FakeWriter()
        let rows = journal()
        let run = try await SaveRun.start(writer: writer, targets: [opened("f")], results: [], journal: rows)
        _ = try await run.file(Data([1]), name: "a", mime: nil, sources: own)
        let gate = AsyncGate()
        await writer.set(listing: { await gate.wait() })
        await writer.set(namesFail: true)
        let next = Task { try await run.file(Data([2]), name: "b", mime: nil, sources: own, in: opened("g")) }
        try await Task.sleep(for: .milliseconds(50))
        await #expect(throws: RunBusy.self) { try await run.finish() }
        // The listing fails: the run was never finished, so it stops all or nothing.
        await gate.open()
        await #expect(throws: SaveRunStopped.self) { _ = try await next.value }
        await #expect(throws: SaveRunStopped.self) { try await run.finish() }

        // Finished: a cancel after that removes nothing, and new work is refused.
        let other = FakeWriter()
        let done = try await SaveRun.start(writer: other, targets: [opened("f")], results: [], journal: journal())
        _ = try await done.file(Data([1]), name: "a", mime: nil, sources: own)
        try await done.finish()
        #expect(await done.cancel().message == SaveRuns.alreadySaved)
        #expect(await other.live.contains("node-1"))
        await #expect(throws: SaveRunRefusal.self) { _ = try await done.file(Data([2]), name: "b", mime: nil, sources: own) }
    }

    /* Two opens at once never settle one row twice: the second finds it changed and leaves it. */
    @Test func twoOpensLookForAnAnsweredRowOnce() async throws {
        let writer = FakeWriter()
        let looks = Locked(0)
        await writer.set(looking: { looks.value += 1 })
        await writer.makeLive("slow")
        let rows = journal()
        try rows.put(SaveRunRow(id: "answered", workspaceId: "ws", nodeIds: ["slow"], uploadIds: [], at: Date(), launch: "an-earlier-launch",
                                uncertain: ["slow": Date()], chosen: "delete"))
        _ = await SaveRuns.interrupted(writer: writer, journal: rows)
        _ = await SaveRuns.interrupted(writer: writer, journal: rows)
        await SaveRuns.quietlySettled()
        #expect(looks.value == 1)
        #expect(rows.list().first?.chosen == nil && rows.list().first?.holds == 0)
    }

    /* A family manager's pause (403 held) is not lost access: the row stays and says so; the open after the hold cleans up. */
    @Test func aHeldCleanUpKeepsTheRowAndALaterOpenCleansUp() async throws {
        let writer = FakeWriter()
        let rows = journal()
        let run = try await SaveRun.start(writer: writer, targets: [opened("f")], results: [], journal: rows)
        _ = try await run.file(Data([1]), name: "a", mime: nil, sources: own)
        await writer.set(held: true)
        let stopped = await run.cancel()
        #expect(stopped.cleanup == .left)
        #expect(stopped.message == "Cancelled. Changes are paused in this family, so what was made is still there. You’ll be asked about it next time.")
        #expect(await writer.live.contains("node-1"))
        let row = try #require(rows.list().first)
        #expect(await SaveRuns.cleanUp(row, writer: writer, journal: rows) == .left)
        #expect(rows.list().count == 1)
        await writer.set(held: false)
        #expect(await SaveRuns.cleanUp(row, writer: writer, journal: rows) == .deleted)
        #expect(await writer.purged == ["node-1"])
        #expect(rows.list().isEmpty)
    }

    /* A sign-out while an interrupted run's clean-up trashes: nothing more is sent, no delete forever. */
    @Test func aSignOutDuringAnInterruptedCleanUpSendsNoDeleteForever() async throws {
        let session = SaveRunJournal.Epoch()
        let rows = journal(session)
        let writer = FakeWriter()
        await writer.makeLive("node-x")
        await writer.set(afterTrash: { session.end() })
        let row = SaveRunRow(id: "left", workspaceId: "ws", nodeIds: ["node-x"], uploadIds: [], at: Date(), launch: "an-earlier-launch")
        try rows.put(row)
        #expect(await SaveRuns.cleanUp(row, writer: writer, journal: rows) == .left)
        #expect(await writer.sent == ["trash"])
        #expect(await writer.purged.isEmpty)
    }

    /* Keep on one screen, then Delete from another screen's older read: nothing is trashed or purged, and it says kept. */
    @Test func aDeleteFromAReadBeforeAKeepSendsNothingAndSaysKept() async throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("save-runs-\(UUID().uuidString).json")
        let session = SaveRunJournal.Epoch()
        let first = SaveRunJournal(url: url, epoch: session)
        let second = SaveRunJournal(url: url, epoch: session)
        let made = SaveRunRow(id: "made", workspaceId: "ws", nodeIds: ["node-x"], uploadIds: [], at: Date(), launch: "an-earlier-launch")
        try first.put(made)
        let writer = FakeWriter()
        await writer.makeLive("node-x")
        let stale = try #require(await SaveRuns.interrupted(writer: writer, journal: second).first)
        #expect(try await SaveRuns.keep(made, writer: writer, journal: first) == .kept)
        #expect(await SaveRuns.cleanUp(stale, writer: writer, journal: second) == .kept)
        #expect(await writer.sent.isEmpty)
        // Asked again: still kept, nothing more sent.
        #expect(try await SaveRuns.keep(stale, writer: writer, journal: second) == .kept)
        #expect(await writer.sent.isEmpty)
    }

    /* Keep while another screen's Delete is under way waits for it, and never says kept of what went. */
    @Test func aKeepWhileADeleteIsUnderWayWaitsAndNeverSaysKeptOfWhatWent() async throws {
        let rows = journal()
        let made = SaveRunRow(id: "made", workspaceId: "ws", nodeIds: ["node-x"], uploadIds: [], at: Date(), launch: "an-earlier-launch")
        try rows.put(made)
        let writer = FakeWriter()
        await writer.makeLive("node-x")
        let gate = AsyncGate()
        let reached = Locked(false)
        await writer.set(trashing: {
            reached.value = true
            await gate.wait()
        })
        let deleting = Task { await SaveRuns.cleanUp(made, writer: writer, journal: rows) }
        while !reached.value { try await Task.sleep(for: .milliseconds(2)) }
        let keepDone = Locked(false)
        let keeping = Task {
            let kept = try await SaveRuns.keep(made, writer: writer, journal: rows)
            keepDone.value = true
            return kept
        }
        // Held behind the Delete's turn while its trash request is on its way.
        try await Task.sleep(for: .milliseconds(200))
        #expect(!keepDone.value)
        await gate.open()
        #expect(await deleting.value == .deleted)
        #expect(try await keeping.value == .gone)
        #expect(rows.list().isEmpty)
    }

    /* A Keep that comes between a quiet look and its write is never undone: compared and written in one hold of the lock. */
    @Test func aKeepBetweenAQuietLookAndItsWriteIsNeverUndone() async throws {
        let rows = journal()
        let answered = SaveRunRow(id: "answered", workspaceId: "ws", nodeIds: ["slow"], uploadIds: [], at: Date(), launch: "an-earlier-launch",
                                  uncertain: ["slow": Date()], chosen: "delete")
        try rows.put(answered)
        let writer = FakeWriter()
        await writer.makeLive("slow")
        await writer.set(items: 2, in: "slow")
        // The person's Keep lands on the journal's next access after the look, between any read and the write after it.
        let armed = Locked(false)
        rows.between = {
            guard armed.value else { return }
            armed.value = false
            // Keep: its row goes (its uploads, none here, asked to abort first).
            rows.retire(answered)
        }
        await writer.set(looking: { armed.value = true })
        _ = await SaveRuns.interrupted(writer: writer, journal: rows)
        await SaveRuns.quietlySettled()
        rows.between = nil
        #expect(rows.list().isEmpty)
    }

    /* finish waits for a folder still being made: the row stays until its creation settles. */
    @Test func finishWaitsForAFolderStillBeingMade() async throws {
        let writer = FakeWriter()
        let gate = AsyncGate()
        await writer.set(making: { await gate.wait() })
        let rows = journal()
        let run = try await SaveRun.start(writer: writer, targets: [opened("f")], results: [], journal: rows)
        let making = Task { try await run.folder("Out", sources: own) }
        try await Task.sleep(for: .milliseconds(50))
        await #expect(throws: RunBusy.self) { try await run.finish() }
        #expect(rows.list().first?.nodeIds == ["made-Out"])
        await gate.open()
        _ = try await making.value
        try await run.finish()
        #expect(rows.list().isEmpty)
    }

    /* A folder inside one the run made, answered 409 for its own id, is found too: the run goes on. */
    @Test func aNestedCreationAnswered409ForItsOwnIdIsFoundToo() async throws {
        let writer = FakeWriter()
        let rows = journal()
        let run = try await SaveRun.start(writer: writer, targets: [opened("f")], results: [], journal: rows)
        let out = try await run.folder("Out", sources: own)
        await writer.set(refuseCreation: .server(409, "An item with this id already exists."))
        await writer.set(making: { await writer.makeLive("made-In") })
        let inner = try await run.folder("In", in: out, sources: own)
        #expect(inner.id == "made-In")
        try await run.finish()
        #expect(rows.list().isEmpty)
    }

    /* A 409 for its own id found as another workspace's row is not the folder minted here: never answered with it. */
    @Test func aCreationAnswered409FoundInAnotherWorkspaceIsNotTheFolderMinted() async throws {
        let writer = FakeWriter()
        let rows = journal()
        let run = try await SaveRun.start(writer: writer, targets: [opened("f")], results: [], journal: rows)
        await writer.set(refuseCreation: .server(409, "An item with this id already exists."))
        await writer.set(making: { await writer.makeLive("made-Out") })
        await writer.set(listedWorkspace: "ws-other")
        let stopped = await #expect(throws: SaveRunStopped.self) { _ = try await run.folder("Out", sources: own) }
        #expect(stopped?.reason == .failed)
    }

    /* A key change's pause cut short (the task cancelled) stops the run and removes what it made, as any failure does. */
    @Test func aPauseCutShortStopsTheRunAndCleansUp() async throws {
        let writer = FakeWriter()
        await writer.answer { _ in throw DriveAPIError.rotating("Finishing a key change…") }
        let rows = journal()
        let run = try await SaveRun.start(writer: writer, targets: [opened("fam")], results: [], journal: rows, pause: { _ in throw CancellationError() })
        _ = try await run.folder("Out", sources: own)
        do {
            _ = try await run.file(Data([1]), name: "a", mime: nil, sources: own)
            Issue.record("the run went on after its pause was cut short")
        } catch let stopped as SaveRunStopped {
            #expect(stopped.reason == .failed)
        }
        #expect(await writer.purged == ["made-Out"])
        #expect(rows.list().isEmpty)
    }

    /* A folder creation answered 409 for its own id that is there is the folder: the run goes on. */
    @Test func aCreationAnswered409ForItsOwnIdThatIsThereIsTheFolder() async throws {
        let writer = FakeWriter()
        await writer.set(refuseCreation: .server(409, "An item with this id already exists."))
        await writer.set(making: { await writer.makeLive("made-Out") })
        let rows = journal()
        let run = try await SaveRun.start(writer: writer, targets: [opened("f")], results: [], journal: rows)
        let out = try await run.folder("Out", sources: own)
        #expect(out.id == "made-Out")
        try await run.finish()
        #expect(await writer.live.contains("made-Out"))
        #expect(rows.list().isEmpty)
    }

    /* A keychain read that failed is no sign-out: the journal of the account opened signed in still reads and writes. */
    @Test func aKeychainReadThatFailedIsNotASignOut() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("save-runs-\(UUID().uuidString).json")
        let a = AccountOwner(userId: "a", origin: "https://drive.test")
        let journal = SaveRunJournal(url: url, epoch: SaveRunJournal.Epoch(), owner: a, signedIn: { .unreadable })
        try journal.put(SaveRunRow(id: "run-a", workspaceId: "ws-a", nodeIds: ["node-a"], uploadIds: [], at: Date(), launch: "an-earlier-launch"))
        #expect(journal.list().map(\.id) == ["run-a"])
    }

    /* An offline clean-up of a file whose completion was never sent doesn't say it may still be there. */
    @Test func anOfflineCleanUpOfAFileNeverCompletedSaysNothingRemains() async throws {
        let writer = FakeWriter()
        let gate = AsyncGate()
        await writer.set(uploading: { await gate.wait() })
        let run = try await SaveRun.start(writer: writer, targets: [opened("f")], results: [], journal: journal())
        let saving = Task { try await run.file(Data([1]), name: "a", mime: nil, sources: own) }
        try await Task.sleep(for: .milliseconds(50))
        await writer.set(offline: true)
        let stopped = await run.cancel()
        #expect(stopped.cleanup == .left)
        #expect(stopped.message == SaveRuns.cancelled)
        await gate.open()
        _ = try? await saving.value
    }

    /*
     * Account A's rows, then B signs in (through the Files sheet while the app was stopped): B's journal on the same file
     * hands B nothing to clean up, and A's rows are dropped unread. Fails if a journal reads another account's rows.
     */
    @Test func anotherAccountsRowsAreNeverHandedToTheNextOnesCleanUp() async throws {
        let writer = FakeWriter()
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("save-runs-\(UUID().uuidString).json")
        let session = SaveRunJournal.Epoch()
        let a = SaveRunJournal(url: url, epoch: session, owner: AccountOwner(userId: "a", origin: "https://drive.test"))
        try a.put(SaveRunRow(id: "run-a", workspaceId: "ws-a", nodeIds: ["node-a"], uploadIds: [], at: Date(), launch: "an-earlier-launch"))
        #expect(await SaveRuns.interrupted(writer: writer, journal: a).map(\.id) == ["run-a"])
        let b = SaveRunJournal(url: url, epoch: session, owner: AccountOwner(userId: "b", origin: "https://drive.test"))
        #expect(await SaveRuns.interrupted(writer: writer, journal: b).isEmpty)
        #expect(!FileManager.default.fileExists(atPath: url.path))
        // The same user id on another server is another account too.
        try a.put(SaveRunRow(id: "run-a", workspaceId: "ws-a", nodeIds: ["node-a"], uploadIds: [], at: Date(), launch: "an-earlier-launch"))
        let elsewhere = SaveRunJournal(url: url, epoch: session, owner: AccountOwner(userId: "a", origin: "https://other.test"))
        #expect(elsewhere.list().isEmpty)
    }

    /* A staging file a write left behind goes at the next open and at the sign-out's wipe. */
    @Test func aLeftoverStagingFileIsGoneAtOpenAndAtTheWipe() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("save-runs-\(UUID().uuidString).json")
        let staging = SaveRunJournal.staging(url)
        try Data("rows".utf8).write(to: staging)
        _ = SaveRunJournal(url: url, epoch: SaveRunJournal.Epoch())
        #expect(!FileManager.default.fileExists(atPath: staging.path))
        let defaultStaging = SaveRunJournal.staging(SaveRunJournal.defaultURL)
        try FileManager.default.createDirectory(at: defaultStaging.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("rows".utf8).write(to: defaultStaging)
        SaveRunJournal.endAccount()
        #expect(!FileManager.default.fileExists(atPath: defaultStaging.path))
    }

    /* A sign-out while a run starts: abandonAll can't reach it yet, so it never starts and writes no row. */
    @Test func aSignOutWhileARunStartsLeavesNoRunAndNoRow() async throws {
        let session = SaveRunJournal.Epoch()
        let rows = journal(session)
        let writer = FakeWriter()
        await writer.set(room: { session.end() })
        do {
            _ = try await SaveRun.start(writer: writer, targets: [opened("f")], results: [], journal: rows)
            Issue.record("a run started after a sign-out")
        } catch let stopped as SaveRunStopped {
            #expect(stopped.reason == .signedOut)
        }
        #expect(rows.list().isEmpty)
    }

    /* A refresh after a key-change pause: one the change still holds up waits again; any other failure stops the run. */
    @Test func aRefreshTheKeyChangeHoldsUpWaitsAndAnyOtherFailureStopsTheRun() async throws {
        let writer = FakeWriter()
        await writer.answer { _ in throw DriveAPIError.rotating("Finishing a key change…") }
        await writer.refreshAnswer { throw DriveAPIError.rotating("Finishing a key change…") }
        let run = try await SaveRun.start(writer: writer, targets: [opened("fam")], results: [], journal: journal(), pause: { _ in })
        _ = try await run.file(Data([1]), name: "a", mime: nil, sources: own)
        #expect(await writer.refreshes == 2)

        let broken = FakeWriter()
        await broken.answer { _ in throw DriveAPIError.rotating("Finishing a key change…") }
        await broken.refreshAnswer { throw DriveAPIError.server(500, "Something went wrong.") }
        let rows = journal()
        let failing = try await SaveRun.start(writer: broken, targets: [opened("fam")], results: [], journal: rows, pause: { _ in })
        do {
            _ = try await failing.file(Data([1]), name: "a", mime: nil, sources: own)
            Issue.record("a refresh failure went on")
        } catch let stopped as SaveRunStopped {
            #expect(stopped.reason == .failed)
        }
        // Stopped, not left open: its row went with the clean-up, and later work is refused.
        #expect(rows.list().isEmpty)
        await #expect(throws: SaveRunStopped.self) { _ = try await failing.file(Data([1]), name: "b", mime: nil, sources: own) }

        let folderBroken = FakeWriter()
        await folderBroken.folderAnswer { throw DriveAPIError.rotating("Finishing a key change…") }
        await folderBroken.refreshAnswer { throw DriveAPIError.server(500, "Something went wrong.") }
        let folders = try await SaveRun.start(writer: folderBroken, targets: [opened("fam")], results: [], journal: journal(), pause: { _ in })
        await #expect(throws: SaveRunStopped.self) { _ = try await folders.folder("Archive", sources: own) }
        await #expect(throws: SaveRunStopped.self) { _ = try await folders.file(Data([1]), name: "b", mime: nil, sources: own) }
    }

    /* Two runs starting at once through separate journals on one file: neither loses the other's row. */
    @Test func journalsOnOneFileNeverLoseEachOthersRows() async throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("save-runs-\(UUID().uuidString).json")
        let session = SaveRunJournal.Epoch()
        let journals = [SaveRunJournal(url: url, epoch: session), SaveRunJournal(url: url, epoch: session)]
        DispatchQueue.concurrentPerform(iterations: 200) { n in
            try? journals[n % 2].put(SaveRunRow(id: "run-\(n)", workspaceId: "ws", nodeIds: [], uploadIds: [], at: Date(), launch: "l"))
        }
        #expect(journals[0].list().count == 200)
        DispatchQueue.concurrentPerform(iterations: 100) { n in
            journals[n % 2].retire(SaveRunRow(id: "run-\(n)", workspaceId: "ws", nodeIds: [], uploadIds: [], at: Date(), launch: "l"))
        }
        #expect(Set(journals[1].list().map(\.id)) == Set((100 ..< 200).map { "run-\($0)" }))
    }

    /* A finished run whose row the disk won't remove is marked done, never offered for deletion, and dropped later. */
    @Test func aFinishedRunWhoseRowWontGoIsNeverOfferedForDeletion() async throws {
        struct Full: Error {}
        let writer = FakeWriter()
        let rows = journal()
        let run = try await SaveRun.start(writer: writer, targets: [opened("f")], results: [], journal: rows)
        _ = try await run.file(Data([1]), name: "a", mime: nil, sources: own)
        let id = run.id
        // Every write that would leave the run's row out is refused.
        rows.fault = { written in if !written.contains(where: { $0.id == id }) { throw Full() } }
        try await run.finish()
        #expect(rows.list().first?.done == true)
        let other = SaveRunRow(id: "other", workspaceId: "ws", nodeIds: ["node-1"], uploadIds: [], at: Date(), launch: "an-earlier-launch")
        rows.fault = nil
        try rows.put(SaveRunRow(id: id, workspaceId: "ws", nodeIds: ["node-1"], uploadIds: [], at: Date(), launch: "an-earlier-launch", done: true))
        try rows.put(other)
        #expect(await SaveRuns.interrupted(writer: writer, journal: rows).map(\.id) == ["other"])
        #expect(rows.list().map(\.id) == ["other"])
        #expect(await writer.live.contains("node-1"))
    }

    /* A folder's id is on disk before its creation goes out, so one created whose answer was lost is still removed. */
    @Test func aFolderWhoseAnswerWasLostIsStillRemovedByItsRow() async throws {
        let writer = FakeWriter()
        await writer.set(loseAnswer: true)
        let rows = journal()
        let run = try await SaveRun.start(writer: writer, targets: [opened("f")], results: [], journal: rows)
        do {
            _ = try await run.folder("Out", sources: own)
            Issue.record("a lost answer passed")
        } catch let stopped as SaveRunStopped {
            #expect(stopped.reason == .failed)
        }
        #expect(await writer.purged == ["made-Out"])
        #expect(rows.list().isEmpty)
    }

    /* A listing that fails after a result landed stops the run and removes it: all or nothing. */
    @Test func aListingThatFailsStopsTheRunAndRemovesWhatItMade() async throws {
        let writer = FakeWriter()
        let rows = journal()
        let run = try await SaveRun.start(writer: writer, targets: [opened("f")], results: [], journal: rows)
        _ = try await run.file(Data([1]), name: "a", mime: nil, sources: own)
        await writer.set(namesFail: true)
        do {
            _ = try await run.file(Data([1]), name: "b", mime: nil, sources: own, in: opened("g"))
            Issue.record("a failed listing left the run open")
        } catch let stopped as SaveRunStopped {
            #expect(stopped.reason == .failed)
        }
        #expect(await writer.purged == ["node-1"])
        #expect(rows.list().isEmpty)
        await #expect(throws: SaveRunStopped.self) { _ = try await run.folder("Out", sources: own) }
    }

    /* A clean-up that leaves a published file says what may remain, never "nothing was saved". */
    @Test func aCleanUpThatLeavesAFileSaysWhatMayRemain() async throws {
        let writer = FakeWriter()
        let run = try await SaveRun.start(writer: writer, targets: [opened("f")], results: [], journal: journal())
        _ = try await run.file(Data([1]), name: "a", mime: nil, sources: own)
        await writer.refuse("node-1")
        let stopped = await run.cancel()
        #expect(stopped.cleanup == .left)
        #expect(stopped.message == "Cancelled. Some of what was made may still be there. You’ll be asked about it next time.")
    }

    /* The network went while a version's parts went up: its completion was never sent, so it isn't said to maybe be saved. */
    @Test func aVersionWhoseCompletionWasNeverSentIsNotSaidToMaybeBeSaved() async throws {
        let writer = FakeWriter()
        let gate = AsyncGate()
        await writer.set(uploading: { await gate.wait() })
        let rows = journal()
        let doc = opened("doc", parent: "f", version: "v1")
        let run = try await SaveRun.start(writer: writer, targets: [doc], results: [], journal: rows)
        let saving = Task { try await run.version(Data([1]), of: doc, in: opened("f"), startedFrom: "v1", sources: own) }
        try await Task.sleep(for: .milliseconds(50))
        await writer.set(offline: true)
        let stopped = await run.cancel()
        #expect(stopped.cleanup == .left)
        #expect(stopped.uncertainVersions == 0)
        #expect(stopped.message == SaveRuns.cancelled)
        #expect(rows.list().map(\.uploadIds) == [["up-1"]])
        await gate.open()
        _ = try? await saving.value
    }

    @Test func aResultOfSeveralSourcesIsSignedAsTheirWeakestUncheckedResealed() throws {
        let signing = try SaveRuns.signing(.from([.file(metadata: .verified, version: .verified, fromLink: false),
                                                   .file(metadata: .verified, version: .unchecked, fromLink: false)]))
        #expect(signing.version == .copy(.resealed))
        // Re-sealed, never refused: as the web signs a source nobody could check.
        let seed = try randomBytes(length: 32)
        let statement = VersionStatement(workspaceId: "ws", nodeId: "n", versionId: "v", objectId: "o", contentSuite: 3)
        guard case .copy(let prior) = signing.version else { Issue.record("not a copy"); return }
        // A plain copy of the unchecked record itself is still refused, as on the web and Android.
        #expect(throws: (any Error).self) {
            _ = try versionCopySign(signingSeed: try randomBytes(length: 32), prior: .unchecked, fromLink: false,
                                    statement: VersionStatement(workspaceId: "ws", nodeId: "n", versionId: "v", objectId: "o", contentSuite: 3),
                                    contentKeyEnvelope: Data([1]))
        }
        let signature = try versionCopySign(signingSeed: seed, prior: prior, fromLink: false, statement: statement, contentKeyEnvelope: Data([1]))
        let me = TrustedKeys(current: try signingPublicKey(signingSeed: seed), retired: [], seen: false)
        #expect(versionIntegrity(trusted: me, statement: statement, contentKeyEnvelope: Data([1]), signature: signature) == .resealed)
        #expect(throws: (any Error).self) { _ = try SaveRuns.signing(.from([])) }
    }
}

/* A gate a test opens when it chooses. */
/* The signed-in account a journal asks about, changed by the test. */
final class SignedInBox: @unchecked Sendable {
    private let lock = NSLock()
    private var held: AccountOwner?
    init(_ value: AccountOwner?) { held = value }
    var value: AccountOwner? {
        get { lock.withLock { held } }
        set { lock.withLock { held = newValue } }
    }
}

actor AsyncGate {
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var opened = false
    func wait() async {
        if opened { return }
        await withCheckedContinuation { waiters.append($0) }
    }
    func open() {
        opened = true
        for waiter in waiters { waiter.resume() }
        waiters = []
    }
}

/* The vault's own upload from memory, against the fake Drive: what the server is sent, and how it is signed. */
extension OnFakeDrive {
    @Suite struct SaveResultTests {
        func vault(_ server: FakeDrive) async throws -> Vault {
            FakeDrive.current = server
            let vault = Vault(api: DriveAPI(session: server.session, configuration: FakeDrive.configuration), session: server.session)
            await vault.adopt(workspace: WorkspaceView(workspaceId: server.workspace, changeSeq: nil, grant: nil, root: server.nodes[server.root]),
                              key: server.workspaceKey)
            await vault.adopt(identity: server.identity)
            await vault.adopt(signers: try server.ownerTrusts())
            return vault
        }

        /* Every file under the app's own folders and its temporary one that holds `bytes`. */
        static func holding(_ bytes: Data) -> [String] {
            let roots = [FileManager.default.temporaryDirectory, URL(fileURLWithPath: NSHomeDirectory())]
            var found: [String] = []
            for root in roots {
                guard let walk = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey, .fileSizeKey]) else { continue }
                for case let url as URL in walk {
                    let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
                    guard values?.isRegularFile == true, (values?.fileSize ?? 0) < 64 << 20, let data = try? Data(contentsOf: url) else { continue }
                    if data.range(of: bytes) != nil { found.append(url.path) }
                }
            }
            return found
        }

        /*
         * Saved from G (the owner's own, verified) and F (planted by a stranger): the result's records are
         * re-sealed, as the server checks the signatures, and its one chunk holds the bytes given. With G
         * alone, they are ordinary. While its part is on its way, no file on the device holds the plaintext.
         */
        @Test func aResultFromAnUnverifiedSourceIsResealedHoldsItsBytesAndNeverTouchesTheDisk() async throws {
            let server = try FakeDrive()
            let vault = try await vault(server)
            let a = try await vault.children(of: server.root).first { $0.id == server.a }!
            let f = try await vault.children(of: server.a).first { $0.id == server.f }!
            let g = try await vault.children(of: server.b).first { $0.id == server.g }!
            let trusted = try server.ownerTrusts()
            let source = { (item: Opened) in SaveSource.file(metadata: trusted.metadata(of: item.node), version: trusted.version(item.node.currentVersion!, of: item.node), fromLink: false) }

            let bytes = Data("tool output \(UUID().uuidString), never on disk".utf8)
            let onDisk = Locked<[String]?>(nil)
            server.onPart = { _ in onDisk.value = Self.holding(bytes) }
            let mixed = try await vault.uploadResult(bytes, name: "f.txt", mime: "text/plain", in: a.id, replacing: nil, startedFrom: nil,
                                                     signing: try SaveRuns.signing(.from([source(g), source(f)])))
            #expect(onDisk.value == [])
            server.onPart = nil
            #expect(server.statements[mixed.id] == "resealed")
            #expect(server.statements["version:" + mixed.node.currentVersion!.id] == "resealed")
            let clean = try await vault.uploadResult(bytes, name: "g copy.txt", mime: "text/plain", in: a.id, replacing: nil, startedFrom: nil,
                                                     signing: try SaveRuns.signing(.from([source(g)])))
            #expect(server.statements[clean.id] == "ordinary")

            // The one part sent decrypts, under the key its envelope seals, to the bytes given.
            let begun = try #require(server.begins.first { ($0["node"] as? [String: Any])?["id"] as? String == mixed.id })
            let versionId = try #require(begun["versionId"] as? String)
            let objectId = try #require(begun["objectId"] as? String)
            let nodeKey = try #require(await vault.nodeKey(of: mixed))
            let key = try versionOpen(ctx: VersionContext(workspaceId: server.workspace, nodeId: mixed.id, versionId: versionId, objectId: objectId), suite: 3,
                                      nodeKey: nodeKey, envelope: try base64urlDecode(value: try #require(begun["contentKeyEnvelope"] as? String)), rowSize: nil)
            let content = Content(workspaceId: server.workspace, objectId: objectId, suite: 3, key: key.key,
                                  nonce: try base64urlDecode(value: try #require(begun["contentNonce"] as? String)),
                                  plaintextSize: key.plaintextSize, thumbnailBytes: key.thumbnailBytes)
            let upload = try #require(server.uploads.first { ($0.value["versionId"] as? String) == versionId }?.key)
            let part = try #require(server.stored["\(upload)/1"])
            #expect(try chunkDecrypt(content: content, index: 0, ciphertext: part) == bytes)
        }

        func newer(_ server: FakeDrive) -> VersionView {
            VersionView(id: UUID().uuidString.lowercased(), objectId: "o", contentKeyEnvelope: server.nodes[server.g]!.currentVersion!.contentKeyEnvelope,
                        status: "ready", contentSuite: 3, chunkCount: 1, contentNonce: "", plaintextSize: nil, ciphertextSize: nil, readyAt: nil)
        }

        func replaceVersion(_ server: FakeDrive, _ version: VersionView) {
            let old = server.nodes[server.g]!
            var updated = NodeView(id: old.id, workspaceId: old.workspaceId, parentId: old.parentId, kind: old.kind, keyEpoch: old.keyEpoch,
                                   parentKeyEpoch: old.parentKeyEpoch, keyEnvelope: old.keyEnvelope, metadataVersion: old.metadataVersion,
                                   metadataEnvelope: old.metadataEnvelope, currentVersion: version, trashedAt: nil,
                                   changeSeq: (old.changeSeq ?? 0) + 1, createdAt: nil, updatedAt: nil)
            updated.metadataSigner = old.metadataSigner
            updated.metadataSignature = old.metadataSignature
            server.nodes[server.g] = updated
        }

        /*
         * A new version of G whose work started at an older version: stale before anything is begun. Another
         * device saving before begin: refused at begin, stale. Another saving while the parts went up: the
         * completion is refused, the upload aborted, and stale with theirs. Fails if any lands over theirs.
         */
        @Test func aNewVersionThatLostTheRaceIsStaleAtBeginAndAtCompletion() async throws {
            let server = try FakeDrive()
            let vault = try await vault(server)
            let b = try await vault.children(of: server.root).first { $0.id == server.b }!
            let g = try await vault.children(of: server.b).first { $0.id == server.g }!
            let current = g.node.currentVersion!.id
            await #expect(throws: SaveStale(currentVersionId: current)) {
                _ = try await vault.uploadResult(Data([1]), name: g.name, mime: nil, in: b.id, replacing: g, startedFrom: "an-older-version", signing: (.own, .own))
            }
            #expect(server.begins.isEmpty)

            let atBegin = newer(server)
            replaceVersion(server, atBegin)
            await #expect(throws: SaveStale(currentVersionId: atBegin.id)) {
                _ = try await vault.uploadResult(Data([1]), name: g.name, mime: nil, in: b.id, replacing: g, startedFrom: current, signing: (.own, .own))
            }
            #expect(server.completed.isEmpty)

            let fresh = try await vault.children(of: server.b).first { $0.id == server.g }!
            let atCompletion = newer(server)
            server.beforeComplete = { [unowned server] in self.replaceVersion(server, atCompletion) }
            await #expect(throws: SaveStale(currentVersionId: atCompletion.id)) {
                _ = try await vault.uploadResult(Data([2]), name: g.name, mime: nil, in: b.id, replacing: fresh, startedFrom: atBegin.id, signing: (.own, .own))
            }
            server.beforeComplete = nil
            #expect(server.completed.isEmpty)
            #expect(server.aborted.count == 1)
            #expect(server.nodes[server.g]?.currentVersion?.id == atCompletion.id)
        }

        /*
         * A tool's new version leaves the file's name record as it is (docs/editing-design.md section 3, as the web
         * does): nothing signed again, and nothing waits on whom to trust. A vault with no trust set loaded still saves.
         */
        @Test func aToolsNewVersionLeavesTheNameRecordAndNeedsNoTrustSet() async throws {
            let server = try FakeDrive()
            FakeDrive.current = server
            let vault = Vault(api: DriveAPI(session: server.session, configuration: FakeDrive.configuration), session: server.session)
            await vault.adopt(workspace: WorkspaceView(workspaceId: server.workspace, changeSeq: nil, grant: nil, root: server.nodes[server.root]),
                              key: server.workspaceKey)
            await vault.adopt(identity: server.identity)
            let b = try await vault.children(of: server.root).first { $0.id == server.b }!
            let g = try await vault.children(of: server.b).first { $0.id == server.g }!
            let before = try #require(server.nodes[server.g])
            let landed = try await vault.uploadResult(Data([1, 2]), name: g.name, mime: nil, in: b.id, replacing: g,
                                                      startedFrom: g.node.currentVersion!.id, signing: (.own, .own))
            let after = try #require(server.nodes[server.g])
            #expect(after.currentVersion?.id != before.currentVersion?.id)
            #expect(after.metadataVersion == before.metadataVersion)
            #expect(after.metadataEnvelope == before.metadataEnvelope)
            #expect(landed.name == g.name)
        }

        /*
         * A tool's result the server completed, though this device can't open its row now: saved, answered with the node the
         * completion named, never a failure that would remove it.
         */
        @Test func aResultThatLandedButCannotBeFiledHereIsSaved() async throws {
            let server = try FakeDrive()
            let vault = try await vault(server)
            let b = try await vault.children(of: server.root).first { $0.id == server.b }!
            server.landedSuite = 2
            let landed = try await vault.uploadResult(Data([1, 2]), name: "out.txt", mime: nil, in: b.id, replacing: nil, startedFrom: nil,
                                                      signing: (.own, .own))
            server.landedSuite = nil
            // It landed on the server, and the save is answered with it, never failed (which would remove it).
            #expect(server.nodes[landed.id] != nil)
            #expect(server.nodes[landed.id]?.trashedAt == nil)
        }

        /*
         * A tool's new version of a file another device renamed while it went up: the name is theirs, as the server serves
         * it, never the one the upload began from (and nothing is signed again). Fails if the old name is kept for the newer record.
         */
        @Test func aToolsNewVersionOfAFileRenamedMeanwhileTakesTheServersName() async throws {
            let server = try FakeDrive()
            let vault = try await vault(server)
            let b = try await vault.children(of: server.root).first { $0.id == server.b }!
            let g = try await vault.children(of: server.b).first { $0.id == server.g }!
            server.beforeComplete = { try? server.renamedElsewhere(server.g, to: "renamed.txt") }
            let landed = try await vault.uploadResult(Data([1, 2]), name: g.name, mime: nil, in: b.id, replacing: g,
                                                      startedFrom: g.node.currentVersion!.id, signing: (.own, .own))
            server.beforeComplete = nil
            #expect(landed.name == "renamed.txt")
            #expect(landed.node.metadataVersion == g.node.metadataVersion + 1)
            #expect(try await vault.resolve(server.g).name == "renamed.txt")
        }

        /* Whether a clean-up may delete forever: true for the own Drive; not known (nil, the row kept) until confirmed otherwise. */
        @Test func mayDeleteForeverIsUnknownUntilConfirmed() async throws {
            let server = try FakeDrive()
            let vault = try await vault(server)
            #expect(await vault.mayPurge(server.workspace) == true)
            server.intercept = { method, parts, _ in method == "GET" && parts.last == "shares" ? (200, ["shares": [Any]()]) : nil }
            #expect(await vault.mayPurge("0b6c0f4e-0000-4000-8000-00000000beef") == nil)
            server.intercept = { method, parts, _ in method == "GET" && parts.last == "shares" ? (503, ["message": "Down."]) : nil }
            #expect(await vault.mayPurge("0b6c0f4e-0000-4000-8000-00000000beef") == nil)
            server.intercept = nil
        }

        /* On a server without the batch route, a clean-up's trash goes one request an item, the session asked before each. */
        @Test func aCleanUpOnAServerWithoutTheBatchRouteTrashesOneItemAtATime() async throws {
            let server = try FakeDrive()
            let vault = try await vault(server)
            _ = try await vault.children(of: server.root)
            let batches = Locked(0)
            let trashed = Locked<[String]>([])
            let rows = try server.nodes.mapValues { try JSONSerialization.jsonObject(with: JSONEncoder().encode($0)) }
            server.intercept = { method, parts, _ in
                guard method == "POST" else { return nil }
                if parts.last == "trash-batch" {
                    batches.value += 1
                    return (501, ["code": "unsupported", "message": "This server does not offer that yet."])
                }
                guard parts.last == "trash", parts.count >= 2 else { return nil }
                let id = parts[parts.count - 2]
                guard let row = rows[id] else { return (404, ["code": "not-found", "message": "This item no longer exists."]) }
                trashed.value.append(id)
                return (200, ["node": row])
            }
            let fates = try await vault.trash([server.a, "never-there"], in: server.workspace, while: { true })
            #expect(fates[server.a] == .done)
            #expect(fates["never-there"] == .gone)
            #expect(batches.value == 1)
            #expect(trashed.value == [server.a])
            // Every item not found, one by one: not made yet or out of reach, and nothing tells which. Uncertain (refused, the
            // row kept), never lost access and never gone.
            let missing = try await vault.trash(["never-1", "never-2"], in: server.workspace, while: { true })
            #expect(Set(missing.values) == [.refused])
            // Signed out after the first item went: the rest unsent (asked for the batch, then before each item).
            let asked = Locked(0)
            let rest = try await vault.trash([server.b, server.f], in: server.workspace, while: {
                asked.value += 1
                return asked.value <= 2
            })
            #expect(rest[server.b] == .done)
            #expect(rest[server.f] == .refused)
            #expect(trashed.value == [server.a, server.b])
            server.intercept = nil
        }

        /*
         * A folder this device created is filed as it sent it: the reply's parent, key epochs and envelopes are ignored (only the
         * server's own fields, such as its change number, are taken), and a reply naming another folder is no answer.
         */
        @Test func aCreatedFolderIsFiledAsItWasSentNeverAsTheReplyDescribesIt() async throws {
            let server = try FakeDrive()
            let vault = try await vault(server)
            _ = try await vault.children(of: server.root)
            let template = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(server.nodes[server.b]!)) as? [String: Any])
            let sent = Locked<[String: Any]>([:])
            let replyId = Locked<String?>(nil)
            server.intercept = { method, parts, body in
                guard method == "POST", parts.last == "folders", let folder = (body["folders"] as? [[String: Any]])?.first else { return nil }
                sent.value = folder
                var lying = template
                lying["id"] = replyId.value ?? folder["id"]
                lying["parentId"] = "someone-elses-folder"
                lying["keyEpoch"] = 99
                lying["parentKeyEpoch"] = 42
                lying["keyEnvelope"] = "theirs"
                lying["metadataEnvelope"] = "theirs-too"
                lying["changeSeq"] = 7
                return (200, ["nodes": [lying]])
            }
            let made = try await vault.createFolder(in: server.root, name: "Out")
            #expect(made.node.parentId == server.root)
            #expect(made.node.keyEpoch == (sent.value["keyEpoch"] as? NSNumber)?.uint64Value)
            #expect(made.node.parentKeyEpoch == (sent.value["parentKeyEpoch"] as? NSNumber)?.uint64Value)
            #expect(made.node.keyEnvelope == sent.value["keyEnvelope"] as? String)
            #expect(made.node.metadataEnvelope == sent.value["metadataEnvelope"] as? String)
            #expect(made.name == "Out")
            // The server's own field is taken.
            #expect(made.node.changeSeq == 7)
            // A reply naming another folder is no answer.
            replyId.value = "another-folder"
            await #expect(throws: DriveAPIError.self) { _ = try await vault.createFolder(in: server.root, name: "Again") }
            server.intercept = nil
        }

        /* A folder creation answered with another node is never adopted, and a run that made it never removes that node. */
        @Test func aFolderCreationAnsweredWithAnotherNodeIsNeverAdoptedOrRemoved() async throws {
            let server = try FakeDrive()
            let vault = try await vault(server)
            let root = try await vault.resolve(server.root)
            let b = try await vault.children(of: server.root).first { $0.id == server.b }!
            let victim = try JSONSerialization.jsonObject(with: JSONEncoder().encode(server.nodes[server.b]!))
            server.intercept = { method, parts, _ in
                guard method == "POST", parts.last == "folders" else { return nil }
                return (200, ["nodes": [victim]])
            }
            let rows = journal()
            let run = try await SaveRun.start(writer: vault, targets: [root], results: [], journal: rows)
            let stopped = await #expect(throws: SaveRunStopped.self) { _ = try await run.folder("Out", sources: own) }
            #expect(stopped?.reason == .failed)
            server.intercept = nil
            // Never adopted under the new folder's key and name, and never trashed or deleted.
            #expect(try await vault.resolve(server.b).name == b.name)
            #expect(server.nodes[server.b]?.trashedAt == nil)
        }

        /*
         * A destination the vault holds under another workspace than the one asked (the own Drive's folder of the same id, say)
         * is refused before anything is minted or sent: a save never lands in another Drive than its run's.
         */
        @Test func aDestinationNotHeldUnderItsOwnWorkspaceIsRefusedBeforeAnythingIsSent() async throws {
            let server = try FakeDrive()
            let vault = try await vault(server)
            _ = try await vault.children(of: server.root)
            let writes = Locked(0)
            server.intercept = { method, _, _ in
                if method != "GET" { writes.value += 1 }
                return nil
            }
            // The own folder's id, named as another workspace's row.
            let shared = opened(server.b, workspace: "0b6c0f4e-0000-4000-8000-00000000beef")
            await #expect(throws: IdCollision.self) {
                _ = try await vault.makeFolder(in: shared, name: "Out", signing: .own, minted: { _ in })
            }
            await #expect(throws: IdCollision.self) {
                _ = try await vault.uploadResult(Data([1]), name: "a", mime: nil, in: shared, replacing: nil, startedFrom: nil, thumbnail: nil,
                                                 signing: (.own, .own), onBegun: { _ in }, onCompleting: { _ in })
            }
            #expect(writes.value == 0)
            server.intercept = nil
        }

        /*
         * A run's folder is made under the very row its destination was checked as, never one its id looks up again: the own
         * Drive's folder of the same id is not that row, so nothing is minted, wrapped or sent, and the own folder gains nothing.
         */
        @Test func aFolderIsMadeUnderTheRowCheckedNeverOneItsIdLooksUpAgain() async throws {
            let server = try FakeDrive()
            let vault = try await vault(server)
            _ = try await vault.children(of: server.root)
            let writes = Locked(0)
            let minted = Locked(0)
            server.intercept = { method, _, _ in
                if method != "GET" { writes.value += 1 }
                return nil
            }
            let shared = opened(server.b, workspace: "0b6c0f4e-0000-4000-8000-00000000beef")
            await #expect(throws: IdCollision.self) {
                _ = try await vault.createFolder(under: shared, name: "Out", signing: .own, onMinted: { _ in minted.value += 1 })
            }
            #expect(writes.value == 0)
            #expect(minted.value == 0)
            #expect(try await vault.children(of: server.b).allSatisfy { $0.name != "Out" })
            // The row held as it is checked is the one written under.
            let b = try await vault.children(of: server.root).first { $0.id == server.b }!
            let made = try await vault.createFolder(under: b, name: "In", signing: .own, onMinted: { _ in minted.value += 1 })
            #expect(made.node.parentId == server.b)
            #expect(minted.value == 1)
            server.intercept = nil
        }

        /* A sign-out during the first of two trash batches sends no second; a purge or an abort sends nothing after it either. */
        @Test func aSignOutBetweenBatchesOrTriesSendsNothingMore() async throws {
            let server = try FakeDrive()
            let vault = try await vault(server)
            let on = Locked(true)
            let batches = Locked(0)
            let ids = (0 ... TrashBatch.maxBatch).map { "node-\($0)" }
            server.intercept = { method, parts, body in
                guard method == "POST", parts.last == "trash-batch" else { return nil }
                batches.value += 1
                on.value = false
                let sent = body["nodeIds"] as? [String] ?? []
                return (200, ["results": sent.map { ["id": $0, "status": "trashed", "trashedAt": "2026-01-01T00:00:00Z", "changeSeq": 1] }])
            }
            let fates = try await vault.trash(ids, in: server.workspace, while: { on.value })
            #expect(batches.value == 1)
            #expect(fates["node-0"] == .done)
            #expect(fates[ids.last!] == .refused)
            // Purge: one request per id, none after the sign-out.
            on.value = true
            let purges = Locked(0)
            server.intercept = { method, parts, _ in
                guard method == "DELETE", parts.contains("nodes") else { return nil }
                purges.value += 1
                on.value = false
                return (200, ["purged": true])
            }
            let purged = try await vault.purge(["node-a", "node-b"], in: server.workspace, while: { on.value })
            #expect(purges.value == 1)
            #expect(purged["node-b"] == .refused)
            // An abort still finishing: no next try after the sign-out.
            on.value = true
            let aborts = Locked(0)
            server.intercept = { method, parts, _ in
                guard method == "POST", parts.last == "abort" else { return nil }
                aborts.value += 1
                on.value = false
                return (409, ["code": "conflict", "message": "finishing", "data": ["upload": "completing"]])
            }
            #expect(await vault.abortUpload("up", in: server.workspace, pause: .zero, while: { on.value }) == .unknown)
            #expect(aborts.value == 1)
            server.intercept = nil
        }

        /* An abort answered "still finishing" is asked again, and settles as what the server then says. */
        @Test func anUploadStillFinishingIsAskedAgainBeforeTheCleanUpDecides() async throws {
            let server = try FakeDrive()
            let vault = try await vault(server)
            server.abortReplies = [(409, ["code": "conflict", "message": "finishing", "data": ["upload": "completing"]]),
                                   (409, ["code": "conflict", "message": "finished", "data": ["upload": "completed"]])]
            #expect(await vault.abortUpload("up", in: server.workspace, while: { true }) == .finished)
            server.abortReplies = [(409, ["code": "conflict", "message": "finishing", "data": ["upload": "completing"]])]
            #expect(await vault.abortUpload("up", in: server.workspace, while: { true }) == .gone)
            // Still finishing after every try: no answer, never finished (its node is published only once it completes).
            server.abortReplies = Array(repeating: (409, ["code": "conflict", "message": "finishing", "data": ["upload": "completing"]]), count: 5)
            #expect(await vault.abortUpload("up", in: server.workspace, pause: .zero, while: { true }) == .unknown)
            // A self-hosted server from before `data.upload` says which in words.
            server.abortReplies = [(409, ["code": "conflict", "message": "This upload is finishing and cannot be cancelled."]),
                                   (409, ["code": "conflict", "message": "This upload already finished."])]
            #expect(await vault.abortUpload("up", in: server.workspace, pause: .zero, while: { true }) == .finished)
            server.abortReplies = [(409, ["code": "conflict", "message": "Something else."])]
            #expect(await vault.abortUpload("up", in: server.workspace, pause: .zero, while: { true }) == .unknown)
            // An expired session (401) says nothing of the upload: no answer, its id kept.
            server.abortReplies = [(401, ["message": "Sign in to HushOS to see your files."])]
            #expect(await vault.abortUpload("up", in: server.workspace, pause: .zero, while: { true }) == .unknown)
        }

        /* A new folder's id is heard before its creation is sent; a throw from the hearer sends nothing. */
        @Test func aNewFoldersIdIsHeardBeforeItsCreationIsSent() async throws {
            struct Refused: Error {}
            let server = try FakeDrive()
            let vault = try await vault(server)
            let existedWhenHeard = Locked<[Bool]>([])
            let made = try await vault.createFolder(in: server.root, name: "Out", onMinted: { id in existedWhenHeard.value.append(server.nodes[id] != nil) })
            #expect(existedWhenHeard.value == [false])
            #expect(server.nodes[made.id] != nil)
            let heard = Locked<String?>(nil)
            await #expect(throws: Refused.self) {
                _ = try await vault.createFolder(in: server.root, name: "Refused", onMinted: { id in heard.value = id; throw Refused() })
            }
            #expect(heard.value != nil)
            #expect(server.nodes[heard.value!] == nil)
        }

        /* The run's row refused at begin: no part, no completion, the reservation aborted. */
        @Test func aBeginWhoseRowCannotBeWrittenSendsNothingAndAbortsItsReservation() async throws {
            struct Full: Error {}
            let server = try FakeDrive()
            let vault = try await vault(server)
            let b = try await vault.children(of: server.root).first { $0.id == server.b }!
            let parts = Locked(0)
            server.onPart = { _ in parts.value += 1 }
            await #expect(throws: Full.self) {
                _ = try await vault.uploadResult(Data([1, 2, 3]), name: "new.txt", mime: nil, in: b.id, replacing: nil, startedFrom: nil,
                                                 signing: (.own, .own), onBegun: { _ in throw Full() })
            }
            #expect(parts.value == 0)
            #expect(server.completed.isEmpty)
            #expect(server.aborted.count == 1)
        }

        /* The next free name comes from the server: a file another device just made, the catalogue not yet told, is taken. */
        @Test func theNextFreeNameSeesAFileTheCatalogueHasNotHeardOf() async throws {
            let feed = try FeedServer()
            let server = feed.drive
            FakeDrive.current = server
            FeedServer.current = feed
            let vault = Vault(api: DriveAPI(session: server.session, configuration: FeedServer.configuration), session: server.session)
            await vault.adopt(workspace: WorkspaceView(workspaceId: server.workspace, changeSeq: nil, grant: nil, root: server.nodes[server.root]),
                              key: server.workspaceKey)
            await vault.adopt(identity: server.identity)
            await vault.adopt(signers: try server.ownerTrusts())
            let file = FileManager.default.temporaryDirectory.appendingPathComponent("mirror-\(UUID().uuidString).sqlite")
            await vault.useMirror(try #require(Mirror(url: file)), page: 2)
            #expect(await vault.buildCatalogue())
            let b = try await vault.children(of: server.root).first { $0.id == server.b }!
            // Another device saves "report.pdf" into B.
            let other = Vault(api: DriveAPI(session: server.session, configuration: FeedServer.configuration), session: server.session)
            await other.adopt(workspace: WorkspaceView(workspaceId: server.workspace, changeSeq: nil, grant: nil, root: server.nodes[server.root]),
                              key: server.workspaceKey)
            await other.adopt(identity: server.identity)
            await other.adopt(signers: try server.ownerTrusts())
            _ = try await other.uploadResult(Data([1]), name: "report.pdf", mime: nil, in: server.b, replacing: nil, startedFrom: nil, signing: (.own, .own))
            #expect(await vault.catalogueChildren(of: server.b)?.contains { $0.name == "report.pdf" } == false)
            #expect(try await vault.names(in: b).contains("report.pdf"))
        }

        /*
         * The catalogue is ready but has not heard of another device's save: the race is still told apart from a
         * key change by asking the server itself. Fails if the check reads the catalogue (SaveRekeyed, retried).
         */
        @Test func aRaceTheCatalogueHasNotHeardOfIsStaleNotRekeyed() async throws {
            let feed = try FeedServer()
            let server = feed.drive
            FakeDrive.current = server
            FeedServer.current = feed
            let vault = Vault(api: DriveAPI(session: server.session, configuration: FeedServer.configuration), session: server.session)
            await vault.adopt(workspace: WorkspaceView(workspaceId: server.workspace, changeSeq: nil, grant: nil, root: server.nodes[server.root]),
                              key: server.workspaceKey)
            await vault.adopt(identity: server.identity)
            await vault.adopt(signers: try server.ownerTrusts())
            let file = FileManager.default.temporaryDirectory.appendingPathComponent("mirror-\(UUID().uuidString).sqlite")
            await vault.useMirror(try #require(Mirror(url: file)), page: 2)
            #expect(await vault.buildCatalogue())
            let b = try await vault.children(of: server.root).first { $0.id == server.b }!
            let g = try await vault.children(of: server.b).first { $0.id == server.g }!
            let theirs = newer(server)
            replaceVersion(server, theirs)
            #expect(await vault.catalogueChildren(of: server.b)?.first { $0.id == server.g }?.node.currentVersion?.id == g.node.currentVersion?.id)
            await #expect(throws: SaveStale(currentVersionId: theirs.id)) {
                _ = try await vault.uploadResult(Data([1]), name: g.name, mime: nil, in: b.id, replacing: g,
                                                 startedFrom: g.node.currentVersion!.id, signing: (.own, .own))
            }
        }

        /* A completion refused only because the file was re-keyed (its version unchanged): to be sealed afresh, never stale, never failed. */
        @Test func aKeyOnlyRefusalAtCompletionIsRekeyedNotStale() async throws {
            let server = try FakeDrive()
            let vault = try await vault(server)
            let b = try await vault.children(of: server.root).first { $0.id == server.b }!
            let g = try await vault.children(of: server.b).first { $0.id == server.g }!
            server.rekeyAtComplete = true
            await #expect(throws: SaveRekeyed()) {
                _ = try await vault.uploadResult(Data([1]), name: g.name, mime: nil, in: b.id, replacing: g, startedFrom: g.node.currentVersion!.id, signing: (.own, .own))
            }
            #expect(server.aborted.count == 1)
        }
    }
}

/* A value a hook sets from another thread. */
final class Locked<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var held: T
    init(_ value: T) { held = value }
    var value: T {
        get { lock.withLock { held } }
        set { lock.withLock { held = newValue } }
    }
}
