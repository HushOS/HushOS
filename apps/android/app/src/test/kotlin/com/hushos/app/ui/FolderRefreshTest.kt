package com.hushos.app.ui

import com.hushos.app.data.NodeView
import com.hushos.app.data.Opened
import com.hushos.core.NodeMetadata
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/*
 * Turning off a link or stopping sharing rotates the item's keys. The folder on screen must
 * not be left empty with nobody to reload it (the endless skeleton): every loaded folder keeps
 * its rows and is read again, and a folder on screen that isn't loaded gets loaded.
 */
class FolderRefreshTest {
    private fun item(id: String, parent: String?) = Opened(
        NodeView(id, "ws", parent, "file", 1uL, 1uL, "", 1uL, "", null, null, null, null),
        NodeMetadata(id, null, 10uL, null),
    )

    private val root = "root"
    private val work = "work"
    private val photos = "photos"
    private val folders = mapOf(
        root to listOf(item("a", root)),
        work to listOf(item("report", work)),
        photos to listOf(item("harbour", photos)),
    )

    @Test
    fun everyLoadedFolderKeepsItsRowsWhileKeysChange() {
        // The link was on "report" in Work; the person is looking at Photos.
        val plan = afterAccessChange(folders)
        assertEquals(folders, plan.shown)
        assertTrue(plan.shown.getValue(photos).isNotEmpty())
    }

    @Test
    fun everyLoadedFolderIsReadAgainNotOnlyTheItemsParent() {
        val plan = afterAccessChange(folders)
        assertEquals(setOf(root, work, photos), plan.reload)
    }

    @Test
    fun aFolderOnScreenThatIsNotLoadedIsFetched() {
        assertTrue(needsLoad(photos, folders - photos, loading = emptySet(), failed = emptySet()))
    }

    @Test
    fun aFolderAlreadyLoadingOrLoadedIsNotFetchedTwice() {
        assertFalse(needsLoad(photos, folders - photos, loading = setOf(photos), failed = emptySet()))
        assertFalse(needsLoad(photos, folders, loading = emptySet(), failed = emptySet()))
    }

    @Test
    fun aFolderThatFailedWaitsForTryAgain() {
        // Fetching again on its own would loop; the failed state offers Try again.
        assertFalse(needsLoad(photos, folders - photos, loading = emptySet(), failed = setOf(photos)))
    }
}
