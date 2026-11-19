package com.hushos.app.data

import com.hushos.core.Integrity
import com.hushos.core.LineEnding
import com.hushos.core.NodeMetadata
import com.hushos.core.PlannedResult
import com.hushos.core.TextEncoding
import com.hushos.core.TextReadOnly
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

/*
 * Editing 1a and 1b on the phone (TextEditing.kt). Which bytes open for editing, in which encoding and line breaks, and
 * what a save writes for an edited text, are held to the web's verdicts (fixtures/text-edit-cases.json); a file that opens
 * for editing comes back out of the EditText's own buffer byte for byte; and the editor's saves ask the save path the right
 * things: a new version from the version it opened, a refusal when someone else saved first, Save on top after theirs, Save
 * as a copy beside it under the next free name.
 */
class TextEditingTest {
    private val cases = JSONObject(File("../../../crates/hushos-core/fixtures/text-edit-cases.json").readText())

    private fun bytes(parts: JSONArray): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        for (i in 0 until parts.length()) {
            val part = parts.getJSONObject(i)
            val hex = part.getString("hex")
            val one = ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
            repeat(part.optInt("repeat", 1)) { out.write(one) }
        }
        return out.toByteArray()
    }

    /* What a save of `text` writes from an editor just opened on `original`; null when it opened read-only. */
    private fun saved(text: CharSequence, original: ByteArray) = TextEditing.SaveState.opening(original)?.bytes(text)

    private fun word(reason: TextReadOnly) = when (reason) {
        TextReadOnly.TOO_LARGE -> "too-large"
        TextReadOnly.ENCODING -> "encoding"
        TextReadOnly.BINARY -> "binary"
        TextReadOnly.LINE_ENDINGS -> "line-endings"
    }

    private fun word(encoding: TextEncoding) = when (encoding) {
        TextEncoding.UTF8 -> "utf-8"
        TextEncoding.UTF8_BOM -> "utf-8-bom"
        TextEncoding.UTF16_LE -> "utf-16le"
        TextEncoding.UTF16_BE -> "utf-16be"
    }

    private fun word(ending: LineEnding) = when (ending) {
        LineEnding.LF -> "lf"
        LineEnding.CRLF -> "crlf"
    }

    @Test fun everyByteCaseOpensAsTheWebOpensIt() {
        val list = cases.getJSONArray("bytes")
        assertTrue(list.length() >= 40)
        for (i in 0 until list.length()) {
            val case = list.getJSONObject(i)
            val name = case.getString("name")
            val expected = if (case.isNull("reason")) null else case.getString("reason")
            when (val opened = TextEditing.open(bytes(case.getJSONArray("bytes")))) {
                is TextEditing.Open.Editable -> {
                    assertNull(name, expected)
                    assertEquals(name, case.getString("encoding"), word(opened.format.encoding))
                    assertEquals(name, case.getString("lineEnding"), word(opened.format.lineEnding))
                    assertEquals(name, case.getBoolean("mixed"), opened.format.mixed)
                    if (case.has("text")) assertEquals(name, case.getString("text"), opened.text)
                    assertFalse(name, '\r' in opened.text)
                }
                is TextEditing.Open.ReadOnly -> assertEquals(name, expected, word(opened.reason))
            }
        }
    }

    /* What a save writes for an edited text: the file's encoding, byte order mark and line breaks, as on the web. */
    @Test fun everyEditWritesWhatTheWebWrites() {
        val list = cases.getJSONArray("edits")
        var refused = 0
        for (i in 0 until list.length()) {
            val case = list.getJSONObject(i)
            val name = case.getString("name")
            val original = bytes(case.getJSONArray("bytes"))
            val text = case.getString("text")
            val expected = if (case.isNull("saved")) null.also { refused++ } else bytes(case.getJSONArray("saved"))
            assertArrayEquals(name, expected, saved(text, original))
            // As the EditText holds a paste (its filter makes every break LF): the same bytes.
            assertArrayEquals(name, expected, saved(TextEditing.lineFeeds(text), original))
        }
        assertTrue(refused > 0)
    }

    @Test fun everyNameOpensInTheEditorAsOnTheWeb() {
        val list = cases.getJSONArray("names")
        for (i in 0 until list.length()) {
            val case = list.getJSONObject(i)
            val mime = if (case.isNull("mime")) null else case.getString("mime")
            assertEquals(case.getString("name"), case.getBoolean("editable"), TextEditing.opens(case.getString("name"), mime))
        }
    }

    /* A save changes only the edited bytes: what opened comes back out exactly, through an Editable like the EditText's. */
    @Test fun everyEditableCaseComesBackOutByteForByte() {
        val list = cases.getJSONArray("bytes")
        for (i in 0 until list.length()) {
            val case = list.getJSONObject(i)
            if (!case.isNull("reason")) continue
            val data = bytes(case.getJSONArray("bytes"))
            val opened = TextEditing.open(data) as TextEditing.Open.Editable
            assertArrayEquals(case.getString("name"), data, saved(opened.text, data))
            // StringBuilder stands in for the EditText's SpannableStringBuilder (both a CharSequence of the same chars).
            assertArrayEquals(case.getString("name"), data, saved(StringBuilder(opened.text), data))
        }
    }

    /* Every save of one session, the format kept from the open: past the limit and back, a CRLF file emptied and typed into. */
    @Test fun everySaveOfASessionWritesWhatTheWebWrites() {
        val list = cases.getJSONArray("sessions")
        assertTrue(list.length() >= 5)
        for (i in 0 until list.length()) {
            val case = list.getJSONObject(i)
            var state = TextEditing.SaveState.opening(bytes(case.getJSONArray("bytes")))!!
            val saves = case.getJSONArray("saves")
            for (at in 0 until saves.length()) {
                val save = saves.getJSONObject(at)
                val parts = save.getJSONArray("text")
                val text = (0 until parts.length()).joinToString("") { parts.getJSONObject(it).let { part -> part.getString("text").repeat(part.optInt("repeat", 1)) } }
                val written = state.bytes(text)
                assertArrayEquals("${case.getString("name")}, save ${at + 1}", bytes(save.getJSONArray("saved")), written)
                state = state.saved(text, written)
            }
        }
    }

    @Test fun anEditInMultibyteTextChangesOnlyThoseBytes() {
        val original = "Grüße 👋\nzweite Zeile noch\nohne Zeilenende"
        val opened = TextEditing.open(original.encodeToByteArray()) as TextEditing.Open.Editable
        val written = saved(opened.text.replace("zweite", "dritte ✓"), original.encodeToByteArray())!!
        val at = "Grüße 👋\n".encodeToByteArray().size
        val bytes = original.encodeToByteArray()
        val expected = bytes.copyOfRange(0, at) + "dritte ✓".encodeToByteArray() + bytes.copyOfRange(at + 6, bytes.size)
        assertArrayEquals(expected, written)
        assertEquals('e'.code.toByte(), written.last())
    }

    @Test fun aLineBreakTypedOrPastedIsLineFeed() {
        assertEquals("a\nb\nc\n", TextEditing.lineFeeds("a\r\nb\rc\n").toString())
        assertEquals("plain", TextEditing.lineFeeds("plain").toString())
    }

    @Test fun readOnlyFilesKeepTheirWordsAndNeverOfferText() {
        assertEquals(TextEditing.Open.ReadOnly(TextReadOnly.BINARY, null), TextEditing.open(byteArrayOf(0x61, 0, 0x62)))
        assertEquals(TextEditing.Open.ReadOnly(TextReadOnly.ENCODING, "caf\uFFFD"), TextEditing.open(byteArrayOf(0x63, 0x61, 0x66, -0x17)))
        assertEquals(TextEditing.Open.ReadOnly(TextReadOnly.LINE_ENDINGS, "a\rb"), TextEditing.open("a\rb".encodeToByteArray()))
        assertEquals("This file uses an encoding HushOS can’t edit without changing it.", TextEditing.words(TextReadOnly.ENCODING))
        assertEquals(8L * 1024 * 1024, TextEditing.LIMIT)
        // Nothing is written for a file the editor can't keep exactly.
        assertNull(saved("cafe", byteArrayOf(0x63, 0x61, 0x66, -0x17)))
    }

    @Test fun aMixedFileSaysWhichLineBreakASaveWrites() {
        fun note(text: String) = TextEditing.mixedNote((TextEditing.open(text.encodeToByteArray()) as TextEditing.Open.Editable).format)
        assertEquals("This file mixes line endings; saving uses Windows (CRLF).", note("a\r\nb\r\nc\n"))
        assertEquals("This file mixes line endings; saving uses Unix (LF).", note("a\nb\nc\r\n"))
        assertNull(note("a\r\n"))
    }

    /* A folder the way the server keeps it for a save: each file's versions in order, a version refused stale when the file moved on. */
    private class Bench : SaveRunWriter {
        override val account: String? = "me"
        val versions = mutableMapOf<String, MutableList<Pair<String, ByteArray>>>()
        val names = mutableMapOf<String, String>()
        val copies = mutableListOf<Prior?>()
        val planned = mutableListOf<List<PlannedResult>>()
        /* Someone else saves right after this one lands, before its reply is read (the reply row shows theirs). */
        var theirsAfterLanding: String? = null
        /* The session the upload went under ended (a 401) once the run had begun. */
        var refused = false
        private var count = 0

        fun add(name: String, text: String): Opened {
            val id = "n${++count}"
            names[id] = name
            versions[id] = mutableListOf("v$count" to text.encodeToByteArray())
            return file(id)
        }
        fun file(id: String): Opened {
            val version = versions.getValue(id).last().first
            val node = NodeView(id, "ws", "f", "file", 1uL, 1uL, "", 1uL, "", VersionView(version, "o", "", "ready", 3u, 1, "n", null, null, null), null, null, null)
            return Opened(node, NodeMetadata(names.getValue(id), "text/plain", null, null, emptyMap()))
        }
        fun theirs(id: String, text: String): String {
            versions.getValue(id).add("v${++count}" to text.encodeToByteArray())
            return "v$count"
        }
        fun text(id: String, at: Int = -1): String {
            val list = versions.getValue(id)
            return list[if (at < 0) list.size + at else at].second.decodeToString()
        }

        override fun refusal(target: Opened): String? = null
        override fun room(workspaceId: String): SaveRoom = SaveRoom.Own(1L shl 40)
        override fun names(folder: Opened): List<String> = names.values.toList()
        override fun makeFolder(folder: Opened, name: String, copy: Prior?, minted: (String) -> Unit): Opened = error("not asked")
        override fun uploadResult(bytes: ByteArray, name: String, mime: String?, folder: Opened, replacing: Opened?, startedFrom: String?, copy: Prior?,
                                  thumbnail: ByteArray?, onBegun: (Vault.BegunIds) -> Unit, onCompleting: (String) -> Unit): Opened {
            val n = ++count
            copies += copy
            if (refused) throw NotAuthenticated()
            if (replacing != null) {
                val list = versions[replacing.id] ?: throw SaveStale(null)
                if (list.last().first != startedFrom) throw SaveStale(list.last().first)
                onBegun(Vault.BegunIds("ws", "up-$n", replacing.id, "v$n"))
                onCompleting("up-$n")
                list.add("v$n" to bytes)
                theirsAfterLanding?.let { theirsAfterLanding = null; theirs(replacing.id, it) }
                return file(replacing.id)
            }
            val id = "n$n"
            onBegun(Vault.BegunIds("ws", "up-$n", id, "v$n"))
            onCompleting("up-$n")
            names[id] = name
            versions[id] = mutableListOf("v$n" to bytes)
            return file(id)
        }
        override fun fresh(file: Opened, folder: Opened): Opened? = if (versions.containsKey(file.id)) file(file.id) else null
        override fun lookFolder(id: String, workspaceId: String): FolderCount? = null
        override fun refreshFolder(folder: Opened): Opened = folder
        override fun abortUpload(uploadId: String, workspaceId: String) = SaveAbortFate.ABORTED
        override fun trash(ids: List<String>, workspaceId: String) = emptyMap<String, SaveItemFate>()
        override fun purge(ids: List<String>, workspaceId: String) = emptyMap<String, SaveItemFate>()
        override fun mayPurge(workspaceId: String): Boolean? = true
    }

    private val folder = Opened(NodeView("f", "ws", "root", "folder", 1uL, 1uL, "", 1uL, "", null, null, null, null), NodeMetadata("f", null, null, null, emptyMap()))

    private fun start(bench: Bench): TextSave.Start {
        val journal = SaveRunJournal(Files.createTempDirectory("text-save").resolve(SaveRunJournal.FILE).toFile(), SaveRunJournal.Epoch())
        return TextSave.Start { targets, results ->
            bench.planned += results
            SaveRun.start(bench, targets, results, journal)
        }
    }

    @Test fun aSaveIsANewVersionHoldingExactlyTheEditedTextPlannedAsItsBytes() {
        val bench = Bench()
        val file = bench.add("notes.txt", "café\n")
        val saved = TextSave.version("café ✓\n".encodeToByteArray(), file, folder, file.node.currentVersion?.id, start(bench))
        assertTrue(saved is TextSaved.Saved)
        assertEquals("café ✓\n", bench.text(file.id))
        assertEquals(2, bench.versions.getValue(file.id).size)
        // Its UTF-8 bytes (10), not its length in characters (7), and no thumbnail; signed as the person's own writing.
        assertEquals(listOf(listOf(PlannedResult.Known(10uL, false))), bench.planned)
        assertEquals(null, bench.copies.last())
    }

    /*
     * A 401 while the save's upload went up: the run stops saying the session was refused, so the editor hands it to the
     * app's session check rather than showing it as a line. Fails if the refusal is lost in the stop.
     */
    @Test fun aSaveStoppedByA401SaysTheSessionWasRefused() {
        val bench = Bench()
        val file = bench.add("notes.txt", "a")
        bench.refused = true
        val stopped = assertThrows(SaveRunStopped::class.java) { TextSave.version("b".encodeToByteArray(), file, folder, file.node.currentVersion?.id, start(bench)) }
        assertTrue(stopped.sessionRefused)
        assertEquals(1, bench.versions.getValue(file.id).size)
    }

    /*
     * The editor's header names and marks the version its text is: a row a save answered with takes over only when it lists
     * the version that save published, in the editor's folder. Fails if someone else's newer version (verified or not)
     * would take the marks off the text read, or a row elsewhere would.
     */
    @Test fun onlyARowListingThePublishedVersionInItsFolderSpeaksForTheText() {
        val bench = Bench()
        val file = bench.add("notes.txt", "a")
        val destination = TextEditing.Destination.of(file)
        val mine = bench.file(file.id)
        assertTrue(TextEditing.speaksFor(mine, mine.node.currentVersion!!.id, destination))
        bench.theirs(file.id, "theirs")
        val theirs = bench.file(file.id)
        assertTrue(!TextEditing.speaksFor(theirs, mine.node.currentVersion!!.id, destination))
        assertTrue(!TextEditing.speaksFor(mine, null, destination))
        assertTrue(!TextEditing.speaksFor(mine, mine.node.currentVersion!!.id, TextEditing.Destination("ws", "elsewhere")))
    }

    /*
     * The editor closes (its session ends) while a save's bytes are going up: cancelling its coroutine can't stop the
     * blocking upload, so the run asks the session right before completing, and nothing lands. Fails if the version is
     * published after the editor has gone, for a save or a copy.
     */
    @Test fun aSaveOrCopyWhoseEditorWentWhileItUploadedNeverCompletes() {
        val bench = Bench()
        val file = bench.add("notes.txt", "a")
        // On through the checks before and after the run starts, gone by the time it would complete.
        fun closingAfterStart(): () -> Boolean { var asked = 0; return { ++asked <= 2 } }
        assertThrows(Exception::class.java) {
            TextSave.version("b".encodeToByteArray(), file, folder, file.node.currentVersion?.id, start(bench), stillOn = closingAfterStart())
        }
        assertEquals(1, bench.versions.getValue(file.id).size)
        val files = bench.versions.size
        assertThrows(Exception::class.java) {
            TextSave.copy("c".encodeToByteArray(), file, folder, SaveSources.OwnWriting, start(bench), stillOn = closingAfterStart())
        }
        assertEquals(files, bench.versions.size)
    }

    @Test fun aSaveAfterSomeoneElsesIsStaleAndPublishesNothing() {
        val bench = Bench()
        val file = bench.add("notes.txt", "start\n")
        val theirs = bench.theirs(file.id, "theirs\n")
        assertEquals(TextSaved.Stale(theirs), TextSave.version("mine\n".encodeToByteArray(), file, folder, file.node.currentVersion?.id, start(bench)))
        assertEquals("theirs\n", bench.text(file.id))
        assertEquals(2, bench.versions.getValue(file.id).size)
    }

    @Test fun saveOnTopMakesANewVersionAfterTheirsAndBothStay() {
        val bench = Bench()
        val file = bench.add("notes.txt", "start\n")
        val theirs = bench.theirs(file.id, "theirs\n")
        assertTrue(TextSave.version("mine\n".encodeToByteArray(), bench.file(file.id), folder, theirs, start(bench)) is TextSaved.Saved)
        assertEquals(3, bench.versions.getValue(file.id).size)
        assertEquals("theirs\n", bench.text(file.id, 1))
        assertEquals("mine\n", bench.text(file.id))
    }

    @Test fun saveAsACopyMakesASiblingUnderTheNextFreeNameSignedAsItsSource() {
        val bench = Bench()
        val file = bench.add("notes.txt", "start\n")
        bench.add("notes (2).txt", "already here")
        bench.theirs(file.id, "theirs\n")
        val sources = SaveSources.From(listOf(SaveSource.OfFile(Integrity.UNKNOWN_SIGNER, Integrity.UNKNOWN_SIGNER)))
        val made = TextSave.copy("mine\n".encodeToByteArray(), file, folder, sources, start(bench))
        assertEquals("notes (3).txt", bench.names[made.file.id])
        assertEquals("mine\n", bench.text(made.file.id))
        assertEquals(bench.versions.getValue(made.file.id).first().first, made.versionId)
        assertEquals("theirs\n", bench.text(file.id))
        // An Unverified source's copy is never signed as the person's own writing.
        assertEquals(Integrity.UNKNOWN_SIGNER, bench.copies.last()?.metadata)
    }

    /* Someone else saved right after this landed: the next save must start from this save's version, not theirs. */
    @Test fun aSaveNamesTheVersionItPublishedNotTheReplyRowsCurrentOne() {
        val bench = Bench()
        val file = bench.add("notes.txt", "a")
        bench.theirsAfterLanding = "theirs"
        val saved = TextSave.version("mine".encodeToByteArray(), file, folder, file.node.currentVersion?.id, start(bench)) as TextSaved.Saved
        assertEquals(bench.versions.getValue(file.id)[1].first, saved.versionId)
        assertEquals("theirs", bench.text(file.id))
    }

    @Test fun aListingForAnotherFolderOrWorkspaceIsNeverTheFilesFolder() {
        val bench = Bench()
        val file = bench.add("notes.txt", "a")
        val (found, row) = TextEditing.target(folder.node, listOf(file.node), file)
        assertEquals("f", found.id)
        assertEquals(file.id, row?.id)
        val elsewhere = folder.node.copy(id = "g")
        assertThrows(TextEditing.WrongFolder::class.java) { TextEditing.target(elsewhere, listOf(file.node), file) }
        val otherDrive = folder.node.copy(workspaceId = "other")
        assertThrows(TextEditing.WrongFolder::class.java) { TextEditing.target(otherDrive, listOf(file.node), file) }
        // The file's id in another workspace or another folder is not the file.
        val twin = file.node.copy(workspaceId = "other")
        val moved = file.node.copy(parentId = "g")
        assertEquals(null, TextEditing.target(folder.node, listOf(twin, moved), file).second)
    }

    @Test fun aPastedCRLFAloneIsLineFeed() {
        assertEquals("\n", TextEditing.lineFeeds("\r\n").toString())
    }

    /* The editor closed or another session began while the folder was being listed: nothing starts, nothing uploads. */
    @Test fun aSaveWhoseSessionEndedStartsNothing() {
        val bench = Bench()
        val file = bench.add("notes.txt", "a")
        assertThrows(TextEditing.SessionEnded::class.java) {
            TextSave.version("b".encodeToByteArray(), file, folder, file.node.currentVersion?.id, start(bench), stillOn = { false })
        }
        assertThrows(TextEditing.SessionEnded::class.java) {
            TextSave.copy("b".encodeToByteArray(), file, folder, SaveSources.OwnWriting, start(bench), stillOn = { false })
        }
        assertEquals(1, bench.versions.getValue(file.id).size)
        assertEquals(1, bench.names.size)
        assertTrue(bench.planned.isEmpty())
    }

    /* Typed during a save: "é" for "e" + U+0301 is a change, as the bytes a save writes are. */
    @Test fun canonicallyEqualTextIsNotTheSameSave() {
        assertTrue(!TextEditing.same("caf\u00e9", "cafe\u0301"))
        assertTrue(TextEditing.same(StringBuilder("caf\u00e9"), "caf\u00e9"))
    }

    private fun node(id: String, ws: String, parent: String?, kind: String = "folder") =
        Opened(NodeView(id, ws, parent, kind, 1uL, 1uL, "", 1uL, "", null, null, null, null), NodeMetadata(id, null, null, null, emptyMap()))

    @Test fun ownershipIsNeverAssumedBeforeTheOwnWorkspaceIsKnown() {
        val doc = node("doc", "theirs", "inner", "file")
        val inner = node("inner", "theirs", "top")
        val top = node("top", "theirs", null)
        val tree = mapOf("inner" to inner, "top" to top)
        val parent = { item: Opened -> item.node.parentId?.let { tree[it] } }
        // Not loaded yet: a viewer's share, or none found, is not one's own.
        assertTrue(!EditRights.mayEdit(doc, null, listOf(top to "viewer"), parent))
        assertTrue(!EditRights.mayEdit(doc, null, emptyList(), parent))
        // An editor's folder covering it counts; a file shared on its own doesn't.
        assertTrue(EditRights.mayEdit(doc, null, listOf(top to "editor"), parent))
        assertTrue(!EditRights.mayEdit(doc, null, listOf(doc to "editor"), parent))
        // Known and the item's: one's own.
        assertTrue(EditRights.mayEdit(node("doc", "MINE", "x", "file"), "mine", emptyList(), parent))
        assertTrue(!EditRights.mayEdit(doc, "mine", emptyList(), parent))
    }

    @Test fun theNearestGrantDecidesAndAFolderAboveMustBeShared() {
        val doc = node("doc", "theirs", "inner", "file")
        val inner = node("inner", "theirs", "top")
        val top = node("top", "theirs", null)
        val tree = mapOf("inner" to inner, "top" to top)
        val parent = { item: Opened -> item.node.parentId?.let { tree[it] } }
        // A viewer's grant nearer than an editor's wins; an editor's nearer than a viewer's wins.
        assertTrue(!EditRights.mayEdit(doc, null, listOf(top to "editor", inner to "viewer"), parent))
        assertTrue(EditRights.mayEdit(doc, null, listOf(top to "viewer", inner to "editor"), parent))
        // The file shared to edit too, inside a folder shared to edit: editable (its folder lists).
        assertTrue(EditRights.mayEdit(doc, null, listOf(top to "editor", doc to "editor"), parent))
        assertTrue(!EditRights.mayEdit(doc, null, listOf(top to "editor", doc to "viewer"), parent))
        // Two grants on one folder: the viewer's.
        assertTrue(!EditRights.mayEdit(doc, null, listOf(top to "editor", top to "viewer"), parent))
        // Another workspace's node with the folder's id is no grant here.
        assertTrue(!EditRights.mayEdit(doc, null, listOf(node("top", "elsewhere", null) to "editor"), parent))
    }

    /* Opening may hand back a newer row this process holds: one moved since is absent from this folder, never adopted. */
    @Test fun aRowTheVaultSwappedForOneElsewhereIsNotTheFile() {
        val file = node("doc", "ws", "f", "file")
        val folder = node("f", "ws", "root")
        assertEquals(file, TextEditing.held(folder, file, file).second)
        assertEquals(null, TextEditing.held(folder, node("doc", "ws", "g", "file"), file).second)
        assertEquals(null, TextEditing.held(folder, node("doc", "other", "f", "file"), file).second)
        assertThrows(TextEditing.WrongFolder::class.java) { TextEditing.held(node("g", "ws", "root"), file, file) }
        assertThrows(TextEditing.WrongFolder::class.java) { TextEditing.held(node("f", "other", "root"), file, file) }
    }

    /* Discarded while the run started (the room check, its record): nothing is handed to the run, and its row goes. */
    @Test fun aSaveWhoseSessionEndsWhileItsRunStartsUploadsNothing() {
        val bench = Bench()
        val file = bench.add("notes.txt", "a")
        val journal = SaveRunJournal(Files.createTempDirectory("text-save").resolve(SaveRunJournal.FILE).toFile(), SaveRunJournal.Epoch())
        var on = true
        val start = TextSave.Start { targets, results -> SaveRun.start(bench, targets, results, journal).also { on = false } }
        assertThrows(TextEditing.SessionEnded::class.java) {
            TextSave.version("b".encodeToByteArray(), file, folder, file.node.currentVersion?.id, start, stillOn = { on }, pause = {})
        }
        assertEquals(1, bench.versions.getValue(file.id).size)
        assertTrue(journal.list().isEmpty())
        on = true
        assertThrows(TextEditing.SessionEnded::class.java) {
            TextSave.copy("b".encodeToByteArray(), file, folder, SaveSources.OwnWriting, start, stillOn = { on }, pause = {})
        }
        assertEquals(1, bench.names.size)
        assertTrue(journal.list().isEmpty())
    }

    /* Work taken under an editor's session stops publishing once it closes, a sign-in replaces its vault, or another text opens. */
    @Test fun workGoesOnOnlyInTheSessionItBeganIn() {
        val first = Any()
        var current: Any? = first
        val session = EditSession(first) { current }
        val token = session.take()!!
        assertTrue(session.live(token))
        // A sign-in replaced the vault: nothing begun before goes on, and nothing new begins.
        current = Any()
        assertTrue(!session.live(token))
        assertEquals(null, session.take())
        current = first
        session.reopened()
        assertTrue(!session.live(token))
        val after = session.take()!!
        assertTrue(session.live(after))
        session.close()
        assertTrue(!session.live(after))
        assertEquals(null, session.take())
    }

    @Test fun theShareAnItemCameThroughIsMatchedByWorkspaceAndId() {
        fun node(id: String, ws: String, parent: String?) =
            Opened(NodeView(id, ws, parent, "folder", 1uL, 1uL, "", 1uL, "", null, null, null, null), NodeMetadata(id, null, null, null, emptyMap()))
        val doc = node("doc", "theirs", "inner")
        val inner = node("inner", "theirs", "top")
        val top = node("top", "theirs", null)
        val tree = mapOf("inner" to inner, "top" to top)
        val parent = { item: Opened -> item.node.parentId?.let { tree[it] } }
        // A mount of another workspace whose root has the folder's id is not the share it came through.
        val twin = node("inner", "elsewhere", null)
        assertEquals(top, EditRights.nearestMount(doc, listOf(twin, top), root = { it }, parent = parent))
        assertEquals(inner, EditRights.nearestMount(doc, listOf(top, inner), root = { it }, parent = parent))
        assertEquals(null, EditRights.nearestMount(doc, listOf(twin), root = { it }, parent = parent))
    }
}
