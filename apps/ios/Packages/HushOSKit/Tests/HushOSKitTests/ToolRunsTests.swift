import CryptoKit
import Foundation
import HushOSCore
import Testing
@testable import HushOSKit

/*
 * The harness file tools run in: the core's reader over an object served by an async fetch (as
 * the store's is), read across a chunk boundary on the run's own thread; one run at a time;
 * cancel, cancelAll and the watchdog ending a run and the thread behind it; a task cancelled
 * before it asks never starting; and ToolReaders against a stubbed Drive API and store,
 * renewing an expired address and cancelling a request in flight when the run ends. Each test
 * fails if its rule is broken. The watchdog runs on a clock that moves a second each time it is
 * read, so no test depends on how fast this machine is.
 */
@Suite(.serialized) struct ToolRunsTests {
    static let chunk: UInt64 = 8 * 1024 * 1024

    /* A second each time the core reads it: each watchdog check, and each progress. */
    final class Stepping: ToolClock, @unchecked Sendable {
        private let lock = NSLock()
        private var now: UInt64 = 0
        func nowMillis() -> UInt64 { lock.lock(); defer { lock.unlock() }; now += 1000; return now }
    }

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

    /* Polls until `condition` holds, for up to five seconds. */
    func eventually(_ condition: @Sendable () async -> Bool) async throws {
        for _ in 0 ..< 500 {
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
        try await eventually { await runs.running == nil }
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

    @Test func aTaskCancelledBeforeItAsksNeverStarts() async throws {
        let runs = ToolRuns()
        let log = Log()
        let task = Task {
            // Busy with something that doesn't look, until cancelled; then it asks for a run.
            while !Task.isCancelled { await Task.yield() }
            return try await runs.run("Too late") { _ in log.add("ran"); return 0 }
        }
        task.cancel()
        await #expect(throws: ToolCancelled.self) { try await task.value }
        #expect(log.items.isEmpty)
        try await eventually { await runs.running == nil }
        #expect(try await runs.run("Next") { _ in 3 } == 3)
    }

    @Test func aWaitingRunCancelledNeverStarts() async throws {
        let runs = ToolRuns()
        let gate = DispatchSemaphore(value: 0)
        let log = Log()
        let first = Task { try await runs.run("First") { _ in gate.wait(); return 0 } }
        try await eventually { await runs.running == "First" }
        let states = Log()
        let second = Task { try await runs.run("Second", state: { states.add("\($0)") }) { _ in log.add("second ran"); return 0 } }
        try await eventually { states.items.contains("\(ToolRunState.waiting(behind: "First"))") }
        second.cancel()
        await #expect(throws: ToolCancelled.self) { try await second.value }
        gate.signal()
        _ = try await first.value
        try await eventually { await runs.running == nil }
        #expect(log.items.isEmpty)
    }

    @Test func cancelAllEndsTheRunningAndTheWaiting() async throws {
        let runs = ToolRuns()
        let log = Log()
        let running = Task {
            try await runs.run("Running") { control in
                while true { try control.check(); Thread.sleep(forTimeInterval: 0.005) }
            }
        }
        try await eventually { await runs.running == "Running" }
        let states = Log()
        let waiting = Task { try await runs.run("Waiting", state: { states.add("\($0)") }) { _ in log.add("waiting ran"); return 0 } }
        try await eventually { states.items.contains("\(ToolRunState.waiting(behind: "Running"))") }
        runs.cancelAll()
        await #expect(throws: ToolCancelled.self) { try await running.value }
        await #expect(throws: ToolCancelled.self) { try await waiting.value }
        try await eventually { await runs.running == nil }
        #expect(log.items.isEmpty)
    }

    @Test func aSignOutAsARunStartsWaitingEndsIt() async throws {
        // cancelAll from the .waiting callback: the waiting run is reached, not only the running one.
        let runs = ToolRuns()
        let gate = DispatchSemaphore(value: 0)
        let log = Log()
        let first = Task { try await runs.run("First") { _ in gate.wait(); return 0 } }
        try await eventually { await runs.running == "First" }
        let second = Task {
            try await runs.run("Second", state: { if case .waiting = $0 { runs.cancelAll() } }) { _ in log.add("second ran"); return 0 }
        }
        await #expect(throws: ToolCancelled.self) { try await second.value }
        await #expect(throws: ToolCancelled.self) { try await first.value }
        gate.signal()
        try await eventually { await runs.running == nil }
        #expect(log.items.isEmpty)
    }

    @Test func aSignOutAsARunIsLetInStartsNothing() async throws {
        // cancelAll from the .running callback: after the slot is taken, before the thread starts.
        let runs = ToolRuns()
        let log = Log()
        await #expect(throws: ToolCancelled.self) {
            try await runs.run("Let in", state: { if case .running = $0 { runs.cancelAll() } }) { _ in log.add("ran"); return 0 }
        }
        #expect(log.items.isEmpty)
        try await eventually { await runs.running == nil }
        #expect(try await runs.run("Next") { _ in 3 } == 3)
    }

    @Test func theWatchdogFailsARunThatReportsNoProgress() async throws {
        let runs = ToolRuns()
        let log = Log()
        let states = Log()
        await #expect(throws: ToolFailed(toolFailedMessage())) {
            try await runs.run("Stuck", poll: .milliseconds(5), clock: Stepping(), state: { states.add("\($0)") }) { control in
                // A parser looping without progress; it only checks it has not been stopped.
                while true {
                    do { try control.check() } catch { log.add("stopped"); throw error }
                    Thread.sleep(forTimeInterval: 0.001)
                }
            }
        }
        #expect(states.items.last == "\(ToolRunState.failed(toolFailedMessage()))")
        try await eventually { log.items.contains("stopped") }
    }

    @Test func progressKeepsTheWatchdogAway() async throws {
        let runs = ToolRuns()
        // Many more checks than the watchdog's 30 seconds, each a second: only progress keeps the run alive.
        let value = try await runs.run("Slow but alive", poll: .milliseconds(2), clock: Stepping()) { control in
            for _ in 0 ..< 400 {
                Thread.sleep(forTimeInterval: 0.001)
                try control.progress()
            }
            return 7
        }
        #expect(value == 7)
    }

    /* The Drive API and store on a stub: version addresses that expire after one use, and ranges. */
    static func stubbedAPI(_ object: Data) -> DriveAPI {
        StoreStub.reset(object)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StoreStub.self]
        return DriveAPI(session: SharedKeychain.Session(origin: "https://drive.test", token: "t", userId: "u"), configuration: configuration)
    }

    @Test func toolReadersReadRangesAndRenewAnExpiredAddress() async throws {
        let size = Self.chunk + 5000
        let (content, object, plain) = try Self.sealed(size)
        let api = Self.stubbedAPI(object)
        let control = RunControl(watchdogMillis: toolWatchdogMillis(), clock: nil)
        let reader = try await ToolReaders.reader(api: api, opened: OpenedVersion(content: content, versionId: "v1"), workspaceId: "ws", control: control)
        let read = try await Task.detached { try reader.readAt(offset: Self.chunk - 10, length: 20) }.value
        let start = Int(Self.chunk - 10)
        #expect(read == plain.subdata(in: start ..< start + 20))
        #expect(StoreStub.state.refused == 1)
        #expect(StoreStub.state.addresses == 2)
        #expect(StoreStub.state.ranges.count == 2)
    }

    @Test func aRunThatEndsCancelsItsFetch() async throws {
        let (content, object, _) = try Self.sealed(1000)
        let api = Self.stubbedAPI(object)
        let control = RunControl(watchdogMillis: toolWatchdogMillis(), clock: nil)
        let reader = try await ToolReaders.reader(api: api, opened: OpenedVersion(content: content, versionId: "v1"), workspaceId: "ws", control: control)
        StoreStub.state.stall = true
        let reading = Task.detached { () -> Bool in
            do { _ = try reader.readAt(offset: 0, length: 10); return true } catch { return false }
        }
        // Held open by the store, past the expired address's renewal.
        try await eventually { StoreStub.state.stalled == 1 }
        let cancelled = ContinuousClock.now
        control.cancel()
        #expect(await reading.value == false)
        #expect(ContinuousClock.now - cancelled < .seconds(2))
        try await eventually { StoreStub.state.stopped >= 1 }
    }
}

/* What the stub saw and how it answers; one test at a time (the suite is serialized). */
final class StoreStubState: @unchecked Sendable {
    var object = Data()
    var addresses = 0
    var refused = 0
    var ranges: [String] = []
    var stall = false
    var stalled = 0
    var stopped = 0
}

final class StoreStub: URLProtocol {
    nonisolated(unsafe) static var state = StoreStubState()
    static let lock = NSLock()

    static func reset(_ object: Data) {
        lock.lock(); state = StoreStubState(); state.object = object; lock.unlock()
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    private func answer(_ status: Int, _ body: Data, headers: [String: String] = [:]) {
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func startLoading() {
        let url = request.url!
        let state = Self.state
        if url.host == "drive.test" {
            Self.lock.lock(); state.addresses += 1; let n = state.addresses; Self.lock.unlock()
            answer(200, Data("{\"url\":\"https://store.test/o?n=\(n)\",\"urlExpiresAt\":null}".utf8), headers: ["Content-Type": "application/json"])
            return
        }
        // The first address has expired by the time it is used.
        if url.query == "n=1" {
            Self.lock.lock(); state.refused += 1; Self.lock.unlock()
            answer(403, Data())
            return
        }
        Self.lock.lock()
        let stall = state.stall
        if stall { state.stalled += 1 }
        Self.lock.unlock()
        // A stalled store never answers; the request ends only when the client stops it.
        if stall { return }
        let header = request.value(forHTTPHeaderField: "Range") ?? ""
        Self.lock.lock(); state.ranges.append(header); Self.lock.unlock()
        let bounds = header.replacingOccurrences(of: "bytes=", with: "").split(separator: "-").compactMap { Int($0) }
        answer(206, state.object.subdata(in: bounds[0] ..< bounds[1] + 1))
    }

    override func stopLoading() {
        Self.lock.lock(); Self.state.stopped += 1; Self.lock.unlock()
    }
}

final class Log: @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [String] = []
    func add(_ entry: String) { lock.lock(); entries.append(entry); lock.unlock() }
    var items: [String] { lock.lock(); defer { lock.unlock() }; return entries }
}
