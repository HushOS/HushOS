package com.hushos.app.data

import com.hushos.core.base64urlDecode
import com.hushos.core.base64urlEncode
import com.hushos.core.identityCreate
import com.hushos.core.identityFingerprint
import com.hushos.core.identitySucceed
import com.hushos.core.keyDigest
import com.hushos.core.randomBytes
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/*
 * When a pinned contact's served keys change, the pin follows only a succession chain the pinned keys signed
 * (docs/integrity-design.md, "What contacts see"). The link is the web's fixture: the fixture identity at key
 * version 2 replaced by a new one at 3. A chain that doesn't hold, a pin that vouched for nothing, or keys that
 * aren't the chain's end stay the changed-key warning: the pin is left as it was.
 */
class SuccessionPinTest {
    private val fixture = WebFixture.json
    private val succession = fixture.getJSONObject("succession")
    private val userId = succession.getString("userId")
    private val link = WebFixture.link(succession.getJSONObject("link"))
    private val now = "2026-10-12T09:00:00Z"

    private val pinned = ContactPin(userId, "ada@example.org", "Ada", link.oldEncryptionPublicKey, link.oldSigningPublicKey,
        identityFingerprint(base64urlDecode(link.oldEncryptionPublicKey), base64urlDecode(link.oldSigningPublicKey)),
        "2026-10-01T00:00:00Z", "old-kem-hash", keyVersion = 2uL)
    private val served = ServedIdentity(3uL, link.newEncryptionPublicKey, link.newSigningPublicKey, link.newKemPublicKey)

    @Test
    fun aChainThePinnedKeysSignedMovesThePinToTheNewKeys() {
        val next = followSuccession(pinned, served, listOf(link), now)!!
        assertEquals(link.newEncryptionPublicKey, next.encryptionPublicKey)
        assertEquals(link.newSigningPublicKey, next.signingPublicKey)
        assertEquals(identityFingerprint(base64urlDecode(link.newEncryptionPublicKey), base64urlDecode(link.newSigningPublicKey)), next.fingerprint)
        assertTrue("the moved pin must still vouch for its keys", next.verified)
        assertEquals(keyDigest(base64urlDecode(link.newKemPublicKey)), next.kemPublicKeyHash)
        assertEquals(3uL, next.keyVersion)
        // What the old key signed still verifies, and People is told so it can suggest comparing words again.
        assertEquals(listOf(link.oldSigningPublicKey), next.previousSigningKeys)
        assertEquals(now, next.keysReplacedAt)
        assertTrue(next.matches(served))
    }

    @Test
    fun aPinFromBeforeSuccessionsFindsTheChainByItsKeys() {
        assertTrue(needsChain(pinned.copy(keyVersion = null), served))
        assertEquals(1uL, chainFrom(pinned.copy(keyVersion = null)))
        assertEquals(link.newSigningPublicKey, followSuccession(pinned.copy(keyVersion = null), served, listOf(link), now)?.signingPublicKey)
    }

    @Test
    fun sharedWithMeServesNoPostQuantumKeyAndTheChainsSignedOneIsTaken() {
        val next = followSuccession(pinned, served.copy(kemPublicKey = null), listOf(link), now)!!
        assertEquals(keyDigest(base64urlDecode(link.newKemPublicKey)), next.kemPublicKeyHash)
    }

    @Test
    fun aForgedOrBrokenChainLeavesThePinAlone() {
        val flipped = base64urlDecode(link.signature).also { it[5] = (it[5].toInt() xor 1).toByte() }
        assertNull("a signature that doesn't hold", followSuccession(pinned, served, listOf(link.copy(signature = base64urlEncode(flipped))), now))
        assertNull("no chain at all", followSuccession(pinned, served, emptyList(), now))
        // The server serves keys other than the chain's end (its own, say), with a genuine link beside them.
        val other = served.copy(encryptionPublicKey = base64urlEncode(ByteArray(32) { 4 }))
        assertNull("served keys that aren't the chain's end", followSuccession(pinned, other, listOf(link), now))
        assertNull("a post-quantum key other than the one the link signed", followSuccession(pinned, served.copy(kemPublicKey = link.newKemPublicKey.reversed()), listOf(link), now))
    }

    @Test
    fun aChainFromKeysThatArentThePinnedOnesIsNoChain() {
        // A genuine succession of another identity (the server's own, made from scratch) served for this contact.
        val root = randomBytes(32u)
        val stranger = identityCreate(userId, root, 2uL)
        val next = identitySucceed(userId, root, stranger)
        val strangerLink = link.copy(
            oldEncryptionPublicKey = stranger.encryptionPublicKey, oldSigningPublicKey = stranger.signingPublicKey,
            newEncryptionPublicKey = next.identity.encryptionPublicKey, newSigningPublicKey = next.identity.signingPublicKey,
            newKemPublicKey = next.identity.kem!!.publicKey, signature = next.signature,
        )
        val strangerServed = ServedIdentity(3uL, next.identity.encryptionPublicKey, next.identity.signingPublicKey, next.identity.kem!!.publicKey)
        assertNull(followSuccession(pinned, strangerServed, listOf(strangerLink), now))
    }

    @Test
    fun onlyAVerifiedPinAtAnOlderVersionAsksForAChain() {
        // Words never checked over both keys: nothing to follow from; they are checked again instead.
        val unchecked = pinned.copy(fingerprint = "")
        assertFalse(needsChain(unchecked, served))
        assertNull(followSuccession(unchecked, served, listOf(link), now))
        // Other keys served at the pinned version or below are a change no succession explains.
        assertFalse(needsChain(pinned.copy(keyVersion = 3uL), served))
        // The same keys served again (a master-key rotation may raise the version) need nothing.
        assertFalse(needsChain(pinned, ServedIdentity(4uL, pinned.encryptionPublicKey, pinned.signingPublicKey, null)))
    }

    @Test
    fun theFollowedPinSurvivesASaveAndAFreshWordsCheckClearsOnlyTheNotice() {
        val next = followSuccession(pinned, served, listOf(link), now)!!
        val settings = Settings.empty()
        settings.pin(next)
        val read = Settings.parse(settings.text(), 1uL).contacts.getValue(userId)
        assertEquals(next, read)
        // Compared again over the same keys: the notice goes, the vouched-for earlier key stays.
        settings.pin(read.copy(keysReplacedAt = null, pinnedAt = now))
        val again = Settings.parse(settings.text(), 2uL).contacts.getValue(userId)
        assertNull(again.keysReplacedAt)
        assertEquals(listOf(link.oldSigningPublicKey), again.previousSigningKeys)
    }
}
