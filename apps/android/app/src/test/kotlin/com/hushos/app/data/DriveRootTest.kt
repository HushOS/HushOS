package com.hushos.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/*
 * An account that never opened Drive has no top folder, and every screen, the Files app
 * and the queue need one. It is made once, sealed with the workspace as its parent at the
 * workspace key's version and a freshly allocated epoch, and whatever root the server
 * returns (another device may have won the race) is the one used.
 */
class DriveRootTest {
    private val ws = "6f1c2b3a-0000-4000-8000-0000000000a1"
    private val workspaceKeyVersion = 3uL

    private fun node(id: String) = NodeView(id, ws, null, "folder", 7uL, workspaceKeyVersion, "k", 1uL, "m", null, null, null, null)

    private class FakeApi(private val answer: (RootInput) -> NodeView) : RootApi {
        val allocated = ArrayList<String>()
        val created = ArrayList<RootInput>()
        override fun allocateEpoch(workspaceId: String): ULong { allocated.add(workspaceId); return 7uL }
        override fun createRoot(workspaceId: String, root: RootInput): NodeView { created.add(root); return answer(root) }
    }

    private val sealedFor = ArrayList<Triple<String, ULong, ULong>>()
    private val seal = { id: String, epoch: ULong, parentEpoch: ULong -> sealedFor.add(Triple(id, epoch, parentEpoch)); "key-$id" to "name-$id" }

    @Test
    fun noRootMakesOneOnceUnderTheWorkspaceWithTheAllocatedEpoch() {
        val api = FakeApi { node(it.id) }
        val view = ensureRoot(WorkspaceView(ws, 0, null, null), workspaceKeyVersion, api, seal, newId = { "root-1" })
        assertEquals(listOf(ws), api.allocated)
        assertEquals(listOf(RootInput("root-1", 7uL, workspaceKeyVersion, "key-root-1", "name-root-1")), api.created)
        // Sealed for the id it is stored under, with the allocated epoch over the workspace key's version.
        assertEquals(listOf(Triple("root-1", 7uL, workspaceKeyVersion)), sealedFor)
        assertEquals("root-1", view.root?.id)
    }

    @Test
    fun aDriveWithARootIsLeftAlone() {
        val api = FakeApi { error("must not create") }
        val existing = WorkspaceView(ws, 4, null, node("root-0"))
        assertSame(existing, ensureRoot(existing, workspaceKeyVersion, api, seal))
        assertTrue(api.allocated.isEmpty() && api.created.isEmpty() && sealedFor.isEmpty())
    }

    @Test
    fun theRootAnotherDeviceStoredFirstIsTheOneUsed() {
        // The server keeps the first root and returns it; ours is never used.
        val api = FakeApi { node("root-from-the-web") }
        val view = ensureRoot(WorkspaceView(ws, 0, null, null), workspaceKeyVersion, api, seal, newId = { "root-mine" })
        assertEquals("root-from-the-web", view.root?.id)
    }
}
