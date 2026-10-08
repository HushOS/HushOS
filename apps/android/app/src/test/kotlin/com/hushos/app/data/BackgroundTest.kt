package com.hushos.app.data

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/* The background-transfers sheet asks only when something would stop a transfer, and "Not now" holds for a week. */
class BackgroundTest {
    private val now = 10_000_000_000L
    private val batteryOn = BackgroundAccess(notifications = true, battery = false, data = true)

    @Test
    fun nothingOffMeansNothingAsked() {
        assertFalse(Background.shouldAsk(BackgroundAccess(true, true, true), notNowAt = null, now = now))
    }

    @Test
    fun anythingOffIsAskedTheFirstTime() {
        assertTrue(Background.shouldAsk(batteryOn, notNowAt = null, now = now))
        assertTrue(Background.shouldAsk(BackgroundAccess(notifications = false, battery = true, data = true), null, now))
        assertTrue(Background.shouldAsk(BackgroundAccess(notifications = true, battery = true, data = false), null, now))
    }

    @Test
    fun notNowHoldsForAWeek() {
        assertFalse(Background.shouldAsk(batteryOn, notNowAt = now - Background.QUIET_FOR + 1, now = now))
        assertTrue(Background.shouldAsk(batteryOn, notNowAt = now - Background.QUIET_FOR, now = now))
    }
}
