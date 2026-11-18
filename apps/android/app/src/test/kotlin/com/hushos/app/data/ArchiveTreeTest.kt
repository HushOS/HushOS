package com.hushos.app.data

import com.hushos.core.ArchiveEntry
import com.hushos.core.ArchiveFolders
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
    private fun entry(path: String, index: Int, directory: Boolean = false, hidden: Boolean = false, dos: UInt = 0u, mtime: Long? = null, folder: Int = 0) = ArchiveEntry(
        index = index.toUInt(), path = path, folder = folder.toUInt(), name = path.trimEnd('/').substringAfterLast('/'), directory = directory,
        size = 1uL, packed = 1uL, dos = dos, mtimeMillis = mtime, lock = "none", support = "ok", link = false, nested = false,
        hidden = hidden, stored = false, saveName = path.trimEnd('/').substringAfterLast('/'),
    )

    /*
     * A tree over `paths` (a trailing `/` a directory) listed as the core lists them: a folder for
     * each name under each parent, numbered as made, each entry in its folder; one under `__MACOSX/`
     * hidden and in none. The core's own listing is held to the shared table in its tests.
     */
    private fun tree(vararg paths: String): ArchiveTree {
        val ids = HashMap<String, Int>()
        val parents = java.io.ByteArrayOutputStream()
        val names = StringBuilder()
        fun folder(parent: Int, name: String) = ids.getOrPut("$parent/$name") {
            val id = ids.size + 1
            for (shift in 0..24 step 8) parents.write((parent ushr shift) and 0xff)
            names.append(name).append('/')
            id
        }
        for (shift in 0..24 step 8) parents.write(0)
        val entries = paths.mapIndexed { index, path ->
            val directory = path.endsWith("/")
            val parts = path.split('/').filter { it.isNotEmpty() }
            if (parts.first() == "__MACOSX") return@mapIndexed entry(path, index, directory, hidden = true)
            var node = 0
            for (part in parts.dropLast(1)) node = folder(node, part)
            if (directory) folder(node, parts.last())
            entry(path, index, directory, folder = node)
        }
        return ArchiveTree(entries, ArchiveFolders(parents.toByteArray(), names.toString()))
    }

    @Test fun foldersAreImpliedByDeeperPathsAndCountWhatTheyHold() {
        val tree = tree("a/b/c.txt", "a/d.txt", "e/", "top.txt")
        val top = tree.rows(0)
        assertEquals(listOf("a", "e", "top.txt"), top.map { it.name })
        val a = top[0] as ArchiveTree.Row.Folder
        assertEquals(ArchiveTree.Row.Folder(a.id, "a", 2), a)
        assertEquals("e" to 0, (top[1] as ArchiveTree.Row.Folder).let { it.name to it.count })
        assertEquals(listOf("b", "d.txt"), tree.rows(a.id).map { it.name })
        val b = tree.rows(a.id)[0] as ArchiveTree.Row.Folder
        assertEquals(listOf("c.txt"), tree.rows(b.id).map { it.name })
        assertEquals(listOf("a", "b"), listOf(a.id, b.id).map(tree::name))
        // A folder the archive doesn't hold is empty, not an error.
        assertTrue(tree.rows(99).isEmpty())
        assertEquals("", tree.name(99))
    }

    @Test fun macResourceEntriesAreLeftOutAndCountNowhere() {
        val tree = tree("photo.jpg", "__MACOSX/._photo.jpg", "__MACOSX/")
        assertEquals(listOf("photo.jpg"), tree.rows(0).map { it.name })
    }

    @Test fun aFileAndAFolderOfOneNameAreBothShown() {
        val tree = tree("same", "same/inner.txt")
        assertEquals(listOf("same" to 1), tree.rows(0).filterIsInstance<ArchiveTree.Row.Folder>().map { it.name to it.count })
        assertEquals(listOf("same"), tree.rows(0).filterIsInstance<ArchiveTree.Row.File>().map { it.name })
    }

    @Test fun numbersSortAsNumbers() {
        val tree = tree("f10.txt", "f2.txt", "f1.txt")
        assertEquals(listOf("f1.txt", "f2.txt", "f10.txt"), tree.rows(0).map { it.name })
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
            "encryption", "password", "wrong-password", "password-unproven", "crc", "auth", "size", "short", "ratio", "nested", "link", "directory", "too-large",
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

    @Test fun aMillionFoldersCostArraysNotObjects() {
        // 4,000 chains of 250 folders each, all different: a million folders, as the core hands
        // them over. The tree holds them as arrays; a folder's rows are found when asked for.
        val parents = java.nio.ByteBuffer.allocate(4 * 1_000_001).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        val names = StringBuilder()
        parents.putInt(0)
        val entries = ArrayList<ArchiveEntry>()
        var id = 0
        for (chain in 0 until 4_000) {
            var parent = 0
            for (depth in 0 until 250) {
                id++
                parents.putInt(parent)
                names.append(if (depth == 0) "c$chain" else "a").append('/')
                parent = id
            }
            entries.add(entry("f$chain.txt", chain, folder = parent))
        }
        val started = System.nanoTime()
        val tree = ArchiveTree(entries, ArchiveFolders(parents.array(), names.toString()))
        val top = tree.rows(0)
        val millis = (System.nanoTime() - started) / 1_000_000
        assertEquals(4_000, top.size)
        assertEquals("c0", top.first().name)
        assertTrue("took $millis ms", millis < 5_000)
        // Down the first chain: one folder a level, the file at the bottom.
        var folder = (top.first() as ArchiveTree.Row.Folder).id
        repeat(249) { folder = (tree.rows(folder).single() as ArchiveTree.Row.Folder).id }
        assertEquals(listOf("f0.txt"), tree.rows(folder).map { it.name })
        // Asked again, the same sorted rows, not sorted again.
        assertTrue(top === tree.rows(0))
    }

    @Test fun numbersCompareAsNumbersWithLeadingZerosAndMixedRuns() {
        val collator = java.text.Collator.getInstance().apply { strength = java.text.Collator.SECONDARY }
        val sorted = listOf("a10", "a2", "a02b", "a2b", "b", "a", "10", "9").sortedWith { x, y -> ArchiveTree.numberAware(x, y, collator) }
        assertEquals(listOf("9", "10", "a", "a2", "a02b", "a2b", "a10", "b"), sorted)
    }

    @Test fun superscriptAndFullWidthDigitsNeverBreakTheSort() {
        val collator = java.text.Collator.getInstance(java.util.Locale.US).apply { strength = java.text.Collator.SECONDARY }
        val order = Comparator<String> { x, y -> ArchiveTree.numberAware(x, y, collator) }
        // "9" < "10" as numbers, while a collator weighs ² and ① as 2 and 1: the order that broke TimSort.
        val names = listOf("9", "10", "²", "³", "①", "１１", "１", "2", "a²", "a10", "a９", "x", "½", "0", "00", "٣")
        // Transitive on every triple, so no sort can find it broken.
        for (a in names) for (b in names) for (c in names) {
            if (order.compare(a, b) <= 0 && order.compare(b, c) <= 0) assertTrue("$a ≤ $b ≤ $c", order.compare(a, c) <= 0)
            assertEquals("$a against $b", -Integer.signum(order.compare(b, a)), Integer.signum(order.compare(a, b)))
        }
        // A folder of many such names sorts (TimSort throws on a comparator that isn't, from 32 names up).
        val many = (0 until 200).map { k -> listOf("$k", "²$k", "①$k", "１$k", "a$k", "a²")[k % 6] + (k / 6) }
        java.util.Collections.sort(ArrayList(many), order)
        // Full-width digits are numbers too: "１１" is eleven, after "10".
        assertEquals(listOf("9", "10", "１１"), listOf("１１", "10", "9").sortedWith(order))
    }
}
