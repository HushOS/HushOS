package com.hushos.app.data

import com.hushos.core.base64urlEncode
import com.hushos.core.identityFingerprint
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

/*
 * A received share opens only under keys the person checked. Taking the server's word for
 * the granter's keys would let a server fake a share "from" anyone, sealed with keys of its own.
 */
class GranterTrustTest {
    private val pinnedKey = base64urlEncode(ByteArray(32) { 1 })
    private val serverKey = base64urlEncode(ByteArray(32) { 2 })
    private val signingKey = ByteArray(32) { 3 }
    private val earlierSigningKey = ByteArray(32) { 5 }
    /* Checked: its fingerprint is the current one over both pinned keys (an unchecked pin is SharingTrustTest's). */
    private val pins = mapOf(
        "user-ana" to ContactPin("user-ana", "ana@example.com", "Ana Lima", pinnedKey, base64urlEncode(signingKey),
            identityFingerprint(ByteArray(32) { 1 }, signingKey), "2026-10-01T00:00:00Z", null,
            keyVersion = 2uL, previousSigningKeys = listOf(base64urlEncode(earlierSigningKey))),
    )

    @Test(expected = GranterTrust.Unverified::class)
    fun aGranterNobodyPinnedIsRefused() {
        granterKeys("user-ana", "Ana Lima", ServedIdentity(2uL, serverKey, base64urlEncode(signingKey), null), emptyMap())
    }

    @Test(expected = GranterTrust.Changed::class)
    fun aServedKeyOtherThanThePinnedOneIsRefused() {
        granterKeys("user-ana", "Ana Lima", ServedIdentity(2uL, serverKey, base64urlEncode(signingKey), null), pins)
    }

    @Test
    fun aMatchingPinOpensWithThePinnedKeysThenTheEarlierOnesASuccessionVouchedFor() {
        val granters = granterKeys("user-ana", "Ana Lima", ServedIdentity(2uL, pinnedKey, base64urlEncode(signingKey), null), pins)
        assertEquals(2, granters.size)
        assertArrayEquals(ByteArray(32) { 1 }, granters[0].encryptionPublicKey)
        assertArrayEquals(signingKey, granters[0].signingPublicKey)
        assertArrayEquals(earlierSigningKey, granters[1].signingPublicKey)
    }
}
