package com.hushos.app.data

import com.hushos.core.base64urlEncode
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/*
 * A received share opens only under keys the person checked: the granter's current pinned Ed25519 key and the served
 * ML-DSA key whose digest the version 3 pin holds, never one they replaced, and never newer served keys the person
 * hasn't checked again (docs/identity-pq-design.md 2 and 3). Taking the server's word for the granter's keys would let
 * a server fake a share "from" anyone, sealed with keys of its own.
 */
class GranterTrustTest {
    private val pinnedKey = base64urlEncode(ByteArray(32) { 1 })
    private val serverKey = base64urlEncode(ByteArray(32) { 2 })
    private val signingKey = ByteArray(32) { 3 }
    private val earlierSigningKey = ByteArray(32) { 5 }
    private val pin = TestPins.verified("user-ana", "ana@example.com", "Ana Lima", pinnedKey, base64urlEncode(signingKey),
        keyVersion = 2uL, previous = listOf(base64urlEncode(earlierSigningKey)))
    private val pins = mapOf("user-ana" to pin)
    private fun served(enc: String = pinnedKey, sig: ByteArray = signingKey, version: ULong = 2uL) = TestPins.served(enc, base64urlEncode(sig), version)

    @Test(expected = GranterTrust.Unverified::class)
    fun aGranterNobodyPinnedIsRefused() {
        granterKey("user-ana", "Ana Lima", served(), emptyMap())
    }

    @Test(expected = GranterTrust.Changed::class)
    fun aServedKeyOtherThanThePinnedOneAtTheSameVersionIsRefused() {
        granterKey("user-ana", "Ana Lima", served(enc = serverKey), pins)
    }

    @Test
    fun aServedMlKemKeyOtherThanThePinnedDigestIsAChangedAccount() {
        val swapped = served().copy(kemPublicKey = base64urlEncode(ByteArray(1184) { 9 }))
        assertThrows(GranterTrust.Changed::class.java) { granterKey("user-ana", "Ana Lima", swapped, pins) }
    }

    @Test
    fun newerServedKeysAreNotFollowedButWaitForTheNextCheck() {
        val replaced = assertThrows(GranterTrust.Replaced::class.java) {
            granterKey("user-ana", "Ana Lima", served(enc = serverKey, sig = ByteArray(32) { 7 }, version = 3uL), pins)
        }
        assertEquals("Ana Lima’s sharing keys changed since you checked them. Check them again in Contacts to open what they shared.", replaced.message)
        // A succession is always to version 2 keys: newer keys served without an ML-DSA key are no succession at all.
        assertThrows(GranterTrust.Changed::class.java) {
            granterKey("user-ana", "Ana Lima", served(enc = serverKey, sig = ByteArray(32) { 7 }, version = 3uL).copy(mlDsaPublicKey = null), pins)
        }
    }

    @Test
    fun aMatchingPinOpensUnderItsCurrentKeysAloneNeverAnEarlierOne() {
        val granter = granterKey("user-ana", "Ana Lima", served(), pins)
        assertArrayEquals(signingKey, granter.signingPublicKey)
        assertEquals(TestPins.mlDsa, base64urlEncode(granter.keys.mlDsaPublicKey))
        // The pin followed a succession: a share that won't open under the current key is waiting for a re-seal.
        assertTrue(granter.replacedKeys)
        assertFalse(granterKey("user-ana", "Ana Lima", served(), mapOf("user-ana" to pin.copy(previousSigningKeys = emptyList()))).replacedKeys)
    }
}
