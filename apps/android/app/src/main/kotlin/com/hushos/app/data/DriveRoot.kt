package com.hushos.app.data

import org.json.JSONObject

/*
 * The drive's top folder, made on first open as the web makes it (packages/drive's
 * client open()): an account that never opened Drive anywhere has none. One epoch is
 * allocated, the root is sealed as a folder is, under the workspace key, with the
 * workspace as its parent, and the server stores it. Two devices racing are settled by
 * the server, which returns the root that won; that one is always the one adopted.
 */

/* The name the web gives the top folder (ROOT_NAME in packages/drive). */
const val ROOT_NAME = "Drive"

/* A root ready to store: its id and the seed it was derived from, epochs, the two envelopes and the writer's signature over the metadata. */
data class RootInput(val id: String, val idSeed: String, val keyEpoch: ULong, val parentKeyEpoch: ULong, val keyEnvelope: String, val metadataEnvelope: String, val metadataSignature: String) {
    /* What `POST /api/drive/workspaces/:id/root` takes. */
    fun body(): JSONObject = JSONObject().put("id", id).put("idSeed", idSeed).put("keyEpoch", keyEpoch.toLong()).put("parentKeyEpoch", parentKeyEpoch.toLong())
        .put("keyEnvelope", keyEnvelope).put("metadataEnvelope", metadataEnvelope).put("metadataSignature", metadataSignature)
}

/* What sealing a root makes: its key and name envelopes and the signature over the name's, all base64url. */
data class SealedRoot(val keyEnvelope: String, val metadataEnvelope: String, val metadataSignature: String)

/* What making a root needs from the server. */
interface RootApi {
    fun allocateEpoch(workspaceId: String): ULong
    /* Stores the root, or returns the one another device stored first. */
    fun createRoot(workspaceId: String, root: RootInput): NodeView
}

/*
 * The workspace with a root: as it came when it has one; otherwise one is made with
 * `seal` (the key and name envelopes for that id and those epochs, the name's signed) and the server's
 * answer is adopted. Its id is minted in the workspace and sent with its seed.
 */
fun ensureRoot(
    view: WorkspaceView, workspaceKeyVersion: ULong, api: RootApi,
    seal: (id: String, keyEpoch: ULong, parentKeyEpoch: ULong) -> SealedRoot,
    newId: () -> ScopedId = { IdField.NODE.mint(view.workspaceId) },
): WorkspaceView {
    if (view.root != null) return view
    val epoch = api.allocateEpoch(view.workspaceId)
    val made = newId()
    val sealed = seal(made.id, epoch, workspaceKeyVersion)
    val root = api.createRoot(view.workspaceId, RootInput(made.id, made.seed, epoch, workspaceKeyVersion, sealed.keyEnvelope, sealed.metadataEnvelope, sealed.metadataSignature))
    return view.copy(root = root)
}
