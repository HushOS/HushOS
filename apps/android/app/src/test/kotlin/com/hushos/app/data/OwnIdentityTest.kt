package com.hushos.app.data

import com.hushos.core.IdentityEnvelope
import com.hushos.core.base64urlDecode
import com.hushos.core.identityOpen
import com.hushos.core.identityVerifyKeys
import com.hushos.core.publicIdentity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
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
    private val marks = SettingsMark(Files.createTempDirectory("marks").resolve("seen.json").toFile())

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
        assertThrows(AuthFailure::class.java) {
            openOwnIdentity(userId, accountKey, marks, served = { legacy }, store = { throw AuthFailure("Update HushOS to save changes", 400) })
        }
    }

    @Test
    fun theOwnWordsAreOverTheFourKeysTheDeviceOpened() {
        val share = WebFixture.json.getJSONObject("share")
        val account = WebFixture.json.getJSONObject("account")
        val keys = identityOpen(account.getString("userId"), base64urlDecode(account.getString("accountKey")), WebFixture.identity(share.getJSONObject("identity")))
        assertEquals(WebFixture.json.getJSONObject("fingerprints").getString("identity"), ownFingerprint(keys))
    }
}
