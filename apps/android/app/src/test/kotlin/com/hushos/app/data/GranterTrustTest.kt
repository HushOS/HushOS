package com.hushos.app.data

import com.hushos.core.base64urlEncode
import org.junit.Assert.assertArrayEquals
import org.junit.Test

/*
 * A received share opens only under a key the person checked. Taking the server's word for
 * the granter's key would let a server fake a share "from" anyone, sealed with a key of its own.
 */
class GranterTrustTest {
    private val pinnedKey = base64urlEncode(ByteArray(32) { 1 })
    private val serverKey = base64urlEncode(ByteArray(32) { 2 })
    private val pins = mapOf(
        "user-ana" to ContactPin("user-ana", "ana@example.com", "Ana Lima", pinnedKey, base64urlEncode(ByteArray(32) { 3 }), "",
            "2026-10-01T00:00:00Z", null),
    )

    @Test(expected = GranterTrust.Unverified::class)
    fun aGranterNobodyPinnedIsRefused() {
        granterKey("user-ana", "Ana Lima", serverKey, emptyMap())
    }

    @Test(expected = GranterTrust.Changed::class)
    fun aServedKeyOtherThanThePinnedOneIsRefused() {
        granterKey("user-ana", "Ana Lima", serverKey, pins)
    }

    @Test
    fun aMatchingPinOpensWithThePinnedKey() {
        assertArrayEquals(ByteArray(32) { 1 }, granterKey("user-ana", "Ana Lima", pinnedKey, pins))
    }
}
