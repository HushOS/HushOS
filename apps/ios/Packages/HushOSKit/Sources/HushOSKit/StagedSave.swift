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

    /*
     * Runs `seal` on the copy placed at `directory/content`, under the queue folder's protection (a shared file keeps the
     * class it was made with, and one sealed only while unlocked couldn't be read again for a re-seal); the plaintext goes
     * once `seal` returns, the copy comes back if it throws.
     *
     * `keep`: a family folder's upload, whose plaintext stays in the folder for the queue to seal again after a key change.
     * The copy is linked in rather than moved, so whatever a failed seal does to the folder (FamilyUploads removes it when
     * the person is no longer in the family), the sheet still holds the file to save elsewhere; it goes only once the seal
     * returns.
     */
    public static func seal<T>(_ copy: URL, in directory: URL, keep: Bool = false, _ seal: (URL) async throws -> T) async throws -> T {
        let content = directory.appendingPathComponent("content")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        // This process's, before the only copy moves in: the queue's sweep leaves it while the process may run,
        // however long a suspended sheet writes nothing (ShareHandoff.sweepOrphans).
        ShareHandoff.claim(directory)
        if keep {
            do { try FileManager.default.linkItem(at: copy, to: content) } catch { try FileManager.default.copyItem(at: copy, to: content) }
        } else {
            try FileManager.default.moveItem(at: copy, to: content)
        }
        Unbacked.protectFile(content)
        do {
            let result = try await seal(content)
            if keep { try? FileManager.default.removeItem(at: copy) } else { try? FileManager.default.removeItem(at: content) }
            return result
        } catch {
            if !keep { try? FileManager.default.moveItem(at: content, to: copy) }
            try? FileManager.default.removeItem(at: directory)
            throw error
        }
    }

    /* What the sheet says for a file that didn't save: always something, a cancellation included (nothing was saved). */
    public static func words(_ error: Error) -> String {
        ErrorWords.say(error, otherwise: failed) ?? failed
    }
}
