package com.hushos.app.data

import com.hushos.core.FamilyGuard
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
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

/*
 * The family guard and the write barrier (docs/optional-verification.md 2.8; iOS's FamilyGuard.swift and its tests):
 * stored before the device record, sealed on disk, merged and never lowered, unreadable rather than absent on any read
 * error but a missing file, kept through a not-member wipe, which waits for the guard it hands back, deleted on sign-out;
 * and while an acceptance's guard is owed, nothing is written into its family.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class FamilyGuardTest {
    private val server = FakeDrive()
    private lateinit var family: FamilyFixture

    @Before
    fun signIn() {
        FamilyFixture.signIn(server, "family-guard-test")
        family = FamilyFixture(server)
        family.storePin(family.pin(listOf(family.r1, family.r2)))
    }

    @After
    fun close() {
        server.close()
        assertEquals("routes the fake does not serve", emptyList<String>(), server.unknown)
    }

    /*
     * The guard is stored before the device record (a crash between leaves it above the record, never below), it is
     * ciphertext on disk, and it only moves up: an older pin changes nothing, another history is refused.
     */
    @Test
    fun theGuardIsStoredBeforeTheRecordSealedAndNeverLowered() {
        family.chain = listOf(family.r1, family.r2, family.r3)
        val phone = family.phone()
        phone.vault.afterFamilyGuard = { throw IllegalStateException("stopped") }
        assertTrue(phone.sync.sync(family.summary) is FamilyState.Failed)
        assertEquals(3uL, phone.vault.familyGuard.family(family.groupId)?.rosterVersion)
        assertNull("the record went before the guard", phone.records.read(family.member.id, family.groupId))
        val onDisk = phone.vault.familyGuard.file.readText()
        assertFalse(onDisk.contains(family.groupId) || onDisk.contains(family.creator.keys.signingPublicKey))
        phone.vault.afterFamilyGuard = null
        val older = family.pin(listOf(family.r1, family.r2))
        assertEquals(3uL, phone.vault.familyGuard.keep(family.groupId, older).rosterVersion)
        assertEquals(3uL, phone.vault.familyGuard.family(family.groupId)?.rosterVersion)
        // Another roster at the version the guard holds is another history.
        assertThrows(FamilyGuardConflict::class.java) { phone.vault.familyGuard.keep(family.groupId, family.pin(listOf(family.r1, family.r2, family.r3Fork))) }
        assertEquals(3uL, phone.vault.familyGuard.family(family.groupId)?.rosterVersion)
    }

    /*
     * A guard folder this process can't search or read makes the file look missing to `exists`: it must read as
     * unreadable, never as no guard, which would be first use. Fails if any read error but a confirmed missing file
     * reads as none.
     */
    @Test
    fun aGuardFolderThatCantBeSearchedIsUnreadableNeverAbsent() {
        val phone = family.phone()
        assertTrue(phone.sync.sync(family.summary) is FamilyState.Accepted)
        val folder = phone.vault.familyGuard.file.parentFile!!
        try {
            assertTrue(folder.setExecutable(false, false) && folder.setReadable(false, false))
            assertThrows(GuardUnreadable::class.java) { phone.vault.familyGuard.family(family.groupId) }
            assertEquals(FamilyGuard.Unreadable, phone.vault.heldFamilyGuard(family.groupId))
            // The contact guard beside it reads the same way.
            assertThrows(GuardUnreadable::class.java) { phone.vault.guard.record() }
        } finally {
            folder.setExecutable(true, false)
            folder.setReadable(true, false)
        }
        // Readable again: a family with nothing stored is absent, as it should be.
        assertEquals(FamilyGuard.Absent, phone.vault.heldFamilyGuard("0a1b2c3d-0000-4000-8000-00000000000e"))
    }

    /*
     * The write barrier: an acceptance whose guard can't be stored keeps every write into its family refused with the
     * storage words (not merely read only) and writes no record, until a later acceptance stores it. Fails if the barrier
     * comes down on a failed store, or the record is written without the guard.
     */
    @Test
    fun aGuardThatCantBeStoredHoldsEveryWriteUntilALaterSyncStoresIt() {
        val phone = family.phone()
        var writable = false
        phone.vault.familyGuardWrites = { writable }
        val failed = phone.sync.sync(family.summary)
        assertEquals(FamilyState.Failed(GuardWords.UNSAVED), failed)
        assertNull(phone.records.read(family.member.id, family.groupId))
        assertThrows(GuardUnsaved::class.java) { phone.vault.refuseFamilyWrite(family.workspaceId) }
        assertThrows(GuardUnsaved::class.java) { phone.vault.sendingIntoFamily(family.workspaceId) }
        // A family folder this phone can't place in a family is held too while any guard is owed.
        assertThrows(GuardUnsaved::class.java) { phone.vault.requireGuardKept("0a1b2c3d-0000-4000-8000-00000000000f") }
        writable = true
        assertTrue(phone.sync.sync(family.summary) is FamilyState.Accepted)
        assertTrue(phone.vault.familyGuardOwed.isEmpty())
        assertThrows(FamilyReadOnly::class.java) { phone.vault.refuseFamilyWrite(family.workspaceId) }
        assertNotNull(phone.records.read(family.member.id, family.groupId))
    }

    /*
     * Not-member after an acceptance whose guard couldn't be stored: the wipe waits (nothing deleted, the storage words)
     * until the guard it hands back is stored, then wipes, and the guard holds the later roster. Fails if the wipe deletes
     * before storing, or stores nothing.
     */
    @Test
    fun aWipeWaitsForTheGuardItHandsBackToBeStored() {
        val phone = family.phone()
        assertTrue(phone.sync.sync(family.summary) is FamilyState.Accepted)
        var writable = false
        phone.vault.familyGuardWrites = { writable }
        family.chain = listOf(family.r1, family.r2, family.r3)
        assertTrue(phone.sync.sync(family.summary) is FamilyState.Failed)
        assertEquals(2uL, phone.vault.familyGuard.family(family.groupId)?.rosterVersion)
        family.notMember = true
        assertEquals(FamilyState.Failed(GuardWords.UNSAVED), phone.sync.sync(family.summary))
        assertNotNull(phone.records.read(family.member.id, family.groupId))
        writable = true
        assertEquals(FamilyState.Wiped, phone.sync.sync(family.summary))
        assertNull(phone.records.read(family.member.id, family.groupId))
        assertEquals(3uL, phone.vault.familyGuard.family(family.groupId)?.rosterVersion)
    }

    /*
     * #247 check, round 7: route 2 stops listing an open family and route 5 answers not-member, but the guard can't be
     * read, so the two-phase wipe can't finish. The family is refused (nothing of it opens), a failed state is handed
     * back under a revision, and the guard and the record stay; the next list, with the guard readable, wipes it. Fails if
     * an unlisted removal whose wipe fails leaves the family open, says nothing, or is never asked about again.
     */
    @Test
    fun anUnlistedRemovalWhoseWipeFailsRefusesTheFamilyAndWipesOnALaterList() {
        family.storePin(family.pin(listOf(family.r1, family.r2)))
        val phone = family.phone()
        assertTrue(phone.sync.sync(family.summary) is FamilyState.Accepted)
        assertEquals(1, phone.vault.listChildren(family.rootId, family.workspaceId).size)
        family.listed = false
        family.notMember = true
        val folder = phone.vault.familyGuard.file.parentFile!!
        val failed = try {
            assertTrue(folder.setExecutable(false, false) && folder.setReadable(false, false))
            phone.sync.listReconciling().second
        } finally {
            folder.setExecutable(true, false)
            folder.setReadable(true, false)
        }
        assertEquals(listOf(family.groupId), failed.map { it.groupId })
        assertTrue("an unlisted removal whose wipe failed said nothing", failed.single().state is FamilyState.Failed)
        assertNotNull(phone.records.read(family.member.id, family.groupId))
        assertEquals(2uL, phone.vault.familyGuard.family(family.groupId)?.rosterVersion)
        assertNull("the family's file stayed open", phone.vault.item(family.fileId))
        assertNull(phone.vault.nodes.key(family.workspaceId, family.fileId))
        assertTrue(runCatching { phone.vault.listChildren(family.rootId, family.workspaceId) }.isFailure)
        // Storage works again: the next list asks again and the wipe finishes.
        val wiped = phone.sync.listReconciling().second
        assertEquals(listOf(FamilyState.Wiped), wiped.map { it.state })
        assertTrue(wiped.single().revision > failed.single().revision)
        assertNull(phone.records.read(family.member.id, family.groupId))
    }

    /*
     * Signed out right after the guard was stored, before the device record: the sync that resumes writes no record (and
     * no joins record) into the signed-out phone. Fails if a record write isn't bound to the session it began in.
     */
    @Test
    fun aSignOutBetweenTheGuardAndTheRecordLeavesNoRecord() {
        val context = RuntimeEnvironment.getApplication()
        val records = File(context.noBackupFilesDir, FamilyRecords.FOLDER)
        val phone = family.phone(records)
        phone.vault.afterFamilyGuard = { AccountStore(context.filesDir, context.cacheDir, context.noBackupFilesDir).wipe() }
        assertTrue(phone.sync.sync(family.summary) is FamilyState.Failed)
        assertNull(phone.records.read(family.member.id, family.groupId))
        assertFalse(records.exists() && records.list().orEmpty().isNotEmpty())
        assertThrows(FamilyRecords.Unsaved::class.java) { phone.records.putJoins(family.member.id, family.groupId, "joins") }
        assertNull(phone.records.readJoins(family.member.id, family.groupId))
    }

    /* Sign-out deletes the family guard with the contact guard, and the families' records: the phone is a new device. */
    @Test
    fun signOutDeletesTheFamilyGuardAndRecords() {
        val context = RuntimeEnvironment.getApplication()
        val records = File(context.noBackupFilesDir, FamilyRecords.FOLDER)
        val phone = family.phone(records)
        assertTrue(phone.sync.sync(family.summary) is FamilyState.Accepted)
        assertTrue(phone.vault.familyGuard.file.exists())
        assertTrue(records.list().orEmpty().isNotEmpty())
        AccountStore(context.filesDir, context.cacheDir, context.noBackupFilesDir).wipe()
        assertFalse(phone.vault.familyGuard.file.exists())
        assertFalse(records.exists())
    }
}
