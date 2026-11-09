package com.hushos.app.data

import com.sun.net.httpserver.HttpServer
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetSocketAddress
import java.util.Collections

/*
 * Registering with the relay holds the deletion secret: each test fails on a handle that outlives a sign-out, one that is
 * never deleted, or one deleted with the wrong secret. A real HTTP server plays the relay and the HushOS server.
 */
class PushRegistrarTest {
    private data class Seen(val method: String, val path: String, val body: JSONObject)

    private val seen: MutableList<Seen> = Collections.synchronizedList(mutableListOf())
    private var put: () -> Int = { 200 }
    private var delete: () -> Int = { 204 }
    private val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).apply {
        createContext("/") { exchange ->
            val body = exchange.requestBody.bufferedReader().readText()
            val path = exchange.requestURI.path
            seen += Seen(exchange.requestMethod, path, runCatching { JSONObject(body) }.getOrDefault(JSONObject()))
            val (status, text) = when {
                exchange.requestMethod == "POST" && path == "/v1/register" ->
                    200 to JSONObject().put("handle", NEW_HANDLE).put("deleteSecret", NEW_SECRET).toString()
                exchange.requestMethod == "PUT" && path == "/api/notifications/registration" -> put().let { it to if (it == 200) "{\"registered\":true}" else "{\"message\":\"No\"}" }
                exchange.requestMethod == "DELETE" && path.startsWith("/v1/register/") -> delete() to ""
                else -> 500 to "{}"
            }
            val bytes = text.toByteArray()
            exchange.sendResponseHeaders(status, if (bytes.isEmpty()) -1 else bytes.size.toLong())
            if (bytes.isNotEmpty()) exchange.responseBody.use { it.write(bytes) }
            exchange.close()
        }
        start()
    }
    private val origin = "http://127.0.0.1:${server.address.port}"
    private val maya = Shared.Session(origin, "maya-token", "u-maya")
    private val sam = Shared.Session(origin, "sam-token", "u-sam")

    @After
    fun stop() = server.stop(0)

    /* The encrypted preferences' part, in memory. */
    private class Memory(@Volatile var session: Shared.Session?, @Volatile var registration: PushRegistration? = null) : PushStore {
        @Volatile var pendingList: List<PushPendingDeletion> = emptyList()
        override fun session() = session
        override fun read() = registration
        override fun write(registration: PushRegistration): Boolean { this.registration = registration; return true }
        override fun clear() { registration = null }
        override fun pending() = pendingList
        override fun setPending(list: List<PushPendingDeletion>): Boolean { pendingList = list; return true }
    }

    private fun previous(token: String = "old-fcm-token-0123456789abcdefghijklmnop") =
        PushRegistration(origin, "u-maya", origin, "fcm", token, OLD_HANDLE, OLD_SECRET)

    private fun registrar(memory: Memory) = PushRegistrar(memory, "fcm") { it }

    private fun deletions(): Map<String, String> = seen.toList().filter { it.method == "DELETE" }
        .associate { it.path.removePrefix("/v1/register/") to it.body.optString("deleteSecret") }

    @Test
    fun aServerThatRefusesTheHandlePutsBackWhatWasKeptAndDeletesTheNewOne() {
        val memory = Memory(maya, previous())
        put = { 500 }
        assertThrows(Exception::class.java) { registrar(memory).register(TOKEN, origin) }
        assertEquals("the registration kept before was not put back", previous(), memory.registration)
        assertEquals(mapOf(NEW_HANDLE to NEW_SECRET), deletions())
        assertTrue(memory.pendingList.isEmpty())
    }

    @Test
    fun aSignOutWhileTheServerAnswersNeverBringsTheRegistrationBack() {
        val memory = Memory(maya, previous())
        val registrar = registrar(memory)
        // Signed out as the PUT arrives: the wipe forgets what is kept (the new handle by then), then the server refuses.
        put = { registrar.forget(); memory.session = null; 500 }
        assertThrows(Exception::class.java) { registrar.register(TOKEN, origin) }
        assertNull("a registration came back after the sign-out", memory.registration)
        assertEquals(mapOf(NEW_HANDLE to NEW_SECRET, OLD_HANDLE to OLD_SECRET), deletions())
        assertTrue(memory.pendingList.isEmpty())
    }

    @Test
    fun anotherAccountSignedInMeanwhileGetsNothingOfTheFirsts() {
        val memory = Memory(maya, previous())
        val registrar = registrar(memory)
        put = { registrar.forget(); memory.session = sam; 500 }
        assertThrows(Exception::class.java) { registrar.register(TOKEN, origin) }
        assertNull("Maya's registration was written under Sam's session", memory.registration)
        assertEquals(setOf(NEW_HANDLE, OLD_HANDLE), deletions().keys)
    }

    @Test
    fun theSameTokenAtTheSameRelaySendsTheKeptHandleAgainAndRegistersNothing() {
        val memory = Memory(maya, previous(TOKEN))
        registrar(memory).register(TOKEN, origin)
        assertEquals("the relay was asked for another handle for the same token", listOf("PUT"), seen.map { it.method })
        assertEquals(OLD_HANDLE, seen.single().body.optString("handle"))
        assertEquals(previous(TOKEN), memory.registration)
    }

    @Test
    fun aNewTokenRegistersAfreshAndDeletesTheOldHandleWithItsSecret() {
        val memory = Memory(maya, previous())
        registrar(memory).register(TOKEN, origin)
        assertEquals(NEW_HANDLE, memory.registration?.handle)
        assertEquals(NEW_SECRET, memory.registration?.deleteSecret)
        assertEquals(NEW_HANDLE, seen.first { it.method == "PUT" }.body.optString("handle"))
        assertEquals(mapOf(OLD_HANDLE to OLD_SECRET), deletions())
    }

    @Test
    fun aDeletionTheRelayDidntConfirmIsKeptAndTriedAgain() {
        val memory = Memory(maya, previous())
        val registrar = registrar(memory)
        delete = { 503 }
        assertTrue(registrar.forget())
        registrar.drain()
        assertNull(memory.registration)
        assertEquals("a deletion the relay never confirmed was let go", listOf(OLD_HANDLE), memory.pendingList.map { it.handle })
        // Next start: the relay answers. 404 counts too: the handle is gone either way.
        delete = { 404 }
        registrar.drain()
        assertTrue(memory.pendingList.isEmpty())
        assertEquals(mapOf(OLD_HANDLE to OLD_SECRET), deletions())
    }

    @Test
    fun aRegistrationThatCantBeKeptIsDeletedAtTheRelayAndNeverSentToTheServer() {
        val memory = object : PushStore by Memory(maya, previous()) {
            override fun write(registration: PushRegistration) = false
        }
        assertThrows(PushNotifications.Refused::class.java) { PushRegistrar(memory, "fcm") { it }.register(TOKEN, origin) }
        assertTrue("the server was given a handle this phone couldn't keep", seen.none { it.method == "PUT" })
        assertEquals(mapOf(NEW_HANDLE to NEW_SECRET), deletions())
    }

    private companion object {
        const val TOKEN = "new-fcm-token-0123456789abcdefghijklmnop"
        // 32 bytes each, base64url: what the relay hands out.
        val OLD_HANDLE = "A".repeat(42) + "E"
        val OLD_SECRET = "B".repeat(42) + "E"
        val NEW_HANDLE = "C".repeat(42) + "E"
        val NEW_SECRET = "D".repeat(42) + "E"
    }
}
