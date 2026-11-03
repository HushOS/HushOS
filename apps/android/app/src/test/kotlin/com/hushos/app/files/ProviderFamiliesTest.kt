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
import com.hushos.app.data.forgetFamilyCopies
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
        WriteBacks.afterContent = null
        WriteBacks.beforeSlotId = null
        WriteBacks.fault = null
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
                          opened: com.hushos.app.data.Opened = families.vault.item(doc.workspaceId, doc.nodeId)!!, epoch: Long = families.epochOf(doc)): String {
        assertTrue("the save wasn't kept", families.save(doc, edit, opened, epoch))
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
        // The job as it was queued: naming the save the slot held then, however many replaced it since.
        val job = queued.firstOrNull { it.state == androidx.work.WorkInfo.State.ENQUEUED } ?: queued.last()
        val file = File(job.tags.first { it.startsWith("file:") }.removePrefix("file:"))
        assertEquals(TransferQueue.slotRequest(job.id, slot, file, family.groupId.lowercase(), session).tags, job.tags)
        val id = if (job.state == androidx.work.WorkInfo.State.ENQUEUED) job.id else UUID.randomUUID()
        val request = TransferQueue.slotRequest(id, slot, file, family.groupId.lowercase(), session)
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
     * Removed by the server while only the Files app looked, with a family file's save failed for good (its row kept for
     * Retry) and another left without a job: the provider's load that confirms the removal ends the family's transfers,
     * as the app's sync does. No save's plaintext is left in the queue, and the row says why, with nothing to retry.
     * Fails if a confirmed removal leaves a pending save's contents or a Retry behind.
     */
    @Test
    fun aRemovalTheProviderConfirmsEndsTheFamilysSaves() {
        var now = 0L
        val vault = Vault(app, DriveApi(Shared.session(app)!!))
        val families = ProviderFamilies(vault, FamilySync(vault, sweeps = false, tellsFiles = false)) { now }
        families.load()
        val doc = FamilyDoc.Node(family.groupId, family.workspaceId, family.fileId)
        families.children(FamilyDoc.Node(family.groupId, family.workspaceId, family.rootId))
        val slot = writeBack(families, doc, families.editFor(doc, "w").apply { writeText("failed save") })
        val inner = server.extraRoutes!!
        server.extraRoutes = { method, segments, query, body ->
            if (method == "POST" && segments == listOf("drive", "uploads")) 400 to org.json.JSONObject().put("message", "Refused.") else inner(method, segments, query, body)
        }
        assertEquals(ListenableWorker.Result.failure()::class, runJob(slot)::class)
        server.extraRoutes = inner
        val stray = WriteBacks.save(app, Reservations.generation, WriteBacks.Target(family.workspaceId, UUID.randomUUID().toString(), "Other.txt", "text/plain",
            family.rootId, family.groupId.lowercase(), family.workspaceId.lowercase()), File(app.cacheDir, "stray").apply { writeText("left without a job") })!!.slot
        family.notMember = true
        family.listed = false
        now += 6 * 60_000L
        assertEquals(emptyList<FamilyRoot>(), families.load())
        assertFalse("a failed save's plaintext outlived the removal", WriteBacks.dir(app, slot).exists())
        assertFalse("a save without a job outlived the removal", WriteBacks.dir(app, stray).exists())
        val rows = com.hushos.app.data.FailedTransfers.of(app).all()
        assertTrue(rows.isNotEmpty() && rows.all { it.reason == com.hushos.app.data.FamilyWords.NOT_IN_FAMILY && it.sourceGone() })
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
     * Left elsewhere after Files opened the file and before it wrote it back: the close keeps nothing (the folder's
     * invalidation count moved since the open read it), so no plaintext reaches the queue and nothing is sent. Fails if a
     * save is kept for a family let go of after its open, on the strength of roots or rows loaded before the leave.
     */
    @Test
    fun aWriteBackAfterTheFamilyWentElsewhereKeepsNothing() {
        val provider = provider()
        rows(provider.queryChildDocuments(folder, null, null as String?), Document.COLUMN_DOCUMENT_ID)
        val families = familiesOf(provider)
        val doc = FamilyDoc.of(file) as FamilyDoc.Node
        val opened = families.vault.item(doc.workspaceId, doc.nodeId)!!
        val epoch = families.epochOf(doc)
        val edit = families.editCopy(doc, keepContents = false, epoch).apply { writeText("not sent") }
        val phone = family.phone()
        assertTrue(phone.sync.sync(family.summary) is FamilyState.Accepted)
        assertEquals(listOf("family:${family.groupId}"), familyRoots(provider))
        assertTrue(phone.sync.leave(family.groupId) is FamilySync.Leaving.Left)
        // The leave deleted the family's copies, the edit among them; as if this one had outlived it, so only the
        // provider's own check of the family stands between it and the server.
        edit.parentFile!!.mkdirs()
        edit.writeText("not sent")
        val sent = server.requests.size
        assertFalse(families.save(doc, edit, opened, epoch))
        assertFalse("a save of a family let go of reached the queue", WriteBacks.dir(app, slot).exists())
        assertTrue(jobs(slot).isEmpty())
        assertEquals(emptyList<String>(), driveWritesSince(sent))
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
        TransferQueue.cancel(app, jobs(slot).single().id, WriteBacks.contentOf(app, slot).path).get()
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
            org.robolectric.Shadows.shadowOf(WriteBacks.closes.looper).idle()
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
        org.robolectric.Shadows.shadowOf(WriteBacks.closes.looper).idle()
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
        org.robolectric.Shadows.shadowOf(WriteBacks.closes.looper).idle()
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

    /*
     * The folder this phone last saw a family file in went to the trash after another member moved the file out of it:
     * an edit that keeps the contents, a read and a tree check all find the file where the feed puts it now. Fails if a
     * folder the server says is gone or in the trash is taken for no answer (the edit refused, the tree check failing).
     */
    @Test
    fun aFileWhoseFolderWentToTheTrashIsFoundWhereItIsNow() {
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
        val second = other.vault.createFolder(family.rootId, "Second")
        other.vault.listChildren(first.id, family.workspaceId)
        other.vault.move(family.fileId, second.id)
        server.trash(first.id)
        assertEquals("marker-family", families.editFor(doc, "rw").readText())
        assertEquals(second.id, families.vault.item(family.workspaceId, family.fileId)!!.node.parentId)
        families.vault.forget(family.workspaceId, family.fileId)
        families.vault.parents[family.fileId] = first.id
        assertTrue(provider.isChildDocument(folder, file))
        assertEquals("marker-family", read(provider, file))
    }

    /*
     * A family file's earlier save's job finished (WorkManager still lists it), and a new save landed in the slot without
     * its job (the process died first): the next sweep queues one, since a finished job owns nothing, and it lands. Fails
     * if a finished job's folder counts as owning the slot.
     */
    @Test
    fun aFamilySaveWhoseOnlyJobHadFinishedGetsOneAtTheNextSweep() {
        val provider = provider()
        rows(provider.queryChildDocuments(folder, null, null as String?), Document.COLUMN_DOCUMENT_ID)
        val families = familiesOf(provider)
        val doc = FamilyDoc.of(file) as FamilyDoc.Node
        writeBack(families, doc, families.editFor(doc, "w").apply { writeText("first save") })
        val finished = jobs(slot).single()
        WorkManager.getInstance(app).cancelWorkById(finished.id).result.get()
        WriteBacks.save(app, Reservations.generation, WriteBacks.pending(app, slot)!!.target, File(app.cacheDir, "unqueued").apply { writeText("second save") })
        TransferQueue.sweep(app, WorkManager.getInstance(app).getWorkInfosByTag(TransferQueue.TAG).get())
        assertEquals(androidx.work.WorkInfo.State.ENQUEUED, jobs(slot).single { it.id != finished.id }.state)
        assertEquals(ListenableWorker.Result.success(), runJob(slot))
        families.children(FamilyDoc.Node(family.groupId, family.workspaceId, family.rootId))
        assertEquals("second save", families.readCopy(doc).readText())
    }

    /*
     * A family save's completion answer is lost, and the next run can't settle it (its abort unanswered): the newer save
     * waits rather than starting while the earlier one could still land under it, then goes once it settles. Fails if a
     * save starts while an earlier save of the file has a reservation unsettled.
     */
    @Test
    fun aNewerFamilySaveWaitsWhileAnEarlierOnesReservationIsUnsettled() {
        val provider = provider()
        rows(provider.queryChildDocuments(folder, null, null as String?), Document.COLUMN_DOCUMENT_ID)
        val families = familiesOf(provider)
        val doc = FamilyDoc.of(file) as FamilyDoc.Node
        writeBack(families, doc, families.editFor(doc, "w").apply { writeText("first save") })
        var dropping = false
        server.dropReply = { method, path -> (dropping || (method == "POST" && path.endsWith("/complete"))).also { if (it) dropping = true } }
        assertEquals(ListenableWorker.Result.retry(), runJob(slot))
        writeBack(families, doc, families.editFor(doc, "w").apply { writeText("second save") })
        server.dropReply = { _, path -> path.endsWith("/abort") }
        val sent = begins()
        assertEquals(ListenableWorker.Result.retry(), runJob(slot))
        assertEquals("a newer save started over an unsettled one", sent, begins())
        server.dropReply = null
        assertEquals(ListenableWorker.Result.success(), runJob(slot))
        assertEquals("second save", serverText())
    }

    /* Every answer from a family save's completion on lost (its upload landed on the server, nothing here heard). */
    private fun dropFromTheCompletion() {
        var dropping = false
        server.dropReply = { method, path -> (dropping || (method == "POST" && path.endsWith("/complete"))).also { if (it) dropping = true } }
    }

    /*
     * The account was removed from the family while an earlier save's reservation is still unsettled (its completion
     * answer lost), and the abort is answered as the server answers once the account can't reach the folder (403: settled
     * only after its expiry). The save's job asks about the family before waiting on that reservation: it ends the
     * family's uploads now, its plaintext and Retry with them, rather than retrying for a day. Fails if a removed family's
     * pending save waits out an unsettled reservation.
     */
    @Test
    fun aRemovedFamilysSaveEndsEvenWhileAnEarlierReservationIsUnsettled() {
        val provider = provider()
        rows(provider.queryChildDocuments(folder, null, null as String?), Document.COLUMN_DOCUMENT_ID)
        val families = familiesOf(provider)
        val doc = FamilyDoc.of(file) as FamilyDoc.Node
        writeBack(families, doc, families.editFor(doc, "w").apply { writeText("first save") })
        dropFromTheCompletion()
        assertEquals(ListenableWorker.Result.retry(), runJob(slot))
        server.dropReply = null
        writeBack(families, doc, families.editFor(doc, "w").apply { writeText("second save") })
        family.notMember = true
        family.listed = false
        val inner = server.extraRoutes!!
        server.extraRoutes = { method, segments, query, body ->
            if (method == "POST" && segments.size == 4 && segments[1] == "uploads" && segments[3] == "abort") 403 to org.json.JSONObject().put("message", "Not a member.")
            else inner(method, segments, query, body)
        }
        assertEquals(ListenableWorker.Result.failure()::class, runJob(slot)::class)
        server.extraRoutes = inner
        assertFalse("a removed family's save outlived it", WriteBacks.dir(app, slot).exists())
        assertTrue(com.hushos.app.data.FailedTransfers.of(app).all().all { it.reason == com.hushos.app.data.FamilyWords.NOT_IN_FAMILY && it.sourceGone() })
    }

    /*
     * A family save's completion landed with its answer lost (its reservation still on the ledger under the save's own
     * key), then the provider confirms the family's removal: the cleanup settles that key, finds the save landed, and
     * says it uploaded, with no reservation left. Fails if the cleanup settles the job's id instead of the slot's keys
     * (the reservation stays, and a landed save reads as not sent).
     */
    @Test
    fun aRemovalSettlesTheSlotsOwnReservations() {
        var now = 0L
        val vault = Vault(app, DriveApi(Shared.session(app)!!))
        val families = ProviderFamilies(vault, FamilySync(vault, sweeps = false, tellsFiles = false)) { now }
        families.load()
        val doc = FamilyDoc.Node(family.groupId, family.workspaceId, family.fileId)
        families.children(FamilyDoc.Node(family.groupId, family.workspaceId, family.rootId))
        writeBack(families, doc, families.editFor(doc, "w").apply { writeText("landed save") })
        dropFromTheCompletion()
        assertEquals(ListenableWorker.Result.retry(), runJob(slot))
        server.dropReply = null
        assertTrue(Reservations.all(app).any { WriteBacks.ledgerOf(slot, it.job) && !it.landed })
        family.notMember = true
        family.listed = false
        now += 6 * 60_000L
        assertEquals(emptyList<FamilyRoot>(), families.load())
        assertTrue("the slot's reservation was left", Reservations.all(app).none { WriteBacks.ledgerOf(slot, it.job) })
        assertTrue("a landed save reads as not sent", com.hushos.app.data.FailedTransfers.of(app).all().isEmpty())
        assertFalse(WriteBacks.dir(app, slot).exists())
    }

    /*
     * A read of a family file with a pending save: another vault lets the family go after the read checked the folder and
     * before it copies the save. The read gets nothing and no plaintext copy is made. Fails if the copy is made on the
     * strength of the check before (the cleanup has already run, and the copy would outlive the family).
     */
    @Test
    fun aPendingReadTheFamilyLetGoOfMeanwhileCopiesNothing() {
        val provider = provider()
        rows(provider.queryChildDocuments(folder, null, null as String?), Document.COLUMN_DOCUMENT_ID)
        val families = familiesOf(provider)
        val doc = FamilyDoc.of(file) as FamilyDoc.Node
        writeBack(families, doc, families.editFor(doc, "w").apply { writeText("pending save") })
        val phone = family.phone()
        assertTrue(phone.sync.sync(family.summary) is FamilyState.Accepted)
        families.afterAccessChecked = {
            families.afterAccessChecked = null
            assertTrue(phone.sync.leave(family.groupId) is FamilySync.Leaving.Left)
        }
        assertThrows(FileNotFoundException::class.java) { read(provider, file) }
        val copies = FamilyCopies.folder(app.cacheDir, family.workspaceId)
        assertTrue("a pending read's plaintext was copied after the family let go", copies == null || !File(copies, "pending").walkTopDown().any { it.isFile })
    }

    /*
     * Cancelling a family file's save while the other app saves it again (the new save holding the slot's lock, not yet
     * published): the cancelled save goes, the save made after the cancel was pressed stays, gets a job of its own and
     * lands. Fails if a cancel's cleanup deletes whatever the slot holds when it runs.
     */
    @Test
    fun aFamilySaveMadeAfterACancelSurvivesIt() {
        val provider = provider()
        rows(provider.queryChildDocuments(folder, null, null as String?), Document.COLUMN_DOCUMENT_ID)
        val families = familiesOf(provider)
        val doc = FamilyDoc.of(file) as FamilyDoc.Node
        writeBack(families, doc, families.editFor(doc, "w").apply { writeText("cancelled save") })
        val job = jobs(slot).single()
        val target = WriteBacks.pending(app, slot)!!.target
        val holding = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1)
        WriteBacks.afterContent = { WriteBacks.afterContent = null; holding.countDown(); release.await(2, java.util.concurrent.TimeUnit.SECONDS) }
        val saving = Thread { WriteBacks.save(app, Reservations.generation, target, File(app.cacheDir, "after").apply { writeText("save after the cancel") }) }.apply { start() }
        assertTrue(holding.await(5, java.util.concurrent.TimeUnit.SECONDS))
        val cleanup = TransferQueue.cancel(app, job.id, job.tags.first { it.startsWith("file:") }.removePrefix("file:"))
        release.countDown()
        saving.join(5_000)
        cleanup.get(5, java.util.concurrent.TimeUnit.SECONDS)
        assertEquals("save after the cancel", WriteBacks.contentOf(app, slot).readText())
        assertEquals(ListenableWorker.Result.success(), runJob(slot))
        assertEquals("save after the cancel", serverText())
    }

    /*
     * A family's cleanup settling a slot's reservation blocks on its abort while the account signs out and the next one
     * saves the same family file (the same slot): the cleanup, finishing for the account that left, deletes nothing of
     * the next account's. Fails if a slot is dropped without checking the account it began for is still the one here.
     */
    @Test
    fun aFamilyCleanupNeverDropsTheNextAccountsSave() {
        val provider = provider()
        rows(provider.queryChildDocuments(folder, null, null as String?), Document.COLUMN_DOCUMENT_ID)
        val families = familiesOf(provider)
        val doc = FamilyDoc.of(file) as FamilyDoc.Node
        writeBack(families, doc, families.editFor(doc, "w").apply { writeText("first account's save") })
        val target = WriteBacks.pending(app, slot)!!.target
        // A reservation a dead run of the slot left (no upload of this process holds it).
        val leftover = UUID.randomUUID().toString()
        Reservations.reserved(app, leftover, family.workspaceId, "$slot#leftover", System.currentTimeMillis(), null)
        Reservations.idle(leftover)
        val began = Reservations.generation
        TransferQueue.dropSlot(app, slot, null, { body -> Reservations.whileAccount(began) { body() } }) { _, _ ->
            // The abort blocks across a sign-out; the next account saves the same file.
            com.hushos.app.data.AccountStore.of(app).wipe()
            WriteBacks.save(app, Reservations.generation, target, File(app.cacheDir, "next").apply { writeText("next account's save") })
            Reservations.Abort.PENDING
        }
        assertEquals("next account's save", WriteBacks.contentOf(app, slot).readText())
    }

    /*
     * A family file with a save waiting is listed with that save's size and date, the bytes a read returns. Fails if a
     * family listing describes the server's version while reads return the pending save.
     */
    @Test
    fun aFamilyListingShowsThePendingSavesSize() {
        val provider = provider()
        rows(provider.queryChildDocuments(folder, null, null as String?), Document.COLUMN_DOCUMENT_ID)
        val families = familiesOf(provider)
        val doc = FamilyDoc.of(file) as FamilyDoc.Node
        val text = "a pending family save, longer than the marker"
        writeBack(families, doc, families.editFor(doc, "w").apply { writeText(text) })
        val kept = File(WriteBacks.dir(app, slot), WriteBacks.pending(app, slot)!!.id + ".bin")
        provider.queryChildDocuments(folder, null, null as String?).use { cursor ->
            val id = cursor.getColumnIndexOrThrow(Document.COLUMN_DOCUMENT_ID)
            var found = false
            while (cursor.moveToNext()) if (cursor.getString(id) == file) {
                found = true
                assertEquals(text.length.toLong(), cursor.getLong(cursor.getColumnIndexOrThrow(Document.COLUMN_SIZE)))
                assertEquals(kept.lastModified(), cursor.getLong(cursor.getColumnIndexOrThrow(Document.COLUMN_LAST_MODIFIED)))
            }
            assertTrue(found)
        }
    }

    /*
     * Files refreshes a family's own listing (its folders) after the family changed on the server (here: this account was
     * removed): the refresh loads the families again, so the listing after it isn't the one loaded minutes before. Fails
     * if a family's listing answers from roots loaded before the refresh until they expire.
     */
    @Test
    fun aRefreshOfAFamilysListingLoadsItAgain() {
        val provider = provider()
        assertEquals(listOf(family.rootId), rows(provider.queryChildDocuments(top, null, null as String?), Document.COLUMN_DOCUMENT_ID)
            .map { (FamilyDoc.of(it!!) as FamilyDoc.Node).nodeId })
        family.notMember = true
        family.listed = false
        provider.refresh(DocumentsContract.buildChildDocumentsUri(authority, top), null, null)
        assertThrows(FileNotFoundException::class.java) { provider.queryChildDocuments(top, null, null as String?).close() }
    }

    /*
     * Another app opens a family file to read and write (keeping its contents) while a save of it is pending, and another
     * vault lets the family go after the open checked the folder's access: no edit is made, so the pending save's plaintext
     * is never copied back into the family's edits after their cleanup. Fails if the edit's invalidation count is read
     * after the access check (it then reads the count after the removal and accepts it).
     */
    @Test
    fun anEditTheFamilyLetGoOfMeanwhileCopiesNothing() {
        val provider = provider()
        rows(provider.queryChildDocuments(folder, null, null as String?), Document.COLUMN_DOCUMENT_ID)
        val families = familiesOf(provider)
        val doc = FamilyDoc.of(file) as FamilyDoc.Node
        writeBack(families, doc, families.editFor(doc, "w").apply { writeText("pending save") })
        // A cleanup of the family's copies (a refusal's or a removal's) lands just after the access check; the slot it
        // leaves for the family's transfers to end.
        families.afterAccessChecked = {
            families.afterAccessChecked = null
            families.vault.forgetFamilyCopies(listOf(family.workspaceId))
        }
        assertThrows(FileNotFoundException::class.java) { provider.openDocument(file, "rw", null).close() }
        val edits = FamilyCopies.edits(app.cacheDir, family.workspaceId)
        assertTrue("a pending save's plaintext was copied into the edits after the family let go", edits == null || !edits.walkTopDown().any { it.isFile })
    }

    /*
     * A read of a family file (no save pending) whose copies are cleaned (a refusal's or a removal's cleanup) after the read
     * checked the folder: nothing is downloaded into the family's copies. Fails if the download's invalidation count is
     * read after the check.
     */
    @Test
    fun aReadTheFamilyLetGoOfMeanwhileKeepsNoCopy() {
        val provider = provider()
        rows(provider.queryChildDocuments(folder, null, null as String?), Document.COLUMN_DOCUMENT_ID)
        val families = familiesOf(provider)
        // A cleanup of the family's copies (a refusal's or a removal's) lands just after the access check; the slot it
        // leaves for the family's transfers to end.
        families.afterAccessChecked = {
            families.afterAccessChecked = null
            families.vault.forgetFamilyCopies(listOf(family.workspaceId))
        }
        assertTrue(runCatching { families.readCopy(FamilyDoc.of(file) as FamilyDoc.Node) }.isFailure)
        val copies = FamilyCopies.folder(app.cacheDir, family.workspaceId)
        assertTrue("a read's plaintext was kept after the family let go", copies == null || !copies.walkTopDown().any { it.isFile })
    }

    /*
     * A family file's save kept tells Files its folder changed (its listing now shows the save's size and date). Fails if
     * a save changes what a family listing shows without telling the observers.
     */
    @Test
    fun aFamilySaveTellsFilesItsFolderChanged() {
        val provider = provider()
        rows(provider.queryChildDocuments(folder, null, null as String?), Document.COLUMN_DOCUMENT_ID)
        val families = familiesOf(provider)
        val doc = FamilyDoc.of(file) as FamilyDoc.Node
        val edit = families.editFor(doc, "w").apply { writeText("pending save") }
        // The URI Files' listing of the folder watches, as the provider registered it.
        val watched = provider.queryChildDocuments(folder, null, null as String?).use { it.notificationUri }
        shadowOf(app.contentResolver).notifiedUris.clear()
        writeBack(families, doc, edit)
        assertTrue(shadowOf(app.contentResolver).notifiedUris.any { it.uri == watched })
    }

    /*
     * A family folder Files is showing, and a save of one of its files kept without telling it (as a save another vault
     * kept would be): the next poll sees the listing changed (the pending save's size and date) and tells Files at the URI
     * its listing watches. Fails if the poll compares only the server's rows.
     */
    @Test
    fun aPollTellsFilesOfAPendingSave() {
        val provider = provider()
        val watched = provider.queryChildDocuments(folder, null, null as String?).use { it.notificationUri }
        val families = familiesOf(provider)
        val doc = FamilyDoc.of(file) as FamilyDoc.Node
        val opened = families.vault.item(doc.workspaceId, doc.nodeId)!!
        WriteBacks.save(app, Reservations.generation, WriteBacks.Target(opened.node.workspaceId, opened.id, opened.name, opened.metadata.mime,
            opened.node.parentId!!, family.groupId.lowercase(), family.workspaceId.lowercase()), File(app.cacheDir, "kept").apply { writeText("kept elsewhere") })
        shadowOf(app.contentResolver).notifiedUris.clear()
        assertTrue(provider.pollOnce())
        assertTrue("the poll didn't see the pending save", shadowOf(app.contentResolver).notifiedUris.any { it.uri == watched })
    }

    /*
     * Another app has a family file open to read and write when HushOS starts: the app's first family sync sweeps the
     * family's read copies (nothing accepted yet in this process), which revokes nothing. The editor's save is kept and
     * sent. Fails if a cache sweep counts as letting the folder go (the save is then refused and the edit deleted).
     */
    @Test
    fun anEditOpenAcrossTheAppsFirstSweepIsKeptAndSent() {
        val provider = provider()
        rows(provider.queryChildDocuments(folder, null, null as String?), Document.COLUMN_DOCUMENT_ID)
        assertEquals("marker-family", read(provider, file))
        val copies = FamilyCopies.folder(app.cacheDir, family.workspaceId)!!
        assertTrue(copies.walkTopDown().any { it.isFile })
        val pfd = provider.openDocument(file, "rw", null)
        // HushOS starts: its own vault and family sync, whose first act is the allowlist sweep.
        FamilySync(Vault(app, DriveApi(Shared.session(app)!!)))
        assertFalse("the app's first sweep didn't run", copies.walkTopDown().any { it.isFile })
        ParcelFileDescriptor.AutoCloseOutputStream(pfd).use { it.write("edited across the start".toByteArray()) }
        org.robolectric.Shadows.shadowOf(WriteBacks.closes.looper).idle()
        assertTrue("the save was refused", WriteBacks.pending(app, slot) != null)
        assertEquals(ListenableWorker.Result.success(), runJob(slot))
        assertEquals("edited across the start" + "marker-family".drop("edited across the start".length), serverText())
    }

    /*
     * Files refreshes a family's own listing while the server is slow to answer: the refresh gives the binder back within
     * its wait, and tells Files the listing changed once the families were loaded again. Fails if the refresh loads the
     * families on the binder thread (a slow server then holds it past the binder's limit).
     */
    @Test
    fun aFamilyRootRefreshNeverHoldsTheBinder() {
        val provider = provider()
        rows(provider.queryChildDocuments(top, null, null as String?), Document.COLUMN_DOCUMENT_ID)
        val release = java.util.concurrent.CountDownLatch(1)
        server.beforeAnswer = { _, path -> if (path.startsWith("groups")) release.await(15, java.util.concurrent.TimeUnit.SECONDS) }
        val listing = DocumentsContract.buildChildDocumentsUri(authority, top)
        shadowOf(app.contentResolver).notifiedUris.clear()
        val began = System.nanoTime()
        provider.refresh(listing, null, null)
        val tookMs = (System.nanoTime() - began) / 1_000_000
        release.countDown()
        server.beforeAnswer = null
        assertTrue("the refresh held the binder ${tookMs}ms", tookMs < 7_000)
        val until = System.currentTimeMillis() + 15_000
        while (shadowOf(app.contentResolver).notifiedUris.none { it.uri == listing } && System.currentTimeMillis() < until) Thread.sleep(50)
        assertTrue("Files wasn't told once the families loaded", shadowOf(app.contentResolver).notifiedUris.any { it.uri == listing })
    }

    /*
     * A family file read (its version cached here), saved, and the save lands from its job's own vault; then the folder
     * can't be asked. A read fails rather than serve the cached version before the landing, which an editor that reads
     * then saves would write over the landed save; once the folder answers, the landed version is read.
     */
    @Test
    fun aFamilyReadAfterALandingWithNoAnswerNeverServesTheVersionBefore() {
        val provider = provider()
        rows(provider.queryChildDocuments(folder, null, null as String?), Document.COLUMN_DOCUMENT_ID)
        val families = familiesOf(provider)
        val doc = FamilyDoc.of(file) as FamilyDoc.Node
        assertEquals("marker-family", families.readCopy(doc).readText())
        writeBack(families, doc, families.editFor(doc, "w").apply { writeText("landed save") })
        assertEquals(ListenableWorker.Result.success(), runJob(slot))
        server.beforeAnswer = { _, path -> if (path.endsWith("/children") || path.endsWith("/changes")) throw IllegalStateException("dropped") }
        assertTrue("a read served the version before the landing", runCatching { families.readCopy(doc) }.isFailure)
        server.beforeAnswer = null
        assertEquals("landed save", families.readCopy(doc).readText())
        assertNull(WriteBacks.landing(app, slot))
    }

    /*
     * Another vault of the session revokes the family's folder (a refusal or a fork the app found), and the provider's next
     * load gets no answer: the revoked root isn't kept from cache, and a pending save of its file is never copied back into
     * its read copies. Once a load accepts the family again, it is back. Fails if a load that got no answer keeps a root
     * revoked since it was accepted.
     */
    @Test
    fun aRootRevokedElsewhereStaysRevokedWhenTheNextLoadGetsNoAnswer() {
        var now = 0L
        val vault = Vault(app, DriveApi(Shared.session(app)!!))
        val families = ProviderFamilies(vault, FamilySync(vault, sweeps = false, tellsFiles = false)) { now }
        families.load()
        val doc = FamilyDoc.Node(family.groupId, family.workspaceId, family.fileId)
        families.children(FamilyDoc.Node(family.groupId, family.workspaceId, family.rootId))
        writeBack(families, doc, families.editFor(doc, "w").apply { writeText("pending save") })
        Vault(app, DriveApi(Shared.session(app)!!)).forgetFamilyCopies(listOf(family.workspaceId))
        // Before any load, from the roots held: refused at once.
        assertFalse(families.due())
        assertTrue("a root revoked since it was accepted was used", runCatching { families.pendingRead(doc) }.isFailure)
        server.beforeAnswer = { _, path -> if (path.startsWith("groups")) throw IllegalStateException("dropped") }
        now += 6 * 60_000L
        assertEquals("a revoked root was kept", emptyList<FamilyRoot>(), families.load())
        assertTrue(runCatching { families.pendingRead(doc) }.isFailure)
        val copies = FamilyCopies.folder(app.cacheDir, family.workspaceId)
        assertTrue("a pending save's plaintext was copied back", copies == null || !copies.walkTopDown().any { it.isFile })
        server.beforeAnswer = null
        now += 60_000L
        assertEquals(listOf(family.groupId), families.load().map { it.groupId })
        assertEquals("pending save", families.pendingRead(doc)!!.readText())
    }

    /*
     * Another app closes a family file and its save can't be kept in the slot (the disk refuses the slot's first write): its
     * edit stays, with a row whose Retry keeps it and sends it. Fails if a family save that couldn't be kept deletes the edit.
     */
    @Test
    fun aFamilySaveThatCantBeKeptKeepsItsEditAndRetriesIt() {
        val provider = provider()
        rows(provider.queryChildDocuments(folder, null, null as String?), Document.COLUMN_DOCUMENT_ID)
        WriteBacks.beforeSlotId = { WriteBacks.beforeSlotId = null; throw java.io.IOException("No space left on device") }
        ParcelFileDescriptor.AutoCloseOutputStream(provider.openDocument(file, "w", null)).use { it.write("save the disk refused".toByteArray()) }
        org.robolectric.Shadows.shadowOf(WriteBacks.closes.looper).idle()
        assertNull(WriteBacks.pending(app, slot))
        val row = com.hushos.app.data.FailedTransfers.of(app).all().single()
        assertEquals("save the disk refused", File(row.file!!).readText())
        assertTrue(TransferQueue.retry(app, row))
        assertEquals(ListenableWorker.Result.success(), runJob(slot))
        assertEquals("save the disk refused", serverText())
    }

    /*
     * A family save that couldn't be kept left its edit and a retry row; then another vault lets the family's folder go (a
     * refusal or a removal the app found). The row's Retry keeps nothing in the queue: the edit goes and the row says the
     * account isn't in the family any more. Fails if a Retry moves a revoked family's edit into the queue, or leaves its
     * row offering a Retry.
     */
    @Test
    fun aRetryOfAFamilySaveAfterItsFolderWasLetGoOfKeepsNothing() {
        val provider = provider()
        rows(provider.queryChildDocuments(folder, null, null as String?), Document.COLUMN_DOCUMENT_ID)
        WriteBacks.beforeSlotId = { WriteBacks.beforeSlotId = null; throw java.io.IOException("No space left on device") }
        ParcelFileDescriptor.AutoCloseOutputStream(provider.openDocument(file, "w", null)).use { it.write("save the disk refused".toByteArray()) }
        org.robolectric.Shadows.shadowOf(WriteBacks.closes.looper).idle()
        val row = com.hushos.app.data.FailedTransfers.of(app).all().single()
        Vault(app, DriveApi(Shared.session(app)!!)).forgetFamilyCopies(listOf(family.workspaceId))
        // The cleanup deleted the edit; as if this one had outlived it, so only the revocation count stands in the way.
        File(row.file!!).apply { parentFile!!.mkdirs(); writeText("save the disk refused") }
        assertFalse(TransferQueue.retry(app, row))
        assertNull("a revoked family's edit reached the queue", WriteBacks.pending(app, slot))
        assertFalse(File(row.file!!).exists())
        val after = com.hushos.app.data.FailedTransfers.of(app).all().single()
        assertEquals(com.hushos.app.data.FamilyWords.NOT_IN_FAMILY, after.reason)
        assertTrue("the row still offers a Retry", after.sourceGone())
    }

    /*
     * The family's folder was let go of once and accepted again before a save of its file couldn't be kept: that save's
     * Retry keeps it and sends it (the folder hasn't been let go of since the row was made). Fails if a Retry measures a
     * revocation from before its row was made.
     */
    @Test
    fun aRetryOfAFamilySaveMadeAfterAnEarlierRevocationKeepsIt() {
        val provider = provider()
        rows(provider.queryChildDocuments(folder, null, null as String?), Document.COLUMN_DOCUMENT_ID)
        val families = familiesOf(provider)
        Vault(app, DriveApi(Shared.session(app)!!)).forgetFamilyCopies(listOf(family.workspaceId))
        families.reload()
        rows(provider.queryChildDocuments(folder, null, null as String?), Document.COLUMN_DOCUMENT_ID)
        WriteBacks.beforeSlotId = { WriteBacks.beforeSlotId = null; throw java.io.IOException("No space left on device") }
        ParcelFileDescriptor.AutoCloseOutputStream(provider.openDocument(file, "w", null)).use { it.write("save after a revocation".toByteArray()) }
        org.robolectric.Shadows.shadowOf(WriteBacks.closes.looper).idle()
        val row = com.hushos.app.data.FailedTransfers.of(app).all().single()
        assertTrue(TransferQueue.retry(app, row))
        assertEquals(ListenableWorker.Result.success(), runJob(slot))
        assertEquals("save after a revocation", serverText())
    }

    /*
     * A family file's save couldn't be kept in its slot (its edit kept for a Retry); the other app then opens the file to
     * read and to append: both start from that edit, not the server's older version. Fails if an open that keeps the
     * contents skips an edit whose save couldn't be kept.
     */
    @Test
    fun aFamilyOpenAfterASaveCouldntBeKeptStartsFromIt() {
        val provider = provider()
        rows(provider.queryChildDocuments(folder, null, null as String?), Document.COLUMN_DOCUMENT_ID)
        val families = familiesOf(provider)
        val doc = FamilyDoc.of(file) as FamilyDoc.Node
        WriteBacks.fault = { at -> if (at == "json") { WriteBacks.fault = null; throw java.io.IOException("No space left on device") } }
        ParcelFileDescriptor.AutoCloseOutputStream(provider.openDocument(file, "w", null)).use { it.write("kept for a retry".toByteArray()) }
        org.robolectric.Shadows.shadowOf(WriteBacks.closes.looper).idle()
        assertEquals(1, com.hushos.app.data.FailedTransfers.of(app).all().size)
        assertEquals("kept for a retry", read(provider, file))
        assertEquals("kept for a retry", families.editFor(doc, "wa").readText())
    }

    private fun familiesOf(provider: HushOSDocumentsProvider): ProviderFamilies =
        HushOSDocumentsProvider::class.java.getDeclaredField("families").apply { isAccessible = true }.get(provider) as ProviderFamilies
}
