package com.hushos.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/*
 * The server could serve an older settings envelope (bringing back a pin the person replaced, or a
 * ledger with a share they stopped) or none at all. A device that has seen version n refuses less.
 */
class SettingsMarkTest {
    @get:Rule val folder = TemporaryFolder()

    private fun mark() = SettingsMark(folder.root.resolve("settings-seen.json"))

    @Test
    fun anOlderVersionThanSeenIsRefused() {
        mark().recordSettings("a", 7uL, sealedV2 = true)
        assertThrows(SettingsRolledBack::class.java) { mark().checkSettings("a", 6uL, present = true) }
        mark().checkSettings("a", 7uL, present = true)
        mark().checkSettings("a", 8uL, present = true)
    }

    @Test
    fun noSettingsAtAllAfterAVersionTwoDocumentWasSeenIsRefused() {
        mark().checkSettings("a", 0uL, present = false)
        mark().recordSettings("a", 1uL, sealedV2 = true)
        assertThrows(SettingsRolledBack::class.java) { mark().checkSettings("a", 0uL, present = false) }
    }

    @Test
    fun theMarkOnlyRisesAndSurvivesANewInstance() {
        mark().recordSettings("a", 9uL, sealedV2 = true)
        mark().recordSettings("a", 3uL, sealedV2 = true)
        assertEquals(9uL, mark().seen(SettingsMark.key("a")))
        assertThrows(SettingsRolledBack::class.java) { mark().checkSettings("a", 8uL, present = true) }
    }

    @Test
    fun theMarkIsPerAccountSoASuccessionNeitherResetsNorSplitsIt() {
        mark().recordSettings("User-1", 5uL, sealedV2 = true)
        // Another account has its own count; the same account in other letter case does not.
        mark().checkSettings("user-2", 0uL, present = false)
        assertThrows(SettingsRolledBack::class.java) { mark().checkSettings("user-1", 4uL, present = true) }
        // The key names no identity: after the account replaced its sharing keys the same mark still refuses less.
        assertEquals(5uL, mark().settingsSeen("user-1", "enc-after-succession"))
        assertThrows(SettingsRolledBack::class.java) { mark().checkSettings("user-1", 4uL, present = true) }
        // The file names neither the account nor its key.
        assertFalse(SettingsMark.key("user-1").contains("user-1"))
    }

    @Test
    fun aMarkAnEarlierAppKeptPerIdentityCarriesOverAndNeverLowersTheAccountsOwn() {
        mark().record(SettingsMark.legacyKey("user-1", "enc-a"), 9uL)
        assertEquals(9uL, mark().settingsSeen("user-1", "enc-a"))
        assertThrows(SettingsRolledBack::class.java) { mark().checkSettings("user-1", 8uL, present = true) }
        // A lower legacy count (another identity's) doesn't pull the account's mark down.
        mark().record(SettingsMark.legacyKey("user-1", "enc-b"), 2uL)
        assertEquals(9uL, mark().settingsSeen("user-1", "enc-b"))
    }

    @Test
    fun anOwnIdentityServedAtALowerKeyVersionThanOpenedBeforeIsRefused() {
        mark().checkIdentity("user-1", 1uL)
        mark().recordIdentity("user-1", 3uL)
        assertThrows(IdentityRolledBack::class.java) { mark().checkIdentity("user-1", 2uL) }
        // The same or a later identity opens; the mark only rises, and outlives a new instance (a sign-in again).
        mark().checkIdentity("USER-1", 3uL)
        mark().recordIdentity("user-1", 4uL)
        mark().recordIdentity("user-1", 2uL)
        assertThrows(IdentityRolledBack::class.java) { mark().checkIdentity("user-1", 3uL) }
        // Another account's identity has its own mark, and the settings mark is a separate count.
        mark().checkIdentity("user-2", 1uL)
        mark().checkSettings("user-1", 0uL, present = false)
    }

    @Test
    fun noDocumentIsJudgedByTheStoredSequenceServedWithIt() {
        // This device saw the account's old version 1 document at sequence 7; the server now serves that row as none, at 7.
        mark().recordSettings("user-1", 7uL, sealedV2 = false)
        mark().checkSettings("user-1", 7uL, present = false)
        // None at a lower sequence (or with no row at all) is a rollback.
        assertThrows(SettingsRolledBack::class.java) { mark().checkSettings("user-1", 6uL, present = false) }
        assertThrows(SettingsRolledBack::class.java) { mark().checkSettings("user-1", 0uL, present = false) }
        // Once a version 2 document was seen, none is never a version 1 row: refused at any sequence.
        mark().recordSettings("user-1", 8uL, sealedV2 = true)
        assertThrows(SettingsRolledBack::class.java) { mark().checkSettings("user-1", 9uL, present = false) }
        assertThrows(SettingsRolledBack::class.java) { mark().checkSettings("user-1", 7uL, present = true) }
    }
}
