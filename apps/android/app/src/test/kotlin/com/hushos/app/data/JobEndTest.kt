package com.hushos.app.data

import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/*
 * A transfer cancelled in the app (or stopped when its network went) must neither go on to say "uploaded" nor be
 * recorded as a failure after Cancel removed its copy. These play out an upload of five parts whose job is stopped
 * after the second, with the progress callback calling checkStop as the workers do.
 */
class JobEndTest {
    private class Upload(val stopAfter: Int?) {
        var stopped = false
        val sent = ArrayList<Int>()
        var completed = false

        fun run(checkStop: () -> Unit, failOnStop: Boolean = false) {
            for (part in 1..5) {
                if (stopped && failOnStop) throw IOException("Socket closed")
                sent.add(part)
                if (part == stopAfter) stopped = true
                checkStop()
            }
            completed = true
        }
    }

    @Test
    fun aStopMidUploadAbandonsTheRestAndIsNeitherDoneNorFailed() {
        val upload = Upload(stopAfter = 2)
        val end = stoppable({ upload.stopped }) { checkStop -> upload.run(checkStop) }
        assertEquals(JobEnd.Stopped, end)
        assertEquals(listOf(1, 2), upload.sent)
        assertFalse(upload.completed)
    }

    @Test
    fun aStopThatBreaksTheConnectionIsStillAStopNotAFailure() {
        val upload = Upload(stopAfter = 2)
        // The stop closes the socket before the next check: the part fails with an IOException.
        val end = stoppable({ upload.stopped }) { _ -> upload.run({}, failOnStop = true) }
        assertEquals(JobEnd.Stopped, end)
    }

    @Test
    fun workThatEndsAfterTheStopDoesNotCountAsDone() {
        var stopped = false
        val end = stoppable({ stopped }) { _ -> stopped = true; "node" }
        assertEquals(JobEnd.Stopped, end)
    }

    @Test
    fun anUnstoppedJobFinishesOrFailsAsBefore() {
        val upload = Upload(stopAfter = null)
        assertEquals(JobEnd.Done(Unit), stoppable({ false }) { checkStop -> upload.run(checkStop) })
        assertTrue(upload.completed)
        val refused = ApiError(500, "boom")
        assertEquals(JobEnd.Failed(refused), stoppable({ false }) { _ -> throw refused })
    }

    /* Keeping a folder records a file's failure and carries on, unless the failure ends the job: a stop does. */
    @Test
    fun aStopEndsAKeptFolderRatherThanFailingOneOfItsFiles() {
        assertTrue(KeepRules.failsTheJob(JobStopped()))
        assertFalse(KeepRules.failsTheJob(IOException("disk")))
    }
}
