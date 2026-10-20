import Foundation
import Testing
@testable import HushOSKit

/*
 * Where a family member's storage comes from (docs/families-shared-pool.md 9,
 * 6.1). While `/api/auth/storage` names a pool, Account must say the storage is
 * the family's and stop naming a personal plan the person no longer draws
 * from. An older server, a server without billing, or a `pool` this build
 * can't read must leave today's card exactly as it was, figures included:
 * a strict decoder would blank the whole card over one field.
 */
@Suite struct StoragePoolTests {
    let pro = #"{"productName":"Pro","status":"active","recurringInterval":"month","quotaBytes":"214748364800","currentPeriodEnd":"2026-11-03T00:00:00.000Z","cancelAtPeriodEnd":false}"#

    func storage(pool: String?) throws -> StorageAllowance {
        let field = pool.map { #","pool":\#($0)"# } ?? ""
        let body = #"{"workspaceId":"w-1","quotaBytes":"858993459200","usedBytes":"335007449088","reservedBytes":"0","availableBytes":"523986010112"\#(field)}"#
        return try JSONDecoder().decode(StorageAllowance.self, from: Data(body.utf8))
    }

    func billing(family: String?) throws -> BillingSummary {
        let field = family.map { #","family":\#($0)"# } ?? ""
        let body = #"{"enabled":true,"hasCustomer":true,"subscription":\#(pro),"intendedPlan":null\#(field)}"#
        return try JSONDecoder().decode(BillingSummary.self, from: Data(body.utf8))
    }

    @Test func aPooledMemberSeesTheFamilysPlanAndNotTheirOwn() throws {
        let allowance = try storage(pool: #"{"groupId":"8f0c2a4e-1b3d-4c5e-9f60-718293a4b5c6","name":"Lindqvist family"}"#)
        #expect(allowance.pool?.groupId == "8f0c2a4e-1b3d-4c5e-9f60-718293a4b5c6")
        #expect(allowance.pool?.name == "Lindqvist family")
        #expect(allowance.quota == 858_993_459_200)

        // A personal plan billing hasn't ended yet still comes back beside the family: it must not show.
        let plan = PlanDisplay(allowance: allowance, billing: try billing(family: #"{"name":"Lindqvist family","planName":"Family Plus"}"#))
        #expect(plan.name == "Family Plus")
        #expect(plan.source == "From Lindqvist family’s plan")
        #expect(plan.family == "Lindqvist family")
        #expect(plan.subscription == nil)

        // Billing unanswered, or a family plan with no name: still the family's, never Pro.
        for summary in [nil, try billing(family: #"{"name":"Lindqvist family","planName":null}"#)] {
            let plan = PlanDisplay(allowance: allowance, billing: summary)
            #expect(plan.name == "Family plan")
            #expect(plan.source == "From Lindqvist family’s plan")
            #expect(plan.subscription == nil)
        }

        // Storage unanswered: billing's family keeps the personal plan off the card.
        let unread = PlanDisplay(allowance: nil, billing: try billing(family: #"{"name":"Lindqvist family","planName":"Family Plus"}"#))
        #expect(unread.source == "From Lindqvist family’s plan")
        #expect(unread.subscription == nil)
    }

    @Test func withoutAPoolTheCardIsTodays() throws {
        // An older server sends neither field; a current one sends null for someone in no family.
        for (pool, family) in [(nil, nil), ("null", "null")] as [(String?, String?)] {
            let allowance = try storage(pool: pool)
            #expect(allowance.pool == nil)
            #expect(allowance.used == 335_007_449_088)
            let summary = try billing(family: family)
            #expect(summary.family == nil)
            let plan = PlanDisplay(allowance: allowance, billing: summary)
            #expect(plan.name == "Pro")
            #expect(plan.source == nil)
            #expect(plan.family == nil)
            #expect(plan.subscription?.productName == "Pro")
        }
        // A server without billing: no plan at all reads Free.
        let off = try JSONDecoder().decode(BillingSummary.self, from: Data(#"{"enabled":false,"hasCustomer":false,"subscription":null,"intendedPlan":null,"family":null}"#.utf8))
        let plan = PlanDisplay(allowance: try storage(pool: "null"), billing: off)
        #expect(plan.name == "Free")
        #expect(plan.source == nil)
    }

    @Test func aPoolThisBuildCantReadLeavesTheFiguresAndTodaysWords() throws {
        let malformed = [
            #""Lindqvist family""#,
            "true",
            "[]",
            "{}",
            #"{"groupId":"g-1"}"#,
            #"{"name":"Lindqvist family"}"#,
            #"{"groupId":"g-1","name":5}"#,
            #"{"groupId":7,"name":"Lindqvist family"}"#,
            #"{"groupId":"g-1","name":"  "}"#,
            #"{"groupId":"","name":"Lindqvist family"}"#,
        ]
        for pool in malformed {
            let allowance = try storage(pool: pool)
            #expect(allowance.pool == nil, "pool \(pool)")
            #expect(allowance.quota == 858_993_459_200, "pool \(pool)")
            #expect(allowance.used == 335_007_449_088, "pool \(pool)")
            let plan = PlanDisplay(allowance: allowance, billing: try billing(family: nil))
            #expect(plan.name == "Pro", "pool \(pool)")
            #expect(plan.source == nil, "pool \(pool)")
        }
        // A family field this build can't read costs the billing answer nothing either.
        for family in [#""Lindqvist family""#, #"{"planName":"Family Plus"}"#, "[]"] {
            let summary = try billing(family: family)
            #expect(summary.family == nil, "family \(family)")
            #expect(summary.subscription?.productName == "Pro", "family \(family)")
        }
    }
}
