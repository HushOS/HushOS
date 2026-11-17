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
    var freshFile: Opened??
    /* What each upload does once begun, in order (default: land). */
    var answers: [@Sendable (Int) throws -> Void] = []
    var listing: (@Sendable () async -> Void)?
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
    func room(_ workspaceId: String) async throws -> SaveRoom { roomIs }
    func names(in folder: Opened) async throws -> [String] {
        await listing?()
        return names
    }
    func makeFolder(in folder: Opened, name: String, signing: Signing) async throws -> Opened {
        live.insert("made-\(name)")
        return opened("made-\(name)", parent: folder.id)
    }
    func uploadResult(_ bytes: Data, name: String, mime: String?, in folder: Opened, replacing: Opened?, startedFrom: String?, thumbnail: Data?,
                      signing: (metadata: Signing, version: Signing), onBegun: @escaping @Sendable (Vault.BegunIds) -> Void) async throws -> Opened {
        count += 1
        let n = count
        uploads.append((name, folder.id, replacing?.id, replacing?.node.keyEpoch, startedFrom, signing))
        let nodeId = replacing?.id ?? "node-\(n)"
        open.insert("up-\(n)")
        onBegun(Vault.BegunIds(workspaceId: "ws", uploadId: "up-\(n)", nodeId: nodeId))
        if !answers.isEmpty { try answers.removeFirst()(n) }
        finish("up-\(n)")
        if replacing == nil { live.insert(nodeId) }
        return opened(nodeId, parent: folder.id)
    }
    func fresh(_ file: Opened, in folder: Opened) async throws -> Opened? {
        if let freshFile { return freshFile }
        return file
    }
    func keyChangePause(_ workspaceId: String, attempt: Int) async throws {}
    func abortUpload(_ uploadId: String, in workspaceId: String) async -> DriveAPI.AbortFate {
        if offline { return .unknown }
        if denied { return .denied }
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
        await #expect(throws: SaveRunStopped.self) {
            _ = try await run.file(Data([1]), name: "a.png", mime: "image/png", sources: own, thumbnail: Data([9]))
        }
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
        rows.put(other)
        #expect(SaveRuns.interrupted(rows).map(\.id) == ["other"])
        await writer.set(offline: true)
        #expect(await SaveRuns.cleanUp(other, writer: writer, journal: rows) == .left)
        #expect(await !SaveRuns.keep(other, writer: writer, journal: rows))
        await writer.set(offline: false)
        await writer.set(denied: true)
        #expect(await SaveRuns.cleanUp(other, writer: writer, journal: rows) == .noAccess)
        #expect(!rows.list().contains { $0.id == "other" })
        await writer.set(denied: false)
        rows.put(other)
        #expect(await SaveRuns.keep(other, writer: writer, journal: rows))
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
        // A result landing after the account was wiped writes no row back.
        _ = try await run.file(Data([1]), name: "a", mime: nil, sources: own)
        #expect(!FileManager.default.fileExists(atPath: file.path))
        await run.abandon()
        await #expect(throws: SaveRunStopped.self) { _ = try await run.file(Data([1]), name: "b", mime: nil, sources: own) }
        // The real sign-out ends every journal on the account's session.
        let accountJournal = journal(SaveRunJournal.account)
        SaveRunJournal.endAccount()
        #expect(!accountJournal.live)
    }

    @Test func aResultOfSeveralSourcesIsSignedAsTheirWeakestUncheckedResealed() throws {
        let signing = try SaveRuns.signing(.from([.file(metadata: .verified, version: .verified, fromLink: false),
                                                   .file(metadata: .verified, version: .unchecked, fromLink: false)]))
        #expect(signing.version == .copy(.unchecked))
        // Re-sealed, never refused: as the web signs a source nobody could check.
        let seed = try randomBytes(length: 32)
        let statement = VersionStatement(workspaceId: "ws", nodeId: "n", versionId: "v", objectId: "o", contentSuite: 3)
        guard case .copy(let prior) = signing.version else { Issue.record("not a copy"); return }
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
