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
        /*
         * A join holds the family's turn while a sync (a check's, a refresh's) waits behind it: the
         * join's answer carries a revision taken in that turn, earlier than the sync's, so a fork or
         * removal the sync publishes is never covered by the join's older Accepted. Fails if the
         * join publishes with no revision, or one not taken in the family's turn.
         */
        @Test func aJoinsAnswerIsOrderedBeforeASyncThatWaitedBehindIt() async throws {
            let family = try FamilyFixture()
            let server = FamilyServer(family: family)
            server.serve(chain: [family.r1, family.r2])
            try server.storeSettings(pin: nil)
            let phone = try await family.phone(server)
            defer { phone.done() }
            let sync = phone.sync
            let held = DispatchSemaphore(value: 0)
            server.onRosters = { held.wait() }
            let joining = Task { try await sync.joinStatusRevised(family.groupId) }
            try await Task.sleep(for: .milliseconds(300))
            let behind = Task { await sync.syncRevised(family.summary) }
            try await Task.sleep(for: .milliseconds(200))
            server.onRosters = nil
            held.signal()
            let (outcome, joinRevision) = try await joining.value
            guard case .joined(.accepted) = outcome else { Issue.record("not joined: \(outcome)"); return }
            let later = await behind.value
            let join = try #require(joinRevision, "the join's answer carries no revision")
            #expect(join < later.revision)
            // The sync's answer shown first, the join's landing after it: the join's never covers it.
            var book = FamilyRevisions()
            let syncShown = book.admits(later.revision, of: family.groupId)
            let joinShown = book.admits(join, of: family.groupId)
            #expect(syncShown && !joinShown)
        }

        /*
         * A join whose guard can't be stored: its member list's folders are held for the barrier before
         * the store, as a sync's acceptance holds them, so a write into one (a share mounted there) is
         * refused while the guard is owed. Fails if the join holds nothing before storing the guard.
         */
        @Test func aJoinWhoseGuardCantBeStoredHoldsWritesIntoItsFolders() async throws {
            let family = try FamilyFixture()
            let server = FamilyServer(family: family)
            server.serve(chain: [family.r1, family.r2])
            try server.storeSettings(pin: nil)
            let writes = GuardSwitch()
            writes.writable = false
            let phone = try await family.phone(server, guards: familyGuards(family.member, writes: writes))
            defer { phone.done() }
            _ = try? await phone.sync.joinStatus(family.groupId)
            #expect(!(await phone.vault.isFamilyWorkspace(family.workspaceId)))
            await #expect(throws: GuardError.unsaved) { try await phone.vault.sendingIntoFamily(family.workspaceId) }
        }

        /*
         * Removed right after the join's acceptance (route 3 answers not-member while the join opens its
         * folders): the family is let go of as a sync's not-member is, so the folders the acceptance
         * opened don't stay open. Fails if the not-member only propagates.
         */
        @Test func aNotMemberRightAfterAJoinsAcceptanceLeavesItsFoldersUnopenable() async throws {
            let family = try FamilyFixture()
            let server = FamilyServer(family: family)
            server.serve(chain: [family.r1, family.r2])
            try server.storeSettings(pin: nil)
            server.detailNotMember = true
            let phone = try await family.phone(server)
            defer { phone.done() }
            await #expect(throws: (any Error).self) { _ = try await phone.sync.joinStatus(family.groupId) }
            await #expect(throws: (any Error).self) { _ = try await phone.vault.children(of: family.rootId) }
            #expect(await phone.vault.item(family.rootId) == nil)
            #expect(phone.records.read(userId: family.member.userId, groupId: family.groupId) == nil)
        }

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

        /*
         * A member check's own read of the member list (after its sync accepted) answers not-member,
         * and so does They match's on another phone of the account. Either is a removal: the family
         * is let go of in two phases and shown wiped, not only an error. Fails if the check's reads
         * treat not-member as any failure.
         */
        @Test func aNotMemberDuringAMemberCheckWipesTheFamily() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            let other = try await family.phone(server)
            defer { other.done() }
            guard case .accepted = await phone.sync.sync(family.summary), case .accepted = await other.sync.sync(family.summary) else {
                Issue.record("not accepted")
                return
            }
            // Each sync continues from its record; the check's own read starts at version 1, and that one says not-member.
            server.notMemberFromStart = true
            let start = try await phone.sync.checkCode(family.summary, with: family.creator.userId)
            #expect(start.state == .wiped)
            #expect(start.problem == FamilyFailure.notInFamily.message)
            #expect(phone.records.read(userId: family.member.userId, groupId: family.groupId) == nil)
            #expect(await phone.vault.item(family.rootId) == nil)

            do {
                _ = try await other.sync.checkMatch(family.groupId, member: creator(family), rosterVersion: 2, code: Array(repeating: "word", count: 12))
                Issue.record("They match went on without the member list")
            } catch let removed as FamilyRemovedNow {
                #expect(removed.cause.isNotMember)
                #expect(removed.removed.state == .wiped)
            }
            #expect(other.records.read(userId: family.member.userId, groupId: family.groupId) == nil)
        }

        /*
         * They match meets not-member while the guard the wipe hands back can't be stored: nothing is
         * cleared and the record stays, so the check hands back the refusal with its storage words and
         * its revision, never "not in this family". Fails if a failed wipe is passed on as a removal.
         */
        @Test func aNotMemberDuringTheyMatchWhoseWipeFailsSaysSoAndKeepsTheRecord() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let writes = GuardSwitch()
            let phone = try await family.phone(server, guards: familyGuards(family.member, writes: writes))
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            server.notMemberFromStart = true
            writes.writable = false
            do {
                _ = try await phone.sync.checkMatch(family.groupId, member: creator(family), rosterVersion: 2, code: Array(repeating: "word", count: 12))
                Issue.record("They match went on without the member list")
            } catch let removed as FamilyRemovedNow {
                guard case .failed(let words) = removed.removed.state else { Issue.record("a failed wipe was passed on as \(removed.removed.state)"); return }
                #expect(words == GuardWords.unsaved)
                #expect(removed.removed.revision > 0)
            }
            #expect(phone.records.read(userId: family.member.userId, groupId: family.groupId) != nil, "a wipe that couldn't finish deleted the record")
        }

        /*
         * The check's own sync meets a 401: the session may have ended, so the check throws it for the
         * app to treat as any request's, never a problem the sheet offers to try again. Fails if the
         * sync's 401 is only kept for later.
         */
        @Test func aSessionThatEndedInTheChecksSyncIsThrown() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            server.unauthorized = true
            do {
                let start = try await phone.sync.checkCode(family.summary, with: family.creator.userId)
                Issue.record("the check went on after a 401: \(start.problem ?? "")")
            } catch {
                #expect(endsSession(error))
            }
        }

        /*
         * A check asked while another sync of the family holds its turn runs after it, and its answer
         * carries the later revision, so the screens show the check's over the earlier one. Fails if
         * the check's answer isn't ordered after the sync it waited behind.
         */
        @Test func aCheckQueuedBehindASyncCarriesTheLaterRevision() async throws {
            let family = try FamilyFixture()
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            let sync = phone.sync
            // The check is asked first but waits: the refresh already holds the family's turn, slowed at its member list read.
            let held = DispatchSemaphore(value: 0)
            server.onRosters = { held.wait() }
            let refresh = Task { await sync.syncRevised(family.summary) }
            try await Task.sleep(for: .milliseconds(200))
            let check = Task { try await sync.checkCode(family.summary, with: family.creator.userId) }
            try await Task.sleep(for: .milliseconds(200))
            server.onRosters = nil
            held.signal()
            let first = await refresh.value
            let second = try await check.value
            #expect(try #require(second.revision) > first.revision)
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
 * Check it's Sam syncs behind any sync of the family already running, then fetches the member
 * lists; a refresh may show its own answer meanwhile. Answers are ordered by the revision taken
 * inside the family's turn: a later look always shows (a refusal too, not only a fork or a
 * removal), an earlier one never covers it (an old fork no more than an old acceptance), and an
 * answer without a revision is the latest when it shows. Fails if answers are ordered by when a
 * screen asked, or a fork or removal wins regardless of when it was found.
 */
@Suite struct FamilyCheckRaceTests {
    let group = "0a427e6e-a934-4366-aea3-b09f70984781"

    @Test func aRefusalFoundAfterARefreshShowsOverIt() {
        var book = FamilyRevisions()
        // The refresh held the family's turn and accepted (revision 1); the check's own sync ran after it and was refused.
        let admitted1 = book.admits(1, of: group)
        #expect(admitted1)
        let admitted2 = book.admits(2, of: group)
        #expect(admitted2)
    }

    @Test func anOlderAnswerNeverCoversALaterOne() {
        var book = FamilyRevisions()
        let admitted3 = book.admits(5, of: group)
        #expect(admitted3)
        // Found before what is shown, whatever it says: an old fork or removal as much as an old acceptance.
        let admitted4 = book.admits(4, of: group)
        #expect(!admitted4)
        let admitted5 = book.admits(5, of: group)
        #expect(!admitted5)
        let admitted6 = book.admits(6, of: group)
        #expect(admitted6)
    }

    @Test func anUnrevisedAnswerIsTheLatestWhenItShows() {
        var book = FamilyRevisions()
        let admitted7 = book.admits(2, of: group)
        #expect(admitted7)
        // A removal the family list found, published when revision 7 was the last given out: a sync settled by then is older.
        let admitted8 = book.admits(nil, of: group, latest: 7)
        #expect(admitted8)
        let admitted9 = book.admits(7, of: group)
        #expect(!admitted9)
        let admitted10 = book.admits(8, of: group)
        #expect(admitted10)
        // Another family's order is its own.
        let admitted11 = book.admits(3, of: "1b427e6e-a934-4366-aea3-b09f70984781")
        #expect(admitted11)
    }
}

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
