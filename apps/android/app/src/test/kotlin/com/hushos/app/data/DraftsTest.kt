package com.hushos.app.data

import com.hushos.core.Draft
import com.hushos.core.DraftFrame
import com.hushos.core.DraftOffer
import com.hushos.core.DraftSelection
import com.hushos.core.LineEnding
import com.hushos.core.TextEncoding
import com.hushos.core.TextFormat
import com.hushos.core.draftLimits
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.File
import java.nio.file.Files
import java.util.Locale
import java.util.TimeZone

/*
 * Drafts on the phone (data/Drafts.kt): the store keeps only sealed records, within the caps, and drops what can never be
 * shown; a write asked for before a sign-out's wipe keeps nothing; the restore decision follows the version the text started
 * from; a write turn writes only editable, answered text and removes the draft back at the baseline. The wipe itself is
 * AccountStoreTest's (drafts/ is one of the account's files).
 */
@RunWith(RobolectricTestRunner::class)
class DraftsTest {
    private val key = ByteArray(32) { (it + 1).toByte() }
    private val place = DraftPlace("6b1a3f0e-2c4d-4e5f-8a9b-0c1d2e3f4a5b", "0d4f2a1b-9c8e-4f7a-b6d5-e4c3b2a1f0e9", "5f0c1d2e-3a4b-4c5d-9e6f-7a8b9c0d1e2f")
    private val base = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
    private val other = "1c2d3e4f-5a6b-4c7d-8e9f-a0b1c2d3e4f5"
    private val now = 1_763_650_440_000L
    private lateinit var folder: File

    @Before
    fun setUp() {
        folder = File(Files.createTempDirectory("drafts").toFile(), DraftStore.DIR)
    }

    private fun store(at: Long = now) = DraftStore(folder) { at }

    private fun draft(text: String, savedAt: Long = now) =
        Draft(DraftFrame(base, TextFormat(TextEncoding.UTF8, LineEnding.LF, false), savedAt.toULong()), text, DraftSelection(2u, 4u), base)

    private fun node(n: Int) = place.copy(nodeId = "5f0c1d2e-3a4b-4c5d-9e6f-%012d".format(n))

    private fun everything() = folder.walkTopDown().filter { it.isFile }.joinToString("\n") { it.readText() }
    private fun records() = folder.walkTopDown().filter { it.isFile && it.name.endsWith(".json") }.toList()

    @Test
    fun keepsOnlyCiphertextAndGivesTheTextBackToTheSameAccountAndFile() {
        assertTrue(store().write(draft("draft canary"), place, key))
        assertFalse(everything().contains("canary"))
        // Nothing that names the file: no node id, no workspace id, no version id.
        assertFalse(everything().contains(place.nodeId))
        assertFalse(everything().contains(base))
        assertFalse(records().any { it.path.contains(place.workspaceId) || it.path.contains(place.nodeId) })
        val read = store().read(place, key).draft!!
        assertEquals("draft canary", read.text)
        assertEquals(DraftSelection(2u, 4u), read.selection)
        assertEquals(base, read.frame.baseVersionId)
        assertNull(store().read(node(9), key).draft)
        assertNull(store().read(place, ByteArray(32) { 9 }).draft)
    }

    @Test
    fun oneDraftPerFileTheLastWriteWins() {
        store().write(draft("first"), place, key)
        store().write(draft("second", now + 1), place, key)
        assertEquals("second", store().read(place, key).draft!!.text)
        assertEquals(1, store().count)
    }

    @Test
    fun aChangedRecordIsDeletedNeverOffered() {
        store().write(draft("mine"), place, key)
        val file = records().single()
        // Another time beside the same sealed text: the associated data no longer holds.
        file.writeText(file.readText().replace(now.toString(), (now - 1).toString()))
        assertNull(store().read(place, key).draft)
        assertEquals(0, store().count)
    }

    @Test
    fun thirtyDaysOldIsOfferedAndAMillisecondMoreIsDropped() {
        val limit = draftLimits().maxAgeMs.toLong()
        store().write(draft("edge", now - limit), node(1), key)
        store().write(draft("past", now - limit - 1), node(2), key)
        assertEquals("edge", store().read(node(1), key).draft?.text)
        assertNull(store().read(node(2), key).draft)
        assertEquals(1, store().count)
    }

    @Test
    fun fiftyAtMostTheOldestGoFirst() {
        for (n in 0 until 50) store().write(draft("d$n", now - 50_000 + n), node(n), key)
        assertEquals(50, store().count)
        store().write(draft("newest"), node(50), key)
        assertEquals(50, store().count)
        assertNull(store().read(node(0), key).draft)
        assertEquals("d1", store().read(node(1), key).draft?.text)
        assertEquals("newest", store().read(node(50), key).draft?.text)
    }

    @Test
    fun textPastTheLimitOrWithHalfACharacterIsNotKeptAndTheLastDraftStays() {
        store().write(draft("kept"), place, key)
        assertFalse(store().write(draft("a".repeat(draftLimits().textBytes.toInt() + 1)), place, key))
        assertFalse(store().write(draft("half \uD83E"), place, key))
        assertEquals("kept", store().read(place, key).draft?.text)
    }

    @Test
    fun aFailedWriteEvictsNothingAndLeavesNoPartialBehind() {
        for (n in 0 until 50) store().write(draft("d$n", now - 50_000 + n), node(n), key)
        assertFalse(store().write(draft("a".repeat(draftLimits().textBytes.toInt() + 1)), node(60), key))
        assertEquals(50, store().count)
        assertEquals("d0", store().read(node(0), key).draft?.text)
        // A write a kill left half done: swept, never counted or kept.
        val partial = File(records().first().parentFile, "left.json.partial").apply { writeText("half") }
        store().read(node(1), key).draft
        assertFalse(partial.exists())
    }

    @Test
    fun theCapsGoByTheFilesDatesNeverByReadingThem() {
        for (n in 0 until 50) store().write(draft("d$n", now - 50_000 + n), node(n), key)
        // A record that doesn't parse, dated now: not "unreadable, so dropped" (the oldest goes instead).
        val odd = File(records().first().parentFile, "odd.json").apply { writeText("not a record"); setLastModified(now) }
        store().write(draft("newest"), node(50), key)
        assertTrue(odd.exists())
        assertNull(store().read(node(0), key).draft)
        assertNull(store().read(node(1), key).draft)
    }

    @Test
    fun aFamilysRemovalDeletesItsDraftsUnopenedAndNoOthers() {
        val family = "2c2c2c2c-0000-4000-8000-000000000002"
        store().write(draft("family"), place.copy(workspaceId = family), key)
        store().write(draft("mine"), place, key)
        store().removeWorkspace(place.userId, family, key)
        assertNull(store().read(place.copy(workspaceId = family), key).draft)
        assertEquals("mine", store().read(place, key).draft?.text)
    }

    @Test
    fun aCopyOfARestoredDraftFromAnotherVersionIsReSealedNeverVouchedFor() {
        val verified = SaveSource.OfFile(com.hushos.core.Integrity.VERIFIED, com.hushos.core.Integrity.VERIFIED)
        val vouched = SaveRuns.signing(SaveSources.From(listOf(verified)))
        val restored = SaveRuns.signing(SaveSources.From(listOf(verified.contentUnknown())))
        assertEquals(com.hushos.core.Integrity.RESEALED, restored?.version)
        assertTrue(vouched?.version != restored?.version)
        // The name record still checks: only the content is unknown.
        assertEquals(vouched?.metadata, restored?.metadata)
    }

    @Test
    fun textRestoredFromAnotherVersionNeverWearsTheReadVersionsCleanMark() {
        assertEquals(com.hushos.core.Integrity.UNCHECKED, Unverified.overRestored(null, contentUnknown = true)?.integrity)
        val marked = Unverified(com.hushos.core.Integrity.UNKNOWN_SIGNER, null, Writer.Unknown(null))
        assertEquals(marked, Unverified.overRestored(marked, contentUnknown = true))
        assertNull(Unverified.overRestored(null, contentUnknown = false))
    }

    @Test
    fun aWriteAskedForBeforeASignOutsWipeKeepsNothing() {
        store().write(draft("before"), place, key)
        val asked = store().generation
        DraftStore.deleteAll(folder.parentFile!!)
        assertEquals(0, store().count)
        assertFalse(store().write(draft("late"), place, key, asked))
        assertEquals(0, store().count)
        // Asked after the wipe: kept.
        assertTrue(store().write(draft("after"), place, key))
    }

    @Test
    fun theRestoreFollowsTheVersionTheTextStartedFrom() {
        val mine = draft("mine")
        assertEquals(DraftOffer.CURRENT, DraftRules.offer(mine, base, "theirs"))
        assertEquals(DraftOffer.STALE, DraftRules.offer(mine, other, "theirs"))
        assertEquals(DraftOffer.STALE, DraftRules.offer(mine, null, "theirs"))
        assertEquals(DraftOffer.SAME, DraftRules.offer(mine, other, "mine"))
    }

    @Test
    fun aTurnWritesOnlyEditableAnsweredTextAndAsksForARemovalAtTheBaseline() {
        assertEquals(DraftRules.Step.NONE, DraftRules.step(editable = false, offering = false, unread = false, startedFrom = base, atBaseline = false))
        assertEquals(DraftRules.Step.NONE, DraftRules.step(editable = true, offering = true, unread = false, startedFrom = base, atBaseline = false))
        // A lookup that couldn't answer: nothing is written over the draft it may have missed.
        assertEquals(DraftRules.Step.NONE, DraftRules.step(editable = true, offering = false, unread = true, startedFrom = base, atBaseline = false))
        assertEquals(DraftRules.Step.NONE, DraftRules.step(editable = true, offering = false, unread = false, startedFrom = null, atBaseline = false))
        assertEquals(DraftRules.Step.REMOVE, DraftRules.step(editable = true, offering = false, unread = false, startedFrom = base, atBaseline = true))
        assertEquals(DraftRules.Step.WRITE, DraftRules.step(editable = true, offering = false, unread = false, startedFrom = base, atBaseline = false))
    }

    @Test
    fun aDraftThatCantBeReadNowIsNoAnswerNeverNoneAndStays() {
        store().write(draft("unread"), place, key)
        val record = records().single()
        val kept = record.readText()
        // Not readable now (a directory where the record was stands in for an I/O failure).
        record.delete()
        record.mkdirs()
        assertTrue(store().read(place, key) is DraftLookup.Unavailable)
        record.delete()
        record.writeText(kept)
        assertEquals("unread", store().read(place, key).draft?.text)
        assertTrue(store().read(node(9), key) is DraftLookup.Absent)
    }

    @Test
    fun saysTheTimeTodayAndTheDateOnAnotherDay() {
        val utc = TimeZone.getTimeZone("UTC")
        val at = 1_763_648_040_000L // 2025-11-20 14:14 UTC
        val clean = { s: String -> s.replace(Regex("[\\u00A0\\u202F]"), " ") }
        assertEquals("2:14 PM", clean(DraftRules.whenSaved(at, 1_763_660_000_000L, Locale.US, utc)))
        // The date's own pattern is the system's (ICU's "MMM d" on a phone; Robolectric's has no space): its parts and the time.
        val otherDay = clean(DraftRules.whenSaved(at, 1_763_740_000_000L, Locale.US, utc))
        assertTrue(otherDay, otherDay.startsWith("Nov") && otherDay.contains("20") && otherDay.endsWith(", 2:14 PM"))
        assertFalse(otherDay, otherDay.contains("2025"))
        val lastYear = clean(DraftRules.whenSaved(at, 1_795_000_000_000L, Locale.US, utc))
        assertTrue(lastYear, lastYear.contains("2025") && lastYear.endsWith(", 2:14 PM"))
    }
}
