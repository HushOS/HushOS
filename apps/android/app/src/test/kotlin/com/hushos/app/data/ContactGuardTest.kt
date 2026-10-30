package com.hushos.app.data

import com.hushos.core.GuardEntry
import com.hushos.core.base64urlDecode
import com.hushos.core.base64urlEncode
import com.hushos.core.guardEntryNext
import com.hushos.core.settingsKeyCreate
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.concurrent.atomic.AtomicInteger

/*
 * The contact guard on disk (docs/optional-verification.md 2.8): one sealed record per account, opened only under the
 * settings key it was sealed under, written only over the revision it read, never read as "nothing recorded" when it is
 * there and won't open, and gone at sign-out with no write from before it coming back.
 */
class ContactGuardTest {
    private val account = WebFixture.json.getJSONObject("workspace")
    private val userId = account.getString("userId")
    private val accountKey = base64urlDecode(account.getString("accountKey"))
    private val folder = File(Files.createTempDirectory("guard").toFile(), ContactGuard.FOLDER)
    private val keyA = settingsKeyCreate(userId, accountKey).let { MarksKey(it.key, it.envelope) }
    private val keyB = settingsKeyCreate(userId, accountKey).let { MarksKey(it.key, it.envelope) }

    private fun guard(key: MarksKey?, signedIn: () -> Boolean = { true }) = ContactGuard(folder, "https://hushos.test", userId, { key }, signedIn)

    /* Grace's keys as a first-seen pin holds them, and the guard entry this device writes for them. */
    private val grace = "7d1e5c2a-3b4f-4a6e-9c8d-1f2e3d4c5b6a"
    private val pin = TestPins.verified(grace, "grace@example.org", "Grace", base64urlEncode(ByteArray(32) { 1 }), base64urlEncode(ByteArray(32) { 2 }))
        .copy(fingerprint = "")
    private val first: GuardEntry = guardEntryNext(null, pin.keys)
    private val other: GuardEntry = guardEntryNext(null, pin.copy(signingPublicKey = base64urlEncode(ByteArray(32) { 5 })).keys)

    @Test
    fun theRecordIsCiphertextThatOpensOnlyUnderItsOwnSettingsKeyAndIsNeverWrittenOverUnderAnother() {
        guard(keyA).commit(grace, first, over = 0uL)
        val bytes = guard(keyA).file.readBytes()
        val text = String(bytes)
        // Neither whom it is about nor their keys, nor whose account it is: the file name is a keyed slot.
        for (secret in listOf(grace, pin.encryptionPublicKey, pin.signingPublicKey, pin.mlDsaPublicKeyHash!!, userId)) assertFalse(secret, text.contains(secret))
        assertFalse(guard(keyA).file.name.contains(userId))
        assertEquals(first, guard(keyA).entry(grace))
        // Sealed under another settings key (the server served a new one): everyone pauses, nobody starts over.
        assertThrows(GuardUnreadable::class.java) { guard(keyB).entry(grace) }
        assertThrows(GuardUnreadable::class.java) { guard(keyB).putPending(grace, PendingAct("t", 1uL, "now", 3uL)) }
        assertArrayEquals(bytes, guard(keyA).file.readBytes())
        // No settings key to be had at all is unreadable too, never empty.
        assertThrows(GuardUnreadable::class.java) { guard(null).record() }
    }

    @Test
    fun aDamagedRecordIsUnreadableNeverNothingRecorded() {
        guard(keyA).commit(grace, first, over = 0uL)
        val file = guard(keyA).file
        val sealed = org.json.JSONObject(file.readText())
        val record = base64urlDecode(sealed.getString("record")).also { it[it.size - 1] = (it[it.size - 1].toInt() xor 1).toByte() }
        file.writeText(sealed.put("record", base64urlEncode(record)).toString())
        assertThrows(GuardUnreadable::class.java) { guard(keyA).entry(grace) }
        file.writeText("not a guard")
        assertThrows(GuardUnreadable::class.java) { guard(keyA).record() }
        // Nothing there at all is first use.
        file.delete()
        assertNull(guard(keyA).entry(grace))
    }

    @Test
    fun aWriteLandsOnlyOverTheRevisionItReadAndAStaleOneIsRacedAndChangesNothing() {
        guard(keyA).commit(grace, first, over = 0uL)
        // Another writer read "nothing stored" before this one committed: it must not put an older entry back.
        assertThrows(GuardRaced::class.java) { guard(keyA).commit(grace, other, over = 0uL) }
        assertEquals(first, guard(keyA).entry(grace))
        val next = guardEntryNext(first, other.keys)
        guard(keyA).commit(grace, next, over = first.revision)
        assertEquals(2uL, guard(keyA).entry(grace)!!.revision)
        assertThrows(GuardRaced::class.java) { guard(keyA).commit(grace, first, over = first.revision) }
    }

    @Test
    fun aCommitDropsThePendingActUnlessToldToKeepItAtTheNewRevision() {
        val act = PendingAct("target", 0uL, "2026-10-30T00:00:00Z", 4uL)
        guard(keyA).putPending(grace, act)
        guard(keyA).commit(grace, first, over = 0uL, keep = act)
        assertEquals(act.copy(revision = first.revision), guard(keyA).pending(grace))
        guard(keyA).commit(grace, guardEntryNext(first, other.keys), over = first.revision)
        assertNull(guard(keyA).pending(grace))
    }

    @Test
    fun signOutDeletesEveryRecordAndAWriteBegunBeforeItWritesNothingBack() {
        guard(keyA).commit(grace, first, over = 0uL)
        val noBackup = folder.parentFile!!
        ContactGuard.deleteAll(noBackup)
        assertFalse(folder.exists())
        // A write that read its generation, then waited while the sign-out ran: it keeps nothing.
        var asked = 0
        val waiting = guard(keyA) { if (asked++ == 0) ContactGuard.deleteAll(noBackup); true }
        assertThrows(GuardUnsaved::class.java) { waiting.commit(grace, first, over = 0uL) }
        assertFalse(waiting.file.exists())
        // A session no longer stored writes nothing either.
        assertThrows(GuardUnsaved::class.java) { guard(keyA) { false }.commit(grace, first, over = 0uL) }
        assertFalse(waiting.file.exists())
    }

    @Test
    fun theShareSheetLooksAtMostThreePeopleUpAtOnceAndAFailureIsSaidNeverReadAsUnchanged() = runBlocking {
        val running = AtomicInteger()
        val most = AtomicInteger()
        val people = (1..7).map { pin.copy(userId = "person-$it") }
        val (changed, failure) = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
            ShareeChecks.changed(people) { person ->
                val now = running.incrementAndGet()
                most.updateAndGet { maxOf(it, now) }
                Thread.sleep(60)
                running.decrementAndGet()
                when (person.userId) {
                    "person-2" -> true
                    "person-5" -> throw java.io.IOException("lookup failed")
                    else -> false
                }
            }
        }
        assertEquals(setOf("person-2"), changed)
        assertTrue(failure is java.io.IOException)
        assertTrue("ran ${most.get()} at once", most.get() in 2..3)
    }
}
