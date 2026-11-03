package com.hushos.app.files

import android.content.pm.ProviderInfo
import android.provider.DocumentsContract
import com.hushos.app.data.DriveApi
import com.hushos.app.data.FakeDrive
import com.hushos.app.data.FamilyFixture
import com.hushos.app.data.Shared
import com.hushos.app.data.Vault
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/*
 * A folder of the drive granted to another app as a tree (ACTION_OPEN_DOCUMENT_TREE): the provider honours the grant only
 * for what the folder holds now, as the server says, never for where its cache last saw a node.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class FilesTreeGrantsTest {
    private val server = FakeDrive()
    private val app get() = RuntimeEnvironment.getApplication()
    private val authority get() = "${app.packageName}.documents"

    @Before
    fun signIn() {
        // The mirror is one per process and Robolectric keeps statics between tests: each test starts from an empty one.
        com.hushos.app.data.Mirror::class.java.getDeclaredField("instance").apply { isAccessible = true }.set(null, null)
        app.deleteDatabase("mirror.db")
        FamilyFixture.signIn(server, "files-tree-grants-test")
    }

    @After
    fun close() {
        server.close()
        assertEquals("routes the fake does not serve", emptyList<String>(), server.unknown)
    }

    private fun provider(): HushOSDocumentsProvider {
        val info = ProviderInfo().apply {
            authority = this@FilesTreeGrantsTest.authority
            exported = true
            grantUriPermissions = true
            readPermission = android.Manifest.permission.MANAGE_DOCUMENTS
            writePermission = android.Manifest.permission.MANAGE_DOCUMENTS
        }
        return Robolectric.buildContentProvider(HushOSDocumentsProvider::class.java).create(info).get()
    }

    /*
     * Another device moves a file out of a folder granted as a tree: the old tree refuses it at once, before any feed
     * pull, and still after a poll; it opened through the tree before the move. Fails if a tree grant is judged from the
     * provider's cached rows, which kept the file under the folder until the next pull (shipped up to 0.11.0).
     */
    @Test
    fun aFileMovedOutOfAGrantedFolderIsOutsideTheTreeAtOnce() {
        val provider = provider()
        val trips = provider.createDocument("root", DocumentsContract.Document.MIME_TYPE_DIR, "Trips")
        val notes = provider.createDocument(trips, "text/plain", "Notes.txt")
        provider.queryChildDocuments(trips, null, null as String?).close()
        val tree = DocumentsContract.buildTreeDocumentUri(authority, trips)
        val inTree = DocumentsContract.buildDocumentUriUsingTree(tree, notes)
        provider.openFile(inTree, "r")!!.close()
        // Another device of the account moves it to the top of the drive.
        val other = Vault(app, DriveApi(Shared.session(app)!!))
        other.listChildren(other.rootId)
        other.listChildren(trips)
        other.move(notes, other.rootId)
        assertFalse(provider.isChildDocument(trips, notes))
        assertThrows(SecurityException::class.java) { provider.openFile(inTree, "r") }
        assertTrue(provider.pollOnce())
        assertFalse(provider.isChildDocument(trips, notes))
        assertThrows(SecurityException::class.java) { provider.openFile(inTree, "r") }
        // Still inside the drive's own top.
        assertTrue(provider.isChildDocument("root", notes))
    }

    /*
     * A file moved by Files into another folder of the drive: the provider answers with the moved document's id, as
     * DocumentsContract.moveDocument needs to report the move done. Fails if the move answers null (Files then says the
     * move failed, though the file moved).
     */
    @Test
    fun aMoveAnswersWithTheMovedDocument() {
        val provider = provider()
        val trips = provider.createDocument("root", DocumentsContract.Document.MIME_TYPE_DIR, "Trips")
        val notes = provider.createDocument("root", "text/plain", "Notes.txt")
        provider.queryChildDocuments("root", null, null as String?).close()
        assertEquals(notes, provider.moveDocument(notes, "root", trips))
        assertTrue(provider.isChildDocument(trips, notes))
    }
}
