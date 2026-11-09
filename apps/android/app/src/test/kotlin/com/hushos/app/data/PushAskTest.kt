package com.hushos.app.data

import com.hushos.app.data.PushAsk.Mark
import com.hushos.app.data.PushAsk.Permission
import com.hushos.app.data.PushAsk.Step
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

/*
 * Asking once, the decision and the record: each test fails on a question asked twice, a registration made with no
 * question where the person may have said no (to Android, or with the Account switch), a retry taken twice, the switch
 * losing a race with the app's own asking, or a record that outlives the account or reaches another one.
 */
class PushAskTest {
    private val relay = "https://push.hushos.com"
    private val maya = Shared.Session(origin = "https://hushos.com", token = "t1", userId = "U1")
    private val dir: File = Files.createTempDirectory("push-ask").toFile()
    private val record = PushAsk.Record(File(File(dir, "files"), PushAsk.FILE))

    @After
    fun cleanUp() {
        dir.deleteRecursively()
    }

    private fun step(mark: Mark?, permission: Permission, registered: Boolean = false, relay: String? = this.relay, available: Boolean = true) =
        PushAsk.step(available = available, registered = registered, mark = mark, relay = relay, permission = permission)

    @Test
    fun aFirstSignInWhereAndroidHasNotBeenAskedAsks() {
        assertEquals(Step.ASK, step(null, Permission.UNDECIDED))
    }

    @Test
    fun notificationsAllowedAlreadyAreOfferedNeverTurnedOnWithoutATap() {
        // Allowed for the switch then switched off, before a sign-out, or Android before 13: no way to tell, so the app asks.
        assertEquals(Step.OFFER, step(null, Permission.ALLOWED))
        assertEquals(Step.MARK_ONLY, step(null, Permission.DENIED))
    }

    @Test
    fun onceAskedOrDecidedNothingHappensWhateverAndroidSays() {
        for (mark in listOf(Mark.ASKED, Mark.DECIDED))
            for (permission in Permission.entries) assertEquals(Step.NOTHING, step(mark, permission))
    }

    @Test
    fun aYesWhoseRegistrationFailedIsMadeAtTheNextStartWithNoQuestion() {
        assertEquals(Step.REGISTER, step(Mark.RETRY, Permission.ALLOWED))
        assertEquals(Step.MARK_ONLY, step(Mark.RETRY, Permission.UNDECIDED))
        assertEquals(Step.MARK_ONLY, step(Mark.RETRY, Permission.DENIED))
    }

    @Test
    fun aRegisteredPhoneNoRelayOrNoFirebaseMeansNothing() {
        assertEquals(Step.NOTHING, step(null, Permission.UNDECIDED, registered = true))
        assertEquals(Step.NOTHING, step(null, Permission.UNDECIDED, relay = null))
        assertEquals(Step.NOTHING, step(null, Permission.UNDECIDED, available = false))
    }

    @Test
    fun theMarkBelongsToOneAccountOnOneServer() {
        assertTrue(record.set(maya, Mark.ASKED, null))
        assertEquals(Mark.ASKED, record.mark(maya))
        // The same account under another token, and its id in another case, are the same account.
        assertEquals(Mark.ASKED, record.mark(maya.copy(token = "t2", userId = "u1")))
        assertNull(record.mark(maya.copy(userId = "U2")))
        assertNull(record.mark(maya.copy(origin = "https://drive.example")))
    }

    @Test
    fun aSecondRunNeverAsksAgainAndTheSwitchAlwaysWins() {
        assertTrue(record.set(maya, Mark.ASKED, null))
        // Another run that read "nothing asked" before this one marked it doesn't get to ask.
        assertFalse(record.set(maya, Mark.ASKED, null))
        // The switch turned off during the question: a failed registration doesn't leave a retry behind.
        record.decided(maya)
        assertFalse(record.set(maya, Mark.RETRY, Mark.ASKED))
        assertEquals(Mark.DECIDED, record.mark(maya))
    }

    @Test
    fun theSwitchUsedWhileTheSettingsWereReadStopsTheAsk() {
        val read = record.mark(maya)
        record.decided(maya)
        assertFalse(record.set(maya, Mark.ASKED, read))
        assertEquals(Mark.DECIDED, record.mark(maya))
    }

    @Test
    fun aRetryIsTakenOnceSoTwoStartsDoNotBothRegister() {
        record.set(maya, Mark.ASKED, null)
        assertTrue(record.set(maya, Mark.RETRY, Mark.ASKED))
        assertTrue(record.set(maya, Mark.ASKED, Mark.RETRY))
        assertFalse(record.set(maya, Mark.ASKED, Mark.RETRY))
    }

    @Test
    fun signingOutWipesTheRecord() {
        record.set(maya, Mark.ASKED, null)
        assertEquals(Mark.ASKED, record.mark(maya))
        AccountStore(File(dir, "files"), File(dir, "cache"), File(dir, "no_backup")).wipe()
        assertNull(record.mark(maya))
    }
}
