package com.hushos.app.data

import org.junit.Assert.assertEquals
import org.junit.Test

/* A server address is an https origin; plain http only to the local network in a debug build. */
class ServerAddressTest {
    private fun ok(input: String, local: Boolean = false) = (ServerAddress.check(input, local) as ServerAddress.Check.Ok).origin
    private fun why(input: String, local: Boolean = false) = (ServerAddress.check(input, local) as ServerAddress.Check.Invalid).reason

    @Test
    fun aServerBecomesItsOrigin() {
        assertEquals("https://hush.example.org", ok("hush.example.org"))
        assertEquals("https://hush.example.org", ok(" HTTPS://Hush.Example.org/ "))
        assertEquals("https://hush.example.org:8443", ok("https://hush.example.org:8443"))
    }

    @Test
    fun plainHttpIsRefusedExceptToTheLocalNetworkInDebug() {
        assertEquals(ServerAddress.NEEDS_HTTPS, why("http://hush.example.org"))
        assertEquals(ServerAddress.NEEDS_HTTPS, why("http://hush.example.org", local = true))
        assertEquals(ServerAddress.NEEDS_HTTPS, why("http://localhost:5173"))
        assertEquals("http://localhost:5173", ok("http://localhost:5173", local = true))
        assertEquals("http://192.168.1.20:5173", ok("http://192.168.1.20:5173", local = true))
        assertEquals(ServerAddress.NEEDS_HTTPS, why("http://8.8.8.8", local = true))
    }

    @Test
    fun anythingElseSaysWhatIsWrong() {
        assertEquals(ServerAddress.NOT_AN_ADDRESS, why(""))
        assertEquals(ServerAddress.NOT_AN_ADDRESS, why("not an address"))
        assertEquals(ServerAddress.NOT_AN_ADDRESS, why("ftp://hush.example.org"))
        assertEquals(ServerAddress.NOT_AN_ADDRESS, why("intranet"))
        assertEquals(ServerAddress.JUST_THE_SERVER, why("https://hush.example.org/app/drive"))
        assertEquals(ServerAddress.JUST_THE_SERVER, why("https://user@hush.example.org"))
    }
}
