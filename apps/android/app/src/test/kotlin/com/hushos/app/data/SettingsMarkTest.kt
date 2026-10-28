package com.hushos.app.data

import com.hushos.core.RollbackMarks
import com.hushos.core.SettingsKeyEnvelope
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/*
 * The server could serve an older settings envelope (bringing back a pin the person replaced, or a ledger with a share
 * they stopped) or none at all, or an identity the account replaced. A device that has seen more refuses less. The
 * marks are sealed under a key from the settings key: what the phone keeps names neither the account nor what it
 * counts, a record that does not open is refused (never read as "nothing seen"), and a mark that could not be kept
 * fails the step it guards.
 */
class SettingsMarkTest {
    @get:Rule val folder = TemporaryFolder()

    private val a = "6b1a3f0e-2c4d-4e5f-8a9b-0c1d2e3f4a5b"
    private val b = "0d4f2a1b-9c8e-4f7a-b6d5-e4c3b2a1f0e9"
    private val dir get() = folder.root.resolve("marks")

    /* A fresh process each time: nothing raised in memory carries over unless the test says so. */
    private fun mark(keys: MarksKeys = keys(7)): SettingsMark {
        SettingsMark.forgetRaised()
        return SettingsMark(dir, keys)
    }

    @After fun forget() = SettingsMark.forgetRaised()

    @Test
    fun anOlderVersionThanSeenIsRefused() {
        mark().recordSettings(a, 7uL, sealedV2 = true)
        assertThrows(SettingsRolledBack::class.java) { mark().checkSettings(a, 6uL, present = true) }
        mark().checkSettings(a, 7uL, present = true)
        mark().checkSettings(a, 8uL, present = true)
    }

    @Test
    fun noSettingsAtAllAfterAVersionTwoDocumentWasSeenIsRefused() {
        mark().checkSettings(a, 0uL, present = false)
        mark().recordSettings(a, 1uL, sealedV2 = true)
        assertThrows(SettingsRolledBack::class.java) { mark().checkSettings(a, 0uL, present = false) }
    }

    @Test
    fun theMarkOnlyRisesIsPerAccountAndIgnoresLetterCase() {
        mark().recordSettings(a.uppercase(), 9uL, sealedV2 = true)
        mark().recordSettings(a, 3uL, sealedV2 = true)
        assertEquals(9uL, mark().read(a).settings)
        assertThrows(SettingsRolledBack::class.java) { mark().checkSettings(a, 8uL, present = true) }
        mark().checkSettings(b, 0uL, present = false)
    }

    @Test
    fun whatIsKeptIsSealedAndNamesNeitherTheAccountNorItsMarks() {
        mark().recordIdentity(a, 3uL, 2u)
        mark().recordSettings(a, 7uL, sealedV2 = true)
        val files = dir.listFiles()!!.filter { it.isFile }
        assertEquals(1, files.size)
        val text = files.single().readText()
        assertFalse(text.contains(a) || text.contains("settings") || text.contains("identity"))
        assertEquals(RollbackMarks(7uL, true, 3uL, 2uL), mark().read(a))
    }

    @Test
    fun aRecordThatDoesNotOpenIsRefusedNeverReadAsNone() {
        mark().recordSettings(a, 7uL, sealedV2 = true)
        // Another settings key, or none served for a record that is there.
        assertThrows(MarksUnreadable::class.java) { mark(keys(8)).checkSettings(a, 1uL, present = true) }
        assertThrows(MarksUnreadable::class.java) { mark { _, _ -> null }.checkSettings(a, 1uL, present = true) }
        // Never sealed over under the other key.
        assertThrows(MarksUnreadable::class.java) { mark(keys(8)).recordSettings(a, 9uL, sealedV2 = true) }
        assertEquals(7uL, mark().read(a).settings)
        // Another account's record in this account's slot, then a damaged one.
        mark().recordSettings(b, 1uL, sealedV2 = false)
        val mine = File(dir, "${com.hushos.core.rollbackMarksSlot(a)}.json")
        File(dir, "${com.hushos.core.rollbackMarksSlot(b)}.json").copyTo(mine, overwrite = true)
        assertThrows(MarksUnreadable::class.java) { mark().read(a) }
        mine.writeText("not a record")
        assertThrows(MarksUnreadable::class.java) { mark().read(a) }
    }

    @Test
    fun nothingKeptReadsAsNoneAndMakesNoSettingsKey() {
        val asked = ArrayList<Boolean>()
        val m = mark { _, create -> asked.add(create); null }
        m.checkSettings(a, 0uL, present = false)
        m.checkIdentity(a, 1uL, 1u)
        m.raise(a, RollbackMarks(0uL, false, 0uL, 0uL))
        assertTrue(asked.isEmpty())
        assertFalse(dir.exists() && dir.listFiles()!!.isNotEmpty())
    }

    /*
     * A mark that could not be kept (no settings key to be had, the server unreachable) fails the step, but still
     * counts in this process: an upgraded identity served as version 1 again is refused here, never upgraded twice.
     */
    @Test
    fun aMarkThatCouldNotBeKeptFailsYetCountsInThisProcessAndLandsWithTheNextWrite() {
        val offline: MarksKeys = { _, _ -> throw AuthFailure("We couldn't reach HushOS.") }
        assertThrows(MarksUnsaved::class.java) { mark(offline).recordIdentity(a, 3uL, 2u) }
        val here = SettingsMark(dir, keys(7))
        assertThrows(IdentityRolledBack::class.java) { here.checkIdentity(a, 3uL, 1u) }
        here.recordSettings(a, 1uL, sealedV2 = false)
        assertEquals(RollbackMarks(1uL, false, 3uL, 2uL), mark().read(a))
    }

    /* A raise still waiting for the settings key when the person signs out writes nothing back after the wipe. */
    @Test
    fun aRaiseThatWaitedThroughASignOutWritesNothingBack() {
        var token: String? = "first"
        val noBackup = folder.root
        val signedIn = SettingsMark(dir, keys(7)) { token }
        signedIn.recordSettings(a, 2uL, sealedV2 = false)
        val waiting = SettingsMark(dir, { kept, create ->
            // Signed out while the key was being fetched: the session goes, then the wipe.
            token = null
            SettingsMark.deleteAll(noBackup)
            keys(7)(kept, create)
        }) { token }
        assertThrows(MarksUnsaved::class.java) { waiting.recordIdentity(a, 3uL, 2u) }
        assertFalse("the marks came back after sign-out", dir.exists())
        // Signed in again: nothing of the last session, in the files or in memory.
        token = "second"
        assertEquals(RollbackMarks(0uL, false, 0uL, 0uL), SettingsMark(dir, keys(7)) { token }.read(a))
    }

    @Test
    fun anOwnIdentityServedBelowWhatWasOpenedOrInTheVersionOneFormIsRefused() {
        mark().checkIdentity(a, 3uL, 1u)
        mark().recordIdentity(a, 3uL, 2u)
        assertThrows(IdentityRolledBack::class.java) { mark().checkIdentity(a, 2uL, 2u) }
        assertThrows(IdentityRolledBack::class.java) { mark().checkIdentity(a, 3uL, 1u) }
        assertThrows(IdentityRolledBack::class.java) { mark().checkIdentity(a, 4uL, 1u) }
        mark().checkIdentity(a, 4uL, 2u)
        mark().checkIdentity(b, 3uL, 1u)
    }

    @Test
    fun noDocumentIsJudgedByTheStoredSequenceServedWithIt() {
        mark().recordSettings(a, 7uL, sealedV2 = false)
        mark().checkSettings(a, 7uL, present = false)
        assertThrows(SettingsRolledBack::class.java) { mark().checkSettings(a, 6uL, present = false) }
        assertThrows(SettingsRolledBack::class.java) { mark().checkSettings(a, 0uL, present = false) }
        mark().recordSettings(a, 8uL, sealedV2 = true)
        assertThrows(SettingsRolledBack::class.java) { mark().checkSettings(a, 9uL, present = false) }
    }

    @Test
    fun plaintextMarksOfEarlierVersionsAreSealedAndRemoved() {
        val legacy = folder.root.resolve(SettingsMark.LEGACY_FILE)
        legacy.writeText(JSONObject()
            .put(SettingsMark.legacyKey(a), 7)
            .put(SettingsMark.legacyV2Key(a), 7)
            .put(SettingsMark.legacyIdentityKey(a), 3)
            .put(SettingsMark.legacyIdentityVersionKey(a), 2)
            .put(SettingsMark.legacyKey(a, "enc-old"), 9)
            .put(SettingsMark.legacyKey(b), 2)
            .toString())
        assertEquals(RollbackMarks(7uL, true, 3uL, 2uL), mark().read(a))
        val left = JSONObject(legacy.readText())
        assertEquals(setOf(SettingsMark.legacyKey(a, "enc-old"), SettingsMark.legacyKey(b)), left.keys().asSequence().toSet())
        // A mark kept per identity moves in once that identity is known: a succession never resets it.
        mark().adopt(a, listOf("enc-old"))
        assertThrows(SettingsRolledBack::class.java) { mark().checkSettings(a, 8uL, present = true) }
    }

    companion object {
        val envelope = SettingsKeyEnvelope("kept-nonce", "kept-ciphertext")
        fun keys(byte: Int): MarksKeys = { _, _ -> MarksKey(ByteArray(32) { byte.toByte() }, envelope) }
    }
}
