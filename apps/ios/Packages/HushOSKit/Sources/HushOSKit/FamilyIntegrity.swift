import Foundation
import HushOSCore

/*
 * A family folder item's mark and Info lines, ported from the web: `recordIssues` and
 * `sortIssues` (packages/drive/src/trust.ts) and `nameSigner`, `issueLines`, `markLabel`,
 * `changedByLabel`/`changedByWords`, `rekeyedLines` and `verifiedByLine`
 * (apps/web/src/lib/integrity-lines.ts), in the family's case only (`names.family` is always
 * set here). Pure, so the words a server could steer by what it serves are tested on their own.
 */

/* Which record of a node a verdict is about. */
public enum FamilyRecordKind: String, Sendable, Equatable { case metadata, version }

/* Why a re-keyed record carries a mark of its own making (trust.ts RekeyCause). */
public enum RekeyCause: String, Sendable, Equatable { case mismatch, unconfirmed, unattested }

/* Who wrote a re-keyed record, who locked it again, the re-keyer's verdict and whether the bytes bound (trust.ts RekeyNote). */
public struct RekeyNote: Sendable, Equatable {
    public let writer: String?
    public let by: String?
    public let integrity: GroupVerdict
    public let bound: Bool?
}

/* One record that did not verify (trust.ts IntegrityIssue); `integrity` is never verified or saved-from-link. */
public struct FamilyIssue: Sendable, Equatable {
    public struct Rekey: Sendable, Equatable {
        public let cause: RekeyCause
        public let rekeyer: GroupVerdict
    }
    public let record: FamilyRecordKind
    public let integrity: GroupVerdict
    public let signer: String?
    public var rekey: Rekey? = nil
}

/* One record as judged: its verdict (a re-keyed record's is its origin's), whose word vouched, and its re-key note. */
public struct FamilyJudged: Sendable, Equatable {
    public let record: FamilyRecordKind
    public let verdict: GroupVerdict
    public let via: String?
    /* Who the server says signed the record (the re-keyer for a re-keyed one). */
    public let signer: String?
    public let note: RekeyNote?
}

/* Who a line can name (integrity-lines.ts SignerNames, the family's case). */
public struct FamilyNames: Sendable, Equatable {
    public struct Member: Sendable, Equatable {
        public let name: String
        public let email: String?
    }
    public struct Vouched: Sendable, Equatable {
        public let name: String
        public let email: String
        public let family: String
    }
    public let userId: String
    /* Pins whose words count, by lowercase user id: their names. */
    public let checked: [String: String]
    /* Pins taken on a family's word, by lowercase user id. */
    public var vouched: [String: Vouched] = [:]
    public let family: String
    /* Route 3's members, by lowercase user id: named as the server names them, address beside (D10). */
    public let members: [String: Member]
}

/* A family mark: its face, its lines, and the way out where there is one. */
public struct FamilyMark: Sendable, Equatable, Hashable {
    public let label: String
    public let lines: [String]
    /* A key conflict (no re-key) is worse than Unverified: the danger colour, as its words say. */
    public let danger: Bool
    /* A check that could not run: Try again. */
    public let retry: Bool
    /* A writer nobody checked, by account id: Check their words. */
    public let check: String?
}

enum FamilyLines {
    /* The re-keyer verdicts that leave the record unmarked: said in Info, never as a mark (decision D5). */
    // Stop-gap (docs/optional-verification.md PR 1): a first-seen writer (`seen`) reads as one nobody checked until PR 5/6 design its own UI; this app never asks for `seen` yet.
    static let infoOnly: [GroupVerdict] = [.verified, .savedFromLink, .retiredKey, .unknownSigner, .seen, .unchecked, .formerMember, .resealed]

    static func trusted(_ verdict: GroupVerdict) -> Bool { verdict == .verified || verdict == .savedFromLink }

    /* trust.ts recordIssues. */
    static func recordIssues(_ record: FamilyRecordKind, _ integrity: GroupVerdict, signer: String?, note: RekeyNote?) -> [FamilyIssue] {
        var issues: [FamilyIssue] = []
        if let note {
            let rekeyer = note.integrity
            // A re-key cause names someone only when their own verified signature covers what failed.
            if note.bound == false {
                issues.append(FamilyIssue(record: record, integrity: .badSignature, signer: rekeyer == .verified ? note.by : nil,
                                          rekey: .init(cause: .mismatch, rekeyer: rekeyer)))
            } else if note.bound == nil {
                issues.append(FamilyIssue(record: record, integrity: .unchecked, signer: nil, rekey: .init(cause: .unconfirmed, rekeyer: rekeyer)))
            } else {
                if !trusted(integrity) { issues.append(FamilyIssue(record: record, integrity: integrity, signer: note.writer)) }
                if !infoOnly.contains(rekeyer) {
                    issues.append(FamilyIssue(record: record, integrity: rekeyer, signer: nil, rekey: .init(cause: .unattested, rekeyer: rekeyer)))
                }
            }
            return issues
        }
        if !trusted(integrity) { issues.append(FamilyIssue(record: record, integrity: integrity, signer: signer)) }
        return issues
    }

    /* trust.ts sortIssues: worst first, stable; a re-key that is not attested ranks with a re-sealed record. */
    static func sorted(_ issues: [FamilyIssue]) -> [FamilyIssue] {
        func rank(_ verdict: GroupVerdict) -> Int {
            switch verdict {
            case .keyConflict: 0
            case .badSignature: 1
            case .retiredKey: 2
            case .formerMember: 3
            case .unknownSigner, .seen: 4
            case .unsigned: 5
            case .resealed: 6
            case .unchecked: 7
            case .verified, .savedFromLink: 8
            }
        }
        func of(_ issue: FamilyIssue) -> Int { issue.rekey?.cause == .unattested ? rank(.resealed) : rank(issue.integrity) }
        return issues.enumerated().sorted { a, b in
            of(a.element) != of(b.element) ? of(a.element) < of(b.element) : a.offset < b.offset
        }.map(\.element)
    }

    static func issues(_ records: [FamilyJudged]) -> [FamilyIssue] {
        sorted(records.flatMap { recordIssues($0.record, $0.verdict, signer: $0.signer, note: $0.note) })
    }

    enum Named: Equatable {
        case you
        case contact(name: String, vouched: FamilyNames.Vouched?)
        case member(name: String, email: String?)
        case unknown
    }

    static func name(_ signer: String?, _ names: FamilyNames) -> Named {
        guard let signer else { return .unknown }
        let id = signer.lowercased()
        if id == names.userId.lowercased() { return .you }
        if let name = names.checked[id] { return .contact(name: name, vouched: names.vouched[id]) }
        if let member = names.members[id] { return .member(name: member.name, email: member.email) }
        return .unknown
    }

    static func firstName(_ name: String) -> String {
        name.split(whereSeparator: \.isWhitespace).first.map(String.init) ?? name
    }

    static func plainContact(_ name: String, _ vouched: FamilyNames.Vouched?) -> String {
        vouched.map { "\($0.name) (\($0.email))" } ?? name
    }

    /* A member as a sentence names them: a checked contact by their pin, anyone else as the server does. */
    static func memberWords(_ named: Named, fallback: String) -> String {
        switch named {
        case .contact(let name, _): firstName(name)
        case .member(let name, let email): email.map { "\(name) (\($0))" } ?? name
        default: fallback
        }
    }

    static func personWords(_ named: Named) -> String? {
        switch named {
        case .you: "you"
        case .unknown: nil
        default: memberWords(named, fallback: "")
        }
    }

    static let cantConfirm = "HushOS can’t confirm who wrote this."
    static let cantConfirmVersion = "HushOS can’t confirm who added this version."
    static let couldntCheck = "HushOS couldn’t check who wrote this. Try again later."
    static let rekeyUnconfirmed = "HushOS couldn’t confirm this item since its keys were replaced."
    static let rekeyUnconfirmedVersion = "HushOS couldn’t confirm this version since its keys were replaced."
    static let rekeyUnattested = "HushOS can’t confirm who replaced this item’s keys."

    struct Line: Equatable {
        let text: String
        var retry = false
        var check: String? = nil
    }

    /* integrity-lines.ts rekeyLine. */
    static func rekeyLine(_ issue: FamilyIssue, _ named: Named) -> Line {
        let version = issue.record == .version
        switch issue.rekey!.cause {
        case .mismatch:
            let who = issue.rekey!.rekeyer == .verified ? personWords(named) : nil
            return Line(text: version
                ? "This version as \(who.map { "\($0) locked it" } ?? "it was locked") again doesn’t match what was added. Don’t trust this item."
                : "What \(who.map { "\($0) locked" } ?? "was locked") again doesn’t match what was written. Don’t trust this item.")
        case .unconfirmed:
            return Line(text: version ? rekeyUnconfirmedVersion : rekeyUnconfirmed, retry: true)
        case .unattested:
            return Line(text: rekeyUnattested)
        }
    }

    /* integrity-lines.ts line, inside a family's folders. */
    static func line(_ issue: FamilyIssue, _ names: FamilyNames) -> Line {
        let version = issue.record == .version
        let named = name(issue.signer, names)
        let plain = version ? cantConfirmVersion : cantConfirm
        if issue.rekey != nil { return rekeyLine(issue, named) }
        switch issue.integrity {
        case .keyConflict:
            if case .contact(_, let vouched?) = named {
                return Line(text: "\(vouched.name) (\(vouched.email))’s keys don’t match the ones \(vouched.family) vouched for. Check it’s them again.", check: issue.signer)
            }
            let who = memberWords(named, fallback: "Its writer")
            return Line(text: "\(who == "Its writer" ? "Its writer’s" : "\(who)’s") keys don’t match the ones you checked. Check it’s them again.", check: issue.signer)
        case .formerMember:
            return Line(text: "\(version ? "Added" : "Written") by \(memberWords(named, fallback: "someone you haven’t checked")), who has left \(names.family).")
        case .unchecked:
            return Line(text: couldntCheck, retry: true)
        case .unsigned:
            return Line(text: plain)
        case .unknownSigner, .seen:
            return Line(text: "\(plain) It was \(version ? "added" : "added or last changed") by someone you haven’t checked.",
                        check: issue.signer != nil && named == .unknown ? issue.signer : nil)
        case .badSignature:
            // In a family's folders a server withholding a member's links makes genuine records read this way: said as what it is.
            return Line(text: version ? "HushOS couldn’t verify this version’s signature." : "HushOS couldn’t verify this signature.")
        case .retiredKey:
            let who: String
            switch named {
            case .you: who = "you have"
            case .contact(let name, let vouched): who = "\(plainContact(name, vouched)) has"
            default: who = "its writer has"
            }
            return Line(text: "\(version ? "This version was signed" : "Signed") with keys \(who) since replaced.")
        case .resealed:
            let by: String
            switch named {
            case .you: by = "you"
            case .contact(let name, let vouched): by = plainContact(name, vouched)
            default: by = "someone you haven’t checked"
            }
            return Line(text: "\(version ? "This version was re-locked" : "Re-locked") by \(by); HushOS couldn’t confirm who wrote it before.")
        case .verified, .savedFromLink:
            return Line(text: "")
        }
    }

    /* integrity-lines.ts issueLines: the same thing said once. */
    static func lines(_ issues: [FamilyIssue], _ names: FamilyNames) -> [Line] {
        guard issues.count >= 2 else { return issues.map { line($0, names) } }
        let (a, b) = (issues[0], issues[1])
        let sameSigner = a.signer?.lowercased() == b.signer?.lowercased()
        if let ra = a.rekey, let rb = b.rekey, ra.cause == rb.cause, sameSigner { return [line(a.record == .metadata ? a : b, names)] }
        if a.rekey == nil, b.rekey == nil, a.integrity == b.integrity, a.integrity != .badSignature, a.integrity == .unchecked || sameSigner {
            return [line(a.record == .metadata ? a : b, names)]
        }
        return issues.map { line($0, names) }
    }

    /* integrity-lines.ts markLabel. */
    static func label(_ issues: [FamilyIssue]) -> String {
        if !issues.isEmpty, issues.allSatisfy({ $0.integrity == .unchecked }) { return "Couldn’t check" }
        if issues.contains(where: { $0.integrity == .keyConflict && $0.rekey == nil }) { return "Keys don’t match" }
        return "Unverified"
    }

    static func mark(_ issues: [FamilyIssue], _ names: FamilyNames) -> FamilyMark? {
        guard !issues.isEmpty else { return nil }
        let lines = lines(issues, names)
        return FamilyMark(label: label(issues), lines: lines.map(\.text),
                          danger: issues.first.map { $0.integrity == .keyConflict && $0.rekey == nil } ?? false,
                          retry: lines.contains { $0.retry }, check: lines.first { $0.check != nil }?.check)
    }

    /* integrity-lines.ts changedByLabel. */
    static func changedByLabel(_ issue: FamilyIssue) -> String {
        if issue.integrity != .formerMember || issue.rekey != nil { return "Changed by" }
        return issue.record == .version ? "Added by" : "Written by"
    }

    /* integrity-lines.ts changedByWords. */
    static func changedByWords(_ issue: FamilyIssue, _ names: FamilyNames) -> String {
        if let rekey = issue.rekey, !(rekey.cause == .mismatch && rekey.rekeyer == .verified) { return "Not confirmed" }
        if issue.integrity == .unchecked { return "Not checked" }
        let named = name(issue.signer, names)
        if issue.integrity == .formerMember {
            let who = memberWords(named, fallback: "someone you haven’t checked")
            return "\(who.prefix(1).uppercased())\(who.dropFirst()), who has left \(names.family)."
        }
        switch named {
        case .you: return "You"
        case .contact(let name, let vouched): return plainContact(name, vouched)
        case .member(let name, let email): return email.map { "\(name) (\($0))" } ?? name
        case .unknown: return issue.signer != nil ? "Someone you haven’t checked" : "Unknown"
        }
    }

    /* integrity-lines.ts rekeyedLines: who wrote a re-keyed item and who locked it again. */
    static func rekeyed(_ records: [FamilyJudged], _ names: FamilyNames) -> (writtenBy: String?, replacedBy: [String]) {
        guard records.contains(where: { $0.note != nil }) else { return (nil, []) }
        let bound = records.filter { $0.note?.bound == true }
        guard !bound.isEmpty else { return (nil, []) }
        func words(_ signer: String?, you: String) -> String? {
            switch name(signer, names) {
            case .you: return you
            case .unknown: return nil
            case let named: return memberWords(named, fallback: "")
            }
        }
        func label(_ record: FamilyRecordKind) -> String { record == .metadata ? "name" : "content" }
        func labelled(_ phrases: [(label: String, phrase: String?)]) -> [String] {
            let present = phrases.compactMap { entry in entry.phrase.map { (entry.label, $0) } }
            if Set(present.map(\.1)).count <= 1 { return present.prefix(1).map(\.1) }
            return present.map { "\($0.1) (\($0.0))" }
        }
        let writers = records.allSatisfy({ trusted($0.verdict) })
            ? labelled(records.map { (label($0.record), words($0.note != nil ? $0.note!.writer : $0.signer, you: "You")) })
            : []
        let replacedBy = labelled(bound.map { record in
            let note = record.note!
            let by = words(note.by, you: "you")
            let phrase: String?
            switch note.integrity {
            case .verified: phrase = by.map { "Keys replaced by \($0)" }
            case .retiredKey: phrase = "Keys replaced by \(by ?? "someone you haven’t checked"), with keys since replaced"
            case .formerMember: phrase = "Keys replaced by \(by ?? "someone you haven’t checked"), who has left \(names.family)"
            case .unknownSigner, .seen: phrase = "Keys replaced by someone you haven’t checked"
            case .unchecked: phrase = "HushOS couldn’t check who replaced its keys"
            default: phrase = nil
            }
            return (label(record.record), phrase)
        })
        return (writers.isEmpty ? nil : writers.joined(separator: ", "), replacedBy)
    }

    /*
     * integrity-lines.ts verifiedByLine for this folder's family: every record verified, one at
     * least on the family's word. Never beside a mark (an unattested re-key leaves the origin verified).
     */
    static func vouched(_ records: [FamilyJudged], issues: [FamilyIssue], groupId: String) -> Bool {
        guard issues.isEmpty, records.allSatisfy({ $0.verdict == .verified }) else { return false }
        return records.contains { $0.via?.lowercased() == groupId.lowercased() }
    }
}
