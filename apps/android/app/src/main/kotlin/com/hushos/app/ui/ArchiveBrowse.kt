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
class ArchiveBrowse(
    val item: Opened,
    private val scope: CoroutineScope,
    private val open: suspend () -> OpenArchive,
) {
    var archive by mutableStateOf<OpenArchive?>(null)
        private set
    var tree by mutableStateOf<ArchiveTree?>(null)
        private set
    var hidden by mutableStateOf(0)
        private set
    var failure by mutableStateOf<String?>(null)
        private set
    var path by mutableStateOf(listOf<String>())
    var opened by mutableStateOf<ArchiveEntry?>(null)
    var unlocked by mutableStateOf(false)
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
            try {
                val opened = open()
                if (closed) { opened.close(); return@launch }
                tree = withContext(Dispatchers.Default) { ArchiveTree(opened.entries) }
                hidden = opened.hidden
                archive = opened
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                failure = archiveFailure(error)
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
                record.error.value = archiveFailure(error, entry = true)
            } ?: run {
                downloads.remove(record)
                done()
            }
        }
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
