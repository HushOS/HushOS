package com.hushos.app.data

import com.hushos.core.MemberStatus
import com.hushos.core.base64urlDecode
import com.hushos.core.rosterParse
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/*
 * A manager's calls that give family folders new keys, on a phone (Android 5b; the web's removal.ts and outbox.ts): Remove
 * from family, marking the departed left, a folder's key replacement and Delete family folder, through the real Vault,
 * GroupsApi and the core's area ledger against FakeDrive serving rosters the core signs. Maya manages the Lindqvist family
 * and lets Grace in first; every call is the core's, kept before it is sent and sent again byte for byte, or rebuilt under
 * the same roster and keys when the server says a folder moved.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class FamilyRemovalTest {
    private val server = FakeDrive()
    private lateinit var family: FamilyFixture

    @Before
    fun signIn() {
        FamilyFixture.allowPatch()
        FamilyFixture.signIn(server, "family-removal-test")
        family = FamilyFixture(server)
    }

    @After
    fun close() {
        server.close()
        assertEquals("routes the fake does not serve", emptyList<String>(), server.unknown)
    }

    private val summary get() = family.summary
    private val graceId get() = server.grace.id.lowercase()
    private val mayaId get() = family.member.id.lowercase()
    private val samId get() = family.creator.id.lowercase()

    /* Maya's phone, the family as she manages it, and Grace let in by her: a member list of four. */
    private fun phone(folder: java.io.File? = null): FamilyFixture.Phone {
        if (folder == null) {
            family.storePin(family.pin(family.mayaManages()))
            family.waiting(server.grace, "grace@example.org", "Grace Hopper")
        }
        val phone = if (folder == null) family.phone() else family.phone(folder)
        assertTrue(phone.sync.sync(summary) is FamilyState.Accepted)
        if (folder == null) {
            assertEquals(LetIn.Landed, phone.sync.letIn(summary, family.pendingRows.map(PendingPerson::from).single()))
            family.callBodies.clear()
        }
        return phone
    }

    private fun view(phone: FamilyFixture.Phone) = (phone.sync.sync(summary) as FamilyState.Accepted).view
    private fun kept(phone: FamilyFixture.Phone) = phone.sync.outbox.list(family.member.id, family.groupId)
    private fun remove(phone: FamilyFixture.Phone, endsLapsed: List<String> = emptyList(), steps: MutableList<RemovalStep> = ArrayList()) =
        phone.sync.removeMember(summary, graceId, "Grace", endsLapsed = endsLapsed) { steps.add(it) }
    private fun bodies(kind: String) = family.rotatingCalls.filter { it.first == kind }.map { JSONObject(it.second) }
    private fun roster(body: JSONObject) = rosterParse(base64urlDecode(body.getJSONObject("roster").getString("statement")))
    private fun rotation(body: JSONObject) = (body.optJSONArray("rotations")?.getJSONObject(0) ?: body.getJSONObject("rotation"))
    private fun grantees(body: JSONObject): Set<String> = body.optJSONArray("grants")?.let { list ->
        (0 until list.length()).map { list.getJSONObject(it).getString("granteeUserId").lowercase() }.toSet()
    }.orEmpty()
    private fun refuse(code: String, data: JSONObject = JSONObject()) = 409 to JSONObject().put("code", code).put("message", "Refused.").put("data", data)

    /*
     * Remove from family: the hold first, then one call that marks Grace left, gives the family folder new keys (granted
     * to Sam and Maya, never Grace; Maya's self-grant of the new key), and the phone then opens the folder at its new key.
     * Fails if the person removed is granted the new key, or the folder is left on the key they hold.
     */
    @Test
    fun aRemovalRotatesTheFolderAndGrantsTheNewKeyOnlyToThoseWhoStay() {
        val phone = phone()
        val steps = ArrayList<RemovalStep>()
        assertEquals(RemovalEnd.Removed, remove(phone, steps = steps))
        assertEquals(listOf(RemovalStep.HOLD, RemovalStep.REMOVE), steps)
        val body = bodies("remove").single()
        assertEquals(setOf(samId, mayaId), grantees(body))
        val wire = rotation(body)
        assertEquals(family.workspaceId, wire.getString("workspaceId"))
        assertEquals(2, wire.getInt("toVersion"))
        assertEquals(2, wire.getJSONObject("selfGrant").getInt("workspaceKeyVersion"))
        val left = roster(body).members.single { it.userId == graceId }
        assertEquals(MemberStatus.LEFT, left.status)
        val now = view(phone)
        assertFalse(now.members.any { it.userId.equals(graceId, ignoreCase = true) })
        assertTrue("the folder opens at its new key", now.areas.single().opened && now.areas.single().rootListed)
        assertTrue(kept(phone).isEmpty())
    }

    /*
     * The hold comes before anything is gathered or sent, and is placed again right before the folders are read. Fails if
     * the person could still draw an epoch or start a walk while the removal is built.
     */
    @Test
    fun theHoldIsPlacedBeforeTheFoldersAreRead() {
        val phone = phone()
        server.requests.clear()
        family.asked.clear()
        assertEquals(RemovalEnd.Removed, remove(phone))
        val order = family.asked.filter { it.endsWith("/hold") || it.endsWith("/root") || it.endsWith("/remove") }
        assertTrue(order.toString(), order.first().endsWith("/hold"))
        val lastHold = order.indexOfLast { it.endsWith("/hold") }
        assertTrue(order.toString(), lastHold < order.indexOfFirst { it.endsWith("/root") })
        assertEquals(listOf(graceId, graceId), family.holdsAsked)
    }

    /*
     * Someone else holds Maya (route 27 answers `held`): nothing is gathered, signed or sent, and the holder is named only
     * as route 3 names them. Fails if a removal goes on, or blames a guess.
     */
    @Test
    fun aHeldManagerSendsNothingAndNamesOnlyWhomRouteThreeNames() {
        val phone = phone()
        family.holdAnswer = refuse("held")
        family.holdRows.add(JSONObject().put("userId", mayaId).put("heldBy", samId).put("expiresAt", "2026-11-03T12:00:00.000Z"))
        assertEquals(RemovalEnd.Held(samId, targetManages = false), remove(phone))
        assertTrue(family.rotatingCalls.isEmpty())
        assertTrue(kept(phone).isEmpty())
        family.holdRows.clear()
        assertEquals(RemovalEnd.Held(null, targetManages = false), remove(phone))
    }

    /*
     * A plan Grace pays for that gives nothing ends with her removal: asked first, before any hold; once confirmed by id,
     * the removal goes on and carries what was confirmed. Fails if a plan is ended unasked, or a hold placed before asking.
     */
    @Test
    fun aLapsedPlanIsAskedAboutBeforeAnythingChanges() {
        val phone = phone()
        family.previewPlans = JSONArray().put(JSONObject().put("id", "plan-1").put("name", "Family Pro (monthly)").put("standing", "paused"))
        val asked = remove(phone)
        assertEquals(RemovalEnd.EndsLapsed(listOf(FamilyLapsedPlan("plan-1", "Family Pro (monthly)", true))), asked)
        assertTrue(family.holdsAsked.isEmpty())
        assertTrue(family.rotatingCalls.isEmpty())
        assertEquals(RemovalEnd.Removed, remove(phone, endsLapsed = listOf("plan-1")))
        assertEquals("plan-1", bodies("remove").single().getJSONArray("endsLapsed").getString(0))
    }

    /*
     * No answer three times: kept. Pressed again: the kept removal goes again, byte for byte, and lands; nothing new is
     * signed. Fails if a second removal (with its own new keys) is built beside one that may still land.
     */
    @Test
    fun pressingAgainWhileUnansweredSendsTheKeptRemoval() {
        val phone = phone()
        repeat(3) { family.rotatingAnswers.add { _, _ -> 503 to JSONObject().put("message", "Unavailable.") } }
        assertTrue(remove(phone) is RemovalEnd.Pending)
        assertEquals(1, kept(phone).size)
        assertEquals(RemovalEnd.Removed, remove(phone))
        assertEquals(4, family.rotatingCalls.size)
        assertEquals(1, family.rotatingCalls.map { it.second }.toSet().size)
    }

    /* Kept unanswered, the app killed; on relaunch the kept removal is sent as it was. Fails if a kept removal is lost or re-signed. */
    @Test
    fun aKeptRemovalSurvivesAKillAndARelaunch() {
        val first = phone()
        repeat(3) { family.rotatingAnswers.add { _, _ -> 503 to JSONObject().put("message", "Unavailable.") } }
        assertTrue(remove(first) is RemovalEnd.Pending)
        val next = phone(first.folder)
        assertEquals(listOf(CallEnd.Landed), next.sync.resumeOutbox(summary).values.toList())
        assertEquals(1, family.rotatingCalls.map { it.second }.toSet().size)
        assertFalse(view(next).members.any { it.userId.equals(graceId, ignoreCase = true) })
    }

    /*
     * `epoch-stale`: the folder is gathered again and the call's rotation made again under a new target, with the very
     * same roster, grants and self-grant (the same keys), kept, then sent. Fails if the bytes are only resent (refused
     * forever), or the call is signed again with new keys.
     */
    @Test
    fun anOvertakenEpochRebuildsTheRotationUnderTheSameRosterAndKeys() {
        val phone = phone()
        family.rotatingAnswers.add { _, _ -> refuse("epoch-stale") }
        assertEquals(RemovalEnd.Removed, remove(phone))
        val (first, second) = bodies("remove")
        assertEquals(first.getJSONObject("roster").toString(), second.getJSONObject("roster").toString())
        assertEquals(first.getJSONArray("grants").toString(), second.getJSONArray("grants").toString())
        assertEquals(rotation(first).getJSONObject("selfGrant").toString(), rotation(second).getJSONObject("selfGrant").toString())
        assertNotEquals(rotation(first).getLong("targetEpoch"), rotation(second).getLong("targetEpoch"))
    }

    /*
     * `document-stale`: a member wrote the folder's tags after it was read; the named document is read again and sealed for
     * its next version under the same new key. Fails if a stale document is resent (refused forever) or left out.
     */
    @Test
    fun aStaleDocumentIsReadAgainAndSealedForItsNextVersion() {
        val phone = phone()
        family.documents["tags"] = 1 to com.hushos.core.base64urlEncode(ByteArray(80) { 7 })
        family.rotatingAnswers.add { _, _ ->
            family.documents["tags"] = 2 to com.hushos.core.base64urlEncode(ByteArray(80) { 8 })
            refuse("document-stale", JSONObject().put("workspaceId", family.workspaceId).put("kind", "tags")
                .put("stale", JSONArray().put(JSONObject().put("workspaceId", family.workspaceId).put("kind", "tags"))))
        }
        // The tags this phone was served never open (junk): read again once, then carried on empty, and said.
        assertEquals(RemovalEnd.Removed, remove(phone))
        assertEquals(listOf(clearedWords("tags")), phone.sync.takeCleared())
        val (first, second) = bodies("remove")
        assertEquals(1, rotation(first).getJSONArray("documents").getJSONObject(0).getInt("version"))
        assertEquals(2, rotation(second).getJSONArray("documents").getJSONObject(0).getInt("version"))
        assertEquals(first.getJSONObject("roster").toString(), second.getJSONObject("roster").toString())
        assertEquals(3, family.documents.getValue("tags").first)
    }

    /*
     * 409 `left-due`: Ada left and isn't marked left yet. The phone marks her left first (route 7, the folder rotated),
     * then builds the removal again over that and it lands. Fails if the removal stops at left-due, or marks someone else.
     */
    @Test
    fun leftDueIsFinishedOnThePhoneThenTheRemovalGoesOn() {
        val phone = phone()
        val ada = server.another("ada@example.org", "Ada Lovelace")
        family.waiting(ada, "ada@example.org", "Ada Lovelace")
        assertEquals(LetIn.Landed, phone.sync.letIn(summary, family.pendingRows.map(PendingPerson::from).single()))
        val adaId = ada.id.lowercase()
        family.rotatingAnswers.add { _, _ -> refuse("left-due", JSONObject().put("userIds", JSONArray().put(adaId))) }
        assertEquals(RemovalEnd.Removed, remove(phone))
        assertEquals(listOf("remove", "rosters", "remove"), family.rotatingCalls.map { it.first })
        val marked = roster(bodies("rosters").single())
        assertEquals(MemberStatus.LEFT, marked.members.single { it.userId == adaId }.status)
        assertEquals(MemberStatus.ACTIVE, marked.members.single { it.userId == graceId }.status)
        val members = view(phone).members.map { it.userId.lowercase() }
        assertFalse(adaId in members || graceId in members)
    }

    /*
     * Route 3 says Grace left and isn't marked left: a manager's phone marks her left at the next open, every folder
     * rotated, and nothing is due after. Fails if a phone leaves the family blocked until someone opens the web.
     */
    @Test
    fun aManagersPhoneMarksTheDepartedLeftAtTheNextOpen() {
        val phone = phone()
        family.dueMarkLeft = listOf(graceId)
        val done = phone.sync.runDue(summary)
        assertTrue(done.markedLeft)
        val body = bodies("rosters").single()
        assertEquals(MemberStatus.LEFT, roster(body).members.single { it.userId == graceId }.status)
        assertEquals(setOf(samId, mayaId), grantees(body))
        assertTrue(family.dueMarkLeft.isEmpty())
        assertEquals(DueDone(), phone.sync.runDue(summary))
    }

    /*
     * Route 3 says the folder is owed new keys (a share or link stopped there): its key is replaced (route 24), granted to
     * every member. Fails if a folder owed new keys keeps the old one.
     */
    @Test
    fun aFolderOwedNewKeysGetsThemAtTheNextOpen() {
        val phone = phone()
        family.dueRotations = listOf(family.workspaceId)
        assertEquals(1, phone.sync.runDue(summary).rotated)
        val body = bodies("rotations").single()
        assertEquals(setOf(samId, mayaId, graceId), grantees(body))
        assertEquals(2, body.getJSONObject("rotation").getInt("toVersion"))
        assertTrue(view(phone).areas.single().opened)
    }

    /*
     * Delete family folder: one roster with the folder's tombstone and nothing else (no key, grant or rotation), and the
     * folder leaves the family. Fails if a deletion lists a key, rotates anything or grants it to anyone.
     */
    @Test
    fun aDeletionCarriesOneTombstoneAndNothingElse() {
        val phone = phone()
        assertEquals(FolderEnd.Landed, phone.sync.deleteFolder(summary, family.workspaceId))
        val body = bodies("delete").single()
        val rows = roster(body).areas
        assertEquals(1, rows.size)
        assertTrue(rows.single().retired && rows.single().workspaceId == family.workspaceId)
        assertFalse(body.has("grants") || body.has("rotation") || body.has("rotations"))
        assertTrue(view(phone).areas.isEmpty())
    }

    /*
     * Codex #281 1: a removal kept unanswered, then the next open's due work (a folder owed new keys) while the server still
     * doesn't answer: the kept removal goes first and, still unanswered, nothing new is staged (DueDone.deferred). Answered, it
     * lands, and its rotation was what was due. Fails if a due roster overtakes a kept removal, leaving the person in.
     */
    @Test
    fun dueWorkWaitsWhileAKeptRemovalIsUnresolved() {
        val phone = phone()
        repeat(6) { family.rotatingAnswers.add { _, _ -> 503 to JSONObject().put("message", "Unavailable.") } }
        assertTrue(remove(phone) is RemovalEnd.Pending)
        family.dueRotations = listOf(family.workspaceId)
        assertTrue(phone.sync.runDue(summary).deferred)
        assertTrue(bodies("rotations").isEmpty())
        assertEquals(listOf(CallEnd.Landed), phone.sync.resumeOutbox(summary).values.toList())
        assertFalse(view(phone).members.any { it.userId.equals(graceId, ignoreCase = true) })
        assertEquals(DueDone(), phone.sync.runDue(summary))
        assertTrue(bodies("rotations").isEmpty())
    }

    /*
     * Codex #281 round 2, 1: a removal kept unanswered holds every new call back, whatever it is (here a folder's deletion),
     * after a relaunch too: while it is unanswered the deletion is refused and nothing of it sent; answered, the removal goes
     * first and lands, then the deletion. Fails if any call is staged over a kept one (the removal would be dropped as
     * overtaken and its person stay in the family).
     */
    @Test
    fun aKeptRemovalHoldsEveryNewCallBackAndGoesFirstAfterARelaunch() {
        val first = phone()
        repeat(6) { family.rotatingAnswers.add { _, _ -> 503 to JSONObject().put("message", "Unavailable.") } }
        assertTrue(remove(first) is RemovalEnd.Pending)
        assertEquals(FolderEnd.Refused(earlierWaiting(summary.name)), first.sync.deleteFolder(summary, family.workspaceId))
        assertTrue(bodies("delete").isEmpty())
        assertEquals(1, kept(first).size)
        val next = phone(first.folder)
        assertEquals(FolderEnd.Landed, next.sync.deleteFolder(summary, family.workspaceId))
        assertTrue(family.rotatingCalls.indexOfLast { it.first == "remove" } < family.rotatingCalls.indexOfFirst { it.first == "delete" })
        val now = view(next)
        assertFalse(now.members.any { it.userId.equals(graceId, ignoreCase = true) })
        assertTrue(now.areas.isEmpty())
    }

    /*
     * Codex #281 round 2, 2: the folder's tags don't open when the removal is staged, and reading them again fails (the
     * process could as well have died there): the entry is kept marked for its recheck, never sendable as it is. After a
     * relaunch the resume reads them again first, notes what still didn't open, then sends; it lands and says so. Fails if
     * an entry carrying emptied documents is sent without the read-again and its word.
     */
    @Test
    fun anEntryWithEmptiedDocumentsIsNeverSentBeforeItsRecheckAfterARelaunch() {
        val first = phone()
        family.documents["tags"] = 1 to com.hushos.core.base64urlEncode(ByteArray(80) { 7 })
        family.documentsFailFrom = 2
        assertTrue(runCatching { remove(first) }.isFailure)
        assertEquals(1, kept(first).size)
        assertTrue(bodies("remove").isEmpty())
        family.documentsFailFrom = Int.MAX_VALUE
        val reads = family.documentReads.get()
        val next = phone(first.folder)
        assertEquals(listOf(CallEnd.Landed), next.sync.resumeOutbox(summary).values.toList())
        assertEquals("read again before it was sent", reads + 1, family.documentReads.get())
        assertEquals(listOf(clearedWords("tags")), next.sync.takeCleared())
        assertFalse(view(next).members.any { it.userId.equals(graceId, ignoreCase = true) })
    }

    /*
     * Codex #281 round 2, 3: removing Grace meets `left-due` for Ada, and marking Ada left gets no answer. Grace's removal is
     * kept as an intent on the phone; after a relaunch the resume sends the kept mark-left, then goes on with Grace's removal,
     * which lands. Fails if "remove Grace next time" lives only in a return value and dies with the process.
     */
    @Test
    fun aRemovalStoppedByADepartureGoesOnAfterARelaunch() {
        val first = phone()
        val ada = server.another("ada@example.org", "Ada Lovelace")
        family.waiting(ada, "ada@example.org", "Ada Lovelace")
        assertEquals(LetIn.Landed, first.sync.letIn(summary, family.pendingRows.map(PendingPerson::from).single()))
        val adaId = ada.id.lowercase()
        family.rotatingAnswers.add { _, _ -> refuse("left-due", JSONObject().put("userIds", JSONArray().put(adaId))) }
        repeat(3) { family.rotatingAnswers.add { _, _ -> 503 to JSONObject().put("message", "Unavailable.") } }
        assertTrue(remove(first) is RemovalEnd.Pending)
        assertEquals(listOf(graceId), first.sync.outbox.removals(family.member.id, family.groupId).map { it.userId })
        val next = phone(first.folder)
        val continued = ArrayList<Pair<String, RemovalEnd>>()
        next.sync.resumeOutbox(summary, continued = { removal, end -> continued.add(removal.userId to end) })
        assertEquals(listOf(graceId to RemovalEnd.Removed), continued)
        val members = view(next).members.map { it.userId.lowercase() }
        assertFalse(adaId in members || graceId in members)
        assertTrue(next.sync.outbox.removals(family.member.id, family.groupId).isEmpty())
    }

    /*
     * Codex #281 2: the folder's tags open when first read; a member writes junk over them before the call is sent
     * (`document-stale`). The rebuild reads them again once more, carries them on empty, and the note is kept with the entry:
     * after no answer and a relaunch, the resumed call lands and says the tags started again empty. Fails if a document that
     * didn't open in a rebuild is emptied without a second read or a word.
     */
    @Test
    fun aDocumentClearedInARebuildIsReadAgainAndSaidWhenItLandsAfterARelaunch() {
        val first = phone()
        family.documents["tags"] = 1 to family.sealedTags(1, """{"version":2,"tags":[{"id":"t1","name":"Recipes"}],"items":{}}""")
        family.rotatingAnswers.add { _, _ ->
            family.documents["tags"] = 2 to com.hushos.core.base64urlEncode(ByteArray(80) { 9 })
            refuse("document-stale", JSONObject().put("workspaceId", family.workspaceId).put("kind", "tags")
                .put("stale", JSONArray().put(JSONObject().put("workspaceId", family.workspaceId).put("kind", "tags"))))
        }
        repeat(3) { family.rotatingAnswers.add { _, _ -> 503 to JSONObject().put("message", "Unavailable.") } }
        server.requests.clear()
        assertTrue(remove(first) is RemovalEnd.Pending)
        // Read when gathered, read in the rebuild, and read once more when it didn't open there.
        assertEquals(3, server.requests.count { it.contains("/documents/tags") })
        assertTrue("nothing said before it lands", first.sync.takeCleared().isEmpty())
        val next = phone(first.folder)
        assertEquals(listOf(CallEnd.Landed), next.sync.resumeOutbox(summary).values.toList())
        assertEquals(listOf(clearedWords("tags")), next.sync.takeCleared())
    }
}
