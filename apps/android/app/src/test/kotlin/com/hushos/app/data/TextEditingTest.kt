package com.hushos.app.data

import com.hushos.core.Integrity
import com.hushos.core.NodeMetadata
import com.hushos.core.PlannedResult
import com.hushos.core.TextReadOnly
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

/*
 * Editing 1a on the phone (TextEditing.kt). Which bytes open for editing is held to the web's verdicts
 * (fixtures/text-edit-cases.json); a file that opens for editing comes back out of the EditText's own buffer byte for byte;
 * and the editor's saves ask the save path the right things: a new version from the version it opened, a refusal when
 * someone else saved first, Save on top after theirs, Save as a copy beside it under the next free name.
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

    private fun word(reason: TextReadOnly) = when (reason) {
        TextReadOnly.TOO_LARGE -> "too-large"
        TextReadOnly.BYTE_ORDER_MARK -> "byte-order-mark"
        TextReadOnly.UTF16 -> "utf-16"
        TextReadOnly.ENCODING -> "encoding"
        TextReadOnly.BINARY -> "binary"
        TextReadOnly.LINE_ENDINGS -> "line-endings"
    }

    @Test fun everyByteCaseOpensAsTheWebOpensIt() {
        val list = cases.getJSONArray("bytes")
        assertTrue(list.length() >= 20)
        for (i in 0 until list.length()) {
            val case = list.getJSONObject(i)
            val expected = if (case.isNull("reason")) null else case.getString("reason")
            val got = when (val opened = TextEditing.open(bytes(case.getJSONArray("bytes")))) {
                is TextEditing.Open.Editable -> null
                is TextEditing.Open.ReadOnly -> word(opened.reason)
            }
            assertEquals(case.getString("name"), expected, got)
        }
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
            assertArrayEquals(case.getString("name"), data, TextEditing.encode(opened.text))
            // StringBuilder stands in for the EditText's SpannableStringBuilder (both a CharSequence of the same chars).
            assertArrayEquals(case.getString("name"), data, TextEditing.encode(StringBuilder(opened.text)))
        }
    }

    @Test fun anEditInMultibyteTextChangesOnlyThoseBytes() {
        val original = "Grüße 👋\nzweite Zeile noch\nohne Zeilenende"
        val opened = TextEditing.open(original.encodeToByteArray()) as TextEditing.Open.Editable
        val saved = TextEditing.encode(opened.text.replace("zweite", "dritte ✓"))
        val at = "Grüße 👋\n".encodeToByteArray().size
        val bytes = original.encodeToByteArray()
        val expected = bytes.copyOfRange(0, at) + "dritte ✓".encodeToByteArray() + bytes.copyOfRange(at + 6, bytes.size)
        assertArrayEquals(expected, saved)
        assertEquals('e'.code.toByte(), saved.last())
    }

    @Test fun aLineBreakTypedOrPastedIsLineFeed() {
        assertEquals("a\nb\nc\n", TextEditing.lineFeeds("a\r\nb\rc\n").toString())
        assertEquals("plain", TextEditing.lineFeeds("plain").toString())
    }

    @Test fun readOnlyFilesKeepTheirWordsAndNeverOfferText() {
        assertEquals(TextEditing.Open.ReadOnly(TextReadOnly.BINARY, null), TextEditing.open(byteArrayOf(0x61, 0)))
        assertEquals(TextEditing.Open.ReadOnly(TextReadOnly.UTF16, null), TextEditing.open(byteArrayOf(-1, -2, 0x68, 0)))
        assertEquals("This file uses Windows line endings, which HushOS can’t edit yet.", TextEditing.words(TextReadOnly.LINE_ENDINGS))
        assertEquals(8L * 1024 * 1024, TextEditing.LIMIT)
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
        val saved = TextSave.version("café ✓\n", file, folder, file.node.currentVersion?.id, start(bench))
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
        val stopped = assertThrows(SaveRunStopped::class.java) { TextSave.version("b", file, folder, file.node.currentVersion?.id, start(bench)) }
        assertTrue(stopped.sessionRefused)
        assertEquals(1, bench.versions.getValue(file.id).size)
    }

    @Test fun aSaveAfterSomeoneElsesIsStaleAndPublishesNothing() {
        val bench = Bench()
        val file = bench.add("notes.txt", "start\n")
        val theirs = bench.theirs(file.id, "theirs\n")
        assertEquals(TextSaved.Stale(theirs), TextSave.version("mine\n", file, folder, file.node.currentVersion?.id, start(bench)))
        assertEquals("theirs\n", bench.text(file.id))
        assertEquals(2, bench.versions.getValue(file.id).size)
    }

    @Test fun saveOnTopMakesANewVersionAfterTheirsAndBothStay() {
        val bench = Bench()
        val file = bench.add("notes.txt", "start\n")
        val theirs = bench.theirs(file.id, "theirs\n")
        assertTrue(TextSave.version("mine\n", bench.file(file.id), folder, theirs, start(bench)) is TextSaved.Saved)
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
        val made = TextSave.copy("mine\n", file, folder, sources, start(bench))
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
        val saved = TextSave.version("mine", file, folder, file.node.currentVersion?.id, start(bench)) as TextSaved.Saved
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
            TextSave.version("b", file, folder, file.node.currentVersion?.id, start(bench), stillOn = { false })
        }
        assertThrows(TextEditing.SessionEnded::class.java) {
            TextSave.copy("b", file, folder, SaveSources.OwnWriting, start(bench), stillOn = { false })
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
            TextSave.version("b", file, folder, file.node.currentVersion?.id, start, stillOn = { on }, pause = {})
        }
        assertEquals(1, bench.versions.getValue(file.id).size)
        assertTrue(journal.list().isEmpty())
        on = true
        assertThrows(TextEditing.SessionEnded::class.java) {
            TextSave.copy("b", file, folder, SaveSources.OwnWriting, start, stillOn = { on }, pause = {})
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
