package com.hushos.app.data

import org.json.JSONObject
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
import org.robolectric.annotation.Config
import java.io.File

/*
 * Family spaces read only (Android 1; iOS's FamilySyncTests) through the real Vault, GroupsApi and the core's area ledger
 * against FakeDrive serving rosters the core signs: a member's folder opens and its creator's file is verified by the
 * family; a chain short of what this phone accepted is refused; a fork opens nothing; not-member wipes but keeps the
 * settings pin; every change in a family folder is refused before anything is sent; and removal on another device is
 * found by asking route 5, never by a list that failed.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class FamilySyncTest {
    private val server = FakeDrive()
    private lateinit var family: FamilyFixture

    @Before
    fun signIn() {
        FamilyFixture.signIn(server, "family-sync-test")
        family = FamilyFixture(server)
    }

    @After
    fun close() {
        server.close()
        assertEquals("routes the fake does not serve", emptyList<String>(), server.unknown)
    }

    private fun accepted(phone: FamilyFixture.Phone): FamilyView =
        (phone.sync.sync(family.summary) as? FamilyState.Accepted)?.view ?: throw AssertionError("not accepted: ${phone.sync.sync(family.summary)}")

    /*
     * Maya's settings pin through roster 2 (her web join): the phone accepts, stores the guard and the record, opens the
     * folder from its grant and lists Sam's file, which reads "Verified by Lindqvist family" with no mark. Fails if the
     * folder opens under anything but the ledger, or the verdict judges by the personal trust set.
     */
    @Test
    fun aMembersFolderOpensAndItsCreatorsFileIsVerifiedByTheFamily() {
        family.storePin(family.pin(listOf(family.r1, family.r2)))
        val phone = family.phone()
        val view = accepted(phone)
        assertEquals(2uL, view.rosterVersion)
        assertEquals(listOf("Photos"), view.areas.map { it.name })
        assertTrue(view.areas.single().openable)
        assertEquals(2uL, phone.records.read(family.member.id, family.groupId)?.rosterVersion)
        assertEquals(2uL, phone.vault.familyGuard.family(family.groupId)?.rosterVersion)
        val file = phone.vault.listChildren(family.rootId).single()
        assertEquals("Recipes.txt", file.name)
        val verdict = phone.sync.verdicts(listOf(file.node), family.groupId).single()
        assertNull(verdict.mark)
        assertEquals("Verified by Lindqvist family", verdict.verifiedBy)
        // Vouched for by the family: no "Not verified" writer for Info.
        assertNull(verdict.seen)
        // The marker went in with the first save of a group pin from this phone; the web's pin, from before it, reads checked.
        assertTrue(server.settings().json.has("familyChecksSince"))
        assertTrue(phone.sync.familyChecked(family.groupId))
    }

    /*
     * The record is at roster 3 and the settings pin only at 2 (an older save from another device). A fresh start of the
     * app, and the server serves roster 2 as the head again: the record's own pin is still a mark, so it is a rollback,
     * refused, and nothing opens. Fails if the record isn't held as a mark from version 1.
     */
    @Test
    fun aChainShortOfTheDeviceRecordIsRefusedAndNothingStaysOpen() {
        family.chain = listOf(family.r1, family.r2, family.r3)
        family.storePin(family.pin(listOf(family.r1, family.r2)))
        val first = family.phone()
        assertEquals(3uL, accepted(first).rosterVersion)
        family.chain = listOf(family.r1, family.r2)
        family.ignoringAfter = true
        family.asked.clear()
        val later = family.phone(first.folder)
        val state = later.sync.sync(family.summary)
        assertTrue("$state", state is FamilyState.Failed)
        assertFalse(family.asked.contains("GET /drive/spaces"))
        assertFalse(later.vault.areaLedger.isArea(family.workspaceId))
        assertEquals(3uL, later.records.read(family.member.id, family.groupId)?.rosterVersion)
    }

    /* Another history from roster 3 than the one accepted: the hard warning, and nothing of the family stays open. */
    @Test
    fun aForkShowsTheWarningAndOpensNothing() {
        family.chain = listOf(family.r1, family.r2, family.r3)
        family.storePin(family.pin(listOf(family.r1, family.r2)))
        val phone = family.phone()
        accepted(phone)
        phone.vault.listChildren(family.rootId)
        family.chain = listOf(family.r1, family.r2, family.r3Fork, family.r4Fork)
        family.asked.clear()
        val state = phone.sync.sync(family.summary)
        assertTrue("$state", state is FamilyState.Fork)
        val fork = (state as FamilyState.Fork).fork
        assertTrue(fork.memberList && fork.version == 3uL)
        assertTrue(fork.sides.flatMap { it.from }.contains("what the server shows now"))
        assertFalse(family.asked.contains("GET /drive/spaces"))
        assertNull(phone.vault.item(family.fileId))
        assertNull(phone.vault.item(family.rootId))
        // The core holds the family's keys back after the fork: the listing is refused there, not by the app.
        val refused = assertThrows(Exception::class.java) { phone.vault.listChildren(family.rootId) }
        assertEquals(FamilyWords.OPEN_AGAIN, FamilyWords.error(refused))
    }

    /*
     * Not-member: the device record and what was opened go, but the settings pin and the family guard stay (D7 reversed,
     * 3.3), so a server that erased the family can't make it first use again. Fails if the wipe deletes either.
     */
    @Test
    fun aNotMemberAnswerWipesWhatThePhoneKeptButKeepsThePinAndTheGuard() {
        family.storePin(family.pin(listOf(family.r1, family.r2)))
        val phone = family.phone()
        accepted(phone)
        phone.vault.listChildren(family.rootId)
        family.notMember = true
        assertEquals(FamilyState.Wiped, phone.sync.sync(family.summary))
        assertNull(phone.records.read(family.member.id, family.groupId))
        assertNull(phone.vault.item(family.fileId))
        assertFalse(phone.vault.areaLedger.isArea(family.workspaceId))
        assertNotNull(server.settings().groupPin(family.groupId))
        assertEquals(2uL, phone.vault.familyGuard.family(family.groupId)?.rosterVersion)
    }

    /*
     * Another member renames Sam's file and uploads a new version: a refresh of the folder shows the new name and opens the
     * new content, through the ledger. Fails if a family row this process opened is kept whatever the server serves now.
     */
    @Test
    fun anotherMembersRenameAndNewVersionShowAfterARefresh() {
        family.storePin(family.pin(listOf(family.r1, family.r2)))
        val phone = family.phone()
        accepted(phone)
        assertEquals("Recipes.txt", phone.vault.listChildren(family.rootId).single().name)
        server.renameAs(family.fileId, "Recipes (Sam).txt")
        server.newVersion(family.fileId, "second version".toByteArray())
        val after = phone.vault.listChildren(family.rootId).single()
        assertEquals("Recipes (Sam).txt", after.name)
        val out = File.createTempFile("family", ".txt")
        phone.vault.download(after.id, out)
        assertEquals("second version", out.readText())
        // Still the family's: judged by its member list, Sam's rename verified by the family.
        assertNull(phone.sync.verdicts(listOf(after.node), family.groupId).single().mark)
    }

    /*
     * Route 25 names one of this account's own folders as the family area's top folder: refused as the family's Couldn't
     * check, never opened through the personal key path, and nothing personal becomes a family folder. Fails if the root is
     * opened by its own workspace.
     */
    @Test
    fun aRootFromAnotherWorkspaceIsRefusedAndNothingPersonalBecomesAFamilyFolder() {
        family.storePin(family.pin(listOf(family.r1, family.r2)))
        family.servedRootId = server.root
        val phone = family.phone()
        val area = accepted(phone).areas.single()
        assertFalse(area.openable)
        assertNull("a personal folder was handed out as the family's top folder", area.root)
        assertEquals("Couldn’t check this folder’s keys", area.line)
        assertFalse(phone.vault.isFamilyWorkspace(server.workspace))
        assertFalse(phone.sync.familyAreas().containsKey(server.workspace.lowercase()))
        assertFalse(phone.vault.familyNodes.containsKey(server.root))
    }

    /* Route 25 names a file inside the area, not its top folder: refused the same way. */
    @Test
    fun aRootThatIsNotTheAreasTopFolderIsRefused() {
        family.storePin(family.pin(listOf(family.r1, family.r2)))
        family.servedRootId = family.fileId
        val phone = family.phone()
        val area = accepted(phone).areas.single()
        assertFalse(area.openable)
        assertNull(area.root)
    }

    /* Holds the first GET of a version's address until released; the latch says it is waiting. */
    private fun holdVersionUrl(): Pair<java.util.concurrent.CountDownLatch, java.util.concurrent.CountDownLatch> {
        val waiting = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1)
        var held = false
        server.beforeAnswer = { method, path ->
            if (!held && method == "GET" && path.startsWith("drive/versions/") && path.endsWith("/url")) {
                held = true
                waiting.countDown()
                release.await(10, java.util.concurrent.TimeUnit.SECONDS)
            }
        }
        return waiting to release
    }

    /*
     * #247 check, round 3: a share (Grace's, served by the server) that targets the family's own folder. Mounted after
     * route 25 proved the folder, it is refused, and the family's rows stay the ledger's. Fails if a share mount can put a
     * row and key into a family's folder.
     */
    @Test
    fun aShareIntoAFamilyFolderIsRefusedAtMount() {
        family.storePin(family.pin(listOf(family.r1, family.r2)))
        val phone = family.phone()
        accepted(phone)
        phone.vault.listChildren(family.rootId, family.workspaceId)
        server.shareWithMe(family.fileId)
        server.pinGrace()
        val mount = phone.vault.mountShares().single()
        assertNotNull("a share into a family folder was mounted", mount.error)
        assertTrue(phone.vault.nodes.viaLedger(family.workspaceId, family.fileId))
    }

    /*
     * #247 check, round 3: the share was mounted before the family's folder was proven (nothing yet named it a family's).
     * Once route 25 proves it, what the share put there goes, and the family's file is opened by the ledger alone. Fails if
     * becoming a family folder keeps a share's rows.
     */
    @Test
    fun aShareMountedBeforeTheFolderWasProvenIsEvictedWhenItIs() {
        family.storePin(family.pin(listOf(family.r1, family.r2)))
        val phone = family.phone()
        server.shareWithMe(family.fileId)
        server.pinGrace()
        assertNull(phone.vault.mountShares().single().error)
        assertNotNull(phone.vault.nodes.row(family.workspaceId, family.fileId))
        accepted(phone)
        assertNull("the share's row outlived the folder becoming a family's", phone.vault.nodes.row(family.workspaceId, family.fileId))
        assertNull(phone.vault.nodes.key(family.workspaceId, family.fileId))
        phone.vault.listChildren(family.rootId, family.workspaceId)
        assertTrue(phone.vault.nodes.viaLedger(family.workspaceId, family.fileId))
    }

    /*
     * #247 check, round 3: after a fork cleared the family, a share refresh can't put the family's file back, and a
     * download of it refuses; nor does a row and key put there any way but the ledger download. Fails if a share mount or
     * a cached row stands in for the ledger.
     */
    @Test
    fun afterAForkClearAShareRefreshCantRefillTheFamilyAndDownloadRefuses() {
        family.chain = listOf(family.r1, family.r2, family.r3)
        family.storePin(family.pin(listOf(family.r1, family.r2)))
        val phone = family.phone()
        accepted(phone)
        val file = phone.vault.listChildren(family.rootId, family.workspaceId).single()
        val key = phone.vault.nodes.key(family.workspaceId, family.fileId)!!
        family.chain = listOf(family.r1, family.r2, family.r3Fork, family.r4Fork)
        assertTrue(phone.sync.sync(family.summary) is FamilyState.Fork)
        server.shareWithMe(family.fileId)
        server.pinGrace()
        assertNotNull(phone.vault.mountShares().single().error)
        assertNull("a share refresh refilled the forked family", phone.vault.nodes.row(family.workspaceId, family.fileId))
        // A row and key held for the family file that its ledger didn't open (as a share mount would leave them).
        phone.vault.nodes.put(file, key)
        val cache = org.robolectric.RuntimeEnvironment.getApplication().cacheDir
        val out = File(cache, "opened/elsewhere/Recipes.txt")
        assertThrows(FamilyFailure::class.java) { phone.vault.download(family.fileId, out, workspaceId = family.workspaceId) }
        assertFalse(out.exists())
    }

    /*
     * #247 check, item 1: an accepted member list names a received share's workspace (a hostile roster). The barrier's
     * hold over it never makes it a family folder: the share still opens and lists, a write into it isn't refused as a
     * family's, and the family's own folder, proven by route 25, still is one. Fails if a roster's word classes a
     * workspace as family.
     */
    @Test
    fun aRosterNamingAShareNeverMakesItAFamilyFolder() {
        family.storePin(family.pin(listOf(family.r1, family.r2)))
        val phone = family.phone()
        accepted(phone)
        val shared = server.folder(server.graceRoot, "S")
        server.file(shared, "t.txt", "theirs".toByteArray())
        server.shareWithMe(shared)
        server.pinGrace()
        assertNull(phone.vault.mountShares().single().error)
        // What the accept path holds when the member list names the share's workspace.
        phone.vault.holdAsFamilyWorkspaces(listOf(server.graceWorkspace), family.groupId)
        assertFalse("a roster's word made a share a family folder", phone.vault.isFamilyWorkspace(server.graceWorkspace))
        assertEquals(listOf("t.txt"), phone.vault.listChildren(shared).map { it.name })
        phone.vault.refuseFamilyWrite(server.graceWorkspace)
        assertTrue(phone.vault.isFamilyWorkspace(family.workspaceId))
    }

    /*
     * Round 16, item 2: another member moves the file from the family's top folder into a subfolder. The subfolder's
     * newer listing opens it first; the top folder's older listing (answered before the move) lands after. The file shows
     * only in its new folder. Fails if a listing keeps a cached row whose parent is now another folder.
     */
    @Test
    fun aMovedFileShowsOnlyInItsNewFolder() {
        val sub = server.folder(family.rootId, "Trips")
        family.storePin(family.pin(listOf(family.r1, family.r2)))
        val phone = family.phone()
        accepted(phone)
        assertEquals(setOf(sub, family.fileId), phone.vault.listChildren(family.rootId, family.workspaceId).map { it.id }.toSet())
        // The top folder's page as the server answered it before the move.
        val before = JSONObject().put("folder", server.node(family.rootId).json()).put("ancestors", org.json.JSONArray())
            .put("children", org.json.JSONArray().put(server.node(sub).json()).put(server.node(family.fileId).json())).put("nextCursor", JSONObject.NULL)
        server.moveAs(family.fileId, sub)
        assertEquals(listOf(family.fileId), phone.vault.listChildren(sub, family.workspaceId).map { it.id })
        val inner = server.extraRoutes!!
        server.extraRoutes = { method, segments, query, body ->
            if (method == "GET" && segments.joinToString("/") == "drive/nodes/${family.rootId}/children") 200 to before else inner(method, segments, query, body)
        }
        assertEquals("the moved file showed in its old folder too", listOf(sub), phone.vault.listChildren(family.rootId, family.workspaceId).map { it.id })
    }

    /*
     * Round 15: ids shared between a family and this account's drive. A family row served with a personal file's id is
     * refused, and so is a personal row with a family file's id, so nothing keyed by node id can mix them; and the family's
     * own root and file open, list, download and judge by their workspace. Fails if a family row may share an id with
     * another workspace's, or if a family lookup goes by id alone.
     */
    @Test
    fun familyRowsNeverShareAnIdWithAnotherWorkspace() {
        family.storePin(family.pin(listOf(family.r1, family.r2)))
        val phone = family.phone()
        accepted(phone)
        phone.vault.listChildren(family.rootId, family.workspaceId)
        val mine = server.file(server.root, "Mine.txt", "my own".toByteArray())
        phone.vault.listChildren(server.root)
        val personal = phone.vault.item(server.workspace, mine)!!
        // A family listing that names the personal file's id: refused, nothing kept under the family's workspace.
        val familyFile = phone.vault.item(family.workspaceId, family.fileId)!!
        assertThrows(FamilyFailure::class.java) { phone.vault.open(familyFile.node.copy(id = mine)) }
        assertNull(phone.vault.item(family.workspaceId, mine))
        // A personal row that names the family file's id: refused too.
        assertThrows(Refused::class.java) { phone.vault.open(personal.node.copy(id = family.fileId)) }
        assertEquals(setOf(family.workspaceId), phone.vault.nodes.workspacesOf(family.fileId))
        // The family's own: listed, downloaded and found by its workspace.
        assertEquals(listOf(family.fileId), phone.vault.listChildren(family.rootId, family.workspaceId).map { it.id })
        val cache = org.robolectric.RuntimeEnvironment.getApplication().cacheDir
        val copy = File(FamilyCopies.folder(cache, family.workspaceId)!!, "${family.fileId}/v1/Recipes.txt")
        phone.vault.download(family.fileId, copy, workspaceId = family.workspaceId)
        assertEquals("marker-family", copy.readText())
        assertEquals(family.workspaceId, phone.vault.item(family.workspaceId, family.rootId)?.node?.workspaceId)
    }

    /*
     * Round 14, item 1: a family row and a personal file share a node id. Downloading the family row never fetches the
     * personal file: not its bytes, not under the family row's path. Fails if the download looks the row up by id alone
     * (which prefers this account's own).
     */
    @Test
    fun aFamilyRowNeverDownloadsThePersonalFileWithItsId() {
        family.storePin(family.pin(listOf(family.r1, family.r2)))
        val phone = family.phone()
        accepted(phone)
        val mine = server.file(server.root, "Mine.txt", "my own plaintext".toByteArray())
        val personal = phone.vault.listChildren(server.root).single { it.id == mine }
        // A row of the family folder under the same id, as a hostile or colliding listing would leave it.
        val twin = personal.copy(node = personal.node.copy(workspaceId = family.workspaceId))
        phone.vault.nodes.put(twin, com.hushos.core.randomBytes(32u))
        assertEquals("the trap: by id alone, this account's own row", server.workspace, phone.vault.item(mine)?.node?.workspaceId)
        val cache = org.robolectric.RuntimeEnvironment.getApplication().cacheDir
        val destination = File(FamilyCopies.folder(cache, family.workspaceId)!!, "$mine/v/Mine.txt")
        runCatching { phone.vault.download(mine, destination, workspaceId = family.workspaceId) }
        assertFalse("the family row's download wrote the personal file", destination.exists() && destination.readText() == "my own plaintext")
        assertFalse(destination.exists())
        // An id the family's workspace doesn't hold at all is refused, never answered with the personal row.
        val other = server.file(server.root, "Other.txt", "also mine".toByteArray())
        phone.vault.listChildren(server.root)
        assertThrows(NotFound::class.java) { phone.vault.download(other, File(cache, "opened/x/Other.txt"), workspaceId = family.workspaceId) }
    }

    /*
     * Round 13, A: a family copy left from a workspace no family here holds (a record that lost track of it, a crash) is
     * deleted when the families start, before any family download, and again after a wipe. Fails if copy cleanup still
     * depends on a record naming the workspace.
     */
    @Test
    fun aCopyNoFamilyHoldsIsDeletedAtStartAndAfterAWipe() {
        val cache = org.robolectric.RuntimeEnvironment.getApplication().cacheDir
        fun stray() = File(cache, "opened/family/0a1b2c3d-0000-4000-8000-0000000000b9/node/v1/Old.txt").apply { parentFile!!.mkdirs(); writeText("plaintext") }
        val first = stray()
        family.storePin(family.pin(listOf(family.r1, family.r2)))
        val phone = family.phone()
        assertFalse("a copy no family holds survived the start", first.exists())
        accepted(phone)
        phone.vault.listChildren(family.rootId)
        val copy = File(FamilyCopies.folder(cache, family.workspaceId)!!, "${family.fileId}/v1/Recipes.txt")
        phone.vault.download(family.fileId, copy)
        val second = stray()
        family.notMember = true
        assertEquals(FamilyState.Wiped, phone.sync.sync(family.summary))
        assertFalse("a copy no family holds survived the wipe", second.exists())
        assertFalse(copy.exists())
    }

    /* Round 13, A: the copies of a family accepted now survive every sweep (a sync, a change of its folders, a sweep run alone). */
    @Test
    fun anAcceptedFamilysCopiesSurviveTheSweep() {
        family.storePin(family.pin(listOf(family.r1, family.r2)))
        val phone = family.phone()
        accepted(phone)
        phone.vault.listChildren(family.rootId)
        val cache = org.robolectric.RuntimeEnvironment.getApplication().cacheDir
        val copy = File(FamilyCopies.folder(cache, family.workspaceId)!!, "${family.fileId}/v1/Recipes.txt")
        phone.vault.download(family.fileId, copy)
        assertTrue(phone.sync.sync(family.summary) is FamilyState.Accepted)
        phone.sync.sweepCopies()
        assertTrue("an accepted family's copy was swept", copy.exists())
    }

    /* Round 13, A: a closed vault sweeps nothing: what is there may be the next session's. */
    @Test
    fun aClosedVaultSweepsNothing() {
        val phone = family.phone()
        phone.vault.close()
        val cache = org.robolectric.RuntimeEnvironment.getApplication().cacheDir
        val copy = File(cache, "opened/family/0a1b2c3d-0000-4000-8000-0000000000c9/node/v1/New.txt").apply { parentFile!!.mkdirs(); writeText("next session") }
        phone.vault.sweepFamilyCopies(emptySet())
        assertTrue("a closed vault swept the next session's copy", copy.exists())
    }

    /*
     * Round 12, item 1: a copy opened before the app closed; the family folder is deleted while it is closed; the app
     * starts again with nothing in memory. Its sync must still find the folder through the record (merged, never replaced
     * by what this process proved so far), forget its copy, and only then let the record go of it; a removal after
     * leaves nothing either. Fails if an acceptance after a relaunch replaces the record's folders.
     */
    @Test
    fun aFolderDeletedWhileTheAppWasClosedLeavesNoCopy() {
        family.storePin(family.pin(listOf(family.r1, family.r2)))
        val before = family.phone()
        accepted(before)
        before.vault.listChildren(family.rootId)
        val cache = org.robolectric.RuntimeEnvironment.getApplication().cacheDir
        val copy = File(FamilyCopies.folder(cache, family.workspaceId)!!, "${family.fileId}/v1/Recipes.txt")
        before.vault.download(family.fileId, copy)
        // Closed; the folder deleted elsewhere meanwhile; started again over the same records.
        family.areaListed = false
        val after = family.phone(before.folder)
        assertTrue(after.sync.sync(family.summary) is FamilyState.Accepted)
        assertFalse("the deleted folder's copy outlived the relaunch", copy.exists())
        assertEquals(emptyList<String>(), after.records.read(family.member.id, family.groupId)?.areas)
        family.notMember = true
        assertEquals(FamilyState.Wiped, after.sync.sync(family.summary))
        assertFalse(FamilyCopies.folder(cache, family.workspaceId)!!.exists())
    }

    /*
     * Round 12, item 2: two listings of the family folder answered out of order. The newer one (the file at its second
     * version) is opened first; the older one lands after and is opened too. The cache keeps the newer row and key, and a
     * download fetches the newer version; asked for the older version's id, it refuses rather than keep the wrong bytes.
     * Fails if an older answer replaces a newer cached row.
     */
    @Test
    fun anOlderAnswerLandingLastKeepsTheNewerRow() {
        family.storePin(family.pin(listOf(family.r1, family.r2)))
        val phone = family.phone()
        accepted(phone)
        val older = phone.vault.listChildren(family.rootId).single().node
        server.newVersion(family.fileId, "the second version".toByteArray())
        val newer = phone.vault.listChildren(family.rootId).single().node
        assertTrue(older.olderThan(newer))
        // The older listing's answer lands now.
        phone.vault.open(older)
        assertEquals("an older answer replaced the newer row", newer.currentVersion?.id, phone.vault.item(family.fileId)?.node?.currentVersion?.id)
        val cache = org.robolectric.RuntimeEnvironment.getApplication().cacheDir
        val copy = File(FamilyCopies.folder(cache, family.workspaceId)!!, "${family.fileId}/${newer.currentVersion!!.id}/Recipes.txt")
        phone.vault.download(family.fileId, copy, expectedVersionId = newer.currentVersion!!.id)
        assertEquals("the second version", copy.readText())
        val stale = File(FamilyCopies.folder(cache, family.workspaceId)!!, "${family.fileId}/${older.currentVersion!!.id}/Recipes.txt")
        assertThrows(Refused::class.java) { phone.vault.download(family.fileId, stale, expectedVersionId = older.currentVersion!!.id) }
        assertFalse(stale.exists())
    }

    /*
     * Round 11, item 2: the family folder is deleted elsewhere and route 25 stops listing it. Its opened copy goes then,
     * before the record lets go of it; after a relaunch and a removal, no copy of it is left anywhere. Fails if the tie
     * between a folder and its family is dropped before its plaintext is.
     */
    @Test
    fun aFolderTheFamilyStopsListingLeavesNoCopy() {
        family.storePin(family.pin(listOf(family.r1, family.r2)))
        val phone = family.phone()
        accepted(phone)
        phone.vault.listChildren(family.rootId)
        val cache = org.robolectric.RuntimeEnvironment.getApplication().cacheDir
        val copy = File(FamilyCopies.folder(cache, family.workspaceId)!!, "${family.fileId}/v1/Recipes.txt")
        phone.vault.download(family.fileId, copy)
        family.areaListed = false
        assertTrue(phone.sync.sync(family.summary) is FamilyState.Accepted)
        assertFalse("the dropped folder's copy outlived it", copy.exists())
        assertEquals(emptyList<String>(), phone.records.read(family.member.id, family.groupId)?.areas)
        val relaunched = family.phone(phone.folder)
        family.notMember = true
        assertEquals(FamilyState.Wiped, relaunched.sync.sync(family.summary))
        assertFalse(copy.exists())
        assertFalse(FamilyCopies.folder(cache, family.workspaceId)!!.exists())
    }

    /*
     * Round 11, item 3: a sync of the last session answers not-member after the account signed in again (its vault
     * closed). Its wipe deletes nothing the new session wrote: not the copy it opened, not the record it saved. Fails if a
     * closed vault's cleanup reaches the shared paths.
     */
    @Test
    fun aClosedVaultsWipeDeletesNothingTheNewSessionWrote() {
        family.storePin(family.pin(listOf(family.r1, family.r2)))
        val old = family.phone()
        accepted(old)
        old.vault.close()
        // Signed in again: a new vault, its own sync and copy, over the same records folder.
        val now = family.phone(old.folder)
        accepted(now)
        now.vault.listChildren(family.rootId)
        val cache = org.robolectric.RuntimeEnvironment.getApplication().cacheDir
        val copy = File(FamilyCopies.folder(cache, family.workspaceId)!!, "${family.fileId}/v1/Recipes.txt")
        now.vault.download(family.fileId, copy)
        // The old session's late not-member, wiped by its own sync.
        old.sync.wipe(family.groupId)
        assertTrue("the old session's wipe deleted the new session's copy", copy.exists())
        assertNotNull("the old session's wipe deleted the new session's record", now.records.read(family.member.id, family.groupId))
        assertNotNull(now.vault.item(family.rootId))
    }

    /*
     * Round 10, item 2: this phone holds a record for another family whose saved folders name this family's workspace
     * (its roster listed it). Wiping that other family leaves this family's rows, keys and opened copies alone; the
     * record this family keeps names only the folder proven its own. Fails if a roster's word lets one family clear another's.
     */
    @Test
    fun wipingAnotherFamilyLeavesThisFamilysFolder() {
        family.storePin(family.pin(listOf(family.r1, family.r2)))
        val phone = family.phone()
        accepted(phone)
        assertEquals(listOf(family.workspaceId), phone.records.read(family.member.id, family.groupId)?.areas)
        phone.vault.listChildren(family.rootId)
        val cache = org.robolectric.RuntimeEnvironment.getApplication().cacheDir
        val copy = File(FamilyCopies.folder(cache, family.workspaceId)!!, "${family.fileId}/v1/Recipes.txt")
        phone.vault.download(family.fileId, copy)
        val other = "0a1b2c3d-0000-4000-8000-0000000000a9"
        phone.records.put(family.member.id, other, FamilyRecords.Row("e30", 1uL, listOf(family.workspaceId)))
        phone.sync.wipe(other)
        assertTrue("the other family's wipe deleted this family's copy", copy.exists())
        assertNotNull("the other family's wipe dropped this family's rows", phone.vault.item(family.rootId))
        assertNotNull(phone.vault.nodes.key(family.workspaceId, family.rootId))
        assertEquals(1, phone.vault.listChildren(family.rootId).size)
    }

    /*
     * Round 9, item 1: the server replays older settings (a rollback) after the family was accepted. The sync is refused
     * before the core is asked, and the core must stop opening the family too: listing its folder afterwards is refused,
     * not answered through the chain the earlier sync committed. Fails if a refusal only clears the app's own caches.
     */
    @Test
    fun aSettingsRollbackStopsTheCoreOpeningTheFamily() {
        family.storePin(family.pin(listOf(family.r1, family.r2)))
        val older = server.settingsSnapshot()
        val phone = family.phone()
        accepted(phone)
        assertEquals(1, phone.vault.listChildren(family.rootId).size)
        // Another device saves; this phone reads it, then the server serves the copy from before.
        server.editSettings { }
        phone.vault.loadSettings()
        older()
        val state = phone.sync.sync(family.summary)
        assertTrue("$state", state is FamilyState.Failed && state.words != FamilyWords.NO_ANSWER)
        assertThrows("the refused family's folder was listed again", Exception::class.java) { phone.vault.listChildren(family.rootId) }
        assertNull(phone.vault.item(family.fileId))
    }

    /*
     * Round 9, item 3: a member check's own read of the member list (after its sync accepted) answers not-member, and so
     * does They match's. Either is a removal: the family is let go of in two phases and shown wiped, not only an error.
     */
    @Test
    fun aNotMemberDuringAMemberCheckWipesTheFamily() {
        family.storePin(family.pin(listOf(family.r1, family.r2)))
        val phone = family.phone()
        accepted(phone)
        val inner = server.extraRoutes!!
        // The sync reads from the record's version; the check's own read starts at version 1, and that one says not-member.
        server.extraRoutes = { method, segments, query, body ->
            if (method == "GET" && segments.joinToString("/") == "groups/${family.groupId}/rosters" && (query["after"] ?: "0") == "0")
                404 to JSONObject().put("code", "not-member").put("message", "You are not in this group.")
            else inner(method, segments, query, body)
        }
        val start = phone.sync.checkCode(family.summary, family.creator.id)
        assertEquals(FamilyState.Wiped, start.state)
        assertEquals(FamilyWords.NOT_IN_FAMILY, start.problem)
        assertNull(phone.records.read(family.member.id, family.groupId))
        assertNull(phone.vault.item(family.rootId))
        // They match on another phone of the account, still in the family: its own read says not-member too.
        val other = family.phone()
        family.storePin(family.pin(listOf(family.r1, family.r2)))
        server.extraRoutes = inner
        accepted(other)
        server.extraRoutes = { method, segments, query, body ->
            if (method == "GET" && segments.joinToString("/") == "groups/${family.groupId}/rosters" && (query["after"] ?: "0") == "0")
                404 to JSONObject().put("code", "not-member").put("message", "You are not in this group.")
            else inner(method, segments, query, body)
        }
        val refused = assertThrows(GroupsApiError::class.java) {
            other.sync.checkMatch(family.groupId, FamilyMemberRef(family.creator.id, "sam@example.org", "Sam Lindqvist"), 2uL, List(12) { "word" })
        }
        assertTrue(refused.isNotMember)
        assertNull(other.records.read(family.member.id, family.groupId))
    }

    /*
     * Round 8, item 1: the account signs out while a family download and a personal one wait on their versions'
     * addresses, holding their content keys. The vault closes, the account's copies are wiped, and then the answers come:
     * neither writes anything. Fails if a download's checks pass after its session ended.
     */
    @Test
    fun aSignOutDuringDownloadsLeavesNoFileAfterTheyResume() {
        family.storePin(family.pin(listOf(family.r1, family.r2)))
        val mine = server.file(server.root, "Mine.txt", "my own".toByteArray())
        val cache = org.robolectric.RuntimeEnvironment.getApplication().cacheDir
        val familyCopy = File(FamilyCopies.folder(cache, family.workspaceId)!!, "${family.fileId}/v1/Recipes.txt")
        val personalCopy = File(cache, "opened/$mine/v1/Mine.txt")
        // Each download in a session of its own, signed out while it waits.
        for ((id, destination) in listOf(family.fileId to familyCopy, mine to personalCopy)) {
            val phone = family.phone()
            if (id == family.fileId) { accepted(phone); phone.vault.listChildren(family.rootId) } else phone.vault.listChildren(server.root)
            val (waiting, release) = holdVersionUrl()
            var failure: Throwable? = null
            val download = kotlin.concurrent.thread { failure = runCatching { phone.vault.download(id, destination) }.exceptionOrNull() }
            assertTrue("the download never asked for its address", waiting.await(10, java.util.concurrent.TimeUnit.SECONDS))
            // Sign-out: the vault closes, then the account's copies are wiped (AccountStore.wipe).
            phone.vault.close()
            File(cache, "opened").deleteRecursively()
            release.countDown()
            download.join(10_000)
            assertNotNull("the download finished after the sign-out", failure)
            assertFalse("${destination.name} was written after the sign-out", destination.exists())
            assertFalse(File(destination.path + ".part").exists())
        }
        assertFalse("the family's folder came back", FamilyCopies.folder(cache, family.workspaceId)!!.exists())
    }

    /*
     * Round 8, item 2: a download from before a forget waits on its address while the family is let go of and opened
     * again, and a newer download of the same file is kept. The old one then resumes and fails with the family's words,
     * and the newer copy stays. Fails if a stale download's error path deletes what it didn't write.
     */
    @Test
    fun aStaleDownloadLeavesTheNewerCopyInPlace() {
        family.storePin(family.pin(listOf(family.r1, family.r2)))
        val phone = family.phone()
        accepted(phone)
        phone.vault.listChildren(family.rootId)
        val cache = org.robolectric.RuntimeEnvironment.getApplication().cacheDir
        val destination = File(FamilyCopies.folder(cache, family.workspaceId)!!, "${family.fileId}/v1/Recipes.txt")
        val (waiting, release) = holdVersionUrl()
        var failure: Throwable? = null
        val old = kotlin.concurrent.thread { failure = runCatching { phone.vault.download(family.fileId, destination) }.exceptionOrNull() }
        assertTrue(waiting.await(10, java.util.concurrent.TimeUnit.SECONDS))
        // Let go of (a refusal), then opened again by the next sync, and the file opened again.
        phone.vault.forgetWorkspaces(listOf(family.workspaceId))
        assertTrue(phone.sync.sync(family.summary) is FamilyState.Accepted)
        phone.vault.listChildren(family.rootId)
        phone.vault.download(family.fileId, destination)
        assertEquals("marker-family", destination.readText())
        release.countDown()
        old.join(10_000)
        assertEquals(FamilyWords.OPEN_AGAIN, FamilyWords.error(failure ?: throw AssertionError("the stale download finished")))
        assertTrue("the stale download deleted the newer copy", destination.exists())
        assertEquals("marker-family", destination.readText())
    }

    /*
     * Round 8, item 3: the rosters answer and the family is accepted, then route 3 (the member list's names) says
     * not-member. That is a removal: the family is wiped, not shown accepted with its keys, rows and copies kept.
     */
    @Test
    fun aNotMemberFromTheMemberListWipesTheFamily() {
        family.storePin(family.pin(listOf(family.r1, family.r2)))
        val phone = family.phone()
        accepted(phone)
        phone.vault.listChildren(family.rootId)
        val inner = server.extraRoutes!!
        server.extraRoutes = { method, segments, query, body ->
            if (method == "GET" && segments.joinToString("/") == "groups/${family.groupId}") 404 to JSONObject().put("code", "not-member").put("message", "You are not in this group.")
            else inner(method, segments, query, body)
        }
        assertEquals(FamilyState.Wiped, phone.sync.sync(family.summary))
        assertNull(phone.records.read(family.member.id, family.groupId))
        assertNull(phone.vault.item(family.fileId))
        assertNull(phone.vault.item(family.rootId))
    }

    /*
     * Round 7, item 1: a file's row is being opened through the ledger, which has handed over its key, when the family's
     * check finds a fork and clears the folder. The open then resumes: it keeps neither the row nor the key, and asking for
     * the file afterwards is refused rather than answered from the cache. Fails if an open puts back what a forget cleared.
     */
    @Test
    fun anOpenThatResumesAfterAForkKeepsNothing() {
        family.chain = listOf(family.r1, family.r2, family.r3)
        family.storePin(family.pin(listOf(family.r1, family.r2)))
        val phone = family.phone()
        accepted(phone)
        family.chain = listOf(family.r1, family.r2, family.r3Fork, family.r4Fork)
        var forked: FamilyState? = null
        phone.vault.afterFamilyOpen = { if (forked == null) forked = phone.sync.sync(family.summary) }
        assertThrows(Exception::class.java) { phone.vault.listChildren(family.rootId) }
        assertTrue("$forked", forked is FamilyState.Fork)
        phone.vault.afterFamilyOpen = null
        assertNull("the opened row came back after the fork", phone.vault.item(family.fileId))
        assertNull(phone.vault.nodes.key(family.workspaceId, family.fileId))
        assertThrows(Exception::class.java) { phone.vault.resolve(family.fileId) }
    }

    /*
     * Round 6, item 2: a family file's download is waiting on its version's address when the server says not-member and
     * the phone wipes the family. The download already holds the content key; it must not make the folder, write the
     * plaintext or keep the file afterwards, and it reports the family's words. Fails if the download writes after the wipe.
     */
    @Test
    fun aRemovalDuringADownloadLeavesNoFileAndHandsOffNothing() {
        family.storePin(family.pin(listOf(family.r1, family.r2)))
        val phone = family.phone()
        accepted(phone)
        phone.vault.listChildren(family.rootId)
        val cache = org.robolectric.RuntimeEnvironment.getApplication().cacheDir
        val folder = FamilyCopies.folder(cache, family.workspaceId)!!
        val destination = File(folder, "${family.fileId}/v1/Recipes.txt")
        val waiting = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1)
        server.beforeAnswer = { method, path ->
            if (method == "GET" && path.startsWith("drive/versions/") && path.endsWith("/url")) {
                waiting.countDown()
                release.await(10, java.util.concurrent.TimeUnit.SECONDS)
            }
        }
        var failure: Throwable? = null
        val download = kotlin.concurrent.thread { failure = runCatching { phone.vault.download(family.fileId, destination) }.exceptionOrNull() }
        assertTrue("the download never asked for its address", waiting.await(10, java.util.concurrent.TimeUnit.SECONDS))
        family.notMember = true
        assertEquals(FamilyState.Wiped, phone.sync.sync(family.summary))
        release.countDown()
        download.join(10_000)
        assertFalse("the plaintext was written after the wipe", destination.exists())
        assertFalse(File(destination.path + ".part").exists())
        assertFalse("the family's folder came back", folder.exists())
        assertEquals(FamilyWords.NOT_IN_FAMILY, FamilyWords.error(failure ?: throw AssertionError("the download finished after the wipe")))
    }

    /*
     * A family file opened in an earlier session (a copy under the cache, younger than the day the startup sweep waits),
     * then the app relaunched and the server says not-member: the copy goes with the family, whatever this session saw,
     * and a personal copy beside it stays. Fails if the wipe only removes what this session opened.
     */
    @Test
    fun aCopyOpenedInAnEarlierSessionGoesWhenTheFamilyIsRemoved() {
        family.storePin(family.pin(listOf(family.r1, family.r2)))
        val first = family.phone()
        accepted(first)
        val cache = org.robolectric.RuntimeEnvironment.getApplication().cacheDir
        val copy = File(FamilyCopies.folder(cache, family.workspaceId)!!, "${family.fileId}/v1/Recipes.txt").apply { parentFile!!.mkdirs(); writeText("plaintext") }
        val personal = File(cache, "opened/personal-node/v1/mine.txt").apply { parentFile!!.mkdirs(); writeText("mine") }
        val relaunched = family.phone(first.folder)
        family.notMember = true
        assertEquals(FamilyState.Wiped, relaunched.sync.sync(family.summary))
        assertFalse(copy.exists())
        assertFalse(FamilyCopies.folder(cache, family.workspaceId)!!.exists())
        assertTrue(personal.exists())
    }

    /* A record is never written over one at a later roster version (an acceptance that finished late). */
    @Test
    fun aLateRecordNeverReplacesALaterOne() {
        val records = FamilyRecords(File(org.robolectric.RuntimeEnvironment.getApplication().cacheDir, "late-" + System.nanoTime()))
        assertTrue(records.put(family.member.id, family.groupId, FamilyRecords.Row("at-3", 3uL, emptyList())))
        assertFalse(records.put(family.member.id, family.groupId, FamilyRecords.Row("at-2", 2uL, emptyList())))
        assertEquals("at-3", records.read(family.member.id, family.groupId)?.envelope)
    }

    /*
     * Family folders are read only on Android until 6c: every change there is refused before anything is sent, after a
     * sync accepted the family (so the ledger would hand out keys). Fails if any write path misses the gate.
     */
    @Test
    fun everyChangeInAFamilyFolderIsRefusedBeforeAnythingIsSent() {
        family.storePin(family.pin(listOf(family.r1, family.r2)))
        val phone = family.phone()
        accepted(phone)
        val vault = phone.vault
        val file = vault.listChildren(family.rootId).single()
        val root = vault.resolve(family.rootId)
        val sent = server.requests.size
        val local = File.createTempFile("photo", ".jpg").apply { writeText("bytes") }
        val writes: List<() -> Unit> = listOf(
            { vault.createFolder(family.rootId, "New") }, { vault.rename(file.id, "Other.txt") }, { vault.trash(file.id) },
            { vault.move(file.id, family.rootId) }, { vault.copy(file.id, family.rootId) }, { vault.copy(file.id, server.root) },
            { vault.copyAcross(file.id, server.root) }, { vault.upload(local, "photo.jpg", "image/jpeg", family.rootId, null) },
            { vault.upload(local, "Recipes.txt", "text/plain", family.rootId, file) }, { vault.keepDownloaded(file) }, { vault.keepFolder(root) },
            { vault.createLink(file, null, null) }, { vault.report(file, "spam", "", null) }, { vault.rotate(root) },
            { vault.share(file, ContactPin.of(family.creator.id, "sam@example.org", "Sam", com.hushos.core.PinKeys(1uL, "a", "b", null, null, ""), "", null), "viewer") },
            { kotlinx.coroutines.runBlocking { vault.trashMany(listOf(file.id)) } },
            { vault.restore(TrashItem(file, false)) },
        )
        for (write in writes) assertThrows(FamilyReadOnly::class.java) { write() }
        assertEquals("nothing was sent", emptyList<String>(), server.requests.drop(sent).filter { !it.startsWith("GET") })
    }

    /*
     * Removed on another device: route 2 stops listing the family and route 5 answers not-member. The phone drops it
     * without a relaunch, and doesn't ask again. Fails if a family route 2 no longer lists is never asked about.
     */
    @Test
    fun aFamilyNoLongerListedAndNotMemberIsWiped() {
        family.storePin(family.pin(listOf(family.r1, family.r2)))
        val phone = family.phone()
        accepted(phone)
        phone.vault.listChildren(family.rootId)
        family.listed = false
        family.notMember = true
        val (listed, removed) = phone.sync.listReconciling()
        assertTrue(listed.isEmpty())
        assertEquals(listOf(family.groupId), removed.map { it.groupId })
        assertNull(phone.records.read(family.member.id, family.groupId))
        assertFalse(phone.vault.areaLedger.isArea(family.workspaceId))
        assertNull(phone.vault.item(family.fileId))
        family.asked.clear()
        assertTrue(phone.sync.listReconciling().second.isEmpty())
        assertFalse(family.asked.any { it.contains("/rosters") })
    }

    /* Route 2 fails, or route 5 answers a 503: nothing is taken away. Only not-member is a removal. */
    @Test
    fun aListOrAnAnswerThatFailsWipesNothing() {
        family.storePin(family.pin(listOf(family.r1, family.r2)))
        val phone = family.phone()
        accepted(phone)
        family.groupsFail = true
        family.notMember = true
        assertThrows(GroupsApiError::class.java) { phone.sync.listReconciling() }
        assertNotNull(phone.records.read(family.member.id, family.groupId))
        assertTrue(phone.vault.areaLedger.isArea(family.workspaceId))
        family.groupsFail = false
        family.notMember = false
        family.listed = false
        family.rostersFail = true
        assertTrue(phone.sync.listReconciling().second.isEmpty())
        assertNotNull(phone.records.read(family.member.id, family.groupId))
        assertTrue(phone.vault.areaLedger.isArea(family.workspaceId))
    }

    /* Route 2 stops listing the family but route 5 still serves it: a race, never a removal. */
    @Test
    fun aFamilyUnlistedButStillServedIsKept() {
        family.storePin(family.pin(listOf(family.r1, family.r2)))
        val phone = family.phone()
        accepted(phone)
        family.listed = false
        assertTrue(phone.sync.listReconciling().second.isEmpty())
        assertNotNull(phone.records.read(family.member.id, family.groupId))
        assertEquals(listOf("Recipes.txt"), phone.vault.listChildren(family.rootId).map { it.name })
    }

    /*
     * The family check records and the marker another client wrote (a check with its words, a `before` record, fields this
     * version doesn't know, odd text) come back exactly as they were from a save of the group pin, and no record is added
     * for a family that has one: Android edits the JSON in place. Fails if a save rebuilds the records or the marker.
     */
    @Test
    fun familyChecksAndTheMarkerAreKeptAsTheyWereThroughASave() {
        val other = "0a1b2c3d-0000-4000-8000-000000000001"
        val third = "0a1b2c3d-0000-4000-8000-000000000003"
        val checks = JSONObject()
            .put(third, JSONObject().put("rosterVersion", 1).put("with", family.creator.id).put("code", org.json.JSONArray(listOf("ocean", "cliff", "état/über 😀")))
                .put("checkedAt", "2026-10-26T10:00:00.000Z").put("zz-later", JSONObject().put("nested", org.json.JSONArray(listOf(1, true, JSONObject.NULL)))))
            .put(other, JSONObject().put("rosterVersion", 9007199254740991L).put("how", "before").put("checkedAt", "2026-10-25T00:00:00.000Z"))
        server.editSettings {
            it.json.put("familyChecks", checks).put("familyChecksSince", "2026-10-25T00:00:00.000Z").put("aLaterClientsField", JSONObject().put("x", 1.5))
            it.setGroupPin(family.groupId, family.pin(listOf(family.r1)))
        }
        val before = server.settings().json
        val phone = family.phone()
        accepted(phone)
        val after = server.settings().json
        assertEquals(2uL, server.settings().groupPin(family.groupId)?.rosterVersion)
        // A first-use family (the marker set, no record of its own) gets no record from a sync's save either.
        assertEquals(before.getJSONObject("familyChecks").toString(), after.getJSONObject("familyChecks").toString())
        assertEquals(before.getString("familyChecksSince"), after.getString("familyChecksSince"))
        assertEquals(before.getJSONObject("aLaterClientsField").toString(), after.getJSONObject("aLaterClientsField").toString())
    }

    /* The same rule from a family that never had a marker: the first save adds it and a `before` record at that pin's roster. */
    @Test
    fun theFirstSaveAddsTheMarkerAndBeforeRecordsForPinsAlreadyThere() {
        val older = "0a1b2c3d-0000-4000-8000-000000000002"
        val olderPin = JSONObject().put("rosterVersion", 4).put("anything", "kept")
        server.editSettings {
            it.json.put("groups", JSONObject().put(older, olderPin))
            it.setGroupPin(family.groupId, family.pin(listOf(family.r1)))
        }
        val phone = family.phone()
        accepted(phone)
        val after = server.settings().json
        assertTrue(after.has("familyChecksSince"))
        val record = after.getJSONObject("familyChecks").getJSONObject(older)
        assertEquals(4, record.getInt("rosterVersion"))
        assertEquals("before", record.getString("how"))
        assertTrue(after.getJSONObject("familyChecks").getJSONObject(family.groupId).getString("how") == "before")
        assertEquals(olderPin.toString(), after.getJSONObject("groups").getJSONObject(older).toString())
    }
}
