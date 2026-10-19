import Foundation
import HushOSCore
import Testing
@testable import HushOSKit

/*
 * Joining a family on the phone (docs/groups-mobile-plan.md, iOS 3) against the family stub, with
 * real member lists the core signs: the newcomer is the fixture's member, let in at roster 2 by
 * the creator. "They match" with the two words the admin reads joins with the code as the join
 * mark and pins it; a wrong word or a code that changed since it was shown keeps nothing; the
 * hidden positions never leave the phone; a wrong pair holds the same two positions across a lock
 * and across a relaunch, and the next wrong pair is the alarm; a relaunch after "They match"
 * finishes from the sealed joins record. Each fails if its step in FamilyJoin is removed.
 */
extension OnFakeDrive {
    @Suite struct FamilyJoinTests {
        /* The newcomer's phone, with settings that hold no pin of the family (they never joined it). */
        func newcomer(_ family: FamilyFixture, chain: [SignedGroupStatement]? = nil) async throws -> (FamilyServer, FamilyFixture.Phone) {
            let server = FamilyServer(family: family)
            server.serve(chain: chain ?? [family.r1, family.r2])
            try server.storeSettings(pin: nil)
            return (server, try await family.phone(server))
        }

        /* The two words the admin reads out for a showing, and a pair with the second one misheard. */
        func readOut(_ shown: JoinShowing) -> [String] { shown.hidden.map { shown.code[$0] } }
        func misheard(_ shown: JoinShowing) -> [String] {
            let words = readOut(shown)
            return [words[0], words[1] == "abandon" ? "ability" : "abandon"]
        }

        func showing(_ outcome: JoinOutcome, changed: Bool = false, sourceLocation: SourceLocation = #_sourceLocation) throws -> JoinShowing {
            guard case .compare(let shown, let wasChanged) = outcome, wasChanged == changed else {
                Issue.record("expected a code to compare (changed: \(changed)), got \(outcome)", sourceLocation: sourceLocation)
                throw FamilyFailure(message: "no showing")
            }
            return shown
        }

        /* Nothing of the family kept: no device record, no joins record, no settings pin, nothing saved to settings, no folder open. */
        func keptNothing(_ family: FamilyFixture, _ server: FamilyServer, _ phone: FamilyFixture.Phone, sourceLocation: SourceLocation = #_sourceLocation) throws {
            let me = family.member.userId
            #expect(phone.records.read(userId: me, groupId: family.groupId) == nil, sourceLocation: sourceLocation)
            #expect(phone.records.read(.joins, userId: me, groupId: family.groupId) == nil, sourceLocation: sourceLocation)
            #expect(try server.storedPin(family) == nil, sourceLocation: sourceLocation)
            #expect(server.savedSettings.isEmpty, sourceLocation: sourceLocation)
            #expect(!phone.vault.areaLedger.isArea(workspaceId: family.workspaceId), sourceLocation: sourceLocation)
        }

        /*
         * Waiting until route 2 says active; then the code of roster 2 (the admin's screen shows the
         * same twelve words), "They match" with the two words read out joins: the device record at
         * roster 2, the settings pin at roster 2, the folder opens with the creator's file, and
         * neither the joins record nor an escalation is left. No request the phone sent, and no
         * settings document it saved, names the hidden words or their positions.
         */
        @Test func theTwoWordsReadOutJoinAndPinAndNoRequestCarriesThePositions() async throws {
            let family = try FamilyFixture()
            let (server, phone) = try await newcomer(family)
            defer { phone.done() }
            let me = family.member.userId

            server.groupState = "accepted"
            #expect(try await phone.sync.joinStatus(family.groupId) == .waiting)
            server.groupState = "active"
            let shown = try showing(try await phone.sync.joinStatus(family.groupId))
            let admins = try joinCode(rosterDigest: rosterDigest(statement: family.r2.statement), groupKey: family.firstKeys, groupKeyVersion: 1)
            #expect(shown.rosterVersion == 2 && shown.code == admins)
            #expect(shown.hidden.count == 2 && shown.hidden[0] < shown.hidden[1] && shown.hidden[1] <= 11)

            guard case .joined(.accepted(let view)) = try await phone.sync.confirmJoin(family.groupId, shown, typed: readOut(shown).map { $0.uppercased() }) else {
                Issue.record("not joined")
                return
            }
            #expect(view.rosterVersion == 2)
            #expect(phone.records.read(userId: me, groupId: family.groupId)?.rosterVersion == 2)
            #expect(try server.storedPin(family)?.rosterVersion == 2)
            #expect(phone.records.read(.joins, userId: me, groupId: family.groupId) == nil)
            #expect(phone.records.read(.holds, userId: me, groupId: family.groupId) == nil)
            #expect(try await phone.vault.children(of: family.rootId).map(\.name) == ["Recipes.txt"])
            // A member now: the join screen has nothing more to do.
            #expect(try await phone.sync.joinStatus(family.groupId) == .member)

            // The code's own words are the server's to know; which two were hidden is not.
            let hidden = readOut(shown)
            let documents = try server.savedDocuments()
            #expect(!documents.isEmpty)
            let names = ["hidden", "positions", "typed", "session"]
            for request in server.traffic {
                let url = URLComponents(string: request.url)
                for item in url?.queryItems ?? [] {
                    #expect(["after", "workspaceId", "cursor"].contains(item.name), "query \(item.name) on \(request.url)")
                }
                for word in hidden {
                    #expect(!(url?.path ?? "").split(separator: "/").contains { $0.lowercased() == word }, "\(word) in \(request.url)")
                }
                let body = String(decoding: request.body, as: UTF8.self).lowercased()
                for word in hidden { #expect(!body.contains("\"\(word)\""), "\(word) sent to \(request.url)") }
                for name in names { #expect(!body.contains("\"\(name)\""), "\(name) sent to \(request.url)") }
            }
            for document in documents.map({ $0.lowercased() }) {
                for word in hidden { #expect(!document.contains("\"\(word)\""), "\(word) saved in settings") }
                for name in names { #expect(!document.contains("\"\(name)\""), "\(name) saved in settings") }
            }
        }

        /* A misheard word: said calmly, never which; nothing of the family kept, only the escalation; the same showing stays. */
        @Test func aWrongTypedWordKeepsNothing() async throws {
            let family = try FamilyFixture()
            let (server, phone) = try await newcomer(family)
            defer { phone.done() }

            let shown = try showing(try await phone.sync.joinStatus(family.groupId))
            #expect(try await phone.sync.confirmJoin(family.groupId, shown, typed: misheard(shown)) == .wrongWords)
            try keptNothing(family, server, phone)
            #expect(phone.records.read(.holds, userId: family.member.userId, groupId: family.groupId) != nil)
            #expect(server.writes.isEmpty)
            await #expect(throws: (any Error).self) { _ = try await phone.vault.children(of: family.rootId) }
            // Shown again, the same two words are hidden.
            #expect(try showing(try await phone.sync.joinStatus(family.groupId)).hidden == shown.hidden)
        }

        /*
         * The server shows another roster 2 after the code was shown: "They match" with the words read
         * out for the code compared checks nothing against the new one and keeps nothing; the new code
         * is the one to compare, said as changed.
         */
        @Test func aCodeThatChangedSinceItWasShownKeepsNothing() async throws {
            let family = try FamilyFixture()
            let (server, phone) = try await newcomer(family)
            defer { phone.done() }

            let shown = try showing(try await phone.sync.joinStatus(family.groupId))
            server.serve(chain: [family.r1, family.r2Other])
            let now = try showing(try await phone.sync.confirmJoin(family.groupId, shown, typed: readOut(shown)), changed: true)
            #expect(now.code != shown.code)
            #expect(now.code == (try joinCode(rosterDigest: rosterDigest(statement: family.r2Other.statement), groupKey: family.firstKeys, groupKeyVersion: 1)))
            try keptNothing(family, server, phone)
            // The words were never checked: no escalation was left by it.
            #expect(phone.records.read(.holds, userId: family.member.userId, groupId: family.groupId) == nil)
        }

        /*
         * A wrong pair, then a lock and an unlock (the ledger cleared and the sync replaced, as
         * sign-out's FamilySync.forget and a new vault do): the showing from before the lock is not
         * checked, the code is shown again with the same two positions hidden, and the next wrong
         * pair is the alarm. Fails when the kept escalation isn't passed back on the first showing.
         */
        @Test func aWrongPairThenALockHidesTheSamePositionsAndTheNextWrongPairIsTheAlarm() async throws {
            let family = try FamilyFixture()
            let (server, phone) = try await newcomer(family)
            defer { phone.done() }

            let shown = try showing(try await phone.sync.joinStatus(family.groupId))
            #expect(try await phone.sync.confirmJoin(family.groupId, shown, typed: misheard(shown)) == .wrongWords)

            phone.vault.areaLedger.clear()
            let unlocked = FamilySync(vault: phone.vault, api: GroupsAPI(drive: phone.vault.api), records: phone.records)
            // Even with the right words, a showing from before the lock is shown again, never checked.
            let again = try showing(try await unlocked.confirmJoin(family.groupId, shown, typed: readOut(shown)))
            #expect(again.hidden == shown.hidden && again.code == shown.code)
            #expect(try await unlocked.confirmJoin(family.groupId, again, typed: misheard(again)) == .mismatch)
            try keptNothing(family, server, phone)
        }

        /* The same across killing and relaunching the app: a new process (vault, ledger, sync) reads the escalation the first one kept. */
        @Test func aWrongPairThenARelaunchHidesTheSamePositionsAndTheNextWrongPairIsTheAlarm() async throws {
            let family = try FamilyFixture()
            let (server, first) = try await newcomer(family)
            let shown = try showing(try await first.sync.joinStatus(family.groupId))
            #expect(try await first.sync.confirmJoin(family.groupId, shown, typed: misheard(shown)) == .wrongWords)
            first.done()

            let relaunched = try await family.phone(server, records: FamilyRecords(folder: first.records.folder, activity: .expired))
            defer { relaunched.done() }
            let again = try showing(try await relaunched.sync.joinStatus(family.groupId))
            #expect(again.hidden == shown.hidden && again.code == shown.code)
            #expect(try await relaunched.sync.confirmJoin(family.groupId, again, typed: misheard(again)) == .mismatch)
            try keptNothing(family, server, relaunched)
            // Then the right words: a match clears the alarm and joins (the alarm is a warning, not a lock-out).
            guard case .joined = try await relaunched.sync.confirmJoin(family.groupId, again, typed: readOut(again)) else {
                Issue.record("not joined")
                return
            }
            #expect(relaunched.records.read(.holds, userId: family.member.userId, groupId: family.groupId) == nil)
        }

        /*
         * A server can't reset the alarm by saying this phone was removed: after a wrong pair, the
         * removed-device wipe (and the account's next sign-in claiming the store) keeps the join
         * check, so the same positions are hidden and the next wrong pair is the alarm. Only the
         * person's own sign-out removes it.
         */
        @Test func aRemovedDeviceWipeKeepsTheJoinCheck() async throws {
            let family = try FamilyFixture()
            let root = FileManager.default.temporaryDirectory.appendingPathComponent("account-\(UUID().uuidString)")
            let account = AccountStore(root: root, temporary: root.appendingPathComponent("tmp"))
            let owner = AccountOwner(userId: family.member.userId, origin: "https://family.test")
            account.claim(owner)
            let records = FamilyRecords(folder: root.appendingPathComponent("local/groups"), activity: .expired)
            let server = FamilyServer(family: family)
            server.serve(chain: [family.r1, family.r2])
            try server.storeSettings(pin: nil)
            let first = try await family.phone(server, records: records)
            let shown = try showing(try await first.sync.joinStatus(family.groupId))
            #expect(try await first.sync.confirmJoin(family.groupId, shown, typed: misheard(shown)) == .wrongWords)
            first.done()

            // "Removed": the device's account data goes; then the account signs in again on this phone.
            account.wipeAfterRemoval()
            #expect(account.owner() == nil)
            account.claim(owner)
            let again = try await family.phone(server, records: FamilyRecords(folder: root.appendingPathComponent("local/groups"), activity: .expired))
            defer { again.done() }
            let next = try showing(try await again.sync.joinStatus(family.groupId))
            #expect(next.hidden == shown.hidden && next.code == shown.code)
            #expect(try await again.sync.confirmJoin(family.groupId, next, typed: misheard(next)) == .mismatch)

            // The person's own sign-out is what clears it.
            account.wipe()
            #expect(records.read(.holds, userId: family.member.userId, groupId: family.groupId) == nil)
        }

        /*
         * Killed between "They match" and the end of the join: the relaunched phone holds only the
         * sealed joins record, and finishes the join from it without asking for the words again.
         */
        @Test func aRelaunchAfterTheyMatchFinishesFromTheJoinsRecord() async throws {
            let family = try FamilyFixture()
            let (server, first) = try await newcomer(family)
            let me = family.member.userId
            let shown = try showing(try await first.sync.joinStatus(family.groupId))
            // As the pin is saved, the joins record is on disk: what a process killed here leaves.
            let kept = Kept()
            let (records, groupId) = (first.records, family.groupId)
            server.beforePut = { kept.value = records.read(.joins, userId: me, groupId: groupId) }
            guard case .joined = try await first.sync.confirmJoin(family.groupId, shown, typed: readOut(shown)) else {
                Issue.record("not joined")
                return
            }
            first.done()
            let joins = try #require(kept.value)

            let fresh = FamilyRecords(folder: FileManager.default.temporaryDirectory.appendingPathComponent("family-records-\(UUID().uuidString)"), activity: .expired)
            try fresh.put(.joins, userId: me, groupId: family.groupId, joins)
            let relaunched = try await family.phone(server, records: fresh)
            defer { relaunched.done() }
            server.clearRequests()
            guard case .joined(.accepted(let view)) = try await relaunched.sync.joinStatus(family.groupId) else {
                Issue.record("not finished from the joins record")
                return
            }
            #expect(view.rosterVersion == 2)
            #expect(fresh.read(userId: me, groupId: family.groupId)?.rosterVersion == 2)
            #expect(fresh.read(.joins, userId: me, groupId: family.groupId) == nil)
            #expect(try await relaunched.vault.children(of: family.rootId).map(\.name) == ["Recipes.txt"])
        }

        /*
         * The app and the background queue ask for the session's vault separately: they must get the
         * same one, and so the same family sync, or a join, a sync and a queued family upload stop
         * taking turns per family (two ledgers, two queues). Another session gets its own.
         */
        @Test func oneSessionHasOneVaultAndOneFamilySync() {
            defer { FamilySync.forget() }
            let session = SharedKeychain.Session(origin: "https://family.test", token: UUID().uuidString, userId: UUID().uuidString.lowercased())
            let app = Vault.current.vault(for: session)
            let queue = Vault.current.vault(for: session)
            #expect(app === queue)
            #expect(FamilySync.shared(for: app) === FamilySync.shared(for: queue))
            let next = Vault.current.vault(for: SharedKeychain.Session(origin: session.origin, token: UUID().uuidString, userId: session.userId))
            #expect(next !== app)
        }

        /*
         * One family per account: an invitation opened while in another family names it, and accepting
         * is refused 409 `in-family` with the family in its data; the token goes in the body only.
         */
        @Test func anInvitationWhileInAnotherFamilyNamesItAndAcceptingIsRefused() async throws {
            let family = try FamilyFixture()
            let (server, phone) = try await newcomer(family)
            defer { phone.done() }
            let token = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc"
            let mine = ["groupId": UUID().uuidString.lowercased(), "name": "Ortega family"]
            server.invitationAnswer = (200, ["inFamily": mine, "invitationId": UUID().uuidString.lowercased(), "groupId": family.groupId, "kind": "family",
                                             "name": "Lindqvist family", "inviter": ["id": family.creator.userId, "name": "Maya Lindqvist", "email": "maya@example.com"],
                                             "roles": [String](), "expiresAt": "2026-10-26T09:00:00.000Z"])
            server.acceptAnswer = (409, ["code": "in-family", "message": "You’re in Ortega family. To join Lindqvist family, leave yours first.",
                                         "data": ["reason": "self", "family": mine]])
            let api = GroupsAPI(drive: phone.vault.api)

            let invitation = try await api.openInvitation(token)
            #expect(invitation.inFamily?.name == "Ortega family" && invitation.name == "Lindqvist family")
            #expect(JoinWords.inFamily("Ortega family", invitedTo: invitation.name, expiresAt: invitation.expiresAt)
                == "You’re in Ortega family. To join Lindqvist family, leave yours first, from its page. This invitation stays open until 26 October.")
            // Accept is off, with the leave-first words, whether opening found the family or accepting did.
            let opened = InvitationNotice.of(invitation, refusal: nil, email: nil)
            #expect(!opened.canAccept)
            guard case .inFamily(_, let yours) = opened.note else { Issue.record("no leave-first note"); return }
            #expect(yours.name == "Ortega family")
            var refused: GroupsAPIError?
            do { _ = try await api.acceptInvitation(token) } catch let error as GroupsAPIError { refused = error }
            #expect(refused?.code == "in-family" && refused?.family?.name == "Ortega family")
            let notIn = Invitation(inFamily: nil, invitationId: invitation.invitationId, groupId: invitation.groupId, kind: "family", name: "Lindqvist family",
                                   inviter: nil, expiresAt: invitation.expiresAt)
            #expect(InvitationNotice.of(notIn, refusal: refused, email: nil).canAccept == false)
            #expect(InvitationNotice.of(notIn, refusal: nil, email: nil) == InvitationNotice(note: nil, canAccept: true))
            // An `in-family` refusal that names no family, or names the newcomer: the web's words, and Accept still off.
            server.acceptAnswer = (409, ["code": "in-family", "message": "You’re in a family."])
            do { _ = try await api.acceptInvitation(token) } catch let error as GroupsAPIError { refused = error }
            #expect(InvitationNotice.of(notIn, refusal: refused, email: nil)
                == InvitationNotice(note: .problem("You’re in a family already. Leave it before you create another."), canAccept: false))
            server.acceptAnswer = (409, ["code": "in-family", "message": "They joined another family.", "data": ["reason": "newcomer"]])
            do { _ = try await api.acceptInvitation(token) } catch let error as GroupsAPIError { refused = error }
            #expect(InvitationNotice.of(notIn, refusal: refused, email: nil)
                == InvitationNotice(note: .problem("They’ve joined another family since they accepted. They can join yours once they leave it."), canAccept: false))
            for request in server.traffic where request.url.contains("/invitations/") {
                #expect(!request.url.contains(token))
                #expect(String(decoding: request.body, as: UTF8.self).contains(token))
            }
            // A token that isn't one never reaches the server.
            server.clearRequests()
            await #expect(throws: GroupsAPIError.self) { _ = try await api.acceptInvitation("../../groups") }
            #expect(!server.requested("/api/invitations/accept", method: "POST"))
        }
    }
}

private final class Kept: @unchecked Sendable {
    var value: String?
}
