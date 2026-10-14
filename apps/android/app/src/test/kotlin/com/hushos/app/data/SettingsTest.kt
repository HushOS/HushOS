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
}
