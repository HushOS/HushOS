package com.hushos.app.data

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/*
 * Where a family member's storage comes from (docs/families-shared-pool.md 9, 6.1). While
 * `/api/auth/storage` names a pool, Account must say the storage is the family's and stop naming
 * a personal plan the person no longer draws from. An older server, a server without billing, or a
 * `pool` this build can't read must leave today's card exactly as it was, figures included.
 */
class StoragePoolTest {
    private val pro = """{"productName":"Pro","status":"active","recurringInterval":"month","quotaBytes":"214748364800","currentPeriodEnd":"2026-11-03T00:00:00.000Z","cancelAtPeriodEnd":true}"""

    /* A field written in as served, or left out as an older server does. */
    private fun field(name: String, value: String?) = if (value == null) "" else ",\"$name\":$value"

    private fun storage(pool: String?) = StorageAllowance.from(JSONObject(
        """{"workspaceId":"w-1","quotaBytes":"858993459200","usedBytes":"335007449088","reservedBytes":"0","availableBytes":"523986010112"""" + field("pool", pool) + "}",
    ))

    private fun billing(family: String?) = BillingSummary.from(JSONObject(
        """{"enabled":true,"hasCustomer":true,"subscription":$pro,"intendedPlan":null""" + field("family", family) + "}",
    ))

    @Test
    fun aPooledMemberSeesTheFamilysPlanAndNotTheirOwn() {
        val allowance = storage("""{"groupId":"8f0c2a4e-1b3d-4c5e-9f60-718293a4b5c6","name":"Lindqvist family"}""")
        assertEquals(StoragePool("8f0c2a4e-1b3d-4c5e-9f60-718293a4b5c6", "Lindqvist family"), allowance.pool)
        assertEquals(858_993_459_200L, allowance.quotaBytes)

        // A personal plan billing hasn't ended yet still comes back beside the family: it must not show.
        val plan = PlanDisplay.of(allowance, billing("""{"name":"Lindqvist family","planName":"Family Plus"}"""))
        assertEquals(PlanDisplay("Family Plus", "From Lindqvist family’s plan", "Lindqvist family", null, false), plan)

        // Billing unanswered, or a family plan with no name: still the family's, never Pro.
        for (summary in listOf(null, billing("""{"name":"Lindqvist family","planName":null}"""), billing("""{"name":"Lindqvist family","planName":" "}"""))) {
            assertEquals(PlanDisplay("Family plan", "From Lindqvist family’s plan", "Lindqvist family", null, false), PlanDisplay.of(allowance, summary))
        }

        // Storage unanswered: billing's family keeps the personal plan off the card.
        val unread = PlanDisplay.of(null, billing("""{"name":"Lindqvist family","planName":"Family Plus"}"""))
        assertEquals("From Lindqvist family’s plan", unread.source)
        assertNull(unread.periodEnd)
    }

    @Test
    fun withoutAPoolTheCardIsTodays() {
        // An older server sends neither field; a current one sends null for someone in no family.
        for ((pool, family) in listOf(null to null, "null" to "null")) {
            val allowance = storage(pool)
            assertNull(allowance.pool)
            assertEquals(335_007_449_088L, allowance.usedBytes)
            val summary = billing(family)
            assertNull(summary.family)
            assertEquals(PlanDisplay("Pro", null, null, "2026-11-03T00:00:00.000Z", true), PlanDisplay.of(allowance, summary))
        }
        // A server without billing: no plan at all reads Free.
        val off = BillingSummary.from(JSONObject("""{"enabled":false,"hasCustomer":false,"subscription":null,"intendedPlan":null,"family":null}"""))
        assertEquals(PlanDisplay("Free", null, null, null, false), PlanDisplay.of(storage("null"), off))
    }

    @Test
    fun aPoolThisBuildCantReadLeavesTheFiguresAndTodaysWords() {
        val malformed = listOf(
            "\"Lindqvist family\"",
            "true",
            "[]",
            "{}",
            """{"groupId":"g-1"}""",
            """{"name":"Lindqvist family"}""",
            """{"groupId":"g-1","name":5}""",
            """{"groupId":7,"name":"Lindqvist family"}""",
            """{"groupId":"g-1","name":"  "}""",
            """{"groupId":"","name":"Lindqvist family"}""",
        )
        for (pool in malformed) {
            val allowance = storage(pool)
            assertNull("pool $pool", allowance.pool)
            assertEquals("pool $pool", 858_993_459_200L, allowance.quotaBytes)
            assertEquals("pool $pool", 335_007_449_088L, allowance.usedBytes)
            val plan = PlanDisplay.of(allowance, billing(null))
            assertEquals("pool $pool", "Pro", plan.name)
            assertNull("pool $pool", plan.source)
        }
        // A family field this build can't read costs the billing answer nothing either.
        for (family in listOf("\"Lindqvist family\"", """{"planName":"Family Plus"}""", "[]")) {
            val summary = billing(family)
            assertNull("family $family", summary.family)
            assertEquals("family $family", "Pro", summary.planName)
        }
    }
}
