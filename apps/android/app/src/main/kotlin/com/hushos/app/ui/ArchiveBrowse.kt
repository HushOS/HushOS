package com.hushos.app.ui

import android.content.ContentResolver
import android.net.Uri
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.hushos.app.data.ArchiveTree
import com.hushos.app.data.OpenArchive
import com.hushos.app.data.Opened
import com.hushos.core.ArchiveEntry
import com.hushos.core.ArchiveFolders
import com.hushos.core.ArchiveException
import com.hushos.core.EntrySink
import com.hushos.core.FetchException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.coroutines.cancellation.CancellationException

/*
 * A zip open in the app, held by the view model so it outlives the screen's composition: a rotation
 * keeps the open session (and with it the password, which only the core holds), the folder, the
 * item open, the download the Save dialog is choosing a place for, and every download under way.
 * Closing it (Back, another archive, the model going) closes its sessions and ends its downloads.
 *
 * Each download runs on a sibling of the open session (the core's `sibling()`: the same listing and
 * the password it holds, a reader of its own), so previews never wait behind it, a password-protected
 * item's download included. The sibling is closed when the download ends, with the archive, and by
 * a sign-out.
 */
/*
 * What an archive screen is open on: its id and name, and the drive's row when there is one (a zip
 * opened from "On this phone" by its record alone has none), for Send a copy of the archive.
 */
data class ArchiveSubject(val id: String, val name: String, val item: Opened? = null, val kept: java.io.File? = null) {
    companion object {
        fun of(item: Opened) = ArchiveSubject(item.id, item.name, item)
    }
}

class ArchiveBrowse(
    subject: ArchiveSubject,
    private val scope: CoroutineScope,
    /*
     * Opens the archive. `resolved` hears the subject as it is now (a family file another member
     * replaced, read again before opening), which the screen then names and sends.
     */
    private val open: suspend (resolved: (ArchiveSubject) -> Unit) -> OpenArchive,
    /* Builds the folder tree, off the main thread; the tests stop it part-way. */
    private val build: suspend (List<ArchiveEntry>, ArchiveFolders) -> ArchiveTree = { entries, folders ->
        withContext(Dispatchers.Default) { ArchiveTree(entries, folders) }
    },
    /* A 401 under the archive's reads, with the session it was read under: the app's session check. */
    private val refused: (com.hushos.app.data.Shared.Session?) -> Unit = {},
) {
    /* What a failed call says; a 401 goes to the session check first, as the drive's reads do. */
    fun failed(error: Throwable, entry: Boolean = false): String {
        if (error is com.hushos.app.data.ArchiveSessionRefused) refused(error.session)
        return archiveFailure(error, entry)
    }

    /* The id it was opened for: the app's state names it, and a later resolution never changes it. */
    val id = subject.id
    var subject by mutableStateOf(subject)
        private set
    var archive by mutableStateOf<OpenArchive?>(null)
        private set
    var tree by mutableStateOf<ArchiveTree?>(null)
        private set
    var hidden by mutableStateOf(0)
        private set
    var failure by mutableStateOf<String?>(null)
        private set
    /* The folders from the top to the one shown, by their numbers in the tree. */
    var path by mutableStateOf(listOf<Int>())
    var opened by mutableStateOf<ArchiveEntry?>(null)
    var unlocked by mutableStateOf(false)
    /* The password held, which only its quick check had passed, was let go of: the cards say it may be wrong. */
    var doubted by mutableStateOf(false)

    /*
     * The archive holds no password: every locked item asks again, saying it may have been wrong
     * when the core let go of it (`password-unproven`).
     */
    fun passwordLost(doubt: Boolean) {
        unlocked = false
        doubted = doubt
    }
    /*
     * The item a Download waits on a password for (its own, or the archive's): kept apart from the
     * item merely shown, and across a rotation, so once it unlocks the download goes on (its
     * confirmation, then the Save dialog) rather than a preview.
     */
    var downloadAfterPassword by mutableStateOf<UInt?>(null)
        private set

    /* An item opened to look at it: a Download waiting on another item's password is let go of. */
    fun show(entry: ArchiveEntry?) {
        opened = entry
        if (downloadAfterPassword != entry?.index) downloadAfterPassword = null
    }

    /* An item opened to download it, which first asks for its password. */
    fun downloadOnceUnlocked(entry: ArchiveEntry) {
        opened = entry
        downloadAfterPassword = entry.index
    }

    /* `entry` opened with the password typed: true, once, if a Download waits on it (the caller goes on to it). */
    fun unlockedFor(entry: ArchiveEntry): Boolean {
        unlocked = true
        doubted = false
        reprompt.remove(entry.index)
        if (downloadAfterPassword != entry.index) return false
        downloadAfterPassword = null
        return true
    }
    var asking by mutableStateOf<ArchiveEntry?>(null)
    /* The download whose place the Save dialog is choosing: kept across a rotation. */
    var waitingFor by mutableStateOf<ArchiveEntry?>(null)
    /* Items whose own password is asked for (the one held didn't open them). */
    val reprompt = mutableStateListOf<UInt>()
    val downloads = mutableStateListOf<EntryDownload>()

    private var loading: Job? = null
    @Volatile var closed = false
        private set

    init {
        load()
    }

    fun load() {
        if (closed) return
        failure = null
        loading?.cancel()
        archive?.close()
        archive = null
        tree = null
        unlocked = false
        reprompt.clear()
        loading = scope.launch {
            var opened: OpenArchive? = null
            try {
                opened = open { now -> if (!closed) subject = now }
                if (closed) return@launch
                // Read across the FFI off the main thread too: up to 100,000 entries are made into objects.
                val (entries, folders) = withContext(Dispatchers.IO) { opened.entries to opened.takeFolders() }
                val built = build(entries, folders)
                // The archive before its tree: whoever sees the tree may already use the archive. A proof or a
                // forget that closes it from here takes the list and the item shown off the screen at once.
                opened.onFamilyClosed = { words -> scope.launch { familyClosed(opened, words) } }
                // Closed while the tree was built (its family let go of, its workspace proven a family's): never shown.
                opened.refusal()?.let { words -> failure = words; return@launch }
                hidden = opened.hidden
                archive = opened
                tree = built
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                failure = failed(error)
            } finally {
                // Opened but never handed over (Back while the tree was building, a close, a failure):
                // closed here, or nothing would close it before a sign-out.
                if (opened != null && archive !== opened) opened.close()
            }
        }
    }

    /*
     * Streams `entry` into the file the person picked (`destination`), nothing of it anywhere else.
     * Opened ("wt": truncated) only at its first piece. A download that fails or is stopped deletes
     * the file when the Save dialog made it (empty before it began) or when anything was written to
     * it (a file it replaces is already gone by then, and a part of the entry is never left under
     * that name); one refused before any piece leaves a replaced file as it was.
     */
    fun startDownload(entry: ArchiveEntry, destination: SaveDestination, done: () -> Unit) {
        if (closed || archive == null) { discardIfMade(destination); return }
        val record = EntryDownload(entry)
        downloads.add(record)
        record.job = scope.launch {
            // Empty when the Save dialog made it for this download (unknown is never taken as made).
            var made: Boolean? = null
            val stream = SaveStream(destination)
            var failure: Throwable? = null
            try {
                made = withContext(Dispatchers.IO) { destination.size() == 0L }
                val main = archive ?: throw CancellationException("Closed.")
                val session = main.sibling()
                try {
                    withContext(Dispatchers.IO) {
                        session.download(entry.index, object : EntrySink {
                            override fun write(chunk: ByteArray) {
                                try {
                                    stream.write(chunk)
                                } catch (error: Exception) {
                                    // In HushOS's words, never the system's (a provider's message, a path).
                                    throw FetchException.Failed(com.hushos.app.data.Problems.say(error, com.hushos.app.data.ArchiveWords.NOT_SAVED))
                                }
                                record.written.value += chunk.size
                            }
                        })
                        // An empty entry writes nothing: its file is opened and emptied all the same.
                        stream.openEmpty()
                    }
                } finally {
                    session.close()
                }
            } catch (error: Throwable) {
                failure = error
            } finally {
                // Closed, then judged, in one step no cancel can skip (a stop, Back, a family let-go, a sign-out):
                // a call thread still running writes nothing more, and what the download made goes.
                withContext(NonCancellable + Dispatchers.IO) {
                    val closing = stream.close()
                    // A provider that fails as it commits failed the download, however much was written.
                    if (failure == null && closing.error != null) {
                        failure = FetchException.Failed(com.hushos.app.data.Problems.say(closing.error, com.hushos.app.data.ArchiveWords.NOT_SAVED))
                    }
                    // Nothing was written before `made` was known, so it can be asked now when a cancel came first.
                    if (failure != null && (closing.wrote || (made ?: (destination.size() == 0L)))) destination.delete()
                }
            }
            val error = failure
            when {
                error == null -> {
                    downloads.remove(record)
                    done()
                }
                error is CancellationException -> {
                    downloads.remove(record)
                    throw error
                }
                else -> downloadFailed(record, error)
            }
        }
    }

    /*
     * A download that failed. One refused for its password (the item has one of its own, not the one
     * held) goes to the item, which asks for it and unlocks by its index; anything else stays on the
     * download's bar in its words.
     */
    internal fun downloadFailed(record: EntryDownload, error: Throwable) {
        if (error is ArchiveException.Refused && error.code == "wrong-password") {
            downloads.remove(record)
            if (record.entry.index !in reprompt) reprompt.add(record.entry.index)
            downloadOnceUnlocked(record.entry)
            return
        }
        // No password held for it any more (the held one, maybe wrong, let go of): asked for again.
        if (error is ArchiveException.Refused && (error.code == "password-unproven" || error.code == "password")) {
            downloads.remove(record)
            passwordLost(doubt = error.code == "password-unproven")
            downloadOnceUnlocked(record.entry)
            return
        }
        record.error.value = failed(error, entry = true)
    }

    /* A picked file no download will fill: deleted if the Save dialog made it (empty), left if it was there before or unknown. */
    fun discardIfMade(destination: SaveDestination) {
        if (destination.size() == 0L) destination.delete()
    }

    fun stop(record: EntryDownload) {
        record.job?.cancel()
        downloads.remove(record)
    }

    /*
     * Its workspace proven a family's, or its family let go of: the archive is closed, and nothing it
     * showed stays (the list, the item open, the downloads), only the family's words.
     */
    private fun familyClosed(which: OpenArchive, words: String) {
        if (archive !== which) return
        for (record in downloads.toList()) record.job?.cancel()
        downloads.clear()
        archive = null
        tree = null
        opened = null
        failure = words
    }

    fun close() {
        closed = true
        loading?.cancel()
        for (record in downloads.toList()) record.job?.cancel()
        // Its siblings (each download's) close with it.
        archive?.close()
    }

}

class EntryDownload(val entry: ArchiveEntry) {
    val written = mutableStateOf(0L)
    val error = mutableStateOf<String?>(null)
    var job: Job? = null
}

/* Where a download is saved: the document the Save dialog picked. */
interface SaveDestination {
    /* Its size before anything is written: 0 for one the Save dialog made, null when the provider doesn't say. */
    fun size(): Long?
    /* Opened for writing from its start, truncated ("wt"). */
    fun open(): java.io.OutputStream
    fun delete()
}

class DocumentDestination(private val resolver: ContentResolver, private val uri: Uri) : SaveDestination {
    override fun size(): Long? = runCatching {
        resolver.query(uri, arrayOf(android.provider.OpenableColumns.SIZE), null, null, null)?.use { row ->
            if (row.moveToFirst() && !row.isNull(0)) row.getLong(0) else null
        }
    }.getOrNull()
    override fun open(): java.io.OutputStream = resolver.openOutputStream(uri, "wt") ?: throw java.io.IOException("No stream.")
    override fun delete() {
        runCatching { android.provider.DocumentsContract.deleteDocument(resolver, uri) }
    }
}

/*
 * A download's file, opened at its first piece, under one lock: written on the call's thread,
 * closed on the coroutine's. Once closed it opens and writes nothing more, so a call thread still
 * running after a cancel or the watchdog never truncates or writes the file again.
 */
private class SaveStream(private val destination: SaveDestination) {
    private var out: java.io.OutputStream? = null
    private var closed = false
    private var wrote = false

    @Synchronized fun write(chunk: ByteArray) {
        if (closed) throw java.io.IOException("The download ended.")
        val stream = out ?: destination.open().also { out = it }
        wrote = true
        stream.write(chunk)
    }

    @Synchronized fun openEmpty() {
        if (!closed && out == null) out = destination.open()
    }

    /* Closes it for good: whether anything was written, and what closing it (the provider's commit) failed with. */
    @Synchronized fun close(): Closed {
        closed = true
        val error = runCatching { out?.close() }.exceptionOrNull()
        out = null
        return Closed(wrote, error)
    }

    class Closed(val wrote: Boolean, val error: Throwable?)
}
