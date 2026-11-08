package com.hushos.app.data

import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/*
 * The session check at launch against a real HTTP server: an answer about the session (200, or a refusal such as 401)
 * decides it, but an error on the server's own side (5xx, 408, 429) is thrown, as when HushOS can't be reached, so the
 * app keeps the stored session as if offline. Before, any answer but 200 read as "ended" and signed everyone out
 * during an outage or a deploy.
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
    fun aServerErrorIsNotASignOut() {
        for (status in listOf(500, 502, 503, 504, 408, 429)) {
            val thrown = assertThrows(SessionUnavailable::class.java) { Auth.sessionCheckAt(answering(status)) }
            assertEquals(status, thrown.status)
        }
    }

    @Test
    fun anAnswerAboutTheSessionStillDecidesIt() {
        assertEquals(SessionCheck.Ended, Auth.sessionCheckAt(answering(401)))
        assertEquals(SessionCheck.Ended, Auth.sessionCheckAt(answering(403)))
        assertEquals(SessionCheck.Ended, Auth.sessionCheckAt(answering(200, """{"user":null,"device":null}""")))
        assertEquals(SessionCheck.Removed, Auth.sessionCheckAt(answering(200, """{"user":null,"device":null,"removed":true}""")))
    }
}
