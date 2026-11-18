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
        ArchiveSessions.closeQueue.sync(flags: .barrier) {}
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

    @Test func aCancelledCallKeepsItsTurnUntilItsThreadEnds() async throws {
        // A read the core can't interrupt holds its session's lock past the cancel: the next call waits for the turn, not on its watchdog.
        final class Slow: LocalSource, @unchecked Sendable {
            let bytes: Data
            let lock = NSLock()
            var slow = false
            init(_ bytes: Data) { self.bytes = bytes }
            func size() -> UInt64 { UInt64(bytes.count) }
            func readAt(offset: UInt64, length: UInt64) throws -> Data {
                if lock.withLock({ slow }) { Thread.sleep(forTimeInterval: 1.2) }
                return bytes.subdata(in: Int(offset) ..< Int(offset + length))
            }
        }
        let kept = Slow(try Data(contentsOf: Self.fixtures.appendingPathComponent("basic.zip")))
        let archive = try await OpenArchive.open(local: kept, watchdog: .milliseconds(600), poll: .milliseconds(50), registered: false)
        let readme = try #require(archive.entries.first { $0.path == "docs/readme.txt" })
        kept.lock.withLock { kept.slow = true }
        let first = Task { try await archive.preview(readme, limit: 1024) }
        while archive.running == 0 { try await Task.sleep(for: .milliseconds(10)) }
        try await Task.sleep(for: .milliseconds(100))
        let started = ContinuousClock.now
        first.cancel()
        await #expect(throws: ArchiveFailure.self) { try await first.value }
        // The caller hears at once.
        #expect(ContinuousClock.now - started < .milliseconds(500))
        kept.lock.withLock { kept.slow = false }
        // Asked at once: its 600 ms watchdog starts only once the first call's thread let go.
        let text = String(decoding: try await archive.preview(readme, limit: 1024), as: UTF8.self)
        #expect(text.contains("Read me. This entry is deflated."))
        archive.close()
    }

    @Test func aStoreRefusalOfTheSessionIsSaidAsItselfWithItsSession() async throws {
        let (content, _) = try Self.sealed("basic.zip")
        let source = ArchiveSource(drainLater: { _ in }) { _ in throw DriveAPIError.notAuthenticated(session: "session-1") }
        do {
            _ = try await OpenArchive.open(source: source, content: content, watchdog: .seconds(30), registered: false)
            Issue.record("opened without the store")
        } catch {
            // Not the core's failure in words: the 401, with the session it was for, for the app's session check.
            #expect(endsSession(error))
            #expect(refusedSession(error) == "session-1")
        }
        // Any other failure of the store is still the archive's own.
        let failing = ArchiveSource(drainLater: { _ in }) { _ in throw DriveAPIError.server(500, "Down") }
        do {
            _ = try await OpenArchive.open(source: failing, content: content, watchdog: .seconds(30), registered: false)
            Issue.record("opened without the store")
        } catch {
            #expect(!endsSession(error))
            #expect(error is ArchiveFailure)
        }
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
        ArchiveSessions.closeQueue.sync(flags: .barrier) {}
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
        ArchiveSessions.closeQueue.sync(flags: .barrier) {}
    }

    @Test func aZipKeptOnThePhoneOpensFromItsCopyAlone() async throws {
        // A sign-out of its own: another suite's, running beside it, never closes these archives mid-test.
        try await ArchiveSessions.$account.withValue(UUID().uuidString) {
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
    }

    @Test func anEntrysOwnPasswordIsTriedOnThatEntryFirst() async throws {
        let archive = try await Self.open("zipcrypto-empty.zip")
        let secret = try #require(archive.entries.first { $0.path == "secret.txt" })
        #expect(try await archive.unlock("not it", entry: secret) == false)
        #expect(try await archive.unlock("correct horse battery", entry: secret))
        #expect(String(decoding: try await archive.preview(secret, limit: 1024), as: UTF8.self).contains("ZipCrypto"))
    }

    @Test func aFamilyLetGoOfClosesItsArchiveAndWritesNothingMore() async throws {
        // A family's file, kept to its family folder as it stood when the open began.
        let workspace = UUID().uuidString.lowercased()
        let archive = try await Self.open("locked-ratio.zip")
        archive.gate = TemporaryCopies.copyGate(familyWorkspace: workspace)
        #expect(try await archive.unlock("correct horse battery"))
        let zeros = try #require(archive.entries.first)
        let pieces = Counter()
        let writing = DispatchSemaphore(value: 0)
        let forgot = DispatchSemaphore(value: 0)
        let atForget = Counter()
        // The family is let go of (a removal, a fork) from another thread once the first piece is written.
        DispatchQueue.global().async {
            writing.wait()
            TemporaryCopies.forgetFamily([workspace])
            for _ in 0 ..< pieces.value { _ = atForget.next() }
            forgot.signal()
        }
        await #expect(throws: ArchiveFailure(code: nil, message: FamilyWords.openAgain)) {
            try await archive.download(zeros, into: ArchiveSink { _ in
                // The second piece waits for the forget to finish (it can't while a piece is written under the lock):
                // a check made before the forget, with the write after it, would write this piece past the forget.
                if pieces.value == 1 { _ = forgot.wait(timeout: .now() + .milliseconds(300)) }
                if pieces.next() == 1 { writing.signal() }
            })
        }
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            DispatchQueue.global().async {
                _ = forgot.wait(timeout: .now() + .seconds(5))
                done.resume()
            }
        }
        // Nothing written after the forget returned.
        #expect(pieces.value == atForget.value)
        #expect(pieces.value >= 1)
        // The archive closed with it: its password gone, and every later call refused before it reads.
        ArchiveSessions.closeQueue.sync(flags: .barrier) {}
        #expect(!archive.unlocked)
        await #expect(throws: ArchiveFailure(code: nil, message: FamilyWords.openAgain)) { try await archive.preview(zeros, limit: 1024) }
    }

    @Test func aPasswordOnlyItsCheckBytePassedIsLetGoOfWhenItsItemReadsAsDamaged() async throws {
        // unproven.zip: "wrong 516" passes the one ZipCrypto check byte of an item an unlock can't inflate.
        let archive = try await Self.open("unproven.zip")
        #expect(try await archive.unlock("wrong 516"))
        let zeros = try #require(archive.entries.first)
        #expect(await code { try await archive.download(zeros, into: ArchiveSink { _ in }) } == "password-unproven")
        #expect(await code { try await archive.download(zeros, into: ArchiveSink { _ in }) } == "password")
        // Let go of on the archive, not only the download's sibling: every item asks again.
        #expect(!archive.unlocked)
        archive.close()
    }

    @Test func aTakenNameIsNumberedWithinAFileNamesBytes() {
        #expect(ArchiveSaveName.numbered("report.pdf", 2) == "report (2).pdf")
        #expect(ArchiveSaveName.numbered("README", 3) == "README (3)")
        #expect(ArchiveSaveName.numbered(".profile", 2) == ".profile (2)")
        // Save names at the limit: ASCII, three-byte characters, four-byte emoji, no extension, an extension past 32 bytes.
        let long = [
            String(repeating: "a", count: 251) + ".txt",
            String(repeating: "日", count: 83) + ".txt",
            String(repeating: "😀", count: 62) + ".md",
            String(repeating: "b", count: 255),
            String(repeating: "c", count: 200) + "." + String(repeating: "x", count: 54),
        ]
        for name in long {
            #expect(name.utf8.count <= 255)
            for n in [2, 10, 1_000] {
                let numbered = ArchiveSaveName.numbered(name, n)
                #expect(numbered.utf8.count <= 255, "\(n): \(numbered.utf8.count) bytes")
                #expect(numbered.contains(" (\(n))"))
                // The base is the name's start, cut between whole scalars.
                let base = numbered.components(separatedBy: " (\(n))")[0]
                #expect(name.hasPrefix(base) && !base.isEmpty)
            }
        }
        #expect(ArchiveSaveName.numbered(long[0], 2).hasSuffix(" (2).txt"))
        #expect(ArchiveSaveName.numbered(long[2], 10).hasSuffix(" (10).md"))
    }

    @Test func aStoppedDownloadKeepsAPasswordOnlyItsCheckBytePassed() async throws {
        // unproven.zip under the right password, which only its check byte proves: a stop is no damage.
        let archive = try await Self.open("unproven.zip")
        let zeros = try #require(archive.entries.first)
        #expect(try await archive.unlock("correct horse battery", entry: zeros))
        let wrote = Counter()
        let download = Task {
            try await archive.download(zeros, into: ArchiveSink { _ in
                _ = wrote.next()
                Thread.sleep(forTimeInterval: 0.3)
            })
        }
        for _ in 0 ..< 200 where wrote.value == 0 { try await Task.sleep(for: .milliseconds(10)) }
        download.cancel()
        let stopped = await download.result
        #expect(throws: (any Error).self) { try stopped.get() }
        #expect(archive.unlocked)
        // A sink that fails is the download's own end too.
        #expect(await code { try await archive.download(zeros, into: ArchiveSink { _ in throw CocoaError(.fileWriteOutOfSpace) }) } != "password-unproven")
        #expect(archive.unlocked)
        let written = Total()
        try await archive.download(zeros, into: ArchiveSink { chunk in written.add(chunk.count) })
        #expect(written.value == zeros.size)
        archive.close()
    }

    @Test func aZipAShareOpenedClosesWhenItsWorkspaceIsProvenAFamilys() async throws {
        // A sign-out of its own: another suite's, running beside it, never closes these archives mid-test.
        try await ArchiveSessions.$account.withValue(UUID().uuidString) {
            let workspace = UUID().uuidString.lowercased()
            // Opened through a share: nothing yet names its workspace a family's.
            let archive = try await Self.open("aes.zip", registered: true)
            try archive.mark(workspace, family: false)
            let secret = try #require(archive.entries.first { $0.path == "secret.txt" })
            #expect(try await archive.unlock("correct horse battery"))
            #expect(archive.serves)
            let heard = Counter()
            let listening = NotificationCenter.default.addObserver(forName: ArchiveSessions.familyClosed, object: nil, queue: nil) { note in
                if note.userInfo?["archive"] as? UUID == archive.identity { _ = heard.next() }
            }
            defer { NotificationCenter.default.removeObserver(listening) }
            // Route 25 proves it a family folder: the share's archive closes at once, idle, its key and password gone.
            ArchiveSessions.proveFamilies([workspace])
            ArchiveSessions.closeQueue.sync(flags: .barrier) {}
            #expect(!archive.unlocked)
            #expect(!archive.serves)
            await #expect(throws: ArchiveFailure.self) { try await archive.preview(secret, limit: 1024) }
            await #expect(throws: ArchiveFailure.self) { try await archive.download(secret, into: ArchiveSink { _ in }) }
            for _ in 0 ..< 50 where heard.value == 0 { try await Task.sleep(for: .milliseconds(20)) }
            #expect(heard.value == 1)
            // One opened from it by a share after the proof is refused as it is marked.
            let late = try await Self.open("aes.zip", registered: true)
            #expect(throws: ArchiveFailure.self) { try late.mark(workspace, family: false) }
            #expect(!late.serves)
            // Another workspace's share is untouched.
            let other = try await Self.open("aes.zip", registered: true)
            try other.mark(UUID().uuidString, family: false)
            #expect(other.serves)
            other.close()
        }
    }

    @Test func aPurgeByNodeClosesOnlyAZipKnownByThatNodeAlone() async throws {
        // A sign-out of its own: another suite's, running beside it, never closes these archives mid-test.
        try await ArchiveSessions.$account.withValue(UUID().uuidString) {
            // A share's zip of one workspace whose node id is also named by another workspace's purge (a collision).
            let mine = try await Self.open("aes.zip", registered: true)
            try mine.mark(UUID().uuidString, node: "node-collides", family: false)
            ArchiveSessions.closeFamily([UUID().uuidString], nodes: ["node-collides"])
            ArchiveSessions.proveFamilies([UUID().uuidString], nodes: ["node-collides"])
            ArchiveSessions.closeQueue.sync(flags: .barrier) {}
            #expect(mine.serves)
            // And one opened after that purge, of a known workspace, is admitted.
            let later = try await Self.open("aes.zip", registered: true)
            try later.mark(UUID().uuidString, node: "node-collides", family: false)
            #expect(later.serves)
            mine.close()
            later.close()
        }
    }

    @Test func aLetGoOrProofOfAnEndedSessionClosesAndFillsNothing() async throws {
        // A sign-out of its own: another suite's, running beside it, never closes these archives mid-test.
        try await ArchiveSessions.$account.withValue(UUID().uuidString) {
            let account = CopyEpoch()
            let ended = TemporaryCopies.session(account)
            TemporaryCopies.endAccount(account)
            // The next session's zip of the same folder.
            let workspace = UUID().uuidString.lowercased()
            let archive = try await Self.open("aes.zip", registered: true)
            try archive.mark(workspace, family: false)
            // The ended session's late let-go and proof: this session's zip stays, and a zip of it opened later is admitted.
            ArchiveSessions.closeFamily([workspace], session: ended)
            ArchiveSessions.proveFamilies([workspace], session: ended)
            ArchiveSessions.closeQueue.sync(flags: .barrier) {}
            #expect(archive.serves)
            let later = try await Self.open("aes.zip", registered: true)
            try later.mark(workspace, family: false)
            #expect(later.serves)
            // The session's own let-go closes both.
            ArchiveSessions.closeFamily([workspace], session: TemporaryCopies.session(account))
            ArchiveSessions.closeQueue.sync(flags: .barrier) {}
            #expect(!archive.serves)
            #expect(!later.serves)
        }
    }

    @Test func aShareOrKeptZipOfAFamilyFolderLetGoOfClosesWithIt() async throws {
        // A sign-out of its own: another suite's, running beside it, never closes these archives mid-test.
        try await ArchiveSessions.$account.withValue(UUID().uuidString) {
            let workspace = UUID().uuidString.lowercased()
            // Opened by a share of what is (or was) a family's folder, not through its ledger.
            let shared = try await Self.open("aes.zip", registered: true)
            try shared.mark(workspace, family: false)
            #expect(try await shared.unlock("correct horse battery"))
            // The sync lets the family go (a refusal, a fork, not a member): its folder's keys and copies go, and so does this.
            TemporaryCopies.forgetFamily([workspace])
            ArchiveSessions.closeQueue.sync(flags: .barrier) {}
            #expect(!shared.unlocked)
            #expect(!shared.serves)
            // One marked after the let-go is refused at its mark.
            let late = try await Self.open("aes.zip", registered: true)
            #expect(throws: ArchiveFailure.self) { try late.mark(workspace, family: false) }
            // A kept zip whose record predates its workspace's: found by the node the vault forgot, and a later one refused.
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: dir) }
            let copy = dir.appendingPathComponent("kept.zip")
            try FileManager.default.copyItem(at: Self.fixtures.appendingPathComponent("aes.zip"), to: copy)
            let kept = try await OpenArchive.openKept(copy, workspace: nil, node: "node-family-kept")
            ArchiveSessions.closeFamily([UUID().uuidString], nodes: ["node-family-kept"])
            ArchiveSessions.closeQueue.sync(flags: .barrier) {}
            #expect(!kept.serves)
            await #expect(throws: ArchiveFailure.self) { _ = try await OpenArchive.openKept(copy, workspace: nil, node: "node-family-kept") }
        }
    }

    @Test func aKeptZipClosesWhenItsWorkspaceIsProvenAFamilysOrItsCopyIsPurged() async throws {
        // A sign-out of its own: another suite's, running beside it, never closes these archives mid-test.
        try await ArchiveSessions.$account.withValue(UUID().uuidString) {
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: dir) }
            let copy = dir.appendingPathComponent("kept.zip")
            try FileManager.default.copyItem(at: Self.fixtures.appendingPathComponent("aes.zip"), to: copy)
            // Opened by its offline record: its workspace and node marked.
            let workspace = UUID().uuidString.lowercased()
            let kept = try await OpenArchive.openKept(copy, workspace: workspace, node: "node-kept")
            #expect(try await kept.unlock("correct horse battery"))
            ArchiveSessions.proveFamilies([workspace])
            ArchiveSessions.closeQueue.sync(flags: .barrier) {}
            #expect(!kept.unlocked)
            #expect(!kept.serves)
            // A record kept before its workspace was recorded: found by the node the proof purged.
            let older = try await OpenArchive.openKept(copy, workspace: nil, node: "node-older")
            #expect(older.serves)
            ArchiveSessions.proveFamilies([UUID().uuidString], nodes: ["node-older"])
            ArchiveSessions.closeQueue.sync(flags: .barrier) {}
            #expect(!older.serves)
            // A purge that comes while such a copy is still being read (before its mark): the mark sees it and refuses.
            ArchiveSessions.proveFamilies([UUID().uuidString], nodes: ["node-late"])
            await #expect(throws: ArchiveFailure.self) { _ = try await OpenArchive.openKept(copy, workspace: nil, node: "node-late") }
        }
    }

    @Test func aDownloadReservesAFileOfItsOwnAndNeverTouchesOneAlreadyThere() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let theirs = dir.appendingPathComponent("report.pdf")
        try Data("someone else's".utf8).write(to: theirs)
        let (first, a) = try ArchiveSaveName.reserve(in: dir, name: "report.pdf")
        let (second, b) = try ArchiveSaveName.reserve(in: dir, name: "report.pdf")
        try a.close()
        try b.close()
        #expect(first.lastPathComponent == "report (2).pdf")
        #expect(second.lastPathComponent == "report (3).pdf")
        #expect(try Data(contentsOf: theirs) == Data("someone else's".utf8))
        // Every number taken: refused, nothing opened.
        #expect(throws: CocoaError.self) { _ = try ArchiveSaveName.reserve(in: dir, name: "report.pdf", tries: 3) }
    }

    @Test func aReadThatFailsUnderneathIsSaidInHushOSsWordsNeverTheSystems() async throws {
        let (content, _) = try Self.sealed("basic.zip")
        let source = ArchiveSource(drainLater: { _ in }) { _ in throw URLError(.notConnectedToInternet) }
        do {
            _ = try await OpenArchive.open(source: source, content: content, watchdog: .seconds(30), registered: false)
            Issue.record("opened without the store")
        } catch let failure as ArchiveFailure {
            #expect(failure.message == AuthError.unreachable)
        }
        let failing = ArchiveSource(drainLater: { _ in }) { _ in throw CocoaError(.fileReadNoSuchFile, userInfo: [NSFilePathErrorKey: "/private/var/secret/path"]) }
        do {
            _ = try await OpenArchive.open(source: failing, content: content, watchdog: .seconds(30), registered: false)
            Issue.record("opened without the store")
        } catch let failure as ArchiveFailure {
            #expect(failure.message == ArchiveWords.unreadable)
            #expect(!failure.message.contains("/private"))
        }
    }

    @Test func aZipWhoseFamilyGoesWhileItsTreeBuildsIsNeverShown() async throws {
        // A sign-out of its own: another suite's, running beside it, never closes these archives mid-test.
        try await ArchiveSessions.$account.withValue(UUID().uuidString) {
            // What the screen asks before it publishes the tree it built off the main thread.
            let workspace = UUID().uuidString.lowercased()
            let archive = try await Self.open("aes.zip", registered: true)
            archive.gate = TemporaryCopies.copyGate(familyWorkspace: workspace)
            try archive.mark(workspace, family: true)
            _ = archive.takeFolders()
            #expect(archive.serves)
            // The family is let go of while the tree builds: by then the archive is closed, and the screen shows nothing of it.
            TemporaryCopies.forgetFamily([workspace])
            ArchiveSessions.closeQueue.sync(flags: .barrier) {}
            #expect(!archive.serves)
        }
    }

    @Test func anIdleFamilyZipClosesTheMomentItsFamilyIsLetGoOf() async throws {
        // A sign-out of its own: another suite's, running beside it, never closes these archives mid-test.
        try await ArchiveSessions.$account.withValue(UUID().uuidString) {
            let workspace = UUID().uuidString.lowercased()
            let archive = try await Self.open("aes.zip", registered: true)
            archive.gate = TemporaryCopies.copyGate(familyWorkspace: workspace)
            try archive.mark(workspace, family: true)
            #expect(try await archive.unlock("correct horse battery"))
            // Nothing is asked of it: the forget alone closes it, and its screen hears.
            let heard = Counter()
            let listening = NotificationCenter.default.addObserver(forName: ArchiveSessions.familyClosed, object: nil, queue: nil) { note in
                if note.userInfo?["archive"] as? UUID == archive.identity { _ = heard.next() }
            }
            defer { NotificationCenter.default.removeObserver(listening) }
            TemporaryCopies.forgetFamily([workspace])
            ArchiveSessions.closeQueue.sync(flags: .barrier) {}
            #expect(!archive.unlocked)
            for _ in 0 ..< 50 where heard.value == 0 { try await Task.sleep(for: .milliseconds(20)) }
            #expect(heard.value == 1)
            // Another family's forget leaves an archive of this one alone.
            let other = try await Self.open("aes.zip", registered: true)
            try other.mark(UUID().uuidString, family: true)
            #expect(try await other.unlock("correct horse battery"))
            TemporaryCopies.forgetFamily([UUID().uuidString])
            ArchiveSessions.closeQueue.sync(flags: .barrier) {}
            #expect(other.unlocked)
            other.close()
        }
    }

    @Test func theAllowlistSweepLeavesAnOpenZipToItsFamilysForget() async throws {
        // A sign-out of its own: another suite's, running beside it, never closes these archives mid-test.
        try await ArchiveSessions.$account.withValue(UUID().uuidString) {
            // A family not proven again since the sync began: its copies swept, its open zip left alone.
            let family = UUID().uuidString.lowercased()
            let archive = try await Self.open("aes.zip", registered: true)
            try archive.mark(family, family: true)
            #expect(try await archive.unlock("correct horse battery"))
            let temporary = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
            defer { try? FileManager.default.removeItem(at: temporary) }
            #expect(TemporaryCopies.sweepFamily(keeping: [], in: temporary))
            ArchiveSessions.closeQueue.sync(flags: .barrier) {}
            #expect(archive.unlocked)
            // Its revocation is what closes it.
            TemporaryCopies.forgetFamily([family], in: temporary)
            ArchiveSessions.closeQueue.sync(flags: .barrier) {}
            #expect(!archive.unlocked)
        }
    }

    final class Total: @unchecked Sendable {
        private let lock = NSLock()
        private var total: UInt64 = 0
        var value: UInt64 { lock.withLock { total } }
        func add(_ count: Int) { lock.withLock { total += UInt64(count) } }
    }

    final class Counter: @unchecked Sendable {
        private let lock = NSLock()
        private var count = 0
        var value: Int { lock.withLock { count } }
        func next() -> Int { lock.withLock { count += 1; return count } }
    }

    @Test func signingOutWipesEveryOpenArchivesPassword() async throws {
        // A sign-out of its own: another suite's, running beside it, never closes these archives mid-test.
        try await ArchiveSessions.$account.withValue(UUID().uuidString) {
            let archive = try await Self.open("aes.zip", registered: true)
            #expect(try await archive.unlock("correct horse battery"))
            ArchiveSessions.closeAll()
            ArchiveSessions.closeQueue.sync(flags: .barrier) {}
            #expect(!archive.unlocked)
            let secret = try #require(archive.entries.first { $0.path == "secret.txt" })
            #expect(await code { try await archive.preview(secret, limit: 1024) } == nil)
        }
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
        // Windows line ends count as lines too: 450 of them make three pieces, not one cut by size alone.
        let windows = Data((0 ..< 450).map { "line \($0)" }.joined(separator: "\r\n").utf8)
        let crlf = ArchiveText.pieces(windows)
        #expect(crlf.count == 3)
        #expect(crlf.joined(separator: "\n") == String(decoding: many, as: UTF8.self))
        // One line of 100 KB, with no line end to cut at, is still cut, between characters.
        let long = Data(String(repeating: "é", count: 50_000).utf8)
        let cut = ArchiveText.pieces(long)
        #expect(cut.allSatisfy { $0.utf8.count <= ArchiveText.bytes })
        #expect(cut.joined(separator: "\n").replacingOccurrences(of: "\n", with: "") == String(decoding: long, as: UTF8.self))
        // One character of 1 MB (a letter under 524,288 accents) is cut too, between its scalars.
        let mark = "a" + String(repeating: "\u{301}", count: 524_288)
        let marked = ArchiveText.pieces(Data(mark.utf8))
        #expect(marked.count > 60)
        #expect(marked.allSatisfy { $0.utf8.count <= ArchiveText.bytes })
        #expect(marked.flatMap(\.unicodeScalars) == Array(mark.unicodeScalars))
    }

    /*
     * Entries and folders for `paths` (a trailing `/` a directory) listed as the core lists them: a
     * folder for each name under each parent, numbered as made, each entry in its folder; one under
     * `__MACOSX/` hidden and in none. The core's own listing is held to the shared table in its tests.
     */
    static func listed(_ paths: [String]) -> ([ArchiveEntry], ArchiveFolders) {
        var ids: [String: UInt32] = [:]
        var parents = Data(count: 4)
        var names = ""
        func folder(_ parent: UInt32, _ name: String) -> UInt32 {
            if let id = ids["\(parent)/\(name)"] { return id }
            let id = UInt32(ids.count + 1)
            ids["\(parent)/\(name)"] = id
            withUnsafeBytes(of: parent.littleEndian) { parents.append(contentsOf: $0) }
            names += name + "/"
            return id
        }
        let entries = paths.enumerated().map { index, path in
            let directory = path.hasSuffix("/")
            let parts = path.split(separator: "/").map(String.init)
            var node: UInt32 = 0
            let macos = parts.first == "__MACOSX"
            if !macos {
                for part in parts.dropLast() { node = folder(node, part) }
                if directory { _ = folder(node, parts.last!) }
            }
            return ArchiveEntry(
                index: UInt32(index), path: path, folder: node, name: parts.last ?? path, directory: directory,
                size: 1, packed: 1, dos: 0, mtimeMillis: nil, lock: "none", support: "ok", link: false, nested: false,
                hidden: macos, stored: false, saveName: parts.last ?? path
            )
        }
        return (entries, ArchiveFolders(parents: parents, names: names))
    }

    @Test func aDeepPathIsOneFolderALevel() {
        // 256 parts deep (the core's cap): every folder on the way, one child each.
        let (entries, folders) = Self.listed([(0 ..< 255).map { "d\($0)" }.joined(separator: "/") + "/z"])
        let tree = ArchiveTree(entries, folders: folders)
        var id: UInt32 = 0
        for depth in 0 ..< 255 {
            guard case .folder(let next, let name, 1) = tree.rows(in: id).first, tree.rows(in: id).count == 1 else {
                Issue.record("no folder at \(depth)")
                return
            }
            #expect(name == "d\(depth)")
            id = next
        }
        #expect(tree.rows(in: id).map(\.name) == ["z"])
    }

    @Test func theTreeListsFoldersFirstWithCountsAndLeavesMacFilesOut() {
        let (entries, folders) = Self.listed([
            "z.txt", "docs/", "docs/readme.txt", "docs/notes/todo.md", "__MACOSX/._z.txt", "a.txt", "empty/",
        ])
        let tree = ArchiveTree(entries, folders: folders)
        let top = tree.rows(in: 0)
        #expect(top.map(\.name) == ["docs", "empty", "a.txt", "z.txt"])
        guard case .folder(let docs, "docs", 2) = top[0], case .folder(let empty, "empty", 0) = top[1] else {
            Issue.record("folders: \(top)")
            return
        }
        #expect(tree.rows(in: empty).isEmpty)
        // A folder no entry names but a deeper path implies.
        guard case .folder(let notes, "notes", 1) = tree.rows(in: docs).first else {
            Issue.record("no notes in docs")
            return
        }
        #expect(tree.name(of: notes) == "notes")
        #expect(tree.rows(in: notes).map(\.name) == ["todo.md"])
        #expect(!top.contains { $0.name == "__MACOSX" })
        // A folder the list doesn't hold is empty, not a crash.
        #expect(tree.rows(in: 999).isEmpty)
        #expect(tree.name(of: 999) == "")
    }

    @Test func everyRefusalTheListShowsHasTheWebsWords() {
        // The codes archive.rs sends that reach the person (directory, link and too-large are drawn, never said).
        for code in ["damaged", "directory-too-large", "too-many-entries", "encrypted-directory", "split", "overlap", "local",
                     "method", "encryption", "password", "wrong-password", "password-unproven", "crc", "auth", "size", "short", "ratio", "nested",
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

    @Test func aZipEntrysDateIsItsUnixTimeOrItsDosDateAsLocalTime() throws {
        var entry = ArchiveEntry(index: 0, path: "a", folder: 0, name: "a", directory: false, size: 0, packed: 0,
                                 dos: (UInt32((2026 - 1980) << 9 | 11 << 5 | 3) << 16) | UInt32(14 << 11 | 30 << 5),
                                 mtimeMillis: nil, lock: "none", support: "ok", link: false, nested: false, hidden: false, stored: true, saveName: "a")
        let zone = TimeZone(identifier: "Asia/Bangkok")!
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let when = try #require(ArchiveEntries.date(entry, timeZone: zone))
        let parts = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: when)
        #expect([parts.year, parts.month, parts.day, parts.hour, parts.minute] == [2026, 11, 3, 14, 30])
        // A phone on the Buddhist calendar shows the same moment as its own year, 2569, never 2026 read as its year.
        var buddhist = Calendar(identifier: .buddhist)
        buddhist.timeZone = zone
        let shown = buddhist.dateComponents([.year, .month, .day], from: when)
        #expect([shown.year, shown.month, shown.day] == [2569, 11, 3])
        entry.mtimeMillis = 1_000
        #expect(ArchiveEntries.date(entry) == Date(timeIntervalSince1970: 1))
        entry.mtimeMillis = nil
        entry.dos = 0
        #expect(ArchiveEntries.date(entry) == nil)
    }
}
