import Foundation
import Testing
@testable import HushOSKit

/*
 * Plaintext Save to HushOS leaves on the phone. An extension killed mid-seal leaves the shared
 * file in transfers/<id>/content with no note, which nothing adopts: it must go once nothing
 * owns it. A sheet still open must keep its staged copies however long it stays open.
 */
struct ShareSweepTests {
    private let files = FileManager.default

    private func root() throws -> URL {
        let root = files.temporaryDirectory.appendingPathComponent("sweep-\(UUID().uuidString)", isDirectory: true)
        try files.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    /* A folder with one file in it, both last changed `ago` seconds before `now`. */
    @discardableResult
    private func folder(_ name: String, in root: URL, file: String = "content", ago: TimeInterval, now: Date) throws -> URL {
        let folder = root.appendingPathComponent(name, isDirectory: true)
        try files.createDirectory(at: folder, withIntermediateDirectories: true)
        let inside = folder.appendingPathComponent(file)
        try Data("plaintext".utf8).write(to: inside)
        let when = now.addingTimeInterval(-ago)
        try files.setAttributes([.modificationDate: when], ofItemAtPath: inside.path)
        try files.setAttributes([.modificationDate: when], ofItemAtPath: folder.path)
        return folder
    }

    private func exists(_ url: URL) -> Bool { files.fileExists(atPath: url.path) }

    /* A staging folder claimed by `pid`, the claim and the folder as old as `ago`. */
    private func claimed(_ name: String, in root: URL, pid: Int32, ago: TimeInterval, now: Date) throws -> URL {
        let folder = try folder(name, in: root, ago: ago, now: now)
        ShareHandoff.claimStaging(folder, pid: pid)
        let when = now.addingTimeInterval(-ago)
        try files.setAttributes([.modificationDate: when], ofItemAtPath: folder.appendingPathComponent("owner").path)
        try files.setAttributes([.modificationDate: when], ofItemAtPath: folder.path)
        return folder
    }

    @Test func plaintextAKilledSealLeftGoesOnceNothingOwnsIt() throws {
        let root = try root(), now = Date()
        let orphan = try folder(UUID().uuidString, in: root, ago: 600, now: now)
        let noted = try folder(UUID().uuidString, in: root, file: "handoff.json", ago: 600, now: now)
        let queuedId = UUID()
        let queued = try folder(queuedId.uuidString, in: root, ago: 600, now: now)
        let sealing = try folder(UUID().uuidString, in: root, ago: 30, now: now)
        let records = root.appendingPathComponent("records.json")
        try Data("[]".utf8).write(to: records)

        ShareHandoff.sweepOrphans(keeping: [queuedId], now: now, in: root)

        #expect(!exists(orphan), "plaintext with no note and no transfer stayed on the phone")
        #expect(exists(noted), "a note waiting to be adopted lost its parts")
        #expect(exists(queued), "a queued transfer lost its folder")
        #expect(exists(sealing), "a seal still writing lost its folder")
        #expect(exists(records))
    }

    @Test func aSheetStillOpenKeepsItsCopiesHoweverLong() throws {
        let root = try root(), now = Date()
        let open = try claimed("open", in: root, pid: 101, ago: 2 * 3600, now: now)
        let closed = try claimed("closed", in: root, pid: 202, ago: 10, now: now)
        let forgotten = try claimed("forgotten", in: root, pid: 101, ago: 2 * 86400, now: now)
        let oldUnowned = try folder("old", in: root, ago: 2 * 3600, now: now)
        let newUnowned = try folder("new", in: root, ago: 600, now: now)

        ShareHandoff.sweepStaging(now: now, in: root, running: { $0 == 101 })

        #expect(exists(open), "an open sheet's copies went after an hour")
        #expect(!exists(closed), "a sheet whose process is gone kept its plaintext")
        #expect(!exists(forgotten), "a process id kept a folder for days")
        #expect(!exists(oldUnowned))
        #expect(exists(newUnowned))
    }

    @Test func thisProcessRunsAndAnUnusedIdDoesNot() {
        #expect(ShareHandoff.processRuns(getpid()))
        #expect(!ShareHandoff.processRuns(99_998))
    }
}
