import Foundation

/*
 * Whose something is: an account is a user id on one server. Two servers can hold the same
 * user id (a staging copy of a production database does), so the origin is part of it. The
 * Files location, the data the phone keeps, the queue's transfers and Save to HushOS's notes
 * each record theirs, and nothing recorded for one account is read, shown or sent under another.
 */
public struct AccountOwner: Codable, Sendable, Hashable {
    public let userId: String
    public let origin: String

    /* Compared as the server compares them: ids and hosts without case, the origin without a trailing slash. */
    public init(userId: String, origin: String) {
        self.userId = userId.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        var origin = origin.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        while origin.hasSuffix("/") { origin.removeLast() }
        self.origin = origin
    }

    public init(_ session: SharedKeychain.Session) {
        self.init(userId: session.userId, origin: session.origin)
    }

    private enum CodingKeys: String, CodingKey { case userId, origin }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(userId: try container.decode(String.self, forKey: .userId), origin: try container.decode(String.self, forKey: .origin))
    }

    /* The account signed in on this phone (the session in the shared keychain), or nil when nobody is. */
    public static var signedIn: AccountOwner? { SharedKeychain.session.map(AccountOwner.init) }
}

/*
 * What the queue does with a transfer (BackgroundTransfers, and Save to HushOS's notes it
 * adopts) by whose it is. Recorded for the account signed in: it runs. Nobody signed in (the
 * session ended, the same account may sign back in): it waits. Recorded for another account,
 * or for none (queued before transfers recorded theirs): it is dropped, never run, since its
 * file, folder and upload belong to whoever queued it.
 */
public enum TransferOwnership: Equatable, Sendable {
    case run, wait, drop

    public static func of(_ owner: AccountOwner?, signedIn: AccountOwner?) -> TransferOwnership {
        guard let signedIn else { return .wait }
        return owner == signedIn ? .run : .drop
    }
}
