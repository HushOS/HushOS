import Foundation
import HushOSCore
import Testing
@testable import HushOSKit

/*
 * A manager's role changes and the organizer handover (docs/groups-mobile-plan.md iOS 5a part 2;
 * Android's FamilyRolesTest, #276) against the stub server with real rosters and the core's ledger.
 * The phone's account manages the family; for the handover it is the organizer, and Maya (the
 * family's creator) is the one billing is handed to. Each test fails on the defect it names.
 */
extension OnFakeDrive {
    @Suite struct FamilyRolesTests {
        typealias Managed = FamilyManageTests.Managed

        static func quickly<T>(_ body: () async throws -> T) async rethrows -> T { try await FamilyManageTests.quickly(body) }

        static let noAnswer = answering(503, ["code": "unavailable", "message": "HushOS is temporarily unavailable."])

        /* The phone's account is the organizer (billing moved to it by Maya at roster 4), synced at it. */
        static func organizer() async throws -> Managed {
            let m = try await FamilyManageTests.managed()
            try m.server.creatorSetsRoles([m.me.lowercased(): [.billing, .members], m.family.creator.userId.lowercased(): [.members]])
            guard case .accepted(let view) = await m.phone.sync.sync(m.summary) else { throw FamilyFailure(message: "not accepted") }
            #expect(view.rosterVersion == 4)
            return m
        }

        static func maya(_ m: Managed) -> FamilyMemberRef {
            FamilyMemberRef(userId: m.family.creator.userId, email: "maya@example.com", name: "Maya Lindqvist")
        }

        /* Maya checked on this phone (They match over the words both screens show): a verified pin of her. */
        static func checkMaya(_ m: Managed) async throws {
            guard case .code(let version, let words, _) = try await m.phone.sync.checkCode(m.summary, with: m.family.creator.userId).code else {
                throw FamilyFailure(message: "no words")
            }
            let saved = try await m.phone.sync.checkMatch(m.family.groupId, member: maya(m), rosterVersion: version, code: words)
            #expect(saved.verified)
        }

        /* `row` let in (a plain member) and checked on this phone: a verified pin of them, as a promotion needs. */
        static func letInAndCheck(_ m: Managed, _ row: PendingPerson, email: String) async throws {
            #expect(try await Self.quickly { try await m.phone.sync.letIn(m.summary, row) } == .landed)
            guard case .code(let version, let words, _) = try await m.phone.sync.checkCode(m.summary, with: row.userId).code else {
                throw FamilyFailure(message: "no words")
            }
            let ref = FamilyMemberRef(userId: row.userId, email: email, name: row.name)
            #expect(try await m.phone.sync.checkMatch(m.family.groupId, member: ref, rosterVersion: version, code: words).verified)
        }

        static func roles(_ m: Managed, _ userId: String) async throws -> [String] {
            guard case .accepted(let view) = await m.phone.sync.sync(m.summary) else { throw FamilyFailure(message: "not accepted") }
            return try #require(view.members.first { $0.userId.lowercased() == userId.lowercased() }).roles
        }

        static func handover(_ m: Managed) throws -> FamilyRecords.KeptHandover? { try m.phone.records.handover(userId: m.me, groupId: m.family.groupId) }

        /*
         * Make them the organizer over a pin nobody checked: a check is asked for and nothing is signed
         * or sent, nor any handover kept. Fails if billing is handed to keys nobody checked.
         */
        @Test func aHandoverOverAnUncheckedPinAsksForACheckFirst() async throws {
            let m = try await Self.organizer()
            defer { m.phone.done() }
            let calls = m.server.callBodies.count
            #expect(try await Self.quickly { try await m.phone.sync.handOver(m.summary, to: m.family.creator.userId, first: "Maya") } == .checkFirst)
            #expect(m.server.callBodies.count == calls, "a call was sent over an unchecked pin")
            #expect(try Self.handover(m) == nil)
            #expect(try m.kept.isEmpty)
        }

        /*
         * The handover: billing to Maya, then let go of here, in that order, and its record gone.
         * Fails if this account lets go first (a family with no organizer), or keeps billing.
         */
        @Test func theHandoverGivesBillingThenLetsGoOfIt() async throws {
            let m = try await Self.organizer()
            defer { m.phone.done() }
            try await Self.checkMaya(m)
            #expect(try await Self.quickly { try await m.phone.sync.handOver(m.summary, to: m.family.creator.userId, first: "Maya") } == .landed)
            #expect(m.server.lock.withLock { m.server.manage.memberCalls } == [m.family.creator.userId.lowercased(), m.me.lowercased()])
            #expect(try await Self.roles(m, m.family.creator.userId).contains("billing"))
            #expect(try await !Self.roles(m, m.me).contains("billing"))
            #expect(try Self.handover(m) == nil)
            #expect(try m.kept.isEmpty)
        }

        /*
         * Billing lands with Maya, then the step down gets no answer and the app is stopped. The next
         * open (a relaunch, the same records) sends the kept step down and lets go of the handover.
         * Fails if a handover stopped between its two calls leaves two organizers for good.
         */
        @Test func aHandoverStoppedBetweenItsCallsIsFinishedAtTheNextOpen() async throws {
            let m = try await Self.organizer()
            try await Self.checkMaya(m)
            m.server.lock.withLock { m.server.manage.memberAnswers = [{ _ in nil }, Self.noAnswer, Self.noAnswer, Self.noAnswer] }
            guard case .pending = try await Self.quickly({ try await m.phone.sync.handOver(m.summary, to: m.family.creator.userId, first: "Maya") }) else {
                Issue.record("not kept for the next open")
                return
            }
            #expect(try Self.handover(m) == FamilyRecords.KeptHandover(to: m.family.creator.userId.lowercased(), staged: true))
            m.phone.done()
            let later = try await m.family.phone(m.server, records: m.phone.records)
            defer { later.done() }
            let next = Managed(family: m.family, server: m.server, phone: later, grace: m.grace)
            _ = await later.sync.sync(m.summary)
            _ = try await Self.quickly { try await later.sync.resumeOutbox(m.family.groupId, names: [m.family.creator.userId.lowercased(): "Maya"]) }
            #expect(try await !Self.roles(next, m.me).contains("billing"), "this account still holds billing")
            #expect(try await Self.roles(next, m.family.creator.userId).contains("billing"))
            #expect(try Self.handover(next) == nil)
        }

        /*
         * Codex #285, 1: a handover left half done (both hold billing, its record kept, nothing in the
         * outbox) is finished by the next open, and whoever hears how it ended syncs the family right
         * away, as the page does. That sync waits for the family's turn: it is told only once the
         * resume let go of it, so the resume ends. Fails (times out) if `handed` is heard inside the
         * family's turn, which the sync then waits on for ever.
         */
        @Test func aResumedHandoverIsToldOutsideTheFamilysTurn() async throws {
            let m = try await Self.organizer()
            defer { m.phone.done() }
            try m.server.creatorSetsRoles([m.family.creator.userId.lowercased(): [.billing, .members]])
            _ = await m.phone.sync.sync(m.summary)
            try m.phone.records.markHandover(userId: m.me, groupId: m.family.groupId, to: m.family.creator.userId, staged: true)
            let (sync, summary, groupId) = (m.phone.sync, m.summary, m.family.groupId)
            let heard = HandedEnds()
            // Not a task group: a child stuck on the family's turn can't be cancelled, and the group would wait on it.
            let resume = await Self.quickly {
                Task {
                    let out = try await sync.resumeOutbox(groupId, handed: { _, end in
                        // As the page does: the family read again at once.
                        _ = await sync.sync(summary)
                        await heard.add(end)
                    })
                    await heard.finish()
                    return out
                }
            }
            let deadline = ContinuousClock.now + .seconds(30)
            while await !heard.finished, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(50)) }
            guard await heard.finished else {
                // Nothing below may touch the family: its turn is still held by the stuck resume.
                resume.cancel()
                Issue.record("the resume never ended: the family's sync waited on its turn")
                return
            }
            _ = try await resume.value
            #expect(await heard.ends == [.landed])
            #expect(try await !Self.roles(m, m.me).contains("billing"))
            #expect(try Self.handover(m) == nil)
        }

        /*
         * Codex #285 round 3: Make them the organizer is kept unanswered for Maya (billing to her),
         * then Stop them managing is asked for her. Both are on her `member` route, but they are
         * different changes: the kept one is sent first and still unanswered, so the new one waits,
         * said so, and nothing new is kept; Make them the organizer pressed again is the kept one's,
         * still saved on this device. Fails if a different kept change is said as this one's (Saved
         * on this device, nothing kept for it), or the same change pressed again is refused as another's.
         */
        @Test func aDifferentKeptChangeForThemMakesThisOneWait() async throws {
            let m = try await Self.organizer()
            defer { m.phone.done() }
            try await Self.checkMaya(m)
            let maya = m.family.creator.userId
            m.server.lock.withLock { m.server.manage.memberAnswers = Array(repeating: Self.noAnswer, count: 12) }
            guard case .pending = try await Self.quickly({ try await m.phone.sync.handOver(m.summary, to: maya, first: "Maya") }) else {
                Issue.record("the handover wasn't kept"); return
            }
            let kept = try m.kept
            #expect(kept.count == 1)
            let end = try await Self.quickly { try await m.phone.sync.changeRole(m.summary, userId: maya, first: "Maya", change: .take) }
            #expect(end == .waiting(ManageWords.earlierWaiting("Lindqvist family")), "another kept change for Maya was said as this one's")
            #expect(try m.kept.map(\.entry) == kept.map(\.entry), "something new was kept over the handover")
            guard case .pending = try await Self.quickly({ try await m.phone.sync.handOver(m.summary, to: maya, first: "Maya") }) else {
                Issue.record("the same change pressed again wasn't the kept one's"); return
            }
            #expect(try m.kept.map(\.entry) == kept.map(\.entry))
            #expect(Set(m.server.callBodies).count == 1, "something other than the kept handover was sent")
        }

        /*
         * Android's aHandoverBlockedBehindAnEarlierChangeGoesOnOnceThatLands: a Let them manage for
         * Grace (let in, her words checked) still unanswered when she is made the organizer. The handover can't be staged yet,
         * so its record is kept, unstaged, and said as saved; once the earlier change lands, the next
         * open stages the handover and finishes it. Fails if a handover blocked behind an earlier
         * change for the same person is dropped as though it had been refused.
         */
        @Test func aHandoverBlockedBehindAnEarlierChangeForThemGoesOnOnceThatLands() async throws {
            let m = try await Self.organizer()
            defer { m.phone.done() }
            try await Self.letInAndCheck(m, try await m.waitingGrace(), email: FamilyManageTests.graceEmail)
            let grace = m.grace.userId.lowercased()
            m.server.lock.withLock { m.server.manage.memberAnswers = Array(repeating: Self.noAnswer, count: 9) }
            let granted = try await Self.quickly { try await m.phone.sync.changeRole(m.summary, userId: grace, first: "Grace", change: .grant) }
            guard case .pending = granted else { Issue.record("the grant wasn't kept: \(granted)"); return }
            // The same change pressed again is the kept one's: still saved on this device.
            guard case .pending = try await Self.quickly({ try await m.phone.sync.changeRole(m.summary, userId: grace, first: "Grace", change: .grant) }) else {
                Issue.record("the same change pressed again wasn't the kept one's"); return
            }
            guard case .pending = try await Self.quickly({ try await m.phone.sync.handOver(m.summary, to: grace, first: "Grace") }) else {
                Issue.record("the blocked handover wasn't kept"); return
            }
            #expect(try Self.handover(m) == FamilyRecords.KeptHandover(to: grace, staged: false), "the blocked handover's record went")
            let (sync, groupId) = (m.phone.sync, m.family.groupId)
            let heard = HandedEnds()
            _ = try await Self.quickly { try await sync.resumeOutbox(groupId, names: [grace: "Grace"], handed: { _, end in await heard.add(end) }) }
            #expect(await heard.ends == [.landed])
            #expect(Set(try await Self.roles(m, grace)) == ["billing", "members"])
            #expect(try await !Self.roles(m, m.me).contains("billing"))
            #expect(try Self.handover(m) == nil)
        }

        /*
         * Codex #286: a grant kept by a build that noted no operation (an entry from before operations
         * were noted). Let them manage pressed again sends it, it lands, and the member list then
         * already says what was asked: said as made. Fails if a kept change of no known operation that
         * lands leaves the request refused as changing nothing.
         */
        @Test func aKeptChangeWithNoOperationThatLandsSatisfiesTheRequest() async throws {
            let m = try await Self.organizer()
            defer { m.phone.done() }
            try await Self.letInAndCheck(m, try await m.waitingGrace(), email: FamilyManageTests.graceEmail)
            let grace = m.grace.userId.lowercased()
            let before = m.server.callBodies.count
            m.server.lock.withLock { m.server.manage.memberAnswers = Array(repeating: Self.noAnswer, count: 3) }
            guard case .pending = try await Self.quickly({ try await m.phone.sync.changeRole(m.summary, userId: grace, first: "Grace", change: .grant) }) else {
                Issue.record("the grant wasn't kept"); return
            }
            // As an earlier build kept it: no operation beside the entry.
            let outbox = m.phone.records.folder.appendingPathComponent("outbox", isDirectory: true)
            let note = try #require(try FileManager.default.contentsOfDirectory(at: outbox, includingPropertiesForKeys: nil).first { $0.pathExtension == "op" })
            try FileManager.default.removeItem(at: note)
            #expect(try await Self.quickly { try await m.phone.sync.changeRole(m.summary, userId: grace, first: "Grace", change: .grant) } == .landed)
            #expect(try await Self.roles(m, grace).contains("members"))
            #expect(try m.kept.isEmpty)
            #expect(Set(m.server.callBodies.dropFirst(before)).count == 1, "the kept grant was signed again")
        }

        /*
         * Codex #285 round 5: Grace's grant is kept unanswered, then the settings can't be read when
         * Ada's grant is asked for. The same operation, but not the same person: Ada's is never said
         * as saved on this device; it waits behind Grace's, nothing kept for it. Fails if a kept call's
         * failure is reported as another person's request kept.
         */
        @Test func anotherPersonsKeptChangeIsNeverThisOnesPending() async throws {
            let m = try await Self.organizer()
            defer { m.phone.done() }
            try await Self.letInAndCheck(m, try await m.waitingGrace(), email: FamilyManageTests.graceEmail)
            let ada = try await onLargeStack { try FamilyPerson() }
            m.server.waiting(ada, email: "ada@example.com", name: "Ada Lindqvist")
            let adaRow = try #require(try await m.phone.sync.waitingToJoin(m.family.groupId).first { $0.userId == ada.userId.lowercased() })
            try await Self.letInAndCheck(m, adaRow, email: "ada@example.com")
            m.server.lock.withLock { m.server.manage.memberAnswers = Array(repeating: Self.noAnswer, count: 3) }
            guard case .pending = try await Self.quickly({ try await m.phone.sync.changeRole(m.summary, userId: m.grace.userId, first: "Grace", change: .grant) }) else {
                Issue.record("Grace's grant wasn't kept"); return
            }
            let kept = try m.kept
            m.server.lock.withLock { m.server.manage.failSettingsReads = true }
            let end = try await Self.quickly { try await m.phone.sync.changeRole(m.summary, userId: ada.userId, first: "Ada", change: .grant) }
            #expect(end == .waiting(ManageWords.earlierWaiting("Lindqvist family")), "Grace's kept grant was said as Ada's")
            #expect(try m.kept.map(\.entry) == kept.map(\.entry))
        }

        /*
         * Codex #285 round 6: Make them the organizer kept unanswered for Maya, then Stop them managing
         * is asked for her: the kept billing call is sent first and lands, and from then on the
         * settings can't be read. The landed call is settled; it is never sent again as this one's,
         * so the stop is never said as saved on this device with nothing of it kept. Fails if a
         * deleted entry's call is taken up again after it settled.
         */
        @Test func aSettledDifferentKeptChangeIsNeverTakenUpAgain() async throws {
            let m = try await Self.organizer()
            defer { m.phone.done() }
            try await Self.checkMaya(m)
            let maya = m.family.creator.userId
            m.server.lock.withLock { m.server.manage.memberAnswers = Array(repeating: Self.noAnswer, count: 3) }
            guard case .pending = try await Self.quickly({ try await m.phone.sync.handOver(m.summary, to: maya, first: "Maya") }) else {
                Issue.record("the handover wasn't kept"); return
            }
            let server = m.server
            server.lock.withLock {
                server.manage.beforeAnswer = { method, _ in
                    // The kept billing call goes out and lands; every settings read after it fails.
                    if method == "PATCH" { server.lock.withLock { server.manage.failSettingsReads = true } }
                }
            }
            let end = try? await Self.quickly { try await m.phone.sync.changeRole(m.summary, userId: maya, first: "Maya", change: .take) }
            server.lock.withLock { server.manage.beforeAnswer = nil; server.manage.failSettingsReads = false }
            let saidSaved: Bool = { if case .pending? = end { return true }; return false }()
            #expect(try !saidSaved || !m.kept.isEmpty, "the stop was said saved on this device with nothing of it kept")
            #expect(try await Self.roles(m, maya).contains("billing"), "the kept billing call didn't land")
        }

        /*
         * Codex #285 round 6 (billing): Make them the organizer kept unanswered (its record staged),
         * confirmed again for the same person while still unanswered: the record stays staged. Then
         * the kept billing call is refused; the next open takes that as the handover's end and signs
         * no fresh billing change. Fails if confirming again resets the record to unstaged, so a
         * definite refusal is followed by a new billing call.
         */
        @Test func confirmingTheSameHandoverAgainKeepsItStaged() async throws {
            let m = try await Self.organizer()
            defer { m.phone.done() }
            try await Self.checkMaya(m)
            let maya = m.family.creator.userId.lowercased()
            m.server.lock.withLock { m.server.manage.memberAnswers = Array(repeating: Self.noAnswer, count: 6) }
            guard case .pending = try await Self.quickly({ try await m.phone.sync.handOver(m.summary, to: maya, first: "Maya") }) else {
                Issue.record("the handover wasn't kept"); return
            }
            #expect(try Self.handover(m) == FamilyRecords.KeptHandover(to: maya, staged: true))
            guard case .pending = try await Self.quickly({ try await m.phone.sync.handOver(m.summary, to: maya, first: "Maya") }) else {
                Issue.record("the second confirm wasn't the kept one's"); return
            }
            #expect(try Self.handover(m) == FamilyRecords.KeptHandover(to: maya, staged: true), "confirming again reset the handover to unstaged")
            let billing = Set(m.server.callBodies)
            m.server.lock.withLock { m.server.manage.memberAnswers = [answering(409, ["code": "held", "message": "Paused."])] }
            _ = try await Self.quickly { try await m.phone.sync.resumeOutbox(m.family.groupId, names: [maya: "Maya"]) }
            #expect(Set(m.server.callBodies) == billing, "a fresh billing change was signed after the kept one was refused")
            #expect(try Self.handover(m) == nil)
            #expect(try await !Self.roles(m, maya).contains("billing"))
        }

        /*
         * Codex #285 round 7 (billing): Make them the organizer whose settings read throws as it is
         * staged (after the sync and the head read, before anything is signed). The screen says it
         * couldn't change that, and the record this attempt made goes with it, so the next open hands
         * nothing over. A staged handover confirmed again over the same failure stays as it was.
         * Fails if a failed attempt leaves an unstaged record that the next open then finishes,
         * making someone the organizer nobody confirmed.
         */
        @Test func aHandoverThatFailsBeforeStagingLeavesNoRecord() async throws {
            let m = try await Self.organizer()
            defer { m.phone.done() }
            try await Self.checkMaya(m)
            let maya = m.family.creator.userId.lowercased()
            let server = m.server
            // The second read of route 3 in a press is the staging's head read: every settings read after it fails.
            func failAfterTheHeadRead() {
                let reads = Calls()
                server.lock.withLock {
                    server.manage.beforeAnswer = { method, path in
                        guard method == "GET", path == "/api/groups/\(server.family.groupId)" else { return }
                        reads.append(true)
                        if reads.values.count == 2 { server.lock.withLock { server.manage.failSettingsReads = true } }
                    }
                }
            }
            func heal() { server.lock.withLock { server.manage.beforeAnswer = nil; server.manage.failSettingsReads = false } }
            failAfterTheHeadRead()
            var failed = false
            do { _ = try await Self.quickly { try await m.phone.sync.handOver(m.summary, to: maya, first: "Maya") } } catch { failed = true }
            heal()
            guard failed else { Issue.record("the handover didn't fail before staging"); return }
            #expect(try Self.handover(m) == nil, "a failed handover left its record")
            #expect(m.server.lock.withLock { m.server.manage.memberCalls }.isEmpty)
            _ = try await Self.quickly { try await m.phone.sync.resumeOutbox(m.family.groupId, names: [maya: "Maya"]) }
            #expect(m.server.lock.withLock { m.server.manage.memberCalls }.isEmpty, "the next open handed over a handover nobody confirmed")
            #expect(try await !Self.roles(m, maya).contains("billing"))
            // One already kept, confirmed again over the same failure: left as it was.
            m.server.lock.withLock { m.server.manage.memberAnswers = Array(repeating: Self.noAnswer, count: 3) }
            guard case .pending = try await Self.quickly({ try await m.phone.sync.handOver(m.summary, to: maya, first: "Maya") }) else {
                Issue.record("the handover wasn't kept"); return
            }
            failAfterTheHeadRead()
            _ = try? await Self.quickly { try await m.phone.sync.handOver(m.summary, to: maya, first: "Maya") }
            heal()
            #expect(try Self.handover(m) == FamilyRecords.KeptHandover(to: maya, staged: true))
        }

        /* Make them the organizer whose staged marker can't be written (a full disk) once billing's call is kept: it fails. */
        static func handOverWithTheMarkerUnwritable(_ m: Managed) async throws {
            let failed: Bool = await FamilyRecords.$markFault.withValue({ staged in if staged { throw GuardError.unsaved } }) {
                do { _ = try await Self.quickly { try await m.phone.sync.handOver(m.summary, to: m.family.creator.userId, first: "Maya") }; return false } catch { return true }
            }
            #expect(failed, "the handover didn't fail on its marker")
            #expect(try m.kept.count == 1, "billing's call wasn't kept")
            #expect(m.server.lock.withLock { m.server.manage.memberCalls }.isEmpty, "something was sent")
        }

        /*
         * Codex #287 / #285 round 8 (billing): billing's call is kept, then its staged marker can't be
         * written. The handover isn't dropped, since its billing call is on the device: the next open
         * sends it, it lands, and the handover finishes with one organizer. Fails if a failed marker
         * drops the record while its billing call stays kept, leaving two organizers once that lands.
         */
        @Test func aHandoverWhoseMarkerFailsAfterBillingWasKeptStillFinishes() async throws {
            let m = try await Self.organizer()
            defer { m.phone.done() }
            try await Self.checkMaya(m)
            let maya = m.family.creator.userId.lowercased()
            try await Self.handOverWithTheMarkerUnwritable(m)
            #expect(try Self.handover(m)?.to == maya, "the handover was dropped though its billing call is kept")
            _ = try await Self.quickly { try await m.phone.sync.resumeOutbox(m.family.groupId, names: [maya: "Maya"]) }
            #expect(try await Self.roles(m, maya).contains("billing"))
            #expect(try await !Self.roles(m, m.me).contains("billing"), "two organizers")
            #expect(try Self.handover(m) == nil)
        }

        /*
         * The same, but the kept billing call is refused at the next open: its end marks the handover
         * staged before the entry goes, so the handover ends there and no fresh billing change is
         * signed. Fails if a handover whose marker failed is taken for one never staged, and billing
         * signed again after a definite refusal.
         */
        @Test func aHandoverWhoseMarkerFailsIsNeverSignedAgainAfterARefusal() async throws {
            let m = try await Self.organizer()
            defer { m.phone.done() }
            try await Self.checkMaya(m)
            let maya = m.family.creator.userId.lowercased()
            try await Self.handOverWithTheMarkerUnwritable(m)
            m.server.lock.withLock { m.server.manage.memberAnswers = [answering(409, ["code": "held", "message": "Paused."])] }
            _ = try await Self.quickly { try await m.phone.sync.resumeOutbox(m.family.groupId, names: [maya: "Maya"]) }
            #expect(m.server.lock.withLock { m.server.manage.memberCalls }.count == 1, "billing was signed again after the refusal")
            #expect(try Self.handover(m) == nil)
            #expect(try await !Self.roles(m, maya).contains("billing"))
        }

        /*
         * Codex #285 round 8 (billing): billing lands with Maya and the step down gets no answer
         * (kept). The next open sends it and it is refused for good: the handover ends there, both
         * stay organizers, and nothing signs another step down; Finish handing over is the person's
         * to press. Fails if a resumed handover whose step down was refused is finished anyway.
         */
        @Test func aRefusedResumedStepDownEndsTheHandover() async throws {
            let m = try await Self.organizer()
            defer { m.phone.done() }
            try await Self.checkMaya(m)
            let maya = m.family.creator.userId.lowercased()
            m.server.lock.withLock { m.server.manage.memberAnswers = [{ _ in nil }, Self.noAnswer, Self.noAnswer, Self.noAnswer] }
            guard case .pending = try await Self.quickly({ try await m.phone.sync.handOver(m.summary, to: maya, first: "Maya") }) else {
                Issue.record("the step down wasn't kept"); return
            }
            #expect(try Self.handover(m) == FamilyRecords.KeptHandover(to: maya, staged: true))
            let calls = m.server.lock.withLock { m.server.manage.memberCalls }.count
            m.server.lock.withLock { m.server.manage.memberAnswers = [answering(409, ["code": "held", "message": "Paused."])] }
            _ = try await Self.quickly { try await m.phone.sync.resumeOutbox(m.family.groupId, names: [maya: "Maya"]) }
            #expect(m.server.lock.withLock { m.server.manage.memberCalls }.count == calls + 1, "another step down was signed after the refusal")
            #expect(try Self.handover(m) == nil)
            #expect(try await Self.roles(m, maya).contains("billing"))
            #expect(try await Self.roles(m, m.me).contains("billing"), "the handover was finished after its refusal")
        }

        /*
         * Billing moved to someone else meanwhile (another device): this account no longer holds it,
         * so it isn't this account's to give. Nothing is signed or sent. Fails if a former organizer
         * hands billing over.
         */
        @Test func aHandoverBySomeoneWhoIsNoLongerTheOrganizerIsRefused() async throws {
            let m = try await Self.organizer()
            defer { m.phone.done() }
            try await Self.checkMaya(m)
            // Maya takes billing back on her device after this phone last synced.
            try m.server.creatorSetsRoles([m.me.lowercased(): [.members], m.family.creator.userId.lowercased(): [.billing, .members]])
            let calls = m.server.callBodies.count
            let end = try await Self.quickly { try await m.phone.sync.handOver(m.summary, to: m.family.creator.userId, first: "Maya",
                                                                              names: [m.family.creator.userId.lowercased(): "Maya"]) }
            #expect(end == .refused("Maya is the organizer now."))
            #expect(m.server.callBodies.count == calls)
            #expect(try Self.handover(m) == nil)
        }

        /*
         * Both this account and Maya hold billing (a handover left half done), then Maya lets go of it
         * on her device. Finish handing over to Maya would leave the family with no organizer: the step
         * down is only for the person billing was handed to, so it is refused and nothing is sent.
         * Fails if this account lets go of billing nobody else holds.
         */
        @Test func theStepDownIsOnlyForWhomItWasHandedTo() async throws {
            let m = try await Self.organizer()
            defer { m.phone.done() }
            try m.server.creatorSetsRoles([m.family.creator.userId.lowercased(): [.billing, .members]])
            guard case .accepted(let view) = await m.phone.sync.sync(m.summary) else { Issue.record("not accepted"); return }
            #expect(FamilySync.handoverToFinish(view, me: m.me) == m.family.creator.userId.lowercased())
            try m.server.creatorSetsRoles([m.family.creator.userId.lowercased(): [.members]])
            let calls = m.server.callBodies.count
            let end = try await Self.quickly { try await m.phone.sync.finishHandingOver(m.summary, to: m.family.creator.userId, first: "Maya") }
            #expect(end == .refused(ManageWords.organizerFirst))
            #expect(m.server.callBodies.count == calls)
            #expect(try await Self.roles(m, m.me).contains("billing"))
        }

        /*
         * The gate: Grace's Let them in is kept unanswered, so nothing new is staged over it, a handover
         * included: it waits, nothing is signed, and Grace's call is left as it was. Fails if a roster
         * call is staged over a kept one (the kept one would be dropped as superseded, unseen).
         */
        @Test func nothingIsStagedOverAKeptCall() async throws {
            let m = try await Self.organizer()
            defer { m.phone.done() }
            try await Self.checkMaya(m)
            m.server.lock.withLock { m.server.manage.admitAnswers = Array(repeating: Self.noAnswer, count: 6) }
            _ = try await Self.quickly { try await m.phone.sync.letIn(m.summary, try await m.waitingGrace()) }
            let graceKept = try m.kept
            #expect(graceKept.count == 1)
            let calls = m.server.lock.withLock { m.server.manage.memberCalls.count }
            let end = try await Self.quickly { try await m.phone.sync.handOver(m.summary, to: m.family.creator.userId, first: "Maya") }
            #expect(end == .waiting(ManageWords.earlierWaiting("Lindqvist family")))
            #expect(m.server.lock.withLock { m.server.manage.memberCalls.count } == calls, "a role change was staged over a kept call")
            #expect(try m.kept.map(\.entry) == graceKept.map(\.entry))
        }

        /*
         * The family can't be read (route 5 answers 503) while a handover is kept: nothing is signed,
         * the handover isn't taken as done, and its record stays for the next open. Fails if a failed
         * sync reads as a landing or as nobody holding billing.
         */
        @Test func aSyncThatFailsIsNeitherALandingNorAnAbsence() async throws {
            let m = try await Self.organizer()
            defer { m.phone.done() }
            try await Self.checkMaya(m)
            try m.phone.records.markHandover(userId: m.me, groupId: m.family.groupId, to: m.family.creator.userId, staged: true)
            m.server.lock.withLock { m.server.rostersFail = true }
            let calls = m.server.callBodies.count
            _ = try await Self.quickly { try await m.phone.sync.resumeOutbox(m.family.groupId) }
            #expect(try Self.handover(m) != nil, "a failed sync let go of the handover")
            let end = try await Self.quickly { try await m.phone.sync.changeRole(m.summary, userId: m.family.creator.userId, first: "Maya", change: .take) }
            #expect(end != .landed)
            #expect(m.server.callBodies.count == calls, "a call was signed over a family that couldn't be read")
        }
    }
}

/* What a resume's `handed` heard, in order. */
private actor HandedEnds {
    var ends: [RoleEnd] = []
    var finished = false
    func add(_ end: RoleEnd) { ends.append(end) }
    func finish() { finished = true }
}
