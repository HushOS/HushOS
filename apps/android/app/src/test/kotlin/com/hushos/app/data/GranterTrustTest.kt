package com.hushos.app.data

import com.hushos.core.base64urlEncode
import com.hushos.core.identityFingerprint
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/*
 * A received share opens only under keys the person checked: the granter's current pinned signing key, never one
 * they replaced, and never newer served keys the person hasn't checked again (docs/integrity-design.md, "Retired
 * keys" and "Who sees whom"). Taking the server's word for the granter's keys would let a server fake a share
 * "from" anyone, sealed with keys of its own.
 */
class GranterTrustTest {
    private val pinnedKey = base64urlEncode(ByteArray(32) { 1 })
    private val serverKey = base64urlEncode(ByteArray(32) { 2 })
    private val signingKey = ByteArray(32) { 3 }
    private val earlierSigningKey = ByteArray(32) { 5 }
    /* Checked: its fingerprint is the current one over both pinned keys (an unchecked pin is SharingTrustTest's). */
    private val pin = ContactPin("user-ana", "ana@example.com", "Ana Lima", pinnedKey, base64urlEncode(signingKey),
        identityFingerprint(ByteArray(32) { 1 }, signingKey), "2026-10-01T00:00:00Z", null,
        keyVersion = 2uL, previousSigningKeys = listOf(base64urlEncode(earlierSigningKey)))
    private val pins = mapOf("user-ana" to pin)

    @Test(expected = GranterTrust.Unverified::class)
    fun aGranterNobodyPinnedIsRefused() {
        granterKey("user-ana", "Ana Lima", ServedIdentity(2uL, serverKey, base64urlEncode(signingKey), null), emptyMap())
    }

    @Test(expected = GranterTrust.Changed::class)
    fun aServedKeyOtherThanThePinnedOneAtTheSameVersionIsRefused() {
        granterKey("user-ana", "Ana Lima", ServedIdentity(2uL, serverKey, base64urlEncode(signingKey), null), pins)
    }

    @Test
    fun newerServedKeysAreNotFollowedButWaitForTheNextCheck() {
        val replaced = assertThrows(GranterTrust.Replaced::class.java) {
            granterKey("user-ana", "Ana Lima", ServedIdentity(3uL, serverKey, base64urlEncode(ByteArray(32) { 7 }), null), pins)
        }
        assertEquals("Ana Lima’s sharing keys changed since you checked them. Check them again in People you share with to open what they shared.", replaced.message)
    }

    @Test
    fun aMatchingPinOpensUnderItsCurrentKeyAloneNeverAnEarlierOne() {
        val granter = granterKey("user-ana", "Ana Lima", ServedIdentity(2uL, pinnedKey, base64urlEncode(signingKey), null), pins)
        assertArrayEquals(signingKey, granter.signingPublicKey)
        // The pin followed a succession: a share that won't open under the current key is waiting for a re-seal.
        assertTrue(granter.replacedKeys)
        assertFalse(granterKey("user-ana", "Ana Lima", ServedIdentity(2uL, pinnedKey, base64urlEncode(signingKey), null),
            mapOf("user-ana" to pin.copy(previousSigningKeys = emptyList()))).replacedKeys)
    }
}
