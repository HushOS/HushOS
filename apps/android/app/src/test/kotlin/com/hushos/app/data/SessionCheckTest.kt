package com.hushos.app.data

import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/*
 * The session check at launch against a real HTTP server: the server answers every session with 200, so a 200 decides
 * it (signed in, ended or removed), and anything else came from something in the way (an outage, a deploy, a proxy)
 * and is thrown, as when HushOS can't be reached, so the app keeps the stored session as if offline. Before, any
 * answer but 200 read as "ended" and signed everyone out.
 */
class SessionCheckTest {
    private fun answering(status: Int, body: String = ""): Shared.Session {
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/api/auth/session") { exchange ->
            val bytes = body.toByteArray()
            exchange.sendResponseHeaders(status, if (bytes.isEmpty()) -1 else bytes.size.toLong())
            if (bytes.isNotEmpty()) exchange.responseBody.use { it.write(bytes) }
            exchange.close()
        }
        server.start()
        servers += server
        return Shared.Session("http://127.0.0.1:${server.address.port}", "token", "user")
    }
    private val servers = mutableListOf<HttpServer>()

    @org.junit.After
    fun stop() = servers.forEach { it.stop(0) }

    @Test
    fun anyAnswerButTwoHundredIsNotASignOut() {
        for (status in listOf(500, 502, 503, 504, 408, 429, 401, 403, 404, 421)) {
            val thrown = assertThrows(SessionUnavailable::class.java) { Auth.sessionCheckAt(answering(status)) }
            assertEquals(status, thrown.status)
        }
    }

    @Test
    fun anAnswerAboutTheSessionStillDecidesIt() {
        assertEquals(SessionCheck.Ended, Auth.sessionCheckAt(answering(200, """{"user":null,"device":null}""")))
        assertEquals(SessionCheck.Removed, Auth.sessionCheckAt(answering(200, """{"user":null,"device":null,"removed":true}""")))
    }
}
