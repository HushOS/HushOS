package com.hushos.app.data

import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/*
 * A removal wipe decided in one screen must never clear a session another screen (the file picker's sign-in, with its
 * own view model) stores. The two callers here share nothing but SessionGuard, as the two view models do.
 */
class SessionGuardTest {
    @Test
    fun aWipeDecidedBeforeASignInBeganTouchesNothing() {
        val seen = SessionGuard.seen()
        var session: String? = null
        // The picker's screen signs in while the app's screen is still asking whether this phone was removed.
        SessionGuard.signingIn { session = "new" }
        val wiped = SessionGuard.wipeUnlessSignedInSince(seen) { session = null; true }
        assertNull(wiped)
        assertEquals("new", session)
    }

    @Test
    fun aSignInThatBeginsDuringAWipeWaitsForIt() {
        val events = Collections.synchronizedList(ArrayList<String>())
        val wiping = CountDownLatch(1)
        val release = CountDownLatch(1)
        val wipe = thread {
            SessionGuard.wipeUnlessSignedInSince(SessionGuard.seen()) {
                events.add("wipe started"); wiping.countDown()
                release.await(5, TimeUnit.SECONDS)
                events.add("wipe finished")
            }
        }
        assertTrue(wiping.await(5, TimeUnit.SECONDS))
        val signIn = thread { SessionGuard.signingIn { events.add("session stored") } }
        // Give the sign-in every chance to jump in while the wipe holds the guard.
        Thread.sleep(200)
        release.countDown()
        wipe.join(5000); signIn.join(5000)
        assertEquals(listOf("wipe started", "wipe finished", "session stored"), events)
    }
}
