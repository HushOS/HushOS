package com.hushos.app.data

import com.hushos.app.data.PushAsk.Permission
import com.hushos.app.data.PushAsk.Step
import org.junit.Assert.assertEquals
import org.junit.Test

/*
 * Asking once: each test fails on a question asked twice, one asked where nothing could arrive, or a registration made
 * after the person said no (to Android, or with the Account switch).
 */
class PushAskTest {
    private val relay = "https://push.hushos.com"

    @Test
    fun aFirstSignInOnAServerWithARelayAsks() {
        assertEquals(Step.ASK, PushAsk.step(available = true, registered = false, asked = false, relay = relay, permission = Permission.UNDECIDED))
    }

    @Test
    fun onceAskedItNeverAsksAgainWhateverTheAnswerWas() {
        for (permission in Permission.entries)
            assertEquals(Step.NOTHING, PushAsk.step(available = true, registered = false, asked = true, relay = relay, permission = permission))
    }

    @Test
    fun aPhoneAlreadyRegisteredIsLeftAsItIs() {
        assertEquals(Step.NOTHING, PushAsk.step(available = true, registered = true, asked = false, relay = relay, permission = Permission.UNDECIDED))
    }

    @Test
    fun noRelayOrNoFirebaseMeansNoQuestion() {
        assertEquals(Step.NOTHING, PushAsk.step(available = true, registered = false, asked = false, relay = null, permission = Permission.UNDECIDED))
        assertEquals(Step.NOTHING, PushAsk.step(available = false, registered = false, asked = false, relay = relay, permission = Permission.UNDECIDED))
    }

    @Test
    fun allowedAlreadyOrBeforeAndroid13RegistersWithoutAQuestion() {
        assertEquals(Step.REGISTER, PushAsk.step(available = true, registered = false, asked = false, relay = relay, permission = Permission.ALLOWED))
    }

    @Test
    fun turnedOffInSettingsBeforeAndroid13OnlyRecordsThatItWasAsked() {
        assertEquals(Step.MARK_ONLY, PushAsk.step(available = true, registered = false, asked = false, relay = relay, permission = Permission.DENIED))
    }
}
