import Foundation

/*
 * What the app does when it comes back on screen and the keychain's session isn't the one it
 * shows: someone signed in from the Files sheet meanwhile (the same account after its session
 * ended, another account, or anyone while the app showed sign-in), or the session went.
 */
public enum SessionChange: Equatable, Sendable {
    /* The session shown is the one stored, or there is nothing new to follow. */
    case none
    /* The same account under a new session: the drive takes the new session and keeps what it shows. */
    case adopt
    /* Start again from the keychain: sign-in, or the stored session's drive. Nothing of anyone's to clear. */
    case restart
    /* Another account's session: the last account's queue stops and its notices go before the new one starts. */
    case another

    /*
     * `shown`: the account and session on screen, nil when the app shows sign-in. `last`: the
     * account shown before sign-in (whose transfers and notices may still be here). `declined`:
     * the stored session the last start found ended, which coming back doesn't ask about again.
     */
    public static func decide(shown: SharedKeychain.Session?, last: AccountOwner?, stored: SharedKeychain.Session?, declined: String?) -> SessionChange {
        if let shown {
            guard let stored else { return .restart }
            if AccountOwner(stored) != AccountOwner(shown) { return .another }
            return stored.token == shown.token ? .none : .adopt
        }
        guard let stored, stored.token != declined else { return .none }
        if let last, last != AccountOwner(stored) { return .another }
        return .restart
    }

    /*
     * What goes from memory before the app follows the change: the last session's family sync,
     * the family keys its area ledger holds, and its vault. Each session has its own vault and
     * ledger (`Vault.fromKeychain`), so a new session for the same account (`adopt`) starts
     * clean too; otherwise the previous account's family keys stayed in memory after another
     * signed in from the Files sheet.
     */
    public func forgetLastSession() {
        guard self != .none else { return }
        FamilySync.forget()
    }
}
