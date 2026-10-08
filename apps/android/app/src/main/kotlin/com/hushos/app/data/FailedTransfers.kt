package com.hushos.app.data

import java.io.File
import java.net.URLDecoder
import java.net.URLEncoder

/*
 * A queued transfer that failed, as the app keeps it: not WorkManager's job record,
 * which it prunes after about a day, but the app's own, beside the account's other
 * files (AccountStore wipes it with them). It holds what the row shows and what Retry
 * needs: for an upload, the copy staged in the app's storage (which stays readable
 * across days and reboots), the folder and the file it replaces; for a keep, the item.
 */
data class FailedTransfer(
    val id: String, val kind: String, val name: String, val reason: String, val at: Long,
    val file: String? = null, val mime: String? = null, val folder: String? = null, val replacing: String? = null,
    val node: String? = null, val isFolder: Boolean = false, val shareRoot: String? = null,
) {
    /* An upload whose staged copy is gone can't be sent again: the row says to pick it again. */
    fun sourceGone(): Boolean = kind == TransferQueue.UPLOAD && (file == null || !File(file).exists())
}

/* The record on disk: one transfer per line, each field percent-encoded, so no format library is needed. */
class FailedTransfers(private val store: File) {
    fun all(): List<FailedTransfer> = runCatching { store.readLines() }.getOrDefault(emptyList()).mapNotNull(::decode)

    /* A failure to keep on the list; the same id again replaces it. */
    fun record(transfer: FailedTransfer) = write(all().filter { it.id != transfer.id } + transfer)

    /* Retried, made room for (and so sent again), or removed: off the list. */
    fun forget(id: String) {
        val list = all()
        if (list.any { it.id == id }) write(list.filter { it.id != id })
    }

    fun has(id: String) = all().any { it.id == id }

    @Synchronized
    private fun write(list: List<FailedTransfer>) {
        store.parentFile?.mkdirs()
        if (list.isEmpty()) store.delete() else store.writeText(list.joinToString("\n", transform = ::encode))
    }

    private fun encode(t: FailedTransfer) = listOf(
        t.id, t.kind, t.name, t.reason, t.at.toString(), t.file, t.mime, t.folder, t.replacing, t.node, t.isFolder.toString(), t.shareRoot,
    ).joinToString("\t") { if (it == null) "-" else "=" + URLEncoder.encode(it, "UTF-8") }

    private fun decode(line: String): FailedTransfer? = runCatching {
        val f = line.split("\t").map { if (it == "-") null else URLDecoder.decode(it.removePrefix("="), "UTF-8") }
        FailedTransfer(f[0]!!, f[1]!!, f[2]!!, f[3]!!, f[4]!!.toLong(), f[5], f[6], f[7], f[8], f[9], f[10] == "true", f[11])
    }.getOrNull()

    companion object {
        /* Beside the account's other files under filesDir; AccountStore lists it so it goes with them. */
        const val FILE = "transfers-failed.tsv"

        fun of(context: android.content.Context) = FailedTransfers(File(context.filesDir, FILE))
    }
}
