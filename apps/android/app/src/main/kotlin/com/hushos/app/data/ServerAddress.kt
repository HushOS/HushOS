package com.hushos.app.data

import java.net.URI

/*
 * The server address a person types under Self-hosting: made into an origin
 * ("https://hush.example.org"), or a sentence saying what is wrong. https only; plain
 * http only in a debug build and only to this machine or the local network, where a
 * dev server has no certificate.
 */
object ServerAddress {
    const val HUSHOS = "https://hushos.com"

    sealed interface Check {
        data class Ok(val origin: String) : Check
        data class Invalid(val reason: String) : Check
    }

    const val NOT_AN_ADDRESS = "That isn’t a web address. It looks like https://hush.example.org."
    const val NEEDS_HTTPS = "Use an address that starts with https://."
    const val JUST_THE_SERVER = "Use just the server’s address, without a path, like https://hush.example.org."

    fun check(input: String, allowLocalHttp: Boolean): Check {
        val typed = input.trim().trimEnd('/')
        if (typed.isEmpty()) return Check.Invalid(NOT_AN_ADDRESS)
        // A bare host means https.
        val withScheme = if ("://" in typed) typed else "https://$typed"
        val uri = runCatching { URI(withScheme) }.getOrNull() ?: return Check.Invalid(NOT_AN_ADDRESS)
        val host = uri.host?.lowercase() ?: return Check.Invalid(NOT_AN_ADDRESS)
        if (!host.contains('.') && host != "localhost") return Check.Invalid(NOT_AN_ADDRESS)
        if (!uri.path.isNullOrEmpty() || uri.query != null || uri.fragment != null || uri.userInfo != null) return Check.Invalid(JUST_THE_SERVER)
        when (uri.scheme?.lowercase()) {
            "https" -> {}
            "http" -> if (!(allowLocalHttp && isLocal(host))) return Check.Invalid(NEEDS_HTTPS)
            else -> return Check.Invalid(NOT_AN_ADDRESS)
        }
        val port = if (uri.port == -1) "" else ":${uri.port}"
        return Check.Ok("${uri.scheme.lowercase()}://$host$port")
    }

    /* This machine or the local network: localhost, the emulator's host, private IPv4 ranges, .local names. */
    fun isLocal(host: String): Boolean {
        if (host == "localhost" || host.endsWith(".local") || host.endsWith(".localhost") || host == "10.0.2.2") return true
        val parts = host.split('.').mapNotNull { it.toIntOrNull() }
        if (parts.size != 4) return false
        return parts[0] == 127 || parts[0] == 10 || (parts[0] == 192 && parts[1] == 168) || (parts[0] == 172 && parts[1] in 16..31)
    }
}
