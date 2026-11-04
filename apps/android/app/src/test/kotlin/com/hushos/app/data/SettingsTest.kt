package com.hushos.app.data

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/*
 * The settings document is shared by every client: the web writes the sharing ledger and may add
 * fields this app has never heard of. A save here that rebuilt the document from the fields it
 * knows would drop the ledger, and with it every share and link the next rotation should keep.
 */
class SettingsTest {
    private val document = """
        {"version":1,"theme":{"accent":"blue"},
         "contacts":{"u-1":{"userId":"u-1","email":"ada@example.org","name":"Ada","encryptionPublicKey":"enc","signingPublicKey":"sig",
           "fingerprint":"f","pinnedAt":"2026-10-01T00:00:00Z","kemPublicKeyHash":null,"note":"met at the conference"}},
         "sharing":{"shares":{"node-1":["u-1"]},"links":{"link-1":"node-1"},"later":true}}
    """.trimIndent()

    private fun pin(id: String, name: String) = ContactPin(id, "$name@example.org", name, "enc-$id", "sig-$id", "f-$id", "2026-10-02T00:00:00Z", null, null)

    /* What a save writes, read back as the next device would. */
    private fun roundTrip(settings: Settings) = Settings.parse(settings.text(), settings.version + 1uL)

    @Test
    fun unknownFieldsSurvivePinUnpinAndLedgerEdits() {
        val settings = Settings.parse(document, 4uL)
        settings.pin(pin("u-2", "Grace"))
        settings.unpin("u-2")
        settings.addShare("node-2", "u-1")
        settings.addLink("link-2", "node-2")
        val saved = JSONObject(roundTrip(settings).text())
        assertEquals("blue", saved.getJSONObject("theme").getString("accent"))
        assertTrue(saved.getJSONObject("sharing").getBoolean("later"))
        assertEquals("met at the conference", saved.getJSONObject("contacts").getJSONObject("u-1").getString("note"))
    }

    @Test
    fun aGroupsWordOnAPinIsReadKeptWhenFollowedAndClearedByAWordsCheck() {
        val group = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a"
        val settings = Settings.parse(document.replace("\"kemPublicKeyHash\":null", "\"kemPublicKeyHash\":null,\"trustedVia\":\"$group\""), 4uL)
        val held = settings.contacts.getValue("u-1")
        assertEquals(group, held.trustedVia)
        // A followed pin carries the origin on.
        settings.pin(held.copy(keysReplacedAt = "2026-10-03T00:00:00Z"))
        assertEquals(group, roundTrip(settings).contacts.getValue("u-1").trustedVia)
        // A words check writes a pin with no origin: the group's word is gone.
        settings.pin(pin("u-1", "Ada"))
        assertFalse(JSONObject(settings.text()).getJSONObject("contacts").getJSONObject("u-1").has("trustedVia"))
        // An empty origin stays empty, for the core to refuse: never read as a words check.
        val empty = Settings.parse(document.replace("\"kemPublicKeyHash\":null", "\"kemPublicKeyHash\":null,\"trustedVia\":\"\""), 4uL)
        assertEquals("", empty.contacts.getValue("u-1").trustedVia)
    }

    @Test
    fun repinningKeepsThePinsOwnUnknownFieldsAndTakesTheNewKeys() {
        val settings = Settings.parse(document, 4uL)
        settings.pin(pin("u-1", "Ada").copy(signingPublicKey = "sig-new", fingerprint = "f-new"))
        val saved = roundTrip(settings)
        val raw = saved.json.getJSONObject("contacts").getJSONObject("u-1")
        assertEquals("met at the conference", raw.getString("note"))
        assertEquals("sig-new", saved.contacts.getValue("u-1").signingPublicKey)
        assertEquals("f-new", saved.contacts.getValue("u-1").fingerprint)
    }

    @Test
    fun pinningAndUnpinningNeverDropsTheLedger() {
        val settings = Settings.parse(document, 4uL)
        settings.pin(pin("u-3", "Linus"))
        settings.unpin("u-1")
        val ledger = roundTrip(settings).ledger
        assertTrue(ledger.hasShare("node-1", "u-1"))
        assertTrue(ledger.hasLink("link-1", "node-1"))
    }

    @Test
    fun aShareIsRecordedOnceAndItsRemovalDropsTheEmptyNode() {
        val settings = Settings.empty()
        settings.addShare("node-9", "u-1")
        settings.addShare("node-9", "u-1")
        settings.addShare("node-9", "u-2")
        assertEquals(2, settings.json.getJSONObject("sharing").getJSONObject("shares").getJSONArray("node-9").length())
        settings.removeShare("node-9", "u-1")
        assertFalse(roundTrip(settings).ledger.hasShare("node-9", "u-1"))
        assertTrue(roundTrip(settings).ledger.hasShare("node-9", "u-2"))
        settings.removeShare("node-9", "u-2")
        assertFalse(roundTrip(settings).json.getJSONObject("sharing").getJSONObject("shares").has("node-9"))
    }

    @Test
    fun aLinkIsRecordedForItsNodeOnlyAndGoesWhenRemoved() {
        val settings = Settings.empty()
        settings.addLink("link-7", "node-7")
        val ledger = roundTrip(settings).ledger
        assertTrue(ledger.hasLink("link-7", "node-7"))
        // The server can move a link id onto another node in its list; the ledger names the node it was made for.
        assertFalse(ledger.hasLink("link-7", "node-8"))
        settings.removeLink("link-7")
        assertFalse(roundTrip(settings).ledger.hasLink("link-7", "node-7"))
    }

    /* A first-seen pin of real-shaped keys (fingerprint ""), as Add someone writes it. */
    private fun firstSeen(id: String) = TestPins.verified(id, "grace@example.org", "Grace", com.hushos.core.base64urlEncode(ByteArray(32) { 1 }),
        com.hushos.core.base64urlEncode(ByteArray(32) { 2 })).copy(fingerprint = "", firstSeen = "added")

    @Test
    fun writingAPinUnderTheServedIdMovesAnotherClientsDifferentlyCasedPinWholeAndKeepsEveryFieldItDoesNotKnow() {
        // Written by the web and a later client: a pin under the id in capitals, with fields this version never reads, and
        // the family and role fields at the top.
        val settings = Settings.parse("""
            {"version":2,"familyChecks":{"g-1":"x"},"familyChecksSince":"2026-10-20","pendingRoles":{"g-1":{"u":"members"}},
             "resealOwnShares":true,"replacementSeen":{"a":1},"trustedViaFamily":{"b":2},"later":"kept",
             "contacts":{"GRACE-ID":{"userId":"GRACE-ID","email":"grace@example.org","name":"Grace","encryptionPublicKey":"old","signingPublicKey":"old",
               "fingerprint":"","pinnedAt":"2026-10-01T00:00:00Z","firstSeen":"shared-with-me","familyChecks":{"g-1":"y"},"note":"kept"}}}
        """.trimIndent(), 7uL)
        settings.setPinOnce(firstSeen("grace-id").copy(firstSeen = null))
        val saved = JSONObject(roundTrip(settings).text())
        val contacts = saved.getJSONObject("contacts")
        assertEquals(listOf("grace-id"), contacts.keys().asSequence().toList())
        val pin = contacts.getJSONObject("grace-id")
        assertEquals("shared-with-me", pin.getString("firstSeen"))
        assertEquals("y", pin.getJSONObject("familyChecks").getString("g-1"))
        assertEquals("kept", pin.getString("note"))
        assertEquals(com.hushos.core.base64urlEncode(ByteArray(32) { 1 }), pin.getString("encryptionPublicKey"))
        for (field in listOf("familyChecks", "familyChecksSince", "pendingRoles", "resealOwnShares", "replacementSeen", "trustedViaFamily", "later"))
            assertTrue(field, saved.has(field))
    }

    @Test
    fun aRemovalIsRecordedForgottenWhenTheyAreAddedAgainAndTheOldestGoFirstWhenRoomRunsOut() {
        val settings = Settings.empty(3uL)
        settings.setPinOnce(firstSeen("u-1"))
        settings.removeContact("U-1", "2026-10-02T00:00:00Z")
        assertTrue(settings.removed("u-1"))
        assertEquals(null, settings.pinOf("u-1"))
        settings.setPinOnce(firstSeen("u-1"))
        assertFalse(settings.removed("u-1"))
        // Room for everything but the removals: they go oldest first, one at a time, and a pin still fits.
        for (i in 0 until 600) settings.removeContact("gone-$i", "2026-09-%02dT00:00:00Z".format(1 + i % 28) + i)
        settings.json.put("padding", "x".repeat(Settings.MAX_BYTES - settings.bytes() + 2_000))
        settings.setPinOnce(firstSeen("u-2"))
        assertTrue(settings.bytes() <= Settings.MAX_BYTES)
        val kept = settings.removals
        assertTrue(kept.isNotEmpty() && kept.size < 600)
        // Only the oldest went: every one kept is later than (or as late as) any forgotten.
        val forgotten = (0 until 600).map { "gone-$it" }.filter { id -> kept.none { it.first == id } }
        val newestForgotten = forgotten.maxOf { id -> "2026-09-%02dT00:00:00Z".format(1 + id.removePrefix("gone-").toInt() % 28) + id.removePrefix("gone-") }
        assertTrue(kept.all { it.second >= newestForgotten })
    }

    @Test
    fun aDocumentFullWithoutAnyRemovalRefusesTheNewPinInTheWebsWordsAndChangesNothing() {
        val settings = Settings.empty(3uL)
        settings.json.put("padding", "x".repeat(Settings.MAX_BYTES - settings.bytes() - 100))
        val before = settings.text()
        val refused = org.junit.Assert.assertThrows(ContactProblem::class.java) { settings.setPinOnce(firstSeen("u-1")) }
        assertEquals("Your contacts are full. Remove someone you no longer share with.", refused.message)
        assertEquals(before, settings.text())
    }
}
