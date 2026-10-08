package com.hushos.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files

/*
 * A failed transfer stays on the app's own record, whatever WorkManager prunes, until it is
 * retried, made room for (which sends it again) or removed; it goes with the account.
 */
class FailedTransfersTest {
    private lateinit var files: File
    private lateinit var record: FailedTransfers
    private lateinit var staged: File

    @Before
    fun setUp() {
        files = Files.createTempDirectory("failed").toFile()
        record = FailedTransfers(File(files, FailedTransfers.FILE))
        staged = File(files, "queue/job-1/content").also { it.parentFile!!.mkdirs(); it.writeText("the file") }
    }

    private fun upload(id: String, reason: String = TransferQueue.NO_ROOM) = FailedTransfer(
        id, TransferQueue.UPLOAD, "Board pack, v7 final.pdf", reason, 1_000L, staged.path, "application/pdf", "folder-1", null,
    )

    @Test
    fun aFailureIsKeptWithWhatRetryNeedsAcrossReads() {
        record.record(upload("job-1"))
        // A fresh reader (another launch, after a reboot) sees the same failure and can send it again.
        val again = FailedTransfers(File(files, FailedTransfers.FILE)).all().single()
        assertEquals(upload("job-1"), again)
        assertFalse(again.sourceGone())
    }

    @Test
    fun retriedMadeRoomForOrRemovedTakesItOffTheList() {
        record.record(upload("job-1"))
        record.record(upload("job-2", "Couldn’t reach HushOS."))
        record.forget("job-1")
        assertEquals(listOf("job-2"), record.all().map { it.id })
        record.forget("job-2")
        assertTrue(record.all().isEmpty())
    }

    @Test
    fun recordingTheSameJobAgainReplacesIt() {
        record.record(upload("job-1"))
        record.record(upload("job-1", "Couldn’t reach HushOS."))
        assertEquals("Couldn’t reach HushOS.", record.all().single().reason)
    }

    @Test
    fun anUploadWhoseCopyIsGoneAsksForTheFileAgain() {
        record.record(upload("job-1"))
        staged.delete()
        assertTrue(record.all().single().sourceGone())
    }

    @Test
    fun namesAndReasonsWithTabsOrNewlinesSurvive() {
        val odd = upload("job-1").copy(name = "a\tb\nc.txt", reason = "line one\nline two")
        record.record(odd)
        assertEquals(odd, record.all().single())
    }

    @Test
    fun theRecordGoesWithTheAccount() {
        val store = AccountStore(files, File(files, "cache"))
        store.claim("alice")
        record.record(upload("job-1"))
        store.claim("bob")
        assertTrue(record.all().isEmpty())
        assertFalse(File(files, FailedTransfers.FILE).exists())
    }
}
