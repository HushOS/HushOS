package com.hushos.app.data

import android.content.Context
import com.hushos.core.deviceRemember
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.util.UUID

/*
 * Two devices of one account walk the same rotation (Replace keys after a share is stopped), and the server judges each
 * node of a batch on its own (packages/db rotateNodeIn). Through the real Vault and DriveApi against FakeDrive.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class RotationRaceTest {
    private val server = FakeDrive()
    private lateinit var vault: Vault

    @Before
    fun signIn() {
        val context = RuntimeEnvironment.getApplication()
        Shared::class.java.getDeclaredField("opened").apply { isAccessible = true }
            .set(null, context.getSharedPreferences("rotation-race-test", Context.MODE_PRIVATE))
        Shared.writeSession(context, Shared.Session(server.origin, server.token, server.userId, "me@example.org"))
        Shared.writeDevice(context, deviceRemember(server.userId, server.accountKey, 1uL, 1uL, UUID.randomUUID().toString()))
        vault = Vault(context, DriveApi(Shared.session(context)!!))
        vault.listChildren(server.root)
    }

    @After
    fun close() {
        server.close()
        assertEquals("routes the fake does not serve", emptyList<String>(), server.unknown)
    }

    /*
     * The other device re-keys Plans just before this phone's batch lands: the phone's Plans comes back stale and its fresh
     * key is dropped. Plans' children never went beside it, so none is sealed under that key: they go in the next batch,
     * under the key the other device put there, and everything reads afterwards from what the server holds. Fails if a
     * child is sent beside its parent (the server takes the child, refuses the parent, and the child is lost to everyone),
     * or if the phone wraps the children under anything but the key the server kept.
     */
    @Test
    fun aFolderAnotherDeviceReKeysFirstNeverLeavesWhatItHoldsUnderAKeyNobodyKept() {
        val plans = server.folder(server.root, "Plans")
        val notes = server.folder(plans, "Notes")
        val plan = server.file(plans, "plan.md", ByteArray(64) { 1 })
        val deep = server.file(notes, "deep.md", ByteArray(32) { 2 })
        vault.listChildren(plans)
        var raced = false
        server.beforeRotationSend = { ids ->
            if (!raced && plans in ids) {
                raced = true
                server.rekeyedElsewhere(plans, plans)
            }
        }

        vault.rotate(vault.item(plans)!!)

        assertTrue("the other device won Plans", raced)
        // Read as another device would, from the envelopes the server holds: nothing is under a key nobody kept.
        assertEquals(listOf("Plans", "Notes", "plan.md", "deep.md"), listOf(plans, notes, plan, deep).map { server.record(it).name })
        val target = server.node(plans).keyEpoch
        assertTrue(listOf(notes, plan, deep).all { server.node(it).keyEpoch == target && server.node(it).parentKeyEpoch == target })
        // The phone holds the key the server kept for Plans, and lists what it holds.
        assertTrue(server.keyOf(plans).contentEquals(vault.nodes.key(server.workspace, plans)!!))
        assertEquals(listOf("Notes", "plan.md"), vault.listChildren(plans).map { it.name })
        assertEquals(listOf("deep.md"), vault.listChildren(notes).map { it.name })
        // Never a node beside its parent in one send; siblings still went together.
        for (batch in server.rotationBatches) for (id in batch) assertFalse(server.node(id).parentId in batch)
        assertEquals(listOf(setOf(plans), setOf(notes, plan), setOf(deep)), server.rotationBatches.map { it.toSet() })
    }
}
