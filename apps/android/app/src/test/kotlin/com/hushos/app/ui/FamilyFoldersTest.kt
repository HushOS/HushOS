package com.hushos.app.ui

import com.hushos.app.data.NodeView
import com.hushos.app.data.Opened
import com.hushos.core.NodeMetadata
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/*
 * Which folders a family's removal is said in (#244's lessons): its top folders, the folders listed inside it (nested
 * ones included), folders an earlier clear already took off screen, and no file ever kept as a folder. Each case is one a
 * person would see go wrong: a nested folder or one cleared by an earlier refusal reading as an empty folder instead of
 * "You're not in this family".
 */
class FamilyFoldersTest {
    private val group = "0a1b2c3d-0000-4000-8000-0000000000a1"
    private val area = "0a1b2c3d-0000-4000-8000-0000000000b1"
    private val own = "0a1b2c3d-0000-4000-8000-0000000000c1"

    private fun row(id: String, workspace: String = area, folder: Boolean = true) =
        Opened(NodeView(id, workspace, "parent", if (folder) "folder" else "file", 1uL, 1uL, "", 1uL, "", null, null, null, null), NodeMetadata(id, null, null, null, emptyMap()))

    private fun index() = FamilyFolders().apply { noteAreas(mapOf(area to group)); noteRoot("root", group) }

    @Test
    fun aNestedFolderListedOnceIsSaidInAfterItsRowsAreGone() {
        val folders = index()
        folders.listed("root", listOf(row("trips"), row("notes.txt", folder = false)), workspaceOf = { null })
        folders.listed("trips", listOf(row("lisbon")), workspaceOf = { null })
        // The rows were dropped already (an earlier clear, a refusal): nothing of the family is on screen.
        val cleared = folders.cleared(group, shown = emptyMap(), tops = emptyList())
        assertEquals(setOf("root", "trips", "lisbon"), cleared)
        assertEquals(group, folders.groupOf("lisbon") { null })
        // A file is never kept as a folder.
        assertFalse("notes.txt" in cleared)
    }

    /*
     * A file opened here, then deleted by another member and dropped from the refreshed listing: its plaintext copy still
     * goes when the family is wiped (its family folder's copies go whole), and its thumbnail with every row the session
     * opened of the family. A personal copy stays. Fails if the wipe reads only what is listed now.
     */
    @Test
    fun aFileOpenedThenGoneFromTheListingIsStillWiped() {
        val folders = index()
        val cache = java.nio.file.Files.createTempDirectory("family-cache").toFile()
        val gone = java.io.File(com.hushos.app.data.FamilyCopies.folder(cache, area)!!, "gone/v1/notes.txt").apply { parentFile!!.mkdirs(); writeText("plaintext") }
        val mine = java.io.File(cache, "opened/mine/v1/notes.txt").apply { parentFile!!.mkdirs(); writeText("mine") }
        // Listed now: only "kept"; "gone" was opened earlier this session (the vault's family nodes); "mine" is personal.
        val ids = folders.wipeIds(group, shown = mapOf("root" to listOf(row("kept", folder = false))), opened = mapOf("gone" to area, "kept" to area, "mine" to own))
        assertEquals(setOf("gone", "kept"), ids)
        com.hushos.app.data.FamilyCopies.delete(cache, folders.workspacesOf(group))
        assertFalse(gone.exists())
        assertTrue(mine.exists())
    }

    @Test
    fun aClearSaysItsWordsInEveryFolderOnScreenThatHoldsTheFamilysItems() {
        val folders = index()
        val shown = mapOf("root" to listOf(row("docs")), "elsewhere" to listOf(row("mine", workspace = own)))
        val cleared = folders.cleared(group, shown, tops = listOf("root"))
        assertEquals(setOf("root", "docs"), cleared)
        // A second clear (the removal after a fork) finds the same folders with nothing on screen.
        assertEquals(cleared, folders.cleared(group, emptyMap(), emptyList()))
        assertTrue(folders.isFamilyFolder("docs") { null })
        assertFalse(folders.isFamilyFolder("elsewhere") { own })
    }
}
