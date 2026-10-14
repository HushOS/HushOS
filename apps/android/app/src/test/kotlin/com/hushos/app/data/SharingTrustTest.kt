package com.hushos.app.data

import com.hushos.core.ShareContext
import com.hushos.core.base64urlDecode
import com.hushos.core.base64urlEncode
import com.hushos.core.identityCreate
import com.hushos.core.identityFingerprint
import com.hushos.core.identityOpen
import com.hushos.core.keyDigest
import com.hushos.core.randomBytes
import com.hushos.core.shareSeal
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/*
 * Who a node key is sealed to, and which received shares open. The identity is the web's own fixture
 * (crates/hushos-core/fixtures/web.json): a version 2 identity with its four public keys and the keys statement the
 * web signed. A pin vouches only when it is version 3 (the ML-DSA digest, and the version 3 fingerprint over all four
 * keys); a share is sealed only hybrid, to the ML-KEM key whose digest the pin holds; a rotation re-seals only what
 * the owner's ledger holds.
 */
class SharingTrustTest {
    private val fixture = JSONObject(File("../../../crates/hushos-core/fixtures/web.json").readText())
    private val userId = fixture.getJSONObject("account").getString("userId")
    private val envelope = WebFixture.identity(fixture.getJSONObject("share").getJSONObject("identity"))
    private val served = WebFixture.served(envelope)
    private val enc = served.encryptionPublicKey
    private val sig = served.signingPublicKey
    private val kem = served.kemPublicKey!!
    private val nodeId = "722d2ea4-f3a4-4d34-8843-1965d8233f83"

    private val verified = ContactPin.ofServed(userId, "ada@example.org", "Ada", served, "2026-10-01T00:00:00Z")!!
    /* Pinned before the release: the same keys, no ML-DSA digest. */
    private val preRelease = TestPins.preRelease(verified)
    /* A stored fingerprint that isn't the current one over the pinned keys (an older format, or tampered). */
    private val staleFingerprint = verified.copy(fingerprint = identityFingerprint(base64urlDecode(enc), ByteArray(32) { 7 }, ByteArray(32) { 3 }, ByteArray(32) { 4 }))
    private fun flipped(key: String) = base64urlEncode(base64urlDecode(key).also { it[0] = (it[0].toInt() xor 1).toByte() })

    @Test
    fun theWordsAreTheWebsAndOnlyAnUpgradedIdentityWhoseKeysStatementHoldsHasThem() {
        val contact = Contact(userId, "Ada", "ada@example.org", served)
        assertTrue(contact.upgraded)
        assertEquals(fixture.getJSONObject("fingerprints").getString("identity"), contact.fingerprint)
        // Words are never shown over a statement that does not hold: a flipped signature, an ML-KEM key it does not
        // name (a server swapping in its own), or the version 1 form of the same keys.
        for (bad in listOf(served.copy(keysSignature = flipped(served.keysSignature!!)), served.copy(kemPublicKey = flipped(kem)),
            served.copy(identityVersion = 1), served.copy(mlDsaPublicKey = null))) {
            val other = Contact(userId, "Ada", "ada@example.org", bad)
            assertFalse(other.upgraded)
            assertNull(other.fingerprint)
            assertNull(ContactPin.ofServed(userId, "ada@example.org", "Ada", bad.copy(mlDsaPublicKey = null), "now"))
        }
        // The statement binds the account: the same keys served for someone else do not hold.
        assertFalse(Contact("another-user", "Ada", "ada@example.org", served).upgraded)
    }

    @Test
    fun theFingerprintChangesWithEachOfTheFourKeys() {
        val base = verified.fingerprint
        for (other in listOf(served.copy(encryptionPublicKey = flipped(enc)), served.copy(signingPublicKey = flipped(sig)),
            served.copy(mlDsaPublicKey = flipped(served.mlDsaPublicKey!!)), served.copy(kemPublicKey = flipped(kem)))) {
            assertNotEquals(base, ContactPin.ofServed(userId, "a", "A", other, "now")!!.fingerprint)
        }
    }

    @Test
    fun aVersionThreePinSealsOnlyToTheMlKemKeyItsDigestNames() {
        assertTrue(verified.verified)
        assertEquals(keyDigest(base64urlDecode(served.mlDsaPublicKey!!)), verified.mlDsaPublicKeyHash)
        assertArrayEquals(base64urlDecode(kem), granteeKem(verified, served))
        // Beside the pinned X25519 and Ed25519 keys: another ML-KEM key, another ML-DSA key, or none (the version 1 form).
        for (swapped in listOf(served.copy(kemPublicKey = flipped(kem)), served.copy(mlDsaPublicKey = flipped(served.mlDsaPublicKey!!)),
            served.copy(mlDsaPublicKey = null, identityVersion = 1, keysSignature = null), served.copy(kemPublicKey = null))) {
            val refused = assertThrows(SharingRefused::class.java) { granteeKem(verified, swapped) }
            assertEquals("Ada’s keys have changed since you checked them. Check it’s them in People you share with.", refused.message)
        }
    }

    @Test
    fun aPinThatVouchesForNothingIsRefusedForSharing() {
        for (pin in listOf(preRelease, staleFingerprint)) {
            val refused = assertThrows(SharingRefused::class.java) { granteeKem(pin, served) }
            assertEquals("Check Ada’s words again in People you share with: this pin was made before the words covered all their keys.", refused.message)
        }
    }

    @Test
    fun whatAPinSaysAboutServedKeys() {
        assertEquals(PinComparison.SAME, comparePin(verified, served))
        // The person upgraded (same classical keys) and was pinned before: words again, nothing trusted until then.
        assertEquals(PinComparison.RECHECK, comparePin(preRelease, served))
        assertEquals(PinComparison.RECHECK, comparePin(preRelease, served.copy(mlDsaPublicKey = null, identityVersion = 1)))
        val newer = TestPins.served(base64urlEncode(ByteArray(32) { 5 }), base64urlEncode(ByteArray(32) { 6 }), 3uL)
        assertEquals(PinComparison.SUCCESSION, comparePin(verified, newer))
        // Only a version 3 pin passes trust on, and only to version 2 keys at a higher key version.
        assertEquals(PinComparison.CHANGED, comparePin(preRelease, newer))
        assertEquals(PinComparison.CHANGED, comparePin(verified, newer.copy(mlDsaPublicKey = null)))
        assertEquals(PinComparison.CHANGED, comparePin(verified, newer.copy(keyVersion = 2uL)))
    }

    @Test
    fun aPinThatVouchesForNothingKeepsTheirSharesShut() {
        for (pin in listOf(preRelease, staleFingerprint))
            assertThrows(GranterTrust.Recheck::class.java) { granterKey(userId, "Ada", served, mapOf(userId to pin)) }
        val granter = granterKey(userId, "Ada", served, mapOf(userId to verified))
        assertEquals(sig, base64urlEncode(granter.signingPublicKey))
        // Other keys at the pinned version are a change no succession explains.
        val atTwo = mapOf(userId to verified.copy(keyVersion = 2uL))
        assertThrows(GranterTrust.Changed::class.java) { granterKey(userId, "Ada", served.copy(encryptionPublicKey = base64urlEncode(ByteArray(32) { 3 })), atTwo) }
        assertThrows(GranterTrust.Changed::class.java) { granterKey(userId, "Ada", served.copy(signingPublicKey = base64urlEncode(ByteArray(32) { 4 })), atTwo) }
        // At a newer version they may be a succession, followed only once the person checks again: shut until then.
        assertThrows(GranterTrust.Replaced::class.java) { granterKey(userId, "Ada", served.copy(keyVersion = 3uL, signingPublicKey = base64urlEncode(ByteArray(32) { 4 })), atTwo) }
    }

    private fun row(id: String, grantee: String, identity: ServedIdentity = served) =
        JSONObject().put("id", id).put("granteeUserId", grantee).put("grantee", identity.toJson())

    private fun link(id: String) = JSONObject().put("id", id).put("hasPassword", false).put("secretEnvelope", JSONObject.NULL)

    @Test
    fun aRotationResealsOnlyWhatTheLedgerHoldsInSuiteFour() {
        val stranger = "6f1c2b3a-0000-4000-8000-0000000000ff"
        val ledger = SharingLedger(mapOf(nodeId to setOf(userId)), mapOf("link-1" to nodeId, "link-2" to "another-node"))
        val plan = planReseal(
            nodeId,
            // The server adds a share to someone pinned but never shared with, and lists three links.
            listOf(row("share-1", userId), row("share-2", stranger)),
            listOf(link("link-1"), link("link-2"), link("link-3")),
            ledger, mapOf(userId to verified, stranger to verified.copy(userId = stranger)),
        )
        assertEquals(listOf("share-1"), plan.shares.map { it.id })
        assertEquals(listOf("link-1"), plan.links.map { it.getString("id") })
        assertTrue(plan.skipped.isEmpty())
        // What the rotation seals for that row is suite 4 (4565 bytes: an ephemeral key, ML-KEM, both signatures).
        val granterId = "8286d83e-31bc-4b1e-93bd-d18435de6b02"
        val ctx = ShareContext("654850ba-18bc-430a-ad22-5ffd1c105aa2", nodeId, 6uL, userId, granterId)
        val root = randomBytes(32u)
        val granter = identityOpen(granterId, root, identityCreate(granterId, root, 1uL))
        val share = plan.shares.single()
        val sealed = shareSeal(ctx, randomBytes(32u), granter, share.publicKey, share.kemPublicKey)
        assertEquals(4565, sealed.size)
        assertTrue(runCatching { shareSeal(ctx, randomBytes(32u), granter, share.publicKey, ByteArray(0)) }.isFailure)
    }

    @Test
    fun anIdentityThatIsNotUpgradedCannotSeal() {
        // A version 1 identity has no ML-DSA key to sign suite 4 with: the app upgrades on unlock, before any share.
        val upgrade = fixture.getJSONObject("upgrade")
        val legacy = identityOpen(upgrade.getString("userId"), base64urlDecode(upgrade.getString("accountKey")), WebFixture.identity(upgrade.getJSONObject("legacy")))
        assertEquals(1u, legacy.identityVersion)
        val ctx = ShareContext("654850ba-18bc-430a-ad22-5ffd1c105aa2", nodeId, 6uL, userId, upgrade.getString("userId"))
        assertTrue(runCatching { shareSeal(ctx, randomBytes(32u), legacy, base64urlDecode(enc), base64urlDecode(kem)) }.isFailure)
    }

    @Test
    fun aRotationSaysWhoItLeftOutInsteadOfSealingClassic() {
        val ledger = SharingLedger(mapOf(nodeId to setOf(userId)), emptyMap())
        val changed = "Ada’s keys have changed since you checked them. Check it’s them in People you share with."
        val cases = listOf(
            Triple(verified, served.copy(kemPublicKey = null), changed),
            Triple(verified, served.copy(kemPublicKey = flipped(kem)), changed),
            Triple(verified, served.copy(mlDsaPublicKey = null, identityVersion = 1, keysSignature = null), changed),
            Triple(staleFingerprint, served, "Check Ada’s words again in People you share with: this pin was made before the words covered all their keys."),
            Triple(preRelease, served, "Check Ada’s words again in People you share with: this pin was made before the words covered all their keys."),
        )
        for ((pin, identity, reason) in cases) {
            val plan = planReseal(nodeId, listOf(row("share-1", userId, identity)), emptyList(), ledger, mapOf(userId to pin))
            assertTrue(plan.shares.isEmpty())
            assertEquals(listOf(reason), plan.skipped)
        }
    }

    @Test
    fun aLinkFromAnOlderDerivationIsRefused() {
        assertThrows(OldLink::class.java) { LinkKdf.check(1, supported = 2) }
        assertThrows(OldLink::class.java) { LinkKdf.check(null, supported = 2) }
        LinkKdf.check(2, supported = 2)
        // As the owner's list serves them: one without a version is older than any this app reads.
        fun listed(kdf: Int?) = LinkView.from(JSONObject().put("id", "l").put("keyEpoch", 1).put("secretEnvelope", JSONObject.NULL).put("hasPassword", false)
            .put("expiresAt", JSONObject.NULL).put("lastUsedAt", JSONObject.NULL).put("createdAt", "2026-10-01T00:00:00Z").put("kdfVersion", kdf ?: JSONObject.NULL))
        assertEquals(false, listed(null).current)
        assertEquals(false, listed(com.hushos.core.linkKdfVersion().toInt() - 1).current)
        assertEquals(true, listed(com.hushos.core.linkKdfVersion().toInt()).current)
    }
}
