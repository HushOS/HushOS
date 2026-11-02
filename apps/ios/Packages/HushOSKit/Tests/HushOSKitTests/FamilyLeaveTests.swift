import Foundation
import HushOSCore
import Testing
@testable import HushOSKit

/*
 * Leaving a family (docs/groups-mobile-plan.md iOS 4, route 20) against the stub server with real
 * rosters and the core's ledger. Each test fails on the defect it names.
 */
extension OnFakeDrive {
    @Suite struct FamilyLeaveTests {
        static var lapsed: [String: Any] { [
            "code": "ends-lapsed", "message": "Leaving ends a plan you pay for.",
            "data": ["plans": [["id": "sub_1", "name": "Family Pro (monthly)", "standing": "paused"]]],
        ] }

        /*
         * A leave that lands wipes what this phone held of the family: its keys, device record, rows
         * and opened copies, and publishes the wipe to the screens. The settings pin and the family
         * guard stay, so a family that comes back is never first use. Route 2 then asks nothing more
         * about it. Fails if a leave keeps keys or plaintext, or loses the pin or the guard.
         */
        @Test func leavingWipesKeysRecordAndCopiesAndKeepsThePinAndTheGuard() async throws {
            let family = try await onLargeStack { try FamilyFixture() }
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            _ = try await phone.vault.children(of: family.rootId)
            let folder = try #require(TemporaryCopies.openedFolder(itemId: family.fileId, version: "v1", familyWorkspace: family.workspaceId, in: phone.temporary))
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let copy = folder.appendingPathComponent("Recipes.txt")
            try Data("Pancakes".utf8).write(to: copy)
            let pin = try server.storedPin(family)
            #expect(pin != nil)
            #expect(try phone.held.family(family.groupId) != nil)
            _ = phone.sync.releases.take()

            guard case .left(let removed, let dissolved) = try await phone.sync.leave(family.groupId, endsLapsed: []) else { Issue.record("not left"); return }
            #expect(removed.state == .wiped)
            #expect(!dissolved)
            #expect(server.lock.withLock { server.rotations.leaves } == [[]], "the leave didn't send its (empty) list of plans")
            #expect(!phone.vault.areaLedger.isArea(workspaceId: family.workspaceId), "the family's keys stayed")
            #expect(await phone.vault.item(NodeRef(workspaceId: family.workspaceId, nodeId: family.fileId)) == nil, "the family's rows stayed")
            #expect(phone.records.read(userId: family.member.userId, groupId: family.groupId) == nil, "the device record stayed")
            #expect(!FileManager.default.fileExists(atPath: copy.path), "an opened copy stayed")
            #expect(try server.storedPin(family) == pin, "leaving changed the settings pin")
            #expect(try phone.held.family(family.groupId) != nil, "leaving deleted the family guard")
            let released = phone.sync.releases.take()
            #expect(released.contains { $0.groupId == family.groupId && $0.revised.state == .wiped }, "the leave's wipe wasn't published")

            server.clearRequests()
            let (listed, _, _) = try await phone.sync.listReconciling()
            #expect(listed.isEmpty)
            #expect(!server.requested("/api/groups/\(family.groupId)/rosters"), "route 2 asked again about a family this phone left")
        }

        /*
         * The server's refusals keep everything here and say the web's words: the organizer's and the
         * last manager's what to do first, a payer's the server's own words, anything else the
         * family's generic words. A leave that ends a plan names it, and the next press confirms it by
         * id and lands. Fails if a refusal wipes anything, or a plan is ended without its confirm.
         */
        @Test func refusalsKeepEverythingAndALapsedPlanIsConfirmedById() async throws {
            let family = try await onLargeStack { try FamilyFixture() }
            let server = family.server(chain: [family.r1, family.r2], pin: try family.pin(through: [family.r1, family.r2]))
            let phone = try await family.phone(server)
            defer { phone.done() }
            guard case .accepted = await phone.sync.sync(family.summary) else { Issue.record("not accepted"); return }
            let payer = "You pay for this family’s plan. Cancel it in Billing on the family’s page before you leave; the family keeps it until the end of the period."
            let cases: [(Int, [String: Any], String)] = [
                (409, ["code": "organizer", "message": "Hand the group’s billing to another member before you leave."], FamilyLeave.organizerFirst),
                (409, ["code": "last-holder", "message": "Let another member manage the group before you leave."], FamilyLeave.managerFirst),
                (409, ["code": "payer", "message": payer], payer),
                (409, ["code": "busy", "message": "Another change to this plan is in progress."], "HushOS couldn’t do that just now. Try again in a moment."),
            ]
            for (status, body, words) in cases {
                server.lock.withLock { server.rotations.leaveRefusal = (status, body) }
                guard case .refused(let said) = try await phone.sync.leave(family.groupId, endsLapsed: []) else { Issue.record("\(body["code"]!) wasn't refused"); continue }
                #expect(said == words)
                #expect(phone.vault.areaLedger.isArea(workspaceId: family.workspaceId), "a refused leave let go of the family's keys")
                #expect(phone.records.read(userId: family.member.userId, groupId: family.groupId) != nil, "a refused leave deleted the record")
            }

            server.lock.withLock { server.rotations.leaveRefusal = (409, Self.lapsed) }
            guard case .endsLapsed(let plans) = try await phone.sync.leave(family.groupId, endsLapsed: []) else { Issue.record("no plans named"); return }
            #expect(plans == [FamilyLapsedPlan(id: "sub_1", name: "Family Pro (monthly)", paused: true)])
            #expect(FamilyLapsedPlan.endsWhenYouLeave(family: "Lindqvist family", plans: plans)
                == "The Family Pro plan for Lindqvist family, which you pay for and which is paused, ends at once when you leave. Nothing of it is refunded: no part of it is in use.")
            #expect(phone.vault.areaLedger.isArea(workspaceId: family.workspaceId))
            server.lock.withLock { server.rotations.leaveRefusal = nil }
            guard case .left = try await phone.sync.leave(family.groupId, endsLapsed: plans.map(\.id)) else { Issue.record("the confirmed leave didn't land"); return }
            #expect(server.lock.withLock { server.rotations.leaves }.last == ["sub_1"], "the confirm didn't name the plan by its id")
        }

        /*
         * Leave family is offered unless the member list already shows the server would refuse it:
         * the only organizer or only manager can't, the last one in the family always can, and a
         * member who left counts for nothing. Fails if a refusal the list shows is offered anyway, or
         * a leave the server allows is held back.
         */
        @Test func leaveIsOfferedUnlessTheMemberListShowsItWouldBeRefused() {
            func member(_ id: String, _ roles: [String], state: String = "active") -> GroupDetail.Member {
                GroupDetail.Member(userId: id, name: id, email: nil, state: state, roles: roles)
            }
            #expect(FamilyLeave.blocker(userId: "me", members: [member("me", ["billing", "members"]), member("sam", [])]) == FamilyLeave.organizerFirst)
            #expect(FamilyLeave.blocker(userId: "me", members: [member("me", ["members"]), member("sam", [])]) == FamilyLeave.managerFirst)
            #expect(FamilyLeave.blocker(userId: "ME", members: [member("me", ["billing"]), member("sam", ["billing"])]) == nil)
            #expect(FamilyLeave.blocker(userId: "me", members: [member("me", ["billing", "members"])]) == nil, "the last one in the family was held back")
            #expect(FamilyLeave.blocker(userId: "me", members: [member("me", ["billing"]), member("sam", ["billing"], state: "left"), member("ana", [])])
                == FamilyLeave.organizerFirst,
                    "a member who left counted as the other organizer")
            #expect(FamilyLeave.blocker(userId: "me", members: [member("me", []), member("sam", ["billing", "members"])]) == nil)
        }

        /*
         * The leave dialog keeps its state (kept by the store, so a scene change keeps it): a second
         * press while a leave is in flight sends nothing; an ends-lapsed answer keeps the plans, and
         * the next press sends their ids; a refusal says why and lets it be pressed again. Fails if a
         * second press can send another leave, or the plans are lost before they're confirmed.
         */
        @Test func aSecondPressWhileALeaveIsInFlightSendsNothing() {
            let plans = [FamilyLapsedPlan(id: "sub_1", name: "Family Pro (monthly)", paused: true)]
            var dialog = LeaveDialog(groupId: "g")
            let first = dialog.confirm()
            #expect(first == [])
            #expect(dialog.busy)
            let second = dialog.confirm()
            #expect(second == nil, "a second press while the leave was in flight sent another")
            let afterPlans = dialog.answered(.endsLapsed(plans))
            #expect(!afterPlans)
            #expect(!dialog.busy && dialog.plans == plans)
            let confirming = dialog.confirm()
            #expect(confirming == ["sub_1"], "the confirm didn't send the plans it named")
            let afterRefusal = dialog.answered(.refused(FamilyLeave.organizerFirst))
            #expect(!afterRefusal)
            #expect(dialog.error == FamilyLeave.organizerFirst && !dialog.busy)
            let again = dialog.confirm()
            #expect(again != nil)
            #expect(dialog.error == nil)
            let left = dialog.answered(.left(FamilySync.Revised(state: .wiped, revision: 1), dissolved: false))
            #expect(left)
        }
    }
}
