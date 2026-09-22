package com.hushos.app.data

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONObject

/*
 * The tree mirror, as the web keeps one in IndexedDB: every node of a
 * workspace as the server serves it, in SQLite so the app and the documents
 * provider read the same rows. Rows are envelopes and ids, the same bytes the
 * server holds; no name or key ever lands here. A page of the change feed and
 * the cursor it advances to are written in one transaction, so the cursor
 * never claims a page that was not kept. Thumbnail trailers are kept beside
 * the rows, still sealed, so a list draws its pictures without a round trip.
 */
class Mirror(context: Context) : SQLiteOpenHelper(context, "mirror.db", null, 1) {
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE nodes (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, json TEXT NOT NULL)")
        db.execSQL("CREATE INDEX nodes_workspace ON nodes (workspace_id)")
        db.execSQL("CREATE TABLE cursors (workspace_id TEXT PRIMARY KEY, cursor INTEGER NOT NULL)")
        db.execSQL("CREATE TABLE thumbnails (version_id TEXT PRIMARY KEY, bytes BLOB NOT NULL)")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {}

    /* The last change sequence applied for this workspace; 0 when nothing has been. */
    fun cursor(workspaceId: String): Int = readableDatabase.rawQuery("SELECT cursor FROM cursors WHERE workspace_id = ?", arrayOf(workspaceId)).use {
        if (it.moveToFirst()) it.getInt(0) else 0
    }

    /* Applies a page and advances the cursor to `nextCursor`, atomically. */
    fun apply(workspaceId: String, changes: List<NodeChange>, nextCursor: Int) {
        val db = writableDatabase
        db.beginTransaction()
        try {
            for (change in changes) {
                when (change.kind) {
                    "node" -> change.node?.let { node ->
                        db.insertWithOnConflict("nodes", null, ContentValues().apply {
                            put("id", node.id); put("workspace_id", node.workspaceId); put("json", node.rawJson)
                        }, SQLiteDatabase.CONFLICT_REPLACE)
                    }
                    "tombstone" -> change.nodeId?.let { db.delete("nodes", "id = ?", arrayOf(it)) }
                }
            }
            val current = cursor(workspaceId)
            db.insertWithOnConflict("cursors", null, ContentValues().apply { put("workspace_id", workspaceId); put("cursor", maxOf(current, nextCursor)) }, SQLiteDatabase.CONFLICT_REPLACE)
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    fun rows(workspaceId: String): List<NodeView> = readableDatabase.rawQuery("SELECT json FROM nodes WHERE workspace_id = ?", arrayOf(workspaceId)).use { cursor ->
        val out = ArrayList<NodeView>()
        while (cursor.moveToNext()) runCatching { NodeView.from(JSONObject(cursor.getString(0))) }.onSuccess { out.add(it) }
        out
    }

    /* Forgets everything about `workspaceId`, or every workspace when none is named. */
    fun clear(workspaceId: String? = null) {
        val db = writableDatabase
        if (workspaceId == null) { db.delete("nodes", null, null); db.delete("cursors", null, null); db.delete("thumbnails", null, null) }
        else { db.delete("nodes", "workspace_id = ?", arrayOf(workspaceId)); db.delete("cursors", "workspace_id = ?", arrayOf(workspaceId)) }
    }

    fun workspaces(): List<String> = readableDatabase.rawQuery("SELECT workspace_id FROM cursors", null).use { cursor ->
        val out = ArrayList<String>()
        while (cursor.moveToNext()) out.add(cursor.getString(0))
        out
    }

    fun thumbnail(versionId: String): ByteArray? = readableDatabase.rawQuery("SELECT bytes FROM thumbnails WHERE version_id = ?", arrayOf(versionId)).use {
        if (it.moveToFirst()) it.getBlob(0) else null
    }

    fun putThumbnail(versionId: String, sealed: ByteArray) {
        writableDatabase.insertWithOnConflict("thumbnails", null, ContentValues().apply { put("version_id", versionId); put("bytes", sealed) }, SQLiteDatabase.CONFLICT_REPLACE)
    }
}
