package com.hushos.app.data

import com.hushos.core.Integrity
import com.hushos.core.NodeMetadata
import com.hushos.core.PlannedResult
import com.hushos.core.TextReadOnly
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
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
            if (replacing != null) {
                val list = versions[replacing.id] ?: throw SaveStale(null)
                if (list.last().first != startedFrom) throw SaveStale(list.last().first)
                onBegun(Vault.BegunIds("ws", "up-$n", replacing.id))
                onCompleting("up-$n")
                list.add("v$n" to bytes)
                return file(replacing.id)
            }
            val id = "n$n"
            onBegun(Vault.BegunIds("ws", "up-$n", id))
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
        assertEquals("notes (3).txt", bench.names[made.id])
        assertEquals("mine\n", bench.text(made.id))
        assertEquals("theirs\n", bench.text(file.id))
        // An Unverified source's copy is never signed as the person's own writing.
        assertEquals(Integrity.UNKNOWN_SIGNER, bench.copies.last()?.metadata)
    }
}
