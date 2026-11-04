package com.hushos.app.data

import android.content.Context
import java.io.File
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/*
 * Save to HushOS into a family folder (SaveTargets), through the real Vault, GroupsApi and the core's area ledger against
 * FakeDrive serving rosters the core signs: Maya is in the Lindqvist family and shares a file from another app. What the
 * queue is handed is what these tests check: the folder, and the family and workspace its job opens before it seals.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class SaveTargetsTest {
    private val server = FakeDrive()
    private lateinit var family: FamilyFixture
    private val context: Context get() = RuntimeEnvironment.getApplication()

    /* What the queue was handed: the copy, the name, the folder and the family. */
    private data class Queued(val name: String, val folderId: String, val family: TransferQueue.Family?)
    private val queued = ArrayList<Queued>()
    private val queue: (File, String, String?, String, TransferQueue.Family?) -> Unit = { _, name, _, folderId, family -> queued.add(Queued(name, folderId, family)) }

    @Before
    fun signIn() {
        FamilyFixture.signIn(server, "save-targets-test")
        family = FamilyFixture(server)
        family.storePin(family.pin(family.mayaManages()))
    }

    @After
    fun close() {
        server.close()
        assertEquals("routes the fake does not serve", emptyList<String>(), server.unknown)
    }

    private fun sheet(phone: FamilyFixture.Phone = family.phone()) = SaveTargets(phone.vault, phone.sync) { Shared.session(context) }
    private fun shared(name: String = "receipt.pdf") = SaveTargets.Outgoing(File(context.cacheDir, "shared-" + System.nanoTime()).apply { writeText("pdf") }, name, "application/pdf")

    /*
     * The family Maya is in is offered by its name, with its folder, and a save there is queued as that family's upload in
     * the folder's own workspace. Fails if a family folder is queued without its family (the job would seal under the
     * personal keys) or under another workspace than the folder's.
     */
    @Test
    fun aFamilyFolderIsOfferedAndQueuedAsItsFamilysUpload() {
        val sheet = sheet()
        val offered = sheet.families()
        assertEquals(listOf("Lindqvist family"), offered.map { it.name })
        val folder = offered.single().folders.single()
        assertEquals(family.rootId, folder.id)
        assertEquals(TransferQueue.Family(family.groupId, family.workspaceId.lowercase()), folder.family)
        assertEquals(listOf("receipt.pdf"), sheet.save(folder, listOf(shared()), queue))
        assertEquals(listOf(Queued("receipt.pdf", family.rootId, TransferQueue.Family(family.groupId, family.workspaceId.lowercase()))), queued)
    }

    /*
     * Maya is removed from the family after the sheet listed it. The save checks the family again: nothing is queued, it
     * says she isn't in the family any more, and the family is no longer offered. Fails if a removed family's folder is
     * still uploaded to, or still offered.
     */
    @Test
    fun aFamilyRemovedMidSheetIsNeitherQueuedNorOffered() {
        val sheet = sheet()
        val folder = sheet.families().single().folders.single()
        family.notMember = true
        val refused = runCatching { sheet.save(folder, listOf(shared()), queue) }.exceptionOrNull()
        assertEquals(FamilyWords.NOT_IN_FAMILY, (refused as FamilyFailure).message)
        assertTrue("nothing queued", queued.isEmpty())
        assertTrue("not offered again", sheet.families().isEmpty())
    }

    /*
     * Another account signs in while the sheet is open (or Maya signs out). Nothing is listed or queued under the
     * session the sheet began in, into either drive. Fails if a sheet saves the last account's files into its folders
     * under the next account, or lists the last account's families.
     */
    @Test
    fun anAccountSwitchedMidSheetQueuesNothing() {
        val phone = family.phone()
        val own = phone.vault.rootId
        val sheet = sheet(phone)
        val folder = sheet.families().single().folders.single()
        Shared.writeSession(context, Shared.Session(server.origin, "another-token", "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f", "other@example.org"))
        assertTrue(runCatching { sheet.save(folder, listOf(shared()), queue) }.exceptionOrNull() is SaveTargets.SessionEnded)
        assertTrue(runCatching { sheet.save(Places.Folder(own, "Files"), listOf(shared()), queue) }.exceptionOrNull() is SaveTargets.SessionEnded)
        assertTrue(runCatching { sheet.families() }.exceptionOrNull() is SaveTargets.SessionEnded)
        assertTrue("nothing queued", queued.isEmpty())
    }

    /*
     * Your own drive's folder is queued as your own upload, never as a family's, and a name the folder holds gets " (2)".
     * Fails if your own drive's save is handed a family (its job would open a family for a personal folder) or overwrites.
     */
    @Test
    fun yourOwnFolderIsQueuedAsYourOwnUpload() {
        val phone = family.phone()
        val own = phone.vault.rootId
        sheet(phone).save(Places.Folder(own, "Files"), listOf(shared("a.txt"), shared("a.txt")), queue)
        assertEquals(listOf(Queued("a.txt", own, null), Queued("a (2).txt", own, null)), queued)
    }

    /*
     * The folder last saved into is remembered with its family, and only whole: a family folder's id without its family
     * (or the other way round) is no folder to offer. Fails if a family folder comes back as one of your own drive.
     */
    @Test
    fun theLastFolderKeepsItsFamily() {
        Places.used(context, Places.Folder(family.rootId, "Photos", family.groupId, family.workspaceId))
        assertEquals(Places.Folder(family.rootId, "Photos", family.groupId, family.workspaceId), Places.last(context))
        Places.used(context, "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e", "Files")
        assertNull(Places.last(context)!!.family)
        context.getSharedPreferences(Places.PREFS, Context.MODE_PRIVATE).edit().putString("last-folder", family.rootId).putString("last-folder-group", family.groupId).commit()
        assertNull("half a family's is none", Places.last(context))
    }
}
