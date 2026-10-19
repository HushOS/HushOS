package com.hushos.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/*
 * A new device record is named after the phone's maker and model, so two phones on one account can
 * be told apart, and the name must pass the server's rule or the sign-in's registration is refused.
 */
class DeviceNameTest {
    /* The server's rule, copied from `normalizeDeviceName` in packages/auth/src/server.ts. */
    private val serverRule = Regex("^[\\p{L}\\p{M}\\p{N} '’()._·-]+$")

    private fun assertAccepted(name: String) {
        assertTrue("\"$name\" is refused by the server", serverRule.matches(name) && name.codePointCount(0, name.length) in 1..40)
    }

    @Test fun aPixelIsNamedWithoutItsMaker() {
        assertEquals("Pixel 9", DeviceName.of("Google", "Pixel 9", tablet = false))
        assertEquals("Pixel Tablet", DeviceName.of("Google", "Pixel Tablet", tablet = true))
    }

    @Test fun aSamsungKeepsItsModelCodeBehindACapitalisedMaker() {
        assertEquals("Samsung SM-S931B", DeviceName.of("samsung", "SM-S931B", tablet = false))
    }

    @Test fun aLowercaseMakerIsCapitalisedWordByWord() {
        assertEquals("Motorola moto g54 5G", DeviceName.of("motorola", "moto g54 5G", tablet = false))
        assertEquals("Hmd Global Nokia G21", DeviceName.of("hmd global", "Nokia G21", tablet = false))
        // A maker that already uses capitals is written as it is.
        assertEquals("HMD Global Nokia G21", DeviceName.of("HMD Global", "Nokia G21", tablet = false))
    }

    @Test fun aModelThatAlreadyNamesItsMakerIsNotNamedTwice() {
        assertEquals("ONEPLUS A6003", DeviceName.of("OnePlus", "ONEPLUS A6003", tablet = false))
        assertEquals("Xiaomi 14", DeviceName.of("Xiaomi", "Xiaomi 14", tablet = false))
    }

    @Test fun charactersTheServerRefusesAreDroppedRatherThanFailingTheSignIn() {
        val name = DeviceName.of("HTC", "U12+", tablet = false)
        assertEquals("HTC U12", name)
        assertAccepted(name)
        // A bidi override would let a name read backwards in the list; the server refuses it.
        val odd = DeviceName.of("Acme/Labs", "Phone, 2 \u202Epro", tablet = false)
        assertEquals("Acme Labs Phone 2 pro", odd)
        assertAccepted(odd)
    }

    @Test fun aLongNameIsCutToTheServersLimit() {
        val name = DeviceName.of("Fairphone", "Fairphone 5 Extended Edition With A Long Marketing Tail", tablet = false)
        assertEquals("Fairphone 5 Extended Edition With A Long", name)
        assertAccepted(name)
    }

    @Test fun noUsableModelFallsBackToTheKindOfDevice() {
        assertEquals("Android phone", DeviceName.of("samsung", "", tablet = false))
        assertEquals("Android tablet", DeviceName.of(null, "+++", tablet = true))
        assertEquals("Android phone", DeviceName.of(null, null, tablet = false))
    }
}
