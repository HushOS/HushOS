package com.hushos.app.data

import com.hushos.core.ArchiveEntry
import java.time.LocalDateTime
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/*
 * The archive's list as folders, the way the web's archive view draws it: folders implied by
 * deeper paths, counts of what each holds, Mac resource entries left out, numbers in order; and
 * an entry's date and the words for each refusal the core can send.
 */
class ArchiveTreeTest {
    private fun entry(path: String, index: Int, directory: Boolean = false, hidden: Boolean = false, dos: UInt = 0u, mtime: Long? = null) = ArchiveEntry(
        index.toUInt(), path, path.split('/', '\\').filter { it.isNotEmpty() && it != "." }, directory, 1uL, 1uL, dos, mtime,
        "none", "ok", link = false, nested = false, hidden = hidden, stored = false, saveName = path.substringAfterLast('/'),
    )

    @Test fun foldersAreImpliedByDeeperPathsAndCountWhatTheyHold() {
        val tree = ArchiveTree(listOf(entry("a/b/c.txt", 0), entry("a/d.txt", 1), entry("e/", 2, directory = true), entry("top.txt", 3)))
        val top = tree.rows(emptyList())
        assertEquals(listOf("a", "e", "top.txt"), top.map { it.name })
        assertEquals(ArchiveTree.Row.Folder("a", 2), top[0])
        assertEquals(ArchiveTree.Row.Folder("e", 0), top[1])
        assertEquals(listOf("b", "d.txt"), tree.rows(listOf("a")).map { it.name })
        assertEquals(listOf("c.txt"), tree.rows(listOf("a", "b")).map { it.name })
        // A folder the archive doesn't hold is empty, not an error.
        assertTrue(tree.rows(listOf("nowhere")).isEmpty())
    }

    @Test fun macResourceEntriesAreLeftOutAndCountNowhere() {
        val tree = ArchiveTree(listOf(entry("photo.jpg", 0), entry("__MACOSX/._photo.jpg", 1, hidden = true), entry("__MACOSX/", 2, directory = true, hidden = true)))
        assertEquals(listOf("photo.jpg"), tree.rows(emptyList()).map { it.name })
    }

    @Test fun aFileAndAFolderOfOneNameAreBothShown() {
        val tree = ArchiveTree(listOf(entry("same", 0), entry("same/inner.txt", 1)))
        assertEquals(listOf(ArchiveTree.Row.Folder("same", 1)), tree.rows(emptyList()).filterIsInstance<ArchiveTree.Row.Folder>())
        assertEquals(listOf("same"), tree.rows(emptyList()).filterIsInstance<ArchiveTree.Row.File>().map { it.name })
    }

    @Test fun numbersSortAsNumbers() {
        val tree = ArchiveTree(listOf(entry("f10.txt", 0), entry("f2.txt", 1), entry("f1.txt", 2)))
        assertEquals(listOf("f1.txt", "f2.txt", "f10.txt"), tree.rows(emptyList()).map { it.name })
    }

    @Test fun anEntryIsDatedByItsUnixTimeElseItsDosDateOnThisClock() {
        val zone = ZoneId.of("Europe/Lisbon")
        // 2026-11-03 14:30:08 as MS-DOS writes it: date << 16 | time.
        val date = ((2026 - 1980) shl 9) or (11 shl 5) or 3
        val time = (14 shl 11) or (30 shl 5) or 4
        val dos = ((date shl 16) or time).toUInt()
        val expected = LocalDateTime.of(2026, 11, 3, 14, 30, 8).atZone(zone).toInstant().toEpochMilli()
        assertEquals(expected, ArchiveTree.modifiedMillis(entry("a", 0, dos = dos), zone))
        assertEquals(1_000L, ArchiveTree.modifiedMillis(entry("a", 0, dos = dos, mtime = 1_000L), zone))
        // No month or day: no date at all, rather than a wrong one.
        assertNull(ArchiveTree.modifiedMillis(entry("a", 0, dos = 0u), zone))
    }

    @Test fun zipsAreKnownByTypeOrName() {
        assertTrue(ArchiveTree.isZip("Photos.ZIP", null))
        assertTrue(ArchiveTree.isZip("download", "application/zip"))
        assertTrue(ArchiveTree.isZip("download", "application/x-zip-compressed; charset=binary"))
        // An Office file is a zip inside, but opens as itself.
        assertFalse(ArchiveTree.isZip("report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"))
    }

    @Test fun everyRefusalTheCoreSendsHasItsOwnWords() {
        val codes = listOf(
            "damaged", "directory-too-large", "too-many-entries", "encrypted-directory", "split", "overlap", "local", "method",
            "encryption", "password", "wrong-password", "crc", "auth", "size", "short", "ratio", "nested", "link", "directory", "too-large",
        )
        val fallback = ArchiveWords.refusal("something new")
        for (code in codes) assertNotEquals(code, fallback, ArchiveWords.refusal(code))
        assertEquals("This archive’s list of contents is encrypted. HushOS can’t open it.", ArchiveWords.refusal("encrypted-directory"))
    }

    @Test fun anItemsOwnDamageBlamesTheItemNotTheArchive() {
        assertEquals("This item is damaged, or isn’t something HushOS can read.", ArchiveWords.refusal("damaged", entry = true))
        assertEquals("This archive is damaged, or isn’t a zip archive HushOS can read.", ArchiveWords.refusal("damaged"))
        // Every other code reads the same either way.
        assertEquals(ArchiveWords.refusal("crc"), ArchiveWords.refusal("crc", entry = true))
    }

    @Test fun deepPathsCostTheirPartsNotEveryPrefix() {
        // 2,000 entries 256 parts deep under one long chain: by prefixes this is about 65 million
        // path strings joined; as a tree of nodes it is 2,000 walks of 256 steps.
        val chain = (1..255).joinToString("/") { "a" }
        val entries = (0 until 2_000).map { entry("$chain/f$it.txt", it) }
        val started = System.nanoTime()
        val tree = ArchiveTree(entries)
        val rows = tree.rows(chain.split('/'))
        val millis = (System.nanoTime() - started) / 1_000_000
        assertEquals(2_000, rows.size)
        assertEquals("f0.txt", rows.first().name)
        assertTrue("took $millis ms", millis < 2_000)
        // Asked again, the same sorted rows, not sorted again.
        assertTrue(rows === tree.rows(chain.split('/')))
    }

    @Test fun numbersCompareAsNumbersWithLeadingZerosAndMixedRuns() {
        val collator = java.text.Collator.getInstance().apply { strength = java.text.Collator.SECONDARY }
        val sorted = listOf("a10", "a2", "a02b", "a2b", "b", "a", "10", "9").sortedWith { x, y -> ArchiveTree.numberAware(x, y, collator) }
        assertEquals(listOf("9", "10", "a", "a2", "a02b", "a2b", "a10", "b"), sorted)
    }
}
