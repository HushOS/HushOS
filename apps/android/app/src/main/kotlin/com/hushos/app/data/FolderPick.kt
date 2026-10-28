package com.hushos.app.data

import android.content.ContentResolver
import android.net.Uri
import android.provider.DocumentsContract

/*
 * A folder picked for upload, read the way the web reads a dropped one: each file with
 * the folder path it came from (the picked folder's own name first), and every folder
 * the pick holds, so an empty one is made too. Hidden files and folders (.DS_Store,
 * .git) stay behind, as file managers hide them.
 */
object FolderPick {
    class File(val uri: Uri, val name: String, val path: List<String>)

    /* What a pick holds; a hidden picked folder (its own name starts with ".") holds nothing. */
    class Picked(val top: String, val files: List<File>, val folders: List<List<String>>)

    fun hidden(name: String) = name.startsWith(".")

    /* What the picked tree holds, walked depth first with one query per folder. */
    fun read(resolver: ContentResolver, tree: Uri): Picked? {
        val rootId = DocumentsContract.getTreeDocumentId(tree)
        val top = resolver.query(DocumentsContract.buildDocumentUriUsingTree(tree, rootId), arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)
            ?.use { if (it.moveToFirst()) it.getString(0) else null }?.let(::wellFormed) ?: return null
        if (hidden(top)) return Picked(top, emptyList(), emptyList())
        val files = ArrayList<File>()
        val folders = arrayListOf(listOf(top))
        val columns = arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE)
        fun walk(id: String, path: List<String>) {
            val children = ArrayList<Triple<String, String, String?>>()
            resolver.query(DocumentsContract.buildChildDocumentsUriUsingTree(tree, id), columns, null, null, null)?.use { cursor ->
                // Names as the provider gives them may hold a lone surrogate: made well formed before they become folders and files.
                while (cursor.moveToNext()) children.add(Triple(cursor.getString(0), wellFormed(cursor.getString(1) ?: continue), cursor.getString(2)))
            }
            for ((child, name, mime) in children) {
                if (hidden(name)) continue
                if (mime == DocumentsContract.Document.MIME_TYPE_DIR) {
                    folders.add(path + name)
                    walk(child, path + name)
                } else {
                    files.add(File(DocumentsContract.buildDocumentUriUsingTree(tree, child), name, path))
                }
            }
        }
        walk(rootId, listOf(top))
        return Picked(top, files, folders)
    }

    /* Every folder the files and folders need, each prefix included, parents before children. */
    fun plan(files: List<List<String>>, folders: List<List<String>>): List<List<String>> {
        val ordered = LinkedHashSet<List<String>>()
        for (path in folders + files) for (depth in 1..path.size) ordered.add(path.take(depth))
        // sortedBy is stable: a parent always comes before anything inside it.
        return ordered.sortedBy { it.size }
    }
}
