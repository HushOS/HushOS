package com.hushos.app.files

import android.content.pm.ProviderInfo
import android.database.Cursor
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import android.provider.DocumentsContract.Root
import com.hushos.app.data.DriveApi
import com.hushos.app.data.FakeDrive
import com.hushos.app.data.FamilyCopies
import com.hushos.app.data.FamilyFixture
import com.hushos.app.data.FamilyFailure
import com.hushos.app.data.FamilyState
import com.hushos.app.data.FamilySync
import com.hushos.app.data.GuardUnsaved
import com.hushos.app.data.SessionEnded
import com.hushos.app.data.Shared
import com.hushos.app.data.Vault
import com.hushos.app.data.familyGuardKept
import com.hushos.app.data.FamilyUploads
import com.hushos.app.data.Reservations
import com.hushos.app.data.TransferQueue
import com.hushos.app.data.WriteBacks
import androidx.work.Configuration
import androidx.work.ListenableWorker
import androidx.work.testing.TestListenableWorkerBuilder
import com.hushos.app.data.UploadWorker
import kotlinx.coroutines.runBlocking
import androidx.work.WorkManager
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.WorkManagerTestInitHelper
import java.util.UUID
import com.hushos.app.data.oweFamilyGuard
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.io.File
import java.io.FileNotFoundException

/*
 * Families in the Files app (Android 6): the real HushOSDocumentsProvider and its own vault, ledger and family sync,
 * against FakeDrive serving rosters the core signs (FamilyFixture). A root is a family the provider's own ledger accepted,
 * holding the folders route 25 proved; it goes, its copies with it, when the family is left or the account removed; and
 * every write from Files goes through the family write path, refused before anything is sent while the guard is owed,
 * once the family went elsewhere, when it goes while the write is on its way, and once the session ended.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ProviderFamiliesTest {
    private val server = FakeDrive()
    private lateinit var family: FamilyFixture
    private val app get() = RuntimeEnvironment.getApplication()
    private val authority get() = "${app.packageName}.documents"

    @Before
    fun signIn() {
        FamilyFixture.signIn(server, "provider-families-test")
        family = FamilyFixture(server)
        family.storePin(family.pin(listOf(family.r1, family.r2)))
        WorkManagerTestInitHelper.initializeTestWorkManager(app, Configuration.Builder().setExecutor(SynchronousExecutor()).setTaskExecutor(SynchronousExecutor()).build())
    }

    @After
    fun close() {
        Reservations.forgetHeld()
        server.close()
        assertEquals("routes the fake does not serve", emptyList<String>(), server.unknown)
    }

    /* The provider as the system makes it, with family loads run on the calling thread. */
    private fun provider(): HushOSDocumentsProvider {
        val info = ProviderInfo().apply {
            authority = this@ProviderFamiliesTest.authority
            exported = true
            grantUriPermissions = true
            readPermission = android.Manifest.permission.MANAGE_DOCUMENTS
            writePermission = android.Manifest.permission.MANAGE_DOCUMENTS
        }
        return Robolectric.buildContentProvider(HushOSDocumentsProvider::class.java).create(info).get().also { it.runFamilyLoad = { load -> load.run() } }
    }

    private fun rows(cursor: Cursor, column: String): List<String?> = cursor.use { c ->
        val index = c.getColumnIndexOrThrow(column)
        generateSequence { if (c.moveToNext()) c.getString(index) else null }.toList()
    }

    private fun familyRoots(provider: HushOSDocumentsProvider) = rows(provider.queryRoots(null), Root.COLUMN_ROOT_ID).filter { it != "hushos" }

    private val top get() = FamilyDoc.Top(family.groupId).id
    private val folder get() = FamilyDoc.Node(family.groupId, family.workspaceId, family.rootId).id
    private val file get() = FamilyDoc.Node(family.groupId, family.workspaceId, family.fileId).id

    private val slot get() = WriteBacks.slotOf(family.workspaceId, family.fileId)

    /*
     * What another app wrote, kept as the file's pending save as the close callback keeps it (ProviderFamilies.save), the
     * file as the app opened it being the row this vault holds. The file's slot.
     */
    private fun writeBack(families: ProviderFamilies, doc: FamilyDoc.Node, edit: File,
                          opened: com.hushos.app.data.Opened = families.vault.item(doc.workspaceId, doc.nodeId)!!): String {
        assertTrue("the save wasn't kept", families.save(doc, edit, opened))
        return WriteBacks.slotOf(doc.workspaceId, doc.nodeId)
    }

    private fun jobs(slot: String) = WorkManager.getInstance(app).getWorkInfosByTag(WriteBacks.SLOT + slot).get()

    /*
     * A run of the slot's job as WorkManager starts it: the worker with the slot request's input and tags (WorkManager holds
     * a job with those tags), its doWork called directly as UploadWorkerTest does (a worker run through the synchronous test
     * executor can't ask WorkManager anything). The run is the waiting job's own (its id), so what the job tells apart by
     * id (its own from the family's other uploads) is told apart here as on a phone; with none waiting, an id of its own.
     */
    private fun runJob(slot: String): ListenableWorker.Result {
        val session = TransferQueue.accountTag(Shared.session(app)!!)
        val queued = jobs(slot)
        assertTrue("no job was queued for the slot", queued.isNotEmpty())
        val expected = TransferQueue.slotRequest(queued.last().id, slot, WriteBacks.contentOf(app, slot), family.groupId.lowercase(), session).tags
        assertTrue(queued.any { it.tags == expected })
        val id = queued.firstOrNull { it.state == androidx.work.WorkInfo.State.ENQUEUED }?.id ?: UUID.randomUUID()
        val request = TransferQueue.slotRequest(id, slot, WriteBacks.contentOf(app, slot), family.groupId.lowercase(), session)
        val worker = TestListenableWorkerBuilder<UploadWorker>(app).setId(id).setInputData(request.workSpec.input).setTags(request.tags.toList()).build()
        return runBlocking { worker.doWork() }
    }

    private fun begins() = server.requests.count { it == "POST /api/drive/uploads" }

    /* The file's bytes as another phone of the account reads them from the server. */
    private fun serverText(): String {
        val other = family.phone()
        assertTrue(other.sync.sync(family.summary) is FamilyState.Accepted)
        other.vault.listChildren(family.rootId, family.workspaceId)
        val out = File(app.cacheDir, "read-${System.nanoTime()}")
        other.vault.download(family.fileId, out, workspaceId = family.workspaceId)
        return out.readText()
    }

    private fun queued() = WorkManager.getInstance(app).getWorkInfosByTag(TransferQueue.TAG).get()

    private fun read(provider: HushOSDocumentsProvider, documentId: String): String =
        ParcelFileDescriptor.AutoCloseInputStream(provider.openDocument(documentId, "r", null)).use { it.readBytes().decodeToString() }

    private fun driveWritesSince(count: Int) = server.requests.drop(count).filter { !it.startsWith("GET") && "/drive/" in it }

    private val rootsUri get() = DocumentsContract.buildRootsUri(authority)
    private fun rootsTold() = shadowOf(app.contentResolver).notifiedUris.count { it.uri == rootsUri }

    /*
     * The family's root: `family:<groupId>`, titled the family's name, its one folder the family's top folder opened
     * through the provider's ledger, Sam's file listed and read byte for byte into the family folder's copies. Fails if
     * the provider shows no family, names it otherwise, lists the folder or file under any other id, or reads them other
     * than through its own ledger.
     */
    @Test
    fun aFamilyItsLedgerAcceptedIsARootWithItsFolder() {
        val provider = provider()
        assertEquals(listOf("family:${family.groupId}"), familyRoots(provider))
        val titles = provider.queryRoots(null).use { c ->
            generateSequence { if (c.moveToNext()) c.getString(c.getColumnIndexOrThrow(Root.COLUMN_ROOT_ID)) to c.getString(c.getColumnIndexOrThrow(Root.COLUMN_TITLE)) else null }.toMap()
        }
        assertEquals("Lindqvist family", titles["family:${family.groupId}"])
        assertEquals(listOf(folder), rows(provider.queryChildDocuments(top, null, null as String?), Document.COLUMN_DOCUMENT_ID))
        assertEquals(listOf("Photos"), rows(provider.queryChildDocuments(top, null, null as String?), Document.COLUMN_DISPLAY_NAME))
        assertEquals(listOf(file), rows(provider.queryChildDocuments(folder, null, null as String?), Document.COLUMN_DOCUMENT_ID))
        assertEquals("marker-family", read(provider, file))
        assertTrue(FamilyCopies.folder(app.cacheDir, family.workspaceId)!!.walkTopDown().any { it.isFile })
        assertTrue(provider.isChildDocument(top, file))
        assertFalse(provider.isChildDocument("root", file))
    }

    /*
     * A family not let in yet (accepted the invitation, waiting) and one whose member list was shown differently have no
     * root, and nothing of them opens through the provider. Fails if a family route 2 lists but the ledger didn't accept
     * is shown.
     */
    @Test
    fun aFamilyWaitingOrShownDifferentlyHasNoRoot() {
        family.groupState = "accepted"
        val waiting = provider()
        assertEquals(emptyList<String>(), familyRoots(waiting))
        assertThrows(FileNotFoundException::class.java) { waiting.queryChildDocuments(top, null, null as String?) }
        // Let in, but the server shows another roster 2 than the one this account's pin holds: a fork.
        family.groupState = "active"
        family.chain = listOf(family.r1, family.r2Other)
        val forked = Vault(app, DriveApi(Shared.session(app)!!))
        val families = ProviderFamilies(forked)
        assertEquals(emptyList<FamilyRoot>(), families.load())
        assertTrue(families.sync.sync(family.summary) is FamilyState.Fork)
        assertThrows(FileNotFoundException::class.java) { families.children(FamilyDoc.Top(family.groupId)) }
    }

    /*
     * Left on the app (another vault of the session): Files is told at once, and the provider's next answer checks the
     * family again: its root is gone, its own ledger let go of the folder, and the copies it read and the edit it was
     * writing are deleted. Fails if the app's leave doesn't tell Files, if the provider answers from the roots it loaded
     * before, or keeps the family's keys, copies or edits.
     */
    @Test
    fun aFamilyLeftOnTheAppLeavesFilesWithItsCopies() {
        val provider = provider()
        rows(provider.queryChildDocuments(folder, null, null as String?), Document.COLUMN_DOCUMENT_ID)
        assertEquals("marker-family", read(provider, file))
        val copies = FamilyCopies.folder(app.cacheDir, family.workspaceId)!!
        assertTrue(copies.exists())
        val edit = familiesOf(provider).editCopy(FamilyDoc.of(file) as FamilyDoc.Node, keepContents = true)
        val phone = family.phone()
        assertTrue(phone.sync.sync(family.summary) is FamilyState.Accepted)
        // The app's acceptance told Files too; the provider looked since, and still shows the family.
        assertEquals(listOf("family:${family.groupId}"), familyRoots(provider))
        val told = rootsTold()
        assertTrue(phone.sync.leave(family.groupId) is FamilySync.Leaving.Left)
        assertTrue("Files wasn't told", rootsTold() > told)
        assertEquals(emptyList<String>(), familyRoots(provider))
        assertThrows(FileNotFoundException::class.java) { provider.queryChildDocuments(folder, null, null as String?) }
        assertFalse(copies.exists())
        assertFalse(edit.exists())
    }

    /*
     * Removed by the server while nothing else on the phone looked (the app closed): the provider's own load, once its
     * roots are old, asks about the family route 2 stopped listing, wipes it in its own ledger, deletes its copies and
     * tells Files. Fails if the provider keeps a root, a key or a copy of a family the server said it isn't in.
     */
    @Test
    fun aRemovalTheProviderFindsItselfTakesTheRootKeysAndCopies() {
        var now = 0L
        val vault = Vault(app, DriveApi(Shared.session(app)!!))
        val families = ProviderFamilies(vault, FamilySync(vault, sweeps = false, tellsFiles = false)) { now }
        assertEquals(listOf(family.groupId), families.load().map { it.groupId })
        val doc = FamilyDoc.Node(family.groupId, family.workspaceId, family.fileId)
        families.children(FamilyDoc.Node(family.groupId, family.workspaceId, family.rootId))
        val copy = families.readCopy(doc)
        assertEquals("marker-family", copy.readText())
        family.notMember = true
        family.listed = false
        // Not due yet: what it showed stands until its roots are old.
        assertFalse(families.due())
        now += 6 * 60_000L
        assertTrue(families.due())
        val told = rootsTold()
        assertEquals(emptyList<FamilyRoot>(), families.load())
        assertTrue(rootsTold() > told)
        assertFalse(vault.areaLedger.isArea(family.workspaceId))
        assertFalse(copy.exists())
        assertThrows(FileNotFoundException::class.java) { families.readCopy(doc) }
    }

    /*
     * A family Files showed whose member list the server now shows differently (a fork), or that the server says this
     * account isn't in while route 2 still lists it: its root goes at the provider's next load, its ledger refuses it and
     * its copies go. Fails if a root outlives its family's acceptance.
     */
    @Test
    fun aRootGoesWhenItsFamilyIsShownDifferentlyOrNotThisAccountsAnyMore() {
        var now = 0L
        family.chain = listOf(family.r1, family.r2, family.r3)
        val vault = Vault(app, DriveApi(Shared.session(app)!!))
        val families = ProviderFamilies(vault, FamilySync(vault, sweeps = false, tellsFiles = false)) { now }
        assertEquals(listOf(family.groupId), families.load().map { it.groupId })
        families.children(FamilyDoc.Node(family.groupId, family.workspaceId, family.rootId))
        val copy = families.readCopy(FamilyDoc.Node(family.groupId, family.workspaceId, family.fileId))
        // Another history from roster 3 than the one accepted.
        family.chain = listOf(family.r1, family.r2, family.r3Fork, family.r4Fork)
        now += 6 * 60_000L
        assertEquals(emptyList<FamilyRoot>(), families.load())
        assertFalse(copy.exists())
        assertThrows(FileNotFoundException::class.java) { families.children(FamilyDoc.Top(family.groupId)) }
        // A fresh session's provider on a family shown as it was, then the server says this account isn't in it while
        // route 2 still lists it.
        vault.close()
        family.chain = listOf(family.r1, family.r2, family.r3)
        FamilyFixture.signIn(server, "provider-families-test-2")
        family.storePin(family.pin(listOf(family.r1, family.r2)))
        val again = Vault(app, DriveApi(Shared.session(app)!!))
        val other = ProviderFamilies(again, FamilySync(again, sweeps = false, tellsFiles = false)) { now }
        assertEquals(listOf(family.groupId), other.load().map { it.groupId })
        family.notMember = true
        now += 6 * 60_000L
        assertEquals(emptyList<FamilyRoot>(), other.load())
        assertFalse(again.areaLedger.isArea(family.workspaceId))
    }

    /*
     * Files writes in a family folder: a new folder, a file written back as a new version, a rename and Move to Trash, all
     * through the provider's ledger, and another phone of the account reads the new bytes. Fails if any of them goes
     * another way than the family write path (keys the ledger made or holds), or lands anything but what Files wrote.
     */
    @Test
    fun filesWritesLandThroughTheFamilyWritePath() {
        val provider = provider()
        val made = provider.createDocument(folder, Document.MIME_TYPE_DIR, "Trips")
        val trips = FamilyDoc.of(made) as FamilyDoc.Node
        assertEquals(family.workspaceId, trips.workspaceId)
        assertEquals("Trips", server.record(trips.nodeId).name)
        rows(provider.queryChildDocuments(folder, null, null as String?), Document.COLUMN_DOCUMENT_ID)
        val families = familiesOf(provider)
        val edit = families.editCopy(FamilyDoc.of(file) as FamilyDoc.Node, keepContents = true)
        assertTrue(edit.path.startsWith(FamilyCopies.edits(app.cacheDir, family.workspaceId)!!.path))
        assertEquals("marker-family", edit.readText())
        edit.writeText("edited in another app")
        assertEquals(ListenableWorker.Result.success(), runJob(writeBack(families, FamilyDoc.of(file) as FamilyDoc.Node, edit)))
        provider.renameDocument(made, "Trips 2026")
        assertEquals("Trips 2026", server.record(trips.nodeId).name)
        provider.deleteDocument(made)
        assertTrue(server.node(trips.nodeId).trashedAt != null)
        // Another phone of the account, its own ledger: the bytes Files wrote.
        val other = family.phone()
        assertTrue(other.sync.sync(family.summary) is FamilyState.Accepted)
        val recipes = other.vault.listChildren(family.rootId, family.workspaceId).single { it.id == family.fileId }
        val out = File(app.cacheDir, "read-${System.nanoTime()}")
        other.vault.download(recipes.id, out, workspaceId = family.workspaceId)
        assertEquals("edited in another app", out.readText())
        // Never out of the family folder, into another, or into the drive.
        assertThrows(FileNotFoundException::class.java) { provider.moveDocument(file, folder, "root") }
    }

    /*
     * The write barrier: while the family's guard is owed, Files writes nothing into its folders. A direct write is
     * refused; an edit another app already wrote is not dropped but queued, and its job sends nothing until the guard is
     * kept, then lands. Fails if a write passes without the guard kept, or an edit is lost to a barrier that only holds
     * for now.
     */
    @Test
    fun filesWritesNothingWhileTheGuardIsOwed() {
        val provider = provider()
        rows(provider.queryChildDocuments(folder, null, null as String?), Document.COLUMN_DOCUMENT_ID)
        val families = familiesOf(provider)
        val doc = FamilyDoc.of(file) as FamilyDoc.Node
        val edit = families.editCopy(doc, keepContents = false).apply { writeText("held behind the guard") }
        val sent = server.requests.size
        val debt = families.vault.oweFamilyGuard(family.groupId)
        assertThrows(FileNotFoundException::class.java) { provider.createDocument(folder, Document.MIME_TYPE_DIR, "Trips") }
        val job = writeBack(families, doc, edit)
        assertTrue("the edit wasn't kept for its job", WriteBacks.contentOf(app, job).exists())
        assertTrue(runJob(job) != ListenableWorker.Result.success())
        assertEquals("a write went out under an owed guard", emptyList<String>(), driveWritesSince(sent))
        families.vault.familyGuardKept(debt)
        assertEquals(ListenableWorker.Result.success(), runJob(job))
        families.children(FamilyDoc.Node(family.groupId, family.workspaceId, family.rootId))
        assertEquals("held behind the guard", families.readCopy(doc).readText())
    }

    /*
     * Left elsewhere after Files opened the file and before it wrote it back: the save is kept (the close asks nothing of
     * the network), and its job checks the family first, sends nothing and ends the family's uploads, its slot with them.
     * Fails if a write-back goes out on the roots the provider loaded before the leave, or its save outlives the family.
     */
    @Test
    fun aWriteBackAfterTheFamilyWentElsewhereSendsNothing() {
        val provider = provider()
        rows(provider.queryChildDocuments(folder, null, null as String?), Document.COLUMN_DOCUMENT_ID)
        val families = familiesOf(provider)
        val edit = families.editCopy(FamilyDoc.of(file) as FamilyDoc.Node, keepContents = false).apply { writeText("not sent") }
        val phone = family.phone()
        assertTrue(phone.sync.sync(family.summary) is FamilyState.Accepted)
        assertEquals(listOf("family:${family.groupId}"), familyRoots(provider))
        assertTrue(phone.sync.leave(family.groupId) is FamilySync.Leaving.Left)
        // The leave deleted the family's copies, the edit among them; as if this one had outlived it, so only the
        // provider's own check of the family stands between it and the server.
        edit.parentFile!!.mkdirs()
        edit.writeText("not sent")
        val sent = server.requests.size
        val slot = writeBack(families, FamilyDoc.of(file) as FamilyDoc.Node, edit)
        assertEquals(ListenableWorker.Result.failure()::class, runJob(slot)::class)
        assertEquals(emptyList<String>(), driveWritesSince(sent))
        assertNull("the save outlived the family", WriteBacks.pending(app, slot))
        assertEquals(com.hushos.app.data.FamilyWords.NOT_IN_FAMILY, com.hushos.app.data.FailedTransfers.of(app).all().single().reason)
    }

    /*
     * Left elsewhere while a rename from Files is on its way (between its entry and its send): the final gate refuses it in
     * the family's words. Fails if the final gate doesn't check whether the folder was let go of since the write began.
     */
    @Test
    fun aRenameTheFamilyLeavesMidwayIsNotSent() {
        val provider = provider()
        rows(provider.queryChildDocuments(folder, null, null as String?), Document.COLUMN_DOCUMENT_ID)
        val families = familiesOf(provider)
        val phone = family.phone()
        assertTrue(phone.sync.sync(family.summary) is FamilyState.Accepted)
        val version = server.node(family.fileId).metadataVersion
        var sent = 0
        families.vault.beforeWriteGate = {
            families.vault.beforeWriteGate = null
            assertTrue(phone.sync.leave(family.groupId) is FamilySync.Leaving.Left)
            sent = server.requests.size
        }
        assertThrows(FamilyFailure::class.java) { families.rename(FamilyDoc.of(file) as FamilyDoc.Node, "Renamed.txt") }
        assertEquals(emptyList<String>(), driveWritesSince(sent))
        assertEquals(version, server.node(family.fileId).metadataVersion)
    }

    /*
     * The session ended (a sign-out) while a rename from Files was on its way: nothing goes. Fails if the final gate lets a
     * closed session's write through while the provider's ledger still holds the family.
     */
    @Test
    fun aRenameFromASessionThatEndedSendsNothing() {
        val provider = provider()
        rows(provider.queryChildDocuments(folder, null, null as String?), Document.COLUMN_DOCUMENT_ID)
        val families = familiesOf(provider)
        val version = server.node(family.fileId).metadataVersion
        var sent = 0
        families.vault.beforeWriteGate = {
            families.vault.beforeWriteGate = null
            families.vault.close()
            sent = server.requests.size
        }
        assertThrows(SessionEnded::class.java) { families.rename(FamilyDoc.of(file) as FamilyDoc.Node, "Renamed.txt") }
        assertEquals(emptyList<String>(), driveWritesSince(sent))
        assertEquals(version, server.node(family.fileId).metadataVersion)
    }

    /*
     * A write-back whose first run gets no answer (every begin dropped): the job is retried, not dropped, and its next run
     * lands the new version with nothing left on the reservation ledger. Fails if a failed write-back is lost.
     */
    @Test
    fun aFailedWriteBackIsRetriedUntilItLands() {
        val provider = provider()
        rows(provider.queryChildDocuments(folder, null, null as String?), Document.COLUMN_DOCUMENT_ID)
        val families = familiesOf(provider)
        val doc = FamilyDoc.of(file) as FamilyDoc.Node
        val edit = families.editFor(doc, "w").apply { writeText("written while offline") }
        val job = writeBack(families, doc, edit)
        server.beforeAnswer = { method, path -> if (method == "POST" && path == "drive/uploads") throw IllegalStateException("dropped") }
        assertEquals(ListenableWorker.Result.retry(), runJob(job))
        assertEquals("marker-family", families.readCopy(doc).readText())
        server.beforeAnswer = null
        assertEquals(ListenableWorker.Result.success(), runJob(job))
        assertEquals(emptyList<Reservations.Record>(), Reservations.all(app))
        val other = family.phone()
        assertTrue(other.sync.sync(family.summary) is FamilyState.Accepted)
        val out = File(app.cacheDir, "read-${System.nanoTime()}")
        other.vault.download(family.fileId, out, workspaceId = family.workspaceId)
        assertEquals("written while offline", out.readText())
    }

    /* The process killed mid-upload, as a test can: nothing after it runs. */
    private class Killed : Error()

    /*
     * A write-back's run that died with its upload reserved (the process killed between its begin and its end): the job's
     * next run first settles that reservation through the ledger (aborted on the server, off the ledger), then sends the
     * new version afresh. Fails if an interrupted write-back is dropped or leaves its room reserved.
     */
    @Test
    fun anInterruptedWriteBackIsSettledThenSentAgain() {
        val provider = provider()
        rows(provider.queryChildDocuments(folder, null, null as String?), Document.COLUMN_DOCUMENT_ID)
        val families = familiesOf(provider)
        val doc = FamilyDoc.of(file) as FamilyDoc.Node
        val edit = families.editFor(doc, "w").apply { writeText("written before the crash") }
        val job = writeBack(families, doc, edit)
        val ledger = WriteBacks.pending(app, job)!!.ledger
        // The job's first run, as the worker runs it, killed after its begin.
        assertThrows(Killed::class.java) {
            FamilyUploads.upload(Vault.fromShared(app)!!, family.groupId, family.workspaceId, File(app.cacheDir, "killed").apply { writeText("written before the crash") },
                "Recipes.txt", "text/plain", family.rootId, family.fileId, ledger) { throw Killed() }
        }
        assertEquals(1, Reservations.all(app).count { it.job == ledger })
        val aborts = server.requests.count { it.startsWith("POST ") && it.endsWith("/abort") }
        assertEquals(ListenableWorker.Result.success(), runJob(job))
        assertEquals(aborts + 1, server.requests.count { it.startsWith("POST ") && it.endsWith("/abort") })
        assertEquals(emptyList<Reservations.Record>(), Reservations.all(app))
        families.children(FamilyDoc.Node(family.groupId, family.workspaceId, family.rootId))
        assertEquals("written before the crash", families.readCopy(doc).readText())
    }

    /*
     * Another app writing a family file in each mode: "wa" appends to what the file held and "rw" writes over it in place,
     * so both keep it; "w", "wt" and "rwt" truncate. The writer is played with the platform's own reading of the mode
     * (ParcelFileDescriptor.parseMode), and the new version is read back from the server. Fails if a mode that keeps the
     * contents starts the edit empty (the new version would hold only the appended bytes) or one that truncates doesn't.
     */
    @Test
    fun eachWriteModeKeepsOrDropsWhatTheFileHeld() {
        val provider = provider()
        rows(provider.queryChildDocuments(folder, null, null as String?), Document.COLUMN_DOCUMENT_ID)
        val families = familiesOf(provider)
        val doc = FamilyDoc.of(file) as FamilyDoc.Node
        for (mode in listOf("wa", "rw", "rwt", "wt", "w")) {
            val before = families.readCopy(doc).readText()
            val wrote = "[$mode]"
            val edit = families.editFor(doc, mode)
            writeAs(mode, edit, wrote)
            assertEquals(ListenableWorker.Result.success(), runJob(writeBack(families, doc, edit)))
            // The job landed it in its own vault: Files lists the folder again, as it does once told.
            families.children(FamilyDoc.Node(family.groupId, family.workspaceId, family.rootId))
            val expected = when (mode) {
                "wa" -> before + wrote
                "rw" -> wrote + before.drop(wrote.length)
                else -> wrote
            }
            assertEquals("mode $mode", expected, families.readCopy(doc).readText())
        }
        // Another phone reads what the last write left.
        val other = family.phone()
        assertTrue(other.sync.sync(family.summary) is FamilyState.Accepted)
        val recipes = other.vault.listChildren(family.rootId, family.workspaceId).single { it.id == family.fileId }
        val out = File(app.cacheDir, "read-${System.nanoTime()}")
        other.vault.download(recipes.id, out, workspaceId = family.workspaceId)
        assertEquals("[w]", out.readText())
    }

    /*
     * The drive's own files take the same rule: an edit for "wa" or "rw" starts from the current version, one for "w",
     * "wt" or "rwt" starts empty. Fails if the personal path seeds by "r" alone (an append would replace the file).
     */
    @Test
    fun aPersonalFileOpenedToAppendKeepsWhatItHeld() {
        val notes = server.file(server.root, "Notes.txt", "personal notes".toByteArray())
        val provider = provider()
        rows(provider.queryChildDocuments("root", null, null as String?), Document.COLUMN_DOCUMENT_ID)
        val vault = HushOSDocumentsProvider::class.java.getDeclaredField("vault").apply { isAccessible = true }.get(provider) as Vault
        for (mode in listOf("wa", "rw")) assertEquals(mode, "personal notes", provider.personalEdit(vault, notes, mode).readText())
        // The platform makes the file when it opens it for a truncating mode: nothing of the old version is in it.
        for (mode in listOf("w", "wt", "rwt")) assertEquals(mode, "", provider.personalEdit(vault, notes, mode).let { if (it.exists()) it.readText() else "" })
    }

    /* Plays another app writing `text` into a file it opened in `mode`, as the platform opens it. */
    private fun writeAs(mode: String, file: File, text: String) {
        val flags = ParcelFileDescriptor.parseMode(mode)
        java.io.RandomAccessFile(file, "rw").use { out ->
            if (flags and ParcelFileDescriptor.MODE_TRUNCATE != 0) out.setLength(0)
            out.seek(if (flags and ParcelFileDescriptor.MODE_APPEND != 0) out.length() else 0)
            out.write(text.toByteArray())
        }
    }

    /*
     * A tree Files kept (a family folder granted to an app) reopened by a fresh provider after a restart, its index of
     * parents gone: a document two levels down still opens, its parents found through the ledger by listing where the
     * folder's change feed puts them. A document outside the tree is still refused. Fails if tree membership is judged
     * from the rows this process happens to hold.
     */
    @Test
    fun aTreeKeptAcrossARestartOpensItsChildrenAndNothingOutside() {
        val first = provider()
        val trips = first.createDocument(folder, Document.MIME_TYPE_DIR, "Trips")
        val notes = first.createDocument(trips, "text/plain", "Notes.txt")
        // The process restarts: a fresh provider and vault, and no index of where nodes sit.
        File(app.filesDir, "files-parents.json").delete()
        val fresh = provider()
        val tree = DocumentsContract.buildTreeDocumentUri(authority, folder)
        ParcelFileDescriptor.AutoCloseInputStream(fresh.openFile(DocumentsContract.buildDocumentUriUsingTree(tree, notes), "r")).use { assertEquals(0, it.readBytes().size) }
        assertTrue(fresh.isChildDocument(folder, notes))
        // A tree at Trips holds Notes.txt but not Sam's file beside Trips.
        val tripsTree = DocumentsContract.buildTreeDocumentUri(authority, trips)
        assertFalse(fresh.isChildDocument(trips, file))
        assertThrows(SecurityException::class.java) { fresh.openFile(DocumentsContract.buildDocumentUriUsingTree(tripsTree, file), "r") }
    }

    /*
     * The last sync got no answer: the root stays, readable, but writes nothing, neither offered (no create on its folders)
     * nor taken, until the family is accepted again. Fails if a root kept on no answer still writes.
     */
    @Test
    fun aRootKeptWithoutAnAnswerIsReadOnlyUntilAcceptedAgain() {
        var now = 0L
        val vault = Vault(app, DriveApi(Shared.session(app)!!))
        val families = ProviderFamilies(vault, FamilySync(vault, sweeps = false, tellsFiles = false)) { now }
        val top = FamilyDoc.Node(family.groupId, family.workspaceId, family.rootId)
        assertTrue(families.load().single().folders.single().writable)
        // Route 5 drops every request: no answer.
        server.beforeAnswer = { _, path -> if (path.startsWith("groups/") && path.endsWith("/rosters")) throw IllegalStateException("dropped") }
        now += 6 * 60_000L
        val kept = families.load().single()
        assertFalse(kept.folders.single().writable)
        assertTrue(kept.unanswered)
        assertEquals(0, families.document(top).flags and Document.FLAG_DIR_SUPPORTS_CREATE)
        assertEquals(listOf("Recipes.txt"), families.children(top).map { it.name })
        val sent = server.requests.size
        assertThrows(FileNotFoundException::class.java) { families.create(top, Document.MIME_TYPE_DIR, "Trips") }
        assertThrows(FileNotFoundException::class.java) { families.editCopy(FamilyDoc.Node(family.groupId, family.workspaceId, family.fileId), keepContents = false) }
        assertEquals(emptyList<String>(), driveWritesSince(sent))
        // Answered again: writable again.
        server.beforeAnswer = null
        now += 60_000L
        assertTrue(families.load().single().folders.single().writable)
        families.create(top, Document.MIME_TYPE_DIR, "Trips")
    }

    /*
     * A family folder Files shows, changed on another device (a new file): the next poll lists it again and tells Files,
     * and a poll that finds nothing new tells nothing. Fails if polling refreshes only the personal drive.
     */
    @Test
    fun aPollTellsFilesOfAFamilyFolderChangedElsewhere() {
        val provider = provider()
        rows(provider.queryChildDocuments(folder, null, null as String?), Document.COLUMN_DOCUMENT_ID)
        val listing = DocumentsContract.buildChildDocumentsUri(authority, family.rootId)
        fun told() = shadowOf(app.contentResolver).notifiedUris.count { it.uri == listing }
        assertTrue(provider.pollOnce())
        val before = told()
        server.file(family.rootId, "Budget.txt", "from the web".toByteArray())
        assertTrue(provider.pollOnce())
        assertEquals(before + 1, told())
        assertTrue(provider.pollOnce())
        assertEquals(before + 1, told())
        assertTrue("Budget.txt" in rows(provider.queryChildDocuments(folder, null, null as String?), Document.COLUMN_DISPLAY_NAME))
    }

    /*
     * An editor holds a family file open when the family's check gets no answer (the root goes read only): what it wrote is
     * queued, not deleted, its job waits while the family can't be checked, and it lands once the family is accepted
     * again. Fails if a transient refusal drops the only edited copy.
     */
    @Test
    fun anEditOpenWhenTheFamilyGetsNoAnswerLandsOnceAcceptedAgain() {
        var now = 0L
        val vault = Vault(app, DriveApi(Shared.session(app)!!))
        val families = ProviderFamilies(vault, FamilySync(vault, sweeps = false, tellsFiles = false)) { now }
        families.load()
        val top = FamilyDoc.Node(family.groupId, family.workspaceId, family.rootId)
        val doc = FamilyDoc.Node(family.groupId, family.workspaceId, family.fileId)
        families.children(top)
        val edit = families.editFor(doc, "w").apply { writeText("saved while offline") }
        server.beforeAnswer = { _, path -> if (path.startsWith("groups/") && path.endsWith("/rosters")) throw IllegalStateException("dropped") }
        now += 6 * 60_000L
        families.load()
        assertTrue(families.roots.single().unanswered)
        val job = writeBack(families, doc, edit)
        assertEquals("saved while offline", WriteBacks.contentOf(app, job).readText())
        assertEquals(ListenableWorker.Result.retry(), runJob(job))
        server.beforeAnswer = null
        assertEquals(ListenableWorker.Result.success(), runJob(job))
        val other = family.phone()
        assertTrue(other.sync.sync(family.summary) is FamilyState.Accepted)
        val out = File(app.cacheDir, "read-${System.nanoTime()}")
        other.vault.listChildren(family.rootId, family.workspaceId)
        other.vault.download(family.fileId, out, workspaceId = family.workspaceId)
        assertEquals("saved while offline", out.readText())
    }

    /*
     * A write-back the queue landed (in its job's own vault), then the editor opens the file again: it reads the new bytes,
     * and an append builds on them, never on the version this vault opened before. Fails if a reopen answers from the
     * provider's stale row (old bytes read, and an append that drops the save).
     */
    @Test
    fun aReopenAfterAQueuedWriteBackReadsAndBuildsOnTheNewVersion() {
        val provider = provider()
        rows(provider.queryChildDocuments(folder, null, null as String?), Document.COLUMN_DOCUMENT_ID)
        val families = familiesOf(provider)
        val doc = FamilyDoc.of(file) as FamilyDoc.Node
        val first = families.editFor(doc, "w").apply { writeText("saved") }
        assertEquals(ListenableWorker.Result.success(), runJob(writeBack(families, doc, first)))
        assertEquals("saved", ParcelFileDescriptor.AutoCloseInputStream(provider.openDocument(file, "r", null)).use { it.readBytes().decodeToString() })
        val append = families.editFor(doc, "wa")
        assertEquals("saved", append.readText())
        writeAs("wa", append, " and more")
        assertEquals(ListenableWorker.Result.success(), runJob(writeBack(families, doc, append)))
        val other = family.phone()
        assertTrue(other.sync.sync(family.summary) is FamilyState.Accepted)
        val out = File(app.cacheDir, "read-${System.nanoTime()}")
        other.vault.listChildren(family.rootId, family.workspaceId)
        other.vault.download(family.fileId, out, workspaceId = family.workspaceId)
        assertEquals("saved and more", out.readText())
    }

    /*
     * A document Files remembered, opened directly (no roots or listing asked first) after the roots went old: the family
     * is checked again before the answer, so a root kept read only after no answer is writable again once the family
     * answers. Fails if a direct request answers from roots past their expiry.
     */
    @Test
    fun aDirectRequestChecksRootsThatWentOld() {
        var now = 0L
        val vault = Vault(app, DriveApi(Shared.session(app)!!))
        val families = ProviderFamilies(vault, FamilySync(vault, sweeps = false, tellsFiles = false)) { now }
        families.load()
        val top = FamilyDoc.Node(family.groupId, family.workspaceId, family.rootId)
        server.beforeAnswer = { _, path -> if (path.startsWith("groups/") && path.endsWith("/rosters")) throw IllegalStateException("dropped") }
        now += 6 * 60_000L
        families.load()
        assertThrows(FileNotFoundException::class.java) { families.create(top, Document.MIME_TYPE_DIR, "Trips") }
        server.beforeAnswer = null
        now += 60_000L
        // No load asked for: the direct request itself checks the family again.
        val made = FamilyDoc.of(families.create(top, Document.MIME_TYPE_DIR, "Trips")) as FamilyDoc.Node
        assertEquals("Trips", server.record(made.nodeId).name)
    }

    /*
     * Another device moves a file out of a folder granted to an app as a tree: the provider never grants it through the old
     * tree from where it used to be, whether asked at once or after a poll listed the folder again. It is still inside the
     * family's own top. Fails if tree access is judged from a cached row, or a relisting keeps rows the folder no longer has.
     */
    @Test
    fun aFileMovedOutOfATreeElsewhereIsOutsideItAtOnce() {
        val provider = provider()
        val trips = provider.createDocument(folder, Document.MIME_TYPE_DIR, "Trips")
        val notes = provider.createDocument(trips, "text/plain", "Notes.txt")
        rows(provider.queryChildDocuments(trips, null, null as String?), Document.COLUMN_DOCUMENT_ID)
        assertTrue(provider.isChildDocument(trips, notes))
        val other = family.phone()
        assertTrue(other.sync.sync(family.summary) is FamilyState.Accepted)
        other.vault.listChildren(family.rootId, family.workspaceId)
        other.vault.listChildren((FamilyDoc.of(trips) as FamilyDoc.Node).nodeId, family.workspaceId)
        other.vault.move((FamilyDoc.of(notes) as FamilyDoc.Node).nodeId, family.rootId)
        assertFalse(provider.isChildDocument(trips, notes))
        assertTrue(provider.pollOnce())
        val tree = DocumentsContract.buildTreeDocumentUri(authority, trips)
        assertThrows(SecurityException::class.java) { provider.openFile(DocumentsContract.buildDocumentUriUsingTree(tree, notes), "r") }
        assertFalse(provider.isChildDocument(trips, notes))
        assertTrue(provider.isChildDocument(folder, notes))
    }

    /*
     * Route 2 leaves the family out while the server still serves it (a list caught between two states): its root stays,
     * read only, and an edit open in it reaches the queue; only the server's not-member takes the root. Fails if a family
     * merely unlisted loses its root, and with it the edit.
     */
    @Test
    fun aFamilyRouteTwoLeavesOutKeepsItsRootUntilTheRemovalIsConfirmed() {
        var now = 0L
        val vault = Vault(app, DriveApi(Shared.session(app)!!))
        val families = ProviderFamilies(vault, FamilySync(vault, sweeps = false, tellsFiles = false)) { now }
        families.load()
        val doc = FamilyDoc.Node(family.groupId, family.workspaceId, family.fileId)
        families.children(FamilyDoc.Node(family.groupId, family.workspaceId, family.rootId))
        val edit = families.editFor(doc, "w").apply { writeText("kept while unlisted") }
        family.listed = false
        now += 6 * 60_000L
        families.load()
        assertFalse(families.roots.single().folders.single().writable)
        val job = writeBack(families, doc, edit)
        assertEquals("kept while unlisted", WriteBacks.contentOf(app, job).readText())
        family.notMember = true
        now += 60_000L
        assertEquals(emptyList<FamilyRoot>(), families.load())
    }

    /*
     * A root that stops taking new items (kept read only on no answer) is told to Files, as is one that takes them again:
     * DocumentsUI keeps each root's flags until told. Fails if only a change of title tells it.
     */
    @Test
    fun aRootsCreateCapabilityChangingTellsFiles() {
        var now = 0L
        val vault = Vault(app, DriveApi(Shared.session(app)!!))
        val families = ProviderFamilies(vault, FamilySync(vault, sweeps = false, tellsFiles = false)) { now }
        families.load()
        var told = rootsTold()
        server.beforeAnswer = { _, path -> if (path.startsWith("groups/") && path.endsWith("/rosters")) throw IllegalStateException("dropped") }
        now += 6 * 60_000L
        assertFalse(families.load().single().folders.single().writable)
        assertEquals(told + 1, rootsTold())
        told = rootsTold()
        server.beforeAnswer = null
        now += 60_000L
        assertTrue(families.load().single().folders.single().writable)
        assertEquals(told + 1, rootsTold())
    }

    /*
     * An editor saves twice before the job runs, the job's first run getting no answer: the slot holds only the second,
     * the next run sends it and lands it, and the first is never sent. Fails if a save is sent other than from the slot,
     * or an older save is sent at all once a newer one is kept.
     */
    @Test
    fun twoSavesOfAFamilyFileLeaveOnlyTheNewestToSend() {
        val provider = provider()
        rows(provider.queryChildDocuments(folder, null, null as String?), Document.COLUMN_DOCUMENT_ID)
        val families = familiesOf(provider)
        val doc = FamilyDoc.of(file) as FamilyDoc.Node
        writeBack(families, doc, families.editFor(doc, "w").apply { writeText("first save") })
        val slot = writeBack(families, doc, families.editFor(doc, "w").apply { writeText("second save") })
        server.beforeAnswer = { method, path -> if (method == "POST" && path == "drive/uploads") throw IllegalStateException("dropped") }
        assertEquals(ListenableWorker.Result.retry(), runJob(slot))
        server.beforeAnswer = null
        val sent = begins()
        assertEquals(ListenableWorker.Result.success(), runJob(slot))
        assertEquals("the first save was sent too", sent + 1, begins())
        assertNull(WriteBacks.pending(app, slot))
        families.children(FamilyDoc.Node(family.groupId, family.workspaceId, family.rootId))
        assertEquals("second save", families.readCopy(doc).readText())
    }

    /*
     * The first save is cancelled from the transfers panel (its slot dropped); the next save gets its own job and fails
     * for good; a later save still lands; the failed row's Retry then sends what the slot holds (nothing: it landed), so
     * nothing older lands over it. Fails if a cancelled or failed save keeps a later one from landing, or a Retry sends an
     * older save.
     */
    @Test
    fun aCancelledOrFailedFamilySaveNeverStopsTheNextAndItsRetryNeverLandsOverIt() {
        val provider = provider()
        rows(provider.queryChildDocuments(folder, null, null as String?), Document.COLUMN_DOCUMENT_ID)
        val families = familiesOf(provider)
        val doc = FamilyDoc.of(file) as FamilyDoc.Node
        val slot = writeBack(families, doc, families.editFor(doc, "w").apply { writeText("cancelled save") })
        TransferQueue.cancel(app, jobs(slot).single().id, WriteBacks.contentOf(app, slot).path)
        assertNull(WriteBacks.pending(app, slot))
        writeBack(families, doc, families.editFor(doc, "w").apply { writeText("failed save") })
        val inner = server.extraRoutes!!
        server.extraRoutes = { method, segments, query, body ->
            if (method == "POST" && segments == listOf("drive", "uploads")) 400 to org.json.JSONObject().put("message", "Refused.") else inner(method, segments, query, body)
        }
        assertEquals(ListenableWorker.Result.failure()::class, runJob(slot)::class)
        server.extraRoutes = inner
        val row = com.hushos.app.data.FailedTransfers.of(app).all().single()
        assertEquals(slot, row.slot)
        writeBack(families, doc, families.editFor(doc, "w").apply { writeText("last save") })
        assertEquals(ListenableWorker.Result.success(), runJob(slot))
        val sent = begins()
        if (TransferQueue.retry(app, row)) assertEquals(ListenableWorker.Result.success(), runJob(slot))
        assertEquals(sent, begins())
        families.children(FamilyDoc.Node(family.groupId, family.workspaceId, family.rootId))
        assertEquals("the retried older save landed over the newer one", "last save", families.readCopy(doc).readText())
    }

    /*
     * Two closes back to back through the provider's real close callback: each save is kept in the callback itself, so
     * the slot holds the second, and one job sends only it. Fails if a save is kept anywhere but its close callback, or
     * out of the order the app closed them in.
     */
    @Test
    fun twoClosesOfAFamilyFileBackToBackLandInTheirOrder() {
        val provider = provider()
        rows(provider.queryChildDocuments(folder, null, null as String?), Document.COLUMN_DOCUMENT_ID)
        val families = familiesOf(provider)
        for (text in listOf("first save", "second save")) {
            ParcelFileDescriptor.AutoCloseOutputStream(provider.openDocument(file, "w", null)).use { it.write(text.toByteArray()) }
            org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle()
        }
        assertEquals("second save", WriteBacks.contentOf(app, slot).readText())
        val sent = begins()
        assertEquals(ListenableWorker.Result.success(), runJob(slot))
        assertEquals(sent + 1, begins())
        families.children(FamilyDoc.Node(family.groupId, family.workspaceId, family.rootId))
        assertEquals("second save", families.readCopy(FamilyDoc.of(file) as FamilyDoc.Node).readText())
    }

    /*
     * An editor holds the file open while another member's device moves it into a folder of its own, and a poll's listing
     * forgets it where it was: the close keeps the save (it looks nothing up), and the job finds the file where it is now
     * (the feed) and lands it there. Closed again while nothing answers, the save is still kept. Fails if a close that
     * can't find the file in the cache drops the only edited copy, or the job looks for it only where it was.
     */
    @Test
    fun aSaveOfAFileMovedAndForgottenWhileOpenIsKept() {
        val provider = provider()
        rows(provider.queryChildDocuments(folder, null, null as String?), Document.COLUMN_DOCUMENT_ID)
        val families = familiesOf(provider)
        val pfd = provider.openDocument(file, "w", null)
        val other = family.phone()
        assertTrue(other.sync.sync(family.summary) is FamilyState.Accepted)
        other.vault.listChildren(family.rootId, family.workspaceId)
        val trips = other.vault.createFolder(family.rootId, "Trips")
        other.vault.move(family.fileId, trips.id)
        assertTrue(provider.pollOnce())
        assertNull("the poll kept the moved file where it was", families.vault.item(family.workspaceId, family.fileId)?.takeIf { it.node.parentId == family.rootId })
        ParcelFileDescriptor.AutoCloseOutputStream(pfd).use { it.write("saved after the move".toByteArray()) }
        org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle()
        assertEquals(ListenableWorker.Result.success(), runJob(slot))
        val out = File(app.cacheDir, "read-${System.nanoTime()}")
        other.vault.listChildren(trips.id, family.workspaceId)
        other.vault.download(family.fileId, out, workspaceId = family.workspaceId)
        assertEquals("saved after the move", out.readText())
        // Moved and forgotten again, and nothing answers: the save is kept all the same.
        val again = provider.openDocument(file, "w", null)
        families.vault.forget(family.workspaceId, family.fileId)
        families.vault.parents.remove(family.fileId)
        server.beforeAnswer = { _, path -> if (path.endsWith("/children") || path.endsWith("/changes")) throw IllegalStateException("dropped") }
        ParcelFileDescriptor.AutoCloseOutputStream(again).use { it.write("saved offline".toByteArray()) }
        org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle()
        server.beforeAnswer = null
        assertEquals("saved offline", WriteBacks.contentOf(app, slot).readText())
    }

    /*
     * The file sits in a folder; another member moves it to a second folder and puts the first in the trash before the
     * save's job runs: the job finds the file by its node where it is now and lands the save there. Fails if the job
     * lists, or looks for the file through, the folder it was queued from.
     */
    @Test
    fun aSaveOfAFileWhoseFolderWentToTheTrashLandsWhereTheFileIsNow() {
        val provider = provider()
        val other = family.phone()
        assertTrue(other.sync.sync(family.summary) is FamilyState.Accepted)
        other.vault.listChildren(family.rootId, family.workspaceId)
        val first = other.vault.createFolder(family.rootId, "First")
        other.vault.move(family.fileId, first.id)
        val inFirst = FamilyDoc.Node(family.groupId, family.workspaceId, first.id).id
        rows(provider.queryChildDocuments(folder, null, null as String?), Document.COLUMN_DOCUMENT_ID)
        rows(provider.queryChildDocuments(inFirst, null, null as String?), Document.COLUMN_DOCUMENT_ID)
        val families = familiesOf(provider)
        val doc = FamilyDoc.of(file) as FamilyDoc.Node
        assertEquals(first.id, families.vault.item(family.workspaceId, family.fileId)!!.node.parentId)
        writeBack(families, doc, families.editFor(doc, "w").apply { writeText("saved before the move") })
        val second = other.vault.createFolder(family.rootId, "Second")
        other.vault.listChildren(first.id, family.workspaceId)
        other.vault.move(family.fileId, second.id)
        server.trash(first.id)
        assertEquals(ListenableWorker.Result.success(), runJob(slot))
        val out = File(app.cacheDir, "read-${System.nanoTime()}")
        other.vault.listChildren(second.id, family.workspaceId)
        other.vault.download(family.fileId, out, workspaceId = family.workspaceId)
        assertEquals("saved before the move", out.readText())
    }

    /*
     * An editor saves, then opens the file again to append before the save's job ran: the append starts from that save,
     * not from the server's older version, and the version left holds both edits. Fails if a contents-keeping edit is
     * seeded from the server while a save of the file is pending.
     */
    @Test
    fun anAppendBeforeAQueuedFamilySaveLandsBuildsOnTheSave() {
        val provider = provider()
        rows(provider.queryChildDocuments(folder, null, null as String?), Document.COLUMN_DOCUMENT_ID)
        val families = familiesOf(provider)
        val doc = FamilyDoc.of(file) as FamilyDoc.Node
        writeBack(families, doc, families.editFor(doc, "w").apply { writeText("first save") })
        val append = families.editFor(doc, "wa")
        assertEquals("first save", append.readText())
        writeAs("wa", append, " then more")
        val slot = writeBack(families, doc, append)
        assertEquals(ListenableWorker.Result.success(), runJob(slot))
        families.children(FamilyDoc.Node(family.groupId, family.workspaceId, family.rootId))
        assertEquals("first save then more", families.readCopy(doc).readText())
    }

    /*
     * While a family file's save is pending (its job waiting, then failed for good and pruned from WorkManager), an app
     * opening it to read (`r`) or to read and write gets that save, never the server's older version. Fails if any open
     * reads past the pending save, or a failed one stops counting once WorkManager forgets its job.
     */
    @Test
    fun everyOpenOfAFamilyFileReadsItsPendingSave() {
        val provider = provider()
        rows(provider.queryChildDocuments(folder, null, null as String?), Document.COLUMN_DOCUMENT_ID)
        val families = familiesOf(provider)
        val doc = FamilyDoc.of(file) as FamilyDoc.Node
        writeBack(families, doc, families.editFor(doc, "w").apply { writeText("pending save") })
        assertEquals("pending save", read(provider, file))
        assertEquals("pending save", families.editFor(doc, "rw").readText())
        val inner = server.extraRoutes!!
        server.extraRoutes = { method, segments, query, body ->
            if (method == "POST" && segments == listOf("drive", "uploads")) 400 to org.json.JSONObject().put("message", "Refused.") else inner(method, segments, query, body)
        }
        assertEquals(ListenableWorker.Result.failure()::class, runJob(slot)::class)
        server.extraRoutes = inner
        WorkManager.getInstance(app).pruneWork().result.get()
        assertEquals("pending save", read(provider, file))
        assertEquals("pending save", families.editFor(doc, "rw").readText())
    }

    /*
     * The network drops as a family save's completion lands: its answer, and everything after it in that run, lost. A newer
     * save arrives; the next run settles the lost upload first (found completed), sends only the newer one, and leaves
     * no landed row behind. Fails if an uncertain completion is sent again or an older save lands after a newer one.
     */
    @Test
    fun anUncertainFamilyCompletionIsSettledNeverSentAgain() {
        val provider = provider()
        rows(provider.queryChildDocuments(folder, null, null as String?), Document.COLUMN_DOCUMENT_ID)
        val families = familiesOf(provider)
        val doc = FamilyDoc.of(file) as FamilyDoc.Node
        writeBack(families, doc, families.editFor(doc, "w").apply { writeText("first save") })
        var dropping = false
        server.dropReply = { method, path -> (dropping || (method == "POST" && path.endsWith("/complete"))).also { if (it) dropping = true } }
        assertEquals(ListenableWorker.Result.retry(), runJob(slot))
        server.dropReply = null
        val sent = begins()
        writeBack(families, doc, families.editFor(doc, "w").apply { writeText("second save") })
        assertEquals(ListenableWorker.Result.success(), runJob(slot))
        assertEquals("the first save was sent again", sent + 1, begins())
        assertEquals("second save", serverText())
        assertNull(WriteBacks.pending(app, slot))
        assertTrue(Reservations.all(app).none { WriteBacks.ledgerOf(slot, it.job) })
    }

    /*
     * Another member's device moves the file into a folder of its own: reopening it finds it where it is now (the feed)
     * rather than calling it missing because the folder it was in no longer lists it. Fails if a reopen gives up after
     * relisting the old folder.
     */
    @Test
    fun aFileMovedElsewhereInTheFamilyStillReopens() {
        val provider = provider()
        rows(provider.queryChildDocuments(folder, null, null as String?), Document.COLUMN_DOCUMENT_ID)
        val families = familiesOf(provider)
        val doc = FamilyDoc.of(file) as FamilyDoc.Node
        val other = family.phone()
        assertTrue(other.sync.sync(family.summary) is FamilyState.Accepted)
        other.vault.listChildren(family.rootId, family.workspaceId)
        val trips = other.vault.createFolder(family.rootId, "Trips")
        other.vault.move(family.fileId, trips.id)
        assertEquals("marker-family", families.readCopy(doc).readText())
        assertEquals("marker-family", families.editFor(doc, "rw").readText())
    }

    private fun familiesOf(provider: HushOSDocumentsProvider): ProviderFamilies =
        HushOSDocumentsProvider::class.java.getDeclaredField("families").apply { isAccessible = true }.get(provider) as ProviderFamilies
}
