package com.hushos.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.util.UUID

/*
 * WorkManager keeps a job's input, tags and output in its own SQLite file, which outlives a pruned job in free pages and
 * which sign-out can't empty. So no job carries the name of a file or folder: the app keeps names itself (JobNames, an
 * account file), and drops each once its job is gone.
 */
class JobNamesTest {
    @get:Rule val folder = TemporaryFolder()
    private val name = "Biopsy results.png"

    private fun carries(values: Collection<Any?>, tags: Set<String>) =
        values.any { it?.toString()?.contains("Biopsy") == true } || tags.any { it.contains("Biopsy") }

    @Test
    fun noTransferJobCarriesAName() {
        val file = folder.newFolder("queue", "job").resolve("content")
        val upload = TransferQueue.uploadRequest(UUID.randomUUID(), file, "image/png", "folder-id", null)
        assertFalse(carries(upload.workSpec.input.keyValueMap.values, upload.tags))
        val keep = TransferQueue.keepRequest("node-id", folder = true, shareRoot = null)
        assertFalse(carries(keep.workSpec.input.keyValueMap.values, keep.tags))
        // The file the upload sends is named by the job, not the file.
        assertFalse(file.path.contains("Biopsy"))
    }

    @Test
    fun aNameStaysWhileItsJobDoesAndGoesAfter() {
        var now = 0L
        val names = JobNames(folder.root.resolve(JobNames.FILE)) { now }
        names.put("a", name)
        names.put("b", "Lisbon")
        // A job queued after the listing was taken is kept for a while, then dropped once WorkManager no longer has it.
        names.retain(setOf("a"))
        assertEquals("Lisbon", names.get("b"))
        now += 11 * 60 * 1000
        names.retain(setOf("a"))
        assertEquals(name, names.get("a"))
        assertNull(names.get("b"))
        names.retain(emptySet())
        assertEquals(emptyMap<String, String>(), names.all())
    }
}
