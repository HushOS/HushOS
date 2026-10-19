package com.hushos.app.data

import android.content.Context
import android.provider.DocumentsContract

/* The file pickers and Files by Google ask again: HushOS's root (signed in or out) and the root's listing. */
object FilesRoots {
    const val ROOT_DOCUMENT = "root"

    fun authority(context: Context) = "${context.packageName}.documents"

    fun changed(context: Context) {
        val authority = authority(context)
        runCatching {
            context.contentResolver.notifyChange(DocumentsContract.buildRootsUri(authority), null)
            context.contentResolver.notifyChange(DocumentsContract.buildChildDocumentsUri(authority, ROOT_DOCUMENT), null)
        }
    }
}
