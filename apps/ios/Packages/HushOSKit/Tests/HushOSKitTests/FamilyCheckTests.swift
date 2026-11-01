import Foundation
import HushOSCore
import Testing
@testable import HushOSKit

/*
 * Check it's Sam in a family, the member list's labels, conflicts over first-seen pins, and the
 * family check records kept through every save (docs/optional-verification.md 2.6, 3.4, 3.8, 7.2),
 * against the family stub with real member lists. The member checks the creator, as the creator's
 * screen would show the same words (the pair code is the core's, worked out alike on both sides).
 */
extension OnFakeDrive {
    @Suite struct FamilyCheckTests {
        /* The creator as route 3 names them. */
        func creator(_ family: FamilyFixture) -> FamilyMemberRef {
            FamilyMemberRef(userId: family.creator.userId, email: "maya@example.com", name: "Maya Lindqvist")
        }

        /*
         * They match over the words both screens show: the check record and a verified pin of the
         * creator go in one save, the creator reads Verified on the member list, the family now reads
         * as checked, and the creator's file carries no mark. Fails if the record or
         * the pin isn't saved, or if the label doesn't follow the pin.
         */
        @Test func theyMatchSavesTheCheckAndAVerifiedPinAndTheMemberReadsVerified() async throws {
            let family = try FamilyFixture()
            let server = FamilyServer(family: family)
            server.serve(chain: [family.r1, family.r2])
            try server.storeSettings(pin: nil)
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .joined(.accepted(let joined)) = try await phone.sync.joinStatus(family.groupId) else { Issue.record("not joined"); return }
            #expect(try await phone.sync.memberStandings(joined)[family.creator.userId.lowercased()] == .notVerified)

            guard case .code(let version, let words, let digest) = try await phone.sync.checkCode(family.summary, with: family.creator.userId).code else {
                Issue.record("no words")
                return
            }
            // The roster that let the later of the two in, under the core's own pair code.
            #expect(version == 2 && digest == rosterDigest(statement: family.r2.statement))
            let saved = try await phone.sync.checkMatch(family.groupId, member: creator(family), rosterVersion: version, code: words)
            #expect(saved == FamilyCheckSaved(checked: true, verified: true))

            let document = try #require(try server.storedDocument())
            let record = try #require((document["familyChecks"] as? [String: Any])?[family.groupId] as? [String: Any])
            #expect(record["with"] as? String == family.creator.userId.lowercased() && record["code"] as? [String] == words)
            #expect((record["rosterVersion"] as? NSNumber)?.intValue == 2)
            let pinRaw = try #require((document["contacts"] as? [String: Any])?[family.creator.userId] as? [String: Any])
            #expect((pinRaw["fingerprint"] as? String)?.isEmpty == false)
            #expect(pinRaw["trustedVia"] == nil)

            guard case .accepted(let view) = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            #expect(try await phone.sync.memberStandings(view)[family.creator.userId.lowercased()] == .verified)
            #expect(await phone.sync.familyChecked(family.groupId))
            let file = try #require(try await phone.vault.children(of: family.rootId).first)
            // Now verified by this person's own pin of the creator, so no mark; the core gives it no `via`, so not "Verified by" the family (as the web's verifiedByLine).
            #expect(await phone.sync.verdict(of: file.node, groupId: family.groupId).mark == nil)
        }

        /*
         * With no guard entry for them on this phone, the core judged the compared keys against the
         * settings pin as it read it. Another device saves a pin of them with other keys before this
         * save reads the settings: that pin is theirs to keep, and the words are compared again.
         * Fails if the family check moves an existing pin to the compared keys.
         */
        @Test func aPinAnotherDeviceSavedMeanwhileIsLeftAndTheWordsAreComparedAgain() async throws {
            let family = try FamilyFixture()
            let server = FamilyServer(family: family)
            server.serve(chain: [family.r1, family.r2])
            try server.storeSettings(pin: nil)
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .joined(.accepted) = try await phone.sync.joinStatus(family.groupId) else { Issue.record("not joined"); return }
            guard case .code(let version, let words, _) = try await phone.sync.checkCode(family.summary, with: family.creator.userId).code else {
                Issue.record("no words")
                return
            }
            let theirs = ContactPin(userId: family.creator.userId, email: "maya@example.com", name: "Maya Lindqvist",
                                    keys: PinKeys(keyVersion: 1, encryptionPublicKey: "their-encryption", signingPublicKey: "their-signing",
                                                  mlDsaPublicKeyHash: "their-ml-dsa", kemPublicKeyHash: "their-kem", fingerprint: ""),
                                    pinnedAt: "2026-11-01T12:00:00.000Z", firstSeen: "added")
            // Saved on another device while this one fetches the member lists to match against.
            server.afterRosters = { try? server.editSettings { $0.setPin(theirs) } }
            let saved = try await phone.sync.checkMatch(family.groupId, member: creator(family), rosterVersion: version, code: words)
            #expect(saved == FamilyCheckSaved(checked: false, verified: false))

            let document = try #require(try server.storedDocument())
            let pinRaw = try #require((document["contacts"] as? [String: Any])?[family.creator.userId] as? [String: Any])
            #expect(pinRaw["signingPublicKey"] as? String == "their-signing")
            #expect(pinRaw["encryptionPublicKey"] as? String == "their-encryption")
            #expect((document["familyChecks"] as? [String: Any])?[family.groupId] == nil)
        }

        /*
         * Getting the latest accepts a newer member list, then the words can't be worked out (the
         * member lists don't load again): the accepted family still comes back, for the page to show
         * as after any sync, with the words' failure as the problem. Fails if a failure after an
         * accepting sync throws the acceptance away.
         */
        @Test func anAcceptingSyncIsHandedBackWhenTheWordsCantBeWorkedOut() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            server.serve(chain: [family.r1, family.r2, family.r3])
            // The sync's own fetch is served; the words' fetch after it isn't.
            server.afterRosters = { server.rostersFail = true }
            let start = try await phone.sync.checkCode(family.summary, with: family.creator.userId)
            guard case .accepted(let view) = start.state else { Issue.record("the acceptance was thrown away: \(start.state)"); return }
            #expect(view.rosterVersion == 3)
            #expect(start.code == nil && start.problem != nil)
        }

        /* They match over words that aren't this phone's (another family, a misread list): nothing is saved, and the member stays not verified. */
        @Test func wordsThatDontMatchHereSaveNothing() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted(let view) = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            guard case .code(let version, let words, _) = try await phone.sync.checkCode(family.summary, with: family.creator.userId).code else {
                Issue.record("no words")
                return
            }
            let before = try server.savedDocuments().count
            let other = Array(words.reversed())
            #expect(try await phone.sync.checkMatch(family.groupId, member: creator(family), rosterVersion: version, code: other)
                == FamilyCheckSaved(checked: false, verified: false))
            #expect(try server.savedDocuments().count == before)
            #expect(try await phone.sync.memberStandings(view)[family.creator.userId.lowercased()] == .notVerified)
        }

        /*
         * A verified pin that agrees with this phone's guard but holds other keys than the member's
         * entry: the member is not Verified, decided from the one guarded read (the standing and the
         * keys compared with the entry are the same pin's). Fails if the label skips the comparison
         * with the entry, or takes the keys from anywhere but the pin the verdict was about.
         */
        @Test func aVerifiedPinOfOtherKeysThanTheEntryIsNotVerified() async throws {
            let family = try FamilyFixture()
            let other = try FamilyPerson()
            let wrongKeys = try pinned(family.creator.userId, other.keys, name: "Maya Lindqvist")
            #expect(wrongKeys.trust == .verified)
            let pin = try family.pin(through: [family.r1, family.r2])
            let server = family.server(chain: [family.r1, family.r2], pin: pin)
            try server.storeSettings(pin: pin, contacts: [wrongKeys])
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted(let view) = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            // Verified as a contact on this phone (the guard holds these keys) ...
            #expect(try await phone.vault.contactStandings()[family.creator.userId.lowercased()]?.verified == true)
            // ... but not the keys the family's member list names for them.
            #expect(try await phone.sync.memberStandings(view)[family.creator.userId.lowercased()] == .notVerified)
        }

        /*
         * Check it's Sam's "Getting the latest" meets a fork: the outcome comes back (never thrown
         * away), with no words, so the screens show the warning as after any sync, and the phone
         * holds nothing of the family open. Fails if the sync's state is dropped.
         */
        @Test func aCheckThatMeetsAForkHandsBackTheWarning() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2, family.r3], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            server.serve(chain: [family.r1, family.r2, family.r3Fork, family.r4Fork])
            let start = try await phone.sync.checkCode(family.summary, with: family.creator.userId)
            guard case .fork = start.state else { Issue.record("the fork was not handed back: \(start.state)"); return }
            #expect(start.code == nil && start.problem != nil)
            await #expect(throws: (any Error).self) { _ = try await phone.vault.children(of: family.rootId) }
        }

        /*
         * The member pinned the creator first-seen over other keys than the ones the member list
         * names (a contact added without words, then planted keys in the list): the creator's file
         * reads "Keys don't match" and the family vouches for nothing. Fails if conflicts are looked
         * for over verified pins only (an iOS 0.10.0 residual, 7.3).
         */
        @Test func aFirstSeenPinThatDisagreesWithAMembersEntryIsAConflict() async throws {
            let family = try FamilyFixture()
            let other = try FamilyPerson()
            var seen = try pinned(family.creator.userId, other.keys, name: "Maya Lindqvist")
            seen.fingerprint = ""
            seen.firstSeen = "added"
            #expect(seen.trust == .seen)
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            try server.storeSettings(pin: try family.pin(through: [family.r1, family.r2]), contacts: [seen])
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            let file = try #require(try await phone.vault.children(of: family.rootId).first)
            let verdict = await phone.sync.verdict(of: file.node, groupId: family.groupId)
            #expect(verdict.mark?.label == "Keys don’t match")
            #expect(verdict.verifiedBy == nil)
        }

        /*
         * The family check records and the first-use marker another client wrote (a family check
         * with its words, a `before` record, a field this version doesn't know) come back exactly as
         * they were from a save of the group pin, and no record is added for a family that already
         * has one. Fails if a save rebuilds the document, or the marker is written again over one
         * that is set.
         */
        @Test func familyChecksAndTheMarkerAreKeptAsTheyWereThroughASave() async throws {
            let family = try FamilyFixture()
            let server = FamilyServer(family: family)
            server.serve(chain: [family.r1, family.r2, family.r3])
            var document = Settings()
            document.setGroupPin(family.groupId, try family.pin(through: [family.r1, family.r2]))
            let checks: [String: Any] = [
                "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a": ["rosterVersion": 4, "with": "00000001-abcd-4abc-8abc-abcdefabcdef",
                                                         "code": Array(repeating: "abandon", count: 12), "checkedAt": "2026-10-29T08:00:00.000Z",
                                                         "fromALaterVersion": ["nested": true]],
                "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b": ["rosterVersion": 1, "how": "before", "checkedAt": "2026-10-28T08:00:00.000Z"],
            ]
            document.document["familyChecks"] = checks
            document.document["familyChecksSince"] = "2026-10-28T08:00:00.000Z"
            try server.storeSettings(document: document)
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            // The pin moved to roster 3, so a save landed.
            #expect(try server.storedPin(family)?.rosterVersion == 3)
            let stored = try #require(try server.storedDocument())
            func canonical(_ value: Any?) throws -> String {
                String(decoding: try JSONSerialization.data(withJSONObject: ["v": value ?? NSNull()], options: [.sortedKeys]), as: UTF8.self)
            }
            #expect(try canonical(stored["familyChecks"]) == canonical(checks))
            #expect(stored["familyChecksSince"] as? String == "2026-10-28T08:00:00.000Z")
        }
    }
}

/*
 * Check it's Sam syncs, then fetches the member lists for the words; meanwhile the live sync may
 * find a fork or a removal and show it. What the check found when it started must not cover that
 * afterwards, and its words must not show for a family no longer accepted. Fails if an older
 * acceptance is shown over a newer warning or removal, or a fork or removal it found is dropped.
 */
@Suite struct FamilyCheckRaceTests {
    let group = "0a427e6e-a934-4366-aea3-b09f70984781"
    var accepted: FamilyState {
        .accepted(FamilyView(groupId: group, rosterVersion: 2, rosterDigest: "d", groupKeyVersion: 1, members: [], areas: [],
                             recordReset: false, ownEntryWrong: false, ownEntryBehind: false, foreign: []))
    }
    var fork: FamilyState { .fork(FamilyFork(memberList: true, version: 2, sides: [])) }

    @Test func aCheckThatStartedBeforeAWarningCannotCoverIt() {
        var book = FamilyGenerations()
        book.published(group)
        let started = book.current(group)
        // The live sync finds the fork while the check waits on the member lists, and shows it.
        book.published(group)
        #expect(!book.admits(accepted, of: group, since: started))
        #expect(!book.admits(.failed("Couldn’t check"), of: group, since: started))
        // A fork or removal the check itself found is always shown.
        #expect(book.admits(fork, of: group, since: started))
        #expect(book.admits(.wiped, of: group, since: started))
    }

    @Test func aCheckWithNothingShownMeanwhileIsShown() {
        var book = FamilyGenerations()
        let started = book.current(group)
        #expect(book.admits(accepted, of: group, since: started))
        // Counted per family: another family's news doesn't hold this one back.
        book.published("1b427e6e-a934-4366-aea3-b09f70984781")
        #expect(book.admits(accepted, of: group.uppercased(), since: started))
    }

    @Test func wordsShowOnlyForAnAcceptedFamily() {
        #expect(FamilySync.checkProblem(accepted) == nil)
        #expect(FamilySync.checkProblem(fork) != nil)
        #expect(FamilySync.checkProblem(.wiped) == FamilyFailure.notInFamily.message)
        #expect(FamilySync.checkProblem(.failed("Couldn’t check")) == "Couldn’t check")
        #expect(FamilySync.checkProblem(.waiting) != nil)
    }
}

/*
 * The member list's labels after a sync accepted a newer list or trust was loaded again, while
 * they are read again. Fails if a member whose entry changed, or anyone under an older trust load,
 * can still read Verified from labels read before.
 */
@Suite struct MemberLabelsTests {
    let sam = "1b427e6e-a934-4366-aea3-b09f70984781"
    let ana = "2c427e6e-a934-4366-aea3-b09f70984781"

    func view(_ digest: String, sam samKeys: String, ana anaKeys: String) -> FamilyView {
        FamilyView(groupId: "g", rosterVersion: 2, rosterDigest: digest, groupKeyVersion: 1,
                   members: [FamilyMember(userId: sam, roles: [], commitment: samKeys), FamilyMember(userId: ana, roles: [], commitment: anaKeys)],
                   areas: [], recordReset: false, ownEntryWrong: false, ownEntryBehind: false, foreign: [])
    }

    @Test func aMemberWhoseEntryChangedShowsNoLabelUntilReadAgain() {
        let before = view("r2", sam: "sam-1", ana: "ana-1")
        let labels = MemberLabels([sam: .verified, ana: .verified], of: before, trust: 4)
        #expect(labels.label(of: before.members[0], in: before, trust: 4) == .verified)

        // Roster 3 gives Sam other keys; Ana's entry is as it was.
        let after = view("r3", sam: "sam-2", ana: "ana-1")
        #expect(labels.label(of: after.members[0], in: after, trust: 4) == nil)
        #expect(labels.label(of: after.members[1], in: after, trust: 4) == .verified)
    }

    @Test func verifiedFromAnOlderTrustLoadIsNotShown() {
        let current = view("r2", sam: "sam-1", ana: "ana-1")
        let labels = MemberLabels([sam: .verified, ana: .notVerified], of: current, trust: 4)
        // A pin saved on another device was loaded since: Verified waits for the new read; Not verified may stay.
        #expect(labels.label(of: current.members[0], in: current, trust: 5) == nil)
        #expect(labels.label(of: current.members[1], in: current, trust: 5) == .notVerified)
    }
}
