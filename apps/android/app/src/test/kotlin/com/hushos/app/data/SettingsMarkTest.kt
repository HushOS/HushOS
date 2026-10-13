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
        mark().record("a", 7uL)
        assertThrows(SettingsRolledBack::class.java) { mark().check("a", 6uL) }
        mark().check("a", 7uL)
        mark().check("a", 8uL)
    }

    @Test
    fun noSettingsAtAllAfterSomeWereSeenIsRefused() {
        mark().check("a", null)
        mark().record("a", 1uL)
        assertThrows(SettingsRolledBack::class.java) { mark().check("a", null) }
    }

    @Test
    fun theMarkOnlyRisesAndSurvivesANewInstance() {
        mark().record("a", 9uL)
        mark().record("a", 3uL)
        assertEquals(9uL, mark().seen("a"))
        assertThrows(SettingsRolledBack::class.java) { mark().check("a", 8uL) }
    }

    @Test
    fun theMarkIsPerAccountSoASuccessionNeitherResetsNorSplitsIt() {
        mark().record(SettingsMark.key("User-1"), 5uL)
        // Another account has its own count; the same account in other letter case does not.
        mark().check(SettingsMark.key("user-2"), null)
        assertThrows(SettingsRolledBack::class.java) { mark().check(SettingsMark.key("user-1"), 4uL) }
        // The key names no identity: after the account replaced its sharing keys the same mark still refuses less.
        assertEquals(5uL, mark().settingsSeen("user-1", "enc-after-succession"))
        assertThrows(SettingsRolledBack::class.java) { mark().check(SettingsMark.key("user-1"), 4uL) }
        // The file names neither the account nor its key.
        assertFalse(SettingsMark.key("user-1").contains("user-1"))
    }

    @Test
    fun aMarkAnEarlierAppKeptPerIdentityCarriesOverAndNeverLowersTheAccountsOwn() {
        mark().record(SettingsMark.legacyKey("user-1", "enc-a"), 9uL)
        assertEquals(9uL, mark().settingsSeen("user-1", "enc-a"))
        assertThrows(SettingsRolledBack::class.java) { mark().check(SettingsMark.key("user-1"), 8uL) }
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
        mark().check(SettingsMark.key("user-1"), null)
    }
}
