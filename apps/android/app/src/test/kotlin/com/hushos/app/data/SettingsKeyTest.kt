package com.hushos.app.data

import com.hushos.core.SettingsEnvelope
import com.hushos.core.SettingsKeyEnvelope
import com.hushos.core.base64urlDecode
import com.hushos.core.randomBytes
import com.hushos.core.settingsKeyCreate
import com.hushos.core.settingsKeyOpen
import com.hushos.core.settingsKeyRewrap
import com.hushos.core.settingsOpen
import com.hushos.core.settingsSeal
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/*
 * Settings version 2 (docs/integrity-design.md, "The settings key"): sealed under a key of their own, wrapped under
 * the account root, so a replaced identity strands nothing. What the web sealed opens here, what this app seals
 * opens as the web's next device would read it, pins and the ledger and unknown fields intact, and only under the
 * key and root it was meant for.
 */
class SettingsKeyTest {
    private val settings = WebFixture.json.getJSONObject("settings")
    private val userId = settings.getString("userId")
    private val root = base64urlDecode(settings.getString("accountKey"))
    private val rawKey = base64urlDecode(settings.getString("settingsKeyRaw"))
    private val wrapped = settings.getJSONObject("settingsKey").let { SettingsKeyEnvelope(it.getString("nonce"), it.getString("ciphertext")) }

    private fun envelope(json: JSONObject) = SettingsEnvelope(json.getInt("version").toUInt(), json.getLong("settingsVersion").toULong(), json.getString("nonce"), json.getString("ciphertext"))

    @Test
    fun theWebsSettingsOpenInBothVersionsWithTheirOwnKeys() {
        assertArrayEquals(rawKey, settingsKeyOpen(userId, root, wrapped))
        assertEquals(settings.getString("json"), settingsOpen(userId, rawKey, null, envelope(settings.getJSONObject("v2"))))
        // Version 1 is read once, under the identity it was sealed with, then saved as version 2.
        assertEquals(settings.getString("json"), settingsOpen(userId, null, base64urlDecode(settings.getString("identityPrivateKey")), envelope(settings.getJSONObject("envelope"))))
        // Neither opens under the other's key.
        assertThrows(Exception::class.java) { settingsOpen(userId, null, base64urlDecode(settings.getString("identityPrivateKey")), envelope(settings.getJSONObject("v2"))) }
        assertThrows(Exception::class.java) { settingsOpen(userId, randomBytes(32u), null, envelope(settings.getJSONObject("v2"))) }
    }

    @Test
    fun aSaveHereReadsBackOnTheNextDeviceWithEverythingInIt() {
        val made = settingsKeyCreate(userId, root)
        val document = Settings.parse("""{"version":1,"theme":"dark","contacts":{},"sharing":{"shares":{"n-1":["u-1"]},"links":{}}}""", 4uL)
        document.pin(ContactPin("u-1", "ada@example.org", "Ada", "enc", "sig", "f", "2026-10-01T00:00:00Z", "h", keyVersion = 2uL,
            previousSigningKeys = listOf("sig-0"), keysReplacedAt = "2026-10-02T00:00:00Z"))
        val sealed = settingsSeal(userId, made.key, 5uL, document.text())
        assertEquals(2u, sealed.version)
        // Padded to 1 KiB steps (the server refuses anything else), and sealed under a key the next device opens from the root.
        assertEquals(0, (base64urlDecode(sealed.ciphertext).size - 16) % 1024)
        val key = settingsKeyOpen(userId, root, made.envelope)
        val read = Settings.parse(settingsOpen(userId.lowercase(), key, null, sealed), sealed.settingsVersion)
        assertEquals("dark", read.json.getString("theme"))
        assertTrue(read.ledger.hasShare("n-1", "u-1"))
        val pin = read.contacts.getValue("u-1")
        assertEquals(2uL, pin.keyVersion)
        assertEquals(listOf("sig-0"), pin.previousSigningKeys)
        assertEquals("2026-10-02T00:00:00Z", pin.keysReplacedAt)
        // Sealed for one settings version and account: offered as another, it doesn't open.
        assertThrows(Exception::class.java) { settingsOpen(userId, key, null, sealed.copy(settingsVersion = 6uL)) }
        assertThrows(Exception::class.java) { settingsOpen("someone-else", key, null, sealed) }
    }

    @Test
    fun aMasterKeyRotationCarriesTheSettingsKeyToTheNewRootOnly() {
        val newRoot = randomBytes(32u)
        val moved = settingsKeyRewrap(userId, root, newRoot, wrapped)
        assertArrayEquals(rawKey, settingsKeyOpen(userId, newRoot, moved))
        assertThrows(Exception::class.java) { settingsKeyOpen(userId, root, moved) }
        assertThrows(Exception::class.java) { settingsKeyRewrap(userId, newRoot, randomBytes(32u), wrapped) }
    }
}
