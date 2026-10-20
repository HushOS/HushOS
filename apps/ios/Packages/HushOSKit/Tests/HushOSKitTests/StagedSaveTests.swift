import Foundation
import Testing
@testable import HushOSKit

/*
 * Save to HushOS moves the shared file's copy into the queue's folder before sealing it. A seal
 * that stops (cancelled, refused, no answer) must leave the copy where it was and say the file
 * wasn't saved: a cancellation once left no words, the sheet said Saved, and the copy was gone.
 */
struct StagedSaveTests {
    private func staged() throws -> (copy: URL, directory: URL) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("staged-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let copy = root.appendingPathComponent("Sintra.jpg")
        try Data("the shared photo".utf8).write(to: copy)
        return (copy, root.appendingPathComponent("transfer", isDirectory: true))
    }

    @Test func aCancelledSealPutsTheCopyBackAndSaysItWasntSaved() async throws {
        let (copy, directory) = try staged()
        do {
            _ = try await StagedSave.seal(copy, in: directory) { content -> Int in
                #expect(FileManager.default.fileExists(atPath: content.path))
                // Claimed before the copy moved in, so the queue's sweep leaves it while this process may run.
                #expect(ShareHandoff.owner(of: directory) == getpid(), "the only copy sat in a folder nobody claimed")
                throw CancellationError()
            }
            Issue.record("a cancelled seal returned")
        } catch {
            #expect(error is CancellationError)
            let words = StagedSave.words(error)
            #expect(!words.isEmpty, "a cancellation left the sheet with nothing to say, so it said Saved")
            #expect(words == StagedSave.failed)
        }
        #expect(try Data(contentsOf: copy) == Data("the shared photo".utf8), "the shared file was lost with the queue's folder")
        #expect(!FileManager.default.fileExists(atPath: directory.path))
    }

    @Test func aRefusedSealKeepsTheCopyAndTheServersWords() async throws {
        let (copy, directory) = try staged()
        do {
            _ = try await StagedSave.seal(copy, in: directory) { _ -> Int in throw DriveAPIError.server(402, "x") }
        } catch {
            #expect(StagedSave.words(error) == DriveAPIError.noRoom)
        }
        #expect(FileManager.default.fileExists(atPath: copy.path))
    }

    @Test func aSealThatLandsLeavesNoPlaintextBehind() async throws {
        let (copy, directory) = try staged()
        let sealed = try await StagedSave.seal(copy, in: directory) { _ in 7 }
        #expect(sealed == 7)
        #expect(!FileManager.default.fileExists(atPath: directory.appendingPathComponent("content").path))
        #expect(!FileManager.default.fileExists(atPath: copy.path))
    }
}
