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
    fun theWebsVersionTwoOpensUnderTheSettingsKeyAlone() {
        assertArrayEquals(rawKey, settingsKeyOpen(userId, root, wrapped))
        assertEquals(settings.getString("json"), settingsOpen(userId, rawKey, envelope(settings.getJSONObject("v2"))))
        assertThrows(Exception::class.java) { settingsOpen(userId, randomBytes(32u), envelope(settings.getJSONObject("v2"))) }
        assertThrows(Exception::class.java) { settingsOpen(userId, null, envelope(settings.getJSONObject("v2"))) }
    }

    @Test
    fun aVersionOneDocumentNoLongerOpensAndReadsAsEmptySettingsSavedOverAsVersionTwo() {
        // The web's genuine version 1 document, with pins in it: a stolen identity key opened those, so none come back.
        val v1 = envelope(settings.getJSONObject("envelope"))
        val read = openSettingsText(userId, rawKey, v1)
        assertTrue(read.contacts.isEmpty())
        assertTrue(read.ledger.shares.isEmpty())
        // At the stored version, so the next save (version 2, one up) is over that document rather than refused as stale.
        assertEquals(v1.settingsVersion, read.version)
        val saved = settingsSeal(userId, rawKey, read.version + 1uL, read.text())
        assertEquals(2u, saved.version)
        assertEquals(read.text(), settingsOpen(userId, rawKey, saved))
    }

    @get:org.junit.Rule val folder = org.junit.rules.TemporaryFolder()

    @Test
    fun aVersionOneRowServedAsNoneIsReadAtItsStoredSequenceSoTheSaveOverItOpensAgain() {
        val mark = SettingsMark(folder.root.resolve("marks"), SettingsMarkTest.keys(7))
        // An earlier session saw the version 1 document at sequence 7; the server serves it as none, with sequence 7.
        mark.recordSettings(userId, 7uL, sealedV2 = false)
        val read = readServedSettings(userId, null, 7uL, mark) { rawKey }
        assertTrue(read.contacts.isEmpty())
        // The save names 7 and seals at 8, the version the server stores it at: read back at 8, it opens.
        assertEquals(7uL, read.version)
        read.pin(ContactPin("u-1", "ada@example.org", "Ada", "enc", "sig", "f", "2026-10-01T00:00:00Z", null, null))
        val saved = settingsSeal(userId, rawKey, read.version + 1uL, read.text())
        mark.recordSettings(userId, saved.settingsVersion, sealedV2 = true)
        val again = readServedSettings(userId, saved, 8uL, mark) { rawKey }
        assertEquals(8uL, again.version)
        assertTrue(again.contacts.containsKey("u-1"))
        // A document sealed at the old rule's 1 does not open where the server stores it.
        val stale = settingsSeal(userId, rawKey, 1uL, read.text())
        assertThrows(Exception::class.java) { settingsOpen(userId, rawKey, stale.copy(settingsVersion = 8uL)) }
    }

    @Test
    fun noneBelowTheMarkOrAfterAVersionTwoDocumentIsARollback() {
        val mark = SettingsMark(folder.root.resolve("marks"), SettingsMarkTest.keys(7))
        mark.recordSettings(userId, 7uL, sealedV2 = false)
        assertThrows(SettingsRolledBack::class.java) { readServedSettings(userId, null, 5uL, mark) { rawKey } }
        mark.recordSettings(userId, 8uL, sealedV2 = true)
        assertThrows(SettingsRolledBack::class.java) { readServedSettings(userId, null, 8uL, mark) { rawKey } }
    }

    @Test
    fun aSaveHereReadsBackOnTheNextDeviceWithEverythingInIt() {
        val made = settingsKeyCreate(userId, root)
        val document = Settings.parse("""{"version":1,"theme":"dark","contacts":{},"sharing":{"shares":{"n-1":["u-1"]},"links":{}}}""", 4uL)
        document.pin(ContactPin("u-1", "ada@example.org", "Ada", "enc", "sig", "f", "2026-10-01T00:00:00Z", "h", "m", keyVersion = 2uL,
            previousSigningKeys = listOf("sig-0"), keysReplacedAt = "2026-10-02T00:00:00Z"))
        val sealed = settingsSeal(userId, made.key, 5uL, document.text())
        assertEquals(2u, sealed.version)
        // Padded to 1 KiB steps (the server refuses anything else), and sealed under a key the next device opens from the root.
        assertEquals(0, (base64urlDecode(sealed.ciphertext).size - 16) % 1024)
        val key = settingsKeyOpen(userId, root, made.envelope)
        val read = Settings.parse(settingsOpen(userId.lowercase(), key, sealed)!!, sealed.settingsVersion)
        assertEquals("dark", read.json.getString("theme"))
        assertTrue(read.ledger.hasShare("n-1", "u-1"))
        // Read as version 1, always written as version 2: clients from before refuse it whole rather than drop the new fields.
        assertEquals(2, read.json.getInt("version"))
        val pin = read.contacts.getValue("u-1")
        // The version 3 pin's ML-DSA digest survives the save; without it the pin would trust nothing on the next device.
        assertEquals("m", pin.mlDsaPublicKeyHash)
        assertEquals("h", pin.kemPublicKeyHash)
        assertEquals(2uL, pin.keyVersion)
        assertEquals(listOf("sig-0"), pin.previousSigningKeys)
        assertEquals("2026-10-02T00:00:00Z", pin.keysReplacedAt)
        // Sealed for one settings version and account: offered as another, it doesn't open.
        assertThrows(Exception::class.java) { settingsOpen(userId, key, sealed.copy(settingsVersion = 6uL)) }
        assertThrows(Exception::class.java) { settingsOpen("someone-else", key, sealed) }
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
