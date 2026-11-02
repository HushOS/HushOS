package com.hushos.app.data

import org.junit.Assert.assertEquals
import org.junit.Test

/*
 * The document ids Files holds for a folder, and the folders a sync's touched ids map to. A folder told under the
 * wrong id is never redrawn: the top folder is "root" to Files, and the provider answers to its node id too.
 */
class FilesRootsTest {
    private val root = "node-root"

    @Test
    fun theTopFolderIsToldByBothNamesAndAnyOtherFolderByItsId() {
        assertEquals(setOf("root", root), FilesRoots.documentIds(root, root))
        assertEquals(setOf("root", root), FilesRoots.documentIds("root", root))
        assertEquals(setOf("folder-a"), FilesRoots.documentIds("folder-a", root))
        // Before the workspace is known, "root" is still the id Files holds.
        assertEquals(setOf("root"), FilesRoots.documentIds("root", null))
    }

    @Test
    fun theProviderHandsOutAndReadsTheSameIds() {
        assertEquals("root", FilesRoots.documentId(root, root))
        assertEquals("folder-a", FilesRoots.documentId("folder-a", root))
        assertEquals(root, FilesRoots.nodeId("root", root))
        assertEquals("folder-a", FilesRoots.nodeId("folder-a", root))
    }

    @Test
    fun aSyncsTouchedIdsMapToTheFoldersWhoseChildrenChanged() {
        // f.txt moved from A into B, g.txt renamed in B, x removed from C (known only by the parent index), D renamed under the top.
        val parents = mapOf("f.txt" to "B", "g.txt" to "B", "x" to "C", "D" to root, "A" to root, "B" to root)
        val files = setOf("f.txt", "g.txt")
        val folders = FilesRoots.foldersOf(listOf("f.txt", "A", "B", "g.txt", "x", "D"), parentOf = { parents[it] }, isFile = { it in files })
        assertEquals(setOf("B", "A", root, "C", "x", "D"), folders)
        // A file is never a folder to tell; its folder is.
        assertEquals(setOf("B"), FilesRoots.foldersOf(listOf("g.txt"), parentOf = { parents[it] }, isFile = { it in files }))
    }
}
