import Foundation

/*
 * Asking once (docs/devices-design.md 5, Settings): right after a sign-in or sign-up, or at the
 * first signed-in start of a build that asks, on a server with notifications and a relay this app
 * can use, the app asks iOS for permission and, if allowed, turns "On this phone" on as the switch
 * does. Once per account on a server: the record is in `state/` (`push-asked.json`), wiped with
 * the account's data, and written before the question, so a question the person dismissed, or an
 * app stopped mid-question, is never asked again by itself. The Account switch marks it too, so
 * a person who turned notifications off there never has them turned back on.
 */
public enum PushAsk {
    static let file = "push-asked.json"

    static func key(_ session: SharedKeychain.Session) -> String { session.origin + "\n" + session.userId.lowercased() }

    public static func asked(_ session: SharedKeychain.Session) -> Bool {
        (Unbacked.read([String].self, file) ?? []).contains(key(session))
    }

    public static func markAsked(_ session: SharedKeychain.Session) {
        var asked = Unbacked.read([String].self, file) ?? []
        guard !asked.contains(key(session)) else { return }
        asked.append(key(session))
        Unbacked.write(asked, file)
    }

    /* What iOS says of HushOS's notifications, as far as asking goes. */
    public enum Permission: Sendable {
        /* Never asked: iOS shows its question. */
        case undecided
        /* Allowed (provisional and ephemeral included): no question, registered at once. */
        case allowed
        /* Declined in the question or turned off in Settings. */
        case denied
    }

    public enum Step: Equatable, Sendable {
        /* Nothing now: not this time, or never again. */
        case nothing
        /* Mark it asked, then ask iOS; register if allowed. */
        case ask
        /* Mark it asked, then register as the switch does: iOS allowed HushOS already. */
        case register
        /* Mark it asked and go no further: the person said no to iOS before. */
        case markOnly
    }

    /*
     * The one decision. Nothing while this build can't get pushes, this phone already has a
     * registration for the account, it was asked before, or the server has no relay this app can
     * use (asked again once it has one: nothing was asked yet).
     */
    public static func step(available: Bool, registered: Bool, asked: Bool, relay: String?, permission: Permission) -> Step {
        guard available, !registered, !asked, relay != nil else { return .nothing }
        switch permission {
        case .undecided: return .ask
        case .allowed: return .register
        case .denied: return .markOnly
        }
    }
}
