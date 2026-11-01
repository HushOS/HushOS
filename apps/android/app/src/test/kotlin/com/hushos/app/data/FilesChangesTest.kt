package com.hushos.app.data

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
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
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.io.File
import java.util.UUID

/*
 * The system Files app keeps a folder's listing until that folder's children URI is notified. Every write the phone
 * makes (from the app, a transfer job, or Files itself through the provider) and every sync that changes a folder must
 * notify it, by the document id Files holds ("root" for the top folder). And the provider's Vault must see changes
 * another Vault in the same process (the app's) already pulled into the shared mirror, or Files is told and still
 * shows the old listing. The real Vault and DriveApi against FakeDrive on loopback; notifications as Robolectric's
 * ContentResolver records them.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class FilesChangesTest {
    private val server = FakeDrive()
    private lateinit var context: Context

    // Drive { A { f.txt }, B { g.txt } }
    private val a = server.folder(server.root, "A")
    private val f = server.file(a, "f.txt", ByteArray(64) { it.toByte() })
    private val b = server.folder(server.root, "B")
    private val g = server.file(b, "g.txt", ByteArray(32) { it.toByte() })

    @Before
    fun signIn() {
        context = RuntimeEnvironment.getApplication()
        Shared::class.java.getDeclaredField("opened").apply { isAccessible = true }
            .set(null, context.getSharedPreferences("files-changes-test", Context.MODE_PRIVATE))
        Shared.writeSession(context, Shared.Session(server.origin, server.token, server.userId, "me@example.org"))
        Shared.writeDevice(context, deviceRemember(server.userId, server.accountKey, 1uL, 1uL, UUID.randomUUID().toString()))
        freshMirror()
    }

    @After
    fun close() {
        freshMirror()
        server.close()
        assertEquals("routes the fake does not serve", emptyList<String>(), server.unknown)
    }

    /* The mirror is one per process, and Robolectric keeps statics between tests: each test starts from an empty one. */
    private fun freshMirror() {
        Mirror::class.java.getDeclaredField("instance").apply { isAccessible = true }.set(null, null)
        context.deleteDatabase("mirror.db")
    }

    private fun vault() = Vault(context, DriveApi(Shared.session(context)!!))

    private fun children(documentId: String): Uri = DocumentsContract.buildChildDocumentsUri(FilesRoots.authority(context), documentId)

    /* What `block` notified, in order. */
    private fun notified(block: () -> Unit): List<Uri> {
        val shadow = shadowOf(context.contentResolver)
        val before = shadow.notifiedUris.size
        block()
        return shadow.notifiedUris.drop(before).map { it.uri }
    }

    private fun file(name: String) = File(File(context.cacheDir, "files-changes-" + UUID.randomUUID()).also { it.mkdirs() }, name)
        .also { it.writeBytes(ByteArray(100) { i -> (i * 7).toByte() }) }

    @Test
    fun everyWriteTellsTheFoldersWhoseChildrenItChanged() {
        val vault = vault()
        vault.buildCatalogue()
        val root = server.root

        // An upload landing (the app's, a transfer job's): its folder, and the top folder by both names Files may hold.
        assertTrue(children(a) in notified { vault.upload(file("new.txt"), "new.txt", "text/plain", a, null) })
        val atTop = notified { vault.upload(file("top.txt"), "top.txt", "text/plain", root, null) }
        assertTrue("the top folder as Files names it", children(FilesRoots.ROOT_DOCUMENT) in atTop)
        assertTrue("the top folder by its node id", children(root) in atTop)

        assertTrue(children(a) in notified { vault.createFolder(a, "Inside") })
        assertTrue(children(b) in notified { vault.rename(g, "g renamed.txt") })

        // A move changes two listings: the folder it left and the one it entered.
        val moved = notified { vault.move(f, b) }
        assertTrue("the folder it left", children(a) in moved)
        assertTrue("the folder it entered", children(b) in moved)

        assertTrue(children(b) in notified { vault.trash(g) })
    }

    @Test
    fun theProviderSeesWhatTheAppAlreadyPulledAndFilesIsToldOfIt() {
        // The app's Vault and the provider's, one process, one mirror.
        val app = vault()
        val provider = vault()
        app.buildCatalogue()
        provider.buildCatalogue()

        // Added elsewhere (the web): the app's live sync pulls it first and moves the mirror's cursor past it.
        val added = server.file(a, "from the web.txt", ByteArray(10))
        assertTrue(added in app.sync()!!)

        val told = notified { assertTrue("the provider's sync still brings it", added in provider.sync()!!) }
        assertTrue("its folder is told", children(a) in told)
        assertTrue("the provider's listing has it", provider.listChildren(a).any { it.id == added })
    }

    @Test
    fun aSyncTellsTheFolderAMoveLeftAsWellAsTheOneItEntered() {
        val app = vault()
        val provider = vault()
        app.buildCatalogue()
        provider.buildCatalogue()
        assertTrue(provider.listChildren(a).any { it.id == f })

        app.move(f, b)
        lateinit var touched: Set<String>
        val told = notified { touched = provider.sync()!! }
        assertTrue("the folder it left is among what the sync touched", a in touched)
        assertTrue("the folder it left is told", children(a) in told)
        assertTrue("the folder it entered is told", children(b) in told)
        assertFalse("gone from the folder it left", provider.listChildren(a).any { it.id == f })
        assertTrue("in the folder it entered", provider.listChildren(b).any { it.id == f })
    }
}
