package com.hushos.app.data

import com.hushos.core.IdentityEnvelope
import com.hushos.core.base64urlDecode
import com.hushos.core.identityCreate
import com.hushos.core.identityOpen
import com.hushos.core.identitySucceed
import com.hushos.core.identityUpgrade
import com.hushos.core.identityVerifyKeys
import com.hushos.core.publicIdentity
import com.hushos.core.randomBytes
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files

/*
 * The upgrade on unlock (docs/identity-pq-design.md 2): a version 1 identity becomes version 2 with the same X25519,
 * Ed25519 and ML-KEM keys and key version before anything is signed; two devices upgrading at once end with one
 * identity; a device that has seen version 2 never opens (or upgrades) the version 1 form again. The identities are
 * the web's fixture: a version 1 identity and the web's own upgrade of it.
 */
class OwnIdentityTest {
    private val upgrade = WebFixture.json.getJSONObject("upgrade")
    private val userId = upgrade.getString("userId")
    private val accountKey = base64urlDecode(upgrade.getString("accountKey"))
    private val legacy = WebFixture.identity(upgrade.getJSONObject("legacy"))
    private val webUpgrade = WebFixture.identity(upgrade.getJSONObject("upgraded"))
    private val marks = SettingsMark(Files.createTempDirectory("marks").resolve("marks").toFile(), SettingsMarkTest.keys(7))

    private class Server(var current: IdentityEnvelope, val conflict: IdentityEnvelope? = null) {
        val stored = ArrayList<IdentityEnvelope>()
        fun store(next: IdentityEnvelope): IdentityEnvelope {
            stored.add(next)
            // Another device got there first: the server keeps its identity and answers 409.
            conflict?.let { current = it; throw AuthFailure("stale", 409) }
            current = next
            return next
        }
    }

    private fun open(server: Server, upgraded: () -> Unit = {}) =
        openOwnIdentity(userId, accountKey, marks, served = { server.current }, store = server::store, upgraded = upgraded)

    @Test
    fun aVersionOneIdentityIsUpgradedWithItsOwnKeysAndAKeysStatementThatHolds() {
        val server = Server(legacy)
        var told = 0
        val opened = open(server) { told++ }
        val sent = server.stored.single()
        assertEquals(2u, sent.version)
        // The same keys and key version: file signatures keep verifying, and the server refuses anything else.
        assertEquals(legacy.keyVersion, sent.keyVersion)
        assertEquals(legacy.encryptionPublicKey, sent.encryptionPublicKey)
        assertEquals(legacy.signingPublicKey, sent.signingPublicKey)
        assertEquals(legacy.kem!!.publicKey, sent.kem!!.publicKey)
        // Version 2 carries no KEM binding; the keys statement replaces it, and holds under both halves.
        assertNull(sent.kem!!.signature)
        assertTrue(identityVerifyKeys(userId, publicIdentity(sent)))
        assertEquals(2u, opened.identityVersion)
        assertEquals(sent.mlDsa!!.publicKey, opened.mlDsaPublicKey)
        assertEquals(1, told)
        // What went over the wire is what the server's schema takes: no binding on a version 2 KEM half.
        val wire = Auth.json(sent)
        assertFalse(wire.getJSONObject("kem").has("signature"))
        assertEquals(sent, Auth.identityEnvelope(wire))
        // The version 1 form keeps its binding when it is rewrapped (the history, a master-key rotation).
        assertTrue(Auth.json(legacy).getJSONObject("kem").has("signature"))
        assertEquals(legacy, Auth.identityEnvelope(Auth.json(legacy)))
    }

    @Test
    fun aDeviceThatLostTheRaceAdoptsTheIdentityTheOtherOneStored() {
        val server = Server(legacy, conflict = webUpgrade)
        var told = 0
        val opened = open(server) { told++ }
        // This device made its own ML-DSA key and offered it; the server kept the other device's, and that one is used.
        assertNotEquals(webUpgrade.mlDsa!!.publicKey, server.stored.single().mlDsa!!.publicKey)
        assertEquals(webUpgrade.mlDsa!!.publicKey, opened.mlDsaPublicKey)
        assertEquals(0, told)
    }

    @Test
    fun anIdentityAlreadyUpgradedIsOpenedAsItIs() {
        val server = Server(webUpgrade)
        assertEquals(webUpgrade.mlDsa!!.publicKey, open(server).mlDsaPublicKey)
        assertTrue(server.stored.isEmpty())
    }

    @Test
    fun afterSeeingVersionTwoTheVersionOneFormIsRefusedAndNoSecondMlDsaKeyIsMade() {
        open(Server(webUpgrade))
        val rolledBack = Server(legacy)
        assertThrows(IdentityRolledBack::class.java) { open(rolledBack) }
        assertTrue(rolledBack.stored.isEmpty())
    }

    @Test
    fun aServerThatAnswersTheUpgradeWithTheOldFormIsNotTakenAsUpgraded() {
        val server = object {
            val stored = ArrayList<IdentityEnvelope>()
        }
        val refused = assertThrows(AuthFailure::class.java) {
            openOwnIdentity(userId, accountKey, marks, served = { legacy }, store = { server.stored.add(it); legacy })
        }
        assertEquals("Your keys could not be upgraded. Try again.", refused.message)
        // Nothing was marked as seen at version 2, and a later honest upgrade still works.
        assertEquals(2u, open(Server(legacy)).identityVersion)
    }

    @Test
    fun aFailedUpgradeOtherThanAConflictStopsBeforeAnythingIsSigned() {
        // Were it handled as a 409, the identity served next (another device's upgrade) would be read and adopted.
        var reads = 0
        var told = 0
        val failure = AuthFailure("Update HushOS to save changes", 400)
        val thrown = assertThrows(AuthFailure::class.java) {
            openOwnIdentity(userId, accountKey, marks, served = { if (reads++ == 0) legacy else webUpgrade }, store = { throw failure }, upgraded = { told++ })
        }
        assertSame(failure, thrown)
        assertEquals("the identity is not read again", 1, reads)
        assertEquals(0, told)
        // Nothing was adopted: the version 1 form still opens (and upgrades) afterwards.
        assertEquals(2u, open(Server(legacy)).identityVersion)
    }

    /* A version 1 form of a version 2 identity: the same keys without ML-DSA or the keys statement. */
    private fun versionOne(envelope: IdentityEnvelope) =
        envelope.copy(version = 1u, mlDsa = null, keysSignature = null, kem = envelope.kem?.copy(signature = null))

    @Test
    fun anIdentityAdoptedFromAConflictIsHeldToTheMarks() {
        val root = randomBytes(32u)
        val current = identityCreate(userId, root, 3uL)
        // This device opened the version 1 identity at key version 3 before the release.
        marks.recordIdentity(userId, 3uL, 1u)
        // The re-read after the 409 hands back a version 2 identity of the account at an older key version.
        val older = identityCreate(userId, root, 2uL)
        val rolledBack = Server(versionOne(current), conflict = older)
        assertThrows(IdentityRolledBack::class.java) {
            openOwnIdentity(userId, root, marks, served = { rolledBack.current }, store = rolledBack::store)
        }
        // An honest race: the winner is adopted, and the version 1 form served next is refused, never upgraded again.
        val winner = identityUpgrade(userId, root, versionOne(current))
        val raced = Server(versionOne(current), conflict = winner)
        assertEquals(winner.mlDsa!!.publicKey, openOwnIdentity(userId, root, marks, served = { raced.current }, store = raced::store).mlDsaPublicKey)
        val next = Server(versionOne(current))
        assertThrows(IdentityRolledBack::class.java) { openOwnIdentity(userId, root, marks, served = { next.current }, store = next::store) }
        assertTrue(next.stored.isEmpty())
    }

    @Test
    fun aSuccessionIsSignedOnlyOverTheIdentityThisDeviceOpened() {
        val root = randomBytes(32u)
        val first = identityCreate(userId, root, 1uL)
        val second = identitySucceed(userId, root, first).identity
        val opened = identityOpen(userId, root, second)
        // The identity it opened, served as it is: the succession goes ahead, from those keys.
        val succession = succeedOwnIdentity(userId, root, opened, second)
        assertTrue(succession.identity.keyVersion > second.keyVersion)
        assertNotEquals(second.signingPublicKey, succession.identity.signingPublicKey)
        // The identity the account replaced, served again: it opens under the same root, but is not the one opened.
        assertThrows(IdentityMoved::class.java) { succeedOwnIdentity(userId, root, opened, first) }
        // Any one of the four keys, the key version or the identity version other than the opened identity's.
        val other = identityCreate(userId, root, 2uL)
        for (served in listOf(
            second.copy(encryptionPublicKey = other.encryptionPublicKey),
            second.copy(signingPublicKey = other.signingPublicKey),
            second.copy(mlDsa = other.mlDsa),
            second.copy(kem = other.kem),
            second.copy(keyVersion = second.keyVersion + 1uL),
            versionOne(second),
        )) assertThrows(IdentityMoved::class.java) { succeedOwnIdentity(userId, root, opened, served) }
    }

    @Test
    fun theOwnWordsAreOverTheFourKeysTheDeviceOpened() {
        val share = WebFixture.json.getJSONObject("share")
        val account = WebFixture.json.getJSONObject("account")
        val keys = identityOpen(account.getString("userId"), base64urlDecode(account.getString("accountKey")), WebFixture.identity(share.getJSONObject("identity")))
        assertEquals(WebFixture.json.getJSONObject("fingerprints").getString("identity"), ownFingerprint(keys))
    }
}
