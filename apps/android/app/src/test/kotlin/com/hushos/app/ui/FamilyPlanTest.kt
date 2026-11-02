package com.hushos.app.ui

import com.hushos.app.data.FamilyPlan
import com.hushos.app.data.GroupDetail
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

/*
 * The family's plan on the phone, read only (iOS 7 and Android 7): the plan, the pool and who pays as the server says
 * them, and no way from any family or account screen to where plans are bought or changed (Google Play's payments
 * policy; Apple's 3.1.3(f) on iOS).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class FamilyPlanTest {
    private val gib = 1_073_741_824L
    private val sam = GroupDetail.Member("b7a3c9e0-0000-4000-8000-000000000001", "Sam Lindqvist", "sam@example.org", "active", listOf("billing", "members"))

    private fun lines(json: String, members: List<GroupDetail.Member>? = listOf(sam)) = FamilyPlanLines.of(FamilyPlan.from(JSONObject(json))!!, members)

    /*
     * A member's glance: the plan's tier with the pool's size, what the pool holds, never who pays (the server sends
     * nobody), and the one line. Fails if the glance shows a payer it wasn't given, or an interval in the plan's name.
     */
    @Test
    fun aMembersGlanceSaysThePlanAndThePoolAndNobodyWhoPays() {
        val shown = lines("""{"enabled":true,"view":"member","hasPlan":true,"planName":"Family Pro (yearly)","lapsedPlan":null,
            "storage":{"usedBytes":"${5 * gib}","quotaBytes":"${2048 * gib}"}}""")
        assertEquals("Family Pro · 2 TB", shown.plan)
        assertEquals(listOf("Used" to "5 GB of 2 TB"), shown.rows)
        assertEquals("Billing is managed on the web.", shown.note)
    }

    /*
     * The payer's or a billing holder's summary: who pays as route 3 names them (name and address), "You" for the payer.
     * Fails if the phone names the payer from anything but the server's `payer`, or names someone route 3 doesn't list.
     */
    @Test
    fun aManagersSummaryNamesWhoPays() {
        val base = """"enabled":true,"view":"manage","plans":[],"subscription":{"productName":"Family (monthly)","status":"active"},
            "lastPlan":null,"storage":{"usedBytes":"0","quotaBytes":"${1024 * gib}"},"seats":{"used":2,"limit":6},"nextPlace":null"""
        assertEquals("Sam Lindqvist (sam@example.org)", lines("""{$base,"payer":{"userId":"${sam.userId.uppercase()}","you":false}}""").rows.toMap()["Paid by"])
        assertEquals("You", lines("""{$base,"payer":{"userId":"x","you":true}}""").rows.toMap()["Paid by"])
        assertNull(lines("""{$base,"payer":{"userId":"someone-else","you":false}}""").rows.toMap()["Paid by"])
        assertNull(lines("""{$base,"payer":null}""").rows.toMap()["Paid by"])
        assertEquals("Family · 1 TB", lines("""{$base,"payer":null}""").plan)
    }

    /*
     * No live plan: a lapsed one in the web's words, else "No family plan right now"; a pool emptied (quota 0) has no
     * Used row. Never a plan that isn't live (a manager's lapsed or ended plan, a glance without `hasPlan`). Billing off,
     * or an answer this build can't read, shows no section. Fails if any of these reads as a live plan.
     */
    @Test
    fun withoutALivePlanItSaysSoAndShowsNoPool() {
        assertEquals("Family Pro’s payment didn’t go through" to listOf("Paid by" to "You"),
            lines("""{"enabled":true,"view":"member","hasPlan":false,"planName":null,"storage":{"usedBytes":"${gib}","quotaBytes":"0"},
                "lapsedPlan":{"productName":"Family Pro (monthly)","standing":"payment-failed","youPay":true}}""").let { it.plan to it.rows })
        assertEquals("Family is paused" to emptyList<Pair<String, String>>(),
            lines("""{"enabled":true,"view":"manage","subscription":null,"lastPlan":{"productName":"Family","endedAt":"2026-10-01T00:00:00Z"},
                "lapsedPlan":{"productName":"Family","standing":"paused","ids":["s"]},"payer":null,"storage":null,"seats":{"used":1,"limit":1}}""").let { it.plan to it.rows })
        assertEquals("No family plan right now" to emptyList<Pair<String, String>>(),
            lines("""{"enabled":true,"view":"member","hasPlan":false,"planName":"Family Pro","storage":null}""").let { it.plan to it.rows })
        assertNull(FamilyPlan.from(JSONObject("""{"enabled":false,"view":"member","hasPlan":false}""")))
        assertNull(FamilyPlan.from(JSONObject("""{"enabled":true,"view":"owner"}""")))
    }

    /*
     * No family or account screen holds a way to a billing page: no link, no URL handler, no web address, no checkout,
     * portal or pricing route, and no "upgrade" wording, in any of their sources. Fails as soon as one is added.
     */
    @Test
    fun noFamilyOrAccountScreenLinksToBilling() {
        val screens = listOf("Families.kt", "FamilyPlan.kt", "FamilyJoin.kt", "FamilyCheck.kt", "FamiliesModel.kt", "AccountScreen.kt")
            .map { File("src/main/kotlin/com/hushos/app/ui", it) }
        val ways = listOf(
            Regex("""LocalUriHandler|openUri|ACTION_VIEW|CustomTabs|LinkAnnotation|Uri\.parse|toUri\("""),
            Regex("""https?://"""),
            Regex("""/(billing|pricing|checkout|portal|plans)\b"""),
            Regex("""\b(upgrade|checkout|polar|portal|subscribe|buy)\b""", RegexOption.IGNORE_CASE),
        )
        val found = screens.flatMap { file ->
            assert(file.exists()) { "missing $file" }
            file.readLines().withIndex().filter { (_, line) -> ways.any { it.containsMatchIn(code(line)) } }.map { (i, line) -> "${file.name}:${i + 1}: ${line.trim()}" }
        }
        assertEquals("ways to a billing page", emptyList<String>(), found)
    }

    /* A line without its comment: what the screen does, not what a comment says about policy. */
    private fun code(line: String): String {
        val trimmed = line.trim()
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return ""
        return line.substringBefore(" // ")
    }
}
