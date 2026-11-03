import Foundation
import HushOSCore
import Testing
@testable import HushOSKit

/*
 * A manager's side of joining (docs/groups-mobile-plan.md iOS 5a; Android's FamilyManageTest,
 * #265) against the stub server with real rosters and the core's ledger: the phone's account
 * manages the family (roster 3, the group key sealed to it), and Grace waits to join. Each test
 * fails on the defect it names.
 */
extension OnFakeDrive {
    @Suite struct FamilyManageTests {
        struct Managed {
            let family: FamilyFixture
            let server: FamilyServer
            let phone: FamilyFixture.Phone
            let grace: FamilyPerson
            var summary: GroupSummary {
                GroupSummary(id: family.groupId, kind: "family", name: "Lindqvist family", roles: ["members"], state: "active", rosterVersion: 3, groupKeyVersion: 1)
            }
            var me: String { family.member.userId }
            var kept: [(outboxId: String, entry: String)] { get throws { try phone.records.outboxList(userId: me, groupId: family.groupId) } }

            func waitingGrace() async throws -> PendingPerson {
                try #require(try await phone.sync.waitingToJoin(family.groupId).first { $0.userId == grace.userId.lowercased() })
            }
        }

        static let graceEmail = "grace@example.com"

        /* The phone's account manages the family, Grace waits to join, and the phone has accepted the family at roster 3. */
        static func managed() async throws -> Managed {
            let family = try await onLargeStack { try FamilyFixture() }
            let grace = try await onLargeStack { try FamilyPerson() }
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            try server.memberManages()
            server.waiting(grace, email: graceEmail, name: "Grace Holm")
            let phone = try await family.phone(server)
            guard case .accepted(let view) = await phone.sync.sync(family.summary) else { throw FamilyFailure(message: "not accepted") }
            #expect(view.rosterVersion == 3)
            return Managed(family: family, server: server, phone: phone, grace: grace)
        }

        /* `body` with no pause between resends. */
        static func quickly<T>(_ body: () async throws -> T) async rethrows -> T {
            try await FamilySync.$resendPause.withValue(.zero) { try await body() }
        }

        /*
         * Let them in lands: one call, the chain one longer, nothing left kept, Grace no longer
         * waiting and pinned first-seen (never verified), every call sent as this app (ios/), and a
         * fresh sync accepts the new member list. Fails if a landed call is kept or sent twice.
         */
        @Test func letThemInLandsAndLeavesNothingKept() async throws {
            let m = try await Self.managed()
            defer { m.phone.done() }
            let person = try await m.waitingGrace()
            #expect(try await Self.quickly { try await m.phone.sync.letIn(m.summary, person) } == .landed)
            #expect(m.server.callBodies.count == 1)
            #expect(m.server.lock.withLock { m.server.chain.count } == 4)
            #expect(try m.kept.isEmpty, "a landed call stayed kept")
            #expect(try await m.phone.sync.waitingToJoin(m.family.groupId).isEmpty)
            let pin = try #require(await m.phone.vault.knownPins()[m.grace.userId.lowercased()])
            #expect(!pin.verified, "Let them in made a checked pin")
            #expect(m.server.callClients.allSatisfy { $0.hasPrefix("ios/") }, "a call went out without the app's client name")
            guard case .accepted(let view) = await m.phone.sync.sync(m.summary) else { Issue.record("not accepted after the admission"); return }
            #expect(view.rosterVersion == 4)
        }

        static let noAnswer = answering(503, ["code": "unavailable", "message": "HushOS is temporarily unavailable."])

        /*
         * An unknown outcome (no answer twice) is sent again as the same bytes, each as this app,
         * and lands. Fails if a resend is signed again or serialized differently.
         */
        @Test func anUnknownOutcomeResendsTheSameBytes() async throws {
            let m = try await Self.managed()
            defer { m.phone.done() }
            m.server.lock.withLock { m.server.manage.admitAnswers = [Self.noAnswer, Self.noAnswer] }
            #expect(try await Self.quickly { try await m.phone.sync.letIn(m.summary, try await m.waitingGrace()) } == .landed)
            let bodies = m.server.callBodies
            #expect(bodies.count == 3 && Set(bodies).count == 1, "a resend wasn't the same bytes")
            #expect(m.server.callClients.count == 3 && m.server.callClients.allSatisfy { $0.hasPrefix("ios/") })
        }

        /*
         * Kept across a kill: no answer three times leaves the call kept; a new process (the same
         * records) sends the same bytes and it lands. Fails if a kept call is lost or signed again.
         */
        @Test func aKeptSendSurvivesAKillAndARelaunch() async throws {
            let m = try await Self.managed()
            defer { m.phone.done() }
            m.server.lock.withLock { m.server.manage.admitAnswers = [Self.noAnswer, Self.noAnswer, Self.noAnswer] }
            guard case .pending = try await Self.quickly({ try await m.phone.sync.letIn(m.summary, try await m.waitingGrace()) }) else {
                Issue.record("no answer wasn't pending"); return
            }
            #expect(try m.kept.count == 1)
            let next = try await m.family.phone(m.server, records: m.phone.records, guards: m.phone.guards)
            guard case .accepted = await next.sync.sync(m.summary) else { Issue.record("not accepted after the relaunch"); return }
            let ends = try await Self.quickly { try await next.sync.resumeOutbox(m.family.groupId) }
            #expect(Array(ends.values) == [.landed])
            let bodies = m.server.callBodies
            #expect(bodies.count == 4 && Set(bodies).count == 1, "the next process sent other bytes than the kept call's")
            #expect(try m.kept.isEmpty)
        }

        /*
         * Another manager's change lands first (stale): the call is dropped and a new one signed over
         * the winner, which lands. Fails if a stale call is sent again as it was, or kept.
         */
        @Test func staleDropsTheSendAndSignsAgainOverTheWinner() async throws {
            let m = try await Self.managed()
            defer { m.phone.done() }
            let server = m.server
            m.server.lock.withLock {
                m.server.manage.admitAnswers = [{ _ in
                    try? server.creatorChangesTheList()
                    return (409, ["code": "stale", "message": "Another change to the family landed first."])
                }]
            }
            #expect(try await Self.quickly { try await m.phone.sync.letIn(m.summary, try await m.waitingGrace()) } == .landed)
            let bodies = m.server.callBodies
            #expect(bodies.count == 2 && bodies[0] != bodies[1], "a stale call was sent again as it was")
            let second = try #require(try JSONSerialization.jsonObject(with: bodies[1]) as? [String: Any])
            #expect((second["expectedRevision"] as? NSNumber)?.intValue == 4)
            #expect(m.server.lock.withLock { m.server.chain.count } == 5)
            #expect(try m.kept.isEmpty)
        }

        /*
         * A call the server applied whose answers were all lost: once the phone has synced, the kept
         * call is dropped as landed, never sent again. Fails if a landed call is resent.
         */
        @Test func aLandedCallWhoseAnswersWereLostIsDroppedUnsent() async throws {
            let m = try await Self.managed()
            defer { m.phone.done() }
            let server = m.server
            let lost: @Sendable ([String: Any]) -> (Int, Any)? = { body in
                let applied = server.lock.withLock { server.apply(body, userId: "") }
                _ = applied
                return (500, ["message": "The connection dropped"])
            }
            m.server.lock.withLock { m.server.manage.admitAnswers = [lost, Self.noAnswer, Self.noAnswer] }
            guard case .pending = try await Self.quickly({ try await m.phone.sync.letIn(m.summary, try await m.waitingGrace()) }) else {
                Issue.record("lost answers weren't pending"); return
            }
            guard case .accepted = await m.phone.sync.sync(m.summary) else { Issue.record("not accepted"); return }
            let sent = m.server.callBodies.count
            #expect(Array(try await Self.quickly { try await m.phone.sync.resumeOutbox(m.family.groupId) }.values) == [.landed])
            #expect(m.server.callBodies.count == sent, "a call the server applied was sent again")
            #expect(try m.kept.isEmpty)
        }

        /*
         * Superseded: another change landed after the call was kept; once synced, the kept call is
         * dropped unsent. Fails if a superseded call is sent.
         */
        @Test func aSupersededEntryIsDroppedUnsent() async throws {
            let m = try await Self.managed()
            defer { m.phone.done() }
            m.server.lock.withLock { m.server.manage.admitAnswers = [Self.noAnswer, Self.noAnswer, Self.noAnswer] }
            _ = try await Self.quickly { try await m.phone.sync.letIn(m.summary, try await m.waitingGrace()) }
            try m.server.creatorChangesTheList()
            guard case .accepted = await m.phone.sync.sync(m.summary) else { Issue.record("not accepted"); return }
            let sent = m.server.callBodies.count
            #expect(Array(try await Self.quickly { try await m.phone.sync.resumeOutbox(m.family.groupId) }.values) == [.stale])
            #expect(m.server.callBodies.count == sent, "a superseded call was sent")
            #expect(try m.kept.isEmpty)
        }

        /*
         * Pressing Let them in again while the first call is unanswered sends that call again and
         * signs nothing new. Fails if a second press stages a competing admission.
         */
        @Test func pressingAgainWhileUnansweredSignsNothingNew() async throws {
            let m = try await Self.managed()
            defer { m.phone.done() }
            m.server.lock.withLock { m.server.manage.admitAnswers = Array(repeating: Self.noAnswer, count: 6) }
            let person = try await m.waitingGrace()
            for _ in 0 ..< 2 {
                guard case .pending = try await Self.quickly({ try await m.phone.sync.letIn(m.summary, person) }) else { Issue.record("not pending"); return }
            }
            #expect(try m.kept.count == 1, "a second press kept a second call")
            let bodies = m.server.callBodies
            #expect(bodies.count == 6 && Set(bodies).count == 1, "a second press signed a new call")
        }

        /*
         * Per person: Grace's call is kept unanswered; letting Ada in sends Ada's call only, and
         * leaves Grace's as it was. Fails if another person's kept call is sent or dropped.
         */
        /*
         * The gate (Android #281): Grace's Let them in is kept unanswered, and letting Ada in sends
         * Grace's first (still unanswered), then stages nothing over it: Ada's waits, said so, and
         * Grace's call is left as it was. Once Grace's lands, Ada is let in. Fails if a roster call is
         * staged over a kept one, which its next resume would drop as superseded, unseen.
         */
        @Test func anotherPersonsKeptAdmissionGoesFirst() async throws {
            let m = try await Self.managed()
            defer { m.phone.done() }
            m.server.lock.withLock { m.server.manage.admitAnswers = Array(repeating: Self.noAnswer, count: 6) }
            _ = try await Self.quickly { try await m.phone.sync.letIn(m.summary, try await m.waitingGrace()) }
            let graceKept = try m.kept
            let ada = try await onLargeStack { try FamilyPerson() }
            m.server.waiting(ada, email: "ada@example.com", name: "Ada Lindqvist")
            let adaRow = try #require(try await m.phone.sync.waitingToJoin(m.family.groupId).first { $0.userId == ada.userId.lowercased() })
            #expect(try await Self.quickly { try await m.phone.sync.letIn(m.summary, adaRow) } == .refused(ManageWords.earlierWaiting("Lindqvist family")))
            #expect(try m.kept.map(\.entry) == graceKept.map(\.entry), "Grace's kept call changed")
            m.server.lock.withLock { m.server.manage.admitAnswers = [] }
            #expect(try await Self.quickly { try await m.phone.sync.letIn(m.summary, adaRow) } == .landed)
            #expect(try m.kept.isEmpty)
        }

        /*
         * A change landed since the phone's last sync: staging syncs first, so one call lands.
         * Fails if a call is staged over a chain the phone hasn't synced.
         */
        @Test func aChangeSinceTheLastSyncIsSyncedBeforeLettingIn() async throws {
            let m = try await Self.managed()
            defer { m.phone.done() }
            try m.server.creatorChangesTheList()
            #expect(try await Self.quickly { try await m.phone.sync.letIn(m.summary, try await m.waitingGrace()) } == .landed)
            #expect(m.server.callBodies.count == 1, "a call was staged over an older chain")
            #expect(m.server.lock.withLock { m.server.chain.count } == 5)
        }

        /*
         * A change lands between the sync and the head read: the head the server serves is checked
         * against the chain synced, and synced again before anything is signed. Fails if staging
         * signs over a head it didn't check.
         */
        @Test func aChangeBetweenTheSyncAndTheHeadReadIsSyncedAgain() async throws {
            let m = try await Self.managed()
            defer { m.phone.done() }
            let server = m.server
            let reads = Calls()
            m.server.lock.withLock {
                m.server.manage.beforeAnswer = { method, path in
                    guard method == "GET", path == "/api/groups/\(server.family.groupId)" else { return }
                    reads.append(true)
                    // The second read of route 3 in the press is the head's (the first is the sync's details).
                    if reads.values.count == 2 { try? server.creatorChangesTheList() }
                }
            }
            #expect(try await Self.quickly { try await m.phone.sync.letIn(m.summary, try await m.waitingGrace()) } == .landed)
            #expect(m.server.callBodies.count == 1, "a call was signed over a head that moved after the sync")
            #expect(m.server.lock.withLock { m.server.chain.count } == 5)
        }

        /*
         * Grace's account changed after the row was drawn: the same drawn row says so (Continue), then
         * lets her in under her keys now, read from route 16 again. Fails if staging takes the keys
         * the drawn row carried.
         */
        @Test func aChangedAccountIsLetInAfterContinueWithoutReloadingTheRow() async throws {
            let m = try await Self.managed()
            defer { m.phone.done() }
            _ = try await m.phone.vault.addContact(email: Self.graceEmail, writer: m.grace.userId, firstSeen: "family")
            let drawn = try await m.waitingGrace()
            let renewed = try await onLargeStack { [userId = m.grace.userId] in try FamilyPerson(userId: userId, keyVersion: 2) }
            m.server.waiting(renewed, email: Self.graceEmail, name: "Grace Holm")
            guard case .changed(let change) = try await Self.quickly({ try await m.phone.sync.letIn(m.summary, drawn) }) else {
                Issue.record("the changed account wasn't said"); return
            }
            _ = try await m.phone.vault.continueWith(change)
            #expect(try await Self.quickly { try await m.phone.sync.letIn(m.summary, drawn) } == .landed, "the drawn row's old keys were staged")
        }

        /*
         * Pinning them moves trust (here a new pin; a followed succession is told the same way, from
         * addContact's own answer) and is told before the admission, so the app judges signatures again
         * even when the admission is then refused. Fails if a pin Let them in made or moved is kept from
         * the app, leaving marks drawn over the old trust.
         */
        @Test func aPinLetThemInMovesIsToldEvenWhenTheAdmissionIsRefused() async throws {
            let m = try await Self.managed()
            defer { m.phone.done() }
            m.server.lock.withLock { m.server.manage.admitAnswers = [answering(409, ["code": "pool-full", "message": "No room."])] }
            let told = Heard()
            let outcome = try await Self.quickly {
                try await m.phone.sync.letIn(m.summary, try await m.waitingGrace()) { await told.add(.landed, route: nil, keptThen: 0) }
            }
            #expect(outcome == .refused(ManageWords.poolFull))
            #expect(await told.ends.count == 1, "a pin Let them in made wasn't told")
            #expect(await m.phone.vault.knownPins()[m.grace.userId.lowercased()] != nil)
        }

        /*
         * The settings can't be read before a kept call is sent: nothing is sent and the call stays
         * kept; once they read, it lands. Fails if a call goes out without the settings read afresh.
         */
        @Test func aSettingsReadThatFailsSendsNothing() async throws {
            let m = try await Self.managed()
            defer { m.phone.done() }
            m.server.lock.withLock { m.server.manage.admitAnswers = [Self.noAnswer, Self.noAnswer, Self.noAnswer] }
            _ = try await Self.quickly { try await m.phone.sync.letIn(m.summary, try await m.waitingGrace()) }
            let sent = m.server.callBodies.count
            m.server.lock.withLock { m.server.manage.failSettingsReads = true }
            guard case .pending? = try await Self.quickly({ try await m.phone.sync.resumeOutbox(m.family.groupId) }).values.first else {
                Issue.record("a failed settings read wasn't pending"); return
            }
            #expect(m.server.callBodies.count == sent, "a call went out without the settings read")
            #expect(try m.kept.count == 1)
            m.server.lock.withLock { m.server.manage.failSettingsReads = false }
            #expect(Array(try await Self.quickly { try await m.phone.sync.resumeOutbox(m.family.groupId) }.values) == [.landed])
        }

        /*
         * Not-member on a kept call: the family is wiped as a removal, published to the screens, and
         * its kept calls go. Fails if not-member is taken as a refusal, or the outbox outlives the wipe.
         */
        @Test func notMemberOnAKeptSendIsARemovalTheScreensAreTold() async throws {
            let m = try await Self.managed()
            defer { m.phone.done() }
            m.server.lock.withLock { m.server.manage.admitAnswers = [Self.noAnswer, Self.noAnswer, Self.noAnswer] }
            _ = try await Self.quickly { try await m.phone.sync.letIn(m.summary, try await m.waitingGrace()) }
            _ = m.phone.sync.releases.take()
            m.server.notMember = true
            #expect(try await Self.quickly { try await m.phone.sync.resumeOutbox(m.family.groupId) }.values.contains(.wiped))
            #expect(m.phone.sync.releases.take().contains { $0.groupId == m.family.groupId && $0.revised.state == .wiped }, "the removal wasn't published")
            #expect(m.phone.records.read(userId: m.me, groupId: m.family.groupId) == nil)
            #expect(try m.kept.isEmpty, "the kept call outlived the wipe")
        }

        /*
         * Not-member while letting in, after the family synced (route 16, read again while staging): a
         * removal, published. Fails if it is thrown on or said as a refusal.
         */
        @Test func notMemberWhileLettingInIsARemovalTheScreensAreTold() async throws {
            let m = try await Self.managed()
            defer { m.phone.done() }
            let person = try await m.waitingGrace()
            _ = m.phone.sync.releases.take()
            m.server.lock.withLock { m.server.manage.pendingAnswer = (404, ["code": "not-member", "message": "You are not in this group."]) }
            #expect(try await Self.quickly { try await m.phone.sync.letIn(m.summary, person) } == .wiped)
            #expect(m.phone.sync.releases.take().contains { $0.groupId == m.family.groupId && $0.revised.state == .wiped })
            #expect(m.phone.records.read(userId: m.me, groupId: m.family.groupId) == nil)
        }

        /*
         * The outbox folder can't be listed: Let them in and the resume throw, and nothing is signed
         * or sent. Fails if a store that can't be read is taken as empty.
         */
        @Test func anOutboxThatCantBeListedSignsAndSendsNothing() async throws {
            let m = try await Self.managed()
            defer { m.phone.done() }
            let folder = m.phone.records.folder.appendingPathComponent("outbox", isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: folder.path)
            defer { try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: folder.path) }
            let person = try await m.waitingGrace()
            await #expect(throws: GuardError.self) { _ = try await Self.quickly { try await m.phone.sync.letIn(m.summary, person) } }
            await #expect(throws: GuardError.self) { _ = try await m.phone.sync.resumeOutbox(m.family.groupId) }
            #expect(m.server.callBodies.isEmpty, "a call was sent while the outbox couldn't be read")
        }

        /*
         * A wipe whose outbox folder can't be listed fails as a wipe that didn't finish: the family
         * isn't let go of as wiped while signed calls stay on disk, and once the folder reads, the
         * removal takes them. Fails if a listing that failed is taken as no calls.
         */
        @Test func aWipeWhoseOutboxCantBeListedFailsAndKeepsNothingBehind() async throws {
            let m = try await Self.managed()
            defer { m.phone.done() }
            m.server.lock.withLock { m.server.manage.admitAnswers = [Self.noAnswer, Self.noAnswer, Self.noAnswer] }
            _ = try await Self.quickly { try await m.phone.sync.letIn(m.summary, try await m.waitingGrace()) }
            let kept = try #require(try m.kept.first)
            let folder = m.phone.records.folder.appendingPathComponent("outbox", isDirectory: true)
            let file = folder.appendingPathComponent("\(m.me.lowercased())_\(m.family.groupId)_\(kept.outboxId).call")
            // Write and search, no listing: each file can still be reached by name.
            try FileManager.default.setAttributes([.posixPermissions: 0o300], ofItemAtPath: folder.path)
            defer { try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: folder.path) }
            #expect(await m.phone.sync.removedNow(m.family.groupId).state != .wiped, "a wipe that couldn't list the kept calls was called done")
            #expect(FileManager.default.fileExists(atPath: file.path))
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: folder.path)
            #expect(await m.phone.sync.removedNow(m.family.groupId).state == .wiped)
            #expect(!FileManager.default.fileExists(atPath: file.path), "a signed call outlived the wipe")
        }

        /*
         * Whoever asked for the resume stops waiting mid-resend (its page left): a call already refused
         * was kept to be said before its entry went, so the refusal is still said, by the next process
         * too; the call after it stays kept. Fails if what a dropped call came to reaches only a caller
         * that may have gone.
         */
        @Test func aRefusalIsKeptToBeSaidEvenWhenTheResumeStops() async throws {
            let m = try await Self.managed()
            defer { m.phone.done() }
            m.server.lock.withLock { m.server.manage.admitAnswers = Array(repeating: Self.noAnswer, count: 6) }
            _ = try await Self.quickly { try await m.phone.sync.letIn(m.summary, try await m.waitingGrace()) }
            // Two calls kept, as an earlier version's outbox could hold them (the gate stages nothing over a kept call
            // now): Grace's set aside while Ada's is staged, then put back.
            let outbox = m.phone.records.folder.appendingPathComponent("outbox", isDirectory: true)
            let graceFile = try #require(try FileManager.default.contentsOfDirectory(at: outbox, includingPropertiesForKeys: nil).first { $0.pathExtension == "call" })
            let aside = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            try FileManager.default.moveItem(at: graceFile, to: aside)
            let ada = try await onLargeStack { try FamilyPerson() }
            m.server.waiting(ada, email: "ada@example.com", name: "Ada Lindqvist")
            let adaRow = try #require(try await m.phone.sync.waitingToJoin(m.family.groupId).first { $0.userId == ada.userId.lowercased() })
            _ = try await Self.quickly { try await m.phone.sync.letIn(m.summary, adaRow) }
            try FileManager.default.moveItem(at: aside, to: graceFile)
            #expect(try m.kept.count == 2)
            m.server.lock.withLock {
                m.server.manage.admitAnswers = [answering(409, ["code": "pool-full", "message": "No room."])] + Array(repeating: Self.noAnswer, count: 3)
            }
            let (groupId, sync) = (m.family.groupId, m.phone.sync)
            let sent = m.server.callBodies.count
            let resume = Task {
                try await FamilySync.$resendPause.withValue(.milliseconds(200)) { try await sync.resumeOutbox(groupId) }
            }
            // The second call sent once and waiting out its pause: the caller stops waiting.
            for _ in 0 ..< 500 where m.server.callBodies.count < sent + 2 { try await Task.sleep(for: .milliseconds(10)) }
            resume.cancel()
            _ = await resume.result
            #expect(try m.kept.count == 1)
            // The page that asked is gone, and so is the process: the next one still has it to say.
            let next = try await m.family.phone(m.server, records: m.phone.records, guards: m.phone.guards)
            #expect(try await next.sync.keptEnds().map(\.end) == [.refused(ManageWords.poolFull)], "a refusal of a dropped call went unsaid")
        }

        /*
         * Turned down with a Let them in still kept for them, and the decline's answer lost after the
         * server took it: the kept call was gone before the decline went. They accept a later
         * invitation (no revision moves) and the outbox resumes: they aren't let in by the old call.
         * Fails if a decline is sent while a signed admission of theirs can still be replayed.
         */
        @Test func aTurnDownWhoseAnswerIsLostLeavesNoAdmissionToReplay() async throws {
            let m = try await Self.managed()
            defer { m.phone.done() }
            m.server.lock.withLock { m.server.manage.admitAnswers = [Self.noAnswer, Self.noAnswer, Self.noAnswer] }
            _ = try await Self.quickly { try await m.phone.sync.letIn(m.summary, try await m.waitingGrace()) }
            #expect(try m.kept.count == 1)
            let server = m.server
            let graceId = m.grace.userId.lowercased()
            m.server.lock.withLock {
                // The server takes the decline; its answer never arrives.
                m.server.manage.beforeAnswer = { method, path in
                    guard method == "POST", path.hasSuffix("/decline") else { return }
                    server.lock.withLock {
                        server.manage.pendingRows.removeAll { $0["userId"] as? String == graceId }
                        server.manage.manageAnswer = (503, ["code": "unavailable", "message": "HushOS is temporarily unavailable."])
                    }
                }
            }
            await #expect(throws: (any Error).self) { try await m.phone.sync.turnDown(m.family.groupId, userId: m.grace.userId) }
            #expect(m.server.lock.withLock { m.server.manage.declined.count } == 1)
            #expect(try m.kept.isEmpty, "a turned-down person's admission stayed kept")
            m.server.lock.withLock {
                m.server.manage.beforeAnswer = nil
                m.server.manage.manageAnswer = nil
            }
            // They accept another invitation: waiting again, under the same chain.
            m.server.waiting(m.grace, email: Self.graceEmail, name: "Grace Holm")
            let chain = m.server.lock.withLock { m.server.chain.count }
            let sent = m.server.callBodies.count
            _ = try await Self.quickly { try await m.phone.sync.resumeOutbox(m.family.groupId) }
            #expect(m.server.callBodies.count == sent, "the old admission was sent after the decline")
            #expect(m.server.lock.withLock { m.server.chain.count } == chain, "they were let in with nobody pressing Let them in")
        }

        /*
         * The kept admissions can't be judged (the settings don't read): the decline isn't sent, so
         * the call that stays kept is for someone still waiting. Fails if a decline goes out while a
         * signed admission of theirs is left behind.
         */
        @Test func aTurnDownWhoseCleanupCantRunSendsNoDecline() async throws {
            let m = try await Self.managed()
            defer { m.phone.done() }
            m.server.lock.withLock { m.server.manage.admitAnswers = [Self.noAnswer, Self.noAnswer, Self.noAnswer] }
            _ = try await Self.quickly { try await m.phone.sync.letIn(m.summary, try await m.waitingGrace()) }
            m.server.lock.withLock { m.server.manage.failSettingsReads = true }
            await #expect(throws: (any Error).self) { try await m.phone.sync.turnDown(m.family.groupId, userId: m.grace.userId) }
            #expect(m.server.lock.withLock { m.server.manage.declined.isEmpty }, "a decline went out with their admission still kept")
            #expect(try m.kept.count == 1)
            #expect(try await m.waitingGrace().userId == m.grace.userId.lowercased())
        }

        /*
         * An outbox that can't be reached (its folder's parent can't be searched) is never read as
         * one that isn't there: listing, resuming and wiping throw. Fails if `fileExists` saying no
         * is taken as nothing kept.
         */
        @Test func anOutboxThatCantBeReachedIsNotAnEmptyOne() async throws {
            let m = try await Self.managed()
            defer { m.phone.done() }
            // A folder that plainly isn't there yet is no calls, and a wipe has nothing to take.
            #expect(!FileManager.default.fileExists(atPath: m.phone.records.folder.appendingPathComponent("outbox").path))
            #expect(try m.kept.isEmpty)
            try m.phone.records.outboxDeleteAll(userId: m.me, groupId: m.family.groupId)
            m.server.lock.withLock { m.server.manage.admitAnswers = [Self.noAnswer, Self.noAnswer, Self.noAnswer] }
            _ = try await Self.quickly { try await m.phone.sync.letIn(m.summary, try await m.waitingGrace()) }
            let parent = m.phone.records.folder
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: parent.path)
            defer { try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: parent.path) }
            #expect(throws: GuardError.self) { _ = try m.phone.records.outboxList(userId: m.me, groupId: m.family.groupId) }
            #expect(throws: GuardError.self) { try m.phone.records.outboxDeleteAll(userId: m.me, groupId: m.family.groupId) }
            await #expect(throws: GuardError.self) { _ = try await m.phone.sync.resumeOutbox(m.family.groupId) }
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: parent.path)
            #expect(try m.kept.count == 1, "the kept call was lost")
        }

        /*
         * Let them in kept on this device says why it isn't in yet, in the words the outbox gave
         * ("Saved on this device. {reason}", Android #265). Fails if the reason is dropped or
         * replaced by fixed words.
         */
        @Test func aKeptLetInSaysWhyItIsntInYet() async throws {
            let m = try await Self.managed()
            defer { m.phone.done() }
            m.server.lock.withLock { m.server.manage.admitAnswers = [Self.noAnswer, Self.noAnswer, Self.noAnswer] }
            let outcome = try await Self.quickly { try await m.phone.sync.letIn(m.summary, try await m.waitingGrace()) }
            guard case .pending(let reason) = outcome else { Issue.record("no answer wasn't pending"); return }
            #expect(!reason.isEmpty)
            #expect(ManageWords.letIn(outcome, first: "Grace", family: "Lindqvist family") == "Saved on this device. \(reason)")
            #expect(ManageWords.letIn(.pending(ManageWords.grantsDue), first: "Grace", family: "Lindqvist family") == "Saved on this device. \(ManageWords.grantsDue)")
            #expect(ManageWords.letIn(.landed, first: "Grace", family: "Lindqvist family") == "Grace is in Lindqvist family")
            #expect(ManageWords.letIn(.refused("No."), first: "Grace", family: "Lindqvist family") == nil)
        }

        /*
         * A kept admission another change overtook is kept to be said, with its route, before its
         * entry goes, and said until read: let them in again. Fails if a superseded admission vanishes
         * without a word.
         */
        @Test func anOvertakenAdmissionIsSaidBeforeItsCallGoes() async throws {
            let m = try await Self.managed()
            defer { m.phone.done() }
            m.server.lock.withLock { m.server.manage.admitAnswers = [Self.noAnswer, Self.noAnswer, Self.noAnswer] }
            _ = try await Self.quickly { try await m.phone.sync.letIn(m.summary, try await m.waitingGrace()) }
            try m.server.creatorChangesTheList()
            guard case .accepted = await m.phone.sync.sync(m.summary) else { Issue.record("not accepted"); return }
            _ = try await Self.quickly { try await m.phone.sync.resumeOutbox(m.family.groupId) }
            let ends = try await m.phone.sync.keptEnds()
            let graceId = m.grace.userId.lowercased()
            #expect(ends.map(\.end) == [.stale] && ends.map(\.route) == [.admit(userId: graceId)], "an overtaken admission wasn't kept to be said")
            #expect(try m.kept.isEmpty)
            let said = ends.first.flatMap { ManageWords.resumed($0.end, route: $0.route) { $0 == graceId ? "Grace" : nil } }
            #expect(said == "An earlier admission of Grace wasn’t sent; let them in again.")
            #expect(ManageWords.resumed(.stale, route: .admit(userId: graceId)) { _ in nil } == "An earlier admission of someone waiting to join wasn’t sent; let them in again.")
            #expect(ManageWords.resumed(.landed, route: .admit(userId: graceId)) { _ in "Grace" } == nil)
        }

        /*
         * Codex #285 round 2: what the staging gate let go of is kept on this phone, not only in the
         * process: Ada's Let them in sends Grace's kept call first, which another change overtook, and
         * the next process (a relaunch before any screen said it, or a screen whose request then threw)
         * still has it to say. Fails if the gate's ends live only in memory.
         */
        @Test func whatTheGateLetGoOfOutlivesTheProcess() async throws {
            let m = try await Self.managed()
            defer { m.phone.done() }
            m.server.lock.withLock { m.server.manage.admitAnswers = [Self.noAnswer, Self.noAnswer, Self.noAnswer] }
            _ = try await Self.quickly { try await m.phone.sync.letIn(m.summary, try await m.waitingGrace()) }
            try m.server.creatorChangesTheList()
            guard case .accepted = await m.phone.sync.sync(m.summary) else { Issue.record("not accepted"); return }
            m.server.lock.withLock { m.server.manage.admitAnswers = [] }
            let ada = try await onLargeStack { try FamilyPerson() }
            m.server.waiting(ada, email: "ada@example.com", name: "Ada Lindqvist")
            let adaRow = try #require(try await m.phone.sync.waitingToJoin(m.family.groupId).first { $0.userId == ada.userId.lowercased() })
            _ = try await Self.quickly { try await m.phone.sync.letIn(m.summary, adaRow) }
            #expect(try m.kept.isEmpty)
            let next = try await m.family.phone(m.server, records: m.phone.records, guards: m.phone.guards)
            let ends = try await next.sync.keptEnds()
            #expect(ends.map(\.end) == [.stale] && ends.map(\.route) == [.admit(userId: m.grace.userId.lowercased())], "the gate's end went with the process")
        }

        /*
         * Said once, and only what was said goes: reading the ends lets go of none; an entry that
         * comes back (the app stopped after keeping its end, before deleting it) and ends the same
         * way again is kept once; letting go of what a screen said keeps an end kept after it looked.
         * Fails if a look loses ends a reset came between, a crash says one twice, or a drop takes
         * an end nobody said.
         */
        @Test func keptEndsAreLetGoOfOnlyOnceSaid() async throws {
            let m = try await Self.managed()
            defer { m.phone.done() }
            m.server.lock.withLock { m.server.manage.admitAnswers = [Self.noAnswer, Self.noAnswer, Self.noAnswer] }
            _ = try await Self.quickly { try await m.phone.sync.letIn(m.summary, try await m.waitingGrace()) }
            let outbox = m.phone.records.folder.appendingPathComponent("outbox", isDirectory: true)
            let graceFile = try #require(try FileManager.default.contentsOfDirectory(at: outbox, includingPropertiesForKeys: nil).first { $0.pathExtension == "call" })
            let copy = try Data(contentsOf: graceFile)
            try m.server.creatorChangesTheList()
            guard case .accepted = await m.phone.sync.sync(m.summary) else { Issue.record("not accepted"); return }
            _ = try await Self.quickly { try await m.phone.sync.resumeOutbox(m.family.groupId) }
            #expect(try await m.phone.sync.keptEnds().count == 1)
            let looked = try await m.phone.sync.keptEnds()
            #expect(looked.count == 1, "a look let go of what it read")
            // The entry back, as if the app stopped between keeping its end and deleting it: overtaken again.
            try copy.write(to: graceFile)
            _ = try await Self.quickly { try await m.phone.sync.resumeOutbox(m.family.groupId) }
            #expect(try m.kept.isEmpty)
            #expect(try await m.phone.sync.keptEnds() == looked, "an entry that came back was said twice")
            // Another end kept after the screen looked, then what it said let go of.
            let later = try #require(FamilyRecords.UnsaidEnd(outboxId: UUID().uuidString, end: .refused("Later."), route: nil))
            try m.phone.records.keepUnsaid(userId: m.me, groupId: m.family.groupId, later)
            try await m.phone.sync.dropKeptEnds(looked)
            #expect(try await m.phone.sync.keptEnds().map(\.end) == [.refused("Later.")], "letting go of what was said took an end kept since")
        }

        /*
         * This phone's call is overtaken and they no longer wait, because another manager turned them
         * down: never said as let in. Fails if leaving route 16 is taken as joining.
         */
        @Test func overtakenByATurnDownIsNotLetIn() async throws {
            let m = try await Self.managed()
            defer { m.phone.done() }
            let server = m.server
            let graceId = m.grace.userId.lowercased()
            m.server.lock.withLock {
                m.server.manage.admitAnswers = [{ _ in
                    try? server.creatorChangesTheList()
                    server.lock.withLock { server.manage.pendingRows.removeAll { $0["userId"] as? String == graceId } }
                    return (409, ["code": "stale", "message": "Another change to the family landed first."])
                }]
            }
            #expect(try await Self.quickly { try await m.phone.sync.letIn(m.summary, try await m.waitingGrace()) } == .refused(ManageWords.notWaiting("Grace")))
            #expect(try m.kept.isEmpty)
        }

        /*
         * This phone's call is overtaken and the member list accepted afresh names them: let in.
         * Fails if a person the roster admitted meanwhile is said not to be waiting.
         */
        @Test func overtakenByTheirAdmissionIsLetIn() async throws {
            let m = try await Self.managed()
            defer { m.phone.done() }
            let server = m.server
            let graceId = m.grace.userId
            m.server.lock.withLock {
                m.server.manage.admitAnswers = [{ body in
                    // Applied, as another manager's admission of Grace would be, then answered as overtaken.
                    _ = server.lock.withLock { server.apply(body, userId: graceId) }
                    return (409, ["code": "stale", "message": "Another change to the family landed first."])
                }]
            }
            #expect(try await Self.quickly { try await m.phone.sync.letIn(m.summary, try await m.waitingGrace()) } == .landed)
        }

        /*
         * A kept call's file can't be read: nothing is signed or sent and the file stays; once it
         * reads, the same bytes land. Fails if an unreadable entry is dropped or skipped.
         */
        @Test func aKeptEntryThatCantBeReadSignsAndSendsNothing() async throws {
            let m = try await Self.managed()
            defer { m.phone.done() }
            m.server.lock.withLock { m.server.manage.admitAnswers = [Self.noAnswer, Self.noAnswer, Self.noAnswer] }
            let person = try await m.waitingGrace()
            _ = try await Self.quickly { try await m.phone.sync.letIn(m.summary, person) }
            let kept = try #require(try m.kept.first)
            let file = m.phone.records.folder.appendingPathComponent("outbox/\(m.me.lowercased())_\(m.family.groupId)_\(kept.outboxId).call")
            try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: file.path)
            let sent = m.server.callBodies.count
            await #expect(throws: GuardError.self) { _ = try await Self.quickly { try await m.phone.sync.letIn(m.summary, person) } }
            await #expect(throws: GuardError.self) { _ = try await m.phone.sync.resumeOutbox(m.family.groupId) }
            #expect(m.server.callBodies.count == sent)
            #expect(FileManager.default.fileExists(atPath: file.path))
            try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: file.path)
            #expect(Array(try await Self.quickly { try await m.phone.sync.resumeOutbox(m.family.groupId) }.values) == [.landed])
            #expect(Set(m.server.callBodies).count == 1)
        }

        /*
         * grants-due: the grants it names are posted, then the same bytes, which land. Fails if the
         * call is signed again after the grants, or the grants aren't posted.
         */
        @Test func grantsDuePostsTheGrantsThenTheSameBytes() async throws {
            let m = try await Self.managed()
            defer { m.phone.done() }
            let due = answering(409, ["code": "grants-due", "message": "Grants are due.",
                                      "data": ["missing": [["workspaceId": m.family.workspaceId, "userId": m.family.creator.userId]]]])
            m.server.lock.withLock { m.server.manage.admitAnswers = [due] }
            #expect(try await Self.quickly { try await m.phone.sync.letIn(m.summary, try await m.waitingGrace()) } == .landed)
            #expect(m.server.lock.withLock { m.server.manage.grantPosts.map(\.workspaceId) } == [m.family.workspaceId])
            let bodies = m.server.callBodies
            #expect(bodies.count == 2 && Set(bodies).count == 1, "the call was signed again after the grants")
        }

        /* Not-member while posting grants: a removal, published, the kept call gone. */
        @Test func notMemberWhilePostingGrantsIsARemoval() async throws {
            let m = try await Self.managed()
            defer { m.phone.done() }
            let due = answering(409, ["code": "grants-due", "message": "Grants are due.",
                                      "data": ["missing": [["workspaceId": m.family.workspaceId, "userId": m.family.creator.userId]]]])
            m.server.lock.withLock {
                m.server.manage.admitAnswers = [due]
                m.server.manage.grantsAnswer = (404, ["code": "not-member", "message": "You are not in this group."])
            }
            _ = m.phone.sync.releases.take()
            #expect(try await Self.quickly { try await m.phone.sync.letIn(m.summary, try await m.waitingGrace()) } == .wiped)
            #expect(m.server.lock.withLock { m.server.manage.grantPosts.count } == 1)
            #expect(m.phone.sync.releases.take().contains { $0.revised.state == .wiped })
            #expect(try m.kept.isEmpty)
        }

        /*
         * The plan is full: said in the web's words, nothing kept, and the one call went as this
         * app, which the server never buys a place for. Fails if the refusal is generic or kept.
         */
        @Test func aFullPlanIsSaidAndNothingIsBought() async throws {
            let m = try await Self.managed()
            defer { m.phone.done() }
            m.server.lock.withLock {
                m.server.manage.admitAnswers = [answering(402, ["code": "seats", "message": "Full.", "data": ["reason": "full"]])]
            }
            #expect(try await Self.quickly { try await m.phone.sync.letIn(m.summary, try await m.waitingGrace()) } == .refused("Every place in Lindqvist family is taken."))
            #expect(try m.kept.isEmpty)
            #expect(m.server.callClients.count == 1 && m.server.callClients[0].hasPrefix("ios/"))
        }

        /*
         * Every refusal of Let them in says its own words (the web's copy.ts, "Try again" for its
         * "Reload and try again"), none the generic retry; pool-full end to end. Fails if a code
         * falls through to words that don't say what happened.
         */
        @Test func everyAdmissionRefusalSaysItsOwnWords() async throws {
            func said(_ code: String?, _ data: [String: Any] = [:], status: Int = 409) -> String {
                ManageWords.call(CallAnswer(status: status, code: code, data: try? JSONSerialization.data(withJSONObject: data)), family: "Lindqvist family", first: "Grace")
            }
            let expected: [(String?, [String: Any], String)] = [
                ("invalid", [:], "Couldn’t save that change. Try again."),
                ("succession-due", [:], "A manager of Lindqvist family needs to finish an earlier change first. Try again."),
                ("left-due", [:], "Someone left the family. A manager needs to finish that before anyone can join or roles change."),
                ("members-changed", [:], "Lindqvist family changed while you were working on it. Try again."),
                ("stale", [:], "Lindqvist family changed while you were working on it. Try again."),
                ("busy", [:], "Another change to this plan is in progress. Try again in a moment."),
                ("seats", ["reason": "no-plan"], "Choose a plan for Lindqvist family before letting anyone in."),
                ("seats", ["reason": "payer"], "Every place in the plan for Lindqvist family is taken. Ask the person who pays for it to add a place."),
                ("seats", ["reason": "cap"], "The plan for Lindqvist family allows no more members."),
                ("seats", ["reason": "full"], "Every place in Lindqvist family is taken."),
                ("no-plan", [:], "Choose a plan for Lindqvist family first. Until it has one, nobody can be invited and no family folders can be made."),
                ("in-family", ["reason": "newcomer"], "They’ve joined another family since they accepted. They can join yours once they leave it."),
                ("pool-full", [:], "Their files don’t fit in the family’s free space. Free up space, then let them in."),
                ("unsupported", [:], "Update HushOS to do this."),
                ("forbidden", [:], "Only someone who manages the family can do that."),
                ("not-pending", [:], "Grace isn’t waiting to join any more."),
                ("held", [:], "Another manager paused your changes in this family for now."),
                ("rotating", [:], "A family folder was changing at the same time. Try again in a moment."),
                ("root-mid-rotation", [:], "A family folder is in the middle of a key change this server can’t account for. Contact the server’s operator."),
                ("area-moved", [:], "A family folder changed meanwhile. Try again."),
                ("no-seal", [:], ManageWords.noSeal),
                ("area-limit", ["limit": 5], "A family can have at most 5 shared folders on this server."),
                ("grants-due", [:], ManageWords.grantsDue),
                ("too-large", [:], "That change is too large for this server."),
                ("rate-limited", [:], "That’s been tried too often. Wait a little, then try again."),
            ]
            for (code, data, words) in expected { #expect(said(code, data) == words, "\(code ?? "none") said other words") }
            #expect(said(nil, status: 0) == GroupsAPIError.noAnswer)

            let m = try await Self.managed()
            defer { m.phone.done() }
            m.server.lock.withLock { m.server.manage.admitAnswers = [answering(409, ["code": "pool-full", "message": "No room."])] }
            #expect(try await Self.quickly { try await m.phone.sync.letIn(m.summary, try await m.waitingGrace()) } == .refused(ManageWords.poolFull))
            #expect(try m.kept.isEmpty)
        }

        /*
         * Someone waiting whose keys are there but don't read fails the whole list: never read as a
         * person without keys. Fails if a list is read in part.
         */
        @Test func aWaitingPersonWhoseKeysDontReadFailsTheList() async throws {
            let m = try await Self.managed()
            defer { m.phone.done() }
            m.server.lock.withLock {
                m.server.manage.pendingRows.append(["userId": UUID().uuidString.lowercased(), "name": "Ada", "email": "ada@example.com", "roles": [String](),
                                                    "identity": ["keyVersion": 1], "inFamily": false])
            }
            await #expect(throws: (any Error).self) { _ = try await m.phone.sync.waitingToJoin(m.family.groupId) }
        }

        /*
         * Route 12's rows as the server writes them (invitedBy is the inviter's user id, or null once
         * their account is gone) list, and a cancelled one leaves the list. Fails if an open
         * invitation turns the manager's page into an error.
         */
        @Test func openInvitationsListInTheServersShapeAndCancelRemovesThem() async throws {
            let m = try await Self.managed()
            defer { m.phone.done() }
            let inviter = UUID().uuidString.lowercased()
            let (first, second) = (UUID().uuidString.lowercased(), UUID().uuidString.lowercased())
            m.server.lock.withLock {
                m.server.manage.invitationRows = [
                    ["id": first, "email": "ada@example.com", "roles": [String](), "invitedBy": inviter, "expiresAt": "2026-11-09T10:00:00.000Z"],
                    ["id": second, "email": "bo@example.com", "roles": ["members"], "invitedBy": NSNull(), "expiresAt": "2026-11-10T10:00:00.000Z"],
                ]
            }
            let open = try await m.phone.sync.openInvitations(m.family.groupId)
            #expect(open.map(\.id) == [first, second])
            #expect(open.map(\.invitedBy) == [inviter, nil])
            try await m.phone.sync.cancelInvitation(m.family.groupId, invitationId: first)
            #expect(try await m.phone.sync.openInvitations(m.family.groupId).map(\.id) == [second])
        }

        /*
         * A session the server ended (401) from a list or an action is thrown as the lost session,
         * never said as a refusal. Fails if a 401 is swallowed into words.
         */
        @Test func aSessionTheServerEndedIsThrownFromListsAndActions() async throws {
            let m = try await Self.managed()
            defer { m.phone.done() }
            let person = try await m.waitingGrace()
            m.server.lock.withLock { m.server.unauthorized = true }
            func ended(_ body: () async throws -> Void) async -> Bool {
                do {
                    try await body()
                    return false
                } catch {
                    if case DriveAPIError.notAuthenticated = error { return true }
                    return false
                }
            }
            #expect(await ended { _ = try await m.phone.sync.waitingToJoin(m.family.groupId) })
            #expect(await ended { _ = try await m.phone.sync.openInvitations(m.family.groupId) })
            #expect(await ended { try await m.phone.sync.invite(m.family.groupId, email: "ada@example.com") })
            #expect(await ended { try await m.phone.sync.turnDown(m.family.groupId, userId: person.userId) })
            #expect(await ended { _ = try await Self.quickly { try await m.phone.sync.letIn(m.summary, person) } })
        }
    }
}

/*
 * The notices a manager's page says, and its lists' loads. Fails if a notice that must be read is
 * replaced or lost, or an older load's answer lands after a newer one.
 */
@Suite struct ManageNoticesTests {
    @Test func untilReadNoticesWaitTheirTurnAndComeBackAfterAPassingOne() {
        var queue = NoticeQueue()
        queue.untilRead("Grace isn’t waiting to join any more.")
        queue.untilRead("A change to Lindqvist family hadn’t reached the server and couldn’t be opened on this device. Make it again.")
        #expect(queue.shown?.text == "Grace isn’t waiting to join any more.")
        let passing = queue.passing("Invitation cancelled")
        #expect(queue.shown == passing)
        queue.expire(passing.id)
        #expect(queue.shown?.text == "Grace isn’t waiting to join any more.", "a notice to be read was lost behind a passing one")
        queue.dismiss()
        #expect(queue.shown?.text.hasPrefix("A change to Lindqvist family") == true, "the second notice to be read was lost")
        queue.dismiss()
        #expect(queue.shown == nil)
    }

    @Test func passingNoticesReplaceEachOtherAndAStaleExpiryChangesNothing() {
        var queue = NoticeQueue()
        let first = queue.passing("Invitation sent to ada@example.com")
        let second = queue.passing("Grace is in Lindqvist family")
        queue.expire(first.id)
        #expect(queue.shown == second, "a stale expiry took the notice shown now")
        queue.clear()
        #expect(queue.shown == nil)
        queue.dismiss()
        #expect(queue.shown == nil)
    }

    @Test func aListAnswerOfAnOlderLoadIsDropped() {
        var loads = ManagedLoads()
        let refresh = loads.begin("g")
        let cancelReload = loads.begin("g")
        #expect(!loads.admits("g", refresh), "an older load's answer landed after a newer one")
        #expect(loads.admits("g", cancelReload))
        let other = loads.begin("h")
        #expect(loads.admits("h", other) && loads.admits("g", cancelReload), "one family's load superseded another's")
    }
}

/* What a resume handed over, with how many calls were still kept as each was. */
private actor Heard {
    private(set) var ends: [(end: CallEnd, route: ChainRoute?, keptThen: Int)] = []
    func add(_ end: CallEnd, route: ChainRoute?, keptThen: Int) { ends.append((end, route, keptThen)) }
}
