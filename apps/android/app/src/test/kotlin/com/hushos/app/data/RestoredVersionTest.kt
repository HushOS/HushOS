package com.hushos.app.data

import com.hushos.core.NodeMetadata
import com.hushos.core.VersionContext
import com.hushos.core.base64urlEncode
import com.hushos.core.randomBytes
import com.hushos.core.versionSeal
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.Instant

/*
 * After an earlier version is restored, the node's metadata still describes the newer
 * upload (its size and date), while the current version is the older file. Every row,
 * in a folder, a link or the Files app, must show the file as it is now: the size sealed
 * in the current version's envelope, and the restore as its last change. These seal real
 * envelopes with the Rust core built for this machine (the hostCore Gradle task).
 */
class RestoredVersionTest {
    private val ws = "6f1c2b3a-0000-4000-8000-000000000001"
    private val nodeId = "6f1c2b3a-0000-4000-8000-000000000002"
    private val versionId = "6f1c2b3a-0000-4000-8000-000000000003"
    private val objectId = "6f1c2b3a-0000-4000-8000-000000000004"
    private val uploaded = "2026-10-05T01:36:00Z"
    private val restored = "2026-10-05T01:37:00Z"

    /* A file whose current version seals `size` bytes under `nodeKey`. */
    private fun node(nodeKey: ByteArray, size: Long): NodeView {
        val sealed = versionSeal(VersionContext(ws, nodeId, versionId, objectId), nodeKey, randomBytes(32u), size.toULong(), 0u)
        val version = VersionView(versionId, objectId, base64urlEncode(sealed.envelope), "complete", 2u, sealed.layout.chunkCount.toInt(), "", size.toString())
        return NodeView(nodeId, ws, "parent", "file", 1uL, 1uL, "", 1uL, "", version, null, "2026-09-01T10:00:00Z", restored)
    }

    @Test
    fun aRestoredVersionShowsItsOwnSizeAndTheRestoreAsItsDate() {
        val key = randomBytes(32u)
        // The metadata still says 156 KB, uploaded at 01:36; the version now current is 3.9 KB.
        val row = openedRow(node(key, 4_000), NodeMetadata("notes.txt", "text/plain", 160_000uL, uploaded), key)
        assertEquals(4_000L, row.size)
        assertEquals(Instant.parse(restored).toEpochMilli(), row.modifiedMillis)
    }

    @Test
    fun aFileThatWasNeverRestoredKeepsItsOwnDate() {
        val key = randomBytes(32u)
        val row = openedRow(node(key, 4_000), NodeMetadata("notes.txt", "text/plain", 4_000uL, uploaded), key)
        assertEquals(4_000L, row.size)
        // The node changed later (a rename, a move), but the file itself is from its upload.
        assertEquals(Instant.parse(uploaded).toEpochMilli(), row.modifiedMillis)
    }

    @Test
    fun anEnvelopeThatDoesNotOpenGivesNoSize() {
        // Another node's key: nothing is read from the envelope, rather than a guess.
        assertNull(sealedSize(node(randomBytes(32u), 4_000), randomBytes(32u)))
    }

    @Test
    fun anEnvelopeMovedToAnotherVersionDoesNotOpen() {
        val key = randomBytes(32u)
        val moved = node(key, 4_000).let { it.copy(currentVersion = it.currentVersion!!.copy(id = "6f1c2b3a-0000-4000-8000-000000000009")) }
        assertNull(sealedSize(moved, key))
    }
}
