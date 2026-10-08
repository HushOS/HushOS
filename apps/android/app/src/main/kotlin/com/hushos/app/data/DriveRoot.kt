package com.hushos.app.data

import java.util.UUID

/*
 * The drive's top folder, made on first open as the web makes it (packages/drive's
 * client open()): an account that never opened Drive anywhere has none. One epoch is
 * allocated, the root is sealed as a folder is, under the workspace key, with the
 * workspace as its parent, and the server stores it. Two devices racing are settled by
 * the server, which returns the root that won; that one is always the one adopted.
 */

/* The name the web gives the top folder (ROOT_NAME in packages/drive). */
const val ROOT_NAME = "Drive"

/* A root ready to store: its id, epochs and the two envelopes. */
data class RootInput(val id: String, val keyEpoch: ULong, val parentKeyEpoch: ULong, val keyEnvelope: String, val metadataEnvelope: String)

/* What making a root needs from the server. */
interface RootApi {
    fun allocateEpoch(workspaceId: String): ULong
    /* Stores the root, or returns the one another device stored first. */
    fun createRoot(workspaceId: String, root: RootInput): NodeView
}

/*
 * The workspace with a root: as it came when it has one; otherwise one is made with
 * `seal` (the key and name envelopes for that id and those epochs) and the server's
 * answer is adopted.
 */
fun ensureRoot(
    view: WorkspaceView, workspaceKeyVersion: ULong, api: RootApi,
    seal: (id: String, keyEpoch: ULong, parentKeyEpoch: ULong) -> Pair<String, String>,
    newId: () -> String = { UUID.randomUUID().toString() },
): WorkspaceView {
    if (view.root != null) return view
    val epoch = api.allocateEpoch(view.workspaceId)
    val id = newId()
    val (keyEnvelope, metadataEnvelope) = seal(id, epoch, workspaceKeyVersion)
    val root = api.createRoot(view.workspaceId, RootInput(id, epoch, workspaceKeyVersion, keyEnvelope, metadataEnvelope))
    return view.copy(root = root)
}
