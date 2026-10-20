import Foundation

/*
 * Save to HushOS: the shared file's copy is moved into the queue's folder and sealed there.
 * Whatever stops it before the note is written (a refusal, no answer, a cancellation) puts the
 * copy back where it was and removes the folder, so the sheet still holds the file and says it
 * wasn't saved. A cancellation once left no words, the sheet said Saved and closed, and the
 * copy had already been deleted with the folder.
 */
public enum StagedSave {
    public static let failed = "Couldn’t save it. Try again."

    /* Runs `seal` on the copy moved to `directory/content`; the plaintext goes once `seal` returns, the copy comes back if it throws. */
    public static func seal<T>(_ copy: URL, in directory: URL, _ seal: (URL) async throws -> T) async throws -> T {
        let content = directory.appendingPathComponent("content")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        // This process's, before the only copy moves in: the queue's sweep leaves it while the process may run,
        // however long a suspended sheet writes nothing (ShareHandoff.sweepOrphans).
        ShareHandoff.claim(directory)
        try FileManager.default.moveItem(at: copy, to: content)
        do {
            let result = try await seal(content)
            try? FileManager.default.removeItem(at: content)
            return result
        } catch {
            try? FileManager.default.moveItem(at: content, to: copy)
            try? FileManager.default.removeItem(at: directory)
            throw error
        }
    }

    /* What the sheet says for a file that didn't save: always something, a cancellation included (nothing was saved). */
    public static func words(_ error: Error) -> String {
        ErrorWords.say(error, otherwise: failed) ?? failed
    }
}
