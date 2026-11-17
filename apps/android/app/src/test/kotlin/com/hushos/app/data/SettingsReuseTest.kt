package com.hushos.app.data

import android.content.Context
import com.hushos.core.deviceRemember
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.util.UUID

/*
 * One settings read serves the readers that only look (Vault.settingsToLook: a family sync's steps, the contacts list) for
 * a short while, as on the web (lib/contacts.settings-reads.test.ts). Through the real Vault, Auth and marks against
 * FakeDrive: what must never come of it is a copy kept across a guard write or a save, a save built on a copy, a copy
 * older than the marks another vault of this phone raised, or a rollback a fresh read would refuse.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class SettingsReuseTest {
    private val server = FakeDrive()
    private lateinit var vault: Vault
    private lateinit var context: Context

    @Before
    fun signIn() {
        context = RuntimeEnvironment.getApplication()
        Shared::class.java.getDeclaredField("opened").apply { isAccessible = true }
            .set(null, context.getSharedPreferences("settings-reuse-test", Context.MODE_PRIVATE))
        Shared.writeSession(context, Shared.Session(server.origin, server.token, server.userId, "me@example.org"))
        Shared.writeDevice(context, deviceRemember(server.userId, server.accountKey, 1uL, 1uL, UUID.randomUUID().toString()))
        vault = Vault(context, DriveApi(Shared.session(context)!!))
        server.editSettings { it.json.put("marker", "first") }
    }

    @After
    fun close() {
        server.close()
        assertEquals("routes the fake does not serve", emptyList<String>(), server.unknown)
    }

    private fun marker(settings: Settings) = settings.json.optString("marker")
    private fun look() = vault.settingsToLook().first

    /* Readers that only look read once, each with a copy of its own. Fails if every step fetches, or copies are shared. */
    @Test
    fun lookingReadersShareOneReadEachWithItsOwnCopy() {
        val first = look()
        val reads = server.settingsGets.get()
        first.json.put("marker", "changed by one reader")
        assertEquals("first", marker(look()))
        assertEquals("first", marker(look()))
        assertEquals(reads, server.settingsGets.get())
    }

    /*
     * A guard write (here the guard remembering a pin another device saved, with no save of its own) drops the copy: the
     * next look is fetched. Fails if the copy outlives a guard write.
     */
    @Test
    fun aGuardWriteDropsTheCopy() {
        look()
        server.pinGrace()
        val before = vault.memory.generation.get()
        vault.trust()
        assertTrue("the guard was written", vault.memory.generation.get() != before)
        server.editSettings { it.json.put("marker", "after the guard moved") }
        assertEquals("after the guard moved", marker(look()))
    }

    /*
     * A save reads its base now, never the copy: a copy another device has moved past would cost a refused save first.
     * And after it, the copy is gone. Fails if updateSettings builds on the copy, or the copy survives the save.
     */
    @Test
    fun aSaveReadsItsBaseNowAndDropsTheCopy() {
        assertEquals("first", marker(look()))
        server.editSettings { it.json.put("other", "another device") }
        val puts = server.settingsPuts.get()
        vault.updateSettings { it.json.put("mine", "this phone") }
        assertEquals("one save, never refused", puts + 1, server.settingsPuts.get())
        server.editSettings { it.json.put("marker", "after the save") }
        val looked = look()
        assertEquals("after the save", marker(looked))
        assertEquals("another device", looked.json.optString("other"))
        assertEquals("this phone", looked.json.optString("mine"))
    }

    /* Later settings another vault of this phone read (the Files app's, a transfer's) are met at once, by the marks. */
    @Test
    fun anotherVaultsLaterReadIsMetByTheMarks() {
        look()
        server.editSettings { it.json.put("marker", "read elsewhere") }
        Vault(context, DriveApi(Shared.session(context)!!)).loadSettings()
        val reads = server.settingsGets.get()
        assertEquals("read elsewhere", marker(look()))
        assertEquals(reads + 1, server.settingsGets.get())
    }

    /* A rollback: a fresh read refuses it, and then no reader goes on with the copy. Fails if the copy hides the refusal. */
    @Test
    fun aRollbackIsRefusedByAFreshReadAndNoCopyOutlivesIt() {
        val older = server.settingsSnapshot()
        server.editSettings { it.json.put("marker", "newer") }
        assertEquals("newer", marker(look()))
        older()
        // Within the window a looking reader is never handed the older copy.
        assertEquals("newer", marker(look()))
        assertThrows(SettingsRolledBack::class.java) { vault.loadSettings() }
        assertThrows(SettingsRolledBack::class.java) { look() }
    }

    /* Past the window the settings are read again. */
    @Test
    fun theCopyEndsWithItsWindow() {
        var now = 1_000_000L
        vault.memory.clock = { now }
        look()
        server.editSettings { it.json.put("marker", "later") }
        now += Vault.SETTINGS_REUSE_MS
        assertEquals("later", marker(look()))
        assertFalse(server.settingsGets.get() < 2)
    }
}
