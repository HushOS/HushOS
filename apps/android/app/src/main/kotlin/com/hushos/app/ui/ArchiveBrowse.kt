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
                val built = build(opened.entries, opened.takeFolders())
                // Closed while the tree was built (its family let go of, its workspace proven a family's): never shown.
                opened.refusal()?.let { words -> failure = words; return@launch }
                // The archive before its tree: whoever sees the tree may already use the archive.
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
     * Streams `entry` into the file the person picked (`uri`), nothing of it anywhere else. A
     * download that fails or is stopped deletes what it made, the empty file included.
     */
    fun startDownload(entry: ArchiveEntry, resolver: ContentResolver, uri: Uri, done: () -> Unit) {
        if (closed || archive == null) { discard(resolver, uri); return }
        val record = EntryDownload(entry)
        downloads.add(record)
        record.job = scope.launch {
            val result = runCatching {
                val main = archive ?: throw CancellationException("Closed.")
                val session = main.sibling()
                try {
                withContext(Dispatchers.IO) {
                    resolver.openOutputStream(uri, "w")!!.use { out ->
                        session.download(entry.index, object : EntrySink {
                            override fun write(chunk: ByteArray) {
                                try {
                                    out.write(chunk)
                                } catch (error: Exception) {
                                    throw FetchException.Failed(error.message ?: "The file couldn't be written.")
                                }
                                record.written.value += chunk.size
                            }
                        })
                    }
                }
                } finally {
                    session.close()
                }
            }
            result.exceptionOrNull()?.let { error ->
                discard(resolver, uri)
                if (error is CancellationException) { downloads.remove(record); throw error }
                downloadFailed(record, error)
            } ?: run {
                downloads.remove(record)
                done()
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

    /* A picked file the download won't fill: gone, not left empty where the person put it. */
    fun discard(resolver: ContentResolver, uri: Uri) {
        runCatching { android.provider.DocumentsContract.deleteDocument(resolver, uri) }
    }

    fun stop(record: EntryDownload) {
        record.job?.cancel()
        downloads.remove(record)
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
