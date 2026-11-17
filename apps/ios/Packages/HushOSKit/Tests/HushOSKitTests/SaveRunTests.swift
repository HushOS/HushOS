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
        live.insert("made-\(name)")
        if loseAnswer { throw DriveAPIError.transport("The network connection was lost.") }
        return opened("made-\(name)", parent: folder.id)
    }
    func set(loseAnswer: Bool) { self.loseAnswer = loseAnswer }
    func set(namesFail: Bool) { self.namesFail = namesFail }
    func set(uploading: @escaping @Sendable () async -> Void) { self.uploading = uploading }
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
        return opened(nodeId, parent: folder.id)
    }
    func refreshFolder(_ folder: Opened) async throws -> Opened {
        refreshes += 1
        if !refreshAnswers.isEmpty { try refreshAnswers.removeFirst()() }
        return opened(folder.id, parent: folder.node.parentId, keyEpoch: folder.node.keyEpoch + 1)
    }
    func folderAnswer(_ next: @escaping @Sendable () throws -> Void) { folderAnswers.append(next) }
    func set(landing: @escaping @Sendable () async -> Void) { self.landing = landing }
    func set(making: @escaping @Sendable () async -> Void) { self.making = making }
    func fresh(_ file: Opened, in folder: Opened) async throws -> Opened? {
        if let freshFile { return freshFile }
        return file
    }
    func keyChangePause(_ workspaceId: String, attempt: Int) async throws {}
    func abortUpload(_ uploadId: String, in workspaceId: String) async -> DriveAPI.AbortFate {
        if offline { return .unknown }
        if denied { return .denied }
        if completing.contains(uploadId) { return .unknown }
        aborted.append(uploadId)
        if finished.contains(uploadId) { return .finished }
        return open.remove(uploadId) != nil ? .aborted : .gone
    }
    func trash(_ ids: [String], in workspaceId: String) async throws -> [String: SaveItemFate] {
        if offline { throw DriveAPIError.transport("offline") }
        var fates: [String: SaveItemFate] = [:]
        for id in ids {
            if denied { fates[id] = .denied } else if refuse.contains(id) { fates[id] = .refused } else if live.remove(id) != nil {
                trashed.insert(id)
                fates[id] = .done
            } else { fates[id] = trashed.contains(id) ? .done : .gone }
        }
        return fates
    }
    func purge(_ ids: [String], in workspaceId: String) async throws -> [String: SaveItemFate] {
        var fates: [String: SaveItemFate] = [:]
        for id in ids {
            if busy.contains(id) { fates[id] = .refused } else if trashed.remove(id) != nil {
                purged.insert(id)
                fates[id] = .done
            } else { fates[id] = .gone }
        }
        return fates
    }
    func mayPurge(_ workspaceId: String) async -> Bool { member }
}

func opened(_ id: String, parent: String? = "root", version: String? = nil, keyEpoch: UInt64 = 1, name: String? = nil) -> Opened {
    let current = version.map {
        VersionView(id: $0, objectId: "o", contentKeyEnvelope: "", status: "ready", contentSuite: 3, chunkCount: 1, contentNonce: "",
                    plaintextSize: nil, ciphertextSize: nil, readyAt: nil)
    }
    let node = NodeView(id: id, workspaceId: "ws", parentId: parent, kind: version == nil ? "folder" : "file", keyEpoch: keyEpoch, parentKeyEpoch: 1,
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

    @Test func theNextLaunchFindsAnInterruptedRunDeletesOrKeepsWhatItMadeAndDropsOneItCanNoLongerReach() async throws {
        let rows = journal()
        let writer = FakeWriter()
        let run = try await SaveRun.start(writer: writer, targets: [opened("f")], results: [], journal: rows)
        // This launch's own row is not interrupted; another launch's is.
        #expect(SaveRuns.interrupted(rows).isEmpty)
        let other = SaveRunRow(id: "other", workspaceId: "ws", nodeIds: ["node-x"], uploadIds: ["up-x"], at: Date(), launch: "an-earlier-launch")
        try rows.put(other)
        #expect(SaveRuns.interrupted(rows).map(\.id) == ["other"])
        await writer.set(offline: true)
        #expect(await SaveRuns.cleanUp(other, writer: writer, journal: rows) == .left)
        #expect(rows.list().contains { $0.id == "other" })
        // Keep with no answer (offline, an older server): the row goes all the same; the server lets an open upload expire.
        try await SaveRuns.keep(other, writer: writer, journal: rows)
        #expect(!rows.list().contains { $0.id == "other" })
        await writer.set(offline: false)
        try rows.put(other)
        await writer.set(denied: true)
        #expect(await SaveRuns.cleanUp(other, writer: writer, journal: rows) == .noAccess)
        #expect(!rows.list().contains { $0.id == "other" })
        await writer.set(denied: false)
        try rows.put(other)
        try await SaveRuns.keep(other, writer: writer, journal: rows)
        #expect(await writer.aborted == ["up-x"])
        #expect(!rows.list().contains { $0.id == "other" })
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
        await writer.set(landing: { await gate.wait() })
        let session = SaveRunJournal.Epoch()
        let run = try await SaveRun.start(writer: writer, targets: [opened("f")], results: [], journal: journal(session))
        let saving = Task { try await run.file(Data([1]), name: "a", mime: nil, sources: own) }
        try await Task.sleep(for: .milliseconds(50))
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
        #expect(SaveRuns.interrupted(rows).map(\.id) == ["other"])
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

        /* An abort answered "still finishing" is asked again, and settles as what the server then says. */
        @Test func anUploadStillFinishingIsAskedAgainBeforeTheCleanUpDecides() async throws {
            let server = try FakeDrive()
            let vault = try await vault(server)
            server.abortReplies = [(409, ["code": "conflict", "message": "finishing", "data": ["upload": "completing"]]),
                                   (409, ["code": "conflict", "message": "finished", "data": ["upload": "completed"]])]
            #expect(await vault.abortUpload("up", in: server.workspace) == .finished)
            server.abortReplies = [(409, ["code": "conflict", "message": "finishing", "data": ["upload": "completing"]])]
            #expect(await vault.abortUpload("up", in: server.workspace) == .gone)
            // Still finishing after every try: no answer, never finished (its node is published only once it completes).
            server.abortReplies = Array(repeating: (409, ["code": "conflict", "message": "finishing", "data": ["upload": "completing"]]), count: 5)
            #expect(await vault.abortUpload("up", in: server.workspace, pause: .zero) == .unknown)
            // A self-hosted server from before `data.upload` says which in words.
            server.abortReplies = [(409, ["code": "conflict", "message": "This upload is finishing and cannot be cancelled."]),
                                   (409, ["code": "conflict", "message": "This upload already finished."])]
            #expect(await vault.abortUpload("up", in: server.workspace, pause: .zero) == .finished)
            server.abortReplies = [(409, ["code": "conflict", "message": "Something else."])]
            #expect(await vault.abortUpload("up", in: server.workspace, pause: .zero) == .unknown)
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
