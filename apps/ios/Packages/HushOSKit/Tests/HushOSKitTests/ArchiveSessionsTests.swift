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

    static func open(_ name: String) async throws -> OpenArchive {
        let (content, object) = try sealed(name)
        return try await OpenArchive.open(source: Sealed(object), content: content, watchdog: .seconds(30))
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
        #expect(!archive.unlocked)
        #expect(await code { try await archive.preview(secret, limit: 1024) } == "password")
    }

    @Test func signingOutWipesEveryOpenArchivesPassword() async throws {
        let archive = try await Self.open("aes.zip")
        #expect(try await archive.unlock("correct horse battery"))
        ArchiveSessions.closeAll()
        #expect(!archive.unlocked)
        let secret = try #require(archive.entries.first { $0.path == "secret.txt" })
        #expect(await code { try await archive.preview(secret, limit: 1024) } == "password")
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
        let stalled = Task { try await OpenArchive.open(source: Sealed(object, stall: true), content: content, watchdog: .seconds(30)) }
        try await Task.sleep(for: .milliseconds(200))
        let started = ContinuousClock.now
        stalled.cancel()
        await #expect(throws: ArchiveFailure.self) { try await stalled.value }
        #expect(ContinuousClock.now - started < .seconds(2))
    }

    @Test func theTreeListsFoldersFirstWithCountsAndLeavesMacFilesOut() {
        func entry(_ index: UInt32, _ path: String, directory: Bool = false, hidden: Bool = false) -> ArchiveEntry {
            ArchiveEntry(
                index: index, path: path, parts: path.split(separator: "/").map(String.init), directory: directory,
                size: 1, packed: 1, dos: 0, mtimeMillis: nil, lock: "none", support: "ok", link: false, nested: false,
                hidden: hidden, stored: false
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
                     "method", "encryption", "password", "wrong-password", "crc", "auth", "size", "ratio", "nested"] {
            #expect(ArchiveWords.refusals[code] != nil, "\(code)")
        }
        #expect(ArchiveWords.refusal("something new") == toolFailedMessage())
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
                                 mtimeMillis: nil, lock: "none", support: "ok", link: false, nested: false, hidden: false, stored: true)
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
