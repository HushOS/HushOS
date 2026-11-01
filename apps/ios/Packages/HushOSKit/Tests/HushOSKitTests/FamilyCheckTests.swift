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

            guard case .code(let version, let words, let digest) = try await phone.sync.checkCode(family.summary, with: family.creator.userId) else {
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

        /* They match over words that aren't this phone's (another family, a misread list): nothing is saved, and the member stays not verified. */
        @Test func wordsThatDontMatchHereSaveNothing() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted(let view) = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            guard case .code(let version, let words, _) = try await phone.sync.checkCode(family.summary, with: family.creator.userId) else {
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
