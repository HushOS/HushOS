package com.hushos.app.data

import android.content.Context
import com.hushos.app.ui.InfoLookup
import com.hushos.app.ui.infoLookup
import com.hushos.app.ui.missingFromShareList
import com.hushos.core.deviceRemember
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.util.UUID

/*
 * A received share's feed is its owner's, so nothing on this device hears that the owner trashed a file in it, and
 * Info kept that file open with Share and Tags live. Info now closes when the item is absent from the list its own
 * parent shows after a refresh: a decision for Info alone. The cache is never changed by it (versions that evicted
 * rows lost trashed ones from the Trash and brought concurrent removals back). The real Vault and DriveApi against
 * FakeDrive on loopback; the list is what `listChildren` hands the screen.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class InfoShareListTest {
    private val server = FakeDrive()
    private lateinit var vault: Vault
    private lateinit var s: String
    private lateinit var t: String
    private lateinit var w: String
    private lateinit var u: String
    private val theirs get() = server.graceWorkspace

    @Before
    fun signIn() {
        val context = RuntimeEnvironment.getApplication()
        Shared::class.java.getDeclaredField("opened").apply { isAccessible = true }
            .set(null, context.getSharedPreferences("info-share-list-test", Context.MODE_PRIVATE))
        Shared.writeSession(context, Shared.Session(server.origin, server.token, server.userId, "me@example.org"))
        Shared.writeDevice(context, deviceRemember(server.userId, server.accountKey, 1uL, 1uL, UUID.randomUUID().toString()))
        vault = Vault(context, DriveApi(Shared.session(context)!!))
        vault.listChildren(server.root)
        // Grace's S { t.txt, w.txt, U }, shared with this account.
        s = server.folder(server.graceRoot, "S")
        t = server.file(s, "t.txt", ByteArray(20) { it.toByte() })
        w = server.file(s, "w.txt", ByteArray(10) { it.toByte() })
        u = server.folder(s, "U")
        server.shareWithMe(s)
        server.pinGrace()
        assertNull(vault.mountShares().single().error)
        vault.listChildren(s)
    }

    @After
    fun close() {
        server.close()
        assertEquals("routes the fake does not serve", emptyList<String>(), server.unknown)
    }

    /* Info's verdict on a share item once its parent's list was refreshed to `listed`, read as Main reads it. */
    private fun info(item: Opened, listed: List<Opened>) = infoLookup(
        live = vault.liveItem(item.id, item.node.workspaceId) != null, held = vault.holds(item.id, item.node.workspaceId),
        removed = vault.removed(item.node.workspaceId, item.id), outOfReach = false, seen = true,
        missingFromList = missingFromShareList(item, vault.ownWorkspaceId, refreshed = true, listed = listed),
    )

    @Test
    fun aShareItemMissingFromItsParentsRefreshedListClosesInfoAndTheCacheIsUntouched() {
        val shown = vault.liveItem(t, theirs)!!
        // Grace trashes t.txt on her own device; the children route leaves it out of S's listing from then on.
        server.drop(t)
        val refreshed = vault.listChildren(s)
        assertEquals(InfoLookup.CLOSE, info(shown, refreshed))
        // Only Info decided: the row is still held, live, and not marked removed.
        assertNotNull(vault.liveItem(t, theirs))
        assertFalse(vault.removed(theirs, t))
        // Before a refresh, the same stale list says nothing.
        assertFalse(missingFromShareList(shown, vault.ownWorkspaceId, refreshed = false, listed = refreshed))
        // Still listed after the refresh: Info stays.
        val other = vault.liveItem(w, theirs)!!
        assertEquals(InfoLookup.SHOW, info(other, refreshed))
    }

    @Test
    fun aTrashedSiblingStillInTheCacheIsUnaffected() {
        // U is in the trash as this device holds it: the listing leaves it out, and the Trash keeps reading this row.
        val held = vault.nodes.row(theirs, u)!!
        vault.nodes.put(held.copy(node = held.node.copy(trashedAt = "2026-10-29T10:00:00Z")), vault.nodes.key(held)!!)
        server.drop(u)
        val refreshed = vault.listChildren(s)
        assertEquals(InfoLookup.SHOW, info(vault.liveItem(t, theirs)!!, refreshed))
        val sibling = vault.nodes.row(theirs, u)
        assertNotNull(sibling)
        assertEquals("2026-10-29T10:00:00Z", sibling!!.node.trashedAt)
        assertFalse(vault.removed(theirs, u))
    }

    @Test
    fun thisAccountsOwnItemIsLeftToTheFeed() {
        // An own item is never closed by a list: its trash reaches this device through the feed (removed, tombstoned).
        val a = server.folder(server.root, "A")
        val f = server.file(a, "f.txt", ByteArray(5) { it.toByte() })
        vault.listChildren(server.root)
        vault.listChildren(a)
        val shown = vault.liveItem(f, server.workspace)!!
        assertFalse(missingFromShareList(shown, vault.ownWorkspaceId, refreshed = true, listed = emptyList()))
    }
}
