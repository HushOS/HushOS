import Foundation
import HushOSCore

/*
 * An error HushOS wrote the words for: its `errorDescription` is copy for the person (or the
 * server's own message, which the web shows too), never a system's or a library's text.
 */
public protocol WordedError: LocalizedError {}

/*
 * What a person reads when something fails, on every screen of the app and its extensions.
 *
 * Cancelled work is not a failure: a `.task` whose view went away (a tab switched, a sheet
 * closed, a list scrolled past), a request a newer one replaced. `say` returns nil for it
 * and the caller shows nothing. Android showed "The coroutine was canceled because it left
 * the composition" in an alert for the same thing.
 *
 * Only HushOS's own errors (`WordedError`) and the core's sentence speak for themselves. An
 * error's own description (a URLError's, a Cocoa error's with a path in it, a decoding
 * error's, a type's name) never reaches the screen: the caller's fallback, in its words, says
 * what didn't happen. Whatever the error said goes to the log, not here.
 */
public enum ErrorWords {
    public static let generic = "Something went wrong. Try again."

    /*
     * Work stopped because whoever waited for it went away, not because anything failed: a
     * `CancellationError`, a person's own cancel, or a URL request cancelled while the task
     * that waits for it is cancelled. URLSession also says "cancelled" when the system ends a
     * request or a session is torn down; with the task still running that is a failure (no
     * answer, retried or reported), never a cancellation, or a failed upload looks finished.
     */
    public static func isCancellation(_ error: Error, taskCancelled: Bool = Task.isCancelled) -> Bool {
        if error is CancellationError { return true }
        let ns = error as NSError
        if ns.domain == NSCocoaErrorDomain && ns.code == NSUserCancelledError { return true }
        let urlCancelled = (error as? URLError)?.code == .cancelled || (ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled)
        return urlCancelled && taskCancelled
    }

    /* The words for `error`, or nil when it is a cancellation and nothing should be said. */
    public static func say(_ error: Error, otherwise fallback: String = generic) -> String? {
        if isCancellation(error) { return nil }
        switch error {
        case let error as CoreError:
            // The core's sentence, without its type around it; a family folder's key change said as the web says it.
            return FamilyWords.core(error)
        case let error as WordedError:
            return error.errorDescription ?? fallback
        case is URLError:
            return AuthError.unreachable
        default:
            return fallback
        }
    }
}

extension DriveAPIError: WordedError {}
extension AuthError: WordedError {}
extension GranterTrust: WordedError {}
extension ContactError: WordedError {}
extension GroupsAPIError: WordedError {}
extension FamilyWriteError: WordedError {}
extension UploadLanded: WordedError {}
extension RotationError: WordedError {}
extension SignersError: WordedError {}
extension FamilyFailure: WordedError {}
extension FamilyRecords.RecordsError: WordedError {}
