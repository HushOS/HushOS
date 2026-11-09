import Foundation

/*
 * Asking once (docs/devices-design.md 5, Settings): right after a sign-in or sign-up, or at the
 * first signed-in start of a build that asks, on a server with notifications and a relay this app
 * can use, the app asks iOS for permission and, if allowed, turns "On this phone" on as the switch
 * does. Where iOS already allows HushOS (the person allowed it for the switch and switched it off
 * since, for background uploads, or before signing out and back in), the app can't tell a yes from
 * an earlier "off", so it asks in its own words instead, once, and only a tap on Turn on registers.
 *
 * Once per account on a server: the record is in `state/` (`push-asked.json`), wiped with the
 * account's data, and marked before the question, so a question the person dismissed, or an app
 * stopped mid-question, is never asked again by itself.
 */
public enum PushAsk {
    static let file = "push-asked.json"

    /* What the record says of an account on a server. None: nothing was asked yet. */
    public enum Mark: String, Codable, Sendable {
        /* The app asked iOS, or is about to: never again by itself. */
        case asked
        /* The person allowed it, but the registration didn't go through: made at the next start, with no question. */
        case retry
        /* The person used Account's switch: the app never asks or registers by itself after that. */
        case decided
    }

    /* What iOS says of HushOS's notifications, as far as asking goes. */
    public enum Permission: Sendable {
        /* Never asked: iOS shows its question. */
        case undecided
        /* Allowed (provisional and ephemeral included). */
        case allowed
        /* Declined in the question or turned off in Settings. */
        case denied
    }

    public enum Step: Equatable, Sendable {
        /* Nothing now: not this time, or never again. */
        case nothing
        /* Mark it asked, then ask iOS; register if allowed. */
        case ask
        /* Register as the switch does, with no question: a yes from before whose registration failed. */
        case register
        /* Mark it asked, then ask in the app's own words (iOS allows HushOS already); register on Turn on. */
        case offer
        /* Mark it asked and go no further. */
        case markOnly
    }

    /*
     * The one decision. Nothing while this build can't get pushes, this phone already has a
     * registration for the account, the server has no relay this app can use (asked once it has
     * one: nothing was asked yet), or the record says asked or decided.
     */
    public static func step(available: Bool, registered: Bool, mark: Mark?, relay: String?, permission: Permission) -> Step {
        guard available, !registered, relay != nil else { return .nothing }
        switch mark {
        case .asked?, .decided?: return .nothing
        case .retry?: return permission == .allowed ? .register : .markOnly
        case nil:
            switch permission {
            case .undecided: return .ask
            case .allowed: return .offer
            case .denied: return .markOnly
            }
        }
    }

    static func key(_ session: SharedKeychain.Session) -> String { session.origin + "\n" + session.userId.lowercased() }

    /*
     * The record, one file of marks by server and account. Every change is a compare-and-set under
     * one lock, so the app's own asking and Account's switch never overwrite each other's answer.
     */
    public struct Record: Sendable {
        let url: URL

        public init(folder: URL) { url = folder.appendingPathComponent(PushAsk.file) }

        public static var shared: Record { Record(folder: Unbacked.state) }

        private static let lock = NSLock()

        public func mark(_ session: SharedKeychain.Session) -> Mark? {
            Self.lock.lock()
            defer { Self.lock.unlock() }
            return read()[PushAsk.key(session)]
        }

        /* Sets `mark` only while the account's mark is still `expected`; true when it did. */
        @discardableResult
        public func set(_ session: SharedKeychain.Session, to mark: Mark, ifStill expected: Mark?) -> Bool {
            Self.lock.lock()
            defer { Self.lock.unlock() }
            var marks = read()
            guard marks[PushAsk.key(session)] == expected else { return false }
            marks[PushAsk.key(session)] = mark
            write(marks)
            return true
        }

        /* Account's switch, either way: the person decided, so the app does nothing by itself again. */
        public func decided(_ session: SharedKeychain.Session) {
            Self.lock.lock()
            defer { Self.lock.unlock() }
            var marks = read()
            marks[PushAsk.key(session)] = .decided
            write(marks)
        }

        private func read() -> [String: Mark] {
            guard let data = try? Data(contentsOf: url) else { return [:] }
            return (try? JSONDecoder().decode([String: Mark].self, from: data)) ?? [:]
        }

        private func write(_ marks: [String: Mark]) {
            guard let data = try? JSONEncoder().encode(marks) else { return }
            Unbacked.folder(url.deletingLastPathComponent())
            try? data.write(to: url, options: .atomic)
        }
    }
}
