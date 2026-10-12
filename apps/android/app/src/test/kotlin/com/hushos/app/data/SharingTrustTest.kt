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
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/*
 * Who a node key is sealed to, and which received shares open. The identity is the web's own fixture
 * (crates/hushos-core/fixtures/web.json): its X25519, Ed25519 and ML-KEM keys and the KEM binding the
 * web signed. A pin vouches only when its fingerprint is the current one over both pinned keys; a share
 * is sealed only hybrid, to a post-quantum key the pin remembers or the pinned identity signed; a
 * rotation re-seals only what the owner's ledger holds.
 */
class SharingTrustTest {
    private val fixture = JSONObject(File("../../../crates/hushos-core/fixtures/web.json").readText())
    private val userId = fixture.getJSONObject("account").getString("userId")
    private val identity = fixture.getJSONObject("share").getJSONObject("identity")
    private val enc = identity.getString("encryptionPublicKey")
    private val sig = identity.getString("signingPublicKey")
    private val kem = identity.getJSONObject("kem").getString("publicKey")
    private val kemSignature = identity.getJSONObject("kem").getString("signature")
    private val nodeId = "722d2ea4-f3a4-4d34-8843-1965d8233f83"

    private fun fingerprint(e: String, s: String) = identityFingerprint(base64urlDecode(e), base64urlDecode(s))
    private val verified = ContactPin(userId, "ada@example.org", "Ada", enc, sig, fingerprint(enc, sig), "2026-10-01T00:00:00Z", null)
    /* Pinned before signing keys were kept: nothing to check the words against. */
    private val noSigningKey = verified.copy(signingPublicKey = "", fingerprint = "")
    /* A stored fingerprint that isn't the current one over the pinned keys (an older format, or tampered). */
    private val staleFingerprint = verified.copy(fingerprint = fingerprint(enc, base64urlEncode(ByteArray(32) { 7 })))
    private val flippedKem = base64urlEncode(base64urlDecode(kem).also { it[0] = (it[0].toInt() xor 1).toByte() })

    @Test
    fun aVerifiedPinTakesTheSignedFirstKeyAndThenOnlyThatKey() {
        assertTrue(verified.verified)
        val first = granteeKem(verified, kem, kemSignature)
        assertEquals(keyDigest(base64urlDecode(kem)), first.firstHash)
        val remembered = verified.copy(kemPublicKeyHash = first.firstHash)
        assertNull(granteeKem(remembered, kem, null).firstHash)
        val changed = assertThrows(SharingRefused::class.java) { granteeKem(remembered, flippedKem, kemSignature) }
        assertEquals("Ada’s post-quantum key has changed since you pinned it. Check with them before sharing.", changed.message)
    }

    @Test
    fun anUnverifiedPinIsRefusedForSharing() {
        for (pin in listOf(noSigningKey, staleFingerprint)) {
            val refused = assertThrows(SharingRefused::class.java) { granteeKem(pin, kem, kemSignature) }
            assertEquals("Check Ada’s words again in People you share with before you share with them.", refused.message)
        }
    }

    @Test
    fun anUnverifiedPinKeepsTheirSharesShut() {
        for (pin in listOf(noSigningKey, staleFingerprint)) {
            val shut = assertThrows(GranterTrust.Recheck::class.java) { granterKeys(userId, "Ada", ServedIdentity(2uL, enc, sig, null), mapOf(userId to pin)) }
            assertEquals("Check Ada’s words again in People you share with to open what they shared.", shut.message)
        }
        val granter = granterKeys(userId, "Ada", ServedIdentity(2uL, enc, sig, null), mapOf(userId to verified)).single()
        assertEquals(enc, base64urlEncode(granter.encryptionPublicKey!!))
        assertEquals(sig, base64urlEncode(granter.signingPublicKey!!))
        assertThrows(GranterTrust.Changed::class.java) { granterKeys(userId, "Ada", ServedIdentity(2uL, base64urlEncode(ByteArray(32) { 3 }), sig, null), mapOf(userId to verified)) }
        // A swapped signing key under the pinned X25519 key is a changed account too: suite 3 shares are checked against it.
        assertThrows(GranterTrust.Changed::class.java) { granterKeys(userId, "Ada", ServedIdentity(2uL, enc, base64urlEncode(ByteArray(32) { 4 }), null), mapOf(userId to verified)) }
    }

    @Test
    fun aMissingOrUnsignedPostQuantumKeyIsRefusedRatherThanSealedClassic() {
        val missing = assertThrows(SharingRefused::class.java) { granteeKem(verified, null, null) }
        assertEquals("Ada hasn’t set up post-quantum keys yet.", missing.message)
        // Signed by the identity, but for another key; and the right key with no signature at all.
        for ((key, signature) in listOf(flippedKem to kemSignature, kem to null)) {
            val unsigned = assertThrows(SharingRefused::class.java) { granteeKem(verified, key, signature) }
            assertEquals("Ada’s post-quantum key is not signed by their identity.", unsigned.message)
        }
    }

    private fun served(id: String, grantee: String, kemKey: String?) = JSONObject().put("id", id).put("granteeUserId", grantee)
        .put("grantee", JSONObject().put("encryptionPublicKey", enc).put("signingPublicKey", sig)
            .put("kem", kemKey?.let { JSONObject().put("publicKey", it).put("signature", kemSignature) } ?: JSONObject.NULL))

    private fun link(id: String) = JSONObject().put("id", id).put("hasPassword", false).put("secretEnvelope", JSONObject.NULL)

    @Test
    fun aRotationResealsOnlyWhatTheLedgerHolds() {
        val stranger = "6f1c2b3a-0000-4000-8000-0000000000ff"
        val ledger = SharingLedger(mapOf(nodeId to setOf(userId)), mapOf("link-1" to nodeId, "link-2" to "another-node"))
        val plan = planReseal(
            nodeId,
            // The server adds a share to someone pinned but never shared with, and lists three links.
            listOf(served("share-1", userId, kem), served("share-2", stranger, kem)),
            listOf(link("link-1"), link("link-2"), link("link-3")),
            ledger, mapOf(userId to verified, stranger to verified.copy(userId = stranger)),
        )
        assertEquals(listOf("share-1"), plan.shares.map { it.id })
        assertEquals(listOf("link-1"), plan.links.map { it.getString("id") })
        assertTrue(plan.skipped.isEmpty())
        // What the rotation seals for that row is suite 3 (1256 bytes: an ephemeral key, ML-KEM, the granter's
        // signature), never the 72-byte X25519-only envelope, which the core no longer makes at all.
        val granterId = "8286d83e-31bc-4b1e-93bd-d18435de6b02"
        val ctx = ShareContext("654850ba-18bc-430a-ad22-5ffd1c105aa2", nodeId, 6uL, userId, granterId)
        val root = randomBytes(32u)
        val granter = identityOpen(granterId, root, identityCreate(granterId, root, 1uL))
        val share = plan.shares.single()
        val sealed = shareSeal(ctx, randomBytes(32u), granter, share.publicKey, share.kemPublicKey)
        assertEquals(1256, sealed.size)
        assertTrue(runCatching { shareSeal(ctx, randomBytes(32u), granter, share.publicKey, ByteArray(0)) }.isFailure)
    }

    @Test
    fun aRotationSaysWhoItLeftOutInsteadOfSealingClassic() {
        val ledger = SharingLedger(mapOf(nodeId to setOf(userId)), emptyMap())
        val cases = mapOf(
            "Ada hasn’t set up post-quantum keys yet." to Pair(verified, served("share-1", userId, null)),
            "Check Ada’s words again in People you share with before you share with them." to Pair(staleFingerprint, served("share-1", userId, kem)),
            "Ada’s post-quantum key is not signed by their identity." to Pair(verified, served("share-1", userId, flippedKem)),
        )
        for ((reason, case) in cases) {
            val plan = planReseal(nodeId, listOf(case.second), emptyList(), ledger, mapOf(userId to case.first))
            assertTrue(plan.shares.isEmpty())
            assertEquals(listOf(reason), plan.skipped)
        }
        // A first key checked here is handed back to be remembered on the pin.
        val plan = planReseal(nodeId, listOf(served("share-1", userId, kem)), emptyList(), ledger, mapOf(userId to verified))
        assertEquals(keyDigest(base64urlDecode(kem)), plan.firstKems[userId])
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
