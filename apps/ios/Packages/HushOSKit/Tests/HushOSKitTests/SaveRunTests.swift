import Foundation
import HushOSCore
import Testing
@testable import HushOSKit

/*
 * The save path on the phone (SaveRuns.swift). A run decides before anything is made whether it
 * may write and whether it fits, saves results from memory under the next free name, ends a
 * version race `stale`, and leaves nothing when it stops: each test fails on the defect a person
 * would see (a run that starts and fails halfway, a laundered mark, a half-made result left
 * behind, a file an editor may only trash deleted forever, a row the next open needs lost).
 */

/* The drive as a run sees it, every call recorded; uploads answer as the test says. */
actor FakeWriter: SaveRunWriter {
    var refusal: String?
    var free: Int64?
    var names: [String] = []
    var member = true
    var trashFails = false
    var uploads: [(name: String, folder: String, replacing: String?, startedFrom: String?, signing: (metadata: Signing, version: Signing))] = []
    var trashed: [[String]] = []
    var purged: [[String]] = []
    var aborted: [String] = []
    var pauses = 0
    /* What each upload does once begun, in order: land, fail, or stay stale. Default: land. */
    var answers: [@Sendable (Int) throws -> Void] = []
    private var count = 0

    init(free: Int64? = 1 << 40) { self.free = free }

    func set(refusal: String?) { self.refusal = refusal }
    func set(member: Bool) { self.member = member }
    func set(trashFails: Bool) { self.trashFails = trashFails }
    func set(names: [String]) { self.names = names }
    func answer(_ next: @escaping @Sendable (Int) throws -> Void) { answers.append(next) }

    func gate(_ target: Opened) async -> SaveGate { refusal.map { .refused($0) } ?? .writable }
    func freeSpace(_ workspaceId: String) async throws -> Int64? { free }
    func names(in folder: Opened) async throws -> [String] { names }
    func makeFolder(in folder: Opened, name: String, signing: Signing) async throws -> Opened { opened("made-\(name)", parent: folder.id) }
    func uploadResult(_ bytes: Data, name: String, mime: String?, in folder: Opened, replacing: Opened?, startedFrom: String?,
                      signing: (metadata: Signing, version: Signing), onBegun: @escaping @Sendable (Vault.BegunIds) -> Void) async throws -> Opened {
        count += 1
        let n = count
        uploads.append((name, folder.id, replacing?.id, startedFrom, signing))
        let nodeId = replacing?.id ?? "node-\(n)"
        onBegun(Vault.BegunIds(workspaceId: "ws", uploadId: "up-\(n)", nodeId: nodeId))
        // Let the run hear of the begin before the answer, as a real upload's parts take time.
        await Task.yield()
        if !answers.isEmpty { try answers.removeFirst()(n) }
        return opened(nodeId, parent: folder.id)
    }
    func keyChangePause(_ workspaceId: String, attempt: Int) async throws { pauses += 1 }
    func abortUpload(_ uploadId: String, in workspaceId: String) async { aborted.append(uploadId) }
    func trash(_ ids: [String], in workspaceId: String) async throws {
        if trashFails { throw DriveAPIError.transport("offline") }
        trashed.append(ids)
    }
    func purge(_ ids: [String], in workspaceId: String) async throws { purged.append(ids) }
    func mayPurge(_ workspaceId: String) async -> Bool { member }
}

func opened(_ id: String, parent: String? = "root", version: String? = nil, name: String? = nil) -> Opened {
    let current = version.map {
        VersionView(id: $0, objectId: "o", contentKeyEnvelope: "", status: "ready", contentSuite: 3, chunkCount: 1, contentNonce: "",
                    plaintextSize: nil, ciphertextSize: nil, readyAt: nil)
    }
    let node = NodeView(id: id, workspaceId: "ws", parentId: parent, kind: version == nil ? "folder" : "file", keyEpoch: 1, parentKeyEpoch: 1,
                        keyEnvelope: "", metadataVersion: 1, metadataEnvelope: "", currentVersion: current, trashedAt: nil, changeSeq: 1,
                        createdAt: nil, updatedAt: nil)
    return Opened(node: node, metadata: NodeMetadata(name: name ?? id, mime: nil, size: nil, modified: nil, attributes: [:]), nodeKey: nil)
}

func journal() -> SaveRunJournal {
    SaveRunJournal(url: FileManager.default.temporaryDirectory.appendingPathComponent("save-runs-\(UUID().uuidString).json"))
}

@Suite struct SaveRunTests {
    let own: (metadata: Signing, version: Signing) = (.own, .own)

    @Test func aReadOnlyFamilyFolderRefusesTheRunBeforeAnythingIsMade() async throws {
        let writer = FakeWriter()
        await writer.set(refusal: "This family folder is read only on this phone.")
        let rows = journal()
        await #expect(throws: SaveRefused.self) {
            _ = try await SaveRun.start(writer: writer, targets: [opened("fam")], results: [.known(size: 1)], signing: own, journal: rows)
        }
        #expect(rows.list().isEmpty)
        #expect(await writer.uploads.isEmpty)
    }

    @Test func aRunThatDoesNotFitIsRefusedByTheCoresEstimateAndOneThatFitsExactlyStarts() async throws {
        let results: [PlannedResult] = [.known(size: 5_000_000), .fromSources(sourcesSize: 2_000_000)]
        let needed = try runEstimate(results: results)
        let short = FakeWriter(free: Int64(needed) - 1)
        do {
            _ = try await SaveRun.start(writer: short, targets: [opened("f")], results: results, signing: own, journal: journal())
            Issue.record("started without room")
        } catch let refused as SaveRefused {
            #expect(refused.reason == .noRoom)
            #expect(refused.needed == needed)
            #expect(refused.free == Int64(needed) - 1)
        }
        let rows = journal()
        let run = try await SaveRun.start(writer: FakeWriter(free: Int64(needed)), targets: [opened("f")], results: results, signing: own, journal: rows)
        #expect(rows.list().map(\.id) == [run.id])
    }

    @Test func eachResultTakesTheNextFreeNameAndNeverReplaces() async throws {
        let writer = FakeWriter()
        await writer.set(names: ["report.pdf", "Report (2).pdf"])
        let run = try await SaveRun.start(writer: writer, targets: [opened("f")], results: [], signing: own, journal: journal())
        _ = try await run.file(Data([1]), name: "report.pdf", mime: nil)
        _ = try await run.file(Data([1]), name: "REPORT.pdf", mime: nil)
        let uploads = await writer.uploads
        #expect(uploads.map(\.name) == ["report (3).pdf", "REPORT (4).pdf"])
        #expect(uploads.allSatisfy { $0.replacing == nil })
    }

    @Test func aVersionSomeoneElseBeatIsStaleAndTheRunGoesOn() async throws {
        let writer = FakeWriter()
        await writer.answer { _ in throw SaveStale(currentVersionId: "v-theirs") }
        let rows = journal()
        let doc = opened("doc", parent: "f", version: "v1")
        let run = try await SaveRun.start(writer: writer, targets: [doc], results: [.known(size: 1)], signing: own, journal: rows)
        let saved = try await run.version(Data([1]), of: doc, in: opened("f"), startedFrom: "v1")
        #expect(saved == .stale(currentVersionId: "v-theirs"))
        #expect(await writer.uploads.first?.startedFrom == "v1")
        // The file is never the run's to delete, and the run is not stopped.
        #expect(rows.list().first?.nodeIds == [])
        _ = try await run.file(Data([2]), name: "after.txt", mime: nil)
        try await run.finish()
        #expect(await writer.trashed.isEmpty)
        #expect(rows.list().isEmpty)
    }

    @Test func aCancelDeletesForeverWhatWasPublishedAndTheRowGoes() async throws {
        let writer = FakeWriter()
        let rows = journal()
        let run = try await SaveRun.start(writer: writer, targets: [opened("f")], results: [], signing: own, journal: rows)
        _ = try await run.file(Data([1]), name: "a", mime: nil)
        #expect(rows.list().first?.nodeIds == ["node-1"])
        #expect(await run.cancel() == .deleted)
        #expect(await writer.trashed == [["node-1"]])
        #expect(await writer.purged == [["node-1"]])
        #expect(rows.list().isEmpty)
        await #expect(throws: SaveRunStopped.self) { _ = try await run.file(Data([1]), name: "b", mime: nil) }
    }

    @Test func aNoRoomInSomeoneElsesShareStopsTheRunUnfiguredAndOnlyTrashes() async throws {
        let writer = FakeWriter(free: nil)
        await writer.set(member: false)
        await writer.answer { _ in }
        await writer.answer { _ in throw DriveAPIError.server(402, "There isn’t enough room. 12 MB free.") }
        let rows = journal()
        let run = try await SaveRun.start(writer: writer, targets: [opened("shared")], results: [.known(size: 1 << 50)], signing: own, journal: rows)
        _ = try await run.file(Data([1]), name: "a", mime: nil)
        do {
            _ = try await run.file(Data([1]), name: "b", mime: nil)
            Issue.record("a 402 went unnoticed")
        } catch let stopped as SaveRunStopped {
            #expect(stopped.reason == .noRoom)
            // The owner's free space the server named is never passed on.
            #expect(stopped.message == SaveRuns.noRoomShared)
            #expect(stopped.cleanup == .trashed)
        }
        #expect(await writer.trashed == [["node-1", "node-2"]])
        #expect(await writer.purged.isEmpty)
        #expect(await writer.aborted == ["up-2"])
        #expect(rows.list().isEmpty)
    }

    @Test func aFolderTheRunMadeGoesAsOne() async throws {
        let writer = FakeWriter()
        let rows = journal()
        let run = try await SaveRun.start(writer: writer, targets: [opened("f")], results: [], signing: own, journal: rows)
        let made = try await run.folder("Archive")
        _ = try await run.file(Data([1]), name: "inside.txt", mime: nil, in: made)
        #expect(rows.list().first?.nodeIds == [made.id])
        _ = await run.cancel()
        #expect(await writer.trashed == [[made.id]])
    }

    @Test func aKeyChangeStillWalkingTheFolderIsWaitedOutNotFailed() async throws {
        let writer = FakeWriter()
        await writer.answer { _ in throw DriveAPIError.rotating("Finishing a key change…") }
        let run = try await SaveRun.start(writer: writer, targets: [opened("fam")], results: [], signing: own, journal: journal(), pause: { _ in })
        let landed = try await run.file(Data([1]), name: "a", mime: nil)
        #expect(landed.id == "node-2")
        #expect(await writer.uploads.count == 2)
    }

    @Test func aCleanUpThatCannotReachTheServerKeepsTheRowAndTheNextLaunchFindsIt() async throws {
        let writer = FakeWriter()
        await writer.set(trashFails: true)
        let rows = journal()
        let run = try await SaveRun.start(writer: writer, targets: [opened("f")], results: [], signing: own, journal: rows)
        _ = try await run.file(Data([1]), name: "a", mime: nil)
        #expect(await run.cancel() == .left)
        #expect(rows.list().map(\.nodeIds) == [["node-1"]])
        // This launch's own row is not interrupted; another launch's is.
        #expect(SaveRuns.interrupted(rows).isEmpty)
        var other = rows.list()[0]
        other = SaveRunRow(id: "other", workspaceId: "ws", nodeIds: ["node-x"], uploadIds: ["up-x"], at: Date(), launch: "an-earlier-launch")
        rows.put(other)
        #expect(SaveRuns.interrupted(rows).map(\.id) == ["other"])
        await writer.set(trashFails: false)
        #expect(await SaveRuns.cleanUp(other, writer: writer, journal: rows) == .deleted)
        #expect(await writer.aborted == ["up-x"])
        #expect(await writer.purged.last == ["node-x"])
        #expect(!rows.list().contains { $0.id == "other" })
    }

    @Test func aResultOfSeveralSourcesIsSignedAsTheirWeakest() throws {
        let signing = try SaveRuns.signing(sources: [(.verified, .verified), (.verified, .unknownSigner), (.savedFromLink, .verified)])
        #expect(signing.metadata == .copy(.savedFromLink))
        #expect(signing.version == .copy(.unknownSigner))
        #expect(throws: (any Error).self) { _ = try SaveRuns.signing(sources: []) }
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

        /*
         * Saved from G (the owner's own, verified) and F (planted by a stranger): the result's records are
         * re-sealed, as the server checks the signatures, and its one chunk holds the bytes given. With G
         * alone, they are ordinary. Fails if a result launders F's mark, or if memory is not what was sent.
         */
        @Test func aResultFromAnUnverifiedSourceIsResealedAndHoldsItsBytes() async throws {
            let server = try FakeDrive()
            let vault = try await vault(server)
            let a = try await vault.children(of: server.root).first { $0.id == server.a }!
            let f = try await vault.children(of: server.a).first { $0.id == server.f }!
            let g = try await vault.children(of: server.b).first { $0.id == server.g }!
            let trusted = try server.ownerTrusts()
            let verdicts = { (item: Opened) in (trusted.metadata(of: item.node), trusted.version(item.node.currentVersion!, of: item.node)) }
            #expect(verdicts(g) == (.verified, .verified))

            let bytes = Data("tool output".utf8)
            let mixed = try await vault.uploadResult(bytes, name: "f.txt", mime: "text/plain", in: a.id, replacing: nil, startedFrom: nil,
                                                     signing: try SaveRuns.signing(sources: [verdicts(g), verdicts(f)]))
            #expect(server.statements[mixed.id] == "resealed")
            #expect(server.statements["version:" + mixed.node.currentVersion!.id] == "resealed")
            let clean = try await vault.uploadResult(bytes, name: "g copy.txt", mime: "text/plain", in: a.id, replacing: nil, startedFrom: nil,
                                                     signing: try SaveRuns.signing(sources: [verdicts(g)]))
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

        /*
         * A new version of G whose work started at an older version: stale before anything is begun. One
         * that started at G's version while another device saved since: refused at begin, and stale with
         * the version current now. Fails if either lands as a version over theirs.
         */
        @Test func aNewVersionThatLostTheRaceIsStaleNeverAVersionOverTheirs() async throws {
            let server = try FakeDrive()
            let vault = try await vault(server)
            let b = try await vault.children(of: server.root).first { $0.id == server.b }!
            let g = try await vault.children(of: server.b).first { $0.id == server.g }!
            let current = g.node.currentVersion!.id
            await #expect(throws: SaveStale(currentVersionId: current)) {
                _ = try await vault.uploadResult(Data([1]), name: g.name, mime: nil, in: b.id, replacing: g, startedFrom: "an-older-version", signing: (.own, .own))
            }
            #expect(server.begins.isEmpty)

            // Another device saves first: the server holds a newer version than this phone listed.
            let theirs = VersionView(id: UUID().uuidString.lowercased(), objectId: "o", contentKeyEnvelope: g.node.currentVersion!.contentKeyEnvelope,
                                     status: "ready", contentSuite: 3, chunkCount: 1, contentNonce: "", plaintextSize: nil, ciphertextSize: nil, readyAt: nil)
            let old = try #require(server.nodes[server.g])
            var newer = NodeView(id: old.id, workspaceId: old.workspaceId, parentId: old.parentId, kind: old.kind, keyEpoch: old.keyEpoch,
                                 parentKeyEpoch: old.parentKeyEpoch, keyEnvelope: old.keyEnvelope, metadataVersion: old.metadataVersion,
                                 metadataEnvelope: old.metadataEnvelope, currentVersion: theirs, trashedAt: nil,
                                 changeSeq: (old.changeSeq ?? 0) + 1, createdAt: nil, updatedAt: nil)
            newer.metadataSigner = old.metadataSigner
            newer.metadataSignature = old.metadataSignature
            server.nodes[server.g] = newer
            await #expect(throws: SaveStale(currentVersionId: theirs.id)) {
                _ = try await vault.uploadResult(Data([1]), name: g.name, mime: nil, in: b.id, replacing: g, startedFrom: current, signing: (.own, .own))
            }
            #expect(server.completed.isEmpty)
            #expect(server.nodes[server.g]?.currentVersion?.id == theirs.id)
        }
    }
}
