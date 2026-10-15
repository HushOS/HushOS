package com.hushos.app.data

import com.hushos.core.IdentityKeys
import com.hushos.core.identityCreate
import com.hushos.core.identityOpen
import com.hushos.core.randomBytes
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/*
 * The identity is forgotten after a succession (this device's) or a signature the server refused (another device's):
 * an open or a history read already on its way then carries the identity before. Kept, it would sign with the replaced
 * key, or leave the replaced key out of the history so shares sealed to it stop opening, until something else forgot it.
 */
class OpenedIdentitiesTest {
    private val userId = "0b5a3c9e-6f1d-4c2a-9e8b-1d2c3b4a5f60"
    private val root = randomBytes(32u)
    private val earliest = identityOpen(userId, root, identityCreate(userId, root, 1uL))
    private val old = identityOpen(userId, root, identityCreate(userId, root, 2uL))
    private val next = identityOpen(userId, root, identityCreate(userId, root, 3uL))

    /* What the server serves; the next open or history read can be held, already read, until `release`. */
    private class Server(@Volatile var current: IdentityKeys, @Volatile var earlier: List<IdentityKeys>) {
        @Volatile var holdOpen = false
        @Volatile var holdHistory = false
        val arrived = CountDownLatch(1)
        val release = CountDownLatch(1)

        private fun held(hold: Boolean) {
            if (!hold) return
            arrived.countDown()
            release.await(10, TimeUnit.SECONDS)
        }

        fun open(): IdentityKeys = current.also { held(holdOpen.also { holdOpen = false }) }
        fun history(): List<IdentityKeys> = earlier.also { held(holdHistory.also { holdHistory = false }) }
    }

    private fun keys(all: List<IdentityKeys>) = all.map { it.signingPublicKey }

    private fun historyReadAcrossAForget(openAgainBeforeTheReply: Boolean) {
        val server = Server(old, listOf(earliest))
        val identities = OpenedIdentities(server::open, server::history)
        identities.current()
        server.holdHistory = true
        var read: List<IdentityKeys> = emptyList()
        val reader = thread { read = identities.all(strict = true) }
        assertTrue(server.arrived.await(10, TimeUnit.SECONDS))
        // The succession lands while the history is on its way: the old identity joins the history.
        server.current = next
        server.earlier = listOf(old, earliest)
        identities.forget()
        if (openAgainBeforeTheReply) assertEquals(next.signingPublicKey, identities.current().signingPublicKey)
        server.release.countDown()
        reader.join(10_000)
        // What the reader is handed is one identity's: the new current key beside its own history, never the old pair.
        assertEquals(keys(listOf(next, old, earliest)), keys(read))
        // And what is kept is the same.
        assertEquals(keys(listOf(next, old, earliest)), keys(identities.all(strict = true)))
    }

    @Test
    fun aHistoryReadBeforeTheIdentityWasForgottenIsNotKept() = historyReadAcrossAForget(openAgainBeforeTheReply = false)

    @Test
    fun aHistoryReadBeforeTheIdentityWasForgottenIsNotKeptBesideTheOneOpenedSince() =
        historyReadAcrossAForget(openAgainBeforeTheReply = true)

    @Test
    fun anOpenUnderWayWhenTheIdentityIsForgottenIsForgottenToo() {
        val server = Server(old, emptyList())
        server.holdOpen = true
        val identities = OpenedIdentities(server::open, server::history)
        val opener = thread { identities.current() }
        assertTrue(server.arrived.await(10, TimeUnit.SECONDS))
        server.current = next
        // Forgotten while the open still holds what it read: it waits for the open, then forgets what that kept.
        val forgetter = thread { identities.forget() }
        forgetter.join(1_000)
        server.release.countDown()
        opener.join(10_000)
        forgetter.join(10_000)
        assertEquals(next.signingPublicKey, identities.current().signingPublicKey)
    }

    /*
     * Your twelve words after the keys were replaced on another device: this process still holds the old identity (it is
     * kept until something forgets it), so the words must come from checking what the server serves now.
     */
    @Test
    fun theIdentityServedNowReplacesTheOneKeptWhenItDiffers() {
        val beforeEnvelope = identityCreate(userId, root, 4uL)
        val afterEnvelope = identityCreate(userId, root, 5uL)
        val before = identityOpen(userId, root, beforeEnvelope)
        val after = identityOpen(userId, root, afterEnvelope)
        var opens = 0
        val server = Server(before, emptyList())
        val identities = OpenedIdentities({ opens++; server.open() }, server::history)
        assertEquals(ownFingerprint(before), ownFingerprint(identities.current(beforeEnvelope)))
        // Served unchanged: the one in use is kept, not opened again.
        assertEquals(ownFingerprint(before), ownFingerprint(identities.current(beforeEnvelope)))
        assertEquals(1, opens)
        server.current = after
        // Unchecked, the old words would still be shown.
        assertEquals(ownFingerprint(before), ownFingerprint(identities.current()))
        assertNotEquals(ownFingerprint(before), ownFingerprint(after))
        assertEquals(ownFingerprint(after), ownFingerprint(identities.current(afterEnvelope)))
        assertEquals(2, opens)
    }
}
