import Foundation
import SQLite3

/*
 * The tree mirror, as the web keeps one in IndexedDB: every node of a
 * workspace as the server serves it, in SQLite in the app group so the app
 * and the Files extension read the same rows. Rows are envelopes and ids, the
 * same bytes the server holds; no name or key ever lands here. A page of the
 * change feed and the cursor it advances to are written in one transaction,
 * so the cursor never claims a page that was not kept. Thumbnail trailers are
 * kept beside the rows, still sealed, so a list draws its pictures without a
 * round trip and nothing readable sits on disk.
 */
final class Mirror {
    private var db: OpaquePointer?

    init?(url: URL) {
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard sqlite3_open_v2(url.path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else { return nil }
        exec("PRAGMA journal_mode = WAL")
        exec("CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, json BLOB NOT NULL)")
        exec("CREATE INDEX IF NOT EXISTS nodes_workspace ON nodes (workspace_id)")
        exec("CREATE TABLE IF NOT EXISTS cursors (workspace_id TEXT PRIMARY KEY, cursor INTEGER NOT NULL)")
        exec("CREATE TABLE IF NOT EXISTS thumbnails (version_id TEXT PRIMARY KEY, bytes BLOB NOT NULL)")
    }

    deinit { sqlite3_close(db) }

    @discardableResult
    private func exec(_ sql: String) -> Bool { sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK }

    private func query<T>(_ sql: String, bind: [Any] = [], row: (OpaquePointer) -> T) -> [T] {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK, let statement else { return [] }
        defer { sqlite3_finalize(statement) }
        bindAll(statement, bind)
        var out: [T] = []
        while sqlite3_step(statement) == SQLITE_ROW { out.append(row(statement)) }
        return out
    }

    private func run(_ sql: String, bind: [Any] = []) {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK, let statement else { return }
        bindAll(statement, bind)
        sqlite3_step(statement)
        sqlite3_finalize(statement)
    }

    private func bindAll(_ statement: OpaquePointer, _ values: [Any]) {
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (index, value) in values.enumerated() {
            let slot = Int32(index + 1)
            switch value {
            case let text as String: sqlite3_bind_text(statement, slot, text, -1, transient)
            case let number as Int: sqlite3_bind_int64(statement, slot, Int64(number))
            case let data as Data: _ = data.withUnsafeBytes { sqlite3_bind_blob(statement, slot, $0.baseAddress, Int32(data.count), transient) }
            default: sqlite3_bind_null(statement, slot)
            }
        }
    }

    private func blob(_ statement: OpaquePointer, _ column: Int32) -> Data {
        guard let bytes = sqlite3_column_blob(statement, column) else { return Data() }
        return Data(bytes: bytes, count: Int(sqlite3_column_bytes(statement, column)))
    }

    private func text(_ statement: OpaquePointer, _ column: Int32) -> String {
        guard let bytes = sqlite3_column_text(statement, column) else { return "" }
        return String(cString: bytes)
    }

    /* The last change sequence applied for this workspace; 0 when nothing has been. */
    func cursor(_ workspaceId: String) -> Int {
        query("SELECT cursor FROM cursors WHERE workspace_id = ?", bind: [workspaceId]) { Int(sqlite3_column_int64($0, 0)) }.first ?? 0
    }

    /* Applies a page and advances the cursor to `nextCursor`, atomically. */
    func apply(_ workspaceId: String, changes: [NodeChange], nextCursor: Int) {
        exec("BEGIN")
        let encoder = JSONEncoder()
        for change in changes {
            if change.kind == "node", let node = change.node, let json = try? encoder.encode(node) {
                run("INSERT OR REPLACE INTO nodes (id, workspace_id, json) VALUES (?, ?, ?)", bind: [node.id, node.workspaceId, json])
            } else if change.kind == "tombstone", let id = change.nodeId {
                run("DELETE FROM nodes WHERE id = ?", bind: [id])
            }
        }
        let current = cursor(workspaceId)
        run("INSERT OR REPLACE INTO cursors (workspace_id, cursor) VALUES (?, ?)", bind: [workspaceId, max(current, nextCursor)])
        exec("COMMIT")
    }

    func rows(_ workspaceId: String) -> [NodeView] {
        let decoder = JSONDecoder()
        return query("SELECT json FROM nodes WHERE workspace_id = ?", bind: [workspaceId]) { blob($0, 0) }
            .compactMap { try? decoder.decode(NodeView.self, from: $0) }
    }

    /* Forgets everything about `workspaceId`, or every workspace when none is named. */
    func clear(_ workspaceId: String? = nil) {
        exec("BEGIN")
        if let workspaceId {
            run("DELETE FROM nodes WHERE workspace_id = ?", bind: [workspaceId])
            run("DELETE FROM cursors WHERE workspace_id = ?", bind: [workspaceId])
        } else {
            exec("DELETE FROM nodes")
            exec("DELETE FROM cursors")
            exec("DELETE FROM thumbnails")
        }
        exec("COMMIT")
    }

    /* Every workspace with a cursor here. */
    func workspaces() -> [String] {
        query("SELECT workspace_id FROM cursors") { text($0, 0) }
    }

    func thumbnail(_ versionId: String) -> Data? {
        query("SELECT bytes FROM thumbnails WHERE version_id = ?", bind: [versionId]) { blob($0, 0) }.first
    }

    func putThumbnail(_ versionId: String, _ sealed: Data) {
        run("INSERT OR REPLACE INTO thumbnails (version_id, bytes) VALUES (?, ?)", bind: [versionId, sealed])
    }
}
