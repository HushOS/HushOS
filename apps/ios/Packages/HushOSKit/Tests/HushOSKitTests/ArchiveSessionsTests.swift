import Foundation
import HushOSCore
import Testing
@testable import HushOSKit

/*
 * A zip open in the viewer: the core's session over a sealed fixture from e2e/fixtures/archives,
 * read through OpenArchive's calls (their own thread and control, no run slot), the password
 * held only until close or sign-out, and the list's folders as the web builds them.
 */
@Suite(.serialized) struct ArchiveSessionsTests {
    /* This file sits seven folders down from the checkout's root. */
    static let fixtures = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("e2e/fixtures/archives")

    /* A fixture sealed as an upload stores it, served by `fetch`. */
    final class Sealed: ObjectSource, @unchecked Sendable {
        let object: Data
        let stall: Bool
        init(_ object: Data, stall: Bool = false) { self.object = object; self.stall = stall }
        func fetch(range: ByteRange, drain: Bool) throws -> Data {
            if stall { Thread.sleep(forTimeInterval: 3600) }
            return object.subdata(in: Int(range.start) ..< Int(range.end) + 1)
        }
        func drainLater(ranges: [ByteRange]) {}
    }

    static func sealed(_ name: String) throws -> (Content, Data) {
        let plain = try Data(contentsOf: fixtures.appendingPathComponent(name))
        let size = UInt64(plain.count)
        let content = Content(
            workspaceId: "11111111-1111-4111-8111-111111111111", objectId: "66666666-6666-4666-8666-666666666666",
            suite: 3, key: try randomBytes(length: 32), nonce: try randomBytes(length: 16), plaintextSize: size, thumbnailBytes: 0
        )
        let layout = try contentLayout(suite: 3, plaintextSize: size, thumbnailBytes: 0)
        var object = Data()
        for index in 0 ..< layout.chunkCount {
            let start = Int(min(index * layout.chunkBytes, size))
            let length = Int(chunkLength(plaintextSize: size, index: index))
            object.append(try chunkEncrypt(content: content, index: index, plaintext: plain.subdata(in: start ..< start + length)))
        }
        return (content, object)
    }

    /* Not registered with a sign-out unless the test is about one: another suite's sign-out runs beside these. */
    static func open(_ name: String, registered: Bool = false) async throws -> OpenArchive {
        let (content, object) = try sealed(name)
        return try await OpenArchive.open(source: Sealed(object), content: content, watchdog: .seconds(30), registered: registered)
    }

    func code(_ work: () async throws -> some Any) async -> String? {
        do { _ = try await work(); return "ok" } catch { return (error as? ArchiveFailure)?.code }
    }

    @Test func aLockedEntryOpensOnlyWithTheRightPasswordAndNotAfterClose() async throws {
        let archive = try await Self.open("aes.zip")
        let secret = try #require(archive.entries.first { $0.path == "secret.txt" })
        #expect(secret.lock == "aes")
        #expect(await code { try await archive.preview(secret, limit: 1024) } == "password")
        #expect(try await archive.unlock("not it") == false)
        #expect(!archive.unlocked)
        #expect(try await archive.unlock("correct horse battery"))
        let text = String(decoding: try await archive.preview(secret, limit: 1024), as: UTF8.self)
        #expect(text.contains("AES-256, AE-2."))
        archive.close()
        ArchiveSessions.closeQueue.sync {}
        #expect(!archive.unlocked)
        // Closed, nothing reads: not the entry the password opened, not the one that needed none.
        await #expect(throws: ArchiveFailure(code: nil, message: "The archive was closed.")) { try await archive.preview(secret, limit: 1024) }
        let plain = try #require(archive.entries.first { $0.path == "plain.txt" })
        await #expect(throws: ArchiveFailure(code: nil, message: "The archive was closed.")) { try await archive.preview(plain, limit: 1024) }
    }

    /* A zip as a copy the phone keeps: bytes read by range, a read that can be made to hang. */
    final class Kept: LocalSource, @unchecked Sendable {
        let bytes: Data
        var stall = false
        var reads = 0
        init(_ bytes: Data) { self.bytes = bytes }
        func size() -> UInt64 { UInt64(bytes.count) }
        func readAt(offset: UInt64, length: UInt64) throws -> Data {
            reads += 1
            if stall { Thread.sleep(forTimeInterval: 5) }
            return bytes.subdata(in: Int(offset) ..< Int(offset + length))
        }
    }

    @Test func aKeptCopyOpensWithoutTheStoreAndItsPasswordWorks() async throws {
        let kept = Kept(try Data(contentsOf: Self.fixtures.appendingPathComponent("aes.zip")))
        let archive = try await OpenArchive.open(local: kept, watchdog: .seconds(30), registered: false)
        #expect(archive.kept)
        let secret = try #require(archive.entries.first { $0.path == "secret.txt" })
        #expect(try await archive.unlock("correct horse battery"))
        #expect(String(decoding: try await archive.preview(secret, limit: 1024), as: UTF8.self).contains("AES-256, AE-2."))
        #expect(kept.reads > 0)
    }

    @Test func closingCancelsTheArchivesCallsAtOnce() async throws {
        let kept = Kept(try Data(contentsOf: Self.fixtures.appendingPathComponent("basic.zip")))
        let archive = try await OpenArchive.open(local: kept, watchdog: .seconds(30), poll: .milliseconds(50), registered: false)
        let readme = try #require(archive.entries.first { $0.path == "docs/readme.txt" })
        kept.stall = true
        let reading = Task { try await archive.preview(readme, limit: 1024) }
        while archive.running == 0 { try await Task.sleep(for: .milliseconds(10)) }
        let started = ContinuousClock.now
        archive.close()
        await #expect(throws: ArchiveFailure.self) { try await reading.value }
        #expect(ContinuousClock.now - started < .seconds(2))
    }

    @Test func aDownloadRunsOnASiblingWithTheParentsPasswordWhileTheParentPreviews() async throws {
        // A kept copy whose reads the test can hold: the download's reader hangs, the parent's doesn't.
        final class Gated: LocalSource, @unchecked Sendable {
            let bytes: Data
            let gate = DispatchSemaphore(value: 0)
            var holdFrom = Int.max
            var reads = 0
            let lock = NSLock()
            init(_ bytes: Data) { self.bytes = bytes }
            func size() -> UInt64 { UInt64(bytes.count) }
            func readAt(offset: UInt64, length: UInt64) throws -> Data {
                let hold = lock.withLock { reads += 1; return reads >= holdFrom }
                if hold { gate.wait() }
                return bytes.subdata(in: Int(offset) ..< Int(offset + length))
            }
        }
        let kept = Gated(try Data(contentsOf: Self.fixtures.appendingPathComponent("aes.zip")))
        let archive = try await OpenArchive.open(local: kept, watchdog: .seconds(30), registered: false)
        let secret = try #require(archive.entries.first { $0.path == "secret.txt" })
        let other = try #require(archive.entries.first { $0.path == "secret-ae1.txt" })
        #expect(try await archive.unlock("correct horse battery"))
        // The next read (the sibling's, for the download) waits on the gate.
        kept.lock.withLock { kept.holdFrom = kept.reads + 1 }
        final class Collected: @unchecked Sendable { var data = Data() }
        let collected = Collected()
        let downloading = Task { try await archive.download(secret, into: ArchiveSink { collected.data.append($0) }) }
        while archive.downloading == 0 || archive.running == 0 { try await Task.sleep(for: .milliseconds(10)) }
        try await Task.sleep(for: .milliseconds(100))
        // The parent previews a locked entry with its own password while the sibling's download is held.
        kept.lock.withLock { kept.holdFrom = .max }
        let text = String(decoding: try await archive.preview(other, limit: 1024), as: UTF8.self)
        #expect(text.contains("AES-256, AE-1."))
        // Released, the sibling reads the locked entry with the password it took from the parent.
        kept.gate.signal()
        try await downloading.value
        #expect(String(decoding: collected.data, as: UTF8.self).contains("AES-256, AE-2."))
        ArchiveSessions.closeQueue.sync {}
        #expect(archive.downloading == 0)
    }

    @Test func closingTheArchiveClosesASiblingMidDownload() async throws {
        let kept = Kept(try Data(contentsOf: Self.fixtures.appendingPathComponent("basic.zip")))
        let archive = try await OpenArchive.open(local: kept, watchdog: .seconds(30), poll: .milliseconds(50), registered: false)
        let readme = try #require(archive.entries.first { $0.path == "docs/readme.txt" })
        kept.stall = true
        let downloading = Task { try await archive.download(readme, into: ArchiveSink { _ in }) }
        while archive.downloading == 0 || archive.running == 0 { try await Task.sleep(for: .milliseconds(10)) }
        let started = ContinuousClock.now
        archive.close()
        await #expect(throws: ArchiveFailure.self) { try await downloading.value }
        #expect(ContinuousClock.now - started < .seconds(2))
        #expect(archive.downloading == 0)
    }

    @Test func aDownloadStartedWhileTheArchiveClosesGetsNoSiblingAndReadsNothing() async throws {
        let kept = Kept(try Data(contentsOf: Self.fixtures.appendingPathComponent("basic.zip")))
        let archive = try await OpenArchive.open(local: kept, watchdog: .seconds(30), poll: .milliseconds(50), registered: false)
        let readme = try #require(archive.entries.first { $0.path == "docs/readme.txt" })
        // The core's close waits on its queue: the session is still open, as it is in the moment after close() returns.
        ArchiveSessions.closeQueue.suspend()
        archive.close()
        let before = kept.reads
        final class Collected: @unchecked Sendable { var bytes = 0 }
        let collected = Collected()
        await #expect(throws: ArchiveFailure.self) {
            try await archive.download(readme, into: ArchiveSink { collected.bytes += $0.count })
        }
        // No sibling left open, nothing read for it, nothing written.
        #expect(archive.downloading == 0)
        #expect(kept.reads == before)
        #expect(collected.bytes == 0)
        ArchiveSessions.closeQueue.resume()
        ArchiveSessions.closeQueue.sync {}
    }

    @Test func aZipKeptOnThePhoneOpensFromItsCopyAlone() async throws {
        // The copy as Offline keeps it: a file on the phone, read by range, with no vault and no store.
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let file = folder.appendingPathComponent("aes.zip")
        try FileManager.default.copyItem(at: Self.fixtures.appendingPathComponent("aes.zip"), to: file)
        let archive = try await OpenArchive.openKept(file)
        defer { archive.close() }
        #expect(archive.kept)
        let secret = try #require(archive.entries.first { $0.path == "secret.txt" })
        #expect(try await archive.unlock("correct horse battery", entry: secret))
        #expect(String(decoding: try await archive.preview(secret, limit: 1024), as: UTF8.self).contains("AES-256, AE-2."))
        // Nothing beside the copy: the folder holds the zip and no plaintext of its entries.
        #expect(try FileManager.default.contentsOfDirectory(atPath: folder.path) == ["aes.zip"])
    }

    @Test func anEntrysOwnPasswordIsTriedOnThatEntryFirst() async throws {
        let archive = try await Self.open("zipcrypto-empty.zip")
        let secret = try #require(archive.entries.first { $0.path == "secret.txt" })
        #expect(try await archive.unlock("not it", entry: secret) == false)
        #expect(try await archive.unlock("correct horse battery", entry: secret))
        #expect(String(decoding: try await archive.preview(secret, limit: 1024), as: UTF8.self).contains("ZipCrypto"))
    }

    @Test func signingOutWipesEveryOpenArchivesPassword() async throws {
        let archive = try await Self.open("aes.zip", registered: true)
        #expect(try await archive.unlock("correct horse battery"))
        ArchiveSessions.closeAll()
        ArchiveSessions.closeQueue.sync {}
        #expect(!archive.unlocked)
        let secret = try #require(archive.entries.first { $0.path == "secret.txt" })
        #expect(await code { try await archive.preview(secret, limit: 1024) } == nil)
    }

    @Test func aBombIsRefusedInItsOwnWordsAndAPreviewIsHeldToItsLimit() async throws {
        let bomb = try await Self.open("declares-1k.zip")
        let small = try #require(bomb.entries.first)
        do {
            _ = try await bomb.preview(small, limit: 1 << 20)
            Issue.record("the bomb was read")
        } catch let failure as ArchiveFailure {
            #expect(failure.code == "size")
            #expect(failure.message == ArchiveWords.refusals["size"])
        }
        let damaged = try await Self.open("stored-bad-crc.zip")
        do {
            _ = try await damaged.preview(try #require(damaged.entries.first), limit: 1 << 20)
            Issue.record("a bad checksum was shown")
        } catch let failure as ArchiveFailure {
            #expect(failure.code == "crc")
        }
        let basic = try await Self.open("basic.zip")
        let readme = try #require(basic.entries.first { $0.path == "docs/readme.txt" })
        #expect(await code { try await basic.preview(readme, limit: 10) } == "too-large")
    }

    @Test func anEntryDownloadsIntoTheSinkByteForByte() async throws {
        let archive = try await Self.open("basic.zip")
        let readme = try #require(archive.entries.first { $0.path == "docs/readme.txt" })
        final class Collected: @unchecked Sendable { var data = Data() }
        let collected = Collected()
        try await archive.download(readme, into: ArchiveSink { collected.data.append($0) })
        #expect(String(decoding: collected.data, as: UTF8.self) == "Read me. This entry is deflated.\nHUSHOS-CANARY-ZIP-5b1e9c\n")
    }

    @Test func aCallStalledOnTheStoreEndsAtOnceWhenItsTaskIsCancelled() async throws {
        let (content, object) = try Self.sealed("basic.zip")
        // An archive over a store that never answers: its first read is the directory's.
        let stalled = Task { try await OpenArchive.open(source: Sealed(object, stall: true), content: content, watchdog: .seconds(30), registered: false) }
        try await Task.sleep(for: .milliseconds(200))
        let started = ContinuousClock.now
        stalled.cancel()
        await #expect(throws: ArchiveFailure.self) { try await stalled.value }
        #expect(ContinuousClock.now - started < .seconds(2))
    }

    @Test func textIsShownInPiecesBoundedByLinesAndBytes() {
        let many = Data((0 ..< 450).map { "line \($0)" }.joined(separator: "\n").utf8)
        let pieces = ArchiveText.pieces(many)
        #expect(pieces.count == 3)
        #expect(pieces.allSatisfy { $0.split(separator: "\n", omittingEmptySubsequences: false).count <= ArchiveText.lines })
        #expect(pieces.joined(separator: "\n") == String(decoding: many, as: UTF8.self))
        // One line of 100 KB, with no line end to cut at, is still cut, between characters.
        let long = Data(String(repeating: "é", count: 50_000).utf8)
        let cut = ArchiveText.pieces(long)
        #expect(cut.allSatisfy { $0.utf8.count <= ArchiveText.bytes })
        #expect(cut.joined(separator: "\n").replacingOccurrences(of: "\n", with: "") == String(decoding: long, as: UTF8.self))
    }

    @Test func aDeepPathCostsItsPartsNotItsPrefixes() {
        // 256 parts deep (the core's cap): every folder on the way, one child each.
        let parts = (0 ..< 255).map { "d\($0)" } + ["z"]
        let deep = ArchiveEntry(index: 0, path: parts.joined(separator: "/"), parts: parts, directory: false, size: 1, packed: 1,
                                dos: 0, mtimeMillis: nil, lock: "none", support: "ok", link: false, nested: false, hidden: false,
                                stored: true, saveName: "z")
        let tree = ArchiveTree([deep])
        #expect(tree.rows(at: []) == [.folder(name: "d0", count: 1)])
        #expect(tree.rows(at: Array(parts.dropLast())).map(\.name) == ["z"])
    }

    @Test func theTreeListsFoldersFirstWithCountsAndLeavesMacFilesOut() {
        func entry(_ index: UInt32, _ path: String, directory: Bool = false, hidden: Bool = false) -> ArchiveEntry {
            ArchiveEntry(
                index: index, path: path, parts: path.split(separator: "/").map(String.init), directory: directory,
                size: 1, packed: 1, dos: 0, mtimeMillis: nil, lock: "none", support: "ok", link: false, nested: false,
                hidden: hidden, stored: false, saveName: path.split(separator: "/").last.map(String.init) ?? path
            )
        }
        let tree = ArchiveTree([
            entry(0, "z.txt"),
            entry(1, "docs/", directory: true),
            entry(2, "docs/readme.txt"),
            entry(3, "docs/notes/todo.md"),
            entry(4, "__MACOSX/._z.txt", hidden: true),
            entry(5, "a.txt"),
            entry(6, "empty/", directory: true),
        ])
        #expect(tree.rows(at: []).map(\.name) == ["docs", "empty", "a.txt", "z.txt"])
        #expect(tree.rows(at: []).first == .folder(name: "docs", count: 2))
        #expect(tree.rows(at: ["empty"]).isEmpty)
        // A folder no entry names but a deeper path implies.
        #expect(tree.rows(at: ["docs", "notes"]).map(\.name) == ["todo.md"])
        #expect(!tree.rows(at: []).contains { $0.name == "__MACOSX" })
    }

    @Test func everyRefusalTheListShowsHasTheWebsWords() {
        // The codes archive.rs sends that reach the person (directory, link and too-large are drawn, never said).
        for code in ["damaged", "directory-too-large", "too-many-entries", "encrypted-directory", "split", "overlap", "local",
                     "method", "encryption", "password", "wrong-password", "crc", "auth", "size", "short", "ratio", "nested",
                     "link", "directory", "too-large"] {
            #expect(ArchiveWords.refusals[code] != nil, "\(code)")
        }
        #expect(ArchiveWords.refusal("something new") == toolFailedMessage())
        // An item's damage is the item's, not the archive's, which still lists.
        #expect(ArchiveWords.refusal("damaged", scope: .entry) == "This item is damaged, or isn’t something HushOS can read.")
        #expect(ArchiveWords.refusal("damaged") == "This archive is damaged, or isn’t a zip archive HushOS can read.")
        #expect(ArchiveWords.refusal("crc", scope: .entry) == ArchiveWords.refusal("crc"))
    }

    @Test func theCardOffersContinuePastTheThresholdAndOnlyDownloadPastTheCeiling() {
        let limits = PreviewLimits(threshold: 100, ceiling: 300)
        #expect(ArchiveEntries.stage(size: 100, limits: limits) == .fine)
        #expect(ArchiveEntries.stage(size: 101, limits: limits) == .offer)
        #expect(ArchiveEntries.stage(size: 300, limits: limits) == .offer)
        #expect(ArchiveEntries.stage(size: 301, limits: limits) == .ceiling)
        #expect(ArchiveEntries.stage(size: 301, limits: PreviewLimits(threshold: nil, ceiling: 400)) == .fine)
        // A phone of 3 GB gets half the image ceiling a 6 GB one does.
        #expect(ArchiveEntries.limits(.image, memory: 3 << 30).ceiling * 2 == ArchiveEntries.limits(.image, memory: 6 << 30).ceiling)
    }

    @Test func aZipEntrysDateIsItsUnixTimeOrItsDosDateAsLocalTime() {
        var entry = ArchiveEntry(index: 0, path: "a", parts: ["a"], directory: false, size: 0, packed: 0,
                                 dos: (UInt32((2026 - 1980) << 9 | 11 << 5 | 3) << 16) | UInt32(14 << 11 | 30 << 5),
                                 mtimeMillis: nil, lock: "none", support: "ok", link: false, nested: false, hidden: false, stored: true, saveName: "a")
        let calendar = Calendar(identifier: .gregorian)
        let parts = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: ArchiveEntries.date(entry, calendar: calendar)!)
        #expect([parts.year, parts.month, parts.day, parts.hour, parts.minute] == [2026, 11, 3, 14, 30])
        entry.mtimeMillis = 1_000
        #expect(ArchiveEntries.date(entry) == Date(timeIntervalSince1970: 1))
        entry.mtimeMillis = nil
        entry.dos = 0
        #expect(ArchiveEntries.date(entry) == nil)
    }
}
