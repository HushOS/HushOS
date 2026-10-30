package com.hushos.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files

/*
 * One account's files must never show to the next account on this phone: decrypted
 * kept files, files opened or fetched for the Files app, decrypted thumbnails, the
 * queue's copies, the parents index, and the stores behind them.
 */
class AccountStoreTest {
    private lateinit var files: File
    private lateinit var cache: File
    private lateinit var noBackup: File
    private var storesForgotten = 0
    private lateinit var store: AccountStore

    /* What account A leaves on the phone after keeping, opening and uploading. */
    private val aliceFiles get() = listOf(
        File(files, "offline/node-a/version-1/Tax return.pdf"),
        // A kept folder: its record and a file that came with it.
        File(files, "offline/folders.json"),
        File(files, "offline/failures.json"),
        File(files, "offline/node-e/version-4/Payslip March.pdf"),
        File(files, "queue/job-1/Holiday.jpg"),
        File(files, "files-parents.json"),
        // The names of queued transfers, kept out of WorkManager's database.
        File(files, JobNames.FILE),
        File(files, JobNames.STAGED),
        File(cache, "opened/node-a/version-1/Tax return.pdf"),
        File(cache, "files/node-b/version-2"),
        File(cache, "thumbnails/node-c"),
        File(cache, "links/node-d/version-3/Shared.pdf"),
        File(cache, "staged/123/Upload.bin"),
        File(cache, "kit/hushos-recovery-kit.txt"),
        // The rollback marks, sealed, and the plaintext ones an earlier version kept across sign-outs.
        File(noBackup, "marks/dm3BIs9g8rvG3OeM5lsOQA.json"),
        File(noBackup, "settings-seen.json"),
    )

    @Before
    fun setUp() {
        val root = Files.createTempDirectory("account-store").toFile()
        files = File(root, "files")
        cache = File(root, "cache")
        noBackup = File(root, "no_backup")
        storesForgotten = 0
        store = AccountStore(files, cache, noBackup) { storesForgotten++ }
    }

    /* Alice's files, written after her sign-in; only what happens afterwards is counted. */
    private fun leaveAlicesData() {
        aliceFiles.forEach { it.parentFile!!.mkdirs(); it.writeText("decrypted") }
        storesForgotten = 0
    }

    @Test
    fun anotherAccountSigningInRemovesTheFirstAccountsData() {
        store.claim("alice")
        leaveAlicesData()
        store.claim("bob")
        for (file in aliceFiles) assertFalse("$file survived another account's sign-in", file.exists())
        assertEquals(1, storesForgotten)
        assertEquals("bob", store.owner())
    }

    @Test
    fun theSameAccountSigningInAgainKeepsWhatItKept() {
        // Its session ended (a password changed elsewhere) and it signs back in: kept files stay.
        store.claim("alice")
        leaveAlicesData()
        store.claim("ALICE")
        for (file in aliceFiles) assertTrue("$file was lost on the same account's sign-in", file.exists())
        assertEquals(0, storesForgotten)
    }

    @Test
    fun dataNobodyIsRecordedAsOwningIsRemovedBeforeASignIn() {
        // Kept before the owner was recorded (an older version signed out without wiping).
        leaveAlicesData()
        store.claim("bob")
        for (file in aliceFiles) assertFalse("$file of an unknown account survived", file.exists())
    }

    @Test
    fun signingOutRemovesEverythingAndTheOwner() {
        store.claim("alice")
        leaveAlicesData()
        store.wipe()
        for (file in aliceFiles) assertFalse("$file survived sign-out", file.exists())
        assertEquals(1, storesForgotten)
        assertEquals(null, store.owner())
    }

    @Test
    fun aSessionFromBeforeTheStoreKeepsItsOwnData() {
        // Already signed in when this version first runs: nothing is wiped, and it is recorded.
        leaveAlicesData()
        store.adopt("alice")
        for (file in aliceFiles) assertTrue(file.exists())
        assertEquals("alice", store.owner())
        // Then someone else signs in: Alice's data goes.
        store.claim("bob")
        for (file in aliceFiles) assertFalse(file.exists())
    }

    /* Marks the store really kept (sealed, under a settings key) are gone after sign-out: the next sign-in reads none. */
    @Test
    fun signingOutLeavesNoRollbackMark() {
        val user = "6b1a3f0e-2c4d-4e5f-8a9b-0c1d2e3f4a5b"
        val keys: MarksKeys = { _, _ -> MarksKey(ByteArray(32) { 7 }, com.hushos.core.SettingsKeyEnvelope("n", "c")) }
        store.claim(user)
        SettingsMark(File(noBackup, SettingsMark.FOLDER), keys).recordIdentity(user, 3uL, 2u)
        SettingsMark.forgetRaised()
        assertEquals(3uL, SettingsMark(File(noBackup, SettingsMark.FOLDER), keys).read(user).identity)
        store.wipe()
        assertTrue("a mark survived sign-out", noBackup.walkTopDown().none { it.isFile })
        SettingsMark.forgetRaised()
        SettingsMark(File(noBackup, SettingsMark.FOLDER), keys).checkIdentity(user, 1uL, 1u)
    }

    @Test
    fun theNativeLibraryInTheCacheIsNotAccountData() {
        val jna = File(cache, "jna-123/libjnidispatch.so").also { it.parentFile!!.mkdirs(); it.writeText("lib") }
        store.claim("alice")
        store.claim("bob")
        assertTrue(jna.exists())
    }
}
