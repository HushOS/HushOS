package com.hushos.app.data

import com.hushos.core.MemberStatus
import com.hushos.core.MembersRole
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
    /* Grace's entry as Maya's page shows it: the membership a removal is confirmed against. */
    private fun graceSince(phone: FamilyFixture.Phone) = view(phone).members.single { it.userId.equals(graceId, ignoreCase = true) }.since
    private fun remove(phone: FamilyFixture.Phone, endsLapsed: List<String> = emptyList(), steps: MutableList<RemovalStep> = ArrayList()) =
        phone.sync.removeMember(summary, graceId, "Grace", graceSince(phone), endsLapsed = endsLapsed) { steps.add(it) }
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
        assertEquals(listOf(clearedWords("tags")), phone.sync.takeCleared(family.groupId))
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
        // No answer is pending, the removal kept for the next open as well as its entry.
        assertTrue(remove(first) is RemovalEnd.Pending)
        assertEquals(1, kept(first).size)
        assertTrue(bodies("remove").isEmpty())
        family.documentsFailFrom = Int.MAX_VALUE
        val reads = family.documentReads.get()
        val next = phone(first.folder)
        assertEquals(listOf(CallEnd.Landed), next.sync.resumeOutbox(summary).values.toList())
        assertEquals("read again before it was sent", reads + 1, family.documentReads.get())
        assertEquals(listOf(clearedWords("tags")), next.sync.takeCleared(family.groupId))
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
        assertTrue("nothing said before it lands", first.sync.takeCleared(family.groupId).isEmpty())
        val next = phone(first.folder)
        assertEquals(listOf(CallEnd.Landed), next.sync.resumeOutbox(summary).values.toList())
        assertEquals(listOf(clearedWords("tags")), next.sync.takeCleared(family.groupId))
    }

    /*
     * Codex #281 round 3, 1: only the removal's intent is left on the phone, and at the next open the server doesn't answer
     * (503): the continued removal is pending and its intent stays. Answered at the open after (a fresh process), it lands.
     * Fails if a transient failure counts as a definite end and the removal is never made.
     */
    @Test
    fun aRemovalIntentOutlivesATransientFailureAndAProcess() {
        val first = phone()
        first.sync.outbox.keepRemoval(family.member.id, family.groupId, FamilyOutbox.Removal(graceId, "Grace", emptyList(), false, graceSince(first).toLong()))
        family.rostersFail = true
        val ended = ArrayList<RemovalEnd>()
        first.sync.resumeOutbox(summary, continued = { _, end -> ended.add(end) })
        assertTrue(ended.single() is RemovalEnd.Pending)
        assertEquals(listOf(graceId), first.sync.outbox.removals(family.member.id, family.groupId).map { it.userId })
        family.rostersFail = false
        val next = phone(first.folder)
        ended.clear()
        next.sync.resumeOutbox(summary, continued = { _, end -> ended.add(end) })
        assertEquals(listOf<RemovalEnd>(RemovalEnd.Removed), ended)
        assertTrue(next.sync.outbox.removals(family.member.id, family.groupId).isEmpty())
        assertFalse(view(next).members.any { it.userId.equals(graceId, ignoreCase = true) })
    }

    /*
     * Codex #281 round 3, 3: a removal lands carrying the folder's tags on empty, and the process dies before anything was
     * said. The words are kept on the phone until taken: the next process says them, once. Fails if the warning lives only
     * in memory between the landing and the screen.
     */
    @Test
    fun aClearedDocumentsWarningOutlivesTheProcessUntilItIsSaid() {
        val first = phone()
        family.documents["tags"] = 1 to com.hushos.core.base64urlEncode(ByteArray(80) { 7 })
        assertEquals(RemovalEnd.Removed, remove(first))
        val next = phone(first.folder)
        assertEquals(listOf(clearedWords("tags")), next.sync.takeCleared(family.groupId))
        assertTrue(next.sync.takeCleared(family.groupId).isEmpty())
    }

    /*
     * Codex #281 round 4, 1: the very first removal of Grace meets a sync that gets no answer (503), before any preview or
     * call. It is pending, and its intent is already kept: after a relaunch the resume removes her. Fails if a removal says
     * "kept for later" with nothing kept (the intent written only after the preview).
     */
    @Test
    fun aFirstRemovalIsKeptBeforeAnythingIsAskedOfTheServer() {
        val first = phone()
        val since = graceSince(first)
        family.rostersFail = true
        assertTrue(first.sync.removeMember(summary, graceId, "Grace", since) is RemovalEnd.Pending)
        assertTrue("nothing asked", family.holdsAsked.isEmpty())
        assertEquals(listOf(graceId), first.sync.outbox.removals(family.member.id, family.groupId).map { it.userId })
        family.rostersFail = false
        val next = phone(first.folder)
        val ended = ArrayList<RemovalEnd>()
        next.sync.resumeOutbox(summary, continued = { _, end -> ended.add(end) })
        assertEquals(listOf<RemovalEnd>(RemovalEnd.Removed), ended)
        assertFalse(view(next).members.any { it.userId.equals(graceId, ignoreCase = true) })
        assertTrue(next.sync.outbox.removals(family.member.id, family.groupId).isEmpty())
    }

    /*
     * Codex #281 round 4, 2: Grace manages the family, and taking that from her first keeps meeting another manager's change
     * (`stale`, three times): nothing definite was said, so the removal is pending and its intent kept. After a relaunch the
     * resume demotes and removes her. Fails if a demotion that may pass next time ends the removal as failed and forgets it.
     */
    @Test
    fun aDemotionThatKeepsChangingKeepsTheRemoval() {
        val first = phone()
        family.verifyPin(server.grace, "grace@example.org", "Grace Hopper")
        assertEquals(RoleEnd.Landed, first.sync.changeRole(summary, graceId, "Grace", MembersRole.GRANT))
        repeat(3) {
            family.memberAnswers.add { _ ->
                family.samChangesTheList()
                409 to JSONObject().put("code", "stale").put("message", "Another change to the family landed first.")
            }
        }
        val end = first.sync.removeMember(summary, graceId, "Grace", graceSince(first), demoteFirst = true)
        assertTrue("$end", end is RemovalEnd.Pending)
        assertEquals(listOf(graceId), first.sync.outbox.removals(family.member.id, family.groupId).map { it.userId })
        assertTrue("members" in view(first).members.single { it.userId.equals(graceId, ignoreCase = true) }.roles)
        val next = phone(first.folder)
        val ended = ArrayList<RemovalEnd>()
        next.sync.resumeOutbox(summary, continued = { _, it -> ended.add(it) })
        assertEquals(listOf<RemovalEnd>(RemovalEnd.Removed), ended)
        assertFalse(view(next).members.any { it.userId.equals(graceId, ignoreCase = true) })
    }

    /*
     * Codex #281 round 4, 4: the folder's tags don't open when the removal is staged, even read again, and are noted. Before
     * the call lands the server says `document-stale` for them, and by now they are whole: the rebuild reads them fine, so
     * the note goes with it. After no answer and a relaunch the call lands and nothing is said. Fails if an old note outlives
     * a rebuild that read the document, warning that tags were emptied when they weren't.
     */
    @Test
    fun aNoteGoesWhenARebuildReadsTheDocumentAfterARelaunch() {
        val first = phone()
        family.documents["tags"] = 1 to com.hushos.core.base64urlEncode(ByteArray(80) { 7 })
        family.rotatingAnswers.add { _, _ ->
            family.documents["tags"] = 2 to family.sealedTags(2, """{"version":2,"tags":[{"id":"t1","name":"Recipes"}],"items":{}}""")
            refuse("document-stale", JSONObject().put("workspaceId", family.workspaceId).put("kind", "tags")
                .put("stale", JSONArray().put(JSONObject().put("workspaceId", family.workspaceId).put("kind", "tags"))))
        }
        repeat(3) { family.rotatingAnswers.add { _, _ -> 503 to JSONObject().put("message", "Unavailable.") } }
        assertTrue(remove(first) is RemovalEnd.Pending)
        val keptCall = kept(first).single()
        assertTrue("noted after the rebuild read them", first.sync.outbox.cleared(family.member.id, family.groupId, keptCall.outboxId).isEmpty())
        val next = phone(first.folder)
        assertEquals(listOf(CallEnd.Landed), next.sync.resumeOutbox(summary).values.toList())
        assertTrue(next.sync.takeCleared(family.groupId).isEmpty())
        assertFalse(view(next).members.any { it.userId.equals(graceId, ignoreCase = true) })
    }

    /*
     * Codex #281 round 6, 1: Grace's removal lands but every reply is lost, so the phone keeps the call and the intent. Sam
     * then lets her in again on his device. After a relaunch the replay is recognised as landed: the intent is retired with
     * it, before its entry goes, and nothing continues it. Fails if the intent outlives the landing and a second removal,
     * which nobody confirmed, is signed over her new membership.
     */
    @Test
    fun aLandedRemovalWhoseReplyWasLostIsNeverMadeAgainAfterAReadmission() {
        val first = phone()
        family.repliesLost = 4
        assertTrue(remove(first) is RemovalEnd.Pending)
        assertEquals(listOf(graceId), first.sync.outbox.removals(family.member.id, family.groupId).map { it.userId })
        assertEquals(1, kept(first).size)
        family.samLetsInAgain(server.grace)
        val removes = bodies("remove").size
        val next = phone(first.folder)
        val continued = ArrayList<RemovalEnd>()
        next.sync.resumeOutbox(summary, continued = { _, end -> continued.add(end) })
        assertEquals("nothing continued", emptyList<RemovalEnd>(), continued)
        assertEquals("no second removal", removes, bodies("remove").size)
        assertTrue(next.sync.outbox.removals(family.member.id, family.groupId).isEmpty())
        assertTrue(kept(next).isEmpty())
        assertTrue(view(next).members.any { it.userId.equals(graceId, ignoreCase = true) })
    }

    /*
     * Codex #281 round 6, 2: a removal of Grace is kept as an intent against her entry as Maya saw it, and Sam changes that
     * entry before the next open (here he gives her billing; leaving and being let in again moves it the same way). The
     * continued removal acts on nothing it wasn't confirmed against: it ends as changed, nothing staged, the intent gone.
     * Fails if an intent removes whatever membership the person has by then.
     */
    @Test
    fun anIntentNeverActsOnAMembershipNobodyConfirmed() {
        val first = phone()
        first.sync.outbox.keepRemoval(family.member.id, family.groupId, FamilyOutbox.Removal(graceId, "Grace", emptyList(), false, graceSince(first).toLong()))
        family.samGivesBilling(graceId)
        val next = phone(first.folder)
        val continued = ArrayList<RemovalEnd>()
        next.sync.resumeOutbox(summary, continued = { _, end -> continued.add(end) })
        assertEquals("still in, so never said as gone", listOf<RemovalEnd>(RemovalEnd.Moved), continued)
        assertTrue("nothing staged", family.rotatingCalls.isEmpty())
        assertTrue(family.holdsAsked.isEmpty())
        assertTrue(next.sync.outbox.removals(family.member.id, family.groupId).isEmpty())
        assertTrue(view(next).members.any { it.userId.equals(graceId, ignoreCase = true) })
    }

    /*
     * Codex #281 round 6, 3: Grace manages the family; taking that from her lands but every reply is lost, and the process
     * dies. The intent already names the version that demotion takes, so after a relaunch the replayed demotion is
     * recognised and her entry as it left her is still the membership confirmed: she is removed. Fails if the binding to
     * the demotion lives only in memory and the removal is dropped as changed.
     */
    @Test
    fun aRemovalWhoseDemotionLandedUnheardGoesOnAfterARelaunch() {
        val first = phone()
        family.verifyPin(server.grace, "grace@example.org", "Grace Hopper")
        assertEquals(RoleEnd.Landed, first.sync.changeRole(summary, graceId, "Grace", MembersRole.GRANT))
        repeat(4) {
            family.memberAnswers.add { body ->
                family.apply(body, null)
                503 to JSONObject().put("message", "Unavailable.")
            }
        }
        val end = first.sync.removeMember(summary, graceId, "Grace", graceSince(first), demoteFirst = true)
        assertTrue("$end", end is RemovalEnd.Pending)
        assertTrue("demoted on the server", "members" !in family.creatorChain().roster().members.single { it.userId.equals(graceId, ignoreCase = true) }.roles.map { it.name.lowercase() })
        val next = phone(first.folder)
        val continued = ArrayList<RemovalEnd>()
        next.sync.resumeOutbox(summary, continued = { _, it -> continued.add(it) })
        assertEquals(listOf<RemovalEnd>(RemovalEnd.Removed), continued)
        assertFalse(view(next).members.any { it.userId.equals(graceId, ignoreCase = true) })
    }

    /*
     * Codex #281 round 6, 4: Sam changes Grace's entry after the removal's last read but before the call is built (as its
     * hold is placed again). The build checks the very list the call is signed over: nothing is staged, and the removal
     * ends as changed. Fails if a removal is signed over a membership nobody confirmed because it changed in that gap.
     */
    @Test
    fun aRemovalIsNeverSignedOverAnEntryThatChangedBeforeTheBuild() {
        val phone = phone()
        val since = graceSince(phone)
        var holds = 0
        server.beforeAnswer = { method, path ->
            if (method == "POST" && path.endsWith("/hold") && ++holds == 2) family.samGivesBilling(graceId)
        }
        assertEquals("still in, so never said as gone", RemovalEnd.Moved, phone.sync.removeMember(summary, graceId, "Grace", since))
        server.beforeAnswer = null
        assertTrue("nothing staged", bodies("remove").isEmpty())
        assertTrue(phone.sync.outbox.removals(family.member.id, family.groupId).isEmpty())
        assertTrue(view(phone).members.any { it.userId.equals(graceId, ignoreCase = true) })
    }

    /*
     * Codex #281 round 7, 1: a group key's standalone succession has moved the chain's revision past the member list's
     * version. Grace manages the family; taking that from her lands, and her entry then sits at the member list's next
     * version, which the intent was bound to: she is removed. Fails if the demotion is bound to the chain's revision (the
     * removal would end as moved, and she would stay).
     */
    @Test
    fun aDemotionIsBoundToTheMemberListVersionNotTheChainRevision() {
        val first = phone()
        family.verifyPin(server.grace, "grace@example.org", "Grace Hopper")
        assertEquals(RoleEnd.Landed, first.sync.changeRole(summary, graceId, "Grace", MembersRole.GRANT))
        family.standaloneSuccessions = 1
        val steps = ArrayList<RemovalStep>()
        assertEquals(RemovalEnd.Removed, first.sync.removeMember(summary, graceId, "Grace", graceSince(first), demoteFirst = true) { steps.add(it) })
        assertEquals(RemovalStep.DEMOTE, steps.first())
        assertFalse(view(first).members.any { it.userId.equals(graceId, ignoreCase = true) })
    }

    /*
     * Codex #281 round 7, 2: the server answers the hold with `members-changed`. Grace is still in the family: said as the
     * family having changed (the web's words), never as her being gone; once she is gone, as gone. Fails if a person who is
     * still in the family is reported as no longer in it.
     */
    @Test
    fun aMembersChangedAnswerSaysGoneOnlyWhenTheyAre() {
        val phone = phone()
        family.holdAnswer = refuse("members-changed")
        assertEquals(RemovalEnd.Moved, remove(phone))
        val since = graceSince(phone)
        family.holdAnswer = null
        assertEquals(RemovalEnd.Removed, remove(phone))
        assertEquals(RemovalEnd.Changed, phone.sync.removeMember(summary, graceId, "Grace", since))
        assertTrue(phone.sync.outbox.removals(family.member.id, family.groupId).isEmpty())
    }

    /*
     * Codex #281 round 8: Grace's removal is kept unanswered, then its entry can no longer be opened on this phone (here
     * overwritten). After a relaunch the resume deletes it and says the change was lost and must be made again; the intent
     * goes with it, so nothing signs a fresh removal behind that word. Fails if an entry's end for good leaves its intent.
     */
    @Test
    fun aRemovalLostUnopenedTakesItsIntentWithIt() {
        val first = phone()
        repeat(6) { family.rotatingAnswers.add { _, _ -> 503 to JSONObject().put("message", "Unavailable.") } }
        assertTrue(remove(first) is RemovalEnd.Pending)
        val entry = kept(first).single()
        assertEquals(entry.outboxId.lowercase(), first.sync.outbox.removals(family.member.id, family.groupId).single().outboxId)
        first.sync.outbox.put(family.member.id, family.groupId, entry.outboxId, "AAAA")
        val removes = bodies("remove").size
        val next = phone(first.folder)
        val continued = ArrayList<RemovalEnd>()
        val ends = next.sync.resumeOutbox(summary, continued = { _, end -> continued.add(end) })
        assertTrue("$ends", (ends.values.single() as CallEnd.Refused).words.contains("Make it again"))
        assertEquals("nothing continued", emptyList<RemovalEnd>(), continued)
        assertEquals("no fresh removal", removes, bodies("remove").size)
        assertTrue(next.sync.outbox.removals(family.member.id, family.groupId).isEmpty())
        assertTrue(view(next).members.any { it.userId.equals(graceId, ignoreCase = true) })
    }

    /*
     * Codex #281 round 8: Grace's removal call is overtaken (`stale`), which retires the intent with the entry, and the
     * read before it is built again gets no answer. The turn is pending, so its intent is kept again; after a relaunch the
     * removal goes on and lands. Fails if a removal says it is kept for later after its entry's end took the intent.
     */
    @Test
    fun aRemovalPendingAfterItsCallWasOvertakenKeepsItsIntent() {
        val first = phone()
        family.rotatingAnswers.add { _, _ ->
            family.samChangesTheList()
            family.rostersFail = true
            409 to JSONObject().put("code", "stale").put("message", "Another change to the family landed first.")
        }
        assertTrue(remove(first) is RemovalEnd.Pending)
        assertEquals(listOf(graceId), first.sync.outbox.removals(family.member.id, family.groupId).map { it.userId })
        family.rostersFail = false
        val next = phone(first.folder)
        val continued = ArrayList<RemovalEnd>()
        next.sync.resumeOutbox(summary, continued = { _, end -> continued.add(end) })
        assertEquals(listOf<RemovalEnd>(RemovalEnd.Removed), continued)
        assertFalse(view(next).members.any { it.userId.equals(graceId, ignoreCase = true) })
    }

    /*
     * Codex #281 round 9: the folder's tags don't open when the removal is staged (junk served to this phone alone), even
     * read again, and are noted. The server then asks for a rebuild (`epoch-stale`); by now the same tags read fine, so the
     * rebuilt call carries them. The process dies as that rebuilt entry is written. After a relaunch the call on disk is the
     * one first staged, which carries the tags on empty: it lands, and that is said. Fails if a crash can leave the rebuild's
     * marker (nothing emptied) beside the call it replaced, clearing the warning for a call that does empty the tags.
     */
    @Test
    fun aCrashWhileARebuildIsWrittenLeavesTheCallAndItsNotesTogether() {
        val first = phone()
        family.documents["tags"] = 1 to com.hushos.core.base64urlEncode(ByteArray(80) { 7 })
        family.rotatingAnswers.add { _, _ ->
            family.documents["tags"] = 1 to family.sealedTags(1, """{"version":2,"tags":[{"id":"t1","name":"Recipes"}],"items":{}}""")
            val staged = kept(first).single().entry
            // The process dies as the rebuilt call is written: any write of a call other than the one on disk.
            FamilyOutbox.beforeWrite = { _, entry -> if (entry != staged) throw IllegalStateException("killed") }
            409 to JSONObject().put("code", "epoch-stale").put("message", "Draw a new epoch.")
        }
        try {
            assertTrue(runCatching { remove(first) }.isFailure)
        } finally {
            FamilyOutbox.beforeWrite = { _, _ -> }
        }
        assertEquals(listOf("tags"), first.sync.outbox.cleared(family.member.id, family.groupId, kept(first).single().outboxId))
        val next = phone(first.folder)
        assertEquals(listOf(CallEnd.Landed), next.sync.resumeOutbox(summary).values.toList())
        assertEquals("the landed call emptied the tags: said", listOf(clearedWords("tags")), next.sync.takeCleared(family.groupId))
        assertFalse(view(next).members.any { it.userId.equals(graceId, ignoreCase = true) })
    }

    /*
     * Codex #281 round 9, the recheck's own write: the folder's tags don't open when the removal is staged, and read again
     * they do, so the call is rebuilt carrying them. The process dies as that is written. After a relaunch the entry on disk
     * is still the one staged, still marked: it is read again first, and the call that lands carries the tags as they read,
     * with nothing said. Fails if the notes and the marker can be settled apart from the call they describe (the staged
     * call, which empties the tags, would then be sent unmarked and unannounced).
     */
    @Test
    fun aCrashWhileARecheckIsSettledLeavesTheCallAndItsMarkerTogether() {
        val first = phone()
        val tags = """{"version":2,"tags":[{"id":"t1","name":"Recipes"}],"items":{}}"""
        family.documents["tags"] = 1 to com.hushos.core.base64urlEncode(ByteArray(80) { 7 })
        var reads = 0
        server.beforeAnswer = { method, path ->
            if (method == "GET" && path.endsWith("/documents/tags") && ++reads == 2) family.documents["tags"] = 1 to family.sealedTags(1, tags)
        }
        var staged: String? = null
        FamilyOutbox.beforeWrite = { _, entry -> if (staged == null) staged = entry else if (entry != staged) throw IllegalStateException("killed") }
        try {
            assertTrue(runCatching { remove(first) }.isFailure)
        } finally {
            FamilyOutbox.beforeWrite = { _, _ -> }
            server.beforeAnswer = null
        }
        assertTrue(bodies("remove").isEmpty())
        assertEquals("the staged call, still marked", listOf(com.hushos.core.ReplacedDocument(family.workspaceId, "tags")),
            first.sync.outbox.recheck(family.member.id, family.groupId, kept(first).single().outboxId)?.replaced)
        val next = phone(first.folder)
        server.requests.clear()
        assertEquals(listOf(CallEnd.Landed), next.sync.resumeOutbox(summary).values.toList())
        val order = server.requests.filter { it.contains("/documents/tags") || it.endsWith("/remove") }
        assertTrue("read again before it was sent: $order", order.first().contains("/documents/tags"))
        assertTrue("nothing emptied, nothing said", next.sync.takeCleared(family.groupId).isEmpty())
    }
}
