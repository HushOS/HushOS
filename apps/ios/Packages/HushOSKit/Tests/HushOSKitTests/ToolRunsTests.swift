import CryptoKit
import Foundation
import HushOSCore
import Testing
@testable import HushOSKit

/*
 * The harness file tools run in: the core's reader over an object served by an async fetch (as
 * the store's is), read across a chunk boundary on the run's own thread; one run at a time;
 * cancel and the watchdog ending a run and the thread behind it. Each test fails if its rule is
 * broken: a second run starting beside the first, a cancel that leaves the work running, a run
 * that hangs without progress and is never stopped.
 */
@Suite struct ToolRunsTests {
    static let chunk: UInt64 = 8 * 1024 * 1024

    /* A file of `size` bytes sealed as an upload stores it, and the bytes. */
    static func sealed(_ size: UInt64) throws -> (content: Content, object: Data, plain: Data) {
        // Not periodic in the chunk size, so bytes read from the wrong place change the digest.
        var plain = Data(count: Int(size))
        plain.withUnsafeMutableBytes { raw in
            let bytes = raw.bindMemory(to: UInt8.self)
            var x: UInt32 = 0x9e37_79b9
            for i in 0 ..< bytes.count {
                x ^= x << 13; x ^= x >> 17; x ^= x << 5
                bytes[i] = UInt8(truncatingIfNeeded: x)
            }
        }
        let content = Content(
            workspaceId: "11111111-1111-4111-8111-111111111111", objectId: "66666666-6666-4666-8666-666666666666",
            suite: 3, key: try randomBytes(length: 32), nonce: try randomBytes(length: 16), plaintextSize: size, thumbnailBytes: 0
        )
        let layout = try contentLayout(suite: 3, plaintextSize: size, thumbnailBytes: 0)
        var object = Data()
        for index in 0 ..< layout.chunkCount {
            let start = Int(min(index * chunk, size))
            let length = Int(chunkLength(plaintextSize: size, index: index))
            object.append(try chunkEncrypt(content: content, index: index, plaintext: plain.subdata(in: start ..< start + length)))
        }
        return (content, object, plain)
    }

    /* Polls until `condition` holds, for up to two seconds. */
    func eventually(_ condition: @Sendable () async -> Bool) async throws {
        for _ in 0 ..< 200 {
            if await condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        Issue.record("the condition never held")
    }

    @Test func aRunReadsAcrossAChunkBoundaryThroughAnAsyncStore() async throws {
        let size = Self.chunk + 5000
        let (content, object, plain) = try Self.sealed(size)
        let source = StoreSource { range in
            // The store answers later, on another task, as a URLSession would.
            try await Task.sleep(for: .milliseconds(5))
            return object.subdata(in: Int(range.start) ..< Int(range.end) + 1)
        }
        let runs = ToolRuns()
        let digest = try await runs.run("Digest") { control in
            let reader = try VersionReader(source: source, content: content, control: control)
            return try rangeDigest(reader: reader, control: control, offset: Self.chunk - 100, length: 300)
        }
        let start = Int(Self.chunk - 100)
        #expect(digest == Data(SHA256.hash(data: plain.subdata(in: start ..< start + 300))))
    }

    @Test func aSecondRunWaitsBehindTheFirstAndStartsWhenItEnds() async throws {
        let runs = ToolRuns()
        let gate = DispatchSemaphore(value: 0)
        let log = Log()
        let first = Task {
            try await runs.run("Extracting Photos.zip") { _ in
                log.add("first started")
                gate.wait()
                log.add("first ended")
                return 1
            }
        }
        try await eventually { await runs.running == "Extracting Photos.zip" }
        let states = Log()
        let second = Task {
            try await runs.run("Converting 3 photos", state: { states.add("\($0)") }) { _ in
                log.add("second started")
                return 2
            }
        }
        try await eventually { states.items.contains("\(ToolRunState.waiting(behind: "Extracting Photos.zip"))") }
        #expect(!log.items.contains("second started"))
        gate.signal()
        #expect(try await first.value == 1)
        #expect(try await second.value == 2)
        #expect(log.items == ["first started", "first ended", "second started"])
        #expect(await runs.running == nil)
    }

    @Test func cancelEndsTheRunAndStopsItsThreadAtTheNextCall() async throws {
        let runs = ToolRuns()
        let log = Log()
        let task = Task {
            try await runs.run("Compressing") { control in
                log.add("started")
                // Busy, reporting progress: only the cancel can end it.
                while true {
                    do { try control.progress() } catch { log.add("stopped"); throw error }
                    Thread.sleep(forTimeInterval: 0.005)
                }
            }
        }
        try await eventually { log.items.contains("started") }
        task.cancel()
        await #expect(throws: ToolCancelled.self) { try await task.value }
        try await eventually { log.items.contains("stopped") }
        // The slot is free again once the thread has returned.
        try await eventually { await runs.running == nil }
        #expect(try await runs.run("Next") { _ in 3 } == 3)
    }

    @Test func aWaitingRunCancelledNeverStarts() async throws {
        let runs = ToolRuns()
        let gate = DispatchSemaphore(value: 0)
        let log = Log()
        let first = Task { try await runs.run("First") { _ in gate.wait(); return 0 } }
        try await eventually { await runs.running == "First" }
        let second = Task { try await runs.run("Second") { _ in log.add("second ran"); return 0 } }
        try await Task.sleep(for: .milliseconds(50))
        second.cancel()
        await #expect(throws: ToolCancelled.self) { try await second.value }
        gate.signal()
        _ = try await first.value
        try await eventually { await runs.running == nil }
        #expect(log.items.isEmpty)
    }

    @Test func theWatchdogFailsARunThatReportsNoProgress() async throws {
        let runs = ToolRuns()
        let log = Log()
        let states = Log()
        let started = ContinuousClock.now
        await #expect(throws: ToolFailed(toolFailedMessage())) {
            try await runs.run("Stuck", watchdog: .milliseconds(300), poll: .milliseconds(20), state: { states.add("\($0)") }) { control in
                // A parser looping without progress; it only checks it has not been stopped.
                while true {
                    do { try control.check() } catch { log.add("stopped"); throw error }
                    Thread.sleep(forTimeInterval: 0.005)
                }
            }
        }
        #expect(ContinuousClock.now - started >= .milliseconds(300))
        #expect(states.items.last == "\(ToolRunState.failed(toolFailedMessage()))")
        try await eventually { log.items.contains("stopped") }
    }

    @Test func progressKeepsTheWatchdogAway() async throws {
        let runs = ToolRuns()
        let value = try await runs.run("Slow but alive", watchdog: .milliseconds(200), poll: .milliseconds(20)) { control in
            for _ in 0 ..< 10 {
                Thread.sleep(forTimeInterval: 0.05)
                try control.progress()
            }
            return 7
        }
        #expect(value == 7)
    }
}

final class Log: @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [String] = []
    func add(_ entry: String) { lock.lock(); entries.append(entry); lock.unlock() }
    var items: [String] { lock.lock(); defer { lock.unlock() }; return entries }
}
