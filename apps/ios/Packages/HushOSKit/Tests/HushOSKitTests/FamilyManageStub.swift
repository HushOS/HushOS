import Foundation
import HushOSCore
@testable import HushOSKit

/*
 * The family stub server's manager routes, as Android's FamilyFixture for #265: the phone's
 * account (the fixture's member) made a manager with the group key sealed to it (route 8), people
 * waiting to join (16) who can be pinned through the contacts lookup, invitations (11, 12, 13),
 * Not now (26), Let them in (17) applied as the server applies it (stale unless built at the
 * head's revision, the roster checked to follow the chain, the person let in), owed grants (22),
 * and settings reads that can fail. Every roster call's bytes and HushOS-Client header are kept.
 */
final class ManageStub: @unchecked Sendable {
    /* Route 2's roles for the phone's account. */
    var listedRoles: [String] = []
    var keySeal: [String: Any]?
    var pendingRows: [[String: Any]] = []
    var pendingAnswer: (Int, Any)?
    var invitationRows: [[String: Any]] = []
    var invitationsAnswer: (Int, Any)?
    /* Answers routes 11, 13 and 26 instead of the server's. */
    var manageAnswer: (Int, Any)?
    /* Scripted answers for route 17, oldest first (each handed the body); then applied as the server would. */
    var admitAnswers: [@Sendable ([String: Any]) -> (Int, Any)?] = []
    var callBodies: [Data] = []
    var callClients: [String] = []
    var grantPosts: [(workspaceId: String, body: Data)] = []
    var grantsAnswer: (Int, Any)?
    var failSettingsReads = false
    /* People the contacts lookup answers for, by email, and route 6 names. */
    var people: [String: (person: FamilyPerson, name: String)] = [:]
    var invites: [[String: Any]] = []
    var cancelled: [String] = []
    var declined: [String] = []
    /* Runs as a request arrives (method, path), before it is answered. */
    var beforeAnswer: (@Sendable (String, String) -> Void)?
}

/*
 * `body` on a thread with an 8 MB stack, waited for: the core's ML-DSA keys run past a test's or a
 * loading thread's stack (onLargeStack, for code that can't await).
 */
final class LargeStackBox<T>: @unchecked Sendable {
    var run: (() throws -> T)?
    var result: Result<T, Error>?
}

func onLargeStackNow<T>(_ body: () throws -> T) throws -> T {
    try withoutActuallyEscaping(body) { body in
        let box = LargeStackBox<T>()
        box.run = body
        let done = DispatchSemaphore(value: 0)
        let thread = Thread {
            box.result = Result { try box.run!() }
            // Let go of the closure before the caller goes on: it must not outlive the call.
            box.run = nil
            done.signal()
        }
        thread.stackSize = 8 << 20
        thread.start()
        done.wait()
        return try box.result!.get()
    }
}

extension FamilyServer {
    /* The chain as the creator's device accepted it: what their next roster is built over. Under the lock. */
    func creatorChain(_ rosters: [SignedGroupStatement]? = nil) throws -> AcceptedRosters {
        let f = family
        let rosters = rosters ?? chain
        return try onLargeStackNow {
            guard case .accepted(let chain) = try acceptRosters(groupId: f.groupId, firstKeys: try f.firstKeys, anchor: .created, pins: [], rosters: rosters,
                                                               successions: [], mlDsaKeys: try f.signerKeys, me: f.creator.own, cache: nil)
            else { throw FamilyFailure(message: "the creator's chain didn't accept") }
            return chain
        }
    }

    /*
     * The creator makes the phone's account a manager (roster 3, after its admission at 2) and
     * seals the family's key to it: what it needs to let anyone in.
     */
    func memberManages() throws {
        let f = family
        try lock.withLock {
            let accepted = try creatorChain([f.r1, f.r2])
            let members = accepted.roster().members.map { member -> RosterMember in
                var member = member
                if member.userId == f.member.userId.lowercased() { member.roles = [.members] }
                return member
            }
            let r3 = try onLargeStackNow {
                try rosterSign(roster: try rosterNext(chain: accepted, members: members, signerUserId: f.creator.userId, areaKeys: nil, retireAreas: nil, format: nil),
                               groupSeed: f.groupSeed, signer: f.creator.keys)
            }
            chain = [f.r1, f.r2, r3]
            manage.listedRoles = ["members"]
            let head = try creatorChain()
            let digest = rosterDigest(statement: r3.statement)
            let sealed = try onLargeStackNow { try groupKeySeal(seed: f.groupSeed,
                                          ctx: GroupKeySealContext(groupId: f.groupId, groupKeyVersion: 1, holderUserId: f.member.userId.lowercased(),
                                                                   holderKeyVersion: f.member.keys.keyVersion, sealerUserId: f.creator.userId, rosterVersion: 3,
                                                                   rosterDigest: digest),
                                          chain: head, holderKemPublicKey: try base64urlDecode(value: f.member.keys.kemPublicKey!), sealer: f.creator.keys) }
            manage.keySeal = ["groupKeyVersion": 1, "holderKeyVersion": f.member.keys.keyVersion, "sealerUserId": f.creator.userId, "rosterVersion": 3,
                              "rosterDigest": digest, "envelope": base64urlEncode(bytes: sealed)]
        }
    }

    /* The creator changes the member list on their own (a roster that only re-signs it): another manager's win. */
    func creatorChangesTheList() throws {
        let f = family
        try lock.withLock {
            let accepted = try creatorChain()
            chain += [try onLargeStackNow {
                try rosterSign(roster: try rosterNext(chain: accepted, members: accepted.roster().members, signerUserId: f.creator.userId,
                                                      areaKeys: nil, retireAreas: nil, format: nil),
                               groupSeed: f.groupSeed, signer: f.creator.keys)
            }]
        }
    }

    /* `person` accepted an invitation and waits to be let in, with the identity HushOS serves for them now. */
    func waiting(_ person: FamilyPerson, email: String, name: String) {
        lock.withLock {
            manage.people[email] = (person, name)
            manage.pendingRows.removeAll { $0["userId"] as? String == person.userId.lowercased() }
            manage.pendingRows.append(["userId": person.userId.lowercased(), "name": name, "email": email, "roles": [String](),
                                       "acceptedAt": "2026-11-02T10:00:00.000Z", "identity": Self.served(person), "inFamily": false])
        }
    }

    static func served(_ person: FamilyPerson) -> [String: Any] {
        let keys = person.keys
        return ["keyVersion": keys.keyVersion, "encryptionPublicKey": keys.encryptionPublicKey, "signingPublicKey": keys.signingPublicKey,
                "mlDsaPublicKey": keys.mlDsaPublicKey!, "kemPublicKey": keys.kemPublicKey!, "keysSignature": person.envelope.keysSignature ?? ""]
    }

    var callBodies: [Data] { lock.withLock { manage.callBodies } }
    var callClients: [String] { lock.withLock { manage.callClients } }

    /* The manager routes; nil for anything else. */
    func manageRoute(_ request: URLRequest, method: String, path: String, body: Data?, sent: [String: Any]) -> (Int, Any)? {
        let f = family
        let hook = lock.withLock { manage.beforeAnswer }
        hook?(method, path)
        if method == "GET", path == "/api/auth/settings", lock.withLock({ manage.failSettingsReads }) {
            return (503, ["message": "HushOS is temporarily unavailable."])
        }
        if method == "POST", path == "/api/auth/contacts/lookup" {
            guard let email = sent["email"] as? String, let (person, name) = lock.withLock({ manage.people[email] }) else {
                return (404, ["message": "No HushOS account uses that email."])
            }
            let served = person.envelope
            return (200, ["contact": [
                "userId": person.userId, "name": name, "email": email, "keyVersion": served.keyVersion, "identityVersion": Int(served.version),
                "encryptionPublicKey": served.encryptionPublicKey, "signingPublicKey": served.signingPublicKey,
                "mlDsaPublicKey": served.mlDsa?.publicKey as Any, "kemPublicKey": served.kem?.publicKey as Any, "keysSignature": served.keysSignature as Any,
            ]])
        }
        let group = "/api/groups/\(f.groupId)"
        guard path.hasPrefix(group) else { return nil }
        let rest = String(path.dropFirst(group.count))
        let parts = rest.split(separator: "/").map(String.init)
        let handled = ["key-seal", "pending", "invitations", "members", "areas"].contains(parts.first ?? "")
            && !(parts.first == "areas" && parts.last != "grants")
        if handled, notMember { return (404, ["code": "not-member", "message": "You are not in this group."]) }
        switch (method, parts) {
        case ("GET", ["key-seal"]):
            return lock.withLock { manage.keySeal.map { (200, $0 as Any) } ?? (409, ["code": "no-seal", "message": "No seal."] as Any) }
        case ("GET", ["pending"]):
            return lock.withLock { manage.pendingAnswer ?? (200, ["pending": manage.pendingRows]) }
        case ("GET", ["invitations"]):
            return lock.withLock { manage.invitationsAnswer ?? (200, ["invitations": manage.invitationRows]) }
        case ("POST", ["invitations"]):
            return lock.withLock {
                manage.invites.append(sent)
                return manage.manageAnswer ?? (201, ["id": UUID().uuidString.lowercased(), "expiresAt": "2026-11-09T10:00:00.000Z"])
            }
        case ("DELETE", let p) where p.count == 2 && p[0] == "invitations":
            return lock.withLock {
                manage.cancelled.append(p[1])
                if let answer = manage.manageAnswer { return answer }
                manage.invitationRows.removeAll { $0["id"] as? String == p[1] }
                return (200, ["revoked": true])
            }
        case ("POST", let p) where p.count == 3 && p[0] == "members" && p[2] == "decline":
            return lock.withLock {
                manage.declined.append(p[1])
                if let answer = manage.manageAnswer { return answer }
                manage.pendingRows.removeAll { $0["userId"] as? String == p[1] }
                return (200, ["declined": true])
            }
        case ("POST", let p) where p.count == 3 && p[0] == "areas" && p[2] == "grants":
            return lock.withLock {
                manage.grantPosts.append((p[1], body ?? Data()))
                return manage.grantsAnswer ?? (200, ["ok": true])
            }
        case ("POST", let p) where p.count == 3 && p[0] == "members" && p[2] == "admit":
            let scripted = lock.withLock { () -> (@Sendable ([String: Any]) -> (Int, Any)?)? in
                manage.callBodies.append(body ?? Data())
                manage.callClients.append(request.value(forHTTPHeaderField: "HushOS-Client") ?? "")
                return manage.admitAnswers.isEmpty ? nil : manage.admitAnswers.removeFirst()
            }
            if let scripted, let answer = scripted(sent) { return answer }
            return lock.withLock { apply(sent, userId: p[1]) }
        default:
            return nil
        }
    }

    /*
     * A roster call applied as the server applies it: `stale` unless built at the head's revision,
     * `invalid` unless its roster follows the chain, then appended and the person let in. Under the lock.
     */
    func apply(_ body: [String: Any], userId: String) -> (Int, Any) {
        guard (body["expectedRevision"] as? NSNumber)?.intValue == chain.count else {
            return (409, ["code": "stale", "message": "Another change to the family landed first."])
        }
        guard let wire = body["roster"] as? [String: Any], let next = Self.signed(wire), (try? creatorChain(chain + [next])) != nil else {
            return (400, ["code": "invalid", "message": "The change was refused.", "data": ["reason": "roster-chain"]])
        }
        chain += [next]
        manage.pendingRows.removeAll { ($0["userId"] as? String)?.lowercased() == userId.lowercased() }
        return (200, ["version": chain.count, "digest": rosterDigest(statement: next.statement), "revision": chain.count, "groupKeyVersion": 1, "replayed": false])
    }

    static func signed(_ wire: [String: Any]) -> SignedGroupStatement? {
        guard let statement = (wire["statement"] as? String).flatMap({ try? base64urlDecode(value: $0) }),
              let signature = wire["signature"] as? [String: Any],
              let ed = (signature["ed25519"] as? String).flatMap({ try? base64urlDecode(value: $0) }),
              let mlDsa = (signature["mlDsa"] as? String).flatMap({ try? base64urlDecode(value: $0) }),
              let signer = (wire["signerSignature"] as? String).flatMap({ try? base64urlDecode(value: $0) }) else { return nil }
        return SignedGroupStatement(statement: statement, signature: GroupSignature(ed25519: ed, mlDsa: mlDsa), signerSignature: signer)
    }
}

extension FamilyPerson {
    /* The same account under new keys (they reset their account, or changed it on another device). */
    init(userId: String, keyVersion: UInt64) throws {
        self.userId = userId
        root = try randomBytes(length: 32)
        envelope = try identityCreate(userId: userId, accountKey: root, keyVersion: keyVersion)
        keys = try identityOpen(userId: userId, accountKey: root, envelope: envelope)
    }
}

/* A scripted route 17 answer: always `status` with `body`. */
func answering(_ status: Int, _ body: [String: Any]) -> @Sendable ([String: Any]) -> (Int, Any)? {
    nonisolated(unsafe) let body = body
    return { _ in (status, body) }
}
