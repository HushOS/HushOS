package com.hushos.app.files

import android.content.pm.ProviderInfo
import android.os.ParcelFileDescriptor
import com.hushos.app.data.DriveApi
import com.hushos.app.data.FakeDrive
import com.hushos.app.data.FamilyFixture
import com.hushos.app.data.Shared
import com.hushos.app.data.Vault
import com.hushos.app.data.TransferQueue
import com.hushos.app.data.UploadWorker
import androidx.work.Configuration
import androidx.work.ListenableWorker
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.TestListenableWorkerBuilder
import androidx.work.testing.WorkManagerTestInitHelper
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.io.File

/*
 * Another app writing a file of the drive through the Files app or a picker, in each mode it can open it in: "wa" appends
 * to what the file held and "rw" writes over it in place, so both keep it; "w", "wt" and "rwt" truncate. The edit the
 * provider hands out is checked, then written as the platform opens it (ParcelFileDescriptor.parseMode) and sent up as
 * the provider's write-back sends it, and the new version is read back from the server.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class FilesWriteModesTest {
    private val server = FakeDrive()
    private val app get() = RuntimeEnvironment.getApplication()

    @Before
    fun signIn() {
        // The mirror is one per process and Robolectric keeps statics between tests: each test starts from an empty one.
        com.hushos.app.data.Mirror::class.java.getDeclaredField("instance").apply { isAccessible = true }.set(null, null)
        app.deleteDatabase("mirror.db")
        FamilyFixture.signIn(server, "files-write-modes-test")
        WorkManagerTestInitHelper.initializeTestWorkManager(app, Configuration.Builder().setExecutor(SynchronousExecutor()).setTaskExecutor(SynchronousExecutor()).build())
    }

    @After
    fun close() {
        server.close()
        assertEquals("routes the fake does not serve", emptyList<String>(), server.unknown)
    }

    /* The provider as the system makes it. */
    private fun provider(): HushOSDocumentsProvider {
        val info = ProviderInfo().apply {
            authority = "${app.packageName}.documents"
            exported = true
            grantUriPermissions = true
            readPermission = android.Manifest.permission.MANAGE_DOCUMENTS
            writePermission = android.Manifest.permission.MANAGE_DOCUMENTS
        }
        return Robolectric.buildContentProvider(HushOSDocumentsProvider::class.java).create(info).get()
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
     * Each mode in turn on one file: its edit starts from the current version or empty as the mode says, and the version it
     * sends up holds what the file held plus what was written ("wa"), what was written over its start ("rw"), or only what
     * was written (the truncating modes). Fails if a mode that keeps the contents starts the edit empty, as releases up to
     * 0.11.0 did for "wa" (the file replaced by the appended bytes alone), or a truncating one keeps them.
     */
    @Test
    fun eachModeKeepsOrDropsWhatTheFileHeld() {
        val notes = server.file(server.root, "Notes.txt", "personal notes".toByteArray())
        val provider = provider()
        provider.queryChildDocuments("root", null, null as String?).close()
        val vault = HushOSDocumentsProvider::class.java.getDeclaredField("vault").apply { isAccessible = true }.get(provider) as Vault
        var held = "personal notes"
        for (mode in listOf("wa", "rw", "rwt", "wt", "w")) {
            val edit = provider.personalEdit(vault, notes, mode)
            // The platform makes the file when it opens it for a truncating mode: nothing of the old version is in it.
            assertEquals(mode, if (WriteModes.keepsContents(mode)) held else "", if (edit.exists()) edit.readText() else "")
            val wrote = "[$mode]"
            writeAs(mode, edit, wrote)
            val item = vault.resolve(notes)
            vault.upload(edit, item.name, item.metadata.mime, item.node.parentId!!, item)
            held = when (mode) {
                "wa" -> held + wrote
                "rw" -> wrote + held.drop(wrote.length)
                else -> wrote
            }
            // Another phone of the account reads the version that landed.
            val out = File(app.cacheDir, "read-${System.nanoTime()}")
            Vault(app, DriveApi(Shared.session(app)!!)).apply { listChildren(server.root) }.download(notes, out)
            assertEquals("mode $mode", held, out.readText())
        }
    }

    /*
     * The provider's own upload of a write-back failed and the transfer queue landed it instead, from the job's own vault:
     * the provider's row still names the version before. An app that then opens the file to append gets the version that
     * landed, and its append builds on it. Fails if a contents-keeping edit starts from the provider's stale row (the
     * append would replace the save with the old bytes plus the new ones).
     */
    @Test
    fun anAppendAfterAQueuedWriteBackBuildsOnTheVersionThatLanded() {
        val notes = server.file(server.root, "Notes.txt", "first draft".toByteArray())
        val provider = provider()
        provider.queryChildDocuments("root", null, null as String?).close()
        val vault = HushOSDocumentsProvider::class.java.getDeclaredField("vault").apply { isAccessible = true }.get(provider) as Vault
        val stale = vault.resolve(notes).node.currentVersion!!.id
        // The write-back the provider couldn't send, queued as its close handler queues it, and run as WorkManager runs it.
        val saved = provider.personalEdit(vault, notes, "w").apply { writeText("saved draft") }
        val item = vault.resolve(notes)
        val job = TransferQueue.upload(app, saved, item.name, item.metadata.mime, item.node.parentId!!, item.id)
        val request = TransferQueue.uploadRequest(job, File(app.filesDir, "queue/$job/content"), item.metadata.mime, item.node.parentId!!, item.id,
            session = TransferQueue.accountTag(Shared.session(app)!!))
        val worker = TestListenableWorkerBuilder<UploadWorker>(app).setId(job).setInputData(request.workSpec.input).setTags(request.tags.toList()).build()
        assertEquals(ListenableWorker.Result.success(), runBlocking { worker.doWork() })
        assertEquals("the provider's row moved without a look at the server", stale, vault.item(notes)!!.node.currentVersion!!.id)
        val append = provider.personalEdit(vault, notes, "wa")
        assertEquals("saved draft", append.readText())
        writeAs("wa", append, " and more")
        val now = vault.resolve(notes)
        vault.upload(append, now.name, now.metadata.mime, now.node.parentId!!, now)
        val out = File(app.cacheDir, "read-${System.nanoTime()}")
        Vault(app, DriveApi(Shared.session(app)!!)).apply { listChildren(server.root) }.download(notes, out)
        assertEquals("saved draft and more", out.readText())
    }

    /* The provider's vault (the one its requests use). */
    private fun vaultOf(provider: HushOSDocumentsProvider) =
        HushOSDocumentsProvider::class.java.getDeclaredField("vault").apply { isAccessible = true }.get(provider) as Vault

    /* The provider's own upload of every write-back fails (no begin answered) while `drop` is set. */
    private fun dropBegins(drop: Boolean) {
        server.beforeAnswer = if (!drop) null else { method, path -> if (method == "POST" && path == "drive/uploads") throw IllegalStateException("dropped") }
    }

    /* The write-backs queued for `notes`, oldest first. */
    private fun queuedFor(notes: String, vault: Vault): List<androidx.work.WorkInfo> {
        val chain = com.hushos.app.data.WriteBacks.chainOf(vault.resolve(notes).node.workspaceId, notes)
        return androidx.work.WorkManager.getInstance(app).getWorkInfosForUniqueWork(chain).get()
            .sortedBy { info -> info.tags.first { it.startsWith("order:") }.removePrefix("order:").toLong() }
    }

    /* A queued write-back's job, run as WorkManager starts it: its request rebuilt as TransferQueue queued it (its tags checked against WorkManager's). */
    private fun runJob(info: androidx.work.WorkInfo, notes: String, folder: String): ListenableWorker.Result {
        val request = TransferQueue.uploadRequest(info.id, File(app.filesDir, "queue/${info.id}/content"), "text/plain", folder, notes,
            session = TransferQueue.accountTag(Shared.session(app)!!), extraTags = info.tags.filter { it.startsWith("chain:") || it.startsWith("order:") })
        assertEquals(request.tags, info.tags)
        val worker = TestListenableWorkerBuilder<UploadWorker>(app).setId(info.id).setInputData(request.workSpec.input).setTags(request.tags.toList()).build()
        return runBlocking { worker.doWork() }
    }

    private fun serverText(notes: String): String {
        val out = File(app.cacheDir, "read-${System.nanoTime()}")
        Vault(app, DriveApi(Shared.session(app)!!)).apply { listChildren(server.root) }.download(notes, out)
        return out.readText()
    }

    /*
     * An app saves twice while the first save's upload is failing (queued, retrying): the second never goes ahead of it,
     * neither straight to the server nor as a job that could run first (it waits behind the first in the document's
     * chain), and the version left is the second save. Fails if a later save can land before an earlier one that then
     * replaces it.
     */
    @Test
    fun twoSavesOfOneDocumentLandInTheOrderTheyWereMade() {
        val notes = server.file(server.root, "Notes.txt", "original".toByteArray())
        val provider = provider()
        provider.queryChildDocuments("root", null, null as String?).close()
        val vault = vaultOf(provider)
        dropBegins(true)
        provider.personalWriteBack(vault, notes, notes, provider.personalEdit(vault, notes, "w").apply { writeText("first save") })
        dropBegins(false)
        provider.personalWriteBack(vault, notes, notes, provider.personalEdit(vault, notes, "w").apply { writeText("second save") })
        assertEquals("a later save went ahead of a queued one", "original", serverText(notes))
        val (first, second) = queuedFor(notes, vault)
        assertEquals(androidx.work.WorkInfo.State.BLOCKED, second.state)
        assertEquals(ListenableWorker.Result.success(), runJob(first, notes, server.root))
        assertEquals(ListenableWorker.Result.success(), runJob(second, notes, server.root))
        assertEquals("second save", serverText(notes))
    }

    /*
     * An app saves (queued: its upload failed), then opens the file again to append before that save lands: the append
     * starts from the save, never from the server's older version, and the version left holds both. Fails if a
     * contents-keeping edit starts from the server while a save of it is still queued (the save would be lost).
     */
    @Test
    fun anAppendBeforeAQueuedSaveLandsBuildsOnTheSave() {
        val notes = server.file(server.root, "Notes.txt", "original".toByteArray())
        val provider = provider()
        provider.queryChildDocuments("root", null, null as String?).close()
        val vault = vaultOf(provider)
        dropBegins(true)
        provider.personalWriteBack(vault, notes, notes, provider.personalEdit(vault, notes, "w").apply { writeText("first save") })
        dropBegins(false)
        val append = provider.personalEdit(vault, notes, "wa")
        assertEquals("first save", append.readText())
        writeAs("wa", append, " then more")
        provider.personalWriteBack(vault, notes, notes, append)
        for (job in queuedFor(notes, vault)) assertEquals(ListenableWorker.Result.success(), runJob(job, notes, server.root))
        assertEquals("first save then more", serverText(notes))
    }
}
