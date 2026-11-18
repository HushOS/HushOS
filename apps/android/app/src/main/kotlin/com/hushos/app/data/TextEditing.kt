package com.hushos.app.data

import com.hushos.core.PlannedResult
import com.hushos.core.TextReadOnly
import com.hushos.core.textEditLimit
import com.hushos.core.textEditableKind
import com.hushos.core.textReadOnly

/*
 * Editing 1a on the phone (docs/editing-design.md sections 1 and 3, the web's lib/text-edit.ts and lib/text-save.ts, iOS's
 * TextEditing.swift): which files the text editor opens, whether it may change them, and how a save goes through the save
 * path (SaveRuns.kt), never a second one.
 *
 * A file opens for editing only when what the editor saves is the file byte for byte except for the edit: the core decides
 * (text_edit.rs, held to the web by fixtures/text-edit-cases.json). Anything else opens read-only with a note.
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
        TextReadOnly.BYTE_ORDER_MARK, TextReadOnly.UTF16 -> "HushOS can’t edit this file’s encoding yet."
        TextReadOnly.ENCODING -> "This file uses an encoding HushOS can’t edit without changing it."
        TextReadOnly.BINARY -> "This file isn’t plain text, so it can’t be edited here."
        TextReadOnly.LINE_ENDINGS -> "This file uses Windows line endings, which HushOS can’t edit yet."
    }

    sealed class Open {
        data class Editable(val text: String) : Open()
        /* The text is shown when it decodes (never past the limit, never binary), and never saved. */
        data class ReadOnly(val reason: TextReadOnly, val text: String?) : Open()
    }

    /* The bytes as the editor holds them. */
    fun open(bytes: ByteArray): Open {
        val reason = textReadOnly(bytes) ?: return Open.Editable(bytes.decodeToString())
        return when (reason) {
            TextReadOnly.TOO_LARGE, TextReadOnly.BINARY, TextReadOnly.UTF16 -> Open.ReadOnly(reason, null)
            else -> Open.ReadOnly(reason, bytes.decodeToString())
        }
    }

    /* What a save writes: the text as UTF-8, nothing added, nothing taken away. */
    fun encode(text: CharSequence): ByteArray = text.toString().encodeToByteArray()

    /*
     * A line break typed or pasted into the system's text view, as the editor keeps it: CRLF and a lone CR become LF, as
     * CodeMirror does on the web, so a file the editor wrote never holds a carriage return.
     */
    fun lineFeeds(inserted: CharSequence): CharSequence =
        if ('\r' !in inserted) inserted else inserted.toString().replace("\r\n", "\n").replace('\r', '\n')
}

/* What a save did: a new version, or someone else's version is current (null: the file is gone from its folder). */
sealed class TextSaved {
    data class Saved(val item: Opened) : TextSaved()
    data class Stale(val currentVersionId: String?) : TextSaved()
}

/* The editor's saves over the save path. `start` makes the run (SaveRun.start over the vault's writer; a stand-in in tests). */
object TextSave {
    fun interface Start {
        fun run(targets: List<Opened>, results: List<PlannedResult>): SaveRun
    }

    /* The app's runs: over the vault's writer, with this account's journal. */
    fun runs(writer: SaveRunWriter, journal: SaveRunJournal) = Start { targets, results -> SaveRun.start(writer, targets, results, journal) }

    /*
     * Save, and Save on top: a new version of `file` holding `text`, unless the file moved on from `startedFrom` (Save on
     * top passes the version current now). Planned as its UTF-8 bytes with no thumbnail, signed as the person's own writing.
     */
    fun version(text: CharSequence, file: Opened, folder: Opened, startedFrom: String?, start: Start): TextSaved {
        val bytes = TextEditing.encode(text)
        val run = start.run(listOf(file), listOf(PlannedResult.Known(bytes.size.toULong(), false)))
        val saved = run.version(bytes, file, folder, startedFrom, SaveSources.OwnWriting, file.metadata.mime)
        // Its only result is in, saved or not: the row goes. One this phone couldn't update stays for the next open.
        runCatching { run.finish() }
        return when (saved) {
            is VersionSaved.Saved -> TextSaved.Saved(saved.item)
            is VersionSaved.Stale -> TextSaved.Stale(saved.currentVersionId)
        }
    }

    /* Save as a copy: a new file beside `file` under the next free name, signed as `file` is (`sources`). */
    fun copy(text: CharSequence, file: Opened, folder: Opened, sources: SaveSources, start: Start): Opened {
        val bytes = TextEditing.encode(text)
        val run = start.run(listOf(folder), listOf(PlannedResult.Known(bytes.size.toULong(), false)))
        val made = run.file(bytes, file.name, file.metadata.mime, sources, folder = folder)
        runCatching { run.finish() }
        return made
    }
}
