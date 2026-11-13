package com.hushos.app.data

import org.json.JSONArray
import org.json.JSONObject

/*
 * Whether two JSON values say the same thing: the same keys with the same values, lists in the same
 * order, key order and number width aside. For holding what the app sends to a fixture's body
 * (android.jar's org.json, which tests compile against, has no comparison of its own).
 */
internal fun sameJson(expected: Any?, actual: Any?): Boolean = when {
    expected is JSONObject && actual is JSONObject ->
        expected.keys().asSequence().toSet() == actual.keys().asSequence().toSet() && expected.keys().asSequence().all { sameJson(expected.get(it), actual.get(it)) }
    expected is JSONArray && actual is JSONArray ->
        expected.length() == actual.length() && (0 until expected.length()).all { sameJson(expected.get(it), actual.get(it)) }
    expected is Number && actual is Number -> expected.toDouble() == actual.toDouble()
    else -> expected == actual
}
