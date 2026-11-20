import Foundation
import HushOSCore
import Testing
@testable import HushOSKit

/*
 * The words of a family folder item's mark and Info, over verdicts as the core returns them
 * (the twins of integrity-lines.test.ts): what a server could steer by what it serves must
 * never read as clean, vouched for, or someone's fault.
 */
@Suite struct FamilyLinesTests {
    let group = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a"
    let me = "00000001-abcd-4abc-8abc-abcdefabcdef"
    let maya = "00000002-abcd-4abc-8abc-abcdefabcdef"
    let sam = "00000003-abcd-4abc-8abc-abcdefabcdef"

    var names: FamilyNames {
        FamilyNames(userId: me, checked: [:], family: "Lindqvist family",
                    members: [maya: .init(name: "Maya Lindqvist", email: "maya@example.com"), sam: .init(name: "Sam Lindqvist", email: "sam@example.com")])
    }

    func judged(_ verdict: GroupVerdict, by signer: String, via: String? = nil, note: RekeyNote? = nil, _ record: FamilyRecordKind = .metadata) -> FamilyJudged {
        FamilyJudged(record: record, verdict: verdict, via: via, signer: signer, note: note)
    }

    /*
     * Someone nobody checked (a family taken on first use): no mark, and Info names who added the
     * content (the version's writer before the name's), as the family serves them. Fails if the
     * writer goes unnamed, if the name's writer stands in for the content's, or if one is named
     * where a mark speaks, where the family vouches, or for this account's own records.
     */
    @Test func anUncheckedWriterIsNamedOnlyWhenNothingElseSpeaks() {
        let added = FamilySync.verdict([judged(.seen, by: sam), judged(.seen, by: maya, .version)], names: names, groupId: group)
        #expect(added.mark == nil)
        #expect(added.seen == FamilySeen(name: "Maya Lindqvist", userId: maya, email: "maya@example.com"))
        #expect(FamilySync.verdict([judged(.seen, by: sam)], names: names, groupId: group).seen?.userId == sam)

        // A mark speaks instead: no "Added by" beside it.
        let marked = FamilySync.verdict([judged(.seen, by: sam), judged(.formerMember, by: maya, .version)], names: names, groupId: group)
        #expect(marked.mark != nil && marked.seen == nil)
        // Vouched for by the family, this account's own, a re-key, or someone nobody can name: none.
        #expect(FamilySync.verdict([judged(.verified, by: sam, via: group)], names: names, groupId: group).seen == nil)
        #expect(FamilySync.verdict([judged(.seen, by: me)], names: names, groupId: group).seen == nil)
        #expect(FamilySync.verdict([judged(.seen, by: "00000009-abcd-4abc-8abc-abcdefabcdef")], names: names, groupId: group).seen == nil)
        let rekey = RekeyNote(writer: maya, by: sam, integrity: .seen, bound: true)
        #expect(FamilySync.verdict([judged(.seen, by: sam, note: rekey)], names: names, groupId: group).seen == nil)
    }

    /* A removed member's file: Unverified, said as the mark says it, never "Verified by" the family. */
    @Test func aFormerMembersFileIsUnverifiedAndNamedAsTheServerNamesThem() {
        let verdict = FamilySync.verdict([judged(.formerMember, by: sam), judged(.formerMember, by: sam, .version)], names: names, groupId: group)
        let mark = try? #require(verdict.mark)
        #expect(mark?.label == "Unverified" && mark?.danger == false)
        #expect(mark?.lines == ["Written by Sam Lindqvist (sam@example.com), who has left Lindqvist family."])
        #expect(verdict.changedBy?.label == "Written by")
        #expect(verdict.changedBy?.words == "Sam Lindqvist (sam@example.com), who has left Lindqvist family.")
        #expect(verdict.verifiedBy == nil)
    }

    /*
     * A re-keyed file whose bytes bound to Maya's verified origin, re-keyed under a signature
     * that doesn't hold: the origin alone would read clean and vouched for, but the re-key is
     * not attested, so it carries a mark and the family vouches for nothing.
     */
    @Test func anUnattestedReKeyIsMarkedAndNotVouchedFor() {
        let note = RekeyNote(writer: maya, by: sam, integrity: .badSignature, bound: true)
        let verdict = FamilySync.verdict([judged(.verified, by: sam, via: group, note: note)], names: names, groupId: group)
        #expect(verdict.mark?.label == "Unverified")
        #expect(verdict.mark?.lines == ["HushOS can’t confirm who replaced this item’s keys."])
        #expect(verdict.changedBy?.words == "Not confirmed")
        #expect(verdict.verifiedBy == nil)
        #expect(verdict.writtenBy == nil)
    }

    /* Bytes that differ from what was written: the mismatch names the re-keyer only under their verified signature. */
    @Test func aReKeyMismatchNamesTheReKeyerOnlyUnderTheirVerifiedSignature() {
        let attested = RekeyNote(writer: maya, by: sam, integrity: .verified, bound: false)
        #expect(FamilySync.verdict([judged(.verified, by: sam, note: attested)], names: names, groupId: group).mark?.lines
            == ["What Sam Lindqvist (sam@example.com) locked again doesn’t match what was written. Don’t trust this item."])
        let unattested = RekeyNote(writer: maya, by: sam, integrity: .unknownSigner, bound: false)
        #expect(FamilySync.verdict([judged(.verified, by: sam, note: unattested)], names: names, groupId: group).mark?.lines
            == ["What was locked again doesn’t match what was written. Don’t trust this item."])
        // Unconfirmed (a server alone can cause it): Couldn't check, with Try again.
        let unconfirmed = RekeyNote(writer: maya, by: sam, integrity: .verified, bound: nil)
        let mark = FamilySync.verdict([judged(.verified, by: sam, note: unconfirmed)], names: names, groupId: group).mark
        #expect(mark?.label == "Couldn’t check" && mark?.retry == true)
    }

    /* A re-key Info says without a mark: who wrote it and who locked it again (decision D5). */
    @Test func anAttestedReKeySaysWhoWroteItAndWhoReplacedTheKeys() {
        let note = RekeyNote(writer: maya, by: sam, integrity: .verified, bound: true)
        let verdict = FamilySync.verdict([judged(.verified, by: sam, via: group, note: note)], names: names, groupId: group)
        #expect(verdict.mark == nil)
        #expect(verdict.writtenBy == "Maya Lindqvist (maya@example.com)")
        #expect(verdict.replacedBy == ["Keys replaced by Sam Lindqvist (sam@example.com)"])
        #expect(verdict.verifiedBy == "Verified by Lindqvist family")
    }

    /* A plain bad signature in a family folder is never an accusation. */
    @Test func aBadSignatureIsSaidWithoutAccusingAnyone() {
        let verdict = FamilySync.verdict([judged(.badSignature, by: maya)], names: names, groupId: group)
        #expect(verdict.mark?.lines == ["HushOS couldn’t verify this signature."])
    }
}
