import Foundation
import HushOSCore
import Testing
@testable import HushOSKit

/*
 * Joining a family on the phone without comparing words (docs/optional-verification.md 3.2, 3.3,
 * 2.8 "per family", 7.2) against the family stub, with real member lists the core signs: the
 * newcomer is the fixture's member, let in at roster 2 by the creator. The phone joins on first
 * use, stores the family guard before the device record, writes the first-use marker in the same
 * settings save as its first group pin, and keeps the guard through a `not-member` answer, so a
 * server that then serves another history meets a refused first use. Each test names the defect it
 * fails on.
 */
extension OnFakeDrive {
    @Suite struct FamilyJoinTests {
        /* The newcomer's phone, with settings that hold no pin of the family (they never joined it). */
        func newcomer(_ family: FamilyFixture, chain: [SignedGroupStatement]? = nil, guards: FamilyGuardStore? = nil) async throws -> (FamilyServer, FamilyFixture.Phone) {
            let server = FamilyServer(family: family)
            server.serve(chain: chain ?? [family.r1, family.r2])
            try server.storeSettings(pin: nil)
            return (server, try await family.phone(server, guards: guards))
        }

        /*
         * Waiting until route 2 says active; then joined with no words: the device record, the
         * settings pin and the family guard at roster 2, the joins record gone, the folder open. The
         * save that put the group pin in the settings carries the first-use marker, and no `before`
         * (or any) check record for this family: a first-use family is never labelled checked. The
         * creator's file then reads as nobody vouched for it (no "Verified by"), and unmarked.
         * Fails without the guard write, without the marker in that save, or without asFirstUse.
         */
        @Test func aFirstUseJoinStoresTheGuardMarksTheSettingsAndVouchesForNobody() async throws {
            let family = try FamilyFixture()
            let (server, phone) = try await newcomer(family)
            defer { phone.done() }
            let me = family.member.userId

            server.groupState = "accepted"
            #expect(try await phone.sync.joinStatus(family.groupId) == .waiting)
            #expect(try phone.held.family(family.groupId) == nil)
            server.groupState = "active"
            let view = try joinedView(try await phone.sync.joinStatus(family.groupId))
            #expect(view.rosterVersion == 2)
            #expect(phone.records.read(userId: me, groupId: family.groupId)?.rosterVersion == 2)
            #expect(phone.records.read(.joins, userId: me, groupId: family.groupId) == nil)
            #expect(try server.storedPin(family)?.rosterVersion == 2)
            #expect(try phone.held.family(family.groupId)?.rosterVersion == 2)
            #expect(try phone.held.family(family.groupId)?.rosterDigest == rosterDigest(statement: family.r2.statement))

            // 7.2: every saved document that holds the group pin holds the marker; none labels this family checked.
            let saved = try server.savedDocuments().compactMap { try JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }
            let pinned = saved.filter { ($0["groups"] as? [String: Any])?[family.groupId] != nil }
            #expect(!pinned.isEmpty)
            for document in pinned {
                #expect(document["familyChecksSince"] is String, "a first-use pin saved without the marker")
                #expect((document["familyChecks"] as? [String: Any])?[family.groupId] == nil, "a first-use family labelled checked")
            }
            #expect(await phone.sync.familyChecked(family.groupId) == false)

            let file = try #require(try await phone.vault.children(of: family.rootId).first)
            let verdict = await phone.sync.verdict(of: file.node, groupId: family.groupId)
            #expect(verdict.mark == nil)
            #expect(verdict.verifiedBy == nil, "a family taken on first use vouched for its writers")
            #expect(try await phone.sync.joinStatus(family.groupId) == .member)
        }

        /*
         * A phone-first join into an account whose settings already pin another family (accepted
         * before first use existed): the save that writes the first first-use pin also writes the
         * marker and a `before` record for that older family at its own roster, so the older family
         * keeps reading as checked and this one doesn't. Fails if the marker or the `before`
         * records are left for a later save.
         */
        @Test func aPhoneFirstJoinWritesTheMarkerAndBeforeRecordsInTheSameSaveAsItsPin() async throws {
            let family = try FamilyFixture()
            let older = try FamilyFixture()
            let server = FamilyServer(family: family)
            server.serve(chain: [family.r1, family.r2])
            var document = Settings()
            // Another family's pin, as an earlier release left it (no marker, no check records).
            document.setGroupPin(older.groupId, try older.pin(through: [older.r1, older.r2, older.r3]))
            try server.storeSettings(document: document)
            let phone = try await family.phone(server)
            defer { phone.done() }

            _ = try joinedView(try await phone.sync.joinStatus(family.groupId))
            let saved = try server.savedDocuments().compactMap { try JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }
            let first = try #require(saved.first { ($0["groups"] as? [String: Any])?[family.groupId] != nil })
            #expect(first["familyChecksSince"] is String)
            let checks = try #require(first["familyChecks"] as? [String: Any])
            let before = try #require(checks[older.groupId] as? [String: Any])
            #expect(before["how"] as? String == "before" && (before["rosterVersion"] as? NSNumber)?.intValue == 3)
            #expect(checks[family.groupId] == nil)
            let storedJSON = try #require(try server.storedDocument())
            let stored = try Settings(json: String(decoding: try JSONSerialization.data(withJSONObject: storedJSON), as: UTF8.self), version: 0)
            #expect(stored.familyChecked(older.groupId) && !stored.familyChecked(family.groupId))
        }

        /*
         * A `not-member` answer wipes the record and what was opened, but never the family guard.
         * The server then serves settings without the group pin and another history at roster 2,
         * as a fresh invitation would: the phone's first-use join meets the guard and shows the hard
         * warning, never joins. Fails if the wipe deletes the guard or a join passes it as absent.
         */
        @Test func aNotMemberAnswerKeepsTheGuardAndAnotherHistoryAfterItIsRefused() async throws {
            let family = try FamilyFixture()
            let (server, phone) = try await newcomer(family)
            defer { phone.done() }
            _ = try joinedView(try await phone.sync.joinStatus(family.groupId))
            let held = try #require(try phone.held.family(family.groupId))

            server.notMember = true
            #expect(await phone.sync.sync(family.summary) == .wiped)
            #expect(phone.records.read(userId: family.member.userId, groupId: family.groupId) == nil)
            // Kept, never lowered: the wipe stores the floor's guard first, which adds the folders opened here (the core's guard_after).
            let after = try #require(try phone.held.family(family.groupId), "the not-member wipe deleted the guard")
            #expect(after.rosterVersion == held.rosterVersion && after.rosterDigest == held.rosterDigest)
            #expect(held.areas.allSatisfy { after.areas[$0.key] ?? 0 >= $0.value })

            // Settings without the pin, another roster 2, and a fresh process on the same phone.
            server.notMember = false
            try server.storeSettings(pin: nil)
            server.serve(chain: [family.r1, family.r2Other])
            let later = try await family.phone(server, records: phone.records, guards: phone.guards)
            guard case .fork = try await later.sync.joinStatus(family.groupId) else {
                Issue.record("first use was taken again over another history")
                return
            }
            #expect(later.records.read(userId: family.member.userId, groupId: family.groupId) == nil)
            #expect(!later.vault.areaLedger.isArea(workspaceId: family.workspaceId))
        }

        /*
         * The family guard can't be stored (a full disk): the join stops with the storage words,
         * no device record is written, and nothing is opened; once storage works again the same
         * phone finishes the join from its joins record and stores the guard. Fails if the record
         * is written before (or without) the guard, or the failure reads as anything but storage.
         */
        @Test func aGuardThatCantBeStoredWritesNoRecordAndTheNextTryStoresIt() async throws {
            let family = try FamilyFixture()
            let writes = GuardSwitch()
            let (_, phone) = try await newcomer(family, guards: familyGuards(family.member, writes: writes))
            defer { phone.done() }
            let me = family.member.userId

            writes.writable = false
            await #expect(throws: GuardError.unsaved) { _ = try await phone.sync.joinStatus(family.groupId) }
            #expect(phone.records.read(userId: me, groupId: family.groupId) == nil)
            #expect(phone.records.read(.joins, userId: me, groupId: family.groupId) != nil)
            #expect(!FileManager.default.fileExists(atPath: phone.guards.file.path))

            writes.writable = true
            _ = try joinedView(try await phone.sync.joinStatus(family.groupId))
            #expect(try phone.held.family(family.groupId)?.rosterVersion == 2)
            #expect(phone.records.read(userId: me, groupId: family.groupId)?.rosterVersion == 2)
        }

        /*
         * Killed right after the guard was stored, before the device record (the order of 2.8):
         * the relaunched phone holds the guard and the joins record, finishes the join from them
         * against the same history, and a server that then serves a chain short of the guard is a
         * rollback, refused. Fails if the record is written first, or the guard isn't a mark.
         */
        @Test func aStopBetweenTheGuardAndTheRecordFinishesFromTheJoinsRecordAndRefusesARollback() async throws {
            let family = try FamilyFixture()
            let (server, first) = try await newcomer(family, chain: [family.r1, family.r2, family.r3])
            let me = family.member.userId
            let records = first.records
            let group = family.groupId
            let recordAtGuard = Kept()
            await first.vault.adopt(afterFamilyGuard: {
                recordAtGuard.value = records.read(userId: me, groupId: group).map { String($0.rosterVersion) } ?? "none"
                throw FamilyFailure(message: "stopped")
            })
            await #expect(throws: (any Error).self) { _ = try await first.sync.joinStatus(family.groupId) }
            first.done()
            #expect(recordAtGuard.value == "none", "the device record was written before the guard")
            #expect(try first.held.family(family.groupId)?.rosterVersion == 3)
            #expect(records.read(.joins, userId: me, groupId: family.groupId) != nil)

            let relaunched = try await family.phone(server, records: records, guards: first.guards)
            _ = try joinedView(try await relaunched.sync.joinStatus(family.groupId))
            #expect(records.read(userId: me, groupId: family.groupId)?.rosterVersion == 3)
            relaunched.done()

            // A wipe of everything but the guard, then the server serves roster 2 as the head.
            server.notMember = true
            let wiping = try await family.phone(server, records: records, guards: first.guards)
            #expect(await wiping.sync.sync(family.summary) == .wiped)
            wiping.done()
            server.notMember = false
            try server.storeSettings(pin: nil)
            server.serve(chain: [family.r1, family.r2])
            let replayed = try await family.phone(server, records: records, guards: first.guards)
            defer { replayed.done() }
            let outcome = try? await replayed.sync.joinStatus(family.groupId)
            if case .joined = outcome { Issue.record("a chain short of the guard was taken") }
            #expect(records.read(userId: me, groupId: family.groupId) == nil)
        }

        /*
         * A `not-member` answer after an acceptance whose guard couldn't be stored: the wipe waits
         * (nothing deleted, the storage words) until the guard is stored, then wipes, and the guard
         * holds the later roster. Fails if the wipe deletes before storing, or stores nothing.
         */
        @Test func aWipeWaitsForTheGuardItHandsBackToBeStored() async throws {
            let family = try FamilyFixture()
            let writes = GuardSwitch()
            let (server, phone) = try await newcomer(family, guards: familyGuards(family.member, writes: writes))
            defer { phone.done() }
            _ = try joinedView(try await phone.sync.joinStatus(family.groupId))

            // Roster 3 accepted while the guard can't be stored: the sync says so, and the guard stays at 2.
            server.serve(chain: [family.r1, family.r2, family.r3])
            writes.writable = false
            #expect(await phone.sync.sync(family.summary) == .failed(GuardWords.unsaved))
            #expect(try phone.held.family(family.groupId)?.rosterVersion == 2)

            server.notMember = true
            #expect(await phone.sync.sync(family.summary) == .failed(GuardWords.unsaved))
            #expect(phone.records.read(userId: family.member.userId, groupId: family.groupId) != nil, "the wipe deleted before the guard was stored")

            writes.writable = true
            #expect(await phone.sync.sync(family.summary) == .wiped)
            #expect(phone.records.read(userId: family.member.userId, groupId: family.groupId) == nil)
            #expect(try phone.held.family(family.groupId)?.rosterVersion == 3)
        }

        /*
         * The same wait when the removal is found by route 2 no longer listing the family (the live
         * check, `listReconciling`), not by a sync: nothing goes while the guard the core hands back
         * can't be stored, then the family goes, its guard kept at the later roster and its write
         * barrier let go. Fails if the unlisted path deletes before storing, deletes the guard, or
         * leaves family writes held after the family is gone.
         */
        @Test func anUnlistedFamilyIsWipedOnlyAfterItsGuardIsStored() async throws {
            let family = try FamilyFixture()
            let writes = GuardSwitch()
            let (server, phone) = try await newcomer(family, guards: familyGuards(family.member, writes: writes))
            defer { phone.done() }
            _ = try joinedView(try await phone.sync.joinStatus(family.groupId))

            server.serve(chain: [family.r1, family.r2, family.r3])
            writes.writable = false
            #expect(await phone.sync.sync(family.summary) == .failed(GuardWords.unsaved))
            #expect(await phone.vault.familyGuardOwed.contains(family.groupId.lowercased()))

            server.listed = false
            server.notMember = true
            // Said, not swallowed: the page leaves its accepted state for the storage words, and the family is asked again.
            let first = try await phone.sync.listReconciling()
            #expect(first.removed.isEmpty)
            #expect(first.failed == [family.groupId: GuardWords.unsaved])
            #expect(phone.records.read(userId: family.member.userId, groupId: family.groupId) != nil, "the wipe deleted before the guard was stored")
            #expect(FileManager.default.fileExists(atPath: phone.guards.file.path))

            writes.writable = true
            let second = try await phone.sync.listReconciling()
            #expect(second.removed == [family.groupId] && second.failed.isEmpty)
            #expect(phone.records.read(userId: family.member.userId, groupId: family.groupId) == nil)
            #expect(try phone.held.family(family.groupId)?.rosterVersion == 3)
            #expect(FileManager.default.fileExists(atPath: phone.guards.file.path))
            #expect(await phone.vault.familyGuardOwed.isEmpty)
        }

        /*
         * The guard only moves up: an older pin written after a newer one changes nothing, and a pin
         * of another history is refused and writes nothing. Fails if the store overwrites.
         */
        @Test func theGuardStoreMergesAndNeverGoesDown() async throws {
            let family = try FamilyFixture()
            let store = familyGuards(family.member)
            var keyed = store
            keyed.key = settingsKey(7)
            let three = try family.pin(through: [family.r1, family.r2, family.r3])
            let two = try family.pin(through: [family.r1, family.r2])
            try keyed.keep(family.groupId, three)
            #expect(try keyed.keep(family.groupId, two).rosterVersion == 3)
            #expect(try keyed.family(family.groupId)?.rosterVersion == 3)
            let other = try family.pin(through: [family.r1, family.r2, family.r3Fork])
            #expect(throws: FamilyGuardConflict.self) { try keyed.keep(family.groupId, other) }
            #expect(try keyed.family(family.groupId)?.rosterDigest == three.rosterDigest)
            // Under another settings key the record is unreadable, never none, and never written over.
            var swapped = store
            swapped.key = settingsKey(8)
            #expect(throws: GuardError.unreadable) { _ = try swapped.family(family.groupId) }
            #expect(throws: GuardError.unreadable) { try swapped.keep(family.groupId, two) }
            // The file names nothing: no family id, no digest.
            let text = try String(contentsOf: keyed.file, encoding: .utf8)
            #expect(!text.contains(family.groupId) && !text.contains(three.rosterDigest))
        }

        /*
         * Another process holds the guard's lock past the wait (the Files extension writing): the
         * join stops with "try again" words, never the full-disk ones, and writes no record. Fails
         * if a busy lock is reported as storage.
         */
        @Test func aBusyGuardLockSaysTryAgainNotFreeUpSpace() async throws {
            let family = try FamilyFixture()
            let (_, phone) = try await newcomer(family)
            defer { phone.done() }
            try FileManager.default.createDirectory(at: phone.guards.folder.deletingLastPathComponent(), withIntermediateDirectories: true)
            let lock = open(phone.guards.folder.path + ".lock", O_RDWR | O_CREAT, 0o600)
            defer { close(lock) }
            #expect(flock(lock, LOCK_EX) == 0)
            await #expect(throws: GuardError.raced) { _ = try await phone.sync.joinStatus(family.groupId) }
            #expect(GuardError.raced.errorDescription == GuardWords.moved)
            #expect(phone.records.read(userId: family.member.userId, groupId: family.groupId) == nil)
            flock(lock, LOCK_UN)
        }

        /*
         * A guard folder this process can't search (permissions, a data-protection class not open yet)
         * makes the file look missing to `fileExists`: it must read as unreadable, never as no guard,
         * which would be first use. Fails if any read error but a confirmed missing file reads as none.
         */
        @Test func aGuardFolderThatCantBeSearchedIsUnreadableNeverAbsent() async throws {
            let family = try FamilyFixture()
            var store = familyGuards(family.member)
            store.key = settingsKey(7)
            #expect(try store.family(family.groupId) == nil, "no folder at all is nothing stored")
            try store.keep(family.groupId, try family.pin(through: [family.r1, family.r2]))
            #expect(chmod(store.folder.path, 0) == 0)
            defer { chmod(store.folder.path, 0o755) }
            #expect(throws: GuardError.unreadable) { _ = try store.family(family.groupId) }
            // The contact guard's read path is the same, in the same folder.
            var contacts = ContactGuardStore(folder: store.folder, owner: store.owner, activity: .expired, generation: GuardGeneration())
            contacts.key = settingsKey(7)
            chmod(store.folder.path, 0o755)
            let maya = try makeIdentity("maya")
            try contacts.commit("maya", try guardEntryNext(previous: nil, pin: try firstSeen(maya.envelope)), over: 0)
            chmod(store.folder.path, 0)
            #expect(throws: GuardError.unreadable) { _ = try contacts.entry("maya") }
        }

        /* A sign-out (any wipe of the account) deletes the family guard with the contact guard. */
        @Test func aSignOutDeletesTheFamilyGuard() async throws {
            let family = try FamilyFixture()
            let root = FileManager.default.temporaryDirectory.appendingPathComponent("account-\(UUID().uuidString)")
            var store = FamilyGuardStore(folder: root.appendingPathComponent("local/guard", isDirectory: true),
                                         owner: AccountOwner(userId: family.member.userId, origin: "https://family.test"), activity: .expired)
            store.key = settingsKey(7)
            try store.keep(family.groupId, try family.pin(through: [family.r1, family.r2]))
            #expect(try store.family(family.groupId) != nil)
            AccountStore(root: root, temporary: root.appendingPathComponent("tmp")).wipe()
            #expect(!FileManager.default.fileExists(atPath: store.file.path))
            #expect(try store.family(family.groupId) == nil)
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

/* Where a join came to, for a test to say what it expected. */
private func joinedView(_ outcome: JoinOutcome, sourceLocation: SourceLocation = #_sourceLocation) throws -> FamilyView {
    guard case .joined(.accepted(let view)) = outcome else {
        Issue.record("expected a join, got \(outcome)", sourceLocation: sourceLocation)
        throw FamilyFailure(message: "not joined")
    }
    return view
}
