package com.hushos.app.data

import com.hushos.core.LineEnding
import com.hushos.core.PlannedResult
import com.hushos.core.RunControl
import com.hushos.core.TextFormat
import com.hushos.core.TextOpened
import com.hushos.core.TextReadOnly
import com.hushos.core.toolWatchdogMillis
import com.hushos.core.textEditLimit
import com.hushos.core.textEditableKind
import com.hushos.core.textOpen
import com.hushos.core.textEncode

/*
 * Editing 1a and 1b on the phone (docs/editing-design.md sections 1 and 3, the web's lib/editor/text-edit.ts and lib/editor/text-save.ts,
 * iOS's TextEditing.swift): which files the text editor opens, whether it may change them, the bytes a save writes, and how
 * a save goes through the save path (SaveRuns.kt), never a second one.
 *
 * A file opens for editing only when what the editor saves is the file byte for byte except for the edit, in its own
 * encoding (UTF-8 with or without a byte order mark, UTF-16 with one), byte order mark and line breaks (LF or CRLF; a mixed
 * file keeps its majority on an edit): the core decides and writes (text_edit.rs, held to the web by
 * fixtures/text-edit-cases.json). Anything else opens read-only with a note, never transcoded.
 */
object TextEditing {
    /* The largest file the editor opens for editing (8 MiB, the web's text preview limit). */
    val LIMIT: Long get() = textEditLimit().toLong()

    /* A file the editor opens, by its name and recorded type (the bytes decide after that). */
    fun opens(name: String, mime: String?): Boolean = textEditableKind(name, mime)

    fun opens(item: Opened): Boolean = !item.isFolder && item.node.currentVersion != null && opens(item.name, item.metadata.mime)

    /* What each read-only reason says, in the web's words. */
    fun words(reason: TextReadOnly): String = when (reason) {
        TextReadOnly.TOO_LARGE -> "This file is too large to edit here."
        TextReadOnly.ENCODING -> "This file uses an encoding HushOS can’t edit without changing it."
        TextReadOnly.BINARY -> "This file isn’t plain text, so it can’t be edited here."
        TextReadOnly.LINE_ENDINGS -> "This file uses line endings HushOS can’t edit without changing them."
    }

    /* What the editor says of a file that mixes line endings, in the web's words: an edit writes them all one way. */
    fun mixedNote(format: TextFormat): String? = if (!format.mixed) null
        else "This file mixes line endings; saving uses ${if (format.lineEnding == LineEnding.CRLF) "Windows (CRLF)" else "Unix (LF)"}."

    sealed class Open {
        /* Without the byte order mark, every line break as LF. */
        data class Editable(val text: String, val format: TextFormat) : Open()
        /* The text is shown when it decodes (never past the limit, never binary, never a guess at another encoding), and never saved. */
        data class ReadOnly(val reason: TextReadOnly, val text: String?) : Open()
    }

    /* The bytes as the editor holds them, as the core reads them. */
    fun open(bytes: ByteArray): Open = when (val opened = textOpen(bytes)) {
        is TextOpened.Editable -> Open.Editable(opened.text, opened.format)
        is TextOpened.ReadOnly -> Open.ReadOnly(opened.reason, opened.text)
    }

    /*
     * One editing session's saves, as on the web (lib/editor/text-edit.ts SaveState) and held to the same fixture (`sessions`): the
     * format found when the file opened, kept for the whole session (a save that removed every line break still writes CRLF
     * for the next one typed; a text grown past the limit still saves), and the text and bytes last opened or saved, which
     * only answer "nothing changed".
     */
    class SaveState private constructor(val format: TextFormat, val text: String, val bytes: ByteArray) {
        /*
         * What a save writes for `text`: the bytes last opened or saved while the text is still theirs, else the text in the
         * session's format. Throws HalfCharacter for a text that can't be written as it is (`writable`): nothing is saved.
         */
        fun bytes(text: CharSequence): ByteArray = when {
            same(text, this.text) -> bytes
            !writable(text) -> throw HalfCharacter()
            else -> textEncode(format, text.toString())
        }

        /* After a save of `text` landed as `bytes`: what the next one compares with. */
        fun saved(text: String, bytes: ByteArray) = SaveState(format, text, bytes)

        /* The same text and bytes, saved in `format` from here: a draft restored brings the format it was typed under. */
        fun inFormat(format: TextFormat) = SaveState(format, text, bytes)

        companion object {
            /* The session of `bytes`, already opened as `opened`: never decoded a second time. */
            fun opening(opened: Open.Editable, bytes: ByteArray) = SaveState(opened.format, opened.text, bytes)

            /* The session of bytes that open for editing; null when they open read-only. */
            fun opening(bytes: ByteArray): SaveState? = (open(bytes) as? Open.Editable)?.let { opening(it, bytes) }
        }
    }

    /*
     * A line break typed or pasted into the system's text view, as the editor keeps it: CRLF and a lone CR become LF, as
     * CodeMirror does on the web; a save writes each one as the file's line break.
     */
    fun lineFeeds(inserted: CharSequence): CharSequence =
        if ('\r' !in inserted) inserted else inserted.toString().replace("\r\n", "\n").replace('\r', '\n')

    /* The save's session ended (the editor closed, another sign-in): nothing was started. */
    class SessionEnded : Exception("This editor was closed before the save started.")

    /*
     * Whether two texts are the same: Kotlin compares UTF-16 code units, so "é" and "e" + U+0301 differ, as the bytes
     * a save writes do.
     */
    fun same(a: CharSequence, b: CharSequence): Boolean = a.toString() == b.toString()

    /*
     * Whether `text` can be written as it is: a surrogate without its pair (half an emoji, which a Kotlin string can hold)
     * would reach the core as "?" in its place, a character nobody typed. As on the web (lib/editor/text-edit.ts `writable`).
     */
    fun writable(text: CharSequence): Boolean {
        var at = 0
        while (at < text.length) {
            val c = text[at]
            if (Character.isLowSurrogate(c)) return false
            if (Character.isHighSurrogate(c)) {
                if (at + 1 >= text.length || !Character.isLowSurrogate(text[at + 1])) return false
                at++
            }
            at++
        }
        return true
    }

    /* A save of text holding half a character: refused before anything is written; the text stays as it is. */
    class HalfCharacter : Exception("half a character")

    /* Why a listing can't stand for the file's folder: it answered for another folder or another workspace. */
    class WrongFolder : Exception("HushOS answered with a different folder than this file’s. Nothing was saved.")

    /*
     * The file's folder and the file in a listing asked for by the file's own folder and workspace, or WrongFolder when the
     * listing answers for another: a save never goes into a folder the editor didn't open the file from. The file is the
     * row with its id in that same workspace and folder, or null when it is not on this page.
     */
    /*
     * The folder and file as the vault opened them, held to the editor's file again: the folder must be the file's own (else
     * WrongFolder); a file row the vault swapped for one elsewhere (moved since) is absent from this folder, never adopted.
     */
    /*
     * Where an editor writes: the workspace and folder it opened its file in, fixed at open (a copy goes into that same
     * folder). Never taken from a row a save or a copy answers with afterwards: a completion answered again, or a row this
     * device adopts, may already show the file moved elsewhere, and the next save then finds it gone from here (the
     * moved-file case), never writes where it went.
     */
    data class Destination(val workspaceId: String, val parentId: String) {
        /* Whether `row` is a file in this folder of this workspace: only then may it set the version a save goes on from. */
        fun holds(row: Opened): Boolean = !row.isFolder && row.node.workspaceId.equals(workspaceId, ignoreCase = true) && row.node.parentId == parentId

        companion object {
            fun of(file: Opened): Destination? = file.node.parentId?.let { Destination(file.node.workspaceId, it) }
        }
    }

    /*
     * Whether a row a save or a copy answered with speaks for the editor's text (its header's name and marks): only when it
     * lists the very version that was published (`versionId`), in the editor's folder. A row already showing someone
     * else's newer version, or the file elsewhere, never takes the marks off the version the text is.
     */
    fun speaksFor(row: Opened, versionId: String?, destination: Destination?): Boolean =
        versionId != null && row.node.currentVersion?.id == versionId && destination?.holds(row) == true

    fun held(folder: Opened, file: Opened?, original: Opened, at: Destination? = Destination.of(original)): Pair<Opened, Opened?> {
        val parent = at?.parentId
        val ws = at?.workspaceId ?: original.node.workspaceId
        if (parent == null || folder.id != parent || !folder.isFolder || !folder.node.workspaceId.equals(ws, ignoreCase = true))
            throw WrongFolder()
        val same = file != null && file.id == original.id && !file.isFolder && file.node.workspaceId.equals(ws, ignoreCase = true) &&
            file.node.parentId == parent
        return folder to (if (same) file else null)
    }

    fun target(folder: NodeView, children: List<NodeView>, file: Opened, at: Destination? = Destination.of(file)): Pair<NodeView, NodeView?> {
        val parent = at?.parentId
        val ws = at?.workspaceId ?: file.node.workspaceId
        if (parent == null || folder.id != parent || folder.kind != "folder" || !folder.workspaceId.equals(ws, ignoreCase = true))
            throw WrongFolder()
        val row = children.firstOrNull {
            it.id == file.id && it.workspaceId.equals(ws, ignoreCase = true) && it.parentId == parent && it.kind == "file"
        }
        return folder to row
    }

    /*
     * The bytes of `file`'s version, the one its row names, read in its own workspace (Vault.openVersion refuses a family's
     * file not opened through its ledger) into memory: never a decrypted copy on disk a killed process could leave, at most
     * `limit` + 1 bytes. `cancelled` ends the read.
     */
    fun bytesOf(vault: Vault, file: Opened, limit: Long, control: RunControl = RunControl(toolWatchdogMillis(), null)): ByteArray {
        // A 401 renewing the object's address mid-read: thrown as itself, for the editor's session check, not the core's failure.
        val refused = java.util.concurrent.atomic.AtomicReference<NotAuthenticated?>(null)
        try {
            val reader = vault.toolReader(file, control, refused = refused)
            val length = minOf(reader.size(), (limit + 1).toULong())
            return reader.readAt(0uL, length)
        } catch (error: Exception) {
            throw refused.get() ?: error
        } finally {
            control.finish()
        }
    }
}

/* What a save did: a new version, or someone else's version is current (null: the file is gone from its folder). */
sealed class TextSaved {
    /* `versionId`: the version this save published, as minted; null when not known (the next save then asks the stale question). */
    data class Saved(val item: Opened, val versionId: String?) : TextSaved()
    data class Stale(val currentVersionId: String?) : TextSaved()
}

/* A copy saved: the new file, and its version as minted (null when not known). */
data class TextCopy(val file: Opened, val versionId: String?)

/* The editor's saves over the save path. `start` makes the run (SaveRun.start over the vault's writer; a stand-in in tests). */
object TextSave {
    fun interface Start {
        fun run(targets: List<Opened>, results: List<PlannedResult>): SaveRun
    }

    /*
     * Ends a run whose result is in: its row goes. A row this phone wouldn't update is asked again (never the upload); past
     * the tries the run is cancelled, which keeps what landed and lets the run go, its row settled at the next open. Never
     * throws: what was saved stays saved.
     */
    fun end(run: SaveRun, tries: Int = 3, pause: (Int) -> Unit = { Thread.sleep(250L * it) }): Boolean {
        for (attempt in 1..tries) {
            try {
                run.finish()
                return true
            } catch (error: Exception) {
                if (attempt < tries) pause(attempt)
            }
        }
        runCatching { run.cancel() }
        return false
    }

    /* The app's runs: over the vault's writer, with this account's journal. */
    fun runs(writer: SaveRunWriter, journal: SaveRunJournal) = Start { targets, results -> SaveRun.start(writer, targets, results, journal) }

    /*
     * Save, and Save on top: a new version of `file` holding `bytes` (SaveState.bytes), unless the file moved on from
     * `startedFrom` (Save on top passes the version current now). Planned as those bytes with no thumbnail, signed as the
     * person's own writing.
     */
    fun version(bytes: ByteArray, file: Opened, folder: Opened, startedFrom: String?, start: Start,
                stillOn: () -> Boolean = { true }, pause: (Int) -> Unit = { Thread.sleep(250L * it) }): TextSaved {
        // Asked last thing before the run starts: a save whose session ended uploads nothing.
        if (!stillOn()) throw TextEditing.SessionEnded()
        val run = start.run(listOf(file), listOf(PlannedResult.Known(bytes.size.toULong(), false)))
        // Starting waited (the room check, the run's record): asked again before any byte goes; the empty run retired.
        if (!stillOn()) {
            end(run, pause = pause)
            throw TextEditing.SessionEnded()
        }
        // Its completion asks the session too: a save whose editor went while its bytes were going up never lands.
        run.holdTo(stillOn)
        val saved = run.version(bytes, file, folder, startedFrom, SaveSources.OwnWriting, file.metadata.mime)
        // Its only result is in, saved or not: the row goes.
        end(run, pause = pause)
        return when (saved) {
            is VersionSaved.Saved -> TextSaved.Saved(saved.item, saved.versionId)
            is VersionSaved.Stale -> TextSaved.Stale(saved.currentVersionId)
        }
    }

    /* Save as a copy: a new file beside `file` under the next free name holding `bytes`, signed as `file` is (`sources`). */
    fun copy(bytes: ByteArray, file: Opened, folder: Opened, sources: SaveSources, start: Start,
             stillOn: () -> Boolean = { true }, pause: (Int) -> Unit = { Thread.sleep(250L * it) }): TextCopy {
        if (!stillOn()) throw TextEditing.SessionEnded()
        val run = start.run(listOf(folder), listOf(PlannedResult.Known(bytes.size.toULong(), false)))
        if (!stillOn()) {
            end(run, pause = pause)
            throw TextEditing.SessionEnded()
        }
        val minted = java.util.concurrent.atomic.AtomicReference<String?>(null)
        run.holdTo(stillOn)
        val made = run.file(bytes, file.name, file.metadata.mime, sources, folder = folder, minted = minted)
        end(run, pause = pause)
        return TextCopy(made, minted.get())
    }
}

/*
 * Who may change an item that isn't a family folder's: their own only when their own workspace is known and is the item's
 * (never assumed before it loads), otherwise an editor's mount that covers it and is a folder above it (a file shared on
 * its own can't be saved: its folder can't be listed).
 */
object EditRights {
    /*
     * The share an item came through: the mount whose root is the item or the nearest folder above it, matched by workspace
     * and id (another workspace's node with the same id is never the share's root). `parent`: an item's parent in its own
     * workspace, or null.
     */
    fun <M> nearestMount(item: Opened, mounts: List<M>, root: (M) -> Opened?, parent: (Opened) -> Opened?): M? {
        var cursor: Opened? = item
        var steps = 0
        while (cursor != null && steps++ < 256) {
            val at = cursor
            mounts.firstOrNull { mount ->
                root(mount)?.let { it.id == at.id && it.node.workspaceId.equals(at.node.workspaceId, ignoreCase = true) } == true
            }?.let { return it }
            cursor = parent(at)
        }
        return null
    }

    /*
     * Whether this person may change an item that isn't a family folder's: their own once their own workspace is known and is
     * the item's; otherwise through shares, as the server decides it (packages/db accessFor): the grant nearest the item (its
     * own first) decides the role (two on one node: the viewer's), and a grant on a folder above must exist too, or its
     * folder can't be listed for a save. `mounts`: each received share's root and role; `parent`: an item's parent in its
     * own workspace.
     */
    fun mayEdit(item: Opened, ownWorkspace: String?, mounts: List<Pair<Opened, String>>, parent: (Opened) -> Opened?): Boolean {
        if (ownWorkspace != null && ownWorkspace.equals(item.node.workspaceId, ignoreCase = true)) return true
        var role: String? = null
        var cursor: Opened? = item
        var steps = 0
        while (cursor != null && steps++ < 256) {
            val at = cursor
            val here = mounts.filter { (root, _) -> root.id == at.id && root.node.workspaceId.equals(at.node.workspaceId, ignoreCase = true) }
            if (here.isNotEmpty()) {
                role = role ?: if (here.all { it.second == "editor" }) "editor" else "viewer"
                if (at !== item && at.id != item.id) return role == "editor"
            }
            cursor = parent(at)
        }
        return false
    }
}

/*
 * One text editor's session (Editing 1a): the vault it opened under and which opened text is on screen. Every save, copy
 * and Open theirs takes a token before its first wait and asks it right before a run starts and before anything it found
 * reaches the screen: the editor closed, another session (a sign-in replacing the vault), or Open theirs since, and the
 * work publishes nothing.
 */
class EditSession<T : Any>(val owner: T, private val current: () -> T?) {
    class Token<T>(val owner: T, internal val opening: Int)

    @Volatile private var opening = 0
    @Volatile var closed = false
        private set

    /* A token for work beginning now; null once closed or under another vault. */
    fun take(): Token<T>? = if (!closed && current() === owner) Token(owner, opening) else null

    /* Whether work begun with `token` may go on: not closed, still this session's vault, the same opened text. */
    fun live(token: Token<T>): Boolean = !closed && current() === owner && token.owner === owner && token.opening == opening

    /* Another text opened (Open theirs): earlier work publishes nothing over it. */
    fun reopened() { opening += 1 }

    fun close() { closed = true }
}
