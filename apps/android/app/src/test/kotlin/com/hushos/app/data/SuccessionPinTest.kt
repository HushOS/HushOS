package com.hushos.app.data

import com.hushos.core.IdentityEnvelope
import com.hushos.core.IdentitySuccession
import com.hushos.core.base64urlDecode
import com.hushos.core.base64urlEncode
import com.hushos.core.identityCreate
import com.hushos.core.identityFingerprintOfKeys
import com.hushos.core.identitySucceed
import com.hushos.core.keyDigest
import com.hushos.core.randomBytes
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import com.hushos.core.PinComparison

/*
 * When a pinned contact's served keys change, the pin follows only a version 2 succession chain the pinned keys
 * signed, both halves (docs/identity-pq-design.md 2). The link is the web's fixture: the fixture identity at key
 * version 2 replaced by a new one at 3. A chain that doesn't hold, a pin that vouched for nothing, or keys that
 * aren't the chain's end stay the changed-key warning: the pin is left as it was.
 */
class SuccessionPinTest {
    private val fixture = WebFixture.json
    private val succession = fixture.getJSONObject("succession")
    private val userId = succession.getString("userId")
    private val link = WebFixture.link(succession.getJSONObject("link"))
    private val old = WebFixture.served(WebFixture.identity(fixture.getJSONObject("share").getJSONObject("identity")))
    private val new = WebFixture.identity(succession.getJSONObject("identity"))
    private val now = "2026-10-12T09:00:00Z"

    private val pinned = ContactPin.ofServed(userId, "ada@example.org", "Ada", old, "2026-10-01T00:00:00Z")!!
    private val served = WebFixture.served(new)

    @Test
    fun aChainThePinnedKeysSignedMovesThePinToTheNewKeysAsAVersionThreePin() {
        assertEquals(link.oldMlDsaPublicKey, old.mlDsaPublicKey)
        val next = followSuccession(pinned, served, listOf(link), now)!!
        assertEquals(link.newEncryptionPublicKey, next.encryptionPublicKey)
        assertEquals(link.newSigningPublicKey, next.signingPublicKey)
        assertEquals(keyDigest(base64urlDecode(link.newMlDsaPublicKey)), next.mlDsaPublicKeyHash)
        assertEquals(keyDigest(base64urlDecode(link.newKemPublicKey)), next.kemPublicKeyHash)
        assertEquals(identityFingerprintOfKeys(base64urlDecode(link.newEncryptionPublicKey), base64urlDecode(link.newSigningPublicKey),
            base64urlDecode(link.newMlDsaPublicKey), base64urlDecode(link.newKemPublicKey)), next.fingerprint)
        assertTrue("the moved pin must still vouch for its keys", next.verified)
        assertEquals(3uL, next.keyVersion)
        // What the old key signed still verifies, and People is told so it can suggest comparing words again.
        assertEquals(listOf(link.oldSigningPublicKey), next.previousSigningKeys)
        assertEquals(now, next.keysReplacedAt)
        // Shares to them still hold the old keys: every client is told to seal them again.
        assertTrue(next.resealShares)
        assertEquals(PinComparison.SAME, next.compare(served))
    }

    @Test
    fun aDecoyLinkInFrontOfTheChainAddsNoKeyToThePreviousSigningKeys() {
        // The server's own identity, and a link from it that the core never checks.
        val root = randomBytes(32u)
        val server = identityCreate(userId, root, 2uL)
        val evil = linkOf(server, identitySucceed(userId, root, server))
        // At the pinned X25519 and Ed25519 keys, but another ML-DSA key: not where the core starts the chain.
        val decoy = link.copy(oldMlDsaPublicKey = server.mlDsa!!.publicKey)
        val next = followSuccession(pinned, served, listOf(decoy, evil, link), now)!!
        // Only the key the verified chain passed through: never the server's, whose records would read retired-key.
        assertEquals(listOf(link.oldSigningPublicKey), next.previousSigningKeys)
        assertFalse(server.signingPublicKey in next.previousSigningKeys)
        // The same decoy with nothing behind it is no chain at all.
        assertNull(followSuccession(pinned, served, listOf(decoy, evil), now))
    }

    /*
     * The pin's own signing key is kept as replaced whatever the start rule found: were it ever to miss where the core
     * started a chain the core verified, the records the pinned key signed would otherwise turn unknown-signer.
     */
    @Test
    fun aFollowedPinAlwaysKeepsItsOwnSigningKey() {
        // No start found: no link's key is kept, the pinned one still is.
        assertEquals(listOf(pinned.signingPublicKey), previousKeysAfter(pinned, listOf(link), null, served.signingPublicKey))
        // Kept once, oldest first, beside what the pin kept before; never the served key.
        val older = pinned.copy(previousSigningKeys = listOf("earlier-key", served.signingPublicKey))
        assertEquals(listOf("earlier-key", pinned.signingPublicKey), previousKeysAfter(older, listOf(link), 0, served.signingPublicKey))
    }

    @Test
    fun aPinFromBeforeSuccessionsFindsTheChainByItsKeys() {
        assertEquals(PinComparison.SUCCESSION, pinned.copy(keyVersion = null).compare(served))
        assertEquals(link.newSigningPublicKey, followSuccession(pinned.copy(keyVersion = null), served, listOf(link), now)?.signingPublicKey)
    }

    @Test
    fun aPinFromBeforeTheReleaseFollowsNothing() {
        // Its words never covered the ML-DSA key: a chain from its classical keys alone passes no trust on.
        val preRelease = TestPins.preRelease(pinned)
        assertEquals(PinComparison.CHANGED, preRelease.compare(served))
        assertNull(followSuccession(preRelease, served, listOf(link), now))
    }

    @Test
    fun aForgedOrBrokenChainLeavesThePinAlone() {
        val signature = base64urlDecode(link.signature)
        // Either half broken: the Ed25519 half (the first 64 bytes) or the ML-DSA half.
        for (at in listOf(5, 64 + 100)) {
            val flipped = signature.copyOf().also { it[at] = (it[at].toInt() xor 1).toByte() }
            assertNull("a signature half that doesn't hold ($at)", followSuccession(pinned, served, listOf(link.copy(signature = base64urlEncode(flipped))), now))
        }
        // Stripped to the Ed25519 half alone: a version 2 link never verifies classically.
        assertNull(followSuccession(pinned, served, listOf(link.copy(signature = base64urlEncode(signature.copyOf(64)))), now))
        assertNull("no chain at all", followSuccession(pinned, served, emptyList(), now))
        // The server serves keys other than the chain's end (its own, say), with a genuine link beside them.
        assertNull("served keys that aren't the chain's end", followSuccession(pinned, served.copy(encryptionPublicKey = base64urlEncode(ByteArray(32) { 4 })), listOf(link), now))
        assertNull("an ML-KEM key other than the one the link signed", followSuccession(pinned, served.copy(kemPublicKey = old.kemPublicKey), listOf(link), now))
        assertNull("an ML-DSA key other than the link's new one", followSuccession(pinned, served.copy(mlDsaPublicKey = old.mlDsaPublicKey), listOf(link), now))
    }

    @Test
    fun aChainFromThePinnedClassicalKeysWithAnotherMlDsaKeyIsNoChain() {
        // The pin's ML-DSA digest is someone else's: the link starts at the pinned X25519 and Ed25519 keys only.
        val otherMlDsa = TestPins.verified(userId, "ada@example.org", "Ada", old.encryptionPublicKey, old.signingPublicKey, keyVersion = 2uL, kem = old.kemPublicKey!!)
        assertNull(followSuccession(otherMlDsa, served, listOf(link), now))
    }

    private fun linkOf(old: IdentityEnvelope, next: IdentitySuccession) = link.copy(
        oldKeyVersion = old.keyVersion, newKeyVersion = next.identity.keyVersion,
        oldEncryptionPublicKey = old.encryptionPublicKey, oldSigningPublicKey = old.signingPublicKey, oldMlDsaPublicKey = old.mlDsa!!.publicKey,
        newEncryptionPublicKey = next.identity.encryptionPublicKey, newSigningPublicKey = next.identity.signingPublicKey,
        newMlDsaPublicKey = next.identity.mlDsa!!.publicKey, newKemPublicKey = next.identity.kem!!.publicKey, signature = next.signature,
    )

    @Test
    fun aChainFromKeysThatArentThePinnedOnesIsNoChain() {
        // A genuine succession of another identity (the server's own, made from scratch) served for this contact.
        val root = randomBytes(32u)
        val stranger = identityCreate(userId, root, 2uL)
        val next = identitySucceed(userId, root, stranger)
        assertNull(followSuccession(pinned, WebFixture.served(next.identity), listOf(linkOf(stranger, next)), now))
        // The stranger's link re-labelled with the pinned keys as its old ones: signed by the wrong keys, refused.
        val relabelled = linkOf(stranger, next).copy(oldEncryptionPublicKey = link.oldEncryptionPublicKey, oldSigningPublicKey = link.oldSigningPublicKey, oldMlDsaPublicKey = link.oldMlDsaPublicKey)
        assertNull(followSuccession(pinned, WebFixture.served(next.identity), listOf(relabelled), now))
    }

    @Test
    fun aFirstSeenPinFollowsAChainAndStaysFirstSeenWhileOneThatVouchesForNothingFollowsNone() {
        // First seen, nobody checked: a chain its keys signed is followed, and the pin stays first-seen, never verified.
        val seen = pinned.copy(fingerprint = "", firstSeen = "shared-with-me")
        assertEquals(PinComparison.SUCCESSION, seen.compare(served))
        val next = followSuccession(seen, served, listOf(link), now)!!
        assertEquals(com.hushos.core.PinTrust.SEEN, next.trust)
        assertEquals("shared-with-me", next.firstSeen)
        assertEquals(PinComparison.SAME, next.compare(served))
        assertEquals(com.hushos.core.PinTrust.VERIFIED, followSuccession(pinned, served, listOf(link), now)!!.trust)
        // A fingerprint over other keys vouches for nothing: nothing to follow from.
        val unchecked = pinned.copy(fingerprint = pinned.fingerprint.reversed())
        assertEquals(PinComparison.CHANGED, unchecked.compare(served))
        assertNull(followSuccession(unchecked, served, listOf(link), now))
        // Other keys served at the pinned version or below are a change no succession explains.
        assertEquals(PinComparison.CHANGED, pinned.copy(keyVersion = 3uL).compare(served))
        // The same keys served again (a master-key rotation may raise the version) need nothing.
        assertEquals(PinComparison.SAME, pinned.compare(old.copy(keyVersion = 4uL)))
    }

    @Test
    fun theFollowedPinSurvivesASaveAndAFreshWordsCheckClearsOnlyTheNotice() {
        val next = followSuccession(pinned, served, listOf(link), now)!!
        val settings = Settings.empty()
        settings.pin(next)
        val read = Settings.parse(settings.text(), 1uL).contacts.getValue(userId)
        assertEquals(next, read)
        assertTrue(read.verified)
        assertTrue(read.resealShares)
        // Compared again over the same keys: the notice goes, the vouched-for earlier key stays.
        settings.pin(read.copy(keysReplacedAt = null, pinnedAt = now))
        val again = Settings.parse(settings.text(), 2uL).contacts.getValue(userId)
        assertNull(again.keysReplacedAt)
        assertEquals(listOf(link.oldSigningPublicKey), again.previousSigningKeys)
    }

    @Test
    fun theWholeChainIsAskedForAndTheCoreFindsWhereThePinnedKeysEnterIt() {
        // Asked from the first version whatever the pin holds, so the request says nothing of it.
        assertEquals(1uL, CHAIN_FROM)
        // Successions before the pinned keys come with the whole chain: the pin follows from its own keys on.
        val root = randomBytes(32u)
        val first = identityCreate(userId, root, 1uL)
        val second = identitySucceed(userId, root, first)
        val third = identitySucceed(userId, root, second.identity)
        val chain = listOf(linkOf(first, second), linkOf(second.identity, third))
        val atSecond = ContactPin.ofServed(userId, "ada@example.org", "Ada", WebFixture.served(second.identity), "2026-10-01T00:00:00Z")!!
        val next = followSuccession(atSecond, WebFixture.served(third.identity), chain, now)!!
        assertEquals(third.identity.signingPublicKey, next.signingPublicKey)
        // Only the key the pin held is vouched for as earlier: the one before it was never checked by this person.
        assertEquals(listOf(second.identity.signingPublicKey), next.previousSigningKeys)
        // A chain with a gap (the middle link missing) carries nothing.
        val atFirst = ContactPin.ofServed(userId, "ada@example.org", "Ada", WebFixture.served(first), "2026-10-01T00:00:00Z")!!
        assertNull(followSuccession(atFirst, WebFixture.served(third.identity), chain.drop(1), now))
    }
}
