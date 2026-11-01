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
class Mirror private constructor(context: Context) : SQLiteOpenHelper(context, "mirror.db", null, 1) {
    companion object {
        @Volatile private var instance: Mirror? = null

        /* One helper per process: the app and the documents provider share its connection, so their writes never lock each other out. */
        fun shared(context: Context): Mirror = instance ?: synchronized(this) { instance ?: Mirror(context.applicationContext).also { instance = it } }
    }

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE nodes (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, json TEXT NOT NULL)")
        db.execSQL("CREATE INDEX nodes_workspace ON nodes (workspace_id)")
        db.execSQL("CREATE TABLE cursors (workspace_id TEXT PRIMARY KEY, cursor INTEGER NOT NULL)")
        db.execSQL("CREATE TABLE thumbnails (version_id TEXT PRIMARY KEY, bytes BLOB NOT NULL)")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {}

    /* Sealed documents the app needs before it can ask the server: the workspace view, the tags registry. */
    override fun onOpen(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE IF NOT EXISTS documents (key TEXT PRIMARY KEY, json TEXT NOT NULL)")
        db.execSQL("CREATE TABLE IF NOT EXISTS resets (workspace_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, refilling INTEGER NOT NULL)")
    }

    /*
     * Held by whoever pulls the feed into the mirror, from reading where the mirror stands to the last page applied: the
     * app's, the provider's and the transfer jobs' Vaults share the mirror, and a pull that started from a cursor the
     * mirror no longer stands on must not land beside another's reset. Never the helper itself, whose monitor
     * SQLiteOpenHelper takes for every read.
     */
    val feedLock = Any()

    /*
     * Where a workspace's mirror stands: its cursor; its generation, which every clear bumps, so a cursor a Vault took
     * under an earlier one is known to describe rows the mirror no longer holds; and whether a refill after a clear
     * is still unfinished, when the cursor is only as far as the refill got and no other cursor may move it.
     */
    data class FeedState(val cursor: Int, val generation: Long, val refilling: Boolean)

    fun state(workspaceId: String): FeedState {
        val db = writableDatabase
        db.execSQL("INSERT OR IGNORE INTO resets (workspace_id, generation, refilling) VALUES (?, 1, 0)", arrayOf(workspaceId))
        return db.rawQuery("SELECT generation, refilling FROM resets WHERE workspace_id = ?", arrayOf(workspaceId)).use {
            it.moveToFirst()
            FeedState(cursor(workspaceId), it.getLong(0), it.getInt(1) != 0)
        }
    }

    /* A refill reached the head of the feed: the mirror holds the whole workspace again. */
    fun refilled(workspaceId: String) {
        writableDatabase.execSQL("UPDATE resets SET refilling = 0 WHERE workspace_id = ?", arrayOf(workspaceId))
    }

    /* A new generation, a refill owed (in the clear's own transaction). */
    private fun reset(db: SQLiteDatabase, workspaceId: String) {
        val generation = db.rawQuery("SELECT generation FROM resets WHERE workspace_id = ?", arrayOf(workspaceId)).use { if (it.moveToFirst()) it.getLong(0) else 0L }
        db.insertWithOnConflict("resets", null, ContentValues().apply {
            put("workspace_id", workspaceId); put("generation", generation + 1); put("refilling", 1)
        }, SQLiteDatabase.CONFLICT_REPLACE)
    }

    fun document(key: String): String? = readableDatabase.rawQuery("SELECT json FROM documents WHERE key = ?", arrayOf(key)).use {
        if (it.moveToFirst()) it.getString(0) else null
    }

    fun putDocument(key: String, json: String) {
        writableDatabase.insertWithOnConflict("documents", null, ContentValues().apply { put("key", key); put("json", json) }, SQLiteDatabase.CONFLICT_REPLACE)
    }

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

    /*
     * Forgets everything about `workspaceId`, or every workspace when none is named. Each one cleared moves to a new
     * generation with a refill owed (kept across the clear, so no Vault's cursor from before it counts again).
     */
    fun clear(workspaceId: String? = null) {
        val db = writableDatabase
        if (workspaceId == null) {
            db.beginTransaction()
            try {
                db.delete("nodes", null, null); db.delete("cursors", null, null); db.delete("thumbnails", null, null); db.delete("documents", null, null)
                db.execSQL("UPDATE resets SET generation = generation + 1, refilling = 1")
                db.setTransactionSuccessful()
            } finally {
                db.endTransaction()
            }
            // An account leaving the phone: its rows don't linger in the file's free pages either.
            db.execSQL("VACUUM")
            return
        }
        db.beginTransaction()
        try {
            db.delete("nodes", "workspace_id = ?", arrayOf(workspaceId)); db.delete("cursors", "workspace_id = ?", arrayOf(workspaceId))
            reset(db, workspaceId)
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
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
