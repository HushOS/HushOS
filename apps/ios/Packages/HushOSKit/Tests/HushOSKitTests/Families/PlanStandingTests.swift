import Foundation
import Testing
@testable import HushOSKit

/*
 * Which personal plan Account names (PlanStanding, the web's `planStanding`).
 * `/api/billing` keeps answering with the last plan after it ends, and with a
 * plan whose payment failed or that is paused: neither gives its storage, so
 * neither may read "Pro · Renews …". A server that records an unpaid plan as
 * ended must land on Free as well.
 */
@Suite struct PlanStandingTests {
    func billing(status: String, endedAt: String? = nil, name: String = "Pro") throws -> BillingSummary {
        let ended = endedAt.map { #""\#($0)""# } ?? "null"
        let body = #"{"enabled":true,"hasCustomer":true,"subscription":{"productName":"\#(name)","status":"\#(status)","recurringInterval":"month","quotaBytes":"214748364800","currentPeriodEnd":"2026-11-03T00:00:00.000Z","cancelAtPeriodEnd":false,"endedAt":\#(ended)},"intendedPlan":null,"family":null}"#
        return try JSONDecoder().decode(BillingSummary.self, from: Data(body.utf8))
    }

    func storage(pool: String = "null") throws -> StorageAllowance {
        let body = #"{"workspaceId":"w-1","quotaBytes":"5368709120","usedBytes":"1073741824","reservedBytes":"0","availableBytes":"4294967296","pool":\#(pool)}"#
        return try JSONDecoder().decode(StorageAllowance.self, from: Data(body.utf8))
    }

    @Test(arguments: ["active", "trialing", "past_due"])
    func aLivePlanIsTheCurrentPlan(status: String) throws {
        let plan = PlanDisplay(allowance: try storage(), billing: try billing(status: status))
        #expect(plan.name == "Pro")
        #expect(plan.subscription?.status == status)
        #expect(plan.lapsed == nil)
    }

    @Test(arguments: ["unpaid", "incomplete"])
    func aPlanWhosePaymentFailedReadsFreeAndSaysSo(status: String) throws {
        let plan = PlanDisplay(allowance: try storage(), billing: try billing(status: status))
        #expect(plan.name == "Free")
        #expect(plan.subscription == nil)
        #expect(plan.lapsed?.line == "Pro’s payment didn’t go through")
        #expect(plan.lapsed?.room == "Pro’s payment didn’t go through, so you have Free’s storage for now.")
    }

    @Test func aPausedPlanReadsFreeAndSaysSo() throws {
        let plan = PlanDisplay(allowance: try storage(), billing: try billing(status: "paused"))
        #expect(plan.name == "Free")
        #expect(plan.subscription == nil)
        #expect(plan.lapsed?.paused == true)
        #expect(plan.lapsed?.line == "Pro is paused")
        #expect(plan.lapsed?.room == "Pro is paused, so you have Free’s storage until it resumes.")
    }

    @Test func anEndedPlanIsFreeWhateverItsStatus() throws {
        // Today's server ends an unpaid plan with its status left as Polar sent it; a past one may
        // still say active. `canceled`, `incomplete_expired` or a status Polar adds later is Free too.
        let ended = [("active", "2026-10-01T00:00:00.000Z"), ("unpaid", "2026-10-01T00:00:00.000Z"), ("paused", "2026-10-01T00:00:00.000Z"), ("canceled", "2026-10-01T00:00:00.000Z"), ("canceled", nil), ("incomplete_expired", nil), ("frozen", nil)] as [(String, String?)]
        for (status, endedAt) in ended {
            let plan = PlanDisplay(allowance: try storage(), billing: try billing(status: status, endedAt: endedAt))
            #expect(plan.name == "Free", "\(status) \(endedAt ?? "not ended")")
            #expect(plan.subscription == nil, "\(status) \(endedAt ?? "not ended")")
            #expect(plan.lapsed == nil, "\(status) \(endedAt ?? "not ended")")
        }
    }

    @Test func theLapsedPlanIsNamedWithoutItsInterval() throws {
        let plan = PlanDisplay(allowance: try storage(), billing: try billing(status: "unpaid", name: "Pro (monthly)"))
        #expect(plan.lapsed?.line == "Pro’s payment didn’t go through")
    }

    @Test func aPooledMemberSeesNoLapsedPersonalPlan() throws {
        // The family's plan is what they draw from; their own unpaid plan says nothing on its card.
        let plan = PlanDisplay(allowance: try storage(pool: #"{"groupId":"g-1","name":"Lindqvist family"}"#), billing: try billing(status: "unpaid"))
        #expect(plan.source == "Shared with Lindqvist family")
        #expect(plan.lapsed == nil)
    }
}
