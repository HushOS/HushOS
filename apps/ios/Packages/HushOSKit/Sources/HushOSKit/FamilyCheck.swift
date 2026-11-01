import Foundation
import HushOSCore

/*
 * Who in a family this person checked, and Check it's Sam in a family (docs/optional-verification.md
 * 3.4, 3.8, 6.9, 6.10; the web's lib/family-trust.ts and components/families/family-check.tsx).
 * Per viewer, never shared: everything here reads this account's own settings pins and this phone's
 * contact guard beside the member list this phone accepted. Every rule is the core's (`pair_code`,
 * `pair_match`); this file fetches, saves and keeps the order.
 */

/* How the member list reads a member (3.8). */
public enum MemberStanding: Sendable, Equatable {
    /* This account's own verified pin of them (never a family's word) agrees with this phone's guard and names their entry's keys now. */
    case verified
    case notVerified
    /* Their pin disagrees with this phone's guard: their account changed. */
    case changed
}

/* The words of a family check, or why there are none. */
public enum FamilyCheckCode: Sendable, Equatable {
    /* The twelve words, over the roster at `rosterVersion`, with that roster's digest for Technical details. */
    case code(rosterVersion: UInt64, code: [String], rosterDigest: String?)
    /* This phone's own entry was wrong at that roster: no words; their own twelve words instead. */
    case ownEntryWrong
    /* One of the two isn't in the family on this phone yet. */
    case notAdmitted
}

/* What They match saved: `checked`, the check record (the codes matched here); `verified`, a verified pin of them too. */
public struct FamilyCheckSaved: Sendable, Equatable {
    public let checked: Bool
    public let verified: Bool
}

/* A member as route 3 names them, for the check's words and the pin it may write. */
public struct FamilyMemberRef: Sendable, Equatable, Hashable {
    public let userId: String
    public let email: String
    public let name: String
    public init(userId: String, email: String, name: String) {
        self.userId = userId
        self.email = email
        self.name = name
    }
}

extension FamilySync {
    /*
     * Each member's standing on this phone (3.8): `verified` only when this account's own verified
     * pin of them (no `trustedVia`) agrees with the guard and its key commitment is their entry's
     * now, which is also the manager rule (3.6); `changed` when the pin disagrees with the guard;
     * anything else not verified. This account's own row has none. A guard that can't be read
     * throws: nobody is shown verified.
     */
    public func memberStandings(_ view: FamilyView) async throws -> [String: MemberStanding] {
        // One read of the settings and the guard: the verdict and the keys compared with the entry are the same pin's.
        let standings = try await vault.guardedStandings()
        var out: [String: MemberStanding] = [:]
        for member in view.members where member.userId.lowercased() != userId.lowercased() {
            let id = member.userId.lowercased()
            let standing = standings[id]
            if standing?.changed == true {
                out[id] = .changed
                continue
            }
            guard let standing, standing.verified, standing.pin.trustedVia == nil, standing.pin.trust == .verified,
                  let held = standing.pin.commitment, held == member.commitment else {
                out[id] = .notVerified
                continue
            }
            out[id] = .verified
        }
        return out
    }

    /*
     * What opening Check it's Sam found: the family as its sync left it (`state`, for the screens to
     * show as after any sync: a fork's warning, a removal, Couldn't check), and the words when it
     * accepted (`code`); otherwise why there are none (`problem`).
     */
    public struct CheckStart: Sendable {
        public let state: FamilyState
        public let code: FamilyCheckCode?
        public let problem: String?
    }

    /*
     * The family check's words with `memberId` (6.10, "Getting the latest" first): the family synced
     * to the server's head, then the pair code over the chain this phone committed, with the roster's
     * digest for Technical details. The sync's outcome comes back whatever it was, so the screens adopt
     * it (a fork or a removal it found clears what this phone opened, as any sync's does).
     */
    public func checkCode(_ summary: GroupSummary, with memberId: String) async throws -> CheckStart {
        let state = await sync(summary)
        if let problem = Self.checkProblem(state) { return CheckStart(state: state, code: nil, problem: problem) }
        guard let chain = acceptedChain(summary.id) else { return CheckStart(state: state, code: nil, problem: GuardWords.unreadable) }
        let served = try await fetchServed(summary.id, after: 0)
        let code: FamilyCheckCode
        switch try pairCode(chain: chain, me: try await vault.ownIdentities(), otherUserId: memberId.lowercased(), rosters: served.rosters) {
        case .code(let version, let words):
            let at = Int(version) - 1
            let digest = served.rosters.indices.contains(at) ? rosterDigest(statement: served.rosters[at].statement) : nil
            code = .code(rosterVersion: version, code: words, rosterDigest: digest)
        case .ownEntryWrong:
            code = .ownEntryWrong
        case .notAdmitted:
            code = .notAdmitted
        }
        return CheckStart(state: state, code: code, problem: nil)
    }

    /* Why Check it's Sam shows no words while the family stands as `state`; nil when it is accepted and they can show. */
    public static func checkProblem(_ state: FamilyState) -> String? {
        switch state {
        case .accepted: return nil
        case .fork: return "This family looks different on this device. Check it from the family page."
        case .failed(let words): return words
        case .wiped: return FamilyFailure.notInFamily.message
        case .waiting, .unchecked: return GuardWords.unreadable
        }
    }

    /*
     * They match (3.4): what the core allows (`pair_match`, over the chain the ledger committed and
     * this phone's guard entry for them), saved in one settings write. `checked` false when the
     * codes no longer match here (the family moved on since the words were shown): nothing saved.
     * The check record and the first-use marker go in that same save (7.2); a verified pin of them
     * only when the core found their entry's keys the very ones compared and the ones this phone
     * holds for them, committed as every trust-changing act is (a pending record, the save, the guard).
     */
    public func checkMatch(_ groupId: String, member: FamilyMemberRef, rosterVersion: UInt64, code: [String]) async throws -> FamilyCheckSaved {
        // Read first, so the ledger holds the settings pin of them it compares with.
        _ = try await vault.familyPin(groupId)
        let held = try await vault.contactGuardState(member.userId)
        let served = try await fetchServed(groupId, after: 0)
        let match = try ledger.pairMatch(me: try await vault.ownIdentities(), groupId: groupId, otherUserId: member.userId.lowercased(),
                                         rosters: served.rosters, rosterVersion: rosterVersion, code: code, guard: held.state,
                                         checkedAt: Self.checkTime(now()))
        guard let check = match.check else { return FamilyCheckSaved(checked: false, verified: false) }
        let verified = try await vault.saveFamilyCheck(groupId, member: member, check: check, keys: match.pin, decidedOver: held.revision)
        vouched[groupId] = true
        return FamilyCheckSaved(checked: true, verified: verified)
    }

    /* Whom this person's family check of `groupId` was with, if it was one (their own words check them then, 6.10). */
    public func checkedFamilyWith(_ groupId: String) async -> String? {
        (try? await vault.familyCheckWith(groupId)) ?? nil
    }
}

extension Vault {
    /* Whether this person vouched for the family, from the settings read now (Settings.familyChecked). */
    func familyChecked(_ groupId: String) async throws -> Bool { try await loadSettings().familyChecked(groupId) }

    /* The other member of this person's family check of `groupId`, if there is one. */
    func familyCheckWith(_ groupId: String) async throws -> String? { try await loadSettings().familyCheckWith(groupId) }

    /*
     * This phone's guard entry for a person, with an act left pending settled first, for a family
     * check (`pair_match` takes it), and the revision it is at, to decide the save over. A guard
     * that can't be read is `unreadable` (the core then writes no pin), never none.
     */
    func contactGuardState(_ contactId: String) async throws -> (state: GuardState, revision: UInt64) {
        try await withGuardTurn {
            let settings = try await loadSettings()
            let entry: GuardEntry?
            do {
                entry = try guardFor(contactId, pin: settings.pin(of: contactId), at: settings.version).entry
            } catch GuardError.unreadable {
                return (.unreadable, 0)
            }
            return (entry.map { .held(entry: $0) } ?? .absent, entry?.revision ?? 0)
        }
    }

    /*
     * They match in a family check, saved (the web's saveFamilyCheck): with no keys, only the check
     * record (and the marker); with keys, a verified pin of them committed from the guard entry the
     * match was decided over, the check record in the same save. A guard that moved meanwhile (a
     * Continue or a check since) stops it before anything is saved. True when the pin was written.
     */
    func saveFamilyCheck(_ groupId: String, member: FamilyMemberRef, check: FamilyCheck, keys: PinKeys?, decidedOver revision: UInt64) async throws -> Bool {
        guard let keys else {
            try await updateSettings { $0.setFamilyCheck(groupId, check) }
            return false
        }
        let contactId = member.userId
        try await withGuardTurn {
            let settings = try await loadSettings()
            let before = settings.pin(of: contactId)
            let (entry, _) = try guardFor(contactId, pin: before, at: settings.version)
            // Decided over this very entry, or not at all: a Continue or a check since is its own act.
            guard (entry?.revision ?? 0) == revision else { throw ContactError.moved }
            var target = (before ?? ContactPin(userId: contactId, email: member.email, name: member.name, keys: keys, pinnedAt: "", firstSeen: "family"))
                .replacing(keys, pinnedAt: ISO8601DateFormatter().string(from: Date()))
            // This person's own check now, never a family's word.
            target.trustedVia = nil
            if target.firstSeen == nil { target.firstSeen = "family" }
            let wanted = target
            _ = try await commitTrust(contactId, entry: entry, target: wanted) { settings in
                try settings.setPin(wanted, ifOver: before, verify: true)
                settings.setFamilyCheck(groupId, check)
            }
        }
        clearChange(contactId)
        forgetLookups(of: contactId)
        return true
    }
}

/*
 * Each family's published state as a count of publications (every sync, refresh, removal or
 * check a screen adopted). A screen that ran a sync of its own (Check it's Sam's "Getting the
 * latest") notes the count when it starts; what it found may be shown only if nothing was
 * published since, unless it is a fork or a removal, which always win: an older acceptance must
 * never cover a warning or a removal found meanwhile.
 */
public struct FamilyGenerations: Sendable {
    private var counts: [String: UInt64] = [:]
    public init() {}

    public func current(_ groupId: String) -> UInt64 { counts[groupId.lowercased(), default: 0] }

    public mutating func published(_ groupId: String) { counts[groupId.lowercased(), default: 0] += 1 }

    public func admits(_ state: FamilyState, of groupId: String, since: UInt64) -> Bool {
        switch state {
        case .fork, .wiped: return true
        default: return current(groupId) == since
        }
    }
}
