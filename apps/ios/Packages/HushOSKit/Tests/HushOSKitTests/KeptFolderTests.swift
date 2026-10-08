import Foundation
import Testing
@testable import HushOSKit

/*
 * A kept folder's files: one that keeps failing waits longer each time instead of failing
 * every sync, and never takes the rest with it; copies kept from a share that was stopped go.
 */
/* Every suite that writes the shared kept-files store runs one test at a time, together. */
@Suite(.serialized) enum OfflineStore {}

extension OfflineStore {
@Suite struct KeptFolderTests {
    func opened(_ id: String, folder: Bool = false, workspace: String = "own") -> Opened {
        let node = NodeView(id: id, workspaceId: workspace, parentId: "p", kind: folder ? "folder" : "file", keyEpoch: 1, parentKeyEpoch: 1,
                            keyEnvelope: "", metadataVersion: 1, metadataEnvelope: "", currentVersion: nil, trashedAt: nil,
                            changeSeq: 1, createdAt: nil, updatedAt: nil)
        return Opened(node: node, metadata: NodeMetadata(name: id, mime: nil, size: 3, modified: nil), nodeKey: nil)
    }

    @Test func aFailingFileWaitsLongerEachTimeUpToAnHour() {
        Offline.forgetAll()
        let start = Date(timeIntervalSince1970: 1_000_000)
        let first = Offline.recordKeepFailure("f1", folder: "k", reason: "Couldn’t reach HushOS.", now: start)
        #expect(first.attempts == 1)
        #expect(first.retryAt == start.addingTimeInterval(30))
        #expect(!Offline.isKeepDue("f1", now: start.addingTimeInterval(29)))
        #expect(Offline.isKeepDue("f1", now: start.addingTimeInterval(30)))
        let second = Offline.recordKeepFailure("f1", folder: "k", reason: "Again.", now: start)
        #expect(second.retryAt == start.addingTimeInterval(60))
        #expect(second.reason == "Again.")
        for _ in 0 ..< 20 { Offline.recordKeepFailure("f1", folder: "k", reason: "x", now: start) }
        #expect(Offline.keepFailures()["f1"]?.retryAt == start.addingTimeInterval(3600))
        Offline.forgetAll()
    }

    @Test func oneFailureLeavesTheRestOfTheFolderKeptAndClearsWhenTheFileComesDown() {
        Offline.forgetAll()
        Offline.rememberFolder(opened("k", folder: true))
        Offline.remember(opened("ok-1"), folder: "k")
        Offline.recordKeepFailure("bad", folder: "k", reason: "Couldn’t update the copy.")
        #expect(Offline.isFolderKept("k"))
        #expect(Offline.isKept("ok-1"))
        #expect(Offline.keepFailures(in: "k").map(\.fileId) == ["bad"])
        // Files never failed are always due; the failed one comes down later and its failure goes.
        #expect(Offline.isKeepDue("ok-1"))
        Offline.remember(opened("bad"), folder: "k")
        #expect(Offline.keepFailures(in: "k").isEmpty)
        #expect(Offline.isKeepDue("bad"))
        Offline.forgetAll()
    }

    @Test func removingTheFolderForgetsItsFailures() {
        Offline.forgetAll()
        Offline.rememberFolder(opened("k", folder: true))
        Offline.recordKeepFailure("bad", folder: "k", reason: "x")
        Offline.recordKeepFailure("other", folder: "elsewhere", reason: "y")
        Offline.forgetFolder("k")
        #expect(Offline.keepFailures().keys.sorted() == ["other"])
        Offline.forgetAll()
    }

    @Test func aStoppedShareTakesItsKeptFolderAndFilesButNotOthers() {
        Offline.forgetAll()
        Offline.rememberFolder(opened("mine", folder: true, workspace: "own"))
        Offline.rememberFolder(opened("from-sam", folder: true, workspace: "sam"))
        Offline.rememberFolder(opened("from-priya", folder: true, workspace: "priya"))
        Offline.remember(opened("sam-file", workspace: "sam"), folder: "from-sam")
        Offline.remember(opened("sam-single", workspace: "sam"))
        Offline.remember(opened("own-file", workspace: "own"))
        Offline.remember(opened("priya-file", workspace: "priya"), folder: "from-priya")

        // Sam stopped sharing; Priya's share is still open.
        let removed = Offline.forgetUnshared(own: "own", shared: ["priya"])
        #expect(removed.map(\.id) == ["from-sam"])
        #expect(Offline.keptFolders().map(\.id).sorted() == ["from-priya", "mine"])
        #expect(Offline.entries().map(\.id).sorted() == ["own-file", "priya-file"])
        Offline.forgetAll()
    }
}
}
