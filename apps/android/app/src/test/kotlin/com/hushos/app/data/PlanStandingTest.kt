package com.hushos.app.data

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/*
 * Which personal plan Account names (PlanStanding, the web's `planStanding`). `/api/billing`
 * keeps answering with the last plan after it ends, and with a plan whose payment failed or that
 * is paused: neither gives its storage, so neither may read "Pro · Renews …". A server that
 * records an unpaid plan as ended must land on Free as well.
 */
class PlanStandingTest {
    private val periodEnd = "2026-11-03T00:00:00.000Z"

    private fun billing(status: String, endedAt: String? = null, name: String = "Pro") = BillingSummary.from(JSONObject(
        """{"enabled":true,"hasCustomer":true,"subscription":{"productName":"$name","status":"$status","recurringInterval":"month","quotaBytes":"214748364800","currentPeriodEnd":"$periodEnd","cancelAtPeriodEnd":false,"endedAt":${endedAt?.let { "\"$it\"" } ?: "null"}},"intendedPlan":null,"family":null}""",
    ))

    private fun storage(pool: String = "null") = StorageAllowance.from(JSONObject(
        """{"workspaceId":"w-1","quotaBytes":"5368709120","usedBytes":"1073741824","reservedBytes":"0","availableBytes":"4294967296","pool":$pool}""",
    ))

    @Test
    fun aLivePlanIsTheCurrentPlan() {
        assertEquals(PlanDisplay("Pro", null, null, periodEnd, false), PlanDisplay.of(storage(), billing("active")))
        assertEquals(PlanDisplay("Pro", null, null, periodEnd, false), PlanDisplay.of(storage(), billing("trialing")))
        // Polar is still retrying the renewal: still the plan, and the card says the payment is overdue.
        assertEquals(PlanDisplay("Pro", null, null, periodEnd, false, overdue = true), PlanDisplay.of(storage(), billing("past_due")))
    }

    @Test
    fun aPlanWhosePaymentFailedReadsFreeAndSaysSo() {
        for (status in listOf("unpaid", "incomplete")) {
            val plan = PlanDisplay.of(storage(), billing(status))
            assertEquals(status, PlanDisplay("Free", null, null, null, false, lapsed = LapsedPlan("Pro", paused = false)), plan)
            assertEquals(status, "Pro’s payment didn’t go through", plan.lapsed?.line)
            assertEquals(status, "Pro’s payment didn’t go through, so you have Free’s storage for now.", plan.lapsed?.room)
        }
    }

    @Test
    fun aPausedPlanReadsFreeAndSaysSo() {
        val plan = PlanDisplay.of(storage(), billing("paused"))
        assertEquals(PlanDisplay("Free", null, null, null, false, lapsed = LapsedPlan("Pro", paused = true)), plan)
        assertEquals("Pro is paused", plan.lapsed?.line)
        assertEquals("Pro is paused, so you have Free’s storage until it resumes.", plan.lapsed?.room)
    }

    @Test
    fun anEndedPlanIsFreeWhateverItsStatus() {
        // Today's server ends an unpaid plan with its status left as Polar sent it; a past one may
        // still say active. `canceled`, `incomplete_expired` or a status Polar adds later is Free too.
        val ended = "2026-10-01T00:00:00.000Z"
        val cases = listOf("active" to ended, "unpaid" to ended, "paused" to ended, "canceled" to ended, "canceled" to null, "incomplete_expired" to null, "frozen" to null)
        for ((status, endedAt) in cases) {
            assertEquals("$status $endedAt", PlanDisplay("Free", null, null, null, false), PlanDisplay.of(storage(), billing(status, endedAt)))
        }
    }

    @Test
    fun theLapsedPlanIsNamedWithoutItsInterval() {
        assertEquals("Pro’s payment didn’t go through", PlanDisplay.of(storage(), billing("unpaid", name = "Pro (monthly)")).lapsed?.line)
    }

    @Test
    fun aPooledMemberSeesNoLapsedPersonalPlan() {
        // The family's plan is what they draw from; their own unpaid plan says nothing on its card.
        val plan = PlanDisplay.of(storage("""{"groupId":"g-1","name":"Lindqvist family"}"""), billing("unpaid"))
        assertEquals("Shared with Lindqvist family", plan.source)
        assertNull(plan.lapsed)
    }
}
