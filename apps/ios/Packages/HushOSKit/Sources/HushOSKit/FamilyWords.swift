import Foundation
import HushOSCore

/*
 * What the families screens say when something fails, as the web's errorCopy and
 * keyChangeWords word it (apps/web/src/lib/groups/copy.ts, lib/key-change-words.ts): a coded
 * refusal in the person's words, no answer as no answer, and the core's own sentence (never its
 * type's description) with only the key-change refusal reworded.
 */
public enum FamilyWords {
    public static let noAnswer = "Couldn’t reach HushOS. Check your connection, then retry."
    public static let readOnly = "Family folders are read only in this app for now. Make changes on the web."
    public static let openAgain = "Open the family again, then try again."
    /* The core's KEY_CHANGE_PENDING, which both twins match exactly, and what the person reads instead. */
    static let keyChangePending = "This folder’s keys changed: the key change has not reached it yet."
    static let keyChangeWait = "HushOS is finishing a key change for this folder. Try again in a moment."

    /* The core's refusal while it holds a family's keys back (after a refusal or a fork, until the next acceptance). */
    static let noChain = "Check the family’s member list first."

    public static func keyChangeWords(_ message: String) -> String {
        if message == keyChangePending { return keyChangeWait }
        // Nothing of the family opens until it is checked again: said as the web's family folders say it.
        if message == noChain { return openAgain }
        return message
    }

    /* The core's sentence, without the error type around it. */
    static func message(of error: CoreError) -> String {
        switch error {
        case .Input(let message), .Opaque(let message), .Sealed(let message): message
        }
    }

    public static func error(_ error: Error) -> String {
        switch error {
        case let error as GroupsAPIError:
            if error.status == 0 { return noAnswer }
            return error.errorDescription ?? "HushOS couldn’t do that just now. Try again in a moment."
        case DriveAPIError.notAuthenticated, AuthError.sessionEnded:
            return "You were signed out. Sign in again, then retry."
        case DriveAPIError.transport:
            return noAnswer
        case AuthError.message(let text) where text == AuthError.unreachable:
            return noAnswer
        case let error as CoreError:
            return keyChangeWords(message(of: error))
        case let error as LocalizedError:
            return error.errorDescription.map(keyChangeWords) ?? "Something went wrong. Try again."
        default:
            return "Something went wrong. Try again."
        }
    }
}
