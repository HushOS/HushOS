package com.hushos.app.data

import com.hushos.core.CheckedHow
import com.hushos.core.FamilyCheck
import com.hushos.core.FamilyChecked
import com.hushos.core.GroupPin
import com.hushos.core.groupPinCheck
import org.json.JSONArray
import org.json.JSONObject

/*
 * The families' fields of the settings document, edited in place as every field is (Settings): each family's
 * cross-device mark (`groups`, docs/groups-design.md 2.7), and which families this person vouched for (`familyChecks`,
 * `familyChecksSince`, docs/optional-verification.md 3.4 and 7.2; the web's lib/groups/family-checks.ts). Records
 * another client wrote are never rewritten: only a record this account has none of is ever added, and the marker is
 * written only when it is missing.
 */

/* The family's pin: null when there is none; refused when one is there and doesn't read (as the web's checkGroupPin). */
fun Settings.groupPin(groupId: String): GroupPin? {
    val groups = json.optJSONObject("groups") ?: return null
    val key = if (groups.has(groupId)) groupId else groups.keys().asSequence().firstOrNull { it.equals(groupId, ignoreCase = true) } ?: return null
    val raw = groups.opt(key) as? JSONObject ?: throw FamilyFailure("Invalid group pin.")
    val pin = groupPinOf(raw) ?: throw FamilyFailure("Invalid group pin.")
    return runCatching { groupPinCheck(groupId, pin) }.getOrElse { throw FamilyFailure("Invalid group pin.") }
}

/* The family's pin replaced whole, as the web's settlePin writes it; everything else in the document stays as it was. */
fun Settings.setGroupPin(groupId: String, pin: GroupPin) {
    val groups = json.optJSONObject("groups") ?: JSONObject().also { json.put("groups", it) }
    groups.put(groupId, groupPinJson(pin))
}

/* JavaScript's truthiness, as the web reads these fields: absent, null, false, 0, NaN and "" are not set. */
private fun truthy(value: Any?): Boolean = when (value) {
    null, JSONObject.NULL -> false
    is Boolean -> value
    is Number -> value.toDouble().let { it != 0.0 && !it.isNaN() }
    is String -> value.isNotEmpty()
    else -> true
}

/* A roster version as the web's Number.isSafeInteger reads it: never a boolean, never a fraction. */
private fun safeInteger(value: Any?): Boolean = when (value) {
    is Int, is Long, is Short, is Byte -> kotlin.math.abs((value as Number).toLong()) <= 9_007_199_254_740_991L
    is Double -> value == Math.rint(value) && kotlin.math.abs(value) <= 9_007_199_254_740_991.0
    is Float -> value.toDouble().let { it == Math.rint(it) && kotlin.math.abs(it) <= 9_007_199_254_740_991.0 }
    else -> false
}

/* Whether this person vouched for `groupId`: a check record, or a pin from before the marker (the web's familyChecked). */
fun Settings.familyChecked(groupId: String): Boolean {
    val checks = json.optJSONObject("familyChecks")
    if (checks != null && checks.has(groupId) && !checks.isNull(groupId)) return true
    if (!truthy(json.optJSONObject("groups")?.opt(groupId))) return false
    return !truthy(json.opt("familyChecksSince"))
}

/* The other member of this person's family check of `groupId`, if the record is one. */
fun Settings.familyCheckWith(groupId: String): String? = (json.optJSONObject("familyChecks")?.opt(groupId) as? JSONObject)?.opt("with") as? String

/*
 * The document a family pin is saved into (the web's withFamilyChecks): the marker, if it is missing, with a `before`
 * record at each pin's own roster for every family pin already here; then a record of what vouched for this acceptance
 * (`checked`: created, or a join code compared). A first-use acceptance (`checked` null) adds no record. The invariant
 * (7.2): no group pin is saved into settings that lack the marker without it, so a pin labelled `before` was never a
 * first-use one. Derived again on every attempt of the compare-and-set, from the document that attempt read.
 */
fun Settings.markFamilyChecks(now: String, acceptance: Pair<String, FamilyChecked?>? = null) {
    val checks = json.opt("familyChecks") as? JSONObject ?: JSONObject()
    if (!truthy(json.opt("familyChecksSince"))) {
        val groups = json.optJSONObject("groups")
        for (groupId in groups?.keys()?.asSequence()?.toList().orEmpty()) {
            if (truthy(checks.opt(groupId))) continue
            val version = (groups!!.opt(groupId) as? JSONObject)?.opt("rosterVersion")
            if (!safeInteger(version)) continue
            checks.put(groupId, JSONObject().put("rosterVersion", version).put("how", "before").put("checkedAt", now))
        }
        json.put("familyChecksSince", now)
    }
    val checked = acceptance?.second
    if (acceptance != null && checked != null && checked.how != CheckedHow.COMPARED && !truthy(checks.opt(acceptance.first))) {
        checks.put(acceptance.first, JSONObject().put("rosterVersion", checked.rosterVersion.toLong()).put("how", if (checked.how == CheckedHow.CREATED) "created" else "join")
            .put("checkedAt", now))
    }
    json.put("familyChecks", checks)
}

/* A family check this person made (3.4), with the marker first if it is missing: what They match saves. */
fun Settings.setFamilyCheck(groupId: String, check: FamilyCheck) {
    markFamilyChecks(check.checkedAt)
    json.getJSONObject("familyChecks").put(groupId, JSONObject().put("rosterVersion", check.rosterVersion.toLong()).put("with", check.with)
        .put("code", JSONArray(check.code)).put("checkedAt", check.checkedAt))
}
