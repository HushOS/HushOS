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
    fun anotherAccountOrIdentityStartsItsOwnCount() {
        mark().record(SettingsMark.key("User-1", "enc-a"), 5uL)
        mark().check(SettingsMark.key("user-2", "enc-a"), null)
        // A reset identity (a new key) is a new count; the same account in other letter case is not.
        mark().check(SettingsMark.key("user-1", "enc-b"), 1uL)
        assertThrows(SettingsRolledBack::class.java) { mark().check(SettingsMark.key("user-1", "enc-a"), 4uL) }
        // The file names neither the account nor its key.
        assertFalse(SettingsMark.key("user-1", "enc-a").contains("user-1"))
    }
}
