package com.hushos.app.data

import com.hushos.core.Integrity
import com.hushos.core.pinOfServed
import org.junit.After
import org.junit.Assert.assertEquals
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
 * Writes in family folders (Android 6c; iOS 2 on main) through the real Vault, GroupsApi and the core's area ledger
 * against FakeDrive serving rosters the core signs: a member makes a folder, uploads, renames, moves within the folder,
 * replaces Sam's file with a new version, trashes and puts back, and another phone of the account reads all of it
 * through its own ledger. A write never reaches the server into a folder it can't write now: a guard owed, a session
 * ended, a ledger that refuses, another space, or a folder proven a family's after the write began on another path.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class FamilyWritesTest {
    private val server = FakeDrive()
    private lateinit var family: FamilyFixture
    private val app get() = RuntimeEnvironment.getApplication()

    @Before
    fun signIn() {
        FamilyFixture.signIn(server, "family-writes-test")
        family = FamilyFixture(server)
        family.storePin(family.pin(listOf(family.r1, family.r2)))
    }

    @After
    fun close() {
        server.close()
        assertEquals("routes the fake does not serve", emptyList<String>(), server.unknown)
    }

    private fun accepted(phone: FamilyFixture.Phone): FamilyView =
        (phone.sync.sync(family.summary) as? FamilyState.Accepted)?.view ?: throw AssertionError("not accepted: ${phone.sync.sync(family.summary)}")

    private fun opened(): FamilyFixture.Phone = family.phone().also { phone -> accepted(phone); phone.vault.listChildren(family.rootId, family.workspaceId) }

    private fun local(name: String, text: String) = File(app.cacheDir, "local-${System.nanoTime()}/$name").apply { parentFile!!.mkdirs(); writeText(text) }

    private fun sentSince(count: Int) = server.requests.drop(count).filter { !it.startsWith("GET") }

    private fun read(vault: Vault, item: Opened): String {
        val out = File(app.cacheDir, "read-${System.nanoTime()}/${item.name}")
        vault.download(item.id, out, workspaceId = item.node.workspaceId)
        return out.readText()
    }

    /*
     * A new folder, a file uploaded into the top folder and moved into it, renamed, a new version of Sam's file, and a
     * trash put back: each lands, each row this phone keeps afterwards is the ledger's own, and another phone of the
     * account (a fresh session and ledger) opens all of it through its ledger and reads the bytes. Fails if a family
     * write seals under anything but keys the ledger made or holds, or keeps its answer as anything but the ledger's.
     */
    @Test
    fun aMembersWritesLandAndAnotherPhoneReadsThemThroughItsLedger() {
        val phone = opened()
        val vault = phone.vault
        val trips = vault.createFolder(family.rootId, "Trips")
        assertTrue(vault.nodes.viaLedger(family.workspaceId, trips.id))
        val notes = vault.upload(local("Notes.txt", "packing list"), "Notes.txt", "text/plain", family.rootId, null)
        assertTrue(vault.nodes.viaLedger(family.workspaceId, notes.id))
        val moved = vault.move(notes.id, trips.id)
        assertEquals(trips.id, moved.node.parentId)
        val renamed = vault.rename(notes.id, "Packing.txt")
        assertTrue(vault.nodes.viaLedger(family.workspaceId, renamed.id))
        val recipes = vault.listChildren(family.rootId, family.workspaceId).single { it.id == family.fileId }
        vault.upload(local("Recipes.txt", "new recipes"), "Recipes.txt", "text/plain", family.rootId, recipes)
        assertEquals(1, kotlinx.coroutines.runBlocking { vault.trashMany(listOf(trips.id)) }.count { it.isSuccess })
        assertTrue(server.node(trips.id).trashedAt != null)
        val back = kotlinx.coroutines.runBlocking { vault.restoreMany(listOf(trips)) }.single()
        assertTrue("$back", back.isSuccess)
        // The fake answers one item a request, as a server without the batch routes: the vault falls back to those.
        synchronized(server.unknown) { server.unknown.removeAll { it.endsWith("/trash-batch") || it.endsWith("/restore-batch") } }
        // Another phone of the account: a new session, its own ledger, nothing of this one's rows.
        vault.close()
        val other = family.phone()
        accepted(other)
        val top = other.vault.listChildren(family.rootId, family.workspaceId)
        assertEquals(setOf("Trips", "Recipes.txt"), top.map { it.name }.toSet())
        assertEquals("new recipes", read(other.vault, top.single { it.id == family.fileId }))
        val inside = other.vault.listChildren(trips.id, family.workspaceId).single()
        assertEquals("Packing.txt", inside.name)
        assertEquals("packing list", read(other.vault, inside))
        assertTrue(other.vault.nodes.viaLedger(family.workspaceId, inside.id))
    }

    /*
     * The write barrier: while the family's guard is owed, nothing is written into its folder, whether the guard was
     * owed before the write began or became owed while it was on its way (a sync meanwhile that couldn't store it).
     * Fails if a family write passes without the guard kept, at its entry or at its final gate.
     */
    @Test
    fun noWriteGoesIntoTheFamilyWhileItsGuardIsOwed() {
        val phone = opened()
        val sent = server.requests.size
        phone.vault.oweFamilyGuard(family.groupId)
        assertThrows(GuardUnsaved::class.java) { phone.vault.createFolder(family.rootId, "Trips") }
        assertThrows(GuardUnsaved::class.java) { phone.vault.trash(family.fileId) }
        assertEquals("a write went out under an owed guard", emptyList<String>(), sentSince(sent))
        phone.vault.familyGuardKept(family.groupId)
        val version = server.node(family.fileId).metadataVersion
        // Owed while the rename was on its way: refused at its final gate.
        phone.vault.beforeWriteGate = { phone.vault.oweFamilyGuard(family.groupId) }
        assertThrows(GuardUnsaved::class.java) { phone.vault.rename(family.fileId, "Renamed.txt") }
        assertEquals(version, server.node(family.fileId).metadataVersion)
        assertEquals(emptyList<String>(), sentSince(sent))
        // A folder proven the family's that no member list held here (known from a device record, as a job's process
        // starts): its guard is still the one owed, and a trash, which seals nothing, waits for it too.
        phone.vault.beforeWriteGate = null
        phone.vault.familyHeld.remove(family.workspaceId.lowercase())
        assertThrows(GuardUnsaved::class.java) { phone.vault.trash(family.fileId) }
        assertNull(server.node(family.fileId).trashedAt)
        assertEquals(emptyList<String>(), sentSince(sent))
    }

    /*
     * The session ended while a write was on its way (a sign-out, another sign-in: the vault closed): nothing of it goes.
     * Fails if the final gate lets a closed session's write through while its ledger still holds the family.
     */
    @Test
    fun aWriteFromASessionThatEndedSendsNothing() {
        val phone = opened()
        val sent = server.requests.size
        val version = server.node(family.fileId).metadataVersion
        phone.vault.beforeWriteGate = { phone.vault.close() }
        assertThrows(SessionEnded::class.java) { phone.vault.rename(family.fileId, "Renamed.txt") }
        assertEquals(version, server.node(family.fileId).metadataVersion)
        assertEquals(emptyList<String>(), sentSince(sent))
    }

    /*
     * The ledger refuses writes into the folder (its member list no longer committed here, as after a refusal): a trash,
     * which seals nothing, is refused all the same and sends nothing. Fails if a family write skips require_writable.
     */
    @Test
    fun aFolderTheLedgerWontWriteTakesNothing() {
        val phone = opened()
        val sent = server.requests.size
        phone.vault.areaLedger.uncommit(family.groupId, false)
        assertThrows(FamilyFailure::class.java) { phone.vault.trash(family.fileId) }
        assertNull(server.node(family.fileId).trashedAt)
        assertEquals(emptyList<String>(), sentSince(sent))
    }

    /*
     * A family folder's item moved into this account's own drive (another space) is refused before anything is sent:
     * the server moves within one workspace, and a family key is never re-wrapped under a personal folder.
     */
    @Test
    fun aMoveOutOfTheFamilysSpaceSendsNothing() {
        val phone = opened()
        val sent = server.requests.size
        assertThrows(ApiError::class.java) { phone.vault.move(family.fileId, server.root) }
        assertEquals(family.rootId, server.node(family.fileId).parentId)
        assertEquals(emptyList<String>(), sentSince(sent))
    }

    /*
     * #243's last rule: a write's judgement of a record it signs again goes by the pins as this phone's guard allows them.
     * This phone's guard holds Sam first-seen at other keys; the settings (another device, or a server's copy) say Sam is
     * verified at the keys Sam's file is signed with. The rename's form is re-sealed, never ordinary. Fails if the write
     * judgement takes the raw settings pins.
     */
    @Test
    fun aWritesJudgementTakesTheGuardsPinsNeverTheRawSettings() {
        val sam = family.creator
        val other = newPerson()
        val guarded = ContactPin.of(sam.id.lowercase(), "sam@example.org", "Sam Lindqvist", pinOfServed(other.servedKeys(), false), "2026-10-30T00:00:00Z", "added")
        val phone = family.phone()
        phone.vault.commitTrust(sam.id.lowercase(), null, guarded) { it.setPin(guarded, ifOver = null) }
        val raw = ContactPin.ofServed(sam.id.lowercase(), "sam@example.org", "Sam Lindqvist", sam.served, "2026-10-31T00:00:00Z")!!
        server.editSettings { it.pin(raw) }
        accepted(phone)
        val file = phone.vault.listChildren(family.rootId, family.workspaceId).single { it.id == family.fileId }
        assertEquals("a write judged Sam by the raw settings pin", Integrity.RESEALED, phone.sync.prior(FamilySync.metadataRecord(file.node), family.workspaceId))
        // And the rename goes out re-sealed, so the other phone reads it as this account's re-seal, not Sam's word.
        val renamed = phone.vault.rename(family.fileId, "Old recipes.txt")
        assertNotNull(server.node(renamed.id).signature)
    }
}
