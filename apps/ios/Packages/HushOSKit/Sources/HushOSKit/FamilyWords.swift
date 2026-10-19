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
    /* What family folders don't offer (the web hides Share, links, Report and versions there too). */
    public static let unavailable = "This isn’t available in family folders."
    public static let openAgain = "Open the family again, then try again."
    /* The core's KEY_CHANGE_PENDING, which both twins match exactly, and what the person reads instead. */
    static let keyChangePending = "This folder’s keys changed: the key change has not reached it yet."
    static let keyChangeWait = "HushOS is finishing a key change for this folder. Try again in a moment."

    /* The core's refusal while it holds a family's keys back (after a refusal or a fork, until the next acceptance). */
    static let noChain = "Check the family’s member list first."
    /* The core's NOT_COMMITTED_ROOT and NOT_CARRIED: keys this device can't vouch for, said as Couldn't check (docs/groups-mobile-plan.md, iOS 2). */
    static let notCommittedRoot = "This folder’s key is not the one the family’s member list names."
    static let notCarried = "This item was added under a key the key change replaces, so it is not carried over."
    public static let couldntCheckKeys = "Couldn’t check this folder’s keys."
    /* The ledger's refusal of a top folder under an area key version it doesn't hold (a key change not accepted here yet). */
    static let olderWorkspaceKey = "This folder was wrapped under an older workspace key."
    /* The same for a folder re-keyed under its parent's next key before this process has it (a walk it hasn't followed yet). */
    static let olderFolderKey = "This item was wrapped under an older folder key."

    public static func keyChangeWords(_ message: String) -> String {
        if message == keyChangePending { return keyChangeWait }
        // Nothing of the family opens until it is checked again: said as the web's family folders say it.
        if message == noChain { return openAgain }
        if message == notCommittedRoot || message == notCarried { return couldntCheckKeys }
        return message
    }

    /* The core's sentence, without the error type around it. */
    static func message(of error: CoreError) -> String {
        switch error {
        case .Input(let message), .Opaque(let message), .Sealed(let message): message
        }
    }

    /* A core refusal in the person's words (its sentence, a family folder's key change reworded); nil for anything else. */
    public static func core(_ error: Error) -> String? {
        guard let error = error as? CoreError else { return nil }
        return keyChangeWords(message(of: error))
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
