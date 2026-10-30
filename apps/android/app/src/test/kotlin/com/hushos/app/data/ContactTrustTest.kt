package com.hushos.app.data

import android.content.Context
import com.hushos.core.PinTrust
import com.hushos.core.deviceRemember
import com.hushos.core.keyCommitment
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
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
import java.util.UUID

/*
 * Contacts without comparing words, through the real Vault, Auth and DriveApi against FakeDrive (ContactTrust.kt;
 * docs/optional-verification.md 2): adding is one step to a first-seen pin and a guard entry; a change with no signed
 * chain pauses that person until Continue; settings that lost a pin the guard holds are a change, never first use; a
 * guard that won't open pauses everyone; an act whose save landed but whose answer was lost is finished on the next
 * read, its re-seal queued first; a verdict is kept only for the exact keys it was made over; a lookup for display is
 * kept a minute.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ContactTrustTest {
    private val server = FakeDrive()
    private lateinit var vault: Vault
    private lateinit var context: Context
    private val email = "grace@example.org"

    @Before
    fun signIn() {
        context = RuntimeEnvironment.getApplication()
        Shared::class.java.getDeclaredField("opened").apply { isAccessible = true }
            .set(null, context.getSharedPreferences("contact-trust-test", Context.MODE_PRIVATE))
        Shared.writeSession(context, Shared.Session(server.origin, server.token, server.userId, "me@example.org"))
        Shared.writeDevice(context, deviceRemember(server.userId, server.accountKey, 1uL, 1uL, UUID.randomUUID().toString()))
        vault = Vault(context, DriveApi(Shared.session(context)!!))
        vault.listChildren(server.root)
    }

    @After
    fun close() {
        server.close()
        assertEquals("routes the fake does not serve", emptyList<String>(), server.unknown)
    }

    private fun grace() = Auth.lookupContact(context, email, vault.api.session)
    private fun guardEntry() = vault.guard.entry(server.grace.id)
    private fun stored() = server.settings().pinOf(server.grace.id)

    @Test
    fun addingSomeoneIsOneStepToAFirstSeenPinWithTheGuardBesideItAndAddingAgainSaysSo() {
        val added = vault.addContact(email) as Added.New
        assertEquals(PinTrust.SEEN, added.pin.trust)
        assertEquals("added", stored()!!.firstSeen)
        assertEquals(grace().commitment, stored()!!.commitment)
        assertEquals(grace().commitment, keyCommitment(guardEntry()!!.keys))
        // On disk, ciphertext only: neither Grace nor her keys.
        val onDisk = vault.guard.file.readText()
        assertFalse(onDisk.contains(server.grace.id) || onDisk.contains(grace().encryptionPublicKey))
        assertTrue(vault.addContact(email) is Added.Already)
        // Sealed to at once, to the keys the pin holds.
        assertEquals(grace().encryptionPublicKey, com.hushos.core.base64urlEncode(vault.trustGrantee(grace(), follow = true).first))
    }

    @Test
    fun anUnsignedChangePausesThemUntilContinueWhichMovesThemAndQueuesTheReSeal() {
        vault.addContact(email)
        val before = stored()!!
        server.startOverGrace()
        val change = (vault.addContact(email) as Added.Changed).change
        assertThrows(AccountChanged::class.java) { vault.trustGrantee(grace(), follow = true) }
        assertTrue(vault.lookup(email).changed)
        // Nothing was sealed to the new keys or saved over the old ones.
        assertEquals(before.commitment, stored()!!.commitment)
        assertFalse(ShareSeals.of(context).queued.contains(server.grace.id.lowercase()))
        val moved = vault.continueWith(change)
        assertEquals(grace().commitment, moved.commitment)
        assertEquals(PinTrust.SEEN, moved.trust)
        assertTrue(moved.previousSigningKeys.contains(before.signingPublicKey))
        assertEquals(grace().commitment, keyCommitment(guardEntry()!!.keys))
        assertTrue(ShareSeals.of(context).queued.contains(server.grace.id.lowercase()))
        vault.trustGrantee(grace(), follow = true)
        assertFalse(vault.lookup(email).changed)
    }

    @Test
    fun settingsThatLostAPinTheGuardHoldsAreAChangeNeverFirstUse() {
        vault.addContact(email)
        // An older copy of the settings, saved over at a higher sequence, without her (no removal recorded) ...
        server.editSettings { it.unpin(server.grace.id) }
        // ... and the server serving other keys for her: first use would pin them silently.
        server.startOverGrace()
        val found = vault.lookup(email)
        assertTrue(found.changed)
        assertNotNull(found.heldFingerprint)
        assertNull(stored())
        assertThrows(ContactProblem::class.java) { vault.trustGrantee(grace(), follow = true) }
        assertNull(stored())
    }

    @Test
    fun aShareFromSomeoneNeverAddedOpensAndPinsThemWhileARemovalWaitsForTheirOpen() {
        val folder = server.folder(server.graceRoot, "From Grace")
        server.shareWithMe(folder)
        assertNotNull(vault.mountShares().single().root)
        assertEquals("shared-with-me", stored()!!.firstSeen)
        assertEquals(PinTrust.SEEN, stored()!!.trust)
        vault.remove(server.grace.id)
        assertTrue(server.settings().removed(server.grace.id))
        val waiting = vault.mountShares().single()
        assertNull(waiting.root)
        assertTrue(waiting.trust is GranterTrust.Waiting)
        assertEquals("You removed Grace from your contacts. Open this to add them again.", waiting.trust!!.message)
        assertNull(stored())
        // Open, the person's own act, adds them back and forgets the removal.
        vault.openWaiting(vault.api.sharedWithMe().single())
        assertFalse(server.settings().removed(server.grace.id))
        assertNotNull(vault.mountShares().single().root)
    }

    @Test
    fun aGuardThatWontOpenPausesEveryoneAndNeverStartsAnyoneOver() {
        val folder = server.folder(server.graceRoot, "From Grace")
        server.shareWithMe(folder)
        vault.addContact(email)
        vault.guard.file.writeText(vault.guard.file.readText().replace("\"record\":\"", "\"record\":\"AA"))
        val mount = vault.mountShares().single()
        assertNull(mount.root)
        assertTrue(mount.trust is GranterTrust.Unchecked)
        assertThrows(GuardUnreadable::class.java) { vault.lookup(email) }
        assertThrows(GuardUnreadable::class.java) { vault.contactStandings() }
        assertThrows(GuardUnreadable::class.java) { vault.trustGrantee(grace(), follow = true) }
    }

    @Test
    fun anActWhoseSaveLandedButWhoseAnswerWasLostIsFinishedOnTheNextReadWithItsReSealQueuedFirst() {
        vault.addContact(email)
        val held = guardEntry()!!
        server.startOverGrace()
        val change = (vault.addContact(email) as Added.Changed).change
        server.loseNextSettingsAnswer = true
        assertThrows(AuthFailure::class.java) { vault.continueWith(change) }
        // The save landed; the guard still holds the old keys with the act pending; the re-seal was queued before the save.
        assertEquals(grace().commitment, stored()!!.commitment)
        assertEquals(held, guardEntry())
        assertNotNull(vault.guard.pending(server.grace.id))
        assertTrue(ShareSeals.of(context).queued.contains(server.grace.id.lowercase()))
        // As after a re-seal pass that ran meanwhile: the next read that finishes the act owes the re-seal again.
        ShareSeals.of(context).let { it.unqueue(it.queued) }
        val found = vault.lookup(email)
        assertFalse(found.changed)
        assertTrue(found.trustChanged)
        assertNull(vault.guard.pending(server.grace.id))
        assertEquals(grace().commitment, keyCommitment(guardEntry()!!.keys))
        assertTrue(ShareSeals.of(context).queued.contains(server.grace.id.lowercase()))
    }

    @Test
    fun mountingReadsTheSettingsOnceAndKeepsOneVerdictPerGranterAndTheFullIdentityTheirShareCameWith() {
        vault.addContact(email)
        val a = server.folder(server.graceRoot, "A")
        val b = server.folder(server.graceRoot, "B")
        val c = server.folder(server.graceRoot, "C")
        server.shareWithMe(a)
        server.shareWithMe(b)
        // The same person, listed in the middle of the list with keys of the server's own.
        server.shareWithMe(c, servedAs = server.impostorOfGrace())
        val reads = server.requests.count { it == "GET /api/auth/settings" }
        val mounts = vault.mountShares().associateBy { it.share.node.id }
        assertEquals(1, server.requests.count { it == "GET /api/auth/settings" } - reads)
        assertNotNull(mounts.getValue(a).root)
        assertNotNull(mounts.getValue(b).root)
        assertNull(mounts.getValue(c).root)
        assertTrue(mounts.getValue(c).trust is GranterTrust.Changed)
    }

    @Test
    fun aRotationKeepsAVerdictOnlyForTheKeysItWasMadeOver() {
        vault.addContact(email)
        val sealTo = vault.granteeSealer(vault.loadSettings())
        sealTo(server.grace.id, server.grace.served)
        assertThrows(AccountChanged::class.java) { sealTo(server.grace.id, server.impostorOfGrace().served) }
    }

    @Test
    fun aLegacyPinBecomesFirstSeenOnTheNextActOverTheKeysItHeld() {
        val legacy = TestPins.preRelease(grace().pin(verified = false, firstSeen = null))
        server.editSettings { it.pin(legacy) }
        assertEquals(PinTrust.LEGACY, stored()!!.trust)
        val found = vault.lookup(email)
        assertFalse(found.changed)
        assertEquals(PinTrust.SEEN, stored()!!.trust)
        assertEquals(grace().commitment, stored()!!.commitment)
    }

    @Test
    fun theShareSheetsLookupsAreKeptAMinuteForgottenOnRemovalAndAFailureIsNeverUnchanged() {
        val pin = (vault.addContact(email) as Added.New).pin
        var now = 1_000_000L
        vault.memory.clock = { now }
        val before = server.lookups
        assertFalse(vault.shareeChanged(pin))
        assertFalse(vault.shareeChanged(pin))
        assertEquals(1, server.lookups - before)
        now += TrustMemory.LOOKUP_KEPT_MS
        assertFalse(vault.shareeChanged(pin))
        assertEquals(2, server.lookups - before)
        // Continue, They match and removal forget the person: the next row looks them up afresh.
        vault.remove(pin.userId)
        server.failLookups = true
        assertThrows(AuthFailure::class.java) { vault.shareeChanged(pin) }
        assertNotEquals(before + 2, server.lookups)
    }

    @Test
    fun aPinWithItsKeysButAFingerprintOverOthersIsMadeFirstSeenNotKeptToFailEveryAct() {
        // Valid keys, a non-empty fingerprint that isn't theirs (an edited or older format): it vouches for nothing.
        val invalid = grace().pin(verified = false, firstSeen = null).copy(fingerprint = "0".repeat(64))
        server.editSettings { it.pin(invalid) }
        assertEquals(PinTrust.INVALID, stored()!!.trust)
        assertFalse(vault.lookup(email).changed)
        assertEquals(PinTrust.SEEN, stored()!!.trust)
        assertEquals(grace().commitment, keyCommitment(guardEntry()!!.keys))
        assertTrue(vault.addContact(email) is Added.Already)
    }

    @Test
    fun aReSealPassThatCouldNotFindAnItemKeepsThemQueuedAndOnlyADeletionLetsThemGo() {
        vault.addContact(email)
        val seals = ShareSeals.of(context)
        // A ledger item this device can't resolve right now (never listed here): not a deletion.
        server.editSettings { it.addShare("0b8f2d1e-5c3a-4e7b-9a6d-2f1e0c9b8a7d", server.grace.id) }
        seals.queue(server.grace.id)
        vault.resealLedgerShares()
        assertTrue(server.grace.id.lowercase() in seals.queued)
        // The same item confirmed gone (its folder lists without it): done with.
        val gone = server.folder(server.root, "Gone")
        vault.listChildren(server.root)
        server.editSettings { it.removeShare("0b8f2d1e-5c3a-4e7b-9a6d-2f1e0c9b8a7d", server.grace.id); it.addShare(gone, server.grace.id) }
        server.drop(gone)
        vault.forget(server.workspace, gone)
        vault.resealLedgerShares()
        assertFalse(server.grace.id.lowercase() in seals.queued)
    }

    @Test
    fun aWriterWhosePinVouchesForNothingIsStillNamedSoTheirMarkOffersTheirCheck() {
        val legacy = TestPins.preRelease(grace().pin(verified = false, firstSeen = null))
        server.editSettings { it.pin(legacy) }
        val writer = vault.trust().writer(server.grace.id)
        assertEquals(Writer.Unknown(email, "Grace Hopper"), writer)
        // And their keys are trusted for nothing.
        assertNull(vault.trust().keysFor(server.grace.id))
    }

    @Test
    fun aRotationSealsToALegacyPinsOwnKeysWhenTheSettingsHaveNoRoomToSaveItsMigration() {
        val legacy = TestPins.preRelease(grace().pin(verified = false, firstSeen = null))
        // Room for the legacy pin, none for it made first-seen (its ML-DSA digest more).
        server.editSettings { it.pin(legacy); it.json.put("padding", "x".repeat(Settings.MAX_BYTES - it.bytes() - 40)) }
        val sealTo = vault.granteeSealer(vault.loadSettings())
        // Left out, the server would revoke her; stopped, the rotation would never finish: sealed to the keys she has.
        val (publicKey, _) = sealTo(server.grace.id, server.grace.served)
        assertEquals(grace().encryptionPublicKey, com.hushos.core.base64urlEncode(publicKey))
        // Nothing saved and nothing remembered: no new trust.
        assertEquals(PinTrust.LEGACY, stored()!!.trust)
        assertNull(guardEntry())
        // Other keys served for her stay a verdict.
        assertThrows(AccountChanged::class.java) { sealTo(server.grace.id, server.impostorOfGrace().served) }
    }

    @Test
    fun addingSomeoneAlreadyThereSaysWhenTheAddItselfMovedTrust() {
        val legacy = TestPins.preRelease(grace().pin(verified = false, firstSeen = null))
        server.editSettings { it.pin(legacy) }
        // Already a contact, but the add made the legacy pin first-seen and remembered her: what is drawn is judged again.
        val added = vault.addContact(email)
        assertTrue(added is Added.Already)
        assertTrue(added.trustChanged)
        // Adding again moves nothing.
        assertFalse(vault.addContact(email).trustChanged)
        assertTrue((vault.addContact(email) as Added.Already).pin.trust == PinTrust.SEEN)
    }

    @Test
    fun sharingWithSomeoneWhosePinTheCheckMovedSaysTrustMoved() {
        val legacy = TestPins.preRelease(grace().pin(verified = false, firstSeen = null))
        server.editSettings { it.pin(legacy) }
        val folder = server.folder(server.root, "Plans")
        vault.listChildren(server.root)
        val item = vault.item(folder)!!
        // The share's check makes the legacy pin first-seen and remembers her: what is drawn is judged again.
        assertTrue(vault.share(item, stored()!!, "viewer").trustChanged)
        assertEquals(PinTrust.SEEN, stored()!!.trust)
        // Sharing again moves nothing about whom this phone trusts.
        assertFalse(vault.share(item, stored()!!, "editor").trustChanged)
    }

    @Test
    fun aReSealPassThatAcknowledgesWhileContinueSavesLeavesTheReSealContinueOwes() {
        vault.addContact(email)
        server.startOverGrace()
        val change = (vault.addContact(email) as Added.Changed).change
        val seals = ShareSeals.of(context)
        // A pass that read the queue (Continue's request in it) and settings without the new pin finishes as the save lands.
        server.onSettingsPut = { seals.unqueue(seals.queued) }
        vault.continueWith(change)
        server.onSettingsPut = null
        assertTrue(server.grace.id.lowercase() in seals.queued)
    }

    @Test
    fun aRotationStoppedMidBatchLeavesEveryKeyAsItWasAndARetryRotatesTheWholeBatch() {
        vault.addContact(email)
        val folder = server.folder(server.root, "Plans")
        val file = server.file(folder, "plan.md", ByteArray(64) { 1 })
        vault.listChildren(server.root)
        vault.listChildren(folder)
        server.editSettings { it.addShare(file, server.grace.id) }
        server.rotationShares[file] = mutableListOf(JSONObject().put("id", "share-1").put("granteeUserId", server.grace.id)
            .put("grantee", server.grace.served.toJson()))
        val folderKey = vault.nodes.key(server.workspace, folder)!!
        val epoch = server.node(folder).keyEpoch
        // The file's grantee check can't read the settings (no verdict on Grace), after the folder was sealed.
        server.failSettingsOnceWorkListed = true
        assertThrows(AuthFailure::class.java) { vault.rotate(vault.item(folder)!!) }
        assertEquals(epoch, server.node(folder).keyEpoch)
        // Nothing was sent, so nothing changed here either: the folder keeps the key the server still holds.
        assertTrue(folderKey.contentEquals(vault.nodes.key(server.workspace, folder)!!))
        assertTrue(server.keyOf(folder).contentEquals(vault.nodes.key(server.workspace, folder)!!))
        // The settings read again: a retry walks both from the keys the server holds, and rotates both.
        server.failSettingsOnceWorkListed = false
        assertEquals(2, vault.rotate(vault.item(folder)!!).done)
        assertTrue(server.node(folder).keyEpoch > epoch && server.node(file).keyEpoch > epoch)
        assertEquals("plan.md", server.record(file).name)
    }

    @Test
    fun aReSealPassJudgesARequestOnlyAgainstSettingsAtLeastAsNewAsIt() {
        val seals = ShareSeals.of(context)
        // A Continue lands right after the pass read the settings: its request must not be judged against them.
        server.onNextSettingsGet = { seals.queue(server.grace.id) }
        vault.resealLedgerShares()
        assertTrue(server.grace.id.lowercase() in seals.queued)
    }

    @Test
    fun aReSealPassKeepsSomeoneQueuedWhoseItemIsInTheTrashNotDeleted() {
        vault.addContact(email)
        val folder = server.folder(server.root, "Plans")
        val file = server.file(folder, "plan.md", ByteArray(64) { 1 })
        vault.listChildren(server.root)
        vault.listChildren(folder)
        server.editSettings { it.addShare(file, server.grace.id) }
        val seals = ShareSeals.of(context)
        seals.queue(server.grace.id)
        // In the Trash, and this device holds no row for it: its folder lists without it, as for a deleted item.
        server.trash(file)
        vault.forget(server.workspace, file)
        vault.resealLedgerShares()
        // Restored, it would still hold the old keys: she stays owed.
        assertTrue(server.grace.id.lowercase() in seals.queued)
    }

    @Test
    fun aReSealPassNeverClearsAKeyReplacementThatStartedWhileItRan() {
        val seals = ShareSeals.of(context)
        assertNull(seals.pending)
        // This account replaces its keys while a pass that read the older ones runs.
        server.onNextSettingsGet = { seals.pending = 5uL }
        vault.resealLedgerShares()
        assertEquals(5uL, seals.pending)
    }

    @Test
    fun aRotationLeftForLaterOfAnItemInTheTrashIsKeptNotDropped() {
        val folder = server.folder(server.root, "Plans")
        val file = server.file(folder, "plan.md", ByteArray(64) { 1 })
        vault.listChildren(server.root)
        vault.listChildren(folder)
        val pending = PendingRotations.of(context)
        pending.add(server.workspace, file)
        server.trash(file)
        vault.forget(server.workspace, file)
        vault.finishRotations()
        // Restored, it would still open with keys the stopped share had: the rotation stays owed.
        assertTrue((server.workspace to file) in pending.all())
        // Deleted for good, it is let go.
        server.drop(file)
        vault.finishRotations()
        assertFalse((server.workspace to file) in pending.all())
    }

    @Test
    fun aRotationWhoseSendFailsStillListsTheFileInItsFolder() {
        val folder = server.folder(server.root, "Plans")
        val file = server.file(folder, "plan.md", ByteArray(64) { 1 })
        vault.listChildren(server.root)
        vault.listChildren(folder)
        // The catalogue answers for the folder, as after a build.
        vault.catalogueChildren[folder] = java.util.concurrent.ConcurrentHashMap.newKeySet<String>().apply { add(file) }
        vault.catalogueState = CatalogueState.READY
        server.failRotationSend = true
        assertThrows(Exception::class.java) { vault.rotate(vault.item(file)!!) }
        assertTrue(vault.listChildren(folder).any { it.id == file })
    }

    /*
     * Batch 1 (the folder) lands; batch 2 (its file, still wrapped under the folder's old key) is lost on the way.
     * The retry finishes from what the server holds, and every node opens.
     */
    @Test
    fun aRotationStoppedAfterABatchLandedFinishesOnRetryAndEveryNodeOpens() {
        val folder = server.folder(server.root, "Plans")
        val file = server.file(folder, "plan.md", ByteArray(64) { 1 })
        vault.listChildren(server.root)
        vault.listChildren(folder)
        server.rotationBatch = 1
        server.failRotationSends = setOf(2)
        assertThrows(Exception::class.java) { vault.rotate(vault.item(folder)!!) }
        assertTrue(server.node(folder).keyEpoch > server.node(file).keyEpoch)
        // Meanwhile the folder still lists the file it hasn't reached.
        assertEquals(listOf("plan.md"), vault.listChildren(folder).map { it.name })
        // Retried from what the vault offers now, as the next Drive open does.
        vault.rotate(vault.item(folder) ?: vault.resolve(folder))
        assertEquals(server.node(folder).keyEpoch, server.node(file).keyEpoch)
        assertEquals(listOf("plan.md"), vault.listChildren(folder).map { it.name })
        assertEquals("Plans", vault.resolve(folder).name)
        // Finished: no previous key is kept for anything under it.
        assertTrue(vault.rotatedKeys.isEmpty())
    }
}
