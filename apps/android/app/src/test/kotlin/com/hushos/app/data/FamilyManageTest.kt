package com.hushos.app.data

import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/*
 * A manager's Let them in on a phone (Android 5a; the web's outbox) through the real Vault, GroupsApi and the core's
 * area ledger against FakeDrive serving rosters the core signs: Maya manages the Lindqvist family, and Grace waits to be
 * let in. Every admission is the core's, kept before it is sent and sent again byte for byte until the server answers.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class FamilyManageTest {
    private val server = FakeDrive()
    private lateinit var family: FamilyFixture
    private val app get() = RuntimeEnvironment.getApplication()

    @Before
    fun signIn() {
        FamilyFixture.signIn(server, "family-manage-test")
        family = FamilyFixture(server)
        val chain = family.mayaManages()
        family.storePin(family.pin(chain))
        family.waiting(server.grace, "grace@example.org", "Grace Hopper")
    }

    @After
    fun close() {
        outboxFolder.setReadable(true)
        outboxFolder.listFiles()?.forEach { it.setReadable(true) }
        server.close()
        assertEquals("routes the fake does not serve", emptyList<String>(), server.unknown)
    }

    private val summary get() = family.summary
    private val grace get() = family.pendingRows.map(PendingPerson::from).single()

    private fun phone(folder: java.io.File? = null): FamilyFixture.Phone {
        val phone = if (folder == null) family.phone() else family.phone(folder)
        assertTrue(phone.sync.sync(summary) is FamilyState.Accepted)
        return phone
    }

    private val outboxFolder get() = java.io.File(java.io.File(app.noBackupFilesDir, FamilyRecords.FOLDER), "outbox")

    private fun kept(phone: FamilyFixture.Phone) = phone.sync.outbox.list(family.member.id, family.groupId)

    /* Answers the next `n` admissions with `status` (the server down, or answering in a way nobody hears). */
    private fun answer(n: Int, status: Int, applied: Boolean = false) = repeat(n) {
        family.admitAnswers.add { body ->
            if (applied) family.apply(body, server.grace.id)
            status to JSONObject().put("message", "Drive is temporarily unavailable. Please try again.")
        }
    }

    /*
     * Let them in: Grace pinned first-seen (no words), the admission signed over that pin as a plain member, kept, sent and
     * landed; the family synced at her admission, and nothing left in the outbox. Fails if the admission is sent before it
     * is kept, or signed over anything but the pin this phone holds.
     */
    @Test
    fun letThemInLandsAndLeavesNothingKept() {
        val phone = phone()
        assertEquals(LetIn.Landed, phone.sync.letIn(summary, grace))
        assertEquals(1, family.callBodies.size)
        assertEquals(4, family.chain.size)
        assertTrue(kept(phone).isEmpty())
        assertTrue(family.pendingRows.isEmpty())
        // Pinned first-seen, from the family's invitation: no words compared.
        val pin = server.settings().pinOf(server.grace.id)!!
        assertTrue(!pin.verified)
        // The phone accepted the family at her admission.
        val after = phone.sync.sync(summary)
        assertTrue("$after", after is FamilyState.Accepted)
        assertEquals(4uL, (after as FamilyState.Accepted).view.rosterVersion)
    }

    /*
     * The server doesn't answer, then does: the very same bytes are sent each time, never signed again. Fails if an
     * unknown outcome is followed by a newly signed call (which could let them in twice, or not at all).
     */
    @Test
    fun anUnknownOutcomeResendsTheSameBytes() {
        val phone = phone()
        answer(2, 503)
        assertEquals(LetIn.Landed, phone.sync.letIn(summary, grace))
        assertEquals(3, family.callBodies.size)
        assertEquals(1, family.callBodies.toSet().size)
        assertTrue(kept(phone).isEmpty())
    }

    /*
     * No answer at all, three times: kept on the phone. The app is killed; on relaunch a fresh vault and ledger read the
     * kept entry back and send the same bytes, signing nothing. Fails if a kept send is lost with the process or signed
     * again after it.
     */
    @Test
    fun aKeptSendSurvivesAKillAndARelaunch() {
        val first = phone()
        answer(3, 503)
        assertTrue(first.sync.letIn(summary, grace) is LetIn.Pending)
        assertEquals(1, kept(first).size)
        val sent = family.callBodies.toList()
        // A new process: nothing of the first vault's ledger, the same device files.
        val next = phone(first.folder)
        val ends = next.sync.resumeOutbox(summary)
        assertEquals(listOf(CallEnd.Landed), ends.values.toList())
        assertEquals(sent.last(), family.callBodies.last())
        assertEquals(1, family.callBodies.toSet().size)
        assertTrue(kept(next).isEmpty())
        assertEquals(4, family.chain.size)
    }

    /*
     * Another manager's change lands first: the server answers `stale`. The entry is dropped, the family synced, and the
     * admission signed again over the winner, which lands. Fails if a stale call is resent, or kept.
     */
    @Test
    fun staleDropsTheSendAndSignsAgainOverTheWinner() {
        val phone = phone()
        family.admitAnswers.add { _ ->
            family.samChangesTheList()
            409 to JSONObject().put("code", "stale").put("message", "Another change to the family landed first.")
        }
        assertEquals(LetIn.Landed, phone.sync.letIn(summary, grace))
        assertEquals(2, family.callBodies.size)
        assertNotEquals(family.callBodies[0], family.callBodies[1])
        // Built over Sam's roster 4: hers is 5.
        assertEquals(4L, JSONObject(family.callBodies[1]).getLong("expectedRevision"))
        assertEquals(5, family.chain.size)
        assertTrue(kept(phone).isEmpty())
    }

    /*
     * A kept send the server took though nobody heard its answer is Landed once the family is synced, and dropped with
     * nothing sent; one the head moved past (another manager's change at that version) is Superseded, dropped, never sent
     * (the next test). Fails if either is sent again.
     */
    @Test
    fun landedAndSupersededEntriesAreDroppedUnsent() {
        val first = phone()
        answer(3, 500, applied = true)
        assertTrue(first.sync.letIn(summary, grace) is LetIn.Pending)
        val sends = family.callBodies.size
        val next = phone(first.folder)
        val ends = next.sync.resumeOutbox(summary).values.toList()
        assertEquals(listOf(CallEnd.Landed), ends)
        assertEquals(sends, family.callBodies.size)
        assertTrue(kept(next).isEmpty())
    }

    @Test
    fun aSupersededEntryIsDroppedUnsent() {
        val first = phone()
        answer(3, 503)
        assertTrue(first.sync.letIn(summary, grace) is LetIn.Pending)
        // Sam's change lands at the version the kept admission was built for.
        family.samChangesTheList()
        val next = phone(first.folder)
        val before = family.callBodies.size
        assertEquals(listOf(CallEnd.Stale), next.sync.resumeOutbox(summary).values.toList())
        assertEquals(before, family.callBodies.size)
        assertTrue(kept(next).isEmpty())
    }

    /*
     * An admission kept for Grace's keys, then her account changes and Maya continues with the new keys: the kept one is
     * held, never sent to the old keys, and Let them in says so until Maya drops it; then she is let in over the new keys.
     * Fails if a kept admission goes to keys this account no longer holds for her.
     */
    @Test
    fun anAdmissionKeptForOtherKeysIsHeld() {
        val phone = phone()
        // Grace's row as the screen drew it before her account changed: every press below is on it, never reloaded.
        val grace = grace
        answer(3, 503)
        assertTrue(phone.sync.letIn(summary, grace) is LetIn.Pending)
        val sends = family.callBodies.size
        server.startOverGrace()
        family.pendingRows.clear()
        family.waiting(server.grace, "grace@example.org", "Grace Hopper")
        val changed = phone.sync.letIn(summary, grace)
        assertTrue("$changed", changed is LetIn.Changed)
        phone.vault.continueWith((changed as LetIn.Changed).change)
        assertEquals(mapOf(kept(phone).single().outboxId to CallEnd.OtherKeys), phone.sync.resumeOutbox(summary))
        assertEquals(LetIn.KeptOther, phone.sync.letIn(summary, grace))
        assertEquals("nothing sent to the old keys", sends, family.callBodies.size)
        phone.sync.dropKeptAdmission(family.groupId, server.grace.id)
        assertEquals(LetIn.Landed, phone.sync.letIn(summary, grace))
        assertTrue(kept(phone).isEmpty())
    }

    /*
     * Grace's admission kept unanswered; another device then follows her account change (Continue), replacing the pin this
     * phone's ledger last read. The settings can't be read now: nothing is sent, the entry stays kept. Once they read, it
     * is held for the old keys. Fails if a send goes out judged against the settings the ledger held before.
     */
    @Test
    fun aSettingsReadThatFailsSendsNothing() {
        val phone = phone()
        answer(3, 503)
        assertTrue(phone.sync.letIn(summary, grace) is LetIn.Pending)
        val sends = family.callBodies.size
        server.startOverGrace()
        val other = family.phone()
        val changed = other.vault.addContact("grace@example.org", writer = server.grace.id, firstSeen = "family")
        assertTrue("$changed", changed is Added.Changed)
        other.vault.continueWith((changed as Added.Changed).change)
        server.failSettingsReads = true
        assertEquals(listOf(CallEnd.Pending(GroupsApiError.NO_ANSWER)), phone.sync.resumeOutbox(summary).values.toList())
        assertEquals("nothing sent", sends, family.callBodies.size)
        assertEquals(1, kept(phone).size)
        server.failSettingsReads = false
        assertEquals(listOf(CallEnd.OtherKeys), phone.sync.resumeOutbox(summary).values.toList())
        assertEquals("nothing sent to the replaced keys", sends, family.callBodies.size)
    }

    /*
     * A kept admission answered not-member: the family is let go of as every removal is (two-phase, its record gone) and
     * the removal published for the screens. Fails if it is wiped unannounced, or the screens keep drawing the family.
     */
    @Test
    fun notMemberOnAKeptSendIsARemovalTheScreensAreTold() {
        val phone = phone()
        answer(3, 503)
        assertTrue(phone.sync.letIn(summary, grace) is LetIn.Pending)
        phone.sync.takeRemovals()
        family.notMember = true
        assertEquals(listOf(CallEnd.Wiped), phone.sync.resumeOutbox(summary).values.toList())
        assertEquals(listOf(FamilyState.Wiped to family.groupId), phone.sync.takeRemovals().map { it.state to it.groupId })
        assertNull(phone.records.read(family.member.id, family.groupId))
        assertTrue(kept(phone).isEmpty())
    }

    /* Let them in meeting not-member on any read (here route 3): the same removal, published, and Wiped. Fails if it throws instead. */
    @Test
    fun notMemberWhileLettingInIsARemovalTheScreensAreTold() {
        val phone = phone()
        phone.sync.takeRemovals()
        family.notMember = true
        assertEquals(LetIn.Wiped, phone.sync.letIn(summary, grace))
        assertEquals(listOf(FamilyState.Wiped to family.groupId), phone.sync.takeRemovals().map { it.state to it.groupId })
        assertNull(phone.records.read(family.member.id, family.groupId))
    }

    /*
     * Let them in pressed again while the first is unanswered: the kept one is sent again, byte for byte, and nothing new
     * is signed. Fails if a second, competing admission is staged beside one that may still land.
     */
    @Test
    fun pressingAgainWhileUnansweredSignsNothingNew() {
        val phone = phone()
        answer(6, 503)
        assertTrue(phone.sync.letIn(summary, grace) is LetIn.Pending)
        assertTrue(phone.sync.letIn(summary, grace) is LetIn.Pending)
        assertEquals(1, kept(phone).size)
        assertEquals(6, family.callBodies.size)
        assertEquals(1, family.callBodies.toSet().size)
    }

    /*
     * Grace's admission held for her old keys, then Ada waits too: Ada is let in, and Grace's held entry is neither sent
     * nor dropped. Fails if one person's kept entry decides another's Let them in.
     */
    @Test
    fun anotherPersonsKeptAdmissionIsLeftAlone() {
        val phone = phone()
        answer(3, 503)
        assertTrue(phone.sync.letIn(summary, grace) is LetIn.Pending)
        server.startOverGrace()
        val changed = phone.sync.letIn(summary, grace)
        phone.vault.continueWith((changed as LetIn.Changed).change)
        val graceKept = kept(phone).single()
        val sends = family.callBodies.size
        val ada = server.another("ada@example.org", "Ada Lovelace")
        family.waiting(ada, "ada@example.org", "Ada Lovelace")
        val adaWaiting = family.pendingRows.map(PendingPerson::from).single { it.userId.equals(ada.id, ignoreCase = true) }
        assertEquals(LetIn.Landed, phone.sync.letIn(summary, adaWaiting))
        assertEquals("only Ada's admission sent", sends + 1, family.callBodies.size)
        assertEquals(listOf(graceKept), kept(phone))
        // Dropping Ada's kept admissions leaves Grace's.
        phone.sync.dropKeptAdmission(family.groupId, ada.id)
        assertEquals(listOf(graceKept), kept(phone))
    }

    /*
     * Sam changes the member list after this phone's last sync, the page still open: Let them in syncs first and builds
     * over his roster, and lands. Fails if the admission is built over the chain this phone held, named at the server's
     * newer revision (refused as not following the head, and every later press the same).
     */
    @Test
    fun aChangeSinceTheLastSyncIsSyncedBeforeLettingIn() {
        val phone = phone()
        family.samChangesTheList()
        assertEquals(LetIn.Landed, phone.sync.letIn(summary, grace))
        assertEquals(1, family.callBodies.size)
        assertEquals(5, family.chain.size)
    }

    /*
     * Grace's account changes while her row is on screen; Let them in on that row says so, Continue follows her new keys,
     * and the next press on the same row lets her in over them, reading her keys afresh. Fails if the admission is built
     * from the row's old identity, which the pin no longer names.
     */
    @Test
    fun aChangedAccountIsLetInAfterContinueWithoutReloadingTheRow() {
        val phone = phone()
        val drawn = grace
        // Pinned at her old keys (an earlier contact, or a Let them in that got no further).
        assertTrue(phone.vault.addContact("grace@example.org", writer = server.grace.id, firstSeen = "family") is Added.New)
        server.startOverGrace()
        family.pendingRows.clear()
        family.waiting(server.grace, "grace@example.org", "Grace Hopper")
        val changed = phone.sync.letIn(summary, drawn)
        assertTrue("$changed", changed is LetIn.Changed)
        phone.vault.continueWith((changed as LetIn.Changed).change)
        assertEquals(LetIn.Landed, phone.sync.letIn(summary, drawn))
        assertTrue(family.pendingRows.isEmpty())
    }

    /*
     * Sam's change lands between this phone's sync and its read of the head (route 3), once the family's key is opened
     * (the first round only opens it, and the next one syncs anyway): the head no longer matches the chain just accepted,
     * so the family is synced again and the admission built over his roster. Fails if a head read after the sync is
     * trusted to name the chain the sync accepted (built over the old chain at the new revision, refused as not following).
     */
    @Test
    fun aChangeBetweenTheSyncAndTheHeadReadIsSyncedAgain() {
        val phone = phone()
        var keyOpened = false
        var once = true
        server.beforeAnswer = { method, path ->
            if (method == "GET" && path == "groups/${family.groupId}/key-seal") keyOpened = true
            // The sync's own read of route 3 comes after its rosters: the change lands after the sync saw them.
            if (keyOpened && once && method == "GET" && path == "groups/${family.groupId}") { once = false; family.samChangesTheList() }
        }
        assertEquals(LetIn.Landed, phone.sync.letIn(summary, grace))
        server.beforeAnswer = null
        assertTrue("the change landed mid-staging", !once)
        assertEquals(1, family.callBodies.size)
        assertEquals(5, family.chain.size)
    }

    /*
     * The outbox folder can't be read: Let them in and the page's resume throw (said as the storage words), and nothing is
     * signed or sent. Fails if an outbox that can't be listed reads as empty, so a kept call is signed again beside itself.
     */
    @Test
    fun anOutboxThatCantBeListedSignsAndSendsNothing() {
        val phone = phone()
        outboxFolder.mkdirs()
        assertTrue(outboxFolder.setReadable(false))
        assertThrows(OutboxUnreadable::class.java) { phone.sync.letIn(summary, grace) }
        assertThrows(OutboxUnreadable::class.java) { phone.sync.resumeOutbox(summary) }
        assertTrue(family.callBodies.isEmpty())
        outboxFolder.setReadable(true)
        assertTrue(kept(phone).isEmpty())
    }

    /*
     * A kept Let them in whose file can't be read: neither skipped nor signed again. Fails if an entry that doesn't read
     * is left out of the list, so the next press signs a second admission and the resume never sends the first.
     */
    @Test
    fun aKeptEntryThatCantBeReadSignsAndSendsNothing() {
        val phone = phone()
        answer(3, 503)
        assertTrue(phone.sync.letIn(summary, grace) is LetIn.Pending)
        val sends = family.callBodies.size
        val file = outboxFolder.listFiles()!!.single { it.name.endsWith(".call") }
        assertTrue(file.setReadable(false))
        assertThrows(OutboxUnreadable::class.java) { phone.sync.letIn(summary, grace) }
        assertThrows(OutboxUnreadable::class.java) { phone.sync.resumeOutbox(summary) }
        assertEquals("nothing sent", sends, family.callBodies.size)
        assertEquals(1, outboxFolder.listFiles()!!.count { it.name.endsWith(".call") })
        file.setReadable(true)
        // Readable again: the very bytes go, and land.
        assertEquals(listOf(CallEnd.Landed), phone.sync.resumeOutbox(summary).values.toList())
        assertEquals(1, family.callBodies.toSet().size)
    }

    private fun grantsDue() = family.admitAnswers.add { _ ->
        409 to JSONObject().put("code", "grants-due").put("message", "Some members are still missing grants.").put("data", JSONObject()
            .put("missing", org.json.JSONArray().put(JSONObject().put("workspaceId", family.workspaceId).put("userId", family.creator.id))))
    }

    /*
     * `grants-due`: the grants the server names are posted (route 22), then the very same bytes sent again, and they land.
     * Fails if the owed grants aren't posted, or the call is signed again after them.
     */
    @Test
    fun grantsDuePostsTheGrantsThenTheSameBytes() {
        val phone = phone()
        grantsDue()
        assertEquals(LetIn.Landed, phone.sync.letIn(summary, grace))
        assertEquals(listOf(family.workspaceId), family.grantPosts.map { it.first })
        assertEquals(2, family.callBodies.size)
        assertEquals(1, family.callBodies.toSet().size)
    }

    /*
     * Route 22 answers not-member while the owed grants are posted: the family is let go of as every removal is, published,
     * and the outbox goes with it. Fails if it is kept as a send still waiting, with nothing let go of.
     */
    @Test
    fun notMemberWhilePostingGrantsIsARemoval() {
        val phone = phone()
        phone.sync.takeRemovals()
        grantsDue()
        family.grantsAnswer = 404 to JSONObject().put("code", "not-member").put("message", "You are not in this group.")
        assertEquals(LetIn.Wiped, phone.sync.letIn(summary, grace))
        assertEquals(1, family.grantPosts.size)
        assertEquals(listOf(FamilyState.Wiped to family.groupId), phone.sync.takeRemovals().map { it.state to it.groupId })
        assertTrue(kept(phone).isEmpty())
    }
}
