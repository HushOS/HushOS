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
        ShareHandoff.claim(folder, pid: pid)
        let when = now.addingTimeInterval(-ago)
        try files.setAttributes([.modificationDate: when], ofItemAtPath: folder.appendingPathComponent("owner").path)
        try files.setAttributes([.modificationDate: when], ofItemAtPath: folder.path)
        return folder
    }

    @Test func plaintextAKilledSealLeftGoesOnceNothingOwnsIt() throws {
        let root = try root(), now = Date()
        let killed = try claimed(UUID().uuidString, in: root, pid: 202, ago: 600, now: now)
        // A marker written by hand or another tool, with a line end: still the process it names.
        let killedByHand = try folder(UUID().uuidString, in: root, file: "owner", ago: 600, now: now)
        try Data("202\n".utf8).write(to: killedByHand.appendingPathComponent("owner"))
        try files.setAttributes([.modificationDate: now.addingTimeInterval(-600)], ofItemAtPath: killedByHand.appendingPathComponent("owner").path)
        try files.setAttributes([.modificationDate: now.addingTimeInterval(-600)], ofItemAtPath: killedByHand.path)
        let abandoned = try folder(UUID().uuidString, in: root, ago: 2 * 86400, now: now)
        let noted = try folder(UUID().uuidString, in: root, file: "handoff.json", ago: 2 * 86400, now: now)
        let queuedId = UUID()
        let queued = try folder(queuedId.uuidString, in: root, ago: 2 * 86400, now: now)
        let records = root.appendingPathComponent("records.json")
        try Data("[]".utf8).write(to: records)

        ShareHandoff.sweepOrphans(keeping: [queuedId], now: now, in: root, running: { $0 == 101 })

        #expect(!exists(killed), "plaintext a killed seal left stayed on the phone")
        #expect(!exists(killedByHand), "an owner with a line end was taken for no owner")
        #expect(!exists(abandoned), "a folder nobody claimed stayed for days")
        #expect(exists(noted), "a note waiting to be adopted lost its parts")
        #expect(exists(queued), "a queued transfer lost its folder")
        #expect(exists(records))
    }

    /*
     * Save on a large file, then another app: iOS suspends the extension mid-seal and its folder,
     * holding the only copy of the file, goes unwritten for minutes. It must survive while its
     * process may still run, including one this process may not signal (EPERM).
     */
    @Test func aSuspendedSealKeepsTheOnlyCopy() throws {
        let root = try root(), now = Date()
        let suspended = try claimed(UUID().uuidString, in: root, pid: 101, ago: 600, now: now)
        let unclaimed = try folder(UUID().uuidString, in: root, ago: 600, now: now)
        ShareHandoff.sweepOrphans(keeping: [], now: now, in: root, running: { $0 == 101 })
        #expect(exists(suspended), "a suspended sheet's seal lost the only copy of its file")
        #expect(exists(unclaimed), "a folder of unknown owner went after minutes")

        // The real check: a process this one may not signal (launchd, EPERM) is not gone.
        let other = try self.root()
        let unsignalable = try claimed(UUID().uuidString, in: other, pid: 1, ago: 600, now: now)
        ShareHandoff.sweepOrphans(keeping: [], now: now, in: other)
        #expect(exists(unsignalable), "a seal whose process can't be signalled was taken for dead")

        // A process id the system has since given away: a day at most.
        let reused = try claimed(UUID().uuidString, in: root, pid: 101, ago: 2 * 86400, now: now)
        ShareHandoff.sweepOrphans(keeping: [], now: now, in: root, running: { $0 == 101 })
        #expect(!exists(reused))
    }

    /*
     * The queue writes its records before the notes and the part files go. The other way round, an
     * app killed in between left an upload with neither note nor record, and the sweep took it.
     */
    @Test func adoptingRecordsTheUploadBeforeItsNoteGoes() throws {
        let root = try root(), now = Date()
        let id = UUID()
        let folder = try folder(id.uuidString, in: root, file: "handoff.json", ago: 0, now: now)
        try Data("etag-a".utf8).write(to: folder.appendingPathComponent("etag-1"))
        try Data("etag-b".utf8).write(to: folder.appendingPathComponent("etag-2"))
        #expect(ShareHandoff.landedParts(id, in: root) == [1: "etag-a", 2: "etag-b"])
        // A part lands after the adoption read the others: its file is not the adoption's to remove.
        try Data("etag-c".utf8).write(to: folder.appendingPathComponent("etag-3"))

        // Records not written (the app died, the disk refused): nothing goes.
        #expect(!ShareHandoff.adopt([id: [1, 2]], in: root) { false })
        #expect(exists(folder.appendingPathComponent("handoff.json")))
        #expect(exists(folder.appendingPathComponent("etag-1")))

        var notePresentWhileRecording = false
        #expect(ShareHandoff.adopt([id: [1, 2]], in: root) {
            notePresentWhileRecording = exists(folder.appendingPathComponent("handoff.json")) && exists(folder.appendingPathComponent("etag-2"))
            return true
        })
        #expect(notePresentWhileRecording, "the note or its parts went before the records naming them were written")
        #expect(!exists(folder.appendingPathComponent("handoff.json")))
        #expect(!exists(folder.appendingPathComponent("etag-1")) && !exists(folder.appendingPathComponent("etag-2")))
        #expect(exists(folder.appendingPathComponent("etag-3")))
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

    @Test func onlyAProcessThatIsGoneCountsAsGone() {
        #expect(ShareHandoff.processRuns(getpid()))
        // launchd: there, but not this process's to signal (EPERM).
        #expect(ShareHandoff.processRuns(1))
        #expect(!ShareHandoff.processRuns(99_998))
        #expect(!ShareHandoff.processRuns(0))
    }
}
