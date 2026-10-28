package com.hushos.app.data

import android.content.Context
import com.hushos.core.deviceRemember
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.io.File
import java.util.UUID

/*
 * A node's attributes (a folder's colour, and keys a newer client added that this app doesn't know) ride along
 * whenever the phone seals a record again: a rename, a copy of a file or a folder tree, a save from a link, a copy
 * across drives either way (Save a copy of a share, a move into a shared folder), a new version, and a rotation. The
 * real Vault, DriveApi, Auth and PublicApi against FakeDrive on loopback; each record the phone wrote is opened as
 * another device would, under keys unwrapped from what the server holds, and must carry its own source's map, which
 * differs from every other node's. Each test fails if its path builds the record from the known fields alone, or
 * from the wrong source. A name typed with a lone surrogate is refused in words before any record is written.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class VaultAttributesTest {
    private val server = FakeDrive()
    private lateinit var vault: Vault
    private lateinit var context: Context

    /* Each node's own: a colour, an attribute called "name", and a key only a newer client knows, with awkward text. */
    private fun attrs(tag: String) = mapOf(
        "colour" to "#$tag",
        "name" to "not $tag's name",
        "zz-later_client" to "kept as a newer client wrote it: “$tag” Ünï \"q\" \\ \n\t 😀",
    )

    // Drive { A { f.txt, Sub { h.txt } }, B { g.txt } }
    private val a = server.folder(server.root, "A", attrs("A"))
    private val f = server.file(a, "f.txt", bytes(200), attrs("f"))
    private val sub = server.folder(a, "Sub", attrs("Sub"))
    private val h = server.file(sub, "h.txt", bytes(120), attrs("h"))
    private val b = server.folder(server.root, "B", attrs("B"))
    private val g = server.file(b, "g.txt", bytes(300), attrs("g"))

    private fun bytes(count: Int) = ByteArray(count) { (it % 251).toByte() }

    @Before
    fun signIn() {
        context = RuntimeEnvironment.getApplication()
        // Shared keeps the session and the remembered device in EncryptedSharedPreferences under an Android Keystore key,
        // which the JVM has no provider for: the same entries in plain preferences stand in for that one file.
        Shared::class.java.getDeclaredField("opened").apply { isAccessible = true }
            .set(null, context.getSharedPreferences("vault-attributes-test", Context.MODE_PRIVATE))
        Shared.writeSession(context, Shared.Session(server.origin, server.token, server.userId, "me@example.org"))
        Shared.writeDevice(context, deviceRemember(server.userId, server.accountKey, 1uL, 1uL, UUID.randomUUID().toString()))
        vault = Vault(context, DriveApi(Shared.session(context)!!))
        vault.listChildren(server.root)
        vault.listChildren(a)
        vault.listChildren(sub)
        vault.listChildren(b)
    }

    @After
    fun close() {
        server.close()
        assertEquals("routes the fake does not serve", emptyList<String>(), server.unknown)
    }

    private fun file(size: Int): File {
        val directory = File(context.cacheDir, "attributes-" + UUID.randomUUID()).also { it.mkdirs() }
        return File(directory, "g.txt").also { it.writeBytes(bytes(size).reversedArray()) }
    }

    /* Grace's folder S { t.txt, U { v.txt } }, shared with the account, whose settings pin her. */
    private fun graceShares(): String {
        val s = server.folder(server.graceRoot, "S", attrs("S"))
        server.file(s, "t.txt", bytes(150), attrs("t"))
        val u = server.folder(s, "U", attrs("U"))
        server.file(u, "v.txt", bytes(90), attrs("v"))
        server.shareWithMe(s)
        server.pinGrace()
        val mount = vault.mountShares().single()
        assertNull(mount.error)
        return s
    }

    @Test
    fun aRenameKeepsEveryAttribute() {
        vault.rename(a, "A renamed")
        val renamed = server.record(a)
        assertEquals("A renamed", renamed.name)
        assertEquals(2L, server.node(a).metadataVersion)
        assertEquals(attrs("A"), renamed.attributes)
        // A file's record keeps its type, size and date beside them.
        vault.rename(g, "g renamed.txt")
        val file = server.record(g)
        assertEquals(listOf("g renamed.txt", "text/plain", 300uL), listOf(file.name, file.mime, file.size))
        assertEquals(attrs("g"), file.attributes)
    }

    @Test
    fun aCopyOfAFileKeepsItsSourcesAttributes() {
        val made = vault.copy(g, a)
        assertNotEquals(g, made.id)
        assertFalse(server.keyOf(g).contentEquals(server.keyOf(made.id)))
        assertEquals(a, server.node(made.id).parentId)
        assertEquals(attrs("g"), server.record(made.id).attributes)
    }

    @Test
    fun aCopiedFolderTreeKeepsEachRecordsOwnAttributes() {
        val made = vault.copy(a, b, "A copy")
        assertEquals("A copy", server.record(made.id).name)
        assertEquals(attrs("A"), server.record(made.id).attributes)
        assertEquals(attrs("f"), server.record(server.child(made.id, "f.txt").id).attributes)
        val copiedSub = server.child(made.id, "Sub")
        assertEquals(attrs("Sub"), server.record(copiedSub.id).attributes)
        assertEquals(attrs("h"), server.record(server.child(copiedSub.id, "h.txt").id).attributes)
    }

    @Test
    fun aNewVersionKeepsTheFilesAttributes() {
        val before = server.node(g).version!!.id
        // As the upload queue and the Files app's write-back both send it: the file as resolved now, replaced.
        vault.upload(file(500), "g.txt", "text/plain", b, vault.resolve(g))
        assertNotEquals(before, server.node(g).version!!.id)
        assertEquals(2L, server.node(g).metadataVersion)
        val replaced = server.record(g)
        assertEquals(500uL, replaced.size)
        assertEquals(attrs("g"), replaced.attributes)
    }

    @Test
    fun aRotationReSealsEveryRecordWithItsAttributes() {
        val before = listOf(a, f, sub, h).associateWith { server.node(it).keyEpoch to server.node(it).metadataEnvelope }
        val result = vault.rotate(vault.resolve(a))
        assertEquals(4, result.done)
        for ((id, tag) in listOf(a to "A", f to "f", sub to "Sub", h to "h")) {
            val (epoch, envelope) = before.getValue(id)
            assertTrue(server.node(id).keyEpoch > epoch)
            assertNotEquals(envelope, server.node(id).metadataEnvelope)
            // Opened under the fresh keys, unwrapped from the root down as the server now holds them.
            assertEquals(attrs(tag), server.record(id).attributes)
        }
        // Nothing outside the subtree was touched.
        assertEquals(attrs("g"), server.record(g).attributes)
    }

    @Test
    fun aSaveFromALinkKeepsEachRecordsOwnAttributes() {
        val l = server.folder(server.graceRoot, "L", attrs("L"))
        server.file(l, "m.txt", bytes(80), attrs("m"))
        val n = server.folder(l, "N", attrs("N"))
        server.file(n, "o.txt", bytes(40), attrs("o"))
        val link = LinkVault(server.origin, server.link(l))
        val item = link.open(null)
        vault.saveFromLink(link, item, server.root, "L")
        val saved = server.child(server.root, "L")
        assertEquals(server.workspace, saved.workspaceId)
        assertEquals(attrs("L"), server.record(saved.id).attributes)
        assertEquals(attrs("m"), server.record(server.child(saved.id, "m.txt").id).attributes)
        val savedN = server.child(saved.id, "N")
        assertEquals(attrs("N"), server.record(savedN.id).attributes)
        assertEquals(attrs("o"), server.record(server.child(savedN.id, "o.txt").id).attributes)
    }

    @Test
    fun aSavedCopyOfAShareKeepsEachRecordsOwnAttributes() {
        val s = graceShares()
        // Save a copy: from Grace's drive into this account's, under the free name the view model picks.
        vault.copyAcross(s, server.root, "S (2)")
        val saved = server.child(server.root, "S (2)")
        assertEquals(server.workspace, saved.workspaceId)
        assertEquals(attrs("S"), server.record(saved.id).attributes)
        assertEquals(attrs("t"), server.record(server.child(saved.id, "t.txt").id).attributes)
        val savedU = server.child(saved.id, "U")
        assertEquals(attrs("U"), server.record(savedU.id).attributes)
        assertEquals(attrs("v"), server.record(server.child(savedU.id, "v.txt").id).attributes)
    }

    @Test
    fun aMoveIntoASharedFolderKeepsEachRecordsOwnAttributes() {
        val s = graceShares()
        vault.listChildren(s)
        // Moving A into Grace's folder: re-uploaded there node by node (moveAll and paste then trash the original).
        vault.copyAcross(a, s)
        val moved = server.child(s, "A")
        assertEquals(server.graceWorkspace, moved.workspaceId)
        assertEquals(attrs("A"), server.record(moved.id).attributes)
        assertEquals(attrs("f"), server.record(server.child(moved.id, "f.txt").id).attributes)
        val movedSub = server.child(moved.id, "Sub")
        assertEquals(attrs("Sub"), server.record(movedSub.id).attributes)
        assertEquals(attrs("h"), server.record(server.child(movedSub.id, "h.txt").id).attributes)
    }

    @Test
    fun aTypedNameWithALoneSurrogateIsRefusedInWordsBeforeAnyRecordIsWritten() {
        val sent = server.requests.size
        val envelope = server.node(a).metadataEnvelope
        // Reaching the core as typed, the bindings would throw a CharacterCodingException, which reads as being offline.
        assertThrows(NameCantBeSaved::class.java) { vault.rename(a, "A\uD800") }
        assertThrows(NameCantBeSaved::class.java) { vault.copy(g, a, "g\uD800.txt") }
        assertThrows(NameCantBeSaved::class.java) { vault.copy(a, b, "A\uDC00") }
        assertThrows(NameCantBeSaved::class.java) { vault.createFolder(b, "new\uD800") }
        // No record is written. createFolder asks for its epoch before it checks the name, so one may be spent; nothing else.
        assertEquals(emptyList<String>(), server.requests.drop(sent).filter { !it.startsWith("GET ") && !it.endsWith("/epochs") })
        assertEquals(envelope, server.node(a).metadataEnvelope)
        assertEquals("A", server.record(a).name)
        assertEquals(attrs("A"), server.record(a).attributes)
        // Nothing was made: every folder holds what it held.
        assertEquals(listOf(f, sub), server.children(a).map { it.id })
        assertEquals(listOf(a, b), server.children(server.root).map { it.id })
        assertEquals(listOf(g), server.children(b).map { it.id })
    }
}
