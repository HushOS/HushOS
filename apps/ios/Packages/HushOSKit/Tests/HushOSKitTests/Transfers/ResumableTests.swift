import Foundation
import Testing
@testable import HushOSKit

/* What a flaky connection does to a transfer: retries, waits, and picking up where it stopped. */
struct ResumableTests {
    let chunk: UInt64 = 4
    let plain = Data((0 ..< 10).map { UInt8($0) }) // chunks 0..3, 4..7, 8..9

    func piece(_ index: UInt64) -> Data { plain.subdata(in: Int(index * chunk) ..< min(plain.count, Int((index + 1) * chunk))) }
    func file() -> URL { FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathComponent("f.bin") }

    @Test func aDroppedChunkIsFetchedAgainAndTheFileComesOutWhole() async throws {
        let out = file()
        var failures = 1
        var waits = 0
        try await Resumable.download(to: out, count: 3, chunkBytes: chunk, online: { true }, sleep: { _ in waits += 1 }) { index in
            if index == 1 && failures > 0 { failures -= 1; throw DriveAPIError.transport("dropped") }
            return piece(index)
        }
        #expect(try Data(contentsOf: out) == plain)
        #expect(waits == 1)
        #expect(!FileManager.default.fileExists(atPath: out.appendingPathExtension("part").path))
    }

    @Test func aPartFileFromAnEarlierTryIsContinuedFromItsLastWholeChunk() async throws {
        let out = file()
        try FileManager.default.createDirectory(at: out.deletingLastPathComponent(), withIntermediateDirectories: true)
        // Chunk 0 whole, chunk 1 cut short with a wrong byte: only chunk 0 may be kept.
        try (piece(0) + Data([99])).write(to: out.appendingPathExtension("part"))
        var fetched: [UInt64] = []
        try await Resumable.download(to: out, count: 3, chunkBytes: chunk, online: { true }, sleep: { _ in }) { index in
            fetched.append(index); return piece(index)
        }
        #expect(fetched == [1, 2])
        #expect(try Data(contentsOf: out) == plain)
    }

    @Test func offlineTimeDoesNotCountAndARefusalFailsAtOnce() async throws {
        var online = false
        var sleeps = 0
        let result = try await Resumable.run(online: { online }, sleep: { _ in sleeps += 1; if sleeps == 20 { online = true } }) {
            if sleeps < 20 { throw DriveAPIError.transport("offline") }
            return "ok"
        }
        #expect(result == "ok") // twenty failures while offline, more than maxAttempts, and still it finished
        var tries = 0
        await #expect(throws: DriveAPIError.self) {
            try await Resumable.run(online: { true }, sleep: { _ in }) { () async throws -> String in tries += 1; throw DriveAPIError.server(404, "gone") }
        }
        #expect(tries == 1)
    }

    @Test func anExpiredAddressIsRefreshedBeforeTheNextTry() async throws {
        var refreshed = 0
        var first = true
        _ = try await Resumable.run(online: { true }, sleep: { _ in }, onExpired: { refreshed += 1 }) { () async throws -> String in
            if first { first = false; throw DriveAPIError.server(403, "expired") }
            return "ok"
        }
        #expect(refreshed == 1)
    }
}
