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
import org.junit.Assert.assertTrue
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

    /*
     * The app closes the file when the provider can't look its row up any more (gone from its cache, and nowhere it knows to
     * list it again): the edit is queued, as the file was when opened, and its job lands it, never deleted unsent. Fails if
     * a failed lookup at close drops the only edited copy.
     */
    @Test
    fun anEditWhoseFileCantBeLookedUpAtCloseIsQueuedNotDropped() {
        val notes = server.file(server.root, "Notes.txt", "original".toByteArray())
        val provider = provider()
        provider.queryChildDocuments("root", null, null as String?).close()
        val vault = HushOSDocumentsProvider::class.java.getDeclaredField("vault").apply { isAccessible = true }.get(provider) as Vault
        val opened = vault.resolve(notes)
        val edit = provider.personalEdit(vault, notes, "w").apply { writeText("kept through a failed lookup") }
        vault.forget(opened.node.workspaceId, notes)
        vault.parents.remove(notes)
        assertTrue(runCatching { vault.resolve(notes) }.isFailure)
        provider.personalWriteBack(vault, notes, notes, edit, opened)
        val queued = androidx.work.WorkManager.getInstance(app).getWorkInfosByTag(TransferQueue.TAG).get().single()
        val staged = File(app.filesDir, "queue/${queued.id}/content")
        assertEquals("kept through a failed lookup", staged.readText())
        val request = TransferQueue.uploadRequest(queued.id, staged, opened.metadata.mime, server.root, notes, session = TransferQueue.accountTag(Shared.session(app)!!))
        val worker = TestListenableWorkerBuilder<UploadWorker>(app).setId(queued.id).setInputData(request.workSpec.input).setTags(request.tags.toList()).build()
        assertEquals(ListenableWorker.Result.success(), runBlocking { worker.doWork() })
        val out = File(app.cacheDir, "read-${System.nanoTime()}")
        Vault(app, DriveApi(Shared.session(app)!!)).apply { listChildren(server.root) }.download(notes, out)
        assertEquals("kept through a failed lookup", out.readText())
    }
}
